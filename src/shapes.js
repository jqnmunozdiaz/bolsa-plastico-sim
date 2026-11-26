import * as THREE from 'three';

/**
 * Generators for the non-bag objects: a rectangular sheet (tablecloth, flag, curtain),
 * a round cloth and a closed pillow. Each returns the same structure as the bag generator:
 *   { geometry, numVertices, numTriangles, positions, indices, stretchEdges, bendingHinges,
 *     pinGroups: { name: [vertex indices] }, pressureMask: Float32Array per triangle }
 * Positions are the rest shape in metres (flat pieces are flat, so their rest angles are zero).
 */

/** Builds stretch edges (+ optional extra shear edges) and bending hinges from triangles. */
export function finishMesh(positions, uvs, indices, { shearPairs = [], pinGroups = {}, pressureMask = null } = {}) {
  const edgeMap = new Map();
  const addEdgeTri = (a, b, opp) => {
    const key = a < b ? a * 1e7 + b : b * 1e7 + a;
    let e = edgeMap.get(key);
    if (!e) edgeMap.set(key, (e = { a: Math.min(a, b), b: Math.max(a, b), opps: [] }));
    e.opps.push(opp);
  };
  for (let t = 0; t < indices.length; t += 3) {
    const [i0, i1, i2] = [indices[t], indices[t + 1], indices[t + 2]];
    addEdgeTri(i0, i1, i2);
    addEdgeTri(i1, i2, i0);
    addEdgeTri(i2, i0, i1);
  }
  const stretchEdges = [];
  const bendingHinges = [];
  for (const e of edgeMap.values()) {
    stretchEdges.push([e.a, e.b]);
    if (e.opps.length === 2) bendingHinges.push([e.a, e.b, e.opps[0], e.opps[1]]);
  }
  for (const [a, b] of shearPairs) {
    const key = a < b ? a * 1e7 + b : b * 1e7 + a;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, true);
      stretchEdges.push([Math.min(a, b), Math.max(a, b)]);
    }
  }
  const posArray = new Float32Array(positions);
  const idxArray = new Uint32Array(indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(new THREE.BufferAttribute(idxArray, 1));
  geometry.computeVertexNormals();
  const numTriangles = idxArray.length / 3;
  return {
    geometry,
    numVertices: posArray.length / 3,
    numTriangles,
    positions: posArray,
    indices: idxArray,
    stretchEdges,
    bendingHinges,
    pinGroups,
    pressureMask: pressureMask ?? new Float32Array(numTriangles),
    leftTipIndices: [],
    rightTipIndices: [],
  };
}

/** Indices of grid vertices within `radius` (metres) of vertex v. */
function around(positions, v, radius) {
  const out = [];
  const r2 = radius * radius;
  for (let i = 0; i < positions.length / 3; i++) {
    const dx = positions[3 * i] - positions[3 * v];
    const dy = positions[3 * i + 1] - positions[3 * v + 1];
    const dz = positions[3 * i + 2] - positions[3 * v + 2];
    if (dx * dx + dy * dy + dz * dz <= r2) out.push(i);
  }
  return out;
}

/**
 * Rectangular sheet, vertical in the XY plane (top edge at yTop), facing +Z.
 * Pin groups: top-left / top-right corner clips, the whole top edge, the whole left edge.
 */
export function createSheet({ width = 0.7, height = 0.5, nx = 52, ny = 37, yTop = 0.72 } = {}) {
  const positions = [];
  const uvs = [];
  const id = (i, j) => j * (nx + 1) + i; // i across, j down from the top
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      positions.push(-width / 2 + (width * i) / nx, yTop - (height * j) / ny, 0);
      uvs.push(i / nx, 1 - j / ny);
    }
  }
  const indices = [];
  const shearPairs = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = id(i, j), b = id(i + 1, j), c = id(i, j + 1), d = id(i + 1, j + 1);
      // Alternate the diagonal so the sheet has no preferred fold direction; normals face +Z
      if ((i + j) % 2 === 0) {
        indices.push(a, c, d, a, d, b);
        shearPairs.push([b, c]);
      } else {
        indices.push(a, c, b, b, c, d);
        shearPairs.push([a, d]);
      }
    }
  }
  const clip = Math.max(0.012, (1.5 * width) / nx);
  const top = [];
  const left = [];
  for (let i = 0; i <= nx; i++) top.push(id(i, 0));
  for (let j = 0; j <= ny; j++) left.push(id(0, j));
  return finishMesh(positions, uvs, indices, {
    shearPairs,
    pinGroups: {
      tl: around(positions, id(0, 0), clip),
      tr: around(positions, id(nx, 0), clip),
      top,
      left,
    },
  });
}

/**
 * Round cloth of radius R lying in the XZ plane at height y, built from concentric rings
 * (ring k has 6k vertices) so all triangles are nearly equilateral.
 * Pin groups: the centre (centre + first ring) and a point on the rim.
 */
export function createRoundCloth({ radius = 0.3, rings = 26, y = 0.62 } = {}) {
  const positions = [0, y, 0];
  const uvs = [0.5, 0.5];
  const ringStart = [0];
  for (let k = 1; k <= rings; k++) {
    ringStart.push(positions.length / 3);
    const n = 6 * k;
    const r = (radius * k) / rings;
    for (let j = 0; j < n; j++) {
      const a = (2 * Math.PI * j) / n;
      positions.push(r * Math.cos(a), y, r * Math.sin(a));
      uvs.push(0.5 + (0.5 * r * Math.cos(a)) / radius, 0.5 + (0.5 * r * Math.sin(a)) / radius);
    }
  }
  const indices = [];
  // Normals point up (+Y): with angle measured from +X towards +Z, triangles (inner, outer_next, outer)
  for (let k = 0; k < rings; k++) {
    const nIn = k === 0 ? 1 : 6 * k;
    const nOut = 6 * (k + 1);
    const sIn = ringStart[k];
    const sOut = ringStart[k + 1];
    let i = k === 0 ? nIn : 0; // the centre is a single vertex: only a fan of outer triangles
    let j = 0;
    // Merge the two rings by angle
    while (i < nIn || j < nOut) {
      const aIn = k === 0 ? Infinity : (2 * Math.PI * (i + 1)) / nIn;
      const aOut = (2 * Math.PI * (j + 1)) / nOut;
      const vin = sIn + (k === 0 ? 0 : i % nIn);
      const vout = sOut + (j % nOut);
      if (j < nOut && (aOut <= aIn || i >= nIn)) {
        indices.push(vin, sOut + ((j + 1) % nOut), vout);
        j++;
      } else {
        indices.push(vin, sIn + ((i + 1) % nIn), vout);
        i++;
      }
    }
  }
  const rimStart = ringStart[rings];
  const centre = [0];
  for (let v = ringStart[1]; v < ringStart[1] + 6; v++) centre.push(v);
  return finishMesh(positions, uvs, indices, {
    pinGroups: {
      centre,
      rim: around(positions, rimStart, Math.max(0.012, (1.5 * radius) / rings)),
    },
  });
}

/**
 * Closed pillow: two rectangular panels sewn along their border, slightly puffed so the inside
 * has volume. Top panel normals face up, bottom panel down (outward), so pressure inflates it.
 * Pin group: one corner.
 */
export function createPillow({ width = 0.5, depth = 0.34, nx = 40, ny = 27, y = 0, puff = 0.012 } = {}) {
  const positions = [];
  const uvs = [];
  const top = new Int32Array((nx + 1) * (ny + 1));
  const bottom = new Int32Array((nx + 1) * (ny + 1));
  const g = (i, j) => j * (nx + 1) + i;
  const bump = (i, j) => Math.sin((Math.PI * i) / nx) * Math.sin((Math.PI * j) / ny);
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      top[g(i, j)] = positions.length / 3;
      positions.push(-width / 2 + (width * i) / nx, y + puff * bump(i, j), -depth / 2 + (depth * j) / ny);
      uvs.push(i / nx, j / ny);
    }
  }
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const border = i === 0 || j === 0 || i === nx || j === ny;
      if (border) {
        bottom[g(i, j)] = top[g(i, j)]; // the seam
      } else {
        bottom[g(i, j)] = positions.length / 3;
        positions.push(-width / 2 + (width * i) / nx, y - puff * bump(i, j), -depth / 2 + (depth * j) / ny);
        uvs.push(i / nx, j / ny);
      }
    }
  }
  const indices = [];
  const shearPairs = [];
  const isBorder = (i, j) => i === 0 || j === 0 || i === nx || j === ny;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      // Diagonal a–d ("even") or b–c ("odd"). Corner quads have a single inner vertex: the diagonal
      // must go through it, or one bottom triangle would be all seam vertices (a copy of a top one).
      const inner = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]].map(([x, z]) => !isBorder(x, z));
      let even = (i + j) % 2 === 0;
      if (inner.filter(Boolean).length === 1) even = inner[0] || inner[3];
      for (const [P, up] of [[top, true], [bottom, false]]) {
        const a = P[g(i, j)], b = P[g(i + 1, j)], c = P[g(i, j + 1)], d = P[g(i + 1, j + 1)];
        // In XZ with Z increasing "down" the grid, (a, c, b) faces +Y
        const t1 = even ? [a, c, d] : [a, c, b];
        const t2 = even ? [a, d, b] : [b, c, d];
        for (const t of [t1, t2]) {
          if (up) indices.push(t[0], t[1], t[2]);
          else indices.push(t[0], t[2], t[1]);
        }
        shearPairs.push(even ? [b, c] : [a, d]);
      }
    }
  }
  const data = finishMesh(positions, uvs, indices, {
    shearPairs,
    pinGroups: { corner: around(positions, top[g(0, 0)], Math.max(0.012, (1.5 * width) / nx)) },
  });
  data.pressureMask.fill(1); // the whole surface is closed
  return data;
}
