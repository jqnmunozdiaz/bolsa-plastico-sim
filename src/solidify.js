import * as THREE from 'three';
import { computeShellOffsets } from './shellOffsets.js';

/**
 * Turns a zero-thickness triangle shell into a closed, printable solid of the given thickness
 * (same idea as Blender's Solidify modifier):
 *  - an outer copy offset +thickness/2 along each vertex normal,
 *  - an inner copy offset -thickness/2 with reversed winding,
 *  - side walls that close every open boundary edge (bag mouth, handle edges).
 *
 * Normals are angle-weighted, and the offset is stretched at bends ("even thickness") so the wall
 * keeps its thickness around folds. At sharp seams (bottom weld, handle tips) where the face
 * normals cancel out, the offset points away from the sheet so the wall wraps around the fold.
 *
 * @param {Float32Array|number[]} pos  flat xyz positions (already in final units, e.g. mm)
 * @param {Uint32Array|number[]} idx   triangle indices, outward-facing winding
 * @param {number} thickness           total wall thickness (same units as pos)
 * @returns {THREE.BufferGeometry} indexed solid geometry
 */
export function solidifyShell(pos, idx, thickness) {
  const N = pos.length / 3;
  const T = idx.length / 3;
  const off = computeShellOffsets(pos, idx, thickness);

  // 3. Vertices: [0, N) outer, [N, 2N) inner
  const out = new Float32Array(N * 6);
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < 3; k++) {
      out[3 * i + k] = pos[3 * i + k] + off[3 * i + k];
      out[3 * (N + i) + k] = pos[3 * i + k] - off[3 * i + k];
    }
  }

  // 4. Faces: outer (same winding), inner (reversed), walls on boundary edges
  const tris = [];
  const edgeCount = new Map();
  const key = (a, b) => (a < b ? a * N + b : b * N + a);
  for (let t = 0; t < T; t++) {
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    tris.push(a, b, c);
    tris.push(N + a, N + c, N + b);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = key(u, v);
      const e = edgeCount.get(k);
      if (e) e.n++;
      else edgeCount.set(k, { n: 1, u, v });
    }
  }
  for (const e of edgeCount.values()) {
    if (e.n !== 1) continue;
    const { u, v } = e; // directed as in its triangle
    tris.push(v, u, N + u);
    tris.push(v, N + u, N + v);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1));
  return geo;
}
