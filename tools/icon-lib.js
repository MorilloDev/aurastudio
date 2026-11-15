"use strict";

// A small 2D painter for item icons. The block generator draws tiles, which are isometric; an item icon is seen
// face-on, so a blade rendered as a block comes out as a lump. Here a shape is a silhouette test plus soft shading:
// the inside of the shape lifts towards the light (upper left) and the rim darkens, which is how the leather, the
// hides and the ingots already in the sheet are drawn.

const CELL = 64;

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** Everything a shape is: inside(x, y) in 0..64 pixel coordinates. */
function mask(inside) {
  const m = new Uint8Array(CELL * CELL);
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++)
      if (inside(x + 0.5, y + 0.5)) m[y * CELL + x] = 1;
  return m;
}

/** Distance from every filled pixel to the nearest empty one, by flood: the shape's own thickness, for the shading. */
function depth(m) {
  const d = new Int16Array(CELL * CELL).fill(-1);
  const queue = [];
  for (let i = 0; i < m.length; i++) {
    if (m[i]) continue;
    d[i] = 0;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head], x = i % CELL, y = (i / CELL) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= CELL || ny >= CELL) continue;
      const j = ny * CELL + nx;
      if (d[j] !== -1) continue;
      d[j] = d[i] + 1;
      queue.push(j);
    }
  }
  return d;
}

/**
 * Paints one shape into an RGBA cell. `light` lands on the upper left, the rim stays dark, and `shine` adds the
 * polished band a metal part has and leather does not.
 */
function paint(rgba, inside, dark, light, { shine = 0.35, rim = 0.45, maxDepth = 6 } = {}) {
  const m = mask(inside), d = depth(m);
  const a = hex(dark), bb = hex(light);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const i = y * CELL + x;
      if (!m[i]) continue;
      const thick = Math.min(1, d[i] / maxDepth);
      // Light from the upper left, across the whole cell.
      const face = 1 - ((x / CELL) * 0.55 + (y / CELL) * 0.45);
      let t = 0.2 + 0.55 * thick + 0.35 * face;
      // The band that runs down a forged edge.
      if (shine > 0) t += shine * Math.exp(-Math.pow((x - y * 0.35 - CELL * 0.3) / 5, 2));
      t = Math.max(0, Math.min(1, t)) * (d[i] <= 1 ? 1 - rim : 1);
      const c = mix(a, bb, t), k = i * 4;
      rgba[k] = c[0]; rgba[k + 1] = c[1]; rgba[k + 2] = c[2]; rgba[k + 3] = 255;
    }
  }
}

// ── Silhouettes ────────────────────────────────────────────────────────────────────────────────────────────────────
// Each one is a test in cell pixels, written around the middle so the icon sits centred.

/** Half-width of the blade at height y: the point, the body, then the shoulders. */
const bladeShape = (x, y) => {
  if (y < 6 || y > 56) return false;
  const dx = Math.abs(x - 32);
  if (y < 14) return dx < (y - 6) * 0.9;           // the point
  if (y < 40) return dx < 8;                        // the body
  if (y < 45) return dx < 13;                       // the shoulders
  return dx < 3.5;                                  // the tang
};

const headShape = (x, y) => {
  if (y < 10 || y > 54) return false;
  const t = (y - 32) / 22;
  if (x > 30 && x < 46) return Math.abs(t) < 1;     // the eye
  if (x >= 46) return Math.abs(t) < 0.55;           // the poll
  // The bit widens as it reaches the edge.
  const span = 10 + (30 - x) * 0.45;
  return x > 8 && Math.abs(y - 32) < span;
};

const eyeHole = (x, y) => x > 34 && x < 42 && y > 24 && y < 40;

const plateShape = (x, y) => {
  const dx = (x - 32) / 24, dy = (y - 32) / 20;
  return dx * dx + dy * dy < 1;
};

const arrowShape = (x, y) => {
  const dx = Math.abs(x - 32);
  if (y >= 6 && y < 22) return dx < (y - 6) * 0.55;                       // head
  if (y >= 22 && y < 56) return dx < 2.5;                                 // shaft
  return false;
};

const fletchShape = (x, y) => {
  if (y < 40 || y > 56) return false;
  const dx = Math.abs(x - 32);
  return dx > 2.5 && dx < 2.5 + (56 - y) * 0.55;
};

module.exports = { CELL, paint, bladeShape, headShape, eyeHole, plateShape, arrowShape, fletchShape, hex, mix };
