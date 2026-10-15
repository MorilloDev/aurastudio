"use strict";

// Atlas: the tile sheets as the game uses them. Cells are selected, moved, swapped, copied and emptied right on the PNG,
// and every move takes the sheet's normal maps along (_n, _d…) and rewrites the [x, y] of every tile JSON that points
// at those cells, so sprites, maps and data never disagree. The inspector edits the tiles themselves (form or raw JSON),
// creates new ones on a cell, and receives what the Crear tab sends ("Enviar al Atlas"). One undo history covers pixels
// and JSON together; Ctrl+S writes only the files that changed, with a backup to put them back.
(function (Aura) {
  const { h, clear, rafThrottle } = Aura.dom;
  const { History } = Aura.history;
  const { Viewport } = Aura.viewport;
  const { prefs } = Aura.storage;
  const { readText, writeHandle, writeInDir, stripExt } = Aura.fs;
  const { section, select, segmented } = Aura.controls;
  const { listSheets } = Aura.sheetFiles;
  const { addToMgcb } = Aura.mgcb;
  const { COMPANIONS, SheetImage } = Aura.atlasLayers;
  const T = Aura.atlasTiles;

  const ck = (x, y) => x + "," + y;
  const pk = (key) => key.split(",").map(Number);
  const sortCells = (cells) => cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);

  // Starting points for "Nuevo tile": the keys a fresh tile of that kind needs, nothing the game already defaults.
  const TILE_KINDS = [
    ["block", "Bloque", { type: "solid", hardness: 1 }],
    ["plant", "Planta", { type: "solid", hardness: 0, collision: "none", shaderEffect: "wind" }],
    ["art", "Solo arte", {}],
  ];

  const FORM_FIELDS = [
    { key: "name", label: "Nombre", kind: "text" },
    { key: "id", label: "Id", kind: "text", hint: "del nombre" },
    { key: "type", label: "Tipo", kind: "select", options: ["", "solid", "liquid", "air"] },
    { key: "hardness", label: "Dureza", kind: "number", hint: "-1 = irrompible" },
    { key: "tags", label: "Etiquetas", kind: "tags", hint: "wood, flammable…" },
    { key: "shaderEffect", label: "Efecto", kind: "select", options: ["", "none", "wind", "wind_tall", "water", "glass"] },
    { key: "collision", label: "Colisión", kind: "select", options: ["", "none", "full"] },
    { key: "luminosity", label: "Luz", kind: "number", hint: "0" },
  ];

  function atlasTool() {
    return new AtlasTool();
  }

  class AtlasTool {
    id = "atlas";
    title = "Atlas";
    project = null;
    docs = [];
    refs = [];
    sheets = [];
    sheet = null;           // the open sheet (sheetFiles entry of an atlas)
    img = null;             // its SheetImage
    grid = { w: 64, h: 64 };
    view = "";              // layer shown: "" colour, "_n", "_d"…
    showMarks = true;
    selection = new Set();  // "x,y" grid cells
    tile = null;            // tile object open in the inspector
    pending = null;         // a placement sent from Crear, waiting for its cell
    placed = null;          // the last placement, until a tile is made for it
    picking = null;         // { label, apply(cell) } while the next click sets an art coordinate
    history = new History({ limit: 200 });
    #hover = null;
    #drag = null;
    #sheetRefs = [];
    #cellRefs = new Map();
    #artCells = new Set();

    // -----------------------------------------------------------------------------------------------------------------
    // Setup

    mount(host, studio) {
      this.studio = studio;
      this.showMarks = prefs.get("atlas:marks", true);
      host.appendChild(this.#buildLayout());
      this.vp = new Viewport(this.canvas);
      this.vp.on("change", () => this.#draw());
      new ResizeObserver(() => this.#draw()).observe(this.viewEl);
      this.history.on("change", () => this.#changed());
      this.#bindPointer();
      this.#registerCommands();
      this.#renderAll();
    }

    async activate() {
      this.#draw();
      const p = this.studio.pendingPlacement;
      this.studio.pendingPlacement = null;
      await this.#refreshIfChanged();
      if (p) this.#beginPlacement(p);
    }

    // Crear's "Guardar en el atlas", Aseprite or a text editor may have written the files while this tab held them.
    // Untouched here, they are simply read again; with edits pending, saving asks before overwriting (#confirmOverwrite).
    async #refreshIfChanged() {
      if (!this.img || this.history.dirty) return;
      const changed = await this.#changedOnDisk();
      if (!changed.length) return;
      await this.studio.busy(this.#loadDocs());
      await this.#loadSheet(this.sheet, false);
      this.studio.setStatus("Releído (cambió fuera del Atlas): " + changed.join(", ") + ".", "ok");
    }

    async #changedOnDisk() {
      return [...(await this.img.changedOnDisk()), ...(await T.docsChangedOnDisk(this.docs))];
    }

    deactivate() {
      this.picking = null;
    }

    isDirty() { return this.history.dirty; }
    dirtyLabel() { return "El atlas"; }

    async onProject(project) {
      this.project = project;
      this.sheets = listSheets(project).filter((s) => s.atlas);
      if (this.history.dirty) {
        // Reloading would throw away the edits; the list is refreshed and the open sheet stays as it is.
        this.studio.toast("Carpeta releída. El atlas tiene cambios sin guardar: los mantengo.", { kind: "warn" });
        this.#renderSheets();
        return;
      }
      await this.studio.busy(this.#loadDocs());
      const keep = this.sheet && this.sheets.find((s) => s.key === this.sheet.key);
      const first = keep ?? this.sheets.find((s) => this.refs.some((r) => r.sheet === T.sheetKey(s.id))) ?? this.sheets[0];
      if (first) await this.#loadSheet(first, !keep);
      else this.#renderAll();
    }

    async #loadDocs() {
      this.docs = await T.loadDocs(this.project);
      this.refs = T.collectRefs(this.docs);
      const broken = this.docs.filter((d) => d.error);
      if (broken.length) {
        this.studio.toast(`${broken.length} archivo(s) de tiles no se pueden leer.`, {
          kind: "bad", detail: broken.map((d) => `${d.name}: ${d.error}`).join(" · "),
        });
      }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Layout

    #buildLayout() {
      this.sheetList = h("div", { class: "at-sheets scroll" });
      this.tileFilter = h("input", { type: "search", placeholder: "Buscar tile…", oninput: () => this.#renderTileList() });
      this.tileList = h("div", { class: "at-tiles scroll" });
      const left = h("div", { class: "at-left" },
        h("div", { class: "at-head" }, h("strong", null, "Hojas")),
        this.sheetList,
        h("div", { class: "at-head" }, this.tileFilter),
        this.tileList);

      this.viewSeg = h("div", { class: "seg" });
      this.marksBtn = h("button", { class: this.showMarks ? "on" : "", title: "Marcas: celdas usadas, referencias rotas, arte sin usar (M)",
        onclick: () => this.#toggleMarks() }, "Marcas");
      this.undoBtn = h("button", { class: "icon", title: "Deshacer (Ctrl+Z)", onclick: () => this.history.undo() }, "↶");
      this.redoBtn = h("button", { class: "icon", title: "Rehacer (Ctrl+Y)", onclick: () => this.history.redo() }, "↷");
      this.saveBtn = h("button", { class: "primary", title: "Guardar la hoja, sus mapas y los JSON cambiados (Ctrl+S)", onclick: () => this.save() }, "Guardar");
      this.banner = h("div", { class: "at-banner", hidden: true });
      this.canvas = h("canvas", { class: "at-canvas", tabindex: 0 });
      this.viewEl = h("div", { class: "at-view" }, this.canvas, this.banner);
      const stage = h("div", { class: "at-stage" },
        h("div", { class: "at-toolbar" },
          this.viewSeg, this.marksBtn,
          h("button", { title: "Ver la hoja entera (F)", onclick: () => this.#fit() }, "Encajar"),
          h("span", { class: "grow" }),
          this.undoBtn, this.redoBtn, this.saveBtn),
        this.viewEl);

      this.panel = h("div", { class: "at-panel scroll" });
      this.root = h("div", { class: "at" }, left, stage, this.panel);
      return this.root;
    }

    #renderAll() {
      this.#renderSheets();
      this.#renderTileList();
      this.#renderViews();
      this.#renderPanel();
      this.#renderBanner();
      this.#updateToolbar();
      this.#draw();
    }

    #renderSheets() {
      clear(this.sheetList);
      if (!this.sheets.length) {
        this.sheetList.appendChild(h("div", { class: "empty-state" },
          this.project ? "Ningún atlases.json declara una hoja con su PNG." : "Abre la carpeta del proyecto para ver sus hojas."));
        return;
      }
      for (const s of this.sheets) {
        const key = T.sheetKey(s.id);
        const count = this.refs.filter((r) => r.sheet === key).length;
        this.sheetList.appendChild(h("div", {
          class: ["at-sheet", this.sheet?.key === s.key && "active"], title: s.path,
          onclick: () => this.#openSheet(s),
        },
          h("div", { class: "id" }, s.id, h("span", { class: "grow" }),
            s.has.n ? h("span", { class: "badge plain", title: "Tiene _n.png" }, "_n") : null,
            s.has.d ? h("span", { class: "badge plain", title: "Tiene _d.png" }, "_d") : null,
            h("span", { class: "badge plain", title: "Referencias de los JSON a esta hoja" }, count)),
          h("div", { class: "path" }, s.path)));
      }
    }

    #renderTileList() {
      clear(this.tileList);
      if (!this.sheet) return;
      const q = this.tileFilter.value.trim().toLowerCase();
      const byTile = new Map();
      for (const r of this.#sheetRefs) {
        if (!byTile.has(r.tile)) byTile.set(r.tile, []);
        byTile.get(r.tile).push(r);
      }
      const rows = [...byTile].filter(([tile]) => !q || T.tileId(tile).includes(q) || T.tileLabel(tile).toLowerCase().includes(q));
      if (!rows.length) {
        this.tileList.appendChild(h("div", { class: "empty-state" }, q ? "Ningún tile coincide." : "Ningún tile usa esta hoja todavía."));
        return;
      }
      for (const [tile, refs] of rows) {
        const broken = refs.some((r) => !this.#refHasArt(r));
        this.tileList.appendChild(h("div", {
          class: ["at-tile", tile === this.tile && "active"], title: `${T.tileId(tile)} · ${refs[0].doc.name}`,
          onclick: () => this.#openTile(tile, true),
        }, h("span", { class: "grow" }, T.tileLabel(tile)),
          broken ? h("span", { class: "badge bad", title: "Apunta a una celda vacía" }, "!") : null,
          h("span", { class: "faint" }, refs.length)));
      }
    }

    #renderViews() {
      clear(this.viewSeg);
      const views = [["", "Color"], ...COMPANIONS.filter(([s]) => this.img?.has(s)).map(([s, label, title]) => [s, label, title])];
      if (!views.some(([v]) => v === this.view)) this.view = "";
      for (const [v, label, title] of views) {
        this.viewSeg.appendChild(h("button", { class: v === this.view ? "on" : "", title: title ?? "La hoja de color",
          onclick: () => { this.view = v; this.#renderViews(); this.#draw(); } }, label));
      }
    }

    #updateToolbar() {
      this.undoBtn.disabled = !this.history.canUndo;
      this.redoBtn.disabled = !this.history.canRedo;
      this.undoBtn.title = "Deshacer" + (this.history.undoLabel ? ": " + this.history.undoLabel : "") + " (Ctrl+Z)";
      this.redoBtn.title = "Rehacer" + (this.history.redoLabel ? ": " + this.history.redoLabel : "") + " (Ctrl+Y)";
      this.saveBtn.disabled = !this.history.dirty;
    }

    #toggleMarks() {
      this.showMarks = !this.showMarks;
      prefs.set("atlas:marks", this.showMarks);
      this.marksBtn.classList.toggle("on", this.showMarks);
      this.#draw();
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Sheets

    async #openSheet(sheet) {
      if (sheet.key === this.sheet?.key) return;
      if (!(await this.#settleUnsaved())) return;
      await this.#loadSheet(sheet, true);
    }

    /** Before something that drops the edits in memory: save, discard (reloading the JSON from disk) or stay. */
    async #settleUnsaved() {
      if (!this.history.dirty) return true;
      const choice = await this.studio.askUnsaved("El atlas «" + (this.sheet?.id ?? "") + "»");
      if (choice === "save") return this.save();
      if (choice === "discard") {
        await this.studio.busy(this.#loadDocs());
        this.history.clear();
        return true;
      }
      return false;
    }

    async #loadSheet(sheet, fit) {
      try {
        const img = await this.studio.busy(new SheetImage(sheet).load(this.project));
        this.sheet = sheet;
        this.img = img;
      } catch (err) {
        this.studio.toast("No pude abrir la hoja.", { kind: "bad", detail: err.message });
        return;
      }
      this.history.clear();
      this.selection.clear();
      this.tile = null;
      this.placed = null;
      this.grid = this.#gridFor(sheet);
      this.#index();
      this.#renderAll();
      if (fit) requestAnimationFrame(() => this.#fit());
      for (const w of this.img.warnings) this.studio.toast(w, { kind: "warn" });
      if (this.#asepriteOf(sheet)) {
        this.studio.toast("Esta hoja tiene su .aseprite al lado.", {
          kind: "warn", detail: "Lo que cambies aquí se pisa si vuelves a exportar el PNG desde Aseprite. Edita en un solo sitio.",
        });
      }
      this.studio.setStatus(`«${sheet.id}»: ${this.img.w}×${this.img.h}, ${this.#sheetRefs.length} referencias, ${this.img.layers.size - 1} mapa(s) acompañando.`, "ok");
    }

    #asepriteOf(sheet) {
      const stem = sheet.path.replace(/\.png$/i, "");
      return this.project.get(stem + ".aseprite") ?? this.project.get(stem + ".ase");
    }

    // The size most of the sheet's references use; remembered per sheet once changed by hand.
    #gridFor(sheet) {
      const saved = prefs.get("atlas:grid:" + sheet.key, null);
      if (saved) return saved;
      const key = T.sheetKey(sheet.id), counts = new Map();
      for (const r of this.refs) if (r.sheet === key) counts.set(r.tw + "x" + r.th, (counts.get(r.tw + "x" + r.th) ?? 0) + 1);
      const best = [...counts].sort((a, b) => b[1] - a[1])[0];
      const [w, h] = best ? best[0].split("x").map(Number) : [T.CELL, T.CELL];
      return { w, h };
    }

    #setGrid(w, h) {
      if (!(w >= 4 && h >= 4)) return;
      this.grid = { w, h };
      prefs.set("atlas:grid:" + this.sheet.key, this.grid);
      this.selection.clear();
      this.#index();
      this.#renderAll();
    }

    get cols() { return this.img ? Math.floor(this.img.w / this.grid.w) : 0; }
    get rows() { return this.img ? Math.floor(this.img.h / this.grid.h) : 0; }

    // -----------------------------------------------------------------------------------------------------------------
    // Index: which references and which art each grid cell has. Rebuilt after every change — cheap next to a frame.

    #index() {
      this.refs = T.collectRefs(this.docs);
      this.#sheetRefs = [];
      this.#cellRefs = new Map();
      this.#artCells = new Set();
      if (!this.img) return;
      const key = T.sheetKey(this.sheet.id);
      for (const r of this.refs) {
        if (r.sheet !== key) continue;
        this.#sheetRefs.push(r);
        for (const c of this.#cellsOf(r)) {
          const k = ck(c[0], c[1]);
          if (!this.#cellRefs.has(k)) this.#cellRefs.set(k, []);
          this.#cellRefs.get(k).push(r);
        }
      }
      const { w, h } = this.grid;
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) if (this.img.hasArt(x * w, y * h, w, h)) this.#artCells.add(ck(x, y));
      }
    }

    #cellsOf(ref) {
      const r = T.refRect(ref), { w, h } = this.grid, out = [];
      for (let y = Math.floor(r.y / h); y < Math.ceil((r.y + r.h) / h); y++) {
        for (let x = Math.floor(r.x / w); x < Math.ceil((r.x + r.w) / w); x++) out.push([x, y]);
      }
      return out;
    }

    #refHasArt(ref) {
      const r = T.refRect(ref);
      return !!this.img && r.x + r.w <= this.img.w && r.y + r.h <= this.img.h && this.img.hasArt(r.x, r.y, r.w, r.h);
    }

    #changed() {
      this.#index();
      if (this.#hover) this.#hoverStatus(this.#hover);
      this.#renderSheets();
      this.#renderTileList();
      this.#renderViews();
      this.#renderPanel();
      this.#updateToolbar();
      this.#draw();
      this.studio.refreshDirty();
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Drawing

    #draw = rafThrottle(() => {
      const c = this.canvas;
      if (!c?.isConnected || !c.offsetWidth) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      const g = c.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      if (!this.img) return;

      const z = this.vp.zoom, ox = this.vp.panX, oy = this.vp.panY;
      const iw = this.img.w * z, ih = this.img.h * z;
      g.fillStyle = this.#checker(g);
      g.fillRect(ox, oy, iw, ih);
      g.imageSmoothingEnabled = false;
      g.drawImage(this.img.canvasOf(this.view), ox, oy, iw, ih);

      const cw = this.grid.w * z, chh = this.grid.h * z;
      const rect = (x, y, w = 1, hh = 1) => [ox + x * cw, oy + y * chh, w * cw, hh * chh];

      if (cw >= 6) {
        g.strokeStyle = "rgba(255,255,255,.08)";
        g.lineWidth = 1;
        g.beginPath();
        for (let x = 0; x <= this.cols; x++) { g.moveTo(Math.round(ox + x * cw) + 0.5, oy); g.lineTo(Math.round(ox + x * cw) + 0.5, oy + this.rows * chh); }
        for (let y = 0; y <= this.rows; y++) { g.moveTo(ox, Math.round(oy + y * chh) + 0.5); g.lineTo(ox + this.cols * cw, Math.round(oy + y * chh) + 0.5); }
        g.stroke();
      }

      if (this.showMarks) {
        // Art no tile points at (yellow corner) and tiles pointing at nothing (red frame): what to look at first.
        g.fillStyle = "rgba(240,180,90,.85)";
        for (const k of this.#artCells) {
          if (this.#cellRefs.has(k)) continue;
          const [x, y] = pk(k);
          const [rx, ry, rw] = rect(x, y);
          const s = Math.max(3, Math.min(8, cw / 6));
          g.fillRect(rx + rw - s - 1, ry + 1, s, s);
        }
        g.strokeStyle = "rgba(239,111,108,.95)";
        g.lineWidth = 2;
        for (const r of this.#sheetRefs) {
          if (this.#refHasArt(r)) continue;
          const rr = T.refRect(r);
          g.strokeRect(ox + rr.x * z + 1, oy + rr.y * z + 1, rr.w * z - 2, rr.h * z - 2);
        }
      }

      // The open tile's cells.
      if (this.tile) {
        g.strokeStyle = "rgba(127,178,255,.95)";
        g.lineWidth = 2;
        for (const r of this.#sheetRefs) {
          if (r.tile !== this.tile) continue;
          const rr = T.refRect(r);
          g.strokeRect(ox + rr.x * z + 1, oy + rr.y * z + 1, rr.w * z - 2, rr.h * z - 2);
        }
      }

      g.fillStyle = "rgba(95,211,176,.22)";
      g.strokeStyle = "rgba(95,211,176,.95)";
      g.lineWidth = 2;
      for (const k of this.selection) {
        const [x, y] = pk(k);
        const r = rect(x, y);
        g.fillRect(...r);
        g.strokeRect(r[0] + 1, r[1] + 1, r[2] - 2, r[3] - 2);
      }

      const d = this.#drag;
      if (d?.kind === "move" && (d.dx || d.dy)) this.#drawMoveGhost(g, rect, d);
      if (d?.kind === "marquee") {
        const [x0, y0, x1, y1] = this.#marqueeCells(d);
        g.strokeStyle = "rgba(95,211,176,.9)";
        g.setLineDash([4, 3]);
        g.strokeRect(...rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1));
        g.setLineDash([]);
      }
      if (this.pending && this.#hover) this.#drawPlacementGhost(g, rect);

      if (this.#hover && !this.pending && !d) {
        g.strokeStyle = this.picking ? "rgba(127,178,255,.95)" : "rgba(255,255,255,.55)";
        g.lineWidth = 1;
        const r = rect(this.#hover[0], this.#hover[1]);
        g.strokeRect(r[0] + 0.5, r[1] + 0.5, r[2] - 1, r[3] - 1);
      }
    });

    #drawMoveGhost(g, rect, d) {
      const { w, h } = this.grid, src = this.img.canvasOf(this.view);
      g.globalAlpha = 0.8;
      for (const k of this.selection) {
        const [x, y] = pk(k);
        g.drawImage(src, x * w, y * h, w, h, ...rect(x + d.dx, y + d.dy));
      }
      g.globalAlpha = 1;
      g.strokeStyle = d.copy ? "rgba(127,178,255,.95)" : "rgba(95,211,176,.95)";
      g.setLineDash([4, 3]);
      for (const k of this.selection) {
        const [x, y] = pk(k);
        const r = rect(x + d.dx, y + d.dy);
        g.strokeRect(r[0] + 1, r[1] + 1, r[2] - 2, r[3] - 2);
      }
      g.setLineDash([]);
    }

    #drawPlacementGhost(g, rect) {
      const cells = this.#placementCells(this.#hover);
      for (let i = 0; i < cells.length; i++) {
        const [x, y] = cells[i];
        const r = rect(x, y);
        const item = this.pending.items[i];
        item.canvas ??= toCanvas(item.color, this.pending.size);
        g.globalAlpha = 0.85;
        g.drawImage(item.canvas, ...r);
        g.globalAlpha = 1;
        const out = x >= this.cols || y >= this.rows;
        const busy = this.#artCells.has(ck(x, y));
        g.strokeStyle = out ? "rgba(240,180,90,.95)" : busy ? "rgba(239,111,108,.95)" : "rgba(95,211,176,.95)";
        g.lineWidth = 2;
        g.strokeRect(r[0] + 1, r[1] + 1, r[2] - 2, r[3] - 2);
      }
    }

    #checker(g) {
      if (!this.checkerPattern) {
        const c = new OffscreenCanvas(16, 16), cg = c.getContext("2d");
        cg.fillStyle = "#2b2e33"; cg.fillRect(0, 0, 16, 16);
        cg.fillStyle = "#33363c"; cg.fillRect(0, 0, 8, 8); cg.fillRect(8, 8, 8, 8);
        this.checkerPattern = g.createPattern(c, "repeat");
      }
      return this.checkerPattern;
    }

    #fit() {
      if (this.img) this.vp.fit(this.img.w, this.img.h);
    }

    #reveal(cells) {
      if (!cells.length) return;
      const [x, y] = cells[0];
      const s = this.vp.toScreen((x + 0.5) * this.grid.w, (y + 0.5) * this.grid.h), size = this.vp.size();
      if (s.x < 0 || s.y < 0 || s.x > size.w || s.y > size.h) this.vp.centerOn((x + 0.5) * this.grid.w, (y + 0.5) * this.grid.h);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Pointer: click selects (Shift adds, Ctrl toggles), dragging art moves it (swapping with what is there; Alt copies),
    // dragging from empty space draws a selection box. Wheel / middle drag / Space pan, as in every canvas of the studio.

    #cellAt(e) {
      const p = this.vp.toImage(e.clientX, e.clientY);
      return [Math.floor(p.x / this.grid.w), Math.floor(p.y / this.grid.h)];
    }

    #inside([x, y]) { return x >= 0 && y >= 0 && x < this.cols && y < this.rows; }

    #bindPointer() {
      const c = this.canvas;
      c.addEventListener("pointerdown", (e) => {
        if (!this.img || e.button !== 0 || this.vp.wantsPan(e)) return;
        c.focus();
        const cell = this.#cellAt(e);
        if (this.pending) { this.#placeAt(cell); return; }
        if (this.picking) {
          if (this.#inside(cell)) { const p = this.picking; this.picking = null; p.apply(cell); }
          return;
        }
        const k = ck(...cell);
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (!this.#inside(cell) || (!this.#artCells.has(k) && !this.selection.has(k) && !e.altKey)) {
          if (!additive) this.selection.clear();
          this.#drag = { kind: "marquee", start: cell, end: cell, base: new Set(this.selection) };
        } else {
          if (e.ctrlKey || e.metaKey) {
            if (this.selection.has(k)) this.selection.delete(k); else this.selection.add(k);
            this.#selectionChanged();
            return;
          }
          if (e.shiftKey) this.selection.add(k);
          else if (!this.selection.has(k)) { this.selection.clear(); this.selection.add(k); }
          this.#drag = { kind: "move", start: cell, dx: 0, dy: 0, copy: e.altKey, clicked: k, additive };
        }
        c.setPointerCapture(e.pointerId);
        this.#draw();
      });
      c.addEventListener("pointermove", (e) => {
        if (!this.img) return;
        const cell = this.#cellAt(e);
        const d = this.#drag;
        if (d?.kind === "marquee") d.end = cell;
        if (d?.kind === "move") { d.dx = cell[0] - d.start[0]; d.dy = cell[1] - d.start[1]; d.copy = e.altKey; }
        const changed = !this.#hover || this.#hover[0] !== cell[0] || this.#hover[1] !== cell[1];
        this.#hover = cell;
        if (changed) this.#hoverStatus(cell);
        this.#draw();
      });
      c.addEventListener("pointerleave", () => { this.#hover = null; this.studio.slot("cell", ""); this.#draw(); });
      c.addEventListener("pointerup", (e) => {
        const d = this.#drag;
        this.#drag = null;
        if (!d) return;
        if (d.kind === "marquee") {
          const [x0, y0, x1, y1] = this.#marqueeCells(d);
          this.selection = new Set(d.base);
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (this.#inside([x, y])) this.selection.add(ck(x, y));
          this.#selectionChanged();
        } else if (d.dx || d.dy) {
          this.#moveSelection(d.dx, d.dy, d.copy);
        } else {
          // A plain click on a cell of a bigger selection picks just that cell.
          if (!d.additive && this.selection.size > 1) { this.selection.clear(); this.selection.add(d.clicked); }
          this.#selectionChanged(true);
        }
        this.#draw();
      });
      c.addEventListener("dblclick", (e) => {
        const refs = this.#cellRefs.get(ck(...this.#cellAt(e)));
        if (refs?.length) this.#openTile(refs[0].tile, false);
      });
    }

    #marqueeCells(d) {
      const clampX = (v) => Math.max(0, Math.min(this.cols - 1, v)), clampY = (v) => Math.max(0, Math.min(this.rows - 1, v));
      return [clampX(Math.min(d.start[0], d.end[0])), clampY(Math.min(d.start[1], d.end[1])),
        clampX(Math.max(d.start[0], d.end[0])), clampY(Math.max(d.start[1], d.end[1]))];
    }

    #hoverStatus(cell) {
      if (!this.#inside(cell)) { this.studio.slot("cell", ""); return; }
      const refs = this.#cellRefs.get(ck(...cell)) ?? [];
      const what = refs.length ? `${T.tileLabel(refs[0].tile)} (${T.refLabel(refs[0])})${refs.length > 1 ? ` +${refs.length - 1}` : ""}`
        : this.#artCells.has(ck(...cell)) ? "arte sin usar" : "vacía";
      this.studio.slot("cell", `[${cell[0]}, ${cell[1]}] · ${what}`);
    }

    /** After the selection changed: the inspector follows, and a cell used by one tile opens that tile. */
    #selectionChanged(fromClick = false) {
      if (fromClick && this.selection.size === 1) {
        const tiles = [...new Set((this.#cellRefs.get([...this.selection][0]) ?? []).map((r) => r.tile))];
        if (tiles.length === 1) this.tile = tiles[0];
      }
      this.#renderPanel();
      this.#renderTileList();
      this.#draw();
    }

    #selectedCells() { return sortCells([...this.selection].map(pk)); }

    // -----------------------------------------------------------------------------------------------------------------
    // Pixel edits. Each is one undo step over every layer (colour and maps) and the JSON coordinates it moves.

    /**
     * Moves the selection by (dx, dy) cells. Without copy it is a permutation: what was in the way goes to the cells
     * left behind, so nothing is ever lost, and every reference follows its art. With copy, the targets are overwritten
     * and no reference changes.
     */
    async #moveSelection(dx, dy, copy = false) {
      const src = this.#selectedCells();
      if (!src.length || (!dx && !dy)) return;
      const dst = src.map(([x, y]) => [x + dx, y + dy]);
      if (dst.some((c) => !this.#inside(c))) {
        this.studio.toast("Se sale de la hoja.", { kind: "warn", detail: "Agranda la hoja (panel Hoja) o mueve a otro sitio." });
        return;
      }
      const { w, h } = this.grid;

      if (copy) {
        const hits = dst.filter(([x, y]) => this.#artCells.has(ck(x, y)) && !this.selection.has(ck(x, y)));
        if (hits.length && !(await this.studio.confirm({
          title: "Copiar encima", danger: true, confirm: "Sobrescribir",
          message: `${hits.length} celda(s) de destino ya tienen arte y se perderá (Ctrl+Z lo devuelve).`,
        }))) return;
        const layers = [...this.img.layers.values()];
        const before = layers.map((l) => dst.map(([x, y]) => this.img.read(l, x * w, y * h, w, h)));
        const after = layers.map((l) => src.map(([x, y]) => this.img.read(l, x * w, y * h, w, h)));
        this.#run(`Copiar ${src.length} celda(s)`, () => this.#writeBlocks(layers, dst, after), () => this.#writeBlocks(layers, dst, before));
        this.#select(dst);
        return;
      }

      // The cells taken over hand their content to the cells vacated, in reading order.
      const srcSet = new Set(src.map((c) => ck(...c))), dstSet = new Set(dst.map((c) => ck(...c)));
      const displaced = sortCells(dst.filter((c) => !srcSet.has(ck(...c))));
      const vacated = sortCells(src.filter((c) => !dstSet.has(ck(...c))));
      const pairs = src.map((c, i) => [c, dst[i]]).concat(displaced.map((c, i) => [c, vacated[i]]));
      const plan = this.#refPlan(pairs);
      if (plan.conflicts.length) {
        this.studio.toast("No puedo mover sin partir un tile.", {
          kind: "bad", detail: plan.conflicts.slice(0, 4).map((r) => `${T.tileLabel(r.tile)} (${T.refLabel(r)})`).join(" · ")
            + " ocupa varias celdas o no encaja en esta cuadrícula. Selecciona todas sus celdas o cambia la cuadrícula.",
        });
        return;
      }
      const inverse = pairs.map(([a, b]) => [b, a]);
      const layers = [...this.img.layers.values()];
      this.#run(`Mover ${src.length} celda(s)`,
        () => { this.#permute(layers, pairs); for (const m of plan.moves) { m.coord[0] = m.to[0]; m.coord[1] = m.to[1]; } },
        () => { this.#permute(layers, inverse); for (const m of plan.moves) { m.coord[0] = m.from[0]; m.coord[1] = m.from[1]; } });
      this.#select(dst);
      const n = new Set(plan.moves.map((m) => m.ref.doc)).size;
      if (plan.moves.length) this.studio.setStatus(`Movido: ${plan.moves.length} coordenada(s) actualizadas en ${n} archivo(s).`, "ok");
    }

    // Where every reference into the moved cells ends up. A reference covering several cells moves only when they all
    // move together; one that would be split, or land off its own file's grid, is a conflict.
    #refPlan(pairs) {
      const delta = new Map(pairs.map(([a, b]) => [ck(...a), [b[0] - a[0], b[1] - a[1]]]));
      const moves = [], conflicts = [];
      for (const ref of this.#sheetRefs) {
        const ds = this.#cellsOf(ref).map((c) => delta.get(ck(...c)) ?? [0, 0]);
        if (ds.every(([x, y]) => !x && !y)) continue;
        const [dx, dy] = ds[0];
        if (!ds.every(([x, y]) => x === dx && y === dy)) { conflicts.push(ref); continue; }
        const nx = ref.coord[0] + (dx * this.grid.w) / ref.tw, ny = ref.coord[1] + (dy * this.grid.h) / ref.th;
        if (!Number.isInteger(nx) || !Number.isInteger(ny)) { conflicts.push(ref); continue; }
        moves.push({ ref, coord: ref.coord, from: [ref.coord[0], ref.coord[1]], to: [nx, ny] });
      }
      return { moves, conflicts };
    }

    #permute(layers, pairs) {
      const { w, h } = this.grid;
      for (const l of layers) {
        const blocks = pairs.map(([[x, y]]) => this.img.read(l, x * w, y * h, w, h));
        pairs.forEach(([, [x, y]], i) => this.img.write(l, x * w, y * h, w, h, blocks[i]));
      }
    }

    #writeBlocks(layers, cells, blocksPerLayer) {
      const { w, h } = this.grid;
      layers.forEach((l, li) => cells.forEach(([x, y], i) => this.img.write(l, x * w, y * h, w, h, blocksPerLayer[li][i])));
    }

    async #emptySelection() {
      const cells = this.#selectedCells();
      if (!cells.length) return;
      const refs = [...new Set(cells.flatMap((c) => this.#cellRefs.get(ck(...c)) ?? []))];
      if (refs.length && !(await this.studio.confirm({
        title: "Vaciar celdas", danger: true, confirm: "Vaciar",
        message: `${refs.length} referencia(s) seguirán apuntando aquí y se verán vacías en el juego: `
          + [...new Set(refs.map((r) => T.tileLabel(r.tile)))].slice(0, 8).join(", ") + ". Ctrl+Z lo devuelve.",
      }))) return;
      const { w, h } = this.grid;
      const layers = [...this.img.layers.values()];
      const before = layers.map((l) => cells.map(([x, y]) => this.img.read(l, x * w, y * h, w, h)));
      this.#run(`Vaciar ${cells.length} celda(s)`,
        () => { for (const l of layers) for (const [x, y] of cells) this.img.clear(l, x * w, y * h, w, h); },
        () => this.#writeBlocks(layers, cells, before));
    }

    /** Adds whole rows or columns of cells (transparent) to the sheet and its maps. */
    #growSheet(addCols, addRows) {
      const oldW = this.img.w, oldH = this.img.h;
      const newW = oldW + addCols * this.grid.w, newH = oldH + addRows * this.grid.h;
      this.#run(`Agrandar la hoja a ${newW}×${newH}`, () => this.img.resize(newW, newH), () => this.img.resize(oldW, oldH));
      this.studio.setStatus(`Hoja ${newW}×${newH}. Si el juego usa ResizeToPowerOfTwo no hace falta nada más.`, "ok");
    }

    #select(cells) {
      this.selection = new Set(cells.map((c) => ck(...c)));
      this.#renderPanel();
      this.#draw();
    }

    #run(label, redo, undo) {
      this.history.run({ label, redo, undo });
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Tile edits. A tile's keys are swapped as values, never cloned on undo, so the [x, y] arrays earlier steps hold stay
    // the ones in the file whatever is undone in between.

    #replaceTile(tile, next, label) {
      const before = Object.entries(tile), after = Object.entries(next);
      const put = (entries) => {
        for (const k of Object.keys(tile)) delete tile[k];
        for (const [k, v] of entries) tile[k] = v;
      };
      this.#run(label, () => put(after), () => put(before));
    }

    #setField(tile, key, value) {
      const next = {};
      let placed = false;
      for (const [k, v] of Object.entries(tile)) {
        if (k === key) { if (value !== undefined) next[k] = value; placed = true; } else next[k] = v;
      }
      if (!placed && value !== undefined) {
        // New keys go before "art", where a person would write them.
        const entries = Object.entries(next), at = entries.findIndex(([k]) => k === "art" || k === "parts");
        entries.splice(at < 0 ? entries.length : at, 0, [key, value]);
        this.#replaceTile(tile, Object.fromEntries(entries), `${T.tileLabel(tile)}: ${key}`);
        return;
      }
      this.#replaceTile(tile, next, `${T.tileLabel(tile)}: ${key}`);
    }

    #setCoord(coord, x, y, label) {
      const from = [coord[0], coord[1]];
      this.#run(label, () => { coord[0] = x; coord[1] = y; }, () => { coord[0] = from[0]; coord[1] = from[1]; });
    }

    #docOf(tile) {
      return this.docs.find((d) => d.root?.tiles.includes(tile)) ?? null;
    }

    #openTile(tile, reveal) {
      this.tile = tile;
      if (reveal) {
        const cells = this.#sheetRefs.filter((r) => r.tile === tile).flatMap((r) => this.#cellsOf(r));
        if (cells.length) { this.#select(cells); this.#reveal(cells); }
      }
      this.#renderPanel();
      this.#renderTileList();
      this.#draw();
    }

    async #deleteTile(tile) {
      const doc = this.#docOf(tile);
      if (!doc || !(await this.studio.confirm({
        title: "Quitar tile", danger: true, confirm: "Quitar",
        message: `«${T.tileLabel(tile)}» sale de ${doc.name}. Su arte se queda en la hoja. Si algo lo usa (estructuras, drops, crecimiento), el juego avisará al cargar.`,
      }))) return;
      const list = doc.root.tiles, index = list.indexOf(tile);
      this.tile = null;
      this.#run(`Quitar ${T.tileLabel(tile)}`, () => list.splice(index, 1), () => list.splice(index, 0, tile));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Placement from Crear

    #beginPlacement(p) {
      if (!this.project) {
        this.studio.toast("Abre la carpeta del proyecto para colocar en una hoja.", { kind: "warn" });
        return;
      }
      const go = async () => {
        if (p.sheetKey && p.sheetKey !== this.sheet?.key) {
          const target = this.sheets.find((s) => s.key === p.sheetKey);
          if (target) {
            if (!(await this.#settleUnsaved())) return;
            await this.#loadSheet(target, true);
          }
        }
        if (!this.img) {
          this.studio.toast("Elige una hoja para colocar.", { kind: "warn" });
          return;
        }
        if (p.size !== this.grid.w || p.size !== this.grid.h) {
          this.studio.toast(`Los sprites miden ${p.size} px y la cuadrícula de «${this.sheet.id}» ${this.grid.w}×${this.grid.h}.`, {
            kind: "warn", detail: "Cambia el tamaño del sprite en Crear o la cuadrícula en el panel Hoja.",
          });
          return;
        }
        this.pending = p;
        this.picking = null;
        this.#renderBanner();
        this.#findGap(false);
        this.canvas.focus();
      };
      go();
    }

    // Cells for n sprites from a start cell, in reading order, wrapping at the sheet's width.
    #placementCells([sx, sy]) {
      const cols = Math.max(1, this.cols);
      return Array.from({ length: this.pending.items.length }, (_, i) => {
        const flat = sy * cols + sx + i;
        return [flat % cols, Math.floor(flat / cols)];
      });
    }

    /** First start cell with room for every sprite, all empty. With go, places there at once. */
    #findGap(go) {
      const n = this.pending.items.length;
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) {
          const cells = this.#placementCells([x, y]);
          if (cells.every((c) => this.#inside(c) && !this.#artCells.has(ck(...c)) && !this.#cellRefs.has(ck(...c)))) {
            this.#hover = [x, y];
            this.#reveal(cells);
            if (go) this.#placeAt([x, y]);
            else this.#draw();
            return true;
          }
        }
      }
      if (go) {
        this.studio.toast(`No hay ${n} celda(s) libres seguidas.`, { kind: "warn", detail: "Usa «Añadir fila» o haz clic donde quieras sobrescribir." });
      }
      return false;
    }

    async #placeAt(start) {
      const p = this.pending;
      if (!p || start[0] < 0 || start[1] < 0) return;
      const cells = this.#placementCells(start);
      const rowsNeeded = Math.max(...cells.map(([, y]) => y)) + 1 - this.rows;
      if (rowsNeeded > 0) {
        if (!(await this.studio.confirm({ title: "Falta sitio", confirm: `Añadir ${rowsNeeded} fila(s)`,
          message: `No caben en la hoja desde [${start.join(", ")}]. ¿La agrando?` }))) return;
        this.#growSheet(0, rowsNeeded);
      }
      const busy = cells.filter((c) => this.#artCells.has(ck(...c)) || this.#cellRefs.has(ck(...c)));
      if (busy.length && !(await this.studio.confirm({
        title: "Colocar encima", danger: true, confirm: "Sobrescribir",
        message: `${busy.length} celda(s) ya tienen arte o un tile que las usa. Ctrl+Z lo devuelve.`,
      }))) return;

      const { w, h } = this.grid;
      const created = !this.img.has("_n") && p.items.some((i) => i.normal);
      const layersNow = () => [...this.img.layers.values()];
      let before = null;
      this.#run(`Colocar ${p.label}`, () => {
        if (created) this.img.ensure("_n");
        const layers = layersNow();
        before ??= layers.map((l) => cells.map(([x, y]) => this.img.read(l, x * w, y * h, w, h)));
        for (const l of layers) {
          cells.forEach(([x, y], i) => {
            const item = p.items[i];
            // The colour and its shape normals; the detail map and the old normals tool's inputs are emptied there, so
            // nothing of the sprite that was in the cell before is left in the maps.
            const data = l.suffix === "" ? item.color : l.suffix === "_n" ? item.normal : null;
            if (data) this.img.write(l, x * w, y * h, w, h, new Uint8ClampedArray(data));
            else this.img.clear(l, x * w, y * h, w, h);
          });
        }
      }, () => {
        const layers = layersNow();
        if (created) {
          this.img.drop("_n");
          this.#writeBlocks(layersNow(), cells, before.filter((_, i) => layers[i].suffix !== "_n"));
        } else {
          this.#writeBlocks(layers, cells, before);
        }
      });
      this.pending = null;
      this.placed = { p, cells };
      this.#select(cells);
      this.#renderBanner();
      this.#renderPanel();
      this.studio.setStatus(`Colocado ${p.label} en ${cells.length} celda(s) desde [${cells[0].join(", ")}]${created ? " · _n nuevo" : ""}. Crea su tile en el panel o guarda (Ctrl+S).`, "ok");
    }

    #cancel() {
      if (this.pending) { this.pending = null; this.#renderBanner(); this.#draw(); return; }
      if (this.picking) { this.picking = null; this.#renderPanel(); this.#draw(); return; }
      if (this.selection.size) { this.selection.clear(); this.#renderPanel(); this.#draw(); }
    }

    #renderBanner() {
      clear(this.banner);
      this.banner.hidden = !this.pending && !this.picking;
      if (this.pending) {
        const p = this.pending;
        this.banner.append(
          h("span", null, h("b", null, p.label), ` · ${p.items.length} celda(s) de ${p.size} px. Haz clic en la primera celda.`),
          h("button", { onclick: () => this.#findGap(true) }, "Primer hueco libre"),
          h("button", { class: "ghost", onclick: () => this.#cancel() }, "Cancelar (Esc)"));
      } else if (this.picking) {
        this.banner.append(h("span", null, `Haz clic en la celda para ${this.picking.label}.`),
          h("button", { class: "ghost", onclick: () => this.#cancel() }, "Cancelar (Esc)"));
      }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Inspector

    #renderPanel() {
      // Removing a focused field fires its change event, which edits and renders again from inside clear(): committing
      // it first lets that inner render finish before this one starts.
      if (this.panel.contains(document.activeElement)) document.activeElement.blur();
      const top = this.panel.scrollTop;
      clear(this.panel);
      if (!this.img) {
        this.panel.appendChild(h("div", { class: "empty-state" }, h("h3", null, "Atlas"),
          "Abre la carpeta del proyecto y elige una hoja. Aquí mueves, cambias y vacías celdas; sus mapas (_n, _d) y las coordenadas de los JSON se actualizan solos."));
        return;
      }
      this.panel.append(this.#sheetSection().el);
      if (this.placed) this.panel.append(this.#placedSection().el);
      this.panel.append(this.#selectionSection().el);
      if (this.tile && this.#docOf(this.tile)) this.panel.append(this.#tileSection(this.tile).el);
      else this.tile = null;
      this.panel.append(this.#reviewSection().el);
      this.panel.scrollTop = top;
      this.#renderBanner();
    }

    #sheetSection() {
      const s = this.sheet, img = this.img;
      const gw = h("input", { type: "number", min: 4, max: 1024, value: this.grid.w, title: "Ancho de celda" });
      const gh = h("input", { type: "number", min: 4, max: 1024, value: this.grid.h, title: "Alto de celda" });
      const apply = () => this.#setGrid(Number(gw.value) | 0, Number(gh.value) | 0);
      gw.onchange = apply; gh.onchange = apply;
      const maps = [...img.layers.values()].filter((l) => l.suffix).map((l) =>
        h("span", { class: ["badge", l.exists ? "plain" : "warn"], title: l.exists ? "Se mueve con la hoja" : "Nuevo: se crea al guardar" }, l.suffix));
      const ase = this.#asepriteOf(s);
      return section({ id: "at-sheet", title: "Hoja", extra: s.id },
        h("div", { class: "note mono" }, s.path),
        h("div", { class: "note" }, `${img.w}×${img.h} px · ${this.cols}×${this.rows} celdas · `, maps.length ? maps : "sin mapas"),
        ase ? h("p", { class: "note warn" }, "Tiene ", h("b", null, ase.name), ": si vuelves a exportar desde Aseprite, se pisa lo de aquí.") : null,
        h("div", { class: "field" }, h("label", null, "Cuadrícula"), h("div", { class: "pair" }, gw, gh)),
        h("div", { class: "row" },
          h("button", { class: "grow", onclick: () => this.#growSheet(0, 1) }, "Añadir fila"),
          h("button", { class: "grow", onclick: () => this.#growSheet(1, 0) }, "Añadir columna")));
    }

    #selectionSection() {
      const cells = this.#selectedCells();
      if (!cells.length) {
        return section({ id: "at-sel", title: "Selección" },
          h("p", { class: "note" }, "Clic en una celda para ver qué tiles la usan. Arrastra para mover (cambia el sitio con lo que haya; ",
            h("b", null, "Alt"), " copia). Arrastra en vacío para seleccionar varias. ", h("b", null, "Supr"), " vacía, flechas mueven."));
      }
      const refs = [...new Set(cells.flatMap((c) => this.#cellRefs.get(ck(...c)) ?? []))];
      const list = h("div", { class: "at-refs" }, refs.length ? refs.map((r) => h("div", {
        class: ["at-ref", r.tile === this.tile && "active"], title: `${T.tileId(r.tile)} · ${r.doc.name}`,
        onclick: () => this.#openTile(r.tile, false),
      }, h("span", { class: "grow" }, T.tileLabel(r.tile)), h("span", { class: "faint" }, `[${r.coord.join(", ")}] ${T.refLabel(r)}`)))
        : h("p", { class: "note" }, cells.some((c) => this.#artCells.has(ck(...c))) ? "Arte que ningún tile usa." : "Celda vacía."));
      const single = cells.length === 1;
      return section({ id: "at-sel", title: "Selección", extra: single ? `[${cells[0].join(", ")}]` : `${cells.length} celdas` },
        list,
        single ? this.#newTileForm(cells, null) : null,
        h("button", { class: "danger", onclick: () => this.#emptySelection() }, "Vaciar celdas (Supr)"));
    }

    // The tile files that can hold a tile drawing from this sheet: those whose sheet it is first.
    #docOptions() {
      const key = T.sheetKey(this.sheet.id);
      const ok = this.docs.filter((d) => d.root);
      ok.sort((a, b) => (T.docSheet(b) === key) - (T.docSheet(a) === key) || a.name.localeCompare(b.name));
      return ok.map((d) => [d.path, d.name + (T.docSheet(d) === key ? "" : " (con sheetId)")]);
    }

    /**
     * "Nuevo tile" on cells: one cell for a selection, or what a placement put down (builder makes the art from its
     * cells). The art is written in the file's own cell size, so it must line up with the file's grid.
     */
    #newTileForm(cells, placement) {
      const details = h("details", { class: "at-new", open: !!placement });
      const opts = this.#docOptions();
      if (!opts.length) return h("p", { class: "note" }, "No hay archivos de tiles (Data/Tiles/*.json) donde crear uno.");
      const base = placement?.p.name ?? "";
      const nameIn = h("input", { type: "text", value: base, placeholder: "Nombre (p. ej. Oak Leaves)", spellcheck: false });
      const idIn = h("input", { type: "text", placeholder: "id: del nombre", spellcheck: false });
      const fileSel = select({ options: opts, value: opts[0][0] });
      const kindSel = select({ options: TILE_KINDS.map(([k, t]) => [k, t]), value: placement?.p.kind ?? "block" });
      const preview = h("pre", { class: "at-json" });
      const error = h("p", { class: "note bad" });

      const build = () => {
        const doc = this.docs.find((d) => d.path === fileSel.get());
        const [tw, th] = T.docCell(doc);
        const coords = cells.map(([x, y]) => [(x * this.grid.w) / tw, (y * this.grid.h) / th]);
        if (coords.some(([x, y]) => !Number.isInteger(x) || !Number.isInteger(y))) {
          throw new Error(`${doc.name} usa celdas de ${tw}×${th}: estas celdas no caen en su cuadrícula.`);
        }
        const name = nameIn.value.trim();
        if (!name) throw new Error("Ponle un nombre.");
        const id = idIn.value.trim() || T.deriveIdPath(name);
        if (!/^[a-z0-9_]+(:[a-z0-9_/]+)?$/.test(id)) throw new Error("El id solo lleva minúsculas, números y _ .");
        const tile = { id, name, ...structuredClone(TILE_KINDS.find(([k]) => k === kindSel.get())[2]) };
        if (T.docSheet(doc) !== T.sheetKey(this.sheet.id)) tile.sheetId = this.sheet.id;
        Object.assign(tile, placement?.p.buildTile ? placement.p.buildTile(coords) : { art: { default: { front: coords[0] } } });
        return { doc, tile };
      };
      const refresh = () => {
        try {
          const { tile } = build();
          preview.textContent = T.formatJson(tile);
          const taken = this.docs.some((d) => d.root?.tiles.some((t) => t && T.tileId(t) === T.tileId(tile)));
          error.textContent = taken ? `Ya existe un tile «${T.tileId(tile)}».` : "";
        } catch (err) {
          preview.textContent = "";
          error.textContent = err.message;
        }
      };
      for (const el of [nameIn, idIn]) el.addEventListener("input", refresh);
      fileSel.input.addEventListener("change", refresh);
      kindSel.input.addEventListener("change", refresh);
      const create = () => {
        refresh();
        if (error.textContent) return;
        const { doc, tile } = build();
        const list = doc.root.tiles;
        this.tile = tile;
        if (placement) this.placed = null;
        this.#run(`Nuevo tile ${tile.name}`, () => list.push(tile), () => list.splice(list.indexOf(tile), 1));
        this.studio.setStatus(`Tile «${tile.id}» añadido a ${doc.name}. Guarda para escribirlo (Ctrl+S).`, "ok");
      };
      refresh();
      details.append(
        h("summary", null, placement ? "Crear su tile" : "Nuevo tile en esta celda"),
        h("div", { class: "field" }, h("label", null, "Nombre"), nameIn),
        h("div", { class: "field" }, h("label", null, "Id"), idIn),
        h("div", { class: "field" }, h("label", null, "Archivo"), fileSel.el),
        h("div", { class: "field" }, h("label", null, "Clase"), kindSel.el),
        preview, error,
        h("button", { class: "primary", onclick: create }, "Crear tile"));
      return details;
    }

    #placedSection() {
      const { p, cells } = this.placed;
      const snippet = p.snippet?.(cells) ?? "";
      return section({ id: "at-placed", title: "Recién colocado", extra: h("button", { class: "ghost", title: "Cerrar", onclick: () => { this.placed = null; this.#renderPanel(); } }, "×") },
        h("p", { class: "note" }, h("b", null, p.label), ` en ${cells.length} celda(s) desde [${cells[0].join(", ")}].`),
        p.buildTile ? this.#newTileForm(cells, this.placed)
          : h("div", null, h("p", { class: "note" }, p.why ?? "Esto no es un solo tile: copia su arte al JSON que toque."),
            h("textarea", { class: "at-raw", rows: 6, readonly: true, value: snippet })));
    }

    #tileSection(tile) {
      const doc = this.#docOf(tile);
      const fields = FORM_FIELDS.map((f) => this.#formField(tile, f));

      // The art: every state and side of the tile and its parts, with their cells.
      const rows = T.collectRefs([{ ...doc, root: { ...doc.root, tiles: [tile] } }]);
      const artRows = rows.map((r) => {
        const xIn = h("input", { type: "number", min: 0, value: r.coord[0] });
        const yIn = h("input", { type: "number", min: 0, value: r.coord[1] });
        const set = () => this.#setCoord(r.coord, Number(xIn.value) | 0, Number(yIn.value) | 0, `${T.tileLabel(tile)}: arte ${T.refLabel(r)}`);
        xIn.onchange = set; yIn.onchange = set;
        const pick = h("button", { class: "icon", title: "Elegir la celda en la hoja", onclick: () => {
          this.picking = { label: `${T.tileLabel(tile)} · ${T.refLabel(r)}`, apply: (cell) => {
            const x = (cell[0] * this.grid.w) / r.tw, y = (cell[1] * this.grid.h) / r.th;
            if (!Number.isInteger(x) || !Number.isInteger(y)) { this.studio.toast("Esa celda no cae en la cuadrícula del archivo.", { kind: "warn" }); return; }
            this.#setCoord(r.coord, x, y, `${T.tileLabel(tile)}: arte ${T.refLabel(r)}`);
          } };
          this.#renderBanner();
        } }, "⌖");
        const off = r.sheet !== T.sheetKey(this.sheet.id);
        return h("div", { class: ["at-art", off && "off"], title: off ? "En otra hoja" : "" },
          h("span", { class: "lbl" }, T.refLabel(r)), xIn, yIn, pick);
      });

      const raw = h("textarea", { class: "at-raw", rows: 12, spellcheck: false, value: T.formatJson(tile) });
      const rawErr = h("p", { class: "note bad" });
      const applyRaw = () => {
        let next;
        try {
          next = JSON.parse(raw.value);
        } catch (err) {
          rawErr.textContent = "JSON no válido: " + err.message;
          return;
        }
        const problems = T.validateTile(next);
        if (problems.length) { rawErr.textContent = problems.join(" "); return; }
        rawErr.textContent = "";
        this.#replaceTile(tile, next, `${T.tileLabel(tile)}: JSON`);
      };

      return section({ id: "at-tile", title: "Tile", extra: T.tileId(tile) },
        h("p", { class: "note" }, "En ", h("b", null, doc.name), "."),
        fields,
        h("div", { class: "at-sub" }, "Arte ", h("span", { class: "faint" }, "(x, y en celdas del archivo)")),
        artRows.length ? artRows : h("p", { class: "note" }, "Sin arte."),
        this.#addArtRow(tile, doc),
        h("div", { class: "at-sub" }, "JSON"),
        raw, rawErr,
        h("div", { class: "row" },
          h("button", { class: "grow", onclick: applyRaw, title: "Sustituye el tile por este JSON (se puede deshacer)" }, "Aplicar JSON"),
          h("button", { onclick: () => this.#openTile(tile, true), title: "Seleccionar sus celdas" }, "Ver celdas"),
          h("button", { class: "danger", onclick: () => this.#deleteTile(tile) }, "Quitar")));
    }

    #formField(tile, f) {
      const current = tile[f.key];
      let input;
      const commit = (value) => {
        if (f.key === "id" || f.key === "name") {
          const next = { ...tile, [f.key]: value };
          if (!next.id && !next.name) { this.studio.toast("Un tile necesita id o nombre.", { kind: "warn" }); this.#renderPanel(); return; }
          const clash = this.docs.some((d) => d.root?.tiles.some((t) => t && t !== tile && T.tileId(t) === T.tileId(next)));
          if (clash) { this.studio.toast(`Ya existe «${T.tileId(next)}».`, { kind: "bad" }); this.#renderPanel(); return; }
          if (f.key === "id" || !tile.id) {
            this.studio.toast("Id cambiado: lo que lo nombre (estructuras, crecimiento, biomas, drops) hay que cambiarlo a mano.", { kind: "warn" });
          }
        }
        this.#setField(tile, f.key, value);
      };
      if (f.kind === "select") {
        const opts = f.options.map((o) => [o, o || "(por defecto)"]);
        if (current !== undefined && !f.options.includes(current)) opts.push([String(current), String(current)]);
        input = select({ options: opts, value: current === undefined ? "" : String(current), onChange: (v) => commit(v || undefined) }).input;
      } else {
        const text = f.kind === "tags" ? (Array.isArray(current) ? current.join(", ") : "") : current ?? "";
        input = h("input", { type: f.kind === "number" ? "number" : "text", value: String(text), placeholder: f.hint ?? "", spellcheck: false, step: "any" });
        input.addEventListener("change", () => {
          const v = input.value.trim();
          if (f.kind === "number") commit(v === "" ? undefined : Number(v));
          else if (f.kind === "tags") commit(v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
          else commit(v || undefined);
        });
      }
      return h("div", { class: "field" }, h("label", null, f.label), input);
    }

    // Adds a state the tile has no art for yet, on the selected cell.
    #addArtRow(tile, doc) {
      const have = new Set(Object.keys(tile.art ?? {}).map((s) => s.toLowerCase()));
      const free = T.STATES.filter((s) => !have.has(s));
      const options = [["", "+ Añadir arte…"], ...free.map((s) => [s, T.STATE_LABEL[s]]),
        ...[...have].filter((s) => tile.art[s] && !tile.art[s].back && !Array.isArray(tile.art[s])).map((s) => [s + ":back", T.STATE_LABEL[s] + " · espalda"])];
      if (options.length === 1 || tile.parts) return null;
      const sel = select({ options, value: "", onChange: (v) => {
        if (!v) return;
        const cell = this.#selectedCells()[0];
        if (!cell) { this.studio.toast("Selecciona antes la celda en la hoja.", { kind: "warn" }); sel.set(""); return; }
        const [tw, th] = T.docCell(doc);
        const coord = [(cell[0] * this.grid.w) / tw, (cell[1] * this.grid.h) / th];
        if (!coord.every(Number.isInteger)) { this.studio.toast("Esa celda no cae en la cuadrícula del archivo.", { kind: "warn" }); sel.set(""); return; }
        const [state, side] = v.split(":");
        const art = { ...(tile.art ?? {}) };
        art[state] = side ? { ...art[state], back: coord } : { front: coord };
        this.#setField(tile, "art", art);
      } });
      sel.input.title = "Usa la celda seleccionada";
      return sel.el;
    }

    #reviewSection() {
      const broken = this.#sheetRefs.filter((r) => !this.#refHasArt(r));
      const orphans = [...this.#artCells].filter((k) => !this.#cellRefs.has(k));
      const dupes = T.duplicateIds(this.docs);
      const errors = this.docs.filter((d) => d.error);
      const item = (text, cells, kind) => h("div", { class: ["at-issue", kind], onclick: cells ? () => { this.#select(cells); this.#reveal(cells); } : null }, text);
      const list = [
        ...broken.map((r) => item(`${T.tileLabel(r.tile)} (${T.refLabel(r)}) → [${r.coord.join(", ")}] vacía`, this.#cellsOf(r), "bad")),
        orphans.length ? item(`${orphans.length} celda(s) con arte que ningún tile usa`, orphans.map(pk), "warn") : null,
        ...dupes.map((id) => item(`Id repetido: ${id} (el juego no carga)`, null, "bad")),
        ...errors.map((d) => item(`${d.name}: ${d.error}`, null, "bad")),
      ].filter(Boolean);
      return section({ id: "at-review", title: "Revisión", extra: list.length ? String(list.length) : "todo bien" },
        list.length ? list : h("p", { class: "note" }, "Cada tile de esta hoja apunta a arte, y no hay ids repetidos."));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Saving

    /** Writes the sheet's changed layers and every changed tile file. Resolves true when everything was written. */
    async save() {
      if (!this.img || !this.history.dirty) return true;
      const dupes = T.duplicateIds(this.docs);
      if (dupes.length && !(await this.studio.confirm({ title: "Ids repetidos", confirm: "Guardar igual", danger: true,
        message: `${dupes.join(", ")} está más de una vez: el juego no cargará hasta que lo arregles.` }))) return false;
      const changed = await this.#changedOnDisk();
      if (changed.length && !(await this.studio.confirm({ title: "Cambiado fuera del Atlas", confirm: "Guardar igual", danger: true,
        message: `${changed.join(", ")} cambió en disco después de abrirlo aquí (Crear, Aseprite, un editor…). Guardar pisa esos cambios; cancela para guardarlos aparte o descartar los de aquí.` }))) return false;
      const backups = [];
      try {
        const written = await this.studio.busy(this.#write(backups));
        this.history.markSaved();
        this.studio.refreshDirty();
        this.studio.toast("Guardado " + (written.length ? written.join(", ") : "(nada cambió)"), {
          kind: "ok", action: backups.length ? { label: "Restaurar anterior", run: () => this.#restore(backups) } : undefined,
        });
        this.studio.setStatus("Guardado: " + written.join(", ") + ".", "ok");
        return true;
      } catch (err) {
        this.studio.toast("No pude guardar todo.", { kind: "bad", detail: err.message + (backups.length ? " · Lo ya escrito se puede restaurar." : ""),
          action: backups.length ? { label: "Restaurar", run: () => this.#restore(backups) } : undefined });
        return false;
      }
    }

    async #write(backups) {
      const { written, created } = await this.img.save(this.project, backups);
      // A map the sheet did not have must also be built by the content pipeline, with the sheet's own settings.
      for (const suffix of created) {
        const s = this.sheet;
        if (!s.mgcb || !s.rel) { written.push(`(añade ${stripExt(s.name)}${suffix}.png al .mgcb a mano)`); continue; }
        const before = await readText(s.mgcb.handle);
        const { text, result } = addToMgcb(before, s.rel, stripExt(s.name) + suffix + ".png");
        if (result !== "already") {
          backups.push({ name: s.mgcb.name, path: s.mgcb.path, dir: s.mgcb.dir, previous: await s.mgcb.handle.getFile() });
          await writeHandle(s.mgcb.handle, text);
          written.push(s.mgcb.name);
        }
      }
      for (const doc of this.docs) {
        if (!T.isDocDirty(doc)) continue;
        const text = T.serialize(doc);
        backups.push({ name: doc.entry.name, path: doc.path, dir: doc.entry.dir, previous: await doc.entry.handle.getFile() });
        await writeHandle(doc.entry.handle, text);
        doc.baseline = text;
        doc.stamp = (await doc.entry.handle.getFile()).lastModified;
        written.push(doc.name);
      }
      this.sheet.has = Object.fromEntries(["n", "d", "faces", "height"].map((k) => [k, this.img.has("_" + k)]));
      this.#renderSheets();
      return written;
    }

    // Puts the files back as they were before the save, then reloads, since memory now holds the newer state.
    async #restore(backups) {
      try {
        for (const b of backups.slice().reverse()) {
          if (b.previous) {
            const handle = await writeInDir(b.dir, b.name, b.previous);
            this.project.addFile(b.path, handle, b.dir);
          } else {
            await b.dir.removeEntry(b.name).catch(() => {});
            this.project.files.delete(b.path.toLowerCase());
          }
        }
        this.history.clear();
        await this.studio.busy(this.#loadDocs());
        const sheet = this.sheets.find((s) => s.key === this.sheet?.key);
        if (sheet) await this.#loadSheet(sheet, false);
        this.studio.toast("Archivos restaurados.", { kind: "ok" });
      } catch (err) {
        this.studio.toast("No pude restaurar.", { kind: "bad", detail: err.message });
      }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Commands

    #registerCommands() {
      const has = () => !!this.img;
      const sel = () => this.selection.size > 0 && !this.pending;
      const arrow = (dx, dy) => () => this.#moveSelection(dx, dy, false);
      this.studio.commands.registerAll([
        { id: "atlas.save", title: "Guardar hoja y JSON", group: "Atlas", keys: ["Ctrl+S"], whileTyping: true, enabled: () => this.history.dirty, run: () => this.save() },
        { id: "atlas.undo", title: "Deshacer", group: "Atlas", keys: ["Ctrl+Z"], enabled: () => this.history.canUndo, run: () => this.history.undo() },
        { id: "atlas.redo", title: "Rehacer", group: "Atlas", keys: ["Ctrl+Y", "Ctrl+Shift+Z"], enabled: () => this.history.canRedo, run: () => this.history.redo() },
        { id: "atlas.empty", title: "Vaciar celdas seleccionadas", group: "Atlas", keys: ["Delete", "Backspace"], enabled: sel, run: () => this.#emptySelection() },
        { id: "atlas.cancel", title: "Cancelar / quitar selección", group: "Atlas", keys: ["Escape"], hidden: true, run: () => this.#cancel() },
        { id: "atlas.fit", title: "Ver la hoja entera", group: "Atlas", keys: ["F"], enabled: has, run: () => this.#fit() },
        { id: "atlas.marks", title: "Mostrar/ocultar marcas", group: "Atlas", keys: ["M"], enabled: has, run: () => this.#toggleMarks() },
        { id: "atlas.all", title: "Seleccionar todo el arte", group: "Atlas", keys: ["Ctrl+A"], enabled: has, run: () => this.#select([...this.#artCells].map(pk)) },
        { id: "atlas.left", title: "Mover selección a la izquierda", group: "Atlas", keys: ["ArrowLeft"], enabled: sel, hidden: true, run: arrow(-1, 0) },
        { id: "atlas.right", title: "Mover selección a la derecha", group: "Atlas", keys: ["ArrowRight"], enabled: sel, hidden: true, run: arrow(1, 0) },
        { id: "atlas.up", title: "Mover selección arriba", group: "Atlas", keys: ["ArrowUp"], enabled: sel, hidden: true, run: arrow(0, -1) },
        { id: "atlas.down", title: "Mover selección abajo", group: "Atlas", keys: ["ArrowDown"], enabled: sel, hidden: true, run: arrow(0, 1) },
        { id: "atlas.gap", title: "Colocar en el primer hueco libre", group: "Atlas", enabled: () => !!this.pending, run: () => this.#findGap(true) },
      ], this.id);
    }

    extraKeys() {
      const group = "Atlas · ratón";
      return [
        { group, title: "Mover celdas (intercambia con lo que haya)", keys: ["Arrastrar"] },
        { group, title: "Copiar celdas", keys: ["Alt+Arrastrar"] },
        { group, title: "Añadir / quitar de la selección", keys: ["Shift+Clic", "Ctrl+Clic"] },
        { group, title: "Abrir el tile de la celda", keys: ["Doble clic"] },
      ];
    }
  }

  function toCanvas(rgba, size) {
    const c = new OffscreenCanvas(size, size);
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
    return c;
  }

  Aura.atlasTool = { atlasTool };
})(window.Aura ??= {});
