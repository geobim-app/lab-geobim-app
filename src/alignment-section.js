// =====================================
// ALIGNMENT SECTION — cut along an IfcAlignment axis + live 2D cross section
// =====================================
// The axis comes from web-ifc (GetAllAlignments: IFC world coordinates,
// Y-up, metres), mapped into the model's local frame with the fragments
// coordination matrix — checked on Viadotto Acerno: bbox matches the model to
// the centimetre. Axis line and markers are children of model.object, so they
// follow every move (Pick/Center Origin, georef). The cut applies only to the
// model the axis belongs to (per-material clipping planes); the X/Y/Z planes
// stay global on the renderer.
import * as THREE from 'three';
import * as WEBIFC from 'web-ifc';
import './alignment-section.css';

const STEP_BUTTONS = [-10, -1, 1, 10];
const CAMERA_BACKOFF_M = 60;
const CAMERA_RISE_M = 8;
const AXIS_COLOR = 0x2ecfb0;

let appState = null;
let api = null;
const axisCache = new Map(); // fileId → Promise<axes[]>

const sec = {
  active: null,      // { file, axes, axisIndex, distance, flipped, plane, group, marker, clonedFrom }
  tick: 0,
  profileOpen: false,
  view: null,
  fitKey: null,
  meshCache: new Map(), // mesh.uuid → { key, world: Float32Array, index, groups, colors }
};

export function initAlignmentSection(state) {
  appState = state;
  const clipBtn = document.getElementById('toggleClipper');
  if (!clipBtn || document.getElementById('toggleAxis')) return;
  const btn = document.createElement('button');
  btn.id = 'toggleAxis';
  btn.className = 'topbar-btn';
  btn.title = 'Section along an IfcAlignment axis';
  btn.textContent = 'Axis';
  btn.addEventListener('click', togglePanel);
  clipBtn.insertAdjacentElement('afterend', btn);
}

// Called by main.js after the X/Y/Z planes were (re)applied to every material:
// that pass overwrites material.clippingPlanes, so restore the axis plane.
export function reapplyAxisClip() {
  if (sec.active) applyMaterials();
}

// =====================================
// AXIS DATA (web-ifc)
// =====================================

async function webIfc() {
  if (!api) {
    api = new WEBIFC.IfcAPI();
    api.SetWasmPath('/wasm/', true);
    await api.Init();
  }
  return api;
}

function lengthUnitScale(buffer) {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, Math.min(buffer.length, 4e6)));
  const m = head.match(/IFCSIUNIT\(\*,\.LENGTHUNIT\.,(\$|\.[A-Z]+\.),\.METRE\.\)/i);
  if (m) return { '.MILLI.': 0.001, '.CENTI.': 0.01, '.DECI.': 0.1, '.KILO.': 1000 }[m[1].toUpperCase()] || 1;
  if (/IFCCONVERSIONBASEDUNIT\([^;]*\.LENGTHUNIT\.,'FOOT'/i.test(head)) return 0.3048;
  if (/IFCCONVERSIONBASEDUNIT\([^;]*\.LENGTHUNIT\.,'INCH'/i.test(head)) return 0.0254;
  return 1;
}

function refValue(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}

// IfcReferents nested in each alignment → [{ distance (m), name, type }]
function readReferents(ifc, modelID, unit) {
  const byAlignment = new Map();
  const rels = ifc.GetLineIDsWithType(modelID, WEBIFC.IFCRELNESTS);
  for (let i = 0; i < rels.size(); i++) {
    let rel;
    try { rel = ifc.GetLine(modelID, rels.get(i)); } catch (_) { continue; }
    const owner = refValue(rel.RelatingObject);
    for (const r of rel.RelatedObjects || []) {
      const rid = refValue(r);
      let ref;
      try { ref = ifc.GetLine(modelID, rid); } catch (_) { continue; }
      if (!ref || ref.type !== WEBIFC.IFCREFERENT) continue;
      try {
        const pl = ifc.GetLine(modelID, refValue(ref.ObjectPlacement));
        if (!pl || pl.type !== WEBIFC.IFCLINEARPLACEMENT) continue;
        const rp = ifc.GetLine(modelID, refValue(pl.RelativePlacement));
        const loc = ifc.GetLine(modelID, refValue(rp.Location));
        const d = Number(refValue(loc.DistanceAlong));
        if (!isFinite(d)) continue;
        if (!byAlignment.has(owner)) byAlignment.set(owner, []);
        byAlignment.get(owner).push({
          distance: d * unit,
          name: refValue(ref.Name) || '',
          type: refValue(ref.PredefinedType) || '',
        });
      } catch (_) { /* referent without a linear placement */ }
    }
  }
  byAlignment.forEach((list) => list.sort((a, b) => a.distance - b.distance));
  return byAlignment;
}

async function loadAxes(file) {
  if (axisCache.has(file.id)) return axisCache.get(file.id);
  const p = (async () => {
    const ifc = await webIfc();
    const modelID = ifc.OpenModel(file.buffer, { COORDINATE_TO_ORIGIN: false });
    try {
      const raw = ifc.GetAllAlignments(modelID) || [];
      if (!raw.length) return [];
      const ids = ifc.GetLineIDsWithType(modelID, WEBIFC.IFCALIGNMENT);
      const unit = lengthUnitScale(file.buffer);
      const referents = readReferents(ifc, modelID, unit);
      const cm = await file.model.getCoordinationMatrix();
      const axes = [];
      raw.forEach((a, i) => {
        const src = a.curve3D && a.curve3D[0] && a.curve3D[0].points;
        if (!src || src.length < 2) return;
        // local (fragments) = coordination matrix × web-ifc point (both Y-up)
        const pts = [];
        for (const q of src) {
          const v = new THREE.Vector3(q.x, q.y, q.z).applyMatrix4(cm);
          if (!pts.length || v.distanceToSquared(pts[pts.length - 1]) > 1e-8) pts.push(v);
        }
        if (pts.length < 2) return;
        // distance along the horizontal alignment = plan length (x, z in Y-up)
        const dist = [0];
        for (let k = 1; k < pts.length; k++) {
          dist.push(dist[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
        }
        const eid = i < ids.size() ? ids.get(i) : null;
        let name = '', guid = '';
        if (eid !== null) {
          try {
            const line = ifc.GetLine(modelID, eid);
            name = refValue(line.Name) || '';
            guid = refValue(line.GlobalId) || '';
          } catch (_) { /* nameless */ }
        }
        axes.push({
          name: name || guid || `Alignment ${i + 1}`,
          pts, dist, length: dist[dist.length - 1],
          markers: (eid !== null && referents.get(eid)) || [],
        });
      });
      return axes;
    } finally {
      ifc.CloseModel(modelID);
    }
  })();
  axisCache.set(file.id, p);
  p.catch(() => axisCache.delete(file.id));
  return p;
}

// Point and unit 3D tangent at a plan distance, model-local frame.
function sampleAxis(axis, s) {
  const d = axis.dist, n = d.length;
  s = Math.min(Math.max(s, 0), d[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d[mid] <= s) lo = mid; else hi = mid;
  }
  const span = d[hi] - d[lo];
  const t = span > 1e-9 ? (s - d[lo]) / span : 0;
  const point = axis.pts[lo].clone().lerp(axis.pts[hi], t);
  const tangent = axis.pts[hi].clone().sub(axis.pts[lo]);
  if (tangent.lengthSq() < 1e-12) tangent.set(1, 0, 0);
  return { point, tangent: tangent.normalize() };
}

function formatStation(s) {
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(s);
  let km = Math.floor(a / 1000);
  let m = a - km * 1000;
  if (m >= 999.995) { km += 1; m = 0; }
  return sign + km + '+' + m.toFixed(2).padStart(6, '0');
}

// =====================================
// PANEL
// =====================================

function viewportEl() {
  return document.getElementById('viewport') || document.body;
}

function togglePanel() {
  let panel = document.getElementById('axisPanel');
  if (panel && !panel.classList.contains('hidden')) {
    deactivate();
    panel.classList.add('hidden');
    document.getElementById('toggleAxis')?.classList.remove('active');
    return;
  }
  if (!panel) panel = createPanel();
  panel.classList.remove('hidden');
  document.getElementById('toggleAxis')?.classList.add('active');
  refreshPanel();
}

function createPanel() {
  const panel = document.createElement('div');
  panel.id = 'axisPanel';
  panel.className = 'axis-panel hidden';
  panel.innerHTML = `
    <div class="axis-panel-head">
      <span class="axis-panel-title">Alignment Section</span>
      <button class="panel-close" id="axisClose" title="Close">&#10005;</button>
    </div>
    <div id="axisBody" class="axis-body"></div>`;
  viewportEl().appendChild(panel);
  panel.querySelector('#axisClose').addEventListener('click', togglePanel);
  return panel;
}

async function refreshPanel() {
  const body = document.getElementById('axisBody');
  if (!body) return;
  const files = appState.files.filter((f) => f.model && f.buffer);
  if (!files.length) {
    body.innerHTML = '<div class="axis-hint">Load an IFC with an IfcAlignment first.</div>';
    return;
  }
  body.innerHTML = '<div class="axis-hint">Reading alignments…</div>';
  const withAxes = [];
  for (const f of files) {
    try {
      const axes = await loadAxes(f);
      if (axes.length) withAxes.push({ file: f, axes });
    } catch (err) {
      console.warn('Alignment read failed for', f.name, err);
    }
  }
  if (!withAxes.length) {
    body.innerHTML = '<div class="axis-hint">No IfcAlignment found in the loaded models.</div>';
    return;
  }
  if (!sec.active || !withAxes.some((w) => w.file === sec.active.file)) {
    activate(withAxes[0].file, withAxes[0].axes, 0);
  }
  renderControls(withAxes);
}

function renderControls(withAxes) {
  const body = document.getElementById('axisBody');
  const a = sec.active;
  if (!body || !a) return;
  const axis = a.axes[a.axisIndex];
  const options = [];
  withAxes.forEach((w) => w.axes.forEach((ax, i) => {
    const sel = w.file === a.file && i === a.axisIndex ? ' selected' : '';
    const label = (withAxes.length > 1 ? w.file.name + ' · ' : '') + ax.name;
    options.push(`<option value="${w.file.id}:${i}"${sel}>${escapeHtml(label)}</option>`);
  }));
  body.innerHTML = `
    <select id="axisSelect" class="axis-select" title="Alignment">${options.join('')}</select>
    <input type="range" id="axisSlider" class="axis-slider" min="0" max="${axis.length}" step="0.1" value="${a.distance}" title="Station">
    <div class="axis-row">
      <label for="axisStation" class="axis-label">Station</label>
      <input type="text" id="axisStation" class="axis-station" inputmode="decimal" value="${formatStation(a.distance)}" title="Station (km+m), Enter to apply">
    </div>
    <div class="axis-row axis-buttons">
      ${STEP_BUTTONS.map((d) => `<button class="axis-btn" data-step="${d}" title="Move ${d > 0 ? '+' : ''}${d} m">${d > 0 ? '+' : ''}${d}</button>`).join('')}
      <button class="axis-btn${a.flipped ? ' active' : ''}" id="axisFlip" title="Flip cut direction">&#8644;</button>
      <button class="axis-btn" id="axisCamera" title="Look along the axis at the cut">View</button>
      <button class="axis-btn${sec.profileOpen ? ' active' : ''}" id="axisProfileBtn" title="2D cross section">2D</button>
    </div>`;
  body.querySelector('#axisSelect').addEventListener('change', (e) => {
    const [fid, idx] = e.target.value.split(':').map(Number);
    const w = withAxes.find((x) => x.file.id === fid);
    if (!w) return;
    activate(w.file, w.axes, idx);
    renderControls(withAxes);
  });
  body.querySelector('#axisSlider').addEventListener('input', (e) => setDistance(parseFloat(e.target.value)));
  const st = body.querySelector('#axisStation');
  st.addEventListener('keydown', (e) => { if (e.key === 'Enter') st.blur(); });
  st.addEventListener('change', () => enterStation(st.value));
  body.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    setDistance(sec.active.distance + Number(b.dataset.step));
  }));
  body.querySelector('#axisFlip').addEventListener('click', (e) => {
    sec.active.flipped = !sec.active.flipped;
    e.currentTarget.classList.toggle('active', sec.active.flipped);
    updatePlane();
  });
  body.querySelector('#axisCamera').addEventListener('click', alignCamera);
  body.querySelector('#axisProfileBtn').addEventListener('click', (e) => {
    toggleProfile(!sec.profileOpen);
    e.currentTarget.classList.toggle('active', sec.profileOpen);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =====================================
// ACTIVATE / PLANE / OVERLAY
// =====================================

function activate(file, axes, axisIndex) {
  const keep = sec.active && sec.active.file === file ? sec.active : null;
  if (!keep) deactivate();
  const axis = axes[axisIndex];
  const a = keep || { file, flipped: false, plane: new THREE.Plane(), group: null, clonedFrom: new Map() };
  a.axes = axes;
  a.axisIndex = axisIndex;
  a.distance = keep ? Math.min(keep.distance, axis.length) : axis.length / 2;
  sec.active = a;
  buildOverlay();
  updatePlane();
  applyMaterials();
  if (!sec.tick) sec.tick = requestAnimationFrame(loop);
  if (sec.profileOpen) scheduleProfile();
}

function deactivate() {
  const a = sec.active;
  if (!a) return;
  sec.active = null;
  if (a.group) a.group.parent?.remove(a.group);
  // restore the shared materials we cloned, drop our plane from the rest
  a.file.model?.object?.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const restored = mats.map((m) => a.clonedFrom.get(m) || m);
    obj.material = Array.isArray(obj.material) ? restored : restored[0];
    restored.forEach((m) => {
      if (m.clippingPlanes && m.clippingPlanes.includes(a.plane)) {
        m.clippingPlanes = m.clippingPlanes.filter((p) => p !== a.plane);
        if (!m.clippingPlanes.length) m.clippingPlanes = null;
        m.needsUpdate = true;
      }
    });
  });
  a.clonedFrom.forEach((orig, clone) => clone.dispose());
  toggleProfile(false);
  appState.fragments?.core?.update(true);
}

function buildOverlay() {
  const a = sec.active;
  if (a.group) a.group.parent?.remove(a.group);
  const axis = a.axes[a.axisIndex];
  const group = new THREE.Group();
  group.name = 'alignmentAxisOverlay';
  const lineGeo = new THREE.BufferGeometry().setFromPoints(axis.pts);
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: AXIS_COLOR, depthTest: false, transparent: true, opacity: 0.9 }));
  line.renderOrder = 999;
  group.add(line);
  if (axis.markers.length) {
    const mk = axis.markers.map((m) => sampleAxis(axis, m.distance).point);
    const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints(mk),
      new THREE.PointsMaterial({ color: 0xffffff, size: 5, sizeAttenuation: false, depthTest: false }));
    pts.renderOrder = 999;
    group.add(pts);
  }
  // Points, not a Mesh: the GLB export (georef.js collectMeshes) takes every
  // scene mesh, and the station marker must not end up on Cesium Ion.
  const marker = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]),
    new THREE.PointsMaterial({ color: AXIS_COLOR, size: 12, sizeAttenuation: false, depthTest: false }));
  marker.renderOrder = 1000;
  marker.name = 'alignmentStationMarker';
  group.add(marker);
  a.marker = marker;
  a.group = group;
  a.file.model.object.add(group);
}

// World-space plane through the station point, normal along the tangent;
// three.js clips the negative side, so the part ahead of the station stays.
function updatePlane() {
  const a = sec.active;
  if (!a) return;
  const obj = a.file.model.object;
  obj.updateMatrixWorld(true);
  const { point, tangent } = sampleAxis(a.axes[a.axisIndex], a.distance);
  a.marker.position.copy(point);
  const pw = point.clone().applyMatrix4(obj.matrixWorld);
  const nw = tangent.clone().transformDirection(obj.matrixWorld);
  if (a.flipped) nw.negate();
  a.plane.setFromNormalAndCoplanarPoint(nw, pw);
}

// Only this model's materials get the plane. Materials it shares with other
// models are cloned first so the cut can't leak into them.
function applyMaterials() {
  const a = sec.active;
  if (!a) return;
  const own = new Set();
  a.file.model.object.traverse((o) => { if (o.isMesh) own.add(o); });
  const shared = new Set();
  appState.world.scene.three.traverse((o) => {
    if (!o.isMesh || own.has(o)) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => shared.add(m));
  });
  own.forEach((obj) => {
    if (obj.parent === a.group) return;
    const isArr = Array.isArray(obj.material);
    const mats = isArr ? obj.material : [obj.material];
    const next = mats.map((m) => {
      if (!m || !shared.has(m)) return m;
      const c = m.clone();
      a.clonedFrom.set(c, m);
      return c;
    });
    if (next.some((m, i) => m !== mats[i])) obj.material = isArr ? next : next[0];
    next.forEach((m) => {
      if (!m) return;
      const list = m.clippingPlanes || [];
      if (!list.includes(a.plane)) {
        m.clippingPlanes = [...list, a.plane];
        m.clipShadows = true;
        m.needsUpdate = true;
      }
    });
  });
}

let lastApply = 0;
function loop(t) {
  sec.tick = 0;
  const a = sec.active;
  if (!a) return;
  if (!appState.files.includes(a.file)) {   // model removed
    deactivate();
    document.getElementById('axisPanel')?.classList.add('hidden');
    document.getElementById('toggleAxis')?.classList.remove('active');
    return;
  }
  updatePlane();
  if (t - lastApply > 500) {                // meshes fragments adds later
    lastApply = t;
    applyMaterials();
  }
  sec.tick = requestAnimationFrame(loop);
}

function setDistance(s) {
  const a = sec.active;
  if (!a) return;
  const axis = a.axes[a.axisIndex];
  a.distance = Math.min(Math.max(s, 0), axis.length);
  updatePlane();
  const slider = document.getElementById('axisSlider');
  if (slider && parseFloat(slider.value) !== a.distance) slider.value = a.distance;
  const input = document.getElementById('axisStation');
  if (input && document.activeElement !== input) input.value = formatStation(a.distance);
  if (sec.profileOpen) scheduleProfile();
}

function enterStation(text) {
  const s = String(text).trim().replace(',', '.');
  const m = s.match(/^(-?)(\d+)\+(\d+(?:\.\d*)?)$/);
  const v = m ? (m[1] ? -1 : 1) * (parseInt(m[2], 10) * 1000 + parseFloat(m[3])) : parseFloat(s);
  setDistance(isFinite(v) ? v : sec.active.distance);
}

function alignCamera() {
  const a = sec.active;
  const controls = appState.world?.camera?.controls;
  if (!a || !controls) return;
  const obj = a.file.model.object;
  const { point, tangent } = sampleAxis(a.axes[a.axisIndex], a.distance);
  const p = point.applyMatrix4(obj.matrixWorld);
  const dir = tangent.transformDirection(obj.matrixWorld);
  if (a.flipped) dir.negate();
  dir.y = 0;
  if (dir.lengthSq() < 1e-9) return;
  dir.normalize();
  const eye = p.clone().addScaledVector(dir, -CAMERA_BACKOFF_M);
  eye.y += CAMERA_RISE_M;
  const target = p.clone().addScaledVector(dir, 10);
  controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, true);
}

// =====================================
// 2D CROSS SECTION
// =====================================

function toggleProfile(open) {
  sec.profileOpen = !!open && !!sec.active;
  let panel = document.getElementById('axisProfilePanel');
  if (sec.profileOpen && !panel) panel = createProfilePanel();
  panel?.classList.toggle('hidden', !sec.profileOpen);
  if (sec.profileOpen) {
    sec.view = null;
    scheduleProfile();
  }
}

function createProfilePanel() {
  const panel = document.createElement('div');
  panel.id = 'axisProfilePanel';
  panel.className = 'axis-profile hidden';
  panel.innerHTML = `
    <div class="axis-profile-head">
      <span class="axis-panel-title" id="axisProfileTitle">Cross section</span>
      <div class="axis-profile-actions">
        <button class="axis-btn" id="axisProfileFit" title="Fit to view">Fit</button>
        <button class="panel-close" id="axisProfileClose" title="Close">&#10005;</button>
      </div>
    </div>
    <div class="axis-profile-body">
      <svg id="axisProfileSvg" class="axis-profile-svg" xmlns="http://www.w3.org/2000/svg"></svg>
      <div class="axis-profile-legend" id="axisProfileLegend"></div>
      <div class="axis-profile-status" id="axisProfileStatus"></div>
    </div>`;
  viewportEl().appendChild(panel);
  panel.querySelector('#axisProfileClose').addEventListener('click', () => {
    toggleProfile(false);
    document.getElementById('axisProfileBtn')?.classList.remove('active');
  });
  panel.querySelector('#axisProfileFit').addEventListener('click', () => { sec.view = null; scheduleProfile(); });
  wireProfileInteraction(panel.querySelector('#axisProfileSvg'));
  return panel;
}

let profilePending = false;
function scheduleProfile() {
  if (profilePending) return;
  profilePending = true;
  requestAnimationFrame(() => { profilePending = false; updateProfile(); });
}

// World-space vertices per mesh, cached until the mesh moves.
function meshWorld(mesh) {
  const pos = mesh.geometry?.attributes?.position;
  if (!pos || !pos.array) return null;
  mesh.updateMatrixWorld(true);
  const key = mesh.matrixWorld.elements.join(',') + '|' + pos.count + '|' + (mesh.isInstancedMesh ? mesh.count : 1);
  const hit = sec.meshCache.get(mesh.uuid);
  if (hit && hit.key === key) return hit;
  const instances = mesh.isInstancedMesh ? mesh.count : 1;
  const world = new Float32Array(pos.count * 3 * instances);
  const v = new THREE.Vector3(), m = new THREE.Matrix4(), im = new THREE.Matrix4();
  for (let k = 0; k < instances; k++) {
    if (mesh.isInstancedMesh) { mesh.getMatrixAt(k, im); m.multiplyMatrices(mesh.matrixWorld, im); } else m.copy(mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      const o = (k * pos.count + i) * 3;
      world[o] = v.x; world[o + 1] = v.y; world[o + 2] = v.z;
    }
  }
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const entry = {
    key, world, instances, count: pos.count,
    index: mesh.geometry.index ? mesh.geometry.index.array : null,
    groups: mesh.geometry.groups && mesh.geometry.groups.length ? mesh.geometry.groups : null,
    colors: mats.map((mt) => (mt && mt.color ? mt.color.clone() : new THREE.Color(0.8, 0.8, 0.8))),
  };
  sec.meshCache.set(mesh.uuid, entry);
  return entry;
}

function updateProfile() {
  const a = sec.active;
  if (!sec.profileOpen || !a) return;
  const t0 = performance.now();
  const obj = a.file.model.object;
  obj.updateMatrixWorld(true);
  const axis = a.axes[a.axisIndex];
  const s = sampleAxis(axis, a.distance);
  const P = s.point.clone().applyMatrix4(obj.matrixWorld);
  const T = s.tangent.clone().transformDirection(obj.matrixWorld);
  const up = new THREE.Vector3(0, 1, 0);
  const R = new THREE.Vector3().crossVectors(T, up);
  if (R.lengthSq() < 1e-12) R.set(1, 0, 0);
  R.normalize();
  const U = new THREE.Vector3().crossVectors(R, T).normalize();

  const title = document.getElementById('axisProfileTitle');
  if (title) title.textContent = `Cross section · ${axis.name} · ${formatStation(a.distance)}`;
  const fitKey = a.file.id + ':' + a.axisIndex;
  if (sec.fitKey !== fitKey) { sec.fitKey = fitKey; sec.view = null; }

  const byColor = new Map();
  obj.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.visible || mesh.parent === a.group) return;
    // quick reject by bounding sphere
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const bs = mesh.geometry.boundingSphere;
    if (bs && !mesh.isInstancedMesh) {
      const c = bs.center.clone().applyMatrix4(mesh.matrixWorld);
      const r = bs.radius * mesh.matrixWorld.getMaxScaleOnAxis();
      if (Math.abs(T.dot(c.sub(P))) > r) return;
    }
    const e = meshWorld(mesh);
    if (!e) return;
    sliceMesh(e, P, T, R, U, byColor);
  });
  setProfileStatus(byColor.size ? '' : 'Nothing cut at this station');
  renderProfile([...byColor.values()]);
  console.debug(`cross section ${Math.round(performance.now() - t0)} ms`);
}

function sliceMesh(e, P, T, R, U, byColor) {
  const w = e.world;
  const nv = e.count * e.instances;
  const sd = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    sd[i] = T.x * (w[i * 3] - P.x) + T.y * (w[i * 3 + 1] - P.y) + T.z * (w[i * 3 + 2] - P.z);
  }
  const idx = e.index;
  const triPerInstance = (idx ? idx.length : e.count) / 3;
  const groupOf = (tri) => {
    if (!e.groups) return 0;
    const start = tri * 3;
    for (const g of e.groups) if (start >= g.start && start < g.start + g.count) return g.materialIndex || 0;
    return 0;
  };
  const out = [0, 0, 0, 0];
  for (let k = 0; k < e.instances; k++) {
    const base = k * e.count;
    for (let tr = 0; tr < triPerInstance; tr++) {
      const a = base + (idx ? idx[tr * 3] : tr * 3);
      const b = base + (idx ? idx[tr * 3 + 1] : tr * 3 + 1);
      const c = base + (idx ? idx[tr * 3 + 2] : tr * 3 + 2);
      const sa = sd[a], sb = sd[b], sc = sd[c];
      if ((sa > 0 && sb > 0 && sc > 0) || (sa < 0 && sb < 0 && sc < 0)) continue;
      let n = 0;
      const edges = [[a, b, sa, sb], [b, c, sb, sc], [c, a, sc, sa]];
      for (let q = 0; q < 3 && n < 4; q++) {
        const [i0, i1, s0, s1] = edges[q];
        if ((s0 > 0) === (s1 > 0) || s0 === s1) continue;
        const f = s0 / (s0 - s1);
        const x = w[i0 * 3] + (w[i1 * 3] - w[i0 * 3]) * f - P.x;
        const y = w[i0 * 3 + 1] + (w[i1 * 3 + 1] - w[i0 * 3 + 1]) * f - P.y;
        const z = w[i0 * 3 + 2] + (w[i1 * 3 + 2] - w[i0 * 3 + 2]) * f - P.z;
        out[n++] = R.x * x + R.y * y + R.z * z;
        out[n++] = U.x * x + U.y * y + U.z * z;
      }
      if (n < 4) continue;
      const col = e.colors[groupOf(tr)] || e.colors[0];
      const key = col.getHexString();
      let g = byColor.get(key);
      if (!g) { g = { color: col, segs: [] }; byColor.set(key, g); }
      g.segs.push(out[0], out[1], out[2], out[3]);
    }
  }
}

function setProfileStatus(text) {
  const el = document.getElementById('axisProfileStatus');
  if (el) el.textContent = text || '';
}

function niceStep(span, target) {
  const raw = span / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
}

function strokeColor(c) {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const k = l < 0.45 ? 0.45 / Math.max(l, 0.05) : 1;
  const ch = (v) => Math.round(Math.min(1, v * k + (l < 0.05 ? 0.4 : 0)) * 255);
  return `rgb(${ch(c.r)},${ch(c.g)},${ch(c.b)})`;
}

function fmt(v, step) {
  const dec = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return v.toFixed(dec);
}

let lastGroups = [];
function renderProfile(groups) {
  lastGroups = groups;
  const svg = document.getElementById('axisProfileSvg');
  if (!svg) return;
  if (!sec.view) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const g of groups) {
      for (let i = 0; i < g.segs.length; i += 2) {
        const x = g.segs[i], y = g.segs[i + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (!isFinite(minX)) { minX = -10; maxX = 10; minY = -5; maxY = 5; }
    minX = Math.min(minX, 0); maxX = Math.max(maxX, 0);
    minY = Math.min(minY, 0); maxY = Math.max(maxY, 0);
    let w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
    const rect = svg.getBoundingClientRect();
    const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 16 / 9;
    if (w / h < aspect) w = h * aspect; else h = w / aspect;
    w *= 1.16; h *= 1.16;
    sec.view = { x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h };
  }
  const v = sec.view;
  svg.setAttribute('viewBox', `${v.x} ${-v.y - v.h} ${v.w} ${v.h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const step = niceStep(Math.max(v.w, v.h), 8);
  const lab = v.h / 40;
  const parts = [];
  for (let gx = Math.ceil(v.x / step) * step; gx <= v.x + v.w; gx += step) {
    parts.push(`<line class="ap-grid${Math.abs(gx) < step / 1e6 ? ' ap-zero' : ''}" x1="${gx}" y1="${-v.y - v.h}" x2="${gx}" y2="${-v.y}"/>`);
    parts.push(`<text class="ap-label" x="${gx + lab * 0.3}" y="${-v.y - lab * 0.5}" font-size="${lab}">${fmt(gx, step)}</text>`);
  }
  for (let gy = Math.ceil(v.y / step) * step; gy <= v.y + v.h; gy += step) {
    parts.push(`<line class="ap-grid${Math.abs(gy) < step / 1e6 ? ' ap-zero' : ''}" x1="${v.x}" y1="${-gy}" x2="${v.x + v.w}" y2="${-gy}"/>`);
    parts.push(`<text class="ap-label" x="${v.x + lab * 0.3}" y="${-gy - lab * 0.3}" font-size="${lab}">${fmt(gy, step)}</text>`);
  }
  for (const g of groups) {
    let d = '';
    for (let k = 0; k < g.segs.length; k += 4) {
      d += `M${g.segs[k].toFixed(3)} ${(-g.segs[k + 1]).toFixed(3)}L${g.segs[k + 2].toFixed(3)} ${(-g.segs[k + 3]).toFixed(3)}`;
    }
    parts.push(`<path class="ap-cut" stroke="${strokeColor(g.color)}" d="${d}"/>`);
  }
  parts.push(`<circle class="ap-axis" cx="0" cy="0" r="${Math.max(v.w, v.h) / 120}"/>`);
  svg.innerHTML = parts.join('');
  const legend = document.getElementById('axisProfileLegend');
  if (legend) legend.textContent = `x: m right of axis · y: m above axis · grid ${fmt(step, step)} m`;
}

function wireProfileInteraction(svg) {
  const toModel = (evt) => {
    const v = sec.view, rect = svg.getBoundingClientRect();
    const s = Math.min(rect.width / v.w, rect.height / v.h);
    const ox = (rect.width - v.w * s) / 2, oy = (rect.height - v.h * s) / 2;
    return { x: v.x + (evt.clientX - rect.left - ox) / s, y: v.y + v.h - (evt.clientY - rect.top - oy) / s, s };
  };
  svg.addEventListener('wheel', (e) => {
    if (!sec.view) return;
    e.preventDefault();
    const m = toModel(e), f = e.deltaY > 0 ? 1.15 : 1 / 1.15, v = sec.view;
    sec.view = { x: m.x - (m.x - v.x) * f, y: m.y - (m.y - v.y) * f, w: v.w * f, h: v.h * f };
    renderProfile(lastGroups);
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    if (!sec.view) return;
    drag = { x: e.clientX, y: e.clientY, view: { ...sec.view }, s: toModel(e).s };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const v = drag.view;
    sec.view = { x: v.x - (e.clientX - drag.x) / drag.s, y: v.y + (e.clientY - drag.y) / drag.s, w: v.w, h: v.h };
    renderProfile(lastGroups);
  });
  const end = (e) => { if (drag) { drag = null; try { svg.releasePointerCapture(e.pointerId); } catch (_) { /* released */ } } };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('dblclick', () => { sec.view = null; scheduleProfile(); });
}

// test/console hook, like window.__labState
window.__labAxis = { sec, loadAxes, setDistance, toggleProfile, alignCamera, updateProfile, applyMaterials };
