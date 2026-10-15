"use strict";

// Biomas: create, edit and look at the biomes of Data/Worldgen/Biomes. The climate map shows which biome the generator picks for
// every temperature × humidity (at the continentalness / erosion / peaks chosen below it), with gaps and overlaps marked;
// the sample lays out a patch of the biome with its real tiles from the atlases — surface, its variants, decoration,
// foliage colour — so a biome is judged by how it looks, not by its numbers. The inspector edits every key BiomeData
// reads, checks each tile id against the tile files, and Ctrl+S writes the biome where the game loads it.
(function (Aura) {
  const { h, clear, rafThrottle } = Aura.dom;
  const { History } = Aura.history;
  const { prefs } = Aura.storage;
  const { writeHandle, joinPath, dirName, baseName } = Aura.fs;
  const { section, slider, select, checkbox, segmented, help } = Aura.controls;
  const { decodePng } = Aura.png;
  const B = Aura.biomeModel;
  const T = Aura.atlasTiles;
  const Tint = Aura.tint;

  const GRID = 9;

  const hash = (x, y, s) => {
    let n = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };

  // A colour for biomes without a foliage colour (the coast, deserts painted as they are), stable per id.
  const idColor = (id) => `hsl(${Math.floor(hash(id.length, [...id].reduce((a, c) => a + c.charCodeAt(0), 0), 7) * 360)}, 45%, 55%)`;

  function biomesTool() {
    return new BiomesTool();
  }

  class BiomesTool {
    id = "biomes";
    title = "Biomas";
    project = null;
    docs = [];
    current = null;
    view = prefs.get("biomes:view", "climate");
    slice = prefs.get("biomes:slice", { continentalness: 0.8, erosion: 0.5, pv: 0.5 });
    sample = { seed: 1, density: 4 };
    history = new History({ limit: 200 });
    #tiles = new Map();      // qualified tile id -> { tile, doc, sheet, coord, tw, th, parts, tinted, habitat }
    #sheets = new Map();     // sheet key -> Promise<canvas | null>

    mount(host, studio) {
      this.studio = studio;
      host.appendChild(this.#buildLayout());
      new ResizeObserver(() => this.#draw()).observe(this.viewEl);
      this.history.on("change", () => this.#changed());
      this.studio.commands.registerAll([
        { id: "biomes.save", title: "Guardar biomas", group: "Biomas", keys: ["Ctrl+S"], whileTyping: true, enabled: () => this.isDirty(), run: () => this.save() },
        { id: "biomes.undo", title: "Deshacer", group: "Biomas", keys: ["Ctrl+Z"], enabled: () => this.history.canUndo, run: () => this.history.undo() },
        { id: "biomes.redo", title: "Rehacer", group: "Biomas", keys: ["Ctrl+Y", "Ctrl+Shift+Z"], enabled: () => this.history.canRedo, run: () => this.history.redo() },
      ], this.id);
      this.#renderAll();
    }

    activate() { this.#draw(); }
    deactivate() {}
    isDirty() { return this.docs.some(B.isDirty); }
    dirtyLabel() { return "Biomas"; }

    async onProject(project) {
      this.project = project;
      if (this.isDirty()) {
        this.studio.toast("Carpeta releída. Hay biomas sin guardar: los mantengo.", { kind: "warn" });
        return;
      }
      await this.studio.busy(this.#load());
    }

    async #load() {
      const [docs, tileDocs] = await Promise.all([B.loadBiomes(this.project), T.loadDocs(this.project)]);
      this.docs = docs;
      this.#indexTiles(tileDocs);
      this.#sheets.clear();
      this.#spriteCache.clear();
      this.biomeTints = await Tint.listBiomes(this.project);
      this.history.clear();
      this.current = this.docs.find((d) => d.root && B.kindOf(d.root) === "surface") ?? this.docs[0] ?? null;
      this.#renderAll();
    }

    // Every tile the biomes may name, with the art the sample draws: its default front, or its parts stacked.
    #indexTiles(tileDocs) {
      this.#tiles.clear();
      for (const doc of tileDocs) {
        if (!doc.root) continue;
        const [tw, th] = T.docCell(doc);
        for (const tile of doc.root.tiles) {
          if (!tile || (!tile.id && !tile.name)) continue;
          const frontOf = (o) => {
            const f = o?.art?.default ?? o?.art?.Default;
            return T.isCoord(f) ? f : T.isCoord(f?.front) ? f.front : null;
          };
          const parts = Array.isArray(tile.parts)
            ? tile.parts.map((p) => ({ x: p.offsetX | 0, y: p.offsetY | 0, z: p.offsetZ | 0, coord: frontOf(p) })).filter((p) => p.coord)
            : [];
          const coord = frontOf(tile);
          this.#tiles.set(T.tileId(tile), {
            tile, doc, sheet: T.docSheet(doc, tile), coord, tw, th, parts,
            tinted: Array.isArray(tile.tags) && tile.tags.some((t) => String(t).toLowerCase() === "biome_tinted"),
            habitat: String(tile.habitat ?? "land").toLowerCase(),
          });
        }
      }
    }

    #tileInfo(ref) {
      if (!ref) return null;
      const id = String(ref).includes(":") ? String(ref) : "aura:" + ref;
      return this.#tiles.get(id) ?? null;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Layout

    #buildLayout() {
      this.listEl = h("div", { class: "bm-list scroll" });
      const left = h("div", { class: "bm-left" },
        h("div", { class: "bm-head" }, h("strong", null, "Biomas"), h("span", { class: "grow" }),
          h("button", { title: "Bioma nuevo", onclick: () => this.#create() }, "+ Nuevo")),
        this.listEl);

      this.viewSeg = segmented({ label: "Vista", value: this.view, onChange: (v) => { this.view = v; prefs.set("biomes:view", v); this.#renderToolbar(); this.#draw(); },
        options: [["climate", "Mapa de clima", "Qué bioma gana en cada temperatura y humedad"], ["sample", "Muestra", "Un trozo del bioma con sus tiles reales"]] });
      this.toolbarExtra = h("div", { class: "row bm-extra" });
      this.undoBtn = h("button", { class: "icon", title: "Deshacer (Ctrl+Z)", onclick: () => this.history.undo() }, "↶");
      this.redoBtn = h("button", { class: "icon", title: "Rehacer (Ctrl+Y)", onclick: () => this.history.redo() }, "↷");
      this.saveBtn = h("button", { class: "primary", title: "Guardar los biomas cambiados donde los carga el juego (Ctrl+S)", onclick: () => this.save() }, "Guardar");
      this.canvas = h("canvas", { class: "bm-canvas" });
      this.legend = h("div", { class: "bm-legend" });
      this.viewEl = h("div", { class: "bm-view" }, this.canvas, this.legend);
      this.canvas.addEventListener("mousemove", (e) => this.#hoverClimate(e));
      this.canvas.addEventListener("click", (e) => this.#clickClimate(e));
      const stage = h("div", { class: "bm-stage" },
        h("div", { class: "bm-toolbar" }, this.viewSeg.el, this.toolbarExtra, h("span", { class: "grow" }), this.undoBtn, this.redoBtn, this.saveBtn),
        this.viewEl);
      this.panel = h("div", { class: "bm-panel scroll" });
      return h("div", { class: "bm" }, left, stage, this.panel);
    }

    #renderAll() {
      this.#renderList();
      this.#renderToolbar();
      this.#renderPanel();
      this.#draw();
    }

    #changed() {
      this.#renderList();
      this.#renderPanel();
      this.#renderToolbar();
      this.#draw();
      this.studio.refreshDirty();
    }

    #renderList() {
      clear(this.listEl);
      if (!this.project) { this.listEl.append(h("div", { class: "empty-state" }, "Abre la carpeta del proyecto para ver sus biomas.")); return; }
      if (!this.docs.length) { this.listEl.append(h("div", { class: "empty-state" }, "No hay biomas en Data/Worldgen/Biomes. Crea el primero con «+ Nuevo».")); return; }
      const groups = [["surface", "Por clima"], ["coast", "Costa"], ["ocean", "Mar abierto"]];
      for (const [k, title] of groups) {
        const docs = this.docs.filter((d) => (d.root ? B.kindOf(d.root) : "surface") === k);
        if (!docs.length) continue;
        this.listEl.append(h("div", { class: "pl-cat" }, title));
        for (const d of docs) {
          const color = d.root?.colors?.foliage;
          this.listEl.append(h("div", { class: ["bm-item", d === this.current && "active"], onclick: () => this.#select(d) },
            h("span", { class: "swatch", style: { background: Tint.hexToRgb(color) ? color : idColor(d.root?.id ?? d.name) } }),
            h("span", { class: "grow" }, d.root?.name ?? d.name),
            B.isDirty(d) ? h("span", { class: "dot", title: "Sin guardar" }) : null,
            d.error ? h("span", { class: "badge bad", title: d.error }, "!") : null,
            this.#missingTiles(d).length ? h("span", { class: "badge warn", title: "Usa tiles que no existen" }, this.#missingTiles(d).length) : null));
        }
      }
    }

    #select(doc) {
      this.current = doc;
      this.#renderAll();
    }

    #renderToolbar() {
      this.undoBtn.disabled = !this.history.canUndo;
      this.redoBtn.disabled = !this.history.canRedo;
      this.saveBtn.disabled = !this.isDirty();
      clear(this.toolbarExtra);
      if (this.view === "climate") {
        for (const [key, label] of B.PARAMS.slice(2)) {
          const input = h("input", { type: "range", min: 0, max: 1, step: 0.01, value: this.slice[key], title: label,
            oninput: () => { this.slice[key] = Number(input.value); prefs.set("biomes:slice", this.slice); out.textContent = Number(input.value).toFixed(2); this.#draw(); } });
          const out = h("span", { class: "mono faint" }, this.slice[key].toFixed(2));
          this.toolbarExtra.append(h("label", { class: "bm-slice", title: `${label} del corte del mapa` }, label.split(" ")[0], input, out));
        }
      } else {
        const dens = h("input", { type: "range", min: 1, max: 30, step: 1, value: this.sample.density,
          oninput: () => { this.sample.density = Number(dens.value); this.#draw(); } });
        this.toolbarExtra.append(
          h("label", { class: "bm-slice", title: "Multiplica las probabilidades de decoración para ver también lo raro" }, "Densidad ×", dens),
          h("button", { title: "Otra muestra", onclick: () => { this.sample.seed++; this.#draw(); } }, "⟳ Otra"));
      }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Editing: each change swaps the whole biome object, so undo is exact and cheap (biome files are small).

    #edit(label, fn) {
      const doc = this.current;
      if (!doc?.root) return;
      const before = JSON.stringify(doc.root);
      const next = JSON.parse(before);
      fn(next);
      const after = JSON.stringify(next);
      if (after === before) return;
      this.history.run({ label, redo: () => { doc.root = JSON.parse(after); }, undo: () => { doc.root = JSON.parse(before); } });
    }

    async #create() {
      if (!this.project) { this.studio.toast("Abre la carpeta del proyecto.", { kind: "warn" }); return; }
      const name = await this.studio.prompt({ title: "Bioma nuevo", message: "Nombre (el id sale de él).", placeholder: "Swamp",
        validate: (v) => (!v ? "Escribe un nombre." : this.docs.some((d) => d.root?.id === T.deriveIdPath(v)) ? "Ya hay un bioma con ese id." : "") });
      if (!name) return;
      const id = T.deriveIdPath(name);
      const path = B.newBiomePath(this.project, this.docs, id);
      if (!path) { this.studio.toast("No encuentro Data/Tiles para saber dónde va Data/Worldgen/Biomes.", { kind: "bad" }); return; }
      const base = this.current?.root && B.kindOf(this.current.root) === "surface" ? structuredClone(this.current.root) : null;
      const root = base ? { ...base, id, name } : B.blank(id, name);
      const doc = { entry: null, path, name: baseName(path), root, eol: "\n", baseline: "", error: null, isNew: true };
      this.history.run({ label: `Nuevo bioma ${name}`, redo: () => { this.docs.push(doc); this.current = doc; }, undo: () => { this.docs.splice(this.docs.indexOf(doc), 1); this.current = this.docs[0] ?? null; } });
      this.studio.setStatus(`Bioma «${id}» creado${base ? " a partir de «" + (this.docs.find((d) => d !== doc && d.root?.id === base.id)?.root?.name ?? base.id) + "»" : ""}. Se escribe en ${path} al guardar.`, "ok");
    }

    #missingTiles(doc) {
      if (!doc?.root || !this.#tiles.size) return [];
      return B.tileRefs(doc.root).filter(([id]) => !this.#tileInfo(id));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Inspector

    #renderPanel() {
      if (this.panel.contains(document.activeElement)) document.activeElement.blur();
      const top = this.panel.scrollTop;
      clear(this.panel);
      const doc = this.current;
      if (!doc) {
        this.panel.append(h("div", { class: "empty-state" }, h("h3", null, "Biomas"), "Elige un bioma o crea uno. Aquí se editan su clima, sus materiales, su decoración y sus colores."));
        return;
      }
      if (!doc.root) {
        this.panel.append(h("div", { class: "empty-state" }, `${doc.name} no se puede leer: ${doc.error}`));
        return;
      }
      const r = doc.root, kind = B.kindOf(r);
      this.tileList = this.tileList ?? h("datalist", { id: "bm-tiles" });
      this.tileList.replaceChildren(...[...this.#tiles.keys()].sort().map((id) => h("option", { value: id.replace(/^aura:/, "") })));
      this.panel.append(this.tileList);

      // Identity
      const text = (label, value, apply, title = "") => {
        const input = h("input", { type: "text", value: value ?? "", spellcheck: false, onchange: () => apply(input.value.trim()) });
        return h("div", { class: "field" }, h("label", null, label, help(title)), input);
      };
      this.panel.append(section({ id: "bm-id", title: "Bioma", extra: doc.isNew ? "nuevo" : doc.name },
        text("Nombre", r.name, (v) => this.#edit("Nombre", (x) => { x.name = v; })),
        text("Id", r.id, (v) => this.#edit("Id", (x) => { x.id = v || undefined; }), "Lo que nombran estructuras, partidas guardadas y la decoración del mar"),
        h("div", { class: "field" }, h("label", null, "Colocación"),
          segmented({ label: "Colocación", value: kind, onChange: (v) => this.#setKind(v),
            options: [["surface", "Clima", "Compite con los demás por temperatura, humedad…"], ["coast", "Costa", "La franja de tierra junto al mar"], ["ocean", "Mar", "Solo decoración del mar abierto"]] }).el),
        doc.isNew ? h("p", { class: "note" }, "Se escribe en ", h("b", null, doc.path), " al guardar.") : null).el);

      if (kind !== "ocean") this.panel.append(this.#climateSection(r, kind).el, this.#materialsSection(r).el);
      this.panel.append(this.#decorationSection(r).el);
      if (kind !== "ocean") this.panel.append(this.#colorsSection(r).el);
      this.panel.append(this.#checkSection(doc).el, this.#rawSection(doc).el);
      this.panel.scrollTop = top;
    }

    #setKind(kind) {
      this.#edit("Colocación", (x) => {
        const box = B.boxOf(x);
        if (kind === "ocean") x.placement = { ocean: {} };
        else if (kind === "coast") x.placement = { coast: { width: [8, 16], temperature: box.temperature, humidity: box.humidity } };
        else x.placement = { surface: { temperature: box.temperature, humidity: box.humidity, continentalness: [0.55, 1] } };
      });
    }

    // Two numbers and a double slider per climate parameter; a parameter left at 0..1 is not written (any value).
    #climateSection(r, kind) {
      const params = kind === "coast" ? B.PARAMS.slice(0, 2) : B.PARAMS;
      const key = kind === "coast" ? "coast" : "surface";
      const box = B.boxOf(r);
      const rows = params.map(([p, label]) => {
        const [lo, hi] = box[p];
        const set = (a, b) => this.#edit(label, (x) => {
          const src = x.placement[key];
          const v = [Math.min(a, b), Math.max(a, b)].map((n) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000);
          if (v[0] === 0 && v[1] === 1 && p !== "temperature" && p !== "humidity") delete src[p];
          else src[p] = v;
        });
        const a = h("input", { type: "number", min: 0, max: 1, step: 0.01, value: lo, onchange: () => set(Number(a.value), hi) });
        const b = h("input", { type: "number", min: 0, max: 1, step: 0.01, value: hi, onchange: () => set(lo, Number(b.value)) });
        const bar = h("div", { class: "bm-range" }, h("i", { style: { left: lo * 100 + "%", width: (hi - lo) * 100 + "%" } }));
        return h("div", { class: "field bm-param" }, h("label", null, label), h("div", { class: "bm-pair" }, a, bar, b));
      });
      const extra = [];
      if (kind === "coast") {
        const [w0, w1] = Array.isArray(r.placement.coast.width) ? r.placement.coast.width : [8, 16];
        const a = h("input", { type: "number", min: 1, max: 64, value: w0, onchange: () => this.#edit("Ancho", (x) => { x.placement.coast.width = [Number(a.value), Math.max(Number(a.value), w1)]; }) });
        const b = h("input", { type: "number", min: 1, max: 64, value: w1, onchange: () => this.#edit("Ancho", (x) => { x.placement.coast.width = [w0, Math.max(w0, Number(b.value))]; }) });
        extra.push(h("div", { class: "field" }, h("label", null, "Ancho (tiles)", help("Cuánto entra la franja tierra adentro; varía entre estos dos")), h("div", { class: "pair" }, a, b)));
      }
      return section({ id: "bm-climate", title: "Clima", extra: kind === "coast" ? "costa" : "" }, ...rows, ...extra,
        h("p", { class: "note" }, "Gana el bioma con la caja más cercana al clima de cada columna. Mira el mapa: rayado = hueco (ningún bioma lo pide), cuadriculado = solape."));
    }

    #tileInput(value, apply, placeholder = "tile") {
      const input = h("input", { type: "text", value: value ?? "", list: "bm-tiles", placeholder, spellcheck: false, onchange: () => apply(input.value.trim()) });
      if (value && !this.#tileInfo(value) && this.#tiles.size) input.classList.add("bad");
      return input;
    }

    #materialsSection(r) {
      const m = r.materials ?? {};
      const mat = (label, key, title) => h("div", { class: "field" }, h("label", null, label, help(title)),
        this.#tileInput(m[key], (v) => this.#edit(label, (x) => { (x.materials ??= {})[key] = v || undefined; })));
      const variants = (m.surfaceVariants ?? []).map((v, i) => this.#chanceRow(v, i,
        (fn) => this.#edit("Variante de superficie", (x) => fn(x.materials.surfaceVariants)), false));
      const depth = slider({ label: "Prof. intermedia", min: 0, max: 12, step: 1, value: m.shallowDepth ?? 3, defaultValue: 3,
        title: "Bloques de material intermedio bajo la superficie", onChange: (v) => this.#edit("Profundidad", (x) => { (x.materials ??= {}).shallowDepth = v; }) });
      const blend = checkbox({ label: "Mezclar superficie con intermedio", value: !!m.blendShallow,
        title: "La franja intermedia intercala tiles de superficie (playas)", onChange: (v) => this.#edit("Mezclar", (x) => { (x.materials ??= {}).blendShallow = v || undefined; }) });
      return section({ id: "bm-materials", title: "Materiales" },
        mat("Superficie", "surface", "El tile de arriba de cada columna"),
        mat("Intermedio", "shallow", "Debajo de la superficie (por defecto dirt)"),
        mat("Profundo", "deep", "El resto hacia abajo (por defecto stone)"),
        depth.el, blend.el,
        h("div", { class: "at-sub" }, "Variantes de superficie"),
        ...variants,
        h("button", { onclick: () => this.#edit("Variante", (x) => { ((x.materials ??= {}).surfaceVariants ??= []).push({ tile: "", chance: 0.01 }); }) }, "+ Variante"));
    }

    // One tile + chance (+ where, for decoration) row with a delete button.
    #chanceRow(entry, i, edit, withOn) {
      const chance = h("input", { type: "number", min: 0, max: 1, step: 0.0001, value: entry.chance ?? 0, title: "Probabilidad por columna (0..1)",
        onchange: () => edit((list) => { list[i].chance = Number(chance.value); }) });
      const tile = this.#tileInput(entry.tile, (v) => edit((list) => { list[i].tile = v; }));
      const on = withOn ? select({ value: entry.on ?? "", options: B.SURFACES, title: "Dónde crece", onChange: (v) => edit((list) => { if (v) list[i].on = v; else delete list[i].on; }) }).input : null;
      const info = this.#tileInfo(entry.tile);
      const thumb = h("canvas", { class: "bm-thumb", width: 32, height: 32 });
      if (info) this.#paintThumb(thumb, info);
      return h("div", { class: ["bm-row", withOn && "with-on"] }, thumb, tile, chance, on,
        h("button", { class: "icon ghost", title: "Quitar", onclick: () => edit((list) => { list.splice(i, 1); }) }, "×"));
    }

    #decorationSection(r) {
      const list = r.decoration ?? [];
      const rows = list.map((d, i) => this.#chanceRow(d, i, (fn) => this.#edit("Decoración", (x) => fn(x.decoration)), true));
      const total = list.reduce((s, d) => s + (Number(d.chance) || 0), 0);
      return section({ id: "bm-deco", title: "Decoración", extra: `${list.length} · Σ ${total.toFixed(3)}` },
        ...rows,
        h("button", { onclick: () => this.#edit("Decoración", (x) => { (x.decoration ??= []).push({ tile: "", chance: 0.01 }); }) }, "+ Decoración"),
        h("p", { class: "note" }, "Por columna se tira una vez y las probabilidades se suman en orden, así que el total debería quedar por debajo de 1. «Automático» decide por el hábitat del tile (las algas en el fondo, los nenúfares sobre el agua)."));
    }

    #colorsSection(r) {
      const color = (label, key, title) => {
        const v = r.colors?.[key];
        const input = h("input", { type: "color", value: Tint.hexToRgb(v) ? v : "#5ce365",
          onchange: () => this.#edit(label, (x) => { (x.colors ??= {})[key] = input.value; }) });
        const off = h("button", { class: "icon ghost", title: "Quitar (sin color: el juego usa el suyo por defecto)", onclick: () => this.#edit(label, (x) => { if (x.colors) delete x.colors[key]; }) }, "×");
        return h("div", { class: "field" }, h("label", null, label, help(title)), h("div", { class: "row" }, input, h("span", { class: "mono faint" }, v ?? "—"), off));
      };
      return section({ id: "bm-colors", title: "Colores" },
        color("Follaje", "foliage", "Tiñe los tiles biome_tinted (hierba, hojas)"),
        color("Atmósfera", "atmosphere", "El color del aire del bioma"));
    }

    #checkSection(doc) {
      const missing = this.#missingTiles(doc);
      const r = doc.root, kind = B.kindOf(r);
      const issues = [
        ...missing.map(([id, where]) => h("div", { class: "at-issue bad" }, `«${id}» (${where}) no existe en ningún archivo de tiles. Créalo en Crear → Atlas o corrige el nombre.`)),
        kind !== "ocean" && !r.materials?.surface ? h("div", { class: "at-issue bad" }, "Falta materials.surface: el juego no carga el bioma.") : null,
        (r.decoration ?? []).reduce((s, d) => s + (Number(d.chance) || 0), 0) > 1 ? h("div", { class: "at-issue warn" }, "La decoración suma más de 1: las últimas entradas no salen nunca.") : null,
        this.docs.filter((d) => d !== doc && d.root?.id && d.root.id === r.id).length ? h("div", { class: "at-issue bad" }, `Otro bioma usa el id «${r.id}».`) : null,
      ].filter(Boolean);
      return section({ id: "bm-check", title: "Revisión", extra: issues.length ? String(issues.length) : "todo bien" },
        issues.length ? issues : h("p", { class: "note" }, "Todos los tiles existen y el bioma se puede cargar."));
    }

    #rawSection(doc) {
      const raw = h("textarea", { class: "at-raw", rows: 14, spellcheck: false, value: T.formatJson(doc.root) });
      const err = h("p", { class: "note bad" });
      return section({ id: "bm-raw", title: "JSON", collapsed: true }, raw, err,
        h("button", { onclick: () => {
          let next;
          try { next = JSON.parse(raw.value); } catch (e) { err.textContent = "JSON no válido: " + e.message; return; }
          if (!next || typeof next !== "object" || (!next.id && !next.name)) { err.textContent = "Un bioma es un objeto con \"id\" o \"name\"."; return; }
          this.#edit("JSON", (x) => { for (const k of Object.keys(x)) delete x[k]; Object.assign(x, next); });
        } }, "Aplicar JSON"));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Drawing

    #draw = rafThrottle(() => {
      const c = this.canvas;
      if (!c?.isConnected || !c.clientWidth) return;
      const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const g = c.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      if (this.view === "climate") this.#drawClimate(g, W, H);
      else this.#drawSample(g, W, H);
    });

    #surfaceBiomes() {
      return this.docs.filter((d) => d.root && B.kindOf(d.root) === "surface").map((d) => ({
        doc: d, box: B.boxOf(d.root),
        color: Tint.hexToRgb(d.root.colors?.foliage) ? d.root.colors.foliage : idColor(d.root.id ?? d.name),
      }));
    }

    // Temperature left → right, humidity bottom → top, each cell coloured by the biome the generator picks there.
    #drawClimate(g, W, H) {
      const biomes = this.#surfaceBiomes();
      clear(this.legend);
      if (!biomes.length) { g.fillStyle = "#98a0aa"; g.fillText("Sin biomas por clima.", 20, 30); return; }
      const size = Math.max(120, Math.min(W - 80, H - 90)), ox = Math.round((W - size) / 2) + 10, oy = Math.round((H - size) / 2) - 10;
      this.chart = { ox, oy, size };
      const N = 100, cell = size / N;
      for (let yi = 0; yi < N; yi++) {
        for (let xi = 0; xi < N; xi++) {
          const climate = { temperature: (xi + 0.5) / N, humidity: 1 - (yi + 0.5) / N, ...this.slice };
          const { biome } = B.pick(biomes, climate);
          const n = B.inside(biomes, climate);
          g.fillStyle = biome.color;
          g.globalAlpha = biome.doc === this.current ? 1 : 0.72;
          g.fillRect(ox + xi * cell, oy + yi * cell, cell + 0.5, cell + 0.5);
          g.globalAlpha = 1;
          // Gap: no box asks for this climate (the nearest takes it). Overlap: several do (the first nearest wins).
          if (n === 0 && (xi + yi) % 4 === 0) { g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(ox + xi * cell, oy + yi * cell, cell, cell); }
          if (n > 1 && xi % 3 === 0 && yi % 3 === 0) { g.fillStyle = "rgba(255,255,255,.7)"; g.fillRect(ox + xi * cell, oy + yi * cell, cell, cell); }
        }
      }
      // Each box, the open biome's thickest. A box outside the current continentalness / erosion / peaks is dashed.
      for (const b of biomes) {
        const [t0, t1] = b.box.temperature, [h0, h1] = b.box.humidity;
        const active = B.PARAMS.slice(2).every(([k]) => this.slice[k] >= b.box[k][0] && this.slice[k] <= b.box[k][1]);
        g.strokeStyle = b.doc === this.current ? "#fff" : "rgba(255,255,255,.55)";
        g.lineWidth = b.doc === this.current ? 2.5 : 1;
        g.setLineDash(active ? [] : [4, 4]);
        g.strokeRect(ox + t0 * size, oy + (1 - h1) * size, (t1 - t0) * size, (h1 - h0) * size);
        g.setLineDash([]);
        g.fillStyle = "#fff";
        g.font = "11px system-ui";
        g.fillText(b.doc.root.name ?? b.doc.root.id, ox + t0 * size + 4, oy + (1 - h1) * size + 13);
      }
      g.fillStyle = "#98a0aa";
      g.font = "12px system-ui";
      g.fillText("Temperatura →", ox + size / 2 - 40, oy + size + 18);
      g.save(); g.translate(ox - 10, oy + size / 2 + 30); g.rotate(-Math.PI / 2); g.fillText("Humedad →", 0, 0); g.restore();
      this.legend.append(
        h("span", null, h("i", { class: "bm-gap" }), "hueco"), h("span", null, h("i", { class: "bm-over" }), "solape"),
        h("span", { class: "faint" }, "Clic: abrir el bioma de ahí"));
    }

    #climateAt(e) {
      if (!this.chart) return null;
      const r = this.canvas.getBoundingClientRect();
      const x = (e.clientX - r.left - this.chart.ox) / this.chart.size, y = (e.clientY - r.top - this.chart.oy) / this.chart.size;
      if (x < 0 || y < 0 || x > 1 || y > 1) return null;
      return { temperature: x, humidity: 1 - y, ...this.slice };
    }

    #hoverClimate(e) {
      if (this.view !== "climate") return;
      const c = this.#climateAt(e);
      if (!c) { this.studio.slot("climate", ""); return; }
      const biomes = this.#surfaceBiomes();
      const { biome } = B.pick(biomes, c), n = B.inside(biomes, c);
      this.studio.slot("climate", `T ${c.temperature.toFixed(2)} · H ${c.humidity.toFixed(2)} → ${biome?.doc.root.name ?? "—"}${n === 0 ? " (hueco)" : n > 1 ? " (solape)" : ""}`);
    }

    #clickClimate(e) {
      if (this.view !== "climate") return;
      const c = this.#climateAt(e);
      if (!c) return;
      const { biome } = B.pick(this.#surfaceBiomes(), c);
      if (biome) this.#select(biome.doc);
    }

    // A patch of the biome: GRID × GRID columns of its surface (with variants), decoration on top, the foliage colour on
    // what is biome_tinted. Chances are multiplied by the density so rare entries show up.
    #drawSample(g, W, H) {
      clear(this.legend);
      const r = this.current?.root;
      if (!r) return;
      const kind = B.kindOf(r);
      const surface = this.#tileInfo(r.materials?.surface);
      if (kind === "ocean" || !surface) {
        g.fillStyle = "#98a0aa"; g.font = "13px system-ui";
        g.fillText(kind === "ocean" ? "La decoración del mar se ve en el juego (no hay suelo que dibujar)." : "Falta el tile de superficie (o no existe).", 20, 30);
        return;
      }
      const need = new Set([surface, ...(r.materials?.surfaceVariants ?? []).map((v) => this.#tileInfo(v.tile)), ...(r.decoration ?? []).map((d) => this.#tileInfo(d.tile))].filter(Boolean).map((i) => i.sheet));
      const pending = [...need].filter((k) => !this.#sheets.has(k) || this.#sheets.get(k).value === undefined);
      if (pending.length) {
        for (const k of pending) this.#sheetCanvas(k).then(() => this.#draw());
        g.fillStyle = "#98a0aa"; g.fillText("Cargando hojas…", 20, 30);
        return;
      }
      const S = surface.tw, E = Aura.blockEngine, BH = E.BLOCK_HEIGHT;
      const o = E.project([0, 0, 0], S, BH), px = E.project([1, 0, 0], S, BH), py = E.project([0, 1, 0], S, BH), pz = E.project([0, 0, BH], S, BH);
      const at = (i, j, l) => [i * (px[0] - o[0]) + j * (py[0] - o[0]) + l * (pz[0] - o[0]), i * (px[1] - o[1]) + j * (py[1] - o[1]) + l * (pz[1] - o[1])];
      const foliage = Tint.hexToRgb(r.colors?.foliage) ?? Tint.hexToRgb(Tint.DEFAULT_TINT.hex);
      const draws = [];
      const seed = this.sample.seed;
      for (let i = 0; i < GRID; i++) {
        for (let j = 0; j < GRID; j++) {
          let top = surface;
          let roll = hash(i, j, seed * 3 + 1), acc = 0;
          for (const v of r.materials?.surfaceVariants ?? []) {
            acc += (Number(v.chance) || 0) * this.sample.density;
            if (roll < acc) { top = this.#tileInfo(v.tile) ?? top; break; }
          }
          const shift = (hash(i, j, 99) * 2 - 1) * 10;
          draws.push({ info: top, i, j, l: 0, shift });
          roll = hash(i, j, seed * 7 + 5); acc = 0;
          for (const d of r.decoration ?? []) {
            const info = this.#tileInfo(d.tile);
            acc += (Number(d.chance) || 0) * this.sample.density;
            if (roll < acc) {
              // Water plants need water; the sample is dry land, so they are left out (counted in the legend).
              if (info && (info.habitat === "land" || !info.habitat) && (!d.on || d.on === "surface")) draws.push({ info, i, j, l: 1, shift });
              break;
            }
          }
        }
      }
      const pieces = [];
      for (const d of draws) {
        const parts = d.info.parts.length ? d.info.parts : [{ x: 0, y: 0, z: 0, coord: d.info.coord }];
        for (const p of parts) if (p.coord) pieces.push({ ...d, coord: p.coord, i: d.i + p.x, j: d.j + p.z, l: d.l + p.y });
      }
      pieces.sort((a, b) => a.i + a.j - (b.i + b.j) || a.l - b.l);
      const pos = pieces.map((p) => at(p.i, p.j, p.l));
      const minX = Math.min(...pos.map((p) => p[0])), minY = Math.min(...pos.map((p) => p[1]));
      const maxX = Math.max(...pos.map((p) => p[0])) + S, maxY = Math.max(...pos.map((p) => p[1])) + S;
      const scene = new OffscreenCanvas(Math.ceil(maxX - minX), Math.ceil(maxY - minY));
      const sg = scene.getContext("2d");
      pieces.forEach((p, k) => {
        const img = this.#sprite(p.info, p.coord, p.info.tinted ? shiftRgb(foliage, p.shift) : null);
        if (img) sg.drawImage(img, Math.round(pos[k][0] - minX), Math.round(pos[k][1] - minY));
      });
      g.fillStyle = "#3d4a55";
      g.fillRect(0, 0, W, H);
      const z = Math.max(1, Math.floor(Math.min((W - 40) / scene.width, (H - 60) / scene.height) * 2) / 2);
      g.imageSmoothingEnabled = false;
      g.drawImage(scene, Math.round((W - scene.width * z) / 2), Math.round((H - 30 - scene.height * z) / 2), scene.width * z, scene.height * z);
      const water = (r.decoration ?? []).filter((d) => { const info = this.#tileInfo(d.tile); return info && ((d.on && d.on !== "surface") || (!d.on && info.habitat !== "land")); }).length;
      this.legend.append(h("span", { class: "faint" }, `${GRID}×${GRID} columnas · decoración ×${this.sample.density}` + (water ? ` · ${water} de agua no se dibujan` : "")));
    }

    // The sheet of a tile as a canvas, decoded once.
    #sheetCanvas(key) {
      if (this.#sheets.has(key)) return this.#sheets.get(key).promise;
      const slot = { value: undefined };
      slot.promise = (async () => {
        const atlas = this.project?.atlases.find((a) => T.sheetKey(a.id) === key);
        if (!atlas?.png) return (slot.value = null);
        const img = await decodePng(await atlas.png.handle.getFile());
        const c = new OffscreenCanvas(img.w, img.h);
        c.getContext("2d").putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
        return (slot.value = { canvas: c, img });
      })().catch(() => (slot.value = null));
      this.#sheets.set(key, slot);
      return slot.promise;
    }

    #spriteCache = new Map();

    #sprite(info, coord, tint) {
      const sheet = this.#sheets.get(info.sheet)?.value;
      if (!sheet) return null;
      const key = `${info.sheet}|${coord}|${tint ?? ""}`;
      let c = this.#spriteCache.get(key);
      if (c) return c;
      const { tw, th } = info, x = coord[0] * tw, y = coord[1] * th;
      c = new OffscreenCanvas(tw, th);
      const cg = c.getContext("2d");
      cg.drawImage(sheet.canvas, x, y, tw, th, 0, 0, tw, th);
      if (tint) {
        const d = cg.getImageData(0, 0, tw, th);
        cg.putImageData(new ImageData(Tint.applyTint(d.data, tint), tw, th), 0, 0);
      }
      this.#spriteCache.set(key, c);
      return c;
    }

    async #paintThumb(canvas, info) {
      await this.#sheetCanvas(info.sheet);
      const img = info.coord ? this.#sprite(info, info.coord, null) : info.parts[0] ? this.#sprite(info, info.parts[0].coord, null) : null;
      if (!img) return;
      const g = canvas.getContext("2d");
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 0, 0, 32, 32);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Saving

    async save() {
      const dirty = this.docs.filter(B.isDirty);
      if (!dirty.length) return true;
      try {
        await this.studio.busy((async () => {
          for (const doc of dirty) {
            const text = B.serialize(doc);
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
        this.studio.toast("Guardado " + dirty.map((d) => d.name).join(", "), { kind: "ok", detail: "El juego los carga al arrancar." });
        return true;
      } catch (err) {
        this.studio.toast("No pude guardar.", { kind: "bad", detail: err.message });
        return false;
      }
    }
  }

  async function dirAt(root, path) {
    let dir = root;
    for (const part of path.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create: true });
    return dir;
  }

  function shiftRgb([r, g, b], degrees) {
    const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), k = 1 / 3, q = Math.sqrt(k);
    const m = (i, j) => (i === j ? c + k * (1 - c) : k * (1 - c) + (((i + 1) % 3 === j) ? -1 : 1) * q * s);
    const v = [r, g, b];
    return [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(v[0] * m(i, 0) + v[1] * m(i, 1) + v[2] * m(i, 2)))));
  }

  Aura.biomesTool = { biomesTool };
})(window.Aura ??= {});
