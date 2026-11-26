import { createSupermarketBagGeometry } from './bagGeometry.js';
import { createSheet, createRoundCloth, createPillow } from './shapes.js';

/**
 * The objects the simulator can show. Each one defines:
 *  - resolutions: low / mid / high mesh settings (~2k, ~4.5k, ~8.5k vertices)
 *  - build(res): mesh data for the solver and the renderer
 *  - pinModes: which named vertex groups are held fixed (first = default)
 *  - place(solver, groups): puts the object in its starting position and pins the groups
 *  - referencePose: the bag also has a physical warm-up that forms its creases
 *  - pressure: suggested internal pressure (Pa) when the object is chosen
 */

const BAG_SHAPE = { width: 0.34, height: 0.5, gussetDepth: 0.068, halfThickness: 0.018 };

/** Tiny deterministic waviness so a perfectly flat piece does not stay perfectly symmetric. */
function ripple(solver, axis, amp = 0.0015) {
  for (let i = 0; i < solver.numVerts; i++) {
    const x = solver.pos[3 * i], y = solver.pos[3 * i + 1], z = solver.pos[3 * i + 2];
    solver.pos[3 * i + axis] += amp * Math.sin(37 * x + 23 * y + 29 * z + i * 0.7);
  }
  solver.prevPos.set(solver.pos);
}

export const OBJECTS = {
  bag: {
    label: 'Bolsa',
    file: 'bolsa',
    resolutions: { low: { nx: 24, ng: 6, nv: 40 }, mid: { nx: 36, ng: 8, nv: 60 }, high: { nx: 48, ng: 12, nv: 80 } },
    build: (r) => createSupermarketBagGeometry({ ...BAG_SHAPE, ...r }),
    pinModes: [
      { id: 'both', label: 'Ambas asas', groups: ['left', 'right'] },
      { id: 'left', label: 'Asa izq.', groups: ['left'] },
      { id: 'right', label: 'Asa der.', groups: ['right'] },
      { id: 'none', label: 'Ninguna', groups: [] },
    ],
    referencePose: true,
    pressure: 0,
    place(solver, groups) {
      solver.resetFlat(); // flat bag held by both handles
      solver.setPinnedGroups(groups);
    },
  },

  sheet: {
    label: 'Lámina',
    file: 'lamina',
    resolutions: { low: { nx: 52, ny: 37 }, mid: { nx: 78, ny: 56 }, high: { nx: 104, ny: 74 } },
    build: (r) => createSheet({ width: 0.7, height: 0.5, ...r }),
    pinModes: [
      { id: 'corners', label: 'Esquinas', groups: ['tl', 'tr'] },
      { id: 'top', label: 'Borde sup.', groups: ['top'] },
      { id: 'flag', label: 'Bandera', groups: ['left'] },
      { id: 'corner', label: 'Una esquina', groups: ['tl'] },
      { id: 'none', label: 'Suelta', groups: [] },
    ],
    pressure: 0,
    place(solver, groups) {
      solver.resetToRest();
      if (groups.length === 0) {
        // Nothing holds it: start horizontal, 45 cm up (or just above the obstacle) and let it drop
        const y0 = Math.max(0.45, solver.colliderTop + 0.08);
        for (let i = 0; i < solver.numVerts; i++) {
          const y = solver.pos[3 * i + 1];
          solver.pos[3 * i + 1] = y0;
          solver.pos[3 * i + 2] = 0.47 - y; // rest y 0.22..0.72 -> z -0.25..0.25
        }
        ripple(solver, 1);
      } else {
        ripple(solver, 2);
      }
      solver.setPinnedGroups(groups);
    },
  },

  round: {
    label: 'Tela redonda',
    file: 'tela-redonda',
    resolutions: { low: { rings: 26 }, mid: { rings: 39 }, high: { rings: 53 } },
    build: (r) => createRoundCloth({ radius: 0.3, y: 0.62, ...r }),
    pinModes: [
      { id: 'centre', label: 'Centro', groups: ['centre'] },
      { id: 'rim', label: 'Un punto del borde', groups: ['rim'] },
      { id: 'none', label: 'Suelta', groups: [] },
    ],
    pressure: 0,
    place(solver, groups) {
      solver.resetToRest();
      // Start above a tall obstacle (rest height 62 cm)
      const lift = Math.max(0, solver.colliderTop + 0.08 - 0.62);
      for (let i = 0; i < solver.numVerts; i++) solver.pos[3 * i + 1] += lift;
      ripple(solver, 1);
      solver.setPinnedGroups(groups);
    },
  },

  pillow: {
    label: 'Cojín',
    file: 'cojin',
    resolutions: { low: { nx: 40, ny: 27 }, mid: { nx: 60, ny: 41 }, high: { nx: 80, ny: 54 } },
    build: (r) => createPillow({ width: 0.5, depth: 0.34, y: 0, ...r }),
    pinModes: [
      { id: 'none', label: 'En el suelo', groups: [] },
      { id: 'corner', label: 'Colgado de una esquina', groups: ['corner'] },
    ],
    pressure: 1.5,
    place(solver, groups) {
      solver.resetToRest();
      // Resting just above the floor, or lifted so it can hang from the corner
      const lift = Math.max(groups.length ? 0.5 : -0.04 + 0.02, solver.colliderTop + 0.06);
      for (let i = 0; i < solver.numVerts; i++) solver.pos[3 * i + 1] += lift;
      solver.prevPos.set(solver.pos);
      solver.setPinnedGroups(groups);
    },
  },
};

/** Union of the vertices fixed by a pin mode. */
export function pinModeSet(pinGroups, mode) {
  const s = new Set();
  for (const g of mode.groups) for (const i of pinGroups[g] ?? []) s.add(i);
  return s;
}
