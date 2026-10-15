"use strict";

// Crear: one tab for everything the studio generates — blocks and plants today, leaves and seeds next. Each mode is a
// whole generator (the Bloques and Foliage tools as they were) mounted the first time it is shown, so switching keeps
// each one's work; this file is only the mode bar and the hand-off of the studio's calls to the mode on show.
(function (Aura) {
  const { h } = Aura.dom;
  const { segmented } = Aura.controls;
  const { prefs } = Aura.storage;

  const MODES = [
    { id: "blocks", label: "Bloque", hint: "Cubos, losas, escaleras… con las caras de una hoja", make: () => Aura.blocksTool.blocksTool() },
    { id: "plants", label: "Planta", hint: "Hierba, flores, cultivos, plantas de agua", make: () => Aura.plantsTool.plantsTool() },
  ];

  function createTool() {
    return new CreateTool();
  }

  class CreateTool {
    id = "create";
    title = "Crear";
    project = null;
    modes = MODES.map((m) => ({ ...m, tool: m.make(), host: null, mounted: false }));
    current = null;

    mount(host, studio) {
      this.studio = studio;
      this.hint = h("span", { class: "hint" });
      this.seg = segmented({
        label: "Qué crear", value: "",
        options: this.modes.map((m) => [m.id, m.label, m.hint]),
        onChange: (id) => this.show(id),
      });
      const hosts = this.modes.map((m) => (m.host = h("div", { class: "cr-host" })));
      host.appendChild(h("div", { class: "cr" },
        h("div", { class: "cr-bar" }, this.seg.el, this.hint, h("span", { class: "grow" }),
          h("span", { class: "hint" }, "«Enviar al Atlas» coloca lo creado en la hoja y crea su tile.")),
        h("div", { style: "position: relative; min-height: 0" }, hosts)));
      this.show(prefs.get("create:mode", this.modes[0].id));
    }

    show(id) {
      const mode = this.modes.find((m) => m.id === id) ?? this.modes[0];
      if (mode === this.current) return;
      this.current?.tool.deactivate?.();
      for (const m of this.modes) m.host.classList.toggle("active", m === mode);
      if (!mode.mounted) {
        mode.mounted = true;
        mode.tool.mount(mode.host, this.studio);
        if (this.project) mode.tool.onProject?.(this.project);
      }
      this.current = mode;
      this.seg.set(mode.id);
      this.hint.textContent = mode.hint;
      prefs.set("create:mode", mode.id);
      // Mounted while hidden, a generator measured a zero-size canvas; showing it is when it can draw.
      requestAnimationFrame(() => mode.tool.activate?.());
    }

    activate() { if (this.current) requestAnimationFrame(() => this.current.tool.activate?.()); }
    deactivate() { this.current?.tool.deactivate?.(); }

    onProject(project) {
      this.project = project;
      for (const m of this.modes) if (m.mounted) m.tool.onProject?.(project);
    }

    isDirty() { return this.modes.some((m) => m.mounted && m.tool.isDirty?.()); }
    dirtyLabel() { return "Crear"; }
  }

  Aura.createTool = { createTool };
})(window.Aura ??= {});
