import * as THREE from 'three';

/**
 * Obstacle the cloth can drape over: none, sphere, table (solid block) or cylinder.
 * Owns the "Obstáculo" controls and the 3D mesh; pushes its settings into the current solver.
 */
export function setupCollider({ scene, floorY, getSolver }) {
  const $ = (id) => document.getElementById(id);
  let type = 'none';

  const material = new THREE.MeshStandardMaterial({ color: '#cdb896', roughness: 0.75, metalness: 0 });
  const geometries = {
    sphere: new THREE.SphereGeometry(0.5, 64, 40),
    table: new THREE.BoxGeometry(1, 1, 1),
    cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 64),
  };
  const mesh = new THREE.Mesh(geometries.sphere, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.visible = false;
  scene.add(mesh);

  const ids = ['sliderColSize', 'sliderColHeight', 'sliderColX', 'sliderColZ', 'sliderColFriction'];

  function settings() {
    const v = (id) => parseFloat($(id).value);
    return {
      type,
      size: v('sliderColSize'),
      height: v('sliderColHeight'),
      x: v('sliderColX'),
      z: v('sliderColZ'),
      friction: v('sliderColFriction'),
    };
  }

  function apply() {
    const c = settings();
    for (const id of ids) $(id).disabled = type === 'none';
    for (const b of document.querySelectorAll('#colSeg button')) b.classList.toggle('active', b.dataset.col === type);

    mesh.visible = type !== 'none';
    if (mesh.visible) {
      mesh.geometry = geometries[type];
      if (type === 'sphere') {
        mesh.scale.set(c.size, c.size, c.size);
        mesh.position.set(c.x, floorY + c.height - c.size / 2, c.z);
      } else {
        mesh.scale.set(c.size, c.height, c.size);
        mesh.position.set(c.x, floorY + c.height / 2, c.z);
      }
    }
    const solver = getSolver();
    if (solver) solver.setCollider(c);
  }

  $('colSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-col]');
    if (!b) return;
    type = b.dataset.col;
    apply();
  });
  for (const id of ids) $(id).addEventListener('input', apply);
  apply();

  return {
    /** Gives a freshly built solver the current obstacle. */
    attach: (solver) => solver.setCollider(settings()),
    /** The obstacle mesh (so other code can ignore or include it). */
    mesh,
  };
}
