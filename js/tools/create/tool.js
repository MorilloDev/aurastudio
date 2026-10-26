"use strict";

// Crear / Composer: modes for generators (blocks, plants) and the multipiece Composer.
(function (Aura) {
  const { h } = Aura.dom;
  const { segmented } = Aura.controls;
  const { prefs } = Aura.storage;

  const MODES = [
    { id: "composer", label: "Composer", hint: "Capas 3D, multipart, agujeros, fusion, tint y export", make: () => Aura.composerTool.composerTool() },
    { id: "blocks", label: "Bloque", hint: "Cubos, losas, escaleras, esferas, marcos\u2026 con caras de una hoja", make: () => Aura.blocksTool.blocksTool() },
    { id: "plants", label: "Planta", hint: "Hierba, flores, cultivos, plantas de agua, hojas y semillas", make: () => Aura.plantsTool.plantsTool() },
  ];

  function createTool() {
    return new CreateTool();
  }

  class CreateTool {
    id = "create";
    title = "Composer";
    project = null;
    modes = MODES.map((m) => ({ ...m, tool: m.make(), host: null, mounted: false }));
    current = null;

    mount(host, studio) {
      this.studio = studio;
      this.hint = h("span", { class: "hint" });
      this.seg = segmented({
        label: "Modo", value: "",
        options: this.modes.map((m) => [m.id, m.label, m.hint]),
        onChange: (id) => this.show(id),
      });
      const hosts = this.modes.map((m) => (m.host = h("div", { class: "cr-host" })));
      host.appendChild(h("div", { class: "cr" },
        h("div", { class: "cr-bar" }, this.seg.el, this.hint, h("span", { class: "grow" }),
          h("span", { class: "hint" }, "Composer combina piezas; Bloque/Planta generan una forma.")),
        h("div", { style: "position: relative; min-height: 0" }, hosts)));
      this.show(prefs.get("create:mode", "composer"));
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
      requestAnimationFrame(() => mode.tool.activate?.());
    }

    activate() { if (this.current) requestAnimationFrame(() => this.current.tool.activate?.()); }
    deactivate() { this.current?.tool.deactivate?.(); }

    onProject(project) {
      this.project = project;
      for (const m of this.modes) if (m.mounted) m.tool.onProject?.(project);
    }

    isDirty() { return this.modes.some((m) => m.mounted && m.tool.isDirty?.()); }
    dirtyLabel() { return "Composer"; }
  }

  Aura.createTool = { createTool };
})(window.Aura ??= {});
