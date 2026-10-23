"use strict";

// Biomas: create, edit and look at the biomes of Data/Worldgen/Biomes. The climate map shows which biome the generator picks for
// every temperature × humidity (at the continentalness / erosion / peaks chosen below it), with gaps and overlaps marked;
// the sample lays out a patch of the biome with its real tiles from the atlases — surface, its variants, decoration,
// foliage colour — so a biome is judged by how it looks, not by its numbers. The 3D view builds a bigger patch with the
// biome's structures (trees, houses) grown as the game grows them, each tile in its sprite's colour, to orbit around. The
// inspector edits every key BiomeData reads (structures included), checks each tile and structure id against the files,
// and Ctrl+S writes the biome where the game loads it.
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
  const Scene = Aura.biomeScene;

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
    sample = { seed: 1, density: 1, size: prefs.get("biomes:sampleSize", 16), relief: prefs.get("biomes:relief", true), water: prefs.get("biomes:water", true) };
    view3d = { seed: 1, density: 1, size: prefs.get("biomes:3dSize", 48), relief: prefs.get("biomes:3dRelief", true), water: prefs.get("biomes:3dWater", true),
      structures: prefs.get("biomes:3dStructures", true) };
    structs = { structures: new Map(), templates: new Map(), errors: [] };
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
      const [docs, tileDocs, structs] = await Promise.all([B.loadBiomes(this.project), T.loadDocs(this.project), Scene.loadStructures(this.project)]);
      this.docs = docs;
      this.structs = structs;
      this.scene3dKey = null;
      this.#indexTiles(tileDocs);
      this.#sheets.clear();
      this.#spriteCache.clear();
      this.colorCache = new Map();
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
        options: [["climate", "Mapa de clima", "Qué bioma gana en cada temperatura y humedad"], ["sample", "Muestra", "Un trozo del bioma con sus tiles reales"],
          ["3d", "3D", "Un trozo más grande con sus estructuras (árboles, casas), cada tile con su color, para girar alrededor"]] });
      this.toolbarExtra = h("div", { class: "row bm-extra" });
      this.undoBtn = h("button", { class: "icon", title: "Deshacer (Ctrl+Z)", onclick: () => this.history.undo() }, "↶");
      this.redoBtn = h("button", { class: "icon", title: "Rehacer (Ctrl+Y)", onclick: () => this.history.redo() }, "↷");
      this.saveBtn = h("button", { class: "primary", title: "Guardar los biomas cambiados donde los carga el juego (Ctrl+S)", onclick: () => this.save() }, "Guardar");
      this.canvas = h("canvas", { class: "bm-canvas" });
      this.legend = h("div", { class: "bm-legend" });
      this.glCanvas = h("canvas", { class: "bm-canvas bm-gl", title: "Arrastra: girar · clic derecho o Shift: mover · rueda: zoom · doble clic: vista del juego" });
      this.viewEl = h("div", { class: "bm-view" }, this.canvas, this.glCanvas, this.legend);
      this.canvas.addEventListener("mousemove", (e) => this.#hoverClimate(e));
      this.canvas.addEventListener("click", (e) => this.#clickClimate(e));
      const stage = h("div", { class: "bm-stage" },
        h("div", { class: "bm-toolbar" }, this.viewSeg.el, this.toolbarExtra, h("span", { class: "grow" }),
          h("button", { title: "Añade a cada bioma las decoraciones que le tocan por hábitat, suelo y clima (se revisa antes)", onclick: () => this.#distributeAll() }, "Repartir"),
          this.undoBtn, this.redoBtn, this.saveBtn),
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
      this.suggestOpen = false;
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
      } else if (this.view === "3d") {
        this.#toolbar3d();
      } else {
        const densOut = h("span", { class: "mono faint" }, "×" + this.sample.density);
        const dens = h("input", { type: "range", min: 0.5, max: 10, step: 0.5, value: this.sample.density,
          oninput: () => { this.sample.density = Number(dens.value); densOut.textContent = "×" + this.sample.density; this.#draw(); } });
        const size = select({ value: String(this.sample.size), options: [["9", "9×9"], ["16", "16×16"], ["24", "24×24"], ["32", "32×32"]], title: "Tamaño de la muestra",
          onChange: (v) => { this.sample.size = Number(v); prefs.set("biomes:sampleSize", this.sample.size); this.#draw(); } });
        const flag = (label, key, title) => {
          const c = h("input", { type: "checkbox", checked: this.sample[key], onchange: () => { this.sample[key] = c.checked; prefs.set("biomes:" + key, c.checked); this.#draw(); } });
          return h("label", { class: "bm-slice", title }, c, label);
        };
        this.toolbarExtra.append(
          size.input ?? size.el,
          flag("Relieve", "relief", "Lomas suaves de 1–3 bloques, como el terreno real"),
          flag("Agua", "water", "Un estanque en lo más bajo, con las plantas de agua del bioma"),
          h("label", { class: "bm-slice", title: "×1 = las probabilidades reales; más para ver también lo raro" }, "Densidad", dens, densOut),
          h("button", { title: "Otra muestra", onclick: () => { this.sample.seed++; this.#draw(); } }, "⟳ Otra"));
      }
    }

    #toolbar3d() {
      const v = this.view3d;
      const flag = (label, key, title) => {
        const c = h("input", { type: "checkbox", checked: v[key], onchange: () => { v[key] = c.checked; prefs.set("biomes:3d" + key[0].toUpperCase() + key.slice(1), c.checked); this.#draw(); } });
        return h("label", { class: "bm-slice", title }, c, label);
      };
      const densOut = h("span", { class: "mono faint" }, "×" + v.density);
      const dens = h("input", { type: "range", min: 0.5, max: 5, step: 0.5, value: v.density,
        oninput: () => { v.density = Number(dens.value); densOut.textContent = "×" + v.density; this.#draw(); } });
      const size = select({ value: String(v.size), options: [["32", "32×32"], ["48", "48×48"], ["64", "64×64"], ["96", "96×96"]], title: "Tamaño del trozo",
        onChange: (s) => { v.size = Number(s); prefs.set("biomes:3dSize", v.size); this.#draw(); } });
      const persp = h("button", { title: "Perspectiva u ortográfica (la del juego)", onclick: () => { persp.textContent = this.voxel?.togglePerspective() ? "Ortográfica" : "Perspectiva"; } },
        this.voxel?.cam.ortho === false ? "Perspectiva" : "Ortográfica");
      this.toolbarExtra.append(
        size.input ?? size.el,
        flag("Relieve", "relief", "Colinas de hasta 6 bloques"),
        flag("Agua", "water", "Un estanque en lo más bajo"),
        flag("Estructuras", "structures", "Los árboles y casas de la lista «Estructuras» del bioma"),
        h("label", { class: "bm-slice", title: "×1 = las probabilidades reales (decoración y estructuras); más para ver lo raro" }, "Densidad", dens, densOut),
        h("button", { title: "Otro trozo", onclick: () => { v.seed++; this.#draw(); } }, "⟳ Otro"),
        h("button", { title: "Vista del juego (doble clic en la vista)", onclick: () => this.voxel?.iso() }, "Iso"),
        h("button", { class: "icon", title: "Girar 90°", onclick: () => this.voxel?.turn(1) }, "↻"),
        persp);
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
      if (kind !== "ocean") this.panel.append(this.#structuresSection(r).el, this.#colorsSection(r).el);
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
      // Decoration rows get − / + around the chance: ×0.8 / ×1.25, so "a bit more of this" needs no typing.
      const nudge = (f, label, title) => h("button", { class: "icon ghost bm-nudge", title,
        onclick: () => edit((list) => { list[i].chance = Math.round(Math.min(1, (Number(list[i].chance) || 0) * f) * 100000) / 100000; }) }, label);
      const chanceCell = withOn ? h("div", { class: "bm-chance" }, nudge(0.8, "−", "Menos (×0,8)"), chance, nudge(1.25, "+", "Más (×1,25)")) : chance;
      const info = this.#tileInfo(entry.tile);
      const thumb = h("canvas", { class: "bm-thumb", width: 32, height: 32 });
      if (info) this.#paintThumb(thumb, info);
      return h("div", { class: ["bm-row", withOn && "with-on"] }, thumb, tile, chanceCell, on,
        h("button", { class: "icon ghost", title: "Quitar", onclick: () => edit((list) => { list.splice(i, 1); }) }, "×"));
    }

    #decorationSection(r) {
      const list = r.decoration ?? [];
      const rows = list.map((d, i) => this.#chanceRow(d, i, (fn) => this.#edit("Decoración", (x) => fn(x.decoration)), true));
      const total = list.reduce((s, d) => s + (Number(d.chance) || 0), 0);
      this.decoTarget ??= 0.6;
      const target = h("input", { type: "number", min: 0.05, max: 0.95, step: 0.05, value: this.decoTarget,
        title: "Cuánto suelo cubre la decoración en total (0..0,95): «Auto-ajustar» reparte esto entre las entradas",
        onchange: () => { this.decoTarget = Math.min(0.95, Math.max(0.05, Number(target.value) || 0.6)); } });
      const dupes = list.length - new Set(list.map((d) => String(d.tile ?? "").replace(/^aura:/, "").toLowerCase() + "|" + (d.on ?? ""))).size;
      const weights = h("div", { class: "bm-weights" },
        h("button", { title: "Recalcula todos los pesos según qué es cada tile (hierba común, flores y rocas raras, menas más raras, plantas de agua) y su clima, para que sumen la cobertura de al lado. Junta las entradas repetidas.",
          onclick: () => this.#edit("Auto-ajustar pesos", (x) => { x.decoration = B.autoWeights(x, this.#tiles, this.decoTarget).decoration; }) }, "Auto-ajustar"),
        h("label", { class: "faint", title: "Cobertura total" }, "a ", target),
        h("span", { class: "grow" }),
        h("button", { title: "Todas las probabilidades ×0,8", onclick: () => this.#edit("Menos decoración", (x) => { x.decoration = B.scaleWeights(x, 0.8); }) }, "− Menos"),
        h("button", { title: "Todas las probabilidades ×1,25 (sin pasar de 0,99 en total)", onclick: () => this.#edit("Más decoración", (x) => { x.decoration = B.scaleWeights(x, 1.25); }) }, "+ Más"));
      return section({ id: "bm-deco", title: "Decoración", extra: `${list.length} · Σ ${total.toFixed(3)}` },
        list.length ? weights : null,
        dupes ? h("div", { class: "at-issue warn" }, `${dupes} entrada${dupes > 1 ? "s" : ""} repetida${dupes > 1 ? "s" : ""} (mismo tile y mismo «dónde»): «Auto-ajustar» las junta.`) : null,
        ...rows,
        h("div", { class: "row" },
          h("button", { onclick: () => this.#edit("Decoración", (x) => { (x.decoration ??= []).push({ tile: "", chance: 0.01 }); }) }, "+ Decoración"),
          h("button", { title: "Propone las plantas y rocas que le tocan a este bioma por su hábitat, su suelo y su clima",
            onclick: () => { this.suggestOpen = !this.suggestOpen; this.suggestPick = null; this.#renderPanel(); } }, this.suggestOpen ? "Cerrar sugerencias" : "Sugerir por hábitat")),
        this.suggestOpen ? this.#suggestions(r) : null,
        h("p", { class: "note" }, "Por columna se tira una vez y las probabilidades se suman en orden, así que el total debería quedar por debajo de 1. «Automático» decide por el hábitat del tile (las algas en el fondo, los nenúfares sobre el agua)."));
    }

    // The biome's "structures": which structures grow here and how densely. The structure files say what they are and what
    // ground they need; the density is the biome's, so one oak can be thick in a forest and rare on the plains.
    #structuresSection(r) {
      const list = Array.isArray(r.structures) ? r.structures : [];
      this.structList = this.structList ?? h("datalist", { id: "bm-structures" });
      this.structList.replaceChildren(...[...this.structs.structures.keys()].sort().map((id) => h("option", { value: id })));
      const edit = (fn) => this.#edit("Estructuras", (x) => { x.structures ??= []; fn(x.structures); if (!x.structures.length) delete x.structures; });
      const rows = list.map((e, i) => {
        const def = this.structs.structures.get(Scene.short(e?.structure));
        const name = h("input", { type: "text", value: e?.structure ?? "", list: "bm-structures", placeholder: "estructura", spellcheck: false,
          onchange: () => edit((l) => { l[i].structure = name.value.trim(); }) });
        if (!def && this.structs.structures.size) name.classList.add("bad");
        const cell = h("input", { type: "number", min: 1, max: 512, step: 1, value: e?.cellSize ?? 8,
          title: "Tamaño de la celda en tiles: en cada celda sale como mucho una", onchange: () => edit((l) => { l[i].cellSize = Math.max(1, Math.round(Number(cell.value) || 8)); }) });
        const chance = h("input", { type: "number", min: 0, max: 1, step: 0.01, value: e?.chance ?? 0.5,
          title: "Probabilidad de que una celda tenga una (0..1)", onchange: () => edit((l) => { l[i].chance = Math.min(1, Math.max(0, Number(chance.value) || 0)); }) });
        const p = def?.root?.placement ?? {};
        const what = def ? [Scene.short(def.root.type), p.priority != null ? "prioridad " + p.priority : null,
          Array.isArray(p.on) && p.on.length ? "sobre " + p.on.join(", ") : null, p.maxSlope != null ? "pendiente ≤ " + p.maxSlope : null].filter(Boolean).join(" · ") : "no existe";
        return h("div", { class: "bm-srow" }, name, cell, chance,
          h("button", { class: "icon ghost", title: "Quitar", onclick: () => edit((l) => { l.splice(i, 1); }) }, "×"),
          h("div", { class: ["faint small bm-sinfo", !def && "bad-text"] }, what));
      });
      return section({ id: "bm-structs", title: "Estructuras", extra: String(list.length) },
        this.structList,
        list.length ? h("div", { class: "bm-srow bm-shead faint small" }, h("span", null, "Estructura"), h("span", null, "Celda"), h("span", null, "Prob."), h("span")) : null,
        ...rows,
        h("button", { onclick: () => edit((l) => { l.push({ structure: "", cellSize: 8, chance: 0.5 }); }) }, "+ Estructura"),
        h("p", { class: "note" }, "Cada celda de «Celda» × «Celda» tiles tira «Prob.» una vez y, si sale, pone la estructura en un punto de la celda. Si dos se pisan gana la de más prioridad. Míralo en la vista 3D."));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Repartir decoraciones

    #tagsOf = (id) => (this.#tileInfo(id)?.tile?.tags ?? []).map((t) => String(t).toLowerCase());

    /** The suggestions for this biome, each with a tick and its chance; ticked ones are added in one step. */
    #suggestions(r) {
      const list = B.suggestDecoration(r, this.#tiles, this.#tagsOf);
      if (!list.length) {
        return h("p", { class: "note" }, "Nada que añadir: lo que le toca a este bioma ya está, o no hay tiles con hábitat, tags de planta o roca (herb, flower, rock…) o categoría foliage.");
      }
      this.suggestPick ??= new Map(list.map((d) => [d.tile, { on: true, chance: d.chance }]));
      const rows = list.map((d) => {
        const pick = this.suggestPick.get(d.tile) ?? { on: true, chance: d.chance };
        this.suggestPick.set(d.tile, pick);
        const thumb = h("canvas", { class: "bm-thumb", width: 32, height: 32 });
        this.#paintThumb(thumb, d.info);
        const tick = h("input", { type: "checkbox", checked: pick.on, onchange: () => { pick.on = tick.checked; } });
        const chance = h("input", { type: "number", min: 0, max: 1, step: 0.0001, value: pick.chance, title: "Probabilidad por columna",
          onchange: () => { pick.chance = Math.max(0, Number(chance.value) || 0); } });
        return h("label", { class: "bm-sug" }, tick, thumb,
          h("span", { class: "grow" }, h("b", null, d.tile), " ",
            h("span", { class: ["badge", d.habitat !== "land" && "accent"] }, B.HABITAT_LABEL[d.habitat] + (d.guessed ? "?" : "")),
            h("div", { class: "faint small" }, d.reason + (d.guessed ? " · hábitat deducido del nombre: se escribe «on»" : ""))),
          chance);
      });
      return h("div", { class: "bm-sugs" }, ...rows,
        h("button", { class: "primary", onclick: () => this.#addSuggestions(list) }, "Añadir marcadas"));
    }

    #addSuggestions(list) {
      const picked = list.filter((d) => this.suggestPick?.get(d.tile)?.on).map((d) => this.#entryOf(d, this.suggestPick.get(d.tile).chance));
      if (!picked.length) return;
      this.suggestOpen = false;
      this.suggestPick = null;
      this.#edit(`Decoración sugerida (${picked.length})`, (x) => { (x.decoration ??= []).push(...picked); });
      this.studio.setStatus(`Añadidas ${picked.length} decoraciones. Revisa la muestra y guarda con Ctrl+S.`, "ok");
    }

    #entryOf(d, chance = d.chance) {
      const e = { tile: d.tile, chance };
      if (d.on) e.on = d.on;
      return e;
    }

    /** Every biome at once: a summary to confirm, then one undo step for all of them. */
    async #distributeAll() {
      const plan = this.docs.filter((doc) => doc.root)
        .map((doc) => ({ doc, add: B.suggestDecoration(doc.root, this.#tiles, this.#tagsOf) }))
        .filter((p) => p.add.length);
      if (!plan.length) { this.studio.toast("Cada bioma ya tiene lo que le toca.", { kind: "ok" }); return; }
      const total = plan.reduce((n, p) => n + p.add.length, 0);
      const lines = plan.map((p) => `${p.doc.root.name ?? p.doc.name}: ${p.add.map((d) => d.tile).join(", ")}`).join("\n");
      const ok = await this.studio.confirm({ title: "Repartir decoraciones",
        message: `Añadir ${total} decoraciones en ${plan.length} biomas (se puede deshacer y no se guarda hasta Ctrl+S):\n\n${lines}`,
        confirm: "Añadir" });
      if (!ok) return;
      const steps = plan.map((p) => ({ doc: p.doc, before: JSON.stringify(p.doc.root),
        after: JSON.stringify({ ...p.doc.root, decoration: [...(p.doc.root.decoration ?? []), ...p.add.map((d) => this.#entryOf(d))] }) }));
      this.history.run({ label: `Repartir decoraciones (${total})`,
        redo: () => { for (const st of steps) st.doc.root = JSON.parse(st.after); },
        undo: () => { for (const st of steps) st.doc.root = JSON.parse(st.before); } });
      this.studio.setStatus(`Repartidas ${total} decoraciones en ${plan.length} biomas. Guarda con Ctrl+S.`, "ok");
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
        ...this.#structureIssues(r),
      ].filter(Boolean);
      return section({ id: "bm-check", title: "Revisión", extra: issues.length ? String(issues.length) : "todo bien" },
        issues.length ? issues : h("p", { class: "note" }, "Todos los tiles existen y el bioma se puede cargar."));
    }

    #structureIssues(r) {
      const list = Array.isArray(r.structures) ? r.structures : [];
      const out = [];
      const seen = new Set();
      list.forEach((e, i) => {
        const id = Scene.short(e?.structure);
        if (!id) out.push(h("div", { class: "at-issue bad" }, `structures[${i}] no dice qué estructura.`));
        else if (!this.structs.structures.has(id)) out.push(h("div", { class: "at-issue bad" }, `La estructura «${id}» (structures[${i}]) no existe en Data/Worldgen/Structures.`));
        else if (seen.has(id)) out.push(h("div", { class: "at-issue bad" }, `«${id}» está dos veces: el juego da error.`));
        seen.add(id);
      });
      // Structure files from before the biome lists: the game reports these keys and stops loading.
      const old = [...this.structs.structures.values()].filter((d) => ["biomes", "cellSize", "chance"].some((k) => d.root?.placement?.[k] != null));
      if (old.length) out.push(h("div", { class: "at-issue warn" }, `Con biomes, cellSize o chance en su placement (el juego da error; van en el bioma): ${old.map((d) => d.id).join(", ")}.`));
      return out;
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
      const gl = this.view === "3d";
      this.canvas.style.display = gl ? "none" : "";
      this.glCanvas.style.display = gl ? "" : "none";
      if (gl) this.#draw3d();
      else if (this.view === "climate") this.#drawClimate(g, W, H);
      else this.#drawSample(g, W, H);
    });

    // -----------------------------------------------------------------------------------------------------------------
    // 3D

    #draw3d() {
      clear(this.legend);
      const say = (text, cls = "faint") => this.legend.append(h("span", { class: cls }, text));
      const r = this.current?.root;
      if (!r || B.kindOf(r) === "ocean") { say(r ? "El mar abierto no tiene suelo que mostrar." : ""); this.voxel?.setScene?.(new EmptyScene(), () => [0, 0, 0, 1], false); return; }
      if (!this.voxel) {
        this.voxel = new Aura.voxelView.VoxelView(this.glCanvas);
        new ResizeObserver(() => this.voxel.render()).observe(this.glCanvas);
      }
      if (!this.voxel.ok) { say("Este navegador no tiene WebGL2: la vista 3D no puede dibujarse.", "bad-text"); return; }

      // Every tile the patch can hold, so their sheets are decoded before the colours are read.
      const v = this.view3d;
      const ids = new Set(["water", r.materials?.surface, r.materials?.shallow ?? "dirt", r.materials?.deep ?? "stone",
        ...(r.materials?.surfaceVariants ?? []).map((x) => x.tile), ...(r.decoration ?? []).map((d) => d.tile)].filter(Boolean).map(Scene.short));
      if (v.structures)
        for (const e of Array.isArray(r.structures) ? r.structures : [])
          for (const id of Scene.structureTiles(this.structs.structures.get(Scene.short(e?.structure)), this.structs.templates)) ids.add(id);
      const infos = [...ids].map((id) => this.#tileInfo(id)).filter(Boolean);
      const pending = [...new Set(infos.map((i) => i.sheet))].filter((k) => !this.#sheets.has(k) || this.#sheets.get(k).value === undefined);
      if (pending.length) {
        say("Cargando hojas…");
        Promise.all(pending.map((k) => this.#sheetCanvas(k))).then(() => this.#draw());
        return;
      }

      const key = JSON.stringify([r, v.size, v.seed, v.relief, v.water, v.density, v.structures]);
      const reframe = this.scene3dDoc !== this.current || this.scene3dSize !== v.size;
      if (key !== this.scene3dKey) {
        const t0 = performance.now();
        const info = (id) => {
          const t = this.#tileInfo(id);
          if (!t) return null;
          const tags = (t.tile.tags ?? []).map((x) => String(x).toLowerCase());
          const category = String(t.doc?.root?.category ?? "").toLowerCase();
          const leafy = tags.includes("leaf") || /leaves|leaf/.test(id);
          return {
            liquid: tags.includes("liquid") || String(t.tile.type ?? "").toLowerCase() === "liquid",
            plant: category === "foliage" || tags.includes("no_collision") || tags.includes("tiny"),
            slab: tags.includes("slab"),
            glass: !leafy && (tags.includes("transparent") || /glass/.test(id)),
            habitat: t.habitat,
          };
        };
        const built = Scene.buildScene(r, this.structs.structures, this.structs.templates, info, v);
        const foliage = Tint.hexToRgb(r.colors?.foliage) ?? Tint.hexToRgb(Tint.DEFAULT_TINT.hex);
        this.voxel.setScene(built.scene, (p) => this.#tileColor(p, foliage), reframe);
        this.scene3dKey = key;
        this.scene3dDoc = this.current;
        this.scene3dSize = v.size;
        this.scene3dStats = { ...built, ms: performance.now() - t0 };
      } else {
        this.voxel.render();
      }

      const st = this.scene3dStats;
      const placed = [...st.counts.entries()].map(([id, n]) => `${id} ${n}`).join(" · ");
      say(`${v.size}×${v.size} · ${Math.round(st.ms)} ms` + (v.structures ? ` · ${placed || "ninguna estructura"}` : " · estructuras ocultas"));
      if (st.missing.size) say(` · no existen o no son de un tipo que el Studio sepa dibujar: ${[...st.missing].join(", ")}`, "bad-text");
      say(" · los colores son el promedio del sprite de cada tile");
    }

    // A tile's colour: its sprite's average over the opaque pixels — of the top half for blocks, where the lit top is —
    // in the biome's foliage colour when it is biome_tinted.
    #tileColor(p, foliage) {
      const K = Scene.KIND;
      const key = p.id + "|" + p.kind + "|" + foliage.join(",");
      this.colorCache ??= new Map();
      if (this.colorCache.has(key)) return this.colorCache.get(key);
      const info = this.#tileInfo(p.id);
      let rgba = p.kind === K.water ? [0.2, 0.45, 0.77, 0.6] : [0.8, 0.3, 0.8, 1];
      const coord = info?.coord ?? info?.parts?.[0]?.coord;
      const img = coord && this.#sprite(info, coord, info.tinted ? foliage : null);
      if (img) {
        const d = img.getContext("2d").getImageData(0, 0, img.width, img.height).data;
        const rows = p.kind === K.plant ? img.height : Math.ceil(img.height / 2);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) * 4;
            if (d[i + 3] < 128) continue;
            r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
          }
        if (n) rgba = [r / n / 255, g / n / 255, b / n / 255, p.kind === K.water ? 0.6 : p.kind === K.glass ? 0.45 : 1];
      }
      this.colorCache.set(key, rgba);
      return rgba;
    }

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
    /**
     * A patch of the biome as the game would build it: gentle hills of its surface over its intermediate material,
     * variants, a pond in the lowest ground (when asked) with the water plants where they grow — on the bottom, along
     * the shore, on the surface — and the land decoration rolled per column the way the generator does it (chances
     * summed in order, one roll), biome_tinted tiles in the biome's foliage colour.
     */
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
      const shallow = this.#tileInfo(r.materials?.shallow ?? "dirt") ?? surface;
      const waterTile = this.#tileInfo("water");
      const decoInfos = (r.decoration ?? []).map((d) => this.#tileInfo(d.tile));
      const need = new Set([surface, shallow, waterTile, ...(r.materials?.surfaceVariants ?? []).map((v) => this.#tileInfo(v.tile)), ...decoInfos].filter(Boolean).map((i) => i.sheet));
      const pending = [...need].filter((k) => !this.#sheets.has(k) || this.#sheets.get(k).value === undefined);
      if (pending.length) {
        for (const k of pending) this.#sheetCanvas(k).then(() => this.#draw());
        g.fillStyle = "#98a0aa"; g.fillText("Cargando hojas…", 20, 30);
        return;
      }
      const missingSheets = [...need].filter((k) => !this.#sheets.get(k)?.value);
      if (missingSheets.length) {
        g.fillStyle = "#f0b45a"; g.font = "13px system-ui";
        g.fillText(`No encuentro el PNG de la hoja ${missingSheets.map((k) => "«" + k + "»").join(", ")} (atlases.json).`, 20, 30);
        g.fillText("Abre la carpeta Content (o la del proyecto) para que las rutas de atlases.json se encuentren.", 20, 50);
        return;
      }

      const N = this.sample.size, seed = this.sample.seed, dens = this.sample.density;
      const S = surface.tw, E = Aura.blockEngine, BH = E.BLOCK_HEIGHT;
      const o = E.project([0, 0, 0], S, BH), px = E.project([1, 0, 0], S, BH), py = E.project([0, 1, 0], S, BH), pz = E.project([0, 0, BH], S, BH);
      const at = (i, j, l) => [i * (px[0] - o[0]) + j * (py[0] - o[0]) + l * (pz[0] - o[0]), i * (px[1] - o[1]) + j * (py[1] - o[1]) + l * (pz[1] - o[1])];
      const foliage = Tint.hexToRgb(r.colors?.foliage) ?? Tint.hexToRgb(Tint.DEFAULT_TINT.hex);

      // Smooth value noise over the grid for the hills; the pond takes the lowest part.
      const noise = (x, y, sd) => {
        const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        const v = (a, b) => hash(a, b, sd);
        return (v(x0, y0) * (1 - sx) + v(x0 + 1, y0) * sx) * (1 - sy) + (v(x0, y0 + 1) * (1 - sx) + v(x0 + 1, y0 + 1) * sx) * sy;
      };
      const field = [];
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) field.push(noise(i / 5, j / 5, seed * 13 + 3) * 0.7 + noise(i / 2.2, j / 2.2, seed * 17 + 9) * 0.3);
      const sorted = [...field].sort((a, b) => a - b);
      const waterCut = this.sample.water ? sorted[Math.floor(sorted.length * 0.16)] : -1;
      const lo = sorted[0], hi = sorted[sorted.length - 1];
      const heightAt = (i, j) => {
        const f = field[i * N + j];
        if (f <= waterCut) return -1;                       // pond floor, one under the water
        return this.sample.relief ? Math.round(((f - lo) / Math.max(1e-6, hi - lo)) * 2.4) : 0;
      };
      const isWater = (i, j) => i >= 0 && j >= 0 && i < N && j < N && field[i * N + j] <= waterCut;

      // Which kind of column a decoration entry may land on: the game's "on", or the tile's habitat for Auto.
      const placeOf = (d, info) => {
        if (d.on) return { surface: "land", seafloor: "bottom", shallows: "shore", watersurface: "top" }[d.on] ?? "land";
        const hab = info ? B.habitatOf(info.tile, d.tile).habitat : "land";
        return { land: "land", submerged: "bottom", emergent: "shore", floating: "top" }[hab];
      };

      const pieces = [];      // { info, coord, i, j, l, sub, tint }
      const put = (info, i, j, l, sub, shift) => {
        if (!info) return;
        const parts = info.parts.length ? info.parts : [{ x: 0, y: 0, z: 0, coord: info.coord }];
        for (const p of parts) if (p.coord) pieces.push({ info, coord: p.coord, i: i + p.x, j: j + p.z, l: l + p.y, sub, shift });
      };
      const counts = new Map();
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const h0 = heightAt(i, j), water = isWater(i, j);
          const shift = (hash(i, j, 99) * 2 - 1) * 10;
          // Ground: the visible blocks of the column (the front rows show their sides down to the lowest level).
          let top = surface;
          let roll = hash(i, j, seed * 3 + 1), acc = 0;
          for (const v of r.materials?.surfaceVariants ?? []) {
            acc += Number(v.chance) || 0;
            if (roll < acc) { top = this.#tileInfo(v.tile) ?? top; break; }
          }
          for (let l = -1; l <= h0; l++) put(l === h0 && !water ? top : shallow, i, j, l, 0, shift);
          const shore = !water && h0 === 0 && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => isWater(i + a, j + b));
          // Decoration: one roll over the summed chances, as the generator does; an entry that cannot grow here is a miss.
          roll = hash(i, j, seed * 7 + 5); acc = 0;
          for (let k = 0; k < (r.decoration ?? []).length; k++) {
            const d = r.decoration[k], info = decoInfos[k];
            acc += (Number(d.chance) || 0) * dens;
            if (roll >= acc) continue;
            const where = placeOf(d, info);
            const ok = water ? where === "bottom" || where === "top" : where === "land" || (where === "shore" && shore);
            if (ok && info) {
              if (where === "bottom") put(info, i, j, 0, 1, shift);            // under the water, on the floor
              else if (where === "top") put(info, i, j, 1, 3, shift);          // on the water: the cell above it
              else put(info, i, j, h0 + 1, 1, shift);
              counts.set(d.tile, (counts.get(d.tile) ?? 0) + 1);
            }
            break;
          }
          if (water) pieces.push({ water: true, i, j, l: 0, sub: 2 });
        }
      }
      // Painter's order: +i comes toward the camera and +j goes away from it, so nearer is larger i − j; then upward.
      pieces.sort((a, b) => a.i - a.j - (b.i - b.j) || a.l - b.l || a.sub - b.sub);
      const pos = pieces.map((p) => at(p.i, p.j, p.l));
      const minX = Math.min(...pos.map((p) => p[0])), minY = Math.min(...pos.map((p) => p[1]));
      const maxX = Math.max(...pos.map((p) => p[0])) + S, maxY = Math.max(...pos.map((p) => p[1])) + S;
      const scene = new OffscreenCanvas(Math.ceil(maxX - minX), Math.ceil(maxY - minY));
      const sg = scene.getContext("2d");
      const waterSprite = this.#waterSprite(waterTile, S);
      pieces.forEach((p, k) => {
        const x = Math.round(pos[k][0] - minX), y = Math.round(pos[k][1] - minY);
        if (p.water) { sg.drawImage(waterSprite, x, y); return; }
        const img = this.#sprite(p.info, p.coord, p.info.tinted ? shiftRgb(foliage, p.shift) : null);
        if (img) sg.drawImage(img, x, y);
      });

      // Sky-ish backdrop from the biome's atmosphere, so a desert reads warm and a taiga cold.
      const atm = Tint.hexToRgb(r.colors?.atmosphere);
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, atm ? `rgb(${atm.map((c) => Math.round(c * 0.35 + 40)).join(",")})` : "#3d4a55");
      grad.addColorStop(1, "#1c2127");
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      const zRaw = Math.min((W - 40) / scene.width, (H - 50) / scene.height);
      const z = zRaw >= 1 ? Math.floor(zRaw * 2) / 2 : zRaw;
      g.imageSmoothingEnabled = zRaw < 1;
      g.drawImage(scene, Math.round((W - scene.width * z) / 2), Math.round((H - 26 - scene.height * z) / 2), scene.width * z, scene.height * z);
      const problems = [...need].map((k) => this.#sheets.get(k)?.reason).filter(Boolean);
      if (problems.length) {
        g.fillStyle = "#f0b45a"; g.font = "13px system-ui";
        problems.slice(0, 6).forEach((t, i) => g.fillText(t, 16, 24 + i * 18));
      }
      // Grey art without biome_tinted: the game draws it grey too, which is almost always a missing tag.
      const grey = [surface, ...decoInfos].filter((info, k, all) => info && !info.tinted && all.indexOf(info) === k && this.#looksGrey(info)).map((i) => i.tile.id ?? i.tile.name);
      this.legend.append(h("span", { class: "faint" },
        `${N}×${N} columnas · densidad ×${dens} · ${[...counts.values()].reduce((a, b) => a + b, 0)} decoraciones` + (waterTile ? "" : this.sample.water ? " · agua dibujada (no hay tile «water»)" : "")));
      if (grey.length) this.legend.append(h("span", { class: "bad-text", title: "Se ven grises porque su arte es gris y no tienen el tag biome_tinted: el juego tampoco los tiñe." },
        ` · grises sin biome_tinted: ${grey.slice(0, 6).join(", ")}${grey.length > 6 ? "…" : ""}`));
    }

    /** The water block: the project's "water" tile when it has one, else a see-through blue cube top. */
    #waterSprite(info, S) {
      const key = "__water|" + S + "|" + (info ? info.sheet + info.coord : "");
      let c = this.#spriteCache.get(key);
      if (c) return c;
      if (info?.coord) {
        const src = this.#sprite(info, info.coord, null);
        c = new OffscreenCanvas(S, S);
        const cg = c.getContext("2d");
        cg.globalAlpha = 0.75;
        if (src) cg.drawImage(src, 0, 0);
      } else {
        c = new OffscreenCanvas(S, S);
        const cg = c.getContext("2d");
        // The top diamond, a little under the block's top: the water's surface.
        const d = S / 16;
        cg.fillStyle = "rgba(52, 118, 196, 0.62)";
        cg.beginPath(); cg.moveTo(S / 2, d); cg.lineTo(S, S / 4 + d); cg.lineTo(S / 2, S / 2 + d); cg.lineTo(0, S / 4 + d); cg.closePath(); cg.fill();
        cg.strokeStyle = "rgba(170, 215, 255, 0.35)";
        cg.beginPath(); cg.moveTo(0, S / 4 + d); cg.lineTo(S / 2, d); cg.lineTo(S, S / 4 + d); cg.stroke();
      }
      this.#spriteCache.set(key, c);
      return c;
    }

    /** Most of the opaque pixels without colour: art made for biome_tinted. */
    #looksGrey(info) {
      const coord = info.coord ?? info.parts[0]?.coord;
      const img = coord && this.#sprite(info, coord, null);
      if (!img) return false;
      const a = Tint.analyze(img.getContext("2d").getImageData(0, 0, img.width, img.height).data);
      return a.total > 20 && a.full / a.total > 0.85;
    }

    // The sheet of a tile as a canvas, decoded once.
    #sheetCanvas(key) {
      if (this.#sheets.has(key)) return this.#sheets.get(key).promise;
      const slot = { value: undefined };
      slot.promise = (async () => {
        // By its atlases.json id; failing that, a png named like the sheet ("dirt" → Dirt.png), so a sheet missing from
        // atlases.json still shows (the game would not draw it, which the message says).
        const atlas = this.project?.atlases.find((a) => T.sheetKey(a.id) === key);
        let png = atlas?.png ?? null;
        if (!png) {
          png = this.project?.filter((e) => e.lower.endsWith(".png") && e.name.toLowerCase() === key + ".png")[0] ?? null;
          slot.reason = !atlas ? `«${key}» no está en atlases.json` + (png ? " (uso " + png.path + ")" : "")
            : `no encuentro el PNG de «${key}» (${atlas.texture})`;
        }
        if (!png) return (slot.value = null);
        const img = await decodePng(await png.handle.getFile());
        const c = new OffscreenCanvas(img.w, img.h);
        c.getContext("2d").putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
        return (slot.value = { canvas: c, img });
      })().catch((err) => { slot.reason = `no pude leer la hoja «${key}»: ${err.message}`; return (slot.value = null); });
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

  // What the 3D view shows for the open sea: nothing.
  class EmptyScene {
    size = 1; height = 1; cells = new Uint16Array(1); palette = [{ id: "air", kind: 0 }];
    at() { return 0; }
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
