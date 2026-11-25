import * as THREE from 'three';

/**
 * Generates a manifold 3D supermarket T-shirt bag mesh with:
 * - Front panel & Back panel with a smooth U-shaped mouth rim (no sawtooth steps)
 * - Inward-folded Left & Right side gussets
 * - Heat-sealed bottom seam (front welded to back)
 * - Two heat-sealed handle loops (Left & Right)
 */
export function createSupermarketBagGeometry(options = {}) {
  const W = options.width ?? 0.34;
  const H = options.height ?? 0.50;
  const G = options.gussetDepth ?? 0.068;
  const t0 = options.halfThickness ?? 0.018;

  const nx = options.nx ?? 24; // columns across front/back (must be even)
  const ng = options.ng ?? 6;  // columns across each side gusset (must be even)
  const nv = options.nv ?? 40; // vertical rows

  const NU = 2 * nx + 2 * ng;
  const ivMouth = Math.floor(nv * 0.69); // mouth bottom at 69% height -> smaller, realistic handles
  // Resolution-independent proportions (tuned at nx = 24, nv = 40)
  const handleCols = Math.max(2, Math.round(nx / 6)); // narrower handle straps on front/back
  const tipRows = Math.max(1, Math.round(nv / 40)); // rows welded/pinned at each handle tip
  const rimMargin = 3 * nv / 40; // gap between U-rim top and handle tips
  const halfNx = nx / 2;
  const mouthHalfCols = halfNx - handleCols; // center columns that stop at the U-rim

  // Smooth U-shaped mouth height for any front/back column offset d from center (0..halfNx)
  function getColumnTopRow(iu) {
    let d = halfNx; // default: full height (handles & gussets)
    if (iu <= nx) {
      d = Math.abs(iu - halfNx);
    } else if (iu >= nx + ng && iu <= 2 * nx + ng) {
      const backCenter = nx + ng + halfNx;
      d = Math.abs(iu - backCenter);
    }
    if (d >= mouthHalfCols) return nv; // part of handle or gusset
    const s = d / mouthHalfCols; // 0 at center, 1 at handle inner edge
    // Smooth U-curve from ivMouth up to nv - 4
    const uCurve = Math.pow(s, 2.2);
    return ivMouth + uCurve * (nv - rimMargin - ivMouth);
  }

  // Precompute top row (float) for each column iu
  const colTopRow = new Float32Array(NU);
  for (let iu = 0; iu < NU; iu++) {
    colTopRow[iu] = getColumnTopRow(iu);
  }

  // For each column iu, row iv is active if iv <= Math.ceil(colTopRow[iu])
  // and its actual y-coordinate is clamped to (colTopRow[iu] / nv) * H!
  // That makes the U-shaped mouth rim 100% smooth with zero stair-stepping.
  function isVertActive(iu, iv) {
    return iv <= Math.floor(colTopRow[iu]) + (colTopRow[iu] % 1 > 0.05 ? 1 : 0);
  }

  const gridIdx = Array.from({ length: nv + 1 }, () => new Int32Array(NU).fill(-1));
  const positions = [];
  const uvs = [];
  const isLeftHandleTip = [];
  const isRightHandleTip = [];
  const isGusset = [];
  const isBottom = [];

  function addVertex(x, y, z, u, v, leftTip, rightTip, gusset, bottom) {
    const idx = positions.length / 3;
    positions.push(x, y, z);
    uvs.push(u, v);
    isLeftHandleTip.push(leftTip);
    isRightHandleTip.push(rightTip);
    isGusset.push(gusset);
    isBottom.push(bottom);
    return idx;
  }

  function getPerimeterXZ(iu, vNorm, effectiveV) {
    const bodyProfile = Math.sin(Math.pow(vNorm, 0.75) * Math.PI);
    const t = t0 * bodyProfile;

    let handlePinch = 1.0;
    const vMouthNorm = ivMouth / nv;
    if (effectiveV > vMouthNorm) {
      const s = (effectiveV - vMouthNorm) / (1 - vMouthNorm);
      handlePinch = 1.0 - 0.12 * Math.pow(s, 1.5);
    }

    const pinchX = (x, cx, iuLocal) => {
      if (effectiveV <= vMouthNorm) return x;
      const s = (effectiveV - vMouthNorm) / (1 - vMouthNorm);
      // Only pinch columns that belong to the handles
      if (colTopRow[iuLocal] >= nv - 0.5) {
        return cx + (x - cx) * (1 - 0.42 * Math.pow(s, 1.7));
      }
      return x;
    };

    if (iu <= nx) {
      const f = iu / nx;
      let x = (-0.5 + f) * W;
      if (iu <= handleCols) x = pinchX(x, -W * 0.37, iu);
      else if (iu >= nx - handleCols) x = pinchX(x, W * 0.37, iu);
      return { x: x * handlePinch, z: t, gusset: false };
    } else if (iu <= nx + ng) {
      const g = (iu - nx) / ng;
      const fold = 1.0 - Math.abs(2 * g - 1);
      let x = (0.5 * W - G * fold) * handlePinch;
      x = pinchX(x, W * 0.37 * handlePinch, iu);
      const z = t * (1 - 2 * g);
      return { x, z, gusset: true };
    } else if (iu <= 2 * nx + ng) {
      const f = (iu - (nx + ng)) / nx;
      let x = (0.5 - f) * W;
      if (iu <= nx + ng + handleCols) x = pinchX(x, W * 0.37, iu);
      else if (iu >= 2 * nx + ng - handleCols) x = pinchX(x, -W * 0.37, iu);
      return { x: x * handlePinch, z: -t, gusset: false };
    } else {
      const g = (iu - (2 * nx + ng)) / ng;
      const fold = 1.0 - Math.abs(2 * g - 1);
      let x = (-0.5 * W + G * fold) * handlePinch;
      x = pinchX(x, -W * 0.37 * handlePinch, iu);
      const z = -t * (1 - 2 * g);
      return { x, z, gusset: true };
    }
  }

  // Determine active quads: a quad (iu, iv) -> (iuNext, iv+1) is active if at least one column reaches iv+0.05
  // and both columns reach at least iv (or the top-clamped vertex of the shorter column forms a smooth boundary triangle)
  const activeQuads = [];
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < NU; iu++) {
      const iuNext = (iu + 1) % NU;
      const top0 = colTopRow[iu];
      const top1 = colTopRow[iuNext];
      if (Math.max(top0, top1) > iv + 0.05) {
        activeQuads.push([iu, iv]);
      }
    }
  }

  const needed = Array.from({ length: nv + 1 }, () => new Uint8Array(NU));
  for (const [iu, iv] of activeQuads) {
    const iuNext = (iu + 1) % NU;
    needed[iv][iu] = 1;
    needed[iv][iuNext] = 1;
    needed[iv + 1][iu] = 1;
    needed[iv + 1][iuNext] = 1;
  }

  // Create vertices with smooth U-rim clamping + bottom/handle-tip welding
  for (let iv = 0; iv <= nv; iv++) {
    for (let iu = 0; iu < NU; iu++) {
      if (!needed[iv][iu]) continue;

      // Rows above a column's (fractional) rim height would all be clamped to the same point:
      // reuse the vertex below instead of stacking duplicates (zero-length edges, flat triangles).
      // Must run before the top-row weld, which would otherwise tie the back rim to the front rim.
      if (iv > 0 && iv - 1 >= colTopRow[iu] - 0.25 && gridIdx[iv - 1][iu] !== -1) {
        gridIdx[iv][iu] = gridIdx[iv - 1][iu];
        continue;
      }

      if (iv === 0 && iu > nx + ng && iu < 2 * nx + ng) {
        const frontIu = 2 * nx + ng - iu;
        if (gridIdx[0][frontIu] !== -1) {
          gridIdx[0][iu] = gridIdx[0][frontIu];
          continue;
        }
      }
      if (iv === nv && iu >= nx + ng && iu <= 2 * nx + ng) {
        const frontIu = 2 * nx + ng - iu;
        if (gridIdx[nv][frontIu] !== -1) {
          gridIdx[nv][iu] = gridIdx[nv][frontIu];
          continue;
        }
      }

      const clampedRow = Math.min(iv, colTopRow[iu]);
      const vNorm = clampedRow / nv;
      const y = vNorm * H;
      const { x, z, gusset } = getPerimeterXZ(iu, vNorm, vNorm);

      const isLeft = iv >= nv - tipRows && (iu <= handleCols || iu >= 2 * nx + ng - handleCols);
      const isRight = iv >= nv - tipRows && (iu >= nx - handleCols && iu <= nx + ng + handleCols);

      gridIdx[iv][iu] = addVertex(
        x,
        y,
        z,
        iu / NU,
        vNorm,
        isLeft,
        isRight,
        gusset,
        iv === 0
      );
    }
  }

  const indices = [];
  const shearPairs = [];

  for (const [iu, iv] of activeQuads) {
    const iuNext = (iu + 1) % NU;
    const v00 = gridIdx[iv][iu];
    const v10 = gridIdx[iv][iuNext];
    const v01 = gridIdx[iv + 1][iu];
    const v11 = gridIdx[iv + 1][iuNext];

    if (v00 < 0 || v10 < 0 || v01 < 0 || v11 < 0) continue;
    if (v00 === v10 && v01 === v11) continue;

    if ((iu + iv) % 2 === 0) {
      if (v00 !== v10 && v10 !== v11 && v00 !== v11) indices.push(v00, v10, v11);
      if (v00 !== v11 && v11 !== v01 && v00 !== v01) indices.push(v00, v11, v01);
      if (v10 !== v01) shearPairs.push([v10, v01]);
    } else {
      if (v00 !== v10 && v10 !== v01 && v00 !== v01) indices.push(v00, v10, v01);
      if (v10 !== v11 && v11 !== v01 && v10 !== v01) indices.push(v10, v11, v01);
      if (v00 !== v11) shearPairs.push([v00, v11]);
    }
  }

  const edgeMap = new Map();
  const numTris = indices.length / 3;

  function addEdgeTri(a, b, opp) {
    const min = a < b ? a : b;
    const max = a < b ? b : a;
    const key = `${min}_${max}`;
    let entry = edgeMap.get(key);
    if (!entry) {
      entry = { a: min, b: max, opps: [] };
      edgeMap.set(key, entry);
    }
    entry.opps.push(opp);
  }

  for (let t = 0; t < numTris; t++) {
    const i0 = indices[3 * t];
    const i1 = indices[3 * t + 1];
    const i2 = indices[3 * t + 2];
    addEdgeTri(i0, i1, i2);
    addEdgeTri(i1, i2, i0);
    addEdgeTri(i2, i0, i1);
  }

  const stretchEdges = [];
  const bendingHinges = [];

  for (const entry of edgeMap.values()) {
    stretchEdges.push([entry.a, entry.b]);
    if (entry.opps.length === 2) {
      bendingHinges.push([entry.a, entry.b, entry.opps[0], entry.opps[1]]);
    }
  }

  for (const [a, b] of shearPairs) {
    const min = a < b ? a : b;
    const max = a < b ? b : a;
    const key = `${min}_${max}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, true);
      stretchEdges.push([min, max]);
    }
  }

  const posArray = new Float32Array(positions);
  const uvArray = new Float32Array(uvs);
  const idxArray = new Uint32Array(indices);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
  geometry.setIndex(new THREE.BufferAttribute(idxArray, 1));
  geometry.computeVertexNormals();

  const leftTipIndices = [];
  const rightTipIndices = [];
  const gussetIndices = [];
  const bottomIndices = [];
  for (let i = 0; i < isLeftHandleTip.length; i++) {
    if (isLeftHandleTip[i]) leftTipIndices.push(i);
    if (isRightHandleTip[i]) rightTipIndices.push(i);
    if (isGusset[i]) gussetIndices.push(i);
    if (isBottom[i]) bottomIndices.push(i);
  }

  return {
    geometry,
    numVertices: posArray.length / 3,
    numTriangles: idxArray.length / 3,
    positions: posArray,
    indices: idxArray,
    stretchEdges,
    bendingHinges,
    leftTipIndices,
    rightTipIndices,
    gussetIndices,
    bottomIndices,
    dimensions: { W, H, G, t0, nx, ng, nv }
  };
}
