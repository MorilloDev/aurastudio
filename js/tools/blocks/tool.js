"use strict";

// Bloques: builds tile sprites (cube, slab, stair, fence…) from face textures of an atlas or a loose texture, with
// procedural ragged edges painted with the face's own texture, hairs, the face light of the Blender materials, ambient
// occlusion, depth and a grayscale pass, rendered with the game's camera — and every variant the tile's "art" map needs
// (states × front / back) in one go. The heavy parts are engine.js / shapes.js / hair.js; this file is the panel, the
// picker, the previews and saving.
(function (Aura) {
  const { h } = Aura.dom;
  const { section, slider, select, checkbox, segmented, numberPair, detailSwitch } = Aura.controls;
  const { decodePng, encodePng } = Aura.png;
  const { downloadBlob, stripExt } = Aura.fs;
  const { prefs } = Aura.storage;
  const { listSheets } = Aura.sheetFiles;
  const Cells = Aura.sheetCells;
  const E = Aura.blockEngine;
  const Sh = Aura.blockShapes;
  const Tint = Aura.tint;
  const TP = Aura.tintPanel;
  const { ContextView } = Aura.contextView;

  const SLOTS = [["top", "Arriba", "#5fd3b0"], ["left", "Izquierda", "#7fb2ff"], ["right", "Derecha", "#e27bd8"]];
  const VIEWS = [["color", "Color"], ["tinted", "Bioma"], ["normal", "Normales"], ["depth", "Profundidad"], ["ao", "AO"], ["gray", "Grises"]];
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
    rotation = { yaw: 0, flipX: false, flipY: false };   // pushed down by the Crear mode bar
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
      this.tint = Tint.merge(saved?.tint);
      this.biomes = [Tint.DEFAULT_TINT];
      this.#loadBiomes();
      host.appendChild(this.#buildLayout());
      this.ctx = new ContextView(this.viewEl, { biomes: this.biomes });
      this.#showContext(this.contextChk.get());
      new ResizeObserver(() => { this.#drawPicker(); this.#drawPreview(); }).observe(this.root);
      this.#renderList();
      this.#schedule();
    }

    activate() { this.#drawPicker(); this.#drawPreview(); }
    deactivate() {}

    /** Orientation pushed down by the Crear bar: yaw is a world rotation inside buildVoxels, the mirrors are pixel
     *  transforms applied to the sprite at the end of the render, so one object is enough for preview and export. */
    setRotation(r) {
      const next = { yaw: ((r?.yaw | 0) % 360 + 360) % 360, flipX: !!r?.flipX, flipY: !!r?.flipY };
      const cur = this.rotation;
      if (cur && cur.yaw === next.yaw && cur.flipX === next.flipX && cur.flipY === next.flipY) return;
      this.rotation = next;
      this.#schedule();
    }

    isDirty() { return false; }

    onProject(project) {
      this.project = project;
      this.sheets = listSheets(project);
      this.#renderList();
      this.#fillTargets();
      this.#loadBiomes();
    }

    async #loadBiomes() {
      this.biomes = await Tint.listBiomes(this.project);
      this.ctx?.setBiomes(this.biomes);
      if (this.panelScroll) this.#rebuildPanel();
    }

    #save() {
      prefs.set(PREFS_KEY, { o: this.o, piece: this.piece, cellSize: this.cellSize, exportScale: this.exportScale, tint: this.tint });
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
      this.contextChk = checkbox({ label: "Contexto", value: prefs.get("blocks:context", false), title: "3 × 3 en el mundo: bioma, luz del día",
        onChange: (v) => { prefs.set("blocks:context", v); this.#showContext(v); } });
      this.previewCanvas = h("canvas", { class: "bk-preview" });
      this.previewLabel = h("div", { class: "bk-preview-label" });
      this.strip = h("div", { class: "bk-strip" });
      this.varStrip = h("div", { class: "bk-strip bk-varstrip" });
      const stage = h("div", { class: "bk-stage" },
        h("div", { class: "bk-toolbar" }, this.viewSeg.el, this.facingSeg.el, h("span", { class: "grow" }), this.contextChk.el, this.guideChk.el),
        this.viewEl = h("div", { class: "bk-view" }, this.previewCanvas, this.previewLabel),
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
   
