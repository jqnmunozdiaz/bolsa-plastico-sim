import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { createSupermarketBagGeometry } from './bagGeometry.js';
import { XPBDBagSolver } from './xpbdSolver.js';

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

// 3. Create Bag Mesh & XPBD Physics Solver
const bagData = createSupermarketBagGeometry({
  width: 0.34,
  height: 0.50,
  gussetDepth: 0.068,
  halfThickness: 0.018,
  nx: 24,
  ng: 6,
  nv: 40,
});

const solver = new XPBDBagSolver(bagData, {
  gravity: 9.8,
  bendingCompliance: 0.06,
  plasticity: 0.88,
  airDrag: 0.55,
  airPressure: 0.0,
  selfCollision: true,
  thickness: 0.0085,
  floorY: -0.04,
  substeps: 7,
});

// Run physical warm-up so the bag starts suspended in the wrinkled reference pose
solver.simulateReferencePose(170);

// Sync initial solved positions to geometry
const posAttr = bagData.geometry.attributes.position;
posAttr.array.set(solver.pos);
posAttr.needsUpdate = true;
bagData.geometry.computeVertexNormals();

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

const bagMesh = new THREE.Mesh(bagData.geometry, bagMaterial);
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
const wireMesh = new THREE.Mesh(bagData.geometry, wireMat);
wireMesh.visible = false;
scene.add(wireMesh);

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

window.addEventListener('pointerup', () => {
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
});

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
  solver.simulateReferencePose(170);
  posAttr.array.set(solver.pos);
  posAttr.needsUpdate = true;
  bagData.geometry.computeVertexNormals();
});
document.getElementById('btnCrumple').addEventListener('click', () => {
  solver.triggerCrumpleImpulse();
});
document.getElementById('btnShake').addEventListener('click', () => {
  solver.triggerAirGust();
});
document.getElementById('btnFlat').addEventListener('click', () => {
  solver.resetFlat();
  posAttr.array.set(solver.pos);
  posAttr.needsUpdate = true;
  bagData.geometry.computeVertexNormals();
});

const btnPause = document.getElementById('btnPause');
const btnDownloadStl = document.getElementById('btnDownloadStl');

function setPaused(nextPaused) {
  paused = nextPaused;
  btnPause.textContent = paused ? 'Reanudar (Espacio)' : 'Pausar (Espacio)';
  btnDownloadStl.disabled = !paused;
  btnDownloadStl.classList.toggle('stl-ready', paused);
  btnDownloadStl.title = paused
    ? 'Descargar modelo 3D en formato STL (escala en mm)'
    : 'Pausa la simulación (Espacio) para descargar el STL';
}

btnPause.addEventListener('click', () => {
  setPaused(!paused);
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    setPaused(!paused);
  }
});

// Binary STL Export (available when paused, exported in millimeters)
const stlExporter = new STLExporter();
btnDownloadStl.addEventListener('click', () => {
  if (!paused) return;
  const exportGeo = bagData.geometry.clone();
  // Convert meters -> millimeters and orient Z-up for standard 3D slicers/CAD
  exportGeo.scale(1000, 1000, 1000);
  exportGeo.rotateX(Math.PI / 2);
  const exportMesh = new THREE.Mesh(exportGeo);
  const stlBuffer = stlExporter.parse(exportMesh, { binary: true });
  exportGeo.dispose();

  const blob = new Blob([stlBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bolsa-supermercado.stl';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
    solver.params[paramKey] = v;
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

document.getElementById('statsBar').textContent =
  `${bagData.numVertices.toLocaleString()} vértices • ${bagData.numTriangles.toLocaleString()} triángulos • Arrastra para tirar • Espacio: Pausar • Órbita: Arrastrar fuera`;

// 6. Animation Loop
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);

  if (!paused) {
    solver.step((1 / 60) * simSpeed);
    posAttr.array.set(solver.pos);
    posAttr.needsUpdate = true;
    bagData.geometry.computeVertexNormals();
  }

  controls.update();
  renderer.render(scene, camera);
}

animate();
