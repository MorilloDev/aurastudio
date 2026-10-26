"use strict";

// Composer: apila piezas 3D (formas del motor de bloques) en capas, con offsets multipart,
// agujeros/marcos, tint y modos de fusion. Exporta PNG o el JSON de parts del juego.
(function (Aura) {
  const { h } = Aura.dom;
  const { section, slider, select } = Aura.controls;
  const { encodePng } = Aura.png;
  const { downloadBlob } = Aura.fs;
  const { prefs } = Aura.storage;
  const E = Aura.blockEngine;
  const Sh = Aura.blockShapes;
  const Tint = Aura.tint;

  const BLENDS = [
    ["normal", "Normal"],
    ["multiply", "Multiplicar"],
    ["screen", "Pantalla"],
    ["overlay", "Superponer"],
    ["add", "Sumar"],
  ];

  const PREFS_KEY = "composer:doc";

  function defaultLayer(i = 0) {
    return {
      id: "L" + Date.now().toString(36) + i,
      name: "Pieza " + (i + 1),
      visible: true,
      shape: "cube",
      params: { ...Sh.PARAM_DEFAULTS },
      offsetX: 0, offsetY: 0, offsetZ: 0,
      shiftX: 0, shiftY: 0, shiftZ: 0,
      rot3d: { x: 0, y: 0, z: 0 },
      blend: "normal",
      opacity: 1,
      tint: null,
    };
  }

  function defaultDoc() {
    return { size: 64, layers: [defaultLayer(0)], selected: 0 };
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

    mount(host, studio) {
      this.studio = studio;
      try {
        const raw = prefs.get(PREFS_KEY, null);
        if (raw) this.doc = { ...defaultDoc(), ...raw, layers: (raw.layers || []).map((l) => ({ ...defaultLayer(), ...l })) };
      } catch { /* ignore */ }

      this.canvas = h("canvas", { class: "cp-preview" });
      this.layerList = h("div", { class: "cp-layers" });
      this.propsHost = h("div", { class: "cp-props" });

      const toolbar = h("div", { class: "cp-toolbar" },
        h("button", { class: "primary", onclick: () => this.addLayer() }, "+ Pieza"),
        h("button", { onclick: () => this.duplicateLayer() }, "Duplicar"),
        h("button", { onclick: () => this.removeLayer() }, "Quitar"),
        h("span", { class: "grow" }),
        h("button", { onclick: () => this.exportPng() }, "Exportar PNG"),
        h("button", { class: "primary", onclick: () => this.exportMultipart() }, "JSON multipart"),
        h("button", { onclick: () => this.sendToAtlas() }, "Enviar al Atlas \u2192"),
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
            "Offsets X/Z = celdas multipart (TilePart). Shift fino pega piezas. Formas: esfera, cilindro, marco, tubo\u2026 Agujeros con marco/tubo o custom ",
            h("code", null, '"hole": true'), "."))));

      this.rebuildLayerList();
      this.rebuildProps();
      this.schedule();
    }

    activate() { this.schedule(); }
    deactivate() {}
    onProject(project) { this.project = project; }
    isDirty() { return this.dirty; }

    savePrefs() {
      prefs.set(PREFS_KEY, this.doc);
      this.dirty = true;
    }

    selected() {
      const i = Math.max(0, Math.min(this.doc.selected, this.doc.layers.length - 1));
      this.doc.selected = i;
      return this.doc.layers[i];
    }

    addLayer() {
      this.doc.layers.push(defaultLayer(this.doc.layers.length));
      this.doc.selected = this.doc.layers.length - 1;
      this.rebuildLayerList();
      this.rebuildProps();
      this.savePrefs();
      this.schedule();
    }

    duplicateLayer() {
      const src = this.selected();
      if (!src) return;
      const copy = structuredClone(src);
      copy.id = "L" + Date.now().toString(36);
      copy.name = src.name + " copia";
      this.doc.layers.splice(this.doc.selected + 1, 0, copy);
      this.doc.selected++;
      this.rebuildLayerList();
      this.rebuildProps();
      this.savePrefs();
      this.schedule();
    }

    removeLayer() {
      if (this.doc.layers.length <= 1) {
        this.studio?.toast("Deja al menos una pieza", { kind: "warn" });
        return;
      }
      this.doc.layers.splice(this.doc.selected, 1);
      this.doc.selected = Math.min(this.doc.selected, this.doc.layers.length - 1);
      this.rebuildLayerList();
      this.rebuildProps();
      this.savePrefs();
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
            onchange: (e) => { L.visible = e.target.checked; this.savePrefs(); this.schedule(); },
          }),
          h("span", { class: "cp-layer-name" }, L.name || "Pieza"),
          h("span", { class: "mono faint" }, `${L.offsetX},${L.offsetY},${L.offsetZ}`),
          h("button", { title: "Subir", onclick: (e) => { e.stopPropagation(); this.moveLayer(i, 1); } }, "\u2191"),
          h("button", { title: "Bajar", onclick: (e) => { e.stopPropagation(); this.moveLayer(i, -1); } }, "\u2193"));
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
      this.savePrefs();
      this.schedule();
    }

    rebuildProps() {
      const L = this.selected();
      if (!L) return;
      const set = (fn) => { fn(); this.savePrefs(); this.schedule(); this.rebuildLayerList(); };

      this.propsHost.replaceChildren(
        h("label", { class: "field" }, h("span", null, "Nombre"),
          h("input", { value: L.name, oninput: (e) => set(() => { L.name = e.target.value; this.rebuildProps(); }) })),
        select({
          label: "Forma", value: L.shape,
          options: Object.entries(Sh.SHAPES).map(([k, s]) => [k, s.label]),
          onChange: (v) => set(() => { L.shape = v; this.rebuildProps(); }),
        }).el,
        ...this.paramControls(L, set),
        section({ id: "cp-off", title: "Multipart (celdas)" },
          this.num(L, "offsetX", "Offset X", -4, 4, set, "TilePart.OffsetX"),
          this.num(L, "offsetY", "Offset Y", -4, 4, set, "TilePart.OffsetY"),
          this.num(L, "offsetZ", "Offset Z", -4, 4, set, "TilePart.OffsetZ")),
        section({ id: "cp-shift", title: "Ajuste fino (pegar)" },
          this.num(L, "shiftX", "Shift X", -0.5, 0.5, set, null, 0.01),
          this.num(L, "shiftY", "Shift Y", -0.5, 0.5, set, null, 0.01),
          this.num(L, "shiftZ", "Shift Z", -0.5, 0.5, set, null, 0.01)),
        section({ id: "cp-rot", title: "Rotacion 3D" },
          this.num(L, "rot3d.x", "Rot X\u00b0", -180, 180, set),
          this.num(L, "rot3d.y", "Rot Y\u00b0", -180, 180, set),
          this.num(L, "rot3d.z", "Rot Z\u00b0", -180, 180, set)),
        section({ id: "cp-blend", title: "Fusion y tint" },
          select({
            label: "Modo fusion", value: L.blend,
            options: BLENDS,
            onChange: (v) => set(() => { L.blend = v; }),
          }).el,
          this.num(L, "opacity", "Opacidad", 0, 1, set, null, 0.05),
          h("label", { class: "field" }, h("span", null, "Tint"),
            h("input", {
              type: "color", value: L.tint || "#ffffff",
              oninput: (e) => set(() => { L.tint = e.target.value; }),
            }),
            h("button", { onclick: () => set(() => { L.tint = null; this.rebuildProps(); }) }, "Sin tint"))),
      );
    }

    paramControls(L, set) {
      const out = [];
      const shape = L.shape;
      if (shape === "layer") out.push(this.paramSlider(L, "layer", "Altura", 1, 15, set));
      if (shape === "small") {
        out.push(this.paramSlider(L, "small", "Ancho", 2, 16, set));
        out.push(this.paramSlider(L, "smallHeight", "Alto", 1, 16, set));
      }
      if (shape === "pillar") out.push(this.paramSlider(L, "pillar", "Grosor", 2, 16, set));
      if (["panel", "slopePanel", "diagonalWall", "semicircle", "frame", "frameRound"].includes(shape)) {
        out.push(this.paramSlider(L, "panel", "Grosor", 1, 8, set));
      }
      if (["sphere", "hemisphere", "cylinder", "semicircle", "arch", "frameRound", "tube"].includes(shape)) {
        out.push(this.paramSlider(L, "radius", "Radio", 2, 8, set));
      }
      if (["frame", "frameRound", "arch", "tube"].includes(shape)) {
        out.push(this.paramSlider(L, "frameThick", "Grosor marco", 1, 6, set));
      }
      return out;
    }

    paramSlider(L, key, label, min, max, set) {
      return slider({
        label, min, max, step: 1, value: L.params[key] ?? Sh.PARAM_DEFAULTS[key],
        onChange: (v) => set(() => { L.params[key] = Number(v); }),
      }).el;
    }

    num(L, path, label, min, max, set, title, step = 1) {
      const get = () => {
        const parts = path.split(".");
        let o = L;
        for (const p of parts) o = o[p];
        return o;
      };
      const put = (v) => {
        const parts = path.split(".");
        let o = L;
        for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
        o[parts[parts.length - 1]] = v;
      };
      return slider({
        label, min, max, step, value: get(), title: title || undefined,
        onChange: (v) => set(() => put(Number(v))),
      }).el;
    }

    schedule() {
      clearTimeout(this._t);
      this._t = setTimeout(() => this.render(), 40);
    }

    faceTex() {
      const solid = (rgb) => {
        const S = 16;
        const rgba = new Uint8ClampedArray(S * S * 4);
        for (let i = 0; i < S * S; i++) {
          rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255;
        }
        return { w: S, h: S, rgba };
      };
      return {
        top: solid([160, 160, 155]),
        left: solid([120, 120, 118]),
        right: solid([100, 100, 98]),
      };
    }

    renderLayer(L) {
      const def = Sh.SHAPES[L.shape] ?? Sh.SHAPES.cube;
      let boxes;
      try {
        boxes = def.boxes ? def.boxes({ ...Sh.PARAM_DEFAULTS, ...L.params }) : [{ min: [0, 0, 0], max: [1, 1, 1] }];
      } catch (err) {
        this.studio?.toast(err.message, { kind: "warn" });
        boxes = Sh.SHAPES.cube.boxes();
      }
      if (L.shiftX || L.shiftY || L.shiftZ) {
        boxes = boxes.map((b) => ({
          ...b,
          min: [b.min[0] + L.shiftX, b.min[1] + L.shiftY, b.min[2] + L.shiftZ],
          max: [b.max[0] + L.shiftX, b.max[1] + L.shiftY, b.max[2] + L.shiftZ],
        }));
      }
      const piece = { boxes, state: "default", facing: "front", rot3d: { ...L.rot3d } };
      return E.render(E.merge({ size: this.doc.size, shading: true }), this.faceTex(), piece);
    }

    blendPixel(dst, src, mode, opacity) {
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

    applyTint(rgba, hex) {
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

    render() {
      const S = this.doc.size;
      const n = S * S;
      const color = new Uint8ClampedArray(n * 4);
      const zbuf = new Float32Array(n).fill(-Infinity);

      for (let i = 0; i < this.doc.layers.length; i++) {
        const L = this.doc.layers[i];
        if (!L.visible) continue;
        let result;
        try { result = this.renderLayer(L); } catch (err) { console.warn(err); continue; }
        let rgba = result.color;
        if (L.tint) rgba = this.applyTint(rgba, L.tint);

        const ox = (L.offsetX - L.offsetZ) * (S * 0.5);
        const oy = (L.offsetX + L.offsetZ) * (S * 0.25) - L.offsetY * (S * 0.5);

        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const si = (y * S + x) * 4;
            if (rgba[si + 3] < 1) continue;
            const dx = Math.round(x + ox);
            const dy = Math.round(y + oy);
            if (dx < 0 || dy < 0 || dx >= S || dy >= S) continue;
            const di = (dy * S + dx) * 4;
            const depthKey = i + (result.depth ? result.depth[(y * S + x) * 4] / 255 : 0);
            if (depthKey < zbuf[dy * S + dx] - 0.001) continue;
            zbuf[dy * S + dx] = depthKey;
            const dst = [color[di], color[di + 1], color[di + 2], color[di + 3]];
            const src = [rgba[si], rgba[si + 1], rgba[si + 2], rgba[si + 3]];
            this.blendPixel(dst, src, L.blend || "normal", L.opacity ?? 1);
            color[di] = dst[0]; color[di + 1] = dst[1]; color[di + 2] = dst[2]; color[di + 3] = dst[3];
          }
        }
      }

      this.preview = { size: S, color };
      this.paintCanvas();
    }

    paintCanvas() {
      const S = this.preview?.size || this.doc.size;
      const c = this.canvas;
      const scale = Math.max(1, Math.floor(Math.min(480, (c.parentElement?.clientWidth || 480)) / S));
      c.width = S * scale;
      c.height = S * scale;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      const g = 8;
      for (let y = 0; y < c.height; y += g) for (let x = 0; x < c.width; x += g) {
        ctx.fillStyle = ((x / g + y / g) & 1) ? "#2a2a30" : "#1e1e24";
        ctx.fillRect(x, y, g, g);
      }
      if (!this.preview) return;
      const img = ctx.createImageData(S, S);
      img.data.set(this.preview.color);
      const off = document.createElement("canvas");
      off.width = S; off.height = S;
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

    multipartParts() {
      const cells = new Map();
      for (const L of this.doc.layers) {
        if (!L.visible) continue;
        const key = `${L.offsetX},${L.offsetY},${L.offsetZ}`;
        if (!cells.has(key)) cells.set(key, { offsetX: L.offsetX, offsetY: L.offsetY, offsetZ: L.offsetZ, layers: [] });
        cells.get(key).layers.push(L);
      }
      if (!cells.has("0,0,0") && cells.size) {
        const first = [...cells.values()][0];
        const ax = first.offsetX, ay = first.offsetY, az = first.offsetZ;
        for (const c of cells.values()) {
          c.offsetX -= ax; c.offsetY -= ay; c.offsetZ -= az;
        }
      }
      return [...cells.values()];
    }

    exportMultipart() {
      const parts = this.multipartParts().map((c) => ({
        offsetX: c.offsetX,
        offsetY: c.offsetY,
        offsetZ: c.offsetZ,
        art: { default: { front: [0, 0] } },
      }));
      const json = {
        name: "ComposerPiece",
        category: "furniture",
        parts,
        _note: "Coords de ejemplo: al enviar al atlas se rellenan las celdas reales.",
      };
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
      downloadBlob(blob, "composer-multipart.json");
      this.studio?.toast(`Multipart: ${parts.length} parte(s)`, { kind: "ok" });
    }

    sendToAtlas() {
      if (!this.preview) this.render();
      const studio = this.studio;
      if (studio) {
        studio.pendingAtlasSprite = {
          name: "composer",
          size: this.preview.size,
          color: this.preview.color,
          parts: this.multipartParts().map((c) => ({
            offsetX: c.offsetX, offsetY: c.offsetY, offsetZ: c.offsetZ,
          })),
        };
      }
      studio?.toast("Abre Atlas y coloca la celda (multipart en JSON aparte)", { kind: "ok" });
      studio?.showTool?.("atlas");
    }
  }

  Aura.composerTool = { composerTool };
})(window.Aura ??= {});
