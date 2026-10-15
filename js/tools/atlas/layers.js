"use strict";

// A tile sheet and its companion maps held as pixels, so every edit of the Atlas tool happens to all of them at once: a
// cell moved in the colour sheet takes its _n (shape normals), _d (detail normals) and the normals tool's _faces /
// _height with it, and the maps can never drift out of line with the sprites.
(function (Aura) {
  const { decodePng, encodePng } = Aura.png;
  const { dirName, joinPath, stripExt, writeInDir } = Aura.fs;
  const { companionPath } = Aura.sheetFiles;

  // What each companion is, for the view buttons and messages. NormalMapLoader reads _n and _d; _faces and _height are
  // inputs the old normals tool kept beside the sheet, moved along so they still match if anyone uses them.
  const COMPANIONS = [
    ["_n", "_n", "Normales de forma (_n)"],
    ["_d", "_d", "Normales de detalle (_d)"],
    ["_faces", "_faces", "Caras pintadas (_faces)"],
    ["_height", "_height", "Altura pintada (_height)"],
  ];

  class SheetImage {
    /** sheet: an entry of sheetFiles.listSheets. Call load() before use. */
    constructor(sheet) {
      this.sheet = sheet;
      this.layers = new Map();   // "" (colour) | "_n" | "_d" | … -> layer
      this.warnings = [];
    }

    get color() { return this.layers.get(""); }
    get w() { return this.color.w; }
    get h() { return this.color.h; }

    async load(project) {
      const colorFile = await this.sheet.entry.handle.getFile();
      const color = await decodePng(colorFile);
      this.#add("", color, this.sheet.entry, colorFile.lastModified);
      for (const [suffix] of COMPANIONS) {
        const entry = project.get(companionPath(this.sheet.path, suffix));
        if (!entry) continue;
        const file = await entry.handle.getFile();
        let img = await decodePng(file);
        if (img.w !== color.w || img.h !== color.h) {
          // A map of another size would put every normal on the wrong pixel; it is laid on a canvas of the sheet's size
          // from the top-left, which is how it was drawn.
          this.warnings.push(`${suffix}.png mide ${img.w}×${img.h} y la hoja ${color.w}×${color.h}: lo ajusto a la hoja al guardar.`);
          img = resized(img, color.w, color.h);
        }
        this.#add(suffix, img, entry, file.lastModified);
      }
      return this;
    }

    // stamp: the file's lastModified when read (0 = no file yet), to notice another program writing it meanwhile.
    #add(suffix, img, entry, stamp) {
      const exists = stamp > 0;
      this.layers.set(suffix, {
        suffix, entry, exists, stamp, w: img.w, h: img.h, rgba: img.rgba,
        baseline: exists ? { w: img.w, h: img.h, rgba: new Uint8ClampedArray(img.rgba) } : null,
        canvas: null, stale: true,
      });
    }

    has(suffix) { return this.layers.has(suffix); }

    /** Adds an empty companion (a sheet that gets its first normal map). Returns true when it was created. */
    ensure(suffix) {
      if (this.layers.has(suffix)) return false;
      this.#add(suffix, { w: this.w, h: this.h, rgba: new Uint8ClampedArray(this.w * this.h * 4) }, null, 0);
      return true;
    }

    drop(suffix) { this.layers.delete(suffix); }

    // -----------------------------------------------------------------------------------------------------------------
    // Pixels

    read(layer, x, y, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        const sy = y + row;
        if (sy < 0 || sy >= layer.h) continue;
        const x0 = Math.max(0, x), x1 = Math.min(layer.w, x + w);
        if (x1 <= x0) continue;
        out.set(layer.rgba.subarray((sy * layer.w + x0) * 4, (sy * layer.w + x1) * 4), (row * w + (x0 - x)) * 4);
      }
      return out;
    }

    write(layer, x, y, w, h, data) {
      for (let row = 0; row < h; row++) {
        const dy = y + row;
        if (dy < 0 || dy >= layer.h) continue;
        const x0 = Math.max(0, x), x1 = Math.min(layer.w, x + w);
        if (x1 <= x0) continue;
        layer.rgba.set(data.subarray((row * w + (x0 - x)) * 4, (row * w + (x1 - x)) * 4), (dy * layer.w + x0) * 4);
      }
      layer.stale = true;
    }

    clear(layer, x, y, w, h) {
      this.write(layer, x, y, w, h, new Uint8ClampedArray(w * h * 4));
    }

    /** Whether any pixel of the colour sheet in the rectangle is visible. */
    hasArt(x, y, w, h) {
      const { rgba, w: W, h: H } = this.color;
      const x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
      for (let py = Math.max(0, y); py < y1; py++) {
        for (let px = Math.max(0, x); px < x1; px++) if (rgba[(py * W + px) * 4 + 3]) return true;
      }
      return false;
    }

    /** Every layer to newW × newH, keeping the top-left. Growing only adds transparent space; shrinking crops. */
    resize(newW, newH) {
      for (const layer of this.layers.values()) {
        const img = resized(layer, newW, newH);
        layer.w = img.w; layer.h = img.h; layer.rgba = img.rgba;
        layer.stale = true;
      }
    }

    /** An up-to-date canvas of the layer, for drawing. Refreshed only after the pixels changed. */
    canvasOf(suffix) {
      const layer = this.layers.get(suffix) ?? this.color;
      if (!layer.canvas || layer.canvas.width !== layer.w || layer.canvas.height !== layer.h) {
        layer.canvas = new OffscreenCanvas(layer.w, layer.h);
        layer.stale = true;
      }
      if (layer.stale) {
        layer.canvas.getContext("2d").putImageData(new ImageData(layer.rgba, layer.w, layer.h), 0, 0);
        layer.stale = false;
      }
      return layer.canvas;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Saving

    /** Names of the layer files another program (or another tab of the studio) wrote since they were read. */
    async changedOnDisk() {
      const out = [];
      for (const layer of this.layers.values()) {
        if (!layer.entry || !layer.stamp) continue;
        const file = await layer.entry.handle.getFile().catch(() => null);
        if (!file || file.lastModified !== layer.stamp) out.push(stripExt(this.sheet.name) + layer.suffix + ".png");
      }
      return out;
    }

    isLayerDirty(layer) {
      const b = layer.baseline;
      if (!b) return layer.rgba.some((v, i) => (i & 3) === 3 && v !== 0);
      if (b.w !== layer.w || b.h !== layer.h) return true;
      const a = layer.rgba, c = b.rgba;
      for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) return true;
      return false;
    }

    /**
     * Writes every changed layer next to the sheet. backups collects { name, path, previous } so the caller can offer
     * to put the files back. Returns the names written and the companions that did not exist before (for the mgcb).
     */
    async save(project, backups) {
      const dir = this.sheet.entry.dir, folder = dirName(this.sheet.path);
      const written = [], created = [];
      for (const layer of this.layers.values()) {
        if (!this.isLayerDirty(layer)) continue;
        const name = stripExt(this.sheet.name) + layer.suffix + ".png";
        const path = joinPath(folder, name);
        const existing = project.get(path);
        backups.push({ name, path, dir, previous: existing ? await existing.handle.getFile() : null });
        const handle = await writeInDir(dir, name, await encodePng(layer.w, layer.h, layer.rgba));
        layer.entry = project.addFile(path, handle, dir);
        layer.stamp = (await handle.getFile()).lastModified;
        if (!layer.exists) created.push(layer.suffix);
        layer.exists = true;
        layer.baseline = { w: layer.w, h: layer.h, rgba: new Uint8ClampedArray(layer.rgba) };
        written.push(name);
      }
      return { written, created };
    }
  }

  function resized(img, w, h) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    const cw = Math.min(w, img.w), ch = Math.min(h, img.h);
    for (let y = 0; y < ch; y++) rgba.set(img.rgba.subarray(y * img.w * 4, (y * img.w + cw) * 4), y * w * 4);
    return { w, h, rgba };
  }

  Aura.atlasLayers = { COMPANIONS, SheetImage };
})(window.Aura ??= {});
