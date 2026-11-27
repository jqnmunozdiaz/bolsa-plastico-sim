import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OBJECTS, pinModeSet } from './objects.js';
import { XPBDBagSolver } from './xpbdSolver.js';
import { solidifyShell } from './solidify.js';
import { writeBinaryStl } from './printable.js';
import { SimHistory } from './history.js';
import StlWorker from './stlWorker.js?worker&inline';
import { setupPanel, getControlValue, setControlValue } from './panel.js';
import { setupAppearance } from './appearance.js';
import { setupMaterials } from './materials.js';
import { setupCollider } from './collider.js';
import { exportGLB, exportOBJ, createRecorder, downloadBlob } from './exporters.js';

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

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
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

// 3. Object Mesh & XPBD Physics Solver (rebuilt when the object or the mesh resolution changes)
const SOLVER_FIXED = { thickness: 0.0085, floorY: -0.04, substeps: 7 };

let currentObj = 'bag';
let currentRes = 'low';
let pinModeId = OBJECTS.bag.pinModes[0].id;
let collider = null; // obstacle controls + mesh (set up before the first object is built)
let customPins = new Set(); // fixed vertices chosen by hand (pin mode 'custom')
let quality = 'normal'; // simulation quality: fast | normal | high
let mouseTool = 'pull'; // 'pull' = drag the film, 'pin' = click to fix / release points
let pinClick = null; // pin tool: pointer-down info to tell a click from a drag
let pinTween = null; // smooth gather / spread of the fixed points
let stepInProgress = null; // physics step being spread over several refreshes { k, n, dt }
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

// Material sliders are shown in friendly units; the solver works in SI units
const UNIT = {
  sliderDensity: 1e-3, // g/m² -> kg/m²
  sliderBend: 1e-6, // µN·m -> N·m
  sliderStretch: 1e3, // kN/m -> N/m
};

function readUiParams() {
  const num = (id) => getControlValue(id) * (UNIT[id] ?? 1);
  return {
    gravity: num('sliderGravity'),
    gravityTilt: num('sliderGravTilt'),
    gravityAzimuth: num('sliderGravAz'),
    viscosity: num('sliderViscosity'),
    windShadow: document.getElementById('chkWindShadow').checked,
    density: num('sliderDensity'),
    bendStiffness: num('sliderBend'),
    stretchStiffness: num('sliderStretch'),
    plasticity: num('sliderPlastic'),
    dragCoeff: num('sliderDrag'),
    pressure: num('sliderPressure'),
    friction: num('sliderFriction'),
    windSpeed: num('sliderWind'),
    windAzimuth: num('sliderWindDir'),
    windElevation: num('sliderWindElev'),
    windTurbulence: num('sliderWindTurb'),
    selfCollision: document.getElementById('chkSelfCol').checked,
  };
}

function syncGeometry() {
  posAttr.array.set(solver.pos);
  posAttr.needsUpdate = true;
  bagData.geometry.computeVertexNormals();
  bagData.geometry.boundingSphere = null; // recomputed lazily for raycasting/culling
}

/** (Re)creates the mesh + solver for an object at a resolution and puts it in its starting pose. */
function buildObject(objKey, resKey) {
  const obj = OBJECTS[objKey];
  const oldGeometry = bagData ? bagData.geometry : bagMesh.geometry;
  endBagDrag();

  if (objKey !== currentObj || pinModeId === 'custom') pinModeId = obj.pinModes[0].id;
  bagData = obj.build(obj.resolutions[resKey]);
  solver = new XPBDBagSolver(bagData, { ...SOLVER_FIXED, ...readUiParams() });
  solver.setQuality(quality);
  collider?.attach(solver);
  posAttr = bagData.geometry.attributes.position;
  bagMesh.geometry = bagData.geometry;
  wireMesh.geometry = bagData.geometry;
  oldGeometry.dispose();
  const objChanged = objKey !== currentObj;
  currentObj = objKey;
  currentRes = resKey;
  stlResult = '';

  history = new SimHistory(solver);
  startObject();

  for (const btn of document.querySelectorAll('#objSeg button')) btn.classList.toggle('active', btn.dataset.obj === objKey);
  for (const btn of document.querySelectorAll('#resSeg button')) btn.classList.toggle('active', btn.dataset.res === resKey);
  if (objChanged || !document.querySelector('#pinSeg button')) {
    renderPinSeg();
    updateResCounts();
  }
  setPaused(false); // a new mesh always starts simulating
  refreshStatus();
}

/**
 * Starting pose: the bag runs its physical warm-up (spread over the next frames so the page never
 * freezes); the other objects are placed directly and the timeline starts right away.
 */
function startObject() {
  const obj = OBJECTS[currentObj];
  if (obj.referencePose) {
    solver.beginReferencePose(170);
    resetHistory();
  } else {
    placeObject();
    resetHistory();
    history.record(simTime);
    refreshTimeline();
  }
  syncGeometry();
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
      // Dragging a fixed point moves its whole group (a handle, a corner clip, an edge…)
      const groupName =
        pinModeId === 'custom' ? null : currentPinMode().groups.find((g) => solver.pinGroups[g]?.includes(bestV));
      const group = groupName
        ? solver.pinGroups[groupName].filter((i) => solver.pinned[i])
        : verticesNear(bestV, Math.max(0.03, 2.5 * solver.meanEdge), true);
      startPinDrag(group, hit.point);
      if (mouseTool === 'pin') pinClick = { x: e.clientX, y: e.clientY, cluster: group, wasPinned: true };
    } else if (mouseTool === 'pin') {
      // Fix a small patch where you click; keep the button down to carry it somewhere else
      const cluster = verticesNear(bestV, Math.max(0.012, 1.2 * solver.meanEdge), false);
      solver.pinVertices(cluster);
      startPinDrag(cluster, hit.point);
      pinClick = { x: e.clientX, y: e.clientY, cluster, wasPinned: false };
      pinsChangedByHand();
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

window.addEventListener('pointerup', (e) => {
  if (pinClick) {
    // A plain click (no drag) on a fixed point releases it
    const moved = Math.hypot(e.clientX - pinClick.x, e.clientY - pinClick.y) > 4;
    if (!moved && pinClick.wasPinned) {
      solver.releaseVertices(pinClick.cluster);
      pinsChangedByHand();
    }
    pinClick = null;
  }
  endBagDrag();
});

/** Vertices within `radius` of vertex v (optionally only fixed ones). */
function verticesNear(v, radius, onlyPinned) {
  const out = [];
  const r2 = radius * radius;
  const p = solver.pos;
  for (let i = 0; i < solver.numVerts; i++) {
    if (onlyPinned && !solver.pinned[i]) continue;
    const dx = p[3 * i] - p[3 * v], dy = p[3 * i + 1] - p[3 * v + 1], dz = p[3 * i + 2] - p[3 * v + 2];
    if (dx * dx + dy * dy + dz * dz <= r2) out.push(i);
  }
  return out;
}

/** Starts moving a set of fixed points with the mouse. */
function startPinDrag(list, point) {
  solver.dragHandleGroup = 'points';
  solver.dragHandleStart = [point.x, point.y, point.z];
  solver.dragPinStarts = list.map((idx) => ({
    idx,
    x: solver.pinTarget[3 * idx],
    y: solver.pinTarget[3 * idx + 1],
    z: solver.pinTarget[3 * idx + 2],
  }));
  solver.dragVertex = -1;
  solver.dragPatch = [];
}
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
  btnWrinkleMode.textContent = wrinkleBrushEnabled ? 'Pincel arrugas: SÍ' : 'Pincel arrugas: NO';
  btnWrinkleMode.classList.toggle('toggled', wrinkleBrushEnabled);
});

document.getElementById('btnRefPose').addEventListener('click', () => {
  endBagDrag();
  startObject();
  setPaused(false);
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
  placeObject(); // flat, no creases
  // A reset starts a new timeline (otherwise it would be labelled with the old run's time)
  resetHistory();
  history.record(simTime);
  refreshTimeline();
  syncGeometry();
  refreshStatus();
});

const btnPause = document.getElementById('btnPause');
const btnDownloadStl = document.getElementById('btnDownloadStl');

const statsBar = document.getElementById('statsBar');
const sliderTime = document.getElementById('sliderTime');
const valTime = document.getElementById('valTime');
const sliderWall = document.getElementById('sliderWall');
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
  stepInProgress = null; // the state is being replaced: drop any half-done step
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
  stepInProgress = null;
  history.restore(viewIndex);
  showPinModeFromSolver(); // the selector follows the frame being viewed
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
  const filename = `${OBJECTS[currentObj].file}-${currentRes}.stl`;
  try {
    const { stl, info } = await runStlWorker(
      P.slice(),
      new Uint32Array(bagData.indices),
      { wall: wallMm, base: chkBase.checked, maxMm: MAX_MM, smooth: document.getElementById('chkSmooth').checked }
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
sliderSpeed.addEventListener('input', () => {
  simSpeed = parseFloat(sliderSpeed.value);
});

function bindSlider(id, paramKey) {
  const slider = document.getElementById(id);
  slider.addEventListener('input', () => solver.setParam(paramKey, getControlValue(id) * (UNIT[id] ?? 1)));
}

bindSlider('sliderDensity', 'density');
bindSlider('sliderBend', 'bendStiffness');
bindSlider('sliderStretch', 'stretchStiffness');
bindSlider('sliderFriction', 'friction');
bindSlider('sliderPlastic', 'plasticity');
bindSlider('sliderDrag', 'dragCoeff');
bindSlider('sliderPressure', 'pressure');
bindSlider('sliderGravity', 'gravity');
bindSlider('sliderGravTilt', 'gravityTilt');
bindSlider('sliderGravAz', 'gravityAzimuth');
bindSlider('sliderViscosity', 'viscosity');
document.getElementById('chkWindShadow').addEventListener('change', (e) => {
  solver.params.windShadow = e.target.checked;
});
document.getElementById('qualitySeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-quality]');
  if (!b) return;
  quality = b.dataset.quality;
  for (const x of document.querySelectorAll('#qualitySeg button')) x.classList.toggle('active', x === b);
  solver.setQuality(quality);
});

document.getElementById('chkSelfCol').addEventListener('change', (e) => {
  solver.params.selfCollision = e.target.checked;
});
document.getElementById('chkWireframe').addEventListener('change', (e) => {
  wireMesh.visible = e.target.checked;
});

// ---- Fixed points: which parts of the object are held in place ----
function currentPinMode() {
  const modes = OBJECTS[currentObj].pinModes;
  return modes.find((m) => m.id === pinModeId) ?? modes[0];
}

function renderPinSeg() {
  const seg = document.getElementById('pinSeg');
  const modes = OBJECTS[currentObj].pinModes;
  seg.textContent = '';
  seg.style.gridTemplateColumns = `repeat(${modes.length}, 1fr)`;
  for (const m of modes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.pin = m.id;
    b.textContent = m.label;
    b.classList.toggle('active', m.id === pinModeId);
    seg.append(b);
  }
  document.getElementById('pinHint').textContent = '';
}

/**
 * Selects the mode that matches what is pinned now (after scrubbing the timeline or editing pins
 * by hand); if none matches, the pins are "personalizado" and remembered as such.
 */
function showPinModeFromSolver() {
  const pinned = solver.pinnedSet();
  const match = OBJECTS[currentObj].pinModes.find((m) => {
    const s = pinModeSet(solver.pinGroups, m);
    return s.size === pinned.size && [...s].every((i) => pinned.has(i));
  });
  if (match) {
    pinModeId = match.id;
  } else {
    pinModeId = 'custom';
    customPins = pinned;
  }
  for (const b of document.querySelectorAll('#pinSeg button')) b.classList.toggle('active', b.dataset.pin === pinModeId);
  document.getElementById('pinHint').textContent = pinModeId === 'custom' ? `personalizado (${pinned.size} vért.)` : '';
}

function pinsChangedByHand() {
  showPinModeFromSolver();
}

/** Puts the object in its starting position with the current fixed points. */
function placeObject() {
  const custom = pinModeId === 'custom';
  OBJECTS[currentObj].place(solver, custom ? [] : currentPinMode().groups);
  if (custom) solver.setPinnedSet(customPins);
}

/** Applies the selected mode (the bag's warm-up always holds both handles; it is applied when it ends). */
function applyPinMode() {
  if (solver.isWarmingUp()) return;
  if (pinModeId === 'custom') solver.setPinnedSet(customPins);
  else solver.setPinnedGroups(currentPinMode().groups);
}

// Pin tool: what a click on the film does
document.getElementById('toolSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tool]');
  if (!b) return;
  mouseTool = b.dataset.tool;
  for (const x of document.querySelectorAll('#toolSeg button')) x.classList.toggle('active', x === b);
});

/**
 * Gathers (f < 1) or spreads (f > 1) all fixed points around their centre over ~0.4 s.
 * With a curtain's whole top edge fixed, gathering makes the cloth fold into pleats.
 */
function scalePins(f) {
  const list = [...solver.pinnedSet()];
  if (!list.length || solver.isWarmingUp()) return;
  endBagDrag();
  const c = [0, 0, 0];
  for (const i of list) for (let k = 0; k < 3; k++) c[k] += solver.pinTarget[3 * i + k] / list.length;
  const from = list.map((i) => [0, 1, 2].map((k) => solver.pinTarget[3 * i + k]));
  const to = from.map((p) => p.map((v, k) => c[k] + (v - c[k]) * f));
  pinTween = { list, from, to, frame: 0, frames: 24 };
}
document.getElementById('btnGather').addEventListener('click', () => scalePins(0.85));
document.getElementById('btnSpread').addEventListener('click', () => scalePins(1 / 0.85));

function advancePinTween() {
  if (!pinTween) return;
  const t = Math.min(1, ++pinTween.frame / pinTween.frames);
  const e = t * t * (3 - 2 * t);
  pinTween.list.forEach((i, n) => {
    for (let k = 0; k < 3; k++) {
      const v = pinTween.from[n][k] + (pinTween.to[n][k] - pinTween.from[n][k]) * e;
      solver.pinTarget[3 * i + k] = v;
      if (paused) solver.pos[3 * i + k] = v; // visible right away; the film follows on resume
    }
  });
  if (paused) syncGeometry();
  if (t >= 1) pinTween = null;
}

// Orange markers on every fixed vertex
const pinMarkerGeo = new THREE.SphereGeometry(0.0045, 10, 8);
const pinMarkerMat = new THREE.MeshBasicMaterial({ color: '#f97316' });
let pinMarkers = null;
const markerMatrix = new THREE.Matrix4();
let showPins = true;
function updatePinMarkers() {
  if (!solver) return;
  if (!pinMarkers || pinMarkers.instanceMatrix.count < solver.numVerts) {
    if (pinMarkers) {
      scene.remove(pinMarkers);
      pinMarkers.dispose();
    }
    pinMarkers = new THREE.InstancedMesh(pinMarkerGeo, pinMarkerMat, solver.numVerts);
    pinMarkers.frustumCulled = false;
    scene.add(pinMarkers);
  }
  let n = 0;
  if (showPins) {
    for (let i = 0; i < solver.numVerts; i++) {
      if (!solver.pinned[i]) continue;
      markerMatrix.makeTranslation(solver.pos[3 * i], solver.pos[3 * i + 1], solver.pos[3 * i + 2]);
      pinMarkers.setMatrixAt(n++, markerMatrix);
    }
  }
  pinMarkers.count = n;
  pinMarkers.instanceMatrix.needsUpdate = true;
}
document.getElementById('chkShowPins').addEventListener('change', (e) => {
  showPins = e.target.checked;
});

document.getElementById('pinSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pin]');
  if (!btn) return;
  endBagDrag();
  pinModeId = btn.dataset.pin;
  for (const b of document.querySelectorAll('#pinSeg button')) b.classList.toggle('active', b === btn);
  document.getElementById('pinHint').textContent = '';
  applyPinMode();
});

// ---- Wind ----
const sliderWind = document.getElementById('sliderWind');
const sliderWindDir = document.getElementById('sliderWindDir');
const sliderWindElev = document.getElementById('sliderWindElev');
const sliderWindTurb = document.getElementById('sliderWindTurb');
const DIR_NAMES = ['la derecha', 'el fondo-der.', 'el fondo', 'el fondo-izq.', 'la izquierda', 'la cámara-izq.', 'la cámara', 'la cámara-der.'];

// Arrow in the scene showing where the wind blows (as seen from the default camera)
const windArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.1, 0x0ea5e9, 0.035, 0.022);
windArrow.visible = false;
const windArrowGroup = new THREE.Group(); // the Escena tab can hide the arrow altogether
windArrowGroup.add(windArrow);
scene.add(windArrowGroup);

function updateWindUi() {
  const speed = parseFloat(sliderWind.value);
  const az = parseFloat(sliderWindDir.value);
  const el = parseFloat(sliderWindElev.value);
  document.getElementById('windSpeedHint').textContent =
    speed === 0 ? 'sin viento' : speed < 1 ? 'brisa suave' : speed < 3 ? 'brisa' : speed < 7 ? 'viento fuerte' : 'temporal';
  document.getElementById('windDirHint').textContent = `hacia ${DIR_NAMES[Math.round(az / 45) % 8]}`;

  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  const dir = new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), -Math.cos(e) * Math.sin(a));
  const len = 0.08 + Math.min(speed, 12) * 0.015;
  // Placed upwind of the bag, pointing at it
  windArrow.position.set(0, 0.3, 0).addScaledVector(dir, -(0.3 + len));
  windArrow.setDirection(dir);
  windArrow.setLength(len, 0.035, 0.022);
  windArrow.visible = speed > 0;
}

for (const [el, key] of [
  [sliderWind, 'windSpeed'],
  [sliderWindDir, 'windAzimuth'],
  [sliderWindElev, 'windElevation'],
  [sliderWindTurb, 'windTurbulence'],
]) {
  el.addEventListener('input', () => {
    solver.setParam(key, parseFloat(el.value));
    updateWindUi();
  });
}
updateWindUi();

// Mesh resolution selector (vertex counts computed from the actual generator of the current object)
function updateResCounts() {
  const obj = OBJECTS[currentObj];
  for (const [key, r] of Object.entries(obj.resolutions)) {
    const probe = obj.build(r);
    const k = (probe.numVertices / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 });
    document.querySelector(`#resSeg button[data-res="${key}"] small`).textContent = `${k}k vért.`;
    probe.geometry.dispose();
  }
}
document.getElementById('resSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-res]');
  if (!btn || btn.dataset.res === currentRes) return;
  buildObject(currentObj, btn.dataset.res);
});
document.getElementById('objSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-obj]');
  if (!btn || btn.dataset.obj === currentObj) return;
  // Each object suggests its own internal pressure (only the bag and the pillow have an inside)
  setControlValue('sliderPressure', OBJECTS[btn.dataset.obj].pressure);
  buildObject(btn.dataset.obj, currentRes);
});

setupPanel();
const appearance = setupAppearance({
  scene, renderer, camera, controls, bagMaterial, floorMesh, floorY: SOLVER_FIXED.floorY,
  hemiLight, keyLight, rimLight, windArrowGroup,
});
setupMaterials(appearance);
collider = setupCollider({ scene, floorY: SOLVER_FIXED.floorY, getSolver: () => solver });
buildObject('bag', 'low');

// ---- First-time guide ----
const guide = document.getElementById('guide');
function showGuide(show) {
  guide.hidden = !show;
  if (!show) {
    try {
      localStorage.setItem('bolsa-sim.guideSeen', '1');
    } catch {
      /* not remembered */
    }
  }
}
document.getElementById('btnHelp').addEventListener('click', () => showGuide(true));
document.getElementById('btnGuideClose').addEventListener('click', () => showGuide(false));
guide.addEventListener('click', (e) => {
  if (e.target === guide) showGuide(false);
});
let guideSeen = false;
try {
  guideSeen = localStorage.getItem('bolsa-sim.guideSeen') === '1';
} catch {
  guideSeen = false;
}
if (!guideSeen && !location.hash.includes('escena=')) showGuide(true);

// Phones: start with the panel folded so the scene is visible
if (window.matchMedia('(max-width: 640px)').matches) {
  hudPanel.classList.add('collapsed');
  toggleHudBtn.textContent = 'Controles';
}

// ---- 3D model export, video, save / load / share ----
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const baseName = () => `${OBJECTS[currentObj].file}-${currentRes}`;

document.getElementById('btnExportGlb').addEventListener('click', async () => {
  try {
    const glb = await exportGLB(bagMesh, collider.group, document.getElementById('chkExportObstacle').checked, SOLVER_FIXED.floorY);
    downloadBlob(glb, `${baseName()}.glb`, 'model/gltf-binary');
  } catch (err) {
    console.warn(err);
    window.alert(`No se pudo exportar el GLB: ${err.message ?? err}`);
  }
});
document.getElementById('btnExportObj').addEventListener('click', () => {
  const obj = exportOBJ(bagMesh, collider.group, document.getElementById('chkExportObstacle').checked, SOLVER_FIXED.floorY);
  downloadBlob(obj, `${baseName()}.obj`, 'text/plain');
});

const btnRecord = document.getElementById('btnRecord');
const recorder = createRecorder(renderer.domElement, {
  onStop: (blob) => downloadBlob(blob, `simulacion-${baseName()}-${stamp()}.webm`, 'video/webm'),
});
let recordTimer = null;
if (!recorder.supported) {
  btnRecord.disabled = true;
  btnRecord.title = 'Este navegador no permite grabar vídeo del lienzo';
}
btnRecord.addEventListener('click', () => {
  if (recorder.active) {
    recorder.stop();
    clearInterval(recordTimer);
    btnRecord.textContent = '● Grabar vídeo';
    btnRecord.classList.remove('toggled');
    return;
  }
  recorder.start();
  btnRecord.classList.add('toggled');
  const tick = () => {
    const s = Math.floor(recorder.seconds);
    btnRecord.textContent = `■ Detener y descargar (${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')})`;
  };
  tick();
  recordTimer = setInterval(tick, 500);
});

function encodeF32(arr) {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function decodeF32(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

/** Every setting of the panel (not the simulation state). */
function collectSettings() {
  const panel = document.getElementById('hudPanel');
  const sliders = {};
  for (const el of panel.querySelectorAll('input[type="range"]')) {
    if (el.id && el.id !== 'sliderTime') sliders[el.id] = Number(getControlValue(el.id).toPrecision(6));
  }
  const checks = {};
  for (const el of panel.querySelectorAll('input[type="checkbox"]')) if (el.id) checks[el.id] = el.checked;
  return {
    app: 'simulador-laminas',
    version: 1,
    object: currentObj,
    res: currentRes,
    pinMode: pinModeId,
    customPins: pinModeId === 'custom' ? [...customPins] : undefined,
    quality,
    obstacle: document.getElementById('colType').value,
    material: document.getElementById('selMaterial').value,
    sliders,
    checks,
    look: appearance.getState(),
  };
}

/** Restores settings and rebuilds the object (it then simulates from its starting pose). */
function applySettings(s) {
  if (!s || typeof s !== 'object') throw new Error('archivo de escena no válido');
  const $ = (id) => document.getElementById(id);
  const colSel = $('colType');
  if (typeof s.obstacle === 'string' && [...colSel.options].some((o) => o.value === s.obstacle)) {
    colSel.value = s.obstacle;
    colSel.dispatchEvent(new Event('change')); // sets its suggested scale; saved values follow
  }
  for (const [id, v] of Object.entries(s.sliders ?? {})) {
    const el = $(id);
    if (el && el.type === 'range' && id !== 'sliderTime' && Number.isFinite(v)) setControlValue(id, v);
  }
  for (const [id, v] of Object.entries(s.checks ?? {})) {
    const el = $(id);
    if (el && el.type === 'checkbox' && el.checked !== !!v) {
      el.checked = !!v;
      el.dispatchEvent(new Event('change'));
    }
  }
  const matSel = $('selMaterial');
  if (typeof s.material === 'string' && [...matSel.options].some((o) => o.value === s.material)) matSel.value = s.material;
  if (s.look) appearance.setState(s.look);
  if (['fast', 'normal', 'high'].includes(s.quality)) document.querySelector(`#qualitySeg [data-quality="${s.quality}"]`).click();

  const objKey = OBJECTS[s.object] ? s.object : currentObj;
  const resKey = ['low', 'mid', 'high'].includes(s.res) ? s.res : currentRes;
  buildObject(objKey, resKey);
  if (s.pinMode === 'custom' && Array.isArray(s.customPins)) {
    pinModeId = 'custom';
    customPins = new Set(s.customPins.filter((i) => Number.isInteger(i) && i >= 0 && i < solver.numVerts));
  } else if (OBJECTS[objKey].pinModes.some((m) => m.id === s.pinMode)) {
    pinModeId = s.pinMode;
  }
  renderPinSeg();
  startObject();
  if (pinModeId === 'custom' && !solver.isWarmingUp()) showPinModeFromSolver();
  refreshStatus();
}

/** Restores a saved cloth shape (same object and resolution) and pauses on it. */
function applyShape(st) {
  if (!st || st.numVerts !== solver.numVerts) return false;
  const pos = decodeF32(st.pos);
  if (pos.length !== solver.pos.length || pos.some((v) => !Number.isFinite(v))) return false;
  solver.cancelReferencePose();
  solver.pos.set(pos);
  solver.prevPos.set(pos);
  solver.vel.fill(0);
  if (st.rest) {
    const rest = decodeF32(st.rest);
    if (rest.length === solver.bendRestAngle.length) solver.bendRestAngle.set(rest);
  }
  solver.setPinnedSet(new Set((st.pinned ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < solver.numVerts)));
  showPinModeFromSolver();
  resetHistory();
  simTime = Number(st.simTime) || 0;
  history.record(simTime);
  refreshTimeline();
  syncGeometry();
  setPaused(true);
  return true;
}

document.getElementById('btnSaveScene').addEventListener('click', () => {
  const data = collectSettings();
  if (document.getElementById('chkSaveShape').checked) {
    data.shape = {
      numVerts: solver.numVerts,
      simTime,
      pos: encodeF32(solver.pos),
      rest: encodeF32(solver.bendRestAngle),
      pinned: [...solver.pinnedSet()],
    };
  }
  downloadBlob(JSON.stringify(data), `escena-${baseName()}-${stamp()}.json`, 'application/json');
});
document.getElementById('btnLoadScene').addEventListener('click', () => document.getElementById('fileScene').click());
document.getElementById('fileScene').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    if (file.size > 50e6) throw new Error('archivo demasiado grande');
    const data = JSON.parse(await file.text());
    applySettings(data);
    if (data.shape && !applyShape(data.shape)) {
      window.alert('Se cargaron los ajustes, pero la forma guardada no corresponde a este objeto y resolución.');
    }
  } catch (err) {
    window.alert(`No se pudo abrir la escena: ${err.message}`);
  }
});

const toB64Url = (str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (b) => decodeURIComponent(escape(atob(b.replace(/-/g, '+').replace(/_/g, '/'))));

document.getElementById('btnShareScene').addEventListener('click', async () => {
  const s = collectSettings();
  if (s.customPins && s.customPins.length > 400) s.customPins = undefined; // keep the link short
  const url = `${location.origin}${location.pathname}#escena=${toB64Url(JSON.stringify(s))}`;
  try {
    await navigator.clipboard.writeText(url);
    statsBar.textContent = 'Enlace copiado: pégalo donde quieras compartir la escena';
  } catch {
    window.prompt('Copia este enlace:', url);
  }
});

// Opening a shared link: apply its settings
const sharedMatch = /[#&]escena=([^&]+)/.exec(location.hash);
if (sharedMatch) {
  try {
    applySettings(JSON.parse(fromB64Url(sharedMatch[1])));
  } catch (err) {
    console.warn('Enlace de escena no válido', err);
  }
}

// 6. Animation Loop
/** Portrait screens (phones): zoom out so the whole object fits across the narrow width. */
function fitCamera() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.zoom = Math.min(1, camera.aspect * 1.25);
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', fitCamera);
fitCamera();

const PHYS_DT = 1 / 60;
const STEP_BUDGET_MS = 16; // physics time per screen refresh (one 60 Hz frame) before the rest of a step waits
let lastFrameTime = performance.now();
let stepClock = 0; // real seconds owed to the physics

function animate(now = performance.now()) {
  requestAnimationFrame(animate);
  const elapsed = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000));
  lastFrameTime = now;

  advancePinTween();
  if (!paused) {
    if (solver.isWarmingUp()) {
      // Spread the reference-pose warm-up over frames (~28 ms of physics per frame)
      const t0 = performance.now();
      do {
        solver.advanceReferencePose(1);
      } while (solver.isWarmingUp() && performance.now() - t0 < 28);
      syncGeometry();
      if (!solver.isWarmingUp()) {
        // Pose ready: apply the chosen fixed handles; the timeline starts here
        applyPinMode();
        resetHistory();
        history.record(simTime);
        refreshTimeline();
      }
      refreshStatus();
    } else {
      // One 1/60 s physics step per 1/60 s of real time, so the bag moves at the same pace on
      // 60, 120 or 144 Hz screens (at most one step per frame: slow meshes run in slow motion)
      // A heavy step (fine meshes) is spread over several screen refreshes: at most ~16 ms of
      // substeps per refresh, so orbiting and the panel stay smooth (the physics runs slower).
      stepClock = Math.min(stepClock + elapsed, 2 * PHYS_DT);
      if (!stepInProgress && stepClock >= PHYS_DT - 0.002) {
        stepClock = Math.max(0, stepClock - PHYS_DT);
        const dt = PHYS_DT * simSpeed;
        solver.beginStep(dt);
        stepInProgress = { k: 0, n: solver._st.substeps, dt };
      }
      if (stepInProgress) {
        const t0 = performance.now();
        do {
          solver.substep(stepInProgress.k++);
        } while (stepInProgress.k < stepInProgress.n && performance.now() - t0 < STEP_BUDGET_MS);
        if (stepInProgress.k >= stepInProgress.n) {
          solver.endStep();
          simTime += stepInProgress.dt;
          stepInProgress = null;
          syncGeometry();
          if (++frameCounter % 2 === 0) {
            history.record(simTime);
            refreshTimeline();
          }
        }
      }
    }
  }

  updatePinMarkers();
  controls.update();
  renderer.render(scene, camera);
}

animate();
