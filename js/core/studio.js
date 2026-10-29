"use strict";

(function (Aura) {
  const { clear, h } = Aura.dom;
  const { Emitter } = Aura.emitter;
  const { hasFolderAccess } = Aura.fs;
  const { Project } = Aura.project;
  const { prefs } = Aura.storage;
  const { Commands, prettyKey } = Aura.commands;
  const { confirmDialog, promptDialog, unsavedDialog } = Aura.dialog;
  const { toast } = Aura.toast;

  /**
   * The frame every tool lives in. It owns what tools share — the project folder, the command list, notifications, the
   * status bar — and switches between tools. A tool is an object:
   *
   *   { id, title, legacy?,
   *     mount(host, studio)      called once, the first time the tool is shown
   *     activate() / deactivate()
   *     onProject(project)       a project was opened or rescanned (also called at mount if one is open)
   *     isDirty() -> bool        unsaved work (tab dot, close warning)
   *     dirtyLabel() -> string   what has unsaved work, for the warning }
   *
   * Tools talk to the studio through this object and to each other through its events, never directly.
   */
  class Studio extends Emitter {
    tools = [];
    active = null;
    project = null;
    commands = new Commands();
    #busy = 0;
    #slots = new Map();

    constructor(root) {
      super();
      this.root = root;
      this.#build();
      this.commands.attach();
      this.#registerCommands();
      window.addEventListener("beforeunload", (e) => {
        if (Aura.lang?.dirty || this.tools.some((t) => t.mounted && t.isDirty?.())) {
          e.preventDefault();
          e.returnValue = "";
        }
      });
      window.addEventListener("hashchange", () => this.#fromHash());
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Layout

    #build() {
      this.tabs = h("nav", { class: "shell-tabs", role: "tablist" });
      this.projectName = h("span", { class: "name" });
      this.openButton = h("button", { onclick: () => this.pickProject(), title: "Abrir la carpeta del proyecto (Ctrl+O)" }, "Abrir carpeta");
      this.reopenButton = h("button", { class: "primary", hidden: true, onclick: () => this.reopenProject() });
      this.rescanButton = h("button", { class: "icon ghost", hidden: true, title: "Volver a leer la carpeta (archivos nuevos o cambiados fuera)", onclick: () => this.rescan() }, "⟳");
      this.body = h("main", { class: "shell-body" });
      this.message = h("span", { class: "msg" }, "Listo.");
      this.slotsEl = h("span", { class: "row", style: "gap: 14px" });
      this.statusBar = h("footer", { class: "shell-status" },
        h("span", { class: "spinner" }),
        this.message,
        this.slotsEl,
        h("span", { class: "help", title: "Paleta de comandos", onclick: () => this.commands.openPalette() }, h("span", { class: "kbd" }, prettyKey("Ctrl+K")), " comandos"),
        h("span", { class: "help", title: "Atajos de teclado", onclick: () => this.openKeysheet() }, h("span", { class: "kbd" }, "?"), " atajos"));

      clear(this.root).append(
        h("header", { class: "shell-head" },
          h("div", { class: "shell-logo" }, h("i"), "Aura Studio"),
          this.tabs,
          h("span", { class: "shell-spacer" }),
          h("div", { class: "shell-project" }, this.projectName, this.rescanButton, this.reopenButton, this.openButton)),
        this.body,
        this.statusBar);
    }

    addTool(tool) {
      tool.host = h("section", { class: "tool-host", role: "tabpanel", "aria-label": tool.title });
      tool.tab = h("button", {
        class: "shell-tab", role: "tab", title: tool.title + (tool.legacy ? " (versión anterior, aún sin migrar)" : ""),
        onclick: () => this.activate(tool.id),
      }, h("span", { class: "dot" }), tool.title, tool.legacy ? h("span", { class: "legacy" }, "v1") : null);
      this.tabs.appendChild(tool.tab);
      this.body.appendChild(tool.host);
      this.tools.push(tool);
    }

    activate(id) {
      const tool = this.tools.find((t) => t.id === id) ?? this.tools[0];
      if (!tool || tool === this.active) return;
      this.active?.deactivate?.();
      for (const t of this.tools) {
        t.host.classList.toggle("active", t === tool);
        t.tab.classList.toggle("active", t === tool);
        t.tab.setAttribute("aria-selected", String(t === tool));
      }
      if (!tool.mounted) {
        tool.mounted = true;
        tool.mount(tool.host, this);
        if (this.project) tool.onProject?.(this.project);
      }
      this.active = tool;
      this.commands.setScope(tool.id);
      this.#clearSlots();
      tool.activate?.();
      prefs.set("tool", tool.id);
      if (location.hash !== "#" + tool.id) history.replaceState(null, "", "#" + tool.id);
      this.emit("tool", tool);
    }

    start() {
      this.#fromHash(prefs.get("tool", this.tools[0]?.id));
      this.#offerReopen();
    }

    #fromHash(fallback) {
      const id = location.hash.slice(1) || fallback;
      if (id) this.activate(id);
    }

    /** Tools call this when their unsaved state may have changed. */
    refreshDirty() {
      for (const t of this.tools) t.tab.classList.toggle("dirty", !!(t.mounted && t.isDirty?.()));
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Project

    async #offerReopen() {
      if (!hasFolderAccess) {
        this.openButton.disabled = true;
        this.openButton.title = "Abrir carpetas necesita Chrome o Edge";
        return;
      }
      const handle = await Project.recall();
      if (!handle || this.project) return;
      this.reopenButton.hidden = false;
      this.reopenButton.textContent = "Reabrir «" + handle.name + "»";
      this.reopenButton.title = "Abrir de nuevo la última carpeta (Ctrl+O)";
      this.lastHandle = handle;
    }

    async pickProject() {
      if (!hasFolderAccess) {
        toast("Este navegador no deja abrir carpetas.", { kind: "warn", detail: "Usa Chrome o Edge. Puedes abrir archivos sueltos en cada herramienta." });
        return;
      }
      try {
        await this.#load(await Project.pick());
      } catch (err) {
        if (err.name !== "AbortError") toast("No pude abrir la carpeta.", { kind: "bad", detail: err.message });
      }
    }

    async reopenProject() {
      if (!this.lastHandle) return this.pickProject();
      try {
        await this.#load(await Project.reopen(this.lastHandle));
      } catch (err) {
        toast("No pude reabrir la carpeta.", { kind: "bad", detail: err.message });
      }
    }

    async rescan() {
      if (!this.project) return;
      await this.#load(this.project, true);
    }

    async #load(project, rescan = false) {
      this.setStatus(rescan ? "Releyendo la carpeta…" : "Leyendo la carpeta…");
      await this.busy(project.scan());
      // The game's texts, shared by every tool. Unsaved text edits survive a rescan instead of being read over.
      if (!Aura.lang.dirty || this.project !== project) await this.busy(Aura.lang.load(project));
      this.project = project;
      this.reopenButton.hidden = true;
      this.rescanButton.hidden = false;
      this.openButton.textContent = "Cambiar carpeta";
      clear(this.projectName).append(h("b", null, project.name));
      this.projectName.title = `${project.files.size} archivos · ${project.mgcbs.length} .mgcb · ${project.atlases.length} atlas`;
      for (const t of this.tools) if (t.mounted) t.onProject?.(project);
      this.emit("project", project);
      this.setStatus(`${rescan ? "Releída" : "Abierta"} «${project.name}»: ${project.files.size} archivos, ${project.atlases.length} atlas, ${project.mgcbs.length} .mgcb.`, "ok");
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Feedback

    setStatus(text, kind = "") {
      this.message.textContent = text;
      this.message.className = "msg " + kind;
      this.message.title = text;
    }

    /** Spinner on while the promise runs (nested calls are counted). */
    async busy(promise) {
      this.#busy++;
      this.statusBar.classList.add("busy");
      try {
        return await promise;
      } finally {
        if (--this.#busy === 0) this.statusBar.classList.remove("busy");
      }
    }

    /** A named value in the status bar for the active tool (zoom, cursor…). Cleared when the tool changes. */
    slot(name, text, title = "") {
      let el = this.#slots.get(name);
      if (!el) {
        el = h("span", { class: "slot" });
        this.#slots.set(name, el);
        this.slotsEl.appendChild(el);
      }
      el.textContent = text;
      el.title = title;
      el.hidden = !text;
    }

    #clearSlots() {
      this.#slots.clear();
      clear(this.slotsEl);
    }

    toast = toast;
    confirm = confirmDialog;
    prompt = promptDialog;
    askUnsaved = unsavedDialog;

    openKeysheet() {
      this.commands.openKeysheet(this.active?.extraKeys?.() ?? []);
    }

    #registerCommands() {
      this.commands.registerAll([
        { id: "studio.palette", title: "Paleta de comandos", group: "Studio", keys: ["Ctrl+K", "Ctrl+Shift+P"], whileTyping: true, hidden: true, run: () => this.commands.openPalette() },
        { id: "studio.keys", title: "Ver atajos de teclado", group: "Studio", keys: ["?"], run: () => this.openKeysheet() },
        { id: "studio.open", title: "Abrir carpeta del proyecto", group: "Studio", keys: ["Ctrl+O"], whileTyping: true, run: () => (this.lastHandle && !this.project ? this.reopenProject() : this.pickProject()) },
        { id: "studio.rescan", title: "Volver a leer la carpeta", group: "Studio", enabled: () => !!this.project, run: () => this.rescan() },
      ]);
    }

    /** Registers Alt+1…9 to switch tools, once all tools are added. */
    registerToolSwitching() {
      this.tools.forEach((tool, i) => {
        this.commands.register({
          id: "studio.tool." + tool.id, title: "Ir a " + tool.title, group: "Herramientas", keys: [`Alt+${i + 1}`],
          whileTyping: true, run: () => this.activate(tool.id),
        });
      });
    }
  }

  Aura.studio = { Studio };
})(window.Aura ??= {});
