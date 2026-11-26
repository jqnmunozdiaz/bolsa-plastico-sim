import * as THREE from 'three';
import { setControlValue } from './panel.js';

/**
 * "Escena" tab: background, floor, lighting, bag look, camera views and PNG capture.
 * Only changes how things look; the physics never reads any of it.
 * Choices are remembered per browser (localStorage) and can be reset.
 */

const STORE_KEY = 'bolsa-sim.scene';

const DEFAULTS = {
  bg: '#f4f5f7',
  gradient: false,
  floor: 'shadow', // shadow | grid | solid | none
  light: 'studio', // studio | soft | dramatic | sunset
  bagColor: '#2d89bd',
  opacity: 0.68,
  shine: 0.88,
  metal: 0, // 1 = metallic finish (aluminium foil)
  ripples: true,
  arrow: true,
  transparentPng: false,
};

const LIGHTS = {
  studio: {
    hemi: ['#ffffff', '#cbd5e1', 0.55],
    key: ['#ffffff', 2.05, [-0.9, 2.5, 1.3]],
    rim: ['#bae6fd', 1.35, [1.2, 1.5, -1.6]],
    env: 1.0,
    shadowRadius: 10,
  },
  soft: {
    hemi: ['#ffffff', '#e2e8f0', 1.05],
    key: ['#ffffff', 0.95, [-0.4, 3.0, 1.0]],
    rim: ['#e0f2fe', 0.6, [1.0, 1.8, -1.4]],
    env: 1.15,
    shadowRadius: 24,
  },
  dramatic: {
    hemi: ['#cbd5e1', '#0f172a', 0.12],
    key: ['#ffffff', 3.4, [-2.2, 1.5, 0.5]],
    rim: ['#7dd3fc', 2.6, [1.6, 1.2, -1.4]],
    env: 0.3,
    shadowRadius: 4,
  },
  sunset: {
    hemi: ['#fde68a', '#475569', 0.4],
    key: ['#fdba74', 2.6, [-2.2, 0.8, 1.2]],
    rim: ['#c4b5fd', 1.5, [1.4, 1.0, -1.6]],
    env: 0.55,
    shadowRadius: 8,
  },
};

const VIEWS = {
  iso: [0.08, 0.35, 1.24],
  front: [0, 0.32, 1.25],
  side: [1.25, 0.32, 0],
  top: [0, 1.55, 0.001],
};
const TARGET = new THREE.Vector3(0, 0.32, 0);

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: settings just aren't remembered */
  }
}

/**
 * @param ctx { scene, renderer, camera, controls, bagMaterial, floorMesh, floorY,
 *              hemiLight, keyLight, rimLight, windArrowGroup }
 */
export function setupAppearance(ctx) {
  const { scene, renderer, camera, controls, bagMaterial, floorMesh, floorY } = ctx;
  const $ = (id) => document.getElementById(id);
  let state = load();

  // Extra floors: a grid and a solid, shadow-receiving plane
  const grid = new THREE.GridHelper(3, 30);
  grid.position.y = floorY + 0.0005;
  grid.material.transparent = true;
  scene.add(grid);
  const solidFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 })
  );
  solidFloor.rotation.x = -Math.PI / 2;
  solidFloor.position.y = floorY - 0.0005;
  solidFloor.receiveShadow = true;
  scene.add(solidFloor);

  let gradientTex = null;

  function luminance(hex) {
    const c = new THREE.Color(hex);
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; // linear
  }

  function applyBackground() {
    const base = new THREE.Color(state.bg);
    if (gradientTex) {
      gradientTex.dispose();
      gradientTex = null;
    }
    if (state.gradient) {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 256;
      const g = canvas.getContext('2d');
      const top = base.clone().lerp(new THREE.Color('#ffffff'), 0.3);
      const bottom = base.clone().lerp(new THREE.Color('#000000'), 0.18);
      const grad = g.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, `#${top.getHexString()}`);
      grad.addColorStop(1, `#${bottom.getHexString()}`);
      g.fillStyle = grad;
      g.fillRect(0, 0, 2, 256);
      gradientTex = new THREE.CanvasTexture(canvas);
      gradientTex.colorSpace = THREE.SRGBColorSpace;
      scene.background = gradientTex;
    } else {
      scene.background = base;
    }
    document.body.style.background = state.bg;

    // Floor colours follow the background
    const dark = luminance(state.bg) < 0.18;
    const lineColor = base.clone().lerp(new THREE.Color(dark ? '#ffffff' : '#0f172a'), dark ? 0.25 : 0.18);
    grid.material.color.copy(lineColor);
    grid.material.opacity = dark ? 0.5 : 0.6;
    solidFloor.material.color.copy(base.clone().lerp(new THREE.Color(dark ? '#ffffff' : '#000000'), 0.06));
    floorMesh.material.opacity = dark ? 0.35 : 0.18;
  }

  function applyFloor() {
    floorMesh.visible = state.floor === 'shadow' || state.floor === 'grid';
    grid.visible = state.floor === 'grid';
    solidFloor.visible = state.floor === 'solid';
  }

  function applyLight() {
    const L = LIGHTS[state.light] ?? LIGHTS.studio;
    ctx.hemiLight.color.set(L.hemi[0]);
    ctx.hemiLight.groundColor.set(L.hemi[1]);
    ctx.hemiLight.intensity = L.hemi[2];
    ctx.keyLight.color.set(L.key[0]);
    ctx.keyLight.intensity = L.key[1];
    ctx.keyLight.position.set(...L.key[2]);
    ctx.keyLight.shadow.radius = L.shadowRadius;
    ctx.rimLight.color.set(L.rim[0]);
    ctx.rimLight.intensity = L.rim[1];
    ctx.rimLight.position.set(...L.rim[2]);
    scene.environmentIntensity = L.env;
  }

  function applyBag() {
    bagMaterial.color.set(state.bagColor);
    // Faint self-glow in a darker shade of the same colour keeps the film readable in shadow
    bagMaterial.emissive.set(state.bagColor).multiplyScalar(0.18);
    bagMaterial.opacity = state.opacity;
    bagMaterial.transparent = state.opacity < 0.999;
    bagMaterial.depthWrite = true;
    bagMaterial.roughness = 0.05 + (1 - state.shine) * 0.8;
    bagMaterial.clearcoat = state.shine;
    bagMaterial.clearcoatRoughness = 0.05 + (1 - state.shine) * 0.4;
    bagMaterial.metalness = state.metal ? 0.85 : 0.02;
    bagMaterial.sheen = state.metal ? 0 : 0.45;
    bagMaterial.bumpScale = state.ripples ? 0.0028 : 0;
    bagMaterial.needsUpdate = true;
  }

  function applyArrow() {
    ctx.windArrowGroup.visible = state.arrow;
  }

  function syncUi() {
    $('colorBg').value = state.bg;
    $('chkGradient').checked = state.gradient;
    $('colorBag').value = state.bagColor;
    $('chkRipples').checked = state.ripples;
    $('chkArrow').checked = state.arrow;
    $('chkTransparentPng').checked = state.transparentPng;
    for (const b of document.querySelectorAll('#floorSeg button')) b.classList.toggle('active', b.dataset.floor === state.floor);
    for (const b of document.querySelectorAll('#lightSeg button')) b.classList.toggle('active', b.dataset.light === state.light);
    for (const b of document.querySelectorAll('.swatches[data-for="colorBg"] button'))
      b.classList.toggle('active', b.dataset.color === state.bg);
    for (const b of document.querySelectorAll('.swatches[data-for="colorBag"] button'))
      b.classList.toggle('active', b.dataset.color === state.bagColor);
    if (parseFloat($('sliderOpacity').value) !== state.opacity) setControlValue('sliderOpacity', state.opacity);
    if (parseFloat($('sliderShine').value) !== state.shine) setControlValue('sliderShine', state.shine);
  }

  function applyAll() {
    applyBackground();
    applyFloor();
    applyLight();
    applyBag();
    applyArrow();
    syncUi();
  }

  function update(patch) {
    state = { ...state, ...patch };
    save(state);
    applyAll();
  }

  // ---- Wiring ----
  $('colorBg').addEventListener('input', (e) => update({ bg: e.target.value }));
  $('chkGradient').addEventListener('change', (e) => update({ gradient: e.target.checked }));
  $('colorBag').addEventListener('input', (e) => update({ bagColor: e.target.value }));
  $('chkRipples').addEventListener('change', (e) => update({ ripples: e.target.checked }));
  $('chkArrow').addEventListener('change', (e) => update({ arrow: e.target.checked }));
  $('chkTransparentPng').addEventListener('change', (e) => update({ transparentPng: e.target.checked }));
  $('sliderOpacity').addEventListener('input', (e) => update({ opacity: parseFloat(e.target.value) }));
  $('sliderShine').addEventListener('input', (e) => update({ shine: parseFloat(e.target.value) }));

  for (const sw of document.querySelectorAll('.swatches')) {
    sw.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-color]');
      if (!b) return;
      update(sw.dataset.for === 'colorBg' ? { bg: b.dataset.color } : { bagColor: b.dataset.color });
    });
  }
  $('floorSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-floor]');
    if (b) update({ floor: b.dataset.floor });
  });
  $('lightSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-light]');
    if (b) update({ light: b.dataset.light });
  });
  $('btnResetScene').addEventListener('click', () => {
    state = { ...DEFAULTS };
    save(state);
    applyAll();
    flyTo('iso');
  });

  // ---- Camera views (smooth fly-to) ----
  let flight = null;
  function flyTo(name) {
    const to = new THREE.Vector3(...VIEWS[name]);
    flight = {
      from: camera.position.clone(),
      fromTarget: controls.target.clone(),
      to,
      t0: performance.now(),
      dur: 650,
    };
    const step = (now) => {
      if (!flight) return;
      const k = Math.min(1, (now - flight.t0) / flight.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // ease in-out
      camera.position.lerpVectors(flight.from, flight.to, e);
      controls.target.lerpVectors(flight.fromTarget, TARGET, e);
      camera.lookAt(controls.target);
      if (k < 1) requestAnimationFrame(step);
      else flight = null;
    };
    requestAnimationFrame(step);
  }
  $('viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) flyTo(b.dataset.view);
  });
  // A manual orbit cancels a running fly-to
  renderer.domElement.addEventListener('pointerdown', () => {
    flight = null;
  });

  // ---- PNG capture ----
  $('btnScreenshot').addEventListener('click', () => {
    const transparent = state.transparentPng;
    const savedBg = scene.background;
    if (transparent) {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    }
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png'); // read right after rendering, same task
    if (transparent) scene.background = savedBg;
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `bolsa-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  applyAll();

  return {
    /** Current material look (colour, opacity, shine, metal). */
    getLook: () => ({ bagColor: state.bagColor, opacity: state.opacity, shine: state.shine, metal: state.metal }),
    /** Applies a material look (used by the material presets). */
    setLook: (look) => update({ ...look }),
    /** Whole scene look, for saving / sharing scenes. */
    getState: () => ({ ...state }),
    /** Restores a saved look (unknown keys are ignored). */
    setState: (st) => {
      const clean = {};
      for (const k of Object.keys(DEFAULTS)) if (st && k in st && typeof st[k] === typeof DEFAULTS[k]) clean[k] = st[k];
      update(clean);
    },
  };
}
