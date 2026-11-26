import * as THREE from 'three';
import { OBSTACLES, obstacleBounds } from './obstacles.js';
import { setControlValue } from './panel.js';

/**
 * Obstacle the cloth can drape over (sphere, block, cylinder, table, chair, 3D printer, bicycle,
 * bottle…). Owns the "Obstáculo" controls and the 3D model; pushes its settings into the solver.
 */
export function setupCollider({ scene, floorY, getSolver }) {
  const $ = (id) => document.getElementById(id);
  const select = $('colType');
  for (const [key, o] of Object.entries(OBSTACLES)) select.append(new Option(o.label, key));
  let type = 'none';

  const group = new THREE.Group();
  scene.add(group);
  const materials = new Map();
  const matFor = (color) => {
    if (!materials.has(color)) {
      materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05 }));
    }
    return materials.get(color);
  };

  /** Builds the drawable model of an obstacle from its pieces (local units, real size). */
  function buildModel(parts) {
    for (const ch of [...group.children]) {
      group.remove(ch);
      ch.geometry.dispose();
    }
    const up = new THREE.Vector3(0, 1, 0);
    for (const q of parts) {
      const mat = matFor(q.color ?? '#cdb896');
      let mesh;
      if (q.type === 'box') {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(2 * q.h[0], 2 * q.h[1], 2 * q.h[2]), mat);
        mesh.position.set(...q.c);
      } else if (q.type === 'sphere') {
        mesh = new THREE.Mesh(new THREE.SphereGeometry(q.r, 48, 32), mat);
        mesh.position.set(...q.c);
      } else if (q.type === 'cyl') {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(q.r, q.r, q.y1 - q.y0, 40), mat);
        mesh.position.set(q.c[0], (q.y0 + q.y1) / 2, q.c[1]);
      } else if (q.type === 'capsule') {
        const a = new THREE.Vector3(...q.a), b = new THREE.Vector3(...q.b);
        const dir = b.clone().sub(a);
        const len = dir.length();
        mesh = new THREE.Mesh(new THREE.CapsuleGeometry(q.r, len, 6, 16), mat);
        mesh.position.copy(a).add(b).multiplyScalar(0.5);
        if (len > 1e-9) mesh.quaternion.setFromUnitVectors(up, dir.normalize());
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  const ids = ['sliderColScale', 'sliderColRot', 'sliderColX', 'sliderColZ', 'sliderColFriction'];

  function settings() {
    const v = (id) => parseFloat($(id).value);
    return {
      parts: OBSTACLES[type].parts,
      scale: v('sliderColScale'),
      rot: v('sliderColRot'),
      x: v('sliderColX'),
      z: v('sliderColZ'),
      friction: v('sliderColFriction'),
    };
  }

  function apply() {
    const c = settings();
    for (const id of ids) $(id).disabled = type === 'none';
    group.visible = type !== 'none';
    group.scale.setScalar(c.scale);
    group.rotation.y = (c.rot * Math.PI) / 180;
    group.position.set(c.x, floorY, c.z);
    if (type !== 'none') {
      const b = obstacleBounds(c.parts);
      const cm = (k) => Math.round((b.max[k] - b.min[k]) * c.scale * 100);
      $('colSizeHint').textContent = `${cm(0)} × ${cm(2)} cm, ${cm(1)} cm de alto`;
    } else {
      $('colSizeHint').textContent = '';
    }
    const solver = getSolver();
    if (solver) solver.setCollider(c);
  }

  select.addEventListener('change', () => {
    type = select.value;
    buildModel(OBSTACLES[type].parts);
    // Each obstacle comes with a scale that suits the 50–70 cm cloths
    setControlValue('sliderColScale', OBSTACLES[type].scale);
    setControlValue('sliderColFriction', OBSTACLES[type].friction ?? 0.8);
    apply();
  });
  for (const id of ids) $(id).addEventListener('input', apply);
  select.value = type;
  apply();

  return {
    /** Gives a freshly built solver the current obstacle. */
    attach: (solver) => solver.setCollider(settings()),
  };
}
