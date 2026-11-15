"use strict";

// Draws every crafting station into Tables.png / Tables_n.png and their inventory icons into Placeables.png, with the
// Studio's own block generator.
//
//   node tools/make-tables.js <carpeta del proyecto Aura> [--dry]
//
// A two-cell station is designed as ONE object 32 wide (x 0..32, y up 0..16, z front-back 0..16) and split here into
// the two cells the tile declares: x < 16 is the half at offsetX 0 (drawn up-left), x > 16 the half at offsetX 1
// (drawn down-right). Designing the whole table at once is why the legs land on its corners and the top meets in the
// middle; the two halves cannot drift apart.
const path = require("path");
const L = require("./block-lib.js");

// ── Materials ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The browns are sampled from the crude workbench that was already in the sheet, so a new table stands next to the old
// art as the same workshop. Each tier moves one step: rough logs, sawn planks, dark hardwood.
const MAT = {
  log: () => L.faces((s) => L.grainTex("#3f2f1b", "#6b512e", { seed: s })),
  plank: () => L.faces((s) => L.planks("#55401f", "#8a6a3d", { seed: s, boards: 4 })),
  darkwood: () => L.faces((s) => L.planks("#2c1f14", "#55392a", { seed: s, boards: 5 })),
  pale: () => L.faces((s) => L.planks("#8d7a5a", "#c0ac96", { seed: s, boards: 3 })),
  paper: () => L.faces((s) => L.speckle("#b9ae93", "#e6ddc6", { seed: s, spread: 0.3 })),
  stone: () => L.faces((s) => L.speckle("#4a4a4e", "#7d7d84", { seed: s })),
  clay: () => L.faces((s) => L.speckle("#5a4330", "#8a6b4c", { seed: s, spread: 0.7 })),
  brick: () => L.faces((s) => L.planks("#5a3a30", "#8d5a46", { seed: s, boards: 4, grain: 0.1 })),
  darkstone: () => L.faces((s) => L.speckle("#2b2b31", "#55555f", { seed: s })),
  iron: () => L.faces((s) => L.speckle("#3f4046", "#767982", { seed: s, spread: 0.6 })),
  steel: () => L.faces((s) => L.speckle("#55585f", "#9aa0ac", { seed: s, spread: 0.5 })),
  gold: () => L.faces((s) => L.speckle("#8a6a1e", "#e3c468", { seed: s, spread: 0.4 })),
  copper: () => L.faces((s) => L.speckle("#6b3f22", "#b4743a", { seed: s, spread: 0.5 })),
  leather: () => L.faces((s) => L.speckle("#6b543a", "#a98f66", { seed: s, spread: 0.7 })),
  hide: () => L.faces((s) => L.speckle("#8a7049", "#c8ab7c", { seed: s, spread: 0.6 })),
  coal: () => L.faces((s) => L.speckle("#16161a", "#33333a", { seed: s })),
  ember: () => L.faces((s) => L.speckle("#7a2a10", "#e8923a", { seed: s, spread: 0.9 })),
  water: () => L.faces((s) => L.speckle("#2a3a46", "#46606e", { seed: s, spread: 0.4 })),
  rune: () => L.faces((s) => L.speckle("#2a3a5a", "#6f8fd0", { seed: s, spread: 0.5 })),
};

const cache = new Map();
const mat = (name) => {
  if (!cache.has(name)) cache.set(name, MAT[name]());
  return cache.get(name);
};

// Tier palettes: the material says the tier as much as the shape does.
const WOOD = { crude: "log", sturdy: "plank", mastered: "darkwood" };
const ROCK = { crude: "clay", sturdy: "brick", mastered: "darkstone" };
const METAL = { crude: "stone", sturdy: "iron", mastered: "gold" };

// ── Shape helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
// Boxes are in 16ths, like a tile's "collision". A two-cell piece is authored 32 wide.
const b = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });

/** Cuts the four upright corners of a box, so a pot or a wheel reads round instead of square. */
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

/** A leg at each of the four corners of a table that spans [x0, x1]. */
const legs = (x0, x1, y0, y1, w = 3, inset = 1) => [
  b(x0 + inset, y0, inset, x0 + inset + w, y1, inset + w),
  b(x0 + inset, y0, 16 - inset - w, x0 + inset + w, y1, 16 - inset),
  b(x1 - inset - w, y0, inset, x1 - inset, y1, inset + w),
  b(x1 - inset - w, y0, 16 - inset - w, x1 - inset, y1, 16 - inset),
];

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
// One function per station, one shape per tier: a better table is a different piece of furniture, not the same one
// repainted.

// General bench: posts and a split log, then a joined bench with a vice, then a cabinet with drawers.
function workbench(tier) {
  const w = WOOD[tier], m = METAL[tier];
  if (tier === "crude") {
    return [
      layer([b(1, 11, 1, 31, 14, 15)], w),                                  // split-log top, overhanging
      layer([b(2, 0, 2, 6, 11, 6), b(2, 0, 10, 6, 11, 14),
             b(26, 0, 2, 30, 11, 6), b(26, 0, 10, 30, 11, 14)], w),         // four round posts
      layer([b(5, 5, 7, 27, 7, 9)], w),                                     // the beam that keeps it from racking
      layer([b(4, 4, 6, 7, 6, 10), b(25, 4, 6, 28, 6, 10)], "leather"),     // rope lashings
      layer([b(8, 14, 4, 13, 15, 7)], "stone"),                             // a stone and a mallet left on it
      layer([b(17, 14, 9, 24, 15, 11)], m),
    ];
  }
  if (tier === "sturdy") {
    return [
      layer([b(0, 12, 0, 32, 15, 16)], w),                                  // planed top
      layer([b(2, 10, 1, 30, 12, 15)], w),                                  // apron
      layer(legs(0, 32, 0, 10, 3, 1), w),
      layer([b(3, 3, 6, 29, 5, 10)], w),                                    // stretcher
      layer([b(4, 5, 2, 28, 7, 14)], "pale"),                               // boards on the shelf
      layer([b(22, 9, 14, 29, 13, 16), b(24, 13, 14, 27, 16, 16)], m),      // vice on the front edge
      layer([b(6, 10, 0, 8, 12, 1), b(24, 10, 0, 26, 12, 1)], m),           // iron straps
    ];
  }
  return [
    layer([b(0, 11, 0, 32, 14, 16)], w),                                    // moulded top
    layer([b(1, 14, 1, 31, 15, 15)], w),
    layer([b(2, 1, 2, 30, 11, 14)], w),                                     // closed cabinet base
    layer([b(3, 7, 1, 15, 10, 2), b(17, 7, 1, 29, 10, 2)], "pale"),         // two drawer fronts
    layer([b(7, 8, 0, 11, 9, 1), b(21, 8, 0, 25, 9, 1)], m),                // their pulls
    layer([b(0, 0, 0, 32, 1, 16)], "stone"),                                // plinth
    layer([b(0, 14, 0, 3, 15, 3), b(29, 14, 0, 32, 15, 3),
           b(0, 14, 13, 3, 15, 16), b(29, 14, 13, 32, 15, 16)], m),         // corner caps
  ];
}

// Carpentry: a log on trestles, a bench with a frame saw, a joiner's bench with drawers and planed boards.
function woodworking(tier) {
  const w = WOOD[tier], m = METAL[tier];
  if (tier === "crude") {
    return [
      layer([b(3, 0, 3, 7, 9, 7), b(3, 0, 9, 7, 9, 13),
             b(25, 0, 3, 29, 9, 7), b(25, 0, 9, 29, 9, 13)], w),            // two trestles
      layer([b(2, 9, 2, 30, 11, 14)], w),                                   // their crossbeams
      layer([round(b(4, 11, 4, 28, 16, 12), 2)], w),                        // the log being cut
      layer([b(14, 11, 2, 16, 16, 4)], m),                                  // saw blade sunk in the log
      layer([b(13, 14, 1, 17, 16, 2)], w),                                  // its handle
    ];
  }
  if (tier === "sturdy") {
    return [
      layer([b(0, 11, 0, 32, 14, 16)], w),
      layer(legs(0, 32, 0, 11, 3, 1), w),
      layer([b(2, 4, 6, 30, 6, 10)], w),                                    // stretcher
      layer([b(3, 6, 2, 13, 8, 14)], "pale"),                               // sawn boards stored under it
      layer([b(17, 14, 3, 29, 16, 13)], w),                                 // workpiece on the bench
      layer([b(21, 14, 1, 23, 16, 4)], m),                                  // saw through the workpiece
      layer([b(19, 15, 0, 25, 16, 1)], w),
      layer([b(3, 14, 4, 9, 15, 7)], m),                                    // chisels laid out
      layer([b(4, 14, 9, 8, 16, 12)], w),
    ];
  }
  return [
    layer([b(0, 11, 0, 32, 14, 16)], w),
    layer([b(1, 14, 1, 31, 15, 15)], w),                                    // moulded edge
    layer([b(2, 1, 2, 30, 11, 14)], w),
    layer([b(0, 0, 0, 32, 1, 16)], "stone"),
    layer([b(3, 6, 1, 13, 10, 2)], "pale"),                                 // tool drawer
    layer([b(6, 7, 0, 10, 8, 1)], m),
    layer([b(16, 15, 3, 30, 16, 13)], "pale"),                              // finished boards, planed
    layer([b(18, 14, 1, 20, 16, 4)], m),                                    // saw standing in the boards
    layer([b(16, 15, 0, 22, 16, 1)], w),
    layer([b(20, 11, 14, 27, 15, 16)], m),                                  // vice
    layer([b(2, 15, 4, 8, 16, 12)], m),                                     // chisel rack
  ];
}

// Masonry: a slab on two blocks, a banker with a grindstone, a polished bench with a big wheel.
function stoneworking(tier) {
  const w = WOOD[tier], r = ROCK[tier], m = METAL[tier];
  if (tier === "crude") {
    return [
      layer([b(3, 0, 3, 10, 8, 13), b(22, 0, 3, 29, 8, 13)], "stone"),      // two rough blocks
      layer([b(1, 8, 1, 31, 11, 15)], "stone"),                             // the slab across them
      layer([b(17, 11, 4, 27, 15, 12)], "stone"),                           // the stone being squared
      layer([b(7, 11, 5, 9, 15, 7)], m),                                    // chisel standing
      layer([b(4, 11, 9, 12, 13, 12)], w),                                  // mallet
      layer([b(13, 11, 2, 16, 12, 5)], "pale"),                             // chippings
    ];
  }
  if (tier === "sturdy") {
    return [
      layer([b(1, 0, 1, 19, 10, 15)], r),                                   // brick base
      layer([b(0, 10, 0, 20, 13, 16)], "stone"),                            // banker top
      layer([b(3, 13, 3, 15, 16, 13)], "stone"),                            // block under the chisel
      layer([b(8, 16, 4, 10, 16, 6)], m),
      layer([b(21, 0, 3, 31, 4, 13)], w),                                   // the grindstone's frame
      layer([b(21, 4, 11, 24, 13, 14), b(28, 4, 11, 31, 13, 14)], w),       // its uprights, behind the wheel
      layer([roundV(b(23, 4, 3, 29, 13, 12), 3)], "stone"),                 // the wheel, standing
      layer([b(21, 7, 6, 31, 9, 9)], m),                                    // axle through it
    ];
  }
  return [
    layer([b(0, 0, 0, 20, 11, 16)], r),                                     // dressed stone base
    layer([b(0, 11, 0, 20, 14, 16)], "steel"),                              // polished top
    layer([b(1, 10, 0, 19, 11, 1)], m),                                     // inlay band
    layer([b(3, 14, 3, 15, 16, 13)], "darkstone"),                          // the carved block
    layer([b(6, 16, 5, 8, 16, 11)], m),
    layer([b(21, 0, 2, 31, 4, 14)], r),                                     // the wheel's plinth
    layer([b(21, 4, 11, 24, 15, 14), b(29, 4, 11, 32, 15, 14)], "darkstone"),  // uprights behind it
    layer([roundV(b(23, 3, 2, 30, 15, 13), 4)], "steel"),                   // big wheel, standing
    layer([b(21, 8, 6, 32, 10, 9)], m),                                     // axle
    layer([b(19, 4, 6, 22, 6, 8), b(19, 4, 6, 21, 10, 8)], m),              // the crank handle
  ];
}

// Forge: a stone block on a stump, an iron anvil with its tools, a steel anvil on a dressed plinth.
function smithing(tier) {
  const w = WOOD[tier], m = METAL[tier];
  const anvil = tier === "crude" ? "stone" : tier === "sturdy" ? "iron" : "steel";
  if (tier === "crude") {
    return [
      layer([round(b(2, 0, 3, 14, 7, 13), 3)], w),                          // stump
      layer([b(1, 7, 2, 15, 11, 14)], anvil),                               // a squared stone for an anvil
      layer([b(18, 0, 4, 30, 5, 12)], "stone"),                             // stones for the tools
      layer([b(19, 5, 5, 29, 7, 11)], w),
      layer([b(21, 7, 6, 23, 10, 8)], m),                                   // hammer head and haft
      layer([b(21, 9, 7, 27, 10, 9)], w),
      layer([b(24, 7, 9, 28, 8, 11)], m),                                   // tongs
    ];
  }
  if (tier === "sturdy") {
    return [
      layer([b(3, 0, 3, 13, 6, 13)], w),                                    // timber block
      layer([b(5, 6, 5, 11, 9, 11)], anvil),                                // waist
      layer([b(2, 9, 3, 14, 12, 13)], anvil),                               // face
      layer([b(0, 10, 6, 3, 12, 10)], anvil),                               // horn
      layer([b(17, 0, 2, 31, 9, 14)], w),                                   // bench beside it
      layer([b(16, 9, 1, 32, 12, 15)], w),
      layer([b(19, 12, 3, 21, 15, 5)], m),                                  // hammer standing
      layer([b(23, 12, 4, 29, 13, 6)], m),                                  // tongs
      layer([round(b(22, 0, 9, 30, 8, 15), 2)], m),                         // quench bucket
      layer([round(b(23, 7, 10, 29, 9, 14), 2)], "water"),
    ];
  }
  return [
    layer([b(1, 0, 2, 15, 6, 14)], "darkstone"),                            // dressed plinth
    layer([b(4, 6, 5, 12, 9, 11)], anvil),
    layer([b(1, 9, 2, 15, 13, 14)], anvil),                                 // heavy face
    layer([b(0, 10, 6, 1, 13, 10)], anvil),
    layer([b(2, 13, 3, 14, 14, 13)], m),                                    // gold band along the face
    layer([b(17, 0, 2, 31, 10, 14)], "darkstone"),                          // tool wall
    layer([b(16, 10, 1, 32, 13, 15)], "steel"),
    layer([b(18, 13, 1, 20, 16, 3), b(22, 13, 1, 24, 16, 3), b(26, 13, 1, 28, 16, 3)], "steel"),  // blades in the rack
    layer([b(17, 15, 0, 31, 16, 1)], m),
    layer([round(b(22, 13, 8, 30, 16, 14), 2)], m),                         // a gilded quench bowl
  ];
}

// Tannery: poles and a pit, a squared frame and a vat, two frames and a lined vat.
function tanning(tier) {
  const w = WOOD[tier], m = METAL[tier];
  if (tier === "crude") {
    return [
      layer([b(18, 0, 9, 21, 16, 12), b(28, 0, 9, 31, 16, 12)], w),         // two poles, set back
      layer([b(18, 13, 9, 31, 16, 12)], w),                                 // crossbar
      layer([b(19, 2, 6, 30, 14, 8)], "hide"),                              // the hide hangs in front of them
      layer([b(19, 1, 5, 20, 15, 9), b(29, 1, 5, 30, 15, 9)], "leather"),   // its lacing
      layer([b(1, 0, 2, 15, 5, 14)], "stone"),                              // the soaking pit, ringed with stones
      layer([b(3, 4, 4, 13, 6, 12)], "water"),
    ];
  }
  if (tier === "sturdy") {
    return [
      layer([b(17, 0, 9, 20, 16, 13), b(28, 0, 9, 31, 16, 13)], w),         // squared frame
      layer([b(17, 14, 9, 31, 16, 13), b(17, 0, 9, 31, 2, 13)], w),
      layer([b(18, 3, 6, 30, 14, 8)], "hide"),                              // stretched across the front
      layer([b(18, 2, 5, 30, 3, 9), b(18, 13, 5, 30, 14, 9)], w),           // the battens it is nailed to
      layer([b(1, 0, 2, 15, 11, 14)], w),                                   // plank vat
      layer([b(0, 9, 1, 16, 12, 15)], m),                                   // iron rim
      layer([b(2, 11, 3, 14, 12, 13)], "water"),
      layer([b(4, 12, 4, 12, 14, 12)], "hide"),                             // a hide soaking in it
    ];
  }
  return [
    layer([b(17, 0, 11, 20, 16, 15), b(28, 0, 11, 31, 16, 15)], w),         // the tall frame, at the back
    layer([b(17, 14, 11, 31, 16, 15)], w),
    layer([b(18, 3, 9, 30, 14, 11)], "leather"),                            // finished leather on it
    layer([b(18, 0, 4, 20, 11, 7), b(29, 0, 4, 31, 11, 7)], w),             // a second, lower frame in front
    layer([b(18, 9, 4, 31, 11, 7)], w),
    layer([b(19, 2, 2, 30, 9, 4)], "hide"),
    layer([b(1, 0, 2, 15, 10, 14)], "darkstone"),                           // stone-lined vat
    layer([b(0, 10, 1, 16, 13, 15)], m),
    layer([b(2, 12, 3, 14, 13, 13)], "water"),
    layer([round(b(4, 13, 5, 12, 16, 11), 2)], "leather"),                  // a roll of finished leather
  ];
}

// Alchemy: a pot on three stones, a pot hung from an iron tripod, a wide cauldron on a hearth. One cell.
function cauldron(tier) {
  const m = tier === "crude" ? "iron" : tier === "sturdy" ? "steel" : "copper";
  if (tier === "crude") {
    return [
      layer([b(1, 0, 4, 4, 3, 8), b(12, 0, 4, 15, 3, 8), b(6, 0, 12, 10, 3, 15)], "stone"),  // three stones
      layer([b(5, 1, 5, 11, 3, 11)], "ember"),                              // the fire between them
      layer([round(b(3, 3, 3, 13, 10, 13), 3)], m),                         // the pot
      layer([round(b(2, 9, 2, 14, 11, 14), 3)], m),                         // its rim
      layer([b(4, 11, 4, 12, 12, 12)], "water"),
    ];
  }
  if (tier === "sturdy") {
    return [
      layer([b(2, 0, 2, 4, 11, 4), b(12, 0, 2, 14, 11, 4), b(7, 0, 13, 9, 11, 15)], "iron"),  // tripod
      layer([b(2, 10, 2, 14, 12, 15)], "iron"),
      layer([b(4, 0, 5, 12, 2, 12)], "ember"),
      layer([round(b(2, 3, 2, 14, 10, 14), 4)], m),                         // bigger belly
      layer([round(b(1, 9, 1, 15, 12, 15), 3)], m),
      layer([b(3, 12, 3, 13, 13, 13)], "water"),
    ];
  }
  return [
    layer([b(0, 0, 0, 16, 4, 16)], "darkstone"),                            // hearth
    layer([b(3, 3, 3, 13, 5, 13)], "ember"),
    layer([round(b(1, 4, 1, 15, 11, 15), 4)], m),                           // wide cauldron
    layer([round(b(0, 10, 0, 16, 13, 16), 3)], "gold"),                     // gilded rim
    layer([b(2, 13, 2, 14, 14, 14)], "water"),
    layer([b(0, 4, 7, 2, 16, 9), b(2, 14, 7, 9, 16, 9)], "iron"),           // the arm it hangs from
  ];
}

// Smelting: a clay dome, a brick furnace with a chimney, a dark stone furnace with a vent. Two cells TALL.
function furnace(tier) {
  const r = ROCK[tier], m = METAL[tier];
  if (tier === "crude") {
    const body = [
      layer([b(0, 0, 0, 5, 16, 16), b(11, 0, 0, 16, 16, 16),
             b(5, 0, 9, 11, 16, 16), b(5, 10, 0, 11, 16, 9)], r),           // the mouth left open
      layer([b(5, 0, 7, 11, 3, 9)], "ember"),
    ];
    const top = [
      layer([round(b(1, 0, 1, 15, 9, 15), 3)], r),                          // the dome
      layer([round(b(5, 9, 5, 11, 14, 11), 1)], r),                         // short flue
      layer([b(6, 13, 6, 10, 14, 10)], "coal"),
    ];
    return [body, top];
  }
  if (tier === "sturdy") {
    const body = [
      layer([b(0, 0, 0, 4, 16, 16), b(12, 0, 0, 16, 16, 16),
             b(4, 0, 10, 12, 16, 16), b(4, 11, 0, 12, 16, 10)], r),
      layer([b(3, 9, 0, 13, 12, 1)], m),                                    // iron lintel over the mouth
      layer([b(4, 0, 8, 12, 3, 10)], "ember"),
      layer([b(0, 0, 0, 16, 2, 16)], "stone"),                              // footing
    ];
    const top = [
      layer([b(0, 0, 0, 16, 8, 16)], r),
      layer([b(1, 8, 1, 15, 10, 15)], "stone"),                             // the shoulder course
      layer([b(5, 10, 5, 11, 16, 11)], r),                                  // square chimney
      layer([b(4, 14, 4, 12, 15, 12)], m),
    ];
    return [body, top];
  }
  const body = [
    layer([b(0, 0, 0, 4, 16, 16), b(12, 0, 0, 16, 16, 16),
           b(4, 0, 10, 12, 16, 16), b(4, 12, 0, 12, 16, 10)], r),
    layer([b(3, 10, 0, 13, 13, 2)], m),                                     // gilded lintel
    layer([b(4, 0, 8, 12, 4, 10)], "ember"),
    layer([b(0, 0, 0, 16, 2, 16)], "darkstone"),
    layer([b(0, 7, 0, 1, 10, 16), b(15, 7, 0, 16, 10, 16)], m),             // vent bands
  ];
  const top = [
    layer([b(0, 0, 0, 16, 7, 16)], r),
    layer([b(0, 7, 0, 16, 9, 16)], "darkstone"),
    layer([b(5, 9, 5, 11, 15, 11)], r),
    layer([b(4, 13, 4, 12, 16, 12)], m),                                    // the cap
  ];
  return [body, top];
}

// Melting: a bowl on a stone ring, a brick stack with bellows, dark stone with a gilded crucible.
function crucible(tier) {
  const w = WOOD[tier], r = ROCK[tier], m = METAL[tier];
  if (tier === "crude") {
    return [
      layer([round(b(1, 0, 1, 15, 6, 15), 3)], "stone"),                    // ring of stones
      layer([b(3, 5, 3, 13, 7, 13)], "ember"),
      layer([round(b(4, 6, 4, 12, 12, 12), 2)], r),                         // the clay bowl
      layer([b(5, 11, 5, 11, 12, 11)], "ember"),
      layer([b(18, 0, 4, 30, 4, 12)], "stone"),                             // the coal pile beside it
      layer([b(19, 4, 5, 29, 7, 11)], "coal"),
    ];
  }
  if (tier === "sturdy") {
    return [
      layer([b(1, 0, 1, 15, 9, 15)], r),                                    // brick stack
      layer([b(2, 9, 2, 14, 11, 14)], "stone"),
      layer([round(b(4, 11, 4, 12, 16, 12), 2)], m),                        // iron crucible on top
      layer([b(5, 15, 5, 11, 16, 11)], "ember"),
      layer([b(1, 3, 6, 15, 6, 10)], m),                                    // the tuyere
      layer([b(17, 0, 3, 23, 7, 13)], w),                                   // bellows
      layer([b(22, 4, 5, 31, 9, 11)], "leather"),
      layer([b(29, 3, 6, 32, 11, 10)], w),                                  // its handle
    ];
  }
  return [
    layer([b(0, 0, 0, 16, 10, 16)], r),
    layer([b(0, 10, 0, 16, 12, 16)], "darkstone"),
    layer([round(b(3, 12, 3, 13, 16, 13), 2)], m),                          // gilded crucible
    layer([b(4, 15, 4, 12, 16, 12)], "ember"),
    layer([b(0, 4, 6, 16, 7, 10)], m),
    layer([b(17, 0, 2, 24, 8, 14)], "darkstone"),                           // double bellows
    layer([b(23, 4, 3, 31, 10, 13)], "leather"),
    layer([b(30, 3, 5, 32, 12, 11)], w),
    layer([b(18, 8, 3, 23, 9, 13)], m),
  ];
}

// Scribing: a slanted plank, a writing desk with scrolls, a lectern with a rune plate. Rune slots grow with the tier.
function scribe(tier) {
  const w = WOOD[tier], m = METAL[tier];
  if (tier === "crude") {
    return [
      layer([b(17, 0, 3, 21, 10, 7), b(27, 0, 3, 31, 10, 7),
             b(17, 0, 11, 21, 8, 15), b(27, 0, 11, 31, 8, 15)], w),         // four posts, the front pair shorter
      layer([b(16, 8, 2, 32, 11, 16), b(16, 10, 2, 32, 13, 9)], w),         // the slanted plank
      layer([b(19, 13, 3, 29, 14, 8)], "paper"),                            // a sheet on it
      layer([b(1, 0, 3, 13, 7, 13)], w),                                    // a crate of scrolls
      layer([b(2, 7, 4, 12, 9, 12)], "paper"),
      layer([b(5, 9, 6, 9, 11, 10)], m),                                    // the inkpot
    ];
  }
  if (tier === "sturdy") {
    return [
      layer([b(16, 10, 0, 32, 13, 16), b(16, 13, 0, 32, 15, 8)], w),        // desk with a sloped lid
      layer(legs(16, 32, 0, 10, 3, 1), w),
      layer([b(18, 6, 1, 30, 9, 2)], "pale"),                               // drawer
      layer([b(22, 7, 0, 26, 8, 1)], m),
      layer([b(19, 15, 2, 29, 16, 7)], "paper"),
      layer([b(1, 0, 2, 15, 3, 14), b(1, 3, 2, 3, 14, 14), b(13, 3, 2, 15, 14, 14),
             b(1, 13, 2, 15, 15, 14), b(1, 8, 3, 15, 9, 13)], w),           // shelf of two levels
      layer([b(4, 3, 4, 12, 8, 12), b(4, 9, 4, 12, 13, 12)], "paper"),      // scrolls
      layer([b(6, 15, 5, 10, 16, 9)], m),                                   // inkwell on top
    ];
  }
  return [
    layer([b(16, 11, 0, 32, 14, 16), b(16, 14, 0, 32, 16, 9)], w),          // heavy lectern top
    layer([b(17, 1, 1, 31, 11, 15)], w),                                    // panelled body
    layer([b(16, 0, 0, 32, 1, 16)], "darkstone"),
    layer([b(21, 14, 9, 27, 16, 12)], "rune"),                              // the rune plate set in the desk
    layer([b(17, 10, 0, 31, 11, 1)], m),                                    // gold banding
    layer([b(1, 0, 2, 15, 2, 14), b(1, 2, 2, 3, 15, 14), b(13, 2, 2, 15, 15, 14),
           b(1, 14, 2, 15, 16, 14), b(1, 6, 3, 15, 7, 13), b(1, 10, 3, 15, 11, 13)], w),  // bookcase
    layer([b(4, 2, 4, 12, 6, 12), b(4, 7, 4, 12, 10, 12), b(4, 11, 4, 12, 14, 12)], "paper"),
    layer([b(5, 16, 6, 7, 16, 8)], "ember"),                                // a candle burning on it
  ];
}

// Engraving: a stone slab to carve runes on, with the rune stone on its stand. One tier.
function engraving() {
  return [
    layer([b(16, 10, 0, 32, 13, 16)], "stone"),                             // stone-topped bench
    layer(legs(16, 32, 0, 10, 3, 1), "log"),
    layer([b(19, 13, 3, 29, 15, 13)], "darkstone"),                         // the blank being carved
    layer([b(23, 15, 6, 25, 16, 10)], "rune"),
    layer([b(21, 13, 1, 27, 14, 3)], "iron"),                               // chisels
    layer([b(3, 0, 3, 13, 4, 13)], "stone"),                                // the rune stand
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
const CAMPFIRE_FROM = [1, 3];   // where the campfire is in the sheet today
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

  const dir = path.join(project, "App", "Content", "Assets", "Tiles");
  const color = new L.Sheet(path.join(dir, "Tables.png"));
  const normal = new L.Sheet(path.join(dir, "Tables_n.png"));
  const campfire = color.read(CAMPFIRE_FROM[0], CAMPFIRE_FROM[1]);
  const campfireNormal = normal.read(CAMPFIRE_FROM[0], CAMPFIRE_FROM[1]);

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
  color.paste(CAMPFIRE_AT[0], CAMPFIRE_AT[1], campfire);
  normal.paste(CAMPFIRE_AT[0], CAMPFIRE_AT[1], campfireNormal);
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
  icons.paste(3, row, campfire);
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
