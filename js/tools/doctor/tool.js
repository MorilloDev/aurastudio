"use strict";

(function (Aura) {
  const { clear, h } = Aura.dom;
  const { DataIndex } = Aura.dataIndex;
  const { decodePng } = Aura.png;
  const { toast } = Aura.toast;

  /**
   * Revisión: the questions that cross files, which until now nobody asked.
   *
   * Every other tab checks its own corner — the Atlas its references, Biomas its tiles — so a recipe pointing at an
   * item that does not exist, an icon aiming at an empty cell and a tile with no translation could all sit in the
   * project for weeks without anything saying a word. This reads Data/ whole and says what is wrong, what uses what,
   * and what each station can make at each tier.
   */
  const TIERS = [["crude", "Crude"], ["sturdy", "Sturdy"], ["mastered", "Mastered"]];

  class DoctorTool {
    id = "doctor";
    title = "Revisión";
    #index = null;
    #sheetArt = new Map();

    mount(host, studio) {
      this.studio = studio;
      this.host = host;
      this.tabs = h("div", { class: "row" });
      this.body = h("div", { class: "doc-body" });
      this.runBtn = h("button", { class: "primary", onclick: () => this.run() }, "Revisar");
      this.summary = h("span", { class: "note" }, "Sin revisar todavía.");
      host.append(
        h("div", { class: "tool-bar" }, this.runBtn, this.summary),
        h("div", { class: "tool-main" }, this.tabs, this.body));
      this.view = "problems";
      this.#buildTabs();
      this.#render();
      studio.commands.registerAll([
        { id: "doctor.run", title: "Revisar los datos", group: "Revisión", keys: ["Ctrl+R"], enabled: () => !!studio.project, run: () => this.run() },
        { id: "doctor.uses", title: "¿Dónde se usa este id?", group: "Revisión", run: () => this.ask() },
      ], this.id);
    }

    /** From the command palette: asks for an id and shows everywhere it turns up. */
    async ask() {
      const id = await this.studio.prompt({ title: "¿Dónde se usa?", message: "Id de un item o de un tile", placeholder: "iron_blade" });
      if (!id) return;
      this.studio.activate(this.id);
      if (!this.#index) await this.run();
      this.view = "uses";
      this.#buildTabs();
      this.#render();
      const input = this.body.querySelector("input[type=search]");
      if (input) { input.value = id; input.dispatchEvent(new Event("input")); input.focus(); }
    }

    onProject() {
      this.#index = null;
      this.#sheetArt.clear();
      this.summary.textContent = "Sin revisar todavía.";
      this.#render();
    }

    isDirty() { return false; }

    #buildTabs() {
      const tab = (id, label) => h("button", {
        class: ["chip", this.view === id && "on"],
        onclick: (e) => {
          this.view = id;
          for (const b of e.target.parentElement.children) b.classList.toggle("on", b === e.target);
          this.#render();
        },
      }, label);
      clear(this.tabs).append(tab("problems", "Problemas"), tab("uses", "Dónde se usa"), tab("crafting", "Crafteo"));
    }

    // ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────

    async run() {
      if (!this.studio.project) { toast("Abre la carpeta del proyecto primero.", { kind: "warn" }); return; }
      await this.studio.busy((async () => {
        this.#index = await DataIndex.build(this.studio.project);
        await this.#readSheetArt();
      })());
      const n = this.#problems().length;
      this.summary.textContent = n
        ? `${n} cosa(s) que mirar · ${this.#index.tiles.size} tiles, ${this.#index.items.size} items, ${this.#index.recipes.length} recetas`
        : `Todo en orden · ${this.#index.tiles.size} tiles, ${this.#index.items.size} items, ${this.#index.recipes.length} recetas`;
      this.#render();
    }

    /** Which cells of each sheet have pixels, so an icon pointing at a blank square can be told apart from a wrong one. */
    async #readSheetArt() {
      for (const [id, sheet] of this.#index.sheets) {
        if (this.#sheetArt.has(id)) continue;
        try {
          const file = await sheet.entry.handle.getFile();
          const img = await decodePng(file);
          const cols = Math.floor(img.w / 64), rows = Math.floor(img.h / 64);
          const filled = new Uint8Array(cols * rows);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              let any = 0;
              for (let y = 0; y < 64 && !any; y++) {
                const base = ((r * 64 + y) * img.w + c * 64) * 4;
                for (let x = 0; x < 64; x++) if (img.rgba[base + x * 4 + 3] > 0) { any = 1; break; }
              }
              filled[r * cols + c] = any;
            }
          }
          this.#sheetArt.set(id, { cols, rows, filled });
        } catch {
          this.#sheetArt.set(id, null);
        }
      }
    }

    // ── Views ──────────────────────────────────────────────────────────────────────────────────────────────────

    #problems() {
      return this.#index ? Aura.dataIndex.problems(this.#index, this.#sheetArt) : [];
    }

    #render() {
      clear(this.body);
      if (!this.#index) {
        this.body.append(h("div", { class: "empty-state" }, "Pulsa «Revisar» para leer Data/ y comprobarlo todo."));
        return;
      }
      if (this.view === "problems") return this.#renderProblems();
      if (this.view === "uses") return this.#renderUses();
      return this.#renderCrafting();
    }

    #renderProblems() {
      const all = this.#problems();
      if (!all.length) { this.body.append(h("div", { class: "empty-state" }, "Nada que corregir.")); return; }
      const order = { error: 0, aviso: 1, nota: 2 };
      all.sort((a, b) => order[a.kind] - order[b.kind] || a.where.localeCompare(b.where));
      const filter = h("input", { type: "search", placeholder: "Filtrar…", oninput: () => paint() });
      const list = h("div", { class: "doc-list" });
      const paint = () => {
        const q = filter.value.trim().toLowerCase();
        clear(list);
        const rows = all.filter((p) => !q || (p.where + p.what).toLowerCase().includes(q));
        for (const p of rows.slice(0, 500)) {
          list.append(h("div", { class: ["doc-row", p.kind] },
            h("span", { class: ["doc-kind", p.kind] }, p.kind),
            h("span", { class: "doc-where" }, p.where),
            h("span", { class: "doc-what" }, p.what)));
        }
        if (rows.length > 500) list.append(h("p", { class: "note" }, `… y ${rows.length - 500} más.`));
      };
      paint();
      const counts = ["error", "aviso", "nota"].map((k) => `${all.filter((p) => p.kind === k).length} ${k}(s)`).join(" · ");
      this.body.append(h("div", { class: "row" }, filter, h("span", { class: "note" }, counts)), list);
    }

    #renderUses() {
      const ix = this.#index;
      const input = h("input", { type: "search", placeholder: "id de un item o un tile (tanning_rack, iron_blade…)", oninput: () => paint() });
      const out = h("div", { class: "doc-uses" });
      const paint = () => {
        const q = input.value.trim().toLowerCase();
        clear(out);
        if (!q) { out.append(h("div", { class: "empty-state" }, "Escribe un id para ver dónde aparece.")); return; }
        const ids = [...new Set([...ix.items.keys(), ...ix.tiles.keys()])].filter((id) => id.toLowerCase().includes(q)).slice(0, 40);
        if (!ids.length) { out.append(h("div", { class: "empty-state" }, "Ningún id coincide.")); return; }
        for (const id of ids) {
          const u = ix.uses(id);
          const lines = [];
          if (u.asOutput.length) lines.push(`Lo hacen: ${u.asOutput.map((r) => `${r.station}/${r.id}${r.minTier !== "crude" ? ` (${r.minTier})` : ""}`).join(", ")}`);
          if (u.asIngredient.length) lines.push(`Entra en: ${u.asIngredient.map((r) => `${r.station}/${r.id}`).join(", ")}`);
          if (u.drops.length) lines.push(`Lo sueltan: ${u.drops.map((d) => d.species).join(", ")}`);
          if (u.brokenFrom.length) lines.push(`Sale al romper: ${u.brokenFrom.map((d) => d.tile).join(", ")}`);
          if (u.placesTile) lines.push(`Coloca el tile: ${u.placesTile}`);
          if (u.placedBy.length) lines.push(`Lo coloca el item: ${u.placedBy.join(", ")}`);
          lines.push(u.texts.length ? `Textos: ${u.texts.map((t) => `${t.lang} "${t.text}"`).join(" · ")}` : "Sin textos");
          out.append(h("div", { class: "doc-use" },
            h("div", { class: "doc-use-head" }, h("strong", {}, id), h("span", { class: "note" }, ix.label(id))),
            ...lines.map((l) => h("div", { class: "doc-use-line" }, l))));
        }
      };
      paint();
      this.body.append(h("div", { class: "row" }, input), out);
    }

    #renderCrafting() {
      const ix = this.#index;
      const stations = [...ix.byStation().entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const grid = h("div", { class: "doc-stations" });
      for (const [station, tiers] of stations) {
        const cols = TIERS.map(([key, label]) => h("div", { class: "doc-tier" },
          h("div", { class: "doc-tier-head" }, label, h("span", { class: "note" }, `${tiers[key].length}`)),
          ...tiers[key].map((r) => h("div", { class: "doc-recipe", title: r.needs.map((n) => ix.label(n)).join(" + ") },
            ix.label(r.gives[0] ?? r.id)))));
        grid.append(h("div", { class: "doc-station" }, h("div", { class: "doc-sub" }, station), h("div", { class: "row" }, ...cols)));
      }
      this.body.append(grid);
    }
  }

  Aura.doctorTool = { doctorTool: () => new DoctorTool() };
})(window.Aura ??= {});
