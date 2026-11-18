"use strict";

// Cave biome files (Data/Worldgen/CaveBiomes/*.json) as CaveBiomeData reads them: a depth band under the sea level, an
// optional climate box, a weight against whoever else fits, the rock it lays into that band, and what grows on its
// floors and ceilings. The pick is replicated here exactly as the game does it — the candidates in id order, walked by
// the column's slow noise — so the depth chart in the tool shows what the generator will actually build.
(function (Aura) {
  const { readText, baseName, joinPath, dirName } = Aura.fs;
  const T = Aura.atlasTiles;

  // The two places a cave decoration can sit, as "on" in an entry.
  const SURFACES = [["caveFloor", "Suelo de cueva"], ["caveCeiling", "Techo de cueva"]];

  // What the game allows; the tool warns past it rather than clamping, so a file written by hand still shows as it is.
  const MAX_DEPTH = 512;

  const isCaveBiomeFile = (entry) => /(^|\/)data\/(worldgen\/)?cavebiomes\/.+\.json$/.test(entry.lower);

  async function loadCaveBiomes(project) {
    const docs = [];
    for (const entry of project.filter(isCaveBiomeFile).sort((a, b) => a.path.localeCompare(b.path))) {
      const doc = { entry, path: entry.path, name: baseName(entry.path), root: null, eol: "\n", baseline: "", error: null, isNew: false, cave: true };
      try {
        const text = await readText(entry.handle);
        doc.eol = text.includes("\r\n") ? "\r\n" : "\n";
        doc.root = JSON.parse(text);
        doc.baseline = Aura.biomeModel.serialize(doc);
      } catch (err) {
        doc.error = err.message;
      }
      docs.push(doc);
    }
    return docs;
  }

  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const pair = (v, lo, hi) => (Array.isArray(v) && v.length === 2 ? [num(v[0], lo), num(v[1], hi)] : [lo, hi]);

  /** The band in levels under the sea, as [min, max]. */
  const bandOf = (root) => pair(root?.placement?.depth, 0, MAX_DEPTH);

  /** The climate box, every parameter as [min, max] (missing = the whole 0..1). */
  const boxOf = (root) => ({
    temperature: pair(root?.placement?.temperature, 0, 1),
    humidity: pair(root?.placement?.humidity, 0, 1),
  });

  const weightOf = (root) => Math.max(0, num(root?.placement?.weight, 1));

  /** The id as CaveBiomeData builds it: "id" without a namespace. */
  function idOf(root) {
    const raw = String(root?.id ?? root?.name ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    return raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  }

  /** A fresh cave biome, in the shape the files have. */
  function blank(id, name) {
    return {
      id, name,
      placement: { depth: [0, 512], weight: 1 },
      materials: {},
      decoration: [],
    };
  }

  /** Every tile id it names, with where, for checking them against the tile files. */
  function tileRefs(root) {
    const out = [];
    if (root?.materials?.wall) out.push([root.materials.wall, "materials.wall"]);
    (root?.decoration ?? []).forEach((d, i) => d?.tile && out.push([d.tile, `decoration[${i}]`]));
    return out;
  }

  /** Where a new file goes: next to the others, or Data/Worldgen/CaveBiomes beside Data/Tiles. */
  function newPath(project, docs, id) {
    if (docs.length) return joinPath(dirName(docs[0].path), id + ".json");
    const tiles = project.filter((e) => /(^|\/)data\/tiles\/.+\.json$/.test(e.lower))[0];
    if (!tiles) return null;
    const at = tiles.lower.lastIndexOf("data/tiles/");
    return joinPath(tiles.path.slice(0, at + 4), "Worldgen", "CaveBiomes", id + ".json");
  }

  const fits = (root, depth, temperature, humidity) => {
    const [lo, hi] = bandOf(root), box = boxOf(root);
    return depth >= lo && depth <= hi
      && temperature >= box.temperature[0] && temperature <= box.temperature[1]
      && humidity >= box.humidity[0] && humidity <= box.humidity[1];
  };

  /** The candidates at one cell, in the order CaveBiomeData walks them (by id), each with its share of the roll. */
  function sharesAt(roots, depth, temperature, humidity) {
    const candidates = roots.filter((r) => fits(r, depth, temperature, humidity))
      .sort((a, b) => String(idOf(a)).localeCompare(String(idOf(b)), "en"));
    const total = candidates.reduce((a, r) => a + weightOf(r), 0);
    if (total <= 0) return [];
    return candidates.map((r) => ({ root: r, id: idOf(r), share: weightOf(r) / total }));
  }

  /** The one a column lands on, given its draw on the slow field (0..1). Exactly the game's walk. */
  function at(roots, depth, temperature, humidity, pick) {
    const shares = sharesAt(roots, depth, temperature, humidity);
    let target = Math.min(Math.max(pick, 0), 0.999999);
    for (const s of shares) {
      target -= s.share;
      if (target < 0) return s.root;
    }
    return null;
  }

  /**
   * What a reader of the file should know before the game tells them: a band nothing claims (plain rock all the way
   * down there), a wall tile that cannot be mined, a decoration that will never be placed because its "on" is missing,
   * and the chances of each surface adding past 1.
   */
  function problems(root, others, tileInfo) {
    const out = [];
    const id = idOf(root);
    if (!id) out.push(["bad", "Sin id: el archivo no se carga."]);

    const [lo, hi] = bandOf(root);
    if (hi < lo) out.push(["bad", `La banda va de ${lo} a ${hi}: el juego la da la vuelta, pero escríbela al derecho.`]);
    if (hi > MAX_DEPTH) out.push(["warn", `La banda llega a ${hi}, más hondo que el fondo del mundo.`]);
    if (weightOf(root) === 0) out.push(["warn", "Peso 0: nunca sale elegido."]);

    const wall = root?.materials?.wall;
    if (wall) {
      const info = tileInfo?.(wall);
      if (!info) out.push(["bad", `La pared «${wall}» no existe.`]);
      else if (Number(info.tile?.hardness) < 0) out.push(["bad", `«${wall}» es indestructible (hardness −1): la cueva no se podría picar.`]);
    }

    const sums = { caveFloor: 0, caveCeiling: 0 };
    (root?.decoration ?? []).forEach((d, i) => {
      const on = d?.on ?? "";
      if (!SURFACES.some(([k]) => k === on)) out.push(["bad", `decoration[${i}]: le falta «dónde» (suelo o techo); el juego la descarta.`]);
      else sums[on] += Number(d.chance) || 0;
      const info = d?.tile ? tileInfo?.(d.tile) : null;
      if (d?.tile && !info) out.push(["bad", `decoration[${i}]: «${d.tile}» no existe.`]);
      else if (info && !info.tile?.placement?.on) out.push(["warn", `decoration[${i}]: «${d.tile}» no dice sobre qué se coloca, así que nunca se pone como decoración.`]);
      else if (info && wall && !(info.tile.placement.on ?? []).map(String).includes(String(wall).replace(/^aura:/, "")))
        out.push(["warn", `decoration[${i}]: «${d.tile}» no acepta «${wall}» como suelo, así que no crecerá aquí.`]);
    });
    for (const [key, label] of SURFACES)
      if (sums[key] > 1) out.push(["warn", `Las probabilidades de ${label.toLowerCase()} suman ${sums[key].toFixed(2)}: las últimas no salen nunca.`]);

    // A gap: a depth where this biome's band stops and nobody else covers it.
    const all = [root, ...others];
    for (let d = 0; d <= MAX_DEPTH; d += 8) {
      if (sharesAt(all, d, 0.5, 0.5).length === 0) {
        out.push(["warn", `A profundidad ${d} no hay ningún bioma de cueva (con clima medio): la roca se queda como la deja la columna.`]);
        break;
      }
    }
    return out;
  }

  Aura.caveBiomeModel = { SURFACES, MAX_DEPTH, isCaveBiomeFile, loadCaveBiomes, bandOf, boxOf, weightOf, idOf, blank,
    tileRefs, newPath, fits, sharesAt, at, problems };
})(window.Aura ??= {});
