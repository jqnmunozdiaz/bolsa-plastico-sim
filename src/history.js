/**
 * Ring buffer of solver snapshots so the user can scrub back in time.
 * A snapshot holds everything that evolves during the simulation:
 * positions, velocities, plastic crease memory (rest angles) and the handle pins.
 * The number of frames kept is limited by a memory budget, so finer meshes keep a shorter window.
 */
export class SimHistory {
  constructor(solver, { budgetBytes = 128e6, maxFrames = 3000 } = {}) {
    this.solver = solver;
    const N = solver.numVerts;
    const B = solver.numBending;
    this.tips = Int32Array.from([...solver.leftTipIndices, ...solver.rightTipIndices]);
    const T = this.tips.length;
    this.off = { vel: 3 * N, bend: 6 * N, pin: 6 * N + B, pinT: 6 * N + B + T };
    this.size = 6 * N + B + 4 * T;
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
    for (let k = 0; k < this.tips.length; k++) {
      const v = this.tips[k];
      buf[this.off.pin + k] = s.pinned[v];
      buf[this.off.pinT + 3 * k] = s.pinTarget[3 * v];
      buf[this.off.pinT + 3 * k + 1] = s.pinTarget[3 * v + 1];
      buf[this.off.pinT + 3 * k + 2] = s.pinTarget[3 * v + 2];
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
    for (let k = 0; k < this.tips.length; k++) {
      const v = this.tips[k];
      const pinned = buf[this.off.pin + k] > 0.5;
      s.pinned[v] = pinned ? 1 : 0;
      s.invMass[v] = pinned ? 0 : s.baseInvMass[v];
      s.pinTarget[3 * v] = buf[this.off.pinT + 3 * k];
      s.pinTarget[3 * v + 1] = buf[this.off.pinT + 3 * k + 1];
      s.pinTarget[3 * v + 2] = buf[this.off.pinT + 3 * k + 2];
    }
  }

  /** Drops every frame after logical index i (resuming from the past starts a new branch). */
  truncateAfter(i) {
    this.count = Math.min(this.count, i + 1);
  }
}
