"use strict";

(function (Aura) {
  /**
   * Item icons, painted face-on. The block generator draws tiles, which are isometric, so a blade rendered as a block
   * comes out a lump; an icon is a silhouette plus soft shading — the inside of the shape lifts towards the light at
   * the upper left, the rim stays dark — which is how the ingots, hides and leather already in the sheets are drawn.
   *
   * Nothing here touches the DOM: it returns pixels, and the Atlas writes them into the cell with the rest of its undo.
   */
  const CELL = 64;

  const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

  /** Distance from every filled pixel to the nearest empty one, by flood: the shape's own thickness, for the shading. */
  function depthOf(m, size) {
    const d = new Int16Array(size * size).fill(-1);
    const queue = [];
    for (let i = 0; i < m.length; i++) {
      if (m[i]) continue;
      d[i] = 0;
      queue.push(i);
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], x = i % size, y = (i / size) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (d[j] !== -1) continue;
        d[j] = d[i] + 1;
        queue.push(j);
      }
    }
    return d;
  }

  /** Paints one silhouette into an RGBA cell. `shine` is the polished band a forged part has and leather does not. */
  function paint(rgba, size, inside, dark, light, { shine = 0.35, rim = 0.45, maxDepth = 6, hole = null } = {}) {
    const k = size / CELL;
    const m = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const px = (x + 0.5) / k, py = (y + 0.5) / k;
        if (inside(px, py) && !(hole && hole(px, py))) m[y * size + x] = 1;
      }
    }
    const d = depthOf(m, size);
    const a = hex(dark), b = hex(light);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (!m[i]) continue;
        const thick = Math.min(1, d[i] / (maxDepth * k));
        const face = 1 - ((x / size) * 0.55 + (y / size) * 0.45);
        let t = 0.2 + 0.55 * thick + 0.35 * face;
        if (shine > 0) t += shine * Math.exp(-Math.pow((x - y * 0.35 - size * 0.3) / (5 * k), 2));
        t = Math.max(0, Math.min(1, t)) * (d[i] <= k ? 1 - rim : 1);
        const c = mix(a, b, t), o = i * 4;
        rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
      }
    }
    return rgba;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Silhouettes, in cell pixels and written around the middle so the icon sits centred.

  const SHAPES = [
    {
      id: "blade", label: "Hoja", shine: 0.35,
      inside: (x, y) => {
        if (y < 6 || y > 56) return false;
        const dx = Math.abs(x - 32);
        if (y < 14) return dx < (y - 6) * 0.9;   // the point
        if (y < 40) return dx < 8;               // the body
        if (y < 45) return dx < 13;              // the shoulders
        return dx < 3.5;                         // the tang
      },
    },
    {
      id: "head", label: "Cabeza de hacha", shine: 0.3,
      inside: (x, y) => {
        if (y < 10 || y > 54) return false;
        const t = (y - 32) / 22;
        if (x > 30 && x < 46) return Math.abs(t) < 1;
        if (x >= 46) return Math.abs(t) < 0.55;
        return x > 8 && Math.abs(y - 32) < 10 + (30 - x) * 0.45;
      },
      hole: (x, y) => x > 34 && x < 42 && y > 24 && y < 40,
    },
    {
      id: "plate", label: "Placa", shine: 0.25,
      inside: (x, y) => {
        const dx = (x - 32) / 24, dy = (y - 32) / 20;
        return dx * dx + dy * dy < 1;
      },
    },
    {
      id: "ingot", label: "Lingote", shine: 0.3,
      inside: (x, y) => {
        if (y < 24 || y > 44) return false;
        // A cast bar: narrower at the top than at the bottom, with the corners taken off.
        const half = 14 + 6 * ((y - 24) / 20);
        const dx = Math.abs(x - 32);
        if (dx > half) return false;
        const corner = Math.min(y - 24, 44 - y);
        return corner > 2 || dx < half - (3 - corner);
      },
    },
    {
      id: "arrow", label: "Flecha", shine: 0.3,
      inside: (x, y) => {
        const dx = Math.abs(x - 32);
        if (y >= 6 && y < 22) return dx < (y - 6) * 0.55;
        if (y >= 22 && y < 56) return dx < 2.5;
        return false;
      },
    },
    {
      id: "rod", label: "Vara", shine: 0.2,
      inside: (x, y) => y > 6 && y < 58 && Math.abs(x - 32) < 3.5,
    },
    {
      id: "disc", label: "Disco", shine: 0.2,
      inside: (x, y) => {
        const dx = x - 32, dy = y - 32;
        return dx * dx + dy * dy < 22 * 22;
      },
    },
    {
      id: "sheet", label: "Lámina", shine: 0.1,
      inside: (x, y) => x > 12 && x < 52 && y > 8 && y < 56,
    },
  ];

  // The metals and materials the game already has in its sheets, as the two ends of each one's shading.
  const MATERIALS = [
    { id: "copper", label: "Cobre", dark: "#6b3419", light: "#e9924f" },
    { id: "bronze", label: "Bronce", dark: "#5d4019", light: "#d9a45c" },
    { id: "iron", label: "Hierro", dark: "#3a3f47", light: "#cdd3da" },
    { id: "steel", label: "Acero", dark: "#333b46", light: "#e4ebf2" },
    { id: "gold", label: "Oro", dark: "#7a5410", light: "#ffdb6b" },
    { id: "silver", label: "Plata", dark: "#4a5057", light: "#eef2f6" },
    { id: "stone", label: "Piedra", dark: "#3d4044", light: "#9aa0a6" },
    { id: "wood", label: "Madera", dark: "#45301c", light: "#b78a52" },
    { id: "leather", label: "Cuero", dark: "#4a2f1b", light: "#b57c47" },
    { id: "bone", label: "Hueso", dark: "#6b6350", light: "#f0e8d0" },
  ];

  /** One icon as a 64 x 64 (or `size`) RGBA block, ready to be written into a cell. */
  function makeIcon({ shape, material, shine, rim, size = CELL }) {
    const s = SHAPES.find((x) => x.id === shape) ?? SHAPES[0];
    const m = MATERIALS.find((x) => x.id === material) ?? MATERIALS[0];
    const rgba = new Uint8ClampedArray(size * size * 4);
    paint(rgba, size, s.inside, m.dark, m.light, { shine: shine ?? s.shine, rim: rim ?? 0.45, hole: s.hole ?? null });
    return rgba;
  }

  Aura.atlasIcons = { CELL, SHAPES, MATERIALS, makeIcon, paint };
})(window.Aura ??= {});
