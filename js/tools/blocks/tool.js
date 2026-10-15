"use strict";

// Bloques: builds tile sprites (cube, slab, stair, fence…) from face textures of an atlas or a loose texture, with
// procedural ragged edges painted with the face's own texture, hairs, the face light of the Blender materials, ambient
// occlusion, depth and a grayscale pass, rendered with the game's camera — and every variant the tile's "art" map needs
// (states × front / back) in one go. The heavy parts are engine.js / shapes.js / hair.js; this file is the panel, the
// picker, the previews and saving.
(function (Aura) {
  const { h } = Aura.dom;
  const { section, slider, select, checkbox, segmented, numberPair } = Aura.controls;
  const { decodePng, encodePng } = Aura.png;
  const { downloadBlob, stripExt } = Aura.fs;
  const { prefs } = Aura.storage;
  const { listSheets } = Aura.normalsSheets;
  const Cells = Aura.sheetCells;
  const E = Aura.blockEngine;
  const Sh = Aura.blockShapes;

  const SLOTS = [["top", "Arriba", "#5fd3b0"], ["left", "Izquierda", "#7fb2ff"], ["right", "Derecha", "#e27bd8"]];
  const VIEWS = [["color", "Color"], ["normal", "Normales"], ["depth", "Profundidad"], ["ao", "AO"], ["gray", "Grises"]];
  const MAPS = [["color", ""], ["normal", "_n"], ["depth", "_depth"], ["ao", "_ao"], ["gray", "_gray"]];
  const PREFS_KEY = "blocks:settings";

  const PIECE_DEFAULTS = {
    shape: "cube",
    params: { ...Sh.PARAM_DEFAULTS },
    states: { default: true, inverted: true, vertical: true, horizontal: true },
    back: true,
    combos: false,
    frontSide: "left",          // which camera face the game's "front" art looks at
  };
  const mergePiece = (p = {}) => ({
    ...PIECE_DEFAULTS, ...p,
    params: { ...PIECE_DEFAULTS.params, ...(p.params || {}) },
    states: { ...PIECE_DEFAULTS.states, ...(p.states || {}) },
  });

  // Option keys each panel section owns, for its own reset button.
  const SECTION_KEYS = {
    mask: ["mask", "autoFit", "chips", "seed"],
    cover: ["cover"],
    hair: ["hair"],
    light: ["shading", "shade", "ao", "aoDistance", "aoStrength", "aoSteps", "aoSamples"],
    pixel: ["edgeLight", "outline", "cleanup", "grayFromTexture"],
  };

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
    variantList = [];
    variantResults = new Map();   // variant id -> render result
    previewId = null;
    previewFacing = "auto";
    #pending = 0;

    // ---------------------------------------------------------------------------------------------------------------
    // Setup

    mount(host, studio) {
      this.studio = studio;
      const saved = prefs.get(PREFS_KEY, null);
      this.o = E.merge(saved?.o ?? {});
      this.piece = mergePiece(saved?.piece);
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
      prefs.set(PREFS_KEY, { o: this.o, piece: this.piece, cellSize: this.cellSize, exportScale: this.exportScale });
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

      // Centre: the preview, its maps and the variants.
      this.viewSeg = segmented({ label: "Vista", value: this.view, options: VIEWS, onChange: (v) => { this.view = v; this.#drawPreview(); this.#drawStrip(); } });
      this.facingSeg = segmented({
        label: "Mirar", value: this.previewFacing,
        options: [["auto", "Auto", "La orientación de la variante elegida"], ...Object.entries(Sh.FACING_LABEL)],
        onChange: (v) => { this.previewFacing = v; this.#render(false); },
      });
      this.guideChk = checkbox({ label: "Guías", value: true, onChange: () => this.#drawPreview() });
      this.previewCanvas = h("canvas", { class: "bk-preview" });
      this.previewLabel = h("div", { class: "bk-preview-label" });
      this.strip = h("div", { class: "bk-strip" });
      this.varStrip = h("div", { class: "bk-strip bk-varstrip" });
      const stage = h("div", { class: "bk-stage" },
        h("div", { class: "bk-toolbar" }, this.viewSeg.el, this.facingSeg.el, h("span", { class: "grow" }), this.guideChk.el),
        h("div", { class: "bk-view" }, this.previewCanvas, this.previewLabel),
        this.strip,
        this.varStrip);

      this.root = h("div", { class: "bk" }, left, stage, this.#buildPanel());
      return this.root;
    }

    // Controls bound to an option path ("shade.left", "hair.edges.corner"): every change re-renders and is remembered.
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

    // Piece controls: same idea, bound to this.piece.
    #setPiece(fn, rebuild = false) {
      fn(this.piece);
      this.#save();
      if (rebuild) this.#rebuildPanel();
      this.#schedule();
    }
    #pieceSlider(label, key, min, max, title = "") {
      return slider({ label, min, max, step: 1, value: this.piece.params[key], defaultValue: Sh.PARAM_DEFAULTS[key], unit: "/16", title,
        onInput: (v) => this.#setPiece((p) => { p.params[key] = v; }) }).el;
    }
    #pieceCheck(label, get, put, title = "") {
      return checkbox({ label, value: get(), title, onChange: (v) => this.#setPiece(() => put(v)) }).el;
    }

    /** The small ↺ in a section header: puts only that section back to its defaults. */
    #sectionReset(run) {
      return h("span", { class: "bk-reset", role: "button", tabindex: 0, title: "Restablecer esta sección",
        onclick: (e) => { e.stopPropagation(); run(); },
        onkeydown: (e) => { if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); run(); } } }, "↺");
    }
    #resetKeys(keys) {
      const d = E.merge({});
      for (const k of keys) this.o[k] = structuredClone(d[k]);
      this.#save();
      this.#rebuildPanel();
      this.#schedule();
    }

    #buildPanel() {
      const def = Sh.SHAPES[this.piece.shape] ?? Sh.SHAPES.cube;

      // Shape: which piece and its sizes.
      const shapeSel = select({ label: "Forma", value: this.piece.shape,
        options: Object.entries(Sh.SHAPES).map(([k, s]) => [k, s.label]),
        onChange: (v) => { this.#resetPreview(); this.#setPiece((p) => { p.shape = v; }, true); } });
      const params = [];
      if (this.piece.shape === "layer") params.push(this.#pieceSlider("Altura", "layer", 1, 15, "Altura de la capa en dieciseisavos (4 = un cuarto)"));
      if (this.piece.shape === "small") {
        params.push(this.#pieceSlider("Ancho", "small", 2, 16), this.#pieceSlider("Alto", "smallHeight", 1, 16));
      }
      if (this.piece.shape === "pillar") params.push(this.#pieceSlider("Grosor", "pillar", 2, 16));
      if (["panel", "slopePanel", "diagonalWall"].includes(this.piece.shape)) params.push(this.#pieceSlider("Grosor", "panel", 1, 8));
      if (this.piece.shape === "custom") {
        const area = h("textarea", { rows: 6, spellcheck: false }, this.piece.params.custom);
        params.push(
          h("p", { class: "note" }, "Cajas como en el ", h("b", null, "\"collision\""), " del tile: min/max en 0..1 (o en dieciseisavos), y hacia arriba, mirando al frente. ",
            "Para inclinar una caja añade ", h("b", null, "\"cuts\": [{ \"n\": [0, 1, -1], \"d\": 0 }]"), " (sólido donde n·p ≤ d; ese ejemplo es una rampa)."),
          area,
          h("button", { onclick: () => {
            try {
              Sh.parseCustom(area.value);
              this.#setPiece((p) => { p.params.custom = area.value; });
            } catch (err) {
              this.studio.toast(err.message, { kind: "warn" });
            }
          } }, "Aplicar cajas"));
      }
      const shape = section({ id: "bk-shape", title: "Forma",
        extra: this.#sectionReset(() => {
          this.piece = mergePiece();
          this.o.texMode = E.DEFAULTS.texMode;
          this.o.uvMode = E.DEFAULTS.uvMode;
          this.#resetPreview();
          this.#save(); this.#rebuildPanel(); this.#schedule();
        }) },
        shapeSel.el, ...params,
        this.#slider("Resolución", "res", 16, 64, 16, "Cubitos por lado del bloque: 32 = uno cada 2 px de un sprite de 64; 64 = uno por pixel (bordes y formas más finos)"),
        this.#choice("Texturas", "texMode", [["auto", "Auto"], ["follow", "Giran"], ["world", "Fijas"]]),
        this.#choice("Ajuste", "uvMode", [["world", "Mundo"], ["fit", "Estirar"]]),
        h("p", { class: "note" }, h("b", null, "Auto:"), " la textura gira con la pieza solo en «horizontal» (troncos tumbados). ",
          h("b", null, "Mundo:"), " el lado de una losa muestra media textura, como Minecraft; ", h("b", null, "Estirar"), " la aplasta entera."));

      // Variants: which sprites the art map gets.
      const variantControls = [];
      if (def.connects) {
        variantControls.push(
          h("p", { class: "note" }, "Poste y brazo por separado, para que el juego los combine según los vecinos."),
          this.#pieceCheck("Brazo también hacia atrás", () => this.piece.back, (v) => { this.piece.back = v; }),
          this.#pieceCheck("Las 16 uniones ya montadas", () => this.piece.combos, (v) => { this.piece.combos = v; }));
      } else {
        variantControls.push(h("div", { class: "bk-zones" }, def.states.map((st) =>
          this.#pieceCheck(Sh.STATE_LABEL[st], () => this.piece.states[st] ?? st === "default", (v) => { this.piece.states[st] = v; },
            { default: "", inverted: "Losa arriba / escalera boca abajo", vertical: "Losa de lado", horizontal: "Tumbado (tronco)" }[st]))));
        variantControls.push(this.#pieceCheck("Generar también «back»", () => this.piece.back, (v) => { this.piece.back = v; },
          "El juego dibuja las otras dos orientaciones espejando front y back"));
      }
      variantControls.push(select({ label: "Front mira a", value: this.piece.frontSide,
        options: [["left", "Cara izquierda (−Y)"], ["right", "Cara derecha (+X)"]],
        onChange: (v) => this.#setPiece((p) => { p.frontSide = v; }) }).el);
      const variants = section({ id: "bk-variants", title: "Variantes" }, ...variantControls);

      // Edge masks: the faces carry on past their edges in a ragged outline, painted with their own texture. Nothing is
      // read from the texture's brightness any more: the shape of the edge is procedural.
      const maskSection = section({ id: "bk-mask", title: "Bordes procedurales", extra: this.#sectionReset(() => this.#resetKeys(SECTION_KEYS.mask)) },
        this.#check("Bordes irregulares", "mask.enabled", "La textura sigue sin cortes en las lenguas que salen del borde"),
        h("p", { class: "note" }, "Atrás = las esquinas de arriba que marcaste; delante = cuelga sobre los lados; abajo = bajo los lados. ",
          "Se aplican a los bordes de cualquier forma (escalera, losa, valla…) y nunca pasan de los lados del sprite."),
        h("div", { class: "bk-zones" },
          this.#check("Atrás izq.", "mask.zones.backLeft"), this.#check("Atrás der.", "mask.zones.backRight"),
          this.#check("Delante izq.", "mask.zones.frontLeft"), this.#check("Delante der.", "mask.zones.frontRight"),
          this.#check("Abajo izq.", "mask.zones.bottomLeft"), this.#check("Abajo der.", "mask.zones.bottomRight")),
        this.#choice("Forma", "mask.style", [["spikes", "Fibras"], ["waves", "Ondas"], ["blocks", "Dientes"]]),
        this.#slider("Largo", "mask.length", 0, 10, 1, "En cubitos (con resolución 64, un cubito ≈ un pixel)"),
        this.#slider("Densidad", "mask.density", 0, 1, 0.01, "Cuánto del borde sale"),
        this.#slider("Variación", "mask.variation", 0, 1, 0.01),
        this.#slider("Ancho", "mask.width", 1, 6, 1, "Cubitos por lengua (fibras / dientes) o por onda"),
        h("div", { class: "row" }, this.#slider("Semilla bordes", "mask.seed", 1, 9999, 1),
          h("button", { onclick: () => { this.o.mask.seed = 1 + Math.floor(Math.random() * 9999); this.#save(); this.#rebuildPanel(); this.#schedule(); } }, "Otra")),
        h("div", { class: "bk-sep" }),
        this.#check("Ajustar dentro del sprite", "autoFit"),
        this.#slider("Desgaste aristas", "chips", 0, 1, 0.01),
        this.#slider("Semilla desgaste", "seed", 1, 9999, 1));

      const cover = section({ id: "bk-cover", title: "Cobertura", extra: this.#sectionReset(() => this.#resetKeys(SECTION_KEYS.cover)) },
        this.#check("La textura de arriba baja por los lados", "cover.enabled", "Nieve sobre tierra, césped sobre un acantilado…"),
        h("p", { class: "note" }, "La textura de arriba se dobla sobre el borde y baja por los lados hasta una línea irregular, sin corte con la cara de arriba. ",
          "En escaleras y losas baja desde cada borde de arriba."),
        h("div", { class: "bk-zones" }, this.#check("Lado izq.", "cover.left"), this.#check("Lado der.", "cover.right")),
        this.#slider("Baja", "cover.depth", 0, 40, 1, "Cubitos desde el borde de arriba (con resolución 64, 2 cubitos ≈ 1 px de alto)"),
        this.#slider("Irregular", "cover.ragged", 0, 30, 1, "Cuánto más baja en las partes irregulares"),
        this.#choice("Forma", "cover.style", [["waves", "Ondas"], ["spikes", "Goteo"], ["blocks", "Dientes"]]),
        this.#slider("Ancho", "cover.width", 1, 8, 1),
        this.#slider("Densidad", "cover.density", 0, 1, 0.01),
        this.#slider("Variación", "cover.variation", 0, 1, 0.01),
        this.#slider("Grosor", "cover.thickness", 0, 3, 1, "0 = pintada; 1–3 = capa que sobresale (nieve gruesa)"),
        h("div", { class: "row" }, this.#slider("Semilla", "cover.seed", 1, 9999, 1),
          h("button", { onclick: () => { this.o.cover.seed = 1 + Math.floor(Math.random() * 9999); this.#save(); this.#rebuildPanel(); this.#schedule(); } }, "Otra")));

      const hair = section({ id: "bk-hair", title: "Pelitos", extra: this.#sectionReset(() => this.#resetKeys(SECTION_KEYS.hair)) },
        this.#check("Pelitos en los bordes", "hair.enabled", "Hebras de 1 px: fibras de corteza, hierba, raíces"),
        h("p", { class: "note" }, "Usan la misma textura que la cara de la que salen, así no desentonan. Nunca pasan de los lados del sprite."),
        h("div", { class: "bk-zones" },
          this.#check("Atrás izq.", "hair.edges.backLeft"), this.#check("Atrás der.", "hair.edges.backRight"),
          this.#check("Delante arriba", "hair.edges.frontTop"), this.#check("Esquina", "hair.edges.corner"),
          this.#check("Abajo izq.", "hair.edges.bottomLeft"), this.#check("Abajo der.", "hair.edges.bottomRight")),
        this.#slider("Densidad", "hair.density", 0.05, 1.5, 0.01, "Hebras por pixel de borde"),
        this.#slider("Largo", "hair.length", 1, 16, 0.5, "En pixeles del sprite"),
        this.#slider("Variación", "hair.lengthVar", 0, 1, 0.01),
        this.#slider("Hacia fuera", "hair.lean", 0, 1, 0.01, "0 = rectas (arriba o colgando), 1 = salen de la cara"),
        this.#slider("Desorden", "hair.spread", 0, 1, 0.01),
        this.#slider("Caída", "hair.droop", 0, 2, 0.01, "Se doblan hacia abajo en la punta"),
        this.#slider("Grosor raíz", "hair.width", 1, 3, 1),
        this.#slider("Punta", "hair.tipShade", -0.8, 0.8, 0.01, "Negativo = punta más oscura, positivo = más clara"),
        h("div", { class: "row" }, this.#slider("Semilla", "hair.seed", 1, 9999, 1),
          h("button", { onclick: () => { this.o.hair.seed = 1 + Math.floor(Math.random() * 9999); this.#save(); this.#rebuildPanel(); this.#schedule(); } }, "Otra")));

      const light = section({ id: "bk-light", title: "Luz", extra: this.#sectionReset(() => this.#resetKeys(SECTION_KEYS.light)) },
        this.#check("Luz por caras (como los materiales)", "shading"),
        this.#slider("Arriba", "shade.top", 0, 1.5, 0.01),
        this.#slider("Izquierda", "shade.left", 0, 1.5, 0.01),
        this.#slider("Derecha", "shade.right", 0, 1.5, 0.01),
        this.#check("Oclusión ambiental (AO)", "ao"),
        this.#slider("Distancia AO", "aoDistance", 0.02, 1, 0.01, "En bloques"),
        this.#slider("Fuerza AO", "aoStrength", 0, 1, 0.01),
        this.#slider("Escalones AO", "aoSteps", 0, 8, 1, "0 = suave; pocos escalones se leen mejor en pixel art"),
        this.#slider("Muestras AO", "aoSamples", 4, 64, 1));

      const pixel = section({ id: "bk-pixel", title: "Pixel art", extra: this.#sectionReset(() => this.#resetKeys(SECTION_KEYS.pixel)) },
        this.#slider("Luz en aristas", "edgeLight", 0, 0.6, 0.01),
        this.#slider("Contorno", "outline", 0, 0.8, 0.01),
        this.#check("Quitar pixeles sueltos", "cleanup"),
        this.#check("Grises con el brillo de la textura", "grayFromTexture"));

      this.sizeSel = select({ label: "Tamaño sprite", value: String(this.o.size),
        options: [["32", "32 px"], ["48", "48 px"], ["64", "64 px"], ["96", "96 px"], ["128", "128 px"]],
        onChange: (v) => this.#set("size", Number(v)) });
      this.targetSel = select({ label: "Hoja destino", value: "", options: [["", "— abre la carpeta —"]] });
      this.targetCell = numberPair({ label: "Celda X / Y", values: [0, 0], min: 0, max: 4096, titles: ["Columna", "Fila"] });
      this.saveN = checkbox({ label: "Guardar también el _n", value: true });
      this.scaleSel = select({ label: "Escala descarga", value: String(this.exportScale),
        options: [["1", "×1"], ["2", "×2"], ["4", "×4"], ["8", "×8"]],
        onChange: (v) => { this.exportScale = Number(v); this.#save(); } });
      this.mapChecks = MAPS.map(([k]) => checkbox({ label: { color: "Color", normal: "Normales", depth: "Profundidad", ao: "AO", gray: "Grises" }[k], value: k === "color" || k === "normal" }));
      this.snippetEl = h("textarea", { class: "bk-snippet", rows: 5, readonly: true, spellcheck: false,
        placeholder: "Aquí sale el \"art\" para el JSON del tile al guardar las variantes." });
      const output = section({ id: "bk-out", title: "Salida" },
        this.sizeSel.el,
        this.targetSel.el, this.targetCell.el, this.saveN.el,
        h("button", { class: "primary", onclick: () => this.#saveVariantsToAtlas(),
          title: "Una celda por variante, seguidas desde la celda X / Y" }, "Guardar variantes en el atlas"),
        h("button", { onclick: () => this.#saveToAtlas(), title: "Solo la vista previa, en la celda X / Y" }, "Guardar solo la vista previa"),
        this.snippetEl,
        h("button", { onclick: () => this.#copySnippet() }, "Copiar \"art\""),
        h("div", { class: "bk-sep" }),
        h("div", { class: "bk-maps" }, this.mapChecks.map((c) => c.el)),
        this.scaleSel.el,
        h("button", { onclick: () => this.#download() }, "Descargar vista previa"),
        h("button", { onclick: () => this.#downloadVariants() }, "Descargar tira de variantes"));

      this.panelScroll = h("div", { class: "scroll" }, shape.el, variants.el, maskSection.el, cover.el, hair.el, light.el, pixel.el, output.el);
      this.panel = h("div", { class: "bk-panel" },
        h("div", { class: "bk-panel-head" }, h("span", null, "Ajustes"),
          h("button", { title: "Volver todo a los valores por defecto", onclick: () => {
            this.o = E.merge({});
            this.piece = mergePiece();
            this.#resetPreview();
            this.#save(); this.#rebuildPanel(); this.#schedule();
          } }, "Restablecer todo")),
        this.panelScroll);
      return this.panel;
    }

    #rebuildPanel() {
      const top = this.panelScroll?.scrollTop ?? 0;
      const fresh = this.#buildPanel();
      this.root.replaceChild(fresh, this.root.children[2]);
      this.panelScroll.scrollTop = top;
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
      // Only the face chosen in "Cara a asignar" takes it (all three with "Todas"), so each face can have its own file.
      const targets = this.activeSlot === "all" ? SLOTS.map(([k]) => k) : [this.activeSlot];
      for (const k of targets) Object.assign(this.slots[k], { key, cx: 0, cy: 0 });
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
      if (!img) return;
      const r = this.pickerCanvas.getBoundingClientRect();
      const scale = this.pickerCanvas.width / r.width / this.pickerScale;
      const x = (e.clientX - r.left) * scale, y = (e.clientY - r.top) * scale;
      // Cell size 0: the whole image is one face, so a click anywhere assigns it.
      const cx = this.cellSize ? Math.floor(x / this.cellSize) : 0, cy = this.cellSize ? Math.floor(y / this.cellSize) : 0;
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
      setTimeout(() => { if (ticket === this.#pending) this.#render(true); }, 30);
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

    /** The variants of the current shape, with the game's front pointed at the chosen camera face. */
    #variants() {
      try {
        const list = Sh.variants(this.piece);
        if (this.piece.frontSide === "right") {
          const turn = { front: "right", back: "left", right: "back", left: "front" };
          for (const v of list) v.facing = turn[v.facing];
        }
        return list;
      } catch (err) {
        this.studio.setStatus(err.message, "warn");
        return [];
      }
    }

    /** Back to the first variant, seen the way it will be saved. */
    #resetPreview() {
      this.previewId = null;
      this.previewFacing = "auto";
      this.facingSeg?.set("auto");
    }

    #previewPiece() {
      const v = this.variantList.find((x) => x.id === this.previewId) ?? this.variantList[0];
      if (!v) return null;
      this.previewId = v.id;
      return { ...v, facing: this.previewFacing === "auto" ? v.facing : this.previewFacing };
    }

    /** Renders the preview now; with all = true also refreshes every variant's thumbnail, a few per frame. */
    #render(all) {
      const tex = this.#textures();
      this.variantList = this.#variants();
      const piece = tex && this.#previewPiece();
      if (!piece) { this.result = null; this.#drawPreview(); this.#drawStrip(); this.#drawVariantStrip(); return; }
      const t0 = performance.now();
      try {
        this.result = E.render(this.o, tex, piece);
      } catch (err) {
        this.studio.toast("No pude generar la pieza.", { kind: "bad", detail: err.message });
        return;
      }
      this.studio.slot?.("bk-time", Math.round(performance.now() - t0) + " ms", "Tiempo de generación");
      this.previewLabel.textContent = `${piece.label} · ${Sh.FACING_LABEL[piece.facing]}`;
      this.#drawPreview();
      this.#drawStrip();
      if (all) this.#renderVariants(tex);
      else this.#drawVariantStrip();
    }

    #renderVariants(tex) {
      const ticket = this.#pending;
      this.variantResults = new Map();
      this.#drawVariantStrip();
      const list = this.variantList;
      let n = 0;
      // One variant per tick, so dragging a slider never waits for the whole set.
      const next = () => {
        if (ticket !== this.#pending || n >= list.length) return;
        const v = list[n++];
        try {
          this.variantResults.set(v.id, E.render(this.o, tex, v));
        } catch {
          return;
        }
        this.#drawVariantThumb(v);
        setTimeout(next, 0);
      };
      setTimeout(next, 0);
    }

    /** Every variant, rendering whatever the background pass has not reached yet. */
    #allVariantResults() {
      const tex = this.#textures();
      if (!tex) return [];
      return this.variantList.map((v) => {
        if (!this.variantResults.has(v.id)) this.variantResults.set(v.id, E.render(this.o, tex, v));
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
        // The full block's outline: what sticks out of it is a ragged edge or a hair.
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
      if (!this.result) { this.strip.replaceChildren(); return; }
      const S = this.result.size;
      this.strip.replaceChildren(...VIEWS.map(([k, t]) => {
        const c = h("canvas", { width: S, height: S, title: t, class: k === this.view ? "on" : "",
          onclick: () => { this.view = k; this.viewSeg.set(k); this.#drawPreview(); this.#drawStrip(); } });
        c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(this.result[k]), S, S), 0, 0);
        return h("div", { class: "bk-thumb" }, c, h("span", null, t));
      }));
    }

    #drawVariantStrip() {
      this.variantThumbs = new Map();
      if (!this.result) { this.varStrip.replaceChildren(); return; }
      const S = this.result.size;
      this.varStrip.replaceChildren(h("div", { class: "bk-strip-title" }, `Variantes (${this.variantList.length})`),
        ...this.variantList.map((v) => {
          const c = h("canvas", { width: S, height: S, title: v.label, class: v.id === this.previewId ? "on" : "",
            onclick: () => { this.previewId = v.id; this.previewFacing = "auto"; this.facingSeg.set("auto"); this.#render(false); } });
          this.variantThumbs.set(v.id, c);
          return h("div", { class: "bk-thumb" }, c, h("span", null, v.label));
        }));
      for (const v of this.variantList) if (this.variantResults.has(v.id)) this.#drawVariantThumb(v);
    }

    #drawVariantThumb(v) {
      const c = this.variantThumbs?.get(v.id);
      const r = this.variantResults.get(v.id);
      if (!c || !r) return;
      if (c.width !== r.size) { c.width = c.height = r.size; }
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
      const top = this.slots.top.key ? this.images.get(this.slots.top.key) : null;
      return (top?.name ?? "bloque") + `_${this.piece.shape}_${this.slots.top.cx}_${this.slots.top.cy}`;
    }

    async #download() {
      if (!this.result) return;
      const S = this.result.size, k = this.exportScale;
      let n = 0;
      for (let i = 0; i < MAPS.length; i++) {
        if (!this.mapChecks[i].get()) continue;
        const [key, suffix] = MAPS[i];
        const rgba = k > 1 ? E.upscale(this.result[key], S, k) : this.result[key];
        downloadBlob(await encodePng(S * k, S * k, new Uint8ClampedArray(rgba)), `${this.#baseName()}_${this.previewId}${suffix}${k > 1 ? "@" + k + "x" : ""}.png`);
        n++;
      }
      this.studio.setStatus(n ? `Descargados ${n} PNG.` : "Marca qué mapas descargar.", n ? "ok" : "warn");
    }

    /** One PNG per checked map, the variants side by side in save order. */
    async #downloadVariants() {
      const all = this.#allVariantResults();
      if (!all.length) return;
      const k = this.exportScale;
      let n = 0;
      for (let m = 0; m < MAPS.length; m++) {
        if (!this.mapChecks[m].get()) continue;
        const [key, suffix] = MAPS[m];
        downloadBlob(await Cells.strip(all.map((a) => a.result), key, k), `${this.#baseName()}_variantes${suffix}${k > 1 ? "@" + k + "x" : ""}.png`);
        n++;
      }
      this.studio.setStatus(n ? `Descargadas ${n} tiras con ${all.length} variantes: ${all.map((a) => a.variant.id).join(", ")}.` : "Marca qué mapas descargar.", n ? "ok" : "warn");
    }

    #targetSheet() {
      const sheet = this.sheets.find((s) => s.key === this.targetSel.get());
      if (!this.project || !sheet) {
        this.studio.toast("Abre la carpeta del proyecto y elige la hoja destino.", { kind: "warn" });
        return null;
      }
      return sheet;
    }

    async #saveToAtlas() {
      if (!this.result) return;
      const sheet = this.#targetSheet();
      if (!sheet) return;
      try {
        await this.studio.busy(this.#writeCells(sheet, [{ cell: this.targetCell.get(), result: this.result }]));
      } catch (err) {
        this.studio.toast("No pude guardar.", { kind: "bad", detail: err.message });
      }
    }

    /** Every variant in its own cell, row by row from the chosen cell, then the tile's "art" map for them. */
    async #saveVariantsToAtlas() {
      if (!this.result) return;
      const sheet = this.#targetSheet();
      if (!sheet) return;
      try {
        await this.studio.busy((async () => {
          const all = this.#allVariantResults();
          const S = all[0].result.size;
          const sheetImg = await decodePng(await sheet.entry.handle.getFile());
          const cells = Cells.layoutCells(this.targetCell.get(), all.length, Math.floor(sheetImg.w / S));
          const items = all.map(({ variant, result }, i) => ({ variant, result, cell: cells[i] }));
          await this.#writeCells(sheet, items, sheetImg);
          this.snippetEl.value = Sh.artSnippet(this.piece.shape, items);
          this.#copySnippet(true);
        })());
      } catch (err) {
        this.studio.toast("No pude guardar.", { kind: "bad", detail: err.message });
      }
    }

    async #copySnippet(quiet = false) {
      if (!this.snippetEl.value) { if (!quiet) this.studio.toast("Guarda las variantes primero.", { kind: "warn" }); return; }
      try {
        await navigator.clipboard.writeText(this.snippetEl.value);
        if (!quiet) this.studio.toast("\"art\" copiado.", { kind: "ok" });
      } catch {
        // Clipboard needs a focused, permitted page; the text stays selectable in the box.
        this.snippetEl.select();
      }
    }

    /** Pastes results into cells of the sheet (and the normals into its _n), keeping a backup to restore. */
    async #writeCells(sheet, items, sheetImg = null) {
      const ctx = { project: this.project, studio: this.studio };
      const done = await Cells.writeCells(ctx, sheet, items, { saveN: this.saveN.get(), sheetImg });
      this.images.delete(sheet.key);
      if (this.pickerKey === sheet.key) await this.#selectSource(sheet.key, sheet);
      Cells.announce(ctx, sheet, items, done);
    }
  }

  Aura.blocksTool = { blocksTool };
})(window.Aura ??= {});
