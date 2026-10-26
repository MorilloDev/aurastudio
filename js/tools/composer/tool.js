"use strict";

// Composer con GRUPOS (carpetas):
// - Grupo multipart ON  → una celda TilePart (offset X/Y/Z); sus capas se componen en esa celda.
// - Grupo multipart OFF → grupo normal (organización); se dibuja en (0,0,0) si está visible.
// Vista: parte activa (celda del grupo seleccionado) + conjunto iso de todas las celdas.
// Enviar al Atlas: N items = N grupos multipart visibles (o 1 si ninguno es multipart).
(function (Aura) {
  const { h } = Aura.dom;
  const { section, slider, select } = Aura.controls;
  const { encodePng } = Aura.png;
  const { downloadBlob } = Aura.fs;
  const { prefs } = Aura.storage;
  const E = Aura.blockEngine;
  const Sh = Aura.blockShapes;

  const BLENDS = [
    ["normal", "Normal"],
    ["multiply", "Multiplicar"],
    ["screen", "Pantalla"],
    ["overlay", "Superponer"],
    ["add", "Sumar"],
  ];

  const PREFS_KEY = "composer:doc";
  const QUEUE_KEY = "composer:queue";

  const uid = () => "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function defaultShapeLayer(i = 0) {
    return {
      id: uid(),
      kind: "shape",
      name: "Forma " + (i + 1),
      visible: true,
      shape: "cube",
      params: { ...(Sh?.PARAM_DEFAULTS || {}) },
      shiftX: 0, shiftY: 0,
      rot3d: { x: 0, y: 0, z: 0 },
      blend: "normal",
      opacity: 1,
      tint: null,
      size: 64,
      color: null,
      normal: null,
      source: null,
    };
  }

  function spriteLayerFromResult(result, meta = {}) {
    const size = result.size || result.w || 64;
    return {
      id: uid(),
      kind: "sprite",
      name: meta.name || meta.source || "Sprite",
      visible: true,
      shiftX: 0, shiftY: 0,
      blend: "normal",
      opacity: 1,
      tint: null,
      size,
      w: result.w || size,
      h: result.h || size,
      color: result.color ? new Uint8ClampedArray(result.color) : null,
      normal: result.normal ? new Uint8ClampedArray(result.normal) : null,
      source: meta.source || "sprite",
      shape: null,
      params: {},
      rot3d: { x: 0, y: 0, z: 0 },
    };
  }

  function defaultGroup(i = 0, multipart = false) {
    return {
      id: uid(),
      name: multipart ? ("Parte " + (i + 1)) : ("Grupo " + (i + 1)),
      visible: true,
      collapsed: false,
      multipart: !!multipart,
      offsetX: multipart ? i : 0,
      offsetY: 0,
      offsetZ: 0,
      layers: [],
    };
  }

  function defaultDoc() {
    const g = defaultGroup(0, false);
    g.name = "Principal";
    g.layers = [defaultShapeLayer(0)];
    return { size: 64, groups: [g], selectedGroup: 0, selectedLayer: 0 };
  }

  /** Migra docs antiguos (layers planos con offset) al modelo de grupos. */
  function migrateDoc(raw) {
    if (raw?.groups && Array.isArray(raw.groups)) {
      return {
        size: raw.size || 64,
        selectedGroup: raw.selectedGroup | 0,
        selectedLayer: raw.selectedLayer | 0,
        groups: raw.groups.map((g, gi) => ({
          ...defaultGroup(gi, !!g.multipart),
          ...g,
          layers: (g.layers || []).map((l, li) => {
            const base = l.kind === "sprite"
              ? spriteLayerFromResult({ size: l.size || 64, color: null }, l)
              : defaultShapeLayer(li);
            return { ...base, ...l, color: null, normal: null };
          }),
        })),
      };
    }
    // Legacy: layers con offsetX/Y/Z
    if (raw?.layers && Array.isArray(raw.layers)) {
      const byCell = new Map();
      raw.layers.forEach((l, i) => {
        const key = (l.offsetX | 0) + "," + (l.offsetY | 0) + "," + (l.offsetZ | 0);
        if (!byCell.has(key)) {
          byCell.set(key, {
            ox: l.offsetX | 0, oy: l.offsetY | 0, oz: l.offsetZ | 0,
            layers: [],
          });
        }
        const base = l.kind === "sprite"
          ? spriteLayerFromResult({ size: l.size || 64, color: null }, l)
          : defaultShapeLayer(i);
        byCell.get(key).layers.push({ ...base, ...l, color: null, normal: null, offsetX: undefined, offsetY: undefined, offsetZ: undefined });
      });
      const cells = [...byCell.values()];
      const multi = cells.length > 1;
      const groups = cells.map((c, i) => {
        const g = defaultGroup(i, multi);
        g.offsetX = c.ox; g.offsetY = c.oy; g.offsetZ = c.oz;
        g.name = multi ? ("Parte " + c.ox + "," + c.oy + "," + c.oz) : "Principal";
        g.layers = c.layers;
        return g;
      });
      if (!groups.length) return defaultDoc();
      return { size: raw.size || 64, groups, selectedGroup: 0, selectedLayer: 0 };
    }
    return defaultDoc();
  }

  function opaqueBounds(rgba, size) {
    let minX = size, minY = size, maxX = -1, maxY = -1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (rgba[(y * size + x) * 4 + 3] < 1) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { minX, minY, maxX, maxY };
  }

  function clampShift(rgba, size, sx, sy) {
    if (!rgba) return { x: 0, y: 0, minSx: 0, maxSx: 0, minSy: 0, maxSy: 0 };
    const b = opaqueBounds(rgba, size);
    if (!b) return { x: 0, y: 0, minSx: 0, maxSx: 0, minSy: 0, maxSy: 0 };
    const minSx = -b.minX, maxSx = size - 1 - b.maxX;
    const minSy = -b.minY, maxSy = size - 1 - b.maxY;
    return {
      x: Math.max(minSx, Math.min(maxSx, Math.round(sx))),
      y: Math.max(minSy, Math.min(maxSy, Math.round(sy))),
      minSx, maxSx, minSy, maxSy,
    };
  }

  function applyTint(rgba, hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return rgba;
    const v = parseInt(m[1], 16);
    const tr = (v >> 16) & 255, tg = (v >> 8) & 255, tb = v & 255;
    const out = new Uint8ClampedArray(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      out[i] = (rgba[i] * tr) / 255;
      out[i + 1] = (rgba[i + 1] * tg) / 255;
      out[i + 2] = (rgba[i + 2] * tb) / 255;
      out[i + 3] = rgba[i + 3];
    }
    return out;
  }

  function blendPixel(dst, src, mode, opacity) {
    if (src[3] < 1) return;
    const a = (src[3] / 255) * opacity;
    if (a <= 0) return;
    const inv = 1 - a;
    let r = src[0], g = src[1], b = src[2];
    if (mode === "multiply") {
      r = (dst[0] * r) / 255; g = (dst[1] * g) / 255; b = (dst[2] * b) / 255;
    } else if (mode === "screen") {
      r = 255 - ((255 - dst[0]) * (255 - r)) / 255;
      g = 255 - ((255 - dst[1]) * (255 - g)) / 255;
      b = 255 - ((255 - dst[2]) * (255 - b)) / 255;
    } else if (mode === "overlay") {
      const ov = (d, s) => d < 128 ? (2 * d * s) / 255 : 255 - (2 * (255 - d) * (255 - s)) / 255;
      r = ov(dst[0], r); g = ov(dst[1], g); b = ov(dst[2], b);
    } else if (mode === "add") {
      r = Math.min(255, dst[0] + r); g = Math.min(255, dst[1] + g); b = Math.min(255, dst[2] + b);
    }
    dst[0] = Math.round(dst[0] * inv + r * a);
    dst[1] = Math.round(dst[1] * inv + g * a);
    dst[2] = Math.round(dst[2] * inv + b * a);
    dst[3] = Math.min(255, Math.round(dst[3] + (255 - dst[3]) * a));
  }

  function blitShifted(dest, destSize, src, srcSize, shiftX, shiftY, blend, opacity) {
    for (let y = 0; y < srcSize; y++) {
      for (let x = 0; x < srcSize; x++) {
        const si = (y * srcSize + x) * 4;
        if (src[si + 3] < 1) continue;
        const dx = x + shiftX, dy = y + shiftY;
        if (dx < 0 || dy < 0 || dx >= destSize || dy >= destSize) continue;
        const di = (dy * destSize + dx) * 4;
        const d = [dest[di], dest[di + 1], dest[di + 2], dest[di + 3]];
        const s = [src[si], src[si + 1], src[si + 2], src[si + 3]];
        blendPixel(d, s, blend || "normal", opacity ?? 1);
        dest[di] = d[0]; dest[di + 1] = d[1]; dest[di + 2] = d[2]; dest[di + 3] = d[3];
      }
    }
  }

  function composerTool() {
    return new ComposerTool();
  }

  class ComposerTool {
    id = "composer";
    title = "Composer";
    project = null;
    doc = defaultDoc();
    dirty = false;
    preview = null;       // conjunto
    activeCell = null;    // parte activa (solo esa celda)
    cellCache = new Map();

    mount(host, studio) {
      this.studio = studio;
      try {
        const raw = prefs.get(PREFS_KEY, null);
        if (raw) this.doc = migrateDoc(raw);
      } catch { /* ignore */ }

      this.ensembleCanvas = h("canvas", { class: "cp-preview" });
      this.partCanvas = h("canvas", { class: "cp-preview cp-part-preview" });
      this.groupList = h("div", { class: "cp-groups" });
      this.propsHost = h("div", { class: "cp-props" });

      const toolbar = h("div", { class: "cp-toolbar" },
        h("button", { class: "primary", onclick: () => this.addGroup(false) }, "+ Grupo"),
        h("button", { class: "primary", onclick: () => this.addGroup(true) }, "+ Parte multipart"),
        h("button", { onclick: () => this.addShapeLayer() }, "+ Forma"),
        h("button", { onclick: () => this.duplicateLayer() }, "Duplicar capa"),
        h("button", { onclick: () => this.removeSelected() }, "Quitar"),
        h("span", { class: "grow" }),
        h("button", { onclick: () => this.exportPng() }, "Exportar PNG conjunto"),
        h("button", { onclick: () => this.exportMultipart() }, "JSON parts"),
        h("button", { class: "primary", onclick: () => this.sendToAtlas() }, "Enviar al Atlas \u2192"),
      );

      host.appendChild(h("div", { class: "cp" },
        h("div", { class: "cp-side" },
          h("div", { class: "cp-side-head" },
            h("b", null, "Grupos / Partes"),
            h("span", { class: "hint" }, "carpeta = grupo")),
          this.groupList,
          h("div", { class: "cp-side-head" }, h("b", null, "Seleccionado")),
          this.propsHost),
        h("div", { class: "cp-stage" },
          toolbar,
          h("div", { class: "cp-views" },
            h("div", { class: "cp-view-block" },
              h("div", { class: "cp-view-label" }, "Parte activa (esta celda)"),
              h("div", { class: "cp-view" }, this.partCanvas)),
            h("div", { class: "cp-view-block" },
              h("div", { class: "cp-view-label" }, "Conjunto (c\u00f3mo queda unido)"),
              h("div", { class: "cp-view" }, this.ensembleCanvas))),
          h("p", { class: "hint cp-hint" },
            "Activa ", h("b", null, "Multipart"), " en un grupo para que sea una celda del tile. ",
            "Las capas dentro de esa carpeta se componen solo en esa celda. ",
            "El conjunto muestra todas las partes en iso con contorno."))));

      this.drainQueue();
      this.rebuildGroupList();
      this.rebuildProps();
      this.schedule();

      Aura.composerBridge = {
        pushResult: (result, meta) => this.pushResult(result, meta),
      };
    }

    activate() { this.drainQueue(); this.schedule(); }
    deactivate() {}
    onProject(project) { this.project = project; }
    isDirty() { return this.dirty; }

    // ── selection helpers ───────────────────────────────────────────────────

    group() {
      const i = Math.max(0, Math.min(this.doc.selectedGroup, this.doc.groups.length - 1));
      this.doc.selectedGroup = i;
      return this.doc.groups[i];
    }

    layer() {
      const g = this.group();
      if (!g?.layers?.length) return null;
      const i = Math.max(0, Math.min(this.doc.selectedLayer, g.layers.length - 1));
      this.doc.selectedLayer = i;
      return g.layers[i];
    }

    // ── mutations ───────────────────────────────────────────────────────────

    addGroup(multipart) {
      const g = defaultGroup(this.doc.groups.length, multipart);
      if (multipart) {
        // Siguiente offset libre en X
        const used = new Set(this.doc.groups.filter((x) => x.multipart).map((x) => x.offsetX + "," + x.offsetY + "," + x.offsetZ));
        let x = 0;
        while (used.has(x + ",0,0")) x++;
        g.offsetX = x;
      }
      this.doc.groups.push(g);
      this.doc.selectedGroup = this.doc.groups.length - 1;
      this.doc.selectedLayer = 0;
      this.touch();
    }

    addShapeLayer() {
      const g = this.group();
      if (!g) return;
      g.layers.push(defaultShapeLayer(g.layers.length));
      this.doc.selectedLayer = g.layers.length - 1;
      this.touch();
    }

    duplicateLayer() {
      const g = this.group();
      const L = this.layer();
      if (!g || !L) return;
      const copy = {
        ...JSON.parse(JSON.stringify({ ...L, color: null, normal: null })),
        id: uid(),
        name: (L.name || "Capa") + " copia",
        color: L.color ? new Uint8ClampedArray(L.color) : null,
        normal: L.normal ? new Uint8ClampedArray(L.normal) : null,
      };
      g.layers.splice(this.doc.selectedLayer + 1, 0, copy);
      this.doc.selectedLayer++;
      this.touch();
    }

    removeSelected() {
      const g = this.group();
      if (!g) return;
      // Si hay capa seleccionada y el grupo tiene capas, quitar capa; si no, quitar grupo.
      if (g.layers.length && this.layer()) {
        if (g.layers.length <= 1 && this.doc.groups.length <= 1) {
          this.studio?.toast("Deja al menos una capa", { kind: "warn" });
          return;
        }
        g.layers.splice(this.doc.selectedLayer, 1);
        if (!g.layers.length) {
          // Grupo vac\u00edo: quitar grupo si hay m\u00e1s
          if (this.doc.groups.length > 1) {
            this.doc.groups.splice(this.doc.selectedGroup, 1);
            this.doc.selectedGroup = Math.min(this.doc.selectedGroup, this.doc.groups.length - 1);
          } else {
            g.layers.push(defaultShapeLayer(0));
          }
        }
        this.doc.selectedLayer = Math.min(this.doc.selectedLayer, Math.max(0, g.layers.length - 1));
      } else {
        if (this.doc.groups.length <= 1) {
          this.studio?.toast("Deja al menos un grupo", { kind: "warn" });
          return;
        }
        this.doc.groups.splice(this.doc.selectedGroup, 1);
        this.doc.selectedGroup = Math.min(this.doc.selectedGroup, this.doc.groups.length - 1);
        this.doc.selectedLayer = 0;
      }
      this.touch();
    }

    pushResult(result, meta = {}) {
      if (!result?.color) {
        this.studio?.toast("No hay preview para a\u00f1adir", { kind: "warn" });
        return;
      }
      let g = this.group();
      if (!g) {
        this.addGroup(false);
        g = this.group();
      }
      const layer = spriteLayerFromResult(result, meta);
      g.layers.push(layer);
      this.doc.selectedLayer = g.layers.length - 1;
      if (result.size) this.doc.size = Math.max(this.doc.size, result.size);
      this.dirty = true;
      this.touch();
      this.studio?.toast("Capa \u00ab" + layer.name + "\u00bb en \u00ab" + g.name + "\u00bb", { kind: "ok" });
    }

    drainQueue() {
      try {
        const q = prefs.get(QUEUE_KEY, []);
        if (!Array.isArray(q) || !q.length) return;
        prefs.set(QUEUE_KEY, []);
        for (const item of q) {
          if (!item?.color) continue;
          this.pushResult({
            size: item.size || 64,
            color: new Uint8ClampedArray(item.color),
            normal: item.normal ? new Uint8ClampedArray(item.normal) : null,
            w: item.w, h: item.h,
          }, item.meta || {});
        }
      } catch { /* ignore */ }
    }

    touch() {
      this.dirty = true;
      this.savePrefsMeta();
      this.rebuildGroupList();
      this.rebuildProps();
      this.schedule();
    }

    savePrefsMeta() {
      prefs.set(PREFS_KEY, {
        size: this.doc.size,
        selectedGroup: this.doc.selectedGroup,
        selectedLayer: this.doc.selectedLayer,
        groups: this.doc.groups.map((g) => ({
          id: g.id, name: g.name, visible: g.visible, collapsed: g.collapsed,
          multipart: g.multipart, offsetX: g.offsetX, offsetY: g.offsetY, offsetZ: g.offsetZ,
          layers: (g.layers || []).map((l) => ({
            id: l.id, kind: l.kind, name: l.name, visible: l.visible,
            shiftX: l.shiftX, shiftY: l.shiftY,
            blend: l.blend, opacity: l.opacity, tint: l.tint,
            shape: l.shape, params: l.params, rot3d: l.rot3d,
            size: l.size, source: l.source,
          })),
        })),
      });
    }

    // ── UI lists ────────────────────────────────────────────────────────────

    rebuildGroupList() {
      this.groupList.replaceChildren();
      this.doc.groups.forEach((g, gi) => {
        const isSel = gi === this.doc.selectedGroup;
        const head = h("div", {
          class: ["cp-group-head", isSel && "active", g.multipart && "multipart"],
          onclick: () => {
            this.doc.selectedGroup = gi;
            this.doc.selectedLayer = 0;
            this.rebuildGroupList();
            this.rebuildProps();
            this.schedule();
          },
        },
          h("input", {
            type: "checkbox", checked: g.visible || null, title: "Mostrar grupo",
            onclick: (e) => e.stopPropagation(),
            onchange: (e) => { g.visible = e.target.checked; this.touch(); },
          }),
          h("button", {
            class: "cp-collapse", title: "Plegar",
            onclick: (e) => { e.stopPropagation(); g.collapsed = !g.collapsed; this.rebuildGroupList(); },
          }, g.collapsed ? "\u25B6" : "\u25BC"),
          h("span", { class: "cp-group-name" }, g.name),
          g.multipart
            ? h("span", { class: "cp-badge", title: "Celda multipart" }, g.offsetX + "," + g.offsetY + "," + g.offsetZ)
            : h("span", { class: "cp-badge faint" }, "grupo"),
          h("button", {
            class: ["cp-mp-btn", g.multipart && "on"],
            title: g.multipart ? "Desactivar multipart (pasa a grupo normal)" : "Activar multipart (esta carpeta = una celda)",
            onclick: (e) => {
              e.stopPropagation();
              g.multipart = !g.multipart;
              if (g.multipart && g.name.startsWith("Grupo")) g.name = "Parte " + (gi + 1);
              this.touch();
            },
          }, g.multipart ? "MP\u2713" : "MP"),
        );
        this.groupList.appendChild(head);

        if (!g.collapsed) {
          g.layers.forEach((L, li) => {
            const row = h("div", {
              class: ["cp-layer", isSel && li === this.doc.selectedLayer && "active"],
              onclick: () => {
                this.doc.selectedGroup = gi;
                this.doc.selectedLayer = li;
                this.rebuildGroupList();
                this.rebuildProps();
                this.schedule();
              },
            },
              h("input", {
                type: "checkbox", checked: L.visible || null,
                onclick: (e) => e.stopPropagation(),
                onchange: (e) => { L.visible = e.target.checked; this.touch(); },
              }),
              h("span", { class: "cp-layer-name" }, L.name || "Capa"),
              h("span", { class: "mono faint" }, L.kind === "sprite" ? (L.source || "sprite") : (L.shape || "shape")),
              h("button", { title: "Subir", onclick: (e) => { e.stopPropagation(); this.moveLayer(gi, li, 1); } }, "\u2191"),
              h("button", { title: "Bajar", onclick: (e) => { e.stopPropagation(); this.moveLayer(gi, li, -1); } }, "\u2193"),
            );
            this.groupList.appendChild(row);
          });
        }
      });
    }

    moveLayer(gi, li, dir) {
      const g = this.doc.groups[gi];
      const j = li + dir;
      if (!g || j < 0 || j >= g.layers.length) return;
      [g.layers[li], g.layers[j]] = [g.layers[j], g.layers[li]];
      this.doc.selectedGroup = gi;
      this.doc.selectedLayer = j;
      this.touch();
    }

    // ── props ───────────────────────────────────────────────────────────────

    rebuildProps() {
      const g = this.group();
      const L = this.layer();
      if (!g) return;
      const set = (fn) => { fn(); this.savePrefsMeta(); this.schedule(); this.rebuildGroupList(); };

      const kids = [];

      // Group props
      kids.push(h("div", { class: "cp-sub" }, "Grupo / carpeta"));
      kids.push(h("label", { class: "field" }, h("span", null, "Nombre"),
        h("input", { value: g.name, oninput: (e) => set(() => { g.name = e.target.value; this.rebuildProps(); }) })));
      kids.push(h("label", { class: "field check" },
        h("input", {
          type: "checkbox", checked: g.multipart || null,
          onchange: (e) => set(() => { g.multipart = e.target.checked; this.rebuildProps(); }),
        }),
        h("span", null, "Multipart (esta carpeta = una celda del tile)")));

      if (g.multipart) {
        kids.push(section({ id: "cp-cell", title: "Celda de esta parte" },
          h("p", { class: "note" }, "Offset en el mundo del juego (TilePart). Otras partes con otro offset = m\u00e1s celdas."),
          this.gNum(g, "offsetX", "Offset X", -4, 4, set),
          this.gNum(g, "offsetY", "Offset Y", -4, 4, set),
          this.gNum(g, "offsetZ", "Offset Z", -4, 4, set),
        ).el);
      } else {
        kids.push(h("p", { class: "note" }, "Grupo normal: organiza capas. Se dibuja en la celda ancla (0,0,0) del conjunto si est\u00e1 visible."));
      }

      if (!L) {
        this.propsHost.replaceChildren(...kids);
        return;
      }

      kids.push(h("div", { class: "cp-sub" }, "Capa"));
      kids.push(h("label", { class: "field" }, h("span", null, "Nombre"),
        h("input", { value: L.name, oninput: (e) => set(() => { L.name = e.target.value; this.rebuildProps(); }) })));
      kids.push(h("p", { class: "note" },
        L.kind === "sprite"
          ? ("Raster (" + (L.source || "sprite") + ", " + (L.size || this.doc.size) + "px).")
          : "Forma procedural."));

      if (L.kind !== "sprite") {
        kids.push(select({
          label: "Forma", value: L.shape || "cube",
          options: Object.entries(Sh.SHAPES).map(([k, s]) => [k, s.label]),
          onChange: (v) => set(() => { L.shape = v; this.rebuildProps(); }),
        }).el);
        for (const el of this.paramControls(L, set)) kids.push(el);
        kids.push(section({ id: "cp-rot", title: "Rotaci\u00f3n 3D" },
          this.lNum(L, "rot3d.x", "Rot X\u00b0", -180, 180, set),
          this.lNum(L, "rot3d.y", "Rot Y\u00b0", -180, 180, set),
          this.lNum(L, "rot3d.z", "Rot Z\u00b0", -180, 180, set),
        ).el);
      }

      const src = this.layerSourceRgba(L);
      const size = L.size || this.doc.size;
      let lim = { minSx: 0, maxSx: 0, minSy: 0, maxSy: 0 };
      if (src?.color) {
        const c = clampShift(src.color, size, L.shiftX || 0, L.shiftY || 0);
        lim = c; L.shiftX = c.x; L.shiftY = c.y;
      }

      kids.push(section({ id: "cp-shift", title: "Mover dentro de la celda del grupo" },
        h("p", { class: "note" },
          "L\u00edmite X " + lim.minSx + "\u2026" + lim.maxSx + ", Y " + lim.minSy + "\u2026" + lim.maxSy +
          (lim.minSx === 0 && lim.maxSx === 0 && lim.minSy === 0 && lim.maxSy === 0
            ? " (arte a celda completa)." : ".")),
        this.lNum(L, "shiftX", "Shift X", lim.minSx, lim.maxSx, (fn) => {
          fn();
          if (src?.color) { const c = clampShift(src.color, size, L.shiftX, L.shiftY); L.shiftX = c.x; L.shiftY = c.y; }
          this.savePrefsMeta(); this.schedule();
        }, null, 1),
        this.lNum(L, "shiftY", "Shift Y", lim.minSy, lim.maxSy, (fn) => {
          fn();
          if (src?.color) { const c = clampShift(src.color, size, L.shiftX, L.shiftY); L.shiftX = c.x; L.shiftY = c.y; }
          this.savePrefsMeta(); this.schedule();
        }, null, 1),
        h("button", { onclick: () => set(() => { L.shiftX = 0; L.shiftY = 0; this.rebuildProps(); }) }, "Centrar"),
      ).el);

      kids.push(section({ id: "cp-blend", title: "Fusi\u00f3n y tint" },
        select({
          label: "Modo fusi\u00f3n", value: L.blend || "normal",
          options: BLENDS,
          onChange: (v) => set(() => { L.blend = v; }),
        }).el,
        this.lNum(L, "opacity", "Opacidad", 0, 1, set, null, 0.05),
        h("label", { class: "field" }, h("span", null, "Tint"),
          h("input", {
            type: "color", value: L.tint || "#ffffff",
            oninput: (e) => set(() => { L.tint = e.target.value; }),
          }),
          h("button", { onclick: () => set(() => { L.tint = null; this.rebuildProps(); }) }, "Sin tint")),
      ).el);

      this.propsHost.replaceChildren(...kids);
    }

    paramControls(L, set) {
      const out = [];
      const shape = L.shape;
      if (!Sh?.PARAM_DEFAULTS) return out;
      const add = (key, label, min, max, step = 1) => out.push(this.paramSlider(L, key, label, min, max, set, step));
      if (shape === "layer") add("layer", "Altura", 1, 15);
      if (shape === "small") { add("small", "Ancho", 2, 16); add("smallHeight", "Alto", 1, 16); }
      if (shape === "pillar") add("pillar", "Grosor", 2, 16);
      if (["panel", "slopePanel", "diagonalWall", "semicircle", "frame", "frameRound"].includes(shape)) add("panel", "Grosor", 1, 8);
      if (["sphere", "hemisphere", "cylinder", "semicircle", "arch", "frameRound", "tube"].includes(shape)) add("radius", "Radio", 2, 8);
      if (["frame", "frameRound", "arch", "tube"].includes(shape)) add("frameThick", "Grosor", 1, 6);
      if (shape === "arch") {
        add("archHeight", "Altura pilares", 1, 14);
        add("archDepth", "Profundidad", 2, 16);
      }
      add("scale", "Escala", 0.2, 1, 0.05);
      return out;
    }

    paramSlider(L, key, label, min, max, set, step = 1) {
      return slider({
        label, min, max, step, value: L.params?.[key] ?? Sh.PARAM_DEFAULTS[key] ?? min,
        onChange: (v) => set(() => { L.params = L.params || {}; L.params[key] = Number(v); }),
      }).el;
    }

    gNum(g, key, label, min, max, set) {
      return slider({
        label, min, max, step: 1, value: g[key] | 0,
        onChange: (v) => set(() => { g[key] = Number(v); }),
      }).el;
    }

    lNum(L, path, label, min, max, set, title, step = 1) {
      const get = () => {
        const parts = path.split(".");
        let o = L;
        for (const p of parts) o = o?.[p];
        return o ?? 0;
      };
      const put = (v) => {
        const parts = path.split(".");
        let o = L;
        for (let i = 0; i < parts.length - 1; i++) {
          o[parts[i]] = o[parts[i]] || {};
          o = o[parts[i]];
        }
        o[parts[parts.length - 1]] = v;
      };
      if (min > max) { min = 0; max = 0; }
      return slider({
        label, min, max, step, value: get(), title: title || undefined,
        onChange: (v) => set(() => put(Number(v))),
      }).el;
    }

    // ── render ──────────────────────────────────────────────────────────────

    schedule() {
      clearTimeout(this._t);
      this._t = setTimeout(() => this.render(), 40);
    }

    layerSourceRgba(L) {
      if (L.kind === "sprite") {
        if (!L.color) return null;
        return { size: L.size || this.doc.size, color: L.color, normal: L.normal };
      }
      try {
        const def = Sh.SHAPES[L.shape] ?? Sh.SHAPES.cube;
        const params = { ...Sh.PARAM_DEFAULTS, ...(L.params || {}) };
        let boxes = def.boxes ? def.boxes(params) : [{ min: [0, 0, 0], max: [1, 1, 1] }];
        if (params.scale != null && params.scale !== 1 && Sh.scaleBoxes) boxes = Sh.scaleBoxes(boxes, params.scale);
        const piece = { boxes, state: "default", facing: "front", rot3d: { ...(L.rot3d || {}) } };
        const solid = (rgb) => {
          const S = 16, rgba = new Uint8ClampedArray(S * S * 4);
          for (let i = 0; i < S * S; i++) {
            rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255;
          }
          return { w: S, h: S, rgba };
        };
        const tex = { top: solid([160, 160, 155]), left: solid([120, 120, 118]), right: solid([100, 100, 98]) };
        const r = E.render(E.merge({ size: L.size || this.doc.size, shading: true }), tex, piece);
        return { size: r.size, color: r.color, normal: r.normal };
      } catch (err) {
        console.warn(err);
        return null;
      }
    }

    /** Compone las capas visibles de un grupo en un buffer size\u00d7size. */
    renderGroup(g) {
      const S = this.doc.size || 64;
      const color = new Uint8ClampedArray(S * S * 4);
      let normal = null;
      for (const L of g.layers || []) {
        if (!L.visible) continue;
        const src = this.layerSourceRgba(L);
        if (!src?.color) continue;
        let rgba = src.color;
        if (L.tint) rgba = applyTint(rgba, L.tint);
        const c = clampShift(rgba, src.size, L.shiftX || 0, L.shiftY || 0);
        L.shiftX = c.x; L.shiftY = c.y;
        blitShifted(color, S, rgba, src.size, c.x, c.y, L.blend, L.opacity ?? 1);
        if (src.normal) {
          if (!normal) normal = new Uint8ClampedArray(S * S * 4);
          blitShifted(normal, S, src.normal, src.size, c.x, c.y, "normal", 1);
        }
      }
      return { size: S, color, normal };
    }

    /**
     * IsoProjection del juego (North):
     *   HalfTileW = 32, HalfTileH = 16, LayerStepY = 32  (con tile 64×64)
     *   TileSpritePos delta desde (0,0,0) a (dx,dy,dz):
     *     sx = (dx - dz) * 32
     *     sy = (dx + dz) * 16 - dy * 32
     * Cada parte es un sprite 64×64 independiente; el conjunto solo los coloca.
     */
    isoDelta(dx, dy, dz) {
      const S = this.doc.size || 64;
      const halfW = S / 2;       // 32
      const halfH = S / 4;       // 16
      const layer = S / 2;       // 32
      return {
        x: Math.round((dx - dz) * halfW),
        y: Math.round((dx + dz) * halfH - dy * layer),
      };
    }

    /** SortDepth del juego (North): X+Z; luego altura para pintar encima. */
    sortKey(dx, dy, dz) {
      return (dx + dz) * 1000 + dy;
    }

    /**
     * Celdas únicas: fusiona grupos que comparten el mismo offset multipart.
     * Grupos sin multipart → ancla (0,0,0).
     * Cada celda se rasteriza a exactamente size×size (64×64).
     */
    buildCells() {
      const S = this.doc.size || 64;
      const map = new Map();
      for (const g of this.doc.groups) {
        if (!g.visible) continue;
        const ox = g.multipart ? (g.offsetX | 0) : 0;
        const oy = g.multipart ? (g.offsetY | 0) : 0;
        const oz = g.multipart ? (g.offsetZ | 0) : 0;
        const key = ox + "," + oy + "," + oz;
        if (!map.has(key)) {
          map.set(key, {
            offsetX: ox, offsetY: oy, offsetZ: oz,
            groups: [],
            label: g.name,
            active: false,
          });
        }
        const cell = map.get(key);
        cell.groups.push(g);
        if (g === this.group()) cell.active = true;
        // Prefer multipart group name for label
        if (g.multipart) cell.label = g.name;
      }
      const cells = [...map.values()].map((c) => {
        // Componer todas las capas de todos los grupos de esta celda → un 64×64
        const color = new Uint8ClampedArray(S * S * 4);
        let normal = null;
        for (const g of c.groups) {
          const r = this.renderGroup(g);
          for (let i = 0; i < color.length; i += 4) {
            if (r.color[i + 3] < 1) continue;
            const d = [color[i], color[i + 1], color[i + 2], color[i + 3]];
            const s = [r.color[i], r.color[i + 1], r.color[i + 2], r.color[i + 3]];
            blendPixel(d, s, "normal", 1);
            color[i] = d[0]; color[i + 1] = d[1]; color[i + 2] = d[2]; color[i + 3] = d[3];
          }
          if (r.normal) {
            if (!normal) normal = new Uint8ClampedArray(S * S * 4);
            for (let i = 0; i < normal.length; i += 4) {
              if (r.normal[i + 3] < 1) continue;
              normal[i] = r.normal[i]; normal[i + 1] = r.normal[i + 1];
              normal[i + 2] = r.normal[i + 2]; normal[i + 3] = r.normal[i + 3];
            }
          }
        }
        const d = this.isoDelta(c.offsetX, c.offsetY, c.offsetZ);
        return {
          ...c,
          size: S,
          color,
          normal,
          px: d.x,
          py: d.y,
          sort: this.sortKey(c.offsetX, c.offsetY, c.offsetZ),
        };
      });
      cells.sort((a, b) => a.sort - b.sort);
      return cells;
    }

    exportCells() {
      return this.buildCells().map((c) => ({
        offsetX: c.offsetX,
        offsetY: c.offsetY,
        offsetZ: c.offsetZ,
        label: c.label,
        color: c.color,
        normal: c.normal,
        size: c.size,
      }));
    }

    render() {
      const S = this.doc.size || 64;
      const cells = this.buildCells();

      // Parte activa: siempre el 64×64 del grupo seleccionado (su celda).
      const ag = this.group();
      if (ag && ag.visible) {
        // Buscar la celda que contiene al grupo activo
        const active = cells.find((c) => c.groups.includes(ag));
        this.activeCell = active
          ? { size: S, color: active.color, normal: active.normal }
          : this.renderGroup(ag);
      } else {
        this.activeCell = { size: S, color: new Uint8ClampedArray(S * S * 4), normal: null };
      }

      // Conjunto: colocar cada celda 64×64 en su sitio iso (sin reescalar ni cortar).
      let minX = 0, minY = 0, maxX = S, maxY = S;
      for (const c of cells) {
        minX = Math.min(minX, c.px);
        minY = Math.min(minY, c.py);
        maxX = Math.max(maxX, c.px + S);
        maxY = Math.max(maxY, c.py + S);
      }
      const pad = 4;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const W = Math.max(S, maxX - minX);
      const H = Math.max(S, maxY - minY);
      const color = new Uint8ClampedArray(W * H * 4);

      for (const c of cells) {
        const dx = c.px - minX;
        const dy = c.py - minY;
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const si = (y * S + x) * 4;
            if (c.color[si + 3] < 1) continue;
            const di = ((dy + y) * W + (dx + x)) * 4;
            const d = [color[di], color[di + 1], color[di + 2], color[di + 3]];
            const s = [c.color[si], c.color[si + 1], c.color[si + 2], c.color[si + 3]];
            // Activa un poco más opaca visualmente no hace falta; mismo blit
            blendPixel(d, s, "normal", 1);
            color[di] = d[0]; color[di + 1] = d[1]; color[di + 2] = d[2]; color[di + 3] = d[3];
          }
        }
      }

      this.preview = {
        size: S, w: W, h: H, color,
        cells: cells.length,
        outlines: cells.map((c) => ({
          x: c.px - minX, y: c.py - minY, w: S, h: S,
          active: c.active,
          multipart: c.groups.some((g) => g.multipart),
          name: c.label,
          ox: c.offsetX, oy: c.offsetY, oz: c.offsetZ,
        })),
      };

      this.paintPart();
      this.paintEnsemble();
    }

    paintPart() {
      // Siempre S×S (64×64): la celda completa, centrada en el panel.
      const S = this.activeCell?.size || this.doc.size || 64;
      const c = this.partCanvas;
      const box = c.parentElement;
      const availW = box?.clientWidth || 320;
      const availH = box?.clientHeight || 320;
      const scale = Math.max(1, Math.floor(Math.min(availW, availH) * 0.92 / S));
      c.width = S * scale;
      c.height = S * scale;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      this.fillChecker(ctx, c.width, c.height);
      if (!this.activeCell) return;
      const off = document.createElement("canvas");
      off.width = S; off.height = S;
      off.getContext("2d").putImageData(
        new ImageData(new Uint8ClampedArray(this.activeCell.color), S, S), 0, 0);
      ctx.drawImage(off, 0, 0, c.width, c.height);
      // Contorno exacto de la celda 64×64
      ctx.strokeStyle = "rgba(95, 211, 176, 0.85)";
      ctx.lineWidth = Math.max(1, Math.round(scale / 2));
      ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
    }

    paintEnsemble() {
      const W = this.preview?.w || this.doc.size;
      const H = this.preview?.h || this.doc.size;
      const S = this.preview?.size || this.doc.size;
      const c = this.ensembleCanvas;
      const box = c.parentElement;
      const scale = Math.max(1, Math.floor(Math.min(
        (box?.clientWidth || 480) / W,
        (box?.clientHeight || 480) / H,
        6)));
      c.width = W * scale;
      c.height = H * scale;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      this.fillChecker(ctx, c.width, c.height);
      if (!this.preview) return;
      const off = document.createElement("canvas");
      off.width = W; off.height = H;
      off.getContext("2d").putImageData(
        new ImageData(new Uint8ClampedArray(this.preview.color), W, H), 0, 0);
      ctx.drawImage(off, 0, 0, c.width, c.height);
      // Contorno por celda 64×64 + etiqueta de offset
      if (this.preview.outlines) {
        ctx.font = `${Math.max(10, 9 * scale)}px sans-serif`;
        for (const o of this.preview.outlines) {
          ctx.strokeStyle = o.active
            ? "rgba(95, 211, 176, 0.95)"
            : (o.multipart ? "rgba(127, 178, 255, 0.6)" : "rgba(255,255,255,0.28)");
          ctx.lineWidth = o.active ? 2 : 1;
          ctx.strokeRect(o.x * scale + 0.5, o.y * scale + 0.5, o.w * scale - 1, o.h * scale - 1);
          if (scale >= 2) {
            ctx.fillStyle = o.active ? "rgba(95, 211, 176, 0.9)" : "rgba(180,190,200,0.7)";
            ctx.fillText(`${o.ox},${o.oy},${o.oz}`, o.x * scale + 3, o.y * scale + 12);
          }
        }
      }
    }

    fillChecker(ctx, w, h) {
      const g = 8;
      for (let y = 0; y < h; y += g) for (let x = 0; x < w; x += g) {
        ctx.fillStyle = ((x / g + y / g) & 1) ? "#2a2a30" : "#1e1e24";
        ctx.fillRect(x, y, g, g);
      }
    }

    async exportPng() {
      if (!this.preview) this.render();
      const W = this.preview.w, H = this.preview.h;
      const blob = await encodePng(W, H, this.preview.color);
      downloadBlob(blob, "composer-conjunto.png");
      this.studio?.toast("PNG del conjunto exportado", { kind: "ok" });
    }

    exportMultipart() {
      this.render();
      const cells = this.exportCells();
      const parts = cells.map((c) => ({
        offsetX: c.offsetX, offsetY: c.offsetY, offsetZ: c.offsetZ,
        art: { default: { front: [0, 0] } },
      }));
      const blob = new Blob([JSON.stringify({
        name: "ComposerPiece",
        category: "furniture",
        parts,
        _note: "Una entrada por grupo multipart visible. Coords de ejemplo.",
      }, null, 2)], { type: "application/json" });
      downloadBlob(blob, "composer-multipart.json");
      this.studio?.toast("parts: " + parts.length, { kind: "ok" });
    }

    sendToAtlas() {
      this.render();
      const cells = this.exportCells();
      if (!cells.length) {
        this.studio?.toast("No hay grupos visibles", { kind: "warn" });
        return;
      }
      const S = this.doc.size || 64;
      this.studio.pendingPlacement = {
        label: "Composer",
        name: "",
        kind: "composer",
        size: S,
        sheetKey: null,
        items: cells.map((c) => ({
          color: c.color,
          normal: c.normal,
          label: c.label || ("celda " + c.offsetX + "," + c.offsetY + "," + c.offsetZ),
        })),
        buildTile: (coords) => {
          if (coords.length === 1) return { art: { default: { front: coords[0] } } };
          return {
            parts: cells.map((c, i) => ({
              offsetX: c.offsetX,
              offsetY: c.offsetY,
              offsetZ: c.offsetZ,
              art: { default: { front: coords[i] || coords[0] } },
            })),
          };
        },
        snippet: (coords) => {
          if (coords.length === 1) {
            return '"art": { "default": { "front": ' + JSON.stringify(coords[0]).replace(",", ", ") + " } }";
          }
          const lines = cells.map((c, i) => {
            const cell = coords[i] || coords[0];
            return '    { "offsetX": ' + c.offsetX + ', "offsetY": ' + c.offsetY + ', "offsetZ": ' + c.offsetZ +
              ', "art": { "default": { "front": ' + JSON.stringify(cell).replace(",", ", ") + " } } }";
          });
          return '"parts": [\n' + lines.join(",\n") + "\n]";
        },
      };
      this.studio.activate("atlas");
    }
  }

  function queueResult(result, meta = {}) {
    if (!result?.color) return false;
    if (Aura.composerBridge?.pushResult) {
      Aura.composerBridge.pushResult(result, meta);
      return true;
    }
    const q = prefs.get(QUEUE_KEY, []);
    q.push({
      size: result.size || result.w || 64,
      w: result.w, h: result.h,
      color: Array.from(result.color),
      normal: result.normal ? Array.from(result.normal) : null,
      meta: { name: meta.name, source: meta.source },
    });
    prefs.set(QUEUE_KEY, q);
    return true;
  }

  Aura.composerTool = { composerTool, queueResult, spriteLayerFromResult };
})(window.Aura ??= {});
