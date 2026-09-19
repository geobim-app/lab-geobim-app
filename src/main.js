import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { N8AOPass } from 'n8ao';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { toggleGeoPanel, setupGeoUI, invalidateGlbCache, updateFootprint, preGenerateGlb, autoDetectGeoref, applyGeorefOverride, activatePickupMode } from './georef.js';

// Intercept BufferAttribute upload callbacks that delete .array
// ThatOpen sets onUploadCallback = function(){delete this.array} to free CPU memory.
// We BLOCK the deletion so .array stays available for GLB export and reflects
// any later modifications (e.g. Hider hiding elements by modifying index buffers).
Object.defineProperty(THREE.BufferAttribute.prototype, 'onUploadCallback', {
  set(fn) {
    const fnStr = fn?.toString() || '';
    if (fnStr.includes('delete')) {
      // Replace destructive callback with no-op — keep arrays in CPU memory
      this._wrappedUpload = function () {};
    } else {
      this._wrappedUpload = fn;
    }
  },
  get() {
    return this._wrappedUpload || function () {};
  },
  configurable: true,
});

// =====================================
// GEOBIM.LAB — BIM Viewer v0.2
// That Open Components + Three.js
// Phase 1: Multi-file, Hide, Delete, Type-Filter, Clipping
// =====================================

const state = {
  components: null,
  world: null,
  ifcLoader: null,
  fragments: null,
  caster: null,
  hider: null,
  // Multi-file support
  files: [],        // { id, name, size, modelId, model, elementCount, color, visible }
  fileIdCounter: 0,
  // Hide mode
  hideMode: false,
  hiddenItems: new Map(),  // key: `${modelId}:${localId}` → { modelId, localId, name }
  // Delete mode
  deleteMode: false,
  deletedStack: [],        // [{modelId, localId, name}] for undo
  deletedSet: new Set(),   // `${modelId}:${localId}` for quick lookup
  // Clipping
  clipPlanes: { x: null, y: null, z: null },
  clipFlipped: { x: false, y: false, z: false },
  clipEnabled: { x: false, y: false, z: false },
  modelBBox: null,
  // Type filter
  typeVisibility: new Map(), // `${modelId}:${type}` → boolean
  // Phase 2: Graphics
  ambientLight: null,
  sunLight: null,
  fillLight: null,
  hemiLight: null,
  composer: null,
  n8ao: null,
  smaaPass: null,
  msaaRT: null,
  pbrEnabled: true,
  originalMaterials: new Map(),
  materialMap: new Map(), // expressId → material name string (from IFC STEP parsing)
  // Phase 3: Georef
  lastFileBuffer: null,
  lastFileName: null,
  pickOriginMode: false,
  pickOriginStep: 0,   // 0=inactive, 1=origin, 2=x-axis
  localXAxis: null,     // THREE.Vector3 from pick step 2
  xAxisArrow: null,     // ArrowHelper visualization
  _pickOriginKeyHandler: null,
  originMarker: null,
  snapPreview: null,
  modelWrapper: null,
  // Measure tool
  measureMode: false,
  measureType: 'point',  // 'point' | 'polyline' | 'area' | 'vertical' | 'horizontal'
  measurePoints: [],     // accumulated points for current measurement
  measurePreview: null,  // preview marker group
  measurePreviewLine: null, // live preview line to cursor
  measurements: [],      // [{ group, type, value }]

  // Returns Set of expressIDs (localIds) that are hidden/deleted/category-filtered
  async getExcludedIds() {
    const excluded = new Set();
    // 1) Manually hidden elements
    for (const [, val] of this.hiddenItems) {
      excluded.add(val.localId);
    }
    // 2) Deleted elements
    for (const entry of this.deletedStack) {
      excluded.add(entry.localId);
    }
    // 3) Category-filtered (unchecked type groups)
    for (const [key, visible] of this.typeVisibility) {
      if (visible === false) {
        // key is `${modelId}:${type}` — need to find localIds of that type
        const [modelId, type] = key.split(':');
        const model = this.fragments?.list?.get(modelId);
        if (!model) continue;
        try {
          const itemsMap = await model.getItems();
          if (itemsMap) {
            itemsMap.forEach((rawItem, localId) => {
              if ((rawItem.category || '').toLowerCase() === type.toLowerCase()) {
                excluded.add(localId);
              }
            });
          }
        } catch (_) {}
      }
    }
    return excluded;
  },
};

// File colors for the file manager
const FILE_COLORS = [
  '#2ECFB0', '#60a5fa', '#f59e0b', '#ef4444', '#a78bfa',
  '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#06b6d4',
];

// =====================================
// STATUS
// =====================================


function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function showLoading(text) {
  const overlay = document.getElementById('loadingOverlay');
  const textEl = document.getElementById('loadingText');
  const fill = document.getElementById('progressFill');
  if (overlay) overlay.classList.remove('hidden');
  if (textEl) textEl.textContent = text || 'Loading...';
  if (fill) fill.style.width = '0%';
}

function updateProgress(pct) {
  const fill = document.getElementById('progressFill');
  if (fill) fill.style.width = Math.min(100, pct) + '%';
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.classList.add('hidden');
}

// =====================================
// INIT
// =====================================

async function init() {
  setStatus('Initializing...');

  const viewport = document.getElementById('viewport');
  if (!viewport) {
    console.error('Viewport element not found');
    return;
  }

  const components = new OBC.Components();
  state.components = components;

  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();
  state.world = world;

  world.scene = new OBC.SimpleScene(components);
  world.scene.setup();

  world.renderer = new OBC.SimpleRenderer(components, viewport);

  world.camera = new OBC.SimpleCamera(components);
  world.camera.controls.setLookAt(10, 10, 10, 0, 0, 0);

  components.init();

  const scene = world.scene.three;
  const renderer = world.renderer.three;
  const camera = world.camera.three;

  scene.background = new THREE.Color(0x0D1017);

  // ---- Lighting ----
  // Remove default lights from SimpleScene.setup()
  const lightsToRemove = [];
  scene.traverse((obj) => {
    if (obj.isLight) lightsToRemove.push(obj);
  });
  lightsToRemove.forEach((l) => l.removeFromParent());

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
  scene.add(ambientLight);
  state.ambientLight = ambientLight;

  const sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
  sunLight.position.set(5, 10, 7.5);
  scene.add(sunLight);
  state.sunLight = sunLight;

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
  fillLight.position.set(-5, 2, -5);
  scene.add(fillLight);
  state.fillLight = fillLight;

  const hemiLight = new THREE.HemisphereLight(0xddeeff, 0x0d0d0d, 0.5);
  scene.add(hemiLight);
  state.hemiLight = hemiLight;

  // ---- Tone Mapping ----
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  // ---- Post-Processing (N8AO + SMAA) ----
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;

  const msaaRT = new THREE.WebGLRenderTarget(w, h, { samples: 4 });
  state.msaaRT = msaaRT;

  const composer = new EffectComposer(renderer, msaaRT);

  const n8ao = new N8AOPass(scene, camera, w, h);
  n8ao.configuration.intensity = 5.1;
  n8ao.configuration.aoRadius = 10.4;
  n8ao.configuration.distanceFalloff = 1.9;
  n8ao.setQualityMode('Ultra');
  composer.addPass(n8ao);

  composer.addPass(new OutputPass());

  const smaaPass = new SMAAPass(w, h);
  smaaPass.enabled = true;
  composer.addPass(smaaPass);

  state.composer = composer;
  state.n8ao = n8ao;
  state.smaaPass = smaaPass;

  // Disable SimpleRenderer's built-in render — we use EffectComposer instead
  world.renderer.enabled = false;

  // Own render loop with EffectComposer (started after fragments.init)
  state._composerRef = composer;

  // Handle resize for composer
  const origResize = world.renderer.resize;
  world.renderer.resize = function (size) {
    origResize.call(this, size);
    const s = this.getSize();
    composer.setSize(s.x, s.y);
  };

  // Enable clipping on renderer
  renderer.localClippingEnabled = true;

  const grids = components.get(OBC.Grids);
  const grid = grids.create(world);
  grid.material.uniforms.uColor.value = new THREE.Color(0x333333);
  state.grid = grid;

  // ---- FragmentsManager ----
  setStatus('Loading fragment worker...');
  const fragments = components.get(OBC.FragmentsManager);
  state.fragments = fragments;

  const workerResponse = await fetch(
    'https://thatopen.github.io/engine_fragment/resources/worker.mjs'
  );
  const workerBlob = await workerResponse.blob();
  const workerFile = new File([workerBlob], 'worker.mjs', {
    type: 'text/javascript',
  });
  const workerUrl = URL.createObjectURL(workerFile);
  fragments.init(workerUrl);

  // Start render loop now that fragments.core is available
  const composerRef = state._composerRef;
  function renderLoop() {
    requestAnimationFrame(renderLoop);
    try { fragments.core.update(); } catch (_) {}
    composerRef.render();
  }
  renderLoop();

  // Wire model loading — multi-file aware
  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);

    let fitted = false;
    model.onViewUpdated.add(() => {
      fragments.core.update(true);
      if (!fitted && model.object.children.length > 0) {
        fitted = true;
        fitCameraToAllModels();
        recomputeClipBounds();
        if (state.pbrEnabled) setTimeout(applyPBR, 100);
      }
    });
  });

  // ---- Hider (visibility control) ----
  const hider = components.get(OBC.Hider);
  state.hider = hider;

  // ---- Raycaster for picking ----
  const casters = components.get(OBC.Raycasters);
  const caster = casters.get(world);
  state.caster = caster;

  // ---- IFC Loader ----
  setStatus('Setting up IFC loader...');
  const ifcLoader = components.get(OBC.IfcLoader);
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: {
      path: '/wasm/',
      absolute: true,
    },
  });
  state.ifcLoader = ifcLoader;

  setStatus('Ready — Open an IFC file or drag & drop');
  console.log('geobim.lab initialized');

  setupUI();
  setupDragDrop();
  setupClipping();
}

// =====================================
// FIT CAMERA
// =====================================

function fitCameraToAllModels() {
  const bbox = new THREE.Box3();
  let hasContent = false;
  for (const f of state.files) {
    if (f.model && f.model.object && f.model.object.children.length > 0) {
      bbox.expandByObject(f.model.object);
      hasContent = true;
    }
  }
  if (!hasContent) return;

  // Clamp to grid — shift model so bottom sits on Y=0
  const yShift = bbox.min.y;
  if (Math.abs(yShift) > 0.001) {
    const offset = new THREE.Vector3(0, yShift, 0);
    shiftAllGeometry(offset);
    bbox.min.y -= yShift;
    bbox.max.y -= yShift;
  }

  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    state.world.camera.controls.setLookAt(
      center.x + maxDim, center.y + maxDim * 0.5, center.z + maxDim,
      center.x, center.y, center.z,
      true
    );
  }
}

// =====================================
// IFC CATEGORIES & LOAD DIALOG
// =====================================

const IFC_CATEGORIES = {
  'Structure':     { types: ['IfcWall','IfcWallStandardCase','IfcSlab','IfcColumn','IfcBeam','IfcFooting','IfcPile','IfcPlate','IfcMember'], default: true },
  'Openings':      { types: ['IfcWindow','IfcDoor','IfcOpeningElement','IfcCurtainWall'], default: true },
  'Roof & Stairs': { types: ['IfcRoof','IfcStair','IfcStairFlight','IfcRamp','IfcRampFlight','IfcRailing'], default: true },
  'MEP':           { types: ['IfcDuctSegment','IfcDuctFitting','IfcPipeSegment','IfcPipeFitting','IfcFlowTerminal','IfcFlowSegment','IfcFlowFitting','IfcAirTerminal','IfcSanitaryTerminal','IfcFireSuppressionTerminal'], default: true },
  'HVAC':          { types: ['IfcFan','IfcCoil','IfcFilter','IfcDamper','IfcBoiler','IfcChiller','IfcHeatExchanger','IfcPump','IfcValve','IfcHumidifier','IfcUnitaryEquipment','IfcSpaceHeater'], default: true },
  'Electrical':    { types: ['IfcCableSegment','IfcCableFitting','IfcCableCarrierSegment','IfcJunctionBox','IfcLightFixture','IfcOutlet','IfcSwitchingDevice'], default: true },
  'Furnishing':    { types: ['IfcFurnishingElement','IfcFurniture','IfcSystemFurnitureElement'], default: true },
  'Covering':      { types: ['IfcCovering','IfcBuildingElementProxy'], default: true },
  'Rebar':         { types: ['IfcReinforcingBar','IfcReinforcingMesh','IfcReinforcingElement','IfcTendon','IfcTendonAnchor'], default: false },
  'Spaces':        { types: ['IfcSpace','IfcSpaceBoundary'], default: false },
  'Site':          { types: ['IfcSite','IfcBuilding','IfcBuildingStorey','IfcProject'], default: false },
};

function showLoadDialog(fileName, sizeMB) {
  return new Promise((resolve) => {
    const categories = Object.entries(IFC_CATEGORIES).map(([name, def]) => ({
      name, types: def.types, default: def.default,
    }));
    // "Other" catch-all — always added, default on
    categories.push({ name: 'Other', types: ['__OTHER__'], default: true });

    const overlay = document.createElement('div');
    overlay.className = 'load-dialog-overlay';

    let catHtml = '';
    categories.forEach((cat, i) => {
      catHtml += `<label class="load-dialog-cat">
        <input type="checkbox" ${cat.default ? 'checked' : ''} data-idx="${i}">
        <span>${escapeHtml(cat.name)}</span>
        <span class="load-dialog-types">${cat.types.length} types</span>
      </label>`;
    });

    overlay.innerHTML = `
      <div class="load-dialog">
        <div class="load-dialog-header">
          <span>Load ${escapeHtml(fileName)} (${sizeMB} MB)</span>
        </div>
        <div class="load-dialog-body">
          <div class="load-dialog-actions">
            <button class="filter-btn" id="ldAll">All</button>
            <button class="filter-btn" id="ldNone">None</button>
            <button class="filter-btn" id="ldInvert">Invert</button>
          </div>
          ${catHtml}
        </div>
        <div class="load-dialog-footer">
          <button class="topbar-btn" id="ldCancel">Cancel</button>
          <button class="topbar-btn primary" id="ldLoad">Load Selected</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const checkboxes = overlay.querySelectorAll('input[type="checkbox"]');
    overlay.querySelector('#ldAll').onclick = () => checkboxes.forEach((cb) => { cb.checked = true; });
    overlay.querySelector('#ldNone').onclick = () => checkboxes.forEach((cb) => { cb.checked = false; });
    overlay.querySelector('#ldInvert').onclick = () => checkboxes.forEach((cb) => { cb.checked = !cb.checked; });

    overlay.querySelector('#ldCancel').onclick = () => { overlay.remove(); resolve(null); };
    overlay.querySelector('#ldLoad').onclick = () => {
      const selected = new Set();
      checkboxes.forEach((cb) => {
        if (cb.checked) {
          categories[parseInt(cb.dataset.idx)].types.forEach((t) => selected.add(t));
        }
      });
      overlay.remove();
      resolve(selected);
    };
  });
}

// =====================================
// IFC LOADING (Multi-file)
// =====================================

async function loadIFC(file) {
  if (!state.ifcLoader || !state.world) {
    setStatus('Error: Viewer not initialized');
    return;
  }

  const sizeMB = (file.size / 1024 / 1024).toFixed(1);

  // Show type filter dialog
  const selectedTypes = await showLoadDialog(file.name, sizeMB);
  if (!selectedTypes) { setStatus('Load cancelled'); return; }

  showLoading(`Loading ${file.name} (${sizeMB} MB)...`);
  setStatus('Loading IFC...');

  try {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    state.lastFileBuffer = data;
    state.lastFileName = file.name;

    // Parse IFC material names for PBR matching
    const parsedMats = parseIfcMaterials(data);
    for (const [id, name] of parsedMats) state.materialMap.set(id, name);

    updateProgress(20);

    const model = await state.ifcLoader.load(data, false, file.name);

    // Preserve vertex arrays before GPU upload deletes them
    // ThatOpen sets onUploadCallback = function(){delete this.array}
    // Arrays kept in CPU memory by prototype patch (no preserveBufferArrays needed)

    // If wrapper exists, move newly added model content into it
    if (state.modelWrapper) {
      const scene = state.world.scene.three;
      const newChildren = [...scene.children].filter((c) =>
        c !== state.modelWrapper && c.name !== 'originMarker' && c.name !== 'grid'
      );
      newChildren.forEach((c) => { scene.remove(c); state.modelWrapper.add(c); });
    }

    updateProgress(100);

    // Model ID is the filename key in fragments.list
    const modelId = [...state.fragments.list.keys()].find(k => state.fragments.list.get(k) === model) || file.name;

    // Register file
    const fileEntry = {
      id: state.fileIdCounter++,
      name: file.name,
      size: file.size,
      modelId: modelId,
      model: model,
      buffer: data,
      elementCount: 0,
      color: FILE_COLORS[state.files.length % FILE_COLORS.length],
      visible: true,
    };

    // Count elements & hide unselected categories
    try {
      const itemsMap = await model.getItems();
      fileEntry.elementCount = itemsMap ? itemsMap.size : 0;

      if (itemsMap && state.hider) {
        // Build case-insensitive lookup from selectedTypes
        const selectedLower = new Set([...selectedTypes].map((t) => t.toLowerCase()));
        const otherSelected = selectedTypes.has('__OTHER__');
        // Collect all known types (from all categories) for "Other" detection
        const allKnownLower = new Set();
        for (const catDef of Object.values(IFC_CATEGORIES)) {
          catDef.types.forEach((t) => allKnownLower.add(t.toLowerCase()));
        }
        const hideIds = [];
        const foundCats = new Set();
        itemsMap.forEach((rawItem, localId) => {
          const cat = rawItem.category || '';
          foundCats.add(cat);
          const catLower = cat.toLowerCase();
          if (allKnownLower.has(catLower)) {
            // Known type — check if its category was selected
            if (!selectedLower.has(catLower)) hideIds.push(localId);
          } else {
            // Unknown type — show if "Other" is selected
            if (!otherSelected) hideIds.push(localId);
          }
        });
        console.log('IFC categories found:', [...foundCats].sort().join(', '));
        if (hideIds.length > 0) {
          console.log(`Hiding ${hideIds.length} elements (unselected categories)`);
          await state.hider.set(false, { [modelId]: new Set(hideIds) });
          state.fragments.core.update(true);
        }
      }
    } catch (_) {}

    state.files.push(fileEntry);

    setStatus(`${file.name} loaded`);
    console.log('IFC loaded:', file.name, `${(file.size / 1024 / 1024).toFixed(1)} MB`);
    hideLoading();

    // Auto-detect georeferencing from IFC
    autoDetectGeoref(data);

    // CRS panel — decode IFC text and show georef status
    try {
      const ifcText = new TextDecoder('utf-8', { fatal: false }).decode(data);
      updateCrsPanel(ifcText);
    } catch (_) {}

    updateFilesBadge();
    renderFilesPanel();
    buildModelTree();
    invalidateGlbCache();
    preGenerateGlb(state);
  } catch (err) {
    console.error('IFC loading failed:', err);
    setStatus('Error: ' + err.message);
    hideLoading();
  }
}

// =====================================
// SERVER MODELS
// =====================================

async function loadServerModel(url, name) {
  if (!state.ifcLoader || !state.world) {
    setStatus('Error: Viewer not initialized');
    return;
  }

  showLoading(`Downloading ${name}...`);
  setStatus(`Downloading ${name}...`);

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = await response.arrayBuffer();
    const data = new Uint8Array(buffer);
    const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);

    // Parse IFC material names for PBR matching
    const parsedMats = parseIfcMaterials(data);
    for (const [id, name2] of parsedMats) state.materialMap.set(id, name2);

    updateProgress(30);
    setStatus(`Loading ${name} (${sizeMB} MB)...`);

    const model = await state.ifcLoader.load(data, false, name);

    // Arrays kept in CPU memory by prototype patch (no preserveBufferArrays needed)

    const modelId = [...state.fragments.list.keys()].find(k => state.fragments.list.get(k) === model) || name;

    state.lastFileBuffer = data;
    state.lastFileName = name;

    const fileEntry = {
      id: state.fileIdCounter++,
      name: name,
      size: buffer.byteLength,
      modelId: modelId,
      model: model,
      buffer: data,
      elementCount: 0,
      color: FILE_COLORS[state.files.length % FILE_COLORS.length],
      visible: true,
    };

    try {
      const itemsMap = await model.getItems();
      fileEntry.elementCount = itemsMap ? itemsMap.size : 0;
    } catch (_) {}

    state.files.push(fileEntry);

    updateProgress(100);
    setStatus(`${name} loaded`);
    console.log('Server IFC loaded:', name, `${sizeMB} MB`);
    hideLoading();

    // CRS panel
    try {
      const ifcText = new TextDecoder('utf-8', { fatal: false }).decode(data);
      updateCrsPanel(ifcText);
    } catch (_) {}

    updateFilesBadge();
    renderFilesPanel();
    buildModelTree();
    invalidateGlbCache();
    preGenerateGlb(state);
  } catch (err) {
    console.error('Server model load failed:', err);
    setStatus('Error: ' + err.message);
    hideLoading();
  }
}

async function setupServerModels() {
  const btn = document.getElementById('serverModelsBtn');
  const menu = document.getElementById('serverModelsMenu');
  if (!btn || !menu) return;

  btn.addEventListener('click', () => {
    menu.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.add('hidden');
    }
  });

  try {
    const res = await fetch('/models/index.php');
    if (!res.ok) throw new Error('No models index');
    const models = await res.json();

    if (models.length === 0) {
      menu.innerHTML = '<div class="dropdown-empty">No models available</div>';
      return;
    }

    menu.innerHTML = '';
    models.forEach((m) => {
      const item = document.createElement('button');
      item.className = 'dropdown-item';
      item.textContent = m.name;
      item.title = `${m.file} (${m.size})`;
      item.addEventListener('click', () => {
        menu.classList.add('hidden');
        loadServerModel(`/models/${m.file}`, m.name);
      });
      menu.appendChild(item);
    });
  } catch (err) {
    menu.innerHTML = '<div class="dropdown-empty">Could not load model list</div>';
  }
}

// =====================================
// FILE MANAGER PANEL
// =====================================

function updateFilesBadge() {
  const badge = document.getElementById('filesBadge');
  if (badge) {
    const count = state.files.length;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
}

function renderFilesPanel() {
  const list = document.getElementById('filesList');
  const info = document.getElementById('filesTotalInfo');
  if (!list) return;

  if (state.files.length === 0) {
    list.innerHTML = '<p class="files-empty">No files loaded</p>';
    if (info) info.textContent = '';
    updateMergeButton();
    updateDownloadButton();
    return;
  }

  const totalElements = state.files.reduce((s, f) => s + f.elementCount, 0);
  const totalSize = state.files.reduce((s, f) => s + f.size, 0);
  if (info) info.textContent = `${state.files.length} files · ${totalElements} elements · ${formatSize(totalSize)}`;

  list.innerHTML = '';
  state.files.forEach((f) => {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-card-color" style="background:${f.color}"></div>
      <div class="file-card-info">
        <div class="file-card-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="file-card-meta">
          <span>${f.elementCount} elements</span>
          <span>${formatSize(f.size)}</span>
        </div>
      </div>
      <div class="file-card-actions">
        <button class="file-card-btn" title="${f.visible ? 'Hide' : 'Show'}" data-action="toggle" data-id="${f.id}">
          ${f.visible ? eyeIcon() : eyeOffIcon()}
        </button>
        <button class="file-card-btn danger" title="Remove" data-action="remove" data-id="${f.id}">
          ${trashIcon()}
        </button>
      </div>
    `;
    list.appendChild(card);
  });

  // Wire buttons
  list.querySelectorAll('[data-action="toggle"]').forEach((btn) => {
    btn.addEventListener('click', () => toggleFileVisibility(parseInt(btn.dataset.id)));
  });
  list.querySelectorAll('[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', () => removeFile(parseInt(btn.dataset.id)));
  });

  updateMergeButton();
  updateDownloadButton();
}

function toggleFileVisibility(fileId) {
  const f = state.files.find((x) => x.id === fileId);
  if (!f || !f.model) return;
  f.visible = !f.visible;
  f.model.object.visible = f.visible;
  state.fragments.core.update(true);
  renderFilesPanel();
}

function removeFile(fileId) {
  const idx = state.files.findIndex((x) => x.id === fileId);
  if (idx === -1) return;
  const f = state.files[idx];

  // Remove from scene
  if (f.model && f.model.object) {
    state.world.scene.three.remove(f.model.object);
  }

  // Dispose model from fragments
  try {
    if (f.model) {
      state.fragments.list.delete(f.modelId);
      f.model.dispose();
    }
  } catch (err) {
    console.warn('Model dispose error:', err);
  }

  // Remove hidden/deleted items for this model
  for (const [key] of state.hiddenItems) {
    if (key.startsWith(f.modelId + ':')) state.hiddenItems.delete(key);
  }
  for (const key of state.deletedSet) {
    if (key.startsWith(f.modelId + ':')) state.deletedSet.delete(key);
  }

  state.files.splice(idx, 1);
  state.fragments.core.update(true);

  updateFilesBadge();
  renderFilesPanel();
  buildModelTree();
  recomputeClipBounds();
  updateHideBadge();
  updateDeleteBadge();
  setStatus(state.files.length > 0 ? `${f.name} removed` : 'Ready');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// =====================================
// IFC MERGE & DOWNLOAD
// =====================================

function updateMergeButton() {
  const btn = document.getElementById('mergeIfc');
  if (btn) btn.classList.toggle('hidden', state.files.filter(f => f.buffer).length < 2);
}

function updateDownloadButton() {
  const btn = document.getElementById('downloadIfc');
  if (btn) btn.classList.toggle('hidden', !state.files.some(f => f.buffer));
}

function parseStepData(text) {
  const dataStart = text.indexOf('DATA;');
  const dataEnd = text.indexOf('ENDSEC;', dataStart);
  if (dataStart === -1 || dataEnd === -1) return null;
  const dataBlock = text.substring(dataStart + 5, dataEnd).trim();
  const lines = dataBlock.split(/\r?\n/).filter(l => l.trim().startsWith('#'));
  let maxId = 0;
  const entities = [];
  for (const line of lines) {
    const m = line.match(/^#(\d+)\s*=/);
    if (m) {
      const id = parseInt(m[1]);
      if (id > maxId) maxId = id;
      entities.push({ id, line: line.trim() });
    }
  }
  return { entities, maxId };
}

function extractSchema(text) {
  const m = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
  return m ? m[1] : 'IFC4';
}

function extractLengthUnit(text) {
  const m = text.match(/IFCSIUNIT\s*\([^)]*,\s*\.LENGTHUNIT\.\s*,\s*([^,)]*)\s*,\s*([^)]*)\)/i);
  if (!m) return 'METRE';
  const prefix = m[1].replace(/[\.\$\s]/g, '');
  const name = m[2].replace(/[\.\$\s]/g, '');
  return prefix ? `${prefix} ${name}` : name;
}

function extractGuids(text) {
  const guids = [];
  const re = /^#\d+\s*=\s*IFC\w+\s*\(\s*'([^']+)'/gim;
  let m;
  while ((m = re.exec(text)) !== null) guids.push(m[1]);
  return guids;
}

/**
 * Extract CRS / georeferencing info from raw IFC text.
 *
 * Parses IfcSite lat/lon, IfcMapConversion, IfcProjectedCRS via regex.
 * No IFC parser needed — works on the raw STEP text.
 *
 * @param {string} ifcText - Raw IFC file content as string
 * @returns {{
 *   site: { lat: number|null, lon: number|null },
 *   mapConversion: { exists: boolean, eastings: number|null, northings: number|null,
 *                    height: number|null, xAxis: number|null, scale: number|null },
 *   projectedCRS: { exists: boolean, name: string|null, epsg: string|null },
 *   diagnosis: { isRevitDefault: boolean, isFullyGeoReferenced: boolean,
 *                isPartial: boolean, recommendation: string }
 * }}
 *
 * @example
 * // Example IFC snippets this function handles:
 * // #101=IFCSITE('guid',$,'Site',$,$,#102,$,$,.ELEMENT.,(52,31,12,0),(13,24,44,0),0.,$,$);
 * // #200=IFCMAPCONVERSION(#180,#201,388800.0,5819600.0,0.0,1.0,0.0,1.0);
 * // #201=IFCPROJECTEDCRS('EPSG:25833','ETRS89 / UTM zone 33N',$,$,$,$,$);
 */
function extractCRSInfo(ifcText) {
  const result = {
    site: { lat: null, lon: null },
    mapConversion: { exists: false, eastings: null, northings: null, height: null, xAxisAbscissa: null, xAxisOrdinate: null, scale: null },
    projectedCRS: { exists: false, name: null, epsg: null },
    diagnosis: { isRevitDefault: false, isFullyGeoReferenced: false, isPartial: false, recommendation: 'CRS nicht lesbar' }
  };

  if (!ifcText) return result;

  try {
    // ── IfcSite: RefLatitude / RefLongitude ──
    // Format: IFCSITE('guid',...,(deg,min,sec,millionthsec),(deg,min,sec,millionthsec),elevation,...);
    const siteRe = /IFCSITE\s*\([^)]*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\s*,\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i;
    const siteMatch = ifcText.match(siteRe);
    if (siteMatch) {
      const dms = (d, m, s, ms) => parseInt(d) + parseInt(m) / 60 + parseInt(s) / 3600 + parseInt(ms) / 3600000000;
      result.site.lat = dms(siteMatch[1], siteMatch[2], siteMatch[3], siteMatch[4]);
      result.site.lon = dms(siteMatch[5], siteMatch[6], siteMatch[7], siteMatch[8]);
    }

    // ── IfcMapConversion ──
    // IFC4 schema: IFCMAPCONVERSION(SourceCRS, TargetCRS, Eastings, Northings,
    //              OrthogonalHeight, XAxisAbscissa, XAxisOrdinate, Scale)
    //              Index:            #ref       #ref       1          2
    //                                3               4              5        6
    const mcRe = /IFCMAPCONVERSION\s*\(\s*#\d+\s*,\s*#\d+\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,)]+)(?:\s*,\s*([^,)]+))?\s*\)/i;
    const mcMatch = ifcText.match(mcRe);
    if (mcMatch) {
      result.mapConversion.exists = true;
      result.mapConversion.eastings = parseFloat(mcMatch[1]);       // Eastings
      result.mapConversion.northings = parseFloat(mcMatch[2]);      // Northings
      result.mapConversion.height = parseFloat(mcMatch[3]);         // OrthogonalHeight
      result.mapConversion.xAxisAbscissa = parseFloat(mcMatch[4]);  // XAxisAbscissa
      result.mapConversion.xAxisOrdinate = parseFloat(mcMatch[5]);  // XAxisOrdinate
      result.mapConversion.scale = mcMatch[6] && mcMatch[6].trim() !== '$' ? parseFloat(mcMatch[6]) : 1.0;
    }

    // ── IfcProjectedCRS ──
    // IFCPROJECTEDCRS('name','description',$,$,$,$,$)
    const crsRe = /IFCPROJECTEDCRS\s*\(\s*'([^']*)'/i;
    const crsMatch = ifcText.match(crsRe);
    if (crsMatch) {
      result.projectedCRS.exists = true;
      result.projectedCRS.name = crsMatch[1];
      // Extract EPSG code from name (e.g. 'EPSG:25833' or 'ETRS89 / UTM zone 33N')
      const epsgMatch = crsMatch[1].match(/EPSG[:\s]*(\d+)/i);
      if (epsgMatch) {
        result.projectedCRS.epsg = 'EPSG:' + epsgMatch[1];
      }
    }

    // ── Diagnosis ──
    const lat = result.site.lat;
    const lon = result.site.lon;
    const hasLatLon = lat !== null && lon !== null;
    const hasMC = result.mapConversion.exists;
    const hasCRS = result.projectedCRS.exists;

    // Revit default: Berlin ~52.5°N, 13.4°E (placeholder coordinates)
    if (hasLatLon) {
      result.diagnosis.isRevitDefault = Math.abs(lat - 52.5) < 0.5 && Math.abs(lon - 13.4) < 0.5;
    }

    if (hasMC && hasCRS) {
      result.diagnosis.isFullyGeoReferenced = true;
      result.diagnosis.isPartial = false;
      if (result.diagnosis.isRevitDefault) {
        result.diagnosis.recommendation = 'IfcMapConversion + CRS vorhanden, aber IfcSite enthält Revit-Standardkoordinaten — Lage prüfen';
      } else {
        result.diagnosis.recommendation = 'Vollständig georeferenziert — direkt verwendbar';
      }
    } else if (hasLatLon && !result.diagnosis.isRevitDefault) {
      result.diagnosis.isPartial = true;
      result.diagnosis.recommendation = hasCRS
        ? 'IfcSite + CRS vorhanden, IfcMapConversion fehlt — manuelle Positionierung empfohlen'
        : 'Nur IfcSite-Koordinaten — Genauigkeit begrenzt, manuelle Positionierung empfohlen';
    } else if (hasMC && !hasCRS) {
      result.diagnosis.isPartial = true;
      result.diagnosis.recommendation = 'IfcMapConversion ohne CRS — Koordinatensystem unbekannt, EPSG manuell setzen';
    } else if (hasLatLon && result.diagnosis.isRevitDefault) {
      result.diagnosis.recommendation = 'Nur Revit-Standardkoordinaten (Berlin) — keine echte Georeferenzierung, manuell positionieren';
    } else {
      result.diagnosis.recommendation = 'Keine Georeferenzierung gefunden — manuell positionieren';
    }
  } catch (e) {
    console.warn('extractCRSInfo error:', e);
  }

  return result;
}

function remapIds(line, offset) {
  return line.replace(/#(\d+)/g, (_, id) => `#${parseInt(id) + offset}`);
}

const SHARED_TYPES = new Set([
  'IFCUNITASSIGNMENT',
  'IFCGEOMETRICREPRESENTATIONCONTEXT',
  'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
]);

function mergeStepTexts(texts) {
  const firstText = texts[0];
  const firstSchema = extractSchema(firstText);
  const firstData = parseStepData(firstText);
  if (!firstData) throw new Error('Could not parse DATA section of first file');

  let firstProjectId = null;
  for (const e of firstData.entities) {
    if (/=\s*IFCPROJECT\s*\(/i.test(e.line)) { firstProjectId = e.id; break; }
  }

  const mergedLines = firstData.entities.map(e => e.line);
  let currentMaxId = firstData.maxId;
  let totalEntities = firstData.entities.length;

  for (let fi = 1; fi < texts.length; fi++) {
    const data = parseStepData(texts[fi]);
    if (!data) continue;
    const offset = currentMaxId;

    let fileProjectId = null;
    for (const e of data.entities) {
      if (/=\s*IFCPROJECT\s*\(/i.test(e.line)) { fileProjectId = e.id; break; }
    }

    for (const e of data.entities) {
      const typeMatch = e.line.match(/=\s*(IFC\w+)\s*\(/i);
      const entType = typeMatch ? typeMatch[1].toUpperCase() : '';
      if (entType === 'IFCPROJECT') continue;
      if (SHARED_TYPES.has(entType)) continue;

      let remapped = remapIds(e.line, offset);
      if (entType === 'IFCRELAGGREGATES' && firstProjectId && fileProjectId) {
        const remappedProjectRef = `#${fileProjectId + offset}`;
        if (remapped.includes(remappedProjectRef)) {
          remapped = remapped.replace(remappedProjectRef, `#${firstProjectId}`);
        }
      }
      mergedLines.push(remapped);
      totalEntities++;
    }
    currentMaxId += data.maxId;
  }

  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  let output = 'ISO-10303-21;\n';
  output += 'HEADER;\n';
  output += `FILE_DESCRIPTION(('Merged IFC'),'2;1');\n`;
  output += `FILE_NAME('merged.ifc','${now}',(''),(''),'geobim.lab','geobim.lab','');\n`;
  output += `FILE_SCHEMA(('${firstSchema}'));\n`;
  output += 'ENDSEC;\n';
  output += 'DATA;\n';
  output += mergedLines.join('\n') + '\n';
  output += 'ENDSEC;\n';
  output += 'END-ISO-10303-21;\n';
  return { content: output, totalEntities, modelCount: texts.length };
}

function showMergeConflictDialog(unitConflicts, guidConflicts, schemaConflict) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'load-dialog-overlay';
    let html = '<div class="load-dialog"><div class="load-dialog-header">';
    html += '<div class="load-dialog-title">IFC Merge — Conflicts detected</div></div>';
    html += '<div class="load-dialog-body" style="max-height:400px;overflow-y:auto;">';

    if (schemaConflict) {
      html += '<div style="margin-bottom:12px;"><div style="font-weight:600;color:#ef4444;margin-bottom:6px;">Schema Conflict</div>';
      html += '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">Files use different IFC schemas. The merged file will use the schema of the first file.</div>';
      html += '<table style="width:100%;font-size:12px;border-collapse:collapse;">';
      schemaConflict.forEach(s => { html += `<tr><td style="padding:2px 8px 2px 0;color:var(--text-primary);">${s.file}</td><td style="color:var(--text-muted);">${s.schema}</td></tr>`; });
      html += '</table></div>';
    }
    if (unitConflicts) {
      html += '<div style="margin-bottom:12px;"><div style="font-weight:600;color:#f59e0b;margin-bottom:6px;">Unit Conflict</div>';
      html += '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">Files use different length units. The merged file will use the units of the first file.</div>';
      html += '<table style="width:100%;font-size:12px;border-collapse:collapse;">';
      unitConflicts.forEach(u => { html += `<tr><td style="padding:2px 8px 2px 0;color:var(--text-primary);">${u.file}</td><td style="color:var(--text-muted);">${u.unit}</td></tr>`; });
      html += '</table></div>';
    }
    if (guidConflicts) {
      html += `<div><div style="font-weight:600;color:#f59e0b;margin-bottom:6px;">GUID Conflicts (${guidConflicts.length})</div>`;
      html += '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">Duplicate GlobalIds found across files.</div>';
      const shown = guidConflicts.slice(0, 20);
      html += '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
      shown.forEach(c => { html += `<tr><td style="padding:2px 8px 2px 0;font-family:monospace;color:var(--text-primary);">${c.guid.substring(0, 22)}</td><td style="color:var(--text-muted);">${c.files.join(', ')}</td></tr>`; });
      if (guidConflicts.length > 20) html += `<tr><td colspan="2" style="padding:4px 0;color:var(--text-muted);font-style:italic;">...and ${guidConflicts.length - 20} more</td></tr>`;
      html += '</table></div>';
    }

    html += '</div><div class="load-dialog-footer">';
    html += '<button class="load-dialog-btn secondary" id="mergeCancelBtn">Cancel</button>';
    html += '<button class="load-dialog-btn primary" id="mergeProceedBtn">Merge anyway</button>';
    html += '</div></div>';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    document.getElementById('mergeCancelBtn').addEventListener('click', () => { document.body.removeChild(overlay); resolve(false); });
    document.getElementById('mergeProceedBtn').addEventListener('click', () => { document.body.removeChild(overlay); resolve(true); });
  });
}

async function mergeIFC() {
  const ifcFiles = state.files.filter(f => f.buffer);
  if (ifcFiles.length < 2) return;

  setStatus('Preparing merge...');
  showLoading('Analysing files...');
  updateProgress(10);

  const texts = ifcFiles.map(f => new TextDecoder().decode(f.buffer));

  const schemas = ifcFiles.map((f, i) => ({ file: f.name, schema: extractSchema(texts[i]) }));
  const uniqueSchemas = new Set(schemas.map(s => s.schema));
  const schemaConflict = uniqueSchemas.size > 1 ? schemas : null;

  const units = ifcFiles.map(f => ({ file: f.name, unit: extractLengthUnit(new TextDecoder().decode(f.buffer)) }));
  const unitConflicts = new Set(units.map(u => u.unit)).size > 1 ? units : null;

  updateProgress(30);
  const guidMap = new Map();
  for (const f of ifcFiles) {
    const text = new TextDecoder().decode(f.buffer);
    for (const guid of extractGuids(text)) {
      if (!guidMap.has(guid)) guidMap.set(guid, []);
      guidMap.get(guid).push(f.name);
    }
  }
  const guidDups = [];
  for (const [guid, files] of guidMap) {
    const unique = [...new Set(files)];
    if (unique.length > 1) guidDups.push({ guid, files: unique });
  }
  const guidConflicts = guidDups.length > 0 ? guidDups : null;
  updateProgress(40);

  if (schemaConflict || unitConflicts || guidConflicts) {
    hideLoading();
    const proceed = await showMergeConflictDialog(unitConflicts, guidConflicts, schemaConflict);
    if (!proceed) { setStatus('Merge cancelled'); return; }
    showLoading('Merging IFC files...');
  }

  updateProgress(50);
  try {
    setStatus('Merging...');
    const result = mergeStepTexts(texts);
    updateProgress(90);

    const mergedName = 'merged_' + ifcFiles.map(f => f.name.replace(/\.ifc$/i, '')).join('_') + '.ifc';
    const blob = new Blob([result.content], { type: 'application/x-step' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = mergedName.length > 80 ? 'merged.ifc' : mergedName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    updateProgress(100);
    hideLoading();
    const sizeMB = (result.content.length / 1024 / 1024).toFixed(1);
    setStatus(`Merged ${result.modelCount} files — ${result.totalEntities} entities (${sizeMB} MB)`);
  } catch (err) {
    console.error('IFC merge failed:', err);
    hideLoading();
    setStatus(`Merge error: ${err.message}`);
  }
}

function downloadIFC() {
  const ifcFiles = state.files.filter(f => f.buffer);
  if (ifcFiles.length === 0) { setStatus('No IFC files loaded'); return; }

  // Collect deleted expressIDs per file
  const deletedByFile = new Map();
  for (const entry of state.deletedStack) {
    const f = state.files.find(fl => fl.modelId === entry.modelId);
    if (f) {
      if (!deletedByFile.has(f.id)) deletedByFile.set(f.id, new Set());
      deletedByFile.get(f.id).add(entry.localId);
    }
  }

  const processedTexts = [];
  for (const f of ifcFiles) {
    const text = new TextDecoder().decode(f.buffer);
    const deletedIds = deletedByFile.get(f.id);
    if (!deletedIds || deletedIds.size === 0) {
      processedTexts.push(text);
      continue;
    }
    // Strip deleted entities from STEP text
    const dataStart = text.indexOf('DATA;');
    const dataEnd = text.indexOf('ENDSEC;', dataStart);
    if (dataStart === -1 || dataEnd === -1) { processedTexts.push(text); continue; }

    const header = text.substring(0, dataStart + 5);
    const dataBlock = text.substring(dataStart + 5, dataEnd).trim();
    const lines = dataBlock.split(/\r?\n/);
    const filteredLines = lines.filter(line => {
      const m = line.trim().match(/^#(\d+)\s*=/);
      if (!m) return true;
      return !deletedIds.has(parseInt(m[1]));
    });
    processedTexts.push(header + '\n' + filteredLines.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n');
  }

  let content, fileName;
  if (processedTexts.length === 1) {
    content = processedTexts[0];
    const baseName = ifcFiles[0].name.replace(/\.ifc$/i, '');
    fileName = deletedByFile.size > 0 ? `${baseName}_edited.ifc` : ifcFiles[0].name;
  } else {
    const result = mergeStepTexts(processedTexts);
    content = result.content;
    fileName = 'merged_edited.ifc';
  }

  const blob = new Blob([content], { type: 'application/x-step' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const sizeMB = (content.length / 1024 / 1024).toFixed(1);
  const delCount = state.deletedStack.length;
  setStatus(`Downloaded ${fileName} (${sizeMB} MB${delCount > 0 ? `, ${delCount} elements removed` : ''})`);
}

// =====================================
// MODEL TREE (Multi-file + Type Filter)
// =====================================

async function buildModelTree() {
  const container = document.getElementById('modelTree');
  const filterActions = document.getElementById('filterActions');
  if (!container) return;

  if (state.files.length === 0) {
    container.innerHTML = '<p class="empty-state">Load an IFC file to see the model tree</p>';
    if (filterActions) filterActions.style.display = 'none';
    return;
  }

  container.innerHTML = '<p class="empty-state">Building tree...</p>';
  document.getElementById('sidebar')?.classList.remove('hidden');
  document.getElementById('toggleTree')?.classList.add('active');
  if (filterActions) filterActions.style.display = 'flex';

  let totalElements = 0;
  const allGroups = []; // { fileEntry, type, items[] }

  // Build groups from all files
  for (const fileEntry of state.files) {
    try {
      const itemsMap = await fileEntry.model.getItems();
      if (!itemsMap || itemsMap.size === 0) continue;

      const groups = {};
      itemsMap.forEach((rawItem, localId) => {
        const category = rawItem.category || 'Unknown';
        const name = rawItem.data?.Name?.value || rawItem.data?.name?.value || '';
        const guid = rawItem.guid || '';
        if (!groups[category]) groups[category] = [];
        groups[category].push({ localId, name: String(name), guid });
      });

      Object.keys(groups).sort().forEach((type) => {
        allGroups.push({ fileEntry, type, items: groups[type] });
        totalElements += groups[type].length;
      });
    } catch (err) {
      console.warn('buildModelTree failed for', fileEntry.name, err);
    }
  }

  // Render tree
  container.innerHTML = '';

  // If multi-file, group by file
  if (state.files.length > 1) {
    for (const fileEntry of state.files) {
      const fileSection = document.createElement('div');
      fileSection.className = 'tree-file-section open';

      const fileHeader = document.createElement('div');
      fileHeader.className = 'tree-file-header';
      fileHeader.innerHTML = `<span class="tree-file-name" style="color:${fileEntry.color}">${escapeHtml(fileEntry.name)}</span>`;
      fileHeader.addEventListener('click', () => fileSection.classList.toggle('open'));
      fileSection.appendChild(fileHeader);

      const fileGroups = allGroups.filter((g) => g.fileEntry.id === fileEntry.id);
      fileGroups.forEach((g) => {
        fileSection.appendChild(createTreeGroup(g.fileEntry, g.type, g.items));
      });

      container.appendChild(fileSection);
    }
  } else {
    // Single file — flat groups
    allGroups.forEach((g) => {
      container.appendChild(createTreeGroup(g.fileEntry, g.type, g.items));
    });
  }

  // Wire search
  const searchInput = document.getElementById('treeSearch');
  const countEl = document.getElementById('treeCount');
  if (countEl) countEl.textContent = `${totalElements}`;

  if (searchInput) {
    // Remove old listeners by cloning
    const newSearch = searchInput.cloneNode(true);
    searchInput.parentNode.replaceChild(newSearch, searchInput);

    newSearch.addEventListener('input', () => {
      const q = newSearch.value.toLowerCase().trim();
      let visible = 0;

      container.querySelectorAll('.tree-group').forEach((group) => {
        const type = group.dataset.type || '';
        const leaves = group.querySelectorAll('.tree-leaf');
        let groupVisible = 0;

        leaves.forEach((leaf) => {
          const name = leaf.dataset.name || '';
          const id = leaf.dataset.localid || '';
          const match = !q || type.includes(q) || name.includes(q) || id.includes(q);
          leaf.classList.toggle('hidden-by-filter', !match);
          if (match) groupVisible++;
        });

        group.classList.toggle('hidden-by-filter', groupVisible === 0);
        if (q && groupVisible > 0) {
          group.classList.add('open');
        }
        visible += groupVisible;
      });

      if (countEl) countEl.textContent = q ? `${visible}/${totalElements}` : `${totalElements}`;
    });
  }

  setStatus(`${state.files.length} file(s) — ${totalElements} elements`);
}

function createTreeGroup(fileEntry, type, items) {
  const groupEl = document.createElement('div');
  groupEl.className = 'tree-group';
  groupEl.dataset.type = type.toLowerCase();
  groupEl.dataset.modelid = fileEntry.modelId;

  const header = document.createElement('div');
  header.className = 'tree-group-header';
  const color = typeColor(type);

  // Type filter checkbox
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'tree-checkbox';
  const visKey = `${fileEntry.modelId}:${type}`;
  checkbox.checked = state.typeVisibility.get(visKey) !== false;
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    const visible = checkbox.checked;
    state.typeVisibility.set(visKey, visible);
    setTypeVisibility(fileEntry.modelId, type, items, visible);
  });

  const label = document.createElement('span');
  label.className = 'tree-group-label';
  label.innerHTML = `<span class="type-badge" style="background:${color}"></span> ${escapeHtml(type)} (${items.length})`;

  header.appendChild(checkbox);
  header.appendChild(label);

  label.addEventListener('click', (e) => {
    e.stopPropagation();
    groupEl.classList.toggle('open');
  });

  const childrenWrap = document.createElement('div');
  childrenWrap.className = 'tree-items';

  items.forEach(({ localId, name }) => {
    const key = `${fileEntry.modelId}:${localId}`;
    if (state.deletedSet.has(key)) return; // skip deleted

    const item = document.createElement('div');
    item.className = 'tree-item tree-leaf';
    item.dataset.name = (name || '').toLowerCase();
    item.dataset.localid = localId;
    item.dataset.modelid = fileEntry.modelId;
    item.innerHTML = `<span>${escapeHtml(name || `#${localId}`)}</span>`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('modelTree')?.querySelectorAll('.tree-item.selected').forEach((el) => el.classList.remove('selected'));
      item.classList.add('selected');
      selectFromTree(fileEntry.modelId, localId);
    });
    childrenWrap.appendChild(item);
  });

  groupEl.appendChild(header);
  groupEl.appendChild(childrenWrap);
  return groupEl;
}

async function setTypeVisibility(modelId, type, items, visible) {
  if (!state.hider || !state.fragments) return;
  const model = state.fragments.list.get(modelId);
  if (!model) return;

  const localIds = items.map((i) => i.localId);
  const itemsObj = { [modelId]: new Set(localIds) };

  try {
    await state.hider.set(visible, itemsObj);
    state.fragments.core.update(true);
    invalidateGlbCache();
  } catch (err) {
    console.warn('setTypeVisibility failed:', err);
  }
}

async function selectFromTree(modelId, localId) {
  if (!state.fragments) return;

  const items = { [modelId]: new Set([localId]) };

  try {
    await state.fragments.resetHighlight();
    await state.fragments.highlight(
      { color: new THREE.Color(0x2ECFB0), opacity: 0.6, transparent: true },
      items
    );
  } catch (_) {}

  try {
    const model = state.fragments.list.get(modelId);
    if (model) {
      const data = await model.getItemsData([localId]);
      showProperties(data, localId);
    }
  } catch (err) {
    console.warn('selectFromTree properties failed:', err);
  }
}

// =====================================
// TYPE FILTER ACTIONS
// =====================================

function setupFilterActions() {
  document.getElementById('filterAll')?.addEventListener('click', () => {
    document.querySelectorAll('#modelTree .tree-checkbox').forEach((cb) => {
      if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    });
  });
  document.getElementById('filterNone')?.addEventListener('click', () => {
    document.querySelectorAll('#modelTree .tree-checkbox').forEach((cb) => {
      if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
    });
  });
  document.getElementById('filterInvert')?.addEventListener('click', () => {
    document.querySelectorAll('#modelTree .tree-checkbox').forEach((cb) => {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
  });
}

// =====================================
// ELEMENT SELECTION + PROPERTIES
// =====================================

async function handleSelection() {
  if (!state.caster || !state.fragments) return;

  // In hide mode, hide the clicked element
  if (state.hideMode) {
    await handleHideClick();
    return;
  }

  // In delete mode, delete the clicked element
  if (state.deleteMode) {
    await handleDeleteClick();
    return;
  }

  const result = await state.caster.castRay();

  try {
    await state.fragments.resetHighlight();
  } catch (_) {}

  if (!result || !result.object) return;

  let modelId = null;
  const localId = result.localId ?? result.itemId ?? null;

  if (result.fragments?.id) {
    modelId = result.fragments.id;
  } else if (state.fragments.list.size > 0) {
    modelId = state.fragments.list.keys().next().value;
  }

  if (modelId && localId != null) {
    const items = { [modelId]: new Set([localId]) };
    try {
      await state.fragments.highlight(
        { color: new THREE.Color(0x2ECFB0), opacity: 0.6, transparent: true },
        items
      );
    } catch (err) {
      console.warn('Highlight failed:', err);
    }

    try {
      const model = state.fragments.list.get(modelId);
      if (model) {
        const data = await model.getItemsData([localId]);
        // Get category + GUID from items map
        let category = null, guid = null;
        try {
          const itemsMap = await model.getItems();
          const itemInfo = itemsMap?.get(localId);
          if (itemInfo) {
            category = itemInfo.category || null;
            guid = itemInfo.guid || null;
          }
        } catch (_) {}
        showProperties(data, localId, category, guid);
        return;
      }
    } catch (err) {
      console.warn('getItemsData failed:', err);
    }
  }

  showPropertiesFallback(result);
}

function showProperties(dataArray, localId, category, guid) {
  const container = document.getElementById('propsContent');
  if (!container) return;

  document.getElementById('propsPanel')?.classList.remove('hidden');
  document.getElementById('toggleProps')?.classList.add('active');

  let html = '';

  // Element header with IFC Type and GlobalId
  html += '<div class="props-group">';
  html += '<div class="props-group-title">Element</div>';
  if (category) html += propRow('IFC Type', category);
  if (guid) html += propRow('GlobalId', guid);
  html += propRow('Local ID', localId);

  if (!dataArray || dataArray.length === 0) {
    html += '</div>';
    container.innerHTML = html;
    return;
  }

  dataArray.forEach((itemData) => {
    if (!itemData) return;
    const entries = Object.entries(itemData);
    const attrs = [];
    const psets = [];
    const qtos = [];

    entries.forEach(([key, val]) => {
      if (Array.isArray(val)) {
        // Separate Pset_ from Qto_ property sets
        if (key.toLowerCase().startsWith('qto_') || key.toLowerCase().startsWith('baseq')) {
          qtos.push([key, val]);
        } else {
          psets.push([key, val]);
        }
      } else if (val && typeof val === 'object' && 'value' in val) {
        attrs.push([key, val.value]);
      }
    });

    // Entity attributes in the header group
    attrs.forEach(([key, val]) => {
      html += propRow(key, formatValue(val));
    });
    html += '</div>';

    // Property Sets (Pset_*) — collapsible
    psets.forEach(([name, items]) => {
      html += '<div class="props-group collapsed">';
      html += `<div class="props-group-title" onclick="this.parentElement.classList.toggle('collapsed')"><span class="pset-toggle">&#9654;</span> ${escapeHtml(name)}</div>`;
      items.forEach((subItem) => {
        if (!subItem) return;
        Object.entries(subItem).forEach(([subKey, subVal]) => {
          if (subVal && typeof subVal === 'object' && 'value' in subVal) {
            html += propRow(subKey, formatValue(subVal.value));
          }
        });
      });
      html += '</div>';
    });

    // Quantities (Qto_*) — collapsible, formatted to 3 decimals
    qtos.forEach(([name, items]) => {
      html += '<div class="props-group collapsed">';
      html += `<div class="props-group-title" onclick="this.parentElement.classList.toggle('collapsed')"><span class="pset-toggle">&#9654;</span> ${escapeHtml(name)}</div>`;
      items.forEach((subItem) => {
        if (!subItem) return;
        Object.entries(subItem).forEach(([subKey, subVal]) => {
          if (subVal && typeof subVal === 'object' && 'value' in subVal) {
            const v = subVal.value;
            html += propRow(subKey, typeof v === 'number' ? v.toFixed(3) : formatValue(v));
          }
        });
      });
      html += '</div>';
    });
  });

  container.innerHTML = html || '<p class="empty-state">No properties found</p>';
}

function showPropertiesFallback(result) {
  const container = document.getElementById('propsContent');
  if (!container) return;

  document.getElementById('propsPanel')?.classList.remove('hidden');
  document.getElementById('toggleProps')?.classList.add('active');

  let html = '<div class="props-group">';
  html += '<div class="props-group-title">Element</div>';
  html += propRow('Local ID', result.localId ?? '--');
  html += propRow('Item ID', result.itemId ?? '--');
  html += propRow('Distance', result.distance?.toFixed(2) ?? '--');
  html += '</div>';
  container.innerHTML = html;
}

function propRow(key, value) {
  return `<div class="props-row"><span class="props-key">${escapeHtml(key)}</span><span class="props-value">${escapeHtml(String(value))}</span></div>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function typeColor(typeName) {
  let hash = 0;
  for (let i = 0; i < typeName.length; i++) {
    hash = typeName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

function formatValue(val) {
  if (val === null || val === undefined) return '--';
  if (typeof val === 'number') return Number.isInteger(val) ? val.toString() : val.toFixed(4);
  return String(val);
}

// =====================================
// HIDE MODE
// =====================================

function toggleHideMode() {
  if (state.deleteMode) toggleDeleteMode(); // exit delete mode first
  state.hideMode = !state.hideMode;
  document.getElementById('toggleHide')?.classList.toggle('active', state.hideMode);
  document.getElementById('hideBanner')?.classList.toggle('hidden', !state.hideMode);
  document.getElementById('showAllBtn')?.classList.toggle('hidden', state.hiddenItems.size === 0);

  if (state.hideMode) {
    setStatus('Hide Mode — click elements to hide');
  } else {
    setStatus('Hide mode off');
  }
}

async function handleHideClick() {
  if (!state.caster || !state.fragments) return;
  const result = await state.caster.castRay();
  if (!result || !result.object) return;

  let modelId = null;
  const localId = result.localId ?? result.itemId ?? null;

  if (result.fragments?.id) {
    modelId = result.fragments.id;
  } else if (state.fragments.list.size > 0) {
    modelId = state.fragments.list.keys().next().value;
  }

  if (modelId == null || localId == null) return;

  const key = `${modelId}:${localId}`;
  if (state.hiddenItems.has(key)) return;

  // Get name for display
  let name = `#${localId}`;
  try {
    const model = state.fragments.list.get(modelId);
    if (model) {
      const data = await model.getItemsData([localId]);
      if (data && data[0]) {
        const nameVal = data[0].Name?.value || data[0].name?.value;
        if (nameVal) name = String(nameVal);
      }
    }
  } catch (_) {}

  state.hiddenItems.set(key, { modelId, localId, name });

  // Hide using FragmentsManager visibility
  try {
    const items = { [modelId]: new Set([localId]) };
    await state.hider.set(false, items);
    state.fragments.core.update(true);
  } catch (err) {
    console.warn('Hide failed:', err);
  }

  updateHideBadge();
  document.getElementById('showAllBtn')?.classList.remove('hidden');
  invalidateGlbCache();
}

async function showAllHidden() {
  if (state.hiddenItems.size === 0) return;

  // Group by model
  const byModel = {};
  for (const [, val] of state.hiddenItems) {
    if (!byModel[val.modelId]) byModel[val.modelId] = new Set();
    byModel[val.modelId].add(val.localId);
  }

  try {
    await state.hider.set(true, byModel);
    state.fragments.core.update(true);
  } catch (err) {
    console.warn('Show all failed:', err);
  }

  state.hiddenItems.clear();
  updateHideBadge();
  document.getElementById('showAllBtn')?.classList.add('hidden');
  invalidateGlbCache();
  setStatus('All elements shown');
}

function updateHideBadge() {
  const badge = document.getElementById('hideBadge');
  if (badge) {
    const count = state.hiddenItems.size;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
}

// =====================================
// DELETE MODE
// =====================================

function toggleDeleteMode() {
  if (state.hideMode) toggleHideMode(); // exit hide mode first
  state.deleteMode = !state.deleteMode;
  document.getElementById('toggleDelete')?.classList.toggle('active', state.deleteMode);
  document.getElementById('deleteBanner')?.classList.toggle('hidden', !state.deleteMode);
  document.getElementById('undoDeleteBtn')?.classList.toggle('hidden', state.deletedStack.length === 0);

  if (state.deleteMode) {
    setStatus('Delete Mode — click elements to delete (Ctrl+Z to undo)');
  } else {
    setStatus('Delete mode off');
  }
}


async function handleDeleteClick() {
  if (!state.caster || !state.fragments) return;
  const result = await state.caster.castRay();
  if (!result || !result.object) return;

  let modelId = null;
  const localId = result.localId ?? result.itemId ?? null;

  if (result.fragments?.id) {
    modelId = result.fragments.id;
  } else if (state.fragments.list.size > 0) {
    modelId = state.fragments.list.keys().next().value;
  }

  if (modelId == null || localId == null) return;

  const key = `${modelId}:${localId}`;
  if (state.deletedSet.has(key)) return;

  // Get name
  let name = `#${localId}`;
  try {
    const model = state.fragments.list.get(modelId);
    if (model) {
      const data = await model.getItemsData([localId]);
      if (data && data[0]) {
        const nameVal = data[0].Name?.value || data[0].name?.value;
        if (nameVal) name = String(nameVal);
      }
    }
  } catch (_) {}

  state.deletedStack.push({ modelId, localId, name });
  state.deletedSet.add(key);

  // Hide the element (simulating delete)
  try {
    const items = { [modelId]: new Set([localId]) };
    await state.hider.set(false, items);
    state.fragments.core.update(true);
  } catch (err) {
    console.warn('Delete failed:', err);
  }

  updateDeleteBadge();
  document.getElementById('undoDeleteBtn')?.classList.remove('hidden');
  invalidateGlbCache();

  // Rebuild tree to remove deleted items
  buildModelTree();
}

async function undoDelete() {
  if (state.deletedStack.length === 0) return;

  const item = state.deletedStack.pop();
  const key = `${item.modelId}:${item.localId}`;
  state.deletedSet.delete(key);

  // Show the element again
  try {
    const items = { [item.modelId]: new Set([item.localId]) };
    await state.hider.set(true, items);
    state.fragments.core.update(true);
  } catch (err) {
    console.warn('Undo delete failed:', err);
  }

  updateDeleteBadge();
  if (state.deletedStack.length === 0) {
    document.getElementById('undoDeleteBtn')?.classList.add('hidden');
  }

  buildModelTree();
  invalidateGlbCache();
  setStatus(`Restored: ${item.name}`);
}

function updateDeleteBadge() {
  const badge = document.getElementById('deleteBadge');
  if (badge) {
    const count = state.deletedSet.size;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
}

// =====================================
// CLIPPING PLANES
// =====================================

function setupClipping() {
  ['x', 'y', 'z'].forEach((axis) => {
    const enable = document.getElementById(`clip${axis.toUpperCase()}Enable`);
    const slider = document.getElementById(`clip${axis.toUpperCase()}Slider`);
    const flip = document.getElementById(`clip${axis.toUpperCase()}Flip`);
    const valEl = document.getElementById(`clip${axis.toUpperCase()}Val`);

    if (!enable || !slider) return;

    enable.addEventListener('change', () => {
      state.clipEnabled[axis] = enable.checked;
      slider.disabled = !enable.checked;
      if (enable.checked) {
        updateClipPlane(axis);
      } else {
        removeClipPlane(axis);
        if (valEl) valEl.textContent = '--';
      }
    });

    slider.addEventListener('input', () => {
      if (state.clipEnabled[axis]) {
        updateClipPlane(axis);
      }
    });

    if (flip) {
      flip.addEventListener('click', () => {
        state.clipFlipped[axis] = !state.clipFlipped[axis];
        flip.classList.toggle('active', state.clipFlipped[axis]);
        if (state.clipEnabled[axis]) updateClipPlane(axis);
      });
    }
  });
}

function recomputeClipBounds() {
  const bbox = new THREE.Box3();
  let hasContent = false;
  for (const f of state.files) {
    if (f.model && f.model.object && f.model.object.children.length > 0) {
      bbox.expandByObject(f.model.object);
      hasContent = true;
    }
  }
  if (!hasContent) {
    state.modelBBox = null;
    return;
  }
  state.modelBBox = bbox;
}

function updateClipPlane(axis) {
  if (!state.modelBBox) recomputeClipBounds();
  if (!state.modelBBox) return;

  const slider = document.getElementById(`clip${axis.toUpperCase()}Slider`);
  const valEl = document.getElementById(`clip${axis.toUpperCase()}Val`);
  if (!slider) return;

  const t = parseInt(slider.value) / 100;
  const min = state.modelBBox.min;
  const max = state.modelBBox.max;

  const normal = new THREE.Vector3();
  let pos;
  const flipped = state.clipFlipped[axis];

  if (axis === 'x') {
    pos = min.x + t * (max.x - min.x);
    normal.set(flipped ? 1 : -1, 0, 0);
  } else if (axis === 'y') {
    pos = min.y + t * (max.y - min.y);
    normal.set(0, flipped ? 1 : -1, 0);
  } else {
    pos = min.z + t * (max.z - min.z);
    normal.set(0, 0, flipped ? 1 : -1);
  }

  const plane = new THREE.Plane(normal, -normal.dot(new THREE.Vector3(
    axis === 'x' ? pos : 0,
    axis === 'y' ? pos : 0,
    axis === 'z' ? pos : 0
  )));

  state.clipPlanes[axis] = plane;
  if (valEl) valEl.textContent = pos.toFixed(2);

  applyClipPlanes();
}

function removeClipPlane(axis) {
  state.clipPlanes[axis] = null;
  applyClipPlanes();
}

function applyClipPlanes() {
  const planes = [];
  ['x', 'y', 'z'].forEach((axis) => {
    if (state.clipPlanes[axis]) planes.push(state.clipPlanes[axis]);
  });

  // Apply to all model meshes via renderer
  const renderer = state.world?.renderer?.three;
  if (renderer) {
    renderer.clippingPlanes = planes;
  }

  // Also apply to all mesh materials in the scene
  state.world?.scene?.three?.traverse((obj) => {
    if (obj.isMesh && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((mat) => {
        mat.clippingPlanes = planes.length > 0 ? planes : null;
        mat.clipShadows = true;
        mat.needsUpdate = true;
      });
    }
  });
}

// =====================================
// UI WIRING
// =====================================

function setupUI() {
  // File input — multi-file
  document.getElementById('ifcInput')?.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files) {
      for (const file of files) loadIFC(file);
    }
    e.target.value = ''; // reset so same file can be re-loaded
  });

  // Add file from file manager
  document.getElementById('addFileInput')?.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files) {
      for (const file of files) loadIFC(file);
    }
    e.target.value = '';
  });

  // Files button
  document.getElementById('toggleFiles')?.addEventListener('click', () => {
    if (state.files.length === 0) {
      // No files — open file picker directly
      document.getElementById('ifcInput')?.click();
      return;
    }
    const panel = document.getElementById('filesPanel');
    panel?.classList.toggle('hidden');
    document.getElementById('toggleFiles')?.classList.toggle('active', !panel?.classList.contains('hidden'));
  });

  // Merge & Download
  document.getElementById('mergeIfc')?.addEventListener('click', mergeIFC);
  document.getElementById('downloadIfc')?.addEventListener('click', downloadIFC);

  // Measure
  document.getElementById('toggleMeasure')?.addEventListener('click', toggleMeasureMode);
  document.getElementById('clearMeasure')?.addEventListener('click', clearMeasurements);
  document.querySelectorAll('.measure-tool-btn[data-measure]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.measureType = btn.dataset.measure;
      document.querySelectorAll('.measure-tool-btn[data-measure]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Reset current in-progress measurement when switching type
      state.measurePoints = [];
      removeMeasurePreview();
      removeMeasurePreviewLine();
      updateMeasureInfo();
    });
  });

  // Tree toggle
  document.getElementById('toggleTree')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('hidden');
    document.getElementById('toggleTree')?.classList.toggle('active');
  });

  // Props toggle
  document.getElementById('toggleProps')?.addEventListener('click', () => {
    document.getElementById('propsPanel')?.classList.toggle('hidden');
    document.getElementById('toggleProps')?.classList.toggle('active');
  });

  // Clip toggle
  document.getElementById('toggleClipper')?.addEventListener('click', () => {
    const panel = document.getElementById('clipPanel');
    panel?.classList.toggle('hidden');
    document.getElementById('toggleClipper')?.classList.toggle('active', !panel?.classList.contains('hidden'));
  });

  // Hide mode
  document.getElementById('toggleHide')?.addEventListener('click', toggleHideMode);
  document.getElementById('showAllBtn')?.addEventListener('click', showAllHidden);

  // Delete mode
  document.getElementById('toggleDelete')?.addEventListener('click', toggleDeleteMode);
  document.getElementById('undoDeleteBtn')?.addEventListener('click', undoDelete);

  // Grid toggle
  document.getElementById('toggleGrid')?.addEventListener('click', () => {
    const btn = document.getElementById('toggleGrid');
    if (state.grid) {
      state.grid.visible = !state.grid.visible;
      btn?.classList.toggle('active');
    }
  });

  // Server models
  setupServerModels();

  // Filter actions
  setupFilterActions();

  // GFX panel
  setupGfxPanel();

  // CRS panel
  setupCrsPanel();

  // Geo panel
  document.getElementById('toggleGeo')?.addEventListener('click', () => toggleGeoPanel(state));
  document.getElementById('geoClose')?.addEventListener('click', () => toggleGeoPanel(state));
  document.getElementById('geoPickOrigin')?.addEventListener('click', togglePickOrigin);
  document.getElementById('geoCenterOrigin')?.addEventListener('click', centerOrigin);
  setupGeoUI(state);

  // Click to select / hide / delete
  const rendererDom = state.world.renderer.three.domElement;

  // Distinguish click from orbit drag
  let pointerDownPos = null;

  rendererDom.addEventListener('pointerdown', (e) => {
    pointerDownPos = { x: e.clientX, y: e.clientY };
  });

  rendererDom.addEventListener('pointerup', (e) => {
    if (!pointerDownPos) return;
    const dx = e.clientX - pointerDownPos.x;
    const dy = e.clientY - pointerDownPos.y;

    if (dx * dx + dy * dy > 25) { pointerDownPos = null; return; } // dragged > 5px
    pointerDownPos = null;
    if (state.pickOriginMode) { handlePickOrigin(); return; }
    if (state.measureMode) { handleMeasureClick(); return; }
    if (state.hideMode) { handleHideClick(); return; }
    if (state.deleteMode) { handleDeleteClick(); return; }
    handleSelection();
  });

  // Double-click to finish polyline/area
  rendererDom.addEventListener('dblclick', (e) => {
    if (state.measureMode) { e.preventDefault(); handleMeasureDblClick(); }
  });

  // Right-click to delete individual measurement
  rendererDom.addEventListener('contextmenu', (e) => {
    if (!state.measureMode || state.measurements.length === 0) return;
    e.preventDefault();
    deleteMeasurementUnderCursor(e);
  });

  // Hover highlight + snap preview
  let hoverThrottle = false;
  rendererDom.addEventListener('mousemove', () => {
    if (hoverThrottle || !state.caster) return;
    hoverThrottle = true;
    requestAnimationFrame(async () => {
      hoverThrottle = false;
      const result = await state.caster.castRay();
      if (state.pickOriginMode || state.measureMode) {
        updateSnapPreview(result);
        rendererDom.style.cursor = 'crosshair';
      } else {
        if (state.snapPreview) state.snapPreview.visible = false;
        rendererDom.style.cursor = (result && result.object) ? 'crosshair' : '';
      }
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', async (e) => {
    // ESC — clear selection, exit modes
    if (e.key === 'Escape') {
      if (state.pickOriginMode) togglePickOrigin();
      if (state.measureMode) toggleMeasureMode();
      if (state.hideMode) toggleHideMode();
      if (state.deleteMode) toggleDeleteMode();
      try { await state.fragments.resetHighlight(); } catch (_) {}
      document.getElementById('propsPanel')?.classList.add('hidden');
      document.getElementById('toggleProps')?.classList.remove('active');
    }

    // H — toggle hide mode
    if (e.key === 'h' || e.key === 'H') {
      if (e.shiftKey) {
        showAllHidden();
      } else if (!e.ctrlKey && !e.metaKey) {
        toggleHideMode();
      }
    }

    // D — toggle delete mode
    if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      toggleDeleteMode();
    }

    // M — toggle measure mode
    if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      toggleMeasureMode();
    }

    // Backspace — undo last measure point
    if (e.key === 'Backspace' && state.measureMode && state.measurePoints.length > 0) {
      e.preventDefault();
      undoMeasurePoint();
    }

    // Ctrl+Z — undo delete
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      undoDelete();
    }
  });
}

// =====================================
// DRAG & DROP (Multi-file)
// =====================================

function setupDragDrop() {
  const dropZone = document.getElementById('dropZone');
  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropZone?.classList.remove('hidden');
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropZone?.classList.add('hidden');
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone?.classList.add('hidden');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    let loaded = 0;
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.ifc')) {
        loadIFC(file);
        loaded++;
      }
    }
    if (loaded === 0) {
      setStatus('Please drop .ifc file(s)');
    }
  });
}

// =====================================
// PBR MATERIALS
// =====================================

const PBR_MAP = [
  { keywords: ['beton', 'concrete', 'c20', 'c25', 'c30', 'c35', 'c40', 'c45', 'c50', 'stahlbeton', 'reinforced'], color: 0x8a8a80, roughness: 0.85, metalness: 0.0 },
  { keywords: ['stahl', 'steel', 's235', 's355', 'baustahl', 'structural steel'], color: 0x7a7a80, roughness: 0.35, metalness: 0.85 },
  { keywords: ['glas', 'glass', 'glazing', 'verglasung'], color: 0xaaccee, roughness: 0.05, metalness: 0.1 },
  { keywords: ['holz', 'wood', 'timber', 'brettschichtholz', 'glulam', 'kerto', 'bsh', 'kvh'], color: 0x8B6914, roughness: 0.75, metalness: 0.0 },
  { keywords: ['ziegel', 'brick', 'klinker', 'masonry', 'mauerwerk'], color: 0x9B4B3A, roughness: 0.9, metalness: 0.0 },
  { keywords: ['fliese', 'tile', 'keramik', 'ceramic', 'porcelain'], color: 0xd4c8b8, roughness: 0.4, metalness: 0.0 },
  { keywords: ['aluminium', 'aluminum', 'alu'], color: 0xc0c0c8, roughness: 0.3, metalness: 0.9 },
  { keywords: ['kupfer', 'copper'], color: 0xb87333, roughness: 0.3, metalness: 0.85 },
  { keywords: ['zink', 'zinc'], color: 0x9a9a9a, roughness: 0.35, metalness: 0.8 },
  { keywords: ['putz', 'plaster', 'render', 'stucco'], color: 0xe8e0d4, roughness: 0.9, metalness: 0.0 },
  { keywords: ['dach', 'roof', 'dachziegel', 'roofing', 'bitumen', 'membrane'], color: 0x4a4a4a, roughness: 0.8, metalness: 0.0 },
  { keywords: ['estrich', 'screed', 'mortar'], color: 0x888880, roughness: 0.8, metalness: 0.0 },
  { keywords: ['gips', 'gypsum', 'drywall', 'plasterboard', 'rigips', 'trockenbau'], color: 0xe8e4dc, roughness: 0.9, metalness: 0.0 },
  { keywords: ['naturstein', 'stone', 'granite', 'marble', 'sandstein', 'limestone'], color: 0xa09888, roughness: 0.6, metalness: 0.0 },
  { keywords: ['daemmung', 'insulation', 'styropor', 'eps', 'xps', 'mineral', 'rockwool', 'glaswolle'], color: 0xd4cc44, roughness: 0.95, metalness: 0.0 },
  { keywords: ['asphalt', 'tarmac'], color: 0x333333, roughness: 0.85, metalness: 0.0 },
  { keywords: ['pvc', 'kunststoff', 'plastic', 'polymer', 'pe', 'pp', 'abs'], color: 0xd0d0d0, roughness: 0.5, metalness: 0.0 },
  { keywords: ['duct', 'kanal', 'lueftung', 'ventilation'], color: 0x8890a0, roughness: 0.35, metalness: 0.8 },
  { keywords: ['rohr', 'pipe', 'leitung', 'piping'], color: 0x607060, roughness: 0.4, metalness: 0.7 },
  { keywords: ['erde', 'earth', 'soil', 'ground'], color: 0x6B4423, roughness: 0.95, metalness: 0.0 },
  { keywords: ['wasser', 'water'], color: 0x3388cc, roughness: 0.1, metalness: 0.0 },
];

const TYPE_PBR = {
  IfcWall: { color: 0x8a8a80, roughness: 0.85, metalness: 0.0 },
  IfcWallStandardCase: { color: 0x8a8a80, roughness: 0.85, metalness: 0.0 },
  IfcCurtainWall: { color: 0xaaccee, roughness: 0.05, metalness: 0.1 },
  IfcBeam: { color: 0x7a7a80, roughness: 0.35, metalness: 0.85 },
  IfcColumn: { color: 0x8a8a80, roughness: 0.85, metalness: 0.0 },
  IfcSlab: { color: 0x8a8a80, roughness: 0.85, metalness: 0.0 },
  IfcRoof: { color: 0x4a4a4a, roughness: 0.8, metalness: 0.0 },
  IfcStair: { color: 0x8a8a80, roughness: 0.85, metalness: 0.0 },
  IfcStairFlight: { color: 0x8a8a80, roughness: 0.85, metalness: 0.0 },
  IfcRailing: { color: 0x7a7a80, roughness: 0.35, metalness: 0.85 },
  IfcWindow: { color: 0xaaccee, roughness: 0.05, metalness: 0.1 },
  IfcDoor: { color: 0x8B6914, roughness: 0.75, metalness: 0.0 },
  IfcPlate: { color: 0xaaccee, roughness: 0.05, metalness: 0.1 },
  IfcMember: { color: 0x7a7a80, roughness: 0.35, metalness: 0.85 },
  IfcFooting: { color: 0x8a8a80, roughness: 0.85, metalness: 0.0 },
  IfcPile: { color: 0x8a8a80, roughness: 0.85, metalness: 0.0 },
  IfcCovering: { color: 0xe8e0d4, roughness: 0.9, metalness: 0.0 },
  IfcBuildingElementProxy: { color: 0xaaaaaa, roughness: 0.6, metalness: 0.0 },
  IfcFurnishingElement: { color: 0x8B6914, roughness: 0.75, metalness: 0.0 },
  IfcFurniture: { color: 0x8B6914, roughness: 0.75, metalness: 0.0 },
  IfcDuctSegment: { color: 0x8890a0, roughness: 0.35, metalness: 0.8 },
  IfcDuctFitting: { color: 0x8890a0, roughness: 0.35, metalness: 0.8 },
  IfcPipeSegment: { color: 0x607060, roughness: 0.4, metalness: 0.7 },
  IfcPipeFitting: { color: 0x607060, roughness: 0.4, metalness: 0.7 },
  IfcFlowTerminal: { color: 0xd0d0d0, roughness: 0.5, metalness: 0.3 },
  IfcSanitaryTerminal: { color: 0xe8e4dc, roughness: 0.3, metalness: 0.1 },
  IfcFlowController: { color: 0x8890a0, roughness: 0.35, metalness: 0.8 },
  IfcEnergyConversionDevice: { color: 0x7a7a80, roughness: 0.4, metalness: 0.7 },
  IfcFlowMovingDevice: { color: 0x7a7a80, roughness: 0.4, metalness: 0.7 },
  IfcDistributionChamberElement: { color: 0x888888, roughness: 0.6, metalness: 0.3 },
  IfcCableCarrierSegment: { color: 0x808088, roughness: 0.4, metalness: 0.8 },
  IfcCableSegment: { color: 0x444444, roughness: 0.6, metalness: 0.3 },
  IfcLightFixture: { color: 0xe0e0e0, roughness: 0.3, metalness: 0.2 },
  IfcElectricDistributionBoard: { color: 0x606068, roughness: 0.5, metalness: 0.6 },
  IfcOutlet: { color: 0xe0e0e0, roughness: 0.5, metalness: 0.1 },
  IfcSpace: { color: 0x4488aa, roughness: 0.5, metalness: 0.0 },
  IfcOpeningElement: { color: 0x88bbdd, roughness: 0.5, metalness: 0.0 },
};

// Parse IFC STEP text to extract material names per expressId
function parseIfcMaterials(buffer) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  const matMap = new Map(); // expressId → material name

  // 1. Parse IFCMATERIAL(name) → materialEntityId → name
  const matNames = new Map(); // #id → name
  const matRe = /^#(\d+)\s*=\s*IFCMATERIAL\s*\(\s*'([^']*)'/gim;
  let m;
  while ((m = matRe.exec(text)) !== null) {
    matNames.set(parseInt(m[1]), m[2]);
  }

  // 2. Parse IFCMATERIALLAYER(#materialRef, ...) → layerId → materialName
  const layerMat = new Map(); // layerId → material name
  const layerRe = /^#(\d+)\s*=\s*IFCMATERIALLAYER\s*\(\s*#(\d+)/gim;
  while ((m = layerRe.exec(text)) !== null) {
    const matId = parseInt(m[2]);
    if (matNames.has(matId)) layerMat.set(parseInt(m[1]), matNames.get(matId));
  }

  // 3. Parse IFCMATERIALLAYERSET((...layers...)) → layerSetId → combined names
  const layerSetNames = new Map();
  const lsRe = /^#(\d+)\s*=\s*IFCMATERIALLAYERSET\s*\(\s*\(([^)]*)\)/gim;
  while ((m = lsRe.exec(text)) !== null) {
    const layerIds = m[2].match(/#(\d+)/g)?.map(x => parseInt(x.slice(1))) || [];
    const names = layerIds.map(id => layerMat.get(id)).filter(Boolean);
    if (names.length) layerSetNames.set(parseInt(m[1]), names.join(' '));
  }

  // 4. Parse IFCMATERIALLAYERSETUSAGE(#layerSetRef, ...) → usageId → combined names
  const usageNames = new Map();
  const usageRe = /^#(\d+)\s*=\s*IFCMATERIALLAYERSETUSAGE\s*\(\s*#(\d+)/gim;
  while ((m = usageRe.exec(text)) !== null) {
    const lsId = parseInt(m[2]);
    if (layerSetNames.has(lsId)) usageNames.set(parseInt(m[1]), layerSetNames.get(lsId));
  }

  // 5. Parse IFCRELASSOCIATESMATERIAL(..., (#el1,#el2,...), #materialRef)
  const relRe = /^#\d+\s*=\s*IFCRELASSOCIATESMATERIAL\s*\([^,]*,[^,]*,[^,]*,[^,]*,\s*\(([^)]*)\)\s*,\s*#(\d+)/gim;
  while ((m = relRe.exec(text)) !== null) {
    const elementIds = m[1].match(/#(\d+)/g)?.map(x => parseInt(x.slice(1))) || [];
    const matRef = parseInt(m[2]);
    const name = matNames.get(matRef) || layerSetNames.get(matRef) || usageNames.get(matRef) || '';
    if (name) {
      for (const eId of elementIds) matMap.set(eId, name);
    }
  }

  console.log(`PBR: parsed ${matNames.size} materials, ${matMap.size} element assignments`);
  return matMap;
}

function matchPbrEntry(text) {
  const lower = text.toLowerCase();
  for (const entry of PBR_MAP) {
    if (entry.keywords.some(kw => lower.includes(kw))) return entry;
  }
  return null;
}

async function applyPBR() {
  if (!state.world) return;
  const scene = state.world.scene.three;

  // Build per-element PBR lookup from materialMap (keyword-matched)
  const elementPbr = new Map(); // expressId → PBR entry
  for (const [expressId, matName] of state.materialMap) {
    const entry = matchPbrEntry(matName);
    if (entry) elementPbr.set(expressId, entry);
  }

  // Case-insensitive TYPE_PBR lookup helper
  const typePbrLower = new Map();
  for (const [key, val] of Object.entries(TYPE_PBR)) {
    typePbrLower.set(key.toLowerCase(), val);
  }

  // Fill elementPbr from IFC type fallback for items without keyword match
  for (const fileEntry of state.files) {
    const model = fileEntry.model;
    if (!model) continue;
    try {
      const itemsMap = await model.getItems();
      if (!itemsMap) continue;
      itemsMap.forEach((rawItem, localId) => {
        if (elementPbr.has(localId)) return;
        const cat = (rawItem.category || '').toLowerCase();
        const tpbr = typePbrLower.get(cat);
        if (tpbr) elementPbr.set(localId, tpbr);
      });
    } catch (_) {}
  }

  console.log(`PBR: ${elementPbr.size} elements matched (${state.materialMap.size} by keyword)`);

  // Apply colors via ThatOpen's model.setColor() API (works with ShaderMaterial)
  let applied = 0;
  for (const fileEntry of state.files) {
    const model = fileEntry.model;
    if (!model || typeof model.setColor !== 'function') continue;

    // Group elements by PBR color
    const colorGroups = new Map(); // hex → { color, localIds[] }
    const itemsMap2 = await model.getItems().catch(() => null);
    if (!itemsMap2) continue;

    itemsMap2.forEach((rawItem, localId) => {
      const pbr = elementPbr.get(localId);
      if (!pbr) return;
      const hex = pbr.color;
      if (!colorGroups.has(hex)) colorGroups.set(hex, { color: new THREE.Color(hex), localIds: [] });
      colorGroups.get(hex).localIds.push(localId);
    });

    for (const [, group] of colorGroups) {
      try {
        await model.setColor(group.localIds, group.color);
        applied += group.localIds.length;
      } catch (err) {
        console.warn('setColor failed:', err);
      }
    }
  }

  if (state.fragments?.core) state.fragments.core.update(true);
  console.log(`PBR: applied to ${applied} elements`);
}

function applyMaterialProps(mat, props) {
  const mats = Array.isArray(mat) ? mat : [mat];
  mats.forEach((m) => {
    if (m.color) m.color.setHex(props.color);
    if ('roughness' in m) m.roughness = props.roughness;
    if ('metalness' in m) m.metalness = props.metalness;
    m.needsUpdate = true;
  });
}

async function removePBR() {
  for (const fileEntry of state.files) {
    const model = fileEntry.model;
    if (!model || typeof model.resetColor !== 'function') continue;
    try {
      await model.resetColor(undefined); // reset all elements
    } catch (err) {
      console.warn('resetColor failed:', err);
    }
  }
  if (state.fragments?.core) state.fragments.core.update(true);
}

function togglePBR() {
  state.pbrEnabled = !state.pbrEnabled;
  if (state.pbrEnabled) {
    applyPBR();
  } else {
    removePBR();
  }
}

// =====================================
// PICK ORIGIN / CENTER ORIGIN + SNAP
// =====================================

function collectSceneMeshes() {
  const meshes = [];
  if (!state.world) return meshes;
  const root = state.modelWrapper || state.world.scene.three;
  root.traverse((obj) => {
    if (obj.isMesh && obj.visible && obj.geometry && obj.name !== 'originMarker') meshes.push(obj);
  });
  return meshes;
}

// Shift scene so `worldPoint` becomes the new origin (0,0,0).
// Uses a persistent wrapper group to accumulate shifts reliably.
function shiftAllGeometry(worldPoint) {
  const scene = state.world.scene.three;

  // Ensure we have a wrapper group for all model content
  if (!state.modelWrapper) {
    const wrapper = new THREE.Group();
    wrapper.name = 'modelWrapper';
    // Move all existing children (except markers/grid) into wrapper
    const children = [...scene.children];
    children.forEach((child) => {
      if (child.name === 'originMarker' || child.name === 'grid') return;
      scene.remove(child);
      wrapper.add(child);
    });
    scene.add(wrapper);
    state.modelWrapper = wrapper;
  }

  state.modelWrapper.position.sub(worldPoint);
  state.modelWrapper.updateMatrix();
  state.modelWrapper.updateMatrixWorld(true);
}

// Snap to nearest vertex or edge midpoint of the hit face
function closestPointOnEdge(a, b, p) {
  const ab = b.clone().sub(a);
  const len2 = ab.lengthSq();
  if (len2 < 1e-10) return a.clone();
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / len2));
  return a.clone().add(ab.multiplyScalar(t));
}

// Build transform matrix for a vertex: instance matrix (if InstancedMesh) × world matrix
function getVertexTransform(mesh, result) {
  const mat = new THREE.Matrix4();
  if (mesh.isInstancedMesh && result.instanceId != null) {
    const instMat = new THREE.Matrix4();
    mesh.getMatrixAt(result.instanceId, instMat);
    mat.multiplyMatrices(mesh.matrixWorld, instMat);
  } else {
    mat.copy(mesh.matrixWorld);
  }
  return mat;
}

// Returns Vector3 with _snapType: 'vertex'|'edge'|'grid'|'face'
function snapPoint(result) {
  const mesh = result.object;
  const faceIndex = result.faceIndex;
  const hitPoint = result.point;

  if (!mesh || !mesh.geometry) {
    const raw = hitPoint.clone(); raw._snapType = 'face'; return raw;
  }

  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  if (!pos || pos.count === 0) {
    const raw = hitPoint.clone(); raw._snapType = 'face'; return raw;
  }

  mesh.updateWorldMatrix(true, false);
  const transform = getVertexTransform(mesh, result);

  // Camera-adaptive snap radii
  const cam = state.world.camera.three;
  const camDist = cam.position.distanceTo(hitPoint);
  const vertexRadius = camDist * 0.05;   // 5% of camera distance
  const edgeRadius = camDist * 0.035;    // 3.5% of camera distance

  // If we have a faceIndex, check that face's vertices/edges first
  if (faceIndex != null) {
    const idx = geo.index;
    let i0, i1, i2;
    if (idx) {
      i0 = idx.getX(faceIndex * 3);
      i1 = idx.getX(faceIndex * 3 + 1);
      i2 = idx.getX(faceIndex * 3 + 2);
    } else {
      i0 = faceIndex * 3;
      i1 = faceIndex * 3 + 1;
      i2 = faceIndex * 3 + 2;
    }

    if (i0 < pos.count && i1 < pos.count && i2 < pos.count) {
      const v0 = new THREE.Vector3().fromBufferAttribute(pos, i0).applyMatrix4(transform);
      const v1 = new THREE.Vector3().fromBufferAttribute(pos, i1).applyMatrix4(transform);
      const v2 = new THREE.Vector3().fromBufferAttribute(pos, i2).applyMatrix4(transform);

      // 1. Vertices
      let bestVert = null, bestVertDist = vertexRadius;
      for (const v of [v0, v1, v2]) {
        const d = v.distanceTo(hitPoint);
        if (d < bestVertDist) { bestVertDist = d; bestVert = v; }
      }
      if (bestVert) { bestVert._snapType = 'vertex'; return bestVert; }

      // 2. Edges — closest point on each edge
      let bestEdge = null, bestEdgeDist = edgeRadius;
      for (const [a, b] of [[v0, v1], [v1, v2], [v0, v2]]) {
        const cp = closestPointOnEdge(a, b, hitPoint);
        const d = cp.distanceTo(hitPoint);
        if (d < bestEdgeDist) { bestEdgeDist = d; bestEdge = cp; }
      }
      if (bestEdge) { bestEdge._snapType = 'edge'; return bestEdge; }
    }
  }

  // 3. Brute-force: scan nearby vertices in the geometry
  let bestVert = null, bestVertDist = vertexRadius;
  const tempV = new THREE.Vector3();
  const scanLimit = Math.min(pos.count, 50000);
  for (let i = 0; i < scanLimit; i++) {
    tempV.fromBufferAttribute(pos, i).applyMatrix4(transform);
    const d = tempV.distanceTo(hitPoint);
    if (d < bestVertDist) {
      bestVertDist = d;
      bestVert = tempV.clone();
    }
  }
  if (bestVert) { bestVert._snapType = 'vertex'; return bestVert; }

  // 4. No snap
  const raw = hitPoint.clone();
  raw._snapType = 'face';
  return raw;
}

function ensureSnapPreview() {
  if (state.snapPreview) return state.snapPreview;
  const group = new THREE.Group();
  group.name = 'originMarker'; // excluded from collectSceneMeshes
  group.renderOrder = 1000;
  group.visible = false;

  // Vertex indicator — diamond shape (small box rotated 45°)
  const vertGeo = new THREE.SphereGeometry(1, 6, 6);
  const vertMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, depthTest: false, transparent: true, opacity: 0.9 });
  const vertMesh = new THREE.Mesh(vertGeo, vertMat);
  vertMesh.name = 'snapVertex';
  vertMesh.visible = false;
  group.add(vertMesh);

  // Edge indicator — torus/ring
  const edgeGeo = new THREE.TorusGeometry(1, 0.25, 8, 16);
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0x00aaff, depthTest: false, transparent: true, opacity: 0.9 });
  const edgeMesh = new THREE.Mesh(edgeGeo, edgeMat);
  edgeMesh.name = 'snapEdge';
  edgeMesh.visible = false;
  group.add(edgeMesh);

  // Face indicator — plain sphere (yellow, original)
  const faceGeo = new THREE.SphereGeometry(1, 16, 16);
  const faceMat = new THREE.MeshBasicMaterial({ color: 0xffff00, depthTest: false, transparent: true, opacity: 0.5 });
  const faceMesh = new THREE.Mesh(faceGeo, faceMat);
  faceMesh.name = 'snapFace';
  faceMesh.visible = false;
  group.add(faceMesh);

  state.world.scene.three.add(group);
  state.snapPreview = group;
  return group;
}

function removeSnapPreview() {
  if (state.snapPreview) {
    state.world.scene.three.remove(state.snapPreview);
    state.snapPreview.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    });
    state.snapPreview = null;
  }
}

function updateSnapPreview(result) {
  if (!result || !result.object) {
    if (state.snapPreview) state.snapPreview.visible = false;
    return;
  }
  const sp = snapPoint(result);
  const preview = ensureSnapPreview();
  const snapType = sp._snapType || 'face';

  const cam = state.world.camera.three;
  const dist = cam.position.distanceTo(sp);
  const scale = dist * 0.008;

  preview.position.copy(sp);
  preview.visible = true;

  // Show the right indicator
  for (const child of preview.children) {
    if (child.name === 'snapVertex') {
      child.visible = snapType === 'vertex';
      child.scale.setScalar(scale);
    } else if (child.name === 'snapEdge') {
      child.visible = snapType === 'edge';
      child.scale.setScalar(scale);
      child.lookAt(cam.position);
    } else if (child.name === 'snapFace') {
      child.visible = snapType === 'face';
      child.scale.setScalar(scale);
    }
  }
}

function togglePickOrigin() {
  state.pickOriginMode = !state.pickOriginMode;
  state.pickOriginStep = state.pickOriginMode ? 1 : 0;
  document.getElementById('geoPickOrigin')?.classList.toggle('active', state.pickOriginMode);

  const banner = document.getElementById('originBanner');
  if (state.pickOriginMode) {
    if (state.hideMode) toggleHideMode();
    if (state.deleteMode) toggleDeleteMode();
    if (banner) { banner.classList.remove('hidden'); banner.textContent = 'PICK ORIGIN — Schritt 1: Ursprung klicken'; }
    state.world.renderer.three.domElement.style.cursor = 'crosshair';
    setStatus('Schritt 1: Klick auf Modell für Ursprung');

    // ESC / Enter handler for step 2
    state._pickOriginKeyHandler = (e) => {
      if (state.pickOriginStep === 2 && (e.key === 'Enter' || e.key === 'Escape')) {
        e.preventDefault();
        // Skip X-axis → default North
        state.localXAxis = new THREE.Vector3(1, 0, 0);
        updateXAxisDisplay(0);
        finishPickOrigin();
      }
    };
    document.addEventListener('keydown', state._pickOriginKeyHandler);
  } else {
    state.pickOriginStep = 0;
    if (banner) banner.classList.add('hidden');
    state.world.renderer.three.domElement.style.cursor = '';
    removeSnapPreview();
    removeXAxisArrow();
    if (state._pickOriginKeyHandler) {
      document.removeEventListener('keydown', state._pickOriginKeyHandler);
      state._pickOriginKeyHandler = null;
    }
    setStatus('Ready');
  }
}

function finishPickOrigin() {
  state.pickOriginStep = 0;
  state.pickOriginMode = false;
  document.getElementById('geoPickOrigin')?.classList.remove('active');
  const banner = document.getElementById('originBanner');
  if (banner) banner.classList.add('hidden');
  state.world.renderer.three.domElement.style.cursor = '';
  removeSnapPreview();
  if (state._pickOriginKeyHandler) {
    document.removeEventListener('keydown', state._pickOriginKeyHandler);
    state._pickOriginKeyHandler = null;
  }
}

async function handlePickOrigin() {
  if (!state.pickOriginMode || !state.caster) return;

  const result = await state.caster.castRay();
  if (!result || !result.object) return;

  const point = snapPoint(result);

  if (state.pickOriginStep === 1) {
    // ── STEP 1: Set origin ──
    shiftAllGeometry(point);
    state.world.camera.controls.setTarget(0, 0, 0, true);

    removeSnapPreview();
    invalidateGlbCache();
    showOriginMarker();
    updateFootprint(state);

    setStatus(`Ursprung gesetzt — Schritt 2: X-Achsenrichtung klicken (Enter = Norden)`);
    const banner = document.getElementById('originBanner');
    if (banner) { banner.textContent = 'PICK ORIGIN — Schritt 2: X-Achsenrichtung klicken (Enter = überspringen)'; banner.style.background = 'rgba(46,207,176,0.85)'; }

    state.pickOriginStep = 2;
    console.log(`Pick Origin Step 1: origin set (shifted ${point.length().toFixed(1)}m)`);

  } else if (state.pickOriginStep === 2) {
    // ── STEP 2: Define X-axis direction ──
    // point is now relative to the new origin (since geometry was shifted in step 1)
    // The direction from origin (0,0,0) to this clicked point = the local X direction
    const xDir = point.clone().normalize();
    state.localXAxis = xDir;

    // Calculate rotation angle in XZ plane (horizontal)
    // atan2(x, z) gives bearing from +Z axis; we want angle from +X axis
    const angleDeg = Math.atan2(xDir.z, xDir.x) * (180 / Math.PI);
    const bearingDeg = ((90 - angleDeg) % 360 + 360) % 360;

    updateXAxisDisplay(bearingDeg);

    // Rotate the origin marker so red X-axis points in the picked direction
    // xDir is in XZ plane; rotation around Y axis
    const rotY = Math.atan2(xDir.z, xDir.x);
    showOriginMarker(rotY);

    setStatus(`X-Achse: ${bearingDeg.toFixed(1)}° — Ursprung + Richtung gesetzt`);
    console.log(`Pick Origin Step 2: X-axis direction ${bearingDeg.toFixed(1)}° — vec(${xDir.x.toFixed(3)}, ${xDir.y.toFixed(3)}, ${xDir.z.toFixed(3)})`);

    // Reset banner color
    const banner = document.getElementById('originBanner');
    if (banner) banner.style.background = '';

    finishPickOrigin();
  }
}

function updateXAxisDisplay(bearingDeg) {
  // Update CRS panel rotation field
  const rotEl = document.getElementById('crsRotation');
  if (rotEl) {
    const norm = Math.round(bearingDeg * 10) / 10;
    rotEl.value = bearingDeg === 0 ? '0° (Norden, default)' : `${norm}° (via Pick)`;
    rotEl.readOnly = true;
    rotEl.style.color = 'var(--text-muted)';
  }

  // Compute xAxis values and store
  const norm = ((bearingDeg % 360) + 360) % 360;
  window._crsPickRotation = {
    deg: norm,
    xAxisAbscissa: Math.round(Math.cos((90 - norm) * Math.PI / 180) * 1e6) / 1e6,
    xAxisOrdinate: Math.round(Math.sin((90 - norm) * Math.PI / 180) * 1e6) / 1e6,
  };
}

// X-axis arrow helpers removed — origin marker rotation handles this now
function removeXAxisArrow() {}  // no-op, kept for compatibility

function centerOrigin() {
  const bbox = new THREE.Box3();
  const meshes = collectSceneMeshes();
  if (!meshes.length) return;
  meshes.forEach((m) => bbox.expandByObject(m));
  const center = bbox.getCenter(new THREE.Vector3());
  if (center.lengthSq() < 0.01) { setStatus('Origin already at center'); return; }

  shiftAllGeometry(center);
  // Set orbit target to new origin
  state.world.camera.controls.setTarget(0, 0, 0, true);

  invalidateGlbCache();
  showOriginMarker();
  updateFootprint(state);

  setStatus(`Origin centered (shifted ${center.length().toFixed(1)}m)`);
}

function removeOriginMarker() {
  if (state.originMarker) {
    state.world.scene.three.remove(state.originMarker);
    state.originMarker.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
    state.originMarker = null;
  }
}

/**
 * Show origin marker (RGB axes). Optional rotationY rotates the whole
 * gizmo around Y so that the red X-axis points in the picked direction.
 * @param {number} [rotationY=0] Rotation around Y in radians
 */
function showOriginMarker(rotationY) {
  removeOriginMarker();

  const bbox = new THREE.Box3();
  const meshes = collectSceneMeshes();
  if (!meshes.length) return;
  meshes.forEach((m) => bbox.expandByObject(m));
  const size = bbox.getSize(new THREE.Vector3());
  const arm = Math.max(0.3, Math.max(size.x, size.y, size.z) * 0.03);
  const thick = arm * 0.03;

  const group = new THREE.Group();
  group.name = 'originMarker';

  // X — red
  const xGeo = new THREE.CylinderGeometry(thick, thick, arm, 6);
  xGeo.rotateZ(-Math.PI / 2);
  xGeo.translate(arm / 2, 0, 0);
  group.add(new THREE.Mesh(xGeo, new THREE.MeshBasicMaterial({ color: 0xff3333, depthTest: false })));

  // Y — green
  const yGeo = new THREE.CylinderGeometry(thick, thick, arm, 6);
  yGeo.translate(0, arm / 2, 0);
  group.add(new THREE.Mesh(yGeo, new THREE.MeshBasicMaterial({ color: 0x33ff33, depthTest: false })));

  // Z — blue
  const zGeo = new THREE.CylinderGeometry(thick, thick, arm, 6);
  zGeo.rotateX(Math.PI / 2);
  zGeo.translate(0, 0, arm / 2);
  group.add(new THREE.Mesh(zGeo, new THREE.MeshBasicMaterial({ color: 0x3333ff, depthTest: false })));

  // Center sphere
  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(thick * 4, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })
  ));

  // Apply rotation so X-axis points in picked direction
  if (rotationY) {
    group.rotation.y = -rotationY;
  }

  group.renderOrder = 999;
  group.traverse((child) => { if (child.isMesh) child.renderOrder = 999; });

  state.world.scene.three.add(group);
  state.originMarker = group;
}

// =====================================
// MEASURE TOOL
// =====================================

function toggleMeasureMode() {
  if (state.hideMode) toggleHideMode();
  if (state.deleteMode) toggleDeleteMode();
  if (state.pickOriginMode) togglePickOrigin();

  state.measureMode = !state.measureMode;
  state.measurePoints = [];
  removeMeasurePreview();
  removeMeasurePreviewLine();
  if (!state.measureMode && state.snapPreview) state.snapPreview.visible = false;

  document.getElementById('toggleMeasure')?.classList.toggle('active', state.measureMode);
  const widget = document.getElementById('measureWidget');
  if (widget) widget.classList.toggle('hidden', !state.measureMode);
  updateMeasureInfo();
}

function updateMeasureInfo() {
  const info = document.getElementById('measureInfo');
  if (!info) return;
  const t = state.measureType;
  const n = state.measurePoints.length;
  if (t === 'point' || t === 'vertical' || t === 'horizontal') {
    info.textContent = n === 0 ? 'Click start point · Right-click to delete' : 'Click end point';
  } else if (t === 'polyline') {
    info.textContent = n === 0 ? 'Click first point · Right-click to delete' : `${n} pts — dbl-click finish · Backspace undo`;
  } else if (t === 'area') {
    info.textContent = n < 3 ? `Click point ${n + 1} (min 3) · Right-click to delete` : `${n} pts — dbl-click close · Backspace undo`;
  }
}

async function handleMeasureClick() {
  if (!state.caster) return;
  const result = await state.caster.castRay();
  if (!result || !result.point) return;
  const point = snapPoint(result);
  const t = state.measureType;

  if (t === 'point' || t === 'vertical' || t === 'horizontal') {
    if (state.measurePoints.length === 0) {
      state.measurePoints.push(point);
      showMeasurePreview(point);
      updateMeasureInfo();
    } else {
      const start = state.measurePoints[0];
      finishTwoPointMeasure(start, point, t);
      state.measurePoints = [];
      removeMeasurePreview();
      removeMeasurePreviewLine();
      updateMeasureInfo();
    }
  } else if (t === 'polyline') {
    state.measurePoints.push(point);
    showMeasurePreview(point);
    // Draw segment from previous point
    if (state.measurePoints.length >= 2) {
      const pts = state.measurePoints;
      addPreviewSegment(pts[pts.length - 2], pts[pts.length - 1]);
    }
    updateMeasureInfo();
  } else if (t === 'area') {
    state.measurePoints.push(point);
    showMeasurePreview(point);
    if (state.measurePoints.length >= 2) {
      const pts = state.measurePoints;
      addPreviewSegment(pts[pts.length - 2], pts[pts.length - 1]);
    }
    updateMeasureInfo();
  }
}

function handleMeasureDblClick() {
  const t = state.measureType;
  const pts = state.measurePoints;
  if (t === 'polyline' && pts.length >= 2) {
    finishPolylineMeasure(pts);
    state.measurePoints = [];
    removeMeasurePreview();
    removeMeasurePreviewLine();
    updateMeasureInfo();
  } else if (t === 'area' && pts.length >= 3) {
    finishAreaMeasure(pts);
    state.measurePoints = [];
    removeMeasurePreview();
    removeMeasurePreviewLine();
    updateMeasureInfo();
  }
}

function finishTwoPointMeasure(start, end, type) {
  const scene = state.world.scene.three;
  const group = new THREE.Group();
  group.name = 'measurement';

  let displayStart = start, displayEnd = end, distance, labelText;

  if (type === 'vertical') {
    // Project to vertical — same XZ as start, Y from start to end
    displayEnd = new THREE.Vector3(start.x, end.y, start.z);
    distance = Math.abs(end.y - start.y);
    labelText = '↕ ' + formatDistance(distance);
    // Dashed horizontal reference lines
    addDashedRefLine(group, end, displayEnd, 0x666666);
  } else if (type === 'horizontal') {
    // Project to horizontal — same Y as start
    displayEnd = new THREE.Vector3(end.x, start.y, end.z);
    distance = Math.sqrt((end.x - start.x) ** 2 + (end.z - start.z) ** 2);
    labelText = '↔ ' + formatDistance(distance);
    addDashedRefLine(group, end, displayEnd, 0x666666);
  } else {
    distance = start.distanceTo(end);
    labelText = formatDistance(distance);
  }

  // Main line
  addMeasureLine(group, displayStart, displayEnd, 0xf59e0b);
  addEndpointSphere(group, displayStart);
  addEndpointSphere(group, displayEnd);

  // Label
  const mid = displayStart.clone().add(displayEnd).multiplyScalar(0.5);
  const label = createTextSprite(labelText);
  label.position.copy(mid);
  offsetLabel(label, displayStart, displayEnd);
  group.add(label);

  // Dimension breakdown for point-to-point
  if (type === 'point') {
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    const dz = Math.abs(end.z - start.z);
    const dimText = `X:${formatDistance(dx)} Y:${formatDistance(dy)} Z:${formatDistance(dz)}`;
    const dimLabel = createTextSprite(dimText, 0.55);
    dimLabel.position.copy(mid);
    offsetLabel(dimLabel, displayStart, displayEnd, -1);
    dimLabel.position.y -= 0.1;
    group.add(dimLabel);
  }

  scene.add(group);
  state.measurements.push({ group, type, value: distance });
  setStatus(`${type === 'vertical' ? 'Vertical' : type === 'horizontal' ? 'Horizontal' : 'Distance'}: ${formatDistance(distance)}`);
}

function finishPolylineMeasure(pts) {
  const scene = state.world.scene.three;
  const group = new THREE.Group();
  group.name = 'measurement';
  let totalDist = 0;

  for (let i = 0; i < pts.length; i++) {
    addEndpointSphere(group, pts[i]);
    if (i > 0) {
      const d = pts[i - 1].distanceTo(pts[i]);
      totalDist += d;
      addMeasureLine(group, pts[i - 1], pts[i], 0xf59e0b);
      // Segment label
      const mid = pts[i - 1].clone().add(pts[i]).multiplyScalar(0.5);
      const segLabel = createTextSprite(formatDistance(d), 0.7);
      segLabel.position.copy(mid);
      offsetLabel(segLabel, pts[i - 1], pts[i]);
      group.add(segLabel);
    }
  }

  // Total label at last point
  const totalLabel = createTextSprite('Σ ' + formatDistance(totalDist), 1.0);
  totalLabel.position.copy(pts[pts.length - 1]);
  totalLabel.position.y += 0.25;
  group.add(totalLabel);

  scene.add(group);
  state.measurements.push({ group, type: 'polyline', value: totalDist });
  setStatus(`Polyline: ${formatDistance(totalDist)} (${pts.length} pts)`);
}

function finishAreaMeasure(pts) {
  const scene = state.world.scene.three;
  const group = new THREE.Group();
  group.name = 'measurement';

  // Draw closed polygon
  for (let i = 0; i < pts.length; i++) {
    addEndpointSphere(group, pts[i]);
    const next = pts[(i + 1) % pts.length];
    addMeasureLine(group, pts[i], next, 0xf59e0b);
  }

  // Semi-transparent fill
  if (pts.length >= 3) {
    const fillGeo = createFillGeometry(pts);
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b, transparent: true, opacity: 0.12,
      side: THREE.DoubleSide, depthTest: false
    });
    const fillMesh = new THREE.Mesh(fillGeo, fillMat);
    fillMesh.renderOrder = 997;
    group.add(fillMesh);
  }

  // Calculate area using Shoelace formula (projected to dominant plane)
  const area = calcPolygonArea(pts);
  const centroid = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
  const areaLabel = createTextSprite(formatArea(area));
  areaLabel.position.copy(centroid);
  areaLabel.position.y += 0.15;
  group.add(areaLabel);

  // Perimeter
  let perim = 0;
  for (let i = 0; i < pts.length; i++) perim += pts[i].distanceTo(pts[(i + 1) % pts.length]);
  const perimLabel = createTextSprite('P: ' + formatDistance(perim), 0.6);
  perimLabel.position.copy(centroid);
  perimLabel.position.y -= 0.1;
  group.add(perimLabel);

  scene.add(group);
  state.measurements.push({ group, type: 'area', value: area });
  setStatus(`Area: ${formatArea(area)}, Perimeter: ${formatDistance(perim)}`);
}

function createFillGeometry(pts) {
  // Fan triangulation from first point — works for convex and simple concave polygons
  const geo = new THREE.BufferGeometry();
  const positions = [];
  for (let i = 1; i < pts.length - 1; i++) {
    positions.push(pts[0].x, pts[0].y, pts[0].z);
    positions.push(pts[i].x, pts[i].y, pts[i].z);
    positions.push(pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

function calcPolygonNormal(pts) {
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i], next = pts[(i + 1) % pts.length];
    n.x += (cur.y - next.y) * (cur.z + next.z);
    n.y += (cur.z - next.z) * (cur.x + next.x);
    n.z += (cur.x - next.x) * (cur.y + next.y);
  }
  return n.normalize();
}

function calcPolygonArea(pts) {
  // 3D polygon area via cross product
  const n = pts.length;
  const cross = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const cur = pts[i], next = pts[(i + 1) % n];
    cross.x += (cur.y * next.z - cur.z * next.y);
    cross.y += (cur.z * next.x - cur.x * next.z);
    cross.z += (cur.x * next.y - cur.y * next.x);
  }
  return cross.length() / 2;
}

function formatArea(a) {
  if (a >= 1) return a.toFixed(3) + ' m²';
  if (a >= 0.01) return (a * 10000).toFixed(1) + ' cm²';
  return (a * 1000000).toFixed(1) + ' mm²';
}

// Helpers
function addMeasureLine(group, p1, p2, color) {
  const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 998;
  group.add(line);
}

function addDashedRefLine(group, p1, p2, color) {
  const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
  const mat = new THREE.LineDashedMaterial({ color, depthTest: false, dashSize: 0.1, gapSize: 0.05 });
  const line = new THREE.Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = 997;
  group.add(line);
}

function addEndpointSphere(group, pos) {
  const geo = new THREE.SphereGeometry(0.04, 10, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, depthTest: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  mesh.renderOrder = 999;
  group.add(mesh);
}

function offsetLabel(label, p1, p2, sign = 1) {
  const dir = p2.clone().sub(p1).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const offset = new THREE.Vector3().crossVectors(dir, up).normalize().multiplyScalar(0.15 * sign);
  if (offset.length() < 0.01) offset.set(0.15 * sign, 0, 0);
  label.position.add(offset);
}

function formatDistance(d) {
  if (d >= 1) return d.toFixed(3) + ' m';
  if (d >= 0.01) return (d * 100).toFixed(1) + ' cm';
  return (d * 1000).toFixed(1) + ' mm';
}

function showMeasurePreview(point) {
  // Add a preview sphere for each clicked point
  if (!state.measurePreview) state.measurePreview = [];
  const geo = new THREE.SphereGeometry(0.05, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, depthTest: false });
  const sphere = new THREE.Mesh(geo, mat);
  sphere.position.copy(point);
  sphere.renderOrder = 999;
  state.world.scene.three.add(sphere);
  state.measurePreview.push(sphere);
}

function addPreviewSegment(p1, p2) {
  if (!state.measurePreview) state.measurePreview = [];
  const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
  const mat = new THREE.LineBasicMaterial({ color: 0xf59e0b, depthTest: false, linewidth: 2 });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 998;
  state.world.scene.three.add(line);
  state.measurePreview.push(line);
}

function removeMeasurePreview() {
  if (state.measurePreview) {
    for (const obj of state.measurePreview) {
      state.world.scene.three.remove(obj);
      obj.geometry?.dispose();
      obj.material?.dispose();
    }
    state.measurePreview = null;
  }
}

function removeMeasurePreviewLine() {
  if (state.measurePreviewLine) {
    state.world.scene.three.remove(state.measurePreviewLine);
    state.measurePreviewLine.geometry?.dispose();
    state.measurePreviewLine.material?.dispose();
    state.measurePreviewLine = null;
  }
}

function createTextSprite(text, scale = 1) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 48;
  ctx.font = `bold ${fontSize}px monospace`;
  const metrics = ctx.measureText(text);
  const w = metrics.width + 24;
  const h = fontSize + 16;
  canvas.width = w;
  canvas.height = h;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 8);
  ctx.fill();

  ctx.font = `bold ${fontSize}px monospace`;
  ctx.fillStyle = '#f59e0b';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);

  const aspect = w / h;
  const spriteScale = 0.4 * scale;
  sprite.scale.set(spriteScale * aspect, spriteScale, 1);

  return sprite;
}

function deleteMeasurementUnderCursor(event) {
  // Project each measurement's midpoint/centroid to screen, find closest to mouse
  const cam = state.world.camera.three;
  const rect = state.world.renderer.three.domElement.getBoundingClientRect();
  const mouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const mouseY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  const mouse = new THREE.Vector2(mouseX, mouseY);

  let bestIdx = -1, bestDist = 0.15; // threshold in NDC
  for (let i = 0; i < state.measurements.length; i++) {
    const m = state.measurements[i];
    // Use group's child positions to find center
    const center = new THREE.Vector3();
    let count = 0;
    m.group.traverse(c => {
      if (c.isMesh || c.isSprite) {
        center.add(c.getWorldPosition(new THREE.Vector3()));
        count++;
      }
    });
    if (count === 0) continue;
    center.divideScalar(count);
    const projected = center.project(cam);
    const d = Math.sqrt((projected.x - mouse.x) ** 2 + (projected.y - mouse.y) ** 2);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  if (bestIdx >= 0) {
    const m = state.measurements[bestIdx];
    state.world.scene.three.remove(m.group);
    m.group.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
    });
    state.measurements.splice(bestIdx, 1);
    setStatus('Measurement deleted (right-click)');
  }
}

function undoMeasurePoint() {
  if (state.measurePoints.length === 0) return;
  state.measurePoints.pop();
  // Rebuild preview
  removeMeasurePreview();
  removeMeasurePreviewLine();
  for (const pt of state.measurePoints) showMeasurePreview(pt);
  for (let i = 1; i < state.measurePoints.length; i++) {
    addPreviewSegment(state.measurePoints[i - 1], state.measurePoints[i]);
  }
  updateMeasureInfo();
}

function clearMeasurements() {
  const scene = state.world.scene.three;
  for (const m of state.measurements) {
    scene.remove(m.group);
    m.group.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    });
  }
  state.measurements = [];
  state.measurePoints = [];
  removeMeasurePreview();
  removeMeasurePreviewLine();
  updateMeasureInfo();
  setStatus('Measurements cleared');
}

// =====================================
// GFX PANEL CONTROLS
// =====================================

function setupGfxPanel() {
  // GFX toggle
  document.getElementById('toggleGfx')?.addEventListener('click', () => {
    const panel = document.getElementById('gfxPanel');
    panel?.classList.toggle('hidden');
    document.getElementById('toggleGfx')?.classList.toggle('active', !panel?.classList.contains('hidden'));
  });

  const renderer = state.world.renderer.three;

  // Lighting
  const lightMap = [
    { id: 'gfx-ambient', get: () => state.ambientLight },
    { id: 'gfx-sun', get: () => state.sunLight },
    { id: 'gfx-fill', get: () => state.fillLight },
    { id: 'gfx-hemi', get: () => state.hemiLight },
  ];
  lightMap.forEach(({ id, get }) => {
    const slider = document.getElementById(id);
    const valEl = document.getElementById(`${id}-val`);
    if (!slider) return;
    slider.oninput = () => {
      const v = parseFloat(slider.value);
      const light = get();
      if (light) light.intensity = v;
      if (valEl) valEl.textContent = v.toFixed(2);
      saveGfxSettings();
    };
  });

  // Tone mapping
  document.getElementById('gfx-tonemap')?.addEventListener('change', (e) => {
    const map = { 0: THREE.NoToneMapping, 1: THREE.LinearToneMapping, 2: THREE.ReinhardToneMapping,
                  3: THREE.CineonToneMapping, 4: THREE.ACESFilmicToneMapping, 5: THREE.AgXToneMapping };
    renderer.toneMapping = map[e.target.value] ?? THREE.ACESFilmicToneMapping;
    saveGfxSettings();
  });

  // Exposure
  const expSlider = document.getElementById('gfx-exposure');
  const expVal = document.getElementById('gfx-exposure-val');
  if (expSlider) {
    expSlider.oninput = () => {
      const v = parseFloat(expSlider.value);
      renderer.toneMappingExposure = v;
      if (expVal) expVal.textContent = v.toFixed(2);
      saveGfxSettings();
    };
  }

  // AO controls
  const aoMap = [
    { id: 'gfx-ao-intensity', key: 'intensity' },
    { id: 'gfx-ao-radius', key: 'aoRadius' },
    { id: 'gfx-ao-falloff', key: 'distanceFalloff' },
  ];
  aoMap.forEach(({ id, key }) => {
    const slider = document.getElementById(id);
    const valEl = document.getElementById(`${id}-val`);
    if (!slider) return;
    slider.oninput = () => {
      const v = parseFloat(slider.value);
      if (state.n8ao) state.n8ao.configuration[key] = v;
      if (valEl) valEl.textContent = v.toFixed(2);
      saveGfxSettings();
    };
  });

  document.getElementById('gfx-ao-enabled')?.addEventListener('change', (e) => {
    if (state.n8ao) {
      // Don't disable the pass (it also renders the scene) — set intensity to 0 instead
      state.n8ao.configuration.intensity = e.target.checked
        ? parseFloat(document.getElementById('gfx-ao-intensity')?.value || 5.1)
        : 0;
    }
    saveGfxSettings();
  });

  document.getElementById('gfx-ao-quality')?.addEventListener('change', (e) => {
    if (state.n8ao) state.n8ao.setQualityMode(e.target.value);
    saveGfxSettings();
  });

  // PBR toggle
  document.getElementById('gfx-pbr')?.addEventListener('change', (e) => {
    state.pbrEnabled = e.target.checked;
    if (state.pbrEnabled) applyPBR();
    else removePBR();
    saveGfxSettings();
  });

  // Background color
  document.getElementById('gfx-bgcolor')?.addEventListener('input', (e) => {
    state.world.scene.three.background = new THREE.Color(e.target.value);
    saveGfxSettings();
  });

  // Resolution / DPR
  const dprSlider = document.getElementById('gfx-dpr');
  const dprVal = document.getElementById('gfx-dpr-val');
  if (dprSlider) {
    dprSlider.oninput = () => {
      const v = parseFloat(dprSlider.value);
      renderer.setPixelRatio(v * window.devicePixelRatio);
      if (dprVal) dprVal.textContent = v.toFixed(2);
      saveGfxSettings();
    };
  }

  // MSAA
  document.getElementById('gfx-msaa')?.addEventListener('change', (e) => {
    const samples = parseInt(e.target.value);
    if (state.msaaRT) {
      state.msaaRT.samples = samples;
      state.msaaRT.dispose();
      const vp = document.getElementById('viewport');
      state.composer.setSize(vp.clientWidth, vp.clientHeight);
    }
    saveGfxSettings();
  });

  // SMAA
  document.getElementById('gfx-smaa')?.addEventListener('change', (e) => {
    if (state.smaaPass) state.smaaPass.enabled = e.target.checked;
    saveGfxSettings();
  });

  restoreGfxSettings();
}

// =====================================
// GFX SETTINGS PERSISTENCE
// =====================================

function saveGfxSettings() {
  try {
    const renderer = state.world.renderer.three;
    const settings = {
      ambient: state.ambientLight?.intensity,
      sun: state.sunLight?.intensity,
      fill: state.fillLight?.intensity,
      hemi: state.hemiLight?.intensity,
      toneMapping: renderer.toneMapping,
      exposure: renderer.toneMappingExposure,
      aoIntensity: state.n8ao?.configuration.intensity,
      aoRadius: state.n8ao?.configuration.aoRadius,
      aoFalloff: state.n8ao?.configuration.distanceFalloff,
      aoEnabled: state.n8ao?.enabled,
      aoQuality: document.getElementById('gfx-ao-quality')?.value,
      pbr: state.pbrEnabled,
      bgColor: '#' + state.world.scene.three.background.getHexString(),
      dpr: document.getElementById('gfx-dpr')?.value,
      msaa: document.getElementById('gfx-msaa')?.value,
      smaa: state.smaaPass?.enabled,
    };
    localStorage.setItem('geobim_toc_gfx', JSON.stringify(settings));
  } catch (_) {}
}

function restoreGfxSettings() {
  try {
    const raw = localStorage.getItem('geobim_toc_gfx');
    if (!raw) return;
    const s = JSON.parse(raw);

    // Restore by triggering slider/select changes
    const setSlider = (id, val) => {
      const el = document.getElementById(id);
      if (el && val != null) { el.value = val; el.dispatchEvent(new Event('input')); }
    };
    const setSelect = (id, val) => {
      const el = document.getElementById(id);
      if (el && val != null) { el.value = val; el.dispatchEvent(new Event('change')); }
    };
    const setCheck = (id, val) => {
      const el = document.getElementById(id);
      if (el && val != null) { el.checked = val; el.dispatchEvent(new Event('change')); }
    };

    setSlider('gfx-ambient', s.ambient);
    setSlider('gfx-sun', s.sun);
    setSlider('gfx-fill', s.fill);
    setSlider('gfx-hemi', s.hemi);
    setSelect('gfx-tonemap', s.toneMapping);
    setSlider('gfx-exposure', s.exposure);
    setSlider('gfx-ao-intensity', s.aoIntensity);
    setSlider('gfx-ao-radius', s.aoRadius);
    setSlider('gfx-ao-falloff', s.aoFalloff);
    setCheck('gfx-ao-enabled', s.aoEnabled);
    setSelect('gfx-ao-quality', s.aoQuality);
    setCheck('gfx-pbr', s.pbr);
    if (s.bgColor) {
      const el = document.getElementById('gfx-bgcolor');
      if (el) { el.value = s.bgColor; el.dispatchEvent(new Event('input')); }
    }
    setSlider('gfx-dpr', s.dpr);
    setSelect('gfx-msaa', s.msaa);
    setCheck('gfx-smaa', s.smaa);
  } catch (_) {}
}

// =====================================
// CRS PANEL
// =====================================

window.crsOverride = null;

function setupCrsPanel() {
  // Toggle button
  document.getElementById('toggleCrs')?.addEventListener('click', () => {
    const panel = document.getElementById('crsPanel');
    panel?.classList.toggle('hidden');
    document.getElementById('toggleCrs')?.classList.toggle('active', !panel?.classList.contains('hidden'));
  });

  // "Aus Karte" — pick position on Cesium, auto-apply immediately
  document.getElementById('crsFromMap')?.addEventListener('click', () => {
    const epsg = document.getElementById('crsEpsg')?.value || 'EPSG:4326';
    activatePickupMode(epsg, (result) => {
      // Fill fields
      document.getElementById('crsEastings').value = result.eastings.toFixed(2);
      document.getElementById('crsNorthings').value = result.northings.toFixed(2);

      const height = parseFloat(document.getElementById('crsHeight')?.value) || 0;
      const rot = window._crsPickRotation || { deg: 0, xAxisAbscissa: 1.0, xAxisOrdinate: 0.0 };

      // Auto-apply
      const geoResult = applyGeorefOverride({ epsg, eastings: result.eastings, northings: result.northings, height });
      if (geoResult) {
        window.crsOverride = {
          epsg, eastings: result.eastings, northings: result.northings, height,
          lat: geoResult.lat, lon: geoResult.lon,
          rotationDeg: rot.deg, xAxisAbscissa: rot.xAxisAbscissa, xAxisOrdinate: rot.xAxisOrdinate,
        };
        const resultEl = document.getElementById('crsResult');
        if (resultEl) {
          resultEl.style.display = 'block';
          resultEl.textContent = `✅ ${geoResult.lat.toFixed(3)}°N / ${geoResult.lon.toFixed(3)}°E — ${rot.deg}°`;
        }
        // Show save button
        const saveBtn = document.getElementById('crsSaveIfc');
        if (saveBtn) saveBtn.style.display = '';
        setStatus('Georeferenzierung übernommen');
      }
    });
  });

  // Rotation edit button — toggle between read-only (pick) and editable
  document.getElementById('crsRotationEdit')?.addEventListener('click', () => {
    const rotEl = document.getElementById('crsRotation');
    if (!rotEl) return;
    if (rotEl.readOnly) {
      rotEl.readOnly = false;
      rotEl.style.color = 'var(--text-primary)';
      rotEl.value = window._crsPickRotation ? String(window._crsPickRotation.deg) : '0';
      rotEl.focus();
      rotEl.select();
    } else {
      // Parse manual value and compute xAxis
      const deg = parseFloat(rotEl.value) || 0;
      const norm = ((deg % 360) + 360) % 360;
      window._crsPickRotation = {
        deg: norm,
        xAxisAbscissa: Math.round(Math.cos((90 - norm) * Math.PI / 180) * 1e6) / 1e6,
        xAxisOrdinate: Math.round(Math.sin((90 - norm) * Math.PI / 180) * 1e6) / 1e6,
      };
      rotEl.value = `${norm}° (manuell)`;
      rotEl.readOnly = true;
      rotEl.style.color = 'var(--text-muted)';
    }
  });

  // "Anwenden" — apply georef override via georef.js
  document.getElementById('crsApply')?.addEventListener('click', () => {
    const epsg = document.getElementById('crsEpsg')?.value;
    const eastings = parseFloat(document.getElementById('crsEastings')?.value);
    const northings = parseFloat(document.getElementById('crsNorthings')?.value);
    const height = parseFloat(document.getElementById('crsHeight')?.value) || 0;

    if (isNaN(eastings) || isNaN(northings)) {
      setStatus('Eastings/Northings eingeben');
      return;
    }

    // Get rotation from pick or manual edit
    const rot = window._crsPickRotation || { deg: 0, xAxisAbscissa: 1.0, xAxisOrdinate: 0.0 };

    const result = applyGeorefOverride({ epsg, eastings, northings, height });

    if (result) {
      window.crsOverride = {
        epsg, eastings, northings, height,
        lat: result.lat, lon: result.lon,
        rotationDeg: rot.deg,
        xAxisAbscissa: rot.xAxisAbscissa,
        xAxisOrdinate: rot.xAxisOrdinate,
      };

      const resultEl = document.getElementById('crsResult');
      if (resultEl) {
        resultEl.style.display = 'block';
        resultEl.textContent = `✅ ${result.lat.toFixed(3)}°N / ${result.lon.toFixed(3)}°E — ${rot.deg}°`;
      }
      // Show save button
      const saveBtn = document.getElementById('crsSaveIfc');
      if (saveBtn) saveBtn.style.display = '';
      setStatus('CRS Override angewendet');
    } else {
      setStatus('Konvertierung fehlgeschlagen — EPSG prüfen');
    }
  });

  // "💾 IFC speichern" — patch IFC with MapConversion and download
  document.getElementById('crsSaveIfc')?.addEventListener('click', () => {
    const override = window.crsOverride;
    if (!override || !state.lastFileBuffer) {
      setStatus('Kein Override oder keine IFC-Datei');
      return;
    }

    const ifcText = new TextDecoder('utf-8', { fatal: false }).decode(state.lastFileBuffer);
    const epsgCode = (override.epsg || 'EPSG:4326').replace('EPSG:', '');
    const epsgNames = {
      '25832': 'ETRS89 / UTM zone 32N', '25833': 'ETRS89 / UTM zone 33N',
      '31467': 'DHDN / 3-degree Gauss-Kruger zone 3', '4326': 'WGS 84'
    };
    const epsgName = epsgNames[epsgCode] || `EPSG:${epsgCode}`;

    // Import patchIfcWithMapConversion is in georef.js — call via dynamic import
    import('./georef.js').then(({ patchIfcWithMapConversion }) => {
      // If not exported, patch inline
      console.warn('patchIfcWithMapConversion not available as export — using inline');
    }).catch(() => {});

    // Patch is in georef.js but not exported — we'll do inline patching here
    // Actually, let's trigger download of patched IFC via a simpler approach:
    // Re-encode the patched text
    const hasExistingMC = /IFCMAPCONVERSION/i.test(ifcText);
    let patched = ifcText;

    if (!hasExistingMC) {
      // Inline patch — same logic as patchIfcWithMapConversion in georef.js
      try {
        let maxId = 0;
        const idRe = /^#(\d+)\s*=/gm;
        let m;
        while ((m = idRe.exec(ifcText)) !== null) {
          const id = parseInt(m[1]);
          if (id > maxId) maxId = id;
        }
        const nextId = maxId + 1;

        const ctxRe = /^#(\d+)\s*=\s*IFCGEOMETRICREPRESENTATIONCONTEXT\s*\(/gim;
        let geoRepCtx = null;
        while ((m = ctxRe.exec(ifcText)) !== null) { geoRepCtx = m[1]; break; }

        if (geoRepCtx) {
          const xA = override.xAxisAbscissa ?? 1.0;
          const xO = override.xAxisOrdinate ?? 0.0;
          const crsLine = `#${nextId}=IFCPROJECTEDCRS('${epsgName}','EPSG:${epsgCode}',$,$,$,$,$);`;
          const mcLine = `#${nextId + 1}=IFCMAPCONVERSION(#${geoRepCtx},#${nextId},${override.eastings},${override.northings},${override.height || 0},${xA},${xO},1.0);`;

          const endsecIdx = patched.lastIndexOf('ENDSEC;');
          if (endsecIdx !== -1) {
            patched = patched.substring(0, endsecIdx) + crsLine + '\n' + mcLine + '\n' + patched.substring(endsecIdx);
          }
          console.log(`IFC patched: EPSG:${epsgCode}, E=${override.eastings}, N=${override.northings}, xAxis=${xA}/${xO}`);
        }
      } catch (e) {
        console.error('IFC patch failed:', e);
      }
    } else {
      setStatus('IFC enthält bereits IfcMapConversion — wird unverändert gespeichert');
    }

    // Download
    const blob = new Blob([patched], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseName = (state.lastFileName || 'model.ifc').replace(/\.ifc$/i, '');
    a.download = `${baseName}_georef.ifc`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`💾 ${a.download} gespeichert`);
  });
}

function updateCrsPanel(ifcText) {
  const info = extractCRSInfo(ifcText);
  const dot = document.getElementById('crsStatusDot');
  const text = document.getElementById('crsStatusText');
  const details = document.getElementById('crsDetailsBody');
  const form = document.getElementById('crsOverrideForm');
  const panel = document.getElementById('crsPanel');

  if (!dot || !text) return;

  // Status indicator
  const diag = info.diagnosis;
  if (diag.isFullyGeoReferenced && !diag.isRevitDefault) {
    dot.textContent = '🟢';
    text.textContent = 'Vollständig georeferenziert';
  } else if (diag.isPartial || (diag.isFullyGeoReferenced && diag.isRevitDefault)) {
    dot.textContent = '🟡';
    text.textContent = diag.isRevitDefault ? 'Revit-Standard (partiell)' : 'Partiell georeferenziert';
  } else if (diag.isRevitDefault) {
    dot.textContent = '🔴';
    text.textContent = 'Revit-Standardkoordinaten';
  } else {
    dot.textContent = '🔴';
    text.textContent = 'Keine Georeferenzierung';
  }

  // Details
  if (details) {
    let html = '';
    if (info.site.lat !== null) {
      html += `<b>IfcSite</b><br>Lat: ${info.site.lat.toFixed(6)}°  Lon: ${info.site.lon.toFixed(6)}°<br>`;
    } else {
      html += '<b>IfcSite</b>: nicht vorhanden<br>';
    }
    if (info.mapConversion.exists) {
      html += `<b>IfcMapConversion</b><br>E: ${info.mapConversion.eastings}  N: ${info.mapConversion.northings}<br>H: ${info.mapConversion.height}  xAxis: ${info.mapConversion.xAxisAbscissa}/${info.mapConversion.xAxisOrdinate}  Scale: ${info.mapConversion.scale}<br>`;
    } else {
      html += '<b>IfcMapConversion</b>: nicht vorhanden<br>';
    }
    if (info.projectedCRS.exists) {
      html += `<b>IfcProjectedCRS</b><br>${info.projectedCRS.name}`;
      if (info.projectedCRS.epsg) html += ` (${info.projectedCRS.epsg})`;
      html += '<br>';
    } else {
      html += '<b>IfcProjectedCRS</b>: nicht vorhanden<br>';
    }
    html += `<br><i>${diag.recommendation}</i>`;
    details.innerHTML = html;
  }

  // Show override form only for red/yellow
  if (form) {
    if (diag.isFullyGeoReferenced && !diag.isRevitDefault) {
      form.classList.add('hidden');
    } else {
      form.classList.remove('hidden');
    }
  }

  // Pre-fill override from detected values
  if (info.mapConversion.exists) {
    const e = document.getElementById('crsEastings');
    const n = document.getElementById('crsNorthings');
    const h = document.getElementById('crsHeight');
    if (e && !e.value) e.value = info.mapConversion.eastings;
    if (n && !n.value) n.value = info.mapConversion.northings;
    if (h && !h.value) h.value = info.mapConversion.height;
  }
  if (info.projectedCRS.epsg) {
    const sel = document.getElementById('crsEpsg');
    if (sel) {
      // Try to select matching EPSG
      for (const opt of sel.options) {
        if (opt.value === info.projectedCRS.epsg) { sel.value = opt.value; break; }
      }
    }
  }

  // Auto-show panel on load
  if (panel) {
    panel.classList.remove('hidden');
    document.getElementById('toggleCrs')?.classList.add('active');
  }
}

// =====================================
// SVG ICONS
// =====================================

function eyeIcon() {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
}

function eyeOffIcon() {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
}

function trashIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
}

// =====================================
// START
// =====================================

init().catch((err) => {
  console.error('Init failed:', err);
  setStatus('Initialization failed: ' + err.message);
});
