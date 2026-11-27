/**
 * Obstacles the cloth can fall on, built from simple solid pieces (in metres, real size, floor at
 * y = 0, centred on x = z = 0). The solver tests every piece, so legs, tubes and wheels all collide.
 *   box      { c: [x, y, z], h: [hx, hy, hz] }        axis-aligned box (half sizes)
 *   sphere   { c: [x, y, z], r }
 *   capsule  { a: [x, y, z], b: [x, y, z], r }         rounded tube between two points
 *   cyl      { c: [x, z], y0, y1, r }                  vertical cylinder with flat ends
 * `color` (optional, per piece) is only for drawing. `scale` is the suggested size factor so the
 * obstacle suits the 50–70 cm cloths; `friction` (default 0.8) the suggested grip.
 */

const WOOD = '#b08a5a';
const DARK = '#374151';

function legBox(x, z, half, h) {
  return { type: 'box', c: [x, h / 2, z], h: [half, h / 2, half] };
}

/** A ring of capsules approximating a torus in the XY plane (bicycle wheel). */
function wheel(cx, cy, R, r, n = 20, color = '#1f2937') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n, a1 = (2 * Math.PI * (i + 1)) / n;
    out.push({
      type: 'capsule',
      a: [cx + R * Math.cos(a0), cy + R * Math.sin(a0), 0],
      b: [cx + R * Math.cos(a1), cy + R * Math.sin(a1), 0],
      r,
      color,
    });
  }
  return out;
}

function tube(a, b, r = 0.017, color = '#0ea5e9') {
  return { type: 'capsule', a, b, r, color };
}

function bicycle() {
  const rear = [-0.5, 0.34, 0], front = [0.5, 0.34, 0], bb = [-0.02, 0.3, 0];
  const seatTop = [-0.14, 0.78, 0], headTop = [0.36, 0.8, 0], headBot = [0.41, 0.66, 0];
  return [
    ...wheel(rear[0], rear[1], 0.33, 0.02),
    ...wheel(front[0], front[1], 0.33, 0.02),
    tube(rear, bb), // chain stay
    tube(rear, seatTop), // seat stay
    tube(bb, seatTop), // seat tube
    tube(seatTop, headTop), // top tube
    tube(bb, headBot, 0.02), // down tube
    tube(headBot, headTop, 0.022), // head tube
    tube(headBot, front, 0.014), // fork
    tube(headTop, [0.33, 0.9, 0], 0.014, DARK), // stem
    tube([0.33, 0.9, -0.24], [0.33, 0.9, 0.24], 0.013, DARK), // handlebar
    tube(seatTop, [-0.16, 0.86, 0], 0.013, DARK), // seat post
    { type: 'box', c: [-0.17, 0.885, 0], h: [0.12, 0.025, 0.06], color: '#111827' }, // saddle
    tube([bb[0], bb[1], -0.06], [bb[0], bb[1], 0.06], 0.02, DARK), // crank axle
    tube([bb[0], bb[1], 0.06], [bb[0] + 0.12, bb[1] - 0.1, 0.06], 0.012, DARK), // crank
    tube([bb[0] - 0.12, bb[1] + 0.1, -0.06], [bb[0], bb[1], -0.06], 0.012, DARK),
    { type: 'cyl', c: [rear[0], 0], y0: rear[1] - 0.02, y1: rear[1] + 0.02, r: 0.03, color: DARK }, // hubs
    { type: 'cyl', c: [front[0], 0], y0: front[1] - 0.02, y1: front[1] + 0.02, r: 0.03, color: DARK },
  ];
}

function table() {
  const top = 0.75, t = 0.04, hx = 0.6, hz = 0.4, leg = 0.025;
  return [
    { type: 'box', c: [0, top - t / 2, 0], h: [hx, t / 2, hz], color: WOOD },
    legBox(hx - 0.06, hz - 0.06, leg, top - t),
    legBox(-hx + 0.06, hz - 0.06, leg, top - t),
    legBox(hx - 0.06, -hz + 0.06, leg, top - t),
    legBox(-hx + 0.06, -hz + 0.06, leg, top - t),
  ].map((p) => ({ color: WOOD, ...p }));
}

function chair() {
  const seat = 0.45, hx = 0.22, hz = 0.21, leg = 0.018, col = '#8b5a2b';
  return [
    { type: 'box', c: [0, seat - 0.02, 0], h: [hx, 0.02, hz] },
    legBox(hx - 0.03, hz - 0.03, leg, seat - 0.04),
    legBox(-hx + 0.03, hz - 0.03, leg, seat - 0.04),
    legBox(hx - 0.03, -hz + 0.03, leg, seat - 0.04),
    legBox(-hx + 0.03, -hz + 0.03, leg, seat - 0.04),
    // Back: two posts and a rail at the back edge (-Z)
    { type: 'box', c: [hx - 0.03, seat + 0.2, -hz + 0.02], h: [leg, 0.2, leg] },
    { type: 'box', c: [-hx + 0.03, seat + 0.2, -hz + 0.02], h: [leg, 0.2, leg] },
    { type: 'box', c: [0, seat + 0.33, -hz + 0.02], h: [hx, 0.07, 0.015] },
  ].map((p) => ({ color: col, ...p }));
}

function printer3d() {
  const frame = '#4b5563';
  return [
    { type: 'box', c: [0, 0.035, 0], h: [0.24, 0.035, 0.2], color: '#1f2937' }, // base
    { type: 'box', c: [0, 0.085, 0.02], h: [0.13, 0.006, 0.13], color: '#9ca3af' }, // bed
    // Frame as rounded tubes: cloth slides smoothly around them (sharp thin boxes make it jitter)
    tube([0.2, 0.07, -0.08], [0.2, 0.44, -0.08], 0.02, frame), // uprights
    tube([-0.2, 0.07, -0.08], [-0.2, 0.44, -0.08], 0.02, frame),
    tube([-0.2, 0.44, -0.08], [0.2, 0.44, -0.08], 0.02, frame), // top bar
    tube([-0.2, 0.24, -0.06], [0.2, 0.24, -0.06], 0.01, '#d1d5db'), // X gantry rod
    { type: 'box', c: [0.02, 0.23, -0.03], h: [0.035, 0.04, 0.03], color: '#f97316' }, // print head
    { type: 'box', c: [-0.17, 0.08, 0.17], h: [0.05, 0.03, 0.02], color: '#111827' }, // screen
    // Spool on top: short disc approximated by a fat capsule across Z
    tube([0, 0.53, -0.115], [0, 0.53, -0.045], 0.07, '#22c55e'),
  ];
}

function bottle() {
  const glass = '#b91c1c';
  return [
    { type: 'cyl', c: [0, 0], y0: 0, y1: 0.19, r: 0.043 },
    { type: 'cyl', c: [0, 0], y0: 0.19, y1: 0.205, r: 0.037 },
    { type: 'cyl', c: [0, 0], y0: 0.205, y1: 0.225, r: 0.027 },
    { type: 'cyl', c: [0, 0], y0: 0.225, y1: 0.3, r: 0.016 },
    { type: 'cyl', c: [0, 0], y0: 0.285, y1: 0.305, r: 0.019, color: '#e5e7eb' },
  ].map((p) => ({ color: glass, ...p }));
}

export const OBSTACLES = {
  none: { label: 'Ninguno', scale: 1, parts: [] },
  sphere: { label: 'Esfera', scale: 1, parts: [{ type: 'sphere', c: [0, 0.15, 0], r: 0.15 }] },
  block: { label: 'Bloque', scale: 1, parts: [{ type: 'box', c: [0, 0.15, 0], h: [0.175, 0.15, 0.175] }] },
  cylinder: { label: 'Cilindro', scale: 1, parts: [{ type: 'cyl', c: [0, 0], y0: 0, y1: 0.35, r: 0.125 }] },
  table: { label: 'Mesa', scale: 0.4, parts: table() }, // 48 x 32 cm top: the 70 x 50 cm sheet overhangs ~11 cm
  chair: { label: 'Silla', scale: 0.6, parts: chair() },
  printer: { label: 'Impresora 3D', scale: 0.8, parts: printer3d() },
  bicycle: { label: 'Bicicleta', scale: 0.45, parts: bicycle() },
  bottle: { label: 'Botella', scale: 1, friction: 1, parts: bottle() }, // narrow top: needs full grip
};

/** Local bounding box of an obstacle's parts. */
export function obstacleBounds(parts) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const add = (p, r) => {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], p[k] - r[k]);
      mx[k] = Math.max(mx[k], p[k] + r[k]);
    }
  };
  for (const q of parts) {
    if (q.type === 'box') add(q.c, q.h);
    else if (q.type === 'sphere') add(q.c, [q.r, q.r, q.r]);
    else if (q.type === 'capsule') {
      add(q.a, [q.r, q.r, q.r]);
      add(q.b, [q.r, q.r, q.r]);
    } else if (q.type === 'cyl') {
      add([q.c[0], q.y0, q.c[1]], [q.r, 0, q.r]);
      add([q.c[0], q.y1, q.c[1]], [q.r, 0, q.r]);
    }
  }
  return { min: mn, max: mx };
}
