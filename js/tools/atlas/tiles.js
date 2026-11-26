"use strict";

// The tile files (Data/Tiles/*.json) and item files (Data/Items/*.json) as the Atlas tool edits them. An item is listed
// like a tile whose only art is its "iconCoord"; both kinds share the docs, the references and the undo history. Every place a tile points into a sheet is kept as the
// live [x, y] array of the parsed file, so moving a cell edits the file itself and nothing has to be merged back; the
// file is written again in the project's own JSON style only when it really changed.
(function (Aura) {
  const { baseName } = Aura.fs;

  // TileInfo.ParseTileFile: tileWidth / tileHeight default to 64 when a file declares none.
  const CELL = 64;
  const NAMESPACE = "aura";

  // TileArtState, in the order the editor lists them.
  const STATES = ["default", "inverted", "vertical", "horizontal", "wall"];
  const STATE_LABEL = { default: "normal", inverted: "invertido", vertical: "vertical", horizontal: "horizontal", wall: "pared", icon: "icono",
    connect: "unión", outer: "esquina ext.", outerInverted: "esquina ext. invertida", inner: "esquina int.", innerInverted: "esquina int. invertida" };

  // Sides that are not a front or a back: a corner of the cell's diamond (a bend) or a direction an arm runs to.
  const SIDE_LABEL = { front: "", back: "espalda", n: "arriba", e: "derecha", s: "abajo", w: "izquierda",
    nw: "arriba-izq.", ne: "arriba-der.", se: "abajo-der.", sw: "abajo-izq." };

  // ItemRegistry.DefaultItemSheet: the atlas of an item file that names none (the old plain-array files).
  const DEFAULT_ITEM_SHEET = "items";

  const isCoord = (v) => Array.isArray(v) && v.length >= 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]);

  /** Atlas ids are compared without their namespace: a file may say "terrain" where atlases.json says "aura:terrain". */
  const sheetKey = (id) => (id ? String(id).toLowerCase().replace(/^[^:]*:/, "") : "");

  /** ContentId.DeriveIdPath: the id a tile gets from its name when it has no "id". */
  const deriveIdPath = (name) => String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  const tileId = (tile) => {
    const raw = tile?.id ?? deriveIdPath(tile?.name);
    return raw.includes(":") ? raw : `${NAMESPACE}:${raw}`;
  };
  const tileLabel = (tile) => tile?.name ?? String(tile?.id ?? "?");

  // -------------------------------------------------------------------------------------------------------------------
  // Files

  const isTileFile = (entry) => /(^|\/)data\/tiles\/.+\.json$/.test(entry.lower);
  const isItemFile = (entry) => /(^|\/)data\/items\/.+\.json$/.test(entry.lower);

  const isItemDoc = (doc) => doc?.kind === "items";

  // The list a file holds, exposed as root.tiles for both kinds so the rest of the tool reads one shape. Not enumerable:
  // the file is written from its own keys, and "tiles" must never end up in it. An item file is a plain array (shared
  // "items" atlas) or { "sheetId", "items": [...] } — ItemRegistry.LoadItemFile reads the same two.
  function attachList(doc) {
    const root = doc.root;
    if (doc.kind === "tiles") {
      if (!root || typeof root !== "object" || !Array.isArray(root.tiles)) throw new Error("no tiene \"tiles\"");
      return;
    }
    let list;
    if (Array.isArray(root)) {
      list = root;
      Object.defineProperty(root, "sheetId", { value: DEFAULT_ITEM_SHEET, enumerable: false, writable: true });
    } else if (root && typeof root === "object" && Array.isArray(root.items)) {
      list = root.items;
    } else {
      throw new Error("no es una lista de items ni { \"sheetId\", \"items\" }");
    }
    Object.defineProperty(root, "tiles", { value: list, enumerable: false, writable: true });
  }

  // Takes // and /* */ out of JSON text, leaving everything inside strings alone — a path like "a//b" or a URL in a
  // description must survive. Character by character on purpose: a regular expression cannot tell a comment from the
  // same two characters inside a string, and getting that wrong corrupts the file silently.
  function stripComments(text) {
    let out = "", i = 0, inString = false;
    while (i < text.length) {
      const c = text[i];
      if (inString) {
        out += c;
        if (c === "\\" && i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
        if (c === '"') inString = false;
        i++;
        continue;
      }
      if (c === '"') { inString = true; out += c; i++; continue; }
      if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        i += 2;
        while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  /**
   * The comment block a file opens with, which is documentation of its own format and must survive a save. Returns the
   * verbatim lines when every comment in the file sits in that header (before the first key), and null otherwise: a
   * comment in the middle of an entry has no place to go back to once the file is rewritten from the parsed tree.
   */
  function headerComments(text) {
    const src = text.replace(/\r\n/g, "\n");
    const open = src.search(/[[{]/);
    if (open < 0) return null;
    let i = open + 1, end = i, inString = false, sawComment = false;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') break;                       // the first key: the header ends here
      if (c === "/" && src[i + 1] === "/") {
        i = src.indexOf("\n", i);
        if (i < 0) i = src.length;
        end = i;
        sawComment = true;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const close = src.indexOf("*/", i + 2);
        i = close < 0 ? src.length : close + 1;
        end = i + 1;
        sawComment = true;
        continue;
      }
    }
    if (!sawComment) return null;
    const header = src.slice(open + 1, end).replace(/^\n+/, "").replace(/\s+$/, "");
    // Anything after the header must be comment-free, or saving would still lose something.
    const rest = src.slice(end);
    if (stripComments(rest) !== rest) return null;
    return header;
  }

  /** Every tile file of the project, parsed. A file that does not parse is listed with its error and never written. */
  async function loadDocs(project) {
    const entries = project.filter((e) => isTileFile(e) || isItemFile(e)).sort((a, b) => a.path.localeCompare(b.path));
    const docs = [];
    for (const entry of entries) {
      const kind = isItemFile(entry) ? "items" : "tiles";
      const doc = { entry, kind, path: entry.path, name: baseName(entry.path), root: null, eol: "\n", baseline: "", error: null, stamp: 0 };
      try {
        const file = await entry.handle.getFile();
        doc.stamp = file.lastModified;
        const text = await file.text();
        doc.eol = text.includes("\r\n") ? "\r\n" : "\n";
        doc.style = { floatKeys: new Set(), openNested: false };

        // The game reads these with a parser that allows // and /* */; JSON.parse does not, so one comment in an item
        // file used to make the whole atlas refuse the file. They are taken out for reading. Writing is a different
        // matter: this tool rewrites the file whole, which would silently throw the comments away, so a file that has
        // any is read and shown but never saved (see isDocDirty) and the panel says so.
        const clean = stripComments(text);
        doc.header = clean !== text ? headerComments(text) : null;
        doc.commented = clean !== text && doc.header === null;
        doc.root = JSON.parse(clean, floatKeyReviver(doc.style.floatKeys));
        attachList(doc);
        if (isItemDoc(doc)) doc.style.openNested = prefersOpenNested(doc, text);
        doc.baseline = serialize(doc);
        attachCoordSpans(doc, text);
      } catch (err) {
        doc.error = err.message;
        doc.root = null;
      }
      docs.push(doc);
    }
    return docs;
  }

  /** Tile files changed on disk since they were read (edited in an editor, or saved by another tool). */
  async function docsChangedOnDisk(docs) {
    const out = [];
    for (const doc of docs) {
      const file = await doc.entry.handle.getFile().catch(() => null);
      if (!file || file.lastModified !== doc.stamp) out.push(doc.name);
    }
    return out;
  }

  // Item files are written fully open, as they are by hand: every object on its own lines, only plain arrays inline.
  // -------------------------------------------------------------------------------------------------------------------
  // Coordinates inside a file that has comments
  //
  // Rewriting such a file whole would throw its comments away, so it is read and shown but not written (isDocDirty).
  // Moving art, though, only ever changes the two numbers of a coordinate, and those can be put back into the original
  // text where they stand. This finds where each one is: the file is walked once, skipping comments but counting every
  // character, and every array of two whole numbers is noted with the path that leads to it. Walking the parsed tree
  // down the same path then gives the live array, so a cell moved in the editor knows which characters to replace.

  /** [{ path, span: [start, end] }] for every [ x, y ] in the text, in the order they are written. */
  function coordSpans(text) {
    const out = [];
    let i = 0;

    const skip = () => {
      for (;;) {
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text[i] === "/" && text[i + 1] === "/") { const e = text.indexOf("\n", i); i = e < 0 ? text.length : e + 1; continue; }
        if (text[i] === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; continue; }
        return;
      }
    };

    const string = () => {
      i++;                                        // the opening quote
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === '"') { i++; return; }
        i++;
      }
    };

    // Returns the value when it is a whole number, and undefined for anything else: enough to spot [ x, y ].
    const value = (path) => {
      skip();
      const start = i;
      const c = text[i];

      if (c === "{") {
        i++;
        for (;;) {
          skip();
          if (text[i] === "}") { i++; break; }
          if (text[i] === ",") { i++; continue; }
          if (text[i] !== '"') { i++; continue; }   // malformed; the real parse will have reported it
          const from = i;
          string();
          const key = JSON.parse(text.slice(from, i));
          skip();
          if (text[i] === ":") i++;
          value(path.concat(key));
        }
        return undefined;
      }

      if (c === "[") {
        i++;
        const items = [];
        for (;;) {
          skip();
          if (text[i] === "]") { i++; break; }
          if (text[i] === ",") { i++; continue; }
          items.push(value(path.concat(items.length)));
        }
        if (items.length === 2 && items.every(Number.isInteger)) out.push({ path, span: [start, i] });
        return undefined;
      }

      if (c === '"') { string(); return undefined; }

      while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
      const raw = text.slice(start, i);
      const n = Number(raw);
      return /^-?\d+$/.test(raw) && Number.isInteger(n) ? n : undefined;
    };

    skip();
    value([]);
    return out;
  }

  const atPath = (root, path) => path.reduce((v, k) => (v == null ? v : v[k]), root);

  /** Ties each span to the live [x, y] in the parsed tree, and remembers what the file says today. */
  function attachCoordSpans(doc, text) {
    doc.coords = [];
    for (const { path, span } of coordSpans(text)) {
      const coord = atPath(doc.root, path);
      // The two walks go over the same file, so this only misses if the text and the parse disagree — then leave it.
      if (!isCoord(coord)) continue;
      doc.coords.push({ coord, span, was: [coord[0], coord[1]] });
    }
    doc.text = text;
  }

  const coordsMoved = (doc) => (doc.coords ?? []).some((c) => c.coord[0] !== c.was[0] || c.coord[1] !== c.was[1]);

  /** Whether the only thing that changed in a commented file is coordinates — the one change that can be patched in. */
  function coordsOnlyChange(doc) {
    if (!doc.coords) return false;
    const now = doc.coords.map((c) => [c.coord[0], c.coord[1]]);
    for (const c of doc.coords) { c.coord[0] = c.was[0]; c.coord[1] = c.was[1]; }
    const same = serialize(doc) === doc.baseline;
    doc.coords.forEach((c, i) => { c.coord[0] = now[i][0]; c.coord[1] = now[i][1]; });
    return same;
  }

  /** The file as it stands, with the moved coordinates written over the old ones and everything else left alone. */
  function patchedText(doc) {
    let text = doc.text;
    for (const c of [...doc.coords].sort((a, b) => b.span[0] - a.span[0])) {
      if (c.coord[0] === c.was[0] && c.coord[1] === c.was[1]) continue;
      text = text.slice(0, c.span[0]) + `[ ${c.coord[0]}, ${c.coord[1]} ]` + text.slice(c.span[1]);
    }
    return text;
  }

  /** Called after a save: what the file says now is what it holds. */
  function markCoordsSaved(doc, text) {
    doc.text = text;
    attachCoordSpans(doc, text);
  }

  function serialize(doc) {
    let text = formatJson(doc.root, "", isItemDoc(doc) ? "open" : null, doc.style);
    // The file's opening comment block goes back where it was, right under the brace, so documenting a format here
    // does not mean giving up editing the file in this tool.
    if (doc.header) text = text.replace(/^([[{])\n/, (_, brace) => brace + "\n" + doc.header + "\n");
    return text.replace(/\n/g, doc.eol) + doc.eol;
  }

  // Hand-written item files differ on small objects inside an item: food.json opens { "type", "amount" } over four lines,
  // runes.json keeps { "amount": 15 } on one. Whichever way reproduces more of the file as read is kept for that file.
  function prefersOpenNested(doc, text) {
    const lines = new Set(text.replace(/\r\n/g, "\n").split("\n"));
    const score = (openNested) => formatJson(doc.root, "", "open", { ...doc.style, openNested }).split("\n").filter((l) => lines.has(l)).length;
    return score(true) > score(false);
  }

  // Keys whose whole numbers the file writes as floats ("consumeDuration": 2.0). JSON.parse turns 2.0 into 2, so without
  // this every save would rewrite them; the source text is only there in browsers with JSON.parse source access (Chrome
  // 114+), elsewhere they are simply written as 2.
  function floatKeyReviver(keys) {
    return function (key, value, context) {
      if (typeof value === "number" && Number.isInteger(value) && context?.source && /[.eE]/.test(context.source) && !/^\d+$/.test(key)) {
        keys.add(key);
      }
      return value;
    };
  }

  // Compared as written text, so undoing back to the loaded state makes the file clean again and a file whose only
  // "change" is our own formatting is never rewritten.
  // A file with comments in it is never dirty: it is read and shown, and left exactly as it is on disk.
  // A file with comments is only ever written back with its coordinates patched, so for one of those "changed" means
  // a cell moved; anything else it cannot save and the panel says so.
  const isDocDirty = (doc) => !!doc.root && (doc.commented ? coordsMoved(doc) && coordsOnlyChange(doc) : serialize(doc) !== doc.baseline);

  /** The text to write for a doc: the whole file, or the original with the moved coordinates patched into it. */
  const docText = (doc) => (doc.commented ? patchedText(doc) : serialize(doc));

  const docSheet = (doc, tile) => sheetKey(tile?.sheetId ?? doc.root?.sheetId);
  const docCell = (doc) => [doc.root?.tileWidth ?? CELL, doc.root?.tileHeight ?? CELL];

  // -------------------------------------------------------------------------------------------------------------------
  // References

  /** The objects of a tile that carry their own "art": the tile, its parts, its flow siblings, its double chest. */
  function artOwners(tile) {
    const out = [{ owner: tile, where: "" }];
    const offset = (p) => `(${p.offsetX | 0}, ${p.offsetY | 0}, ${p.offsetZ | 0})`;
    if (Array.isArray(tile.parts)) {
      for (const p of tile.parts) if (p && typeof p === "object") out.push({ owner: p, where: "parte " + offset(p) });
    }
    if (Array.isArray(tile.flow)) {
      for (const f of tile.flow) if (f && typeof f === "object") out.push({ owner: f, where: `flujo '${f.name ?? f.id ?? "?"}'` });
    }
    const double = tile.storage?.double;
    if (double && typeof double === "object" && Array.isArray(double.parts)) {
      for (const p of double.parts) if (p && typeof p === "object") out.push({ owner: p, where: "cofre doble " + offset(p) });
    }
    return out;
  }

  /**
   * Every [x, y] a tile file points at: { doc, tile, owner, where, state, side, coord, sheet, tw, th }. coord is the
   * array inside the parsed file — changing its two numbers is changing the file.
   */
  function collectRefs(docs) {
    const refs = [];
    for (const doc of docs) {
      if (!doc.root) continue;
      const [tw, th] = docCell(doc);
      for (const tile of doc.root.tiles) {
        if (!tile || typeof tile !== "object") continue;
        const sheet = docSheet(doc, tile);
        if (isItemDoc(doc)) {
          // Any "iconCoord", [0, 0] included, is a real cell. An item without the key has no icon of its own: the game
          // shows its fallback square, or a tile item's tile.
          const c = tile.iconCoord;
          if (isCoord(c)) refs.push({ doc, tile, owner: tile, where: "", state: "icon", side: "front", coord: c, sheet, tw, th });
          continue;
        }
        for (const { owner, where } of artOwners(tile)) {
          const art = owner.art;
          if (!art || typeof art !== "object" || Array.isArray(art)) continue;
          for (const [state, frame] of Object.entries(art)) {
            // A bare [x, y] (an early draft of the format) is a front.
            if (isCoord(frame)) {
              refs.push({ doc, tile, owner, where, state, side: "front", coord: frame, sheet, tw, th });
              continue;
            }
            if (!frame || typeof frame !== "object") continue;
            // Every side the frame names, not just front and back: a fence keeps its four arms in here, and a flight
            // of stairs its four bends, and leaving those out would lose track of the cells they point at.
            for (const [side, coord] of Object.entries(frame)) {
              if (isCoord(coord)) refs.push({ doc, tile, owner, where, state, side, coord, sheet, tw, th });
            }
          }
        }
      }
    }
    return refs;
  }

  const refLabel = (ref) => [STATE_LABEL[ref.state] ?? ref.state, SIDE_LABEL[ref.side] ?? ref.side, ref.where].filter(Boolean).join(" · ");
  const refRect = (ref) => ({ x: ref.coord[0] * ref.tw, y: ref.coord[1] * ref.th, w: ref.tw, h: ref.th });

  /** Ids declared more than once: TileInfo.Load stops on the second. Tiles and items are separate registries, so the
   * "grass" block and the "grass" item never clash. */
  function duplicateIds(docs) {
    const seen = new Map();
    for (const doc of docs) for (const tile of doc.root?.tiles ?? []) {
      if (!tile || (!tile.id && !tile.name)) continue;
      const key = (isItemDoc(doc) ? "item " : "") + tileId(tile);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  }

  /** Same check for an item typed by hand (ItemRegistry.ParseItem): name and type, and a well-formed iconCoord. */
  function validateItem(item) {
    const problems = [];
    if (!item || typeof item !== "object" || Array.isArray(item)) return ["Un item es un objeto { … }."];
    if (!item.name) problems.push("Le falta \"name\".");
    if (!item.type) problems.push("Le falta \"type\" (MiscItem, Material, TileItem, ConsumableItem…).");
    if (item.iconCoord !== undefined && !isCoord(item.iconCoord)) problems.push("\"iconCoord\" debe ser [ x, y ].");
    return problems;
  }

  /**
   * Sorts a file's list by where its art sits: the smallest Y first, then X, so the JSON reads in the sheet's order. An
   * entry with no art on any sheet keeps its place among the others at the end. Returns the new order, or null when the
   * list already is in it.
   */
  function orderByCoord(doc, refs) {
    const list = doc.root?.tiles;
    if (!list) return null;
    const firstCell = new Map();
    for (const r of refs) {
      if (r.doc !== doc) continue;
      const at = firstCell.get(r.tile);
      if (!at || r.coord[1] < at[1] || (r.coord[1] === at[1] && r.coord[0] < at[0])) firstCell.set(r.tile, [r.coord[0], r.coord[1]]);
    }

    const keyed = list.map((t, i) => ({ t, i, at: firstCell.get(t) }));
    keyed.sort((a, b) => {
      if (!a.at || !b.at) return (a.at ? 0 : 1) - (b.at ? 0 : 1) || a.i - b.i;
      return a.at[1] - b.at[1] || a.at[0] - b.at[0] || a.i - b.i;
    });
    const next = keyed.map((k) => k.t);
    return next.every((t, i) => t === list[i]) ? null : next;
  }

  /** Problems a tile JSON typed by hand would stop the game with, as messages; empty when it reads fine. */
  function validateTile(tile) {
    const problems = [];
    if (!tile || typeof tile !== "object" || Array.isArray(tile)) return ["Un tile es un objeto { … }."];
    if (!tile.id && !tile.name) problems.push("Le falta \"id\" o \"name\".");
    for (const { owner, where } of artOwners(tile)) {
      const art = owner.art;
      if (art === undefined) continue;
      const at = where ? ` (${where})` : "";
      if (!art || typeof art !== "object" || Array.isArray(art)) { problems.push(`"art"${at} debe ser un objeto por estado.`); continue; }
      for (const [state, frame] of Object.entries(art)) {
        if (!STATES.includes(state.toLowerCase())) problems.push(`Estado de arte desconocido "${state}"${at}: usa ${STATES.join(", ")}.`);
        if (isCoord(frame)) continue;
        if (!frame || typeof frame !== "object" || !isCoord(frame.front)) problems.push(`"art.${state}"${at} necesita "front": [ x, y ].`);
        if (frame?.back !== undefined && !isCoord(frame.back)) problems.push(`"art.${state}.back"${at} debe ser [ x, y ].`);
      }
    }
    return problems;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // JSON out — the style the project's files are written in: two-space indent, arrays of plain values on one line
  // ([ 0, 0 ]), small flat objects on one line, and each art state on one line so a tile's art reads as a table.

  // role "open" (an item file's root and its list) and "item" (each item): always opened, like the hand-written files;
  // what is inside an item follows the usual rule, so a small { "amount": 15 } stays on one line.
  function formatJson(v, indent = "", role = null, style = null) {
    const floatKeys = style?.floatKeys;
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      if (v.every((x) => x === null || typeof x !== "object")) return `[ ${v.map((x) => JSON.stringify(x)).join(", ")} ]`;
      const inner = indent + "  ";
      return `[\n${v.map((x) => inner + formatJson(x, inner, role === "open" ? "item" : role === "nested" ? "nested" : null, style)).join(",\n")}\n${indent}]`;
    }
    if (v && typeof v === "object") {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      if (!keys.length) return "{}";
      const value = (k, inner, childRole) => (floatKeys?.has(k) && Number.isInteger(v[k])
        ? `${v[k]}.0`
        : formatJson(v[k], inner, childRole, style));
      if (role === "artState") return `{ ${keys.map((k) => `${JSON.stringify(k)}: ${value(k)}`).join(", ")} }`;
      // A small flat object ({ "item": …, "minQty": 1 }, "placement", "growth") stays on one line, as the files are
      // written by hand; anything holding objects, or too long, opens up.
      const flat = keys.every((k) => v[k] === null || typeof v[k] !== "object" || (Array.isArray(v[k]) && v[k].every((x) => x === null || typeof x !== "object")));
      if (flat && role !== "art" && role !== "open" && role !== "item" && role !== "nested") {
        const line = `{ ${keys.map((k) => `${JSON.stringify(k)}: ${value(k)}`).join(", ")} }`;
        if (line.length <= 96) return line;
      }
      const inner = indent + "  ";
      const nested = style?.openNested ? "nested" : null;
      const childRole = (k) => (role === "open" ? "open"
        : role === "item" || role === "nested" ? nested
        : role === "art" ? "artState" : k === "art" ? "art" : null);
      return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${value(k, inner, childRole(k))}`).join(",\n")}\n${indent}}`;
    }
    return JSON.stringify(v);
  }

  Aura.atlasTiles = {
    CELL, STATES, STATE_LABEL, isCoord, sheetKey, deriveIdPath, tileId, tileLabel,
    loadDocs, docsChangedOnDisk, serialize, docText, isDocDirty, coordSpans, coordsMoved, coordsOnlyChange, markCoordsSaved,
    docSheet, docCell, artOwners, collectRefs, refLabel, refRect, duplicateIds,
    validateTile, validateItem, formatJson, isItemDoc, orderByCoord, DEFAULT_ITEM_SHEET,
  };
})(window.Aura ??= {});
