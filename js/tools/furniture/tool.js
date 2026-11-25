"use strict";

// Generador de muebles: mesas, cofres, armarios, estanterías, camas.
//
// No es un motor nuevo. Un mueble se describe como grupos de cajas (furniture/parts.js) y cada grupo pasa por el
// mismo render que un bloque, con las mismas texturas del juego; luego se apilan por profundidad. Eso es lo que deja
// que un tablero de madera clara descanse sobre un armazón oscuro sin pintar un solo píxel a mano, y lo que hace que
// un mueble se vea como el mundo en el que está.
(function (Aura) {
  const { h } = Aura.dom;
  const { section, slider, select, checkbox, segmented } = Aura.controls;
  const { prefs } = Aura.storage;
  const E = Aura.blockEngine;
  const P = Aura.furnitureParts;
  const M = Aura.furnitureMaterials;

  // Un mueble no es terreno: el borde mordido que el motor le pone a la base de un bloque (hierba sobre un risco)
  // aquí solo deshilacha las patas y los herrajes.
  const RENDER = { size: 64, res: 32, aoSteps: 4, cleanup: true, mask: { enabled: false } };

  const PARTS = [
    ["frame", "Armazón y patas"], ["body", "Cuerpo"], ["top", "Tablero o tapa"],
    ["front", "Frente, puertas y cajones"], ["metal", "Herrajes"], ["cloth", "Tela"],
  ];

  const VIEWS = [["color", "Color"], ["normal", "Normales"], ["depth", "Profundidad"]];

  function furnitureTool() {
    return new FurnitureTool();
  }

  class FurnitureTool {
    id = "furniture";
    title = "Mueble";
    studio = null;
    project = null;
    editTarget = null;
    result = null;
    materialsImage = null;

    #pending = 0;
    #tex = M.source(null);

    constructor() {
      this.kind = prefs.get("furniture:kind", "table");
      this.p = this.#restore();
      this.view = prefs.get("furniture:view", "color");
      this.zoom = 4;
    }

    #restore() {
      const saved = prefs.get("furniture:params", null);
      if (saved && saved.body) {
        try { return { ...P.defaults(this.kind), ...structuredClone(saved) }; } catch { /* a corrupt entry just resets */ }
      }
      return P.defaults(this.kind);
    }

    #save() {
      prefs.set("furniture:params", this.p);
      prefs.set("furniture:kind", this.kind);
    }

    // -----------------------------------------------------------------------------------------------------------
    // Montaje

    mount(host, studio) {
      this.studio = studio;
      this.panel = h("div", { class: "fn-panel" });
      this.canvas = h("canvas", { class: "fn-canvas", width: 320, height: 320 });
      this.status = h("div", { class: "hint fn-status" }, "");

      host.appendChild(h("div", { class: "fn" },
        this.panel,
        h("div", { class: "fn-stage" },
          h("div", { class: "fn-stage-bar" },
            segmented({
              options: VIEWS, value: this.view, label: "Vista",
              onChange: (v) => { this.view = v; prefs.set("furniture:view", v); this.#draw(); },
            }).el,
            h("span", { class: "grow" }),
            h("button", { type: "button", onclick: () => this.applyToComposer() }, "Aplicar al Composer")),
          this.canvas,
          this.status)));

      this.#buildPanel();
      this.#schedule();
    }

    activate() { this.#schedule(); }
    deactivate() {}

    async onProject(project) {
      this.project = project;
      this.materialsImage = null;
      this.#tex = M.source(null);
      try {
        const entry = project?.get?.("App/Content/Assets/Texture/Materials.png");
        if (entry?.handle) {
          this.materialsImage = await Aura.png.decodePng(await entry.handle.getFile());
          this.#tex = M.source(this.materialsImage);
        }
      } catch (err) {
        console.warn("furniture: Materials.png", err);
      }
      this.#schedule();
    }

    isDirty() { return false; }

    // -----------------------------------------------------------------------------------------------------------
    // Panel

    #set(key, value) {
      this.p[key] = value;
      this.#save();
      this.#schedule();
    }

    #num(label, key, min, max, step = 0.5, title = "") {
      return slider({
        label, min, max, step, value: this.p[key], title,
        defaultValue: P.DEFAULTS[key],
        onInput: (v) => this.#set(key, v),
      }).el;
    }

    // Las familias solo ordenan el catálogo: el cuerpo y los parámetros son los mismos para todas.
    #presetItems() {
      const FAMILY = {
        table: "Mesas y apoyos", round_table: "Mesas y apoyos", desk: "Mesas y apoyos", lectern: "Mesas y apoyos",
        chest: "Guardado", trunk: "Guardado", crate: "Guardado", barrel: "Guardado",
        wardrobe: "Armarios", cupboard: "Armarios", bookshelf: "Armarios", nightstand: "Armarios",
        bench: "Asientos y camas", stool: "Asientos y camas", bed: "Asientos y camas",
      };
      const KEYS = {
        chest: "cofre baul arca tesoro", trunk: "arcon baul", crate: "caja cajon embalaje",
        barrel: "barril tonel tinaja", wardrobe: "armario ropero", cupboard: "alacena vitrina aparador",
        bookshelf: "estanteria libreria balda", nightstand: "mesilla noche comoda",
        bed: "cama camastro", bench: "banco escano", stool: "taburete banqueta silla",
        desk: "escritorio buro pupitre", lectern: "atril facistol pupitre",
        table: "mesa tablero", round_table: "mesa redonda velador",
      };
      return Aura.furnitureParts.KINDS
        .map(([id, label]) => ({ id, label, group: FAMILY[id] ?? "Otros", keywords: KEYS[id] ?? "" }))
        .sort((a, b) => a.group.localeCompare(b.group));
    }

    // Una casilla por esquina. Quitar patas sueltas es lo que convierte una mesa en una repisa o en una barra.
    #legToggles() {
      const p = this.p;
      const names = p.legs === "sled"
        ? [["Izquierda", 0], ["Derecha", 1]]
        : [["Frente izq.", 0], ["Frente der.", 1], ["Fondo izq.", 2], ["Fondo der.", 3]];
      const row = h("div", { class: "fn-legs" });
      for (const [label, i] of names) {
        row.appendChild(checkbox({
          label, value: p.legMask[i] !== 0,
          onChange: (v) => { p.legMask[i] = v ? 1 : 0; this.#save(); this.#schedule(); },
        }).el);
      }
      return row;
    }

    #buildPanel() {
      Aura.dom.clear(this.panel);
      const p = this.p;
      const add = (sec) => this.panel.appendChild(sec.el);

      this.picker = Aura.picker.gallery({
        items: this.#presetItems(), value: this.kind, columns: 2,
        placeholder: "Buscar mueble…",
        onPick: (v) => {
          this.kind = v;
          this.p = P.defaults(v);
          this.#save();
          this.#buildPanel();
          this.#schedule();
        },
      });

      add(section({ id: "fn-kind", title: "Pieza" },
        this.picker.el,
        select({
          label: "Cuerpo", value: p.body,
          options: [["table", "Mesa (patas y tablero)"], ["box", "Caja (casco cerrado)"], ["shelf", "Estantería"], ["slab", "Tabla (cama, banco)"]],
          title: "El cuerpo decide qué partes tiene la pieza. Cambiarlo no borra el resto de ajustes.",
          onChange: (v) => { this.#set("body", v); this.#buildPanel(); },
        }).el,
        p.body === "box" ? checkbox({
          label: "Cuerpo redondo", value: p.round,
          title: "Duelas abombadas y aros en vez de paredes rectas: un barril o una tinaja.",
          onChange: (v) => { this.#set("round", v); this.#buildPanel(); },
        }).el : null));

      add(section({ id: "fn-size", title: "Medidas" },
        this.#num("Ancho", "width", 2, 16),
        this.#num("Fondo", "depth", 2, 16),
        this.#num("Alto", "height", 2, 16)));

      add(section({ id: "fn-legs", title: "Patas" },
        select({
          label: "Forma", value: p.legs,
          options: [["none", "Sin patas"], ["square", "Postes"], ["turned", "Torneadas"], ["splayed", "Abiertas"], ["sled", "Patines"], ["plinth", "Zócalo"]],
          onChange: (v) => { this.#set("legs", v); this.#buildPanel(); },
        }).el,
        p.legs === "none" || p.legs === "plinth" ? null : this.#legToggles(),
        p.legs === "none" ? null : this.#num("Grosor", "legThick", 1, 5, 0.5),
        p.legs === "none" || p.body === "table" || p.body === "slab" ? null : this.#num("Altura de la pata", "legHeight", 0, 8, 0.5),
        p.body === "table" && p.legs !== "none" && p.legs !== "plinth" ? this.#num("Travesaño", "stretcher", 0, 8, 0.5, "Altura de la barra que une las patas. 0 la quita.") : null,
        p.body === "table" && p.legs !== "none" && p.legs !== "plinth"
          ? checkbox({ label: "Zapatas", value: p.feet, title: "Un taco bajo cada pata.", onChange: (v) => this.#set("feet", v) }).el
          : null));

      if (p.body === "table" || p.body === "slab") {
        add(section({ id: "fn-top", title: "Tablero" },
          this.#num("Grosor", "topThick", 0.5, 5, 0.5),
          p.body === "table" ? this.#num("Voladizo", "overhang", 0, 3, 0.25) : null,
          p.body === "table" ? this.#num("Faldón", "apron", 0, 4, 0.5, "La faja bajo el tablero que une las patas.") : null,
          p.body === "table" ? checkbox({ label: "Redondo", value: p.round, onChange: (v) => this.#set("round", v) }).el : null,
          p.body === "table" ? this.#num("Inclinación", "slope", 0, 1, 0.05, "Un atril: el tablero se corta por un plano en vez de escalonarse.") : null,
          p.body === "slab" ? this.#num("Cabecero", "headboard", 0, 8, 0.5) : null));
      }

      if (p.body === "box" || p.body === "shelf") {
        add(section({ id: "fn-carcass", title: "Casco" },
          p.round ? null : this.#num("Grosor de pared", "wall", 0.5, 3, 0.25),
          p.round ? null : checkbox({ label: "Con fondo", value: p.back, onChange: (v) => this.#set("back", v) }).el,
          p.body === "box" ? select({
            label: "Tapa", value: p.lid, options: [["none", "Sin tapa"], ["flat", "Plana"], ["domed", "Abombada"]],
            onChange: (v) => { this.#set("lid", v); this.#buildPanel(); },
          }).el : null,
          p.body === "box" && p.lid !== "none" ? this.#num("Grosor de la tapa", "lidThick", 0.5, 5, 0.5) : null,
          p.round ? null : this.#num("Baldas", "shelves", 0, 4, 1)));
      }

      if (p.body === "box" && !p.round) {
        add(section({ id: "fn-front", title: "Frente" },
          this.#num("Puertas", "doors", 0, 2, 1),
          this.#num("Cajones", "drawers", 0, 4, 1),
          p.doors > 0 ? this.#num("Abierta", "open", 0, 1, 0.05, "0 cerrada, 1 abierta del todo. Sirve para el estado abierto del tile.") : null,
          checkbox({ label: "Frente abierto", value: p.openFront, title: "Sin puerta ni tabla: un escritorio o una alacena abierta.", onChange: (v) => this.#set("openFront", v) }).el,
          select({
            label: "Tirador", value: p.handle, options: [["none", "Ninguno"], ["knob", "Pomo"], ["ring", "Argolla"], ["bar", "Barra"]],
            onChange: (v) => this.#set("handle", v),
          }).el));
      }

      if (p.body === "box") {
        add(section({ id: "fn-iron", title: "Herrajes" },
          this.#num("Bandas de metal", "bands", 0, 4, 1)));
      }

      // Partes: cada grupo se enciende, se apaga y elige su material por separado. Apagar el cuerpo de un armario
      // deja el armazón a la vista, que es lo que se quiere para una estructura a medio hacer o una ruina.
      const hidden = new Set(p.hidden ?? []);
      const parts = section({ id: "fn-parts", title: "Partes y materiales" });
      for (const [key, label] of PARTS) {
        parts.body.appendChild(h("div", { class: "fn-part" },
          checkbox({
            label: "", value: !hidden.has(key), title: "Mostrar " + label.toLowerCase(),
            onChange: (v) => {
              const set = new Set(this.p.hidden ?? []);
              if (v) set.delete(key); else set.add(key);
              this.p.hidden = [...set];
              this.#save();
              this.#schedule();
            },
          }).el,
          select({
            label, value: p.materials[key] ?? "wood", options: M.LIST,
            onChange: (v) => { p.materials[key] = v; this.#save(); this.#schedule(); },
          }).el));
      }
      parts.body.appendChild(h("p", { class: "hint" },
        this.materialsImage
          ? "Texturas de Materials.png del proyecto."
          : "Sin proyecto abierto: texturas pintadas aquí. Abre el proyecto para usar las del juego."));
      add(parts);
    }

    // -----------------------------------------------------------------------------------------------------------
    // Render

    #schedule() {
      const ticket = ++this.#pending;
      setTimeout(() => { if (ticket === this.#pending) this.#render(); }, 30);
    }

    #render() {
      let groups;
      try {
        groups = P.build(this.p);
      } catch (err) {
        this.status.textContent = "No se pudo construir: " + err.message;
        return;
      }
      if (!groups.length) {
        this.status.textContent = "La pieza no tiene ninguna caja: sube el alto o el ancho.";
        this.result = null;
        this.#draw();
        return;
      }

      const layers = [];
      for (const g of groups) {
        try {
          const piece = { boxes: Aura.blockShapes.parseCustom(JSON.stringify(g.boxes)), state: "default", facing: "front" };
          layers.push(E.render(RENDER, this.#tex(g.material), piece));
        } catch (err) {
          console.warn("furniture group", g.part, err);
        }
      }
      this.result = stack(layers, RENDER.size);
      this.status.textContent = groups.length + " grupos · " + groups.reduce((n, g) => n + g.boxes.length, 0) + " cajas";
      this.#draw();
    }

    #draw() {
      const ctx = this.canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.result) return;

      const S = this.result.size, zoom = Math.max(1, Math.floor(this.canvas.width / S));
      const data = this.result[this.view] ?? this.result.color;
      const off = document.createElement("canvas");
      off.width = S; off.height = S;
      off.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), S, S), 0, 0);
      const ox = (this.canvas.width - S * zoom) / 2, oy = (this.canvas.height - S * zoom) / 2;
      ctx.drawImage(off, ox, oy, S * zoom, S * zoom);
    }

    // -----------------------------------------------------------------------------------------------------------
    // Composer

    getRecipe() {
      return { kind: "furniture", type: this.kind, p: structuredClone(this.p) };
    }

    /** Picks the piece from outside the panel, the same as clicking it in the gallery. */
    setKind(kind) {
      if (!kind || kind === this.kind) return;

      this.kind = kind;
      this.p = P.defaults(kind);
      this.#save();
      this.#buildPanel();
      this.#schedule();
    }

    loadRecipe(recipe) {
      if (!recipe || recipe.kind !== "furniture") return;
      try {
        this.kind = recipe.type ?? this.kind;
        this.p = { ...P.defaults(this.kind), ...structuredClone(recipe.p ?? {}) };
        this.#save();
        this.#buildPanel();
        this.#schedule();
      } catch (err) {
        console.warn("loadRecipe furniture", err);
      }
    }

    clearEditTarget() { this.editTarget = null; }

    applyToComposer() {
      if (!this.result) {
        this.studio.toast("Genera un mueble antes de añadirlo", { kind: "warn" });
        return false;
      }
      const meta = {
        name: this.kind,
        source: "mueble",
        recipe: this.getRecipe(),
        replaceTarget: this.editTarget || null,
      };
      const ok = Aura.composerTool?.queueResult?.(this.result, meta);
      if (!ok) {
        this.studio.toast("Composer no disponible", { kind: "warn" });
        return false;
      }
      const wasEdit = !!this.editTarget;
      this.editTarget = null;
      this.studio.toast(wasEdit ? "Capa actualizada en el Composer" : "Mueble añadido al Composer", { kind: "ok" });
      return true;
    }
  }

  /**
   * Apila capas en un sprite, gana el píxel más cercano (la profundidad del motor es blanco = cerca). Es lo que deja
   * que una pieza lleve varios materiales: el motor solo admite un juego de texturas por render.
   */
  function stack(layers, size) {
    const n = size * size;
    const color = new Uint8ClampedArray(n * 4), normal = new Uint8ClampedArray(n * 4), depth = new Uint8ClampedArray(n * 4);
    const best = new Float32Array(n).fill(-1);
    for (const l of layers) {
      if (!l?.mask) continue;
      for (let i = 0; i < n; i++) {
        if (!l.mask[i]) continue;
        // Empate a favor de la capa posterior: los grupos vienen en el orden en que se superponen (herrajes sobre
        // el cuerpo), y a esta resolución medio dieciseisavo de salida cae en el mismo byte de profundidad.
        const d = l.depth[i * 4];
        if (d < best[i]) continue;
        best[i] = d;
        for (let c = 0; c < 4; c++) {
          color[i * 4 + c] = l.color[i * 4 + c];
          normal[i * 4 + c] = l.normal[i * 4 + c];
          depth[i * 4 + c] = l.depth[i * 4 + c];
        }
      }
    }
    return { size, color, normal, depth };
  }

  Aura.furnitureTool = { furnitureTool, stack, RENDER };
})(window.Aura ??= {});
