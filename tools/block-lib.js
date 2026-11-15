"use strict";

// Loads the Studio's block generator outside the browser, the same way plant-lib does with the plants: shapes.js and
// engine.js have no DOM in them, so a piece built here comes out identical to one built in the Bloques tab.
// Adds what the page gets from its UI instead: flat 16 x 16 face textures, and stacking several materials into one
// sprite by depth (a wooden top on a stone base).
const fs = require("fs");
const path = require("path");
const { Sheet, encodePNG, decodePNG } = require("./plant-lib.js");

const ROOT = path.join(__dirname, "..");
for (const file of ["js/tools/blocks/shapes.js", "js/tools/blocks/hair.js", "js/tools/blocks/engine.js"]) {
  globalThis.Aura ??= {};
  new Function(fs.readFileSync(path.join(ROOT, file), "utf8"))();
}

const A = globalThis.Aura;
const E = A.blockEngine;

// ── Textures ───────────────────────────────────────────────────────────────────────────────────────────────────────

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 16 x 16 RGBA image in the shape faceTexture wants: { w, h, rgba }. paint(x, y, rand) returns [r, g, b]. */
function texture(paint, seed = 1) {
  const w = 16, rgba = new Uint8ClampedArray(w * w * 4), rand = rng(seed);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y, rand);
      const i = (y * w + x) * 4;
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  }
  return { w, h: w, rgba };
}

/** Planks: boards along x with a darker seam between them, plus grain. */
function planks(dark, light, { boards = 4, seed = 1, grain = 0.18 } = {}) {
  const a = hex(dark), b = hex(light);
  const step = 16 / boards;
  return texture((x, y, rand) => {
    const seam = y % step < 1;
    const board = Math.floor(y / step);
    const tone = 0.35 + 0.3 * ((board * 7919 % 5) / 4) + grain * (rand() - 0.5) * 2;
    const c = mix(a, b, Math.max(0, Math.min(1, tone)));
    return seam ? mix(c, a, 0.75) : c;
  }, seed);
}

/** Log or beam grain: streaks along y, no seams. */
function grainTex(dark, light, { seed = 1, streaks = 0.5 } = {}) {
  const a = hex(dark), b = hex(light);
  const cols = new Array(16).fill(0).map((_, i) => 0.3 + 0.5 * ((i * 2654435761 % 97) / 96));
  return texture((x, y, rand) => mix(a, b, Math.max(0, Math.min(1, cols[x] * (1 - streaks * 0.3) + streaks * 0.25 * (rand() - 0.5) * 2))), seed);
}

/** Mottled stone or metal: soft patches between the two colours. */
function speckle(dark, light, { seed = 1, spread = 1 } = {}) {
  const a = hex(dark), b = hex(light);
  return texture((x, y, rand) => {
    const n = (Math.sin(x * 1.7 + y * 0.9 + seed) + Math.sin(x * 0.6 - y * 1.4 + seed * 2)) * 0.25 + 0.5;
    return mix(a, b, Math.max(0, Math.min(1, n + spread * 0.18 * (rand() - 0.5) * 2)));
  }, seed);
}

/** The three faces of one material, each with its own seed so they do not repeat each other. */
function faces(make) {
  const tex = {};
  for (const [i, key] of ["top", "left", "right"].entries()) {
    const img = make(i + 1);
    tex[key] = E.faceTexture(img, { x: 0, y: 0, w: img.w, h: img.h });
  }
  return tex;
}

/**
 * The game's own material textures (Assets/Texture/Materials.png, cells of 64). A table built from these sits in the
 * world as the same material as the blocks around it, which a texture invented here never quite does.
 */
function materials(project, cellSize = 64) {
  const file = path.join(project, "App", "Content", "Assets", "Texture", "Materials.png");
  const png = decodePNG(file);
  const img = { w: png.width, h: png.height, rgba: png.rgba };
  const cache = new Map();
  return (col, row) => {
    const key = col + "," + row;
    if (!cache.has(key)) {
      const rect = { x: col * cellSize, y: row * cellSize, w: cellSize, h: cellSize };
      const face = E.faceTexture(img, rect);
      cache.set(key, { top: face, left: face, right: face });
    }
    return cache.get(key);
  };
}

// ── Render ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// Furniture, not terrain: the ragged edge the engine puts on a block's bottom (grass over a cliff) only frays the
// legs and the metal bands here.
const RENDER = { size: 64, res: 32, aoSteps: 4, cleanup: true, mask: { enabled: false } };

/**
 * One layer of a piece: boxes (in 16ths, like a tile's "collision") drawn with one material.
 * Returns what the engine gives: { color, normal, depth, mask, … }.
 */
function layer(boxes, tex, opts = {}) {
  const { facing = "front", state = "default", ...rest } = opts;
  const piece = { boxes: A.blockShapes.parseCustom(JSON.stringify(boxes)), state, facing };
  return E.render({ ...RENDER, ...rest }, tex, piece);
}

/**
 * Stacks layers into one sprite, nearest pixel wins (the engine's depth is white = near). Lets a piece be made of
 * several materials without rendering it as one, which the engine does not do: one texture set per render.
 */
function stack(layers) {
  const n = 64 * 64;
  const color = new Uint8ClampedArray(n * 4), normal = new Uint8ClampedArray(n * 4);
  const best = new Float32Array(n).fill(-1);
  for (const l of layers) {
    for (let i = 0; i < n; i++) {
      if (!l.mask[i]) continue;
      const d = l.depth[i * 4];
      if (d <= best[i]) continue;
      best[i] = d;
      for (let c = 0; c < 4; c++) {
        color[i * 4 + c] = l.color[i * 4 + c];
        normal[i * 4 + c] = l.normal[i * 4 + c];
      }
    }
  }
  return { color, normal };
}

module.exports = { A, E, Sheet, encodePNG, decodePNG, materials, texture, planks, grainTex, speckle, faces, layer, stack, hex, mix, rng };
