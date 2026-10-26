"use strict";

// Plants: grass, flowers and crops built in the browser (a port of the Stylized Foliage Generator add-on) and drawn
// with the game's camera into a sprite with its normal map, depth, AO and grayscale — plus growth stages and seed
// variants saved into consecutive atlas cells. The heavy parts are mesh.js, generators.js and raster.js.
(function (Aura) {
  const { h } = Aura.dom;
  const { section, slider, select, checkbox, segmented, numberPair, detailSwitch } = Aura.controls;
  const { decodePng, encodePng } = Aura.png;
  const { downloadBlob } = Aura.fs;
  const { prefs } = Aura.storage;
  const { listSheets } = Aura.sheetFiles;
  const G = Aura.plantGen;
  const R = Aura.plantRaster;
  const Cells = Aura.sheetCells;
  const Tint = Aura.tint;
  const TP = Aura.tintPanel;
  const { ContextView } = Aura.contextView;

  const VIEWS = [["color", "Color"], ["tinted", "Bioma"], ["normal", "Normales"], ["depth", "Profundidad"], ["ao", "AO"], ["gray", "Grises"]];
  const MAPS = [["color", ""], ["normal", "_n"], ["depth", "_depth"], ["ao", "_ao"], ["gray", "_gray"]];
  const PREFS_KEY = "plants:settings";
  const VARIANT_DEFAULTS = { stages: 1, seeds: 1 };
  // Size of the variety and variation pictures, and how many variations.
  const THUMB = 48;
  const GALLERY = 6;
  // Growth export (phase 5): what each growing type becomes in the game. Stage plants are a chain of tiles
  // (id_0 → id_1 → …, "growth": { "next", "days" }); column plants a base with its middle and top tiles.
  const STAGE_ITEMS = {
    WHEAT: ["Wheat", "Wheat Seeds"], CARROT: ["Carrot", "Carrot"], POTATO: ["Potato", "Potato"],
    CORN: ["Corn", "Corn Seeds"], PUMPKIN: ["Pumpkin", "Pumpkin Seeds"],
  };
  const COLUMN_TYPES = {
    BAMBOO: { product: "Bamboo", on: ["dirt", "grass", "sand"], maxHeight: 6, opts: {} },
    SUGAR_CANE: { product: "Sugar Cane", on: ["sand", "dirt", "grass"], maxHeight: 5, opts: {} },
    PAPYRUS: { product: "Papyrus", on: ["sand", "dirt", "grass"], maxHeight: 4, opts: { waterMode: "LAND" } },
    SEAWEED: { product: "Kelp", on: ["sand", "dirt", "stone"], maxHeight: 0, habitat: "submerged", opts: { waterDepth: 3.2, waterFill: true } },
  };
  const HABITATS = { UNDERWATER: "submerged", EMERGENT: "emergent", SURFACE: "floating" };
  const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  // Variety pictures depend only on the type and the variety, so they are drawn once per session.
  const thumbCache = new Map();

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
      // Light and pixel-art options per plant type: a flat gray leaf style must not turn the grass flat too. A type
      // seen for the first time starts from the shared ones.
      this.rDefault = R.merge(saved?.render ?? {});
      this.rByType = {};
      for (const [k, v] of Object.entries(saved?.renderByType ?? {})) this.rByType[k] = R.merge(v);
      this.variants = { ...VARIANT_DEFAULTS, ...(saved?.variants ?? {}) };
      this.exportScale = saved?.exportScale ?? 4;
      this.tint = Tint.merge(saved?.tint);
      this.biomes = [Tint.DEFAULT_TINT];
      this.#loadBiomes();
      host.appendChild(this.#buildLayout());
      this.ctx = new ContextView(this.viewEl, { biomes: this.biomes });
      this.#showContext(this.contextChk.get());
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
      this.#loadBiomes();
    }

    async #loadBiomes() {
      this.biomes = await Tint.listBiomes(this.project);
      this.ctx?.setBiomes(this.biomes);
      if (this.panelScroll) this.#rebuildPanel();
    }

    /** This type's render options (light, maps, pixel art). */
    get r() { return (this.rByType[this.type] ??= R.merge(structuredClone(this.rDefault))); }
    set r(v) { this.rByType[this.type] = v; }

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
        if (pr?.render && !this.rByType[this.type]) this.r = R.merge({ ...structuredClone(this.rDefault), ...structuredClone(pr.render) });
      }
      this.byType[this.type] = { ...G.defaults(this.type), ...saved };
      return this.byType[this.type];
    }

    #save() {
      prefs.set(PREFS_KEY, { type: this.type, byType: this.byType, render: this.rDefault, renderByType: this.rByType, variants: this.variants, exportScale: this.exportScale, tint: this.tint });
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
      this.contextChk = checkbox({ label: "Contexto", value: prefs.get("plants:context", false), title: "3 × 3 en el mundo, sobre bloques de hierba: bioma, luz del día, viento",
        onChange: (v) => { prefs.set("plants:context", v); this.#showContext(v); } });
      this.previewCanvas = h("canvas", { class: "bk-preview" });
      this.previewLabel = h("div", { class: "bk-preview-label" });
      this.strip = h("div", { class: "bk-strip" });
      this.varStrip = h("div", { class: "bk-strip bk-varstrip" });
      const stage = h("div", { class: "bk-stage" },
        h("div", { class: "bk-toolbar" }, this.viewSeg.el, h("span", { class: "grow" }), this.contextChk.el, this.guideChk.el),
        this.viewEl = h("div", { class: "bk-view" }, this.previewCanvas, this.previewLabel),
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
      // A variety with a look of its own ("render", the flat leaves) brings its light and pixel-art settings; leaving it
      // for one without gives those settings back.
      const prev = G.PRESETS[this.type].find((x) => x.key === this.o.variety);
      if (pr.render) this.r = R.merge({ ...this.r, ...structuredClone(pr.render) });
      else if (prev?.render) for (const k of Object.keys(prev.render)) this.r[k] = structuredClone(this.rDefault[k]);
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
    #rColor(label, key, title = "") {
      const input = h("input", { type: "color", value: this.r[key], title, oninput: (e) => this.#rSet(key, e.target.value) });
      return h("div", { class: "field", ondblclick: () => { input.value = R.DEFAULTS[key]; this.#rSet(key, R.DEFAULTS[key]); } },
        h("label", { title: "Doble clic: por defecto" }, label), input);
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
        // Variety first, as cards with a picture of each: it sets the plant's look and colours in one go; everything
        // below stays editable.
        const current = this.o.variety ?? (t.presetParam ? this.o[t.presetParam] : "");
        const known = presets.find((pr) => pr.key === current);
        const cards = h("div", { class: "pl-cards" }, presets.map((pr) => {
          const c = h("canvas", { width: THUMB, height: THUMB });
          this.#queueThumb(`${this.type}|${pr.key}`, c, () => ({ ...G.defaults(this.type), ...structuredClone(pr.values) }),
            pr.render ? { ...this.rDefault, ...pr.render } : this.rDefault);
          return h("button", { class: ["pl-card", pr.key === current && "on"], title: pr.label, onclick: () => this.#applyPreset(pr.key) },
            c, h("span", null, pr.label));
        }));
        sections.push(section({ id: "pl-variety", title: "Variedad", extra: known ? known.label : "personalizada" }, cards));
      }
      // Other random seeds of exactly these settings: the quickest way to find a nicer one.
      this.galleryEl = h("div", { class: "pl-gallery" });
      sections.push(section({ id: "pl-gallery", title: "Variaciones",
        extra: h("span", { class: "bk-reset", role: "button", tabindex: 0, title: "Otras seis", onclick: (e) => { e.stopPropagation(); this.galleryBase = null; this.#fillGallery(); } }, "⟳") },
        this.galleryEl, h("p", { class: "note" }, "La misma planta con otra semilla aleatoria. Clic para quedarte con esa.")));
      for (const [title, list] of Object.entries(t.params)) sections.push(this.#schemaSection("own-" + title, title, list));
      // A type may list the shared groups that mean something for it (a leaf block has no spacing, water or parts).
      for (const [title, list] of Object.entries(G.COMMON)) {
        if (!t.common || t.common.includes(title)) {
          const sec = this.#schemaSection("common-" + title, title, list);
          if (title !== "Colores") sec.el.classList.add("adv");
          sections.push(sec);
        }
      }

      const light = section({ id: "pl-light", title: "Luz y mapas",
        extra: this.#sectionReset(() => {
          for (const k of ["shading", "shade", "normals", "ao", "aoDistance", "aoStrength", "aoSteps", "aoSamples", "aoGround",
            "depthShade", "depthTint", "depthCurve", "depthMode"]) this.r[k] = structuredClone(R.DEFAULTS[k]);
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
        this.#rSlider("Muestras AO", "aoSamples", 4, 48, 1),
        this.#rSlider("Sombra por profundidad", "depthShade", 0, 1, 0.01, "Lo que está más atrás se oscurece hacia el tono; queda dentro del sprite (el juego no lee la profundidad)"),
        this.#rColor("Tono del fondo", "depthTint", "Se multiplica con el color en lo más profundo"),
        this.#rSlider("Curva", "depthCurve", 0.25, 4, 0.05, "Más de 1: solo lo más profundo; menos de 1: llega más adelante"),
        h("div", { class: "field" }, h("label", null, "Profundidad"),
          segmented({ label: "Profundidad", value: this.r.depthMode, options: [["back", "Hacia atrás"], ["view", "Atrás y abajo"]],
            onChange: (v) => this.#rSet("depthMode", v) }).el));

      const pixel = section({ id: "pl-pixel", title: "Pixel art",
        extra: this.#sectionReset(() => {
          for (const k of ["supersample", "coverage", "lightSteps", "toneSteps", "innerEdges", "innerEdgeGap", "monochrome", "outline", "grayFromColor"]) this.r[k] = R.DEFAULTS[k];
          this.#save(); this.#rebuildPanel(); this.#schedule();
        }) },
        this.#rSlider("Muestreo", "supersample", 1, 4, 1, "Muestras por lado de cada pixel: más = bordes más fieles"),
        this.#rSlider("Cobertura mínima", "coverage", 1, 9, 1, "Muestras que necesita un pixel para pintarse (1 = no se pierde nada fino)"),
        this.#rSlider("Pasos de luz", "lightSteps", 0, 8, 1, "0 = suave; pocos pasos = sombreado por bandas"),
        this.#rSlider("Tonos", "toneSteps", 0, 10, 1, "0 = sin cambios; n = el sprite queda en n tonos planos repartidos entre su pixel más oscuro y el más claro (una hoja, un tono)"),
        this.#rSlider("Borde entre hojas", "innerEdges", 0, 0.6, 0.01, "Oscurece una línea fina donde una hoja tapa a otra, para que se lean por separado"),
        this.#rSlider("Salto del borde", "innerEdgeGap", 0.01, 0.2, 0.005, "Cuánto más cerca tiene que estar la hoja de delante para marcar la línea, en bloques"),
        this.#rCheck("Gris (para biome_tinted)", "monochrome", "El color sale en grises con su propio brillo: el juego lo tiñe con el color del bioma"),
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
        h("button", { onclick: () => this.#sendToAtlas(), title: "Abre la pestaña Atlas para elegir las celdas viendo la hoja; allí mismo creas su tile" }, "Enviar al Atlas →"),
        h("button", { class: "primary", onclick: () => this.#addToComposer(),
          title: "Mete la vista previa actual como una capa del Composer" }, "Añadir al Composer"),
        this.snippetEl,
        h("button", { onclick: () => this.#copySnippet() }, "Copiar celdas"),
        h("div", { class: "bk-sep" }),
        h("div", { class: "bk-maps" }, this.mapChecks.map((c) => c.el)),
        this.scaleSel.el,
        h("button", { onclick: () => this.#download() }, "Descargar vista previa"),
        h("button", { onclick: () => this.#downloadVariants() }, "Descargar tira de variantes"));

      this.tintUi = TP.tintSection({ id: "pl-tint", state: this.tint, biomes: this.biomes,
        onChange: () => { this.#save(); this.#schedule(); } });
      const growth = this.#growthSection();
      this.panelScroll = h("div", { class: "scroll" }, variants.el, ...sections.map((s) => s.el), this.tintUi.el, growth?.el, light.el, pixel.el, output.el);
      light.el.classList.add("adv");
      pixel.el.classList.add("adv");
      const detail = h("span");
      this.panel = h("div", { class: "bk-panel" },
        h("div", { class: "bk-panel-head" }, h("span", null, t.label), detail,
          h("button", { title: "Esta planta y la luz a sus valores por defecto", onclick: () => {
            delete this.byType[this.type];
            this.r = R.merge({});
            this.variants = { ...VARIANT_DEFAULTS };
            this.#save(); this.#rebuildPanel(); this.#schedule();
          } }, "↺ Todo")),
        this.panelScroll);
      detail.replaceWith(detailSwitch(this.panel));
      return this.panel;
    }

    // ── Pictures for the panel, drawn one per tick after the main preview so dragging a slider never waits for them.

    #thumbJobs = [];
    #thumbTimer = 0;

    #queueThumb(key, canvas, optsFn, render = null) {
      const cached = key && thumbCache.get(key);
      if (cached) { paintThumb(canvas, cached); return; }
      this.#thumbJobs.push({ key, canvas, optsFn, render });
      if (!this.#thumbTimer) this.#thumbTimer = setTimeout(() => this.#runThumbs(), 120);
    }

    #runThumbs() {
      this.#thumbTimer = 0;
      const job = this.#thumbJobs.shift();
      if (!job) return;
      if (job.canvas.isConnected) {
        try {
          const img = this.#thumbImage(job.optsFn(), job.render);
          if (job.key) thumbCache.set(job.key, img);
          paintThumb(job.canvas, img);
        } catch {
          // A picture that fails is just left blank; the preview reports real errors.
        }
      }
      if (this.#thumbJobs.length) this.#thumbTimer = setTimeout(() => this.#runThumbs(), 0);
    }

    // Small and cheap: no AO, no supersampling; the parts of a tall plant stacked.
    #thumbImage(opts, render = null) {
      const mesh = G.build(this.type, opts);
      const ground = (opts.groundZ ?? 0) * Aura.blockEngine.BLOCK_HEIGHT;
      const parts = R.renderParts(mesh, R.merge({ ...(render ?? this.r), size: THUMB, ao: false, supersample: 2 }), ground, mesh.cells);
      return stack(parts);
    }

    #fillGallery() {
      if (!this.galleryEl) return;
      this.galleryBase ??= 1 + Math.floor(Math.random() * 9000);
      const o = this.o;
      this.galleryEl.replaceChildren(...Array.from({ length: GALLERY }, (_, k) => {
        const seed = ((this.galleryBase + k * 997) % 9999) + 1;
        const c = h("canvas", { width: THUMB, height: THUMB });
        this.#queueThumb(null, c, () => ({ ...o, seed }));
        return h("button", { class: "pl-card", title: "Semilla " + seed, onclick: () => { this.o.seed = seed; this.#save(); this.#rebuildPanel(); this.#schedule(); } }, c);
      }));
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

    /**
     * One variant: its parts (one sprite per cell, bottom first) plus each map stacked into one tall picture, the
     * parts drawn one cell height apart the way the game piles them up (upper parts over lower ones).
     */
    #renderOne(v) {
      const mesh = G.build(this.type, v.opts);
      const ground = v.opts.groundZ * Aura.blockEngine.BLOCK_HEIGHT;
      const parts = R.renderParts(mesh, this.r, ground, mesh.cells);
      // biome_tinted: what is saved is the grey art; "tinted" is that art under the preview biome, as the game draws it.
      const previewRgb = TP.previewRgb(this.tint, this.biomes);
      for (const part of parts) {
        if (this.tint.enabled) part.color = Tint.toTinted(part.color, TP.resolve(this.tint, this.biomes));
        part.tinted = this.tint.enabled ? Tint.applyTint(part.color, previewRgb) : part.color;
      }
      const S = parts[0].size, step = S / 2, w = S, hgt = S + (parts.length - 1) * step;
      const out = { size: S, w, h: hgt, parts, cells: parts.length, triangles: mesh.triangles };
      for (const key of [...MAPS.map(([k]) => k), "tinted"]) {
        const img = new Uint8ClampedArray(w * hgt * 4);
        parts.forEach((part, k) => {
          const oy = hgt - S - k * step;
          for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
            const si = (y * S + x) * 4;
            if (!part[key][si + 3]) continue;
            img.set(part[key].subarray(si, si + 4), ((oy + y) * w + x) * 4);
          }
        });
        out[key] = img;
      }
      return out;
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
      this.tintUi?.setStats(this.tint.enabled ? Tint.analyze(this.result.color) : null);
      this.#updateContext();
      clearTimeout(this.galleryTimer);
      this.galleryTimer = setTimeout(() => this.#fillGallery(), 400);
      const cells = this.result.cells > 1 ? ` · ${this.result.cells} celdas` : "";
      this.previewLabel.textContent = `${G.TYPES[this.type].label} · ${v.label}${cells}`;
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
        if (n >= list.length) this.#updateContext();
        setTimeout(next, 0);
      };
      setTimeout(next, 0);
    }

    // ── Growth export ──

    /** This type's export settings: ids and names from its label, its own items and day range, all editable. */
    get growthOut() {
      this.byGrowth ??= prefs.get("plants:growth", {});
      const t = G.TYPES[this.type], col = COLUMN_TYPES[this.type];
      const [product, seeds] = STAGE_ITEMS[this.type] ?? [col?.product ?? t.label, ""];
      const base = { id: slug(col?.product ?? product), name: col?.product ?? product, days: col ? [0.5, 1] : [1, 2], product, seeds, maxHeight: col?.maxHeight ?? 5 };
      return (this.byGrowth[this.type] = { ...base, ...(this.byGrowth[this.type] ?? {}) });
    }

    #growthSection() {
      const t = G.TYPES[this.type], col = COLUMN_TYPES[this.type];
      if (!t.growth && !col) return null;
      const g = this.growthOut;
      const save = () => prefs.set("plants:growth", this.byGrowth);
      const text = (label, key, title) => {
        const input = h("input", { type: "text", value: g[key], spellcheck: false, title, onchange: () => { g[key] = input.value.trim(); save(); } });
        return h("div", { class: "field" }, h("label", null, label), input);
      };
      const days = numberPair({ label: "Días por paso", values: g.days, min: 0, max: 100, titles: ["Mínimo", "Máximo"],
        onChange: ([a, b]) => { g.days = [Math.max(0.05, a), Math.max(0.05, a, b)]; save(); } });
      days.inputs.forEach((i) => { i.step = "0.1"; });
      const rows = col
        ? [text("Id", "id"), text("Nombre", "name"), days.el, text("Producto", "product", "El item que suelta"),
          slider({ label: "Altura máx.", min: 0, max: 16, step: 1, value: g.maxHeight, defaultValue: col.maxHeight,
            title: "0 = crece hasta que algo lo pare (un techo, la superficie del agua)", onChange: (v) => { g.maxHeight = v; save(); } }).el,
          h("p", { class: "note" }, "Se dibuja una columna de 3 y se corta en ", h("b", null, "base, medio y punta"), ": tres tiles que encajan apilados.")]
        : [text("Id", "id", "Las etapas serán id_0, id_1…"), text("Nombre", "name"), days.el,
          text("Producto", "product", "Lo que suelta la última etapa"), text("Semillas", "seeds", "Item que la planta (vacío o igual al producto: se planta el producto)"),
          h("p", { class: "note" }, `Etapas: las de Variantes (ahora ${this.variants.stages}). De cada etapa se exporta la semilla 1.`)];
      return section({ id: "pl-growth", title: "Crecimiento" }, ...rows,
        h("button", { class: "primary", onclick: () => (col ? this.#sendColumn() : this.#sendStages()) }, "Enviar crecimiento al Atlas →"));
    }

    // Shared by every tile of a growing set: what the example crops and canes in the game data carry.
    #growthBase() {
      const mode = G.waterMode(this.type, this.o);
      return {
        type: "solid", hardness: 1,
        tags: [...(this.tint.enabled ? ["biome_tinted"] : []), "herb", "fragile", "flammable"].filter((tag) => !(HABITATS[mode] && tag === "flammable")),
        ...(HABITATS[mode] ? { habitat: HABITATS[mode] } : {}),
      };
    }

    #sendStages() {
      const n = this.variants.stages;
      if (n < 2) { this.studio.toast("Pon al menos 2 etapas en Variantes.", { kind: "warn" }); return; }
      const g = this.growthOut, t = G.TYPES[this.type];
      const results = Array.from({ length: n }, (_, s) => {
        const v = this.variantList.find((x) => x.id === `s${s}_v0`);
        if (!this.variantResults.has(v.id)) this.variantResults.set(v.id, this.#renderOne(v));
        return this.variantResults.get(v.id);
      });
      const flat = results.flatMap((r, s) => r.parts.map((part, k) => ({ stage: s, part: k, color: part.color, normal: part.normal, label: `Etapa ${s + 1}` })));
      const seeds = g.seeds && g.seeds !== g.product ? g.seeds : "";
      const crop = t.category === "crops";
      const drop = (item, min, max) => ({ item, chance: 1.0, minQty: min, maxQty: max });
      this.studio.pendingPlacement = {
        label: `${t.label} · ${n} etapas`, name: g.name, id: g.id, kind: "plant", size: results[0].size, sheetKey: this.targetSel.get() || null,
        items: flat,
        buildTiles: (coords, { id, name }) => results.map((r, s) => {
          const cs = coords.filter((_, i) => flat[i].stage === s);
          const last = s === n - 1;
          return {
            id: `${id}_${s}`, name: last ? name : `${name} (${s + 1}/${n})`,
            ...(cs.length === 1 ? { art: { default: { front: cs[0] } } } : { parts: cs.map((c, k) => ({ offsetY: k, art: { default: { front: c } } })) }),
            ...this.#growthBase(),
            placement: { attach: ["floor"], on: crop ? ["farmland"] : ["grass", "dirt"] },
            ...(crop ? { spawnOn: ["grass", "dirt"] } : {}),
            shaderEffect: "wind",
            ...(last ? {} : { growth: { next: `${id}_${s + 1}`, days: g.days } }),
            drops: last
              ? [drop(g.product, 1, 2), ...(seeds ? [drop(seeds, 1, 3)] : [])]
              : [drop(seeds || g.product, 1, 1)],
          };
        }),
        itemsText: () => [
          seeds && `{ "id": "${slug(seeds)}", "name": "${seeds}", "desc": "", "type": "TileItem", "maxStack": 256, "tileType": "herb", "tile": "${g.id}_0" }`,
          seeds ? `{ "id": "${slug(g.product)}", "name": "${g.product}", "desc": "", "type": "Material", "maxStack": 256, "iconCoord": [ 0, 0 ] }`
            : `{ "id": "${slug(g.product)}", "name": "${g.product}", "desc": "", "type": "TileItem", "maxStack": 256, "tileType": "herb", "tile": "${g.id}_0" }`,
        ].filter(Boolean).join(",\n"),
      };
      this.studio.activate("atlas");
    }

    #sendColumn() {
      const g = this.growthOut, col = COLUMN_TYPES[this.type], t = G.TYPES[this.type];
      const v = { id: "column", opts: { ...this.o, ...col.opts, multipart: true, cells: 3, fillCells: true } };
      const r = this.#renderOne(v);
      if (r.parts.length < 3) { this.studio.toast("No salió una columna de 3 celdas.", { kind: "bad" }); return; }
      const roles = ["base", "middle", "top"];
      const flat = r.parts.slice(0, 3).map((part, k) => ({ color: part.color, normal: part.normal, label: roles[k] }));
      const drop = { item: g.product, chance: 1.0, minQty: 1, maxQty: 1 };
      this.studio.pendingPlacement = {
        label: `${t.label} · base, medio y punta`, name: g.name, id: g.id, kind: "plant", size: r.size, sheetKey: this.targetSel.get() || null,
        items: flat,
        buildTiles: (coords, { id, name }) => [
          {
            id, name, art: { default: { front: coords[0] } }, ...this.#growthBase(), ...(col.habitat ? { habitat: col.habitat } : {}),
            placement: { attach: ["floor"], on: col.on }, shaderEffect: "wind",
            growth: { type: "column", maxHeight: g.maxHeight, middle: `${id}_middle`, top: `${id}_top`, days: g.days }, drops: [drop],
          },
          { id: `${id}_middle`, name, art: { default: { front: coords[1] } }, ...this.#growthBase(), shaderEffect: "wind", drops: [drop] },
          { id: `${id}_top`, name, art: { default: { front: coords[2] } }, ...this.#growthBase(), shaderEffect: "wind", drops: [drop] },
        ],
        itemsText: () => `{ "id": "${slug(g.product)}", "name": "${g.product}", "desc": "", "type": "TileItem", "maxStack": 256, "tileType": "herb", "tile": "${g.id}" }`,
      };
      this.studio.activate("atlas");
    }

    #showContext(on) {
      this.previewCanvas.hidden = on;
      this.previewLabel.hidden = on;
      this.ctx?.show(on);
      if (on) this.#updateContext();
      else this.#drawPreview();   // it was hidden (size 0) while the context view was up
    }

    // Every seed variant of the current stage spread over the 3 × 3, so the patch looks like the world, not a stamp.
    #updateContext() {
      if (!this.ctx?.visible || !this.result) return;
      const stage = this.variantList.find((v) => v.id === this.previewId)?.stage ?? 0;
      const variants = [this.result, ...this.variantList.filter((v) => v.id !== this.previewId && v.stage === stage)
        .map((v) => this.variantResults.get(v.id)).filter(Boolean)];
      const t = G.TYPES[this.type], o = this.o;
      const block = this.type === "LEAVES" && o.leafForm === "BLOCK";
      this.ctx.setContent({
        kind: block ? "block" : "plant", size: this.result.size, tinted: this.tint.enabled,
        variants: variants.map((r) => ({ parts: r.parts.map((p) => p.color) })),
        sways: !block && !["leaves", "fungi"].includes(t.category),
      });
    }

    #allVariantResults() {
      return this.variantList.map((v) => {
        if (!this.variantResults.has(v.id)) this.variantResults.set(v.id, this.#renderOne(v));
        return { variant: v, result: this.variantResults.get(v.id) };
      });
    }

    #imageCanvas(rgba, w, hgt = w) {
      const c = new OffscreenCanvas(w, hgt);
      c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), w, hgt), 0, 0);
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
      const S = this.result.size, W = this.result.w, Ht = this.result.h;
      const zoom = Math.max(1, Math.floor(Math.min(c.width / W, c.height / Ht) * 0.9));
      const ox = Math.floor((c.width - W * zoom) / 2), oyTop = Math.floor((c.height - Ht * zoom) / 2);
      for (let y = 0; y < Ht; y++) for (let x = 0; x < W; x++) {
        ctx.fillStyle = (x >> 2 ^ y >> 2) & 1 ? "#2f3338" : "#383d43";
        ctx.fillRect(ox + x * zoom, oyTop + y * zoom, zoom, zoom);
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.#imageCanvas(this.result[this.view], W, Ht), ox, oyTop, W * zoom, Ht * zoom);
      if (!this.guideChk.get()) return;
      ctx.lineWidth = 1;
      // Each part's sprite, bottom one solid, the ones above dashed: what goes into each atlas cell.
      for (let k = 0; k < this.result.cells; k++) {
        const top = oyTop + (Ht - S - k * S / 2) * zoom;
        ctx.strokeStyle = k ? "rgba(255,210,120,.45)" : "rgba(255,255,255,.35)";
        ctx.setLineDash(k ? [6, 4] : []);
        ctx.strokeRect(ox - 0.5, top - 0.5, S * zoom + 1, S * zoom + 1);
      }
      ctx.setLineDash([]);
      // Guides are drawn in the bottom cell's frame.
      const oy = oyTop + (Ht - S) * zoom;
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
        const zw = z + G.waterLevels(this.type, this.o).surface * H;
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
      const { w, h: hgt } = this.result;
      this.strip.replaceChildren(...VIEWS.map(([k, t]) => {
        const c = h("canvas", { width: w, height: hgt, title: t, class: k === this.view ? "on" : "", style: { height: Math.round(64 * hgt / w) + "px" },
          onclick: () => { this.view = k; this.viewSeg.set(k); this.#drawPreview(); this.#drawStrip(); this.#drawVariantStrip(); } });
        c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(this.result[k]), w, hgt), 0, 0);
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
      if (c.width !== r.w || c.height !== r.h) { c.width = r.w; c.height = r.h; c.style.height = Math.round(64 * r.h / r.w) + "px"; }
      c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(r[this.view]), r.w, r.h), 0, 0);
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
        for (const [pi, part] of this.result.parts.entries()) {
          const rgba = k > 1 ? Aura.blockEngine.upscale(part[key], S, k) : part[key];
          const tag = this.result.cells > 1 ? `_p${pi + 1}` : "";
          downloadBlob(await encodePng(S * k, S * k, new Uint8ClampedArray(rgba)), `${this.#baseName()}_${this.previewId}${tag}${suffix}${k > 1 ? "@" + k + "x" : ""}.png`);
          n++;
        }
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
        downloadBlob(await Cells.strip(all.flatMap((a) => a.result.parts), key, k), `${this.#baseName()}_variantes${suffix}${k > 1 ? "@" + k + "x" : ""}.png`);
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
          // One cell per part: a two-tile corn takes two cells, bottom part first.
          const flat = all.flatMap((a) => a.result.parts.map((part, pi) => ({ variant: a.variant, part: pi, parts: a.result.cells, result: part })));
          const S = flat[0].result.size;
          const sheetImg = await decodePng(await sheet.entry.handle.getFile());
          const cells = Cells.layoutCells(this.targetCell.get(), flat.length, Math.floor(sheetImg.w / S));
          const items = flat.map((a, i) => ({ ...a, cell: cells[i] }));
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
     * Hands every variant to the Atlas tab (one cell per part, bottom first). One plant becomes one tile there — a tall
     * one as "parts" stacked upward; stages and seeds are several tiles, so they go over as their cells only.
     */

    /** Público: usado por el hub Crear (overlay). Devuelve true si se aplicó. */
    applyToComposer() {
      return this.#addToComposer(true);
    }

    /**
     * Mete la planta en el Composer. Multipart = cada parte como capa/grupo con offsetY.
     * Las plantas no llevan AO de generador.
     */
    #addToComposer(fromHub = false) {
      if (!this.result) {
        this.studio.toast("Genera una planta antes de añadirla", { kind: "warn" });
        return false;
      }
      const name = this.type || "planta";
      const ok = Aura.composerTool?.queueResult?.(this.result, { name, source: "planta" });
      if (!ok) {
        this.studio.toast("Composer no disponible", { kind: "warn" });
        return false;
      }
      if (!fromHub) {
        try { Aura.storage.prefs.set("create:mode", "composer"); } catch {}
        this.studio.activate?.("create");
        this.studio.tools?.find?.((t) => t.id === "create")?.show?.("composer");
      }
      const n = this.result.parts?.length || 1;
      this.studio.toast(n > 1
        ? ("Planta multipart: " + n + " partes en el Composer")
        : "Planta añadida al Composer", { kind: "ok" });
      return true;
    }


    #sendToAtlas() {
      const all = this.#allVariantResults();
      if (!all.length) return;
      const flat = all.flatMap((a) => a.result.parts.map((part, pi) => ({ variant: a.variant, part: pi, parts: a.result.cells, result: part })));
      const t = G.TYPES[this.type];
      this.studio.pendingPlacement = {
        label: t.label, name: t.label, kind: "plant", size: flat[0].result.size, sheetKey: this.targetSel.get() || null,
        items: flat.map((f) => ({ color: f.result.color, normal: f.result.normal, label: f.variant.label })),
        buildTile: all.length === 1
          ? (coords) => ({
            ...(this.tint.enabled ? { tags: ["biome_tinted"] } : {}),
            ...(coords.length === 1
              ? { art: { default: { front: coords[0] } } }
              : { parts: coords.map((c, i) => ({ offsetY: i, art: { default: { front: c } } })) }),
          })
          : null,
        snippet: (cells) => this.#snippet(flat.map((f, i) => ({ ...f, cell: cells[i] }))),
        why: "Varias etapas o semillas son varios tiles; por ahora copia sus celdas al JSON que toque.",
      };
      this.studio.activate("atlas");
    }

    /**
     * The saved cells as JSON: "stages" for growth stages (one list of seed variants per stage when there are several),
     * "variants" for seeds only; multipart plants give { "parts": [bottom, …, top] } instead of one cell. A proposal to
     * wire into the decoration / crop JSON, which has no such key yet.
     */
    #snippet(allItems) {
      // A multipart variant is listed by its bottom cell plus "parts", every cell bottom to top.
      const items = allItems.filter((i) => i.part === 0);
      const stages = Math.max(...items.map((i) => i.variant.stage)) + 1;
      const seeds = Math.max(...items.map((i) => i.variant.seed)) + 1;
      const cell = (i) => {
        const list = allItems.filter((x) => x.variant === i.variant).map((x) => JSON.stringify(x.cell).replace(",", ", "));
        return list.length > 1 ? `{ "parts": [${list.join(", ")}] }` : list[0];
      };
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

  // A tall plant's parts one over another, half a cell apart like the game piles them.
  function stack(parts) {
    const S = parts[0].size, step = S / 2, w = S, hgt = S + (parts.length - 1) * step;
    const rgba = new Uint8ClampedArray(w * hgt * 4);
    parts.forEach((part, k) => {
      const oy = hgt - S - k * step;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const si = (y * S + x) * 4;
        if (part.color[si + 3]) rgba.set(part.color.subarray(si, si + 4), ((oy + y) * w + x) * 4);
      }
    });
    return { w, h: hgt, rgba };
  }

  function paintThumb(canvas, img) {
    canvas.width = img.w;
    canvas.height = img.h;
    canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.w, img.h), 0, 0);
  }

  Aura.plantsTool = { plantsTool };
})(window.Aura ??= {});
