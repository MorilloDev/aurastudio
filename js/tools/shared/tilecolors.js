"use strict";

// Tiles as the 3D views need them: what each tile id is (a block, a plant, water, glass, a slab — what the scene builder
// and the renderer ask) and one flat colour per tile, the average of its sprite's opaque pixels (of the top half for
// blocks, where the lit top is), in a biome's foliage colour when the tile is biome_tinted. Sheets are decoded once.
(function (Aura) {
  const T = Aura.atlasTiles;
  const Tint = Aura.tint;
  const { decodePng } = Aura.png;

  const MISSING = [0.8, 0.3, 0.8, 1];      // a tile no tile file defines: loud on purpose
  const WATER = [0.2, 0.45, 0.77, 0.6];

  class TileColors {
    #tiles = new Map();      // qualified id -> { tile, doc, sheet, coord, tw, th, tinted, habitat, tags, category }
    #sheets = new Map();     // sheet key -> { promise, value }
    #colors = new Map();

    constructor(project, tileDocs) {
      this.project = project;
      for (const doc of tileDocs) {
        if (!doc.root) continue;
        const [tw, th] = T.docCell(doc);
        for (const tile of doc.root.tiles) {
          if (!tile || (!tile.id && !tile.name)) continue;
          const front = (o) => {
            const f = o?.art?.default ?? o?.art?.Default;
            return T.isCoord(f) ? f : T.isCoord(f?.front) ? f.front : null;
          };
          const coord = front(tile) ?? (Array.isArray(tile.parts) ? tile.parts.map(front).find(Boolean) : null) ?? null;
          const tags = (Array.isArray(tile.tags) ? tile.tags : []).map((t) => String(t).toLowerCase());
          this.#tiles.set(T.tileId(tile), {
            tile, doc, sheet: T.docSheet(doc, tile), coord, tw, th, tags,
            tinted: tags.includes("biome_tinted"),
            habitat: String(tile.habitat ?? "land").toLowerCase(),
            category: String(doc.root?.category ?? "").toLowerCase(),
          });
        }
      }
    }

    get ids() { return [...this.#tiles.keys()]; }

    info(ref) {
      if (!ref) return null;
      const id = String(ref).includes(":") ? String(ref) : "aura:" + ref;
      return this.#tiles.get(id) ?? null;
    }

    /** What the scene builder asks about a tile (Aura.biomeScene.buildScene / buildPreview). Null when it does not exist. */
    kindInfo = (id) => {
      const t = this.info(id);
      if (!t) return null;
      const leafy = t.tags.includes("leaf") || /leaves|leaf/.test(id);
      return {
        liquid: t.tags.includes("liquid") || String(t.tile.type ?? "").toLowerCase() === "liquid",
        plant: t.category === "foliage" || t.tags.includes("no_collision") || t.tags.includes("tiny"),
        slab: t.tags.includes("slab"),
        glass: !leafy && (t.tags.includes("transparent") || /glass/.test(id)),
        habitat: t.habitat,
      };
    };

    /** Decodes the sheets these tiles are drawn from. */
    async ensure(ids) {
      const keys = new Set();
      for (const id of ids) {
        const t = this.info(id);
        if (t) keys.add(t.sheet);
      }
      await Promise.all([...keys].map((k) => this.#sheet(k)));
    }

    /** [r, g, b, a] 0..1 for a scene palette entry { id, kind }; foliage = [r, g, b] 0..255 for biome_tinted tiles. */
    color(p, foliage) {
      const K = Aura.biomeScene.KIND;
      const key = p.id + "|" + p.kind + "|" + (foliage ?? []).join(",");
      if (this.#colors.has(key)) return this.#colors.get(key);
      const t = this.info(p.id);
      let rgba = p.kind === K.water ? WATER : MISSING;
      const sheet = t && this.#sheets.get(t.sheet)?.value;
      if (t?.coord && sheet) {
        const { tw, th } = t;
        const c = new OffscreenCanvas(tw, th);
        const g = c.getContext("2d");
        g.drawImage(sheet, t.coord[0] * tw, t.coord[1] * th, tw, th, 0, 0, tw, th);
        let d = g.getImageData(0, 0, tw, th).data;
        if (t.tinted && foliage) d = Tint.applyTint(d, foliage);
        const rows = p.kind === K.plant ? th : Math.ceil(th / 2);
        let r = 0, gr = 0, b = 0, n = 0;
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < tw; x++) {
            const i = (y * tw + x) * 4;
            if (d[i + 3] < 128) continue;
            r += d[i]; gr += d[i + 1]; b += d[i + 2]; n++;
          }
        if (n) rgba = [r / n / 255, gr / n / 255, b / n / 255, p.kind === K.water ? 0.6 : p.kind === K.glass ? 0.45 : 1];
      } else if (t) {
        // The tile exists but its sheet could not be read: a quiet colour from its id, so the shape still reads.
        let n = 0;
        for (const ch of p.id) n = (n * 31 + ch.charCodeAt(0)) | 0;
        const hue = ((n >>> 0) % 360) / 360;
        rgba = [0.45 + 0.2 * Math.cos(hue * 6.28), 0.45 + 0.2 * Math.cos((hue + 0.33) * 6.28), 0.45 + 0.2 * Math.cos((hue + 0.66) * 6.28), 1];
      }
      this.#colors.set(key, rgba);
      return rgba;
    }

    // The sheet's pixels, by its atlases.json id; failing that a png named like the sheet ("dirt" → Dirt.png).
    #sheet(key) {
      if (this.#sheets.has(key)) return this.#sheets.get(key).promise;
      const slot = { value: null };
      slot.promise = (async () => {
        const atlas = this.project?.atlases.find((a) => T.sheetKey(a.id) === key);
        const png = atlas?.png ?? this.project?.filter((e) => e.lower.endsWith(".png") && e.name.toLowerCase() === key + ".png")[0] ?? null;
        if (!png) return null;
        const img = await decodePng(await png.handle.getFile());
        const c = new OffscreenCanvas(img.w, img.h);
        c.getContext("2d").putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
        return (slot.value = c);
      })().catch(() => null);
      this.#sheets.set(key, slot);
      return slot.promise;
    }
  }

  Aura.tileColors = { TileColors };
})(window.Aura ??= {});
