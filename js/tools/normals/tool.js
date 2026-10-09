"use strict";

(function (Aura) {
  const { clear, debounce, h, isTyping, rafThrottle } = Aura.dom;
  const { baseName, dirName, downloadBlob, joinPath, readText, stripExt, writeHandle, writeInDir } = Aura.fs;
  const { History } = Aura.history;
  const { decodePng, encodePng } = Aura.png;
  const { prefs } = Aura.storage;
  const { prettyKey } = Aura.commands;
  const { checkbox, numberPair, section, segmented, select, slider } = Aura.controls;
  const { Viewport } = Aura.viewport;
  const { Compute } = Aura.normalsCompute;
  const { encodeChannel, decode, FRONT, LEFT, RIGHT, TOP } = Aura.normalsGenerator;
  const { addToMgcb } = Aura.normalsMgcb;
  const { Overrides, RELIEF_ALPHA } = Aura.normalsOverrides;
  const { SheetRenderer } = Aura.normalsRenderer;
  const { companionPath, listSheets, looseSheet, refreshCompanions } = Aura.normalsSheets;

  // Normal maps: builds the _n (faces + relief) or _d (relief only) map of a tile sheet, previewed lit exactly like the game
  // (TileInstanced.fx), with faces painted by hand or imported from Blender renders (Aura Normals add-on). Writes the map
  // next to its sheet and registers it in the mgcb.

  const DEFAULT_SETTINGS = {
    faces: "auto", litSide: "auto", minContrast: 6, roundness: 4, cellW: 64, cellH: 64,
    strength: 20, steps: 2, smooth: 1, invert: false, perFace: true, output: "n",
  };

  const SETTING_LABELS = {
    faces: "detección", litSide: "lado iluminado", minContrast: "sombreado mínimo", roundness: "redondez",
    cellW: "ancho de celda", cellH: "alto de celda", strength: "fuerza del relieve", steps: "pasos pixel-art",
    smooth: "suavizado", invert: "invertir", perFace: "relieve por cara", output: "tipo de mapa",
  };

  const DEFAULT_LIGHT = { sunAngle: 60, sunHeight: 45, sunAmount: 100, lightTop: 100, lightLeft: 82, lightRight: 64 };
  const LIGHT_PRESETS = [
    ["Mediodía", { sunAngle: 60, sunHeight: 70, sunAmount: 100, lightTop: 100, lightLeft: 82, lightRight: 64 }],
    ["Mañana", { sunAngle: 15, sunHeight: 25, sunAmount: 90, lightTop: 92, lightLeft: 70, lightRight: 80 }],
    ["Tarde", { sunAngle: 100, sunHeight: 20, sunAmount: 90, lightTop: 90, lightLeft: 84, lightRight: 58 }],
    ["Noche / cueva", { sunAngle: 60, sunHeight: 45, sunAmount: 0, lightTop: 55, lightLeft: 45, lightRight: 38 }],
  ];

  const TOOLS = [
    ["move", "Mover", "V", null],
    ["cell", "Celda", "C", null],
    ["top", "Arriba", "1", "#80EEBF"],
    ["left", "Izq.", "2", "#2553CE"],
    ["right", "Der.", "3", "#DA53CE"],
    ["front", "Frente", "4", "#8080FF"],
    ["erase", "Borrar", "E", null],
  ];
  const FACE_NORMALS = { top: TOP, left: LEFT, right: RIGHT, front: FRONT };
  const PAINT_TOOLS = new Set(["top", "left", "right", "front", "erase"]);

  const VIEW_OPTIONS = [
    ["game", "Juego", "Iluminado como en el juego (G)"],
    ["normal", "Normal", "El mapa que se guarda (N)"],
    ["faces", "Caras", "Las caras detectadas o pintadas, sin relieve (F)"],
    ["art", "Arte", "El dibujo (mantén A para verlo un momento)"],
    ["file", "Archivo", "El mapa guardado ahora en disco"],
  ];

  function normalsTool() {
    return new NormalsTool();
  }

  class NormalsTool {
    id = "normals";
    title = "Normal maps";

    project = null;
    sheets = [];
    sheet = null;
    ov = null;
    result = null;
    settings = { ...DEFAULT_SETTINGS };
    committed = { ...DEFAULT_SETTINGS };
    history = new History();
    view = prefs.get("normals:view", "game");
    tool = "move";
    brush = prefs.get("normals:brush", 3);
    showGrid = prefs.get("normals:grid", true);
    light = { ...DEFAULT_LIGHT, ...prefs.get("normals:light", {}) };
    compare = false;
    split = 0.5;
    holdArt = false;
    cell = null;          // { cx, cy } chosen for Blender imports
    imp = null;           // the last import: { img, cells, dx, dy, command }
    cursor = null;        // sheet pixel under the mouse

    // -------------------------------------------------------------------------------------------------------------------
    // Setup

    mount(host, studio) {
      this.studio = studio;
      this.compute = new Compute((r) => this.#onResult(r));
      this.history.on("change", () => this.#onHistory());
      host.appendChild(this.#buildLayout());
      this.viewport = new Viewport(this.glCanvas);
      this.viewport.leftPans = () => this.tool === "move";
      this.viewport.on("change", () => this.redraw());
      this.renderer = new SheetRenderer(this.glCanvas);
      this.#bindPointer();
      this.#bindDrop();
      this.#registerCommands();
      new ResizeObserver(() => this.redraw()).observe(this.viewportEl);
      window.addEventListener("keydown", (e) => {
        if (e.key.toLowerCase() === "a" && !e.repeat && this.#isActive() && !isTyping(e.target) && !e.ctrlKey && !e.metaKey && !this.holdArt) {
          this.holdArt = true;
          this.redraw();
        }
      });
      window.addEventListener("keyup", (e) => {
        if (e.key.toLowerCase() === "a" && this.holdArt) { this.holdArt = false; this.redraw(); }
      });
      this.#renderList();
      this.#renderEmpty();
      this.#updateUi();
    }

    activate() {
      this.redraw();
      this.#updateSlots();
    }

    deactivate() {
      this.holdArt = false;
    }

    #isActive() {
      return this.studio.active === this;
    }

    isDirty() {
      return !!this.sheet && this.history.dirty;
    }

    onProject(project) {
      this.project = project;
      this.sheets = listSheets(project);
      if (this.sheet && !this.sheet.file) {
        const same = this.sheets.find((s) => s.key === this.sheet.key);
        if (same) Object.assign(this.sheet, { entry: same.entry, has: same.has, mgcb: same.mgcb, rel: same.rel });
      }
      this.#renderList();
      this.#renderEmpty();
      this.#updateUi();
    }

    extraKeys() {
      return [
        { group: "Vista", title: "Ver el arte mientras se mantiene", keys: ["A"] },
        { group: "Vista", title: "Mover la vista", keys: ["Space"] },
      ];
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Layout

    #buildLayout() {
      // Sheet list.
      this.filterInput = h("input", { type: "search", placeholder: "Buscar hoja…  (Ctrl+F)", oninput: () => this.#renderList() });
      this.listEl = h("div", { class: "items scroll", role: "listbox", "aria-label": "Hojas" });
      this.fileInput = h("input", { type: "file", accept: "image/png", multiple: true, hidden: true,
        onchange: (e) => { this.#openLoose(e.target.files); e.target.value = ""; } });
      const list = h("aside", { class: "nm-list" },
        h("div", { class: "head" }, this.filterInput,
          h("button", { onclick: () => this.fileInput.click(), title: "Abrir una hoja suelta (y sus _faces / _height) sin proyecto" }, "Abrir PNG suelto…")),
        this.listEl, this.fileInput);

      // Toolbar.
      this.viewSeg = segmented({ label: "Vista", options: VIEW_OPTIONS, value: this.view, onChange: (v) => this.#setView(v) });
      this.compareButton = h("button", { class: "ghost", title: "Comparar con el arte: arrastra la línea (D)", onclick: () => this.#toggleCompare() }, "◧ Comparar");
      this.toolButtons = new Map();
      const tools = h("div", { class: "seg", role: "radiogroup", "aria-label": "Herramienta" }, TOOLS.map(([id, label, key, colour]) => {
        const b = h("button", { title: `${label} (${key})`, onclick: () => this.#setTool(id) },
          colour ? h("span", { class: "swatch", style: { background: colour } }) : null, label);
        this.toolButtons.set(id, b);
        return b;
      }));
      this.brushRange = h("input", { type: "range", min: 1, max: 32, value: this.brush, "aria-label": "Tamaño del pincel",
        oninput: () => this.#setBrush(Number(this.brushRange.value)) });
      this.brushOut = h("output", null, String(this.brush));
      this.brushEl = h("label", { class: "brush", title: "Tamaño del pincel ( [ y ] )" }, "Pincel", this.brushRange, this.brushOut);
      this.undoButton = h("button", { class: "icon", onclick: () => this.#undo() }, "↶");
      this.redoButton = h("button", { class: "icon", onclick: () => this.#redo() }, "↷");
      this.zoomLabel = h("span", { class: "zoom-label" }, "100%");
      this.gridButton = h("button", { class: "ghost", title: "Ver las celdas (Shift+G)", onclick: () => this.#toggleGrid() }, "Celdas");
      const toolbar = h("div", { class: "nm-toolbar" },
        h("button", { class: "icon ghost", title: "Mostrar u ocultar la lista de hojas (Ctrl+B)", onclick: () => this.#toggleList() }, "☰"),
        tools, this.brushEl,
        h("span", { class: "grow" }),
        this.undoButton, this.redoButton);
      const viewBar = h("div", { class: "nm-float nm-views" }, this.viewSeg.el, h("span", { class: "sep-v" }), this.compareButton, this.gridButton);
      const zoomBar = h("div", { class: "nm-float nm-zoom" },
        h("button", { class: "icon ghost", title: "Alejar (−)", onclick: () => this.viewport.step(-1) }, "−"),
        this.zoomLabel,
        h("button", { class: "icon ghost", title: "Acercar (+)", onclick: () => this.viewport.step(1) }, "+"),
        h("button", { class: "ghost", title: "Ajustar a la vista (0)", onclick: () => this.#fit() }, "Ajustar"));

      // Viewport.
      this.glCanvas = h("canvas", { class: "sheet-layer" });
      this.overlay = h("canvas", { class: "overlay-layer" });
      this.hint = h("div", { class: "float-hint" });
      this.emptyEl = h("div", { class: "welcome" });
      this.viewportEl = h("div", { class: "nm-viewport" }, this.glCanvas, this.overlay, this.emptyEl, this.hint, viewBar, zoomBar,
        h("div", { class: "drop" }, "Suelta aquí: una hoja PNG para abrirla, o un render de Blender sobre la celda donde va."));

      const stage = h("div", { class: "nm-stage" }, toolbar, this.viewportEl);
      this.root = h("div", { class: "nm" }, list, stage, this.#buildPanel());
      return this.root;
    }

    #buildPanel() {
      const c = {};
      const setting = (key, build) => {
        c[key] = build;
        return build.el;
      };
      const sl = (key, label, min, max, title = "") => setting(key, slider({
        label, min, max, value: this.settings[key], defaultValue: DEFAULT_SETTINGS[key], title,
        onInput: (v) => this.#setSetting(key, v), onChange: (v) => this.#commitSetting(key, v),
      }));

      // Sheet info.
      this.infoEl = h("dl", { class: "nm-info" });
      const info = section({ id: "nm-info", title: "Hoja" }, this.infoEl);

      // Face detection.
      const faces = section({ id: "nm-faces", title: "Caras" },
        setting("faces", select({
          label: "Detectar", value: this.settings.faces,
          options: [["auto", "Automático"], ["shading", "Por sombreado"], ["rounded", "Redondeado"], ["cells", "Bloque por celda"]],
          title: "Cómo se deciden las caras de cada pieza del dibujo:\nAutomático: elige por pieza\nPor sombreado: caras claras y oscuras del dibujo\nRedondeado: plantas y objetos curvos\nBloque por celda: un cubo por celda",
          onChange: (v) => { this.#setSetting("faces", v); this.#commitSetting("faces", v); },
        })),
        h("div", { class: "field" }, h("label", null, "Lado iluminado"),
          setting("litSide", segmented({
            label: "Lado iluminado", value: this.settings.litSide,
            options: [["auto", "Auto"], ["left", "Izq."], ["right", "Der."]],
            onChange: (v) => { this.#setSetting("litSide", v); this.#commitSetting("litSide", v); },
          }))),
        sl("minContrast", "Sombreado mín.", 0, 30, "Diferencia de brillo mínima para separar dos caras"),
        sl("roundness", "Redondez", 1, 12, "Cuánto se curvan las piezas redondeadas"),
        setting("cell", numberPair({
          label: "Celda (px)", values: [this.settings.cellW, this.settings.cellH], min: 1, max: 4096,
          titles: ["Ancho de celda", "Alto de celda"],
          onChange: ([w, hgt]) => this.#setCellSize(w, hgt),
        })));

      // Relief.
      const relief = section({ id: "nm-relief", title: "Relieve" },
        sl("strength", "Fuerza", 0, 100, "Cuánto se marca el relieve del dibujo"),
        sl("steps", "Pasos pixel-art", 0, 4, "0 = suave; más = sombreado en bandas planas, como pixel art"),
        sl("smooth", "Suavizado", 0, 3),
        setting("invert", checkbox({ label: "Invertir (oscuro = elevado)", value: this.settings.invert,
          onChange: (v) => { this.#setSetting("invert", v); this.#commitSetting("invert", v); } })),
        setting("perFace", checkbox({ label: "Relieve dentro de cada cara", value: this.settings.perFace,
          title: "El relieve no cruza el borde entre dos caras",
          onChange: (v) => { this.#setSetting("perFace", v); this.#commitSetting("perFace", v); } })));

      // Blender.
      this.cellLabel = h("span", { class: "muted" });
      this.offsetLabel = h("span", { class: "offset" });
      const nudge = (dx, dy, cls, text) => h("button", { class: cls, title: "Mover el render (flechas; Mayús = 8 px)", onclick: () => this.#nudge(dx, dy) }, text);
      this.importButton = h("button", { onclick: () => this.#pickImport(), title: "Importar un render de Blender (I)" }, "Importar PNG…");
      this.clearCellButton = h("button", { onclick: () => this.#clearCell(), title: "Volver la celda a automático (Supr)" }, "Quitar de la celda");
      this.nudgePad = h("div", { class: "nm-nudge" }, nudge(0, -1, "up", "↑"), nudge(-1, 0, "left", "←"), nudge(0, 1, "down", "↓"), nudge(1, 0, "right", "→"));
      this.importInput = h("input", { type: "file", accept: "image/png", hidden: true,
        onchange: async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) this.#importFile(f); } });
      const blender = section({ id: "nm-blender", title: "Normales de Blender" },
        h("div", { class: "field" }, h("label", null, "Celda"), this.cellLabel),
        h("div", { class: "row" }, this.importButton, this.clearCellButton),
        h("div", { class: "nm-import-row" }, this.nudgePad, this.offsetLabel),
        this.importInput,
        h("p", { class: "note" }, "Elige la celda con ", h("b", null, "Celda (C)"), " o ", h("b", null, "suelta el PNG sobre ella"),
          ". Un PNG del tamaño de la hoja se importa entero. Los renders del add-on vienen finales (alfa 254): no se les suma relieve."));

      // Preview light.
      const lightSlider = (key, label, min, max, unit = "") => {
        const s = slider({ label, min, max, value: this.light[key], defaultValue: DEFAULT_LIGHT[key], unit,
          onInput: (v) => { this.light[key] = v; this.redraw(); }, onChange: () => prefs.set("normals:light", this.light) });
        this.lightControls[key] = s;
        return s.el;
      };
      this.lightControls = {};
      const light = section({ id: "nm-light", title: "Luz de la vista previa", collapsed: true },
        h("div", { class: "nm-presets" }, LIGHT_PRESETS.map(([name, values]) => h("button", { onclick: () => this.#setLight(values) }, name))),
        lightSlider("sunAngle", "Sol: dirección", 0, 360, "°"),
        lightSlider("sunHeight", "Sol: altura", 1, 89, "°"),
        lightSlider("sunAmount", "Sol: fuerza", 0, 100),
        lightSlider("lightTop", "Luz arriba", 0, 100),
        lightSlider("lightLeft", "Luz izquierda", 0, 100),
        lightSlider("lightRight", "Luz derecha", 0, 100),
        h("p", { class: "note" }, "Solo afecta a la vista previa, no al archivo. Mismo cálculo que TileInstanced.fx: 0° = de frente a la cara derecha, 90° = a la izquierda; sol en 0 = noche o cueva."));

      // Save (always visible).
      this.outputSeg = segmented({ label: "Tipo de mapa", value: this.settings.output,
        options: [["n", "Caras + relieve (_n)", "Mapa completo"], ["d", "Solo relieve (_d)", "El juego lo dobla sobre las caras del cubo"]],
        onChange: (v) => { this.#setSetting("output", v); this.#commitSetting("output", v); } });
      c.output = this.outputSeg;
      this.saveFaces = h("input", { type: "checkbox", checked: prefs.get("normals:saveFaces", true), onchange: () => prefs.set("normals:saveFaces", this.saveFaces.checked) });
      this.registerMgcb = h("input", { type: "checkbox", checked: prefs.get("normals:registerMgcb", true), onchange: () => prefs.set("normals:registerMgcb", this.registerMgcb.checked) });
      this.saveButton = h("button", { class: "primary", onclick: () => this.save() }, "Guardar");
      this.downloadButton = h("button", { class: "icon", onclick: () => this.download(), title: "Descargar en vez de guardar en el proyecto (Ctrl+Shift+S)", "aria-label": "Descargar" }, "⤓");
      this.whereEl = h("div", { class: "where" });
      const save = h("div", { class: "nm-save" },
        this.outputSeg.el,
        h("div", { class: "opts" },
          h("label", { title: "Guarda las caras pintadas o importadas, para seguir editándolas otro día" }, this.saveFaces, "Guardar _faces.png"),
          h("label", { title: "Añade el mapa al Content.mgcb copiando la entrada de la hoja" }, this.registerMgcb, "Registrar en mgcb")),
        h("div", { class: "buttons" }, this.saveButton, this.downloadButton),
        this.whereEl);

      this.controls = c;
      return h("aside", { class: "nm-panel" },
        h("div", { class: "scroll" }, info.el, faces.el, relief.el, blender.el, light.el),
        save);
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Sheet list

    #renderList() {
      if (!this.listEl) return;
      clear(this.listEl);
      const q = this.filterInput.value.trim().toLowerCase();
      const shown = this.sheets.filter((s) => !q || s.id.toLowerCase().includes(q) || s.path.toLowerCase().includes(q));
      this.visibleSheets = [];

      if (!this.project && !this.sheet) {
        this.listEl.appendChild(h("div", { class: "empty-state" }, "Abre la carpeta del proyecto para ver sus hojas, o abre un PNG suelto."));
        return;
      }
      if (this.sheet?.file) {
        this.listEl.appendChild(h("div", { class: "group-head", style: "cursor: default" }, "Abierta suelta"));
        this.listEl.appendChild(this.#sheetRow(this.sheet));
      }
      if (this.project && !shown.length) {
        this.listEl.appendChild(h("div", { class: "empty-state" }, this.sheets.length ? "Ninguna hoja coincide." : "No encontré PNG en la carpeta."));
        return;
      }
      const groups = [["atlas", "Atlas", shown.filter((s) => s.atlas)], ["other", "Otras imágenes", shown.filter((s) => !s.atlas)]];
      for (const [key, title, items] of groups) {
        if (!items.length) continue;
        // While searching every group is open, so a match is never hidden.
        const collapsed = !q && prefs.get("normals:group:" + key, key === "other");
        const head = h("button", { class: ["group-head", collapsed && "collapsed"],
          onclick: () => { prefs.set("normals:group:" + key, !collapsed); this.#renderList(); } },
        h("span", { class: "chev" }, "▾"), `${title} · ${items.length}`);
        this.listEl.appendChild(head);
        if (collapsed) continue;
        for (const s of items) {
          this.visibleSheets.push(s);
          this.listEl.appendChild(this.#sheetRow(s));
        }
      }
      this.listEl.querySelector(".active")?.scrollIntoView({ block: "nearest" });
    }

    #sheetRow(s) {
      const active = this.sheet?.key === s.key;
      return h("div", {
        class: ["nm-sheet", active && "active"], role: "option", "aria-selected": String(active), title: s.path,
        onclick: () => this.openSheet(s),
      },
      h("span", { class: "id" }, active && this.isDirty() ? h("span", { class: "dot", title: "Sin guardar" }) : null, s.id),
      h("span", { class: "badges" },
        s.has?.n ? h("span", { class: "badge", title: "Tiene _n.png" }, "_n") : null,
        s.has?.d ? h("span", { class: "badge", title: "Tiene _d.png" }, "_d") : null,
        s.has?.faces ? h("span", { class: "badge plain", title: "Tiene caras pintadas (_faces.png)" }, "caras") : null),
      h("span", { class: "path" }, s.path));
    }

    #stepSheet(dir) {
      const list = this.visibleSheets ?? [];
      if (!list.length) return;
      const at = list.findIndex((s) => s.key === this.sheet?.key);
      const next = list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + dir))];
      if (next && next.key !== this.sheet?.key) this.openSheet(next);
    }

    #toggleList() {
      const narrow = window.matchMedia("(max-width: 960px)").matches;
      this.root.classList.toggle(narrow ? "show-list" : "no-list");
      requestAnimationFrame(() => this.redraw());
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Opening a sheet

    async openSheet(sheet) {
      if (this.sheet?.key === sheet.key) return;
      if (this.isDirty()) {
        const choice = await this.studio.askUnsaved(this.sheet.id);
        if (!choice) return;
        if (choice === "save" && !(await this.save())) return;
      }
      try {
        await this.studio.busy(this.#load(sheet));
      } catch (err) {
        this.studio.toast("No pude abrir la hoja.", { kind: "bad", detail: err.message });
      }
    }

    async #readCompanion(sheet, suffix, w, h) {
      let blob = null;
      if (sheet.file) {
        blob = sheet.files.get(`${stripExt(sheet.name).toLowerCase()}${suffix}.png`) ?? null;
      } else if (this.project) {
        const entry = this.project.get(companionPath(sheet.path, suffix));
        blob = entry ? await entry.handle.getFile() : null;
      }
      if (!blob) return null;
      const img = await decodePng(blob);
      if (img.w === w && img.h === h) return img.rgba;
      this.studio.toast(`${suffix}.png no mide lo mismo que la hoja; lo ignoro.`, { kind: "warn" });
      return null;
    }

    async #load(sheet) {
      this.studio.setStatus("Abriendo " + sheet.id + "…");
      const blob = sheet.file ?? await sheet.entry.handle.getFile();
      const img = await decodePng(blob);
      const loaded = { ...sheet, w: img.w, h: img.h, rgba: img.rgba };
      loaded.heightRgba = await this.#readCompanion(sheet, "_height", img.w, img.h);
      loaded.fileRgba = { n: await this.#readCompanion(sheet, "_n", img.w, img.h), d: await this.#readCompanion(sheet, "_d", img.w, img.h) };
      const faces = await this.#readCompanion(sheet, "_faces", img.w, img.h);

      this.sheet = loaded;
      this.ov = Overrides.fromFacesPng(img.w, img.h, faces);
      this.result = null;
      this.cell = null;
      this.imp = null;
      this.settings = this.#loadSettings(sheet);
      this.committed = { ...this.settings };
      this.history.clear();
      this.history.markSaved();
      this.#writeSettingsToUi();
      this.renderer.setSheet(loaded);
      this.renderer.setFile(loaded.fileRgba[this.settings.output]);
      this.#renderList();
      this.#renderEmpty();
      this.#updateUi();
      this.#fit();
      this.#requestCompute(0);
      const extras = [faces && "caras pintadas", loaded.heightRgba && "altura", (loaded.fileRgba.n || loaded.fileRgba.d) && "mapa guardado"].filter(Boolean);
      this.studio.setStatus(`${sheet.id} abierta · ${img.w}×${img.h}${extras.length ? " · con " + extras.join(", ") : ""}.`, "ok");
    }

    async #openLoose(fileList) {
      const sheet = looseSheet(fileList);
      if (!sheet) {
        this.studio.toast("No veo una hoja PNG.", { kind: "warn", detail: "Los archivos _n / _d / _faces / _height acompañan a una hoja; abre también la hoja." });
        return;
      }
      await this.openSheet(sheet);
    }

    // Per-sheet settings; the previous tool stored them under "aura-normals:<path>", read once for continuity.
    #loadSettings(sheet) {
      let saved = prefs.get("normals:settings:" + sheet.key, null);
      if (!saved) {
        try { saved = JSON.parse(localStorage.getItem("aura-normals:" + sheet.key) || "null"); } catch { saved = null; }
      }
      return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
    }

    #storeSettings() {
      if (this.sheet) prefs.set("normals:settings:" + this.sheet.key, this.settings);
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Settings (each change is one undo step; a slider drag is one change)

    #setSetting(key, value) {
      this.settings[key] = value;
      this.#storeSettings();
      if (key === "output") {
        this.renderer.setFile(this.sheet?.fileRgba?.[value] ?? null);
        this.#updateSaveUi();
      }
      if (key === "cellW" || key === "cellH") this.cell = null;
      this.#requestCompute();
      this.redraw();
    }

    #commitSetting(key, value) {
      const before = this.committed[key];
      if (before === value || !this.sheet) {
        this.committed[key] = value;
        return;
      }
      this.committed[key] = value;
      this.history.push({
        label: "Cambiar " + SETTING_LABELS[key],
        undo: () => this.#applySetting(key, before),
        redo: () => this.#applySetting(key, value),
      }, { mergeKey: "set:" + key });
    }

    #applySetting(key, value) {
      this.committed[key] = value;
      this.#setSetting(key, value);
      this.#writeSettingsToUi();
    }

    #setCellSize(w, hgt) {
      w = Math.max(1, Math.min(4096, w | 0));
      hgt = Math.max(1, Math.min(4096, hgt | 0));
      const before = [this.committed.cellW, this.committed.cellH];
      if (before[0] === w && before[1] === hgt) return;
      const apply = ([cw, ch]) => {
        this.committed.cellW = cw;
        this.committed.cellH = ch;
        this.settings.cellW = cw;
        this.settings.cellH = ch;
        this.cell = null;
        this.imp = null;
        this.#storeSettings();
        this.#writeSettingsToUi();
        this.#requestCompute();
        this.#updateUi();
      };
      apply([w, hgt]);
      if (this.sheet) this.history.push({ label: "Cambiar tamaño de celda", undo: () => apply(before), redo: () => apply([w, hgt]) });
    }

    #writeSettingsToUi() {
      const c = this.controls, s = this.settings;
      for (const key of ["minContrast", "roundness", "strength", "steps", "smooth", "faces", "litSide", "invert", "perFace", "output"]) {
        c[key].set(s[key]);
      }
      c.cell.set([s.cellW, s.cellH]);
    }

    #setLight(values) {
      Object.assign(this.light, values);
      for (const [key, control] of Object.entries(this.lightControls)) control.set(this.light[key]);
      prefs.set("normals:light", this.light);
      this.redraw();
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Compute

    #requestCompute(delay = 120) {
      if (!this.sheet) return;
      const s = this.sheet;
      this.compute.request({
        w: s.w, h: s.h, rgba: s.rgba, heightRgba: s.heightRgba,
        ovHas: this.ov.has, ovN: this.ov.n, ovFixed: this.ov.fixed, settings: { ...this.settings },
      }, delay);
      this.studio.slot("compute", "calculando…");
    }

    #onResult(r) {
      this.result = r;
      this.resultSettings = { ...this.settings };
      const n = r.w * r.h;
      const normal = new Uint8ClampedArray(n * 4), base = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) {
        if (r.has[i]) {
          normal[i * 4] = encodeChannel(r.nx[i]); normal[i * 4 + 1] = encodeChannel(r.ny[i]); normal[i * 4 + 2] = encodeChannel(r.nz[i]);
          normal[i * 4 + 3] = 255;
        }
        if (r.hasBase[i]) {
          base[i * 4] = encodeChannel(r.bx[i]); base[i * 4 + 1] = encodeChannel(r.by[i]); base[i * 4 + 2] = encodeChannel(r.bz[i]);
          base[i * 4 + 3] = 255;
        }
      }
      this.encoded = normal;
      this.renderer.setResult(normal, base);
      this.renderer.invalidate();
      this.redraw();
      this.#updateSlots();
    }

    #updateSlots() {
      if (!this.#isActive()) return;
      const r = this.result;
      let text = "";
      if (this.compute.pending) text = "calculando…";
      else if (r) {
        text = `${Math.round(r.ms)} ms`;
        if (this.settings.faces !== "cells" && this.settings.litSide === "auto" && r.litLeft !== undefined) {
          text += ` · luz detectada a la ${r.litLeft ? "izquierda" : "derecha"}`;
        }
      }
      this.studio.slot("compute", text, this.compute.inWorker ? "Calculado en segundo plano" : "Calculado en la página");
      this.studio.slot("zoom", this.sheet ? Math.round(this.viewport.zoom * 100) + "%" : "");
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Drawing

    redraw = rafThrottle(() => this.#draw());

    #draw() {
      if (!this.viewport) return;
      const v = this.viewport;
      const view = this.holdArt ? "art" : this.view;
      const { w: cssW } = v.size();
      this.renderer.draw({
        view, zoom: v.zoom, panX: v.panX, panY: v.panY,
        cellW: this.settings.cellW, cellH: this.settings.cellH,
        detail: (this.resultSettings ?? this.settings).output === "d",
        light: this.#lightUniforms(),
        split: this.compare && !this.holdArt && view !== "art" ? Math.round(cssW * this.split) : -1,
      });
      this.#drawOverlay();
      this.zoomLabel.textContent = Math.round(v.zoom * 100) + "%";
      if (this.#isActive()) this.studio.slot("zoom", this.sheet ? Math.round(v.zoom * 100) + "%" : "");
    }

    #lightUniforms() {
      const L = this.light;
      return {
        angle: L.sunAngle * Math.PI / 180, height: L.sunHeight * Math.PI / 180, amount: L.sunAmount / 100,
        top: L.lightTop / 100, left: L.lightLeft / 100, right: L.lightRight / 100,
      };
    }

    #drawOverlay() {
      const canvas = this.overlay, dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const W = Math.max(1, Math.round(rect.width * dpr)), H = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const s = this.sheet;
      if (!s) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const v = this.viewport, z = v.zoom;
      const cw = Math.max(1, this.settings.cellW), ch = Math.max(1, this.settings.cellH);
      const x0 = v.panX, y0 = v.panY, x1 = x0 + s.w * z, y1 = y0 + s.h * z;

      // Pixel grid when zoomed in far enough to paint single pixels.
      if (z >= 14) {
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        const fromX = Math.max(0, Math.floor(-x0 / z)), toX = Math.min(s.w, Math.ceil((rect.width - x0) / z));
        const fromY = Math.max(0, Math.floor(-y0 / z)), toY = Math.min(s.h, Math.ceil((rect.height - y0) / z));
        for (let x = fromX; x <= toX; x++) { const px = Math.round(x0 + x * z) + 0.5; ctx.moveTo(px, Math.max(0, y0)); ctx.lineTo(px, Math.min(rect.height, y1)); }
        for (let y = fromY; y <= toY; y++) { const py = Math.round(y0 + y * z) + 0.5; ctx.moveTo(Math.max(0, x0), py); ctx.lineTo(Math.min(rect.width, x1), py); }
        ctx.stroke();
      }

      if (this.showGrid && cw * z >= 6 && ch * z >= 6) {
        ctx.strokeStyle = "rgba(255,255,255,0.13)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x <= s.w; x += cw) { const px = Math.round(x0 + x * z) + 0.5; ctx.moveTo(px, y0); ctx.lineTo(px, y1); }
        for (let y = 0; y <= s.h; y += ch) { const py = Math.round(y0 + y * z) + 0.5; ctx.moveTo(x0, py); ctx.lineTo(x1, py); }
        ctx.stroke();
      }

      const cellRect = (cx, cy) => [Math.round(x0 + cx * cw * z), Math.round(y0 + cy * ch * z), Math.round(cw * z), Math.round(ch * z)];
      if (this.tool === "cell" && this.cursor && this.#inside(this.cursor)) {
        const [x, y, w, hh] = cellRect(Math.floor(this.cursor.x / cw), Math.floor(this.cursor.y / ch));
        ctx.fillStyle = "rgba(95,211,176,0.10)";
        ctx.fillRect(x, y, w, hh);
      }
      if (this.cell) {
        const [x, y, w, hh] = cellRect(this.cell.cx, this.cell.cy);
        ctx.strokeStyle = "#5fd3b0";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, hh - 2);
      }

      if (this.cursor && PAINT_TOOLS.has(this.tool) && !v.isPanning) {
        const size = this.brush, half = Math.floor((size - 1) / 2);
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 3;
        const bx = Math.round(x0 + (this.cursor.x - half) * z) + 0.5, by = Math.round(y0 + (this.cursor.y - half) * z) + 0.5;
        ctx.strokeRect(bx, by, size * z, size * z);
        ctx.strokeStyle = this.tool === "erase" ? "#ef6f6c" : "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, size * z, size * z);
      }

      if (this.compare && !this.holdArt && this.view !== "art") {
        const sx = Math.round(rect.width * this.split) + 0.5;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, rect.height);
        ctx.stroke();
        ctx.fillStyle = "#e6e8eb";
        ctx.beginPath();
        ctx.arc(sx, rect.height / 2, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#131518";
        ctx.font = "11px system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("⇔", sx, rect.height / 2 + 1);
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(sx - 52, 8, 44, 18);
        ctx.fillRect(sx + 8, 8, 52, 18);
        ctx.fillStyle = "#e6e8eb";
        ctx.fillText("Arte", sx - 30, 17);
        ctx.fillText(VIEW_OPTIONS.find((o) => o[0] === this.view)?.[1] ?? "", sx + 34, 17);
      }
    }

    #inside(p) {
      return this.sheet && p.x >= 0 && p.y >= 0 && p.x < this.sheet.w && p.y < this.sheet.h;
    }

    #fit() {
      if (!this.sheet) return;
      this.viewport.fit(this.sheet.w, this.sheet.h);
    }

    #renderEmpty() {
      if (!this.emptyEl) return;
      clear(this.emptyEl);
      this.emptyEl.hidden = !!this.sheet;
      this.hint.hidden = !this.sheet;
      if (this.sheet) return;
      const studio = this.studio;
      const card = h("div", { class: "card" });
      if (!this.project) {
        card.append(
          h("h1", null, "Normal maps"),
          h("p", null, "Abre la carpeta del proyecto: se listan las hojas de tus atlases.json, y cada mapa se guarda junto a su hoja y se registra en el Content.mgcb."),
          h("div", { class: "actions" },
            studio.lastHandle
              ? h("button", { class: "primary", onclick: () => studio.reopenProject() }, "Reabrir «" + studio.lastHandle.name + "»")
              : null,
            h("button", { class: studio.lastHandle ? "" : "primary", onclick: () => studio.pickProject() }, "Abrir carpeta…"),
            h("button", { onclick: () => this.fileInput.click() }, "Abrir PNG suelto…")),
          h("p", { class: "tip" }, "También puedes arrastrar una hoja aquí. ", h("span", { class: "kbd" }, prettyKey("Ctrl+K")), " abre la lista de comandos y ", h("span", { class: "kbd" }, "?"), " los atajos."));
      } else {
        card.append(
          h("h1", null, "Elige una hoja"),
          h("p", null, `${this.sheets.filter((s) => s.atlas).length} atlas y ${this.sheets.filter((s) => !s.atlas).length} imágenes más en «${this.project.name}». Elige una en la lista, o `,
            h("span", { class: "kbd" }, "Alt+↓"), " para abrir la primera."));
      }
      this.emptyEl.appendChild(card);
    }

    // -------------------------------------------------------------------------------------------------------------------
    // View & tools

    #setView(view) {
      if (view === "file" && !this.renderer.hasFile) {
        this.studio.toast(`No hay ${this.#outputName() || "mapa"} guardado para esta hoja.`, { kind: "warn" });
        this.viewSeg.set(this.view);
        return;
      }
      this.view = view;
      this.viewSeg.set(view);
      prefs.set("normals:view", view);
      this.redraw();
    }

    #toggleCompare() {
      this.compare = !this.compare;
      this.compareButton.classList.toggle("on", this.compare);
      this.redraw();
    }

    #toggleGrid() {
      this.showGrid = !this.showGrid;
      prefs.set("normals:grid", this.showGrid);
      this.gridButton.classList.toggle("on", this.showGrid);
      this.redraw();
    }

    #setTool(tool) {
      this.tool = tool;
      for (const [id, b] of this.toolButtons) b.classList.toggle("on", id === tool);
      this.brushEl.hidden = !PAINT_TOOLS.has(tool);
      this.glCanvas.style.cursor = tool === "move" ? "grab" : tool === "cell" ? "pointer" : "crosshair";
      this.#updateHint();
      this.redraw();
    }

    #setBrush(size) {
      this.brush = Math.max(1, Math.min(32, size | 0));
      this.brushRange.value = String(this.brush);
      this.brushOut.textContent = String(this.brush);
      prefs.set("normals:brush", this.brush);
      this.redraw();
    }

    #updateHint() {
      const hints = {
        move: "Arrastra para mover · rueda: zoom · mantén A: ver el arte",
        cell: "Clic: elegir la celda donde importar · suelta un PNG de Blender sobre una celda",
        erase: "Pinta para volver a lo automático · [ ] tamaño del pincel",
      };
      this.hint.textContent = hints[this.tool] ?? "Pinta la cara · [ ] tamaño del pincel · Espacio + arrastrar: mover";
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Pointer

    #bindPointer() {
      const canvas = this.glCanvas;
      let stroke = null, splitDrag = false;

      canvas.addEventListener("pointerdown", (e) => {
        // Working on the picture hands the keyboard back to the shortcuts (a number field keeps focus otherwise).
        if (isTyping()) document.activeElement.blur();
        if (!this.sheet) return;
        if (this.compare && Math.abs(this.#splitX() - this.#localX(e)) < 8 && e.button === 0) {
          splitDrag = true;
          canvas.setPointerCapture(e.pointerId);
          return;
        }
        if (this.viewport.wantsPan(e) || e.button !== 0) return;
        const p = this.#pixel(e);
        if (this.tool === "cell") {
          this.#selectCell(p);
          return;
        }
        if (!PAINT_TOOLS.has(this.tool)) return;
        canvas.setPointerCapture(e.pointerId);
        stroke = { patch: this.ov.begin(), last: p };
        this.#paintAt(stroke.patch, p.x, p.y);
        this.#requestCompute(60);
      });

      canvas.addEventListener("pointermove", (e) => {
        if (!this.sheet) return;
        if (splitDrag) {
          const { w } = this.viewport.size();
          this.split = Math.min(0.98, Math.max(0.02, this.#localX(e) / w));
          this.redraw();
          return;
        }
        const p = this.#pixel(e);
        this.cursor = p;
        if (stroke) {
          this.#paintLine(stroke.patch, stroke.last, p);
          stroke.last = p;
          this.#requestCompute(60);
        }
        this.#updateCursorSlot();
        canvas.style.cursor = this.compare && Math.abs(this.#splitX() - this.#localX(e)) < 8 ? "ew-resize"
          : this.tool === "move" ? "grab" : this.tool === "cell" ? "pointer" : "crosshair";
        this.redraw();
      });

      const end = () => {
        splitDrag = false;
        if (!stroke) return;
        const command = stroke.patch.toCommand(this.tool === "erase" ? "Borrar caras" : "Pintar caras", () => this.#afterOverrideChange());
        stroke = null;
        if (command) this.history.push(command);
      };
      canvas.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", end);
      canvas.addEventListener("pointerleave", () => { this.cursor = null; this.#updateCursorSlot(); this.redraw(); });
    }

    #localX(e) {
      return e.clientX - this.glCanvas.getBoundingClientRect().left;
    }

    #splitX() {
      return this.viewport.size().w * this.split;
    }

    #pixel(e) {
      const p = this.viewport.toImage(e.clientX, e.clientY);
      return { x: Math.floor(p.x), y: Math.floor(p.y) };
    }

    #updateCursorSlot() {
      if (!this.#isActive()) return;
      const p = this.cursor;
      if (!p || !this.#inside(p)) { this.studio.slot("cursor", ""); return; }
      const cw = Math.max(1, this.settings.cellW), ch = Math.max(1, this.settings.cellH);
      this.studio.slot("cursor", `x ${p.x} · y ${p.y} · celda ${Math.floor(p.x / cw)}, ${Math.floor(p.y / ch)}`);
    }

    #paintAt(patch, x, y) {
      const s = this.sheet, size = this.brush, half = Math.floor((size - 1) / 2);
      const face = FACE_NORMALS[this.tool];
      for (let py = y - half; py < y - half + size; py++) {
        for (let px = x - half; px < x - half + size; px++) {
          if (px < 0 || py < 0 || px >= s.w || py >= s.h) continue;
          const i = py * s.w + px;
          if (s.rgba[i * 4 + 3] === 0) continue;
          if (this.tool === "erase") patch.clear(i);
          else patch.set(i, face, false);
        }
      }
    }

    #paintLine(patch, a, b) {
      const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
      for (let t = 0; t <= steps; t++) {
        this.#paintAt(patch, Math.round(a.x + (b.x - a.x) * t / steps), Math.round(a.y + (b.y - a.y) * t / steps));
      }
    }

    #afterOverrideChange() {
      this.#requestCompute(0);
      this.#updateInfo();
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Blender import

    #selectCell(p) {
      if (!this.#inside(p)) return;
      const cw = Math.max(1, this.settings.cellW), ch = Math.max(1, this.settings.cellH);
      const cell = { cx: Math.floor(p.x / cw), cy: Math.floor(p.y / ch) };
      if (this.cell && this.cell.cx === cell.cx && this.cell.cy === cell.cy) return;
      this.cell = cell;
      this.imp = null;
      this.#updateBlenderUi();
      this.redraw();
    }

    #pickImport() {
      if (!this.sheet) return;
      this.importInput.click();
    }

    async #importFile(file, dropPoint = null) {
      try {
        const img = await decodePng(file);
        const full = img.w === this.sheet.w && img.h === this.sheet.h;
        if (!full) {
          if (dropPoint) this.#selectCell(dropPoint);
          if (!this.cell) {
            this.studio.toast("Elige primero la celda.", { kind: "warn", detail: "Con la herramienta Celda (C), o suelta el PNG directamente sobre la celda." });
            this.#setTool("cell");
            return;
          }
        }
        this.imp = { img, full, cells: full ? this.#cellsCovered(img) : null, dx: 0, dy: 0, command: null, name: file.name };
        this.#applyImport(true);
      } catch (err) {
        this.studio.toast("No pude leer el PNG.", { kind: "bad", detail: err.message });
      }
    }

    // The cells a full-sheet render actually covers: only those are replaced, so faces painted elsewhere stay.
    #cellsCovered(img) {
      const cw = Math.max(1, this.settings.cellW), ch = Math.max(1, this.settings.cellH);
      const cells = new Set();
      for (let y = 0; y < img.h; y++) {
        for (let x = 0; x < img.w; x++) {
          if (img.rgba[(y * img.w + x) * 4 + 3] >= 128) cells.add(Math.floor(y / ch) * 65536 + Math.floor(x / cw));
        }
      }
      return cells;
    }

    /** Places the current import at its offset. A re-placement (nudge) amends the same undo step while it is the latest. */
    #applyImport(fresh) {
      const imp = this.imp, s = this.sheet, img = imp.img;
      const cw = Math.max(1, this.settings.cellW), ch = Math.max(1, this.settings.cellH);
      const amend = !fresh && imp.command && this.history.last === imp.command && this.history.dirty;
      if (amend) imp.command.undo();

      const patch = this.ov.begin();
      const rects = imp.full
        ? [...imp.cells].map((k) => ({ x: (k % 65536) * cw, y: Math.floor(k / 65536) * ch, w: cw, h: ch }))
        : [{ x: this.cell.cx * cw, y: this.cell.cy * ch, w: cw, h: ch }];
      const originX = imp.full ? 0 : rects[0].x, originY = imp.full ? 0 : rects[0].y;
      let placed = 0, outside = 0, final = 0, spritePixels = 0, uncovered = 0;
      for (const r of rects) {
        for (let y = r.y; y < Math.min(s.h, r.y + r.h); y++) {
          for (let x = r.x; x < Math.min(s.w, r.x + r.w); x++) patch.clear(y * s.w + x);
        }
        for (let y = r.y; y < Math.min(s.h, r.y + r.h); y++) {
          for (let x = r.x; x < Math.min(s.w, r.x + r.w); x++) {
            const i = y * s.w + x;
            const ix = x - originX - imp.dx, iy = y - originY - imp.dy;
            const inImg = ix >= 0 && iy >= 0 && ix < img.w && iy < img.h;
            const k = inImg ? (iy * img.w + ix) * 4 : -1;
            const sprite = s.rgba[i * 4 + 3] > 0;
            if (sprite) spritePixels++;
            if (!inImg || img.rgba[k + 3] < 128) {
              if (sprite) uncovered++;
              continue;
            }
            if (!sprite) { outside++; continue; }
            const isFinal = img.rgba[k + 3] === RELIEF_ALPHA;
            patch.set(i, decode(img.rgba[k], img.rgba[k + 1], img.rgba[k + 2]), isFinal);
            placed++;
            if (isFinal) final++;
          }
        }
      }

      const label = imp.full ? "Importar normales (hoja completa)" : "Importar normales en la celda";
      const command = patch.toCommand(label, () => this.#afterOverrideChange());
      if (amend && command) {
        imp.command.undo = command.undo;
        imp.command.redo = command.redo;
      } else if (amend && !command) {
        // Re-placed exactly where it was before the import: the step undoes to nothing; keep it, it costs nothing.
      } else if (command) {
        imp.command = command;
        this.history.push(command);
      }
      this.#afterOverrideChange();
      this.#updateBlenderUi();

      const share = spritePixels ? (spritePixels - uncovered) / spritePixels : 0;
      const relief = final > placed / 2 ? "finales de Blender (sin relieve extra)" : "sin marca de final: se les suma el relieve del dibujo";
      const detail = `${placed} píxeles ${relief} · ${uncovered} del sprite sin cubrir · ${outside} del render fuera del sprite.`;
      if (spritePixels && share < 0.9) {
        this.studio.setStatus("Importado, pero no calza bien — muévelo con las flechas. " + detail, "warn");
      } else {
        this.studio.setStatus("Importado. " + detail, "ok");
      }
    }

    #nudge(dx, dy) {
      if (!this.imp) return;
      this.imp.dx += dx;
      this.imp.dy += dy;
      this.#applyImport(false);
    }

    #clearCell() {
      if (!this.sheet || !this.cell) return;
      const s = this.sheet, cw = Math.max(1, this.settings.cellW), ch = Math.max(1, this.settings.cellH);
      const patch = this.ov.begin();
      for (let y = this.cell.cy * ch; y < Math.min(s.h, (this.cell.cy + 1) * ch); y++) {
        for (let x = this.cell.cx * cw; x < Math.min(s.w, (this.cell.cx + 1) * cw); x++) patch.clear(y * s.w + x);
      }
      const command = patch.toCommand("Quitar caras de la celda", () => this.#afterOverrideChange());
      this.imp = null;
      if (!command) {
        this.studio.setStatus("Esa celda ya estaba en automático.");
        return;
      }
      this.history.push(command);
      this.#afterOverrideChange();
      this.#updateBlenderUi();
      this.studio.setStatus("Celda vuelta a automático.", "ok");
    }

    #bindDrop() {
      const el = this.viewportEl;
      let depth = 0;
      el.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; el.classList.add("dragging"); });
      el.addEventListener("dragover", (e) => e.preventDefault());
      el.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; el.classList.remove("dragging"); } });
      el.addEventListener("drop", async (e) => {
        e.preventDefault();
        depth = 0;
        el.classList.remove("dragging");
        const files = [...e.dataTransfer.files].filter((f) => /\.png$/i.test(f.name));
        if (!files.length) return;
        if (!this.sheet) return this.#openLoose(files);

        const img = await decodePng(files[0]);
        if (img.w === this.sheet.w && img.h === this.sheet.h) {
          const asImport = await this.studio.confirm({
            title: "PNG del tamaño de la hoja",
            message: `«${files[0].name}» mide lo mismo que ${this.sheet.id}. ¿Son normales de Blender para toda la hoja, o es otra hoja que quieres abrir?`,
            confirm: "Importar normales", cancel: "Abrir como hoja",
          });
          if (asImport) return this.#importFile(files[0]);
          return this.#openLoose(files);
        }
        const p = this.viewport.toImage(e.clientX, e.clientY);
        this.#importFile(files[0], { x: Math.floor(p.x), y: Math.floor(p.y) });
      });
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Undo

    #undo() {
      const c = this.history.undo();
      if (c) this.studio.setStatus("Deshecho: " + c.label);
    }

    #redo() {
      const c = this.history.redo();
      if (c) this.studio.setStatus("Rehecho: " + c.label);
    }

    #onHistory() {
      this.undoButton.disabled = !this.history.canUndo;
      this.redoButton.disabled = !this.history.canRedo;
      this.undoButton.title = this.history.canUndo ? `Deshacer: ${this.history.undoLabel} (${prettyKey("Ctrl+Z")})` : "Nada que deshacer";
      this.redoButton.title = this.history.canRedo ? `Rehacer: ${this.history.redoLabel} (${prettyKey("Ctrl+Shift+Z")})` : "Nada que rehacer";
      this.studio.refreshDirty();
      this.#updateSaveUi();
      const row = this.listEl.querySelector(".nm-sheet.active .id");
      if (row) {
        row.querySelector(".dot")?.remove();
        if (this.isDirty()) row.prepend(h("span", { class: "dot", title: "Sin guardar" }));
      }
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Saving

    #outputName() {
      if (!this.sheet) return "";
      return stripExt(this.sheet.name) + (this.settings.output === "d" ? "_d" : "_n") + ".png";
    }

    #facesRgba() {
      const s = this.sheet, ov = this.ov, n = s.w * s.h;
      const out = new Uint8ClampedArray(n * 4);
      let any = false;
      for (let i = 0; i < n; i++) {
        if (!ov.has[i]) continue;
        any = true;
        out[i * 4] = encodeChannel(ov.n[i * 3]);
        out[i * 4 + 1] = encodeChannel(ov.n[i * 3 + 1]);
        out[i * 4 + 2] = encodeChannel(ov.n[i * 3 + 2]);
        out[i * 4 + 3] = ov.fixed[i] ? RELIEF_ALPHA : 255;
      }
      return any ? out : null;
    }

    /** Writes the map (and faces) next to the sheet. Resolves true when saved. */
    async save() {
      const s = this.sheet;
      if (!s) return false;
      if (!s.entry) {
        await this.download();
        return true;
      }
      this.saveButton.disabled = true;
      try {
        return await this.studio.busy(this.#saveToProject(s));
      } catch (err) {
        this.studio.toast("No pude guardar.", { kind: "bad", detail: err.message });
        return false;
      } finally {
        this.#updateSaveUi();
      }
    }

    async #saveToProject(s) {
      this.studio.setStatus("Guardando…");
      await this.compute.whenIdle();
      const dir = s.entry.dir, folder = dirName(s.path);
      const project = this.project;
      const backups = [];
      const writeKeepingBackup = async (name, blob) => {
        const path = joinPath(folder, name);
        const existing = project.get(path);
        backups.push({ name, path, previous: existing ? await existing.handle.getFile() : null });
        const handle = await writeInDir(dir, name, blob);
        project.addFile(path, handle, dir);
      };

      const written = [];
      const mapName = this.#outputName();
      await writeKeepingBackup(mapName, await encodePng(s.w, s.h, this.encoded));
      written.push(mapName);

      let facesNote = "";
      const facesName = stripExt(s.name) + "_faces.png";
      if (this.saveFaces.checked) {
        const faces = this.#facesRgba();
        if (faces) {
          await writeKeepingBackup(facesName, await encodePng(s.w, s.h, faces));
          written.push(facesName);
        } else if (project.get(joinPath(folder, facesName))) {
          // Every painted face was erased: an old _faces.png would bring them back next time.
          const entry = project.get(joinPath(folder, facesName));
          backups.push({ name: facesName, path: entry.path, previous: await entry.handle.getFile() });
          await dir.removeEntry(facesName);
          project.files.delete(entry.lower);
          facesNote = ` · quitado ${facesName} (ya no hay caras pintadas)`;
        }
      }

      let mgcbNote = "";
      if (this.registerMgcb.checked && s.mgcb && s.rel) {
        const before = await readText(s.mgcb.handle);
        const { text, result } = addToMgcb(before, s.rel, mapName);
        if (result !== "already") await writeHandle(s.mgcb.handle, text);
        mgcbNote = { already: " · ya estaba en el mgcb", copied: " · añadido al mgcb (copiando la entrada de la hoja)", new: " · añadido al mgcb (entrada nueva)" }[result];
      }

      s.fileRgba[this.settings.output] = this.encoded;
      this.renderer.setFile(this.encoded);
      refreshCompanions(project, s);
      const listed = this.sheets.find((x) => x.key === s.key);
      if (listed) listed.has = s.has;
      this.history.markSaved();
      this.#renderList();
      this.studio.setStatus("Guardado: " + written.join(", ") + facesNote + mgcbNote + ".", "ok");
      this.studio.toast("Guardado " + written.join(", "), {
        kind: "ok", detail: facesNote.replace(/^ · /, "") || undefined,
        action: { label: "Restaurar anterior", run: () => this.#restore(dir, backups) },
      });
      return true;
    }

    // Puts back the files as they were before the last save (the mgcb entry stays: it is harmless and already built).
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
        refreshCompanions(this.project, this.sheet);
        this.#renderList();
        this.studio.toast("Archivos restaurados a como estaban antes de guardar.", { kind: "ok" });
      } catch (err) {
        this.studio.toast("No pude restaurar.", { kind: "bad", detail: err.message });
      }
    }

    async download() {
      const s = this.sheet;
      if (!s) return;
      await this.compute.whenIdle();
      downloadBlob(await encodePng(s.w, s.h, this.encoded), this.#outputName());
      const faces = this.#facesRgba();
      if (this.saveFaces.checked && faces) downloadBlob(await encodePng(s.w, s.h, faces), stripExt(s.name) + "_faces.png");
      this.studio.setStatus("Descargado " + this.#outputName() + (s.entry ? "" : " — cópialo junto a la hoja."), "ok");
    }

    // -------------------------------------------------------------------------------------------------------------------
    // UI state

    #updateUi() {
      this.#setTool(this.tool);
      this.viewSeg.set(this.view);
      this.gridButton.classList.toggle("on", this.showGrid);
      this.#onHistory();
      this.#updateInfo();
      this.#updateBlenderUi();
      this.#updateSaveUi();
      this.#updateHint();
    }

    #updateInfo() {
      if (!this.infoEl) return;
      clear(this.infoEl);
      const s = this.sheet;
      if (!s) {
        this.infoEl.append(h("dt", null, "—"), h("dd", { class: "muted" }, "Ninguna hoja abierta"));
        return;
      }
      let painted = 0, blender = 0;
      for (let i = 0; i < this.ov.has.length; i++) {
        if (!this.ov.has[i]) continue;
        if (this.ov.fixed[i]) blender++; else painted++;
      }
      const row = (k, v, title = "") => [h("dt", null, k), h("dd", { title: title || String(v) }, v)];
      this.infoEl.append(
        ...row("Hoja", s.id),
        ...row("Tamaño", `${s.w} × ${s.h} px · ${Math.floor(s.w / this.settings.cellW)} × ${Math.floor(s.h / this.settings.cellH)} celdas`),
        ...row("Archivo", s.path),
        ...row("mgcb", s.mgcb ? s.mgcb.path : (s.entry ? "ninguno encontrado" : "— (suelta)")),
        ...row("Caras", painted || blender ? `${painted} px pintados · ${blender} px de Blender` : "todo automático"),
        ...(s.heightRgba ? row("Altura", "usa _height.png") : []));
    }

    #updateBlenderUi() {
      if (!this.cellLabel) return;
      const c = this.cell;
      this.cellLabel.textContent = c ? `columna ${c.cx + 1}, fila ${c.cy + 1}` : "— elige con «Celda» (C)";
      this.importButton.disabled = !this.sheet;
      this.clearCellButton.disabled = !this.sheet || !c;
      const canNudge = !!this.imp;
      for (const b of this.nudgePad.querySelectorAll("button")) b.disabled = !canNudge;
      this.offsetLabel.textContent = this.imp ? `desplazado ${this.imp.dx}, ${this.imp.dy} px` : "";
    }

    #updateSaveUi() {
      if (!this.saveButton) return;
      const s = this.sheet;
      const name = this.#outputName();
      this.saveButton.disabled = !s;
      this.downloadButton.disabled = !s;
      clear(this.saveButton).append(s && !s.entry ? "Descargar" : "Guardar", h("span", { class: "kbd" }, prettyKey("Ctrl+S")));
      this.saveButton.title = s ? (s.entry ? "Guardar " : "Descargar ") + name : "";
      this.registerMgcb.disabled = !s?.entry || !s.mgcb;
      let where = "";
      if (s && !s.entry) where = `Hoja suelta: se descarga ${name}; cópialo junto a la hoja.`;
      else if (s) where = joinPath(dirName(s.path), name) + (s.mgcb ? " · " + baseName(s.mgcb.path) : " · sin .mgcb encontrado");
      this.whereEl.textContent = where + (s && this.isDirty() ? " · cambios sin guardar" : "");
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Commands

    #registerCommands() {
      const hasSheet = () => !!this.sheet;
      const G = { view: "Vista", tools: "Herramientas", file: "Archivo", edit: "Edición", blender: "Blender", nav: "Hojas" };
      const list = [
        { id: "nm.save", title: "Guardar el mapa", group: G.file, keys: ["Ctrl+S"], whileTyping: true, enabled: hasSheet, run: () => this.save() },
        { id: "nm.download", title: "Descargar el mapa", group: G.file, keys: ["Ctrl+Shift+S"], whileTyping: true, enabled: hasSheet, run: () => this.download() },
        { id: "nm.openLoose", title: "Abrir PNG suelto…", group: G.file, run: () => this.fileInput.click() },
        { id: "nm.undo", title: "Deshacer", group: G.edit, keys: ["Ctrl+Z"], enabled: () => this.history.canUndo, run: () => this.#undo() },
        { id: "nm.redo", title: "Rehacer", group: G.edit, keys: ["Ctrl+Shift+Z", "Ctrl+Y"], enabled: () => this.history.canRedo, run: () => this.#redo() },
        { id: "nm.find", title: "Buscar hoja", group: G.nav, keys: ["Ctrl+F"], whileTyping: true, run: () => { this.filterInput.focus(); this.filterInput.select(); } },
        { id: "nm.next", title: "Hoja siguiente", group: G.nav, keys: ["Alt+ArrowDown"], whileTyping: true, run: () => this.#stepSheet(1) },
        { id: "nm.prev", title: "Hoja anterior", group: G.nav, keys: ["Alt+ArrowUp"], whileTyping: true, run: () => this.#stepSheet(-1) },
        { id: "nm.list", title: "Mostrar u ocultar la lista", group: G.nav, keys: ["Ctrl+B"], run: () => this.#toggleList() },
        { id: "nm.view.game", title: "Vista: juego", group: G.view, keys: ["G"], run: () => this.#setView("game") },
        { id: "nm.view.normal", title: "Vista: normal map", group: G.view, keys: ["N"], run: () => this.#setView("normal") },
        { id: "nm.view.faces", title: "Vista: caras", group: G.view, keys: ["F"], run: () => this.#setView("faces") },
        { id: "nm.view.art", title: "Vista: arte", group: G.view, run: () => this.#setView("art") },
        { id: "nm.view.file", title: "Vista: archivo guardado", group: G.view, run: () => this.#setView("file") },
        { id: "nm.compare", title: "Comparar con el arte", group: G.view, keys: ["D"], enabled: hasSheet, run: () => this.#toggleCompare() },
        { id: "nm.grid", title: "Ver las celdas", group: G.view, keys: ["Shift+G"], run: () => this.#toggleGrid() },
        { id: "nm.fit", title: "Ajustar a la vista", group: G.view, keys: ["0", "Home"], enabled: hasSheet, run: () => this.#fit() },
        { id: "nm.zoomIn", title: "Acercar", group: G.view, keys: ["+", "="], enabled: hasSheet, run: () => this.viewport.step(1) },
        { id: "nm.zoomOut", title: "Alejar", group: G.view, keys: ["-"], enabled: hasSheet, run: () => this.viewport.step(-1) },
        { id: "nm.zoom100", title: "Zoom 100%", group: G.view, enabled: hasSheet, run: () => this.viewport.setZoom(1) },
        ...TOOLS.map(([id, label, key]) => ({ id: "nm.tool." + id, title: "Herramienta: " + label, group: G.tools, keys: [key], run: () => this.#setTool(id) })),
        { id: "nm.brushDown", title: "Pincel más pequeño", group: G.tools, keys: ["["], run: () => this.#setBrush(this.brush - 1) },
        { id: "nm.brushUp", title: "Pincel más grande", group: G.tools, keys: ["]"], run: () => this.#setBrush(this.brush + 1) },
        { id: "nm.import", title: "Importar normales de Blender…", group: G.blender, keys: ["I"], enabled: hasSheet, run: () => this.#pickImport() },
        { id: "nm.clearCell", title: "Quitar caras de la celda elegida", group: G.blender, keys: ["Delete", "Backspace"], enabled: () => !!this.cell, run: () => this.#clearCell() },
        ...[["ArrowLeft", -1, 0, "izquierda"], ["ArrowRight", 1, 0, "derecha"], ["ArrowUp", 0, -1, "arriba"], ["ArrowDown", 0, 1, "abajo"]].flatMap(([key, dx, dy, name]) => [
          { id: "nm.nudge." + key, title: "Mover el render a la " + name, group: G.blender, keys: [key], hidden: true, enabled: () => !!this.imp, run: () => this.#nudge(dx, dy) },
          { id: "nm.nudge8." + key, title: "Mover el render 8 px a la " + name, group: G.blender, keys: ["Shift+" + key], hidden: true, enabled: () => !!this.imp, run: () => this.#nudge(dx * 8, dy * 8) },
        ]),
      ];
      this.studio.commands.registerAll(list, this.id);
    }
  }

  Aura.normalsTool = { normalsTool };
})(window.Aura ??= {});
