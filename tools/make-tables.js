"use strict";

// Draws the crafting stations into Tables.png and Tables_n.png with the Studio's own block generator, so the tiers of
// one station are the same piece in a better material instead of three unrelated sprites.
//
//   node tools/make-tables.js <carpeta del proyecto Aura> [--dry]
//
// The crude station that already exists is left alone: only the cells listed in LAYOUT are written.
const path = require("path");
const L = require("./block-lib.js");

// ── Materials ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Browns taken from the crude workbench that is already in the sheet, so a sturdy table next to it reads as the same
// workshop. Each tier moves one step: rough logs, planed planks, dark hardwood with metal.
const MAT = {
  log: () => L.faces((s) => L.grainTex("#3f2f1b", "#6b512e", { seed: s })),
  plank: () => L.faces((s) => L.planks("#55401f", "#8a6a3d", { seed: s, boards: 4 })),
  darkwood: () => L.faces((s) => L.planks("#2c1f14", "#55392a", { seed: s, boards: 5 })),
  pale: () => L.faces((s) => L.planks("#8d7a5a", "#c0ac96", { seed: s, boards: 3 })),
  stone: () => L.faces((s) => L.speckle("#4a4a4e", "#7d7d84", { seed: s })),
  brick: () => L.faces((s) => L.planks("#5a3a30", "#8d5a46", { seed: s, boards: 4, grain: 0.1 })),
  darkstone: () => L.faces((s) => L.speckle("#2b2b31", "#55555f", { seed: s })),
  iron: () => L.faces((s) => L.speckle("#3f4046", "#767982", { seed: s, spread: 0.6 })),
  steel: () => L.faces((s) => L.speckle("#55585f", "#9aa0ac", { seed: s, spread: 0.5 })),
  gold: () => L.faces((s) => L.speckle("#8a6a1e", "#e3c468", { seed: s, spread: 0.4 })),
  copper: () => L.faces((s) => L.speckle("#6b3f22", "#b4743a", { seed: s, spread: 0.5 })),
  leather: () => L.faces((s) => L.speckle("#6b543a", "#a98f66", { seed: s, spread: 0.7 })),
  coal: () => L.faces((s) => L.speckle("#16161a", "#33333a", { seed: s })),
};

const cache = new Map();
const mat = (name) => {
  if (!cache.has(name)) cache.set(name, MAT[name]());
  return cache.get(name);
};

// ── Shape helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
// Boxes are in 16ths of a cell, like a tile's "collision": x left to right, y up, z front to back.
const b = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });

/** The two legs of a half-table: on the cell's outer side, so two cells side by side give a four-legged table. */
const legs = (outer, top, w = 3) => {
  const x0 = outer === "left" ? 1 : 16 - 1 - w;
  return [b(x0, 0, 1, x0 + w, top, 1 + w), b(x0, 0, 15 - w, x0 + w, top, 15)];
};

const tableTop = (y0 = 13) => [b(0, y0, 0, 16, 16, 16)];
const slab = (y0, y1) => [b(0, y0, 0, 16, y1, 16)];

// ── Stations ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Each entry gives, per cell, the layers it is made of: boxes drawn with one material. Nearest pixel wins, so a
// wooden top over a stone base needs no care beyond listing both.
const wood = { crude: "log", sturdy: "plank", mastered: "darkwood" };
const metal = { crude: "stone", sturdy: "iron", mastered: "gold" };
const rock = { crude: "stone", sturdy: "brick", mastered: "darkstone" };

function workbench(tier) {
  const w = wood[tier], m = metal[tier];
  const extra = (side) => {
    if (tier === "crude") return [];
    // A shelf under the top, and on the mastered one a band of metal around the apron.
    const shelf = { boxes: [b(2, 5, 2, 14, 7, 14)], mat: w };
    if (tier === "sturdy") return [shelf, { boxes: [b(side === "left" ? 1 : 12, 7, 1, side === "left" ? 4 : 15, 9, 15)], mat: m }];
    // A full apron under the top: a thin band peeking out from behind the top frays into teeth at this size.
    return [shelf, { boxes: [b(0, 9, 0, 16, 12, 16)], mat: m }];
  };
  return ["left", "right"].map((side) => [
    { boxes: tableTop(tier === "mastered" ? 13 : 12), mat: w },
    { boxes: legs(side, tier === "mastered" ? 13 : 12, tier === "crude" ? 4 : 3), mat: w },
    ...extra(side),
  ]);
}

function smithing(tier) {
  const w = wood[tier], m = metal[tier], anvil = tier === "crude" ? "stone" : tier === "sturdy" ? "iron" : "steel";
  const anvilCell = [
    { boxes: [b(3, 0, 3, 13, 5, 13)], mat: w },                       // stump
    { boxes: [b(6, 5, 6, 10, 9, 10)], mat: anvil },                   // waist
    { boxes: [b(2, 9, 4, 14, 13, 12)], mat: anvil },                  // face
    { boxes: [b(0, 10, 6, 2, 12, 10)], mat: anvil },                  // horn
  ];
  if (tier === "mastered") anvilCell.push({ boxes: [b(4, 13, 5, 12, 15, 11)], mat: "gold" });
  const bench = [
    { boxes: tableTop(12), mat: w },
    { boxes: legs("right", 12, 3), mat: w },
    { boxes: [b(2, 12, 3, 6, 15, 6), b(9, 12, 4, 13, 14, 11)], mat: m },  // tools left on the bench
  ];
  return [anvilCell, bench];
}

function tanning(tier) {
  const w = wood[tier];
  const hide = tier === "mastered" ? "leather" : tier === "sturdy" ? "leather" : "pale";
  const frame = [
    { boxes: [b(2, 0, 6, 4, 16, 9), b(12, 0, 6, 14, 16, 9), b(2, 14, 6, 14, 16, 9)], mat: w },
    { boxes: [b(4, 2, 6.5, 12, 14, 8.5)], mat: hide },
  ];
  if (tier !== "crude") frame.push({ boxes: [b(2, 0, 5, 14, 2, 10)], mat: w });
  const vat = [
    { boxes: [b(3, 0, 3, 13, tier === "crude" ? 8 : 11, 13)], mat: w },
    { boxes: [b(2, tier === "crude" ? 7 : 10, 2, 14, tier === "crude" ? 9 : 12, 14)], mat: metal[tier] },
  ];
  if (tier === "mastered") vat.push({ boxes: [b(4, 12, 4, 12, 13, 12)], mat: "leather" });
  return [frame, vat];
}

function cauldron(tier) {
  const pot = tier === "crude" ? "iron" : tier === "sturdy" ? "steel" : "gold";
  return [[
    { boxes: [b(2, 0, 2, 14, 3, 14)], mat: rock[tier] },               // the stones it stands on
    { boxes: [b(4, 2, 4, 12, 6, 12)], mat: pot },                      // foot
    { boxes: [b(2, 6, 2, 14, 12, 14)], mat: pot },                     // belly
    { boxes: [b(3, 12, 3, 13, 14, 13)], mat: "coal" },                 // what is in it
  ]];
}

// Two cells tall: the body with its mouth, then the chimney. Boxes leave the mouth open instead of cutting it.
function furnace(tier) {
  const r = rock[tier], m = metal[tier];
  const body = [
    { boxes: [b(0, 0, 0, 5, 16, 16), b(11, 0, 0, 16, 16, 16), b(5, 0, 9, 11, 16, 16), b(5, 11, 0, 11, 16, 9)], mat: r },
    { boxes: [b(5, 0, 8, 11, 2, 9)], mat: "coal" },
  ];
  if (tier !== "crude") body.push({ boxes: [b(4, 10, 0, 12, 12, 1)], mat: m });
  const top = [
    { boxes: [b(0, 0, 0, 16, 10, 16)], mat: r },
    { boxes: [b(5, 10, 5, 11, 16, 11)], mat: tier === "mastered" ? m : r },
  ];
  return [body, top];
}

function crucible(tier) {
  const r = rock[tier], m = metal[tier];
  return [
    [
      { boxes: [b(1, 0, 1, 15, 7, 15)], mat: r },
      { boxes: [b(3, 7, 3, 13, 12, 13)], mat: m },
      { boxes: [b(5, 12, 5, 11, 13, 11)], mat: "coal" },
    ],
    [
      { boxes: [b(2, 0, 2, 14, 5, 14)], mat: r },
      { boxes: [b(4, 5, 4, 12, 9, 12)], mat: "coal" },
      { boxes: [b(3, 9, 3, 13, 11, 13)], mat: m },
    ],
  ];
}

function woodworking(tier) {
  const w = wood[tier], m = metal[tier];
  const bench = [
    { boxes: slab(10, 13), mat: w },
    { boxes: legs("left", 10, 3), mat: w },
    { boxes: [b(3, 13, 4, 13, 16, 12)], mat: w },                      // the log being cut
    // The saw standing in the log is what tells this bench apart from the workbench.
    { boxes: [b(7, 13, 7, 9, 16, 9)], mat: m },
  ];
  const stack = [
    { boxes: [b(1, 0, 2, 15, 3, 14)], mat: w },
    { boxes: [b(2, 3, 3, 14, 6, 13)], mat: w },
    { boxes: [b(3, 6, 4, 13, 8, 12)], mat: tier === "crude" ? w : "pale" },
  ];
  if (tier === "mastered") stack.push({ boxes: [b(3, 8, 4, 13, 9, 12)], mat: m });
  return [bench, stack];
}

function stoneworking(tier) {
  const r = rock[tier], m = metal[tier], w = wood[tier];
  const bench = [
    { boxes: [b(0, 10, 0, 16, 14, 16)], mat: r },
    { boxes: legs("left", 10, 4), mat: w },
    { boxes: [b(4, 14, 5, 12, 16, 11)], mat: r },                      // the block being cut
    { boxes: [b(6, 14, 3, 10, 15, 5)], mat: m },                       // chisel
  ];
  const wheel = [
    { boxes: [b(3, 0, 3, 13, 5, 13)], mat: w },
    { boxes: [b(6, 5, 2, 10, 14, 14)], mat: r },                       // the grinding wheel on its side
    { boxes: [b(7, 8, 1, 9, 11, 15)], mat: m },                        // axle
  ];
  if (tier === "mastered") wheel.push({ boxes: [b(6, 14, 6, 10, 15, 10)], mat: "gold" });
  return [bench, wheel];
}

function engraving(tier) {
  const w = wood[tier], r = rock[tier], m = metal[tier];
  const bench = [
    { boxes: slab(10, 13), mat: w },
    { boxes: legs("left", 10, 3), mat: w },
    { boxes: [b(3, 13, 4, 13, 15, 12)], mat: r },                      // the slab being carved
    { boxes: [b(6, 15, 5, 10, 16, 7)], mat: m },                       // chisel
  ];
  const stand = [
    { boxes: [b(4, 0, 4, 12, 8, 12)], mat: r },
    { boxes: [b(5, 8, 5, 11, 13, 11)], mat: r },                       // the rune stone on its pedestal
    { boxes: [b(6, 13, 6, 10, 14, 10)], mat: m },
  ];
  return [bench, stand];
}

function scribe(tier) {
  const w = wood[tier], m = metal[tier];
  // A sloped writing top, built as three steps: the engine's cuts would smooth it, but at 64 px the steps read better.
  const desk = [
    { boxes: [b(0, 10, 0, 16, 12, 16), b(0, 12, 0, 16, 13, 11), b(0, 13, 0, 16, 14, 6)], mat: w },
    { boxes: legs("left", 10, 3), mat: w },
    { boxes: [b(3, 14, 1, 13, 15, 6)], mat: "pale" },                  // the sheet on it
  ];
  const shelf = [
    { boxes: [b(2, 0, 3, 14, 3, 13), b(2, 3, 3, 4, 14, 13), b(12, 3, 3, 14, 14, 13), b(2, 13, 3, 14, 15, 13)], mat: w },
    { boxes: [b(5, 4, 5, 11, 8, 11)], mat: "pale" },                   // scrolls
    { boxes: [b(5, 9, 6, 8, 12, 9)], mat: m },                         // inkwell
  ];
  return [desk, shelf];
}

// ── Icons ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// The inventory icon of a placed station: one cell holding the whole thing, not half of the two it occupies in the
// world. Same pieces and the same materials, so the icon and what gets placed are plainly the same table.
function iconTable(tier, extra = []) {
  const w = wood[tier];
  return [
    { boxes: slab(12, 16), mat: w },
    { boxes: [b(1, 0, 1, 4, 12, 4), b(12, 0, 1, 15, 12, 4), b(1, 0, 12, 4, 12, 15), b(12, 0, 12, 15, 12, 15)], mat: w },
    ...extra,
  ];
}

function icon(family, tier) {
  const w = wood[tier], m = metal[tier], r = rock[tier];
  switch (family) {
    case "workbench": return iconTable(tier, tier === "crude" ? [] : [{ boxes: [b(2, 8, 2, 14, 10, 14)], mat: tier === "mastered" ? m : w }]);
    case "smithing_table": return smithing(tier)[0];
    case "tanning_rack": return tanning(tier)[0];
    case "cauldron": return cauldron(tier)[0];
    case "crucible": return crucible(tier)[0];
    case "engraving_table": return engraving(tier)[1];
    case "scribe_table": return scribe(tier)[0];
    case "woodworking_table": return [
      { boxes: slab(10, 13), mat: w },
      { boxes: [b(1, 0, 1, 4, 10, 4), b(12, 0, 1, 15, 10, 4), b(1, 0, 12, 4, 10, 15), b(12, 0, 12, 15, 10, 15)], mat: w },
      { boxes: [b(3, 13, 4, 13, 16, 12)], mat: w },                    // the log on the bench
      { boxes: [b(7, 13, 7, 9, 16, 9)], mat: m },                      // the saw standing in it
    ];
    case "stoneworking_table": return stoneworking(tier)[1];
    case "campfire": return [
      { boxes: [b(1, 0, 1, 15, 3, 15)], mat: "stone" },
      { boxes: [b(4, 3, 7, 12, 5, 9), b(7, 3, 4, 9, 5, 12)], mat: "log" },
      { boxes: [b(6, 5, 6, 10, 7, 10)], mat: "coal" },
    ];
    case "furnace": {
      const body = furnace(tier)[0];
      return [...body, { boxes: [b(5, 16, 5, 11, 16, 11)], mat: r }];
    }
    default: return iconTable(tier);
  }
}

// ── Layout ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Which cells of Tables.png each piece is written to. The crude stations already in the sheet keep their cells.
const LAYOUT = [
  // The stations that were sharing one placeholder table get a piece of their own.
  { id: "crude_smithing_table", make: () => smithing("crude"), cells: [[0, 2], [1, 2]] },
  { id: "crude_crucible", make: () => crucible("crude"), cells: [[6, 2], [7, 2]] },
  { id: "crude_engraving_table", make: () => engraving("crude"), cells: [[0, 7], [1, 7]] },
  { id: "crude_scribe_table", make: () => scribe("crude"), cells: [[2, 7], [3, 7]] },

  { id: "sturdy_workbench", make: () => workbench("sturdy"), cells: [[2, 0], [3, 0]] },
  { id: "mastered_workbench", make: () => workbench("mastered"), cells: [[4, 0], [5, 0]] },

  { id: "sturdy_furnace", make: () => furnace("sturdy"), cells: [[4, 1], [5, 1]], back: [[6, 1], [7, 1]] },
  { id: "mastered_furnace", make: () => furnace("mastered"), cells: [[0, 5], [1, 5]], back: [[2, 5], [3, 5]] },

  { id: "sturdy_smithing_table", make: () => smithing("sturdy"), cells: [[2, 2], [3, 2]] },
  { id: "mastered_smithing_table", make: () => smithing("mastered"), cells: [[4, 2], [5, 2]] },

  { id: "sturdy_cauldron", make: () => cauldron("sturdy"), cells: [[2, 3]] },
  { id: "mastered_cauldron", make: () => cauldron("mastered"), cells: [[3, 3]] },

  { id: "sturdy_crucible", make: () => crucible("sturdy"), cells: [[4, 3], [5, 3]] },
  { id: "mastered_crucible", make: () => crucible("mastered"), cells: [[6, 3], [7, 3]] },

  { id: "sturdy_tanning_rack", make: () => tanning("sturdy"), cells: [[2, 4], [3, 4]] },
  { id: "mastered_tanning_rack", make: () => tanning("mastered"), cells: [[4, 4], [5, 4]] },

  { id: "crude_woodworking_table", make: () => woodworking("crude"), cells: [[4, 5], [5, 5]] },
  { id: "sturdy_woodworking_table", make: () => woodworking("sturdy"), cells: [[6, 5], [7, 5]] },
  { id: "mastered_woodworking_table", make: () => woodworking("mastered"), cells: [[0, 6], [1, 6]] },

  { id: "crude_stoneworking_table", make: () => stoneworking("crude"), cells: [[2, 6], [3, 6]] },
  { id: "sturdy_stoneworking_table", make: () => stoneworking("sturdy"), cells: [[4, 6], [5, 6]] },
  { id: "mastered_stoneworking_table", make: () => stoneworking("mastered"), cells: [[6, 6], [7, 6]] },
];

// Inventory icons, in Placeables.png: a row per family, a column per tier. Rows 0 and 1 are left as they are.
const ICON_ROWS = [
  ["workbench", 2], ["furnace", 3], ["smithing_table", 4], ["tanning_rack", 5],
  ["cauldron", 6], ["crucible", 7], ["woodworking_table", 8], ["stoneworking_table", 9],
];
const ICON_SINGLES = [["engraving_table", 3, 2], ["scribe_table", 4, 2], ["campfire", 5, 2]];
const TIERS = ["crude", "sturdy", "mastered"];

// ── Run ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function drawCell(layers, facing) {
  return L.stack(layers.map((l) => L.layer(l.boxes, mat(l.mat), { facing })));
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

  for (const piece of LAYOUT) {
    const cells = piece.make();
    for (const [i, cell] of cells.entries()) {
      const at = piece.cells[i];
      const front = drawCell(cell, "front");
      color.paste(at[0], at[1], front.color);
      normal.paste(at[0], at[1], front.normal);

      if (!piece.back) continue;
      const back = drawCell(cell, "back");
      color.paste(piece.back[i][0], piece.back[i][1], back.color);
      normal.paste(piece.back[i][0], piece.back[i][1], back.normal);
    }
    console.log(`${piece.id}: ${cells.length} celda(s)${piece.back ? " + trasera" : ""}`);
  }

  const items = path.join(project, "App", "Content", "Assets", "Items");
  const icons = new L.Sheet(path.join(items, "Placeables.png"));
  for (const [family, row] of ICON_ROWS) {
    TIERS.forEach((tier, col) => {
      icons.paste(col, row, drawCell(icon(family, tier), "front").color);
    });
    console.log(`icono ${family}: fila ${row}`);
  }
  for (const [family, col, row] of ICON_SINGLES) {
    icons.paste(col, row, drawCell(icon(family, "crude"), "front").color);
    console.log(`icono ${family}: (${col}, ${row})`);
  }

  if (dry) { console.log("--dry: no se ha escrito nada."); return; }
  color.save();
  normal.save();
  icons.save();
  console.log(`Escritas ${path.join(dir, "Tables.png")}, Tables_n.png y ${path.join(items, "Placeables.png")}`);
}

main();
