"use strict";

// Every tile the structure editor can place or draw, registered the way TileInfo.Load registers them: the file tiles, then
// their generated siblings — part cells of multi-cell pieces ("<id>_part_1_0_0"), back art ("<id>_back"), the shape art
// of slabs, logs and hanging pieces ("_vertical", "_horizontal", "_wall", "_inverted"), flows, colour variants and the
// joined double chest. Each tile gets its sprite (atlas cell, colour-variant multiply, foliage tint on its grey pixels)
// and its flat colours: the sprite's average for the plan, its top half for the 3D blocks.
(function (Aura) {
  const T = Aura.atlasTiles;
  const { decodePng } = Aura.png;

  const NAMESPACE = "aura";
  const AIR = "air";
  const CELL = 64;

  // CellShape flags, as stored per cell in the game.
  const SHAPE = { UPPER: 1, DOUBLE: 2, VERTICAL: 4, HORIZONTAL: 8, WALL: 64 };

  // TileArt states and the per-state keys the registry reads them into.
  const ART_STATES = [
    { state: "default", front: "tileCoord", back: "backCoord" },
    { state: "inverted", front: "invertedCoord", back: "invertedBackCoord" },
    { state: "vertical", front: "verticalCoord", back: "verticalBackCoord" },
    { state: "horizontal", front: "horizontalCoord", back: "horizontalBackCoord" },
    { state: "wall", front: "wallCoord", back: "wallBackCoord" },
  ];

  /** Ids are short in the editor ("oak_log"); a mod's keep their namespace ("mymod:ruin_wall"). */
  const short = (id) => {
    const s = String(id ?? "").trim().toLowerCase();
    return s.startsWith(NAMESPACE + ":") ? s.slice(NAMESPACE.length + 1) : s;
  };
  const deriveIdPath = (name) => String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const offsetText = (n) => (n < 0 ? `m${-n}` : `${n}`);
  const partId = (anchor, dx, dy, dz) => `${anchor}_part_${offsetText(dx)}_${offsetText(dy)}_${offsetText(dz)}`;
  const coordOf = (t) => (Array.isArray(t) && t.length >= 2 ? [t[0] | 0, t[1] | 0] : null);
  const hexRgb = (hex) => {
    const c = typeof hex === "string" ? hex.replace("#", "") : "";
    return c.length >= 6 ? [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)] : null;
  };

  class TileRegistry {
    tiles = new Map();          // short id → tile
    errors = [];
    #sheets = new Map();        // sheet key → canvas | null
    #loading = new Map();       // sheet key → promise, while it decodes
    #sprites = new Map();       // id|foliage → canvas | null
    #colors = new Map();

    constructor(project, tileDocs) {
      this.project = project;
      this.#add({ id: AIR, name: "Aire", category: "terrain", tags: [], sheet: "", tw: CELL, th: CELL, coord: null, inPalette: true });
      for (const doc of tileDocs) {
        if (doc.kind === "items" || !doc.root || !Array.isArray(doc.root.tiles)) continue;
        const root = doc.root;
        const ctx = { sheet: T.sheetKey(root.sheetId ?? "terrain"), tw: root.tileWidth ?? CELL, th: root.tileHeight ?? CELL,
          category: String(root.category ?? "terrain").toLowerCase(), file: doc.name };
        for (const raw of root.tiles) {
          if (!raw || (!raw.id && !raw.name)) continue;
          const o = structuredClone(raw);
          normalizeArt(o);
          this.#entry(o, ctx);
          const double = doubleStorage(o);
          if (double) this.#entry(double, ctx);
        }
      }
    }

    get(id) { return this.tiles.get(short(id)) ?? null; }
    has(id) { return this.tiles.has(short(id)); }

    /** The piece a cell belongs to: the anchor tile for a part cell. */
    pieceOf(id) {
      const t = this.get(id);
      return t?.anchor ? this.get(t.anchor.id) : t;
    }

    paletteTiles() { return [...this.tiles.values()].filter((t) => t.inPalette); }

    isPlant(id) {
      const t = this.get(id);
      return !!t && (t.category === "foliage" || t.tags.includes("fragile") || t.tags.includes("leaf"));
    }

    isSoil(id) {
      const t = this.get(id);
      return !!t && ["dirt", "grass", "sand", "soil"].some((g) => t.tags.includes(g)) && !t.tags.includes("log") && !t.tags.includes("leaf");
    }

    isLeaf(id) { return !!this.get(id)?.tags.includes("leaf") || /leaves$/.test(short(id)); }
    isLog(id) { const t = this.get(id); return !!t && !this.isLeaf(id) && (t.tags.includes("log") || /_log$/.test(t.id)); }

    /** What the 3D view draws a tile as: "plant" (crossed quads), "water", "glass", "slab" or "solid". */
    kind(id) {
      const t = this.get(id);
      if (!t) return "solid";
      if (t.liquid) return "water";
      if (t.category === "foliage" || t.tags.includes("no_collision") || t.tags.includes("tiny")) return "plant";
      if (t.slab) return "slab";
      if (!this.isLeaf(id) && (t.tags.includes("transparent") || /glass/.test(t.id))) return "glass";
      return "solid";
    }

    // ── Shapes ───────────────────────────────────────────────────────────────────────────────────────────────────

    /** The shapes a tile can be placed with, as the game allows them — the order F cycles through. */
    shapeOptions(id) {
      const tile = this.get(id);
      const options = [[0, "Normal"]];
      if (!tile || tile.parts) return options;
      if (tile.slab) {
        options.push([SHAPE.UPPER, "Losa arriba"], [SHAPE.DOUBLE, "Losa doble"]);
        if (tile.verticalId) options.push([SHAPE.VERTICAL, "Losa vertical"], [SHAPE.VERTICAL | SHAPE.DOUBLE, "Vertical doble"]);
      } else {
        if (tile.wallId) options.push([SHAPE.WALL, "En pared"]);
        if (tile.horizontalId) options.push([SHAPE.HORIZONTAL, "Acostado"]);
      }
      if (tile.rotatableVertical) options.push([SHAPE.UPPER, "Invertida"]);
      return options;
    }

    shapeName(id, shape) { return this.shapeOptions(id).find(([v]) => v === shape)?.[1] ?? "Normal"; }

    /** Whether a placed cell keeps a facing: a rotatable or multi-cell piece, or a shape that looks one way. */
    turns(id, shape = 0) {
      const p = this.pieceOf(id);
      return !!p && (p.rotatable || !!p.parts) || shapeKeepsFacing(shape);
    }

    /** Templates saved before wall art hung the torch with the lying-log flag; the game reads that as the wall shape. */
    templateShape(id, shape) {
      const t = this.get(id);
      return shape === SHAPE.HORIZONTAL && t?.wallId && !t.horizontalId ? SHAPE.WALL : shape;
    }

    // ── Art ──────────────────────────────────────────────────────────────────────────────────────────────────────

    /** Decodes the sheets of these tiles (all, when ids is omitted). */
    async ensure(ids) {
      const keys = new Set();
      for (const id of ids ?? this.tiles.keys()) {
        const t = this.get(id);
        if (!t) continue;
        keys.add(t.sheet);
        for (const sib of [t.backId, t.invertedId, t.verticalId, t.horizontalId, t.wallId, ...(t.parts ?? []).map((p) => p.id)])
          if (sib) keys.add(this.get(sib)?.sheet);
      }
      await Promise.all([...keys].filter(Boolean).map((k) => this.#sheet(k)));
    }

    /** The tile's final pixels as a canvas (null without art): foliage = [r, g, b] for the biome_tinted grey. */
    sprite(id, foliage = DEFAULT_FOLIAGE) {
      const tile = this.get(id);
      if (!tile?.coord || tile.id === AIR) return null;
      const key = tile.id + "|" + foliage.join(",");
      if (this.#sprites.has(key)) return this.#sprites.get(key);
      const sheet = this.#sheets.get(tile.sheet);
      if (!sheet) return null;           // not decoded yet: not cached, asked again next frame
      const c = new OffscreenCanvas(tile.tw, tile.th);
      const g = c.getContext("2d");
      g.drawImage(sheet, tile.coord[0] * tile.tw, tile.coord[1] * tile.th, tile.tw, tile.th, 0, 0, tile.tw, tile.th);
      const tinted = tile.tags.includes("biome_tinted");
      if (tinted || tile.tint) {
        const data = g.getImageData(0, 0, tile.tw, tile.th);
        tintPixels(data.data, tile.tint, tinted ? foliage : null);
        g.putImageData(data, 0, 0);
      }
      this.#sprites.set(key, c);
      return c;
    }

    /** [r, g, b] 0..255 averaged over the opaque pixels: the whole sprite, or its top half (a block's lit top). */
    color(id, foliage = DEFAULT_FOLIAGE, topHalf = false) {
      const key = short(id) + "|" + foliage.join(",") + "|" + topHalf;
      if (this.#colors.has(key)) return this.#colors.get(key);
      const img = this.sprite(id, foliage);
      if (!img) return null;
      const d = img.getContext("2d").getImageData(0, 0, img.width, img.height).data;
      const rows = topHalf ? Math.ceil(img.height / 2) : img.height;
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          if (d[i + 3] < 128) continue;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
      const out = n ? [r / n, g / n, b / n] : null;
      this.#colors.set(key, out);
      return out;
    }

    #sheet(key) {
      if (this.#sheets.has(key)) return Promise.resolve(this.#sheets.get(key));
      // Asked again while it decodes (the palette and a view at once): the same decode, not a second one.
      if (this.#loading.has(key)) return this.#loading.get(key);
      const promise = (async () => {
        const atlas = this.project?.atlases.find((a) => T.sheetKey(a.id) === key);
        const png = atlas?.png ?? this.project?.filter((e) => e.lower.endsWith(".png") && e.name.toLowerCase() === key + ".png")[0] ?? null;
        if (!png) { this.errors.push(`No encuentro el PNG de la hoja «${key}».`); return null; }
        const img = await decodePng(await png.handle.getFile());
        const c = new OffscreenCanvas(img.w, img.h);
        c.getContext("2d").putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
        return c;
      })().catch((err) => { this.errors.push(`No pude leer la hoja «${key}»: ${err.message}`); return null; })
        .then((c) => { this.#sheets.set(key, c); this.#loading.delete(key); return c; });
      this.#loading.set(key, promise);
      return promise;
    }

    // ── Registration (TileInfo.Load) ───────────────────────────────────────────────────────────────────────────

    #add(tile) {
      if (this.tiles.has(tile.id)) this.errors.push(`Id repetido: ${tile.id}`);
      this.tiles.set(tile.id, tile);
    }

    #entry(o, ctx) {
      const id = short(o.id ?? deriveIdPath(o.name));
      const tags = (Array.isArray(o.tags) ? o.tags : []).map((t) => String(t).toLowerCase());
      const shared = {
        category: ctx.category, tags, sheet: o.sheetId ? T.sheetKey(o.sheetId) : ctx.sheet, tw: ctx.tw, th: ctx.th,
        liquid: String(o.type ?? "").toLowerCase() === "liquid", file: ctx.file,
      };
      const tile = {
        ...shared, id, name: o.name ?? id, coord: coordOf(o.tileCoord), tint: null, inPalette: true,
        rotatable: o.rotatable === true,
        slab: tags.includes("slab"),
        rotatableVertical: o.rotatableVertical === true || Array.isArray(o.invertedCoord),
      };
      const cells = new Map([[id, tile]]);

      // The anchor cell takes its coord from its parts entry, as in TileInfo.NormalizeParts / GeneratePartTiles.
      if (Array.isArray(o.parts) && o.parts.length) {
        const anchorPart = o.parts.find((p) => !(p.offsetX | 0) && !(p.offsetY | 0) && !(p.offsetZ | 0));
        if (anchorPart) tile.coord = coordOf(anchorPart.tileCoord);
        if (o.parts.length > 1) {
          tile.parts = [];
          for (const p of o.parts) {
            const dx = p.offsetX | 0, dy = p.offsetY | 0, dz = p.offsetZ | 0;
            if (!dx && !dy && !dz) { tile.parts.push({ dx, dy, dz, id }); continue; }
            const cellId = partId(id, dx, dy, dz);
            const cell = { ...shared, id: cellId, name: `${tile.name} (${dx},${dy},${dz})`, coord: coordOf(p.tileCoord), tint: null,
              inPalette: false, anchor: { id, dx: -dx, dy: -dy, dz: -dz } };
            this.#add(cell);
            cells.set(cellId, cell);
            tile.parts.push({ dx, dy, dz, id: cellId });
          }
        }
      }

      this.#add(tile);
      this.#swapPartners(tile, cells);
      this.#backTiles(o, tile, cells, shared);
      if (!o.parts || o.parts.length <= 1) this.#shapeArt(o, tile, shared);

      for (const flow of Array.isArray(o.flow) ? o.flow : [])
        this.#add({ ...shared, id: short(flow.id ?? deriveIdPath(flow.name ?? "")), name: flow.name, coord: coordOf(flow.tileCoord), tint: null, inPalette: false });

      for (const v of Array.isArray(o.colorVariants) ? o.colorVariants : [])
        this.#add({ ...shared, id: short(v.id ?? deriveIdPath(v.name ?? "")), name: v.name, coord: tile.coord, tint: hexRgb(v.color), inPalette: true });
    }

    // WorldQuery.ResolveIds: a rotatable two-cell horizontal piece lets each half draw the other's art when the camera
    // puts the second cell above the anchor on screen.
    #swapPartners(tile, cells) {
      if (!tile.rotatable || tile.parts?.length !== 2) return;
      const second = tile.parts.find((p) => p.dx || p.dy || p.dz);
      if (!tile.parts.some((p) => !p.dx && !p.dy && !p.dz) || !second || second.dy !== 0) return;
      tile.swap = { partnerId: second.id, ox: second.dx, oz: second.dz };
      cells.get(second.id).swap = { partnerId: tile.id, ox: second.dx, oz: second.dz };
    }

    // TileInfo.GenerateBackTiles: "<cell>_back" drawn when a piece is seen from behind.
    #backTiles(o, tile, cells, shared) {
      let parts = Array.isArray(o.parts) && o.parts.length ? o.parts : null;
      if (!parts && Array.isArray(o.backCoord)) parts = [{ backCoord: o.backCoord }];
      for (const p of parts ?? []) {
        if (!Array.isArray(p.backCoord)) continue;
        const dx = p.offsetX | 0, dy = p.offsetY | 0, dz = p.offsetZ | 0;
        const cell = !dx && !dy && !dz ? tile : cells.get(partId(tile.id, dx, dy, dz));
        if (!cell) continue;
        const back = { ...shared, id: `${cell.id}_back`, name: `${cell.name} (detrás)`, coord: coordOf(p.backCoord), tint: null, inPalette: false };
        this.#add(back);
        cell.backId = back.id;
      }
    }

    // TileInfo.GenerateShapeArtTiles: render-only siblings for the other shapes a single-cell piece can take.
    #shapeArt(o, tile, shared) {
      const pair = (suffix, label, front, back) => {
        if (!Array.isArray(front)) return null;
        const art = { ...shared, id: tile.id + suffix, name: `${tile.name} (${label})`, coord: coordOf(front), tint: null, inPalette: false };
        this.#add(art);
        if (Array.isArray(back)) {
          const b = { ...art, id: art.id + "_back", name: `${art.name} detrás`, coord: coordOf(back) };
          this.#add(b);
          art.backId = b.id;
        }
        return art.id;
      };
      tile.invertedId = pair("_inverted", "invertida", o.invertedCoord, o.invertedBackCoord);
      tile.verticalId = pair("_vertical", "vertical", o.verticalCoord, o.verticalBackCoord);
      tile.horizontalId = pair("_horizontal", "acostado", o.horizontalCoord, o.horizontalBackCoord);
      tile.wallId = pair("_wall", "en pared", o.wallCoord, o.wallBackCoord);
    }
  }

  const shapeKeepsFacing = (shape) => (shape & (SHAPE.VERTICAL | SHAPE.HORIZONTAL | SHAPE.WALL)) !== 0;

  // TileArt.Read: "art" on the tile, its parts, flows and the double chest's parts, read into the per-state keys. A file
  // still on the old keys whose placement allows walls hangs from its horizontalCoord (the torch): that is its wall art.
  function normalizeArt(o) {
    const owners = [o, ...(Array.isArray(o.parts) ? o.parts : []), ...(Array.isArray(o.flow) ? o.flow : []),
      ...(Array.isArray(o.storage?.double?.parts) ? o.storage.double.parts : [])];
    const usedArt = owners.some((p) => p && typeof p.art === "object");
    for (const p of owners) if (p && typeof p === "object") expandArt(p);
    const attach = o.placement?.attach;
    const allowsWall = !!o.placement && (!Array.isArray(attach) || attach.some((a) => String(a).toLowerCase() === "wall"));
    if (!usedArt && allowsWall && Array.isArray(o.horizontalCoord) && !Array.isArray(o.wallCoord)) {
      o.wallCoord = o.horizontalCoord;
      delete o.horizontalCoord;
    }
  }

  function expandArt(obj) {
    const art = obj.art;
    if (!art || typeof art !== "object" || Array.isArray(art)) return;
    const byState = new Map(Object.entries(art).map(([k, v]) => [k.toLowerCase(), v]));
    for (const s of ART_STATES) {
      const frame = byState.get(s.state);
      if (!frame) continue;
      const front = Array.isArray(frame) ? frame : frame.front;
      const back = Array.isArray(frame) ? null : frame.back;
      if (front) obj[s.front] = front;
      if (back) obj[s.back] = back;
    }
    delete obj.art;
  }

  // storage.double as TileInfo.ParseStorage reads it: { parts } gives the double its own art, true reuses the single art for
  // both halves, a string names a hand-made tile that is already its own entry.
  function doubleStorage(o) {
    const d = o.storage?.double;
    if (!d || typeof d === "string") return null;
    const baseId = o.id ?? deriveIdPath(o.name);
    let parts = d.parts;
    if (!Array.isArray(parts)) {
      const anchor = Array.isArray(o.parts) ? o.parts.find((p) => !(p.offsetX | 0) && !(p.offsetY | 0) && !(p.offsetZ | 0)) : null;
      parts = [0, 1].map((offsetX) => ({ offsetX, tileCoord: anchor?.tileCoord ?? o.tileCoord, backCoord: anchor?.backCoord ?? o.backCoord }));
    }
    return { id: `${baseId}_double`, name: `${o.name ?? baseId} (doble)`, tags: o.tags, sheetId: o.sheetId, type: o.type, rotatable: true, parts };
  }

  // Chunk.DefaultFoliageTint — the green a biome_tinted tile shows with no biome.
  const DEFAULT_FOLIAGE = [92, 227, 101];

  // The colour-variant multiply, then the biome tint on the low-saturation texels (TileInstanced.fx's mask: fading out between
  // 0.05 and 0.20 HSV saturation, so painted details keep their own colour).
  function tintPixels(px, tint, foliage) {
    const smooth = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      const max = Math.max(px[i], px[i + 1], px[i + 2]), min = Math.min(px[i], px[i + 1], px[i + 2]);
      const mask = foliage ? 1 - smooth(0.05, 0.2, max > 0 ? (max - min) / max : 0) : 0;
      if (tint) for (let c = 0; c < 3; c++) px[i + c] = px[i + c] * tint[c] / 255;
      if (mask > 0) for (let c = 0; c < 3; c++) px[i + c] = px[i + c] * (1 - mask + mask * foliage[c] / 255);
    }
  }

  Aura.structTiles = { TileRegistry, SHAPE, AIR, CELL, DEFAULT_FOLIAGE, short, shapeKeepsFacing, partId };
})(window.Aura ??= {});
