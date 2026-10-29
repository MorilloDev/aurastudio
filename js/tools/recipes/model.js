"use strict";

// Recipe files of Data/Crafting as the game reads them: CraftingSystem (hand, workbench, smithing, cauldron —
// "ingredients" / "output" / "mode"…), FurnaceSystem (furnace, crucible — "input" / "input2" / "output" / "minTemp") and
// fuels.json ("burnTime" / "tempBoost"). The game parses them with Newtonsoft, which allows // comments, so a file is
// kept as its list of entries, each with the comment lines and blank line written before it, and written back the same.
(function (Aura) {
  const { readText, baseName, joinPath, dirName } = Aura.fs;
  const T = Aura.atlasTiles;

  // The stations, as PlayerUIController builds them: slot counts, files and which extra files each one also reads.
  const STATIONS = [
    { id: "hand", label: "Mano", file: "hand.json", kind: "crafting", slots: 3, note: "Crafteo desde el inventario (3 casillas)." },
    { id: "workbench", label: "Mesa de trabajo", file: "workbench.json", kind: "crafting", slots: 5, extra: ["hand.json"],
      note: "5 casillas. También hace todo lo de «Mano» (lee hand.json)." },
    { id: "smithing", label: "Herrería", file: "smithing.json", kind: "crafting", slots: 1, note: "1 casilla: Modify / Upgrade sobre el arma o equipo." },
    { id: "cauldron", label: "Caldero", file: "cauldron.json", kind: "crafting", slots: 5, tileSlots: "cauldron",
      note: "Hasta 5 casillas según el tier del caldero. Necesita al jugador." },
    { id: "furnace", label: "Horno", file: "furnace.json", kind: "furnace", inputs: 1, note: "Entrada, combustible y salida. Avanza mientras la temperatura llega a «minTemp»." },
    { id: "crucible", label: "Crisol", file: "crucible.json", kind: "furnace", inputs: 3,
      note: "Metal 1, metal 2 y ritual (aún sin uso en las recetas), combustible y salida. Con un solo ingrediente, el metal 2 debe estar vacío." },
    { id: "fuels", label: "Combustibles", file: "fuels.json", kind: "fuels", note: "Lo que arde en hornos y crisoles: segundos que dura y cuánto calienta." },
  ];

  const MODES = [["Give", "Dar (nuevo item)"], ["Modify", "Modificar (casilla)"], ["Upgrade", "Mejorar (casilla)"]];

  const isCraftingFile = (entry) => /(^|\/)data\/crafting\/[^/]+\.json$/.test(entry.lower);

  // ---------------------------------------------------------------------------------------------------------------
  // Reading and writing, comments included

  /**
   * Splits a top-level JSON array into its elements, keeping the // and /* *\/ comment lines and blank lines written
   * before each one. Comments inside an element are dropped (none of the files has any).
   */
  function parseCommented(text) {
    const src = text.replace(/\r\n/g, "\n");
    let i = src.indexOf("[");
    if (i < 0) throw new Error("no es una lista [ … ]");
    i++;
    const entries = [];
    let comments = [], gap = false, newlines = 0;
    const floatKeys = new Set();
    for (;;) {
      // Whitespace, commas and comments up to the next element.
      while (i < src.length) {
        const c = src[i];
        if (c === "\n") { newlines++; if (newlines >= 2 && entries.length) gap = true; i++; continue; }
        if (c === " " || c === "\t" || c === "," || c === "\r") { i++; continue; }
        if (c === "/" && src[i + 1] === "/") {
          const end = src.indexOf("\n", i);
          comments.push(src.slice(i, end < 0 ? src.length : end).trim());
          i = end < 0 ? src.length : end;
          newlines = 0;
          continue;
        }
        if (c === "/" && src[i + 1] === "*") {
          const end = src.indexOf("*/", i + 2);
          comments.push(src.slice(i, end < 0 ? src.length : end + 2).trim());
          i = end < 0 ? src.length : end + 2;
          newlines = 0;
          continue;
        }
        break;
      }
      if (i >= src.length || src[i] === "]") break;
      // One element: brackets matched, strings respected.
      const start = i;
      let depth = 0, inStr = false;
      for (; i < src.length; i++) {
        const c = src[i];
        if (inStr) { if (c === "\\") i++; else if (c === "\"") inStr = false; continue; }
        if (c === "\"") inStr = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") { depth--; if (depth === 0) { i++; break; } }
        else if (depth === 0 && (c === "," || c === "\n")) break;
      }
      const chunk = src.slice(start, i).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      // Which numbers this entry writes with a decimal point ("craftTime": 4.0): kept per entry, since fuels.json writes
      // "burnTime": 7.5 next to "burnTime": 15.
      const own = new Set();
      for (const m of chunk.matchAll(/"(\w+)"\s*:\s*-?\d+\.\d+/g)) { own.add(m[1]); floatKeys.add(m[1]); }
      entries.push({ comments, gap: gap && entries.length > 0, value: JSON.parse(chunk), floatKeys: own });
      comments = []; gap = false; newlines = 0;
    }
    return { entries, tail: comments, floatKeys };
  }

  function serialize(doc) {
    const pad = "  ";
    const parts = doc.entries.map((e) => {
      const lines = [];
      if (e.gap) lines.push("");
      for (const c of e.comments ?? []) lines.push(pad + c);
      // New entries take the file's habit (craftTime as 4.0); read ones keep their own.
      lines.push(pad + T.formatJson(e.value, pad, "item", { floatKeys: e.floatKeys ?? doc.floatKeys, openNested: true }));
      return lines.join("\n");
    });
    const tail = (doc.tail ?? []).map((c) => "\n" + pad + c).join("");
    const body = parts.length ? "[\n" + parts.join(",\n") + tail + "\n]" : "[" + tail + (tail ? "\n" : "") + "]";
    return body.replace(/\n/g, doc.eol) + doc.eol;
  }

  const isDirty = (doc) => doc.isNew ? doc.entries.length > 0 : serialize(doc) !== doc.baseline;

  async function loadFiles(project) {
    const docs = [];
    for (const entry of project.filter(isCraftingFile).sort((a, b) => a.path.localeCompare(b.path))) {
      const doc = { entry, path: entry.path, name: baseName(entry.path), entries: [], tail: [], floatKeys: new Set(["craftTime"]),
        eol: "\n", baseline: "", error: null, isNew: false };
      try {
        const text = await readText(entry.handle);
        doc.eol = text.includes("\r\n") ? "\r\n" : "\n";
        const parsed = text.trim() ? parseCommented(text) : { entries: [], tail: [], floatKeys: new Set() };
        doc.entries = parsed.entries;
        doc.tail = parsed.tail;
        // The file's habit for new entries: a key every entry writes with a decimal point.
        for (const k of parsed.floatKeys) if (parsed.entries.every((e) => !(k in e.value) || e.floatKeys.has(k))) doc.floatKeys.add(k);
        doc.baseline = serialize(doc);
      } catch (err) {
        doc.error = err.message;
      }
      docs.push(doc);
    }
    return docs;
  }

  /** The Data/Crafting folder: next to the recipe files, or beside Data/Items. */
  function craftingDir(project, docs) {
    if (docs.length) return dirName(docs[0].path);
    const items = project.filter((e) => /(^|\/)data\/items\/.+\.json$/.test(e.lower))[0];
    if (!items) return null;
    const at = items.lower.lastIndexOf("data/items/");
    return joinPath(items.path.slice(0, at + 4), "Crafting");
  }

  /** What a file is, from its name (the stations above) or, for one the game does not name, from its entries. */
  function stationOf(doc) {
    const known = STATIONS.find((s) => s.file === doc.name.toLowerCase());
    if (known) return known;
    const first = doc.entries[0]?.value ?? {};
    const kind = "ingredients" in first ? "crafting" : "burnTime" in first ? "fuels" : "input" in first ? "furnace" : "crafting";
    const maxSlot = Math.max(0, ...doc.entries.flatMap((e) => (e.value.ingredients ?? []).map((i) => (Number.isInteger(i.slot) ? i.slot + 1 : 0))));
    return { id: "file:" + doc.name, label: doc.name.replace(/\.json$/i, ""), file: doc.name, kind, slots: Math.max(3, maxSlot), inputs: 2,
      note: "Archivo que ninguna estación del juego lee todavía (no está en PlayerUIController)." };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Items

  /**
   * Every item the recipes may name, under each key ItemRegistry.ResolveKey accepts: its id, "aura:id" and its display
   * name. Each record knows where its icon is: its own cell (iconCoord) or its tile's art (a TileItem without one).
   */
  function indexItems(docs) {
    const tiles = new Map(), items = [], byKey = new Map();
    for (const doc of docs) {
      if (!doc.root || T.isItemDoc(doc)) continue;
      const [tw, th] = T.docCell(doc);
      for (const tile of doc.root.tiles) {
        if (!tile) continue;
        const f = tile.art?.default ?? tile.art?.Default;
        const coord = T.isCoord(f) ? f : T.isCoord(f?.front) ? f.front
          : Array.isArray(tile.parts) ? tile.parts.map((p) => p.art?.default).map((a) => (T.isCoord(a) ? a : a?.front)).find(T.isCoord) : null;
        tiles.set(T.tileId(tile), { sheet: T.docSheet(doc, tile), coord, tw, th });
      }
    }
    for (const doc of docs) {
      if (!doc.root || !T.isItemDoc(doc)) continue;
      const [tw, th] = T.docCell(doc);
      for (const item of doc.root.tiles) {
        if (!item || (!item.id && !item.name)) continue;
        const id = String(item.id ?? T.deriveIdPath(item.name)).replace(/^aura:/, "");
        let icon = null;
        if (T.isCoord(item.iconCoord)) icon = { sheet: T.docSheet(doc, item), coord: item.iconCoord, tw, th };
        else if (item.tile || item.tileType) {
          const t = tiles.get(T.tileId({ id: item.tile ?? item.tileType }));
          if (t?.coord) icon = { ...t, fromTile: true };
        }
        // Shown by the name the player reads (Data/Lang, Spanish), the JSON name kept for lookups.
        const rec = { id, name: Aura.lang?.display("item", id, item.name ?? id) ?? item.name ?? id, jsonName: item.name ?? id, item, doc, file: doc.name.replace(/\.json$/i, ""),
          group: item.itemType ?? item.type ?? "Otros", stack: item.maxStack ?? 1, icon };
        items.push(rec);
        for (const k of [id, "aura:" + id, item.name]) if (k) byKey.set(String(k).toLowerCase(), rec);
      }
    }
    return { items, byKey, tiles };
  }

  const resolveItem = (index, key) => (key ? index.byKey.get(String(key).toLowerCase()) ?? null : null);

  // ---------------------------------------------------------------------------------------------------------------
  // What each recipe names, and what is wrong with it

  /** Every [itemKey, where] a recipe names, so the checks and «Usos» read every kind the same way. */
  function itemRefs(kind, r) {
    if (kind === "fuels") return [[r.item, "item"]];
    if (kind === "furnace") return [[r.input, "input"], r.input2 != null ? [r.input2, "input2"] : null, [r.output, "output"]].filter(Boolean);
    return [...(r.ingredients ?? []).map((g, i) => [g.item, `ingredients[${i}]`]), [r.output?.item, "output"]];
  }
  const inputsOf = (kind, r) => itemRefs(kind, r).filter(([, w]) => w !== "output");
  const outputOf = (kind, r) => (kind === "fuels" ? null : kind === "furnace" ? r.output : r.output?.item);

  /** [{ level: "bad" | "warn", text, entry }] for one file seen as one station. */
  function check(doc, station, index, alsoRead = []) {
    const out = [];
    const bad = (e, text) => out.push({ level: "bad", text, entry: e });
    const warn = (e, text) => out.push({ level: "warn", text, entry: e });
    const ids = new Map();
    for (const d of [doc, ...alsoRead]) for (const e of d.entries) {
      if (e.value?.id) ids.set(e.value.id, (ids.get(e.value.id) ?? 0) + 1);
    }
    const seenInputs = new Map(), seenFuels = new Set();
    for (const e of doc.entries) {
      const r = e.value ?? {};
      const label = r.id ?? r.item ?? "?";
      for (const [key, where] of itemRefs(station.kind, r)) {
        if (!key) bad(e, `«${label}»: falta el item de ${where}.`);
        else if (index.items.length && !resolveItem(index, key)) bad(e, `«${label}»: «${key}» (${where}) no existe. El juego no arranca (ContentErrors).`);
      }
      if (station.kind === "fuels") {
        const k = String(r.item ?? "").toLowerCase().replace(/^aura:/, "");
        if (seenFuels.has(k)) warn(e, `«${r.item}» está dos veces: solo cuenta la primera.`);
        seenFuels.add(k);
        if (!(r.burnTime > 0)) warn(e, `«${r.item}»: burnTime debe ser mayor que 0.`);
        continue;
      }
      if (!r.id) warn(e, "Una receta sin «id»: el guardado del horno y los avisos la nombran por él.");
      else if ((ids.get(r.id) ?? 0) > 1) warn(e, `El id «${r.id}» se repite${alsoRead.length ? " (contando hand.json)" : ""}.`);
      if (station.kind === "furnace") {
        const key = [r.input, r.inputQty ?? 1, r.input2 ?? "", r.input2Qty ?? 0].join("|").toLowerCase();
        if (seenInputs.has(key)) warn(e, `«${label}» pide lo mismo que «${seenInputs.get(key)}», que va antes: nunca sale.`);
        else seenInputs.set(key, label);
        if (station.inputs < 2 && r.input2) bad(e, `«${label}»: el horno solo tiene una entrada (input2 no se usa).`);
        continue;
      }
      const ings = r.ingredients ?? [];
      if (!ings.length) bad(e, `«${label}»: sin ingredientes.`);
      const slots = new Map();
      for (const g of ings) {
        if (!((g.qty ?? 1) >= 1)) warn(e, `«${label}»: cantidad menor que 1.`);
        if (Number.isInteger(g.slot)) {
          if (g.slot >= station.slots) bad(e, `«${label}»: usa la casilla ${g.slot + 1} y ${station.label.toLowerCase()} tiene ${station.slots}.`);
          if (slots.has(g.slot) && slots.get(g.slot) !== String(g.item).toLowerCase()) bad(e, `«${label}»: dos items distintos en la casilla ${g.slot + 1}: nunca encaja.`);
          slots.set(g.slot, String(g.item).toLowerCase());
        }
      }
      if (ings.length > station.slots && ings.every((g) => !Number.isInteger(g.slot))) {
        const distinct = new Set(ings.map((g) => String(g.item).toLowerCase())).size;
        if (distinct > station.slots) bad(e, `«${label}»: ${distinct} items distintos en ${station.slots} casillas.`);
      }
      if ((r.mode === "Modify" || r.mode === "Upgrade") && r.output?.targetSlot == null) warn(e, `«${label}»: ${r.mode} sin «targetSlot» usa la casilla 1.`);
      if (r.failChance != null && !(r.failChance >= 0 && r.failChance <= 1)) bad(e, `«${label}»: failChance va de 0 a 1.`);
    }
    return out;
  }

  /** Recipes that make an item and recipes that use it, across every file. */
  function usesOf(docs, index, rec) {
    const made = [], used = [], burns = [];
    const same = (key) => resolveItem(index, key) === rec;
    for (const doc of docs) {
      const station = stationOf(doc);
      for (const e of doc.entries) {
        const r = e.value ?? {};
        if (station.kind === "fuels") { if (same(r.item)) burns.push({ doc, station, entry: e }); continue; }
        if (same(outputOf(station.kind, r))) made.push({ doc, station, entry: e });
        if (inputsOf(station.kind, r).some(([k]) => same(k))) used.push({ doc, station, entry: e });
      }
    }
    return { made, used, burns };
  }

  Aura.recipeModel = { STATIONS, MODES, isCraftingFile, parseCommented, serialize, isDirty, loadFiles, craftingDir, stationOf,
    indexItems, resolveItem, itemRefs, inputsOf, outputOf, check, usesOf };
})(window.Aura ??= {});
