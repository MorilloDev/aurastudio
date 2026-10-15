"use strict";

// Plantas: grass, flowers and crops built in the browser (a port of the Stylized Foliage Generator add-on) and drawn
// with the game's camera into a sprite with its normal map, depth, AO and grayscale — plus growth stages and seed
// variants saved into consecutive atlas cells. The heavy parts are mesh.js, generators.js and raster.js.
(function (Aura) {
  const { h } = Aura.dom;
  const { section, slider, select, checkbox, segmented, numberPair } = Aura.controls;
  const { decodePng, encodePng } = Aura.png;
  const { downloadBlob } = Aura.fs;
  const { prefs } = Aura.storage;
  const { listSheets } = Aura.normalsSheets;
  const G = Aura.plantGen;
  const R = Aura.plantRaster;
  const Cells = Aura.sheetCells;

  const VIEWS = [["color", "Color"], ["normal", "Normales"], ["depth", "Profundidad"], ["ao", "AO"], ["gray", "Grises"]];
  const MAPS = [["color", ""], ["normal", "_n"], ["depth", "_depth"], ["ao", "_ao"], ["gray", "_gray"]];
  const PREFS_KEY = "plants:settings";
  const VARIANT_DEFAULTS = { stages: 1, seeds: 1 };

  function plantsTool() {
    return new PlantsTool();
  }

  class PlantsTool {
    id = "plants";
    title = "Foliage";
    project = null;
    sheets = [];
    view = "color";
    result = null;
    variantList = [];
    variantResults = new Map();
    previewId = null;
    #pending = 0;

    // ---------------------------------------------------------------------------------------------------------------
    // Setup

    mount(host, studio) {
      this.studio = studio;
      const saved = prefs.get(PREFS_KEY, null);
      this.type = G.TYPES[saved?.type] ? saved.type : "GRASS";
      this.byType = saved?.byType ?? {};
      this.r = R.merge(saved?.render ?? {});
      this.variants = { ...VARIANT_DEFAULTS, ...(saved?.variants ?? {}) };
      this.exportScale = saved?.exportScale ?? 4;
      host.appendChild(this.#buildLayout());
      new ResizeObserver(() => this.#drawPreview()).observe(this.root);
      this.#schedule();
    }

    activate() { this.#drawPreview(); }
    deactivate() {}
    isDirty() { return false; }

    onProject(project) {
      this.project = project;
      this.sheets = listSheets(project);
      this.#fillTargets();
    }

    /** This type's options: its defaults with whatever was changed on top. */
    get o() {
      let saved = this.byType[this.type];
      if (!saved) {
        // First time on this type: start from its first variety (or the one its head / style names), so a sunflower
        // is yellow and a kelp green from the start.
        const t = G.TYPES[this.type], presets = G.PRESETS[this.type];
        const base = G.defaults(this.type);
        const pr = presets?.find((x) => t.presetParam && x.key === base[t.presetParam]) ?? presets?.[0];
        saved = pr ? { ...structuredClone(pr.values), variety: pr.key } : {};
      }
      this.byType[this.type] = { ...G.defaults(this.type), ...saved };
      return this.byType[this.type];
    }

    #save() {
      prefs.set(PREFS_KEY, { type: this.type, byType: this.byType, render: this.r, variants: this.variants, exportScale: this.exportScale });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Layout

    #buildLayout() {
      this.typeList = h("div", { class: "bk-items scroll pl-types" });
      const left = h("div", { class: "bk-list" },
        h("div", { class: "head" }, h("strong", null, "Tipo de planta")),
        this.typeList,
        h("div", { class: "bk-pick" },
          h("p", { class: "note" }, "Las plantas nacen en el suelo de la celda (abajo del rombo) y no se salen del sprite. ",
            "El ", h("b", null, "_n"), " guarda la normal real de cada pixel: el juego la reparte entre arriba, izquierda y derecha. ",
            "«Por caras» la ajusta a los tres colores del cubo.")));
      this.#renderTypes();

      this.viewSeg = segmented({ label: "Vista", value: this.view, options: VIEWS, onChange: (v) => { this.view = v; this.#drawPreview(); this.#drawStrip(); this.#drawVariantStrip(); } });
      this.guideChk = checkbox({ label: "Guías", value: true, onChange: () => this.#drawPreview() });
      this.previewCanvas = h("canvas", { class: "bk-preview" });
      this.previewLabel = h("div", { class: "bk-preview-label" });
      this.strip = h("div", { class: "bk-strip" });
      this.varStrip = h("div", { class: "bk-strip bk-varstrip" });
      const stage = h("div", { class: "bk-stage" },
        h("div", { class: "bk-toolbar" }, this.viewSeg.el, h("span", { class: "grow" }), this.guideChk.el),
        h("div", { class: "bk-view" }, this.previewCanvas, this.previewLabel),
        this.strip, this.varStrip);

      this.root = h("div", { class: "bk" }, left, stage, this.#buildPanel());
      return this.root;
    }

    #renderTypes() {
      // Grouped by where the plant belongs, each with its varieties as a hint.
      const items = [];
      for (const [cat, title] of G.CATEGORIES) {
        const types = Object.entries(G.TYPES).filter(([, t]) => t.category === cat);
        if (!types.length) continue;
        items.push(h("div", { class: "pl-cat" }, title));
        for (const [k, t] of types) {
          const presets = G.PRESETS[k];
          const sub = presets ? presets.map((pr) => pr.label).join(" · ") : t.growth ? "etapas de crecimiento" : "";
          items.push(h("div", { class: ["bk-sheet", k === this.type && "active"], onclick: () => this.#setType(k) },
            h("div", { class: "id" }, t.label), sub && h("div", { class: "path", title: sub }, sub)));
        }
      }
      this.typeList.replaceChildren(...items);
    }

    #setType(k) {
      if (k === this.type) return;
      this.type = k;
      this.previewId = null;
      this.#save();
      this.#renderTypes();
      this.#rebuildPanel();
      this.#schedule();
    }

    /** A control for one schema entry, bound to this type's options. */
    #control([key, label, kind, , min, max, step, title]) {
      const o = this.o;
      const set = (v) => {
        this.o[key] = v;
        // An option that names a variety (a flower's head, pumpkin or melon) also brings that variety's colours.
        if (G.TYPES[this.type].presetParam === key && this.#applyPreset(v)) return;
        this.#save(); this.#schedule();
      };
      const def = G.defaults(this.type)[key];
      if (kind === "color") {
        const input = h("input", { type: "color", value: o[key], title: title ?? "", oninput: (e) => set(e.target.value) });
        return h("div", { class: "field", ondblclick: () => { input.value = def; set(def); } }, h("label", { title: "Doble clic: por defecto" }, label), input);
      }
      if (kind === "bool") return checkbox({ label, value: o[key], title: title ?? "", onChange: set }).el;
      if (Array.isArray(kind)) return select({ label, value: o[key], options: kind, title: title ?? "", onChange: set }).el;
      return slider({ label, min, max, step, value: o[key], defaultValue: def, title: title ?? "",
        onInput: (v) => set(kind === "int" ? Math.round(v) : v) }).el;
    }

    /** Applies a variety of the current type: its shape and colours, which stay editable. False if there is none. */
    #applyPreset(key) {
      const pr = G.PRESETS[this.type]?.find((x) => x.key === key);
      if (!pr) return false;
      Object.assign(this.o, structuredClone(pr.values), { variety: key });
      this.#save();
      this.#rebuildPanel();
      this.#schedule();
      return true;
    }

    #sectionReset(run) {
      return h("span", { class: "bk-reset", role: "button", tabindex: 0, title: "Restablecer esta sección",
        onclick: (e) => { e.stopPropagation(); run(); },
        onkeydown: (e) => { if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); run(); } } }, "↺");
    }

    #schemaSection(id, title, list) {
      return section({ id: "pl-" + id, title,
        extra: this.#sectionReset(() => {
          const d = G.defaults(this.type);
          for (const [key] of list) this.o[key] = d[key];
          this.#save(); this.#rebuildPanel(); this.#schedule();
        }) }, ...list.map((entry) => this.#control(entry)));
    }

    // Render options, bound to this.r.
    #rSlider(label, path, min, max, step, title = "") {
      const get = (o) => path.split(".").reduce((x, k) => x[k], o);
      return slider({ label, min, max, step, value: get(this.r), defaultValue: get(R.DEFAULTS), title,
        onInput: (v) => this.#rSet(path, v) }).el;
    }
    #rCheck(label, key, title = "") {
      return checkbox({ label, value: this.r[key], title, onChange: (v) => this.#rSet(key, v) }).el;
    }
    #rSet(path, v) {
      const keys = path.split(".");
      const last = keys.pop();
      keys.reduce((x, k) => x[k], this.r)[last] = v;
      this.#save();
      this.#schedule();
    }

    #buildPanel() {
      const t = G.TYPES[this.type];
      const sections = [];
      const presets = G.PRESETS[this.type];
      if (presets) {
        // Variety first: it sets the plant's look and colours in one go; everything below stays editable.
        const current = this.o.variety ?? (t.presetParam ? this.o[t.presetParam] : "");
        const varSel = select({ label: "Variedad", value: presets.some((pr) => pr.key === current) ? current : "",
          options: [["", "— personalizada —"], ...presets.map((pr) => [pr.key, pr.label])],
          title: "Pone la forma y los colores de esa variedad; luego puedes cambiar lo que quieras",
          onChange: (v) => { if (v) this.#applyPreset(v); } });
        sections.push(section({ id: "pl-variety", title: "Variedad" }, varSel.el,
          h("div", { class: "pl-presets" }, presets.map((pr) => h("button", { class: pr.key === current ? "on" : "", onclick: () => this.#applyPreset(pr.key) }, pr.label)))));
      }
      for (const [title, list] of Object.entries(t.params)) sections.push(this.#schemaSection("own-" + title, title, list));
      for (const [title, list] of Object.entries(G.COMMON)) sections.push(this.#schemaSection("common-" + title, title, list));

      const light = section({ id: "pl-light", title: "Luz y mapas",
        extra: this.#sectionReset(() => {
          for (const k of ["shading", "shade", "normals", "ao", "aoDistance", "aoStrength", "aoSteps", "aoSamples", "aoGround"]) this.r[k] = structuredClone(R.DEFAULTS[k]);
          this.#save(); this.#rebuildPanel(); this.#schedule();
        }) },
        this.#rCheck("Luz por caras (como los materiales)", "shading"),
        this.#rSlider("Arriba", "shade.top", 0, 1.5, 0.01),
        this.#rSlider("Izquierda", "shade.left", 0, 1.5, 0.01),
        this.#rSlider("Derecha", "shade.right", 0, 1.5, 0.01),
        h("div", { class: "field" }, h("label", null, "Normales"),
          segmented({ label: "Normales", value: this.r.normals, options: [["smooth", "Reales"], ["faces", "Por caras"]],
            onChange: (v) => this.#rSet("normals", v) }).el),
        this.#rCheck("Oclusión ambiental (AO)", "ao"),
        this.#rCheck("El suelo también tapa", "aoGround", "La base de la planta se oscurece contra el suelo"),
        this.#rSlider("Distancia AO", "aoDistance", 0.02, 0.5, 0.01, "En bloques"),
        this.#rSlider("Fuerza AO", "aoStrength", 0, 1, 0.01),
        this.#rSlider("Escalones AO", "aoSteps", 0, 8, 1),
        this.#rSlider("Muestras AO", "aoSamples", 4, 48, 1));

      const pixel = section({ id: "pl-pixel", title: "Pixel art",
        extra: this.#sectionReset(() => {
          for (const k of ["supersample", "coverage", "lightSteps", "outline", "grayFromColor"]) this.r[k] = R.DEFAULTS[k];
          this.#save(); this.#rebuildPanel(); this.#schedule();
        }) },
        this.#rSlider("Muestreo", "supersample", 1, 4, 1, "Muestras por lado de cada pixel: más = bordes más fieles"),
        this.#rSlider("Cobertura mínima", "coverage", 1, 9, 1, "Muestras que necesita un pixel para pintarse (1 = no se pierde nada fino)"),
        this.#rSlider("Pasos de luz", "lightSteps", 0, 8, 1, "0 = suave; pocos pasos = sombreado por bandas"),
        this.#rSlider("Contorno", "outline", 0, 0.8, 0.01),
        this.#rCheck("Grises con el color", "grayFromColor"));

      const variantControls = [];
      if (t.growth) {
        variantControls.push(slider({ label: "Etapas", min: 1, max: 8, step: 1, value: this.variants.stages, defaultValue: 1,
          title: "1 = solo el crecimiento elegido; más = de brote a maduro, repartidas",
          onInput: (v) => { this.variants.stages = v; this.#save(); this.#schedule(); } }).el);
      }
      variantControls.push(slider({ label: "Semillas", min: 1, max: 8, step: 1, value: this.variants.seeds, defaultValue: 1,
        title: "Versiones distintas de la misma planta, para que no se repita en el mundo",
        onInput: (v) => { this.variants.seeds = v; this.#save(); this.#schedule(); } }).el);
      const variants = section({ id: "pl-variants", title: "Variantes" }, ...variantControls);

      this.sizeSel = select({ label: "Tamaño sprite", value: String(this.r.size),
        options: [["32", "32 px"], ["48", "48 px"], ["64", "64 px"], ["96", "96 px"], ["128", "128 px"]],
        onChange: (v) => this.#rSet("size", Number(v)) });
      this.targetSel = select({ label: "Hoja destino", value: "", options: [["", "— abre la carpeta —"]] });
      this.targetCell = numberPair({ label: "Celda X / Y", values: [0, 0], min: 0, max: 4096, titles: ["Columna", "Fila"] });
      this.saveN = checkbox({ label: "Guardar también el _n", value: true });
      this.scaleSel = select({ label: "Escala descarga", value: String(this.exportScale),
        options: [["1", "×1"], ["2", "×2"], ["4", "×4"], ["8", "×8"]],
        onChange: (v) => { this.exportScale = Number(v); this.#save(); } });
      this.mapChecks = MAPS.map(([k]) => checkbox({ label: { color: "Color", normal: "Normales", depth: "Profundidad", ao: "AO", gray: "Grises" }[k], value: k === "color" || k === "normal" }));
      this.snippetEl = h("textarea", { class: "bk-snippet", rows: 4, readonly: true, spellcheck: false,
        placeholder: "Aquí salen las celdas guardadas, para el JSON." });
      const output = section({ id: "pl-out", title: "Salida" },
        this.sizeSel.el, this.targetSel.el, this.targetCell.el, this.saveN.el,
        h("button", { class: "primary", onclick: () => this.#saveVariants(), title: "Una celda por variante, seguidas desde la celda X / Y" }, "Guardar variantes en el atlas"),
        h("button", { onclick: () => this.#saveVariants(true), title: "Solo la vista previa, en la celda X / Y" }, "Guardar solo la vista previa"),
        this.snippetEl,
        h("button", { onclick: () => this.#copySnippet() }, "Copiar celdas"),
        h("div", { class: "bk-sep" }),
        h("div", { class: "bk-maps" }, this.mapChecks.map((c) => c.el)),
        this.scaleSel.el,
        h("button", { onclick: () => this.#download() }, "Descargar vista previa"),
        h("button", { onclick: () => this.#downloadVariants() }, "Descargar tira de variantes"));

      this.panelScroll = h("div", { class: "scroll" }, variants.el, ...sections.map((s) => s.el), light.el, pixel.el, output.el);
      this.panel = h("div", { class: "bk-panel" },
        h("div", { class: "bk-panel-head" }, h("span", null, t.label),
          h("button", { title: "Esta planta y la luz a sus valores por defecto", onclick: () => {
            delete this.byType[this.type];
            this.r = R.merge({});
            this.variants = { ...VARIANT_DEFAULTS };
            this.#save(); this.#rebuildPanel(); this.#schedule();
          } }, "Restablecer todo")),
        this.panelScroll);
      return this.panel;
    }

    #rebuildPanel() {
      const top = this.panelScroll?.scrollTop ?? 0;
      this.root.replaceChild(this.#buildPanel(), this.root.children[2]);
      this.panelScroll.scrollTop = top;
      this.#fillTargets();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Render

    #schedule() {
      const ticket = ++this.#pending;
      setTimeout(() => { if (ticket === this.#pending) this.#render(true); }, 40);
    }

    /** Growth stages × seeds of the current plant. Each variant: { id, label, opts, stage, seed }. */
    #variantList() {
      const t = G.TYPES[this.type], o = this.o;
      const stages = t.growth ? Math.max(1, this.variants.stages) : 1;
      const seeds = Math.max(1, this.variants.seeds);
      const out = [];
      for (let s = 0; s < stages; s++) {
        const growth = stages > 1 ? (s + 1) / stages : o.growth;
        for (let v = 0; v < seeds; v++) {
          const opts = { ...o, seed: o.seed + v * 101 };
          if (t.growth) opts.growth = growth;
          const label = [stages > 1 && `Etapa ${s + 1}/${stages}`, seeds > 1 && `semilla ${v + 1}`].filter(Boolean).join(" · ") || "Planta";
          out.push({ id: `s${s}_v${v}`, label, opts, stage: s, seed: v });
        }
      }
      return out;
    }

    #renderOne(v) {
      const mesh = G.build(this.type, v.opts);
      const ground = v.opts.groundZ * Aura.blockEngine.BLOCK_HEIGHT;
      return { ...R.render(mesh, this.r, ground), triangles: mesh.triangles };
    }

    #render(all) {
      this.variantList = this.#variantList();
      const v = this.variantList.find((x) => x.id === this.previewId) ?? this.variantList[0];
      this.previewId = v.id;
      const t0 = performance.now();
      try {
        this.result = this.#renderOne(v);
      } catch (err) {
        this.studio.toast("No pude generar la planta.", { kind: "bad", detail: err.message });
        return;
      }
      this.studio.slot?.("pl-time", `${Math.round(performance.now() - t0)} ms · ${this.result.triangles} triángulos`, "Tiempo de generación");
      this.previewLabel.textContent = `${G.TYPES[this.type].label} · ${v.label}`;
      this.#drawPreview();
      this.#drawStrip();
      if (all) this.#renderVariants();
      else this.#drawVariantStrip();
    }

    #renderVariants() {
      const ticket = this.#pending;
      this.variantResults = new Map([[this.previewId, this.result]]);
      this.#drawVariantStrip();
      const list = this.variantList.filter((v) => v.id !== this.previewId);
      let n = 0;
      // One variant per tick, so dragging a slider never waits for the whole set.
      const next = () => {
        if (ticket !== this.#pending || n >= list.length) return;
        const v = list[n++];
        try {
          this.variantResults.set(v.id, this.#renderOne(v));
        } catch {
          return;
        }
        this.#drawVariantThumb(v);
        setTimeout(next, 0);
      };
      setTimeout(next, 0);
    }

    #allVariantResults() {
      return this.variantList.map((v) => {
        if (!this.variantResults.has(v.id)) this.variantResults.set(v.id, this.#renderOne(v));
        return { variant: v, result: this.variantResults.get(v.id) };
      });
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
      if (!this.result) return;
      const S = this.result.size;
      const zoom = Math.max(1, Math.floor(Math.min(c.width, c.height) * 0.9 / S));
      const ox = Math.floor((c.width - S * zoom) / 2), oy = Math.floor((c.height - S * zoom) / 2);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        ctx.fillStyle = (x >> 2 ^ y >> 2) & 1 ? "#2f3338" : "#383d43";
        ctx.fillRect(ox + x * zoom, oy + y * zoom, zoom, zoom);
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.#imageCanvas(this.result[this.view], S), ox, oy, S * zoom, S * zoom);
      if (!this.guideChk.get()) return;
      ctx.strokeStyle = "rgba(255,255,255,.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(ox - 0.5, oy - 0.5, S * zoom + 1, S * zoom + 1);
      // The cell's ground: where the plants are rooted.
      const H = Aura.blockEngine.BLOCK_HEIGHT, z = this.o.groundZ * H;
      const pts = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => {
        const [px, py] = Aura.blockEngine.project([x, y, z], S, H);
        return [ox + px * zoom, oy + py * zoom];
      });
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(120,220,160,.55)";
      ctx.stroke();
      // The water's surface, for plants that live in or on it.
      const mode = G.waterMode(this.type, this.o);
      if (mode !== "LAND") {
        const zw = z + this.o.waterDepth * H;
        const wp = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => {
          const [px, py] = Aura.blockEngine.project([x, y, zw], S, H);
          return [ox + px * zoom, oy + py * zoom];
        });
        ctx.beginPath();
        wp.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fillStyle = "rgba(70,140,230,.10)";
        ctx.fill();
        ctx.strokeStyle = "rgba(110,170,255,.7)";
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    #drawStrip() {
      if (!this.result) { this.strip.replaceChildren(); return; }
      const S = this.result.size;
      this.strip.replaceChildren(...VIEWS.map(([k, t]) => {
        const c = h("canvas", { width: S, height: S, title: t, class: k === this.view ? "on" : "",
          onclick: () => { this.view = k; this.viewSeg.set(k); this.#drawPreview(); this.#drawStrip(); this.#drawVariantStrip(); } });
        c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(this.result[k]), S, S), 0, 0);
        return h("div", { class: "bk-thumb" }, c, h("span", null, t));
      }));
    }

    #drawVariantStrip() {
      this.variantThumbs = new Map();
      if (this.variantList.length <= 1) { this.varStrip.replaceChildren(); this.varStrip.hidden = true; return; }
      this.varStrip.hidden = false;
      const S = this.result?.size ?? 64;
      this.varStrip.replaceChildren(h("div", { class: "bk-strip-title" }, `Variantes (${this.variantList.length})`),
        ...this.variantList.map((v) => {
          const c = h("canvas", { width: S, height: S, title: v.label, class: v.id === this.previewId ? "on" : "",
            onclick: () => { this.previewId = v.id; this.#render(false); } });
          this.variantThumbs.set(v.id, c);
          return h("div", { class: "bk-thumb" }, c, h("span", null, v.label));
        }));
      for (const v of this.variantList) if (this.variantResults.has(v.id)) this.#drawVariantThumb(v);
    }

    #drawVariantThumb(v) {
      const c = this.variantThumbs?.get(v.id), r = this.variantResults.get(v.id);
      if (!c || !r) return;
      if (c.width !== r.size) c.width = c.height = r.size;
      c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(r[this.view]), r.size, r.size), 0, 0);
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
      return this.type.toLowerCase() + (this.type === "FLOWER" ? "_" + this.o.headShape.toLowerCase() : "");
    }

    async #download() {
      if (!this.result) return;
      const S = this.result.size, k = this.exportScale;
      let n = 0;
      for (let i = 0; i < MAPS.length; i++) {
        if (!this.mapChecks[i].get()) continue;
        const [key, suffix] = MAPS[i];
        const rgba = k > 1 ? Aura.blockEngine.upscale(this.result[key], S, k) : this.result[key];
        downloadBlob(await encodePng(S * k, S * k, new Uint8ClampedArray(rgba)), `${this.#baseName()}_${this.previewId}${suffix}${k > 1 ? "@" + k + "x" : ""}.png`);
        n++;
      }
      this.studio.setStatus(n ? `Descargados ${n} PNG.` : "Marca qué mapas descargar.", n ? "ok" : "warn");
    }

    async #downloadVariants() {
      const all = this.#allVariantResults();
      let n = 0;
      for (let m = 0; m < MAPS.length; m++) {
        if (!this.mapChecks[m].get()) continue;
        const [key, suffix] = MAPS[m];
        const k = this.exportScale;
        downloadBlob(await Cells.strip(all.map((a) => a.result), key, k), `${this.#baseName()}_variantes${suffix}${k > 1 ? "@" + k + "x" : ""}.png`);
        n++;
      }
      this.studio.setStatus(n ? `Descargadas ${n} tiras con ${all.length} variantes.` : "Marca qué mapas descargar.", n ? "ok" : "warn");
    }

    /** Saves every variant (or only the preview) into cells from X / Y, and lists the cells for the JSON. */
    async #saveVariants(onlyPreview = false) {
      if (!this.result) return;
      const sheet = this.sheets.find((s) => s.key === this.targetSel.get());
      if (!this.project || !sheet) {
        this.studio.toast("Abre la carpeta del proyecto y elige la hoja destino.", { kind: "warn" });
        return;
      }
      try {
        await this.studio.busy((async () => {
          const all = onlyPreview
            ? [{ variant: this.variantList.find((v) => v.id === this.previewId), result: this.result }]
            : this.#allVariantResults();
          const S = all[0].result.size;
          const sheetImg = await decodePng(await sheet.entry.handle.getFile());
          const cells = Cells.layoutCells(this.targetCell.get(), all.length, Math.floor(sheetImg.w / S));
          const items = all.map((a, i) => ({ ...a, cell: cells[i] }));
          const ctx = { project: this.project, studio: this.studio };
          Cells.announce(ctx, sheet, items, await Cells.writeCells(ctx, sheet, items, { saveN: this.saveN.get(), sheetImg }));
          this.snippetEl.value = this.#snippet(items);
          this.#copySnippet(true);
        })());
      } catch (err) {
        this.studio.toast("No pude guardar.", { kind: "bad", detail: err.message });
      }
    }

    /**
     * The saved cells as JSON: "stages" for growth stages (one list of seed variants per stage when there are several),
     * "variants" for seeds only. A proposal to wire into the decoration / crop JSON, which has no such key yet.
     */
    #snippet(items) {
      const stages = Math.max(...items.map((i) => i.variant.stage)) + 1;
      const seeds = Math.max(...items.map((i) => i.variant.seed)) + 1;
      const cell = (i) => JSON.stringify(i.cell).replace(",", ", ");
      if (items.length === 1) return `"art": { "default": { "front": ${cell(items[0])} } }`;
      if (stages > 1) {
        const rows = Array.from({ length: stages }, (_, s) => {
          const list = items.filter((i) => i.variant.stage === s).map(cell);
          return "    " + (seeds > 1 ? `[${list.join(", ")}]` : list[0]);
        });
        return `"stages": [\n${rows.join(",\n")}\n]`;
      }
      return `"variants": [ ${items.map(cell).join(", ")} ]`;
    }

    async #copySnippet(quiet = false) {
      if (!this.snippetEl.value) { if (!quiet) this.studio.toast("Guarda primero.", { kind: "warn" }); return; }
      try {
        await navigator.clipboard.writeText(this.snippetEl.value);
        if (!quiet) this.studio.toast("Celdas copiadas.", { kind: "ok" });
      } catch {
        // Clipboard needs a focused, permitted page; the text stays selectable in the box.
        this.snippetEl.select();
      }
    }
  }

  Aura.plantsTool = { plantsTool };
})(window.Aura ??= {});
