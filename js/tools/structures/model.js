"use strict";

// A template being built: its cells (tile, facing, shape), the anchor, the cells hidden from view, and the edits — placing
// a piece the way WorldQuery.PlaceTile does (a rotatable piece turns its parts with its facing), removing the whole piece
// from any of its cells, filling and clearing rectangles. Every edit is one undo step in the tool's History. The file is
// the format StructureTemplates reads (formatVersion 2).
(function (Aura) {
  const { SHAPE, AIR, short, shapeKeepsFacing } = Aura.structTiles;

  const FORMAT_VERSION = 2;
  const key = (x, y, z) => `${x},${y},${z}`;
  const parse = (k) => k.split(",").map(Number);
  const qualify = (id) => (String(id).includes(":") ? String(id) : "aura:" + id);

  // WorldQuery.RotateOffset: a piece's part offset turned by its facing (0..3 = PlacementDirection North..West).
  function rotateOffset(ox, oz, dir) {
    switch (dir) {
      case 1: return [-oz, ox];
      case 2: return [-ox, -oz];
      case 3: return [oz, -ox];
      default: return [ox, oz];
    }
  }

  /** A Set that tells when it changes (the hidden cells: they alter what the views draw, and so what shades what). */
  class NotifySet extends Set {
    constructor(onChange) { super(); this.onChange = onChange; }
    add(v) { const had = this.has(v); super.add(v); if (!had) this.onChange(); return this; }
    delete(v) { const had = super.delete(v); if (had) this.onChange(); return had; }
    clear() { if (this.size) { super.clear(); this.onChange(); } }
  }

  class TemplateDoc {
    /** Counts every change to the cells or to what is hidden, so what is worked out from them (the AO) knows when to redo. */
    rev = 0;
    blocks = new Map();     // "x,y,z" → tile id (short)
    dirs = new Map();       // "x,y,z" → facing 1..3 (absent = 0)
    shapes = new Map();     // "x,y,z" → CellShape flags (absent = 0)
    hidden = new NotifySet(() => { this.rev++; });     // view only, never saved
    anchor = null;          // [x, y, z], or null for the bottom-centre default
    unknown = new Set();    // tile ids the file names that no tile file defines
    extra = { blockEntities: [], connectors: [] };     // kept as read: the Studio does not edit them yet

    /** registry: TileRegistry; history: the tool's History (each commit is one step); onChange after every change. */
    constructor(registry, history, onChange) {
      this.registry = registry;
      this.history = history;
      this.onChange = onChange;
    }

    static fromJson(o, registry, history, onChange) {
      const doc = new TemplateDoc(registry, history, onChange);
      const palette = Array.isArray(o?.palette) ? o.palette.map(short) : [];
      for (const b of Array.isArray(o?.blocks) ? o.blocks : []) {
        const [x, y, z, index, dir, shape] = b;
        const id = palette[index];
        if (id == null) continue;
        if (!registry.has(id)) doc.unknown.add(id);
        const k = key(x, y, z);
        doc.blocks.set(k, id);
        if (dir & 3) doc.dirs.set(k, dir & 3);
        if (shape) doc.shapes.set(k, registry.templateShape(id, shape));
      }
      doc.anchor = Array.isArray(o?.anchor) ? o.anchor.slice(0, 3) : null;
      if (Array.isArray(o?.blockEntities)) doc.extra.blockEntities = o.blockEntities;
      if (Array.isArray(o?.connectors)) doc.extra.connectors = o.connectors;
      return doc;
    }

    /** Cells of a generated structure (Map "x,y,z" → { id, dir, shape }), as a doc the views can draw. */
    static fromCells(cells, registry) {
      const doc = new TemplateDoc(registry, null, null);
      for (const [k, c] of cells) {
        doc.blocks.set(k, c.id);
        if (c.dir) doc.dirs.set(k, c.dir);
        if (c.shape) doc.shapes.set(k, c.shape);
      }
      return doc;
    }

    get size() { return this.blocks.size; }

    bounds() {
      if (!this.blocks.size) return null;
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const k of this.blocks.keys()) {
        const [x, y, z] = parse(k);
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      }
      return { minX, minY, minZ, maxX, maxY, maxZ };
    }

    /** The anchor in use: the one set, or the bottom layer's footprint centre. */
    effectiveAnchor() {
      if (this.anchor) return this.anchor;
      const b = this.bounds();
      return b ? [Math.floor((b.minX + b.maxX) / 2), b.minY, Math.floor((b.minZ + b.maxZ) / 2)] : [0, 0, 0];
    }

    cell(k) {
      const id = this.blocks.get(k);
      return id === undefined ? null : { id, dir: this.dirs.get(k) ?? 0, shape: this.shapes.get(k) ?? 0 };
    }

    // ── Editing ──────────────────────────────────────────────────────────────────────────────────────────────────

    /** changes: Map "x,y,z" → { id, dir, shape } | null. One undo step; nothing when nothing changes. */
    commit(changes, label = "Editar") {
      const record = [];
      for (const [k, after] of changes) {
        const before = this.cell(k);
        if (same(before, after)) continue;
        record.push([k, before, after]);
      }
      if (!record.length) return false;
      this.history.run({
        label,
        redo: () => { for (const [k, , after] of record) this.#apply(k, after); this.onChange?.(); },
        undo: () => { for (let i = record.length - 1; i >= 0; i--) this.#apply(record[i][0], record[i][1]); this.onChange?.(); },
      });
      return true;
    }

    #apply(k, c) {
      this.rev++;
      if (c === null) {
        this.blocks.delete(k); this.dirs.delete(k); this.shapes.delete(k); this.hidden.delete(k);
        return;
      }
      this.blocks.set(k, c.id);
      if (c.dir) this.dirs.set(k, c.dir); else this.dirs.delete(k);
      if (c.shape) this.shapes.set(k, c.shape); else this.shapes.delete(k);
    }

    /** As WorldQuery.PlaceTile: a rotatable piece turns its part offsets by its facing, every cell keeps that facing. */
    placeInto(changes, [x, y, z], id, facing, shape) {
      const tile = this.registry.get(id);
      const sh = this.registry.shapeOptions(id).some(([v]) => v === shape) ? shape : 0;
      const dir = tile?.rotatable || shapeKeepsFacing(sh) ? facing : 0;
      if (tile?.parts) {
        for (const p of tile.parts) {
          const [rx, rz] = rotateOffset(p.dx, p.dz, dir);
          changes.set(key(x + rx, y + p.dy, z + rz), { id: p.id, dir, shape: 0 });
        }
        return;
      }
      changes.set(key(x, y, z), { id: short(id), dir, shape: sh });
    }

    /** Removing any cell of a multi-cell piece removes the whole piece, as breaking it does in the game. */
    removeInto(changes, [x, y, z]) {
      const k = key(x, y, z);
      const id = this.blocks.get(k);
      if (!id) return;
      changes.set(k, null);
      const dir = this.dirs.get(k) ?? 0;
      const tile = this.registry.get(id);
      let ax = x, ay = y, az = z, anchorTile = tile;
      if (tile?.anchor) {
        const [ox, oz] = rotateOffset(tile.anchor.dx, tile.anchor.dz, dir);
        ax += ox; ay += tile.anchor.dy; az += oz;
        anchorTile = this.registry.get(tile.anchor.id);
      }
      for (const p of anchorTile?.parts ?? []) {
        const [rx, rz] = rotateOffset(p.dx, p.dz, dir);
        const pk = key(ax + rx, ay + p.dy, az + rz);
        if (this.blocks.get(pk) === p.id) changes.set(pk, null);
      }
    }

    place(cell, id, facing, shape) {
      const changes = new Map();
      this.placeInto(changes, cell, id, facing, shape);
      return this.commit(changes, "Poner " + id);
    }

    remove(cell) {
      const changes = new Map();
      this.removeInto(changes, cell);
      return this.commit(changes, "Quitar");
    }

    /** A rectangle on one level, filled with a one-cell tile or cleared. Returns an error text, or null. */
    rect([x0, z0], [x1, z1], level, id, facing, shape, remove) {
      if (!remove && this.registry.get(id)?.parts) return "El rectángulo solo rellena tiles de una celda.";
      const changes = new Map();
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
          if (remove) this.removeInto(changes, [x, level, z]);
          else this.placeInto(changes, [x, level, z], id, facing, shape);
        }
      this.commit(changes, remove ? "Vaciar rectángulo" : "Rellenar rectángulo");
      return null;
    }

    /** A list of cells (a shape) filled with a one-cell tile, or cleared: one undo step. Returns an error text, or null. */
    fill(cells, id, facing, shape, remove, label) {
      if (!remove && this.registry.get(id)?.parts) return "Las formas solo rellenan tiles de una celda.";
      const changes = new Map();
      for (const c of cells) {
        if (remove) this.removeInto(changes, c);
        else this.placeInto(changes, c, id, facing, shape);
      }
      this.commit(changes, label ?? (remove ? "Vaciar forma" : "Forma"));
      return null;
    }

    setAnchor(cell) {
      const before = this.anchor, after = cell ? cell.slice() : null;
      this.history.run({ label: "Anclaje", redo: () => { this.anchor = after; this.onChange?.(); }, undo: () => { this.anchor = before; this.onChange?.(); } });
    }

    // ── File ─────────────────────────────────────────────────────────────────────────────────────────────────────

    /** The file StructureTemplates reads. Throws on an empty template. */
    toText() {
      const b = this.bounds();
      if (!b) throw new Error("La plantilla está vacía.");
      const a = this.effectiveAnchor();
      // The game requires the anchor inside the size, so an anchor outside the blocks grows the bounds.
      const minX = Math.min(b.minX, a[0]), minY = Math.min(b.minY, a[1]), minZ = Math.min(b.minZ, a[2]);
      const maxX = Math.max(b.maxX, a[0]), maxY = Math.max(b.maxY, a[1]), maxZ = Math.max(b.maxZ, a[2]);

      const entries = [...this.blocks].map(([k, id]) => {
        const [x, y, z] = parse(k);
        return [x - minX, y - minY, z - minZ, id, this.dirs.get(k) ?? 0, this.shapes.get(k) ?? 0];
      });
      entries.sort((p, q) => p[1] - q[1] || p[2] - q[2] || p[0] - q[0]);

      const palette = [], index = new Map();
      for (const e of entries) if (!index.has(e[3])) { index.set(e[3], palette.length); palette.push(e[3]); }

      const rows = [];
      for (let i = 0; i < entries.length; i += 8)
        rows.push("    " + entries.slice(i, i + 8).map(([x, y, z, id, dir, shape]) => shape ? `[${x},${y},${z},${index.get(id)},${dir},${shape}]`
          : dir ? `[${x},${y},${z},${index.get(id)},${dir}]` : `[${x},${y},${z},${index.get(id)}]`).join(", "));

      return [
        "{",
        `  "formatVersion": ${FORMAT_VERSION},`,
        `  "size": [${maxX - minX + 1}, ${maxY - minY + 1}, ${maxZ - minZ + 1}],`,
        `  "anchor": [${a[0] - minX}, ${a[1] - minY}, ${a[2] - minZ}],`,
        `  "palette": [${palette.map((id) => JSON.stringify(qualify(id))).join(", ")}],`,
        '  "blocks": [',
        rows.join(",\n"),
        "  ],",
        `  "blockEntities": ${JSON.stringify(this.extra.blockEntities)},`,
        `  "connectors": ${JSON.stringify(this.extra.connectors)}`,
        "}",
        "",
      ].join("\n");
    }
  }

  const same = (a, b) => a === b || (!!a && !!b && a.id === b.id && (a.dir ?? 0) === (b.dir ?? 0) && (a.shape ?? 0) === (b.shape ?? 0));

  Aura.structModel = { TemplateDoc, key, parse, rotateOffset, AIR, SHAPE };
})(window.Aura ??= {});
