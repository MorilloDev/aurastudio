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
        // file used to make the whole atlas refuse the file. They are taken out for reading. Writing one back is done
        // piece by piece instead of whole, so the comments stay where they are (see patchedText).
        const clean = stripComments(text);
        doc.header = clean !== text ? headerComments(text) : null;
        doc.commented = clean !== text && doc.header === null;
        doc.root = JSON.parse(clean, floatKeyReviver(doc.style.floatKeys));
        attachList(doc);
        if (isItemDoc(doc)) doc.style.openNested = prefersOpenNested(doc, text);
        doc.baseline = serialize(doc);
        attachSpans(doc, text);
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
  // Writing a file that has comments
  //
  // Rewriting such a file whole would throw its comments away. Instead the file is read once, counting every character
  // and skipping comments, and what is written down is where each piece of it sits in the text: every [ x, y ], and
  // every tile of the list. Saving then touches only the pieces that changed:
  //
  //   · a cell that moved  -> the two numbers are replaced where they stand, and nothing else in the file is touched;
  //   · a tile that changed in any other way -> that tile's block is written again (a comment inside that one tile is
  //     lost, and the save says which);
  //   · a tile added or removed -> inserted at the end of the list, or cut out of it.
  //
  // Everything outside those pieces — the header, the blank lines, the comments on other tiles — comes through as it
  // was on disk.

  /** Where every value sits in the text. Comments are skipped but counted, so the offsets are into the file as read. */
  function scanJson(text) {
    const coords = [], elements = [], arrays = new Map();
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
      i++;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === '"') { i++; return; }
        i++;
      }
    };

    // Returns the value when it is a whole number, and undefined otherwise: enough to spot [ x, y ].
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
          if (text[i] !== '"') { i++; continue; }          // malformed; the real parse reports it
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
          if (text[i] === "]") { arrays.set(path.join("\u0000"), { start, end: i + 1, close: i }); i++; break; }
          if (text[i] === ",") { i++; continue; }
          const at = i;
          items.push(value(path.concat(items.length)));
          elements.push({ path: path.concat(items.length - 1), span: [at, i] });
        }
        if (items.length === 2 && items.every(Number.isInteger)) coords.push({ path, span: [start, i] });
        return undefined;
      }

      if (c === '"') { string(); return undefined; }

      while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
      const raw = text.slice(start, i);
      return /^-?\d+$/.test(raw) ? Number(raw) : undefined;
    };

    skip();
    value([]);
    return { coords, elements, arrays };
  }

  const atPath = (root, path) => path.reduce((v, k) => (v == null ? v : v[k]), root);

  // Where the list of tiles or items lives in the text. An item file can be the bare array, and then it is the root.
  function listPath(doc) {
    if (doc.kind === "tiles") return ["tiles"];
    return Array.isArray(doc.root) ? [] : ["items"];
  }

  // How a value compares: same text, same value. Key order is kept by the parser, so this catches a reorder too.
  const canonical = (value) => JSON.stringify(value);

  /** Ties the spans to the live tree and remembers what the file says today. */
  function attachSpans(doc, text) {
    const scan = scanJson(text);
    doc.text = text;
    doc.coords = [];
    for (const { path, span } of scan.coords) {
      const coord = atPath(doc.root, path);
      if (!isCoord(coord)) continue;                       // text and parse disagree; leave that one alone
      doc.coords.push({ coord, span, was: [coord[0], coord[1]] });
    }

    const key = listPath(doc);
    const prefix = key.join("\u0000");
    doc.entries = [];
    for (const { path, span } of scan.elements) {
      if (path.length !== key.length + 1 || path.slice(0, key.length).join("\u0000") !== prefix) continue;
      const value = atPath(doc.root, path);
      if (value == null) continue;
      doc.entries.push({ value, span, baseline: canonical(value) });
    }
    doc.listSpan = scan.arrays.get(prefix) ?? null;
  }

  /** Whether a commented file can be written back at all: it needs the spans, and a list it can add to. */
  const canPatch = (doc) => !!doc.coords && !!doc.entries && !!doc.listSpan;

  // The tiles whose block has to be written again, and whether any of them carries a comment that will go with it.
  function rewrites(doc) {
    const list = doc.root.tiles;
    const out = [];
    for (const entry of doc.entries) {
      if (!list.includes(entry.value)) { out.push({ entry, kind: "remove" }); continue; }
      if (canonical(entry.value) === entry.baseline) continue;

      // Only the cells moved? Then the numbers are replaced where they stand and the comments stay.
      const inside = doc.coords.filter((c) => c.span[0] >= entry.span[0] && c.span[1] <= entry.span[1]);
      const now = inside.map((c) => [c.coord[0], c.coord[1]]);
      for (const c of inside) { c.coord[0] = c.was[0]; c.coord[1] = c.was[1]; }
      const coordsOnly = canonical(entry.value) === entry.baseline;
      inside.forEach((c, k) => { c.coord[0] = now[k][0]; c.coord[1] = now[k][1]; });
      if (coordsOnly) continue;

      out.push({ entry, kind: "replace" });
    }
    return out;
  }

  /** Which tiles would lose a comment if the file were saved now, by id. Empty when nothing would.</summary> */
  function commentsAtRisk(doc) {
    if (!canPatch(doc)) return [];
    const at = [];
    for (const { entry, kind } of rewrites(doc)) {
      const slice = doc.text.slice(entry.span[0], entry.span[1]);
      if (kind === "replace" && /\/\/|\/\*/.test(slice)) at.push(tileId(entry.value));
    }
    return at;
  }

  const anyChange = (doc) => serialize(doc) !== doc.baseline;

  /** The file as it stands: the text on disk with only the pieces that changed written over. */
  function patchedText(doc) {
    const list = doc.root.tiles;
    const edits = [];

    // Cells that moved, outside any tile that is being written again anyway.
    const redone = new Set(rewrites(doc).filter((r) => r.kind === "replace").map((r) => r.entry));
    for (const c of doc.coords) {
      if (c.coord[0] === c.was[0] && c.coord[1] === c.was[1]) continue;
      const owner = doc.entries.find((e) => c.span[0] >= e.span[0] && c.span[1] <= e.span[1]);
      if (owner && (redone.has(owner) || !list.includes(owner.value))) continue;
      edits.push({ start: c.span[0], end: c.span[1], text: `[ ${c.coord[0]}, ${c.coord[1]} ]` });
    }

    // Tiles written again or cut out.
    const indent = indentOf(doc);
    for (const { entry, kind } of rewrites(doc)) {
      if (kind === "replace") {
        edits.push({ start: entry.span[0], end: entry.span[1], text: formatJson(entry.value, indent, isItemDoc(doc) ? "item" : null, doc.style) });
        continue;
      }
      // Out with the comma that held it in the list, so what is left still parses.
      let start = entry.span[0], end = entry.span[1];
      let after = end;
      while (after < doc.text.length && /\s/.test(doc.text[after])) after++;
      if (doc.text[after] === ",") { end = after + 1; while (end < doc.text.length && doc.text[end] !== "\n") end++; }
      else { let before = start; while (before > 0 && /\s/.test(doc.text[before - 1])) before--; if (doc.text[before - 1] === ",") start = before - 1; }
      edits.push({ start, end, text: "" });
    }

    // Tiles that are new to the list: in at the end, where nothing else has to move.
    const added = list.filter((value) => !doc.entries.some((e) => e.value === value));
    if (added.length) {
      const body = added.map((value) => indent + formatJson(value, indent, isItemDoc(doc) ? "item" : null, doc.style)).join(",\n");
      const close = doc.listSpan.close;
      let at = close;
      while (at > 0 && /\s/.test(doc.text[at - 1])) at--;
      const lead = doc.entries.length || doc.text[at - 1] !== "[" ? ",\n" : "\n";
      edits.push({ start: at, end: at, text: lead + body });
    }

    let text = doc.text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    return text;
  }

  // The indent the list's own entries are written with, taken from the file rather than assumed.
  function indentOf(doc) {
    const first = doc.entries[0];
    if (!first) return "    ";
    let at = first.span[0];
    while (at > 0 && (doc.text[at - 1] === " " || doc.text[at - 1] === "\t")) at--;
    return doc.text.slice(at, first.span[0]) || "    ";
  }

  /** Called after a save: what the file says now is what it holds. */
  function markCoordsSaved(doc, text) {
    attachSpans(doc, text);
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
  const isDocDirty = (doc) => !!doc.root && (doc.commented ? canPatch(doc) && anyChange(doc) : serialize(doc) !== doc.baseline);

  /** The text to write for a doc: the whole file, or the original with only the changed pieces written over. */
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
    loadDocs, docsChangedOnDisk, serialize, docText, isDocDirty, scanJson, canPatch, commentsAtRisk, markCoordsSaved, attachSpans,
    docSheet, docCell, artOwners, collectRefs, refLabel, refRect, duplicateIds,
    validateTile, validateItem, formatJson, isItemDoc, orderByCoord, DEFAULT_ITEM_SHEET,
  };
})(window.Aura ??= {});
