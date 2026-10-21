"use strict";

// Recetas: every crafting recipe of Aura as the game shows it — the station's own slots with the item icons in them,
// the arrow with its time, the result — edited by dragging items from the browser on the left into slots, between
// slots (swap), the wheel for quantities, right click to empty. The list under it is the station's file in order, with
// its // section comments; the panel checks every item against the item files (an unknown one stops the game) and
// shows the recipe's JSON. Ctrl+S writes Data/Crafting/*.json, comments and number style kept.
(function (Aura) {
  const { h, clear } = Aura.dom;
  const { History } = Aura.history;
  const { prefs } = Aura.storage;
  const { writeHandle, joinPath, dirName, baseName } = Aura.fs;
  const { section, select, segmented, checkbox, help } = Aura.controls;
  const { decodePng } = Aura.png;
  const M = Aura.recipeModel;
  const T = Aura.atlasTiles;

  const ITEM_MIME = "text/x-aura-item";
  const CELL_MIME = "text/x-aura-cell";
  const CARD_MIME = "text/x-aura-recipe";

  function recipesTool() {
    return new RecipesTool();
  }

  class RecipesTool {
    id = "recipes";
    title = "Recetas";
    project = null;
    docs = [];
    index = { items: [], byKey: new Map(), tiles: new Map() };
    stationId = prefs.get("recipes:station", "hand");
    sel = 0;                 // index of the selected recipe in the station's file
    groupBy = prefs.get("recipes:groupBy", "group");
    query = "";
    listQuery = "";
    pickedItem = null;       // item record whose «Usos» show under the browser
    cauldronSlots = 2;
    history = new History({ limit: 300 });
    #sheets = new Map();
    #sprites = new Map();

    mount(host, studio) {
      this.studio = studio;
      host.appendChild(this.#buildLayout());
      this.history.on("change", () => this.#changed());
      const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
      this.studio.commands.registerAll([
        { id: "recipes.save", title: "Guardar recetas", group: "Recetas", keys: ["Ctrl+S"], whileTyping: true, enabled: () => this.isDirty(), run: () => this.save() },
        { id: "recipes.undo", title: "Deshacer", group: "Recetas", keys: ["Ctrl+Z"], enabled: () => this.history.canUndo && !typing(), run: () => this.history.undo() },
        { id: "recipes.redo", title: "Rehacer", group: "Recetas", keys: ["Ctrl+Y", "Ctrl+Shift+Z"], enabled: () => this.history.canRedo && !typing(), run: () => this.history.redo() },
        { id: "recipes.new", title: "Receta nueva", group: "Recetas", keys: ["Ctrl+N"], enabled: () => !!this.project, run: () => this.#addRecipe() },
        { id: "recipes.dup", title: "Duplicar receta", group: "Recetas", keys: ["Ctrl+D"], enabled: () => !!this.#current(), run: () => this.#duplicate() },
        { id: "recipes.del", title: "Borrar receta", group: "Recetas", keys: ["Delete"], enabled: () => !!this.#current() && !typing(), run: () => this.#remove() },
      ], this.id);
      this.#renderAll();
    }

    activate() {}
    deactivate() {}
    isDirty() { return this.docs.some(M.isDirty); }
    dirtyLabel() { return "Recetas"; }

    async onProject(project) {
      this.project = project;
      if (this.isDirty()) {
        this.studio.toast("Carpeta releída. Hay recetas sin guardar: las mantengo.", { kind: "warn" });
        return;
      }
      await this.studio.busy(this.#load());
    }

    async #load() {
      const [docs, itemDocs] = await Promise.all([M.loadFiles(this.project), T.loadDocs(this.project)]);
      this.docs = docs;
      this.index = M.indexItems(itemDocs);
      // The cauldron's slots come from its tile ("stationSlots"); the biggest cauldron is what a recipe can count on.
      const cauldrons = itemDocs.filter((d) => d.root && !T.isItemDoc(d)).flatMap((d) => d.root.tiles)
        .filter((t) => t?.stationType === "cauldron" && t.stationSlots > 0).map((t) => t.stationSlots);
      this.cauldronSlots = Math.max(2, ...cauldrons);
      this.#sheets.clear();
      this.#sprites.clear();
      this.history.clear();
      this.sel = 0;
      this.#renderAll();
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Stations and files

    #stations() {
      const known = M.STATIONS.map((s) => (s.id === "cauldron" ? { ...s, slots: this.cauldronSlots } : s));
      const extra = this.docs.filter((d) => !M.STATIONS.some((s) => s.file === d.name.toLowerCase())).map((d) => M.stationOf(d));
      return [...known, ...extra];
    }

    #station() {
      const all = this.#stations();
      return all.find((s) => s.id === this.stationId) ?? all[0];
    }

    /** The station's file; one that does not exist yet is a new, empty document written on the first save with recipes. */
    #docOf(station) {
      let doc = this.docs.find((d) => d.name.toLowerCase() === station.file);
      if (!doc && this.project) {
        const dir = M.craftingDir(this.project, this.docs);
        doc = { entry: null, path: dir ? joinPath(dir, station.file) : station.file, name: station.file, entries: [], tail: [],
          floatKeys: new Set(["craftTime"]), eol: "\n", baseline: "", error: null, isNew: true };
        this.docs.push(doc);
      }
      return doc ?? null;
    }

    #alsoRead(station) {
      return (station.extra ?? []).map((f) => this.docs.find((d) => d.name.toLowerCase() === f)).filter(Boolean);
    }

    #current() {
      const doc = this.#docOf(this.#station());
      return doc?.entries[this.sel] ?? null;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Editing: one step swaps the file's whole entry list, so undo is exact (recipe files are small).

    #snap(doc) {
      return JSON.stringify(doc.entries.map((e) => ({ comments: e.comments, gap: e.gap, value: e.value, floatKeys: e.floatKeys ? [...e.floatKeys] : null })));
    }
    #restore(doc, text) {
      doc.entries = JSON.parse(text).map((e) => ({ ...e, floatKeys: e.floatKeys ? new Set(e.floatKeys) : null }));
    }

    #edit(label, fn, { doc = this.#docOf(this.#station()), select = null } = {}) {
      if (!doc) return;
      const before = this.#snap(doc), selBefore = this.sel;
      const work = JSON.parse(before).map((e) => ({ ...e, floatKeys: e.floatKeys ? new Set(e.floatKeys) : null }));
      const r = fn(work);
      const next = JSON.stringify(work.map((e) => ({ comments: e.comments, gap: e.gap, value: e.value, floatKeys: e.floatKeys ? [...e.floatKeys] : null })));
      if (next === before) return;
      const selAfter = select ?? (typeof r === "number" ? r : this.sel);
      this.history.run({ label,
        redo: () => { this.#restore(doc, next); this.sel = selAfter; },
        undo: () => { this.#restore(doc, before); this.sel = selBefore; } });
    }

    /** Edits the selected recipe's value in place. */
    #editRecipe(label, fn) {
      this.#edit(label, (list) => { const e = list[this.sel]; if (e) fn(e.value, e); });
    }

    #addRecipe(seed = null) {
      const station = this.#station();
      const value = seed ?? (station.kind === "fuels" ? { item: "", burnTime: 10, tempBoost: 100 }
        : station.kind === "furnace" ? (station.inputs > 1
          ? { id: "new_recipe", input: "", inputQty: 1, input2: "", input2Qty: 1, output: "", outputQty: 1, craftTime: 10, minTemp: 500 }
          : { id: "new_recipe", input: "", output: "", craftTime: 8, minTemp: 400 })
        : { id: "new_recipe", mode: "Give", craftTime: 2, ingredients: [], output: { item: "", qty: 1 } });
      if (value.id) value.id = this.#freeId(value.id);
      this.#edit("Receta nueva", (list) => {
        const at = Math.min(list.length, this.sel + 1);
        list.splice(at, 0, { comments: [], gap: false, value, floatKeys: null });
        return at;
      });
    }

    #freeId(base) {
      const taken = new Set(this.docs.flatMap((d) => d.entries.map((e) => e.value?.id)).filter(Boolean));
      if (!taken.has(base)) return base;
      for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
    }

    #duplicate() {
      const e = this.#current();
      if (!e) return;
      const value = structuredClone(e.value);
      if (value.id) value.id = this.#freeId(value.id);
      this.#addRecipe(value);
    }

    #remove() {
      const e = this.#current();
      if (!e) return;
      this.#edit("Borrar receta", (list) => {
        const [gone] = list.splice(this.sel, 1);
        // Its section comment stays with the recipe that now starts the section.
        if (gone?.comments?.length && list[this.sel]) list[this.sel].comments = [...gone.comments, ...(list[this.sel].comments ?? [])];
        return Math.max(0, Math.min(this.sel, list.length - 1));
      });
    }

    #move(from, to) {
      this.#edit("Mover receta", (list) => {
        if (to < 0 || to >= list.length || from === to) return from;
        const [e] = list.splice(from, 1);
        list.splice(to, 0, e);
        return to;
      });
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Layout

    #buildLayout() {
      this.search = h("input", { type: "search", placeholder: "Buscar items…", oninput: () => { this.query = this.search.value.trim().toLowerCase(); this.#renderItems(); } });
      this.groupSeg = segmented({ value: this.groupBy, options: [["group", "Por tipo"], ["file", "Por archivo"]],
        onChange: (v) => { this.groupBy = v; prefs.set("recipes:groupBy", v); this.#renderItems(); } });
      this.itemsEl = h("div", { class: "rc-items scroll" });
      this.usesEl = h("div", { class: "rc-uses scroll" });
      const left = h("div", { class: "rc-left" },
        h("div", { class: "rc-head" }, h("strong", null, "Items"), h("span", { class: "grow" }), this.groupSeg.el),
        h("div", { class: "rc-search" }, this.search),
        this.itemsEl, this.usesEl);

      this.tabsEl = h("div", { class: "rc-tabs" });
      this.undoBtn = h("button", { class: "icon", title: "Deshacer (Ctrl+Z)", onclick: () => this.history.undo() }, "↶");
      this.redoBtn = h("button", { class: "icon", title: "Rehacer (Ctrl+Y)", onclick: () => this.history.redo() }, "↷");
      this.saveBtn = h("button", { class: "primary", title: "Escribir los archivos de Data/Crafting cambiados (Ctrl+S)", onclick: () => this.save() }, "Guardar");
      this.editorEl = h("div", { class: "rc-editor" });
      this.listEl = h("div", { class: "rc-list" });
      const stage = h("div", { class: "rc-stage" },
        h("div", { class: "rc-toolbar" }, this.tabsEl, h("span", { class: "grow" }), this.undoBtn, this.redoBtn, this.saveBtn),
        h("div", { class: "rc-scroll scroll" }, this.editorEl, this.listEl));
      this.panel = h("div", { class: "rc-panel scroll" });
      return h("div", { class: "rc" }, left, stage, this.panel);
    }

    #renderAll() {
      this.#renderItems();
      this.#renderTabs();
      this.#renderEditor();
      this.#renderList();
      this.#renderPanel();
      this.#renderToolbar();
    }

    #changed() {
      const doc = this.#docOf(this.#station());
      if (doc) this.sel = Math.max(0, Math.min(this.sel, doc.entries.length - 1));
      this.#renderTabs();
      this.#renderEditor();
      this.#renderList();
      this.#renderPanel();
      this.#renderToolbar();
      this.#renderUses();
      this.studio.refreshDirty();
    }

    #renderToolbar() {
      this.undoBtn.disabled = !this.history.canUndo;
      this.redoBtn.disabled = !this.history.canRedo;
      this.saveBtn.disabled = !this.isDirty();
    }

    #renderTabs() {
      clear(this.tabsEl);
      for (const s of this.#stations()) {
        const doc = this.docs.find((d) => d.name.toLowerCase() === s.file);
        const n = doc?.entries.length ?? 0;
        this.tabsEl.append(h("button", { class: ["rc-tab", s.id === this.#station().id && "on"], title: s.note,
          onclick: () => this.#openStation(s.id) },
          s.label, h("span", { class: "faint" }, " " + n), doc && M.isDirty(doc) ? h("span", { class: "dot", title: "Sin guardar" }) : null));
      }
    }

    #openStation(id, sel = 0) {
      this.stationId = id;
      prefs.set("recipes:station", id);
      this.sel = sel;
      this.#renderTabs();
      this.#renderEditor();
      this.#renderList();
      this.#renderPanel();
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Item browser

    #renderItems() {
      clear(this.itemsEl);
      if (!this.project) { this.itemsEl.append(h("div", { class: "empty-state" }, "Abre la carpeta del proyecto para ver sus items y recetas.")); return; }
      const q = this.query;
      const items = this.index.items.filter((r) => !q || r.id.toLowerCase().includes(q) || String(r.name).toLowerCase().includes(q));
      if (!items.length) { this.itemsEl.append(h("div", { class: "empty-state" }, q ? "Ningún item coincide." : "No hay items en Data/Items.")); return; }
      const groups = new Map();
      for (const r of items) {
        const k = this.groupBy === "file" ? r.file : r.group;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      for (const [k, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
        this.itemsEl.append(h("div", { class: "pl-cat" }, `${k} · ${list.length}`));
        this.itemsEl.append(h("div", { class: "rc-grid" }, list.map((r) => this.#itemButton(r))));
      }
    }

    #itemButton(rec) {
      const c = h("canvas", { width: 32, height: 32 });
      this.#paintIcon(c, rec);
      // A div, not a button: Firefox never starts a drag from a <button>.
      return h("div", { class: ["rc-item", this.pickedItem === rec && "on"], draggable: true, role: "button", tabindex: 0, title: `${rec.name}  (${rec.id})\nArrástralo a una casilla · doble clic: a la primera casilla libre`,
        ondragstart: (e) => { e.dataTransfer.setData(ITEM_MIME, rec.id); e.dataTransfer.effectAllowed = "copy"; },
        onclick: () => { this.pickedItem = rec; this.#renderItems(); this.#renderUses(); },
        ondblclick: () => this.#dropAnywhere(rec.id) }, c);
    }

    /** «Usos»: what makes the picked item, what uses it, whether it burns — each a link to that recipe. */
    #renderUses() {
      clear(this.usesEl);
      const rec = this.pickedItem;
      if (!rec) { this.usesEl.append(h("p", { class: "note" }, "Clic en un item: aquí ves con qué se fabrica y para qué sirve.")); return; }
      const { made, used, burns } = M.usesOf(this.docs, this.index, rec);
      const link = (u) => h("button", { class: "rc-link", onclick: () => this.#openStation(u.station.id, u.doc.entries.indexOf(u.entry)) },
        h("span", { class: "faint" }, u.station.label + " · "), u.entry.value.id ?? u.entry.value.item);
      const c = h("canvas", { width: 32, height: 32 });
      this.#paintIcon(c, rec);
      this.usesEl.append(h("div", { class: "rc-uses-head" }, c, h("div", null, h("b", null, rec.name), h("div", { class: "faint mono" }, rec.id))),
        h("div", { class: "at-sub" }, `Se fabrica en (${made.length})`), ...(made.length ? made.map(link) : [h("p", { class: "note" }, "Ninguna receta: se consigue de otra forma (o no se puede).")]),
        h("div", { class: "at-sub" }, `Se usa en (${used.length})`), ...(used.length ? used.map(link) : [h("p", { class: "note" }, "—")]),
        ...(burns.length ? [h("div", { class: "at-sub" }, "Combustible"), ...burns.map(link)] : []));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // The recipe as the station shows it

    #renderEditor() {
      clear(this.editorEl);
      const station = this.#station(), doc = this.#docOf(station);
      if (!this.project || !doc) { this.editorEl.append(h("div", { class: "empty-state" }, "Abre la carpeta del proyecto.")); return; }
      if (doc.error) { this.editorEl.append(h("div", { class: "empty-state" }, `${doc.name} no se puede leer: ${doc.error}`)); return; }
      const e = doc.entries[this.sel];
      if (station.kind === "fuels") { this.editorEl.append(this.#fuelsEditor(doc)); return; }
      if (!e) {
        this.editorEl.append(h("div", { class: "empty-state" }, `${station.label}: sin recetas todavía.`,
          h("div", null, h("button", { class: "primary", onclick: () => this.#addRecipe() }, "+ Primera receta"))));
        return;
      }
      this.editorEl.append(station.kind === "furnace" ? this.#furnaceEditor(e.value, station) : this.#craftingEditor(e.value, station));
    }

    /** One slot: icon, quantity badge, its number; a drop target for items and for other slots. */
    #slot({ key, label, itemKey, qty, onDrop, onSwap, onQty, onClear, marks = [], disabled = false, big = false, title = "" }) {
      const rec = M.resolveItem(this.index, itemKey);
      const c = h("canvas", { width: big ? 48 : 40, height: big ? 48 : 40 });
      if (rec) this.#paintIcon(c, rec);
      const unknown = itemKey && !rec;
      const badge = itemKey && qty != null ? h("span", { class: "rc-qty", title: "Clic para escribir · rueda: ±1",
        onclick: (ev) => { ev.stopPropagation(); this.#askQty(qty, onQty); } }, "×" + qty) : null;
      const el = h("div", { class: ["rc-slot", big && "big", itemKey && "full", unknown && "bad", disabled && "off"], draggable: !!itemKey && !!onSwap,
        title: disabled ? title : (itemKey ? `${rec?.name ?? itemKey} (${itemKey})\n${title}Arrastra a otra casilla para intercambiar · rueda: cantidad · clic derecho: vaciar` : `${title}Suelta aquí un item`),
        ondragstart: (ev) => { ev.dataTransfer.setData(CELL_MIME, String(key)); ev.dataTransfer.effectAllowed = "move"; },
        ondragover: (ev) => { if (disabled) return; if ([...ev.dataTransfer.types].some((t) => t === ITEM_MIME || (onSwap && t === CELL_MIME))) { ev.preventDefault(); el.classList.add("hot"); } },
        ondragleave: () => el.classList.remove("hot"),
        ondrop: (ev) => {
          el.classList.remove("hot");
          if (disabled) return;
          ev.preventDefault();
          const item = ev.dataTransfer.getData(ITEM_MIME), cell = ev.dataTransfer.getData(CELL_MIME);
          if (item) onDrop?.(item);
          else if (cell !== "" && onSwap) onSwap(cell);
        },
        onwheel: (ev) => { if (!itemKey || qty == null || !onQty) return; ev.preventDefault(); onQty(Math.max(1, qty + (ev.deltaY < 0 ? 1 : -1))); },
        oncontextmenu: (ev) => { ev.preventDefault(); if (itemKey) onClear?.(); },
      }, h("span", { class: "rc-num" }, label), c, unknown ? h("span", { class: "rc-unknown" }, itemKey) : null, badge, ...marks);
      return el;
    }

    async #askQty(qty, onQty) {
      if (!onQty) return;
      const v = await this.studio.prompt({ title: "Cantidad", message: "Cuántos.", value: String(qty),
        validate: (s) => (Number.isInteger(Number(s)) && Number(s) >= 1 ? "" : "Un número entero desde 1.") });
      if (v) onQty(Number(v));
    }

    // CraftingSystem stations: ingredients with or without a fixed slot, the result, mode, time and failure.
    #craftingEditor(r, station) {
      const N = station.slots;
      const ings = r.ingredients ?? [];
      const fixed = ings.some((g) => Number.isInteger(g.slot));
      // Which ingredient shows in each cell: fixed slots where they say, the rest filling the free cells in order.
      const cells = Array(N).fill(null), overflow = [];
      if (fixed) ings.forEach((g, i) => { if (Number.isInteger(g.slot) && g.slot < N && cells[g.slot] === null) cells[g.slot] = i; });
      ings.forEach((g, i) => {
        if (cells.includes(i)) return;
        if (fixed && Number.isInteger(g.slot)) { overflow.push(i); return; }
        const free = cells.indexOf(null);
        if (free < 0) overflow.push(i); else cells[free] = i;
      });
      const isTarget = (cell) => r.mode && r.mode !== "Give" && (r.output?.targetSlot ?? 0) === cell;
      const returns = new Set(r.returnOnFail ?? []);

      const setAt = (cell, item) => this.#editRecipe("Ingrediente", (v) => {
        v.ingredients ??= [];
        const i = cells[cell];
        if (i !== null && i !== undefined) v.ingredients[i].item = item;
        else v.ingredients.push(fixed ? { item, qty: 1, slot: cell } : { item, qty: 1 });
      });
      const swap = (a, b) => this.#editRecipe("Intercambiar casillas", (v) => {
        const ia = cells[a], ib = cells[b];
        if (fixed) {
          if (ia !== null) v.ingredients[ia].slot = b;
          if (ib !== null) v.ingredients[ib].slot = a;
        } else if (ia !== null && ib !== null) {
          [v.ingredients[ia], v.ingredients[ib]] = [v.ingredients[ib], v.ingredients[ia]];
        } else if (ia !== null) {
          // Free slots have no position of their own: moving to an empty cell sends it to the end.
          v.ingredients.push(v.ingredients.splice(ia, 1)[0]);
        }
      });
      const slots = cells.map((i, cell) => {
        const g = i !== null ? ings[i] : null;
        const marks = [];
        if (isTarget(cell)) marks.push(h("span", { class: "rc-mark target", title: `${r.mode}: esta casilla recibe el resultado` }, "◎"));
        if (r.failChance > 0) {
          marks.push(h("button", { class: ["rc-mark ret", returns.has(cell) && "on"], title: "Si falla, devolver lo de esta casilla (returnOnFail)",
            onclick: (ev) => { ev.stopPropagation(); this.#editRecipe("Devolver si falla", (v) => {
              const set = new Set(v.returnOnFail ?? []);
              if (set.has(cell)) set.delete(cell); else set.add(cell);
              v.returnOnFail = [...set].sort((x, y) => x - y);
              if (!v.returnOnFail.length) delete v.returnOnFail;
            }); } }, "↩"));
        }
        return this.#slot({ key: cell, label: String(cell + 1), itemKey: g?.item, qty: g ? g.qty ?? 1 : null,
          onDrop: (item) => setAt(cell, item),
          onSwap: (from) => swap(Number(from), cell),
          onQty: (q) => this.#editRecipe("Cantidad", (v) => { v.ingredients[i].qty = q; }),
          onClear: () => this.#editRecipe("Vaciar casilla", (v) => { v.ingredients.splice(i, 1); }),
          marks, title: fixed && g && !Number.isInteger(g.slot) ? "Sin casilla fija (vale en cualquiera). " : "" });
      });
      const out = r.output ?? {};
      const outSlot = this.#slot({ key: "out", label: "", itemKey: out.item, qty: out.item ? out.qty ?? 1 : null, big: true,
        title: r.mode && r.mode !== "Give" ? `${r.mode}: el item de la casilla ${(out.targetSlot ?? 0) + 1} pasa a ser este. ` : "",
        onDrop: (item) => this.#editRecipe("Resultado", (v) => { v.output = { ...(v.output ?? {}), item, qty: v.output?.qty ?? 1 }; }),
        onQty: (q) => this.#editRecipe("Cantidad", (v) => { v.output.qty = q; }),
        onClear: () => this.#editRecipe("Quitar resultado", (v) => { v.output.item = ""; }) });

      const grid = h("div", { class: ["rc-slots", station.slots > 3 && "wrap"] }, slots);
      const visual = h("div", { class: "rc-machine" },
        h("div", { class: "rc-machine-title" }, station.label, h("span", { class: "faint" }, ` · ${N} casilla${N > 1 ? "s" : ""}`)),
        h("div", { class: "rc-row" }, grid,
          h("div", { class: "rc-arrow", title: "Tiempo de crafteo" }, h("span", null, "➜"), h("small", null, `${r.craftTime ?? 1} s`),
            r.failChance > 0 ? h("small", { class: "bad-text" }, `falla ${Math.round(r.failChance * 100)} %`) : null),
          outSlot),
        overflow.length ? h("div", { class: "at-issue bad" }, `${overflow.length} ingrediente(s) no caben en las ${N} casillas: ${overflow.map((i) => ings[i].item).join(", ")}.`) : null);

      const field = (label, input, tip = "") => h("div", { class: "field" }, h("label", null, label, tip ? help(tip) : null), input);
      const num = (value, set, { step = 0.5, min = 0, max = null } = {}) => {
        const el = h("input", { type: "number", step, min, ...(max != null ? { max } : {}), value: value ?? "",
          onchange: () => set(el.value === "" ? null : Number(el.value)) });
        return el;
      };
      const idInput = h("input", { type: "text", value: r.id ?? "", spellcheck: false,
        onchange: () => this.#editRecipe("Id", (v) => { v.id = idInput.value.trim(); }) });
      const fields = h("div", { class: "rc-fields" },
        field("Id", h("div", { class: "row" }, idInput,
          h("button", { title: "El id del resultado", onclick: () => out.item && this.#editRecipe("Id", (v) => { v.id = this.#freeId(String(out.item).replace(/^aura:/, "")); }) }, "= resultado"))),
        field("Tiempo (s)", num(r.craftTime ?? 1, (n) => this.#editRecipe("Tiempo", (v) => { v.craftTime = n ?? 1; }))),
        field("Modo", select({ value: r.mode ?? "Give", options: M.MODES, onChange: (m) => this.#editRecipe("Modo", (v) => {
          v.mode = m;
          if (m === "Give") delete v.output.targetSlot; else v.output.targetSlot ??= 0;
        }) }).input, "Dar: crea el resultado. Modificar: cambia el item de una casilla (runas en el arma). Mejorar: lo sustituye por el resultado conservando runas y desgaste."),
        r.mode && r.mode !== "Give" ? field("Casilla objetivo", select({ value: String(out.targetSlot ?? 0), options: Array.from({ length: N }, (_, i) => [String(i), `Casilla ${i + 1}`]),
          onChange: (s) => this.#editRecipe("Casilla objetivo", (v) => { v.output.targetSlot = Number(s); }) }).input) : null,
        field("Prob. de fallo", num(r.failChance, (n) => this.#editRecipe("Fallo", (v) => {
          if (!n) { delete v.failChance; delete v.returnOnFail; } else v.failChance = Math.min(1, n);
        }), { step: 0.05, max: 1 }), "0..1. Al fallar se gastan los ingredientes; las casillas marcadas con ↩ se devuelven."),
        field("Casillas fijas", checkbox({ value: fixed, title: "Cada ingrediente en su casilla («slot»), como la mano; sin marcar vale en cualquier casilla, como el caldero",
          onChange: (on) => this.#editRecipe("Casillas fijas", (v) => {
            if (on) cells.forEach((i, cell) => { if (i !== null) v.ingredients[i].slot = cell; });
            else {
              v.ingredients = cells.filter((i) => i !== null).map((i) => v.ingredients[i]).concat(overflow.map((i) => v.ingredients[i]));
              for (const g of v.ingredients) delete g.slot;
            }
          }) }).input, "Cada ingrediente en su casilla («slot»), como la mano. Sin marcar, vale en cualquier casilla, como el caldero."));
      return h("div", null, visual, fields, h("p", { class: "note" }, station.note));
    }

    // FurnaceSystem stations: one or two inputs by slot, fuel from fuels.json, the result, time and temperature.
    #furnaceEditor(r, station) {
      const crucible = station.inputs > 1;
      const setKey = (key, qtyKey, item) => this.#editRecipe("Entrada", (v) => { v[key] = item; if (qtyKey in v || crucible) v[qtyKey] ??= 1; });
      const qtyOf = (v, k) => v[k] ?? 1;
      // Quantity keys: written only when not 1 unless the file already writes them (crucible does, furnace does not).
      const setQty = (k) => (q) => this.#editRecipe("Cantidad", (v) => { if (q === 1 && !(k in v) && !crucible) return; v[k] = q; });
      const swapInputs = () => this.#editRecipe("Intercambiar metales", (v) => {
        [v.input, v.input2] = [v.input2 ?? "", v.input];
        [v.inputQty, v.input2Qty] = [v.input2Qty ?? 1, v.inputQty ?? 1];
        if (!v.input2) { delete v.input2; delete v.input2Qty; }
      });
      const in1 = this.#slot({ key: "in1", label: crucible ? "Metal 1" : "Entrada", itemKey: r.input, qty: r.input ? qtyOf(r, "inputQty") : null,
        onDrop: (item) => setKey("input", "inputQty", item), onQty: setQty("inputQty"), onSwap: crucible ? swapInputs : null,
        onClear: () => this.#editRecipe("Vaciar", (v) => { v.input = ""; }) });
      const in2 = crucible ? this.#slot({ key: "in2", label: "Metal 2", itemKey: r.input2, qty: r.input2 ? qtyOf(r, "input2Qty") : null,
        title: "Vacío: receta de un solo metal (el metal 2 debe estar vacío en el crisol). ",
        onDrop: (item) => this.#editRecipe("Metal 2", (v) => { v.input2 = item; v.input2Qty ??= 1; }), onQty: setQty("input2Qty"), onSwap: swapInputs,
        onClear: () => this.#editRecipe("Vaciar", (v) => { delete v.input2; delete v.input2Qty; }) }) : null;
      const ritual = crucible ? this.#slot({ key: "rit", label: "Ritual", disabled: true, title: "La tercera casilla del crisol aún no la lee ninguna receta." }) : null;
      const fuelDoc = this.docs.find((d) => d.name.toLowerCase() === "fuels.json");
      const fuel = h("div", { class: "rc-slot off fuel", title: `Cualquier combustible de fuels.json (${fuelDoc?.entries.length ?? 0})`,
        onclick: () => this.#openStation("fuels") }, h("span", { class: "rc-num" }, "Fuego"), h("span", { class: "rc-flame" }, "🔥"));
      const out = this.#slot({ key: "out", label: "", big: true, itemKey: r.output, qty: r.output ? qtyOf(r, "outputQty") : null,
        onDrop: (item) => this.#editRecipe("Resultado", (v) => { v.output = item; }), onQty: setQty("outputQty"),
        onClear: () => this.#editRecipe("Quitar resultado", (v) => { v.output = ""; }) });
      const temp = Number(r.minTemp ?? 400);
      const visual = h("div", { class: "rc-machine hot" },
        h("div", { class: "rc-machine-title" }, station.label),
        h("div", { class: "rc-row" },
          h("div", { class: "rc-col" }, h("div", { class: "rc-slots" }, in1, in2, ritual), fuel),
          h("div", { class: "rc-arrow" }, h("span", null, "➜"), h("small", null, `${r.craftTime ?? 10} s`),
            h("div", { class: "rc-thermo", title: `Necesita ${temp}°` }, h("i", { style: { width: Math.min(100, temp / 12) + "%" } })), h("small", null, `${temp}°`)),
          out));
      const field = (label, input, tip = "") => h("div", { class: "field" }, h("label", null, label, tip ? help(tip) : null), input);
      const num = (value, set, step = 0.5) => { const el = h("input", { type: "number", step, min: 0, value, onchange: () => set(Number(el.value)) }); return el; };
      const idInput = h("input", { type: "text", value: r.id ?? "", spellcheck: false, onchange: () => this.#editRecipe("Id", (v) => { v.id = idInput.value.trim(); }) });
      const fields = h("div", { class: "rc-fields" },
        field("Id", idInput, "El guardado del horno recuerda la receta en curso por su id."),
        field("Tiempo (s)", num(r.craftTime ?? 10, (n) => this.#editRecipe("Tiempo", (v) => { v.craftTime = n; }))),
        field("Temp. mínima", num(temp, (n) => this.#editRecipe("Temperatura", (v) => { v.minTemp = n; }), 50), "Debajo de esta temperatura el progreso se pausa (no se pierde)."));
      return h("div", null, visual, fields, h("p", { class: "note" }, station.note));
    }

    // fuels.json: a table of what burns, each row editable, items dropped on it to add them.
    #fuelsEditor(doc) {
      const rows = doc.entries.map((e, i) => {
        const r = e.value;
        const rec = M.resolveItem(this.index, r.item);
        const c = h("canvas", { width: 32, height: 32 });
        if (rec) this.#paintIcon(c, rec);
        const num = (k, step) => { const el = h("input", { type: "number", min: 0, step, value: r[k] ?? 0,
          onchange: () => this.#edit("Combustible", (list) => { list[i].value[k] = Number(el.value); }) }); return el; };
        const maxBurn = Math.max(1, ...doc.entries.map((x) => Number(x.value.burnTime) || 0));
        return h("div", { class: ["rc-fuel", i === this.sel && "on", r.item && !rec && "bad"], onclick: () => { this.sel = i; this.#renderList(); this.#renderPanel(); } },
          c, h("span", { class: "grow" }, h("b", null, rec?.name ?? r.item ?? "?"), h("div", { class: "faint mono" }, r.item)),
          h("label", { class: "faint" }, "s ", num("burnTime", 0.5)), h("label", { class: "faint" }, "+° ", num("tempBoost", 10)),
          h("div", { class: "rc-bar", title: `${r.burnTime} s` }, h("i", { style: { width: (100 * (Number(r.burnTime) || 0) / maxBurn) + "%" } })),
          h("button", { class: "icon ghost", title: "Quitar", onclick: (ev) => { ev.stopPropagation(); this.#edit("Quitar combustible", (list) => { list.splice(i, 1); }); } }, "×"));
      });
      const drop = h("div", { class: "rc-drop", ondragover: (ev) => { if ([...ev.dataTransfer.types].includes(ITEM_MIME)) { ev.preventDefault(); drop.classList.add("hot"); } },
        ondragleave: () => drop.classList.remove("hot"),
        ondrop: (ev) => { drop.classList.remove("hot"); const item = ev.dataTransfer.getData(ITEM_MIME); if (!item) return; ev.preventDefault(); this.#addFuel(item); } },
        "Suelta aquí un item para que sirva de combustible");
      return h("div", null, h("div", { class: "rc-machine-title" }, "Combustibles", h("span", { class: "faint" }, " · segundos que arde y cuánto sube la temperatura")), drop, ...rows);
    }

    #addFuel(item) {
      const doc = this.#docOf(this.#station());
      if (doc.entries.some((e) => String(e.value.item).toLowerCase() === item.toLowerCase())) { this.studio.toast(`«${item}» ya es combustible.`, { kind: "warn" }); return; }
      this.#edit("Combustible nuevo", (list) => { list.push({ comments: [], gap: false, value: { item, burnTime: 10, tempBoost: 100 }, floatKeys: null }); return list.length - 1; });
    }

    /** Double click on an item: the first free ingredient slot of the recipe, or the result when it has none. */
    #dropAnywhere(item) {
      const station = this.#station();
      if (station.kind === "fuels") { this.#addFuel(item); return; }
      const e = this.#current();
      if (!e) return;
      if (station.kind === "furnace") {
        this.#editRecipe("Item", (v) => { if (!v.input) v.input = item; else if (station.inputs > 1 && !v.input2) { v.input2 = item; v.input2Qty ??= 1; } else v.output = item; });
        return;
      }
      this.#editRecipe("Item", (v) => {
        v.ingredients ??= [];
        if (!v.output?.item) { v.output = { ...(v.output ?? {}), item, qty: v.output?.qty ?? 1 }; return; }
        if (v.ingredients.length >= station.slots) return;
        const fixed = v.ingredients.some((g) => Number.isInteger(g.slot));
        if (!fixed) { v.ingredients.push({ item, qty: 1 }); return; }
        const used = new Set(v.ingredients.map((g) => g.slot));
        let s = 0; while (used.has(s)) s++;
        v.ingredients.push({ item, qty: 1, slot: s });
      });
    }

    // -----------------------------------------------------------------------------------------------------------------
    // The station's recipes, in file order

    #renderList() {
      clear(this.listEl);
      const station = this.#station(), doc = this.#docOf(station);
      if (!doc || station.kind === "fuels") return;
      const q = this.listQuery;
      const filter = h("input", { type: "search", placeholder: "Filtrar recetas…", value: q,
        oninput: () => { this.listQuery = filter.value.trim().toLowerCase(); this.#renderCards(cards, doc, station); } });
      const cards = h("div", { class: "rc-cards" });
      this.listEl.append(h("div", { class: "rc-listbar" },
        h("strong", null, `Recetas · ${doc.entries.length}`), filter, h("span", { class: "grow" }),
        h("button", { onclick: () => this.#addRecipe(), title: "Ctrl+N" }, "+ Nueva"),
        h("button", { onclick: () => this.#duplicate(), title: "Ctrl+D" }, "Duplicar"),
        h("button", { onclick: () => this.#move(this.sel, this.sel - 1), title: "Subir (el orden decide cuál gana si dos encajan)" }, "↑"),
        h("button", { onclick: () => this.#move(this.sel, this.sel + 1), title: "Bajar" }, "↓"),
        h("button", { class: "danger", onclick: () => this.#remove(), title: "Supr" }, "Borrar")), cards);
      this.#renderCards(cards, doc, station);
      for (const other of this.#alsoRead(station)) {
        const extra = h("div", { class: "rc-cards ro" });
        this.listEl.append(h("div", { class: "at-sub" }, `También hace las de ${other.name} (${other.entries.length}) — se editan en su pestaña`), extra);
        this.#renderCards(extra, other, M.stationOf(other), true);
      }
    }

    #renderCards(host, doc, station, readOnly = false) {
      clear(host);
      const q = this.listQuery;
      const issues = new Set(M.check(doc, station, this.index).map((i) => i.entry));
      doc.entries.forEach((e, i) => {
        const r = e.value ?? {};
        const keys = M.itemRefs(station.kind, r).map(([k]) => String(k ?? "").toLowerCase());
        if (q && !String(r.id ?? "").toLowerCase().includes(q) && !keys.some((k) => k.includes(q))) return;
        for (const c of e.comments ?? []) host.append(h("div", { class: "rc-section" }, c.replace(/^\/\/\s?|^\/\*\s?|\s?\*\/$/g, "")));
        const icon = (key, qty) => {
          const c = h("canvas", { width: 24, height: 24 });
          const rec = M.resolveItem(this.index, key);
          if (rec) this.#paintIcon(c, rec);
          return h("span", { class: ["rc-mini", key && !rec && "bad"], title: key ?? "" }, c, qty > 1 ? h("b", null, qty) : null);
        };
        const ins = station.kind === "furnace"
          ? [icon(r.input, r.inputQty ?? 1), r.input2 ? icon(r.input2, r.input2Qty ?? 1) : null]
          : (r.ingredients ?? []).map((g) => icon(g.item, g.qty ?? 1));
        const outKey = M.outputOf(station.kind, r), outQty = station.kind === "furnace" ? r.outputQty ?? 1 : r.output?.qty ?? 1;
        const card = h("div", { class: ["rc-card", !readOnly && i === this.sel && "on", issues.has(e) && "warn"], draggable: !readOnly,
          title: readOnly ? "Ábrela en su pestaña para editarla" : "Clic: editar · arrastra para reordenar",
          onclick: () => { if (readOnly) this.#openStation(station.id, i); else { this.sel = i; this.#renderEditor(); this.#renderList(); this.#renderPanel(); } },
          ondragstart: (ev) => { ev.dataTransfer.setData(CARD_MIME, String(i)); ev.dataTransfer.effectAllowed = "move"; },
          ondragover: (ev) => { if (!readOnly && [...ev.dataTransfer.types].includes(CARD_MIME)) { ev.preventDefault(); card.classList.add("hot"); } },
          ondragleave: () => card.classList.remove("hot"),
          ondrop: (ev) => { card.classList.remove("hot"); const from = ev.dataTransfer.getData(CARD_MIME); if (from === "") return; ev.preventDefault(); this.#move(Number(from), i); } },
          h("div", { class: "rc-card-items" }, ...ins, h("span", { class: "faint" }, "→"), icon(outKey, outQty)),
          h("div", { class: "rc-card-id mono" }, r.id ?? "(sin id)"));
        host.append(card);
      });
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Panel: the file, its problems, the recipe's JSON

    #renderPanel() {
      clear(this.panel);
      const station = this.#station(), doc = this.#docOf(station);
      if (!doc) { this.panel.append(h("div", { class: "empty-state" }, "Recetas", h("p", null, "Abre la carpeta del proyecto (Content)."))); return; }
      this.panel.append(section({ id: "rc-file", title: station.label, extra: doc.isNew ? "nuevo" : doc.name },
        h("p", { class: "note" }, station.note),
        h("p", { class: "note mono" }, doc.path),
        doc.isNew ? h("p", { class: "note" }, "El archivo no existe: se crea al guardar con su primera receta.") : null).el);
      const issues = M.check(doc, station, this.index, this.#alsoRead(station));
      this.panel.append(section({ id: "rc-check", title: "Revisión", extra: issues.length ? String(issues.length) : "todo bien" },
        issues.length ? issues.map((it) => h("div", { class: ["at-issue", it.level], style: { cursor: "pointer" },
          onclick: () => { this.sel = doc.entries.indexOf(it.entry); this.#renderEditor(); this.#renderList(); this.#renderPanel(); } }, it.text))
          : h("p", { class: "note" }, this.index.items.length ? "Todos los items existen y nada choca." : "No encontré items (Data/Items): no puedo comprobar los nombres.")).el);
      const e = doc.entries[this.sel];
      if (e) {
        const raw = h("textarea", { class: "at-raw", rows: 14, spellcheck: false, value: T.formatJson(e.value, "", "item", { openNested: true, floatKeys: e.floatKeys ?? doc.floatKeys }) });
        const err = h("p", { class: "note bad" });
        this.panel.append(section({ id: "rc-json", title: "JSON", collapsed: prefs.get("recipes:jsonCollapsed", false) }, raw, err,
          h("button", { onclick: () => {
            let next;
            try { next = JSON.parse(raw.value); } catch (x) { err.textContent = "JSON no válido: " + x.message; return; }
            if (!next || typeof next !== "object" || Array.isArray(next)) { err.textContent = "Una receta es un objeto { … }."; return; }
            this.#edit("JSON", (list) => { list[this.sel].value = next; });
          } }, "Aplicar JSON")).el);
      }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Icons: the item's own cell, or its tile's art; a sheet is decoded once.

    async #paintIcon(canvas, rec) {
      const g = canvas.getContext("2d");
      const ic = rec.icon;
      if (!ic?.coord) { this.#letter(g, canvas, rec); return; }
      const sheet = await this.#sheetCanvas(ic.sheet);
      if (!sheet) { this.#letter(g, canvas, rec); return; }
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.drawImage(sheet, ic.coord[0] * ic.tw, ic.coord[1] * ic.th, ic.tw, ic.th, 0, 0, canvas.width, canvas.height);
    }

    #letter(g, canvas, rec) {
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = "#3a4048"; g.fillRect(2, 2, canvas.width - 4, canvas.height - 4);
      g.fillStyle = "#c8ccd2"; g.font = `${Math.round(canvas.height * 0.45)}px system-ui`; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(rec.name ?? "?").slice(0, 2), canvas.width / 2, canvas.height / 2 + 1);
    }

    #sheetCanvas(key) {
      if (this.#sheets.has(key)) return this.#sheets.get(key);
      const p = (async () => {
        const atlas = this.project?.atlases.find((a) => T.sheetKey(a.id) === key);
        const png = atlas?.png ?? this.project?.filter((e) => e.lower.endsWith(".png") && e.name.toLowerCase() === key + ".png")[0] ?? null;
        if (!png) return null;
        const img = await decodePng(await png.handle.getFile());
        const c = new OffscreenCanvas(img.w, img.h);
        c.getContext("2d").putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
        return c;
      })().catch(() => null);
      this.#sheets.set(key, p);
      return p;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Saving

    async save() {
      const dirty = this.docs.filter(M.isDirty);
      if (!dirty.length) return true;
      try {
        await this.studio.busy((async () => {
          for (const doc of dirty) {
            const text = M.serialize(doc);
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
        this.studio.toast("Guardado " + dirty.map((d) => d.name).join(", "), { kind: "ok", detail: "El juego lee las recetas al arrancar." });
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

  Aura.recipesTool = { recipesTool };
})(window.Aura ??= {});
