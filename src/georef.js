// =====================================
// GEOREFERENCING & ION UPLOAD MODULE
// Adapted for ThatOpen Components viewer
// =====================================

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import proj4 from 'proj4';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Common CRS definitions for proj4
const CRS_DEFS = {
  'EPSG:25832': '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:25833': '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:25831': '+proj=utm +zone=31 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:32632': '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs',
  'EPSG:32633': '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs',
  'EPSG:32631': '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs',
  'EPSG:4326':  '+proj=longlat +datum=WGS84 +no_defs',
  'EPSG:3857':  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +no_defs',
  'EPSG:2056':  '+proj=somerc +lat_0=46.9524056 +lon_0=7.43958333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs',
  'EPSG:31467': '+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=3500000 +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs',
  'EPSG:31468': '+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs',
  'EPSG:31469': '+proj=tmerc +lat_0=0 +lon_0=15 +k=1 +x_0=5500000 +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs',
  'EPSG:2154':  '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:27700': '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.060,0.1502,0.2470,0.8421,-20.4894 +units=m +no_defs',
};

Object.entries(CRS_DEFS).forEach(([code, def]) => proj4.defs(code, def));

// =====================================
// RESOLVE EPSG from CRS name
// =====================================

function resolveEpsg(crsName) {
  if (!crsName) return null;
  const epsgMatch = crsName.match(/EPSG[:\s]*(\d+)/i);
  if (epsgMatch) return `EPSG:${epsgMatch[1]}`;
  const lower = crsName.toLowerCase();
  if (lower.includes('utm') && lower.includes('32')) return 'EPSG:25832';
  if (lower.includes('utm') && lower.includes('33')) return 'EPSG:25833';
  if (lower.includes('utm') && lower.includes('31')) return 'EPSG:25831';
  if (lower.includes('ch1903') || lower.includes('lv95')) return 'EPSG:2056';
  if (lower.includes('gauss') && lower.includes('3')) return 'EPSG:31467';
  if (lower.includes('gauss') && lower.includes('4')) return 'EPSG:31468';
  if (lower.includes('lambert') && lower.includes('93')) return 'EPSG:2154';
  if (lower.includes('osgb') || lower.includes('british')) return 'EPSG:27700';
  return null;
}

// =====================================
// AUTO-DETECT GEOREF from IFC STEP text
// =====================================

// Parse a STEP value — handles numbers, strings, enum, $, references
function stepVal(s) {
  if (!s || s === '$' || s === '*') return null;
  s = s.trim();
  if (s.startsWith("'")) return s.slice(1, -1);
  const n = parseFloat(s);
  return isNaN(n) ? s : n;
}

export function autoDetectGeoref(ifcBuffer) {
  if (!ifcBuffer) return null;

  try {
    // Decode IFC as text (only need to scan for georef entities)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(ifcBuffer);

    // Find IfcMapConversion: IFCMAPCONVERSION(source, target, eastings, northings, orthogonalHeight, xAxisAbscissa, xAxisOrdinate, scale)
    const mcMatch = text.match(/IFCMAPCONVERSION\s*\(([^;]+)\)/i);
    if (!mcMatch) return null;

    const mcArgs = mcMatch[1].split(',').map((s) => s.trim());
    // Args: 0=source, 1=target, 2=eastings, 3=northings, 4=orthogonalHeight, 5=xAxisAbscissa, 6=xAxisOrdinate, 7=scale
    const eastings = stepVal(mcArgs[2]);
    const northings = stepVal(mcArgs[3]);
    const orthogonalHeight = stepVal(mcArgs[4]) || 0;
    const xAxisAbscissa = stepVal(mcArgs[5]);
    const xAxisOrdinate = stepVal(mcArgs[6]);

    if (eastings == null || northings == null) return null;

    // Find target CRS reference
    const targetRef = mcArgs[1]?.trim();
    let crsName = null;
    if (targetRef && targetRef.startsWith('#')) {
      // Look up the IfcProjectedCRS entity
      const refId = targetRef.slice(1);
      const crsPattern = new RegExp(`#${refId}\\s*=\\s*IFCPROJECTEDCRS\\s*\\(([^;]+)\\)`, 'i');
      const crsMatch = text.match(crsPattern);
      if (crsMatch) {
        const crsArgs = crsMatch[1].split(',').map((s) => s.trim());
        crsName = stepVal(crsArgs[0]) || null;
      }
    }

    // Also try to find CRS name by scanning all IfcProjectedCRS if ref lookup failed
    if (!crsName) {
      const anyCrs = text.match(/IFCPROJECTEDCRS\s*\(\s*'([^']+)'/i);
      if (anyCrs) crsName = anyCrs[1];
    }

    console.log('Georef detected:', { eastings, northings, height: orthogonalHeight, crs: crsName });

    const epsg = resolveEpsg(crsName);
    if (epsg && CRS_DEFS[epsg]) {
      const [lon, lat] = proj4(epsg, 'EPSG:4326', [eastings, northings]);
      geoState.lon = lon;
      geoState.lat = lat;
      geoState.terrainHeight = orthogonalHeight;
      geoState.height = 0;
      geoState.detected = true;
      geoState.crsName = crsName;

      if (xAxisAbscissa != null && xAxisOrdinate != null) {
        geoState.rotation = Math.atan2(xAxisOrdinate, xAxisAbscissa) * (180 / Math.PI);
      }

      console.log(`Georef → WGS84: ${lat.toFixed(6)}, ${lon.toFixed(6)}, h=${orthogonalHeight.toFixed(1)}, rot=${geoState.rotation.toFixed(1)}`);
      return geoState;
    } else {
      console.warn('Unknown CRS, cannot auto-convert:', crsName);
      return null;
    }
  } catch (err) {
    console.warn('Georef detection failed:', err);
    return null;
  }
}

let cesiumViewer = null;
let footprintEntity = null;
let pinEntity = null;
let modelEntity = null;
let cachedGlbUrl = null;
let gizmoEntities = [];
let defaultImageryLayer = null; // Cesium's default base layer
let wmtsLayer = null; // current WMTS overlay layer
let geoState = {
  lon: null,
  lat: null,
  height: 0,
  terrainHeight: 0,
  rotation: 0,
  detected: false,
  crsName: null,
  ionToken: null,
};

function effectiveHeight() {
  return (geoState.terrainHeight || 0) + (geoState.height || 0);
}

async function sampleTerrainAt(lon, lat) {
  if (!cesiumViewer) return;
  const Cesium = window.Cesium;
  try {
    const tp = cesiumViewer.scene.terrainProvider;
    if (tp && tp.ready !== false) {
      const positions = [Cesium.Cartographic.fromDegrees(lon, lat)];
      const updated = await Cesium.sampleTerrainMostDetailed(tp, positions);
      if (updated[0] && isFinite(updated[0].height)) {
        geoState.terrainHeight = Math.round(updated[0].height * 10) / 10;
      }
    }
  } catch (_) {}
}

// =====================================
// COLLECT SCENE MESHES (ThatOpen adapter)
// =====================================

function collectMeshes(appState) {
  const meshes = [];
  if (!appState.world) return meshes;
  let hiddenCount = 0;
  appState.world.scene.three.traverse((obj) => {
    if (obj.isMesh && obj.geometry) {
      if (!obj.visible) { hiddenCount++; return; }
      meshes.push(obj);
    }
  });
  if (hiddenCount > 0) console.log(`collectMeshes: ${meshes.length} visible, ${hiddenCount} hidden`);
  return meshes;
}

function sceneBBox(appState) {
  const bbox = new THREE.Box3();
  const meshes = collectMeshes(appState);
  meshes.forEach((m) => bbox.expandByObject(m));
  return bbox;
}

// =====================================
// GEO PANEL — Cesium minimap
// =====================================

export function initGeoPanel(appState) {
  const Cesium = window.Cesium;
  if (!Cesium) {
    console.error('CesiumJS not loaded');
    return;
  }

  const container = document.getElementById('cesiumMinimap');
  if (!container || cesiumViewer) return;

  const tokenInput = document.getElementById('geoIonToken');
  const token = tokenInput?.value?.trim() || geoState.ionToken || '';
  if (!token) {
    document.getElementById('geoStatus').textContent = 'Enter Cesium Ion token first';
    return;
  }
  geoState.ionToken = token;
  Cesium.Ion.defaultAccessToken = token;

  cesiumViewer = new Cesium.Viewer(container, {
    baseLayerPicker: false,
    timeline: false,
    animation: false,
    fullscreenButton: false,
    homeButton: false,
    geocoder: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    infoBox: false,
    selectionIndicator: false,
    creditContainer: document.createElement('div'),
  });

  cesiumViewer.scene.setTerrain(Cesium.Terrain.fromWorldTerrain());
  cesiumViewer.scene.globe.depthTestAgainstTerrain = true;

  // Store reference to default base imagery layer
  defaultImageryLayer = cesiumViewer.imageryLayers.get(0);

  // Apply saved WMTS layer preference
  const savedLayer = localStorage.getItem('geobim_map_layer');
  if (savedLayer && savedLayer !== 'default') {
    setWmtsLayer(savedLayer);
  }

  // Harmonize mouse controls with Three.js viewport:
  // Left-drag = orbit, Right-drag = pan, Scroll = zoom
  const ssCam = cesiumViewer.scene.screenSpaceCameraController;
  ssCam.rotateEventTypes = [Cesium.CameraEventType.LEFT_DRAG];
  ssCam.translateEventTypes = [Cesium.CameraEventType.RIGHT_DRAG];
  ssCam.zoomEventTypes = [
    Cesium.CameraEventType.WHEEL,
    Cesium.CameraEventType.PINCH,
  ];
  ssCam.tiltEventTypes = [
    { eventType: Cesium.CameraEventType.MIDDLE_DRAG },
    { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.SHIFT },
  ];
  ssCam.lookEventTypes = [];

  // Interaction
  const handler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.scene.canvas);
  let dragging = false;
  let rotating = false;
  let heightDrag = false;
  let dragStartAngle = 0;
  let heightDragStartY = 0;

  function pickGlobePosition(screenPos) {
    const ray = cesiumViewer.camera.getPickRay(screenPos);
    return ray ? cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene) : null;
  }

  async function sampleHeight(lon, lat) {
    try {
      const tp = cesiumViewer.scene.terrainProvider;
      if (tp && tp.ready !== false) {
        const positions = [Cesium.Cartographic.fromDegrees(lon, lat)];
        const updated = await Cesium.sampleTerrainMostDetailed(tp, positions);
        if (updated[0] && isFinite(updated[0].height)) return Math.round(updated[0].height * 10) / 10;
      }
    } catch (_) {}
    return 0;
  }

  function isNearModel(screenPos) {
    if (geoState.lon == null) return false;
    const modelScreen = Cesium.SceneTransforms.worldToWindowCoordinates(
      cesiumViewer.scene,
      Cesium.Cartesian3.fromDegrees(geoState.lon, geoState.lat, effectiveHeight())
    );
    if (!modelScreen) return false;
    const dx = screenPos.x - modelScreen.x;
    const dy = screenPos.y - modelScreen.y;
    return Math.sqrt(dx * dx + dy * dy) < 80;
  }

  let ctrlDown = false, zDown = false;

  handler.setInputAction((e) => {
    if (geoState.lon != null && isNearModel(e.position)) {
      if (zDown) {
        heightDrag = true;
        heightDragStartY = e.position.y;
      } else if (e.position._ctrlKey || ctrlDown) {
        rotating = true;
        const modelScreen = Cesium.SceneTransforms.worldToWindowCoordinates(
          cesiumViewer.scene,
          Cesium.Cartesian3.fromDegrees(geoState.lon, geoState.lat, effectiveHeight())
        );
        dragStartAngle = Math.atan2(e.position.y - modelScreen.y, e.position.x - modelScreen.x);
      } else {
        dragging = true;
      }
      cesiumViewer.scene.screenSpaceCameraController.enableRotate = false;
      cesiumViewer.scene.screenSpaceCameraController.enableTranslate = false;
    }
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction((e) => {
    if (dragging) {
      const cartesian = pickGlobePosition(e.endPosition);
      if (!cartesian) return;
      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      geoState.lon = Cesium.Math.toDegrees(carto.longitude);
      geoState.lat = Cesium.Math.toDegrees(carto.latitude);
      geoState.terrainHeight = Math.round(carto.height * 10) / 10;
      updateGeoUI();
      repositionEntities();
    } else if (rotating) {
      const modelScreen = Cesium.SceneTransforms.worldToWindowCoordinates(
        cesiumViewer.scene,
        Cesium.Cartesian3.fromDegrees(geoState.lon, geoState.lat, effectiveHeight())
      );
      if (!modelScreen) return;
      const angle = Math.atan2(e.endPosition.y - modelScreen.y, e.endPosition.x - modelScreen.x);
      const delta = (angle - dragStartAngle) * (180 / Math.PI);
      dragStartAngle = angle;
      geoState.rotation = ((geoState.rotation || 0) + delta + 360) % 360;
      if (geoState.rotation > 180) geoState.rotation -= 360;
      updateGeoUI();
      repositionEntities();
      const slider = document.getElementById('geoRotSlider');
      if (slider) slider.value = geoState.rotation.toFixed(1);
    } else if (heightDrag) {
      const dy = heightDragStartY - e.endPosition.y;
      heightDragStartY = e.endPosition.y;
      geoState.height = Math.round(((geoState.height || 0) + dy * 0.1) * 10) / 10;
      updateGeoUI();
      repositionEntities();
    } else {
      if (geoState.lon != null && isNearModel(e.endPosition)) {
        cesiumViewer.scene.canvas.style.cursor = zDown ? 'ns-resize' : 'grab';
      } else {
        cesiumViewer.scene.canvas.style.cursor = '';
      }
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction(async () => {
    if (dragging || rotating || heightDrag) {
      const wasDrag = dragging;
      dragging = false;
      rotating = false;
      heightDrag = false;
      cesiumViewer.scene.screenSpaceCameraController.enableRotate = true;
      cesiumViewer.scene.screenSpaceCameraController.enableTranslate = true;
      cesiumViewer.scene.canvas.style.cursor = '';
      if (geoState.lon != null) {
        if (wasDrag) {
          geoState.terrainHeight = await sampleHeight(geoState.lon, geoState.lat) || geoState.terrainHeight;
        }
        updateGeoUI();
        updateFootprint(appState);
      }
      return;
    }
  }, Cesium.ScreenSpaceEventType.LEFT_UP);

  handler.setInputAction(async (click) => {
    if (geoState.lon != null && isNearModel(click.position)) return;
    const cartesian = pickGlobePosition(click.position);
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    geoState.lon = Cesium.Math.toDegrees(carto.longitude);
    geoState.lat = Cesium.Math.toDegrees(carto.latitude);
    geoState.terrainHeight = Math.round(carto.height * 10) / 10;
    geoState.height = 0;
    geoState.terrainHeight = await sampleHeight(geoState.lon, geoState.lat) || geoState.terrainHeight;
    updateGeoUI();
    updateFootprint(appState);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const onKeyDown = (e) => {
    if (e.key === 'Control') ctrlDown = true;
    if (e.key === 'z' || e.key === 'Z') zDown = true;
  };
  const onKeyUp = (e) => {
    if (e.key === 'Control') ctrlDown = false;
    if (e.key === 'z' || e.key === 'Z') zDown = false;
  };
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  if (geoState.lon != null && geoState.lat != null) {
    updateGeoUI();
    flyToPosition();
    updateFootprint(appState);
  }

  document.getElementById('geoStatus').textContent = geoState.detected ? 'Auto-detected from IFC' : 'Click map to place model';

  const ro = new ResizeObserver(() => {
    if (cesiumViewer) cesiumViewer.resize();
  });
  ro.observe(container);
}

export function destroyGeoPanel() {
  if (splitterCleanup) splitterCleanup();
  if (cesiumViewer) {
    cesiumViewer.destroy();
    cesiumViewer = null;
    modelEntity = null;
    pinEntity = null;
    footprintEntity = null;
    gizmoEntities = [];
  }
}

export function toggleGeoPanel(appState) {
  const panel = document.getElementById('geoPanel');
  const splitter = document.getElementById('geoSplitter');
  if (!panel) return;
  const isHidden = panel.classList.toggle('hidden');
  splitter?.classList.toggle('hidden', isHidden);
  document.getElementById('toggleGeo')?.classList.toggle('active', !isHidden);

  // Restore saved width
  if (!isHidden) {
    const saved = localStorage.getItem('geoPanelWidth');
    if (saved) panel.style.width = saved + 'px';
  }

  resizeThreeViewport(appState);

  if (!isHidden) {
    initSplitter(appState);
    setTimeout(() => initGeoPanel(appState), 100);
  } else {
    destroyGeoPanel();
  }
}

let splitterCleanup = null;
function initSplitter(appState) {
  if (splitterCleanup) return; // already attached
  const splitter = document.getElementById('geoSplitter');
  const panel = document.getElementById('geoPanel');
  if (!splitter || !panel) return;

  let startX, startW;

  function onMouseDown(e) {
    e.preventDefault();
    startX = e.clientX;
    startW = panel.offsetWidth;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    const dx = startX - e.clientX; // dragging left = wider panel
    const newW = Math.max(280, Math.min(window.innerWidth * 0.7, startW + dx));
    panel.style.width = newW + 'px';
    resizeViewportSync(appState);
    if (cesiumViewer) cesiumViewer.resize();
  }

  function onMouseUp() {
    splitter.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    localStorage.setItem('geoPanelWidth', panel.offsetWidth);
    resizeViewportSync(appState);
    if (cesiumViewer) cesiumViewer.resize();
  }

  splitter.addEventListener('mousedown', onMouseDown);
  splitterCleanup = () => {
    splitter.removeEventListener('mousedown', onMouseDown);
    splitterCleanup = null;
  };
}

function resizeThreeViewport(appState) {
  const viewport = document.getElementById('viewport');
  if (!viewport) return;
  requestAnimationFrame(() => resizeViewportSync(appState));
}

function resizeViewportSync(appState) {
  const viewport = document.getElementById('viewport');
  if (!viewport) return;
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  if (w <= 0 || h <= 0) return;
  if (appState.world?.camera?.three) {
    const cam = appState.world.camera.three;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }
  if (appState.world?.renderer?.three) {
    appState.world.renderer.three.setSize(w, h);
  }
  if (appState.composer) {
    appState.composer.setSize(w, h);
    appState.composer.render();
  } else if (appState.world?.renderer?.three) {
    appState.world.renderer.three.render(
      appState.world.scene?.three,
      appState.world.camera?.three
    );
  }
}

// =====================================
// GEO UI Updates
// =====================================

function updateGeoUI() {
  const lonEl = document.getElementById('geoLon');
  const latEl = document.getElementById('geoLat');
  const heightEl = document.getElementById('geoHeight');
  const rotEl = document.getElementById('geoRotation');
  const statusEl = document.getElementById('geoStatus');

  const eff = effectiveHeight();
  if (lonEl) lonEl.value = geoState.lon?.toFixed(6) ?? '';
  if (latEl) latEl.value = geoState.lat?.toFixed(6) ?? '';
  if (heightEl) heightEl.value = eff.toFixed(1);
  if (rotEl) rotEl.value = geoState.rotation?.toFixed(1) ?? '0';

  const heightSlider = document.getElementById('geoHeightSlider');
  if (heightSlider) {
    const t = geoState.terrainHeight || 0;
    heightSlider.min = (t - 50).toFixed(0);
    heightSlider.max = (t + 200).toFixed(0);
    heightSlider.value = eff;
  }
  const rotSlider = document.getElementById('geoRotSlider');
  if (rotSlider) rotSlider.value = geoState.rotation ?? 0;
  if (statusEl && geoState.lon != null) {
    statusEl.textContent = geoState.detected ? `Auto: ${geoState.crsName || 'IFC Georef'}` : 'Position set';
    statusEl.style.color = '#2ECFB0';
  }
}

function flyToPosition() {
  if (!cesiumViewer || geoState.lon == null) return;
  const Cesium = window.Cesium;
  cesiumViewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(geoState.lon, geoState.lat, 500),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
    duration: 1.5,
  });
}

// =====================================
// GLB EXPORT (from scene traversal)
// =====================================

// Read buffer data — arrays are kept in CPU memory by prototype patch in main.js
function readAttrFloat(attr) {
  if (!attr || attr.count === 0 || !attr.array) return null;
  return new Float32Array(attr.array);
}

function readIndexData(idx) {
  if (!idx || !idx.array) return null;
  return new Uint32Array(idx.array);
}

// Check if a geometry is a ThatOpen internal helper (flat plane with few vertices)
// Real geometry has many vertices; helper objects are simple rectangles (4-24 verts)
function isHelperPlane(posData, matrix) {
  const vertCount = posData.length / 3;
  if (vertCount > 24) return false; // real geometry — skip check

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const v = new THREE.Vector3();
  for (let i = 0; i < posData.length; i += 3) {
    v.set(posData[i], posData[i + 1], posData[i + 2]).applyMatrix4(matrix);
    min[0] = Math.min(min[0], v.x); min[1] = Math.min(min[1], v.y); min[2] = Math.min(min[2], v.z);
    max[0] = Math.max(max[0], v.x); max[1] = Math.max(max[1], v.y); max[2] = Math.max(max[2], v.z);
  }
  const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]].sort((a, b) => a - b);
  // Flat plane: thinnest dimension essentially zero
  return dims[2] > 0.01 && dims[0] < 0.001;
}

async function exportSceneToGlb(appState) {
  if (cachedGlbUrl) return cachedGlbUrl;
  const meshes = collectMeshes(appState);
  if (!meshes.length) { console.warn('GLB export: no meshes found'); return null; }

  const exportScene = new THREE.Scene();
  const disposables = [];
  let added = 0, skipped = 0, openingSkipped = 0;

  // Helper: create export mesh from position data + matrix
  function addExportMesh(posData, idxData, matrix, color, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posData.slice(), 3));
    if (idxData) geo.setIndex(new THREE.BufferAttribute(idxData.slice(), 1));

    geo.applyMatrix4(matrix);

    // Flip winding if matrix has negative determinant (mirror/scale)
    if (matrix.determinant() < 0 && geo.index) {
      const idxArr = geo.index.array;
      for (let i = 0; i < idxArr.length; i += 3) {
        const tmp = idxArr[i];
        idxArr[i] = idxArr[i + 2];
        idxArr[i + 2] = tmp;
      }
      geo.index.needsUpdate = true;
    }

    geo.computeVertexNormals();

    // Force-normalize all normals (degenerate triangles produce zero-length normals)
    const nAttr = geo.getAttribute('normal');
    if (nAttr) {
      for (let i = 0; i < nAttr.count; i++) {
        let x = nAttr.getX(i), y = nAttr.getY(i), z = nAttr.getZ(i);
        const len = Math.sqrt(x * x + y * y + z * z);
        if (len < 1e-6) { x = 0; y = 0; z = 1; } // fallback for degenerate
        else { x /= len; y /= len; z /= len; }
        nAttr.setXYZ(i, x, y, z);
      }
      nAttr.needsUpdate = true;
    }

    const previewMat = new THREE.MeshStandardMaterial({
      color, opacity, transparent: opacity < 1,
      metalness: 0.1, roughness: 0.8, side: THREE.DoubleSide,
    });

    exportScene.add(new THREE.Mesh(geo, previewMat));
    disposables.push(geo, previewMat);
    added++;
  }

  let instancedCount = 0;

  meshes.forEach((m) => {
    try {
      const srcPos = m.geometry.getAttribute('position');
      const posData = readAttrFloat(srcPos);
      if (!posData || posData.length < 9) { skipped++; return; }

      const fullIdxData = readIndexData(m.geometry.index);
      const materials = Array.isArray(m.material) ? m.material : [m.material];
      const groups = m.geometry.groups;

      m.updateWorldMatrix(true, false);

      // Skip flat-plane helper geometries (ThatOpen internal objects not rendered in viewport)
      if (isHelperPlane(posData, m.matrixWorld)) { openingSkipped++; skipped++; return; }

      // Multi-material mesh: export each group separately with correct material
      if (groups.length > 0 && materials.length > 1) {
        for (const group of groups) {
          const matIdx = group.materialIndex || 0;
          const mat = materials[matIdx] || materials[0];
          const opacity = mat?.opacity ?? 1;
          if (opacity < 0.01) continue; // skip invisible groups

          const c = mat?.color ? mat.color.clone() : new THREE.Color(0.8, 0.8, 0.8);

          // Extract only this group's indices
          if (fullIdxData) {
            const groupIdx = fullIdxData.slice(group.start, group.start + group.count);
            if (groupIdx.length < 3) continue;
            addExportMesh(posData, groupIdx, m.matrixWorld, c, opacity);
          } else {
            // Non-indexed: slice position data by group range
            const startVert = group.start;
            const endVert = group.start + group.count;
            const groupPos = posData.slice(startVert * 3, endVert * 3);
            if (groupPos.length < 9) continue;
            addExportMesh(groupPos, null, m.matrixWorld, c, opacity);
          }
        }
      } else {
        // Single material mesh
        const mat = materials[0];
        const c = mat?.color ? mat.color.clone() : new THREE.Color(0.8, 0.8, 0.8);
        const opacity = mat?.opacity ?? 1;

        // Handle InstancedMesh
        if (m.isInstancedMesh && m.count > 0) {
          instancedCount++;
          const instMatrix = new THREE.Matrix4();
          const combined = new THREE.Matrix4();
          for (let i = 0; i < m.count; i++) {
            m.getMatrixAt(i, instMatrix);
            combined.multiplyMatrices(m.matrixWorld, instMatrix);
            addExportMesh(posData, fullIdxData, combined, c.clone(), opacity);
          }
        } else {
          addExportMesh(posData, fullIdxData, m.matrixWorld, c, opacity);
        }
      }
    } catch (err) {
      skipped++;
      console.warn('GLB export: skipped mesh', err.message);
    }
  });

  console.log(`GLB export: ${added} meshes added, ${skipped} skipped (${openingSkipped} openings), ${instancedCount} instanced`);
  if (!added) return null;

  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(exportScene, { binary: true });
  disposables.forEach((d) => d.dispose());

  const blob = new Blob([glb], { type: 'model/gltf-binary' });
  console.log(`GLB export: ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
  cachedGlbUrl = URL.createObjectURL(blob);
  return cachedGlbUrl;
}

// Fast reposition during drag
function repositionEntities() {
  if (!cesiumViewer || geoState.lon == null) return;
  const Cesium = window.Cesium;
  const h = effectiveHeight();
  const position = Cesium.Cartesian3.fromDegrees(geoState.lon, geoState.lat, h);
  const heading = Cesium.Math.toRadians(geoState.rotation || 0);
  const orientation = Cesium.Transforms.headingPitchRollQuaternion(
    position, new Cesium.HeadingPitchRoll(heading, 0, 0)
  );

  if (modelEntity) {
    modelEntity.position = position;
    modelEntity.orientation = orientation;
  }
  if (pinEntity) {
    pinEntity.position = position;
  }
}

export async function updateFootprint(appState) {
  if (!cesiumViewer || geoState.lon == null) return;
  const Cesium = window.Cesium;
  const meshes = collectMeshes(appState);

  const h = effectiveHeight();
  const position = Cesium.Cartesian3.fromDegrees(geoState.lon, geoState.lat, h);
  const heading = Cesium.Math.toRadians(geoState.rotation || 0);
  const orientation = Cesium.Transforms.headingPitchRollQuaternion(
    position, new Cesium.HeadingPitchRoll(heading, 0, 0)
  );

  // Model entity
  if (!modelEntity && meshes.length) {
    try {
      const glbUrl = await exportSceneToGlb(appState);
      if (glbUrl) {
        modelEntity = cesiumViewer.entities.add({
          position, orientation,
          model: { uri: glbUrl, scale: 1.0, minimumPixelSize: 32, maximumScale: 20000 },
        });
      }
    } catch (e) {
      console.warn('GLB export for preview failed:', e);
    }
  } else if (modelEntity) {
    modelEntity.position = position;
    modelEntity.orientation = orientation;
  }

  // Fallback footprint
  if (!modelEntity && meshes.length) {
    if (footprintEntity) cesiumViewer.entities.remove(footprintEntity);
    footprintEntity = null;

    const bbox = sceneBBox(appState);
    const size = bbox.getSize(new THREE.Vector3());
    let sizeX = size.x > 0 ? size.x : 20;
    let sizeZ = size.z > 0 ? size.z : 20;

    const mPerDegLat = 111320;
    const mPerDegLon = mPerDegLat * Math.cos(geoState.lat * Math.PI / 180);
    const halfLon = (sizeX / 2) / mPerDegLon;
    const halfLat = (sizeZ / 2) / mPerDegLat;
    const rotRad = (geoState.rotation || 0) * Math.PI / 180;

    const corners = [
      [-halfLon, -halfLat], [halfLon, -halfLat],
      [halfLon, halfLat], [-halfLon, halfLat],
    ].map(([dx, dy]) => {
      const rx = dx * Math.cos(rotRad) - dy * Math.sin(rotRad);
      const ry = dx * Math.sin(rotRad) + dy * Math.cos(rotRad);
      return Cesium.Cartesian3.fromDegrees(geoState.lon + rx, geoState.lat + ry);
    });

    footprintEntity = cesiumViewer.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(corners),
        material: Cesium.Color.fromCssColorString('#2ECFB0').withAlpha(0.35),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#2ECFB0'),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });
  }

  // Gizmo axes
  gizmoEntities.forEach((e) => cesiumViewer.entities.remove(e));
  gizmoEntities = [];

  let armLen = 15;
  if (meshes.length) {
    const sizeM = sceneBBox(appState).getSize(new THREE.Vector3());
    armLen = Math.max(5, Math.max(sizeM.x, sizeM.z) * 0.15);
  }
  const mPerDegLat2 = 111320;
  const mPerDegLon2 = mPerDegLat2 * Math.cos(geoState.lat * Math.PI / 180);
  const rotRad2 = (geoState.rotation || 0) * Math.PI / 180;

  function offsetM(dx, dz) {
    const rx = dx * Math.cos(rotRad2) - dz * Math.sin(rotRad2);
    const rz = dx * Math.sin(rotRad2) + dz * Math.cos(rotRad2);
    return [geoState.lon + rx / mPerDegLon2, geoState.lat + rz / mPerDegLat2];
  }

  // X (red)
  const xNeg = offsetM(-armLen, 0);
  const xPos = offsetM(armLen, 0);
  gizmoEntities.push(cesiumViewer.entities.add({
    polyline: { positions: [Cesium.Cartesian3.fromDegrees(xNeg[0], xNeg[1], h), Cesium.Cartesian3.fromDegrees(xPos[0], xPos[1], h)], width: 3, material: Cesium.Color.fromCssColorString('#ff3333'), clampToGround: false },
  }));
  // Z (blue)
  const zNeg = offsetM(0, -armLen);
  const zPos = offsetM(0, armLen);
  gizmoEntities.push(cesiumViewer.entities.add({
    polyline: { positions: [Cesium.Cartesian3.fromDegrees(zNeg[0], zNeg[1], h), Cesium.Cartesian3.fromDegrees(zPos[0], zPos[1], h)], width: 3, material: Cesium.Color.fromCssColorString('#3333ff'), clampToGround: false },
  }));
  // Y (green, vertical)
  gizmoEntities.push(cesiumViewer.entities.add({
    polyline: { positions: [Cesium.Cartesian3.fromDegrees(geoState.lon, geoState.lat, h), Cesium.Cartesian3.fromDegrees(geoState.lon, geoState.lat, h + armLen)], width: 3, material: Cesium.Color.fromCssColorString('#33ff33'), clampToGround: false },
  }));
  // White center
  if (!pinEntity) {
    pinEntity = cesiumViewer.entities.add({
      position,
      point: { pixelSize: 10, color: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
  } else {
    pinEntity.position = position;
  }
}

// =====================================
// ADDRESS SEARCH (Nominatim)
// =====================================

export async function searchAddress(query) {
  if (!query?.trim()) return;
  const statusEl = document.getElementById('geoStatus');
  if (statusEl) { statusEl.textContent = 'Searching...'; statusEl.style.color = ''; }

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const resp = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const results = await resp.json();
    if (results.length > 0) {
      geoState.lon = parseFloat(results[0].lon);
      geoState.lat = parseFloat(results[0].lat);
      geoState.detected = false;
      updateGeoUI();
      flyToPosition();
      if (statusEl) { statusEl.textContent = results[0].display_name.substring(0, 40) + '...'; statusEl.style.color = '#2ECFB0'; }
    } else {
      if (statusEl) { statusEl.textContent = 'Address not found'; statusEl.style.color = '#ff6666'; }
    }
  } catch (err) {
    console.warn('Geocoding failed:', err);
    if (statusEl) { statusEl.textContent = 'Search failed'; statusEl.style.color = '#ff6666'; }
  }
}

// =====================================
// MANUAL COORDINATE INPUT
// =====================================

export function applyManualCoords(appState) {
  const lon = parseFloat(document.getElementById('geoLon')?.value);
  const lat = parseFloat(document.getElementById('geoLat')?.value);
  const absHeight = parseFloat(document.getElementById('geoHeight')?.value) || 0;
  const rotation = parseFloat(document.getElementById('geoRotation')?.value) || 0;

  if (isNaN(lon) || isNaN(lat)) return;

  const posChanged = geoState.lon == null ||
    Math.abs(lon - geoState.lon) > 0.0001 ||
    Math.abs(lat - geoState.lat) > 0.0001;

  geoState.lon = lon;
  geoState.lat = lat;
  geoState.height = absHeight - (geoState.terrainHeight || 0);
  geoState.rotation = rotation;
  geoState.detected = false;

  updateGeoUI();
  if (cesiumViewer) {
    if (posChanged) {
      flyToPosition();
      sampleTerrainAt(lon, lat);
    }
    updateFootprint(appState);
  }
}

// =====================================
// CESIUM ION UPLOAD
// =====================================

// Clean IFC buffer by removing excluded elements via web-ifc
async function cleanIfcBuffer(rawBuffer, excludedIds) {
  if (!excludedIds || excludedIds.size === 0) return rawBuffer;

  const WebIFC = await import('web-ifc');
  const ifcApi = new WebIFC.IfcAPI();
  ifcApi.SetWasmPath('https://unpkg.com/web-ifc@0.0.74/');
  await ifcApi.Init();

  const modelID = ifcApi.OpenModel(rawBuffer);
  let deleted = 0;
  for (const expressID of excludedIds) {
    try {
      ifcApi.DeleteLine(modelID, expressID);
      deleted++;
    } catch (err) {
      console.warn(`DeleteLine(${expressID}) failed:`, err.message);
    }
  }

  console.log(`IFC cleaned: ${deleted}/${excludedIds.size} elements removed`);
  const cleanedBuffer = ifcApi.SaveModel(modelID);
  ifcApi.CloseModel(modelID);
  return cleanedBuffer;
}

// =====================================
// PATCH IFC WITH MAPCONVERSION
// =====================================

/**
 * Inject IfcMapConversion + IfcProjectedCRS into raw IFC text.
 * Also patches IfcSite RefLatitude/RefLongitude to correct WGS84 DMS values.
 *
 * @param {string} ifcText - Raw IFC file content
 * @param {{ eastings: number, northings: number, height: number,
 *           epsgCode: string, epsgName: string,
 *           xAxisAbscissa?: number, xAxisOrdinate?: number, scale?: number }} params
 * @returns {string} Patched IFC text (or original on error)
 */
function patchIfcWithMapConversion(ifcText, params) {
  try {
    const { eastings, northings, height, epsgCode, epsgName,
            xAxisAbscissa = 1.0, xAxisOrdinate = 0.0, scale = 1.0 } = params;

    // 1. Find highest entity ID
    let maxId = 0;
    const idRe = /^#(\d+)\s*=/gm;
    let m;
    while ((m = idRe.exec(ifcText)) !== null) {
      const id = parseInt(m[1]);
      if (id > maxId) maxId = id;
    }
    const nextId = maxId + 1;

    // 2. Find IFCGEOMETRICREPRESENTATIONCONTEXT ID (the 3D context, not sub-contexts)
    const ctxRe = /^#(\d+)\s*=\s*IFCGEOMETRICREPRESENTATIONCONTEXT\s*\(/gim;
    let geoRepContextId = null;
    while ((m = ctxRe.exec(ifcText)) !== null) {
      geoRepContextId = m[1];
      // Prefer the first one (usually the main 3D context)
      break;
    }
    if (!geoRepContextId) {
      console.error('patchIfcWithMapConversion: IFCGEOMETRICREPRESENTATIONCONTEXT not found');
      return ifcText;
    }

    // 3. Build new entities
    const crsEntity = `#${nextId}=IFCPROJECTEDCRS('${epsgName}','EPSG:${epsgCode}',$,$,$,$,$);`;
    const mcEntity = `#${nextId + 1}=IFCMAPCONVERSION(#${geoRepContextId},#${nextId},${eastings},${northings},${height},${xAxisAbscissa},${xAxisOrdinate},${scale});`;

    // Insert before ENDSEC;
    const endsecIdx = ifcText.lastIndexOf('ENDSEC;');
    if (endsecIdx === -1) {
      console.error('patchIfcWithMapConversion: ENDSEC not found');
      return ifcText;
    }

    let patched = ifcText.substring(0, endsecIdx)
      + crsEntity + '\n'
      + mcEntity + '\n'
      + ifcText.substring(endsecIdx);

    // 4. Patch IfcSite RefLatitude/RefLongitude to correct WGS84 DMS
    // Convert eastings/northings to WGS84 first
    const fullEpsg = `EPSG:${epsgCode}`;
    let lon, lat;
    if (fullEpsg === 'EPSG:4326') {
      lon = eastings;
      lat = northings;
    } else {
      if (!proj4.defs(fullEpsg) && CRS_DEFS[fullEpsg]) {
        proj4.defs(fullEpsg, CRS_DEFS[fullEpsg]);
      }
      [lon, lat] = proj4(fullEpsg, 'EPSG:4326', [eastings, northings]);
    }

    // Decimal degrees → DMS compound (deg, min, sec, millionthsec)
    function decToDmsCompound(dec) {
      const sign = dec < 0 ? -1 : 1;
      dec = Math.abs(dec);
      const deg = Math.floor(dec);
      const minFloat = (dec - deg) * 60;
      const min = Math.floor(minFloat);
      const secFloat = (minFloat - min) * 60;
      const sec = Math.floor(secFloat);
      const msec = Math.round((secFloat - sec) * 1000000);
      return `(${sign * deg},${min},${sec},${msec})`;
    }

    const latDms = decToDmsCompound(lat);
    const lonDms = decToDmsCompound(lon);

    // Replace IfcSite lat/lon: match the two DMS compound tuples
    const siteRe = /IFCSITE\s*\(([^)]*\([^)]*\))\s*,\s*(\([^)]*\))\s*,\s*(\([^)]*\))/i;
    patched = patched.replace(siteRe, (match, prefix, oldLat, oldLon) => {
      return match.replace(oldLat, latDms).replace(oldLon, lonDms);
    });

    console.log(`IFC patched: #${nextId} IFCPROJECTEDCRS(${epsgName}), #${nextId + 1} IFCMAPCONVERSION, Site DMS updated`);
    return patched;
  } catch (e) {
    console.error('patchIfcWithMapConversion failed:', e);
    return ifcText;
  }
}

// =====================================
// ION UPLOAD (with georef patching)
// =====================================

export async function uploadToIon(appState) {
  const token = geoState.ionToken || document.getElementById('geoIonToken')?.value?.trim();
  if (!token) { alert('Please enter a Cesium Ion Access Token'); return; }
  if (!appState.lastFileBuffer) { alert('No IFC file loaded'); return; }

  const statusEl = document.getElementById('geoStatus');
  const uploadBtn = document.getElementById('geoUploadBtn');

  // Check georef state: detected from IFC, manual override, or nothing
  const override = window.crsOverride;
  const hasDetectedGeoref = geoState.detected && geoState.lon != null;
  const hasOverride = override && override.lat != null && override.lon != null;

  if (!hasDetectedGeoref && !hasOverride) {
    // No georef at all — show warning dialog
    const proceed = confirm(
      'Keine Georeferenzierung vorhanden.\n\n' +
      'Das Modell hat keine IfcMapConversion und es wurde kein Override gesetzt.\n' +
      'Cesium Ion kann das Modell möglicherweise nicht korrekt positionieren.\n\n' +
      '→ CRS-Panel öffnen und Koordinaten eingeben, oder\n' +
      '→ "OK" für Upload ohne Georeferenzierung'
    );
    if (!proceed) return;
    // Allow upload without position — Ion will place at 0,0
    if (geoState.lon == null) { geoState.lon = 0; geoState.lat = 0; }
  }

  if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.textContent = 'Uploading...'; }
  if (statusEl) { statusEl.textContent = 'Preparing IFC...'; statusEl.style.color = ''; }

  try {
    // Clean IFC: remove hidden/deleted/filtered elements
    let uploadBuffer = appState.lastFileBuffer;
    if (appState.getExcludedIds) {
      const excludedIds = await appState.getExcludedIds();
      if (excludedIds.size > 0) {
        if (statusEl) statusEl.textContent = `Cleaning IFC (${excludedIds.size} elements)...`;
        uploadBuffer = await cleanIfcBuffer(appState.lastFileBuffer, excludedIds);
        console.log(`Upload buffer: ${(uploadBuffer.length / 1024 / 1024).toFixed(1)} MB (was ${(appState.lastFileBuffer.length / 1024 / 1024).toFixed(1)} MB)`);
      }
    }

    // Patch IFC with MapConversion if override is set and file isn't already georeferenced
    if (hasOverride) {
      const ifcText = new TextDecoder('utf-8', { fatal: false }).decode(uploadBuffer);
      const hasExistingMC = /IFCMAPCONVERSION/i.test(ifcText);

      if (!hasExistingMC) {
        // Derive EPSG code/name from override
        const epsgCode = (override.epsg || 'EPSG:4326').replace('EPSG:', '');
        const epsgNames = {
          '25832': 'ETRS89 / UTM zone 32N', '25833': 'ETRS89 / UTM zone 33N',
          '31467': 'DHDN / 3-degree Gauss-Kruger zone 3', '4326': 'WGS 84'
        };
        const epsgName = epsgNames[epsgCode] || `EPSG:${epsgCode}`;

        if (statusEl) statusEl.textContent = `Patching IFC (EPSG:${epsgCode})...`;

        const patched = patchIfcWithMapConversion(ifcText, {
          eastings: override.eastings, northings: override.northings,
          height: override.height || 0, epsgCode, epsgName,
          xAxisAbscissa: override.xAxisAbscissa ?? 1.0,
          xAxisOrdinate: override.xAxisOrdinate ?? 0.0,
        });

        uploadBuffer = new TextEncoder().encode(patched);
        console.log(`IFC patched with IfcMapConversion (EPSG:${epsgCode})`);
        if (statusEl) { statusEl.textContent = `✅ IfcMapConversion eingefügt (EPSG:${epsgCode})`; statusEl.style.color = '#2ECFB0'; }
        // Brief pause to show the message
        await new Promise(r => setTimeout(r, 800));
      } else {
        if (statusEl) { statusEl.textContent = '✅ Kein Patch nötig — bereits georeferenziert'; statusEl.style.color = '#2ECFB0'; }
        await new Promise(r => setTimeout(r, 800));
      }

      // Use override position for Ion
      geoState.lon = override.lon;
      geoState.lat = override.lat;
    } else if (hasDetectedGeoref) {
      if (statusEl) { statusEl.textContent = '✅ Kein Patch nötig — georeferenziert aus IFC'; statusEl.style.color = '#2ECFB0'; }
      await new Promise(r => setTimeout(r, 800));
    }

    if (statusEl) statusEl.textContent = 'Creating asset...';

    const createResp = await fetch('https://api.cesium.com/v1/assets', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: appState.lastFileName || 'IFC Model',
        description: `Uploaded from geobim.lab TOC — ${new Date().toISOString().split('T')[0]}`,
        type: '3DTILES',
        options: { sourceType: 'BIM_CAD', position: [geoState.lon, geoState.lat, effectiveHeight()] },
      }),
    });

    if (!createResp.ok) {
      const err = await createResp.json().catch(() => ({}));
      throw new Error(err.message || `API error ${createResp.status}`);
    }

    const { assetMetadata, uploadLocation } = await createResp.json();
    const assetId = assetMetadata.id;
    if (statusEl) statusEl.textContent = `Asset #${assetId} — uploading file...`;

    const { endpoint, bucket, prefix, accessKey, secretAccessKey, sessionToken } = uploadLocation;
    const fileName = appState.lastFileName || 'model.ifc';

    const s3 = new S3Client({
      region: 'us-east-1',
      endpoint,
      credentials: { accessKeyId: accessKey, secretAccessKey, sessionToken },
      forcePathStyle: true,
    });

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}${fileName}`,
      Body: uploadBuffer,
      ContentType: 'application/octet-stream',
    }));

    if (statusEl) statusEl.textContent = `Asset #${assetId} — finalizing...`;

    const completeResp = await fetch(`https://api.cesium.com/v1/assets/${assetId}/uploadComplete`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!completeResp.ok) throw new Error('Failed to complete upload');

    if (statusEl) { statusEl.textContent = `Asset #${assetId} — tiling...`; statusEl.style.color = '#2ECFB0'; }
    pollAssetStatus(assetId, token, statusEl);
  } catch (err) {
    console.error('Ion upload failed:', err);
    if (statusEl) { statusEl.textContent = `Upload failed: ${err.message}`; statusEl.style.color = '#ff6666'; }
  } finally {
    if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.textContent = 'Upload to Ion'; }
  }
}

async function pollAssetStatus(assetId, token, statusEl) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const resp = await fetch(`https://api.cesium.com/v1/assets/${assetId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!resp.ok) continue;
      const data = await resp.json();

      if (data.status === 'COMPLETE') {
        const ionUrl = `https://ion.cesium.com/assets/${assetId}`;
        if (statusEl) { statusEl.innerHTML = `✅ Asset #${assetId} ready! <a href="${ionUrl}" target="_blank" rel="noopener" style="color:#2ECFB0;text-decoration:underline;">Open in Cesium Ion</a>`; statusEl.style.color = '#2ECFB0'; }
        const linkEl = document.getElementById('geoAssetLink');
        if (linkEl) {
          linkEl.href = ionUrl;
          linkEl.textContent = `Open Asset #${assetId} in Cesium Ion`;
          linkEl.style.display = 'inline-block';
        }
        const geobimLinkEl = document.getElementById('geoOpenInGeobimLink');
        if (geobimLinkEl) {
          geobimLinkEl.href = `https://geobim.app/?asset=${assetId}`;
          geobimLinkEl.textContent = `Open Asset #${assetId} in geobim.app`;
          geobimLinkEl.style.display = 'inline-block';
        }
        console.log(`Ion asset ready: ${ionUrl}`);
        return;
      } else if (data.status === 'ERROR') {
        if (statusEl) { statusEl.textContent = `Tiling failed for #${assetId}`; statusEl.style.color = '#ff6666'; }
        return;
      } else {
        if (statusEl) statusEl.textContent = `Tiling #${assetId}... ${data.percentComplete || 0}%`;
      }
    } catch (_) {}
  }
}

// =====================================
// WMTS LAYER SWITCHING
// =====================================

const WMTS_LAYERS = {
  by_dop: { layer: 'by_dop', format: 'image/jpeg' },
  by_amtl_karte: { layer: 'by_amtl_karte', format: 'image/png' },
  by_webkarte: { layer: 'by_webkarte', format: 'image/png' },
  by_webkarte_grau: { layer: 'by_webkarte_grau', format: 'image/png' },
};

const ALKIS_LAYERS = {
  alkis_farbe: 'by_alkis_parzellarkarte_farbe',
  alkis_grau: 'by_alkis_parzellarkarte_grau',
  alkis_umring: 'by_alkis_parzellarkarte_umr_gelb',
};

function setWmtsLayer(layerId) {
  if (!cesiumViewer) return;
  const layers = cesiumViewer.imageryLayers;

  // Remove previous overlay layer
  if (wmtsLayer) {
    layers.remove(wmtsLayer, true);
    wmtsLayer = null;
  }

  if (layerId === 'default') {
    if (defaultImageryLayer) defaultImageryLayer.show = true;
    return;
  }

  // Hide default imagery
  if (defaultImageryLayer) defaultImageryLayer.show = false;

  // ALKIS WMS layers
  const alkisLayer = ALKIS_LAYERS[layerId];
  if (alkisLayer) {
    const provider = new Cesium.WebMapServiceImageryProvider({
      url: 'https://geoservices.bayern.de/od/wms/alkis/v1/parzellarkarte',
      layers: alkisLayer,
      parameters: { transparent: true, format: 'image/png' },
    });
    wmtsLayer = layers.addImageryProvider(provider);
    return;
  }

  // Bayern WMTS layers
  const cfg = WMTS_LAYERS[layerId];
  if (!cfg) return;

  const provider = new Cesium.WebMapTileServiceImageryProvider({
    url: `https://wmtsod1.bayernwolke.de/wmts/${cfg.layer}/smerc/{TileMatrix}/{TileCol}/{TileRow}`,
    layer: cfg.layer,
    style: 'default',
    format: cfg.format,
    tileMatrixSetID: 'smerc',
    maximumLevel: 19,
  });

  wmtsLayer = layers.addImageryProvider(provider);
}

// =====================================
// SETUP UI BINDINGS
// =====================================

export function setupGeoUI(appState) {
  const searchInput = document.getElementById('geoSearch');
  const searchBtn = document.getElementById('geoSearchBtn');
  if (searchBtn && searchInput) {
    const doSearch = () => {
      searchAddress(searchInput.value);
      if (cesiumViewer) setTimeout(() => updateFootprint(appState), 2000);
    };
    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  }

  ['geoLon', 'geoLat', 'geoHeight', 'geoRotation'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => applyManualCoords(appState));
  });

  const rotSlider = document.getElementById('geoRotSlider');
  const rotInput = document.getElementById('geoRotation');
  if (rotSlider && rotInput) {
    rotSlider.addEventListener('input', () => {
      rotInput.value = rotSlider.value;
      geoState.rotation = parseFloat(rotSlider.value);
      repositionEntities();
    });
    rotSlider.addEventListener('change', () => { if (cesiumViewer) updateFootprint(appState); });
  }

  const heightSlider = document.getElementById('geoHeightSlider');
  const heightInput = document.getElementById('geoHeight');
  if (heightSlider && heightInput) {
    heightSlider.addEventListener('input', () => {
      heightInput.value = heightSlider.value;
      geoState.height = parseFloat(heightSlider.value) - (geoState.terrainHeight || 0);
      repositionEntities();
    });
    heightSlider.addEventListener('change', () => { if (cesiumViewer) updateFootprint(appState); });
  }

  document.getElementById('geoZoomBtn')?.addEventListener('click', () => {
    if (cesiumViewer && modelEntity) {
      cesiumViewer.zoomTo(modelEntity, new window.Cesium.HeadingPitchRange(0, window.Cesium.Math.toRadians(-45), 0));
    } else if (cesiumViewer && geoState.lon != null) {
      flyToPosition();
    }
  });

  const tokenInput = document.getElementById('geoIonToken');
  if (tokenInput) {
    const saved = localStorage.getItem('geobim_ion_token');
    if (saved) { tokenInput.value = saved; geoState.ionToken = saved; }
    tokenInput.addEventListener('change', () => {
      geoState.ionToken = tokenInput.value.trim();
      localStorage.setItem('geobim_ion_token', geoState.ionToken);
    });
  }

  document.getElementById('geoUploadBtn')?.addEventListener('click', () => uploadToIon(appState));

  document.getElementById('geoTokenToggle')?.addEventListener('click', () => {
    const pop = document.getElementById('geoTokenPopover');
    if (pop) pop.style.display = pop.style.display === 'none' ? '' : 'none';
  });

  // WMTS layer selector
  const layerSelect = document.getElementById('geoLayerSelect');
  if (layerSelect) {
    // Restore saved preference
    const savedLayer = localStorage.getItem('geobim_map_layer');
    if (savedLayer) layerSelect.value = savedLayer;
    layerSelect.addEventListener('change', () => {
      setWmtsLayer(layerSelect.value);
      localStorage.setItem('geobim_map_layer', layerSelect.value);
    });
  }
}

export function invalidateGlbCache() {
  if (cachedGlbUrl) { URL.revokeObjectURL(cachedGlbUrl); cachedGlbUrl = null; }
  if (modelEntity && cesiumViewer) {
    cesiumViewer.entities.remove(modelEntity);
    modelEntity = null;
  }
}

// Pre-generate GLB in background after IFC load so Cesium preview is instant
export function preGenerateGlb(appState) {
  // Delay to let ThatOpen finish processing (render, hider, etc.)
  setTimeout(async () => {
    if (cachedGlbUrl) return; // already cached
    try {
      const url = await exportSceneToGlb(appState);
      if (url) console.log('GLB pre-generated for Cesium preview');
    } catch (err) {
      console.warn('GLB pre-generation failed:', err.message);
    }
  }, 2000);
}

// =====================================
// CRS OVERRIDE — Apply manual georef
// =====================================

/**
 * Apply a manual georeferencing override.
 * Converts projected coordinates to WGS84, updates geoState,
 * flies camera to position, and places model anchor.
 *
 * @param {{ epsg: string, eastings: number, northings: number, height: number }} params
 * @returns {{ lat: number, lon: number } | null}
 */
export function applyGeorefOverride(params) {
  const { epsg, eastings, northings, height } = params;
  if (eastings == null || northings == null) return null;

  let lon, lat;
  if (epsg === 'EPSG:4326') {
    lon = eastings;
    lat = northings;
  } else {
    // Ensure proj4 def exists
    if (!proj4.defs(epsg) && CRS_DEFS[epsg]) {
      proj4.defs(epsg, CRS_DEFS[epsg]);
    }
    try {
      [lon, lat] = proj4(epsg, 'EPSG:4326', [eastings, northings]);
    } catch (e) {
      console.error('applyGeorefOverride: proj4 conversion failed', e);
      return null;
    }
  }

  // Update geoState
  geoState.lon = lon;
  geoState.lat = lat;
  geoState.height = height || 0;
  geoState.detected = true;
  geoState.crsName = epsg;

  // Fly Cesium camera if viewer exists
  if (cesiumViewer) {
    const Cesium = window.Cesium;
    cesiumViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, (height || 0) + 200),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
      duration: 1.5,
    });

    // Sample terrain height
    sampleTerrainAt(lon, lat);

    // Update pin
    updatePin();
  }

  // Update geo panel UI if present
  const statusEl = document.getElementById('geoStatus');
  if (statusEl) {
    statusEl.textContent = `Override: ${lat.toFixed(6)}°N, ${lon.toFixed(6)}°E`;
    statusEl.style.color = '#2ECFB0';
  }

  console.log(`CRS Override applied: ${epsg} → ${lat.toFixed(6)}°N, ${lon.toFixed(6)}°E, h=${height || 0}`);
  return { lat, lon };
}

// =====================================
// PICKUP MODE — Click on Cesium map
// =====================================

let pickupHandler = null;
let pickupOverlay = null;

/**
 * Single-click pickup mode on Cesium minimap — position only.
 * X-axis rotation is handled by Pick Origin in the 3D viewport.
 *
 * @param {string} targetEpsg - Target EPSG code (e.g. 'EPSG:25832')
 * @param {function} callback - Called with { lon, lat, eastings, northings, epsg }
 */
export function activatePickupMode(targetEpsg, callback) {
  const Cesium = window.Cesium;
  if (!cesiumViewer || !Cesium) {
    console.warn('Pickup mode: Cesium viewer not available — open Geo panel first');
    return;
  }

  deactivatePickupMode();

  // Overlay hint
  pickupOverlay = document.createElement('div');
  pickupOverlay.id = 'crsPickupOverlay';
  pickupOverlay.style.cssText =
    'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;' +
    'display:flex;align-items:flex-start;justify-content:center;padding-top:8px;' +
    'pointer-events:none;';
  pickupOverlay.innerHTML =
    '<div style="background:rgba(14,17,23,0.85);border:1px solid rgba(46,207,176,0.4);' +
    'border-radius:6px;padding:6px 14px;font-size:11px;color:#2ECFB0;pointer-events:none;">' +
    '📍 Klicke auf die Karte um Position zu übernehmen</div>';

  const cesiumContainer = cesiumViewer.container;
  cesiumContainer.style.cursor = 'crosshair';
  cesiumContainer.appendChild(pickupOverlay);

  pickupHandler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.scene.canvas);
  pickupHandler.setInputAction((click) => {
    const cartesian = cesiumViewer.scene.pickPosition(click.position)
      || cesiumViewer.camera.pickEllipsoid(click.position, cesiumViewer.scene.globe.ellipsoid);
    if (!cartesian) { deactivatePickupMode(); return; }

    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);

    let eastings = lon, northings = lat;
    if (targetEpsg && targetEpsg !== 'EPSG:4326') {
      if (!proj4.defs(targetEpsg) && CRS_DEFS[targetEpsg]) {
        proj4.defs(targetEpsg, CRS_DEFS[targetEpsg]);
      }
      try {
        [eastings, northings] = proj4('EPSG:4326', targetEpsg, [lon, lat]);
      } catch (e) {
        console.warn('Pickup: proj4 conversion failed, using WGS84', e);
      }
    }

    deactivatePickupMode();

    if (typeof callback === 'function') {
      callback({ lon, lat, eastings, northings, epsg: targetEpsg });
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const escHandler = (e) => {
    if (e.key === 'Escape') {
      deactivatePickupMode();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

function deactivatePickupMode() {
  if (pickupHandler) {
    pickupHandler.destroy();
    pickupHandler = null;
  }
  if (pickupOverlay) {
    pickupOverlay.remove();
    pickupOverlay = null;
  }
  if (cesiumViewer) {
    cesiumViewer.container.style.cursor = '';
  }
}

function updatePin() {
  if (!cesiumViewer || geoState.lon == null) return;
  const Cesium = window.Cesium;
  const pos = Cesium.Cartesian3.fromDegrees(geoState.lon, geoState.lat, effectiveHeight());
  if (pinEntity) {
    pinEntity.position = pos;
  } else {
    pinEntity = cesiumViewer.entities.add({
      position: pos,
      point: { pixelSize: 10, color: Cesium.Color.fromCssColorString('#2ECFB0'), outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
    });
  }
}

export { geoState };
