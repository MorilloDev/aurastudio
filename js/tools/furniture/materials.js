"use strict";

// Los materiales de un mueble.
//
// Con un proyecto abierto salen de Assets/Texture/Materials.png, las mismas celdas que usan los bloques: una mesa
// hecha con ellas pertenece al mundo en el que está en vez de parecer un sprite de otro juego. Sin proyecto —o si
// falta el archivo— se pintan aquí, con las mismas tres recetas que usa el generador fuera del navegador (tablas,
// veta y moteado), para que la herramienta siga sirviendo antes de abrir nada.
(function (Aura) {
  const E = Aura.blockEngine;

  // Celda de Materials.png por nombre, igual que en tools/make-tables.js.
  const CELLS = {
    log: [6, 4], log_dark: [0, 4], rope: [1, 5],
    wood: [11, 4], wood_light: [5, 4], wood_pale: [2, 4],
    panel: [10, 4], wood_dark: [0, 4],
    stone: [0, 2], cobble: [1, 2], bricks: [2, 2], darkstone: [2, 0], sandstone: [1, 3], rough_stone: [3, 5],
    iron: [1, 1], steel: [3, 6], gold: [2, 6], copper: [1, 6], bronze: [5, 6],
    ember: [4, 1], paper: [2, 5], hide: [9, 4], cloth: [0, 1], bone: [5, 1], rune: [6, 1], glass: [7, 1],
  };

  // Lo que se ofrece en el desplegable, en el orden en que se usan.
  const LIST = [
    ["wood", "Madera"], ["wood_light", "Madera clara"], ["wood_dark", "Madera oscura"], ["wood_pale", "Madera pálida"],
    ["panel", "Panelada"], ["log", "Tronco"], ["log_dark", "Tronco oscuro"],
    ["iron", "Hierro"], ["steel", "Acero"], ["copper", "Cobre"], ["bronze", "Bronce"], ["gold", "Oro"],
    ["stone", "Piedra"], ["cobble", "Adoquín"], ["bricks", "Ladrillo"], ["darkstone", "Piedra oscura"], ["sandstone", "Arenisca"],
    ["cloth", "Tela"], ["hide", "Piel"], ["rope", "Soga"], ["paper", "Papel"], ["bone", "Hueso"],
    ["glass", "Cristal"], ["rune", "Runa"], ["ember", "Brasa"],
  ];

  // ── Pintadas a mano, para cuando no hay proyecto ──────────────────────────────────────────────────────────────

  const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function paint(fn, seed = 1) {
    const w = 16, rgba = new Uint8ClampedArray(w * w * 4), rand = rng(seed);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const c = fn(x, y, rand), i = (y * w + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
      }
    }
    return { w, h: w, rgba };
  }

  const planks = (dark, light, boards = 4, seed = 1) => {
    const a = hex(dark), b = hex(light), step = 16 / boards;
    return paint((x, y, rand) => {
      const seam = y % step < 1, board = Math.floor(y / step);
      const tone = 0.35 + 0.3 * ((board * 7919 % 5) / 4) + 0.18 * (rand() - 0.5) * 2;
      const c = mix(a, b, clamp01(tone));
      return seam ? mix(c, a, 0.75) : c;
    }, seed);
  };

  const grain = (dark, light, seed = 1) => {
    const a = hex(dark), b = hex(light);
    const cols = new Array(16).fill(0).map((_, i) => 0.3 + 0.5 * ((i * 2654435761 % 97) / 96));
    return paint((x, y, rand) => mix(a, b, clamp01(cols[x] * 0.85 + 0.12 * (rand() - 0.5) * 2)), seed);
  };

  const speckle = (dark, light, seed = 1) =>
    paint((x, y, rand) => mix(hex(dark), hex(light), clamp01(0.35 + 0.5 * rand())), seed);

  const PAINTED = {
    wood: () => planks("#5a3b22", "#946238", 4, 3),
    wood_light: () => planks("#8a6238", "#c79a62", 4, 5),
    wood_dark: () => planks("#3a2616", "#5f3f24", 5, 7),
    wood_pale: () => planks("#9a7a52", "#d8bc93", 4, 11),
    panel: () => planks("#4a3120", "#7d5733", 2, 13),
    log: () => grain("#4b3420", "#8a6038", 17),
    log_dark: () => grain("#2e1f12", "#54391f", 19),
    iron: () => speckle("#4a4e55", "#8e949c", 23),
    steel: () => speckle("#5a6068", "#b2b8c0", 29),
    copper: () => speckle("#6d3b22", "#c07a46", 31),
    bronze: () => speckle("#6a4a1e", "#b08a3c", 37),
    gold: () => speckle("#8a6a12", "#e8c452", 41),
    stone: () => speckle("#55585c", "#8b9096", 43),
    cobble: () => speckle("#464a4e", "#7d838a", 47),
    bricks: () => planks("#5d3028", "#8e4a3a", 4, 53),
    darkstone: () => speckle("#2a2d33", "#4b5058", 59),
    sandstone: () => speckle("#9a8456", "#d8c48c", 61),
    cloth: () => paint((x, y, rand) => mix(hex("#5a3a52"), hex("#8e5f82"), clamp01(((x + y) % 2) * 0.35 + 0.3 + 0.2 * rand())), 67),
    hide: () => speckle("#6a4a30", "#a9825a", 71),
    rope: () => grain("#7a6238", "#b59a62", 73),
    paper: () => speckle("#b4a888", "#e4dcc4", 79),
    bone: () => speckle("#a9a287", "#e2dcc6", 83),
    glass: () => speckle("#4e7a86", "#9ecbd6", 89),
    rune: () => speckle("#2c3a6a", "#6a7ed0", 97),
    ember: () => speckle("#7a2a12", "#e07a28", 101),
  };

  /**
   * Una fuente de texturas: pide un nombre de material y devuelve el juego de caras que el motor espera. Con imagen
   * de proyecto corta su celda; sin ella pinta la receta. Cachea, porque una pieza pide el mismo material una vez
   * por grupo y el panel se redibuja al mover cualquier control.
   */
  function source(materialsImage, cellSize = 64) {
    const cache = new Map();
    return (name) => {
      if (cache.has(name)) return cache.get(name);
      let face;
      const cell = CELLS[name];
      if (materialsImage && cell) {
        const rect = { x: cell[0] * cellSize, y: cell[1] * cellSize, w: cellSize, h: cellSize };
        face = E.faceTexture(materialsImage, rect);
      } else {
        const img = (PAINTED[name] ?? PAINTED.wood)();
        face = E.faceTexture(img, { x: 0, y: 0, w: img.w, h: img.h });
      }
      const set = { top: face, left: face, right: face };
      cache.set(name, set);
      return set;
    };
  }

  Aura.furnitureMaterials = { CELLS, LIST, PAINTED, source, planks, grain, speckle };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
