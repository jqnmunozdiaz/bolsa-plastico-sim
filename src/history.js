/**
 * Ring buffer of solver snapshots so the user can scrub back in time.
 * A snapshot holds everything that evolves during the simulation:
 * positions, velocities, plastic crease memory (rest angles) and which vertices are fixed
 * (packed 16 per float; a fixed vertex sits exactly on its pin target, so its position is the target).
 * The number of frames kept is limited by a memory budget, so finer meshes keep a shorter window.
 */
export class SimHistory {
  constructor(solver, { budgetBytes = 128e6, maxFrames = 3000 } = {}) {
    this.solver = solver;
    const N = solver.numVerts;
    const B = solver.numBending;
    this.flagFloats = Math.ceil(N / 16);
    this.off = { vel: 3 * N, bend: 6 * N, pin: 6 * N + B };
    this.size = 6 * N + B + this.flagFloats;
    this.capacity = Math.max(60, Math.min(maxFrames, Math.floor(budgetBytes / (this.size * 4))));
    this.bufs = new Array(this.capacity);
    this.times = new Float64Array(this.capacity);
    this.clear();
  }

  clear() {
    this.start = 0;
    this.count = 0;
  }

  _phys(i) {
    return (this.start + i) % this.capacity;
  }

  /** Time (simulated seconds) of logical frame i. */
  timeAt(i) {
    return this.times[this._phys(i)];
  }

  record(time) {
    let phys;
    if (this.count < this.capacity) {
      phys = this._phys(this.count);
      this.count++;
    } else {
      phys = this.start; // overwrite the oldest frame
      this.start = (this.start + 1) % this.capacity;
    }
    const buf = this.bufs[phys] ?? (this.bufs[phys] = new Float32Array(this.size));
    const s = this.solver;
    buf.set(s.pos, 0);
    buf.set(s.vel, this.off.vel);
    buf.set(s.bendRestAngle, this.off.bend);
    const N = s.numVerts;
    for (let f = 0; f < this.flagFloats; f++) {
      let bits = 0;
      for (let b = 0; b < 16; b++) {
        const i = f * 16 + b;
        if (i < N && s.pinned[i]) bits |= 1 << b;
      }
      buf[this.off.pin + f] = bits;
    }
    this.times[phys] = time;
  }

  restore(i) {
    const buf = this.bufs[this._phys(i)];
    const s = this.solver;
    const N3 = s.pos.length;
    s.pos.set(buf.subarray(0, N3));
    s.prevPos.set(s.pos);
    s.vel.set(buf.subarray(this.off.vel, this.off.vel + N3));
    s.bendRestAngle.set(buf.subarray(this.off.bend, this.off.bend + s.numBending));
    s.extForces.fill(0);
    const N = s.numVerts;
    for (let f = 0; f < this.flagFloats; f++) {
      const bits = buf[this.off.pin + f] | 0;
      for (let b = 0; b < 16; b++) {
        const v = f * 16 + b;
        if (v >= N) break;
        const on = (bits >> b) & 1;
        s.pinned[v] = on;
        s.invMass[v] = on ? 0 : s.baseInvMass[v];
        if (on) {
          s.pinTarget[3 * v] = s.pos[3 * v];
          s.pinTarget[3 * v + 1] = s.pos[3 * v + 1];
          s.pinTarget[3 * v + 2] = s.pos[3 * v + 2];
        }
      }
    }
  }

  /** Drops every frame after logical index i (resuming from the past starts a new branch). */
  truncateAfter(i) {
    this.count = Math.min(this.count, i + 1);
  }
}
