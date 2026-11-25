/**
 * Per-vertex offset vectors of length ~thickness/2 (stretched at bends), pointing to the outer side.
 * The outer surface is pos + off, the inner surface pos - off.
 */
export function computeShellOffsets(pos, idx, thickness) {
  const N = pos.length / 3;
  const T = idx.length / 3;
  const half = thickness / 2;

  // 1. Angle-weighted vertex normals + "away from sheet" direction for fold seams
  const nrm = new Float64Array(N * 3);
  const away = new Float64Array(N * 3);
  const wsum = new Float64Array(N);
  const faceN = new Float64Array(T * 3);
  const p = (i, k) => pos[3 * i + k];

  for (let t = 0; t < T; t++) {
    const v = [idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]];
    const e1 = [p(v[1], 0) - p(v[0], 0), p(v[1], 1) - p(v[0], 1), p(v[1], 2) - p(v[0], 2)];
    const e2 = [p(v[2], 0) - p(v[0], 0), p(v[2], 1) - p(v[0], 1), p(v[2], 2) - p(v[0], 2)];
    let fx = e1[1] * e2[2] - e1[2] * e2[1];
    let fy = e1[2] * e2[0] - e1[0] * e2[2];
    let fz = e1[0] * e2[1] - e1[1] * e2[0];
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (fl < 1e-12) continue; // degenerate triangle
    fx /= fl; fy /= fl; fz /= fl;
    faceN[3 * t] = fx; faceN[3 * t + 1] = fy; faceN[3 * t + 2] = fz;

    const cx = (p(v[0], 0) + p(v[1], 0) + p(v[2], 0)) / 3;
    const cy = (p(v[0], 1) + p(v[1], 1) + p(v[2], 1)) / 3;
    const cz = (p(v[0], 2) + p(v[1], 2) + p(v[2], 2)) / 3;

    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3];
      const ux = p(b, 0) - p(a, 0), uy = p(b, 1) - p(a, 1), uz = p(b, 2) - p(a, 2);
      const wx = p(c, 0) - p(a, 0), wy = p(c, 1) - p(a, 1), wz = p(c, 2) - p(a, 2);
      const lu = Math.sqrt(ux * ux + uy * uy + uz * uz);
      const lw = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (lu < 1e-12 || lw < 1e-12) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (ux * wx + uy * wy + uz * wz) / (lu * lw))));
      nrm[3 * a] += fx * ang; nrm[3 * a + 1] += fy * ang; nrm[3 * a + 2] += fz * ang;
      wsum[a] += ang;
      away[3 * a] += (p(a, 0) - cx) * ang;
      away[3 * a + 1] += (p(a, 1) - cy) * ang;
      away[3 * a + 2] += (p(a, 2) - cz) * ang;
    }
  }

  // 2. Per-vertex offset vector (direction * even-thickness factor * half thickness)
  const off = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    if (wsum[i] === 0) continue;
    let nx = nrm[3 * i] / wsum[i], ny = nrm[3 * i + 1] / wsum[i], nz = nrm[3 * i + 2] / wsum[i];
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    // nl = 1 on flat areas, ~0 where the sheet folds back on itself (welded seams)
    if (nl < 0.4) {
      let ax = away[3 * i], ay = away[3 * i + 1], az = away[3 * i + 2];
      const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      const blend = 1 - nl / 0.4;
      nx += (ax / al) * blend; ny += (ay / al) * blend; nz += (az / al) * blend;
    }
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    // Even thickness: 1 / cos(angle between vertex normal and face normals), clamped
    const factor = Math.min(2, 1 / Math.max(0.5, nl));
    off[3 * i] = nx * half * factor;
    off[3 * i + 1] = ny * half * factor;
    off[3 * i + 2] = nz * half * factor;
  }
  return off;
}
