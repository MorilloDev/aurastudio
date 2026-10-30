"use strict";

// Crear = hub: Composer siempre visible. Bloque y Planta se abren en overlay;
// «Aplicar» mete el resultado (o todas las partes de una planta multipart) en el Composer.
(function (Aura) {
  const { h } = Aura.dom;
  const { prefs } = Aura.storage;

  function createTool() {
    return new CreateTool();
  }

  class CreateTool {
    id = "create";
    title = "Crear";
    project = null;
    studio = null;
    composer = null;
    blocks = null;
    plants = null;
    overlayMode = null; // "blocks" | "plants" | null

    mount(host, studio) {
      this.studio = studio;

      this.composerHost = h("div", { class: "cr-composer-host" });
      this.blocksHost = h("div", { class: "cr-gen-host" });
      this.plantsHost = h("div", { class: "cr-gen-host" });

      this.overlayTitle = h("h2", null, "Bloque");
      this.overlayTag = h("span", { class: "cr-overlay-tag" }, "generador");
      this.overlayHint = h("span", { class: "hint" }, "");

      this.overlay = h("div", { class: "cr-overlay", hidden: true },
        h("div", { class: "cr-overlay-panel" },
          h("div", { class: "cr-overlay-bar" },
            this.overlayTitle,
            this.overlayTag,
            h("span", { class: "grow" }),
            this.overlayHint),
          h("div", { class: "cr-overlay-body" },
            this.blocksHost,
            this.plantsHost),
          h("div", { class: "cr-overlay-foot" },
            h("span", { class: "hint cr-apply-hint" }, "El resultado se añade al Composer (grupo activo)."),
            h("button", { type: "button", onclick: () => this.closeOverlay() }, "Cancelar"),
            h("button", {
              type: "button", class: "primary",
              onclick: () => this.applyGenerator(),
            }, "Aplicar al Composer"))));

      // Bloque/Planta solo en la columna izquierda del Composer (evitar duplicados arriba).
      this.hubBar = h("div", { class: "cr-hub-bar" },
        h("span", { class: "hint" }, ""));

      host.appendChild(h("div", { class: "cr cr-hub" },
        this.hubBar,
        this.composerHost,
        this.overlay));

      this.composer = Aura.composerTool.composerTool();
      this.blocks = Aura.blocksTool.blocksTool();
      this.plants = Aura.plantsTool.plantsTool();

      this.composer.mount(this.composerHost, studio);
      this.blocks.mount(this.blocksHost, studio);
      this.plants.mount(this.plantsHost, studio);

      this.blocksHost.hidden = true;
      this.plantsHost.hidden = true;

      prefs.set("create:mode", "composer");
    }

    openGenerator(mode) {
      this.overlayMode = mode;
      this.blocksHost.hidden = mode !== "blocks";
      this.plantsHost.hidden = mode !== "plants";
      if (mode === "blocks") {
        this.overlayTitle.textContent = "Bloque";
        this.overlayTag.textContent = "generador";
        this.overlayHint.textContent = "AO del motor sí · al aplicar = 1 capa";
        this.blocks.activate?.();
      } else {
        this.overlayTitle.textContent = "Planta";
        this.overlayTag.textContent = "follaje";
        this.overlayHint.textContent = "Sin AO · multipart → una capa por celda";
        this.plants.activate?.();
      }
      this.overlay.hidden = false;
      this.overlay.classList.add("open");
    }

    closeOverlay() {
      this.overlayMode = null;
      this.overlay.hidden = true;
      this.overlay.classList.remove("open");
      this.blocks.deactivate?.();
      this.plants.deactivate?.();
      this.composer.activate?.();
    }

    applyGenerator() {
      const mode = this.overlayMode;
      let ok = false;
      if (mode === "blocks") {
        ok = this.blocks.applyToComposer?.() ?? false;
      } else if (mode === "plants") {
        ok = this.plants.applyToComposer?.() ?? false;
      }
      if (ok) this.closeOverlay();
    }

    activate() {
      if (this.overlayMode) {
        if (this.overlayMode === "blocks") this.blocks.activate?.();
        else this.plants.activate?.();
      } else {
        this.composer.activate?.();
      }
    }

    deactivate() {
      this.composer.deactivate?.();
      this.blocks.deactivate?.();
      this.plants.deactivate?.();
    }

    onProject(project) {
      this.project = project;
      this.composer?.onProject?.(project);
      this.blocks?.onProject?.(project);
      this.plants?.onProject?.(project);
    }

    isDirty() {
      return !!(this.composer?.isDirty?.() || this.blocks?.isDirty?.() || this.plants?.isDirty?.());
    }

    dirtyLabel() { return "Crear"; }

    show(id) {
      if (id === "blocks" || id === "plants") this.openGenerator(id);
      else this.closeOverlay();
    }
  }

  Aura.createTool = { createTool };
})(window.Aura ??= {});
