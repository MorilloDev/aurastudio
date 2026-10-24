"use strict";

// Estructuras: one editor for everything Data/Worldgen builds with — the structure files (Structures/*.json: trees grown
// by TreeGenerator, houses stamped by TemplateGenerator) and the template files they stamp (Templates/*.json). Both are
// seen in two views of the same cells: the game's isometric 2D (its sprites, projection and sort) and a 3D one (each tile
// its sprite's average colour). A template is built block by block in either view — left click places, right click
// removes, Alt + click picks up a tile, Shift + drag fills or clears a rectangle on the working level. A structure is
// previewed as the game grows it (exact generators: the same seed grows the same tree), tuned from the inspector, and
// can be baked into a template to finish by hand. Which biomes grow a structure, and how densely, is the biome's to say.
(function (Aura) {
  const { h, clear, rafThrottle } = Aura.dom;
  const { History } = Aura.history;
  const { prefs } = Aura.storage;
  const { readText, writeHandle, joinPath, dirName, baseName } = Aura.fs;
  const { section, slider, select, checkbox, segmented, help } = Aura.controls;
  const T = Aura.atlasTiles;
  const Tint = Aura.tint;
  const G = Aura.structGen;
  const SH = Aura.structShapes;
  const { TileRegistry, SHAPE, AIR, DEFAULT_FOLIAGE } = Aura.structTiles;
  const { TemplateDoc, key, parse, rotateOffset } = Aura.structModel;
  const { KIND } = Aura.voxelView;

  const short = G.short;
  const isStructureFile = (e) => /(^|\/)data\/worldgen\/structures\/.+\.json$/.test(e.lower);
  const isTemplateFile = (e) => /(^|\/)data\/worldgen\/templates\/.+\.json$/.test(e.lower);

  const FACINGS = [["0", "N", "Norte"], ["1", "E", "Este"], ["2", "S", "Sur"], ["3", "O", "Oeste"]];
  const VIEW_MODES = [["all", "Todo", "Todos los niveles enteros (1)"], ["ghost", "Fantasma", "Lo de encima del nivel, transparente (2)"],
    ["cut", "Cortar", "Lo de encima del nivel, oculto (3)"]];

  // ── Paths into a structure's JSON ("config.crown.radius") ──────────────────────────────────────────────────────────

  const getPath = (o, path) => path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), o);

  function setPath(o, path, value) {
    const keys = path.split(".");
    let v = o;
    for (const k of keys.slice(0, -1)) v = v[k] ??= {};
    if (value === undefined) delete v[keys.at(-1)];
    else v[keys.at(-1)] = value;
  }

  const round = (n, step) => Math.round(n / step) * step;
  const pairOf = (v, a, b) => (Array.isArray(v) ? [Number(v[0]), Number(v[1])] : typeof v === "number" ? [v, v] : [a, b]);

  // New files, in the shape the existing ones have.
  const NEW_TREE = (id) => ({
    id, type: "aura:tree",
    config: { trunk: "oak_log", trunkHeight: [6, 8], crown: { shape: "blob", tile: "oakleaves", radius: [2.5, 3.5], height: [2.5, 3.5], warp: 0.35 } },
    placement: { on: ["grass", "dirt"], maxSlope: 1.2, priority: 5 },
  });
  const NEW_TEMPLATE = (id, template) => ({
    id, type: "aura:template",
    config: { templates: [template ?? ""], rotate: true, adaptation: "foundation", foundation: "stone", maxHeightDifference: 3 },
    placement: { maxSlope: 0.8, priority: 10 },
  });

  function structuresTool() {
    return new StructuresTool();
  }

  class StructuresTool {
    id = "structures";
    title = "Estructuras";
    project = null;
    registry = null;
    docs = [];              // structure files: { entry, path, name, root, eol, baseline, error, isNew }
    tdocs = [];             // template files: { isTemplate, id, entry, path, name, json, eol, baseline, doc, error, isNew }
    current = null;         // one of either
    templates = new Map();  // id → parsed template (Aura.structGen.parseTemplate), what the structure previews stamp
    biomes = [];
    tints = [];
    history = new History({ limit: 400 });

    view = prefs.get("structures:view", "iso");     // "iso" | "3d"
    level = 0;
    viewMode = prefs.get("structures:viewMode", "ghost");
    selected = "";
    facing = 0;
    shape = 0;
    search = "";
    seed = 1;
    count = prefs.get("structures:count", 1);
    tint = prefs.get("structures:tint", "");

    shapeTool = prefs.get("structures:shapeTool", "brush");   // "brush" or a shape of Aura.structShapes
    shapeOpts = { ...SH.DEFAULTS, ...prefs.get("structures:shapeOpts", {}) };
    shapeStart = null;      // { cell, remove }: the first click of a two-click shape (box, walls, line)
    #shapeMemo = null;

    selection = new Set();  // "x,y,z" keys of the selected blocks of the template being edited (view state, never saved)
    clipboard = null;       // { name, size, cells: [{ p: [x, y, z] from the min corner, id, dir, shape }] }: survives changing template
    float = null;           // what is being carried: { cells: [{ d: offset from the pivot, id, dir, shape }], lifted: Set|null, hid: [], off, lastAt, label }

    preview = null;         // { key, doc, far, plate, shapes, error } for the structure shown
    scene3d = null;         // the scene last handed to the 3D view, with its origin in template coordinates
    box3d = null;
    hover3d = null;         // { hit, place } under the mouse in 3D
    rect3d = null;
    #dirty3d = true;

    mount(host, studio) {
      this.studio = studio;
      host.appendChild(this.#buildLayout());
      this.history.on("change", () => this.#changed());
      const tpl = () => !!this.#editDoc();
      const cmd = (id, title, keys, run, extra = {}) => ({ id: "structures." + id, title, group: "Estructuras", keys, run, ...extra });
      this.studio.commands.registerAll([
        cmd("save", "Guardar", ["Ctrl+S"], () => this.save(), { whileTyping: true, enabled: () => this.isDirty() }),
        cmd("undo", "Deshacer", ["Ctrl+Z"], () => this.history.undo(), { enabled: () => this.history.canUndo }),
        cmd("redo", "Rehacer", ["Ctrl+Y", "Ctrl+Shift+Z"], () => this.history.redo(), { enabled: () => this.history.canRedo }),
        cmd("view", "Cambiar vista iso 2D / 3D", ["V"], () => this.#setView(this.view === "iso" ? "3d" : "iso")),
        cmd("up", "Subir de nivel", ["W", "PageUp"], () => this.#setLevel(this.level + 1), { enabled: tpl }),
        cmd("down", "Bajar de nivel", ["S", "PageDown"], () => this.#setLevel(this.level - 1), { enabled: tpl }),
        cmd("facing", "Girar la pieza / otra semilla", ["R"], () => {
          if (this.float) this.#rotateFloat();
          else if (tpl()) this.#setFacing((this.facing + 1) & 3);
          else { this.seed++; this.#invalidate(); }
        }),
        cmd("shape", "Siguiente forma de la pieza", ["F"], () => this.#cycleShape(), { enabled: tpl }),
        cmd("camL", "Girar la cámara", ["Q"], () => this.#turnCamera(-1)),
        cmd("camR", "Girar la cámara al otro lado", ["E"], () => this.#turnCamera(1)),
        cmd("all", "Ver todo", ["1"], () => this.#setViewMode("all"), { enabled: tpl }),
        cmd("ghost", "Lo de encima, transparente", ["2"], () => this.#setViewMode("ghost"), { enabled: tpl }),
        cmd("cut", "Lo de encima, oculto", ["3"], () => this.#setViewMode("cut"), { enabled: tpl }),
        cmd("hide", "Ocultar el bloque bajo el ratón", ["H"], () => this.#hideHovered(), { enabled: tpl }),
        cmd("show", "Mostrar todo lo oculto", ["Shift+H"], () => this.#showAll(), { enabled: tpl }),
        cmd("anchor", "Anclaje en el bloque bajo el ratón", ["A"], () => this.#anchorHovered(), { enabled: tpl }),
        cmd("center", "Centrar la vista", ["Home"], () => this.#center()),
        cmd("delete", "Borrar la selección (sin selección: la estructura o plantilla elegida del proyecto)", ["Delete"],
          () => { if (tpl() && this.selection.size && !this.float) this.#deleteSelection(); else this.#delete(this.current); }, { enabled: () => !!this.current }),
        cmd("deleteSel", "Borrar la selección", ["Backspace"], () => this.#deleteSelection(), { enabled: () => tpl() && this.selection.size > 0 && !this.float }),
        cmd("selectAll", "Seleccionar todo", ["Ctrl+A"], () => this.#selectAll(), { enabled: () => tpl() && !this.float }),
        cmd("copy", "Copiar la selección (sin selección: la plantilla entera)", ["Ctrl+C"], () => this.#copy(), { enabled: () => this.#canCopy() && !this.float }),
        cmd("cutSel", "Cortar la selección", ["Ctrl+X"], () => this.#cut(), { enabled: () => tpl() && this.selection.size > 0 && !this.float }),
        cmd("paste", "Pegar (entera, seleccionada, siguiendo el ratón)", ["Ctrl+V"], () => this.#paste(), { enabled: () => tpl() && !!this.clipboard && !this.float }),
        cmd("duplicate", "Duplicar la selección", ["Ctrl+D"], () => this.#duplicate(), { enabled: () => tpl() && this.selection.size > 0 && !this.float }),
        cmd("grab", "Mover la selección con el ratón", ["G"], () => this.#grab(), { enabled: () => tpl() && this.selection.size > 0 && !this.float }),
        cmd("drop", "Soltar lo que llevas donde esté el ratón", ["Enter"], () => this.#dropFloat(), { enabled: () => !!this.float }),
        cmd("tool", "Siguiente herramienta de forma", ["T"], () => this.#cycleShapeTool(1), { enabled: tpl }),
        cmd("toolPrev", "Herramienta de forma anterior", ["Shift+T"], () => this.#cycleShapeTool(-1), { enabled: tpl }),
        cmd("bigger", "Forma más grande", ["+", "]"], () => this.#bumpShape(1), { enabled: tpl }),
        cmd("smaller", "Forma más pequeña", ["-", "["], () => this.#bumpShape(-1), { enabled: tpl }),
        cmd("cancelShape", "Cancelar: lo que llevas, la forma a medias o la selección", ["Escape"], () => {
          if (this.float) this.#cancelFloat();
          else if (this.shapeStart) this.#cancelShape();
          else this.#clearSelection();
        }, { enabled: () => !!this.float || !!this.shapeStart || this.selection.size > 0 }),
      ], this.id);
      this.#renderAll();
    }

    activate() { this.#invalidate(); }
    deactivate() {}
    isDirty() { return this.docs.some((d) => this.#isDirtyDoc(d)) || this.tdocs.some((t) => this.#isDirtyTemplate(t)); }
    dirtyLabel() { return "Estructuras"; }

    async onProject(project) {
      this.project = project;
      if (this.isDirty()) {
        this.studio.toast("Carpeta releída. Hay estructuras o plantillas sin guardar: las mantengo.", { kind: "warn" });
        return;
      }
      await this.studio.busy(this.#load());
    }

    async #load() {
      const [tileDocs, biomes, tints] = await Promise.all([T.loadDocs(this.project), Aura.biomeModel.loadBiomes(this.project), Tint.listBiomes(this.project)]);
      this.registry = new TileRegistry(this.project, tileDocs);
      this.biomes = biomes.filter((b) => b.root);
      this.tints = tints;
      const turnsOf = (id, shape) => this.registry.turns(id, shape);

      this.docs = [];
      for (const entry of this.project.filter(isStructureFile).sort((a, b) => a.path.localeCompare(b.path))) {
        const doc = { entry, path: entry.path, name: baseName(entry.path), root: null, eol: "\n", baseline: "", error: null, isNew: false };
        try {
          const text = await readText(entry.handle);
          doc.eol = text.includes("\r\n") ? "\r\n" : "\n";
          doc.root = JSON.parse(text);
          doc.baseline = this.#serialize(doc);
        } catch (err) {
          doc.error = err.message;
        }
        this.docs.push(doc);
      }

      this.tdocs = [];
      this.templates = new Map();
      for (const entry of this.project.filter(isTemplateFile).sort((a, b) => a.path.localeCompare(b.path))) {
        const id = short(baseName(entry.path).replace(/\.json$/i, ""));
        const t = { isTemplate: true, id, entry, path: entry.path, name: baseName(entry.path), json: null, eol: "\n", baseline: "", doc: null, error: null, isNew: false };
        try {
          const text = await readText(entry.handle);
          t.eol = text.includes("\r\n") ? "\r\n" : "\n";
          t.json = JSON.parse(text);
          const parsed = G.parseTemplate(t.json, turnsOf);
          if (!parsed) throw new Error("no es una plantilla (faltan size, anchor, palette o blocks)");
          this.templates.set(id, parsed);
        } catch (err) {
          t.error = err.message;
        }
        this.tdocs.push(t);
      }

      this.history.clear();
      this.preview = null;
      this.box3d = null;
      this.current = null;
      this.#select(this.docs.find((d) => d.root) ?? this.tdocs.find((t) => t.json) ?? null);
      // Every sheet, so the palette's thumbnails and the iso view have their art; the views redraw as it arrives.
      this.registry.ensure().then(() => { this.#renderPalette(); this.#invalidate(); });
    }

    #serialize(doc) { return T.formatJson(doc.root).replace(/\n/g, doc.eol) + doc.eol; }

    /** The template's file text as it would be saved, or null for an empty one (nothing to save). */
    #templateText(t) {
      if (!t.doc) return t.baseline;
      try { return t.doc.toText().replace(/\n/g, t.eol); } catch { return null; }
    }

    #isDirtyDoc(d) { return !!d.root && (d.isNew || this.#serialize(d) !== d.baseline); }
    #isDirtyTemplate(t) {
      if (!t.doc) return false;
      const text = this.#templateText(t);
      return t.isNew ? text !== null : text !== t.baseline;
    }

    /** The template being edited, or null when a structure (or nothing) is shown. */
    #editDoc() { return this.current?.isTemplate ? this.current.doc : null; }
    /** What the views draw: the template being edited, or the structure's preview. */
    #viewDoc() { return this.#editDoc() ?? this.preview?.doc ?? null; }

    #foliage() {
      const used = this.current?.isTemplate ? [] : this.#usedIn(this.current);
      const hex = this.tint ? this.tints?.find((t) => t.id === this.tint)?.hex : used[0]?.hex;
      return Tint.hexToRgb(hex) ?? DEFAULT_FOLIAGE;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Layout

    #buildLayout() {
      this.listEl = h("div", { class: "bm-list scroll" });
      const left = h("div", { class: "bm-left" },
        h("div", { class: "bm-head" }, h("strong", null, "Estructuras"), h("span", { class: "grow" }),
          h("button", { class: "primary", title: "Estructura nueva desde cero: un lienzo vacío donde pones los tiles uno a uno (crea la plantilla y la estructura que la usa)", onclick: () => this.#createByHand() }, "+ A mano"),
          h("button", { title: "Árbol o arbusto nuevo", onclick: () => this.#create("tree") }, "+ Árbol"),
          h("button", { title: "Estructura nueva hecha de plantillas (casas, ruinas)", onclick: () => this.#create("template") }, "+ Casa"),
          h("button", { title: "Plantilla nueva, vacía, para construir bloque a bloque", onclick: () => this.#createTemplate() }, "+ Plantilla")),
        this.listEl);

      this.toolbarEl = h("div", { class: "bm-toolbar" });
      this.isoCanvas = h("canvas", { class: "bm-canvas st-iso", tabindex: 0,
        title: "Clic: poner · clic derecho: quitar · Alt+clic: copiar tile · Shift+arrastrar: rectángulo · rueda: zoom · botón central o Espacio+arrastrar: mover" });
      this.glCanvas = h("canvas", { class: "bm-canvas bm-gl",
        title: "Clic: poner · clic derecho: quitar · Alt+clic: copiar tile · Shift+arrastrar: rectángulo · arrastrar: girar · botón derecho o central arrastrando: mover · rueda: zoom · doble clic: vista del juego" });
      this.legend = h("div", { class: "bm-legend" });
      this.viewEl = h("div", { class: "bm-view" }, this.isoCanvas, this.glCanvas, this.legend);
      const stage = h("div", { class: "bm-stage" }, this.toolbarEl, this.viewEl);
      this.panel = h("div", { class: "bm-panel scroll" });
      return h("div", { class: "bm st" }, left, stage, this.panel);
    }

    #ensureViews() {
      if (!this.iso) {
        const tool = this;
        this.iso = new Aura.structIso.IsoView(this.isoCanvas, {
          get doc() { return tool.#viewDoc(); },
          get registry() { return tool.registry; },
          get foliage() { return tool.#foliage(); },
          get level() { return tool.#editDoc() ? tool.level : 9999; },
          get viewMode() { return tool.#editDoc() ? tool.viewMode : "all"; },
          get editable() { return !!tool.#editDoc(); },
          get selected() { return tool.selected; },
          get facing() { return tool.facing; },
          get shape() { return tool.shape; },
          get shapeStart() { return tool.shapeStart; },
          get selection() { return tool.selection; },
          get floating() { return !!tool.float; },
          floatCells: () => this.#floatList(),
          shapeGhost: (place) => this.#shapeCells(place)?.cells ?? null,
          get farLeaves() { return tool.#editDoc() ? null : tool.preview?.far ?? null; },
          labels: null,
          onPlace: (cell, e, hit) => this.#place(cell, e, hit),
          onRemove: (cell, place) => this.#remove(cell, place),
          onPick: (cell) => this.#pick(cell),
          onRect: (a, b, remove) => this.#rect(a, b, remove),
          onHover: () => this.#renderLegend(),
        });
        new ResizeObserver(() => this.iso.render()).observe(this.isoCanvas);
      }
      if (!this.voxel) {
        this.voxel = new Aura.voxelView.VoxelView(this.glCanvas, {
          hover: (ray) => { this.hover3d = ray && this.#editDoc() ? this.#pick3d(ray) : null; this.#overlay3d(); this.#renderLegend(); },
          click: (ray, button, e) => this.#click3d(ray, button, e),
          rectStart: (ray, remove) => {
            const c = this.#editDoc() && this.#planeCell(ray);
            this.rect3d = c ? { start: [c[0], c[2]], end: [c[0], c[2]], remove } : null;
            this.#overlay3d();
          },
          rectMove: (ray) => {
            const c = this.rect3d && this.#planeCell(ray);
            if (c) { this.rect3d.end = [c[0], c[2]]; this.#overlay3d(); }
          },
          rectEnd: () => {
            const r = this.rect3d;
            this.rect3d = null;
            if (r) this.#rect(r.start, r.end, r.remove);
            this.#overlay3d();
          },
        });
        new ResizeObserver(() => this.voxel.render()).observe(this.glCanvas);
      }
    }

    #renderAll() {
      this.#renderList();
      this.#renderToolbar();
      this.#renderPanel();
      this.#invalidate();
    }

    // A slider being dragged edits live (the tree follows the mouse); rebuilding the panel then would destroy the slider
    // under the pointer, so that one change leaves the panel as it is.
    #live = false;

    #changed() {
      const t = this.current?.isTemplate ? this.current : null;
      // An undo / redo while something is carried puts the carried blocks back; the selection forgets blocks that are gone.
      if (this.float) { this.#unlift(); this.float = null; }
      if (this.selection.size && t?.doc) for (const k of this.selection) if (!t.doc.blocks.has(k)) this.selection.delete(k);
      // The structures that stamp this template see it as it is now, saved or not.
      if (t?.doc) {
        try {
          this.templates.set(t.id, G.parseTemplate(JSON.parse(t.doc.toText()), (id, s) => this.registry.turns(id, s)));
          this.templatesRev = (this.templatesRev ?? 0) + 1;
        } catch { /* an empty template: the structures keep the last one that had blocks */ }
      }
      this.#renderList();
      this.#renderToolbar();
      if (t) { this.#renderTemplateInfo(); this.#renderSelection(); }
      else if (!this.#live) this.#renderPanel();
      this.#invalidate();
      this.studio.refreshDirty();
    }

    #renderToolbar() {
      const bar = this.toolbarEl;
      clear(bar);
      const tpl = this.#editDoc();
      bar.append(segmented({ label: "Vista", value: this.view, onChange: (v) => this.#setView(v),
        options: [["iso", "Iso 2D", "Los sprites del juego, como se ve en el juego (V)"], ["3d", "3D", "Bloques con el color de cada tile (V)"]] }).el);
      if (tpl) {
        bar.append(segmented({ label: "Encima del nivel", value: this.viewMode, onChange: (v) => this.#setViewMode(v), options: VIEW_MODES }).el,
          h("span", { class: "st-level", title: "El nivel de trabajo: donde se pone con el ratón sin bloque debajo (W / S)" },
            h("button", { class: "icon", onclick: () => this.#setLevel(this.level - 1) }, "▼"),
            h("span", { class: "mono" }, "Nivel " + this.level),
            h("button", { class: "icon", onclick: () => this.#setLevel(this.level + 1) }, "▲")));
      } else if (this.current?.root) {
        bar.append(segmented({ label: "Cuántas", value: String(this.count), onChange: (v) => { this.count = Number(v); prefs.set("structures:count", this.count); this.#invalidate(true); },
          options: [["1", "1", "Una"], ["4", "2×2", "Cuatro, cada una con su semilla"], ["9", "3×3", "Nueve: cómo varían sus tamaños"]] }).el,
          h("button", { title: "Otra semilla (R)", onclick: () => { this.seed++; this.#invalidate(); } }, "⟳ Otra"));
      }
      if (this.tints?.length) {
        const own = !tpl && this.#usedIn(this.current)[0]?.hex;
        const options = [["", own ? "Follaje: su bioma" : "Follaje: por defecto"], ...this.tints.filter((t) => t.id).map((t) => [t.id, "Follaje: " + t.name])];
        bar.append(select({ value: this.tint, options, title: "El color de los tiles biome_tinted (hojas, hierba)",
          onChange: (v) => { this.tint = v; prefs.set("structures:tint", v); this.#renderPalette(); this.#invalidate(); } }).input);
      }
      bar.append(
        h("button", { class: "icon", title: "Girar la cámara (Q)", onclick: () => this.#turnCamera(-1) }, "↺"),
        h("button", { class: "icon", title: "Girar la cámara (E)", onclick: () => this.#turnCamera(1) }, "↻"),
        h("button", { title: "Centrar (Inicio)", onclick: () => this.#center() }, "Centrar"));
      if (this.view === "3d") {
        bar.append(h("button", { title: "Vista del juego (doble clic en la vista)", onclick: () => this.voxel?.iso() }, "Iso"),
          h("button", { title: "Perspectiva u ortográfica (la del juego)", onclick: (e) => { e.target.textContent = this.voxel?.togglePerspective() ? "Perspectiva" : "Ortográfica"; } },
            this.voxel?.cam.ortho === false ? "Ortográfica" : "Perspectiva"));
      }
      bar.append(h("span", { class: "grow" }),
        h("button", { class: "icon", title: "Deshacer (Ctrl+Z)", disabled: !this.history.canUndo, onclick: () => this.history.undo() }, "↶"),
        h("button", { class: "icon", title: "Rehacer (Ctrl+Y)", disabled: !this.history.canRedo, onclick: () => this.history.redo() }, "↷"),
        h("button", { class: "primary", title: "Guardar estructuras y plantillas cambiadas donde las carga el juego (Ctrl+S)", disabled: !this.isDirty(), onclick: () => this.save() }, "Guardar"));
    }

    #renderList() {
      clear(this.listEl);
      if (!this.project) { this.listEl.append(h("div", { class: "empty-state" }, "Abre la carpeta del proyecto para ver sus estructuras.")); return; }
      const groups = [["tree", "Árboles y arbustos"], ["template", "Hechas de plantillas"], ["other", "Otros tipos"]];
      const typeOf = (d) => { const t = short(d.root?.type); return t === "tree" || t === "template" ? t : "other"; };
      for (const [k, title] of groups) {
        const docs = this.docs.filter((d) => typeOf(d) === k);
        if (!docs.length) continue;
        this.listEl.append(h("div", { class: "pl-cat" }, title));
        for (const d of docs) {
          const used = this.#usedIn(d).length;
          this.listEl.append(h("div", { class: ["bm-item", d === this.current && "active"], onclick: () => this.#select(d) },
            h("span", { class: "grow" }, d.root?.id ?? d.name),
            used ? h("span", { class: "faint small", title: "Biomas que la usan" }, used) : h("span", { class: "badge warn", title: "Ningún bioma la usa: no sale en el mundo" }, "0"),
            this.#isDirtyDoc(d) ? h("span", { class: "dot", title: "Sin guardar" }) : null,
            d.error ? h("span", { class: "badge bad", title: d.error }, "!") : null,
            this.#delButton(d)));
        }
      }
      if (this.tdocs.length) {
        this.listEl.append(h("div", { class: "pl-cat", title: "Los archivos de Worldgen/Templates: se construyen bloque a bloque" }, "Plantillas"));
        for (const t of this.tdocs)
          this.listEl.append(h("div", { class: ["bm-item", t === this.current && "active"], onclick: () => this.#select(t) },
            h("span", { class: "grow" }, "▦ " + t.id),
            this.#templateUsers(t.id).length ? null : h("span", { class: "faint small", title: "Ninguna estructura la usa" }, "—"),
            this.#isDirtyTemplate(t) ? h("span", { class: "dot", title: "Sin guardar" }) : null,
            t.error ? h("span", { class: "badge bad", title: t.error }, "!") : null,
            this.#delButton(t)));
      }
    }

    #select(doc) {
      if (this.float) this.#cancelFloat();
      this.selection = new Set();
      if (doc?.isTemplate && !doc.doc && doc.json && this.registry) {
        doc.doc = TemplateDoc.fromJson(doc.json, this.registry, this.history, () => {});
        // The baseline is the file as the Studio writes it, so opening a hand-formatted file does not count as a change.
        doc.baseline = this.#templateText(doc) ?? doc.baseline;
      }
      this.current = doc;
      this.hover3d = null;
      this.shapeStart = null;
      if (doc?.isTemplate && doc.doc) {
        // The level the template stands on: its anchor's (the ground line), so the first view shows the floor plan.
        this.level = doc.doc.size ? doc.doc.effectiveAnchor()[1] : 0;
        this.registry.ensure([...new Set(doc.doc.blocks.values())]).then(() => this.#invalidate());
      }
      this.#renderAll();
      this.#center();
    }

    /** The biomes whose "structures" list this one: [{ biome name, cellSize, chance, hex }]. */
    #usedIn(doc) {
      const id = short(doc?.root?.id);
      if (!id) return [];
      const out = [];
      for (const b of this.biomes)
        for (const e of Array.isArray(b.root.structures) ? b.root.structures : [])
          if (short(e?.structure) === id)
            out.push({ name: b.root.name ?? b.root.id, id: b.root.id, cellSize: e.cellSize, chance: e.chance, hex: b.root.colors?.foliage });
      return out;
    }

    #templateUsers(id) {
      return this.docs.filter((d) => (Array.isArray(d.root?.config?.templates) ? d.root.config.templates : [])
        .some((v) => short(typeof v === "string" ? v : v?.template) === id));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Structure editing: each change swaps the whole structure object, so undo is exact and cheap (structure files are small).

    #edit(label, fn, mergeKey = null) {
      const doc = this.current;
      if (!doc?.root) return;
      const before = JSON.stringify(doc.root);
      const next = JSON.parse(before);
      fn(next);
      const after = JSON.stringify(next);
      if (after === before) return;
      this.history.run({ label, redo: () => { doc.root = JSON.parse(after); }, undo: () => { doc.root = JSON.parse(before); } }, { mergeKey });
    }

    #set(label, path, value, mergeKey = null) { this.#edit(label, (x) => setPath(x, path, value), mergeKey); }

    async #create(kind) {
      if (!this.project) { this.studio.toast("Abre la carpeta del proyecto.", { kind: "warn" }); return; }
      const name = await this.studio.prompt({ title: kind === "tree" ? "Árbol nuevo" : "Estructura de plantillas nueva",
        message: "Id (el nombre del archivo).", placeholder: kind === "tree" ? "willow_tree" : "ruins_small",
        validate: (v) => (!v ? "Escribe un id." : this.docs.some((d) => short(d.root?.id) === T.deriveIdPath(v)) ? "Ya hay una estructura con ese id." : "") });
      if (!name) return;
      const id = T.deriveIdPath(name);
      const dir = this.docs[0] ? dirName(this.docs[0].path) : this.#worldgenDir("Structures");
      if (!dir) { this.studio.toast("No encuentro Data/Tiles para saber dónde va Data/Worldgen/Structures.", { kind: "bad" }); return; }
      const path = joinPath(dir, id + ".json");
      const cur = this.current?.root ? this.current : null;
      const base = cur && short(cur.root.type) === kind ? structuredClone(cur.root) : null;
      const template = this.current?.isTemplate ? this.current.id : this.tdocs[0]?.id;
      const root = base ? { ...base, id } : kind === "tree" ? NEW_TREE(id) : NEW_TEMPLATE(id, template);
      const doc = { entry: null, path, name: baseName(path), root, eol: "\n", baseline: "", error: null, isNew: true };
      this.history.run({ label: `Nueva estructura ${id}`, redo: () => { this.docs.push(doc); this.current = doc; },
        undo: () => { this.docs.splice(this.docs.indexOf(doc), 1); this.current = this.docs[0] ?? null; } });
      this.#select(doc);
      this.studio.setStatus(`Estructura «${id}» creada${base ? " a partir de «" + base.id + "»" : ""}. Para que salga en el mundo, añádela a un bioma (Biomas → Estructuras).`, "ok");
    }

    #delButton(item) {
      return h("button", { class: "icon ghost danger st-del", title: "Borrar del proyecto (Supr)",
        onclick: (e) => { e.stopPropagation(); this.#delete(item); } }, "🗑");
    }

    /**
     * Deletes a structure or template file from the project folder (or just drops it when it was never saved). It says what
     * still points at it first: a template some structure stamps, a structure some biome lists. Deleting a file cannot be
     * undone, so the undo history is cleared afterwards (its steps would point at documents that no longer exist).
     */
    async #delete(item) {
      if (!item || !this.project) return;
      const isTpl = !!item.isTemplate;
      const id = isTpl ? item.id : short(item.root?.id) || item.name;
      const kind = isTpl ? "la plantilla" : "la estructura";

      const notes = [];
      if (isTpl) {
        const users = this.#templateUsers(item.id).map((d) => d.root.id);
        if (users.length) notes.push(`La usan las estructuras: ${users.join(", ")}. Se quedarán sin ella.`);
      } else {
        const biomes = this.#usedIn(item).map((u) => u.name);
        if (biomes.length) notes.push(`La listan los biomas: ${biomes.join(", ")}. Su referencia quedará rota.`);
      }
      const onDisk = !!item.entry;
      const ok = await this.studio.confirm({
        title: `Borrar ${isTpl ? "plantilla" : "estructura"} «${id}»`,
        message: [onDisk ? `Se borra el archivo ${item.path} de la carpeta del proyecto y no se puede deshacer.` : `Aún no se guardó: se descarta sin tocar la carpeta.`,
          ...notes, "Se vacía el historial de deshacer."].join("\n\n"),
        confirm: "Borrar", danger: true });
      if (!ok) return;

      try {
        if (onDisk) {
          await item.entry.dir.removeEntry(item.entry.name);
          this.project.files.delete(item.entry.lower);
        }
      } catch (err) {
        this.studio.toast("No pude borrar el archivo.", { kind: "bad", detail: err.message });
        return;
      }

      const list = isTpl ? this.tdocs : this.docs;
      const at = list.indexOf(item);
      if (at >= 0) list.splice(at, 1);
      if (isTpl) { this.templates.delete(item.id); this.templatesRev = (this.templatesRev ?? 0) + 1; }
      this.history.clear();
      this.preview = null;
      this.box3d = null;
      if (this.current === item) {
        this.current = null;
        this.#select(list[Math.min(at, list.length - 1)] ?? this.docs.find((d) => d.root) ?? this.tdocs.find((t) => t.doc || t.json) ?? null);
      } else this.#renderAll();
      this.studio.refreshDirty();
      this.studio.toast(`Borrada ${kind} «${id}».`, { kind: "ok", detail: onDisk ? item.path : undefined });
    }

    /**
     * A structure from nothing, built by hand: one id makes both an empty template (the cells, placed tile by tile) and the
     * structure file that stamps it, so the result is a complete structure the biomes can use. One undo step removes both.
     */
    async #createByHand() {
      if (!this.project || !this.registry) { this.studio.toast("Abre la carpeta del proyecto.", { kind: "warn" }); return; }
      const taken = (id) => this.docs.some((d) => short(d.root?.id) === id) || this.tdocs.some((t) => t.id === id);
      const name = await this.studio.prompt({ title: "Estructura a mano",
        message: "Id (sirve de nombre para la estructura y para su plantilla). Empiezas con un lienzo vacío y pones los tiles uno a uno.",
        placeholder: "watchtower",
        validate: (v) => (!v ? "Escribe un id." : taken(T.deriveIdPath(v)) ? "Ya hay una estructura o plantilla con ese id." : "") });
      if (!name) return;
      const id = T.deriveIdPath(name);
      const structDir = this.docs[0] ? dirName(this.docs[0].path) : this.#worldgenDir("Structures");
      const tplDir = this.#worldgenDir("Templates");
      if (!structDir || !tplDir) { this.studio.toast("No encuentro Data/Tiles para saber dónde va Data/Worldgen.", { kind: "bad" }); return; }

      const tdoc = new TemplateDoc(this.registry, this.history, () => {});
      const tpath = joinPath(tplDir, id + ".json");
      const t = { isTemplate: true, id, entry: null, path: tpath, name: baseName(tpath), json: null, eol: "\n", baseline: "", doc: tdoc, error: null, isNew: true };
      const spath = joinPath(structDir, id + ".json");
      const s = { entry: null, path: spath, name: baseName(spath), root: NEW_TEMPLATE(id, id), eol: "\n", baseline: "", error: null, isNew: true };

      this.history.run({ label: `Nueva estructura a mano ${id}`,
        redo: () => {
          this.docs.push(s);
          this.tdocs.push(t);
          this.tdocs.sort((a, b) => a.id.localeCompare(b.id));
        },
        undo: () => {
          this.docs.splice(this.docs.indexOf(s), 1);
          this.tdocs.splice(this.tdocs.indexOf(t), 1);
          if (this.current === s || this.current === t) this.current = this.docs[0] ?? null;
        } });
      this.level = 0;
      this.#select(t);
      this.studio.setStatus(`Estructura «${id}» creada, vacía. Elige un tile en la paleta y haz clic para poner el primero. Guarda con Ctrl+S; para que salga en el mundo, añádela a un bioma (Biomas → Estructuras).`, "ok");
    }

    /** Data/Worldgen/<sub>, found next to Data/Tiles when no file of that kind exists yet. */
    #worldgenDir(sub) {
      const near = sub === "Templates" ? this.tdocs.find((t) => !t.isNew) : this.docs.find((d) => !d.isNew);
      if (near) return dirName(near.path);
      const other = sub === "Templates" ? this.docs.find((d) => !d.isNew) : this.tdocs.find((t) => !t.isNew);
      if (other) return joinPath(dirName(dirName(other.path)), sub);
      const tiles = this.project.filter((e) => /(^|\/)data\/tiles\/.+\.json$/.test(e.lower))[0];
      if (!tiles) return null;
      const at = tiles.lower.lastIndexOf("data/tiles/");
      return joinPath(tiles.path.slice(0, at + 4), "Worldgen", sub);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Templates

    async #createTemplate(fromCells = null, anchor = null, suggestion = "") {
      if (!this.project || !this.registry) { this.studio.toast("Abre la carpeta del proyecto.", { kind: "warn" }); return null; }
      const name = await this.studio.prompt({ title: fromCells ? "Pasar a plantilla" : "Plantilla nueva",
        message: "Id (el nombre del archivo en Worldgen/Templates).", placeholder: suggestion || "house_small", value: suggestion,
        validate: (v) => (!v ? "Escribe un id." : this.tdocs.some((t) => t.id === T.deriveIdPath(v)) ? "Ya hay una plantilla con ese id." : "") });
      if (!name) return null;
      const id = T.deriveIdPath(name);
      const dir = this.#worldgenDir("Templates");
      if (!dir) { this.studio.toast("No encuentro Data/Tiles para saber dónde va Data/Worldgen/Templates.", { kind: "bad" }); return null; }
      const path = joinPath(dir, id + ".json");
      const doc = fromCells ? TemplateDoc.fromCells(fromCells, this.registry) : new TemplateDoc(this.registry, null, null);
      doc.history = this.history;
      doc.onChange = () => {};
      if (anchor) doc.anchor = anchor;
      const t = { isTemplate: true, id, entry: null, path, name: baseName(path), json: null, eol: "\n", baseline: "", doc, error: null, isNew: true };
      this.tdocs.push(t);
      this.tdocs.sort((a, b) => a.id.localeCompare(b.id));
      this.#select(t);
      this.studio.setStatus(`Plantilla «${id}» creada. Se escribe en ${path} al guardar; la usa una estructura «+ Casa».`, "ok");
      return t;
    }

    #place(cell, e, hit) {
      const doc = this.#editDoc();
      if (!doc) return;
      if (this.float) { this.#dropFloat(); return; }
      if (this.shapeTool === "select") { this.#selectClick(hit, e); return; }
      if (!cell) return;
      if (this.shapeTool !== "brush") { this.#applyShape(cell, false); return; }
      if (!this.selected) { this.studio.toast("Elige un tile en la paleta (o Alt+clic sobre uno).", { kind: "warn" }); return; }
      doc.place(cell, this.selected, this.facing, this.shape);
    }

    #remove(cell, place) {
      if (!this.#editDoc()) return;
      if (this.float) { this.#cancelFloat(); return; }
      if (this.shapeTool === "select") { this.#deselect(cell); return; }
      if (this.shapeTool !== "brush") {
        // Right click: a shape started is dropped; otherwise the shape is carved out where the preview shows it.
        if (this.shapeStart) this.#cancelShape();
        else this.#applyShape(place ?? cell, true);
        return;
      }
      if (cell) this.#editDoc().remove(cell);
    }

    // ── Selection, copy / paste and moving ───────────────────────────────────────────────────────────────────────────
    // A selection is a set of cells of the template being edited. Moving and pasting both carry blocks as a "float": a
    // translucent copy that follows the mouse (R turns it, W / S raise the plane, click or Enter drops it, Esc cancels).
    // Moving lifts the selected blocks out of view while carried (the file is untouched until the drop, so Esc is exact);
    // the drop is one undo step that clears the old place and writes the new one. What was dropped stays selected.

    #selChanged() {
      this.#renderLegend();
      this.#renderSelection();
      this.#draw();
    }

    /** The cells of the piece under a block (a door or bed: all its parts), as keys. */
    #pieceKeys(doc, cell) {
      const probe = new Map();
      doc.removeInto(probe, cell);
      return [...probe.keys()];
    }

    #selectClick(hit, e) {
      const doc = this.#editDoc();
      if (!doc) return;
      const add = !!(e && (e.ctrlKey || e.metaKey));
      if (!hit) { if (!add) this.selection = new Set(); }
      else {
        const keys = this.#pieceKeys(doc, hit);
        if (!keys.length) return;
        if (add) {
          const on = this.selection.has(keys[0]);
          for (const k of keys) on ? this.selection.delete(k) : this.selection.add(k);
        } else this.selection = new Set(keys);
      }
      this.#selChanged();
    }

    #deselect(hit) {
      const doc = this.#editDoc();
      if (!doc) return;
      if (hit) for (const k of this.#pieceKeys(doc, hit)) this.selection.delete(k);
      else this.selection = new Set();
      this.#selChanged();
    }

    /** Shift + drag: the blocks inside the rectangle (every height, or only the working level). The right button takes them out. */
    #selectRect([x0, z0], [x1, z1], remove) {
      const doc = this.#editDoc();
      if (!doc) return;
      const lo = [Math.min(x0, x1), Math.min(z0, z1)], hi = [Math.max(x0, x1), Math.max(z0, z1)];
      const next = remove ? new Set(this.selection) : new Set();
      for (const k of doc.blocks.keys()) {
        const [x, y, z] = parse(k);
        if (x < lo[0] || x > hi[0] || z < lo[1] || z > hi[1]) continue;
        if (this.shapeOpts.onlyLevel && y !== this.level) continue;
        remove ? next.delete(k) : next.add(k);
      }
      this.selection = next;
      this.#selChanged();
    }

    #selectAll() {
      const doc = this.#editDoc();
      if (!doc?.size) return;
      this.selection = new Set(doc.blocks.keys());
      this.#selChanged();
    }

    #clearSelection() {
      if (!this.selection.size) return;
      this.selection = new Set();
      this.#selChanged();
    }

    #deleteSelection() {
      const doc = this.#editDoc();
      if (!doc || !this.selection.size) return;
      const changes = new Map();
      for (const k of this.selection) changes.set(k, null);
      this.selection = new Set();
      doc.commit(changes, "Borrar selección");
      this.#selChanged();
    }

    // ── Copy ───────────────────────────────────────────────────────────────────────────────────────────────────────

    #canCopy() {
      const cur = this.current;
      if (!cur) return false;
      return cur.isTemplate ? !!cur.doc?.size : !!(cur.root && G.generatorFor(cur.root, this.templates));
    }

    /** What Copy takes: the selection; with none, the whole template; for a structure, the one that is shown (this seed). */
    #copySource() {
      const cur = this.current;
      if (!cur) return null;
      if (cur.isTemplate) {
        const doc = cur.doc;
        if (!doc?.size) return null;
        const keys = this.selection.size ? [...this.selection] : [...doc.blocks.keys()];
        const cells = new Map();
        for (const k of keys) { const c = doc.cell(k); if (c) cells.set(k, c); }
        return { name: cur.id + (this.selection.size ? " (selección)" : ""), cells };
      }
      const r = cur.root;
      const gen = r && G.generatorFor(r, this.templates);
      if (!gen) return null;
      const { cells, plate } = this.#grow(r, gen, 1, 0);
      for (const k of plate) cells.delete(k);
      return { name: short(r.id), cells };
    }

    #copy() {
      const src = this.#copySource();
      if (!src?.cells.size) { this.studio.toast("No hay nada que copiar.", { kind: "warn" }); return false; }
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (const k of src.cells.keys()) {
        const p = parse(k);
        for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); }
      }
      this.clipboard = {
        name: src.name, size: [mx[0] - mn[0] + 1, mx[1] - mn[1] + 1, mx[2] - mn[2] + 1],
        cells: [...src.cells].map(([k, c]) => { const p = parse(k); return { p: [p[0] - mn[0], p[1] - mn[1], p[2] - mn[2]], id: c.id, dir: c.dir ?? 0, shape: c.shape ?? 0 }; }),
      };
      this.studio.setStatus(`Copiado «${src.name}»: ${src.cells.size} bloques. Abre otra plantilla y pega con Ctrl+V.`, "ok");
      this.#renderSelection();
      return true;
    }

    #cut() {
      if (!this.selection.size || !this.#copy()) return;
      this.#deleteSelection();
    }

    #duplicate() {
      if (!this.selection.size || !this.#copy()) return;
      this.#paste();
    }

    // ── Carrying: paste and move ───────────────────────────────────────────────────────────────────────────────────

    /** Paste: the whole clipboard, centred on the mouse with its base on the plane, already selected and carried. */
    #paste() {
      const doc = this.#editDoc();
      if (!doc) { this.studio.toast("Abre una plantilla para pegar.", { kind: "warn" }); return; }
      const clip = this.clipboard;
      if (!clip) { this.studio.toast("No hay nada copiado.", { kind: "warn" }); return; }
      const px = Math.floor(clip.size[0] / 2), pz = Math.floor(clip.size[2] / 2);
      this.float = { cells: clip.cells.map((c) => ({ d: [c.p[0] - px, c.p[1], c.p[2] - pz], id: c.id, dir: c.dir, shape: c.shape })),
        lifted: null, hid: [], off: [0, 0, 0], lastAt: this.#hovered()?.place?.slice() ?? null, label: `Pegar ${clip.name}` };
      this.selection = new Set();
      this.studio.setStatus(`Pegado «${clip.name}» (${clip.cells.length} bloques): llévalo con el ratón y clic para soltarlo. R lo gira, W / S suben o bajan el plano, Esc lo cancela.`, "ok");
      this.#selChanged();
    }

    /** G: lift the selection to carry it. The pivot is the cell under the mouse, so nothing jumps. */
    #grab() {
      const doc = this.#editDoc();
      if (!doc || !this.selection.size || this.float) return;
      const cells = [...this.selection].map((k) => ({ p: parse(k), c: doc.cell(k) })).filter((e) => e.c);
      if (!cells.length) return;
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (const { p } of cells) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); }
      const pivot = this.#hovered()?.place?.slice() ?? [Math.floor((mn[0] + mx[0]) / 2), mn[1], Math.floor((mn[2] + mx[2]) / 2)];
      const lifted = new Set(cells.map((e) => key(...e.p)));
      const hid = [];
      for (const k of lifted) if (!doc.hidden.has(k)) { doc.hidden.add(k); hid.push(k); }
      this.float = { cells: cells.map(({ p, c }) => ({ d: [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]], id: c.id, dir: c.dir, shape: c.shape })),
        lifted, hid, off: [0, 0, 0], lastAt: pivot.slice(), label: "Mover" };
      this.studio.setStatus("Moviendo: clic o Enter suelta, R gira, W / S suben o bajan el plano, Esc devuelve todo a su sitio.", "ok");
      this.#invalidate();
      this.#selChanged();
    }

    /** Where the carried pivot is: under the mouse (the last place it was), plus the nudges. */
    #floatAt() {
      const f = this.float;
      const place = this.#hovered()?.place;
      if (place) f.lastAt = place.slice();
      const base = f.lastAt ?? [0, this.level, 0];
      return [base[0] + f.off[0], base[1] + f.off[1], base[2] + f.off[2]];
    }

    #floatList() {
      if (!this.float) return null;
      const at = this.#floatAt();
      return this.float.cells.map((c) => ({ p: [at[0] + c.d[0], at[1] + c.d[1], at[2] + c.d[2]], id: c.id, dir: c.dir, shape: c.shape }));
    }

    #unlift() {
      const doc = this.#editDoc();
      if (doc && this.float?.hid) for (const k of this.float.hid) doc.hidden.delete(k);
    }

    #cancelFloat() {
      if (!this.float) return;
      this.#unlift();
      const moved = !!this.float.lifted;
      this.float = null;
      this.#invalidate();
      this.#selChanged();
      if (moved) this.studio.setStatus("Movimiento cancelado: todo sigue donde estaba.", "ok");
    }

    /** Drop: one undo step. A move clears the lifted blocks' old cells and writes the new ones; a paste only writes. */
    #dropFloat() {
      const f = this.float, doc = this.#editDoc();
      if (!f || !doc) return;
      const at = this.#floatAt();
      this.#unlift();
      this.float = null;
      const changes = new Map();
      if (f.lifted) for (const k of f.lifted) changes.set(k, null);
      const now = new Set();
      for (const c of f.cells) {
        const k = key(at[0] + c.d[0], at[1] + c.d[1], at[2] + c.d[2]);
        changes.set(k, { id: c.id, dir: c.dir, shape: c.shape });
        now.add(k);
      }
      doc.commit(changes, f.label);
      this.selection = now;
      this.#invalidate();
      this.#selChanged();
    }

    /** R while carrying: a quarter turn about the pivot; every piece keeps facing the way it did relative to the whole. */
    #rotateFloat() {
      const f = this.float;
      if (!f) return;
      for (const c of f.cells) {
        const [dx, dz] = rotateOffset(c.d[0], c.d[2], 1);
        c.d = [dx, c.d[1], dz];
        if (c.dir || this.registry.turns(c.id, c.shape)) c.dir = (c.dir + 1) & 3;
      }
      this.#selChanged();
    }

    /** The Desplazar buttons: carrying, they nudge what is carried; otherwise the selection moves one block, as one undo step. */
    #nudge(axis, d) {
      const doc = this.#editDoc();
      if (!doc) return;
      if (this.float) { this.float.off[axis] += d; this.#selChanged(); return; }
      if (!this.selection.size) return;
      const delta = [0, 0, 0];
      delta[axis] = d;
      const changes = new Map(), now = new Set();
      for (const k of this.selection) changes.set(k, null);
      for (const k of this.selection) {
        const c = doc.cell(k);
        if (!c) continue;
        const p = parse(k), nk = key(p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]);
        changes.set(nk, c);
        now.add(nk);
      }
      doc.commit(changes, "Desplazar");
      this.selection = now;
      this.#invalidate();
      this.#selChanged();
    }

    #renderSelection() {
      const el = this.selEl;
      if (!el) return;
      clear(el);
      const n = this.selection.size, clip = this.clipboard, busy = !!this.float;
      const btn = (label, title, fn, disabled = false) => h("button", { class: "small", title, disabled, onclick: fn }, label);
      const axes = [["X −", 0, -1, "Un bloque hacia −X"], ["X +", 0, 1, "Un bloque hacia +X"], ["Y −", 1, -1, "Un nivel abajo"],
        ["Y +", 1, 1, "Un nivel arriba"], ["Z −", 2, -1, "Un bloque hacia −Z"], ["Z +", 2, 1, "Un bloque hacia +Z"]];
      el.append(
        h("p", { class: "note" }, busy ? "Llevando bloques: clic o Enter los suelta · R gira · W / S suben o bajan el plano · Esc cancela."
          : n ? `${n} bloque${n === 1 ? "" : "s"} seleccionado${n === 1 ? "" : "s"}.`
            : "Nada seleccionado. Herramienta «Seleccionar» (T): clic, Ctrl+clic suma, Shift+arrastrar una caja. Ctrl+A: todo."),
        h("div", { class: "st-sel" },
          btn("Todo", "Seleccionar todo (Ctrl+A)", () => this.#selectAll(), busy),
          btn("Nada", "Quitar la selección (Esc)", () => this.#clearSelection(), busy || !n),
          btn("Copiar", "Copia la selección; sin selección, la plantilla entera (Ctrl+C)", () => this.#copy(), busy || !this.#canCopy()),
          btn("Cortar", "Ctrl+X", () => this.#cut(), busy || !n),
          btn("Pegar", "Ctrl+V: se pega entero, seleccionado y siguiendo el ratón", () => this.#paste(), busy || !clip),
          btn("Duplicar", "Ctrl+D", () => this.#duplicate(), busy || !n),
          btn("Mover", "G: levanta la selección y la lleva con el ratón; clic la suelta", () => this.#grab(), busy || !n),
          btn("Borrar", "Retroceso", () => this.#deleteSelection(), busy || !n)),
        h("div", { class: "st-nudge" }, h("span", { class: "faint small" }, "Desplazar"),
          ...axes.map(([t, a, d, title]) => btn(t, title, () => this.#nudge(a, d), !n && !busy))),
        clip ? h("p", { class: "note" }, `Copiado: «${clip.name}» · ${clip.cells.length} bloques · ${clip.size.join(" × ")}`) : null);
    }

    // ── Shapes: sphere, circle, ring, cylinder… placed or carved in one step (Aura.structShapes makes the cells) ─────

    #shapeType() { return SH.typeOf(this.shapeTool); }

    /** The cells the active shape would take with the mouse on `place` ({ cells, error }), or null for the brush. */
    #shapeCells(place) {
      const type = this.#shapeType();
      if (type.id === "brush" || type.id === "select" || !place || !this.#editDoc()) return null;
      const start = this.shapeStart?.cell;
      const k = JSON.stringify([type.id, this.shapeOpts, place, start ?? null]);
      if (this.#shapeMemo?.key === k) return this.#shapeMemo.res;
      const res = type.points === 2 && !start ? { cells: [place.slice()], error: null } : SH.cells(type.id, this.shapeOpts, start ?? place, place);
      this.#shapeMemo = { key: k, res };
      return res;
    }

    #applyShape(cell, remove) {
      const doc = this.#editDoc();
      if (!doc || !cell) return;
      const type = this.#shapeType();
      if (type.points === 2 && !this.shapeStart) {
        if (!remove && !this.selected) { this.studio.toast("Elige un tile en la paleta (o Alt+clic sobre uno).", { kind: "warn" }); return; }
        this.shapeStart = { cell: cell.slice(), remove };
        this.#shapeChanged();
        return;
      }
      const start = this.shapeStart;
      const carving = start ? start.remove : remove;
      if (!carving && !this.selected) { this.studio.toast("Elige un tile en la paleta (o Alt+clic sobre uno).", { kind: "warn" }); return; }
      const res = SH.cells(type.id, this.shapeOpts, start?.cell ?? cell, cell);
      this.shapeStart = null;
      if (res.error) this.studio.toast(res.error, { kind: "warn" });
      else {
        const err = doc.fill(res.cells, this.selected, this.facing, this.shape, carving, `${carving ? "Vaciar" : "Poner"} ${type.name.toLowerCase()}`);
        if (err) this.studio.toast(err, { kind: "warn" });
      }
      this.#shapeChanged();
    }

    #cancelShape() {
      if (!this.shapeStart) return;
      this.shapeStart = null;
      this.#shapeChanged();
    }

    #shapeChanged() {
      this.#shapeMemo = null;
      this.#renderLegend();
      this.#invalidate();
    }

    #setShapeTool(id) {
      this.shapeTool = id;
      this.shapeStart = null;
      prefs.set("structures:shapeTool", id);
      this.#renderShapes();
      this.#shapeChanged();
    }

    #cycleShapeTool(d) {
      const i = SH.TYPES.findIndex((t) => t.id === this.shapeTool);
      this.#setShapeTool(SH.TYPES[(i + d + SH.TYPES.length) % SH.TYPES.length].id);
    }

    /** + / − : the radius, or the height for the shapes that have no radius (box, walls). */
    #bumpShape(d) {
      const params = this.#shapeType().params;
      const k = params.includes("r") ? "r" : params.includes("h") ? "h" : null;
      if (!k) return;
      const [lo, hi] = SH.LIMITS[k];
      this.shapeOpts[k] = Math.max(lo, Math.min(hi, this.shapeOpts[k] + d));
      prefs.set("structures:shapeOpts", this.shapeOpts);
      this.#renderShapes();
      this.#shapeChanged();
    }

    #renderShapes() {
      const el = this.shapeEl;
      if (!el) return;
      clear(el);
      const type = this.#shapeType(), o = this.shapeOpts;
      const has = (p) => type.params.includes(p);
      const set = (k, v, redraw = false) => {
        o[k] = v;
        prefs.set("structures:shapeOpts", o);
        if (redraw) this.#renderShapes();
        this.#shapeChanged();
      };
      el.append(
        h("div", { class: "st-shapes" }, ...SH.TYPES.map((t) => h("button", { class: ["small", t.id === type.id && "on"], title: t.hint, onclick: () => this.#setShapeTool(t.id) }, t.name))),
        h("p", { class: "note" }, type.hint, type.id !== "brush" && type.id !== "select" ? " Clic derecho: vaciar la forma. T: cambiar de forma · + / −: tamaño." : ""));
      if (has("onlyLevel")) el.append(checkbox({ label: "Solo el nivel de trabajo", value: o.onlyLevel, title: "La caja (Shift+arrastrar) elige solo los bloques de este nivel; si no, todas las alturas", onChange: (v) => set("onlyLevel", v) }).el);
      if (has("plane")) el.append(select({ label: "Plano", value: o.plane, options: [["h", "Horizontal"], ["ns", "Vertical (de frente)"], ["ew", "Vertical (de lado)"]], onChange: (v) => set("plane", v) }).el);
      if (has("r")) el.append(slider({ label: "Radio", min: SH.LIMITS.r[0], max: SH.LIMITS.r[1], value: o.r, defaultValue: SH.DEFAULTS.r, onInput: (v) => set("r", v) }).el);
      if (has("h")) el.append(slider({ label: "Alto", min: SH.LIMITS.h[0], max: SH.LIMITS.h[1], value: o.h, defaultValue: SH.DEFAULTS.h, onInput: (v) => set("h", v) }).el);
      if (has("hollow")) el.append(checkbox({ label: "Hueca", value: o.hollow, title: "Solo la cáscara, vacía por dentro", onChange: (v) => set("hollow", v, true) }).el);
      const shell = has("t") && (o.hollow || !has("hollow"));
      if (shell) el.append(slider({ label: "Grosor", min: SH.LIMITS.t[0], max: SH.LIMITS.t[1], value: o.t, defaultValue: SH.DEFAULTS.t, onInput: (v) => set("t", v) }).el);
      if (has("caps") && o.hollow)
        el.append(checkbox({ label: "Techo", value: o.capTop, onChange: (v) => set("capTop", v) }).el,
          checkbox({ label: "Suelo", value: o.capBottom, onChange: (v) => set("capBottom", v) }).el);
      if (has("grounded")) el.append(checkbox({ label: "Apoyada en el nivel", value: o.grounded, title: "El clic marca la base; si no, el centro de la esfera", onChange: (v) => set("grounded", v) }).el);
    }

    #pick(cell) {
      const c = cell && this.#viewDoc()?.cell(key(...cell));
      if (!c) return;
      const piece = this.registry.pieceOf(c.id);
      this.selected = piece?.id ?? c.id;
      this.facing = c.dir;
      this.shape = c.shape;
      this.#renderPalette();
      this.#invalidate();
    }

    #rect(a, b, remove) {
      const doc = this.#editDoc();
      if (!doc || this.float) return;
      if (this.shapeTool === "select") { this.#selectRect(a, b, remove); return; }
      if (!remove && !this.selected) { this.studio.toast("Elige un tile en la paleta.", { kind: "warn" }); return; }
      const err = doc.rect(a, b, this.level, this.selected, this.facing, this.shape, remove);
      if (err) this.studio.toast(err, { kind: "warn" });
    }

    #setLevel(n) {
      this.level = Math.max(-64, Math.min(256, n));
      this.#renderToolbar();
      this.#renderTemplateInfo();
      this.#invalidate();
    }

    #setViewMode(m) {
      this.viewMode = m;
      prefs.set("structures:viewMode", m);
      this.#renderToolbar();
      this.#invalidate();
    }

    #setView(v) {
      this.view = v;
      prefs.set("structures:view", v);
      this.#renderToolbar();
      this.#invalidate();
      this.#center();
    }

    #setFacing(f) {
      this.facing = f;
      this.#renderPiece();
      this.#invalidate();
    }

    #cycleShape() {
      if (!this.selected) return;
      const options = this.registry.shapeOptions(this.selected).map(([v]) => v);
      this.shape = options[(options.indexOf(this.shape) + 1) % options.length] ?? 0;
      this.#renderPiece();
      this.#invalidate();
    }

    #hovered() {
      return this.view === "3d" ? this.hover3d : this.iso?.hover;
    }

    #hideHovered() {
      const doc = this.#editDoc(), hit = this.#hovered()?.hit;
      if (!doc || !hit) return;
      doc.hidden.add(key(...hit));
      this.#renderTemplateInfo();
      this.#invalidate();
    }

    #showAll() {
      const doc = this.#editDoc();
      if (!doc?.hidden.size) return;
      doc.hidden.clear();
      this.#renderTemplateInfo();
      this.#invalidate();
    }

    #anchorHovered() {
      const doc = this.#editDoc(), hv = this.#hovered();
      const cell = hv?.hit ?? hv?.place;
      if (!doc || !cell) return;
      const same = doc.anchor && doc.anchor.every((v, i) => v === cell[i]);
      doc.setAnchor(same ? null : cell);
    }

    #turnCamera(step) {
      if (this.view === "3d") this.voxel?.turn(step);
      else { this.iso?.turn(step); }
    }

    #center() {
      this.#ensureViews();
      if (this.view === "3d") { if (this.voxel) this.voxel.framed = false; this.#invalidate(true); }
      else requestAnimationFrame(() => { this.iso.center(); this.iso.render(); });
    }


    // -----------------------------------------------------------------------------------------------------------------
    // Inspector

    #renderPanel() {
      if (this.panel.contains(document.activeElement)) document.activeElement.blur();
      const top = this.panel.scrollTop;
      clear(this.panel);
      this.templateInfoEl = this.pieceEl = this.paletteGrid = this.selEl = this.shapeEl = null;
      const doc = this.current;
      if (!doc) {
        this.panel.append(h("div", { class: "empty-state" }, h("h3", null, "Estructuras"),
          "Elige una estructura o una plantilla, o crea una. Las plantillas se construyen bloque a bloque en la vista iso o en la 3D; los árboles se ajustan viéndolos crecer."));
        return;
      }
      if (doc.isTemplate) { this.#templatePanel(doc); this.panel.scrollTop = top; return; }
      if (!doc.root) { this.panel.append(h("div", { class: "empty-state" }, `${doc.name} no se puede leer: ${doc.error}`)); return; }

      this.tileList ??= h("datalist", { id: "st-tiles" });
      this.tileList.replaceChildren(...[...(this.registry?.tiles.keys() ?? [])].filter((id) => id !== AIR).sort().map((id) => h("option", { value: id })));
      this.panel.append(this.tileList);

      const r = doc.root, type = short(r.type);
      const idInput = h("input", { type: "text", value: r.id ?? "", spellcheck: false, onchange: () => this.#set("Id", "id", idInput.value.trim() || undefined) });
      this.panel.append(section({ id: "st-id", title: "Estructura", extra: doc.isNew ? "nueva" : doc.name },
        h("div", { class: "field" }, h("label", null, "Id", help("Lo que nombran los biomas en su lista «structures»")), idInput),
        h("div", { class: "field" }, h("label", null, "Tipo"), h("span", { class: "mono" }, r.type ?? "—")),
        doc.isNew ? h("p", { class: "note" }, "Se escribe en ", h("b", null, doc.path), " al guardar.") : null,
        G.generatorFor(r, this.templates) ? h("button", { title: "Copia la primera de la vista (con esta semilla) a una plantilla nueva, para terminarla a mano",
          onclick: () => this.#bake() }, "Pasar a plantilla…") : null,
        G.generatorFor(r, this.templates) ? h("button", { title: "Copia la que se ve (con esta semilla) para pegarla dentro de una plantilla: abre la plantilla y Ctrl+V",
          onclick: () => this.#copy() }, "Copiar para pegar") : null).el);

      if (type === "tree") this.panel.append(...this.#treeSections(r));
      else if (type === "template") this.panel.append(this.#templateSection(r).el);
      else this.panel.append(h("p", { class: "note pad" }, `El Studio no sabe dibujar el tipo «${r.type}»: edítalo en el JSON.`));

      this.panel.append(this.#placementSection(r).el, this.#biomesSection(doc).el, this.#checkSection(doc).el, this.#rawSection(doc).el);
      this.panel.scrollTop = top;
    }

    // ── The template panel: what it is, the piece in hand, the palette ────────────────────────────────────────────────

    #templatePanel(t) {
      if (!t.doc) {
        this.panel.append(h("div", { class: "empty-state" }, `${t.name} no se puede leer: ${t.error ?? "sin datos"}`));
        return;
      }
      this.templateInfoEl = h("div");
      this.pieceEl = h("div");
      this.shapeEl = h("div");
      this.selEl = h("div");
      this.paletteGrid = h("div", { class: "st-palette" });
      const search = h("input", { type: "search", placeholder: "Buscar tile…", value: this.search, spellcheck: false,
        oninput: () => { this.search = search.value; this.#renderPalette(); } });
      this.panel.append(
        section({ id: "st-tinfo", title: "Plantilla", extra: t.isNew ? "nueva" : t.name }, this.templateInfoEl).el,
        section({ id: "st-shapes", title: "Forma", extra: "rápido" }, this.shapeEl).el,
        section({ id: "st-sel", title: "Selección", extra: "copiar · mover" }, this.selEl).el,
        section({ id: "st-piece", title: "Pieza" }, this.pieceEl).el,
        section({ id: "st-palette", title: "Paleta" }, search, this.paletteGrid).el,
        section({ id: "st-keys", title: "Atajos", collapsed: true },
          h("p", { class: "note" }, "Clic: poner · clic derecho: quitar (una pieza grande entera) · Alt+clic: copiar tile, orientación y forma · Shift+arrastrar: rellenar un rectángulo del nivel (con el derecho: vaciarlo)."),
          h("p", { class: "note" }, "Ctrl+A / C / X / V / D: todo, copiar, cortar, pegar, duplicar · G: mover lo seleccionado · Enter: soltar · T: herramienta (seleccionar, esfera, círculo, cilindro…) · + / −: tamaño · Esc: cancelar · W / S: nivel · R: girar la pieza · F: forma · Q / E: girar la cámara · 1 2 3: todo / fantasma / cortar · H: ocultar el bloque (Shift+H: mostrar todo) · A: anclaje · V: iso / 3D · Inicio: centrar.")).el);
      this.#renderTemplateInfo();
      this.#renderShapes();
      this.#renderSelection();
      this.#renderPiece();
      this.#renderPalette();
    }

    #renderTemplateInfo() {
      const el = this.templateInfoEl, t = this.current;
      if (!el || !t?.isTemplate || !t.doc) return;
      clear(el);
      const doc = t.doc, b = doc.bounds(), a = doc.effectiveAnchor();
      const users = this.#templateUsers(t.id);
      el.append(...[
        h("p", { class: "note" }, b ? `${b.maxX - b.minX + 1} × ${b.maxY - b.minY + 1} × ${b.maxZ - b.minZ + 1} · ${doc.size} bloques` : "Vacía: pon el primer bloque.",
          ` · nivel ${this.level}`),
        h("p", { class: "note" }, `Anclaje ${a.join(", ")}`, doc.anchor ? "" : " (por defecto: centro de la base)", " — el punto que se apoya en el suelo. A: ponerlo en el bloque bajo el ratón."),
        doc.hidden.size ? h("p", { class: "note" }, `${doc.hidden.size} ocultos (solo en la vista). `, h("button", { class: "small", onclick: () => this.#showAll() }, "Mostrar")) : null,
        doc.unknown.size ? h("div", { class: "at-issue bad" }, "Tiles que no existen: " + [...doc.unknown].join(", ")) : null,
        users.length
          ? h("p", { class: "note" }, "La usan: ", ...users.map((d, i) => [i ? ", " : "", h("a", { href: "#", onclick: (e) => { e.preventDefault(); this.#select(d); } }, d.root.id)]))
          : h("p", { class: "note" }, "Ninguna estructura la usa: no sale en el mundo. ", h("button", { class: "small", onclick: () => this.#create("template") }, "+ Casa con ella")),
      ].filter(Boolean));
      if (t.isNew) el.append(h("p", { class: "note" }, "Se escribe en ", h("b", null, t.path), " al guardar."));
    }

    #renderPiece() {
      const el = this.pieceEl;
      if (!el) return;
      clear(el);
      const id = this.selected, tile = id && this.registry.get(id);
      if (!tile) { el.append(h("p", { class: "note" }, "Ninguna: elige una en la paleta o Alt+clic sobre un bloque.")); return; }
      el.append(h("div", { class: "st-piece" }, this.#thumb(id, 48), h("div", null, h("b", null, tile.name ?? id), h("div", { class: "faint mono small" }, id))));
      if (this.registry.turns(id, this.shape))
        el.append(h("div", { class: "field" }, h("label", null, "Mira a", help("R gira")),
          segmented({ label: "Mira a", value: String(this.facing), onChange: (v) => this.#setFacing(Number(v)), options: FACINGS }).el));
      const shapes = this.registry.shapeOptions(id);
      if (shapes.length > 1) {
        if (!shapes.some(([v]) => v === this.shape)) this.shape = 0;
        el.append(h("div", { class: "field" }, h("label", null, "Forma", help("F pasa a la siguiente")),
          select({ value: String(this.shape), options: shapes.map(([v, n]) => [String(v), n]),
            onChange: (v) => { this.shape = Number(v); this.#renderPiece(); this.#invalidate(); } }).input));
      } else this.shape = 0;
      if (tile.parts) el.append(h("p", { class: "note" }, `Pieza de ${tile.parts.length} celdas: se pone y se quita entera.`));
    }

    #renderPalette() {
      const grid = this.paletteGrid;
      if (!grid || !this.registry) return;
      clear(grid);
      const q = this.search.trim().toLowerCase();
      const tiles = this.registry.paletteTiles().filter((t) => !q || t.id.includes(q) || String(t.name ?? "").toLowerCase().includes(q));
      const byCat = new Map();
      for (const t of tiles) {
        const c = t.id === AIR ? "aire" : t.category || "otros";
        if (!byCat.has(c)) byCat.set(c, []);
        byCat.get(c).push(t);
      }
      for (const [cat, list] of [...byCat].sort((a, b) => a[0].localeCompare(b[0]))) {
        grid.append(h("div", { class: "pl-cat" }, cat));
        const row = h("div", { class: "st-tiles" });
        for (const t of list.sort((a, b) => a.id.localeCompare(b.id)))
          row.append(h("button", { class: ["st-tile", t.id === this.selected && "on"], title: `${t.name ?? t.id}\n${t.id}`,
            onclick: () => { this.selected = t.id; this.shape = 0; this.#renderPiece(); this.#renderPalette(); this.#invalidate(); } },
            this.#thumb(t.id, 36)));
        grid.append(row);
      }
      if (!tiles.length) grid.append(h("p", { class: "note" }, this.registry.tiles.size > 1 ? "Nada con ese nombre." : "No hay archivos de tiles en Data/Tiles."));
    }

    /** A tile's sprite fitted in a square; a multi-cell piece shows its first part's art. */
    #thumb(id, size) {
      const c = h("canvas", { width: size, height: size, class: "st-thumb" });
      const g = c.getContext("2d");
      const tile = this.registry.get(id);
      const art = this.registry.sprite(id, this.#foliage()) ?? (tile?.parts?.[0] ? this.registry.sprite(tile.parts[0].id, this.#foliage()) : null);
      if (art) {
        const k = Math.min(size / art.width, size / art.height);
        g.imageSmoothingEnabled = false;
        g.drawImage(art, (size - art.width * k) / 2, (size - art.height * k) / 2, art.width * k, art.height * k);
      } else {
        g.fillStyle = id === AIR ? "rgba(160,200,255,0.25)" : this.registry.has(id) ? "#56606c" : "#c050c0";
        g.fillRect(size * 0.2, size * 0.2, size * 0.6, size * 0.6);
        if (id === AIR) { g.strokeStyle = "#9cc"; g.strokeRect(size * 0.2, size * 0.2, size * 0.6, size * 0.6); }
      }
      return c;
    }

    // Field builders bound to a path: every change is one undo step, slider drags merge into one.

    #tileField(label, path, title = "", fallback = "") {
      const value = getPath(this.current.root, path) ?? "";
      const input = h("input", { type: "text", value, list: "st-tiles", placeholder: fallback || "tile", spellcheck: false,
        onchange: () => this.#set(label, path, input.value.trim() || undefined) });
      if (value && this.registry && !this.registry.has(value)) input.classList.add("bad");
      return h("div", { class: "field" }, h("label", null, label, help(title)), input);
    }

    #pair(label, path, [a, b], { min = 0, max = 64, step = 1, title = "" } = {}) {
      const [lo, hi] = pairOf(getPath(this.current.root, path), a, b);
      const set = (x, y) => this.#set(label, path, [round(Math.min(x, y), step), round(Math.max(x, y), step)].map((n) => Math.min(max, Math.max(min, n))));
      const ia = h("input", { type: "number", min, max, step, value: lo, onchange: () => set(Number(ia.value), hi) });
      const ib = h("input", { type: "number", min, max, step, value: hi, onchange: () => set(lo, Number(ib.value)) });
      return h("div", { class: "field" }, h("label", null, label, help(title)), h("div", { class: "pair" }, ia, ib));
    }

    // A [a, b] that is not a min/max (a layered crown's bottom and top radius): kept in the order given.
    #ordered(label, path, [a, b], { min = 0, max = 64, step = 0.5, title = "" } = {}) {
      const [x, y] = pairOf(getPath(this.current.root, path), a, b);
      const ia = h("input", { type: "number", min, max, step, value: x, onchange: () => this.#set(label, path, [Number(ia.value), y]) });
      const ib = h("input", { type: "number", min, max, step, value: y, onchange: () => this.#set(label, path, [x, Number(ib.value)]) });
      return h("div", { class: "field" }, h("label", null, label, help(title)), h("div", { class: "pair" }, ia, ib));
    }

    #slide(label, path, def, min, max, step, title = "") {
      const v = getPath(this.current.root, path);
      return slider({ label, min, max, step, value: v ?? def, defaultValue: def, title,
        onInput: (n) => { this.#live = true; this.#set(label, path, n, path); this.#live = false; } }).el;
    }

    // An optional block (branches, roots, droop): a tick adds it with these defaults or removes it.
    #optional(title, path, defaults, build, hint) {
      const on = getPath(this.current.root, path) != null;
      const tick = checkbox({ label: on ? "Activado" : "Desactivado", value: on, title: hint,
        onChange: (v) => this.#set(title, path, v ? structuredClone(defaults) : undefined) });
      return section({ id: "st-" + path, title, extra: on ? "" : "no" }, tick.el, ...(on ? build() : []));
    }

    #treeSections(r) {
      const c = r.config ?? {};
      const crown = c.crown ?? {};
      const shape = crown.shape ?? "blob";
      const width = segmented({ label: "Ancho", value: String(c.trunkWidth ?? 1), onChange: (v) => this.#set("Ancho", "config.trunkWidth", v === "2" ? 2 : undefined),
        options: [["1", "1×1"], ["2", "2×2", "Tronco de cuatro columnas"]] });
      const trunk = section({ id: "st-trunk", title: "Tronco" },
        this.#tileField("Tile", "config.trunk", "Sin tronco: un arbusto (solo copa)"),
        this.#pair("Altura", "config.trunkHeight", [0, 0], { max: 40, title: "Bloques de tronco, entre estos dos" }),
        h("div", { class: "field" }, h("label", null, "Ancho"), width.el));

      const shapeSeg = segmented({ label: "Forma", value: shape, onChange: (v) => this.#edit("Forma de la copa", (x) => {
        const cr = (x.config ??= {}).crown ??= {};
        cr.shape = v;
        if (v === "layers") { cr.radius = [3, 1]; cr.start ??= 2; cr.spacing ??= 2; cr.count ??= 3; cr.thickness ??= 1.5; delete cr.height; delete cr.offset; }
        if (v === "blob") { cr.radius = [3, 4]; cr.height ??= [3, 4]; delete cr.start; delete cr.spacing; delete cr.count; delete cr.thickness; }
      }), options: [["blob", "Bola", "Una masa deformada (roble, abedul)"], ["layers", "Capas", "Discos que se estrechan hacia arriba (pino, arbustos)"], ["none", "Ninguna", "Solo las hojas de las puntas de las ramas"]] });
      const crownBody = [h("div", { class: "field" }, h("label", null, "Forma"), shapeSeg.el)];
      if (shape !== "none") crownBody.push(this.#tileField("Tile", "config.crown.tile", "Las hojas"));
      if (shape === "blob") crownBody.push(
        this.#pair("Radio", "config.crown.radius", [3, 4], { step: 0.5, max: 16, title: "Ancho de la bola, entre estos dos" }),
        this.#pair("Alto", "config.crown.height", [3, 4], { step: 0.5, max: 16, title: "Medio alto de la bola" }),
        this.#slide("Desplazamiento", "config.crown.offset", 0, -4, 4, 0.5, "Sube o baja la copa respecto a la punta del tronco"));
      if (shape === "layers") crownBody.push(
        this.#ordered("Radio abajo / arriba", "config.crown.radius", [3, 1], { title: "El disco de abajo y el de arriba; los de en medio van entre los dos" }),
        this.#slide("Empieza a", "config.crown.start", 0, 0, 30, 1, "Bloques sobre el suelo donde va el primer disco"),
        this.#slide("Separación", "config.crown.spacing", 3, 1, 8, 1, "Bloques entre un disco y el siguiente"),
        this.#slide("Discos", "config.crown.count", 1, 1, 12, 1),
        this.#slide("Grosor", "config.crown.thickness", 2, 0.5, 4, 0.5));
      if (shape !== "none") crownBody.push(
        this.#slide("Deformación", "config.crown.warp", 0.3, 0, 1, 0.05, "Cuánto se aleja de la forma perfecta (bultos)"),
        this.#slide("Tronco dentro", "config.crown.core", 0, 0, 1, 0.05, "Cuánto sigue el tronco dentro de la copa: en copas altas evita que las hojas de arriba caigan al talar"));
      const crownSec = section({ id: "st-crown", title: "Copa" }, ...crownBody);

      const droop = this.#optional("Hojas colgantes", "config.crown.droop", { chance: 0.3, length: [1, 2] }, () => [
        this.#slide("Probabilidad", "config.crown.droop.chance", 0.3, 0, 1, 0.05, "Por columna del borde de abajo de la copa"),
        this.#pair("Largo", "config.crown.droop.length", [1, 2], { max: 8 })], "Hojas que cuelgan bajo la copa (sauce)");

      const branches = this.#optional("Ramas", "config.branches", { count: [2, 3], start: [0.5, 0.8], length: [2, 3], rise: 0.3, leaves: { radius: [1.5, 2], height: [1, 1.5] } }, () => {
        const out = [
          this.#pair("Cuántas", "config.branches.count", [2, 3], { max: 12 }),
          this.#pair("Salen a", "config.branches.start", [0.5, 0.8], { step: 0.05, max: 1, title: "Fracción de la altura del tronco" }),
          this.#pair("Largo", "config.branches.length", [2, 3], { max: 12 }),
          this.#slide("Suben", "config.branches.rise", 0.3, 0, 1, 0.05, "Probabilidad de subir un bloque en cada paso"),
          this.#tileField("Tile", "config.branches.tile", "Por defecto el del tronco (necesita arte acostado)", c.trunk ?? ""),
        ];
        const leaves = getPath(r, "config.branches.leaves") != null;
        out.push(checkbox({ label: "Hojas en la punta", value: leaves,
          onChange: (v) => this.#set("Hojas de las ramas", "config.branches.leaves", v ? { radius: [1.5, 2], height: [1, 1.5] } : undefined) }).el);
        if (leaves) out.push(
          this.#pair("Radio hojas", "config.branches.leaves.radius", [1.5, 2], { step: 0.5, max: 8 }),
          this.#pair("Alto hojas", "config.branches.leaves.height", [1, 1.5], { step: 0.5, max: 8 }));
        return out;
      }, "Troncos acostados que salen del tronco, con un racimo de hojas en la punta");

      const roots = this.#optional("Raíces", "config.roots", { count: [1, 2], length: [1, 2] }, () => [
        this.#pair("Cuántas", "config.roots.count", [0, 2], { max: 8 }),
        this.#pair("Largo", "config.roots.length", [1, 2], { max: 8 }),
        this.#slide("Se hunden", "config.roots.sink", 0.4, 0, 1, 0.05, "Probabilidad de bajar un bloque en cada paso"),
        this.#slide("Hondura", "config.roots.depth", 2, 0, 6, 1, "Hasta cuántos bloques bajo el suelo"),
        checkbox({ label: "También en diagonal", value: getPath(r, "config.roots.diagonal") ?? true,
          onChange: (v) => this.#set("Diagonal", "config.roots.diagonal", v ? undefined : false) }).el,
        this.#tileField("Tile", "config.roots.tile", "Por defecto el del tronco", c.trunk ?? "")], "Troncos acostados al pie que se meten en la tierra");

      return [trunk.el, crownSec.el, droop.el, branches.el, roots.el];
    }

    #templateSection(r) {
      const list = Array.isArray(r.config?.templates) ? r.config.templates : [];
      this.templateList ??= h("datalist", { id: "st-templates" });
      this.templateList.replaceChildren(...[...this.templates.keys()].sort().map((id) => h("option", { value: id })));
      const edit = (fn) => this.#edit("Plantillas", (x) => { ((x.config ??= {}).templates ??= []); fn(x.config.templates); });
      const rows = list.map((v, i) => {
        const name = typeof v === "string" ? v : v?.template ?? "";
        const weight = typeof v === "object" ? v.weight ?? 1 : 1;
        const write = (n, w) => edit((l) => { l[i] = w === 1 ? n : { template: n, weight: w }; });
        const ni = h("input", { type: "text", value: name, list: "st-templates", spellcheck: false, onchange: () => write(ni.value.trim(), weight) });
        if (name && !this.templates.has(short(name))) ni.classList.add("bad");
        const wi = h("input", { type: "number", min: 1, step: 1, value: weight, title: "Peso: una con 3 sale el triple que una con 1", onchange: () => write(name, Math.max(1, Number(wi.value) || 1)) });
        const t = this.tdocs.find((x) => x.id === short(name));
        return h("div", { class: "st-trow" }, ni, wi,
          h("button", { class: "icon ghost", title: "Editarla bloque a bloque", disabled: !t, onclick: () => this.#select(t) }, "✎"),
          h("button", { class: "icon ghost", title: "Quitar", onclick: () => edit((l) => { l.splice(i, 1); }) }, "×"));
      });
      const adaptation = String(r.config?.adaptation ?? "none").toLowerCase();
      const adapt = segmented({ label: "Terreno", value: adaptation, onChange: (v) => this.#set("Terreno", "config.adaptation", v),
        options: [["none", "Tal cual", "Se apoya en el suelo del anclaje; el resto puede flotar o hundirse"], ["foundation", "Cimientos", "Se apoya en el punto más alto y rellena debajo"]] });
      return section({ id: "st-templates", title: "Plantillas", extra: String(list.length) }, this.templateList,
        ...rows,
        h("button", { onclick: () => edit((l) => { l.push([...this.templates.keys()][0] ?? ""); }) }, "+ Variante"),
        checkbox({ label: "Girar al azar", value: r.config?.rotate ?? true, onChange: (v) => this.#set("Girar", "config.rotate", v) }).el,
        h("div", { class: "field" }, h("label", null, "Terreno"), adapt.el),
        adaptation === "foundation" ? this.#tileField("Cimientos", "config.foundation", "El tile que rellena debajo", "stone") : null,
        this.#slide("Desnivel máx.", "config.maxHeightDifference", 2, 0, 12, 1, "Más desnivel que esto en su huella y no se pone ahí"),
        h("p", { class: "note" }, "Cada variante es un archivo de Worldgen/Templates: ✎ la abre para construirla bloque a bloque."));
    }

    #placementSection(r) {
      const on = Array.isArray(r.placement?.on) ? r.placement.on : [];
      const input = h("input", { type: "text", value: on.join(", "), placeholder: "cualquier suelo", spellcheck: false,
        onchange: () => {
          const list = input.value.split(",").map((s) => s.trim()).filter(Boolean);
          this.#set("Sobre", "placement.on", list.length ? list : undefined);
        } });
      const missing = this.registry ? on.filter((t) => !this.registry.has(t)) : [];
      if (missing.length) input.classList.add("bad");
      return section({ id: "st-place", title: "Dónde puede ir" },
        h("div", { class: "field" }, h("label", null, "Sobre", help("Tiles de suelo, separados por comas. Vacío: cualquiera.")), input),
        this.#slide("Pendiente máx.", "placement.maxSlope", 1.5, 0, 3, 0.1, "Niveles por tile; los acantilados empiezan en 1,5"),
        this.#slide("Prioridad", "placement.priority", 0, 0, 20, 1, "Si dos se pisan, gana la de más prioridad (un árbol grande sobre un arbusto)"),
        h("p", { class: "note" }, "Cuántas salen y en qué biomas lo dice cada bioma en su lista «Estructuras»."));
    }

    #biomesSection(doc) {
      const used = this.#usedIn(doc);
      return section({ id: "st-biomes", title: "Biomas que la usan", extra: String(used.length) },
        used.length
          ? used.map((u) => h("div", { class: "st-use" }, h("span", { class: "swatch", style: { background: Tint.hexToRgb(u.hex) ? u.hex : "#888" } }),
            h("b", null, u.name), h("span", { class: "faint" }, ` celda ${u.cellSize ?? 8} · prob. ${u.chance ?? 0.5}`)))
          : h("p", { class: "note" }, "Ningún bioma la usa, así que no sale en el mundo. Añádela en Biomas → Estructuras."));
    }

    #checkSection(doc) {
      const r = doc.root, issues = [];
      for (const k of ["biomes", "cellSize", "chance"])
        if (r.placement?.[k] != null) issues.push(h("div", { class: "at-issue bad" }, `placement.${k}: el juego da error. Va en el bioma (Biomas → Estructuras).`,
          h("button", { class: "small", onclick: () => this.#set("Quitar " + k, "placement." + k, undefined) }, "Quitar")));
      if (this.registry) {
        const tiles = Aura.biomeScene.structureTiles({ root: r }, this.templates);
        for (const t of new Set(tiles)) if (t !== "air" && !this.registry.has(t)) issues.push(h("div", { class: "at-issue bad" }, `«${t}» no existe en ningún archivo de tiles.`));
      }
      if (short(r.type) === "template")
        for (const v of r.config?.templates ?? []) {
          const n = short(typeof v === "string" ? v : v?.template);
          if (!this.templates.has(n)) issues.push(h("div", { class: "at-issue bad" }, `La plantilla «${n}» no existe en Worldgen/Templates.`));
        }
      if (this.docs.some((d) => d !== doc && short(d.root?.id) === short(r.id))) issues.push(h("div", { class: "at-issue bad" }, `Otra estructura usa el id «${r.id}».`));
      return section({ id: "st-check", title: "Revisión", extra: issues.length ? String(issues.length) : "todo bien" },
        issues.length ? issues : h("p", { class: "note" }, "Todos los tiles y plantillas existen."));
    }

    #rawSection(doc) {
      const raw = h("textarea", { class: "at-raw", rows: 14, spellcheck: false, value: T.formatJson(doc.root) });
      const err = h("p", { class: "note bad" });
      return section({ id: "st-raw", title: "JSON", collapsed: true }, raw, err,
        h("button", { onclick: () => {
          let next;
          try { next = JSON.parse(raw.value); } catch (e) { err.textContent = "JSON no válido: " + e.message; return; }
          if (!next || typeof next !== "object" || !next.id) { err.textContent = "Una estructura es un objeto con \"id\"."; return; }
          this.#edit("JSON", (x) => { for (const k of Object.keys(x)) delete x[k]; Object.assign(x, next); });
        } }, "Aplicar JSON"));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Structure previews: the exact generators on a plate of the ground it stands on

    #buildPreview() {
      const r = this.current?.root;
      if (!r || !this.registry) return null;
      const foliage = this.#foliage();
      const k = JSON.stringify([r, this.seed, this.count, [...this.templates.keys()], this.templatesRev ?? 0]);
      if (this.preview?.key === k) return this.preview;
      const gen = G.generatorFor(r, this.templates);
      if (!gen) return (this.preview = { key: k, doc: null, error: `El Studio no sabe dibujar «${r.type}»${short(r.type) === "template" ? " (¿existen sus plantillas?)" : ""}.` });
      void foliage;
      const n = Math.round(Math.sqrt(this.count));
      const { cells, plate, shapes } = this.#grow(r, gen, n);
      const isTree = gen instanceof G.TreeGenerator;
      const far = isTree ? G.farLeaves(cells, (id) => this.registry.isLeaf(id), (id) => this.registry.isLog(id)) : null;
      const doc = TemplateDoc.fromCells(cells, this.registry);
      this.registry.ensure([...new Set(doc.blocks.values())]).then(() => this.#invalidate());
      return (this.preview = { key: k, doc, far, plate, shapes, gen });
    }

    /** n × n of the structure, each from its own roll, on a ground plate; ground level is 0. */
    #grow(r, gen, n, only = -1) {
      const reach = Math.ceil(gen.maxReach ?? 6);
      const step = reach * 2 + 3;
      const cells = new Map(), plate = new Set();
      const surface = short(r.placement?.on?.[0] ?? "grass");
      const span = only >= 0 ? 0 : (n - 1) * step;
      for (let x = -reach - 1; x <= span + reach + 1; x++)
        for (let z = -reach - 1; z <= span + reach + 1; z++)
          for (const [y, id] of [[0, surface], [-1, "dirt"], [-2, "dirt"]]) {
            const k = key(x, y, z);
            cells.set(k, { id });
            plate.add(k);
          }
      // StructureWriter.Set: "any" writes over everything, "plants" over air and plants, "soil" also over the ground.
      const set = (x, y, z, tile, dir, shape, rule) => {
        const k = key(x, y, z), cur = cells.get(k);
        if (rule !== "any" && cur && !(this.registry.isPlant(cur.id) || (rule === "soil" && plate.has(k)))) return false;
        if (!tile || tile === AIR) cells.delete(k);
        else cells.set(k, { id: tile, dir, shape });
        plate.delete(k);
        return true;
      };
      const salt = G.stableHash("aura:" + short(r.id));
      const shapes = [];
      for (let i = 0; i < n * n; i++) {
        if (only >= 0 && i !== only) continue;
        const rng = new G.GenRandom(this.seed, i, 0, salt);
        const shape = gen.plan(rng);
        const col = only >= 0 ? 0 : (i % n) * step, row = only >= 0 ? 0 : Math.floor(i / n) * step;
        gen.write(shape, col, 0, row, set);
        shapes.push({ ...shape, col, row });
      }
      return { cells, plate, shapes };
    }

    /** The first tree or house of the view, without its plate, into a new template anchored at its foot. */
    async #bake() {
      const r = this.current?.root;
      const gen = r && G.generatorFor(r, this.templates);
      if (!gen) return;
      const { cells, plate } = this.#grow(r, gen, 1, 0);
      for (const k of plate) cells.delete(k);
      if (!cells.size) { this.studio.toast("No crece nada con esta semilla.", { kind: "warn" }); return; }
      await this.#createTemplate(cells, [0, 1, 0], short(r.id) + "_" + this.seed);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Drawing

    /** Something changed what the views show; rebuild3d also rebuilds the 3D mesh's frame. */
    #invalidate(reframe = false) {
      this.#dirty3d = true;
      if (reframe && this.voxel) this.voxel.framed = false;
      this.#draw();
    }

    #draw = rafThrottle(() => {
      if (!this.isoCanvas?.isConnected) return;
      this.#ensureViews();
      const iso = this.view === "iso";
      this.isoCanvas.style.display = iso ? "" : "none";
      this.glCanvas.style.display = iso ? "none" : "";
      if (!this.#editDoc()) this.#buildPreview();
      if (iso) this.iso.render();
      else this.#draw3d();
      this.#renderLegend();
    });

    #renderLegend() {
      clear(this.legend);
      const say = (text, cls = "faint") => this.legend.append(h("span", { class: cls }, text));
      if (!this.registry) return;
      if (this.view === "3d" && !this.voxel?.ok) { say("Este navegador no tiene WebGL2: la vista 3D no puede dibujarse.", "bad-text"); return; }
      const doc = this.#editDoc();
      if (doc) {
        const hv = this.#hovered();
        const cell = hv?.hit ?? hv?.place;
        say(`nivel ${this.level}`);
        const st = this.#shapeType();
        if (st.id !== "brush") {
          const res = hv?.place ? this.#shapeCells(hv.place) : null;
          say(st.name + (res && !res.error && res.cells.length > 1 ? ` · ${res.cells.length} celdas` : ""));
          if (st.points === 2) say(this.shapeStart ? `esquina 1: ${this.shapeStart.cell.join(", ")} · clic en la opuesta (clic derecho o Esc cancela)` : "clic en la primera esquina");
          if (res?.error) say(res.error, "bad-text");
        }
        if (this.float) say(`llevas ${this.float.cells.length} bloques · clic: soltar · R: girar · Esc: cancelar`);
        else if (this.selection.size) say(`${this.selection.size} seleccionados`);
        if (cell) say(`${cell.join(", ")}` + (hv.hit ? ` · ${doc.blocks.get(key(...hv.hit))}` : ""));
        if (this.selected) say(`en mano: ${this.selected}` + (this.registry.turns(this.selected, this.shape) ? ` · mira ${FACINGS[this.facing][2].toLowerCase()}` : "")
          + (this.shape ? ` · ${this.registry.shapeName(this.selected, this.shape)}` : ""));
        return;
      }
      const p = this.preview;
      if (!p) return;
      if (p.error) { say(p.error, "bad-text"); return; }
      const trunks = p.shapes.map((x) => x.trunk).filter((n) => n != null);
      say(`semilla ${this.seed}` + (trunks.length ? ` · tronco ${Math.min(...trunks)}–${Math.max(...trunks)}` : "")
        + ` · huella ${p.shapes.map((x) => x.footprint.toFixed(1)).join(", ")}`);
      if (p.far?.size) say(`${p.far.size} hojas lejos del tronco (rojas): caen al talar un vecino`, "bad-text");
    }

    // ── 3D ──────────────────────────────────────────────────────────────────────────────────────────────────────────

    #draw3d() {
      const v = this.voxel;
      if (!v.ok) return;
      const doc = this.#viewDoc();
      if (this.#dirty3d) {
        this.#dirty3d = false;
        if (!doc) { v.setScene(EMPTY, () => [0, 0, 0, 1], false); this.scene3d = null; v.setOverlay({}); return; }
        this.scene3d = this.#buildScene(doc, !!this.#editDoc());
        const foliage = this.#foliage();
        v.setScene(this.scene3d, (p) => this.#color3d(p, foliage), !v.framed);
      }
      this.#overlay3d();
    }

    /**
     * The doc as a voxel grid. The grid only grows while a template is edited (placing at its edge widens it), and the
     * camera is moved by the growth, so the view does not jump.
     */
    #buildScene(doc, editable) {
      const b = doc.bounds() ?? { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
      const m = editable ? 6 : 1;
      const need = { x0: b.minX - m, y0: Math.min(b.minY, editable ? this.level : b.minY) - (editable ? 1 : 0), z0: b.minZ - m,
        x1: b.maxX + m, y1: Math.max(b.maxY, editable ? this.level : b.maxY) + (editable ? 3 : 0), z1: b.maxZ + m };
      let box = this.box3d;
      const fits = box && box.doc === doc && need.x0 >= box.x0 && need.y0 >= box.y0 && need.z0 >= box.z0 && need.x1 <= box.x1 && need.y1 <= box.y1 && need.z1 <= box.z1;
      if (!fits) {
        const grow = box && box.doc === doc && editable;
        const nb = grow ? { x0: Math.min(box.x0, need.x0 - 4), y0: Math.min(box.y0, need.y0 - 2), z0: Math.min(box.z0, need.z0 - 4),
          x1: Math.max(box.x1, need.x1 + 4), y1: Math.max(box.y1, need.y1 + 2), z1: Math.max(box.z1, need.z1 + 4), doc } : { ...need, doc };
        if (grow && this.voxel) {
          const t = this.voxel.cam.target;
          t[0] += box.x0 - nb.x0; t[1] += box.y0 - nb.y0; t[2] += box.z0 - nb.z0;
        } else if (this.voxel) this.voxel.framed = false;
        this.box3d = box = nb;
      }
      const sx = box.x1 - box.x0 + 1, sy = box.y1 - box.y0 + 1, sz = box.z1 - box.z0 + 1;
      const cells = new Uint16Array(sx * sy * sz);
      const palette = [{ id: AIR, kind: 0 }], index = new Map();
      const entry = (id, kind, shape, dir) => {
        const pk = `${id}|${kind}|${shape}|${dir}`;
        let i = index.get(pk);
        if (i === undefined) { i = palette.length; palette.push({ id, kind, shape, dir }); index.set(pk, i); }
        return i;
      };
      const kinds = { solid: KIND.solid, plant: KIND.plant, water: KIND.water, glass: KIND.glass, slab: KIND.slab };
      for (const [k, id] of doc.blocks) {
        if (editable && doc.hidden.has(k)) continue;
        const [x, y, z] = parse(k);
        const above = editable && y > this.level;
        if (above && this.viewMode === "cut") continue;
        const ghost = id === AIR || (above && this.viewMode === "ghost");
        const kind = ghost ? KIND.ghost : kinds[this.registry.kind(id)] ?? KIND.solid;
        const shape = kind === KIND.slab ? doc.shapes.get(k) ?? 0 : 0, dir = kind === KIND.slab ? doc.dirs.get(k) ?? 0 : 0;
        cells[((y - box.y0) * sz + (z - box.z0)) * sx + (x - box.x0)] = entry(id, kind, shape, dir);
      }
      const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz;
      const at = (x, y, z) => (inside(x, y, z) ? cells[(y * sz + z) * sx + x] : 0);
      return {
        sizeX: sx, sizeZ: sz, height: sy, palette, at, origin: [box.x0, box.y0, box.z0],
        boxAt: (x, y, z) => slabBox(palette[at(x, y, z)]),
      };
    }

    #color3d(p, foliage) {
      if (p.kind === KIND.ghost) {
        if (p.id === AIR) return [0.75, 0.85, 1, 0.1];
        const c = this.registry.color(p.id, foliage, true) ?? [200, 200, 200];
        return [c[0] / 255, c[1] / 255, c[2] / 255, 0.16];
      }
      if (!this.registry.has(p.id)) return [0.8, 0.3, 0.8, 1];
      const c = this.registry.color(p.id, foliage, p.kind !== KIND.plant);
      const alpha = p.kind === KIND.water ? 0.6 : p.kind === KIND.glass ? 0.45 : 1;
      if (c) return [c[0] / 255, c[1] / 255, c[2] / 255, alpha];
      if (p.kind === KIND.water) return [0.2, 0.45, 0.77, 0.6];
      // The tile exists but has no art (yet): a quiet colour from its id, so the shape still reads.
      let n = 0;
      for (const ch of p.id) n = (n * 31 + ch.charCodeAt(0)) | 0;
      const hue = ((n >>> 0) % 360) / 360;
      return [0.45 + 0.2 * Math.cos(hue * 6.28), 0.45 + 0.2 * Math.cos((hue + 0.33) * 6.28), 0.45 + 0.2 * Math.cos((hue + 0.66) * 6.28), alpha];
    }

    /** Cells of the template that stop the mouse: visible ones, and above the level only when everything is shown. */
    #pickable(doc, x, y, z) {
      const k = key(x, y, z);
      return doc.blocks.has(k) && !doc.hidden.has(k) && (this.viewMode === "all" || y <= this.level);
    }

    /** The cell under the ray and the empty one in front of the face it enters by; the level's plane when nothing is hit. */
    #pick3d(ray) {
      const s = this.scene3d, doc = this.#editDoc();
      if (!s || !doc) return null;
      const [ox, oy, oz] = s.origin, size = [s.sizeX, s.height, s.sizeZ];
      const o = ray.o, d = ray.d;
      let t0 = 0, t1 = Infinity, axis0 = -1;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-9) { if (o[a] < 0 || o[a] > size[a]) return this.#planePick(ray); continue; }
        let ta = (0 - o[a]) / d[a], tb = (size[a] - o[a]) / d[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        if (ta > t0) { t0 = ta; axis0 = a; }
        t1 = Math.min(t1, tb);
      }
      if (t0 > t1) return this.#planePick(ray);
      const p = [0, 1, 2].map((a) => o[a] + d[a] * (t0 + 1e-5));
      const c = p.map((v, a) => Math.min(size[a] - 1, Math.max(0, Math.floor(v))));
      const step = d.map((v) => (v > 0 ? 1 : -1));
      const tMax = [0, 1, 2].map((a) => (Math.abs(d[a]) < 1e-9 ? Infinity : ((step[a] > 0 ? c[a] + 1 : c[a]) - p[a]) / d[a]));
      const tDelta = d.map((v) => (Math.abs(v) < 1e-9 ? Infinity : Math.abs(1 / v)));
      let normal = [0, 0, 0];
      if (axis0 >= 0) normal[axis0] = -step[axis0];
      for (let i = 0; i < 4096; i++) {
        if (c[0] < 0 || c[1] < 0 || c[2] < 0 || c[0] >= size[0] || c[1] >= size[1] || c[2] >= size[2]) break;
        const w = [c[0] + ox, c[1] + oy, c[2] + oz];
        if (this.#pickable(doc, ...w)) {
          const place = [w[0] + normal[0], w[1] + normal[1], w[2] + normal[2]];
          return { hit: w, place: normal.some((n) => n) ? place : w };
        }
        // Nothing hit on the way down to the level: the level's plane wins over cells further behind it.
        if (w[1] < this.level && d[1] < 0) return this.#planePick(ray);
        const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
        c[a] += step[a];
        tMax[a] += tDelta[a];
        normal = [0, 0, 0];
        normal[a] = -step[a];
      }
      return this.#planePick(ray);
    }

    #planePick(ray) {
      const c = this.#planeCell(ray);
      return c ? { hit: null, place: c } : null;
    }

    /** Where the ray meets the floor of the working level, as a cell of that level. */
    #planeCell(ray) {
      const s = this.scene3d;
      if (!s || Math.abs(ray.d[1]) < 1e-6) return null;
      const y = this.level - s.origin[1];
      const t = (y - ray.o[1]) / ray.d[1];
      if (t < 0) return null;
      return [Math.floor(ray.o[0] + ray.d[0] * t) + s.origin[0], this.level, Math.floor(ray.o[2] + ray.d[2] * t) + s.origin[2]];
    }

    #click3d(ray, button, e) {
      if (!this.#editDoc()) return;
      const p = this.#pick3d(ray);
      if (!p) return;
      if (button === 0 && e.altKey) this.#pick(p.hit);
      else if (button === 0) this.#place(p.place, e, p.hit);
      else if (button === 2) this.#remove(p.hit, p.place);
      this.hover3d = this.#pick3d(ray);
    }

    #overlay3d() {
      const v = this.voxel, s = this.scene3d;
      if (!v?.ok || !s) return;
      const [ox, oy, oz] = s.origin;
      const lines = [], boxes = [];
      const at = ([x, y, z]) => [x - ox, y - oy, z - oz];
      const cube = (cell, color, inset = 0) => {
        const [x, y, z] = at(cell);
        boxes.push({ min: [x + inset, y + inset, z + inset], max: [x + 1 - inset, y + 1 - inset, z + 1 - inset], color });
      };
      const outline = (cell, color, pad = 0.01) => {
        const [x, y, z] = at(cell);
        const a = [x - pad, y - pad, z - pad], b = [x + 1 + pad, y + 1 + pad, z + 1 + pad];
        const P = (i, j, k) => [i ? b[0] : a[0], j ? b[1] : a[1], k ? b[2] : a[2]];
        for (const [p, q] of [[[0, 0, 0], [1, 0, 0]], [[0, 1, 0], [1, 1, 0]], [[0, 0, 1], [1, 0, 1]], [[0, 1, 1], [1, 1, 1]],
          [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]], [[0, 0, 1], [0, 1, 1]], [[1, 0, 1], [1, 1, 1]],
          [[0, 0, 0], [0, 0, 1]], [[1, 0, 0], [1, 0, 1]], [[0, 1, 0], [0, 1, 1]], [[1, 1, 0], [1, 1, 1]]])
          lines.push({ a: P(...p), b: P(...q), color });
      };
      const doc = this.#editDoc();
      if (doc) {
        // The working level's grid.
        const y = this.level - oy, gc = [1, 1, 1, 0.13];
        for (let x = 0; x <= s.sizeX; x++) lines.push({ a: [x, y, 0], b: [x, y, s.sizeZ], color: gc });
        for (let z = 0; z <= s.sizeZ; z++) lines.push({ a: [0, y, z], b: [s.sizeX, y, z], color: gc });
        const anchor = doc.effectiveAnchor();
        outline(anchor, doc.anchor ? [1, 0.82, 0.2, 0.95] : [1, 0.82, 0.2, 0.4], 0.04);
        const hv = this.hover3d;
        if (this.selection.size) {
          let n = 0;
          for (const k of this.selection) {
            if (doc.hidden.has(k)) continue;
            cube(parse(k), [1, 0.82, 0.2, 0.3], -0.02);
            if (++n >= 6000) break;
          }
        }
        if (this.float) {
          const fol = this.#foliage();
          let n = 0;
          for (const e of this.#floatList()) {
            const c = this.registry.color(e.id, fol, true);
            cube(e.p, c ? [c[0] / 255, c[1] / 255, c[2] / 255, 0.72] : [1, 0.82, 0.2, 0.6], -0.01);
            if (++n >= 8000) break;
          }
        }
        if (this.shapeStart) outline(this.shapeStart.cell, [1, 0.82, 0.2, 0.95], 0.04);
        if (this.rect3d) {
          const { start: [x0, z0], end: [x1, z1], remove } = this.rect3d;
          for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
            for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) cube([x, this.level, z], remove ? [1, 0.3, 0.3, 0.3] : [0.4, 0.9, 0.5, 0.3], 0.02);
        } else if (hv && !this.float) {
          if (hv.hit) outline(hv.hit, [1, 1, 1, 0.9]);
          const sh = hv.place && this.#shapeCells(hv.place);
          if (sh) {
            const color = this.shapeStart?.remove ? [1, 0.3, 0.3, 0.3] : [0.4, 0.95, 0.55, 0.35];
            for (let i = 0; i < Math.min(sh.cells.length, 4000); i++) cube(sh.cells[i], color, 0.03);
          } else if (this.selected && hv.place) {
            const ghost = new Map();
            doc.placeInto(ghost, hv.place, this.selected, this.facing, this.shape);
            for (const k of ghost.keys()) cube(parse(k), [0.4, 0.95, 0.55, 0.35], 0.03);
          }
        }
      } else if (this.preview?.far) {
        for (const k of this.preview.far) cube(parse(k), [1, 0.15, 0.15, 0.55], -0.02);
      }
      v.setOverlay({ lines, boxes });
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Saving

    async save() {
      const dirty = this.docs.filter((d) => this.#isDirtyDoc(d));
      const tdirty = this.tdocs.filter((t) => this.#isDirtyTemplate(t));
      if (!dirty.length && !tdirty.length) return true;
      // Nothing is written until everything can be: a new structure must not point at a template that is still empty.
      const emptyNew = this.tdocs.filter((t) => t.isNew && t.doc && this.#templateText(t) === null).map((t) => t.id);
      const blocked = dirty.filter((d) => (Array.isArray(d.root?.config?.templates) ? d.root.config.templates : [])
        .some((v) => emptyNew.includes(short(typeof v === "string" ? v : v?.template))));
      if (blocked.length) {
        this.studio.toast("Aún no se puede guardar.", { kind: "warn",
          detail: `${blocked.map((d) => `«${d.root.id}»`).join(", ")} usa una plantilla vacía: pon al menos un bloque (o deshaz su creación) y vuelve a guardar.` });
        return false;
      }
      const write = async (item, text) => {
        if (!item.entry) {
          const dir = await dirAt(this.project.root, dirName(item.path));
          const handle = await dir.getFileHandle(baseName(item.path), { create: true });
          await writeHandle(handle, text);
          item.entry = this.project.addFile(item.path, handle, dir);
          item.isNew = false;
        } else {
          await writeHandle(item.entry.handle, text);
        }
        item.baseline = text;
      };
      try {
        await this.studio.busy((async () => {
          for (const doc of dirty) await write(doc, this.#serialize(doc));
          for (const t of tdirty) {
            const text = this.#templateText(t);
            if (text === null) throw new Error(`La plantilla «${t.id}» está vacía: pon al menos un bloque o bórrala.`);
            await write(t, text);
          }
        })());
        this.history.markSaved();
        this.#changed();
        this.studio.toast("Guardado " + [...dirty, ...tdirty].map((d) => d.name).join(", "), { kind: "ok", detail: "El juego los carga al arrancar." });
        return true;
      } catch (err) {
        this.studio.toast("No pude guardar.", { kind: "bad", detail: err.message });
        return false;
      }
    }
  }

  // A slab's box in its cell: the lower or upper half, both (double), or a vertical half against the side it faces.
  function slabBox(p) {
    const s = p?.shape ?? 0;
    if (s & SHAPE.DOUBLE) return [0, 0, 0, 1, 1, 1];
    if (s & SHAPE.VERTICAL) {
      switch (p.dir & 3) {
        case 1: return [0, 0, 0, 0.5, 1, 1];
        case 2: return [0, 0, 0, 1, 1, 0.5];
        case 3: return [0.5, 0, 0, 1, 1, 1];
        default: return [0, 0, 0.5, 1, 1, 1];
      }
    }
    return s & SHAPE.UPPER ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1];
  }

  const EMPTY = { size: 1, height: 1, palette: [{ id: AIR, kind: 0 }], at: () => 0 };

  async function dirAt(root, path) {
    let dir = root;
    for (const part of path.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create: true });
    return dir;
  }

  Aura.structuresTool = { structuresTool };
})(window.Aura ??= {});
