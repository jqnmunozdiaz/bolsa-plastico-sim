/**
 * XPBD (Extended Position Based Dynamics) Thin-Shell Plastic Film Solver
 *
 * Models an HDPE supermarket bag with:
 * - Near-inextensible membrane stretch/shear constraints
 * - Signed dihedral bending constraints with elasto-plastic crease memory
 * - Triangle aerodynamic drag & subtle internal air cushion
 * - Fast spatial-hash self-collision + floor collision
 */
export class XPBDBagSolver {
  constructor(bagMeshData, params = {}) {
    this.numVerts = bagMeshData.numVertices;
    this.numTris = bagMeshData.numTriangles;
    this.indices = bagMeshData.indices;
    this.leftTipIndices = bagMeshData.leftTipIndices ?? [];
    this.rightTipIndices = bagMeshData.rightTipIndices ?? [];
    // Named groups of vertices that can be fixed in place (bag: the two handle tips)
    this.pinGroups = bagMeshData.pinGroups ?? { left: this.leftTipIndices, right: this.rightTipIndices };
    this.pinCandidates = Int32Array.from(new Set(Object.values(this.pinGroups).flat()));
    this.gussetIndices = bagMeshData.gussetIndices;
    this.dimensions = bagMeshData.dimensions;

    // Physics parameters
    this.params = {
      gravity: params.gravity ?? 9.8, // m/s²
      gravityTilt: params.gravityTilt ?? 0, // degrees away from straight down
      gravityAzimuth: params.gravityAzimuth ?? 0, // direction of the tilt (same convention as the wind)
      viscosity: params.viscosity ?? 1.7, // velocity damping, 1/s (1.7 = the original 0.996 per substep)
      windShadow: params.windShadow ?? true, // parts behind other parts (seen from the wind) get less wind
      // Material, in SI units
      density: params.density ?? 0.018, // areal density, kg/m² (HDPE film ~19 µm)
      bendStiffness: params.bendStiffness ?? 4.9e-6, // bending modulus D = E·t³/12, N·m
      stretchStiffness: params.stretchStiffness ?? 18000, // in-plane stiffness E·t, N/m
      plasticity: params.plasticity ?? 0.68, // 0..1 share of each excess fold that becomes permanent
      dragCoeff: params.dragCoeff ?? 1.0, // aerodynamic drag coefficient Cd of each facet
      pressure: params.pressure ?? 0, // overpressure inside the bag body, Pa
      friction: params.friction ?? 0.3, // floor friction 0..1
      selfCollision: params.selfCollision ?? true,
      thickness: params.thickness ?? 0.0085,
      floorY: params.floorY ?? -0.06,
      substeps: params.substeps ?? 7,
      // Steady wind: speed in m/s, direction it blows TOWARDS (azimuth in the floor plane, elevation
      // above it) and turbulence 0..1 (gusts that vary in time and across the film)
      windSpeed: params.windSpeed ?? 0,
      windAzimuth: params.windAzimuth ?? 0,
      windElevation: params.windElevation ?? 0,
      windTurbulence: params.windTurbulence ?? 0.4,
    };
    this.time = 0; // simulated seconds (drives the wind gusts)

    // Masses, forces and stiffnesses come from physical units, so they are resolution independent.
    // A few numerical settings still depend on the edge length (reference mesh: nx = 24, nv = 40).
    // edgeRatio ~ edge length / reference edge length, from the mean triangle area
    // (reference: the low-resolution bag, 9.757e-5 m² per triangle)
    let restArea = 0;
    for (let t = 0; t < this.numTris; t++) {
      restArea += this._triArea(bagMeshData.positions, this.indices[3 * t], this.indices[3 * t + 1], this.indices[3 * t + 2]);
    }
    const edgeRatio = Math.sqrt(restArea / this.numTris / 9.757e-5);
    this.meanEdge = Math.sqrt((2 * restArea) / this.numTris); // typical edge length (m)
    // Smaller hinges see smaller angles for the same curvature -> lower the plastic yield angle
    this.yieldAngle = 0.26 * edgeRatio;
    // Allow more candidates per hash cell when the mesh is denser
    this.cellCap = Math.round(24 / (edgeRatio * edgeRatio));
    // Gauss-Seidel converges more slowly on finer meshes: add cheap extra stretch passes
    this.baseStretchIters = params.stretchIters ?? (edgeRatio < 0.6 ? 3 : edgeRatio < 0.9 ? 2 : 1);
    this.stretchIters = this.baseStretchIters;

    const N = this.numVerts;
    this.restPos = new Float32Array(bagMeshData.positions);
    this.pos = new Float32Array(bagMeshData.positions);
    this.prevPos = new Float32Array(bagMeshData.positions);
    this.vel = new Float32Array(N * 3);
    this.invMass = new Float32Array(N);
    this.pinned = new Uint8Array(N);
    this.pinTarget = new Float32Array(N * 3);

    // Film area carried by each vertex (a third of each adjacent triangle, at rest)
    this.vertArea = new Float64Array(N);
    for (let t = 0; t < this.numTris; t++) {
      const a = this.indices[3 * t], b = this.indices[3 * t + 1], c = this.indices[3 * t + 2];
      const A = this._triArea(this.restPos, a, b, c);
      this.vertArea[a] += A / 3;
      this.vertArea[b] += A / 3;
      this.vertArea[c] += A / 3;
    }
    this.baseInvMass = new Float32Array(N);
    this.updateMasses();

    // Where internal pressure acts (per triangle, 0..1). Bag: its body below the handles
    if (bagMeshData.pressureMask) {
      this.pressureMask = bagMeshData.pressureMask;
    } else {
      const H = this.dimensions.H;
      this.pressureMask = new Float32Array(this.numTris);
      for (let t = 0; t < this.numTris; t++) {
        let y = 0;
        for (let k = 0; k < 3; k++) y += this.restPos[3 * this.indices[3 * t + k] + 1] / 3;
        this.pressureMask[t] = Math.max(0, 1 - Math.pow(y / (H * 0.72), 2));
      }
    }

    // Precompute stretch edges & rest lengths
    const edges = bagMeshData.stretchEdges;
    this.numStretch = edges.length;
    this.stretchA = new Int32Array(this.numStretch);
    this.stretchB = new Int32Array(this.numStretch);
    this.stretchRestLen = new Float32Array(this.numStretch);

    for (let i = 0; i < this.numStretch; i++) {
      const a = edges[i][0];
      const b = edges[i][1];
      this.stretchA[i] = a;
      this.stretchB[i] = b;
      const dx = this.restPos[3 * b] - this.restPos[3 * a];
      const dy = this.restPos[3 * b + 1] - this.restPos[3 * a + 1];
      const dz = this.restPos[3 * b + 2] - this.restPos[3 * a + 2];
      this.stretchRestLen[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    // Precompute dihedral bending hinges & rest angles
    const hinges = bagMeshData.bendingHinges;
    this.numBending = hinges.length;
    this.bendI0 = new Int32Array(this.numBending);
    this.bendI1 = new Int32Array(this.numBending);
    this.bendI2 = new Int32Array(this.numBending);
    this.bendI3 = new Int32Array(this.numBending);
    this.bendRestAngle = new Float32Array(this.numBending);
    this.bendInitialAngle = new Float32Array(this.numBending);
    this.bendGeom = new Float32Array(this.numBending);

    for (let i = 0; i < this.numBending; i++) {
      const [i0, i1, i2, i3] = hinges[i];
      this.bendI0[i] = i0;
      this.bendI1[i] = i1;
      this.bendI2[i] = i2;
      this.bendI3[i] = i3;
      const ang = this._computeDihedralAngle(this.restPos, i0, i1, i2, i3);
      this.bendRestAngle[i] = ang;
      this.bendInitialAngle[i] = ang;
      // Discrete-shell hinge stiffness: k = D · 3|e|² / (A1 + A2)  (Grinspun et al.)
      const ex = this.restPos[3 * i1] - this.restPos[3 * i0];
      const ey = this.restPos[3 * i1 + 1] - this.restPos[3 * i0 + 1];
      const ez = this.restPos[3 * i1 + 2] - this.restPos[3 * i0 + 2];
      const areas = this._triArea(this.restPos, i0, i1, i2) + this._triArea(this.restPos, i0, i1, i3);
      this.bendGeom[i] = areas > 1e-12 ? (3 * (ex * ex + ey * ey + ez * ez)) / areas : 0;
    }

    // Build 1-ring + 2-ring adjacency sets for self-collision exclusion
    const adj1 = Array.from({ length: N }, () => new Set());
    for (let i = 0; i < this.numStretch; i++) {
      adj1[this.stretchA[i]].add(this.stretchB[i]);
      adj1[this.stretchB[i]].add(this.stretchA[i]);
    }
    // Stored flat (CSR) so the collision pass can mark them in a typed array instead of Set lookups
    const exclLists = [];
    let exclTotal = 0;
    for (let i = 0; i < N; i++) {
      const s = new Set(adj1[i]);
      s.add(i);
      for (const n1 of adj1[i]) {
        for (const n2 of adj1[n1]) {
          s.add(n2);
        }
      }
      exclLists.push(s);
      exclTotal += s.size;
    }
    this.exclStart = new Int32Array(N + 1);
    this.exclIdx = new Int32Array(exclTotal);
    let off = 0;
    for (let i = 0; i < N; i++) {
      this.exclStart[i] = off;
      for (const j of exclLists[i]) this.exclIdx[off++] = j;
    }
    this.exclStart[N] = off;
    this.exclMark = new Int32Array(N).fill(-1);

    // Per-frame aerodynamic impulses and pressure forces (reused to avoid allocations)
    this.aeroForces = new Float32Array(N * 3);
    this.pressForces = new Float32Array(N * 3);

    // Spatial hash buffers (zero-allocation per step)
    this.hashSize = 8192;
    while (this.hashSize < 2 * N) this.hashSize *= 2;
    this.cellStart = new Int32Array(this.hashSize + 1);
    this.cellEntries = new Int32Array(N);
    this.vertCellHash = new Int32Array(N);

    // Interactive mouse drag / wrinkle brush state
    this.dragVertex = -1;
    this.dragTarget = [0, 0, 0];
    this.dragPatch = []; // [{ idx, weight, ox, oy, oz }]
    this.dragHandleGroup = null; // 'left' | 'right' | null
    this.dragHandleStart = [0, 0, 0];
    this.dragPinStarts = []; // [{ idx, x, y, z }]
    this.wrinkleMode = false;

    // Temporary external sculpt/gust forces (used for reference pose warm-up or air gusts)
    this.extForces = new Float32Array(N * 3);

    // Optional obstacle made of solid pieces (see setCollider)
    this.collider = null;
    this.colliderTop = -Infinity;
  }

  _computeDihedralAngle(p, i0, i1, i2, i3) {
    const p0x = p[3 * i0], p0y = p[3 * i0 + 1], p0z = p[3 * i0 + 2];
    const ex = p[3 * i1] - p0x, ey = p[3 * i1 + 1] - p0y, ez = p[3 * i1 + 2] - p0z;
    const eLen = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (eLen < 1e-7) return 0;

    const a2x = p[3 * i2] - p0x, a2y = p[3 * i2 + 1] - p0y, a2z = p[3 * i2 + 2] - p0z;
    const a3x = p[3 * i3] - p0x, a3y = p[3 * i3 + 1] - p0y, a3z = p[3 * i3 + 2] - p0z;

    // n1 = e x a2, n2 = a3 x e
    let n1x = ey * a2z - ez * a2y;
    let n1y = ez * a2x - ex * a2z;
    let n1z = ex * a2y - ey * a2x;
    const n1Len = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z);

    let n2x = a3y * ez - a3z * ey;
    let n2y = a3z * ex - a3x * ez;
    let n2z = a3x * ey - a3y * ex;
    const n2Len = Math.sqrt(n2x * n2x + n2y * n2y + n2z * n2z);

    if (n1Len < 1e-7 || n2Len < 1e-7) return 0;
    n1x /= n1Len; n1y /= n1Len; n1z /= n1Len;
    n2x /= n2Len; n2y /= n2Len; n2z /= n2Len;

    const cosT = Math.max(-1, Math.min(1, n1x * n2x + n1y * n2y + n1z * n2z));
    // Sign via (n1 x n2) . (e / eLen)
    const cx = n1y * n2z - n1z * n2y;
    const cy = n1z * n2x - n1x * n2z;
    const cz = n1x * n2y - n1y * n2x;
    const sinT = (cx * ex + cy * ey + cz * ez) / eLen;
    return Math.atan2(sinT, cosT);
  }

  _triArea(p, a, b, c) {
    const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
    const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  }

  /** Vertex masses from the areal density (pinned vertices keep zero inverse mass). */
  updateMasses() {
    const rho = Math.max(1e-4, this.params.density);
    let mean = 0;
    for (let i = 0; i < this.numVerts; i++) mean += this.vertArea[i];
    mean /= this.numVerts;
    for (let i = 0; i < this.numVerts; i++) {
      const A = this.vertArea[i] > 0 ? this.vertArea[i] : mean;
      this.baseInvMass[i] = 1 / (rho * A);
      this.invMass[i] = this.pinned[i] ? 0 : this.baseInvMass[i];
    }
  }

  /** Sets a UI parameter; during warm-up, air settings are stored and applied when it ends. */
  setParam(key, value) {
    if (this.warmup && key in this.warmupSaved) this.warmupSaved[key] = value;
    else this.params[key] = value;
    if (key === 'density') this.updateMasses();
  }

  /** Back to the rest shape: no motion, no creases, nothing pinned. */
  resetToRest() {
    this.cancelReferencePose();
    this.pos.set(this.restPos);
    this.prevPos.set(this.restPos);
    this.vel.fill(0);
    this.extForces.fill(0);
    this.bendRestAngle.set(this.bendInitialAngle);
    this.clearPins();
  }

  /** Bag only: flat bag hanging from both handles. */
  resetFlat() {
    this.resetToRest();
    this.pinHandles(
      { x: -0.125, y: 0.56, z: 0.0 },
      { x: 0.125, y: 0.56, z: 0.0 }
    );
  }

  /** Fixes the given vertices where they are now. */
  pinVertices(list) {
    for (const i of list) {
      if (this.pinned[i]) continue;
      this.pinned[i] = 1;
      this.invMass[i] = 0;
      for (let k = 0; k < 3; k++) {
        this.pinTarget[3 * i + k] = this.pos[3 * i + k];
        this.prevPos[3 * i + k] = this.pos[3 * i + k];
      }
      this.vel[3 * i] = this.vel[3 * i + 1] = this.vel[3 * i + 2] = 0;
    }
  }

  /** Releases the given vertices (they become ordinary film again). */
  releaseVertices(list) {
    for (const i of list) {
      if (!this.pinned[i]) continue;
      this.pinned[i] = 0;
      this.invMass[i] = this.baseInvMass[i];
    }
  }

  /** Makes exactly this set of vertices fixed (new ones where they are now); releases all others. */
  setPinnedSet(want) {
    const release = [];
    for (let i = 0; i < this.numVerts; i++) if (this.pinned[i] && !want.has(i)) release.push(i);
    this.releaseVertices(release);
    this.pinVertices(want);
  }

  /** Fixes exactly the vertices of the named groups and releases every other vertex. */
  setPinnedGroups(names) {
    const want = new Set();
    for (const n of names) for (const i of this.pinGroups[n] ?? []) want.add(i);
    this.setPinnedSet(want);
  }

  /** Set of currently pinned vertices. */
  pinnedSet() {
    const out = new Set();
    for (let i = 0; i < this.numVerts; i++) if (this.pinned[i]) out.add(i);
    return out;
  }

  clearPins() {
    this.pinned.fill(0);
    this.invMass.set(this.baseInvMass);
  }

  pinHandles(leftOffset, rightOffset) {
    // Compute centroids of left and right handle tips in rest space
    const pinGroup = (indices, target) => {
      if (indices.length === 0) return;
      let cx = 0, cy = 0, cz = 0;
      for (const idx of indices) {
        cx += this.restPos[3 * idx];
        cy += this.restPos[3 * idx + 1];
        cz += this.restPos[3 * idx + 2];
      }
      cx /= indices.length;
      cy /= indices.length;
      cz /= indices.length;

      for (const idx of indices) {
        this.pinned[idx] = 1;
        this.invMass[idx] = 0.0;
        const dx = (this.restPos[3 * idx] - cx) * 0.45;
        const dy = (this.restPos[3 * idx + 1] - cy) * 0.45;
        const dz = (this.restPos[3 * idx + 2] - cz) * 0.45;
        this.pinTarget[3 * idx] = target.x + dx;
        this.pinTarget[3 * idx + 1] = target.y + dy;
        this.pinTarget[3 * idx + 2] = target.z + dz;
        this.pos[3 * idx] = this.pinTarget[3 * idx];
        this.pos[3 * idx + 1] = this.pinTarget[3 * idx + 1];
        this.pos[3 * idx + 2] = this.pinTarget[3 * idx + 2];
        this.prevPos[3 * idx] = this.pinTarget[3 * idx];
        this.prevPos[3 * idx + 1] = this.pinTarget[3 * idx + 1];
        this.prevPos[3 * idx + 2] = this.pinTarget[3 * idx + 2];
      }
    };

    pinGroup(this.leftTipIndices, leftOffset);
    pinGroup(this.rightTipIndices, rightOffset);
  }

  /**
   * Runs a physically-driven warm-up that suspends the bag with the left handle
   * higher than the right handle and applies a temporary localized squeeze/tuck
   * on the lower-right corner so plastic creases & diagonal tension folds form
   * naturally before releasing into pure free-hanging equilibrium.
   */
  simulateReferencePose(steps = 170) {
    this.beginReferencePose(steps);
    while (this.isWarmingUp()) this.advanceReferencePose(steps);
  }

  /** Starts an incremental reference-pose warm-up (advance it with advanceReferencePose). */
  beginReferencePose(steps = 170) {
    this.pos.set(this.restPos);
    this.prevPos.set(this.restPos);
    this.vel.fill(0);
    this.extForces.fill(0);
    this.bendRestAngle.set(this.bendInitialAngle);
    this.clearPins();

    // Rotate 3/4 view angle (~26 deg) matching the reference photograph
    const cosR = Math.cos(0.45);
    const sinR = Math.sin(0.45);
    for (let i = 0; i < this.numVerts; i++) {
      const x = this.pos[3 * i];
      const z = this.pos[3 * i + 2];
      this.pos[3 * i] = x * cosR - z * sinR;
      this.pos[3 * i + 2] = x * sinR + z * cosR;
      this.pos[3 * i + 1] += 0.11; // Elevate so entire bag floats cleanly above floor shadow
      this.prevPos[3 * i] = this.pos[3 * i];
      this.prevPos[3 * i + 1] = this.pos[3 * i + 1];
      this.prevPos[3 * i + 2] = this.pos[3 * i + 2];
    }

    // Pin handles suspended in mid-air: left handle tall & forward, right handle lower & back
    this.pinHandles(
      { x: -0.105, y: 0.61, z: 0.05 },
      { x: 0.108, y: 0.495, z: -0.05 }
    );

    // If a warm-up was already running, keep the user's original values
    if (!this.warmup) {
      this.warmupSaved = {
        dragCoeff: this.params.dragCoeff,
        pressure: this.params.pressure,
        windSpeed: this.params.windSpeed,
        gravityTilt: this.params.gravityTilt,
      };
    }
    this.params.gravityTilt = 0; // and with gravity straight down
    // The reference pose always forms the same way: still air, no aerodynamic damping
    this.params.windSpeed = 0;
    this.params.dragCoeff = 0;
    this.params.pressure = 0;
    this.warmup = { step: 0, total: steps };
  }

  isWarmingUp() {
    return !!this.warmup;
  }

  /** Warm-up progress in [0, 1]. */
  warmupProgress() {
    return this.warmup ? this.warmup.step / this.warmup.total : 1;
  }

  /** Runs up to maxSteps warm-up steps; returns true when the warm-up has finished. */
  advanceReferencePose(maxSteps = 1) {
    if (!this.warmup) return true;
    const dt = 1 / 60;
    const steps = this.warmup.total;
    for (let n = 0; n < maxSteps && this.warmup.step < steps; n++) {
      const s = this.warmup.step++;
      this.extForces.fill(0);
      if (s < steps * 0.72) {
        const env = Math.sin((s / (steps * 0.72)) * Math.PI);
        const strength = env * 30.0;
        for (let i = 0; i < this.numVerts; i++) {
          if (this.pinned[i]) continue;
          const x = this.pos[3 * i];
          const y = this.pos[3 * i + 1];
          const z = this.pos[3 * i + 2];

          // 1. Lower-right inward tuck & upward crumple pocket
          if (x > 0.00 && y < 0.36) {
            const wx = Math.min(1, x / 0.13);
            const wy = Math.min(1, (0.36 - y) / 0.18);
            const w = wx * wy;
            this.extForces[3 * i] -= w * strength * 1.15;
            this.extForces[3 * i + 1] += w * strength * 0.85;
            this.extForces[3 * i + 2] -= w * strength * 0.75 * Math.sign(z || 1);
          }

          // 2. Crisp diagonal tension-fold buckling waves (upper-left mouth -> lower-right)
          const diag = (x + 0.06) * 0.88 + (y - 0.36);
          if (y > 0.13 && y < 0.46) {
            const wave = Math.sin(diag * 68.0) + 0.45 * Math.sin(diag * 115.0 + 0.8);
            this.extForces[3 * i + 2] += wave * strength * 0.65;
          }
        }
      }
      this.step(dt);
    }

    if (this.warmup.step >= steps) this.cancelReferencePose();
    return !this.warmup;
  }

  /** Ends the warm-up (finished or interrupted) and restores the user's air settings. */
  cancelReferencePose() {
    if (!this.warmup) return;
    this.extForces.fill(0);
    this.params.dragCoeff = this.warmupSaved.dragCoeff;
    this.params.pressure = this.warmupSaved.pressure;
    this.params.windSpeed = this.warmupSaved.windSpeed;
    this.params.gravityTilt = this.warmupSaved.gravityTilt;
    this.warmup = null;
  }

  /**
   * Applies a random crumple impulse & temporary inward squeeze, then lets go.
   */
  triggerCrumpleImpulse() {
    // Squeeze towards the centre of the free film
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (let i = 0; i < this.numVerts; i++) {
      if (this.pinned[i]) continue;
      cx += this.pos[3 * i]; cy += this.pos[3 * i + 1]; cz += this.pos[3 * i + 2]; n++;
    }
    if (n === 0) return;
    cx /= n; cy /= n; cz /= n;
    for (let i = 0; i < this.numVerts; i++) {
      if (this.pinned[i]) continue;
      const dx = cx - this.pos[3 * i];
      const dy = cy - this.pos[3 * i + 1];
      const dz = cz - this.pos[3 * i + 2];
      const noise = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      this.vel[3 * i] += dx * 4.5 + (noise - 0.5) * 0.8;
      this.vel[3 * i + 1] += dy * 3.5;
      this.vel[3 * i + 2] += dz * 6.0 + Math.cos(i * 7.13) * 0.6;
    }
  }

  triggerAirGust() {
    for (let i = 0; i < this.numVerts; i++) {
      if (this.pinned[i]) continue;
      const y = this.pos[3 * i + 1];
      const gust = (1.2 + 0.6 * Math.sin(y * 10.0));
      this.vel[3 * i] += gust * 0.9;
      this.vel[3 * i + 1] += 0.35;
      this.vel[3 * i + 2] += (Math.sin(i * 3.7) * 0.5 + 0.4) * 0.8;
    }
  }

  /** Advances one frame (all substeps at once). */
  step(dt) {
    this.beginStep(dt);
    for (let k = 0; k < this._st.substeps; k++) this.substep(k);
    this.endStep();
  }

  /**
   * First part of a frame: aerodynamics (once per frame) and the per-frame constants.
   * Then run substep(0 .. substeps-1) and endStep(). Split this way so a slow frame can be
   * spread over several screen refreshes and the page stays responsive.
   */
  beginStep(dt) {
    const substeps = this.params.substeps;
    const sdt = dt / substeps;
    const N = this.numVerts;

    // Aerodynamics, once per frame, as impulses (N·s) per vertex:
    //  - Drag of each facet against the air (still air or wind), normal to the facet:
    //    F = ½ ρ_air Cd A v_rel|v_rel|. Integrated implicitly over the frame
    //    (v' = v / (1 + k|v|dt), k = ½ ρ_air Cd / ρ_film) so it is stable even for very light film.
    //  - Internal overpressure p (Pa) on the bag body: F = p A along the facet normal.
    const impulses = this.aeroForces;
    impulses.fill(0);
    const press = this.pressForces; // pressure is a steady force: applied every substep, not as one kick
    press.fill(0);
    const P = this.params;
    const rhoFilm = Math.max(1e-4, P.density);
    const kDrag = (0.5 * 1.2 * Math.max(0, P.dragCoeff)) / rhoFilm; // 1/m
    const pressure = P.pressure;
    const windOn = P.windSpeed > 0.01;
    const az = (P.windAzimuth * Math.PI) / 180;
    const el = (P.windElevation * Math.PI) / 180;
    // Azimuth 0° = towards +X (right), 90° = towards -Z (away from the default camera)
    const wdx = Math.cos(el) * Math.cos(az), wdy = Math.sin(el), wdz = -Math.cos(el) * Math.sin(az);
    // Horizontal perpendicular (for gusts that swing sideways)
    const wpx = Math.sin(az), wpz = Math.cos(az);
    const turb = Math.max(0, Math.min(1, P.windTurbulence));
    const tm = this.time;
    const shadow = windOn && P.windShadow ? this._windShadow(wdx, wdy, wdz) : null;

    for (let t = 0; t < this.numTris; t++) {
      const i0 = this.indices[3 * t];
      const i1 = this.indices[3 * t + 1];
      const i2 = this.indices[3 * t + 2];

      const x0 = this.pos[3 * i0], y0 = this.pos[3 * i0 + 1], z0 = this.pos[3 * i0 + 2];
      const e1x = this.pos[3 * i1] - x0, e1y = this.pos[3 * i1 + 1] - y0, e1z = this.pos[3 * i1 + 2] - z0;
      const e2x = this.pos[3 * i2] - x0, e2y = this.pos[3 * i2 + 1] - y0, e2z = this.pos[3 * i2 + 2] - z0;

      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const area2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (area2 < 1e-9) continue;
      const area = 0.5 * area2;
      nx /= area2; ny /= area2; nz /= area2;

      const vx = (this.vel[3 * i0] + this.vel[3 * i1] + this.vel[3 * i2]) / 3;
      const vy = (this.vel[3 * i0 + 1] + this.vel[3 * i1 + 1] + this.vel[3 * i2 + 1]) / 3;
      const vz = (this.vel[3 * i0 + 2] + this.vel[3 * i1 + 2] + this.vel[3 * i2 + 2]) / 3;

      const vn = vx * nx + vy * ny + vz * nz;

      const avgY = (y0 + this.pos[3 * i1 + 1] + this.pos[3 * i2 + 1]) / 3;
      const bodyMask = this.pressureMask[t]; // where internal pressure acts
      let wn = 0; // air velocity along the normal
      if (windOn) {
        const cx = (x0 * 3 + e1x + e2x) / 3, cy = avgY, cz = (z0 * 3 + e1z + e2z) / 3;
        let gust = 1, swing = 0, lift = 0;
        if (turb > 0) {
          // Smooth gusts: slow overall surges + faster ripples that travel across the film
          gust = 1 + turb * (0.45 * Math.sin(0.9 * tm + 0.3) + 0.35 * Math.sin(2.3 * tm + 7 * cx - 5 * cy) +
            0.25 * Math.sin(5.1 * tm - 9 * cz + 6 * cy));
          if (gust < 0) gust = 0;
          swing = turb * 0.35 * Math.sin(0.7 * tm + 3 * cy + 1.1);
          lift = turb * 0.25 * Math.sin(1.3 * tm + 4 * cx);
        }
        const sp = P.windSpeed * gust * (shadow ? shadow[t] : 1);
        const wx = sp * (wdx + swing * wpx);
        const wy = sp * (wdy + lift);
        const wz = sp * (wdz + swing * wpz);
        wn = wx * nx + wy * ny + wz * nz;
      }
      const vrel = vn - wn; // film speed relative to the air, along the normal
      const dvn = -vrel * (1 - 1 / (1 + kDrag * Math.abs(vrel) * dt)); // implicit quadratic drag
      // Drag impulse on the facet (its film mass times the velocity change), shared by its corners
      const F = (pressure * area * bodyMask) / 3;
      if (F !== 0) {
        press[3 * i0] += F * nx; press[3 * i0 + 1] += F * ny; press[3 * i0 + 2] += F * nz;
        press[3 * i1] += F * nx; press[3 * i1 + 1] += F * ny; press[3 * i1 + 2] += F * nz;
        press[3 * i2] += F * nx; press[3 * i2 + 1] += F * ny; press[3 * i2 + 2] += F * nz;
      }
      const J = (rhoFilm * area * dvn) / 3;
      if (J === 0) continue;
      const jx = J * nx, jy = J * ny, jz = J * nz;
      impulses[3 * i0] += jx; impulses[3 * i0 + 1] += jy; impulses[3 * i0 + 2] += jz;
      impulses[3 * i1] += jx; impulses[3 * i1 + 1] += jy; impulses[3 * i1 + 2] += jz;
      impulses[3 * i2] += jx; impulses[3 * i2 + 1] += jy; impulses[3 * i2 + 2] += jz;
    }
    for (let i = 0; i < N; i++) {
      const w = this.invMass[i];
      if (w === 0) continue;
      this.vel[3 * i] += impulses[3 * i] * w;
      this.vel[3 * i + 1] += impulses[3 * i + 1] * w;
      this.vel[3 * i + 2] += impulses[3 * i + 2] * w;
    }

    // Gravity vector: tilted away from straight down towards the azimuth (0° = +X, 90° = -Z)
    const gt = (P.gravityTilt * Math.PI) / 180, ga = (P.gravityAzimuth * Math.PI) / 180;
    const gx = P.gravity * Math.sin(gt) * Math.cos(ga);
    const gy = -P.gravity * Math.cos(gt);
    const gz = -P.gravity * Math.sin(gt) * Math.sin(ga);
    const damp = Math.exp(-Math.max(0, P.viscosity) * sdt); // viscous damping per substep
    // XPBD compliances (inverse stiffness) divided by the substep squared
    const stretchAlpha = 1 / (Math.max(1, P.stretchStiffness) * sdt * sdt);
    const bendAlphaScale = 1 / (Math.max(1e-10, P.bendStiffness) * sdt * sdt); // ÷ per-hinge geometry

    this._st = { dt, substeps, sdt, N, press, gx, gy, gz, damp, stretchAlpha, bendAlphaScale, P };
  }

  /** One substep: integrate, drag, constraints, collisions, velocities. */
  substep(step) {
    const { substeps, sdt, N, press, gx, gy, gz, damp, stretchAlpha, bendAlphaScale, P } = this._st;
    // 1. Integrate velocities & predict positions
    for (let i = 0; i < N; i++) {
      if (this.pinned[i]) {
        this.pos[3 * i] = this.pinTarget[3 * i];
        this.pos[3 * i + 1] = this.pinTarget[3 * i + 1];
        this.pos[3 * i + 2] = this.pinTarget[3 * i + 2];
        this.prevPos[3 * i] = this.pinTarget[3 * i];
        this.prevPos[3 * i + 1] = this.pinTarget[3 * i + 1];
        this.prevPos[3 * i + 2] = this.pinTarget[3 * i + 2];
        continue;
      }

      const ix = 3 * i, iy = ix + 1, iz = ix + 2;
      this.prevPos[ix] = this.pos[ix];
      this.prevPos[iy] = this.pos[iy];
      this.prevPos[iz] = this.pos[iz];

      // Gravity, warm-up sculpting and pressure (aerodynamic drag was applied above, per frame)
      const w = this.invMass[i];
      this.vel[ix] += (gx + this.extForces[ix] + press[ix] * w) * sdt;
      this.vel[iy] += (gy + this.extForces[iy] + press[iy] * w) * sdt;
      this.vel[iz] += (gz + this.extForces[iz] + press[iz] * w) * sdt;

      // Viscous damping (air viscosity / internal friction of the material)
      this.vel[ix] *= damp;
      this.vel[iy] *= damp;
      this.vel[iz] *= damp;

      this.pos[ix] += this.vel[ix] * sdt;
      this.pos[iy] += this.vel[iy] * sdt;
      this.pos[iz] += this.vel[iz] * sdt;
    }

    // Interactive handle-tip dragging (moves the suspended handle pin)
    if (this.dragHandleGroup) {
      const dx = this.dragTarget[0] - this.dragHandleStart[0];
      const dy = this.dragTarget[1] - this.dragHandleStart[1];
      const dz = this.dragTarget[2] - this.dragHandleStart[2];
      for (let k = 0; k < this.dragPinStarts.length; k++) {
        const item = this.dragPinStarts[k];
        this.pinTarget[3 * item.idx] = item.x + dx;
        this.pinTarget[3 * item.idx + 1] = item.y + dy;
        this.pinTarget[3 * item.idx + 2] = item.z + dz;
      }
    }

    // Interactive mouse drag / soft-radius pinch-wrinkle
    if (this.dragVertex >= 0) {
      for (let k = 0; k < this.dragPatch.length; k++) {
        const { idx, weight, ox, oy, oz } = this.dragPatch[k];
        if (this.pinned[idx]) continue;
        const pIdx = 3 * idx;
        if (this.wrinkleMode) {
          const px = this.dragTarget[0] - this.pos[pIdx];
          const py = this.dragTarget[1] - this.pos[pIdx + 1];
          const pz = this.dragTarget[2] - this.pos[pIdx + 2];
          const jitter = Math.sin(idx * 19.37) * 0.003;
          this.pos[pIdx] += px * 0.35 * weight;
          this.pos[pIdx + 1] += py * 0.35 * weight;
          this.pos[pIdx + 2] += (pz * 0.35 + jitter) * weight;
        } else {
          // Pull patch toward dragTarget + its initial offset so the bag follows the cursor cleanly
          const tx = this.dragTarget[0] + ox;
          const ty = this.dragTarget[1] + oy;
          const tz = this.dragTarget[2] + oz;
          const pull = 0.78 * weight;
          this.pos[pIdx] += (tx - this.pos[pIdx]) * pull;
          this.pos[pIdx + 1] += (ty - this.pos[pIdx + 1]) * pull;
          this.pos[pIdx + 2] += (tz - this.pos[pIdx + 2]) * pull;
        }
      }
    }

    // 2. Solve Stretch Constraints (extra passes on finer meshes keep the film from sagging)
    for (let it = 0; it < this.stretchIters; it++) {
      for (let c = 0; c < this.numStretch; c++) {
        const a = this.stretchA[c];
        const b = this.stretchB[c];
        const w1 = this.invMass[a];
        const w2 = this.invMass[b];
        const wSum = w1 + w2;
        if (wSum === 0) continue;

        const ia = 3 * a, ib = 3 * b;
        const dx = this.pos[ib] - this.pos[ia];
        const dy = this.pos[ib + 1] - this.pos[ia + 1];
        const dz = this.pos[ib + 2] - this.pos[ia + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-8) continue;

        const C = len - this.stretchRestLen[c];
        const lambda = -C / (wSum + stretchAlpha);
        const scale = lambda / len;

        if (w1 > 0) {
          this.pos[ia] -= dx * scale * w1;
          this.pos[ia + 1] -= dy * scale * w1;
          this.pos[ia + 2] -= dz * scale * w1;
        }
        if (w2 > 0) {
          this.pos[ib] += dx * scale * w2;
          this.pos[ib + 1] += dy * scale * w2;
          this.pos[ib + 2] += dz * scale * w2;
        }
      }
    }

    // 3. Solve Dihedral Bending Constraints
    this._solveBending(bendAlphaScale);

    // 4. Floor Collision
    const floorY = this.params.floorY;
    const keep = 1 - Math.max(0, Math.min(1, P.friction)); // share of sliding motion kept
    for (let i = 0; i < N; i++) {
      if (this.pinned[i]) continue;
      const iy = 3 * i + 1;
      if (this.pos[iy] < floorY) {
        this.pos[iy] = floorY;
        // Floor friction
        this.pos[3 * i] = this.prevPos[3 * i] + (this.pos[3 * i] - this.prevPos[3 * i]) * keep;
        this.pos[3 * i + 2] = this.prevPos[3 * i + 2] + (this.pos[3 * i + 2] - this.prevPos[3 * i + 2]) * keep;
      }
    }

    // 4b. Obstacle
    if (this.collider) this._solveCollider();

    // 5. Self-Collision (run once per frame on last substep to prevent CPU spikes/stuttering)
    if (this.params.selfCollision && step === substeps - 1) {
      this._solveSelfCollision();
    }

    // 6. Update velocities from position change (with velocity clamp & NaN guard)
    const invSdt = 1.0 / sdt;
    const maxVel = 4.5;
    for (let i = 0; i < N; i++) {
      if (this.pinned[i]) continue;
      const ix = 3 * i, iy = ix + 1, iz = ix + 2;
      if (!Number.isFinite(this.pos[ix]) || !Number.isFinite(this.pos[iy]) || !Number.isFinite(this.pos[iz])) {
        this.pos[ix] = this.prevPos[ix];
        this.pos[iy] = this.prevPos[iy];
        this.pos[iz] = this.prevPos[iz];
        this.vel[ix] = 0; this.vel[iy] = 0; this.vel[iz] = 0;
        continue;
      }
      let vx = (this.pos[ix] - this.prevPos[ix]) * invSdt;
      let vy = (this.pos[iy] - this.prevPos[iy]) * invSdt;
      let vz = (this.pos[iz] - this.prevPos[iz]) * invSdt;
      const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vLen > maxVel) {
        const s = maxVel / vLen;
        vx *= s; vy *= s; vz *= s;
      }
      this.vel[ix] = vx;
      this.vel[iy] = vy;
      this.vel[iz] = vz;
    }
  }

  /** Last part of a frame: simulated time and plastic crease memory. */
  endStep() {
    const dt = this._st.dt;
    this.time += dt;

    // 7. Elasto-Plastic Crease Memory Update (once per frame)
    if (this.params.plasticity > 0.001) {
      const plast = this.params.plasticity;
      const yieldAngle = this.yieldAngle; // ~15 deg (at reference resolution) elastic threshold before plastic creasing
      const maxPlastic = 2.15;
      for (let h = 0; h < this.numBending; h++) {
        const theta = this._computeDihedralAngle(
          this.pos,
          this.bendI0[h],
          this.bendI1[h],
          this.bendI2[h],
          this.bendI3[h]
        );
        let diff = theta - this.bendRestAngle[h];
        if (diff > Math.PI) diff -= 2 * Math.PI;
        if (diff < -Math.PI) diff += 2 * Math.PI;

        const absDiff = Math.abs(diff);
        if (absDiff > yieldAngle) {
          const excess = (absDiff - yieldAngle) * Math.sign(diff);
          let nextRest = this.bendRestAngle[h] + excess * plast * 0.14;
          if (nextRest > maxPlastic) nextRest = maxPlastic;
          if (nextRest < -maxPlastic) nextRest = -maxPlastic;
          this.bendRestAngle[h] = nextRest;
        }
      }
    }
  }

  /**
   * Obstacle made of solid pieces (see obstacles.js), placed at (x, z) on the floor, rotated about
   * the vertical axis by rot degrees and scaled uniformly. null / no pieces = no obstacle.
   */
  setCollider(c) {
    if (!c || !c.parts || c.parts.length === 0) {
      this.collider = null;
      this.colliderTop = -Infinity;
      return;
    }
    const rot = ((c.rot ?? 0) * Math.PI) / 180;
    const s = Math.max(0.01, c.scale ?? 1);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const grow = (p, r) => {
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], p[k] - r);
        mx[k] = Math.max(mx[k], p[k] + r);
      }
    };
    for (const q of c.parts) {
      if (q.type === 'box') { grow([q.c[0] - q.h[0], q.c[1] - q.h[1], q.c[2] - q.h[2]], 0); grow([q.c[0] + q.h[0], q.c[1] + q.h[1], q.c[2] + q.h[2]], 0); }
      else if (q.type === 'sphere') grow(q.c, q.r);
      else if (q.type === 'capsule') { grow(q.a, q.r); grow(q.b, q.r); }
      else if (q.type === 'cyl') { grow([q.c[0], q.y0, q.c[1]], q.r); grow([q.c[0], q.y1, q.c[1]], q.r); }
    }
    // Per-piece bounding boxes (local, grown by the margin) to skip far pieces quickly
    const m = 0.006 / s;
    const pb = new Float32Array(6 * c.parts.length);
    c.parts.forEach((q, k) => {
      let a, b;
      if (q.type === 'box') { a = q.c.map((v, i) => v - q.h[i]); b = q.c.map((v, i) => v + q.h[i]); }
      else if (q.type === 'sphere') { a = q.c.map((v) => v - q.r); b = q.c.map((v) => v + q.r); }
      else if (q.type === 'capsule') { a = q.a.map((v, i) => Math.min(v, q.b[i]) - q.r); b = q.a.map((v, i) => Math.max(v, q.b[i]) + q.r); }
      else { a = [q.c[0] - q.r, q.y0, q.c[1] - q.r]; b = [q.c[0] + q.r, q.y1, q.c[1] + q.r]; }
      for (let i = 0; i < 3; i++) { pb[6 * k + i] = a[i] - m; pb[6 * k + 3 + i] = b[i] + m; }
    });
    this.collider = {
      parts: c.parts, x: c.x ?? 0, z: c.z ?? 0, scale: s, cos: Math.cos(rot), sin: Math.sin(rot),
      friction: c.friction ?? 0.8, min: mn, max: mx, pb,
    };
    // Highest point (world y): loose cloth starts above it
    this.colliderTop = this.params.floorY + mx[1] * s;
  }

  /**
   * Pushes a point (local obstacle frame, in L[0..2]) out of every piece it overlaps, along the
   * shortest way out. Returns true if it moved; the last surface normal is left in N[0..2].
   */
  _pushOutLocal(L, N, m) {
    const c = this.collider;
    const parts = c.parts, pb = c.pb;
    let lx = L[0], ly = L[1], lz = L[2];
    let hit = false;
    for (let k = 0; k < parts.length; k++) {
      const o = 6 * k;
      if (lx < pb[o] || lx > pb[o + 3] || ly < pb[o + 1] || ly > pb[o + 4] || lz < pb[o + 2] || lz > pb[o + 5]) continue;
      const q = parts[k];
      if (q.type === 'sphere') {
        const ex = lx - q.c[0], ey = ly - q.c[1], ez = lz - q.c[2];
        const R = q.r + m, d2 = ex * ex + ey * ey + ez * ez;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2) || 1e-9;
        N[0] = ex / d; N[1] = ey / d; N[2] = ez / d;
        lx = q.c[0] + N[0] * R; ly = q.c[1] + N[1] * R; lz = q.c[2] + N[2] * R;
      } else if (q.type === 'box') {
        const ex = lx - q.c[0], ey = ly - q.c[1], ez = lz - q.c[2];
        const px = q.h[0] + m - Math.abs(ex), pz = q.h[2] + m - Math.abs(ez);
        let py = q.h[1] + m - Math.abs(ey);
        if (px <= 0 || py <= 0 || pz <= 0) continue;
        // A box standing on the floor never pushes downwards (the floor would push back: jitter)
        if (ey < 0 && q.c[1] - q.h[1] <= 1e-3) py = Infinity;
        N[0] = 0; N[1] = 0; N[2] = 0;
        if (py <= px && py <= pz) { N[1] = ey >= 0 ? 1 : -1; ly = q.c[1] + N[1] * (q.h[1] + m); }
        else if (px <= pz) { N[0] = ex >= 0 ? 1 : -1; lx = q.c[0] + N[0] * (q.h[0] + m); }
        else { N[2] = ez >= 0 ? 1 : -1; lz = q.c[2] + N[2] * (q.h[2] + m); }
      } else if (q.type === 'capsule') {
        const ax = q.a[0], ay = q.a[1], az = q.a[2];
        const bx = q.b[0] - ax, by = q.b[1] - ay, bz = q.b[2] - az;
        const bb = bx * bx + by * by + bz * bz;
        let t = bb > 0 ? ((lx - ax) * bx + (ly - ay) * by + (lz - az) * bz) / bb : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + bx * t, cy = ay + by * t, cz = az + bz * t;
        const ex = lx - cx, ey = ly - cy, ez = lz - cz;
        const R = q.r + m, d2 = ex * ex + ey * ey + ez * ez;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2);
        if (d < 1e-9) { N[0] = 0; N[1] = 1; N[2] = 0; } else { N[0] = ex / d; N[1] = ey / d; N[2] = ez / d; }
        lx = cx + N[0] * R; ly = cy + N[1] * R; lz = cz + N[2] * R;
      } else if (q.type === 'cyl') {
        const ex = lx - q.c[0], ez = lz - q.c[1];
        const r = Math.sqrt(ex * ex + ez * ez);
        const R = q.r + m;
        if (r >= R || ly >= q.y1 + m || ly <= q.y0 - m) continue;
        const penTop = q.y1 + m - ly, penBot = q.y0 > 0 ? ly - (q.y0 - m) : Infinity, penSide = R - r;
        N[0] = 0; N[1] = 0; N[2] = 0;
        if (penTop <= penSide && penTop <= penBot) { N[1] = 1; ly = q.y1 + m; }
        else if (penBot <= penSide) { N[1] = -1; ly = q.y0 - m; }
        else {
          if (r < 1e-9) { N[0] = 1; } else { N[0] = ex / r; N[2] = ez / r; }
          lx = q.c[0] + N[0] * R; lz = q.c[1] + N[2] * R;
        }
      } else continue;
      hit = true;
    }
    L[0] = lx; L[1] = ly; L[2] = lz;
    return hit;
  }

  /**
   * Pushes free vertices out of the obstacle (plus a small margin for the film thickness) and
   * applies friction to the motion along its surface. Works in the obstacle's own frame
   * (unrotated, unscaled). After friction the point is projected once more, so on small curved
   * pieces (tubes) friction never leaves it slightly inside (which made the cloth jitter).
   */
  _solveCollider() {
    const c = this.collider;
    const s = c.scale, cs = c.cos, sn = c.sin;
    const m = 0.006 / s; // margin in local units
    const fr = Math.max(0, Math.min(1, c.friction));
    const fy = this.params.floorY;
    const p = this.pos;
    const L = this._colL ?? (this._colL = new Float64Array(3));
    const Nn = this._colN ?? (this._colN = new Float64Array(3));
    const toLocal = (wx, wy, wz) => {
      const dx = wx - c.x, dz = wz - c.z;
      L[0] = (dx * cs - dz * sn) / s;
      L[1] = (wy - fy) / s;
      L[2] = (dx * sn + dz * cs) / s;
    };
    const mu = 2 * fr; // friction coefficient (slider 0..1 -> 0..2)
    for (let i = 0; i < this.numVerts; i++) {
      if (this.pinned[i]) continue;
      const ix = 3 * i;
      const ox = p[ix], oy = p[ix + 1], oz = p[ix + 2];
      toLocal(ox, oy, oz);
      if (L[0] < c.min[0] - m || L[0] > c.max[0] + m || L[1] < c.min[1] - m || L[1] > c.max[1] + m ||
          L[2] < c.min[2] - m || L[2] > c.max[2] + m) continue;
      if (!this._pushOutLocal(L, Nn, m)) continue;
      // local -> world (scale, rotate by +rot)
      let wx0 = L[0] * s, wz0 = L[2] * s;
      const tx = c.x + wx0 * cs + wz0 * sn;
      const ty = fy + L[1] * s;
      const tz = c.z - wx0 * sn + wz0 * cs;
      const wnx = Nn[0] * cs + Nn[2] * sn, wny = Nn[1], wnz = -Nn[0] * sn + Nn[2] * cs;
      // Position-based friction (Macklin et al. 2014): the sliding of this substep is cancelled
      // while it is smaller than mu x penetration depth (static), otherwise reduced by that amount
      const depth = Math.hypot(tx - ox, ty - oy, tz - oz);
      const mx = tx - this.prevPos[ix], my = ty - this.prevPos[ix + 1], mz = tz - this.prevPos[ix + 2];
      const mn = mx * wnx + my * wny + mz * wnz;
      const sx = mx - mn * wnx, sy = my - mn * wny, sz = mz - mn * wnz; // tangential sliding
      const slide = Math.hypot(sx, sy, sz);
      const k = slide > 1e-12 ? Math.min(1, (mu * depth) / slide) : 0;
      let fx = tx - sx * k;
      let fyy = ty - sy * k;
      let fz = tz - sz * k;
      // Make sure friction did not put it back inside a curved piece
      toLocal(fx, fyy, fz);
      if (this._pushOutLocal(L, Nn, m)) {
        wx0 = L[0] * s; wz0 = L[2] * s;
        fx = c.x + wx0 * cs + wz0 * sn;
        fyy = fy + L[1] * s;
        fz = c.z - wx0 * sn + wz0 * cs;
      }
      p[ix] = fx;
      p[ix + 1] = fyy;
      p[ix + 2] = fz;
    }

    // Edge midpoints: a thin piece (bottle neck, bicycle tube, chair leg) could otherwise slip
    // between two vertices and pierce the film. If the midpoint is inside, move the edge out.
    for (let e = 0; e < this.numStretch; e++) {
      const a = this.stretchA[e], b = this.stretchB[e];
      const fa = !this.pinned[a], fb = !this.pinned[b];
      if (!fa && !fb) continue;
      const mx = (p[3 * a] + p[3 * b]) * 0.5, my = (p[3 * a + 1] + p[3 * b + 1]) * 0.5, mz = (p[3 * a + 2] + p[3 * b + 2]) * 0.5;
      toLocal(mx, my, mz);
      if (L[0] < c.min[0] - m || L[0] > c.max[0] + m || L[1] < c.min[1] - m || L[1] > c.max[1] + m ||
          L[2] < c.min[2] - m || L[2] > c.max[2] + m) continue;
      if (!this._pushOutLocal(L, Nn, m)) continue;
      const wx0 = L[0] * s, wz0 = L[2] * s;
      const dx = c.x + wx0 * cs + wz0 * sn - mx;
      const dy = fy + L[1] * s - my;
      const dz = c.z - wx0 * sn + wz0 * cs - mz;
      // Shift so the midpoint lands on the surface (a fixed end stays: the free end moves twice as far)
      const ka = fa ? (fb ? 1 : 2) : 0, kb = fb ? (fa ? 1 : 2) : 0;
      p[3 * a] += dx * ka; p[3 * a + 1] += dy * ka; p[3 * a + 2] += dz * ka;
      p[3 * b] += dx * kb; p[3 * b + 1] += dy * kb; p[3 * b + 2] += dz * kb;
    }
  }

  /**
   * Simulation quality: 'fast' (5 substeps), 'normal' (7) or 'high' (10 substeps and one more
   * stretch pass). More substeps = stiffer, more accurate film, but slower.
   */
  setQuality(q) {
    const substeps = { fast: 5, normal: 7, high: 10 }[q] ?? 7;
    this.params.substeps = substeps;
    this.stretchIters = this.baseStretchIters + (q === 'high' ? 1 : 0);
  }

  /**
   * Wind shadow: looking along the wind, a facet with another part of the film in front of it
   * (closer to where the wind comes from, on the same line of sight) only gets 25 % of the wind.
   * Uses a 2.5 cm grid on the plane perpendicular to the wind. Returns a factor per triangle.
   */
  _windShadow(dx, dy, dz) {
    const T = this.numTris, p = this.pos, I = this.indices;
    // Basis (u, v) perpendicular to the wind direction d
    let ux = -dz, uy = 0, uz = dx; // d x up
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-6) { ux = 1; uy = 0; uz = 0; ul = 1; } // wind straight up or down
    ux /= ul; uy /= ul; uz /= ul;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    const proj = this._shadowProj ?? (this._shadowProj = new Float32Array(3 * T));
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (let t = 0; t < T; t++) {
      const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
      const cx = (p[a] + p[b] + p[c]) / 3, cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3, cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
      const pu = cx * ux + cy * uy + cz * uz, pv = cx * vx + cy * vy + cz * vz;
      proj[3 * t] = pu; proj[3 * t + 1] = pv; proj[3 * t + 2] = cx * dx + cy * dy + cz * dz;
      if (pu < umin) umin = pu; if (pu > umax) umax = pu;
      if (pv < vmin) vmin = pv; if (pv > vmax) vmax = pv;
    }
    const cell = 0.025;
    const cols = Math.min(160, Math.floor((umax - umin) / cell) + 1);
    const rows = Math.min(160, Math.floor((vmax - vmin) / cell) + 1);
    const size = cols * rows;
    if (!this._shadowGrid || this._shadowGrid.length < size) this._shadowGrid = new Float32Array(size);
    const grid = this._shadowGrid;
    grid.fill(Infinity, 0, size);
    const cellOf = (t) => {
      const ci = Math.min(cols - 1, Math.floor((proj[3 * t] - umin) / cell));
      const cj = Math.min(rows - 1, Math.floor((proj[3 * t + 1] - vmin) / cell));
      return cj * cols + ci;
    };
    for (let t = 0; t < T; t++) {
      const k = cellOf(t);
      if (proj[3 * t + 2] < grid[k]) grid[k] = proj[3 * t + 2];
    }
    const out = this._shadowOut ?? (this._shadowOut = new Float32Array(T));
    for (let t = 0; t < T; t++) out[t] = proj[3 * t + 2] > grid[cellOf(t)] + 0.015 ? 0.25 : 1;
    return out;
  }

  _solveBending(alphaScale) {
    const p = this.pos;
    for (let h = 0; h < this.numBending; h++) {
      const geom = this.bendGeom[h];
      if (geom === 0) continue;
      const alpha = alphaScale / geom;
      const i0 = this.bendI0[h];
      const i1 = this.bendI1[h];
      const i2 = this.bendI2[h];
      const i3 = this.bendI3[h];

      const w0 = this.invMass[i0];
      const w1 = this.invMass[i1];
      const w2 = this.invMass[i2];
      const w3 = this.invMass[i3];
      if (w0 + w1 + w2 + w3 === 0) continue;

      const p0x = p[3 * i0], p0y = p[3 * i0 + 1], p0z = p[3 * i0 + 2];
      const ex = p[3 * i1] - p0x, ey = p[3 * i1 + 1] - p0y, ez = p[3 * i1 + 2] - p0z;
      const eLen = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (eLen < 1e-6) continue;

      const a2x = p[3 * i2] - p0x, a2y = p[3 * i2 + 1] - p0y, a2z = p[3 * i2 + 2] - p0z;
      const a3x = p[3 * i3] - p0x, a3y = p[3 * i3 + 1] - p0y, a3z = p[3 * i3 + 2] - p0z;

      // n1 = e x a2, n2 = a3 x e
      let n1x = ey * a2z - ez * a2y;
      let n1y = ez * a2x - ex * a2z;
      let n1z = ex * a2y - ey * a2x;
      const n1Len = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z);

      let n2x = a3y * ez - a3z * ey;
      let n2y = a3z * ex - a3x * ez;
      let n2z = a3x * ey - a3y * ex;
      const n2Len = Math.sqrt(n2x * n2x + n2y * n2y + n2z * n2z);

      if (n1Len < 1e-6 || n2Len < 1e-6) continue;
      n1x /= n1Len; n1y /= n1Len; n1z /= n1Len;
      n2x /= n2Len; n2y /= n2Len; n2z /= n2Len;

      const cosT = Math.max(-0.9995, Math.min(0.9995, n1x * n2x + n1y * n2y + n1z * n2z));
      const cx = n1y * n2z - n1z * n2y;
      const cy = n1z * n2x - n1x * n2z;
      const cz = n1x * n2y - n1y * n2x;
      const sinT = (cx * ex + cy * ey + cz * ez) / eLen;
      const theta = Math.atan2(sinT, cosT);

      let C = theta - this.bendRestAngle[h];
      if (C > Math.PI) C -= 2 * Math.PI;
      if (C < -Math.PI) C += 2 * Math.PI;
      if (Math.abs(C) < 1e-4) continue;
      if (C > 0.8) C = 0.8; // limit a single correction for stability
      else if (C < -0.8) C = -0.8;

      // Exact dihedral angle gradients (Bridson et al.)
      // Moving i2 in +n1 or i3 in +n2 decreases theta, so gradients are -n1/h2 and -n2/h3
      const invH2 = eLen / n1Len;
      const invH3 = eLen / n2Len;

      const q2x = -n1x * invH2, q2y = -n1y * invH2, q2z = -n1z * invH2;
      const q3x = -n2x * invH3, q3y = -n2y * invH3, q3z = -n2z * invH3;

      const invE2 = 1.0 / (eLen * eLen);
      const u2 = (a2x * ex + a2y * ey + a2z * ez) * invE2;
      const u3 = (a3x * ex + a3y * ey + a3z * ez) * invE2;

      const q1x = -(u2 * q2x + u3 * q3x);
      const q1y = -(u2 * q2y + u3 * q3y);
      const q1z = -(u2 * q2z + u3 * q3z);

      const q0x = -(q1x + q2x + q3x);
      const q0y = -(q1y + q2y + q3y);
      const q0z = -(q1z + q2z + q3z);

      const denom =
        w0 * (q0x * q0x + q0y * q0y + q0z * q0z) +
        w1 * (q1x * q1x + q1y * q1y + q1z * q1z) +
        w2 * (q2x * q2x + q2y * q2y + q2z * q2z) +
        w3 * (q3x * q3x + q3y * q3y + q3z * q3z) +
        alpha;

      if (denom < 1e-10) continue;
      const dLambda = -C / denom;

      if (w0 > 0) { p[3 * i0] += w0 * dLambda * q0x; p[3 * i0 + 1] += w0 * dLambda * q0y; p[3 * i0 + 2] += w0 * dLambda * q0z; }
      if (w1 > 0) { p[3 * i1] += w1 * dLambda * q1x; p[3 * i1 + 1] += w1 * dLambda * q1y; p[3 * i1 + 2] += w1 * dLambda * q1z; }
      if (w2 > 0) { p[3 * i2] += w2 * dLambda * q2x; p[3 * i2 + 1] += w2 * dLambda * q2y; p[3 * i2 + 2] += w2 * dLambda * q2z; }
      if (w3 > 0) { p[3 * i3] += w3 * dLambda * q3x; p[3 * i3 + 1] += w3 * dLambda * q3y; p[3 * i3 + 2] += w3 * dLambda * q3z; }
    }
  }

  _solveSelfCollision() {
    const N = this.numVerts;
    const thickness = this.params.thickness;
    const thicknessSq = thickness * thickness;
    const invCell = 1.0 / (thickness * 1.6);
    const HSIZE = this.hashSize;

    this.cellStart.fill(0);

    const hashCoord = (xi, yi, zi) => {
      const h = (xi * 92837111) ^ (yi * 689287499) ^ (zi * 283923481);
      return ((h % HSIZE) + HSIZE) % HSIZE;
    };

    for (let i = 0; i < N; i++) {
      const xi = Math.floor(this.pos[3 * i] * invCell);
      const yi = Math.floor(this.pos[3 * i + 1] * invCell);
      const zi = Math.floor(this.pos[3 * i + 2] * invCell);
      const h = hashCoord(xi, yi, zi);
      this.vertCellHash[i] = h;
      this.cellStart[h]++;
    }

    // Prefix sum
    let sum = 0;
    for (let i = 0; i < HSIZE; i++) {
      sum += this.cellStart[i];
      this.cellStart[i] = sum;
    }
    this.cellStart[HSIZE] = sum;

    // Fill entries
    for (let i = 0; i < N; i++) {
      const h = this.vertCellHash[i];
      this.cellStart[h]--;
      this.cellEntries[this.cellStart[h]] = i;
    }

    // Query neighbors
    for (let i = 0; i < N; i++) {
      const px = this.pos[3 * i];
      const py = this.pos[3 * i + 1];
      const pz = this.pos[3 * i + 2];
      const xi = Math.floor(px * invCell);
      const yi = Math.floor(py * invCell);
      const zi = Math.floor(pz * invCell);
      const exclMark = this.exclMark;
      for (let e = this.exclStart[i]; e < this.exclStart[i + 1]; e++) exclMark[this.exclIdx[e]] = i;
      const wi = this.invMass[i];

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const h = hashCoord(xi + dx, yi + dy, zi + dz);
            const start = this.cellStart[h];
            const end = Math.min(this.cellStart[h + 1], start + this.cellCap);
            for (let k = start; k < end; k++) {
              const j = this.cellEntries[k];
              if (j <= i || exclMark[j] === i) continue;
              const wj = this.invMass[j];
              const wSum = wi + wj;
              if (wSum === 0) continue;

              const rx = this.pos[3 * j] - px;
              const ry = this.pos[3 * j + 1] - py;
              const rz = this.pos[3 * j + 2] - pz;
              const dSq = rx * rx + ry * ry + rz * rz;
              if (dSq < thicknessSq && dSq > 1e-12) {
                const d = Math.sqrt(dSq);
                const push = (thickness - d) / (d * wSum) * 0.55;
                if (wi > 0) {
                  this.pos[3 * i] -= rx * push * wi;
                  this.pos[3 * i + 1] -= ry * push * wi;
                  this.pos[3 * i + 2] -= rz * push * wi;
                }
                if (wj > 0) {
                  this.pos[3 * j] += rx * push * wj;
                  this.pos[3 * j + 1] += ry * push * wj;
                  this.pos[3 * j + 2] += rz * push * wj;
                }
              }
            }
          }
        }
      }
    }
  }
}
