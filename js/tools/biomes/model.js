"use strict";

// Biome files (Data/Worldgen/Biomes/*.json) as BiomeData reads them: placement (surface by climate, coast strip, or open-sea
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

  const isBiomeFile = (entry) => /(^|\/)data\/(worldgen\/)?biomes\/.+\.json$/.test(entry.lower);

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

  /** Where a new biome file goes: next to the other biomes, or Data/Worldgen/Biomes beside Data/Tiles. */
  function newBiomePath(project, docs, id) {
    if (docs.length) return joinPath(dirName(docs[0].path), id + ".json");
    const tiles = project.filter((e) => /(^|\/)data\/tiles\/.+\.json$/.test(e.lower))[0];
    if (!tiles) return null;
    const at = tiles.lower.lastIndexOf("data/tiles/");
    const data = tiles.path.slice(0, at + 4);
    return joinPath(data, "Worldgen", "Biomes", id + ".json");
  }

  // ── Repartir decoraciones ───────────────────────────────────────────────────────────────────────────────────────
  // Which biome each decoration tile belongs in, from what the tile files already say: its habitat (where it grows), its
  // spawnOn (what ground it needs), its growth climate and its tags. The Studio only proposes; the person ticks.

  const HABITAT_ON = { land: "surface", submerged: "seafloor", emergent: "shallows", floating: "watersurface" };
  const HABITAT_LABEL = { land: "tierra", submerged: "sumergida", emergent: "emergente", floating: "flotante" };
  // For tiles without "habitat": the name is a good guess, and the guess decides "on" so the game puts it in the water.
  const NAME_HABITAT = [
    [/kelp|seaweed|alga|coral|anemone|seagrass|sea_grass|sponge/, "submerged"],
    [/reed|cattail|papyrus|junco|bulrush|rush|mangrove_root/, "emergent"],
    [/lily|lilypad|duckweed|nenufar|lenteja/, "floating"],
  ];
  const DECOR_TAGS = ["herb", "plant", "flower", "foliage", "mushroom", "fungus", "rock", "pebble", "decoration", "bush", "fern", "coral"];
  const DECOR_CATEGORIES = ["foliage", "plants", "flora", "decoration", "decorations"];

  const lowerTags = (tile) => (Array.isArray(tile?.tags) ? tile.tags.map((t) => String(t).toLowerCase()) : []);
  const shortId = (id) => String(id ?? "").replace(/^aura:/, "");

  /** { habitat, guessed }: the tile's own habitat, or one guessed from its name (land when nothing says otherwise). */
  function habitatOf(tile, id) {
    const own = tile?.habitat ? String(tile.habitat).toLowerCase() : "";
    if (HABITAT_ON[own]) return { habitat: own, guessed: false };
    const name = shortId(id).toLowerCase();
    for (const [re, hab] of NAME_HABITAT) if (re.test(name)) return { habitat: hab, guessed: true };
    return { habitat: "land", guessed: false };
  }

  /**
   * The tiles that can be decoration: plants, rocks and the like, not crop stages (anything with a next stage, or that is
   * one) nor the middle / top of a column, which grow from their base.
   */
  function decorationCandidates(tiles) {
    const grown = new Set();
    for (const [, info] of tiles) {
      const g = info.tile?.growth;
      for (const k of ["next", "middle", "top", "into"]) if (g?.[k]) grown.add(shortId(g[k]));
    }
    const out = [];
    for (const [id, info] of tiles) {
      const tile = info.tile, short = shortId(id);
      if (!tile || grown.has(short) || tile.growth?.next) continue;
      const tags = lowerTags(tile);
      if (tags.includes("crop") || tags.includes("planted")) continue;
      const category = String(info.doc?.root?.category ?? "").toLowerCase();
      const decor = !!tile.habitat || tags.some((t) => DECOR_TAGS.includes(t)) || DECOR_CATEGORIES.includes(category);
      if (!decor) continue;
      out.push({ id: short, info, tags, ...habitatOf(tile, short) });
    }
    return out;
  }

  /** 0..1, how much of the tile's growth climate the biome's box covers; null when the tile sets none. */
  function climateFit(tile, box) {
    const c = tile?.growth?.climate;
    if (!c || !box) return null;
    let fit = 1, any = false;
    for (const key of ["temperature", "humidity"]) {
      if (!Array.isArray(c[key])) continue;
      any = true;
      const [a, b] = range(c[key]), [lo, hi] = box[key];
      const overlap = Math.max(0, Math.min(b, hi) - Math.max(a, lo));
      fit *= overlap / Math.max(1e-6, Math.min(b - a, hi - lo) || 1e-6);
    }
    return any ? Math.min(1, fit) : null;
  }

  /** true / false when the tile's spawnOn names grounds, null when it names none. tagsOf(id) → lower-case tags. */
  function groundFits(tile, root, tagsOf) {
    const list = Array.isArray(tile?.spawnOn) ? tile.spawnOn.map((v) => String(v).toLowerCase()) : [];
    if (!list.length) return null;
    const m = root?.materials ?? {};
    const grounds = [m.surface, ...(m.surfaceVariants ?? []).map((v) => v?.tile)].filter(Boolean).map((g) => shortId(g).toLowerCase());
    return grounds.some((g) => list.some((want) => (want.startsWith("#") ? tagsOf(g).includes(want.slice(1)) : shortId(want) === g)));
  }

  /**
   * What a biome would gain: [{ tile, on, chance, habitat, guessed, reason }] for every candidate that fits and is not
   * already in its decoration. Chances are a starting point by kind (grass tufts common, flowers and rocks rare, ore
   * rocks rarer), scaled by how well the climate fits, then scaled down together so the biome's total stays under 0.95.
   */
  function suggestDecoration(root, tiles, tagsOf) {
    if (!root) return [];
    const kind = kindOf(root);
    const box = kind === "ocean" ? null : boxOf(root);
    const have = new Set((root.decoration ?? []).map((d) => shortId(d?.tile).toLowerCase()));
    const surfaceTags = tagsOf(shortId(root.materials?.surface).toLowerCase());
    const grassy = surfaceTags.includes("biome_tinted") || /grass/.test(String(root.materials?.surface ?? ""));
    const wet = kind === "coast" || (box && box.humidity[1] >= 0.5);
    const out = [];
    for (const c of decorationCandidates(tiles)) {
      if (have.has(c.id.toLowerCase())) continue;
      const tile = c.info.tile, reasons = [];
      let chance;
      if (c.habitat === "land") {
        if (kind === "ocean") continue;
        const ground = groundFits(tile, root, tagsOf);
        const rocky = c.tags.includes("rock") || c.tags.includes("pebble");
        if (ground === false) continue;
        if (ground === true) reasons.push("crece sobre " + shortId(root.materials?.surface));
        else if (!rocky && !grassy) continue;      // plants without spawnOn grow on grass, not on sand or stone
        chance = kindChance(c.info, "land", c.tags);
        reasons.push(rocky ? "roca" : c.info.tinted ? "hierba (se tiñe)" : "planta de tierra");
      } else {
        chance = kindChance(c.info, c.habitat, c.tags);
        if (c.habitat === "submerged") {
          reasons.push(kind === "ocean" ? "fondo del mar" : "fondo de ríos y lagos");
        } else {
          if (kind === "ocean") continue;          // the open sea has no shore and no calm water for lily pads
          if (kind !== "ocean" && !wet) continue;  // reeds and lily pads only where the biome is humid enough for water
          reasons.push(c.habitat === "emergent" ? "orillas" : "sobre el agua");
        }
      }
      const fit = climateFit(tile, box);
      if (fit === 0) continue;
      if (fit !== null) { chance *= fit; reasons.push(`clima ${Math.round(fit * 100)} %`); }
      // Only an explicit "on" when the tile does not say its habitat itself: the game's Auto would put it on land.
      const on = c.guessed ? HABITAT_ON[c.habitat] : undefined;
      out.push({ tile: c.id, on, chance, habitat: c.habitat, guessed: c.guessed, reason: reasons.join(" · "), info: c.info });
    }
    const used = (root.decoration ?? []).reduce((s, d) => s + (Number(d.chance) || 0), 0);
    const room = Math.max(0, 0.95 - used), want = out.reduce((s, d) => s + d.chance, 0);
    const k = want > room ? room / want : 1;
    for (const d of out) d.chance = Math.round(d.chance * k * 100000) / 100000;
    return out.filter((d) => d.chance > 0);
  }

  /** Starting chance of a decoration by what it is: grass tufts common, plants and rocks rare, ore rocks rarer. */
  function kindChance(info, habitat, tags) {
    if (habitat === "submerged") return 0.07;
    if (habitat === "emergent") return 0.05;
    if (habitat === "floating") return 0.03;
    if (tags.includes("rock") || tags.includes("pebble")) return tags.includes("needs_pickaxe") ? 0.0006 : 0.002;
    if (info?.tinted) return 0.15;
    return info?.tile?.growth?.type === "column" ? 0.006 : 0.005;
  }

  const qualify = (id) => (String(id).includes(":") ? String(id) : "aura:" + id);

  /**
   * «Auto-ajustar»: every entry's chance from what it is (as the suggestions) and how well its climate fits, scaled so
   * the whole decoration adds up to target. Repeated tiles (same tile, same "on") are merged first, keeping the first.
   * An entry whose tile does not exist keeps its share as it was.
   */
  function autoWeights(root, tiles, target) {
    const box = kindOf(root) === "ocean" ? null : boxOf(root);
    const seen = new Map(), out = [];
    for (const d of root?.decoration ?? []) {
      if (!d?.tile) { out.push({ ...d }); continue; }
      const key = shortId(d.tile).toLowerCase() + "|" + (d.on ?? "");
      if (seen.has(key)) continue;
      seen.set(key, true);
      out.push({ ...d });
    }
    const raw = out.map((d) => {
      const info = d.tile ? tiles.get(qualify(d.tile)) : null;
      if (!info) return Number(d.chance) || 0;
      const on = d.on ? Object.entries(HABITAT_ON).find(([, v]) => v === d.on)?.[0] : null;
      const hab = on ?? habitatOf(info.tile, d.tile).habitat;
      const fit = climateFit(info.tile, box);
      // A tile the person put there on purpose stays, even when its climate does not fit: just rarer.
      return kindChance(info, hab, lowerTags(info.tile)) * (fit === null ? 1 : Math.max(0.1, fit));
    });
    const sum = raw.reduce((a, b) => a + b, 0);
    const k = sum > 0 ? target / sum : 0;
    out.forEach((d, i) => { if (d.tile) d.chance = Math.round(raw[i] * k * 100000) / 100000; });
    return { decoration: out, merged: (root?.decoration?.length ?? 0) - out.length };
  }

  /** «Más» / «Menos»: every chance × f, never letting the total pass 0.99. */
  function scaleWeights(root, f) {
    const list = (root?.decoration ?? []).map((d) => ({ ...d }));
    const sum = list.reduce((a, d) => a + (Number(d.chance) || 0), 0);
    const k = sum * f > 0.99 ? 0.99 / Math.max(1e-9, sum) : f;
    for (const d of list) d.chance = Math.round((Number(d.chance) || 0) * k * 100000) / 100000;
    return list;
  }

  Aura.biomeModel = { PARAMS, SURFACES, HABITAT_LABEL, HABITAT_ON, habitatOf, autoWeights, scaleWeights, loadBiomes, serialize, isDirty, kindOf, boxOf, pick, inside, blank, tileRefs, newBiomePath,
    decorationCandidates, suggestDecoration };
})(window.Aura ??= {});
