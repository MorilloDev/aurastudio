"use strict";

// Estructuras: the files of Data/Worldgen/Structures, each seen in 3D as the game grows it — a tree from its trunk, crown,
// branches and roots, a house from its templates — on a plate of the ground it stands on. Every number of a tree is a
// control and the view follows it, so a tree is tuned by looking at it; "3×3" shows nine at once to judge the spread of
// sizes. Houses and ruins are built block by block in the Plantillas tab (v1); here they are placed: which templates, how
// they meet the ground, where they may stand. Which biomes grow a structure, and how densely, is the biome's to say.
(function (Aura) {
  const { h, clear, rafThrottle } = Aura.dom;
  const { History } = Aura.history;
  const { prefs } = Aura.storage;
  const { readText, writeHandle, joinPath, dirName, baseName } = Aura.fs;
  const { section, slider, select, checkbox, segmented, help } = Aura.controls;
  const T = Aura.atlasTiles;
  const Tint = Aura.tint;
  const S = Aura.biomeScene;

  const isStructureFile = (e) => /(^|\/)data\/worldgen\/structures\/.+\.json$/.test(e.lower);

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
    docs = [];
    current = null;         // a structure doc, or { template: id } for a template file shown on its own
    templates = new Map();
    biomes = [];
    colors = null;
    seed = 1;
    count = prefs.get("structures:count", 1);
    tint = prefs.get("structures:tint", "");
    history = new History({ limit: 300 });

    mount(host, studio) {
      this.studio = studio;
      host.appendChild(this.#buildLayout());
      this.history.on("change", () => this.#changed());
      this.studio.commands.registerAll([
        { id: "structures.save", title: "Guardar estructuras", group: "Estructuras", keys: ["Ctrl+S"], whileTyping: true, enabled: () => this.isDirty(), run: () => this.save() },
        { id: "structures.undo", title: "Deshacer", group: "Estructuras", keys: ["Ctrl+Z"], enabled: () => this.history.canUndo, run: () => this.history.undo() },
        { id: "structures.redo", title: "Rehacer", group: "Estructuras", keys: ["Ctrl+Y", "Ctrl+Shift+Z"], enabled: () => this.history.canRedo, run: () => this.history.redo() },
        { id: "structures.reseed", title: "Otra semilla", group: "Estructuras", keys: ["R"], run: () => { this.seed++; this.#draw(); } },
      ], this.id);
      this.#renderAll();
    }

    activate() { this.#draw(); }
    deactivate() {}
    isDirty() { return this.docs.some((d) => d.root && (d.isNew || this.#serialize(d) !== d.baseline)); }
    dirtyLabel() { return "Estructuras"; }

    async onProject(project) {
      this.project = project;
      if (this.isDirty()) {
        this.studio.toast("Carpeta releída. Hay estructuras sin guardar: las mantengo.", { kind: "warn" });
        return;
      }
      await this.studio.busy(this.#load());
    }

    async #load() {
      const [structs, tileDocs, biomes, tints] = await Promise.all([
        S.loadStructures(this.project), T.loadDocs(this.project), Aura.biomeModel.loadBiomes(this.project), Tint.listBiomes(this.project)]);
      this.templates = structs.templates;
      this.biomes = biomes.filter((b) => b.root);
      this.tints = tints;
      this.colors = new Aura.tileColors.TileColors(this.project, tileDocs);
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
      this.history.clear();
      this.current = this.docs.find((d) => d.root) ?? null;
      this.sceneKey = null;
      this.#renderAll();
    }

    #serialize(doc) { return T.formatJson(doc.root).replace(/\n/g, doc.eol) + doc.eol; }

    // -----------------------------------------------------------------------------------------------------------------
    // Layout

    #buildLayout() {
      this.listEl = h("div", { class: "bm-list scroll" });
      const left = h("div", { class: "bm-left" },
        h("div", { class: "bm-head" }, h("strong", null, "Estructuras"), h("span", { class: "grow" }),
          h("button", { title: "Árbol o arbusto nuevo", onclick: () => this.#create("tree") }, "+ Árbol"),
          h("button", { title: "Estructura nueva hecha de plantillas (casas, ruinas)", onclick: () => this.#create("template") }, "+ Casa")),
        this.listEl);

      this.countSeg = segmented({ label: "Cuántas", value: String(this.count), onChange: (v) => { this.count = Number(v); prefs.set("structures:count", this.count); this.#draw(); },
        options: [["1", "1", "Una"], ["4", "2×2", "Cuatro, cada una con su semilla"], ["9", "3×3", "Nueve: cómo varían sus tamaños"]] });
      this.tintSlot = h("span");
      this.undoBtn = h("button", { class: "icon", title: "Deshacer (Ctrl+Z)", onclick: () => this.history.undo() }, "↶");
      this.redoBtn = h("button", { class: "icon", title: "Rehacer (Ctrl+Y)", onclick: () => this.history.redo() }, "↷");
      this.saveBtn = h("button", { class: "primary", title: "Guardar las estructuras cambiadas donde las carga el juego (Ctrl+S)", onclick: () => this.save() }, "Guardar");
      this.persp = h("button", { title: "Perspectiva u ortográfica (la del juego)", onclick: () => { this.persp.textContent = this.voxel?.togglePerspective() ? "Ortográfica" : "Perspectiva"; } }, "Ortográfica");
      this.glCanvas = h("canvas", { class: "bm-canvas bm-gl", title: "Arrastra: girar · clic derecho o Shift: mover · rueda: zoom · doble clic: vista del juego" });
      this.legend = h("div", { class: "bm-legend" });
      this.viewEl = h("div", { class: "bm-view" }, this.glCanvas, this.legend);
      const stage = h("div", { class: "bm-stage" },
        h("div", { class: "bm-toolbar" }, this.countSeg.el,
          h("button", { title: "Otra semilla (R)", onclick: () => { this.seed++; this.#draw(); } }, "⟳ Otra"),
          this.tintSlot,
          h("button", { title: "Vista del juego (doble clic en la vista)", onclick: () => this.voxel?.iso() }, "Iso"),
          h("button", { class: "icon", title: "Girar 90°", onclick: () => this.voxel?.turn(1) }, "↻"),
          this.persp, h("span", { class: "grow" }), this.undoBtn, this.redoBtn, this.saveBtn),
        this.viewEl);
      this.panel = h("div", { class: "bm-panel scroll" });
      return h("div", { class: "bm st" }, left, stage, this.panel);
    }

    #renderAll() {
      this.#renderList();
      this.#renderToolbar();
      this.#renderPanel();
      this.#draw();
    }

    // A slider being dragged edits live (the tree follows the mouse); rebuilding the panel then would destroy the slider
    // under the pointer, so that one change leaves the panel as it is.
    #live = false;

    #changed() {
      this.#renderList();
      this.#renderToolbar();
      if (!this.#live) this.#renderPanel();
      this.#draw();
      this.studio.refreshDirty();
    }

    #renderToolbar() {
      this.undoBtn.disabled = !this.history.canUndo;
      this.redoBtn.disabled = !this.history.canRedo;
      this.saveBtn.disabled = !this.isDirty();
      clear(this.tintSlot);
      if (!this.tints?.length) return;
      const own = this.#usedIn(this.current)[0]?.hex;
      const options = [["", own ? "Follaje: su bioma" : "Follaje: por defecto"], ...this.tints.filter((t) => t.id).map((t) => [t.id, "Follaje: " + t.name])];
      this.tintSlot.append(select({ value: this.tint, options, title: "El color de los tiles biome_tinted (hojas, hierba)",
        onChange: (v) => { this.tint = v; prefs.set("structures:tint", v); this.#draw(); } }).input);
    }

    #renderList() {
      clear(this.listEl);
      if (!this.project) { this.listEl.append(h("div", { class: "empty-state" }, "Abre la carpeta del proyecto para ver sus estructuras.")); return; }
      const groups = [["tree", "Árboles y arbustos"], ["template", "Hechas de plantillas"], ["other", "Otros tipos"]];
      const typeOf = (d) => { const t = S.short(d.root?.type); return t === "tree" || t === "template" ? t : "other"; };
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
            d.error ? h("span", { class: "badge bad", title: d.error }, "!") : null));
        }
      }
      if (this.templates.size) {
        this.listEl.append(h("div", { class: "pl-cat", title: "Los archivos de Worldgen/Templates: se construyen en la pestaña Plantillas" }, "Archivos de plantilla"));
        for (const id of [...this.templates.keys()].sort())
          this.listEl.append(h("div", { class: ["bm-item", this.current?.template === id && "active"], onclick: () => this.#select({ template: id }) },
            h("span", { class: "grow faint" }, id)));
      }
    }

    #isDirtyDoc(d) { return !!d.root && (d.isNew || this.#serialize(d) !== d.baseline); }

    #select(doc) {
      this.current = doc;
      this.#renderAll();
    }

    /** The biomes whose "structures" list this one: [{ biome name, cellSize, chance, hex }]. */
    #usedIn(doc) {
      const id = S.short(doc?.root?.id);
      if (!id) return [];
      const out = [];
      for (const b of this.biomes)
        for (const e of Array.isArray(b.root.structures) ? b.root.structures : [])
          if (S.short(e?.structure) === id)
            out.push({ name: b.root.name ?? b.root.id, id: b.root.id, cellSize: e.cellSize, chance: e.chance, hex: b.root.colors?.foliage });
      return out;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Editing: each change swaps the whole structure object, so undo is exact and cheap (structure files are small).

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
        validate: (v) => (!v ? "Escribe un id." : this.docs.some((d) => S.short(d.root?.id) === T.deriveIdPath(v)) ? "Ya hay una estructura con ese id." : "") });
      if (!name) return;
      const id = T.deriveIdPath(name);
      const dir = this.docs[0] ? dirName(this.docs[0].path) : this.#structuresDir();
      if (!dir) { this.studio.toast("No encuentro Data/Tiles para saber dónde va Data/Worldgen/Structures.", { kind: "bad" }); return; }
      const path = joinPath(dir, id + ".json");
      const base = this.current?.root && S.short(this.current.root.type) === kind ? structuredClone(this.current.root) : null;
      const root = base ? { ...base, id } : kind === "tree" ? NEW_TREE(id) : NEW_TEMPLATE(id, [...this.templates.keys()][0]);
      const doc = { entry: null, path, name: baseName(path), root, eol: "\n", baseline: "", error: null, isNew: true };
      this.history.run({ label: `Nueva estructura ${id}`, redo: () => { this.docs.push(doc); this.current = doc; },
        undo: () => { this.docs.splice(this.docs.indexOf(doc), 1); this.current = this.docs[0] ?? null; } });
      this.studio.setStatus(`Estructura «${id}» creada${base ? " a partir de «" + base.id + "»" : ""}. Para que salga en el mundo, añádela a un bioma (Biomas → Estructuras).`, "ok");
    }

    #structuresDir() {
      const tiles = this.project.filter((e) => /(^|\/)data\/tiles\/.+\.json$/.test(e.lower))[0];
      if (!tiles) return null;
      const at = tiles.lower.lastIndexOf("data/tiles/");
      return joinPath(tiles.path.slice(0, at + 4), "Worldgen", "Structures");
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Inspector

    #renderPanel() {
      if (this.panel.contains(document.activeElement)) document.activeElement.blur();
      const top = this.panel.scrollTop;
      clear(this.panel);
      const doc = this.current;
      if (doc?.template) { this.#templateFilePanel(doc.template); return; }
      if (!doc) {
        this.panel.append(h("div", { class: "empty-state" }, h("h3", null, "Estructuras"),
          "Elige una estructura o crea una. Los árboles se ajustan aquí viéndolos crecer; las casas se construyen en Plantillas y aquí se colocan."));
        return;
      }
      if (!doc.root) { this.panel.append(h("div", { class: "empty-state" }, `${doc.name} no se puede leer: ${doc.error}`)); return; }

      this.tileList ??= h("datalist", { id: "st-tiles" });
      this.tileList.replaceChildren(...(this.colors?.ids ?? []).sort().map((id) => h("option", { value: id.replace(/^aura:/, "") })));
      this.panel.append(this.tileList);

      const r = doc.root, type = S.short(r.type);
      const idInput = h("input", { type: "text", value: r.id ?? "", spellcheck: false, onchange: () => this.#set("Id", "id", idInput.value.trim() || undefined) });
      this.panel.append(section({ id: "st-id", title: "Estructura", extra: doc.isNew ? "nueva" : doc.name },
        h("div", { class: "field" }, h("label", null, "Id", help("Lo que nombran los biomas en su lista «structures»")), idInput),
        h("div", { class: "field" }, h("label", null, "Tipo"), h("span", { class: "mono" }, r.type ?? "—")),
        doc.isNew ? h("p", { class: "note" }, "Se escribe en ", h("b", null, doc.path), " al guardar.") : null).el);

      if (type === "tree") this.panel.append(...this.#treeSections(r));
      else if (type === "template") this.panel.append(this.#templateSection(r).el);
      else this.panel.append(h("p", { class: "note pad" }, `El Studio no sabe dibujar el tipo «${r.type}»: edítalo en el JSON.`));

      this.panel.append(this.#placementSection(r).el, this.#biomesSection(doc).el, this.#checkSection(doc).el, this.#rawSection(doc).el);
      this.panel.scrollTop = top;
    }

    // Field builders bound to a path: every change is one undo step, slider drags merge into one.

    #tileField(label, path, title = "", fallback = "") {
      const value = getPath(this.current.root, path) ?? "";
      const input = h("input", { type: "text", value, list: "st-tiles", placeholder: fallback || "tile", spellcheck: false,
        onchange: () => this.#set(label, path, input.value.trim() || undefined) });
      if (value && this.colors && !this.colors.info(value)) input.classList.add("bad");
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
        if (name && !this.templates.has(S.short(name))) ni.classList.add("bad");
        const wi = h("input", { type: "number", min: 1, step: 1, value: weight, title: "Peso: una con 3 sale el triple que una con 1", onchange: () => write(name, Math.max(1, Number(wi.value) || 1)) });
        return h("div", { class: "st-trow" }, ni, wi, h("button", { class: "icon ghost", title: "Quitar", onclick: () => edit((l) => { l.splice(i, 1); }) }, "×"));
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
        h("p", { class: "note" }, "Cada variante es un archivo de Worldgen/Templates. Se construyen bloque a bloque en la pestaña Plantillas."));
    }

    #placementSection(r) {
      const on = Array.isArray(r.placement?.on) ? r.placement.on : [];
      const input = h("input", { type: "text", value: on.join(", "), placeholder: "cualquier suelo", spellcheck: false,
        onchange: () => {
          const list = input.value.split(",").map((s) => s.trim()).filter(Boolean);
          this.#set("Sobre", "placement.on", list.length ? list : undefined);
        } });
      const missing = this.colors ? on.filter((t) => !this.colors.info(t)) : [];
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
      if (this.colors) {
        const tiles = S.structureTiles({ root: r }, this.templates);
        for (const t of new Set(tiles)) if (t !== "air" && !this.colors.info(t)) issues.push(h("div", { class: "at-issue bad" }, `«${t}» no existe en ningún archivo de tiles.`));
      }
      if (S.short(r.type) === "template")
        for (const v of r.config?.templates ?? []) {
          const n = S.short(typeof v === "string" ? v : v?.template);
          if (!this.templates.has(n)) issues.push(h("div", { class: "at-issue bad" }, `La plantilla «${n}» no existe en Worldgen/Templates.`));
        }
      if (this.docs.some((d) => d !== doc && S.short(d.root?.id) === S.short(r.id))) issues.push(h("div", { class: "at-issue bad" }, `Otra estructura usa el id «${r.id}».`));
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

    #templateFilePanel(id) {
      const t = this.templates.get(id);
      const users = this.docs.filter((d) => (d.root?.config?.templates ?? []).some((v) => S.short(typeof v === "string" ? v : v?.template) === id));
      this.panel.append(section({ id: "st-tfile", title: "Plantilla", extra: id },
        h("p", { class: "note" }, `${t.sizeX} × ${t.sizeY} × ${t.sizeZ} · ${t.blocks.length} bloques · anclaje ${t.anchorX}, ${t.anchorY}, ${t.anchorZ}`),
        h("p", { class: "note" }, "Se construye bloque a bloque en la pestaña Plantillas. Aquí solo se ve."),
        users.length ? h("p", { class: "note" }, "La usan: ", users.map((d) => d.root.id).join(", ")) : h("p", { class: "note" }, "Ninguna estructura la usa todavía: crea una con «+ Plantilla».")).el);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // 3D

    #draw = rafThrottle(() => this.#draw3d());

    async #draw3d() {
      if (!this.glCanvas?.isConnected || !this.glCanvas.clientWidth) return;
      clear(this.legend);
      const say = (text, cls = "faint") => this.legend.append(h("span", { class: cls }, text));
      if (!this.voxel) {
        this.voxel = new Aura.voxelView.VoxelView(this.glCanvas);
        new ResizeObserver(() => this.voxel.render()).observe(this.glCanvas);
      }
      if (!this.voxel.ok) { say("Este navegador no tiene WebGL2: la vista 3D no puede dibujarse.", "bad-text"); return; }
      if (!this.colors) return;

      // A template file on its own is shown as a structure that uses only it, standing as built (no turn, no foundation).
      const def = this.current?.template
        ? { root: { type: "template", config: { templates: [this.current.template], rotate: false } } }
        : this.current?.root ? { root: this.current.root } : null;
      if (!def) { this.voxel.setScene(EMPTY, () => [0, 0, 0, 1], false); return; }

      const used = this.#usedIn(this.current);
      const hex = this.tint ? this.tints?.find((t) => t.id === this.tint)?.hex : used[0]?.hex;
      const foliage = Tint.hexToRgb(hex) ?? Tint.hexToRgb(Tint.DEFAULT_TINT.hex);
      const key = JSON.stringify([def.root, this.seed, this.count, foliage]);
      if (key === this.sceneKey) { this.voxel.render(); say(this.sceneLegend ?? ""); return; }

      const ground = def.root.placement?.on?.[0] ?? "grass";
      await this.colors.ensure([...S.structureTiles(def, this.templates), ground, "dirt", "stone"]);
      if (JSON.stringify([def.root, this.seed, this.count, foliage]) !== key) return;      // edited while loading

      const built = S.buildPreview(def, this.templates, this.colors.kindInfo, { seed: this.seed, count: this.count });
      if (!built) { this.voxel.setScene(EMPTY, () => [0, 0, 0, 1], false); say(`El Studio no sabe dibujar el tipo «${def.root.type}».`, "bad-text"); return; }
      const reframe = this.framedFor !== this.current || this.framedCount !== this.count;
      this.voxel.setScene(built.scene, (p) => this.colors.color(p, foliage), reframe);
      this.framedFor = this.current;
      this.framedCount = this.count;
      this.sceneKey = key;

      const s = built.shapes;
      const trunks = s.map((x) => x.trunk).filter((n) => n != null);
      this.sceneLegend = `semilla ${this.seed}` + (trunks.length ? ` · tronco ${Math.min(...trunks)}–${Math.max(...trunks)}` : "")
        + ` · huella ${s.map((x) => x.footprint.toFixed(1)).join(", ")}` + " · colores: promedio del sprite de cada tile";
      clear(this.legend);
      say(this.sceneLegend);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Saving

    async save() {
      const dirty = this.docs.filter((d) => this.#isDirtyDoc(d));
      if (!dirty.length) return true;
      try {
        await this.studio.busy((async () => {
          for (const doc of dirty) {
            const text = this.#serialize(doc);
            if (!doc.entry) {
              const dir = await dirAt(this.project.root, dirName(doc.path));
              const handle = await dir.getFileHandle(baseName(doc.path), { create: true });
              await writeHandle(handle, text);
              doc.entry = this.project.addFile(doc.path, handle, dir);
              doc.isNew = false;
            } else {
              await writeHandle(doc.entry.handle, text);
            }
            doc.baseline = text;
          }
        })());
        this.history.markSaved();
        this.#changed();
        this.studio.toast("Guardado " + dirty.map((d) => d.name).join(", "), { kind: "ok", detail: "El juego las carga al arrancar." });
        return true;
      } catch (err) {
        this.studio.toast("No pude guardar.", { kind: "bad", detail: err.message });
        return false;
      }
    }
  }

  const EMPTY = { size: 1, height: 1, cells: new Uint16Array(1), palette: [{ id: "air", kind: 0 }], at: () => 0 };

  async function dirAt(root, path) {
    let dir = root;
    for (const part of path.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create: true });
    return dir;
  }

  Aura.structuresTool = { structuresTool };
})(window.Aura ??= {});
