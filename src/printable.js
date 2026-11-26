import { computeShellOffsets } from './shellOffsets.js';

/**
 * Builds a clean, printable solid from the simulated film (runs in the STL worker).
 *
 *  1. Thickens every triangle into a small prism (convex hull of its offset vertices). Neighbouring
 *     prisms share their side faces, so there are no gaps.
 *  2. Boolean-unions all prisms with Manifold. The result is guaranteed watertight and free of
 *     self-intersections, even where the bag touches itself or folds sharply.
 *  3. Drops floating debris and tiny sealed air pockets.
 *  4. Optionally trims a few mm off the rounded bottom and fuses it into a flat base plate, so the
 *     model has real bed contact instead of balancing on a single point.
 *  5. Scales down (if needed) so no axis exceeds maxMm, centered on X/Y with Z min = 0.
 *
 * @param wasm      initialised manifold-3d module
 * @param P         Float32Array xyz in mm, Z-up
 * @param idx       Uint32Array triangle indices (outward winding)
 * @param options   { wall, base, maxMm, smooth } (smooth: one level of Loop subdivision first)
 * @param progress  callback(stepLabel)
 */
export function buildPrintableSolid(wasm, P, idx, options = {}, progress = () => {}) {
  const { Manifold, CrossSection } = wasm;
  if (options.smooth) ({ P, idx } = loopSubdivide(P, idx));
  const wall = options.wall ?? 1.2;
  const useBase = options.base ?? true;
  const maxMm = options.maxMm ?? 240 * 0.9995;
  const info = {};
  const garbage = [];
  const keep = (m) => {
    garbage.push(m);
    return m;
  };

  try {
    // 1. Thick prisms
    progress('Dando grosor a la lámina…');
    const off = computeShellOffsets(P, idx, wall);
    const prisms = [];
    for (let t = 0; t < idx.length; t += 3) {
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const v = 3 * idx[t + k];
        pts.push([P[v] + off[v], P[v + 1] + off[v + 1], P[v + 2] + off[v + 2]]);
        pts.push([P[v] - off[v], P[v + 1] - off[v + 1], P[v + 2] - off[v + 2]]);
      }
      const h = Manifold.hull(pts);
      if (h.isEmpty()) h.delete();
      else prisms.push(h);
    }

    // 2. Union (removes every self-intersection)
    progress('Uniendo y reparando la malla…');
    let solid = keep(Manifold.union(prisms));
    solid.numTri(); // force evaluation before freeing the inputs
    for (const p of prisms) p.delete();

    // 3. Keep the main body and any sizeable piece. Sealed air pockets (negative-volume shells, e.g.
    //    the inside of a pillow) are filled: the slicer then prints that space with infill, which
    //    prints reliably, instead of a hollow it cannot support.
    const comps = solid.decompose();
    const vols = comps.map((c) => c.volume());
    const mainVol = Math.max(...vols);
    const kept = comps.filter((c, i) => vols[i] > 0 && vols[i] >= 0.01 * mainVol);
    info.filledVoids = vols.filter((v) => v < 0).length;
    info.removedPieces = comps.length - kept.length - info.filledVoids;
    solid = keep(Manifold.compose(kept));
    for (const c of comps) c.delete();

    // 4. Flat base plate
    if (useBase) {
      progress('Añadiendo base de apoyo…');
      const minZ = solid.boundingBox().min[2];
      // Lowest cut height (1–8 mm) whose cross-section gives real contact with the plate
      let cut = 8;
      for (let h = 1; h <= 8; h += 0.5) {
        const cs = solid.slice(minZ + h);
        const area = cs.area();
        cs.delete();
        if (area >= 40) {
          cut = h;
          break;
        }
      }
      const zc = minZ + cut;
      const plateT = 2;
      const s1 = solid.slice(zc);
      const s2 = solid.slice(zc + 15);
      const outline = CrossSection.hull([s1, s2]);
      const foot = outline.offset(4, 'Round', 2, 48);
      const plateRaw = foot.extrude(plateT + 0.4); // 0.4 mm overlap into the bag for a solid bond
      const plate = plateRaw.translate([0, 0, zc - plateT]);
      const trimmed = solid.trimByPlane([0, 0, 1], zc);
      solid = keep(Manifold.union(trimmed, plate));
      solid.numTri();
      for (const x of [s1, s2, outline, foot, plateRaw, plate, trimmed]) x.delete();
      info.baseCutMm = cut;
    }

    // 5. Fit to the build volume and place on the plate
    const bb = solid.boundingBox();
    const size = [0, 1, 2].map((k) => bb.max[k] - bb.min[k]);
    const s = Math.min(1, maxMm / Math.max(...size));
    const moved = keep(solid.translate([-(bb.min[0] + bb.max[0]) / 2, -(bb.min[1] + bb.max[1]) / 2, -bb.min[2]]));
    solid = keep(moved.scale(s));
    // Collapse sub-0.01 mm slivers left by the union: in float32 they would turn into coincident
    // vertices that slicers weld into non-manifold edges
    solid = keep(solid.simplify(0.01));

    const mesh = solid.getMesh();
    const np = mesh.numProp;
    const nv = mesh.vertProperties.length / np;
    const positions = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      positions[3 * i] = mesh.vertProperties[np * i];
      positions[3 * i + 1] = mesh.vertProperties[np * i + 1];
      positions[3 * i + 2] = mesh.vertProperties[np * i + 2];
    }
    info.separatedTouchPoints = separateTouchingVertices(positions, mesh.triVerts, 0.01);
    const fb = solid.boundingBox();
    info.sizeMm = [0, 1, 2].map((k) => fb.max[k] - fb.min[k]);
    info.volumeCm3 = solid.volume() / 1000;
    info.triangles = mesh.triVerts.length / 3;
    info.genus = solid.genus();
    return { positions, indices: new Uint32Array(mesh.triVerts), info };
  } finally {
    for (const m of garbage) m.delete();
  }
}

/**
 * Where two parts of the film just touch, Manifold keeps two separate vertices at exactly the same
 * point (valid for Manifold, which works with indices). An STL only stores coordinates, so a slicer
 * would weld them into a non-manifold edge shared by four triangles. Moving each copy a hair
 * inward along its own normal separates the two parts without visibly changing the model.
 * Returns how many vertices were moved.
 */
function separateTouchingVertices(positions, triVerts, dist) {
  const nv = positions.length / 3;
  const groups = new Map();
  let shared = null;
  for (let v = 0; v < nv; v++) {
    const k = `${positions[3 * v]},${positions[3 * v + 1]},${positions[3 * v + 2]}`;
    const prev = groups.get(k);
    if (prev === undefined) groups.set(k, v);
    else (shared ??= new Set()).add(prev).add(v);
  }
  if (!shared) return 0;

  // Area-weighted vertex normals (only needed for the shared vertices)
  const n = new Float64Array(3 * nv);
  for (let t = 0; t < triVerts.length; t += 3) {
    const a = triVerts[t], b = triVerts[t + 1], c = triVerts[t + 2];
    if (!shared.has(a) && !shared.has(b) && !shared.has(c)) continue;
    const ux = positions[3 * b] - positions[3 * a], uy = positions[3 * b + 1] - positions[3 * a + 1], uz = positions[3 * b + 2] - positions[3 * a + 2];
    const vx = positions[3 * c] - positions[3 * a], vy = positions[3 * c + 1] - positions[3 * a + 1], vz = positions[3 * c + 2] - positions[3 * a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      n[3 * v] += fx; n[3 * v + 1] += fy; n[3 * v + 2] += fz;
    }
  }
  let moved = 0;
  for (const v of shared) {
    const l = Math.hypot(n[3 * v], n[3 * v + 1], n[3 * v + 2]);
    if (l === 0) continue;
    for (let k = 0; k < 3; k++) positions[3 * v + k] -= (n[3 * v + k] / l) * dist;
    moved++;
  }
  return moved;
}

/**
 * One level of Loop subdivision: every triangle becomes four and the surface is smoothed
 * (new edge points: 3/8 of the edge ends + 1/8 of the opposite corners; old points move towards
 * their neighbours). Borders are smoothed along the border only, so open edges stay put.
 */
export function loopSubdivide(P, idx) {
  const nv = P.length / 3;
  const T = idx.length / 3;
  const edges = new Map(); // key -> { a, b, opp: [], id }
  const key = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[3 * t + k], b = idx[3 * t + ((k + 1) % 3)], c = idx[3 * t + ((k + 2) % 3)];
      const kk = key(a, b);
      let e = edges.get(kk);
      if (!e) edges.set(kk, (e = { a, b, opp: [], id: -1 }));
      e.opp.push(c);
    }
  }
  const out = new Float32Array(3 * (nv + edges.size));
  // Neighbour sums: all neighbours, and border neighbours (edges with one triangle)
  const nSum = new Float64Array(3 * nv), nCnt = new Int32Array(nv);
  const bSum = new Float64Array(3 * nv), bCnt = new Int32Array(nv);
  let next = nv;
  for (const e of edges.values()) {
    e.id = next++;
    const { a, b } = e;
    for (let k = 0; k < 3; k++) {
      nSum[3 * a + k] += P[3 * b + k];
      nSum[3 * b + k] += P[3 * a + k];
    }
    nCnt[a]++;
    nCnt[b]++;
    const border = e.opp.length !== 2;
    if (border) {
      for (let k = 0; k < 3; k++) {
        bSum[3 * a + k] += P[3 * b + k];
        bSum[3 * b + k] += P[3 * a + k];
      }
      bCnt[a]++;
      bCnt[b]++;
    }
    for (let k = 0; k < 3; k++) {
      out[3 * e.id + k] = border
        ? 0.5 * (P[3 * a + k] + P[3 * b + k])
        : 0.375 * (P[3 * a + k] + P[3 * b + k]) + 0.125 * (P[3 * e.opp[0] + k] + P[3 * e.opp[1] + k]);
    }
  }
  for (let v = 0; v < nv; v++) {
    if (bCnt[v] === 2) {
      for (let k = 0; k < 3; k++) out[3 * v + k] = 0.75 * P[3 * v + k] + 0.125 * bSum[3 * v + k];
    } else if (bCnt[v] > 0 || nCnt[v] < 3) {
      for (let k = 0; k < 3; k++) out[3 * v + k] = P[3 * v + k]; // corner / non-manifold: keep
    } else {
      const n = nCnt[v];
      const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
      for (let k = 0; k < 3; k++) out[3 * v + k] = (1 - n * beta) * P[3 * v + k] + beta * nSum[3 * v + k];
    }
  }
  const outIdx = new Uint32Array(12 * T);
  for (let t = 0; t < T; t++) {
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    const ab = edges.get(key(a, b)).id, bc = edges.get(key(b, c)).id, ca = edges.get(key(c, a)).id;
    outIdx.set([a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca], 12 * t);
  }
  return { P: out, idx: outIdx };
}

/**
 * Writes a binary STL (with per-face normals) from indexed triangles.
 * Slivers whose corners collapse to the same float32 point are skipped: slicers weld vertices by
 * coordinates, so they would only show up as "degenerate facets" (the welded mesh stays closed).
 */
export function writeBinaryStl(positions, indices) {
  const f = Math.fround;
  const same = (a, b) =>
    f(positions[a]) === f(positions[b]) &&
    f(positions[a + 1]) === f(positions[b + 1]) &&
    f(positions[a + 2]) === f(positions[b + 2]);
  const keepTris = [];
  for (let t = 0; t < indices.length / 3; t++) {
    const a = 3 * indices[3 * t], b = 3 * indices[3 * t + 1], c = 3 * indices[3 * t + 2];
    if (!same(a, b) && !same(b, c) && !same(a, c)) keepTris.push(t);
  }
  const T = keepTris.length;
  const buf = new ArrayBuffer(84 + 50 * T);
  const dv = new DataView(buf);
  const header = 'bolsa-plastico-sim printable solid';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, T, true);
  let o = 84;
  for (const t of keepTris) {
    const a = 3 * indices[3 * t], b = 3 * indices[3 * t + 1], c = 3 * indices[3 * t + 2];
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(o, positions[v], true);
      dv.setFloat32(o + 4, positions[v + 1], true);
      dv.setFloat32(o + 8, positions[v + 2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
