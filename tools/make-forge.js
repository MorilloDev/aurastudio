"use strict";

// Draws the forge's parts — blades, tool heads, plates and metal arrows — into Items/Materials.png, with the same
// block generator the stations use, so a part looks like it came out of the same workshop.
//
//   node tools/make-forge.js <carpeta del proyecto Aura> [--dry]
const path = require("path");
const L = require("./block-lib.js");

const METAL = {
  copper: ["#6b3f22", "#c08048"],
  bronze: ["#6a4a1e", "#c9a04a"],
  iron: ["#3f4046", "#8a8d96"],
  steel: ["#55585f", "#b0b6c2"],
};
METAL.bronze = ["#6a4a1e", "#c9a04a"];

const WOOD = ["#43321d", "#7a5c36"];
const FEATHER = ["#8d7a5a", "#d8cfbb"];

const I = require("./icon-lib.js");

const WOODC = ["#3a2a18", "#8a6a3d"];
const FEATHERC = ["#6f6450", "#e4dcc8"];

// Each part is a stack of silhouettes painted back to front.
const PART = {
  blade: (m) => (c) => {
    I.paint(c, (x, y) => I.bladeShape(x, y) && y >= 45, ...WOODC, { shine: 0 });   // the tang
    I.paint(c, (x, y) => I.bladeShape(x, y) && y < 45, ...m, { shine: 0.4 });
  },
  head: (m) => (c) => {
    I.paint(c, (x, y) => x > 30 && x < 44 && y > 6 && y < 58, ...WOODC, { shine: 0 });  // the haft through the eye
    I.paint(c, (x, y) => I.headShape(x, y) && !I.eyeHole(x, y), ...m, { shine: 0.35 });
  },
  plate: (m) => (c) => {
    I.paint(c, I.plateShape, ...m, { shine: 0.3, maxDepth: 9 });
    I.paint(c, (x, y) => [[14, 24], [50, 24], [14, 40], [50, 40]].some(([px, py]) =>
      (x - px) ** 2 + (y - py) ** 2 < 9) && I.plateShape(x, y), ...m, { shine: 0.9, rim: 0.1, maxDepth: 2 });
  },
  arrow: (m) => (c) => {
    I.paint(c, I.fletchShape, ...FEATHERC, { shine: 0.15 });
    I.paint(c, (x, y) => I.arrowShape(x, y) && y >= 22, ...WOODC, { shine: 0.1 });
    I.paint(c, (x, y) => I.arrowShape(x, y) && y < 22, ...m, { shine: 0.45 });
  },
};

// Where each one goes in Materials.png. Row 9 was empty; the two arrows sit beside the old ones.
const LAYOUT = [
  ["copper_blade", "blade", "copper", 0, 9],
  ["bronze_blade", "blade", "bronze", 1, 9],
  ["iron_blade", "blade", "iron", 2, 9],
  ["steel_blade", "blade", "steel", 3, 9],
  ["copper_head", "head", "copper", 4, 9],
  ["bronze_head", "head", "bronze", 5, 9],
  ["iron_head", "head", "iron", 6, 9],
  ["steel_head", "head", "steel", 7, 9],
  ["iron_plate", "plate", "iron", 8, 9],
  ["steel_plate", "plate", "steel", 9, 9],
  ["iron_arrow", "arrow", "iron", 0, 7],
  ["steel_arrow", "arrow", "steel", 1, 7],
];

function main() {
  const project = process.argv[2];
  const dry = process.argv.includes("--dry");
  if (!project) {
    console.error("Uso: node tools/make-forge.js <carpeta del proyecto Aura> [--dry]");
    process.exit(1);
  }
  const file = path.join(project, "App", "Content", "Assets", "Items", "Materials.png");
  const sheet = new L.Sheet(file);
  const coords = {};
  for (const [id, kind, metal, col, row] of LAYOUT) {
    const cell = new Uint8ClampedArray(I.CELL * I.CELL * 4);
    PART[kind](METAL[metal])(cell);
    sheet.paste(col, row, cell);
    coords[id] = [col, row];
  }
  console.log(JSON.stringify(coords));
  if (dry) { console.log("--dry: no se ha escrito nada."); return; }
  sheet.save();
  console.log(`Escritas ${LAYOUT.length} piezas en ${file}`);
}

main();
