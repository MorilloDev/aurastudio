"use strict";

// Crear: una pestaña para todo lo que genera el estudio — bloques y plantas hoy, hojas y semillas después.
// Cada modo es un generador completo, montado la primera vez que se muestra, así cambiar de modo conserva
// el trabajo de cada uno. Aquí sólo vive la barra de modos, la orientación y el hand-off al modo en pantalla.
(function (Aura) {
  const { h } = Aura.dom;
  const { segmented } = Aura.controls;
  const { prefs } = Aura.storage;

  // Un sprite isométrico no se puede girar 90° como bitmap: la proyección 2:1 no es invariante bajo esa
  // rotación. El giro ocurre en coordenadas de mundo y se vuelve a proyectar; los espejos, en cambio, sí son
  // transformaciones de píxel y se aplican al final del render. Por eso cada modo declara qué ejes soporta.
  const AXES = { yaw: false, flipX: false, flipY: false };
  const normYaw = (y) => (((Math.round((y || 0) / 90) * 90) % 360) + 360) % 360;
  const ROT_ZERO = () => ({ yaw: 0, flipX: false, flipY: false });

  const rot = {
    sane: (r) => ({ yaw: normYaw(r?.yaw), flipX: !!r?.flipX, flipY: !!r?.flipY }),
    turn: (r, steps) => ({ ...r, yaw: normYaw(r.yaw + 90 * steps) }),
    flip: (r, axis) => (axis === "x" ? { ...r, flipX: !r.flipX } : { ...r, flipY: !r.flipY }),
    same: (a, b) => a.yaw === b.yaw && a.flipX === b.flipX && a.flipY === b.flipY,
  };

  const MODES = [
    {
      id: "blocks", label: "Bloque",
      hint: "Cubos, losas, escaleras… con las caras de una hoja",
      // El cubo puede girar en los 4 yaw y espejarse; la vegetación es un billboard que mira a cámara, así
      // que sólo admite espejo horizontal (girarla 90° la tumbaría).
      axes: { yaw: true, flipX: true, flipY: true },
      make: () => Aura.blocksTool.blocksTool(),
    },
    {
      id: "plants", label: "Planta",
      hint: "Hierba, flores, cultivos, plantas de agua, hojas y semillas",
      axes: { yaw: false, flipX: true, flipY: false },
      make: () => Aura.plantsTool.plantsTool(),
    },
  ];

  function createTool() { return new CreateTool(); }

  class CreateTool {
    id = "create";
    title = "Crear";
    project = null;
    studio = null;
    current = null;
    token = 0;
    modes = MODES.map((m) => ({ ...m, axes: { ...AXES, ...m.axes }, tool: null, host: null, mounted: false, rot: null }));

    onKey = (e) => this.handleKey(e);

    mount(host, studio) {
      this.studio = studio;
      this.hint = h("span", { class: "hint" });
      this.rotBox = h("div", { class: "cr-rot" });
      this.seg = segmented({
        label: "Qué crear", value: "",
        options: this.modes.map((m) => [m.id, m.label, m.hint]),
        onChange: (id) => this.show(id),
      });
      const hosts = this.modes.map((m) => (m.host = h("div", { class: "cr-host" })));
      host.appendChild(h("div", { class: "cr" },
        h("div", { class: "cr-bar" }, this.seg.el, this.hint, h("span", { class: "grow" }), this.rotBox,
          h("span", { class: "hint" }, "«Enviar al Atlas» coloca lo creado en la hoja y crea su tile.")),
        h("div", { style: "position: relative; min-height: 0" }, hosts)));
      this.show(prefs.get("create:mode", this.modes[0].id));
    }

    show(id) {
      const mode = this.modes.find((m) => m.id === id) ?? this.modes[0];
      if (mode === this.current) return;
      this.current?.tool?.deactivate?.();
      for (const m of this.modes) m.host.classList.toggle("active", m === mode);

      // Construcción y montaje perezosos: antes los dos generadores se instanciaban al crear la herramienta,
      // aunque el usuario no abriese el otro modo.
      if (!mode.tool) mode.tool = mode.make();
      if (!mode.mounted) {
        mode.mounted = true;
        mode.tool.mount(mode.host, this.studio);
        if (this.project) mode.tool.onProject?.(this.project);
      }

      this.current = mode;
      this.seg.set(mode.id);
      this.hint.textContent = mode.hint;
      this.buildRotBar(mode);
      mode.tool.setRotation?.(this.rotOf(mode));
      prefs.set("create:mode", mode.id);

      // Montado en oculto el generador midió un canvas de tamaño cero; al mostrarlo es cuando puede dibujar.
      // El token descarta activar un modo que ya se abandonó si el usuario cambia rápido.
      const token = ++this.token;
      requestAnimationFrame(() => { if (this.token === token) mode.tool.activate?.(); });
    }

    // ─── orientación ────────────────────────────────────────────────────────────────────────────────
    rotOf(mode) {
      if (!mode.rot) mode.rot = rot.sane(prefs.get(`create:rot:${mode.id}`, ROT_ZERO()));
      return mode.rot;
    }

    setRot(next) {
      const mode = this.current;
      if (!mode) return;
      next = rot.sane(next);
      if (rot.same(this.rotOf(mode), next)) return;
      mode.rot = next;
      prefs.set(`create:rot:${mode.id}`, next);
      this.buildRotBar(mode);
      mode.tool?.setRotation?.(next);
    }

    buildRotBar(mode) {
      const caps = mode.axes;
      const cur = this.rotOf(mode);
      this.rotBox.replaceChildren();
      this.rotBox.hidden = !(caps.yaw || caps.flipX || caps.flipY);
      if (this.rotBox.hidden) return;

      const btn = (glyph, title, on, fn) => {
        const b = h("button", {
          class: ["cr-rbtn", on && "on"], type: "button", title, "aria-label": title,
          onclick: () => this.setRot(fn(cur)),
        }, glyph);
        return b;
      };

      if (caps.yaw) {
        this.rotBox.append(
          btn("⟲", "Girar 90° a la izquierda (Q)", false, (r) => rot.turn(r, -1)),
          h("span", { class: "cr-rlabel", title: "Giro sobre el eje vertical" }, `${cur.yaw}°`),
          btn("⟳", "Girar 90° a la derecha (E)", false, (r) => rot.turn(r, 1)),
        );
      }
      if (caps.flipX) this.rotBox.append(btn("⇋", "Espejo horizontal (X)", cur.flipX, (r) => rot.flip(r, "x")));
      if (caps.flipY) this.rotBox.append(btn("⇅", "Espejo vertical (Y)", cur.flipY, (r) => rot.flip(r, "y")));
    }

    handleKey(e) {
      const mode = this.current;
      if (!mode || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target;
      if (t?.isContentEditable || /^(input|textarea|select)$/i.test(t?.tagName ?? "")) return;
      const caps = mode.axes, cur = this.rotOf(mode), k = e.key.toLowerCase();
      if (caps.yaw && (k === "q" || k === "e")) this.setRot(rot.turn(cur, k === "q" ? -1 : 1));
      else if (caps.flipX && k === "x") this.setRot(rot.flip(cur, "x"));
      else if (caps.flipY && k === "y") this.setRot(rot.flip(cur, "y"));
      else return;
      e.preventDefault();
    }

    // ─── ciclo de vida ──────────────────────────────────────────────────────────────────────────────
    activate() {
      window.addEventListener("keydown", this.onKey);
      const mode = this.current;
      if (mode) requestAnimationFrame(() => { if (this.current === mode) mode.tool.activate?.(); });
    }

    deactivate() {
      window.removeEventListener("keydown", this.onKey);
      this.current?.tool?.deactivate?.();
    }

    dispose() {
      this.deactivate();
      for (const m of this.modes) {
        if (!m.mounted) continue;
        m.tool?.dispose?.();
        m.mounted = false;
        m.tool = null;
      }
      this.current = null;
    }

    onProject(project) {
      this.project = project;
      for (const m of this.modes) if (m.mounted) m.tool.onProject?.(project);
    }

    isDirty() { return this.modes.some((m) => m.mounted && m.tool?.isDirty?.()); }
    dirtyLabel() { return "Crear"; }
  }

  Aura.createTool = { createTool };
})(window.Aura ??= {});
