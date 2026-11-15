"use strict";

// Draws the game's flowers and their petal icons with the Studio's own plant generator, straight into the project's
// sheets. The Plantas tab makes one plant at a time by hand; this makes the whole set the same way, so re-running it
// after a change to a variety redraws every flower that uses it instead of redoing them one by one.
//
//   node tools/make-flowers.js <path to the Aura project>        draws them
//   node tools/make-flowers.js <path> --dry                      says what it would draw and where
//
// What it writes: Assets/Tiles/Foliage.png and Foliage_n.png (the plants and their normals) and
// Assets/Items/Materials.png (the petal icons). The tile and item JSON is not touched — the ids and the cells below
// are the contract between the two, and the files already name them.

const fs = require("fs");
const path = require("path");
const { presets, render, Sheet } = require("./plant-lib.js");

const P = presets("FLOWER");

// Shared shape: a small clump, upright, kept inside the cell's diamond. The varieties below only say what the flower
// is and what colour it is — everything about how it sits in the world is decided once, here, so a new flower lands
// next to the others instead of looking like it came from somewhere else.
const CLUMP = {
  distribution: "GRID",
  positionJitter: 0.35,
  separation: 0.16,
  inclination: 6,
  inclinationVariation: 10,
  keepInCell: true,
  fitSprite: true,
};

// The flowers, each with the cell it owns in Foliage.png. Cells are [col, row]; a row past the end of the sheet grows
// it, which is why the new ones sit on a row of their own.
const FLOWERS = [
  { id: "daisy", cell: [0, 10], opts: { ...P.DAISY, ...CLUMP, count: 3, scale: 1.25, seed: 5 } },
  { id: "bluebell", cell: [1, 10], opts: { ...P.BELL, ...CLUMP, count: 4, scale: 1.3, seed: 12, petalCount: 7 } },
  {
    id: "orange_tulip", cell: [2, 10],
    opts: { ...P.TULIP, ...CLUMP, count: 2, scale: 1.3, seed: 21, petalColor: "#e8873a", petalTipColor: "#ffb86a" },
  },
  { id: "poppy", cell: [3, 10], opts: { ...P.POPPY, ...CLUMP, count: 3, scale: 1.2, seed: 33 } },
];

// A petal icon is the same flower with its stem taken away and its head laid flat and scattered: the petals the
// flower is made of, seen from above. Drawing them from the flower's own values is what keeps an icon the colour of
// the plant it comes off, including after someone retunes that variety.
const LOOSE = {
  // stemBranches stays at its default: the head rides a branch, and at 0 the flower comes out with no head at all.
  count: 5, stemHeight: 0.02, stemWidth: 0.004, stemLeafCount: 0, showCenter: false,
  headFaceUp: 1, petalLayers: 1, petalCount: 5, petalTilt: 4, petalCurl: 0.1, petalLength: 0.17, petalWidth: 0.09,
  distribution: "SCATTER", areaSize: 0.55, inclination: 0, inclinationVariation: 0, bend: 0,
  sizeVariation: 0.25, groundZ: 0,
};

const PETALS = [
  { id: "rose_petals", cell: [6, 6], from: P.ROSE, seed: 4 },
  { id: "sunflower_petals", cell: [7, 6], from: P.SUNFLOWER, seed: 8 },
  { id: "lavender_petals", cell: [8, 6], from: P.LAVENDER, seed: 15 },
  { id: "daisy_petals", cell: [9, 6], from: P.DAISY, seed: 23 },
  { id: "bluebell_petals", cell: [10, 6], from: P.BELL, seed: 31 },
  { id: "tulip_petals", cell: [6, 7], from: { ...P.TULIP, petalColor: "#e8873a", petalTipColor: "#ffb86a" }, seed: 42 },
  { id: "poppy_petals", cell: [7, 7], from: P.POPPY, seed: 56 },
];

function main() {
  const project = process.argv[2];
  const dry = process.argv.includes("--dry");
  if (!project) {
    console.error("Usage: node tools/make-flowers.js <path to the Aura project> [--dry]");
    process.exit(1);
  }

  const tiles = path.join(project, "App/Content/Assets/Tiles");
  const items = path.join(project, "App/Content/Assets/Items");
  for (const file of ["Foliage.png", "Foliage_n.png"]) {
    if (!fs.existsSync(path.join(tiles, file))) {
      console.error(`Not found: ${path.join(tiles, file)} — is that the project folder?`);
      process.exit(1);
    }
  }

  const colour = new Sheet(path.join(tiles, "Foliage.png"));
  const normal = new Sheet(path.join(tiles, "Foliage_n.png"));
  const icons = new Sheet(path.join(items, "Materials.png"));

  for (const flower of FLOWERS) {
    const [col, row] = flower.cell;
    const parts = render("FLOWER", flower.opts);
    if (parts.length !== 1) {
      console.error(`${flower.id}: came out ${parts.length} cells tall; give it a cell per part or make it shorter.`);
      process.exit(1);
    }

    // A cell that already holds something that is not ours is a mistake worth stopping for: these sheets are hand-made
    // and an overwrite is not undoable.
    if (!colour.isEmpty(col, row) && !process.argv.includes("--overwrite"))
      console.warn(`${flower.id}: (${col}, ${row}) was not empty — redrawing it.`);

    console.log(`${flower.id.padEnd(14)} Foliage (${col}, ${row})`);
    if (dry) continue;
    colour.paste(col, row, parts[0].color);
    normal.paste(col, row, parts[0].normal);
  }

  for (const petal of PETALS) {
    const [col, row] = petal.cell;
    const parts = render("FLOWER", { ...petal.from, ...LOOSE, seed: petal.seed });
    console.log(`${petal.id.padEnd(14)} Materials (${col}, ${row})`);
    if (dry) continue;
    icons.paste(col, row, parts[0].color);
  }

  if (dry) return;
  colour.save();
  normal.save();
  icons.save();
  console.log(`\nDrawn: ${FLOWERS.length} flowers and ${PETALS.length} icons.`);
}

main();
