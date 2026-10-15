"use strict";

// The tile files (Data/Tiles/*.json) as the Atlas tool edits them. Every place a tile points into a sheet is kept as the
// live [x, y] array of the parsed file, so moving a cell edits the file itself and nothing has to be merged back; the
// file is written again in the project's own JSON style only when it really changed.
(function (Aura) {
  const { baseName } = Aura.fs;

  // TileInfo.ParseTileFile: tileWidth / tileHeight default to 64 when a file declares none.
  const CELL = 64;
  const NAMESPACE = "aura";

  // TileArtState, in the order the editor lists them.
  const STATES = ["default", "inverted", "vertical", "horizontal", "wall"];
  const STATE_LABEL = { default: "normal", inverted: "invertido", vertical: "vertical", horizontal: "horizontal", wall: "pared" };

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

  /** Every tile file of the project, parsed. A file that does not parse is listed with its error and never written. */
  async function loadDocs(project) {
    const entries = project.filter(isTileFile).sort((a, b) => a.path.localeCompare(b.path));
    const docs = [];
    for (const entry of entries) {
      const doc = { entry, path: entry.path, name: baseName(entry.path), root: null, eol: "\n", baseline: "", error: null, stamp: 0 };
      try {
        const file = await entry.handle.getFile();
        doc.stamp = file.lastModified;
        const text = await file.text();
        doc.eol = text.includes("\r\n") ? "\r\n" : "\n";
        doc.root = JSON.parse(text);
        if (!doc.root || typeof doc.root !== "object" || !Array.isArray(doc.root.tiles)) throw new Error("no tiene \"tiles\"");
        doc.baseline = serialize(doc);
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

  const serialize = (doc) => formatJson(doc.root).replace(/\n/g, doc.eol) + doc.eol;

  // Compared as written text, so undoing back to the loaded state makes the file clean again and a file whose only
  // "change" is our own formatting is never rewritten.
  const isDocDirty = (doc) => !!doc.root && serialize(doc) !== doc.baseline;

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
            for (const side of ["front", "back"]) {
              if (isCoord(frame[side])) refs.push({ doc, tile, owner, where, state, side, coord: frame[side], sheet, tw, th });
            }
          }
        }
      }
    }
    return refs;
  }

  const refLabel = (ref) => [STATE_LABEL[ref.state] ?? ref.state, ref.side === "back" ? "espalda" : "", ref.where].filter(Boolean).join(" · ");
  const refRect = (ref) => ({ x: ref.coord[0] * ref.tw, y: ref.coord[1] * ref.th, w: ref.tw, h: ref.th });

  /** Ids declared more than once: TileInfo.Load stops on the second. */
  function duplicateIds(docs) {
    const seen = new Map();
    for (const doc of docs) for (const tile of doc.root?.tiles ?? []) {
      if (!tile || (!tile.id && !tile.name)) continue;
      const id = tileId(tile);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
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
  // JSON out — the style the project's files are written in (the same the old Atlas tool wrote): two-space indent, arrays
  // of plain values on one line ([ 0, 0 ]), and each art state on one line so a tile's art reads as a table.

  function formatJson(v, indent = "", role = null) {
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      if (v.every((x) => x === null || typeof x !== "object")) return `[ ${v.map((x) => JSON.stringify(x)).join(", ")} ]`;
      const inner = indent + "  ";
      return `[\n${v.map((x) => inner + formatJson(x, inner)).join(",\n")}\n${indent}]`;
    }
    if (v && typeof v === "object") {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      if (!keys.length) return "{}";
      if (role === "artState") return `{ ${keys.map((k) => `${JSON.stringify(k)}: ${formatJson(v[k])}`).join(", ")} }`;
      const inner = indent + "  ";
      const childRole = (k) => (role === "art" ? "artState" : k === "art" ? "art" : null);
      return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${formatJson(v[k], inner, childRole(k))}`).join(",\n")}\n${indent}}`;
    }
    return JSON.stringify(v);
  }

  Aura.atlasTiles = {
    CELL, STATES, STATE_LABEL, isCoord, sheetKey, deriveIdPath, tileId, tileLabel,
    loadDocs, docsChangedOnDisk, serialize, isDocDirty, docSheet, docCell, artOwners, collectRefs, refLabel, refRect, duplicateIds,
    validateTile, formatJson,
  };
})(window.Aura ??= {});
