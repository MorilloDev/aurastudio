"use strict";

// Composer: capas de sprites (Bloque/Planta) o formas. Cada capa vive en una celda multipart (offsetX/Y/Z);
// el shift solo mueve el tile DENTRO de esa celda (no sale del 0..size). Enviar al Atlas = mismo flujo que Bloque.
(function (Aura) {
  const { h } = Aura.dom;
  const { section, slider, select } = Aura.controls;
  const { encodePng } = Aura.png;
  const { downloadBlob } = Aura.fs;
  const { prefs } = Aura.storage;
  const E = Aura.blockEngine;
  const Sh = Aura.blockShapes;

  const BLENDS = [
    ["normal", "Normal"],
    ["multiply", "Multiplicar"],
    ["screen", "Pantalla"],
    ["overlay", "Superponer"],
    ["add", "Sumar"],
  ];

  const PREFS_KEY = "composer:doc";
  const QUEUE_KEY = "composer:queue";

  function defaultShapeLayer(i = 0) {
    return {
      id: "L" + Date.now().toString(36) + "_" + i,
      kind: "shape",
      name: "Forma " + (i + 1),
      visible: true,
      shape: "cube",
      params: { ...(Sh?.PARAM_DEFAULTS || {}) },
      offsetX: 0, offsetY: 0, offsetZ: 0,
      shiftX: 0, shiftY: 0,
      rot3d: { x: 0, y: 0, z: 0 },
      blend: "normal",
      opacity: 1,
      tint: null,
      size: 64,
      color: null,
      source: null,
    };
  }

  function spriteLayerFromResult(result, meta = {}) {
    const size = result.size || result.w || 64;
    return {
      id: "L" + Date.now().toString(36),
      kind: "sprite",
      name: meta.name || meta.source || "Sprite",
      visible: true,
      offsetX: meta.offsetX || 0,
      offsetY: meta.offsetY || 0,
      offsetZ: meta.offsetZ || 0,
      shiftX: 0, shiftY: 0,
      blend: "normal",
      opacity: 1,
      tint: null,
      size,
      w: result.w || size,
      h: result.h || size,
      color: result.color ? new Uint8ClampedArray(result.color) : null,
      normal: result.normal ? new Uint8ClampedArray(result.normal) : null,
      source: meta.source || "sprite",
      shape: null,
      params: {},
      rot3d: { x: 0, y: 0, z: 0 },
    };
  }

  function defaultDoc() {
    return { size: 64, layers: [defaultShapeLayer(0)], selected: 0 };
  }

  /** Bounding box of opaque pixels (alpha > 0). null if empty. */
  function opaqueBounds(rgba, size) {
    let minX = size, minY = size, maxX = -1, maxY = -1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (rgba[(y * size + x) * 4 + 3] < 1) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { minX, minY, maxX, maxY };
  }

  /**
   * Shift allowed so opaque content stays inside the cell [0, size).
   * Full-cell art → only (0,0). Content smaller can slide until it hits the wall.
   */
  function clampShift(rgba, size, sx, sy) {
    if (!rgba) return { x: 0, y: 0 };
    const b = opaqueBounds(rgba, size);
    if (!b) return { x: 0, y: 0 };
    const minSx = -b.minX;
    const maxSx = size - 1 - b.maxX;
    const minSy = -b.minY;
    const maxSy = size - 1 - b.maxY;
    return {
      x: Math.max(minSx, Math.min(maxSx, Math.round(sx))),
      y: Math.max(minSy, Math.min(maxSy, Math.round(sy))),
      minSx, maxSx, minSy, maxSy,
    };
  }

  function applyTint(rgba, hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return rgba;
    const v = parseInt(m[1], 16);
    const tr = (v >> 16) & 255, tg = (v >> 8) & 255, tb = v & 255;
    const out = new Uint8ClampedArray(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      out[i] = (rgba[i] * tr) / 255;
      out[i + 1] = (rgba[i + 1] * tg) / 255;
      out[i + 2] = (rgba[i + 2] * tb) / 255;
      out[i + 3] = rgba[i + 3];
    }
    return out;
  }

  function blendPixel(dst, src, mode, opacity) {
    if (src[3] < 1) return;
    const a = (src[3] / 255) * opacity;
    if (a <= 0) return;
    const inv = 1 - a;
    let r = src[0], g = src[1], b = src[2];
    if (mode === "multiply") {
      r = (dst[0] * r) / 255; g = (dst[1] * g) / 255; b = (dst[2] * b) / 255;
    } else if (mode === "screen") {
      r = 255 - ((255 - dst[0]) * (255 - r)) / 255;
      g = 255 - ((255 - dst[1]) * (255 - g)) / 255;
      b = 255 - ((255 - dst[2]) * (255 - b)) / 255;
    } else if (mode === "overlay") {
      const ov = (d, s) => d < 128 ? (2 * d * s) / 255 : 255 - (2 * (255 - d) * (255 - s)) / 255;
      r = ov(dst[0], r); g = ov(dst[1], g); b = ov(dst[2], b);
    } else if (mode === "add") {
      r = Math.min(255, dst[0] + r); g = Math.min(255, dst[1] + g); b = Math.min(255, dst[2] + b);
    }
    dst[0] = Math.round(dst[0] * inv + r * a);
    dst[1] = Math.round(dst[1] * inv + g * a);
    dst[2] = Math.round(dst[2] * inv + b * a);
    dst[3] = Math.min(255, Math.round(dst[3] + (255 - dst[3]) * a));
  }

  /** Dibuja rgba fuente en dest con offset de pixel (shift), sin salir del dest size. */
  function blitShifted(dest, destSize, src, srcSize, shiftX, shiftY, blend, opacity) {
    for (let y = 0; y < srcSize; y++) {
      for (let x = 0; x < srcSize; x++) {
        const si = (y * srcSize + x) * 4;
        if (src[si + 3] < 1) continue;
        const dx = x + shiftX;
        const dy = y + shiftY;
        if (dx < 0 || dy < 0 || dx >= destSize || dy >= destSize) continue;
        const di = (dy * destSize + dx) * 4;
        const d = [dest[di], dest[di + 1], dest[di + 2], dest[di + 3]];
        const s = [src[si], src[si + 1], src[si + 2], src[si + 3]];
        blendPixel(d, s, blend || "normal", opacity ?? 1);
        dest[di] = d[0]; dest[di + 1] = d[1]; dest[di + 2] = d[2]; dest[di + 3] = d[3];
      }
    }
  }

  function composerTool() {
    return new ComposerTool();
  }

  class ComposerTool {
    id = "composer";
    title = "Composer";
    project = null;
    doc = defaultDoc();
    dirty = false;
    preview = null;
    cellCanvases = new Map(); // "ox,oy,oz" -> { size, color, normal? }

    mount(host, studio) {
      this.studio = studio;
      try {
        const raw = prefs.get(PREFS_KEY, null);
        if (raw) {
          this.doc = {
            ...defaultDoc(),
            ...raw,
            layers: (raw.layers || []).map((l) => {
              const base = l.kind === "sprite"
                ? spriteLayerFromResult({ size: l.size || 64, color: null }, l)
                : defaultShapeLayer();
              return { ...base, ...l, color: null, normal: null };
            }),
          };
        }
      } catch { /* ignore */ }

      this.canvas = h("canvas", { class: "cp-preview" });
      this.layerList = h("div", { class: "cp-layers" });
      this.propsHost = h("div", { class: "cp-props" });
      this.shiftHint = h("p", { class: "note" });

      const toolbar = h("div", { class: "cp-toolbar" },
        h("button", { class: "primary", onclick: () => this.addShapeLayer() }, "+ Forma"),
        h("button", { onclick: () => this.duplicateLayer() }, "Duplicar"),
        h("button", { onclick: () => this.removeLayer() }, "Quitar"),
        h("span", { class: "grow" }),
        h("button", { onclick: () => this.exportPng() }, "Exportar PNG"),
        h("button", { onclick: () => this.exportMultipart() }, "JSON multipart"),
        h("button", { class: "primary", onclick: () => this.sendToAtlas() }, "Enviar al Atlas \u2192"),
      );

      host.appendChild(h("div", { class: "cp" },
        h("div", { class: "cp-side" },
          h("div", { class: "cp-side-head" }, h("b", null, "Capas"), h("span", { class: "hint" }, "arriba = delante")),
          this.layerList,
          h("div", { class: "cp-side-head" }, h("b", null, "Pieza activa")),
          this.propsHost),
        h("div", { class: "cp-stage" },
          toolbar,
          h("div", { class: "cp-view" }, this.canvas),
          h("p", { class: "hint cp-hint" },
            "Offset X/Y/Z = celda multipart. Shift mueve el tile ", h("b", null, "solo dentro de esa celda"),
            ". En Bloque/Planta: \u00abA\u00f1adir al Composer\u00bb."))));

      this.drainQueue();
      this.rebuildLayerList();
      this.rebuildProps();
      this.schedule();

      Aura.composerBridge = {
        pushResult: (result, meta) => this.pushResult(result, meta),
      };
    }

    activate() {
      this.drainQueue();
      this.schedule();
    }
    deactivate() {}
    onProject(project) { this.project = project; }
    isDirty() { return this.dirty; }

    pushResult(result, meta = {}) {
      if (!result?.color) {
        this.studio?.toast("No hay preview para a\u00f1adir", { kind: "warn" });
        return;
      }
      const layer = spriteLayerFromResult(result, meta);
      this.doc.layers.push(layer);
      this.doc.selected = this.doc.layers.length - 1;
      if (result.size) this.doc.size = Math.max(this.doc.size, result.size);
      this.dirty = true;
      this.savePrefsMeta();
      this.rebuildLayerList();
      this.rebuildProps();
      this.schedule();
      this.studio?.toast("Capa \u00ab" + layer.name + "\u00bb a\u00f1adida", { kind: "ok" });
    }

    drainQueue() {
      try {
        const q = prefs.get(QUEUE_KEY, []);
        if (!Array.isArray(q) || !q.length) return;
        prefs.set(QUEUE_KEY, []);
        for (const item of q) {
          if (!item?.color) continue;
          this.pushResult({
            size: item.size || 64,
            color: new Uint8ClampedArray(item.color),
            normal: item.normal ? new Uint8ClampedArray(item.normal) : null,
            w: item.w, h: item.h,
          }, item.meta || {});
        }
      } catch { /* ignore */ }
    }

    savePrefsMeta() {
      prefs.set(PREFS_KEY, {
        size: this.doc.size,
        selected: this.doc.selected,
        layers: this.doc.layers.map((l) => ({
          id: l.id, kind: l.kind, name: l.name, visible: l.visible,
          offsetX: l.offsetX, offsetY: l.offsetY, offsetZ: l.offsetZ,
          shiftX: l.shiftX, shiftY: l.shiftY,
          blend: l.blend, opacity: l.opacity, tint: l.tint,
          shape: l.shape, params: l.params, rot3d: l.rot3d,
          size: l.size, source: l.source,
        })),
      });
    }

    selected() {
      const i = Math.max(0, Math.min(this.doc.selected, this.doc.layers.length - 1));
      this.doc.selected = i;
      return this.doc.layers[i];
    }

    addShapeLayer() {
      this.doc.layers.push(defaultShapeLayer(this.doc.layers.length));
      this.doc.selected = this.doc.layers.length - 1;
      this.rebuildLayerList();
      this.rebuildProps();
      this.savePrefsMeta();
      this.schedule();
    }

    duplicateLayer() {
      const src = this.selected();
      if (!src) return;
      const copy = {
        ...structuredClone({ ...src, color: null, normal: null }),
        id: "L" + Date.now().toString(36),
        name: (src.name || "Pieza") + " copia",
        color: src.color ? new Uint8ClampedArray(src.color) : null,
        normal: src.normal ? new Uint8ClampedArray(src.normal) : null,
      };
      this.doc.layers.splice(this.doc.selected + 1, 0, copy);
      this.doc.selected++;
      this.rebuildLayerList();
      this.rebuildProps();
      this.savePrefsMeta();
      this.schedule();
    }

    removeLayer() {
      if (this.doc.layers.length <= 1) {
        this.studio?.toast("Deja al menos una capa", { kind: "warn" });
        return;
      }
      this.doc.layers.splice(this.doc.selected, 1);
      this.doc.selected = Math.min(this.doc.selected, this.doc.layers.length - 1);
      this.rebuildLayerList();
      this.rebuildProps();
      this.savePrefsMeta();
      this.schedule();
    }

    rebuildLayerList() {
      this.layerList.replaceChildren();
      const order = this.doc.layers.map((_, i) => i).reverse();
      for (const i of order) {
        const L = this.doc.layers[i];
        const row = h("div", {
          class: ["cp-layer", i === this.doc.selected && "active"],
          onclick: () => { this.doc.selected = i; this.rebuildLayerList(); this.rebuildProps(); },
        },
          h("input", {
            type: "checkbox", checked: L.visible || null,
            onclick: (e) => e.stopPropagation(),
            onchange: (e) => { L.visible = e.target.checked; this.savePrefsMeta(); this.schedule(); },
          }),
          h("span", { class: "cp-layer-name" }, L.name || "Pieza"),
          h("span", { class: "mono faint", title: "Celda multipart" }, L.offsetX + "," + L.offsetY + "," + L.offsetZ),
          h("button", { title: "Subir (delante)", onclick: (e) => { e.stopPropagation(); this.moveLayer(i, 1); } }, "\u2191"),
          h("button", { title: "Bajar (atr\u00e1s)", onclick: (e) => { e.stopPropagation(); this.moveLayer(i, -1); } }, "\u2193"));
        this.layerList.appendChild(row);
      }
    }

    moveLayer(i, dir) {
      const j = i + dir;
      if (j < 0 || j >= this.doc.layers.length) return;
      const arr = this.doc.layers;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      this.doc.selected = j;
      this.rebuildLayerList();
      this.savePrefsMeta();
      this.schedule();
    }

    /** Source RGBA for a layer (sprite or rendered shape), same size as layer.size. */
    layerSourceRgba(L) {
      if (L.kind === "sprite") {
        if (!L.color) return null;
        return { size: L.size || this.doc.size, color: L.color, normal: L.normal };
      }
      try {
        const def = Sh.SHAPES[L.shape] ?? Sh.SHAPES.cube;
        let boxes;
        try {
          const params = { ...Sh.PARAM_DEFAULTS, ...(L.params || {}) };
          boxes = def.boxes ? def.boxes(params) : [{ min: [0, 0, 0], max: [1, 1, 1] }];
          if (params.scale != null && params.scale !== 1 && Sh.scaleBoxes) boxes = Sh.scaleBoxes(boxes, params.scale);
        } catch {
          boxes = Sh.SHAPES.cube.boxes();
        }
        const piece = { boxes, state: "default", facing: "front", rot3d: { ...(L.rot3d || {}) } };
        const solid = (rgb) => {
          const S = 16, rgba = new Uint8ClampedArray(S * S * 4);
          for (let i = 0; i < S * S; i++) {
            rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255;
          }
          return { w: S, h: S, rgba };
        };
        const tex = { top: solid([160, 160, 155]), left: solid([120, 120, 118]), right: solid([100, 100, 98]) };
        const r = E.render(E.merge({ size: L.size || this.doc.size, shading: true }), tex, piece);
        return { size: r.size, color: r.color, normal: r.normal };
      } catch (err) {
        console.warn(err);
        return null;
      }
    }

    rebuildProps() {
      const L = this.selected();
      if (!L) return;
      const set = (fn) => { fn(); this.savePrefsMeta(); this.schedule(); this.rebuildLayerList(); };

      // Limits of shift for this layer (from current source).
      const src = this.layerSourceRgba(L);
      const size = L.size || this.doc.size;
      let lim = { minSx: 0, maxSx: 0, minSy: 0, maxSy: 0 };
      if (src?.color) {
        const c = clampShift(src.color, size, L.shiftX || 0, L.shiftY || 0);
        lim = c;
        L.shiftX = c.x;
        L.shiftY = c.y;
      }

      const kids = [];
      kids.push(h("label", { class: "field" }, h("span", null, "Nombre"),
        h("input", { value: L.name, oninput: (e) => set(() => { L.name = e.target.value; this.rebuildProps(); }) })));
      kids.push(h("p", { class: "note" },
        L.kind === "sprite"
          ? ("Capa raster (" + (L.source || "sprite") + ", " + size + "px). Generada en Bloque/Planta.")
          : "Capa de forma procedural."));

      if (L.kind !== "sprite") {
        kids.push(select({
          label: "Forma", value: L.shape || "cube",
          options: Object.entries(Sh.SHAPES).map(([k, s]) => [k, s.label]),
          onChange: (v) => set(() => { L.shape = v; this.rebuildProps(); }),
        }).el);
        for (const el of this.paramControls(L, set)) kids.push(el);
        kids.push(section({ id: "cp-rot", title: "Rotaci\u00f3n 3D" },
          this.num(L, "rot3d.x", "Rot X\u00b0", -180, 180, set),
          this.num(L, "rot3d.y", "Rot Y\u00b0", -180, 180, set),
          this.num(L, "rot3d.z", "Rot Z\u00b0", -180, 180, set),
        ).el);
      }

      kids.push(section({ id: "cp-cell", title: "Celda multipart" },
        h("p", { class: "note" }, "Cada combinaci\u00f3n distinta de offsets es una celda del tile (mesa, banco\u2026)."),
        this.num(L, "offsetX", "Offset X", -4, 4, set, "TilePart.OffsetX"),
        this.num(L, "offsetY", "Offset Y", -4, 4, set, "TilePart.OffsetY (altura)"),
        this.num(L, "offsetZ", "Offset Z", -4, 4, set, "TilePart.OffsetZ"),
      ).el);

      kids.push(section({ id: "cp-shift", title: "Mover dentro de la celda" },
        h("p", { class: "note" },
          "Solo dentro de los " + size + "\u00d7" + size + " px de esta celda. " +
          "L\u00edmite actual: X " + lim.minSx + "\u2026" + lim.maxSx + ", Y " + lim.minSy + "\u2026" + lim.maxSy +
          (lim.minSx === 0 && lim.maxSx === 0 && lim.minSy === 0 && lim.maxSy === 0
            ? " (el arte llena la celda; no hay margen)."
            : ".")),
        this.num(L, "shiftX", "Shift X px", lim.minSx, lim.maxSx, (fn) => {
          fn();
          if (src?.color) {
            const c = clampShift(src.color, size, L.shiftX, L.shiftY);
            L.shiftX = c.x; L.shiftY = c.y;
          }
          this.savePrefsMeta();
          this.schedule();
        }, "Horizontal dentro de la celda", 1),
        this.num(L, "shiftY", "Shift Y px", lim.minSy, lim.maxSy, (fn) => {
          fn();
          if (src?.color) {
            const c = clampShift(src.color, size, L.shiftX, L.shiftY);
            L.shiftX = c.x; L.shiftY = c.y;
          }
          this.savePrefsMeta();
          this.schedule();
        }, "Vertical dentro de la celda", 1),
        h("button", { onclick: () => set(() => { L.shiftX = 0; L.shiftY = 0; this.rebuildProps(); }) }, "Centrar (0,0)"),
      ).el);

      kids.push(section({ id: "cp-blend", title: "Fusi\u00f3n y tint" },
        select({
          label: "Modo fusi\u00f3n", value: L.blend || "normal",
          options: BLENDS,
          onChange: (v) => set(() => { L.blend = v; }),
        }).el,
        this.num(L, "opacity", "Opacidad", 0, 1, set, null, 0.05),
        h("label", { class: "field" }, h("span", null, "Tint"),
          h("input", {
            type: "color", value: L.tint || "#ffffff",
            oninput: (e) => set(() => { L.tint = e.target.value; }),
          }),
          h("button", { onclick: () => set(() => { L.tint = null; this.rebuildProps(); }) }, "Sin tint")),
      ).el);

      this.propsHost.replaceChildren(...kids);
    }

    paramControls(L, set) {
      const out = [];
      const shape = L.shape;
      if (!Sh?.PARAM_DEFAULTS) return out;
      const add = (key, label, min, max, step = 1) => out.push(this.paramSlider(L, key, label, min, max, set, step));
      if (shape === "layer") add("layer", "Altura", 1, 15);
      if (shape === "small") { add("small", "Ancho", 2, 16); add("smallHeight", "Alto", 1, 16); }
      if (shape === "pillar") add("pillar", "Grosor", 2, 16);
      if (["panel", "slopePanel", "diagonalWall", "semicircle", "frame", "frameRound"].includes(shape)) add("panel", "Grosor", 1, 8);
      if (["sphere", "hemisphere", "cylinder", "semicircle", "arch", "frameRound", "tube"].includes(shape)) add("radius", "Radio", 2, 8);
      if (["frame", "frameRound", "arch", "tube"].includes(shape)) add("frameThick", "Grosor", 1, 6);
      if (shape === "arch") {
        add("archHeight", "Altura pilares", 1, 14);
        add("archDepth", "Profundidad", 2, 16);
      }
      // Tamaño de la forma dentro de la celda.
      add("scale", "Escala", 0.2, 1, 0.05);
      return out;
    }

    paramSlider(L, key, label, min, max, set, step = 1) {
      return slider({
        label, min, max, step, value: L.params?.[key] ?? Sh.PARAM_DEFAULTS[key] ?? min,
        onChange: (v) => set(() => { L.params = L.params || {}; L.params[key] = Number(v); }),
      }).el;
    }

    num(L, path, label, min, max, set, title, step = 1) {
      const get = () => {
        const parts = path.split(".");
        let o = L;
        for (const p of parts) o = o?.[p];
        return o ?? 0;
      };
      const put = (v) => {
        const parts = path.split(".");
        let o = L;
        for (let i = 0; i < parts.length - 1; i++) {
          o[parts[i]] = o[parts[i]] || {};
          o = o[parts[i]];
        }
        o[parts[parts.length - 1]] = v;
      };
      // If min>max (empty range), freeze at 0.
      if (min > max) { min = 0; max = 0; }
      return slider({
        label, min, max, step, value: get(), title: title || undefined,
        onChange: (v) => set(() => put(Number(v))),
      }).el;
    }

    schedule() {
      clearTimeout(this._t);
      this._t = setTimeout(() => this.render(), 40);
    }

    /** Compose one cell: all visible layers with that offset, shifts clamped inside the cell. */
    renderCell(ox, oy, oz) {
      const S = this.doc.size;
      const color = new Uint8ClampedArray(S * S * 4);
      const normal = new Uint8ClampedArray(S * S * 4);
      let hasNormal = false;

      for (let i = 0; i < this.doc.layers.length; i++) {
        const L = this.doc.layers[i];
        if (!L.visible) continue;
        if ((L.offsetX | 0) !== ox || (L.offsetY | 0) !== oy || (L.offsetZ | 0) !== oz) continue;
        const src = this.layerSourceRgba(L);
        if (!src?.color) continue;
        let rgba = src.color;
        if (L.tint) rgba = applyTint(rgba, L.tint);
        const clamped = clampShift(rgba, src.size, L.shiftX || 0, L.shiftY || 0);
        L.shiftX = clamped.x;
        L.shiftY = clamped.y;
        blitShifted(color, S, rgba, src.size, clamped.x, clamped.y, L.blend, L.opacity ?? 1);
        if (src.normal) {
          hasNormal = true;
          blitShifted(normal, S, src.normal, src.size, clamped.x, clamped.y, "normal", 1);
        }
      }
      return { size: S, color, normal: hasNormal ? normal : null };
    }

    /** All unique cells used by visible layers, anchor-normalized so (0,0,0) exists. */
    listCells() {
      const map = new Map();
      for (const L of this.doc.layers) {
        if (!L.visible) continue;
        const key = (L.offsetX | 0) + "," + (L.offsetY | 0) + "," + (L.offsetZ | 0);
        if (!map.has(key)) {
          map.set(key, { offsetX: L.offsetX | 0, offsetY: L.offsetY | 0, offsetZ: L.offsetZ | 0 });
        }
      }
      let cells = [...map.values()];
      if (!cells.length) cells = [{ offsetX: 0, offsetY: 0, offsetZ: 0 }];
      const hasAnchor = cells.some((c) => c.offsetX === 0 && c.offsetY === 0 && c.offsetZ === 0);
      if (!hasAnchor) {
        const a = cells[0];
        cells = cells.map((c) => ({
          offsetX: c.offsetX - a.offsetX,
          offsetY: c.offsetY - a.offsetY,
          offsetZ: c.offsetZ - a.offsetZ,
        }));
      }
      // Stable order: Y, then Z, then X (like stacking furniture).
      cells.sort((a, b) => a.offsetY - b.offsetY || a.offsetZ - b.offsetZ || a.offsetX - b.offsetX);
      return cells;
    }

    render() {
      const S = this.doc.size;
      this.cellCanvases.clear();

      // Celdas reales (sin normalizar): cada offset distinto = una celda al lado.
      const raw = new Map();
      for (const L of this.doc.layers) {
        if (!L.visible) continue;
        const key = (L.offsetX | 0) + "," + (L.offsetY | 0) + "," + (L.offsetZ | 0);
        if (!raw.has(key)) raw.set(key, { offsetX: L.offsetX | 0, offsetY: L.offsetY | 0, offsetZ: L.offsetZ | 0 });
      }
      const rawCells = [...raw.values()];
      if (!rawCells.length) rawCells.push({ offsetX: 0, offsetY: 0, offsetZ: 0 });

      for (const c of rawCells) {
        this.cellCanvases.set(c.offsetX + "," + c.offsetY + "," + c.offsetZ, this.renderCell(c.offsetX, c.offsetY, c.offsetZ));
      }

      // Offsets isométricos en px para cada celda (mismo criterio que el juego aproxima en 2D).
      const placed = rawCells.map((c) => {
        const ox = Math.round((c.offsetX - c.offsetZ) * (S * 0.5));
        const oy = Math.round((c.offsetX + c.offsetZ) * (S * 0.25) - c.offsetY * (S * 0.5));
        return { c, ox, oy };
      });

      // Lienzo que cabe TODAS las celdas sin cortar.
      let minX = 0, minY = 0, maxX = S, maxY = S;
      for (const p of placed) {
        minX = Math.min(minX, p.ox);
        minY = Math.min(minY, p.oy);
        maxX = Math.max(maxX, p.ox + S);
        maxY = Math.max(maxY, p.oy + S);
      }
      const pad = 4;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const W = Math.max(S, maxX - minX);
      const H = Math.max(S, maxY - minY);
      const color = new Uint8ClampedArray(W * H * 4);

      for (const p of placed) {
        const cell = this.cellCanvases.get(p.c.offsetX + "," + p.c.offsetY + "," + p.c.offsetZ);
        if (!cell) continue;
        const dx = p.ox - minX;
        const dy = p.oy - minY;
        // Blit cell into the big canvas at (dx, dy).
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const si = (y * S + x) * 4;
            if (cell.color[si + 3] < 1) continue;
            const di = ((dy + y) * W + (dx + x)) * 4;
            const d = [color[di], color[di + 1], color[di + 2], color[di + 3]];
            const s = [cell.color[si], cell.color[si + 1], cell.color[si + 2], cell.color[si + 3]];
            blendPixel(d, s, "normal", 1);
            color[di] = d[0]; color[di + 1] = d[1]; color[di + 2] = d[2]; color[di + 3] = d[3];
          }
        }
      }

      this.preview = { size: S, w: W, h: H, color, cells: rawCells.length };
      this.paintCanvas();
    }

    paintCanvas() {
      const W = this.preview?.w || this.preview?.size || this.doc.size;
      const H = this.preview?.h || this.preview?.size || this.doc.size;
      const c = this.canvas;
      const boxW = c.parentElement?.clientWidth || 480;
      const boxH = c.parentElement?.clientHeight || 480;
      const scale = Math.max(1, Math.floor(Math.min(boxW / W, boxH / H, 8)));
      c.width = W * scale;
      c.height = H * scale;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      const g = Math.max(4, 8);
      for (let y = 0; y < c.height; y += g) for (let x = 0; x < c.width; x += g) {
        ctx.fillStyle = ((x / g + y / g) & 1) ? "#2a2a30" : "#1e1e24";
        ctx.fillRect(x, y, g, g);
      }
      if (!this.preview) return;
      // Optional grid of cell bounds when multipart.
      if ((this.preview.cells || 1) > 1) {
        ctx.strokeStyle = "rgba(95, 211, 176, 0.35)";
        ctx.lineWidth = 1;
      }
      const img = new ImageData(new Uint8ClampedArray(this.preview.color), W, H);
      const off = document.createElement("canvas");
      off.width = W; off.height = H;
      off.getContext("2d").putImageData(img, 0, 0);
      ctx.drawImage(off, 0, 0, c.width, c.height);
    }

    async exportPng() {
      if (!this.preview) this.render();
      const S = this.preview.size;
      const blob = await encodePng(S, S, this.preview.color);
      downloadBlob(blob, "composer-tile.png");
      this.studio?.toast("PNG exportado", { kind: "ok" });
    }

    exportMultipart() {
      this.render();
      const cells = this.listCells();
      const parts = cells.map((c) => ({
        offsetX: c.offsetX,
        offsetY: c.offsetY,
        offsetZ: c.offsetZ,
        art: { default: { front: [0, 0] } },
      }));
      const blob = new Blob([JSON.stringify({
        name: "ComposerPiece",
        category: "furniture",
        parts,
        _note: "Coords de ejemplo; al colocar en el atlas se rellenan las celdas reales.",
      }, null, 2)], { type: "application/json" });
      downloadBlob(blob, "composer-multipart.json");
      this.studio?.toast("Multipart: " + parts.length + " parte(s)", { kind: "ok" });
    }

    /**
     * Mismo flujo que Bloque: pendingPlacement + activate atlas + clic en celda.
     * Una item por celda multipart (composici\u00f3n de capas de esa celda).
     */
    sendToAtlas() {
      this.render();
      const cells = this.listCells();
      // Render each cell with original offsets matching layer data.
      // listCells may have rebased; rebuild from layers with same rebase.
      const raw = new Map();
      for (const L of this.doc.layers) {
        if (!L.visible) continue;
        const key = (L.offsetX | 0) + "," + (L.offsetY | 0) + "," + (L.offsetZ | 0);
        if (!raw.has(key)) raw.set(key, { offsetX: L.offsetX | 0, offsetY: L.offsetY | 0, offsetZ: L.offsetZ | 0 });
      }
      let rawCells = [...raw.values()];
      if (!rawCells.length) {
        this.studio?.toast("No hay capas visibles", { kind: "warn" });
        return;
      }
      const hasAnchor = rawCells.some((c) => c.offsetX === 0 && c.offsetY === 0 && c.offsetZ === 0);
      let baseX = 0, baseY = 0, baseZ = 0;
      if (!hasAnchor) {
        baseX = rawCells[0].offsetX;
        baseY = rawCells[0].offsetY;
        baseZ = rawCells[0].offsetZ;
      }
      rawCells = rawCells.map((c) => ({
        offsetX: c.offsetX - baseX,
        offsetY: c.offsetY - baseY,
        offsetZ: c.offsetZ - baseZ,
        _ox: c.offsetX + (hasAnchor ? 0 : 0), // original for renderCell
        _oy: c.offsetY,
        _oz: c.offsetZ,
        // wait: if we rebased, original was c.offsetX before map - fix:
      }));
      // Redo cleanly:
      const originals = [...raw.values()];
      if (!hasAnchor) {
        baseX = originals[0].offsetX;
        baseY = originals[0].offsetY;
        baseZ = originals[0].offsetZ;
      } else {
        baseX = baseY = baseZ = 0;
      }
      const ordered = originals
        .map((c) => ({
          offsetX: c.offsetX - baseX,
          offsetY: c.offsetY - baseY,
          offsetZ: c.offsetZ - baseZ,
          srcX: c.offsetX,
          srcY: c.offsetY,
          srcZ: c.offsetZ,
        }))
        .sort((a, b) => a.offsetY - b.offsetY || a.offsetZ - b.offsetZ || a.offsetX - b.offsetX);

      const items = ordered.map((c) => {
        const rendered = this.renderCell(c.srcX, c.srcY, c.srcZ);
        return {
          color: rendered.color,
          normal: rendered.normal,
          label: "celda " + c.offsetX + "," + c.offsetY + "," + c.offsetZ,
          offsetX: c.offsetX,
          offsetY: c.offsetY,
          offsetZ: c.offsetZ,
        };
      });

      const S = this.doc.size;
      this.studio.pendingPlacement = {
        label: "Composer",
        name: "",
        kind: "composer",
        size: S,
        sheetKey: null,
        items: items.map((it) => ({ color: it.color, normal: it.normal, label: it.label })),
        buildTile: (coords) => {
          if (coords.length === 1) {
            return { art: { default: { front: coords[0] } } };
          }
          return {
            parts: ordered.map((c, i) => ({
              offsetX: c.offsetX,
              offsetY: c.offsetY,
              offsetZ: c.offsetZ,
              art: { default: { front: coords[i] || coords[0] } },
            })),
          };
        },
        snippet: (cells) => {
          if (cells.length === 1) {
            return '"art": { "default": { "front": ' + JSON.stringify(cells[0]).replace(",", ", ") + " } }";
          }
          const parts = ordered.map((c, i) => {
            const cell = cells[i] || cells[0];
            return '    { "offsetX": ' + c.offsetX + ', "offsetY": ' + c.offsetY + ', "offsetZ": ' + c.offsetZ +
              ', "art": { "default": { "front": ' + JSON.stringify(cell).replace(",", ", ") + " } } }";
          });
          return '"parts": [\n' + parts.join(",\n") + "\n]";
        },
      };
      this.studio.activate("atlas");
    }
  }

  function queueResult(result, meta = {}) {
    if (!result?.color) return false;
    if (Aura.composerBridge?.pushResult) {
      Aura.composerBridge.pushResult(result, meta);
      return true;
    }
    const q = prefs.get(QUEUE_KEY, []);
    q.push({
      size: result.size || result.w || 64,
      w: result.w, h: result.h,
      color: Array.from(result.color),
      normal: result.normal ? Array.from(result.normal) : null,
      meta: { name: meta.name, source: meta.source },
    });
    prefs.set(QUEUE_KEY, q);
    return true;
  }

  Aura.composerTool = { composerTool, queueResult, spriteLayerFromResult };
})(window.Aura ??= {});
