"use strict";

// Draws every crafting station into Tables.png / Tables_n.png and their inventory icons into Placeables.png, with the
// Studio's own block generator and the game's own material textures.
//
//   node tools/make-tables.js <carpeta del proyecto Aura> [--dry]
//
// A two-cell station is designed as ONE object 32 wide (x 0..32, y up 0..16, z front-back 0..16) and split here into
// the two cells the tile declares: x < 16 is the half at offsetX 0 (drawn up-left), x > 16 the half at offsetX 1
// (drawn down-right). Designing the whole table at once is why the legs land on its corners and the top meets in the
// middle; the two halves cannot drift apart.
//
// The tiers are three different pieces of furniture, not one repainted:
//   crude     round logs lashed with rope, nothing sawn, nothing square
//   sturdy    sawn planks, square joints, iron straps
//   mastered  panelled wood with polished metal
const path = require("path");
const L = require("./block-lib.js");

// ── Materials ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Cells of Assets/Texture/Materials.png, the same textures the blocks use, so a table belongs to the world it stands
// in instead of looking like a sprite from another game.
let tex = null;   // set in main(), once the project folder is known
const CELL = {
  log: [6, 4], logDark: [0, 4], rope: [1, 5],
  plank: [11, 4], plankPale: [5, 4], plankLight: [2, 4],
  panel: [10, 4], panelDark: [0, 4],
  stone: [0, 2], cobble: [1, 2], bricks: [2, 2], darkstone: [2, 0], sandstone: [1, 3], roughStone: [3, 5],
  iron: [1, 1], steel: [3, 6], gold: [2, 6], copper: [1, 6], bronze: [5, 6],
  ember: [4, 1], paper: [2, 5], hide: [9, 4], leather: [0, 1], bone: [5, 1], rune: [6, 1], water: [7, 1],
};
const mat = (name) => tex(...CELL[name]);

// Tier palettes: the material carries as much of the tier as the shape does.
const WOOD = { crude: "log", sturdy: "plank", mastered: "panel" };
const ROCK = { crude: "cobble", sturdy: "bricks", mastered: "darkstone" };
const METAL = { crude: "stone", sturdy: "iron", mastered: "gold" };

// ── Shape helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const b = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });

/** Cuts the four upright corners of a box, so a log or a pot reads round instead of square. */
const round = (box, k = 3) => ({
  ...box,
  cuts: [
    { n: [1, 0, 1], d: box.max[0] + box.max[2] - k },
    { n: [1, 0, -1], d: box.max[0] - box.min[2] - k },
    { n: [-1, 0, 1], d: -box.min[0] + box.max[2] - k },
    { n: [-1, 0, -1], d: -box.min[0] - box.min[2] - k },
  ],
});

/** Cuts the corners of an upright disc (a grinding wheel seen from its side), axle along x. */
const roundV = (box, k = 3) => ({
  ...box,
  cuts: [
    { n: [0, 1, 1], d: box.max[1] + box.max[2] - k },
    { n: [0, 1, -1], d: box.max[1] - box.min[2] - k },
    { n: [0, -1, 1], d: -box.min[1] + box.max[2] - k },
    { n: [0, -1, -1], d: -box.min[1] - box.min[2] - k },
  ],
});

/**
 * Legs at the four corners of EVERY cell the table covers, not just at the ends of the piece.
 *
 * This is the rule the hand-made art follows and the one that matters: the game draws the four camera angles from two
 * sprites, mirroring a cell in place and sometimes swapping the two halves. A cell only survives that if its own art
 * is left-right symmetric and both cells carry the same structure — otherwise the top and the legs stop lining up the
 * moment the camera turns, which is exactly what was wrong. Props on top may be asymmetric: they just change ends.
 */
const legs = (x0, x1, top, w = 4) => {
  const out = [];
  for (let x = x0; x < x1; x += 16) {
    out.push(b(x, 0, 0, x + w, top, w), b(x, 0, 16 - w, x + w, top, 16));
    out.push(b(x + 16 - w, 0, 0, x + 16, top, w), b(x + 16 - w, 0, 16 - w, x + 16, top, 16));
  }
  return out;
};

/** A tabletop across the whole piece, inset only front and back so the legs under it stay visible. */
const top = (x0, x1, y0, y1) => [b(x0, y0, 1, x1, y1, 15)];

/** The rope that holds a crude piece together: a band around a joint. */
const lash = (x, y, w = 2) => [b(x, y, 0, x + w, y + 2, 16)];

const layer = (boxes, m) => ({ boxes, mat: m });

/**
 * Splits a 32-wide design into the two cells of the tile. Boxes that cross the middle are cut in two, and a box's
 * corner cuts travel with it.
 */
function split(layers) {
  const far = [], near = [];
  const piece = (box, lo, hi, shift) => {
    const out = {
      min: [Math.max(box.min[0], lo) - shift, box.min[1], box.min[2]],
      max: [Math.min(box.max[0], hi) - shift, box.max[1], box.max[2]],
    };
    if (box.cuts) out.cuts = box.cuts.map((c) => ({ n: c.n, d: c.d - c.n[0] * shift }));
    return out;
  };
  for (const l of layers) {
    const f = [], n = [];
    for (const box of l.boxes) {
      if (box.min[0] < 16) f.push(piece(box, 0, 16, 0));
      if (box.max[0] > 16) n.push(piece(box, 16, 32, 16));
    }
    if (f.length) far.push({ boxes: f, mat: l.mat });
    if (n.length) near.push({ boxes: n, mat: l.mat });
  }
  return [far, near];
}

// ── Stations ───────────────────────────────────────────────────────────────────────────────────────────────────────

// General bench: logs lashed with rope, then a joined bench with a vice, then a panelled cabinet.
function workbench(tier) {
  const w = WOOD[tier], m = METAL[tier];
  if (tier === "crude") {
    return [
      layer(legs(0, 32, 12, 5), w),                                                        // a post at every corner
      layer([roundV(b(0, 12, 1, 32, 16, 8), 2), roundV(b(0, 12, 8, 32, 16, 15), 2)], w),   // two split logs for a top
      layer([b(1, 6, 6, 31, 8, 10)], w),                                                   // the beam across
      layer([...lash(1, 10), ...lash(13, 10), ...lash(17, 10), ...lash(29, 10)], "rope"),
      layer([b(10, 16, 5, 14, 16, 9)], "stone"),                                           // a stone left on it
      layer([b(19, 16, 7, 24, 16, 9)], m),
    ];
  }
  if (tier === "sturdy") {
    return [
      layer(legs(0, 32, 13), w),
      layer(top(0, 32, 13, 16), w),
      layer([b(3, 10, 2, 29, 13, 14)], w),                                                 // apron under the top
      layer([b(4, 4, 6, 28, 6, 10)], w),                                                   // stretcher
      layer([b(5, 6, 3, 27, 8, 13)], "plankPale"),                                         // boards on the shelf
      layer([b(21, 9, 13, 28, 13, 16), b(23, 13, 14, 26, 16, 16)], m),                     // vice on the front edge
      layer([b(5, 10, 1, 7, 13, 2), b(25, 10, 1, 27, 13, 2)], m),                          // iron straps
    ];
  }
  return [
    layer(legs(0, 32, 12, 3), "panelDark"),
    layer([b(3, 1, 2, 29, 12, 14)], w),                                                    // panelled cabinet
    layer(top(0, 32, 12, 15), w),
    layer([b(1, 15, 1, 31, 16, 15)], "panelDark"),                                         // moulded lip
    layer([b(4, 7, 1, 15, 11, 2), b(17, 7, 1, 28, 11, 2)], "panelDark"),                   // two drawers
    layer([b(8, 8, 0, 11, 10, 1), b(21, 8, 0, 24, 10, 1)], m),                             // their pulls
    layer([b(0, 15, 0, 4, 16, 4), b(28, 15, 0, 32, 16, 4),
           b(0, 15, 12, 4, 16, 16), b(28, 15, 12, 32, 16, 16)], m),                        // corner caps
  ];
}

// Carpentry: a log on lashed trestles, a bench with a frame saw, a joiner's bench with planed boards.
function woodworking(tier) {
  const w = WOOD[tier], m = METAL[tier];
  if (tier === "crude") {
    return [
      layer(legs(0, 32, 10, 5), w),                                                        // a trestle leg per corner
      layer([b(0, 10, 2, 32, 12, 6), b(0, 10, 10, 32, 12, 14)], w),                        // their crossbeams
      layer([roundV(b(1, 12, 5, 31, 16, 11), 2)], "logDark"),                               // the log being cut
      layer([...lash(5, 9), ...lash(25, 9)], "rope"),
      layer([b(14, 12, 1, 16, 16, 4)], m),                                                 // the axe sunk in it
      layer([b(13, 10, 0, 17, 13, 2)], w),
    ];
  }
  if (tier === "sturdy") {
    return [
      layer(legs(0, 32, 12), w),
      layer(top(0, 32, 12, 15), w),
      layer([b(3, 5, 6, 29, 7, 10)], w),                                                   // stretcher
      layer([b(4, 7, 3, 14, 9, 13)], "plankPale"),                                         // boards stored under it
      layer([b(17, 15, 3, 29, 16, 13)], "plankPale"),                                      // the workpiece
      layer([b(21, 15, 1, 23, 16, 4)], m),                                                 // saw through it
      layer([b(19, 16, 0, 25, 16, 1)], w),
      layer([b(4, 15, 4, 10, 16, 7)], m),                                                  // chisels
    ];
  }
  return [
    layer(legs(0, 32, 12, 3), "panelDark"),
    layer([b(3, 1, 2, 29, 12, 14)], w),
    layer(top(0, 32, 12, 15), w),
    layer([b(1, 15, 1, 31, 16, 15)], "panelDark"),
    layer([b(4, 6, 1, 14, 10, 2)], "panelDark"),                                           // tool drawer
    layer([b(7, 7, 0, 11, 9, 1)], m),
    layer([b(16, 16, 3, 30, 16, 13)], "plankPale"),                                        // finished boards
    layer([b(18, 15, 1, 20, 16, 4)], "steel"),                                             // saw standing in them
    layer([b(16, 16, 0, 22, 16, 1)], w),
    layer([b(20, 12, 13, 27, 15, 16)], m),                                                 // vice
    layer([b(3, 16, 4, 9, 16, 12)], "steel"),                                              // chisel rack
  ];
}

// Masonry: a flat rock on two boulders, a brick banker with a grindstone, a polished bench with a big wheel.
function stoneworking(tier) {
  const w = WOOD[tier], r = ROCK[tier], m = METAL[tier];
  if (tier === "crude") {
    return [
      layer([round(b(1, 0, 2, 9, 8, 14), 3), round(b(9, 0, 2, 16, 8, 14), 3),
             round(b(16, 0, 2, 23, 8, 14), 3), round(b(23, 0, 2, 31, 8, 14), 3)], "roughStone"),  // boulders under it
      layer([b(1, 8, 1, 31, 11, 15)], "roughStone"),                                       // the slab across them
      layer([b(17, 11, 4, 27, 15, 12)], "stone"),                                          // the stone being squared
      layer([b(7, 11, 5, 9, 15, 7)], m),                                                   // chisel standing
      layer([b(4, 11, 9, 12, 13, 12)], w),                                                 // mallet
      layer([b(13, 11, 2, 16, 12, 5)], "sandstone"),                                       // chippings
    ];
  }
  if (tier === "sturdy") {
    return [
      layer([b(1, 0, 1, 15, 10, 15)], r),                                                  // brick base, inside its cell
      layer([b(0, 10, 0, 16, 13, 16)], "stone"),                                           // banker top
      layer([b(2, 13, 14, 14, 16, 4)], "stone"),
      layer([b(3, 13, 3, 13, 16, 13)], "stone"),                                           // block under the chisel
      layer([b(7, 16, 4, 9, 16, 6)], m),
      layer([b(17, 0, 10, 31, 4, 15)], "logDark"),                                         // the grindstone's frame
      layer([b(17, 4, 12, 20, 15, 15), b(28, 4, 12, 31, 15, 15)], "logDark"),
      layer([roundV(b(18, 2, 1, 30, 16, 11), 5)], "stone"),                                // the wheel, out in front
      layer([b(17, 9, 4, 31, 11, 7)], m),                                                  // axle
    ];
  }
  return [
    layer([b(0, 0, 0, 16, 11, 16)], r),
    layer([b(0, 11, 0, 16, 14, 16)], "steel"),                                             // polished top
    layer([b(1, 10, 0, 15, 11, 1)], m),                                                    // inlay band
    layer([b(3, 14, 3, 13, 16, 13)], "darkstone"),                                         // the carved block
    layer([b(6, 16, 5, 8, 16, 11)], m),
    layer([b(18, 0, 2, 30, 4, 14)], r),
    layer([b(18, 4, 11, 21, 15, 14), b(28, 4, 11, 31, 15, 14)], "darkstone"),
    layer([roundV(b(20, 3, 2, 29, 15, 13), 4)], "steel"),                                  // big wheel
    layer([b(18, 8, 6, 31, 10, 9)], m),
    layer([b(16, 4, 6, 19, 6, 8), b(16, 4, 6, 18, 10, 8)], m),                             // crank
  ];
}

// Forge: a boulder on a stump, an iron anvil with its tools, a steel anvil on a dressed plinth.
function smithing(tier) {
  const w = WOOD[tier], m = METAL[tier];
  const anvil = tier === "crude" ? "roughStone" : tier === "sturdy" ? "iron" : "steel";
  if (tier === "crude") {
    return [
      layer([round(b(2, 0, 3, 14, 7, 13), 3)], w),                                         // stump
      layer([...lash(3, 4), ...lash(11, 4)], "rope"),
      layer([round(b(1, 7, 2, 15, 12, 14), 3)], anvil),                                    // a boulder for an anvil
      layer([round(b(18, 0, 4, 30, 5, 12), 3)], "roughStone"),                             // stones for the tools
      layer([b(19, 5, 5, 29, 7, 11)], w),
      layer([b(21, 7, 6, 24, 10, 9)], "roughStone"),                                       // stone hammer
      layer([b(22, 9, 7, 28, 10, 9)], w),
    ];
  }
  if (tier === "sturdy") {
    return [
      layer([b(3, 0, 3, 13, 6, 13)], w),                                                   // timber block
      layer([b(5, 6, 5, 11, 9, 11)], anvil),                                               // waist
      layer([b(2, 9, 3, 14, 12, 13)], anvil),                                              // face
      layer([b(0, 10, 6, 3, 12, 10)], anvil),                                              // horn
      layer(legs(16, 32, 9), w),
      layer([b(16, 9, 1, 32, 12, 15)], w),                                                 // bench beside it
      layer([b(19, 12, 3, 21, 15, 5)], m),                                                 // hammer standing
      layer([b(23, 12, 4, 29, 13, 6)], m),                                                 // tongs
      layer([round(b(22, 0, 9, 30, 8, 15), 2)], m),                                        // quench bucket
      layer([round(b(23, 7, 10, 29, 9, 14), 2)], "water"),
    ];
  }
  return [
    layer([b(1, 0, 2, 15, 6, 14)], "darkstone"),                                           // dressed plinth
    layer([b(4, 6, 5, 12, 9, 11)], anvil),
    layer([b(1, 9, 2, 15, 13, 14)], anvil),
    layer([b(0, 10, 6, 1, 13, 10)], anvil),
    layer([b(2, 13, 3, 14, 14, 13)], m),                                                   // gold band
    layer([b(17, 0, 2, 31, 10, 14)], "darkstone"),
    layer([b(16, 10, 1, 32, 13, 15)], "steel"),
    layer([b(18, 13, 1, 20, 16, 3), b(22, 13, 1, 24, 16, 3), b(26, 13, 1, 28, 16, 3)], "steel"),
    layer([b(17, 15, 0, 31, 16, 1)], m),
    layer([round(b(22, 13, 8, 30, 16, 14), 2)], m),
  ];
}

// Tannery: two forked poles and a pit, a squared frame and a vat, a panelled frame and a lined vat.
function tanning(tier) {
  const w = WOOD[tier], m = METAL[tier];
  // A drying rack is read at a glance by the hide stretched across it, so the frame runs the whole piece and the
  // hide with it; the vat is a prop in one cell, free to change ends when the camera turns.
  const post = (x) => [b(x, 0, 9, x + 3, 16, 13)];
  const frame = [...post(0), ...post(13), ...post(16), ...post(29)];
  if (tier === "crude") {
    return [
      layer(frame.map((x) => round(x, 1)), w),
      layer([round(b(0, 13, 9, 32, 16, 13), 1)], w),                                       // crossbar
      layer([b(1, 2, 7, 31, 14, 9)], "hide"),                                              // the hide, in front of it
      layer([...lash(0, 12), ...lash(13, 12), ...lash(16, 12), ...lash(29, 12)], "rope"),
      layer([round(b(18, 0, 1, 30, 5, 7), 3)], "roughStone"),                              // the soaking pit
      layer([b(20, 4, 2, 28, 6, 6)], "water"),
    ];
  }
  if (tier === "sturdy") {
    return [
      layer(frame, w),
      layer([b(0, 13, 9, 32, 16, 13), b(0, 0, 9, 32, 2, 13)], w),                          // top and bottom rails
      layer([b(1, 3, 7, 31, 13, 9)], "hide"),
      layer([b(1, 2, 6, 31, 3, 10), b(1, 12, 6, 31, 13, 10)], w),                          // battens
      layer([b(18, 0, 0, 30, 9, 8)], w),                                                   // plank vat
      layer([b(17, 7, 0, 31, 10, 8)], m),                                                  // iron rim
      layer([b(19, 9, 1, 29, 10, 7)], "water"),
    ];
  }
  return [
    layer(frame, "panelDark"),
    layer([b(0, 13, 9, 32, 16, 13), b(0, 0, 9, 32, 2, 13)], w),
    layer([b(1, 3, 7, 31, 13, 9)], "leather"),                                             // finished leather on it
    layer([b(0, 12, 8, 32, 13, 10), b(0, 2, 8, 32, 3, 10)], m),                            // metal battens
    layer([b(18, 0, 0, 30, 8, 8)], "darkstone"),                                           // stone-lined vat
    layer([b(17, 8, 0, 31, 11, 8)], m),
    layer([b(19, 10, 1, 29, 11, 7)], "water"),
    layer([round(b(1, 0, 1, 9, 4, 7), 2)], "leather"),                                     // a roll of leather
  ];
}

// A fire with a ring of stones and two logs across it. One cell, and the campfire tile itself.
function fire(withPot) {
  const out = [
    layer([round(b(1, 0, 4, 4, 3, 8), 1), round(b(12, 0, 4, 15, 3, 8), 1),
           round(b(4, 0, 12, 8, 3, 15), 1), round(b(8, 0, 1, 12, 3, 4), 1),
           round(b(2, 0, 10, 5, 3, 13), 1), round(b(11, 0, 10, 14, 3, 13), 1)], "roughStone"),  // the ring
    layer([round(b(4, 2, 7, 12, 4, 9), 1), round(b(7, 2, 4, 9, 4, 12), 1)], "logDark"),    // two logs across
    layer([b(5, 3, 5, 11, 7, 11), b(6, 7, 6, 10, 9, 10), b(7, 9, 7, 9, 11, 9)], "ember"),  // the flame
  ];
  if (!withPot) return out;
  return out;
}

// Alchemy: a pot hung over a campfire, then a wood stove, then a polished stone one. One cell.
function cauldron(tier) {
  const pot = tier === "crude" ? "iron" : tier === "sturdy" ? "steel" : "copper";
  if (tier === "crude") {
    return [
      ...fire(),
      layer([round(b(1, 0, 7, 3, 16, 9), 0), round(b(13, 0, 7, 15, 16, 9), 0),
             round(b(1, 14, 7, 15, 16, 9), 0)], "logDark"),                                // the two posts and the bar
      layer([b(7, 12, 7, 9, 14, 9)], "iron"),                                              // the hook
      layer([round(b(3, 6, 3, 13, 12, 13), 3)], pot),                                      // the pot hanging over it
      layer([round(b(2, 11, 2, 14, 13, 14), 3)], pot),
      layer([b(4, 13, 4, 12, 14, 12)], "water"),
    ];
  }
  if (tier === "sturdy") {
    // A wood stove: a closed firebox with its mouth, and the pot sunk into the top.
    return [
      layer([b(0, 0, 0, 16, 9, 16)], "bricks"),
      layer([b(4, 1, 0, 12, 6, 1)], "ember"),                                              // the mouth, lit
      layer([b(3, 0, 0, 13, 1, 1), b(3, 6, 0, 13, 7, 1), b(3, 1, 0, 4, 6, 1), b(12, 1, 0, 13, 6, 1)], "iron"),
      layer([b(0, 9, 0, 16, 11, 16)], "iron"),                                             // the plate on top
      layer([round(b(3, 11, 3, 13, 15, 13), 3)], pot),                                     // the pot sunk in it
      layer([round(b(2, 14, 2, 14, 16, 14), 3)], pot),
      layer([b(3, 16, 3, 13, 16, 13)], "water"),
    ];
  }
  return [
    layer([b(0, 0, 0, 16, 10, 16)], "darkstone"),
    layer([b(4, 1, 0, 12, 7, 1)], "ember"),
    layer([b(3, 0, 0, 13, 1, 1), b(3, 7, 0, 13, 8, 1), b(3, 1, 0, 4, 7, 1), b(12, 1, 0, 13, 7, 1)], "gold"),
    layer([b(0, 10, 0, 16, 12, 16)], "steel"),                                             // polished plate
    layer([b(0, 12, 0, 16, 13, 1), b(0, 12, 15, 16, 13, 16)], "gold"),                     // its trim
    layer([round(b(2, 12, 2, 14, 16, 14), 4)], pot),                                       // a wide pot
    layer([b(3, 16, 3, 13, 16, 13)], "water"),
  ];
}

// Smelting: a clay dome, a brick furnace with a chimney, a dark stone furnace with a vent. Two cells TALL.
function furnace(tier) {
  const r = ROCK[tier], m = METAL[tier];
  if (tier === "crude") {
    const body = [
      layer([round(b(0, 0, 0, 16, 16, 16), 4)], "roughStone"),
      layer([b(5, 0, 0, 11, 8, 3)], "ember"),                                              // the mouth, lit
      layer([b(4, 0, 0, 12, 1, 1), b(4, 8, 0, 12, 9, 2)], "roughStone"),
    ];
    const tops = [
      layer([round(b(1, 0, 1, 15, 9, 15), 4)], "roughStone"),                              // the dome
      layer([round(b(5, 9, 5, 11, 13, 11), 1)], "roughStone"),
      layer([b(6, 12, 6, 10, 13, 10)], "ember"),
    ];
    return [body, tops];
  }
  if (tier === "sturdy") {
    const body = [
      layer([b(0, 0, 0, 16, 16, 16)], r),
      layer([b(4, 1, 0, 12, 9, 2)], "ember"),
      layer([b(3, 0, 0, 13, 1, 1), b(3, 9, 0, 13, 11, 2), b(3, 1, 0, 4, 9, 1), b(12, 1, 0, 13, 9, 1)], m),
      layer([b(0, 0, 0, 16, 2, 16)], "stone"),                                             // footing
    ];
    const tops = [
      layer([b(0, 0, 0, 16, 8, 16)], r),
      layer([b(1, 8, 1, 15, 10, 15)], "stone"),                                            // the shoulder course
      layer([b(5, 10, 5, 11, 16, 11)], r),                                                 // square chimney
      layer([b(4, 14, 4, 12, 15, 12)], m),
    ];
    return [body, tops];
  }
  const body = [
    layer([b(0, 0, 0, 16, 16, 16)], r),
    layer([b(4, 1, 0, 12, 10, 2)], "ember"),
    layer([b(3, 0, 0, 13, 1, 1), b(3, 10, 0, 13, 12, 2), b(3, 1, 0, 4, 10, 1), b(12, 1, 0, 13, 10, 1)], m),
    layer([b(0, 0, 0, 16, 2, 16)], "steel"),
    layer([b(0, 13, 0, 16, 14, 16)], m),                                                   // banding
  ];
  const tops = [
    layer([b(0, 0, 0, 16, 7, 16)], r),
    layer([b(0, 7, 0, 16, 9, 16)], "steel"),
    layer([b(5, 9, 5, 11, 15, 11)], r),
    layer([b(4, 13, 4, 12, 16, 12)], m),
  ];
  return [body, tops];
}

// Melting: a bowl on a ring of stones, a brick stack with bellows, dark stone with a gilded crucible.
function crucible(tier) {
  const w = WOOD[tier], r = ROCK[tier], m = METAL[tier];
  if (tier === "crude") {
    return [
      layer([round(b(1, 0, 1, 15, 6, 15), 4)], "roughStone"),                              // ring of stones
      layer([b(3, 5, 3, 13, 8, 13)], "ember"),
      layer([round(b(4, 6, 4, 12, 12, 12), 2)], "sandstone"),                              // the clay bowl
      layer([b(5, 11, 5, 11, 12, 11)], "ember"),
      layer([round(b(18, 0, 4, 30, 4, 12), 3)], "roughStone"),                             // the coal pile beside it
      layer([b(19, 4, 5, 29, 7, 11)], "darkstone"),
    ];
  }
  if (tier === "sturdy") {
    return [
      layer([b(1, 0, 1, 15, 9, 15)], r),                                                   // brick stack
      layer([b(2, 9, 2, 14, 11, 14)], "stone"),
      layer([round(b(4, 11, 4, 12, 16, 12), 2)], m),                                       // iron crucible
      layer([b(5, 15, 5, 11, 16, 11)], "ember"),
      layer([b(1, 3, 6, 15, 6, 10)], m),                                                   // the tuyere
      layer([b(17, 0, 3, 23, 7, 13)], w),                                                  // bellows
      layer([b(22, 4, 5, 31, 9, 11)], "leather"),
      layer([b(29, 3, 6, 32, 11, 10)], w),
    ];
  }
  return [
    layer([b(0, 0, 0, 16, 10, 16)], r),
    layer([b(0, 10, 0, 16, 12, 16)], "steel"),
    layer([round(b(3, 12, 3, 13, 16, 13), 2)], m),                                         // gilded crucible
    layer([b(4, 15, 4, 12, 16, 12)], "ember"),
    layer([b(0, 4, 6, 16, 7, 10)], m),
    layer([b(17, 0, 2, 24, 8, 14)], "darkstone"),                                          // double bellows
    layer([b(23, 4, 3, 31, 10, 13)], "leather"),
    layer([b(30, 3, 5, 32, 12, 11)], w),
    layer([b(18, 8, 3, 23, 9, 13)], m),
  ];
}

// Scribing: a split log on posts, a writing desk with scrolls, a panelled lectern with a rune plate.
function scribe(tier) {
  const w = WOOD[tier], m = METAL[tier];
  if (tier === "crude") {
    return [
      layer([round(b(17, 0, 2, 21, 11, 6), 1), round(b(27, 0, 2, 31, 11, 6), 1),
             round(b(17, 0, 11, 21, 9, 15), 1), round(b(27, 0, 11, 31, 9, 15), 1)], w),    // posts, front pair shorter
      layer([b(16, 9, 1, 32, 12, 16), b(16, 11, 1, 32, 14, 9)], w),                        // the slanted plank
      layer([...lash(18, 8), ...lash(28, 8)], "rope"),
      layer([b(19, 14, 3, 29, 15, 8)], "paper"),
      layer([round(b(1, 0, 3, 13, 8, 13), 2)], w),                                         // a hollow log of scrolls
      layer([b(2, 8, 4, 12, 10, 12)], "paper"),
      layer([b(5, 10, 6, 9, 12, 10)], m),                                                  // the inkpot
    ];
  }
  if (tier === "sturdy") {
    return [
      layer(legs(16, 32, 11), w),
      layer([b(16, 11, 1, 32, 14, 15), b(16, 14, 1, 32, 16, 8)], w),                       // desk with a sloped lid
      layer([b(19, 7, 2, 29, 10, 3)], "plankPale"),                                        // drawer
      layer([b(22, 8, 1, 26, 9, 2)], m),
      layer([b(19, 16, 3, 29, 16, 8)], "paper"),
      layer([b(1, 0, 2, 15, 3, 14), b(1, 3, 2, 3, 14, 14), b(13, 3, 2, 15, 14, 14),
             b(1, 13, 2, 15, 15, 14), b(1, 8, 3, 15, 9, 13)], w),                          // shelf
      layer([b(4, 3, 4, 12, 8, 12), b(4, 9, 4, 12, 13, 12)], "paper"),
      layer([b(6, 15, 5, 10, 16, 9)], m),
    ];
  }
  return [
    layer([b(16, 12, 0, 32, 15, 16), b(16, 15, 0, 32, 16, 9)], w),                         // lectern top
    layer([b(17, 1, 1, 31, 12, 15)], "panelDark"),                                         // panelled body
    layer([b(16, 0, 0, 32, 1, 16)], "darkstone"),
    layer([b(21, 15, 9, 27, 16, 12)], "rune"),                                             // the rune plate
    layer([b(17, 11, 0, 31, 12, 1)], m),                                                   // gold banding
    layer([b(1, 0, 2, 15, 2, 14), b(1, 2, 2, 3, 15, 14), b(13, 2, 2, 15, 15, 14),
           b(1, 14, 2, 15, 16, 14), b(1, 6, 3, 15, 7, 13), b(1, 10, 3, 15, 11, 13)], "panelDark"),
    layer([b(4, 2, 4, 12, 6, 12), b(4, 7, 4, 12, 10, 12), b(4, 11, 4, 12, 14, 12)], "paper"),
    layer([b(5, 16, 6, 7, 16, 8)], "ember"),                                               // a candle
  ];
}

// Engraving: a stone slab to carve runes on, with the rune stone on its stand. One tier.
function engraving() {
  return [
    layer(legs(16, 32, 11), "log"),
    layer([b(16, 11, 1, 32, 14, 15)], "stone"),                                            // stone-topped bench
    layer([b(19, 14, 3, 29, 16, 13)], "darkstone"),                                        // the blank being carved
    layer([b(23, 16, 6, 25, 16, 10)], "rune"),
    layer([b(21, 14, 1, 27, 15, 3)], "iron"),                                              // chisels
    layer([round(b(3, 0, 3, 13, 4, 13), 2)], "roughStone"),                                // the rune stand
    layer([b(5, 4, 5, 11, 12, 11)], "darkstone"),
    layer([b(6, 8, 4, 10, 11, 5)], "rune"),
    layer([b(4, 12, 4, 12, 13, 12)], "iron"),
  ];
}

// ── Layout ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A row per station, a column pair per tier. The sheet is rewritten from row 0, so the coordinates printed at the end
// are what tables.json has to say.
const TIERS = ["crude", "sturdy", "mastered"];

const FAMILIES = [
  { id: "workbench", row: 0, make: workbench },
  { id: "woodworking_table", row: 2, make: woodworking },
  { id: "stoneworking_table", row: 4, make: stoneworking },
  { id: "smithing_table", row: 6, make: smithing },
  { id: "tanning_rack", row: 8, make: tanning },
  { id: "scribe_table", row: 10, make: scribe },
  { id: "crucible", row: 12, make: crucible },
];

// A station gets two rows: the fronts, then the same cells seen from behind. The game mirrors those two for the
// other two facings, so a bench whose vice, hide or bellows are only on one side needs its own back art.
const CAULDRON_ROW = 14;
const CAULDRON_BACK_ROW = 15;
const CAMPFIRE_AT = [3, 14];
const ENGRAVING_AT = [4, 14];
const FURNACE_AT = { crude: [0, 16], sturdy: [4, 16], mastered: [0, 17] };   // [column, row]: front pair, then back pair
const SHEET_ROWS = 18;

// ── Run ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const draw = (layers, facing) => L.stack(layers.map((l) => L.layer(l.boxes, mat(l.mat), { facing })));

/** The 32-wide design pressed into one cell, for the inventory icon: the whole table, not half of it. */
function squeeze(layers) {
  return layers.map((l) => ({
    mat: l.mat,
    boxes: l.boxes.map((box) => {
      const out = { min: [box.min[0] / 2, box.min[1], box.min[2]], max: [box.max[0] / 2, box.max[1], box.max[2]] };
      if (box.cuts) out.cuts = box.cuts.map((c) => ({ n: c.n, d: c.d / (c.n[0] !== 0 ? 2 : 1) }));
      return out;
    }),
  }));
}

/** The two-cell-tall furnace pressed into one cell: body below, chimney on top. */
function squeezeTall([body, top]) {
  const squash = (layers, scale, lift) => layers.map((l) => ({
    mat: l.mat,
    boxes: l.boxes.map((box) => ({
      min: [box.min[0], box.min[1] * scale + lift, box.min[2]],
      max: [box.max[0], box.max[1] * scale + lift, box.max[2]],
    })),
  }));
  return [...squash(body, 0.62, 0), ...squash(top, 0.36, 9.9)];
}

function main() {
  const project = process.argv[2];
  const dry = process.argv.includes("--dry");
  if (!project) {
    console.error("Uso: node tools/make-tables.js <carpeta del proyecto Aura> [--dry]");
    process.exit(1);
  }

  tex = L.materials(project);
  const dir = path.join(project, "App", "Content", "Assets", "Tiles");
  const color = new L.Sheet(path.join(dir, "Tables.png"));
  const normal = new L.Sheet(path.join(dir, "Tables_n.png"));

  color.clear(SHEET_ROWS);
  normal.clear(SHEET_ROWS);
  const put = (col, row, cell) => { color.paste(col, row, cell.color); normal.paste(col, row, cell.normal); };

  const tiles = {};
  for (const family of FAMILIES) {
    for (const [i, tier] of TIERS.entries()) {
      const [far, near] = split(family.make(tier));
      const col = i * 2, back = family.row + 1;
      put(col, family.row, draw(far, "front"));
      put(col + 1, family.row, draw(near, "front"));
      put(col, back, draw(far, "back"));
      put(col + 1, back, draw(near, "back"));
      tiles[`${tier}_${family.id}`] = [[col, family.row], [col + 1, family.row]];
      tiles[`${tier}_${family.id}_back`] = [[col, back], [col + 1, back]];
    }
  }
  for (const [i, tier] of TIERS.entries()) {
    put(i, CAULDRON_ROW, draw(cauldron(tier), "front"));
    put(i, CAULDRON_BACK_ROW, draw(cauldron(tier), "back"));
    tiles[`${tier}_cauldron`] = [[i, CAULDRON_ROW]];
    tiles[`${tier}_cauldron_back`] = [[i, CAULDRON_BACK_ROW]];
  }
  put(CAMPFIRE_AT[0], CAMPFIRE_AT[1], draw(fire(), "front"));
  tiles.campfire = [CAMPFIRE_AT];

  const [engFar, engNear] = split(engraving());
  const engBack = CAULDRON_BACK_ROW;
  put(ENGRAVING_AT[0], ENGRAVING_AT[1], draw(engFar, "front"));
  put(ENGRAVING_AT[0] + 1, ENGRAVING_AT[1], draw(engNear, "front"));
  put(ENGRAVING_AT[0], engBack, draw(engFar, "back"));
  put(ENGRAVING_AT[0] + 1, engBack, draw(engNear, "back"));
  tiles.crude_engraving_table = [ENGRAVING_AT, [ENGRAVING_AT[0] + 1, ENGRAVING_AT[1]]];
  tiles.crude_engraving_table_back = [[ENGRAVING_AT[0], engBack], [ENGRAVING_AT[0] + 1, engBack]];

  for (const tier of TIERS) {
    const [col, row] = FURNACE_AT[tier];
    const front = [], back = [];
    for (const [i, cell] of furnace(tier).entries()) {
      put(col + i, row, draw(cell, "front"));
      put(col + 2 + i, row, draw(cell, "back"));
      front.push([col + i, row]);
      back.push([col + 2 + i, row]);
    }
    tiles[`${tier}_furnace`] = front;
    tiles[`${tier}_furnace_back`] = back;
  }

  const items = path.join(project, "App", "Content", "Assets", "Items");
  const icons = new L.Sheet(path.join(items, "Placeables.png"));
  const iconAt = {};
  let row = 2;
  for (const family of FAMILIES) {
    for (const [i, tier] of TIERS.entries()) {
      icons.paste(i, row, draw(squeeze(family.make(tier)), "front").color);
      iconAt[`${tier}_${family.id}`] = [i, row];
    }
    row++;
  }
  for (const [i, tier] of TIERS.entries()) {
    icons.paste(i, row, draw(cauldron(tier), "front").color);
    iconAt[`${tier}_cauldron`] = [i, row];
  }
  icons.paste(3, row, draw(fire(), "front").color);
  iconAt.campfire = [3, row];
  row++;
  for (const [i, tier] of TIERS.entries()) {
    icons.paste(i, row, draw(squeezeTall(furnace(tier)), "front").color);
    iconAt[`${tier}_furnace`] = [i, row];
  }
  icons.paste(3, row, draw(squeeze(engraving()), "front").color);
  iconAt.crude_engraving_table = [3, row];

  console.log(JSON.stringify({ tiles, icons: iconAt }, null, 1));
  if (dry) { console.log("--dry: no se ha escrito nada."); return; }
  color.save();
  normal.save();
  icons.save();
  console.log(`Escritas Tables.png, Tables_n.png y Placeables.png`);
}

main();
