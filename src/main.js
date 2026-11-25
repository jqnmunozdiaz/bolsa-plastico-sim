import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createSupermarketBagGeometry } from './bagGeometry.js';
import { XPBDBagSolver } from './xpbdSolver.js';
import { solidifyShell } from './solidify.js';
import { writeBinaryStl } from './printable.js';
import { SimHistory } from './history.js';
import StlWorker from './stlWorker.js?worker&inline';

/**
 * Generates a procedural fine HDPE extrusion-ripple bump texture
 * to capture the subtle horizontal micro-wrinkles of thin polyethylene film.
 */
function createFilmRippleTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    // High-frequency horizontal ripples + medium wave modulation
    const baseWave = Math.sin(v * Math.PI * 150.0) * 0.45 + Math.sin(v * Math.PI * 64.0) * 0.25;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const mod = Math.sin(u * Math.PI * 14.0 + v * 9.0) * 0.35 + Math.cos(u * Math.PI * 31.0 - v * 17.0) * 0.2;
      const val = Math.max(0, Math.min(255, Math.floor(128 + (baseWave + mod * 0.5) * 48)));
      const idx = (y * size + x) * 4;
      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
}

// 1. Scene, Camera, Renderer
const app = document.getElementById('app');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#f4f5f7');

const camera = new THREE.PerspectiveCamera(
  34,
  window.innerWidth / window.innerHeight,
  0.05,
  20
);
camera.position.set(0.08, 0.35, 1.24);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);

// Studio environment reflections
const pmremGenerator = new THREE.PMREMGenerator(renderer);
const roomEnv = new RoomEnvironment();
scene.environment = pmremGenerator.fromScene(roomEnv, 0.04).texture;
roomEnv.dispose();

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0.0, 0.32, 0.0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 0.45;
controls.maxDistance = 3.0;
controls.update();

// 2. Studio Lighting & Shadow Floor
const hemiLight = new THREE.HemisphereLight('#ffffff', '#cbd5e1', 0.55);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight('#ffffff', 2.05);
keyLight.position.set(-0.9, 2.5, 1.3);
keyLight.castShadow = true;
keyLight.shadow.mapSize.width = 2048;
keyLight.shadow.mapSize.height = 2048;
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 6.0;
const d = 0.65;
keyLight.shadow.camera.left = -d;
keyLight.shadow.camera.right = d;
keyLight.shadow.camera.top = d;
keyLight.shadow.camera.bottom = -d;
keyLight.shadow.bias = -0.0005;
keyLight.shadow.radius = 10;
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight('#bae6fd', 1.35);
rimLight.position.set(1.2, 1.5, -1.6);
scene.add(rimLight);

// Soft studio floor shadow receiver
const floorGeo = new THREE.PlaneGeometry(4, 4);
const floorMat = new THREE.ShadowMaterial({ opacity: 0.18 });
const floorMesh = new THREE.Mesh(floorGeo, floorMat);
floorMesh.rotation.x = -Math.PI / 2;
floorMesh.position.y = -0.04;
floorMesh.receiveShadow = true;
scene.add(floorMesh);

// 3. Bag Mesh & XPBD Physics Solver (rebuilt when the mesh resolution changes)
const RESOLUTIONS = {
  low: { label: 'Baja', nx: 24, ng: 6, nv: 40 },
  mid: { label: 'Media', nx: 36, ng: 8, nv: 60 },
  high: { label: 'Alta', nx: 48, ng: 12, nv: 80 },
};
const BAG_SHAPE = { width: 0.34, height: 0.50, gussetDepth: 0.068, halfThickness: 0.018 };
const SOLVER_FIXED = { thickness: 0.0085, floorY: -0.04, substeps: 7 };

let currentRes = 'low';
let bagData = null;
let solver = null;
let posAttr = null;
let history = null; // SimHistory for the timeline slider
let simTime = 0; // simulated seconds since the reference pose finished
let frameCounter = 0;
let viewIndex = null; // timeline frame being viewed while scrubbing (null = live)

const rippleBump = createFilmRippleTexture();

const bagMaterial = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color('#2d89bd'),
  emissive: new THREE.Color('#082f49'),
  emissiveIntensity: 0.06,
  roughness: 0.15,
  metalness: 0.02,
  clearcoat: 0.88,
  clearcoatRoughness: 0.09,
  ior: 1.51, // Polyethylene
  transparent: true,
  opacity: 0.68,
  sheen: 0.45,
  sheenRoughness: 0.25,
  sheenColor: new THREE.Color('#e0f2fe'),
  bumpMap: rippleBump,
  bumpScale: 0.0028,
  side: THREE.DoubleSide,
  depthWrite: true,
});

const bagMesh = new THREE.Mesh(new THREE.BufferGeometry(), bagMaterial);
bagMesh.castShadow = true;
bagMesh.receiveShadow = true;
scene.add(bagMesh);

// Optional wireframe overlay
const wireMat = new THREE.MeshBasicMaterial({
  color: '#0369a1',
  wireframe: true,
  transparent: true,
  opacity: 0.22,
});
const wireMesh = new THREE.Mesh(bagMesh.geometry, wireMat);
wireMesh.visible = false;
scene.add(wireMesh);

function readUiParams() {
  const num = (id) => parseFloat(document.getElementById(id).value);
  return {
    gravity: num('sliderGravity'),
    bendingCompliance: num('sliderBend'),
    plasticity: num('sliderPlastic'),
    airDrag: num('sliderDrag'),
    airPressure: num('sliderPressure'),
    selfCollision: document.getElementById('chkSelfCol').checked,
  };
}

function syncGeometry() {
  posAttr.array.set(solver.pos);
  posAttr.needsUpdate = true;
  bagData.geometry.computeVertexNormals();
  bagData.geometry.boundingSphere = null; // recomputed lazily for raycasting/culling
}

/** (Re)creates the mesh + solver at the given resolution and starts the reference-pose warm-up. */
function buildBag(resKey) {
  const res = RESOLUTIONS[resKey];
  const oldGeometry = bagData ? bagData.geometry : bagMesh.geometry;
  endBagDrag();

  bagData = createSupermarketBagGeometry({ ...BAG_SHAPE, nx: res.nx, ng: res.ng, nv: res.nv });
  solver = new XPBDBagSolver(bagData, { ...SOLVER_FIXED, ...readUiParams() });
  posAttr = bagData.geometry.attributes.position;
  bagMesh.geometry = bagData.geometry;
  wireMesh.geometry = bagData.geometry;
  oldGeometry.dispose();
  currentRes = resKey;

  history = new SimHistory(solver);

  // Physical warm-up runs over the next frames so the page never freezes
  solver.beginReferencePose(170);
  resetHistory();
  syncGeometry();

  document.getElementById('valRes').textContent = res.label;
  for (const btn of document.querySelectorAll('#resSeg button')) {
    btn.classList.toggle('active', btn.dataset.res === resKey);
  }
  refreshStatus();
}

// 4. Interactive Mouse Raycast Dragging on the Bag
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const dragPlane = new THREE.Plane();
const dragIntersect = new THREE.Vector3();
let isDraggingBag = false;

// Subtle cursor grab indicator dot
const grabDotGeo = new THREE.SphereGeometry(0.009, 16, 16);
const grabDotMat = new THREE.MeshBasicMaterial({
  color: '#0284c7',
  transparent: true,
  opacity: 0.75,
});
const grabDot = new THREE.Mesh(grabDotGeo, grabDotMat);
grabDot.visible = false;
scene.add(grabDot);

function updatePointer(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  updatePointer(e);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(bagMesh);
  if (hits.length > 0) {
    const hit = hits[0];
    const triIdx = hit.faceIndex;
    const i0 = bagData.indices[3 * triIdx];
    const i1 = bagData.indices[3 * triIdx + 1];
    const i2 = bagData.indices[3 * triIdx + 2];
    const candidates = [i0, i1, i2];
    let bestV = i0;
    let bestDist = Infinity;
    for (const v of candidates) {
      const dx = solver.pos[3 * v] - hit.point.x;
      const dy = solver.pos[3 * v + 1] - hit.point.y;
      const dz = solver.pos[3 * v + 2] - hit.point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestDist) {
        bestDist = d2;
        bestV = v;
      }
    }

    isDraggingBag = true;
    controls.enabled = false;
    renderer.domElement.style.cursor = 'grabbing';
    grabDot.position.copy(hit.point);
    grabDot.visible = true;

    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    dragPlane.setFromNormalAndCoplanarPoint(camDir.negate(), hit.point);

    solver.dragTarget[0] = hit.point.x;
    solver.dragTarget[1] = hit.point.y;
    solver.dragTarget[2] = hit.point.z;

    if (solver.pinned[bestV]) {
      // Dragging a handle tip moves that handle's pin!
      const isLeft = bagData.leftTipIndices.includes(bestV);
      solver.dragHandleGroup = isLeft ? 'left' : 'right';
      solver.dragHandleStart = [hit.point.x, hit.point.y, hit.point.z];
      const group = isLeft ? bagData.leftTipIndices : bagData.rightTipIndices;
      solver.dragPinStarts = group.map((idx) => ({
        idx,
        x: solver.pinTarget[3 * idx],
        y: solver.pinTarget[3 * idx + 1],
        z: solver.pinTarget[3 * idx + 2],
      }));
      solver.dragVertex = -1;
      solver.dragPatch = [];
    } else {
      solver.dragHandleGroup = null;
      solver.dragVertex = bestV;
      solver.wrinkleMode = wrinkleBrushEnabled || e.shiftKey;

      const radius = solver.wrinkleMode ? 0.09 : 0.075;
      const rSq = radius * radius;
      const patch = [];
      for (let i = 0; i < solver.numVerts; i++) {
        if (solver.pinned[i]) continue;
        const ox = solver.pos[3 * i] - hit.point.x;
        const oy = solver.pos[3 * i + 1] - hit.point.y;
        const oz = solver.pos[3 * i + 2] - hit.point.z;
        const d2 = ox * ox + oy * oy + oz * oz;
        if (d2 < rSq) {
          const w = Math.pow(1 - Math.sqrt(d2) / radius, 1.4);
          patch.push({ idx: i, weight: w, ox, oy, oz });
        }
      }
      solver.dragPatch = patch;
    }
  }
});

window.addEventListener('pointermove', (e) => {
  updatePointer(e);
  if (!isDraggingBag) {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(bagMesh);
    renderer.domElement.style.cursor = hits.length > 0 ? 'grab' : 'default';
    return;
  }
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.ray.intersectPlane(dragPlane, dragIntersect)) {
    solver.dragTarget[0] = dragIntersect.x;
    solver.dragTarget[1] = dragIntersect.y;
    solver.dragTarget[2] = dragIntersect.z;
    grabDot.position.copy(dragIntersect);
  }
});

function endBagDrag() {
  if (isDraggingBag) {
    isDraggingBag = false;
    solver.dragVertex = -1;
    solver.dragPatch = [];
    solver.dragHandleGroup = null;
    solver.dragPinStarts = [];
    grabDot.visible = false;
    renderer.domElement.style.cursor = 'grab';
    controls.enabled = true;
  }
}

window.addEventListener('pointerup', endBagDrag);
window.addEventListener('pointercancel', endBagDrag);
window.addEventListener('blur', endBagDrag);

// 5. UI Controls Wiring (Spanish)
let paused = false;
let simSpeed = 1.0;
let wrinkleBrushEnabled = false;
const hudPanel = document.getElementById('hudPanel');
const toggleHudBtn = document.getElementById('toggleHudBtn');
toggleHudBtn.addEventListener('click', () => {
  hudPanel.classList.toggle('collapsed');
  toggleHudBtn.textContent = hudPanel.classList.contains('collapsed') ? 'Controles' : 'Ocultar';
});

const btnWrinkleMode = document.getElementById('btnWrinkleMode');
btnWrinkleMode.addEventListener('click', () => {
  wrinkleBrushEnabled = !wrinkleBrushEnabled;
  btnWrinkleMode.textContent = wrinkleBrushEnabled ? 'Pincel Arrugas: SÍ' : 'Pincel Arrugas: NO';
  btnWrinkleMode.style.borderColor = wrinkleBrushEnabled ? '#0284c7' : '';
  btnWrinkleMode.style.color = wrinkleBrushEnabled ? '#0284c7' : '';
  btnWrinkleMode.style.background = wrinkleBrushEnabled ? '#e0f2fe' : '';
});

document.getElementById('btnRefPose').addEventListener('click', () => {
  endBagDrag();
  solver.beginReferencePose(170);
  resetHistory();
  syncGeometry();
  refreshStatus();
});
document.getElementById('btnCrumple').addEventListener('click', () => {
  solver.triggerCrumpleImpulse();
});
document.getElementById('btnShake').addEventListener('click', () => {
  solver.triggerAirGust();
});
document.getElementById('btnFlat').addEventListener('click', () => {
  endBagDrag();
  solver.resetFlat();
  syncGeometry();
  refreshStatus();
});

const btnPause = document.getElementById('btnPause');
const btnDownloadStl = document.getElementById('btnDownloadStl');

const statsBar = document.getElementById('statsBar');
const sliderTime = document.getElementById('sliderTime');
const valTime = document.getElementById('valTime');
const sliderWall = document.getElementById('sliderWall');
const valWall = document.getElementById('valWall');
const chkBase = document.getElementById('chkBase');
let stlBusy = false;
let stlProgress = '';
let stlResult = '';

function refreshStatus() {
  const warming = solver.isWarmingUp();
  const ready = paused && !stlBusy;
  btnDownloadStl.disabled = !ready;
  btnDownloadStl.classList.toggle('stl-ready', ready);
  btnDownloadStl.textContent = stlBusy ? 'Generando STL…' : 'Descargar STL';
  btnDownloadStl.title = stlBusy
    ? 'Generando el sólido imprimible…'
    : paused
      ? 'Descargar sólido imprimible en STL (mm, máx. 24 cm por eje)'
      : 'Pausa la simulación (Espacio) para descargar el STL';

  const counts = `${bagData.numVertices.toLocaleString('es-ES')} vértices • ${bagData.numTriangles.toLocaleString('es-ES')} triángulos`;
  const pct = Math.round(solver.warmupProgress() * 100);
  if (stlBusy) statsBar.textContent = `Generando STL imprimible: ${stlProgress}`;
  else if (warming) statsBar.textContent = paused
    ? `Pose de referencia en pausa (${pct} %) • ${counts}`
    : `Generando pose de referencia… ${pct} % • ${counts}`;
  else if (paused) statsBar.textContent = `En pausa • ${stlResult || counts} • Espacio: Reanudar`;
  else statsBar.textContent = `${counts} • Arrastra para tirar • Espacio: Pausar • Órbita: Arrastrar fuera`;
}

// ---- Timeline (history of the simulation) ----
function resetHistory() {
  history.clear();
  simTime = 0;
  frameCounter = 0;
  viewIndex = null;
  refreshTimeline();
}

function refreshTimeline() {
  const n = history ? history.count : 0;
  sliderTime.disabled = solver.isWarmingUp() || n < 2;
  sliderTime.max = String(Math.max(0, n - 1));
  const i = viewIndex ?? n - 1;
  sliderTime.value = String(Math.max(0, i));
  valTime.textContent = n === 0
    ? '—'
    : `${history.timeAt(i).toFixed(1)} / ${history.timeAt(n - 1).toFixed(1)} s`;
}

sliderTime.addEventListener('input', () => {
  if (!history || history.count === 0 || solver.isWarmingUp()) return;
  if (!paused) setPaused(true);
  endBagDrag();
  viewIndex = parseInt(sliderTime.value, 10);
  history.restore(viewIndex);
  syncGeometry();
  refreshTimeline();
});

function setPaused(nextPaused) {
  if (paused === nextPaused) return;
  paused = nextPaused;
  if (!paused && viewIndex !== null) {
    // Resume from the frame being viewed: everything after it is discarded (new branch)
    history.truncateAfter(viewIndex);
    simTime = history.timeAt(viewIndex);
    viewIndex = null;
    frameCounter = 0;
    refreshTimeline();
  }
  if (!paused) stlResult = '';
  btnPause.textContent = paused ? 'Reanudar (Espacio)' : 'Pausar (Espacio)';
  refreshStatus();
}

btnPause.addEventListener('click', () => {
  setPaused(!paused);
});

// Space toggles pause. A focused button/checkbox would also react to Space (on keyup) and undo
// the toggle, so cancel that default and drop focus from buttons after mouse clicks.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  e.preventDefault();
  if (e.repeat) return;
  setPaused(!paused);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') e.preventDefault();
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('button, input[type="checkbox"]');
  if (el) el.blur();
});

// ---- Printable STL export (runs in a background worker with the Manifold geometry kernel) ----
const MAX_MM = 240 * 0.9995; // tiny margin so float rounding never exceeds 240.0 mm
let stlWorker = null;
let stlJobId = 0;

sliderWall.addEventListener('input', () => {
  valWall.textContent = `${parseFloat(sliderWall.value).toFixed(1)} mm`;
});

function runStlWorker(positions, indices, options) {
  if (!stlWorker) stlWorker = new StlWorker();
  const id = ++stlJobId;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stlWorker.removeEventListener('message', onMessage);
      stlWorker.removeEventListener('error', onError);
    };
    const onMessage = (e) => {
      const d = e.data;
      if (d.id !== id) return;
      if (d.progress) {
        stlProgress = d.progress;
        refreshStatus();
        return;
      }
      cleanup();
      if (d.error) reject(new Error(d.error));
      else resolve(d);
    };
    const onError = (e) => {
      cleanup();
      stlWorker.terminate();
      stlWorker = null;
      reject(new Error(e.message || 'Error en el worker de STL'));
    };
    stlWorker.addEventListener('message', onMessage);
    stlWorker.addEventListener('error', onError);
    stlWorker.postMessage(
      { id, positions, indices, options },
      [positions.buffer, indices.buffer]
    );
  });
}

/** Fallback if the repair kernel fails: plain solidify, fit to MAX_MM, center on the plate. */
function simpleSolidStl(P, indices, wallMm) {
  const geo = solidifyShell(P, indices, wallMm);
  const pos = geo.attributes.position.array;
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], pos[i + k]);
      mx[k] = Math.max(mx[k], pos[i + k]);
    }
  }
  const s = Math.min(1, MAX_MM / Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]));
  const shift = [-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -mn[2]];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) pos[i + k] = (pos[i + k] + shift[k]) * s;
  }
  const stl = writeBinaryStl(pos, geo.index.array);
  geo.dispose();
  return stl;
}

function downloadBuffer(buffer, filename) {
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

btnDownloadStl.addEventListener('click', async () => {
  if (!paused || stlBusy) return;
  stlBusy = true;
  stlProgress = 'preparando…';
  refreshStatus();

  // Orient for the build plate (Z-up: rotate +90° about X) and convert meters -> mm,
  // scaled so no axis exceeds 240 mm. The worker fits again after adding wall and base.
  const N = bagData.numVertices;
  const P = new Float32Array(3 * N);
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < N; i++) {
    P[3 * i] = solver.pos[3 * i];
    P[3 * i + 1] = -solver.pos[3 * i + 2];
    P[3 * i + 2] = solver.pos[3 * i + 1];
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], P[3 * i + k]);
      mx[k] = Math.max(mx[k], P[3 * i + k]);
    }
  }
  const scaleMm = Math.min(1000, MAX_MM / Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]));
  for (let i = 0; i < P.length; i++) P[i] *= scaleMm;

  const wallMm = parseFloat(sliderWall.value);
  const filename = `bolsa-supermercado-${currentRes}.stl`;
  try {
    const { stl, info } = await runStlWorker(
      P.slice(),
      new Uint32Array(bagData.indices),
      { wall: wallMm, base: chkBase.checked, maxMm: MAX_MM }
    );
    downloadBuffer(stl, filename);
    stlResult = `STL ${info.sizeMm.map((v) => v.toFixed(0)).join(' × ')} mm, ${info.volumeCm3.toFixed(0)} cm³, sin errores`;
  } catch (err) {
    console.warn('No se pudo reparar el STL; se exporta el sólido simple.', err);
    downloadBuffer(simpleSolidStl(P, new Uint32Array(bagData.indices), wallMm), filename);
    stlResult = 'STL sin reparar (falló el motor de reparación)';
  } finally {
    stlBusy = false;
    refreshStatus();
  }
});

const sliderSpeed = document.getElementById('sliderSpeed');
const valSpeed = document.getElementById('valSpeed');
sliderSpeed.addEventListener('input', () => {
  simSpeed = parseFloat(sliderSpeed.value);
  valSpeed.textContent = `${simSpeed.toFixed(2)}x`;
});

function bindSlider(id, valId, paramKey) {
  const slider = document.getElementById(id);
  const label = document.getElementById(valId);
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    solver.setParam(paramKey, v);
    label.textContent = v.toFixed(paramKey === 'gravity' ? 1 : 2);
  });
}

bindSlider('sliderBend', 'valBend', 'bendingCompliance');
bindSlider('sliderPlastic', 'valPlastic', 'plasticity');
bindSlider('sliderDrag', 'valDrag', 'airDrag');
bindSlider('sliderPressure', 'valPressure', 'airPressure');
bindSlider('sliderGravity', 'valGravity', 'gravity');

document.getElementById('chkSelfCol').addEventListener('change', (e) => {
  solver.params.selfCollision = e.target.checked;
});
document.getElementById('chkWireframe').addEventListener('change', (e) => {
  wireMesh.visible = e.target.checked;
});

// Mesh resolution selector (vertex counts computed from the actual generator)
for (const [key, res] of Object.entries(RESOLUTIONS)) {
  const probe = createSupermarketBagGeometry({ ...BAG_SHAPE, nx: res.nx, ng: res.ng, nv: res.nv });
  const k = (probe.numVertices / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 });
  document.querySelector(`#resSeg button[data-res="${key}"] small`).textContent = `${k}k vért.`;
  probe.geometry.dispose();
}
document.getElementById('resSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-res]');
  if (!btn || btn.dataset.res === currentRes) return;
  buildBag(btn.dataset.res);
});

buildBag('low');

// 6. Animation Loop
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);

  if (!paused) {
    if (solver.isWarmingUp()) {
      // Spread the reference-pose warm-up over frames (~28 ms of physics per frame)
      const t0 = performance.now();
      do {
        solver.advanceReferencePose(1);
      } while (solver.isWarmingUp() && performance.now() - t0 < 28);
      syncGeometry();
      if (!solver.isWarmingUp()) {
        // Pose ready: the timeline starts here
        resetHistory();
        history.record(simTime);
        refreshTimeline();
      }
      refreshStatus();
    } else {
      const dt = (1 / 60) * simSpeed;
      solver.step(dt);
      simTime += dt;
      syncGeometry();
      if (++frameCounter % 2 === 0) {
        history.record(simTime);
        refreshTimeline();
      }
    }
  }

  controls.update();
  renderer.render(scene, camera);
}

animate();
