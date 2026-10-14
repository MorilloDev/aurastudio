"use strict";

// Bloques: builds a block sprite from face textures of an atlas (or a loose texture), with relief, edge control, the
// face light of the Blender materials, ambient occlusion, depth and a grayscale pass, rendered with the game's camera.
// Everything heavy is in engine.js; this file is the panel, the cell picker, the preview and the saving.
(function (Aura) {
  const { h } = Aura.dom;
  const { section, slider, select, checkbox, segmented, numberPair } = Aura.controls;
  const { decodePng, encodePng } = Aura.png;
  const { downloadBlob, joinPath, dirName, stripExt, writeInDir } = Aura.fs;
  const { prefs } = Aura.storage;
  const { listSheets, companionPath, refreshCompanions } = Aura.normalsSheets;
  const E = Aura.blockEngine;

  const SLOTS = [["top", "Arriba", "#5fd3b0"], ["left", "Izquierda", "#7fb2ff"], ["right", "Derecha", "#e27bd8"]];
  const VIEWS = [["color", "Color"], ["normal", "Normales"], ["depth", "Profundidad"], ["ao", "AO"], ["gray", "Grises"]];
  const MAPS = [["color", ""], ["normal", "_n"], ["depth", "_depth"], ["ao", "_ao"], ["gray", "_gray"]];
  const PREFS_KEY = "blocks:settings";

  function blocksTool() {
    return new BlocksTool();
  }

  class BlocksTool {
    id = "blocks";
    title = "Bloques";
    project = null;
    sheets = [];
    images = new Map();      // source key -> { key, name, w, h, rgba, sheet }
    slots = {
      top: { key: null, cx: 0, cy: 0, rot: 0, flip: false },
      left: { key: null, cx: 0, cy: 0, rot: 0, flip: false },
      right: { key: null, cx: 0, cy: 0, rot: 0, flip: false },
    };
    activeSlot = "all";
    view = "color";
    result = null;
    #pending = 0;

    // ---------------------------------------------------------------------------------------------------------------
    // Setup

    mount(host, studio) {
      this.studio = studio;
      const saved = prefs.get(PREFS_KEY, null);
      this.o = E.merge(saved?.o ?? {});
      this.cellSize = saved?.cellSize ?? 64;
      this.exportScale = saved?.exportScale ?? 4;
      host.appendChild(this.#buildLayout());
      new ResizeObserver(() => { this.#drawPicker(); this.#drawPreview(); }).observe(this.root);
      this.#renderList();
      this.#schedule();
    }

    activate() { this.#drawPicker(); this.#drawPreview(); }
    deactivate() {}
    isDirty() { return false; }

    onProject(project) {
      this.project = project;
      this.sheets = listSheets(project);
      this.#renderList();
      this.#fillTargets();
    }

    #save() {
      prefs.set(PREFS_KEY, { o: this.o, cellSize: this.cellSize, exportScale: this.exportScale });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Layout

    #buildLayout() {
      // Left: sources and the cell picker.
      this.fileInput = h("input", { type: "file", accept: ".png,image/png", hidden: true, onchange: (e) => this.#openLoose(e.target.files) });
      this.filterInput = h("input", { type: "search", placeholder: "Filtrar hojas…", oninput: () => this.#renderList() });
      this.listEl = h("div", { class: "bk-items scroll" });
      this.slotSeg = segmented({
        label: "Cara a asignar", value: "all",
        options: [["all", "Todas"], ...SLOTS.map(([k, t]) => [k, t])],
        onChange: (v) => { this.activeSlot = v; this.#updateSlotControls(); },
      });
      this.cellInput = h("input", { type: "number", min: 0, max: 1024, value: this.cellSize, title: "0 = la imagen entera es una cara",
        onchange: () => { this.cellSize = Math.max(0, Number(this.cellInput.value) || 0); this.#save(); this.#drawPicker(); this.#schedule(); } });
      this.rotSel = select({ label: "Girar", value: "0", options: [["0", "0°"], ["90", "90°"], ["180", "180°"], ["270", "270°"]],
        onChange: (v) => this.#forSlots((s) => { s.rot = Number(v); }) });
      this.flipChk = checkbox({ label: "Espejo", value: false, onChange: (v) => this.#forSlots((s) => { s.flip = v; }) });
      this.pickerCanvas = h("canvas", { class: "bk-picker", onclick: (e) => this.#pickCell(e) });
      this.slotInfo = h("div", { class: "bk-slotinfo" });
      const left = h("div", { class: "bk-list" },
        h("div", { class: "head" },
          h("div", { class: "row" }, h("button", { class: "grow", onclick: () => this.fileInput.click() }, "Abrir textura suelta…"), this.fileInput),
          this.filterInput),
        this.listEl,
        h("div", { class: "bk-pick" },
          h("div", { class: "field" }, h("label", null, "Celda (px)"), this.cellInput),
          this.slotSeg.el,
          h("div", { class: "bk-picker-wrap scroll" }, this.pickerCanvas),
          this.slotInfo,
          h("div", { class: "pair2" }, this.rotSel.el, this.flipChk.el)));

      // Centre: the preview.
      this.viewSeg = segmented({ label: "Vista", value: this.view, options: VIEWS, onChange: (v) => { this.view = v; this.#drawPreview(); } });
      this.guideChk = checkbox({ label: "Guías", value: true, onChange: () => this.#drawPreview() });
      this.previewCanvas = h("canvas", { class: "bk-preview" });
      this.strip = h("div", { class: "bk-strip" });
      const stage = h("div", { class: "bk-stage" },
        h("div", { class: "bk-toolbar" }, this.viewSeg.el, h("span", { class: "grow" }), this.guideChk.el),
        h("div", { class: "bk-view" }, this.previewCanvas),
        this.strip);

      this.root = h("div", { class: "bk" }, left, stage, this.#buildPanel());
      return this.root;
    }

    // Controls bound to an option path ("shade.left"): every change re-renders and is remembered.
    #get(path) { return path.split(".").reduce((o, k) => o[k], this.o); }
    #set(path, v) {
      const keys = path.split(".");
      const last = keys.pop();
      keys.reduce((o, k) => o[k], this.o)[last] = v;
      this.#save();
      this.#schedule();
    }
    #slider(label, path, min, max, step, title = "") {
      const def = path.split(".").reduce((o, k) => o[k], E.DEFAULTS);
      return slider({ label, min, max, step, value: this.#get(path), defaultValue: def, title,
        onInput: (v) => this.#set(path, v) }).el;
    }
    #check(label, path, title = "") {
      return checkbox({ label, value: this.#get(path), title, onChange: (v) => this.#set(path, v) }).el;
    }
    #choice(label, path, options) {
      return h("div", { class: "field" }, h("label", null, label),
        segmented({ label, value: this.#get(path), options, onChange: (v) => this.#set(path, v) }).el);
    }

    #buildPanel() {
      const relief = section({ id: "bk-relief", title: "Relieve" },
        this.#choice("Relieve", "relief", [["none", "Plano"], ["in", "Tallado"], ["out", "Saliente"]]),
        this.#choice("Altura de", "source", [["luma", "Brillo"], ["alpha", "Alfa"]]),
        this.#choice("Lectura", "sampling", [["min", "Mínimo"], ["avg", "Media"], ["max", "Máximo"]]),
        this.#slider("Resolución", "res", 4, 64, 1, "Cubitos por lado del bloque. Más = relieve más fino."),
        this.#slider("Profundidad", "depth", 1, 6, 1, "En cubitos"),
        this.#slider("Niveles", "steps", 1, 6, 1),
        this.#slider("Umbral", "threshold", 0, 0.95, 0.01),
        this.#check("Contraste automático", "autoContrast", "Estira lo más oscuro y lo más claro de cada cara a 0..1"),
        this.#check("Invertir", "invert"),
        h("div", { class: "bk-row3" }, this.#check("Arriba", "faces.top"), this.#check("Izq.", "faces.left"), this.#check("Der.", "faces.right")));

      const edges = section({ id: "bk-edges", title: "Bordes" },
        h("p", { class: "note" }, "Dónde puede salir el relieve fuera del bloque. Los lados verticales del sprite se quedan planos para no salirse."),
        h("div", { class: "bk-zones" },
          this.#check("Arriba izq.", "edges.topLeft"), this.#check("Arriba der.", "edges.topRight"),
          this.#check("Abajo izq.", "edges.bottomLeft"), this.#check("Abajo der.", "edges.bottomRight")),
        this.#check("Relieve en los lados verticales", "edges.sides"),
        this.#slider("Suavizado borde", "edgeFalloff", 0, 8, 1, "Cubitos en los que el relieve se apaga hacia un borde plano"),
        this.#check("Ajustar dentro del sprite", "autoFit"),
        this.#slider("Desgaste aristas", "chips", 0, 1, 0.01),
        this.#slider("Labio colgante", "lip", 0, 8, 1, "Lo de arriba cuelga sobre los lados (césped, nieve, musgo)"),
        this.#slider("Prob. labio", "lipChance", 0, 1, 0.01),
        h("div", { class: "row" }, this.#slider("Semilla", "seed", 1, 9999, 1),
          h("button", { onclick: () => { this.o.seed = 1 + Math.floor(Math.random() * 9999); this.#save(); this.#rebuildPanel(); this.#schedule(); } }, "Otra")));

      const light = section({ id: "bk-light", title: "Luz" },
        this.#check("Luz por caras (como los materiales)", "shading"),
        this.#slider("Arriba", "shade.top", 0, 1.5, 0.01),
        this.#slider("Izquierda", "shade.left", 0, 1.5, 0.01),
        this.#slider("Derecha", "shade.right", 0, 1.5, 0.01),
        this.#check("Oclusión ambiental (AO)", "ao"),
        this.#slider("Distancia AO", "aoDistance", 0.02, 1, 0.01, "En bloques"),
        this.#slider("Fuerza AO", "aoStrength", 0, 1, 0.01),
        this.#slider("Escalones AO", "aoSteps", 0, 8, 1, "0 = suave; pocos escalones se leen mejor en pixel art"),
        this.#slider("Muestras AO", "aoSamples", 4, 64, 1));

      const pixel = section({ id: "bk-pixel", title: "Pixel art" },
        this.#slider("Luz en aristas", "edgeLight", 0, 0.6, 0.01),
        this.#slider("Contorno", "outline", 0, 0.8, 0.01),
        this.#check("Quitar pixeles sueltos", "cleanup"),
        this.#check("Grises con el brillo de la textura", "grayFromTexture"));

      this.sizeSel = select({ label: "Tamaño sprite", value: String(this.o.size),
        options: [["32", "32 px"], ["48", "48 px"], ["64", "64 px"], ["96", "96 px"], ["128", "128 px"]],
        onChange: (v) => this.#set("size", Number(v)) });
      this.targetSel = select({ label: "Hoja destino", value: "", options: [["", "— abre la carpeta —"]] });
      this.targetCell = numberPair({ label: "Celda X / Y", values: [0, 0], min: 0, max: 4096 });
      this.saveN = checkbox({ label: "Guardar también el _n", value: true });
      this.scaleSel = select({ label: "Escala descarga", value: String(this.exportScale),
        options: [["1", "×1"], ["2", "×2"], ["4", "×4"], ["8", "×8"]],
        onChange: (v) => { this.exportScale = Number(v); this.#save(); } });
      this.mapChecks = MAPS.map(([k]) => checkbox({ label: { color: "Color", normal: "Normales", depth: "Profundidad", ao: "AO", gray: "Grises" }[k], value: k === "color" || k === "normal" }));
      const output = section({ id: "bk-out", title: "Salida" },
        this.sizeSel.el,
        this.targetSel.el, this.targetCell.el, this.saveN.el,
        h("button", { class: "primary", onclick: () => this.#saveToAtlas() }, "Guardar en el atlas"),
        h("div", { class: "bk-sep" }),
        h("div", { class: "bk-maps" }, this.mapChecks.map((c) => c.el)),
        this.scaleSel.el,
        h("button", { onclick: () => this.#download() }, "Descargar PNG"));

      this.panelScroll = h("div", { class: "scroll" }, relief.el, edges.el, light.el, pixel.el, output.el);
      this.panel = h("div", { class: "bk-panel" },
        h("div", { class: "bk-panel-head" }, h("span", null, "Ajustes"),
          h("button", { title: "Volver a los valores por defecto", onclick: () => { this.o = E.merge({}); this.#save(); this.#rebuildPanel(); this.#schedule(); } }, "Restablecer")),
        this.panelScroll);
      return this.panel;
    }

    #rebuildPanel() {
      const fresh = this.#buildPanel();
      this.root.replaceChild(fresh, this.root.children[2]);
      this.#fillTargets();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Sources

    #renderList() {
      const q = this.filterInput.value.trim().toLowerCase();
      this.listEl.replaceChildren();
      const loose = [...this.images.values()].filter((i) => !i.sheet);
      for (const img of loose) this.listEl.appendChild(this.#listItem(img.key, img.name, "suelta"));
      for (const s of this.sheets) {
        if (q && !s.id.toLowerCase().includes(q) && !s.path.toLowerCase().includes(q)) continue;
        this.listEl.appendChild(this.#listItem(s.key, s.id, s.path, s));
      }
      if (!this.listEl.children.length) {
        this.listEl.appendChild(h("div", { class: "empty-state" }, "Abre la carpeta del proyecto para ver sus atlas, o abre una textura suelta."));
      }
    }

    #listItem(key, title, sub, sheet = null) {
      const used = SLOTS.filter(([k]) => this.slots[k].key === key).map(([, , c]) => h("span", { class: "swatch", style: { background: c } }));
      return h("div", { class: ["bk-sheet", this.pickerKey === key && "active"], onclick: () => this.#selectSource(key, sheet) },
        h("div", { class: "id" }, title, ...used), h("div", { class: "path" }, sub));
    }

    async #selectSource(key, sheet) {
      try {
        if (!this.images.has(key) && sheet) {
          const blob = await sheet.entry.handle.getFile();
          const img = await decodePng(blob);
          this.images.set(key, { key, name: sheet.id, ...img, sheet });
        }
        this.pickerKey = key;
        // A source with no face assigned yet takes all three, so one click shows a block straight away.
        if (!SLOTS.some(([k]) => this.slots[k].key)) for (const [k] of SLOTS) Object.assign(this.slots[k], { key, cx: 0, cy: 0 });
        if (sheet && !this.targetSel.get()) this.targetSel.set(key);
        this.#renderList();
        this.#drawPicker();
        this.#updateSlotControls();
        this.#schedule();
      } catch (err) {
        this.studio.toast("No pude abrir la imagen.", { kind: "bad", detail: err.message });
      }
    }

    async #openLoose(files) {
      const file = files?.[0];
      if (!file) return;
      const img = await decodePng(file);
      const key = "loose:" + file.name;
      this.images.set(key, { key, name: stripExt(file.name), ...img, sheet: null });
      for (const [k] of SLOTS) Object.assign(this.slots[k], { key, cx: 0, cy: 0 });
      // A square loose texture is usually one face (the whole image); anything else is probably a small atlas,
      // so keep the current cell size if it tiles the image and otherwise guess the largest common grid.
      const tiles = (cs) => cs > 0 && img.w % cs === 0 && img.h % cs === 0 && cs < Math.max(img.w, img.h);
      const guess = img.w === img.h && img.w <= 256 ? 0
        : tiles(this.cellSize) ? this.cellSize
        : [128, 64, 32, 16].find(tiles) ?? 0;
      if (guess !== this.cellSize) {
        this.cellSize = guess;
        this.cellInput.value = guess;
        this.#save();
      }
      this.fileInput.value = "";
      await this.#selectSource(key, null);
    }

    #cellRect(img, cx, cy) {
      const cs = this.cellSize;
      if (!cs || cs >= Math.max(img.w, img.h)) return { x: 0, y: 0, w: img.w, h: img.h };
      const x = Math.min(img.w - cs, Math.max(0, cx * cs)), y = Math.min(img.h - cs, Math.max(0, cy * cs));
      return { x, y, w: Math.min(cs, img.w), h: Math.min(cs, img.h) };
    }

    #pickCell(e) {
      const img = this.images.get(this.pickerKey);
      if (!img || !this.cellSize) return;
      const r = this.pickerCanvas.getBoundingClientRect();
      const scale = this.pickerCanvas.width / r.width / this.pickerScale;
      const x = (e.clientX - r.left) * scale, y = (e.clientY - r.top) * scale;
      const cx = Math.floor(x / this.cellSize), cy = Math.floor(y / this.cellSize);
      const targets = this.activeSlot === "all" ? SLOTS.map(([k]) => k) : [this.activeSlot];
      for (const k of targets) Object.assign(this.slots[k], { key: img.key, cx, cy });
      this.#renderList();
      this.#drawPicker();
      this.#updateSlotControls();
      this.#schedule();
    }

    #forSlots(fn) {
      const targets = this.activeSlot === "all" ? SLOTS.map(([k]) => k) : [this.activeSlot];
      for (const k of targets) fn(this.slots[k]);
      this.#schedule();
    }

    #updateSlotControls() {
      const s = this.slots[this.activeSlot === "all" ? "top" : this.activeSlot];
      this.rotSel.set(String(s.rot));
      this.flipChk.set(s.flip);
      this.slotInfo.replaceChildren(...SLOTS.map(([k, t, c]) => {
        const sl = this.slots[k];
        const img = sl.key ? this.images.get(sl.key) : null;
        return h("div", { class: "row" }, h("span", { class: "swatch", style: { background: c } }),
          h("span", { class: "grow" }, t), h("span", { class: "muted mono" }, img ? `${img.name} [${sl.cx}, ${sl.cy}]` : "—"));
      }));
    }

    #drawPicker() {
      const img = this.images.get(this.pickerKey);
      const c = this.pickerCanvas;
      if (!img) { c.width = c.height = 0; return; }
      const avail = Math.max(120, c.parentElement.clientWidth - 2);
      const scale = Math.max(1, Math.floor(avail / img.w)) || 1;
      const fit = Math.min(scale, avail / img.w);
      this.pickerScale = fit;
      c.width = Math.round(img.w * fit);
      c.height = Math.round(img.h * fit);
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      const tmp = new OffscreenCanvas(img.w, img.h);
      tmp.getContext("2d").putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(tmp, 0, 0, c.width, c.height);
      const cs = this.cellSize;
      if (cs > 0 && cs < Math.max(img.w, img.h)) {
        ctx.strokeStyle = "rgba(255,255,255,.18)";
        ctx.lineWidth = 1;
        for (let x = cs; x < img.w; x += cs) { ctx.beginPath(); ctx.moveTo(x * fit + 0.5, 0); ctx.lineTo(x * fit + 0.5, c.height); ctx.stroke(); }
        for (let y = cs; y < img.h; y += cs) { ctx.beginPath(); ctx.moveTo(0, y * fit + 0.5); ctx.lineTo(c.width, y * fit + 0.5); ctx.stroke(); }
      }
      SLOTS.forEach(([k, t, colour], n) => {
        const sl = this.slots[k];
        if (sl.key !== img.key) return;
        const r = this.#cellRect(img, sl.cx, sl.cy);
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        const inset = 1 + n * 2;
        ctx.strokeRect(r.x * fit + inset, r.y * fit + inset, r.w * fit - inset * 2, r.h * fit - inset * 2);
        ctx.fillStyle = colour;
        ctx.font = "bold 11px sans-serif";
        ctx.fillText(t[0], r.x * fit + 4 + n * 10, r.y * fit + 13);
      });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Render

    #schedule() {
      const ticket = ++this.#pending;
      setTimeout(() => { if (ticket === this.#pending) this.#render(); }, 30);
    }

    #textures() {
      const tex = {};
      for (const [k] of SLOTS) {
        const sl = this.slots[k];
        const img = sl.key ? this.images.get(sl.key) : null;
        if (!img) return null;
        tex[k] = E.faceTexture(img, this.#cellRect(img, sl.cx, sl.cy), sl.rot, sl.flip);
      }
      return tex;
    }

    #render() {
      const tex = this.#textures();
      if (!tex) { this.result = null; this.#drawPreview(); return; }
      const t0 = performance.now();
      try {
        this.result = E.render(this.o, tex);
      } catch (err) {
        this.studio.toast("No pude generar el bloque.", { kind: "bad", detail: err.message });
        return;
      }
      this.studio.slot?.("bk-time", Math.round(performance.now() - t0) + " ms", "Tiempo de generación");
      this.#drawPreview();
      this.#drawStrip();
    }

    #imageCanvas(rgba, size) {
      const c = new OffscreenCanvas(size, size);
      c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
      return c;
    }

    #drawPreview() {
      const c = this.previewCanvas;
      const box = c.parentElement;
      if (!box) return;
      c.width = box.clientWidth;
      c.height = box.clientHeight;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, c.width, c.height);
      if (!this.result) {
        ctx.fillStyle = "#98a0aa";
        ctx.font = "14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Elige una hoja o una textura y haz clic en una celda.", c.width / 2, c.height / 2);
        return;
      }
      const S = this.result.size;
      const zoom = Math.max(1, Math.floor(Math.min(c.width, c.height) * 0.9 / S));
      const ox = Math.floor((c.width - S * zoom) / 2), oy = Math.floor((c.height - S * zoom) / 2);
      // Checkerboard behind, so transparent pixels read as transparent.
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        ctx.fillStyle = (x >> 2 ^ y >> 2) & 1 ? "#2f3338" : "#383d43";
        ctx.fillRect(ox + x * zoom, oy + y * zoom, zoom, zoom);
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.#imageCanvas(this.result[this.view], S), ox, oy, S * zoom, S * zoom);
      if (this.guideChk.get()) {
        ctx.strokeStyle = "rgba(255,255,255,.35)";
        ctx.lineWidth = 1;
        ctx.strokeRect(ox - 0.5, oy - 0.5, S * zoom + 1, S * zoom + 1);
        // The plain block's outline: what sticks out of it is relief or lip.
        const q = S * zoom / 4;
        ctx.beginPath();
        ctx.moveTo(ox + S * zoom / 2, oy);
        ctx.lineTo(ox + S * zoom, oy + q); ctx.lineTo(ox + S * zoom, oy + 3 * q);
        ctx.lineTo(ox + S * zoom / 2, oy + 4 * q); ctx.lineTo(ox, oy + 3 * q); ctx.lineTo(ox, oy + q); ctx.closePath();
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    #drawStrip() {
      if (!this.result) return;
      const S = this.result.size;
      this.strip.replaceChildren(...VIEWS.map(([k, t]) => {
        const c = h("canvas", { width: S, height: S, title: t, class: k === this.view ? "on" : "",
          onclick: () => { this.view = k; this.viewSeg.set(k); this.#drawPreview(); this.#drawStrip(); } });
        c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(this.result[k]), S, S), 0, 0);
        return h("div", { class: "bk-thumb" }, c, h("span", null, t));
      }));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Output

    #fillTargets() {
      if (!this.targetSel) return;
      const current = this.targetSel.get();
      const options = this.sheets.length ? this.sheets.map((s) => [s.key, s.id]) : [["", "— abre la carpeta —"]];
      this.targetSel.input.replaceChildren(...options.map(([v, t]) => h("option", { value: v }, t)));
      if (options.some(([v]) => v === current)) this.targetSel.set(current);
    }

    #baseName() {
      const top = this.slots.top.key ? this.images.get(this.slots.top.key) : null;
      return (top?.name ?? "bloque") + `_${this.slots.top.cx}_${this.slots.top.cy}`;
    }

    async #download() {
      if (!this.result) return;
      const S = this.result.size, k = this.exportScale;
      let n = 0;
      for (let i = 0; i < MAPS.length; i++) {
        if (!this.mapChecks[i].get()) continue;
        const [key, suffix] = MAPS[i];
        const rgba = k > 1 ? E.upscale(this.result[key], S, k) : this.result[key];
        downloadBlob(await encodePng(S * k, S * k, new Uint8ClampedArray(rgba)), `${this.#baseName()}${suffix}${k > 1 ? "@" + k + "x" : ""}.png`);
        n++;
      }
      this.studio.setStatus(n ? `Descargados ${n} PNG.` : "Marca qué mapas descargar.", n ? "ok" : "warn");
    }

    /** Pastes the sprite into a cell of the target sheet (and the normals into its _n), keeping a backup to restore. */
    async #saveToAtlas() {
      if (!this.result) return;
      const sheet = this.sheets.find((s) => s.key === this.targetSel.get());
      if (!this.project || !sheet) {
        this.studio.toast("Abre la carpeta del proyecto y elige la hoja destino.", { kind: "warn" });
        return;
      }
      try {
        await this.studio.busy(this.#writeCell(sheet));
      } catch (err) {
        this.studio.toast("No pude guardar.", { kind: "bad", detail: err.message });
      }
    }

    async #writeCell(sheet) {
      const S = this.result.size;
      const [cx, cy] = this.targetCell.get();
      const sheetImg = await decodePng(await sheet.entry.handle.getFile());
      if ((cx + 1) * S > sheetImg.w || (cy + 1) * S > sheetImg.h) {
        throw new Error(`La celda [${cx}, ${cy}] de ${S} px no cabe en la hoja (${sheetImg.w}×${sheetImg.h}).`);
      }
      const dir = sheet.entry.dir, folder = dirName(sheet.path);
      const backups = [];
      const write = async (name, w, hgt, rgba) => {
        const path = joinPath(folder, name);
        const existing = this.project.get(path);
        backups.push({ name, path, previous: existing ? await existing.handle.getFile() : null });
        const handle = await writeInDir(dir, name, await encodePng(w, hgt, rgba));
        this.project.addFile(path, handle, dir);
      };
      const paste = (target, tw, src) => {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const si = (y * S + x) * 4, di = ((cy * S + y) * tw + cx * S + x) * 4;
          for (let c = 0; c < 4; c++) target[di + c] = src[si + c];
        }
      };
      paste(sheetImg.rgba, sheetImg.w, this.result.color);
      await write(sheet.name, sheetImg.w, sheetImg.h, sheetImg.rgba);
      const written = [sheet.name];
      if (this.saveN.get()) {
        const nPath = companionPath(sheet.path, "_n");
        const nEntry = this.project.get(nPath);
        let nImg = nEntry ? await decodePng(await nEntry.handle.getFile()) : null;
        if (!nImg || nImg.w !== sheetImg.w || nImg.h !== sheetImg.h) {
          nImg = { w: sheetImg.w, h: sheetImg.h, rgba: new Uint8ClampedArray(sheetImg.w * sheetImg.h * 4) };
        }
        paste(nImg.rgba, nImg.w, this.result.normal);
        const nName = stripExt(sheet.name) + "_n.png";
        await write(nName, nImg.w, nImg.h, nImg.rgba);
        written.push(nName);
      }
      refreshCompanions(this.project, sheet);
      this.images.delete(sheet.key);
      if (this.pickerKey === sheet.key) await this.#selectSource(sheet.key, sheet);
      this.studio.setStatus(`Guardado en [${cx}, ${cy}]: ${written.join(", ")}.`, "ok");
      this.studio.toast("Guardado " + written.join(", "), {
        kind: "ok", detail: `Celda [${cx}, ${cy}] de ${sheet.id}`,
        action: { label: "Restaurar anterior", run: () => this.#restore(dir, backups) },
      });
    }

    async #restore(dir, backups) {
      try {
        for (const b of backups) {
          if (b.previous) {
            const handle = await writeInDir(dir, b.name, b.previous);
            this.project.addFile(b.path, handle, dir);
          } else {
            await dir.removeEntry(b.name).catch(() => {});
            this.project.files.delete(b.path.toLowerCase());
          }
        }
        this.studio.toast("Archivos restaurados.", { kind: "ok" });
      } catch (err) {
        this.studio.toast("No pude restaurar.", { kind: "bad", detail: err.message });
      }
    }
  }

  Aura.blocksTool = { blocksTool };
})(window.Aura ??= {});
