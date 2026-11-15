"use strict";

(function (Aura) {
  const { readText } = Aura.fs;
  const { parse } = Aura.jsonc;

  /**
   * One read of everything under Data/, shared by whatever needs to ask a question across files: what a recipe needs,
   * which tile an item places, who drops what, what has no text yet.
   *
   * Every tool used to answer these on its own and only for its own corner, which is how an item with no recipe, an
   * icon pointing at an empty cell and a tile with no translation all sat in the project for weeks. The index is read
   * once per scan and handed around; nothing here writes.
   */

  const idOf = (entry) => (typeof entry === "string" ? entry : entry?.id);

  /** Every item an ingredient accepts: the item itself plus its "or" alternatives. */
  function ingredientItems(ing) {
    if (!ing || typeof ing !== "object") return [];
    const out = ing.item ? [ing.item] : [];
    if (Array.isArray(ing.or)) out.push(...ing.or.filter((x) => typeof x === "string"));
    return out;
  }

  /** What a recipe produces, whichever shape the file uses. */
  function outputItems(recipe) {
    const out = [];
    const take = (o) => {
      if (typeof o === "string") out.push(o);
      else if (o && typeof o === "object" && o.item) out.push(o.item);
    };
    take(recipe.output);
    for (const by of recipe.byproducts ?? []) take(by);
    return out;
  }

  class DataIndex {
    constructor() {
      this.tiles = new Map();      // id -> { id, tile, file, sheetId, cells: [[c, r], …] }
      this.items = new Map();      // id -> { id, item, file, sheetId, icon }
      this.recipes = [];           // { id, file, station, minTier, needs: [], gives: [], requires, tool, recipe }
      this.loot = [];              // { species, item, file }
      this.drops = [];             // { tile, item, file }
      this.strings = new Map();    // es_es | en_us -> Map(key -> text)
      this.languages = new Map();  // es_es | en_us -> the name written inside the file
      this.sheets = new Map();     // sheetId -> { contentPath, width, height, cols, rows }
      this.files = [];             // { path, hasComments }
      this.errors = [];            // files that could not be read at all
    }

    // ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────

    static async build(project, { onStep } = {}) {
      const index = new DataIndex();
      const data = project.filter((e) => e.lower.includes("/data/") && e.lower.endsWith(".json"));
      for (const entry of data) {
        onStep?.(entry.path);
        let text;
        try {
          text = await readText(entry.handle);
        } catch (err) {
          index.errors.push({ path: entry.path, message: String(err.message ?? err) });
          continue;
        }
        let doc;
        try {
          doc = parse(text);
        } catch (err) {
          index.errors.push({ path: entry.path, message: String(err.message ?? err) });
          continue;
        }
        index.files.push({ path: entry.path, hasComments: Aura.jsonc.hasComments(text) });
        index.#take(entry.path, doc);
      }
      await index.#readSheets(project);
      return index;
    }

    #take(path, doc) {
      const lower = path.toLowerCase();
      if (Array.isArray(doc?.tiles)) return this.#takeTiles(path, doc);
      if (Array.isArray(doc?.items)) return this.#takeItems(path, doc);
      if (lower.includes("/crafting/")) return this.#takeRecipes(path, doc);
      if (lower.includes("/lang/")) return this.#takeLang(path, doc);
      if (lower.includes("species")) return this.#takeSpecies(path, doc);
    }

    #takeTiles(path, doc) {
      for (const tile of doc.tiles) {
        if (!tile?.id) continue;
        const cells = [];
        const grab = (art) => {
          for (const state of Object.values(art ?? {})) {
            if (!state || typeof state !== "object") continue;
            for (const coord of Object.values(state)) {
              if (Array.isArray(coord) && coord.length === 2) cells.push(coord);
            }
          }
        };
        grab(tile.art);
        for (const part of tile.parts ?? []) grab(part?.art);
        // Breaking a tile is how the player gets most of the materials in the game, so its drops are a source of an
        // item just like a recipe or an animal's loot. They are written with the namespace ("aura:stick").
        for (const drop of tile.drops ?? []) {
          if (drop?.item) this.drops.push({ tile: tile.id, item: String(drop.item).replace(/^[^:]+:/, ""), file: path });
        }
        this.tiles.set(tile.id, { id: tile.id, tile, file: path, sheetId: doc.sheetId, cells });

        // Colour variants are tiles the game makes at load time from one entry. They are real ids that items and
        // recipes point at, so they belong in the index or every one of them looks like a broken reference.
        for (const variant of tile.colorVariants ?? []) {
          if (!variant?.id) continue;
          this.tiles.set(variant.id, {
            id: variant.id, tile: { ...tile, ...variant }, file: path, sheetId: doc.sheetId, cells,
            variantOf: tile.id,
          });
        }
      }
    }

    #takeItems(path, doc) {
      for (const item of doc.items) {
        if (!item?.id) continue;
        this.items.set(item.id, { id: item.id, item, file: path, sheetId: doc.sheetId, icon: item.iconCoord ?? null });
      }
    }

    #takeRecipes(path, doc) {
      const station = path.split("/").pop().replace(/\.json$/i, "");
      const list = Array.isArray(doc) ? doc : Object.values(doc ?? {});
      for (const recipe of list) {
        if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) continue;
        const needs = [];
        for (const ing of recipe.ingredients ?? []) needs.push(...ingredientItems(ing));
        const gives = outputItems(recipe);
        if (!needs.length && !gives.length) continue;
        this.recipes.push({
          id: recipe.id ?? idOf(recipe) ?? "(sin id)",
          file: path, station,
          minTier: (recipe.minTier ?? "crude").toLowerCase(),
          needs, gives,
          requires: recipe.requires ?? null,
          tool: recipe.tool ?? null,
          recipe,
        });
      }
    }

    // Keyed by the file name (es_es, en_us), not by the "language" field inside it: that field holds the name a
    // player reads ("Español"), and asking for a text by that name finds nothing.
    #takeLang(path, doc) {
      const id = path.split("/").pop().replace(/\.json$/i, "").toLowerCase();
      this.strings.set(id, new Map(Object.entries(doc?.strings ?? {})));
      this.languages.set(id, doc?.language ?? id);
    }

    #takeSpecies(path, doc) {
      for (const [species, body] of Object.entries(doc ?? {})) {
        for (const drop of body?.loot ?? []) {
          if (drop?.item) this.loot.push({ species, item: drop.item, file: path });
        }
      }
    }

    /** Sheet sizes, so an iconCoord can be checked against the picture it points at. */
    async #readSheets(project) {
      for (const atlas of project.atlases ?? []) {
        const png = project.resolveContentPng?.(atlas.texture);
        if (!png) continue;
        this.sheets.set(atlas.id, { contentPath: atlas.texture, entry: png });
      }
    }

    // ── Asking ───────────────────────────────────────────────────────────────────────────────────────────────────

    /** Everywhere an id turns up: recipes that take it or make it, the tile an item places, drops, texts. */
    uses(id) {
      const out = { asIngredient: [], asOutput: [], drops: [], brokenFrom: [], placesTile: null, placedBy: [], texts: [] };
      for (const r of this.recipes) {
        if (r.needs.includes(id)) out.asIngredient.push(r);
        if (r.gives.includes(id)) out.asOutput.push(r);
      }
      for (const l of this.loot) if (l.item === id) out.drops.push(l);
      for (const d of this.drops) if (d.item === id) out.brokenFrom.push(d);
      const item = this.items.get(id);
      if (item?.item?.tile) out.placesTile = item.item.tile;
      for (const other of this.items.values()) if (other.item?.tile === id) out.placedBy.push(other.id);
      for (const [lang, map] of this.strings) {
        for (const kind of ["item", "tile"]) {
          for (const field of ["name", "desc"]) {
            const key = `${kind}.aura.${id}.${field}`;
            if (map.has(key)) out.texts.push({ lang, key, text: map.get(key) });
          }
        }
      }
      return out;
    }

    /** A translation for a tile or an item, in the language asked for. */
    text(kind, id, field, lang = "es_es") {
      return this.strings.get(lang)?.get(`${kind}.aura.${id}.${field}`) ?? null;
    }

    /** The name a player reads, falling back to the JSON name and then the id. */
    label(id) {
      return this.text("item", id, "name") ?? this.text("tile", id, "name")
        ?? this.items.get(id)?.item?.name ?? this.tiles.get(id)?.tile?.name ?? id;
    }

    /** Recipes grouped by the station file they live in, and inside it by tier. */
    byStation() {
      const out = new Map();
      for (const r of this.recipes) {
        if (!out.has(r.station)) out.set(r.station, { crude: [], sturdy: [], mastered: [] });
        const tiers = out.get(r.station);
        (tiers[r.minTier] ?? tiers.crude).push(r);
      }
      return out;
    }
  }

  // Items the player is meant to find rather than make: a recipe for them would be the bug.
  const FOUND_NOT_MADE = /(_log|_ore|^stone$|^rock$|^dirt$|^sand$|_seed|_sapling|^water|^raw_|_hide$|^bone|^feather$|^stick$|^plant_fiber$)/;

  /**
   * Everything that crosses files and nobody was checking: references into thin air, icons on empty cells, things
   * with no text, items nothing can give you. `sheetArt` maps a sheet id to { cols, rows, filled } and may be empty,
   * in which case the checks that need the picture are skipped.
   */
  function problems(ix, sheetArt = new Map()) {
    const out = [];
    const add = (kind, where, what) => out.push({ kind, where, what });


      for (const e of ix.errors) add("error", e.path, `No se puede leer: ${e.message}`);

      for (const r of ix.recipes) {
        for (const id of [...r.needs, ...r.gives]) {
          if (!ix.items.has(id)) add("error", `${r.file} · ${r.id}`, `"${id}" no existe como item`);
        }
      }

      for (const item of ix.items.values()) {
        if (item.item.tile && !ix.tiles.has(item.item.tile)) {
          add("error", `${item.file} · ${item.id}`, `coloca "${item.item.tile}", que no existe como tile`);
        }
        const art = sheetArt.get(item.sheetId);
        const c = item.icon;
        if (art && c) {
          if (c[0] >= art.cols || c[1] >= art.rows) add("error", `${item.file} · ${item.id}`, `su icono [${c}] se sale de la hoja`);
          else if (!art.filled[c[1] * art.cols + c[0]]) add("aviso", `${item.file} · ${item.id}`, `su icono [${c}] apunta a una celda vacía`);
        }
      }

      for (const tile of ix.tiles.values()) {
        if (tile.variantOf) continue;
        const art = sheetArt.get(tile.sheetId);
        if (!art) continue;
        for (const c of tile.cells) {
          if (c[0] >= art.cols || c[1] >= art.rows) add("error", `${tile.file} · ${tile.id}`, `su arte [${c}] se sale de la hoja`);
          else if (!art.filled[c[1] * art.cols + c[0]]) add("aviso", `${tile.file} · ${tile.id}`, `su arte [${c}] es una celda vacía`);
        }
      }

      // Nothing translated at all falls back to the JSON "name", which is the documented behaviour and usually just
      // means the entry is new: counted once instead of once per entry, or the real findings end up buried under it.
      let untranslated = 0;
      for (const [kind, map] of [["tile", ix.tiles], ["item", ix.items]]) {
        for (const entry of map.values()) {
          if (entry.variantOf) continue;
          const missing = ["es_es", "en_us"].filter((lang) => !ix.text(kind, entry.id, "name", lang));
          if (missing.length === 2) untranslated++;
          else if (missing.length === 1) add("aviso", `${entry.file} · ${entry.id}`, `sin texto en ${missing[0] === "es_es" ? "español" : "inglés"}`);
        }
      }
      if (untranslated) add("nota", "Lang", `${untranslated} tiles/items sin traducir: usan el "name" del JSON`);

      for (const [lang, map] of ix.strings) {
        for (const key of map.keys()) {
          const m = /^(item|tile)\.aura\.(.+)\.(name|desc)$/.exec(key);
          if (!m) continue;
          const known = m[1] === "item" ? ix.items.has(m[2]) : ix.tiles.has(m[2]);
          if (!known) add("aviso", `Lang/${lang}`, `"${key}" no corresponde a ningún ${m[1]}`);
        }
      }

      for (const item of ix.items.values()) {
        if (/^test_/.test(item.id)) continue;
        const u = ix.uses(item.id);
        const gettable = u.asOutput.length || u.drops.length || u.brokenFrom.length;
        if (!gettable && !FOUND_NOT_MADE.test(item.id)) add("aviso", `${item.file} · ${item.id}`, "no se obtiene de nada: ni receta, ni botín, ni romper un tile");
        if (!u.asIngredient.length && !item.item.tile && !item.item.equipSlot && !item.item.ammo
            && item.item.itemType === "Material") {
          add("aviso", `${item.file} · ${item.id}`, "ninguna receta lo usa");
        }
      }

      // Counted, not listed one by one: a comment in a data file is normal (the game's parser allows them) and only
      // matters in the file the Atlas is about to rewrite, which the Atlas itself says when it reads it.
      const commented = ix.files.filter((f) => f.hasComments).length;
      if (commented) add("nota", "Data", `${commented} archivo(s) con comentarios: el juego los lee sin problema`);
    return out;
  }

  Aura.dataIndex = { DataIndex, ingredientItems, outputItems, problems };
})(window.Aura ??= {});
