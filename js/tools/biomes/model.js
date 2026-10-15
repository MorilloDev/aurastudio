"use strict";

// Biome files (Data/Biomes/*.json) as BiomeData reads them: placement (surface by climate, coast strip, or open-sea
// decoration only), materials, decoration and colours — plus the multi-noise pick the generator uses (the biome whose
// climate box is nearest, summing squared distances per parameter), so the Studio can show which biome wins where.
(function (Aura) {
  const { readText, baseName, joinPath, dirName } = Aura.fs;
  const T = Aura.atlasTiles;

  const PARAMS = [
    ["temperature", "Temperatura"],
    ["humidity", "Humedad"],
    ["continentalness", "Continentalidad"],
    ["erosion", "Erosión"],
    ["pv", "Picos y valles"],
  ];

  // DecorationSurface, as "on" in a decoration entry ("" = Auto: from the tile's habitat).
  const SURFACES = [["", "Automático"], ["surface", "Suelo"], ["seafloor", "Fondo del agua"], ["shallows", "Orilla (emergente)"], ["watersurface", "Sobre el agua"]];

  const isBiomeFile = (entry) => /(^|\/)data\/biomes\/.+\.json$/.test(entry.lower);

  async function loadBiomes(project) {
    const docs = [];
    for (const entry of project.filter(isBiomeFile).sort((a, b) => a.path.localeCompare(b.path))) {
      const doc = { entry, path: entry.path, name: baseName(entry.path), root: null, eol: "\n", baseline: "", error: null, isNew: false };
      try {
        const text = await readText(entry.handle);
        doc.eol = text.includes("\r\n") ? "\r\n" : "\n";
        doc.root = JSON.parse(text);
        doc.baseline = serialize(doc);
      } catch (err) {
        doc.error = err.message;
      }
      docs.push(doc);
    }
    return docs;
  }

  const serialize = (doc) => T.formatJson(doc.root).replace(/\n/g, doc.eol) + doc.eol;
  const isDirty = (doc) => !!doc.root && (doc.isNew || serialize(doc) !== doc.baseline);

  /** "surface" | "coast" | "ocean" (decoration-only for the open sea). */
  function kindOf(root) {
    const p = root?.placement ?? {};
    if (p.ocean) return "ocean";
    if (p.coast) return "coast";
    return "surface";
  }

  const range = (v) => (Array.isArray(v) && v.length === 2 ? [Number(v[0]), Number(v[1])] : [0, 1]);

  /** The climate box of a surface or coast biome: every parameter as [min, max] (missing = the whole 0..1). */
  function boxOf(root) {
    const k = kindOf(root);
    const src = k === "coast" ? root.placement.coast : root.placement?.surface ?? {};
    return Object.fromEntries(PARAMS.map(([key]) => [key, range(src?.[key])]));
  }

  const dist = ([lo, hi], v) => (v < lo ? lo - v : v > hi ? v - hi : 0);

  /** The surface biome the generator picks for a climate { temperature, humidity, … }: the nearest box. */
  function pick(biomes, climate) {
    let best = null, bestD = Infinity;
    for (const b of biomes) {
      let d = 0;
      for (const [key] of PARAMS) d += dist(b.box[key], climate[key]) ** 2;
      if (d < bestD) { best = b; bestD = d; }
    }
    return { biome: best, distance: Math.sqrt(bestD) };
  }

  /** How many surface boxes contain the climate (0 = a gap the nearest biome fills, 2+ = an overlap). */
  function inside(biomes, climate) {
    let n = 0;
    for (const b of biomes) if (PARAMS.every(([key]) => dist(b.box[key], climate[key]) === 0)) n++;
    return n;
  }

  /** A fresh biome, in the shape the existing files have. */
  function blank(id, name) {
    return {
      id, name,
      placement: { surface: { temperature: [0.3, 0.7], humidity: [0.3, 0.7], continentalness: [0.55, 1] } },
      materials: { surface: "grass", surfaceVariants: [], shallow: "dirt", deep: "stone", shallowDepth: 3 },
      decoration: [],
      colors: { foliage: "#5ce365", atmosphere: "#5ce365" },
    };
  }

  /** Every tile id a biome names, with where, for checking them against the tile files. */
  function tileRefs(root) {
    const out = [];
    const m = root?.materials ?? {};
    for (const key of ["surface", "shallow", "deep"]) if (m[key]) out.push([m[key], "materials." + key]);
    (m.surfaceVariants ?? []).forEach((v, i) => v?.tile && out.push([v.tile, `materials.surfaceVariants[${i}]`]));
    (root?.decoration ?? []).forEach((d, i) => d?.tile && out.push([d.tile, `decoration[${i}]`]));
    return out;
  }

  /** Where a new biome file goes: next to the other biomes, or Data/Biomes beside Data/Tiles. */
  function newBiomePath(project, docs, id) {
    if (docs.length) return joinPath(dirName(docs[0].path), id + ".json");
    const tiles = project.filter((e) => /(^|\/)data\/tiles\/.+\.json$/.test(e.lower))[0];
    if (!tiles) return null;
    const at = tiles.lower.lastIndexOf("data/tiles/");
    const data = tiles.path.slice(0, at + 4);
    return joinPath(data, "Biomes", id + ".json");
  }

  Aura.biomeModel = { PARAMS, SURFACES, loadBiomes, serialize, isDirty, kindOf, boxOf, pick, inside, blank, tileRefs, newBiomePath };
})(window.Aura ??= {});
