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
    return {
      size: 64, groups: [g], selectedGroup: 0, selectedLayer: 0,
      ao: { enabled: true, strength: 0.5, radius: 3, samples: 12, crossCell: true },
    };
  }

  /** Migra docs antiguos (layers planos con offset) al modelo de grupos. */
  function migrateDoc(raw) {
    if (raw?.groups && Array.isArray(raw.groups)) {
      return {
        size: raw.size || 64,
        selectedGroup: raw.selectedGroup | 0,
        selectedLayer: raw.selectedLayer | 0,
        ao: { enabled: true, strength: 0.5, radius: 3, samples: 12, crossCell: true, ...(raw.ao || {}) },
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


  /**
   * AO en espacio de imagen entre capas/celdas.
   * depth: Float32Array size*size, mayor = más cerca de la cámara (como el motor).
   * Para cada píxel opaco, si vecinos más cercanos “tapan” el hemisferio, oscurece.
   */
  function applyScreenAO(color, depth, width, height, opts) {
    const strength = opts.strength ?? 0.45;
    const radius = Math.max(1, opts.radius ?? 3);
    const samples = Math.max(4, opts.samples ?? 12);
    if (strength <= 0.001) return color;

    // Muestras en círculo (estable, sin RNG por frame).
    const dirs = [];
    for (let i = 0; i < samples; i++) {
      const a = (i + 0.5) / samples * Math.PI * 2;
      dirs.push([Math.cos(a), Math.sin(a)]);
    }

    const out = new Uint8ClampedArray(color);
    const bias = opts.bias ?? 0.02;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const di = i * 4;
        if (color[di + 3] < 1) continue;
        const d0 = depth[i];
        if (!Number.isFinite(d0)) continue;

        let blocked = 0, total = 0;
        for (const [dx, dy] of dirs) {
          // Dos radios: cercano y medio (mejor que un solo anillo).
          for (const rMul of [0.45, 1]) {
            const sx = Math.round(x + dx * radius * rMul);
            const sy = Math.round(y + dy * radius * rMul);
            total++;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
              // Borde abierto = menos oclusión (cielo).
              continue;
            }
            const j = sy * width + sx;
            const d1 = depth[j];
            if (!Number.isFinite(d1)) continue; // vacío = no ocluye
            // Vecino más cerca (depth mayor) y con diferencia relevante → ocluye.
            if (d1 > d0 + bias) blocked++;
          }
        }
        const ao = 1 - strength * (blocked / Math.max(1, total));
        out[di] = Math.round(color[di] * ao);
        out[di + 1] = Math.round(color[di + 1] * ao);
        out[di + 2] = Math.round(color[di + 2] * ao);
      }
    }
    return out;
  }

  /** Depth sintético si no hay mapa: base + orden de capa (frente más cerca). */
  function syntheticDepth(size, layerIndex, totalLayers, shiftY) {
    const d = new Float32Array(size * size);
    // Frente (índice alto) = depth mayor. shiftY hacia abajo en pantalla ≈ un poco más lejos en iso.
    const base = 1 + (layerIndex + 1) / (totalLayers + 1);
    d.fill(base - (shiftY || 0) * 0.001);
    return d;
  }

  /** Convierte depth RGBA del motor (blanco = cerca) a float 0..1. */
  function depthFromMap(depthRgba, size) {
    const d = new Float32Array(size * size);
    if (!depthRgba) { d.fill(0.5); return d; }
    for (let i = 0; i < size * size; i++) {
      d[i] = depthRgba[i * 4] / 255;
    }
    return d;
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
    clipboard = null;       // capa copiada/cortada
    zoomPart = 0;           // 0 = auto ajustar
    zoomEnsemble = 0;       // 0 = auto ajustar
    fitMode = true;
    #drag = null;           // { startX, startY, originShiftX, originShiftY, layer }

    mount(host, studio) {
      this.studio = studio;
      try {
        const raw = prefs.get(PREFS_KEY, null);
        if (raw) this.doc = migrateDoc(raw);
      } catch { /* ignore */ }

      this.ensembleCanvas = h("canvas", { class: "cp-preview", title: "Clic en una celda para seleccionarla" });
      this.partCanvas = h("canvas", { class: "cp-preview cp-part-preview", title: "Arrastra para mover la capa dentro de la celda" });
      this.groupList = h("div", { class: "cp-groups" });
      this.propsHost = h("div", { class: "cp-props" });
      this.zoomPartLabel = h("span", { class: "cp-zoom-lbl" }, "auto");
      this.zoomEnsLabel = h("span", { class: "cp-zoom-lbl" }, "auto");

      const toolbar = h("div", { class: "cp-toolbar" },
        h("div", { class: "cp-tool-group" },
          h("button", { class: "primary", title: "Grupo normal (organización)", onclick: () => this.addGroup(false) }, "+ Grupo"),
          h("button", { class: "primary", title: "Nueva celda multipart", onclick: () => this.addGroup(true) }, "+ Parte"),
          h("button", { title: "Añadir forma a la parte activa", onclick: () => this.addShapeLayer() }, "+ Forma")),
        h("div", { class: "cp-tool-group" },
          h("button", { title: "Ctrl+C", onclick: () => this.copyLayer() }, "Copiar"),
          h("button", { title: "Ctrl+X", onclick: () => this.cutLayer() }, "Cortar"),
          h("button", { title: "Ctrl+V", onclick: () => this.pasteLayer() }, "Pegar"),
          h("button", { title: "Ctrl+D", onclick: () => this.duplicateLayer() }, "Duplicar"),
          h("button", { title: "Supr", onclick: () => this.removeSelected() }, "Quitar")),
        h("div", { class: "cp-tool-group" },
          h("button", { title: "Alejar parte", onclick: () => this.bumpZoom("part", -1) }, "−"),
          this.zoomPartLabel,
          h("button", { title: "Acercar parte", onclick: () => this.bumpZoom("part", 1) }, "+"),
          h("button", { title: "Ajustar parte al panel", onclick: () => { this.zoomPart = 0; this.paintPart(); this.syncZoomLabels(); } }, "Ajustar"),
          h("span", { class: "cp-sep" }),
          h("button", { title: "Alejar conjunto", onclick: () => this.bumpZoom("ens", -1) }, "−"),
          this.zoomEnsLabel,
          h("button", { title: "Acercar conjunto", onclick: () => this.bumpZoom("ens", 1) }, "+"),
          h("button", { title: "Ajustar conjunto", onclick: () => { this.zoomEnsemble = 0; this.paintEnsemble(); this.syncZoomLabels(); } }, "Ajustar")),
        h("span", { class: "grow" }),
        h("div", { class: "cp-tool-group" },
          h("button", { onclick: () => this.exportPng() }, "PNG"),
          h("button", { onclick: () => this.exportMultipart() }, "JSON"),
          h("button", { class: "primary", onclick: () => this.sendToAtlas() }, "Atlas →")),
      );

      this.partView = h("div", { class: "cp-view" }, this.partCanvas);
      this.ensView = h("div", { class: "cp-view" }, this.ensembleCanvas);

      host.appendChild(h("div", { class: "cp" },
        h("div", { class: "cp-side" },
          h("div", { class: "cp-side-head" },
            h("b", null, "Grupos / Partes"),
            h("span", { class: "hint" }, "MP = celda")),
          this.groupList,
          h("div", { class: "cp-side-head" }, h("b", null, "Propiedades")),
          this.propsHost),
        h("div", { class: "cp-stage" },
          toolbar,
          h("div", { class: "cp-views" },
            h("div", { class: "cp-view-block" },
              h("div", { class: "cp-view-label" },
                h("span", null, "Parte activa"),
                h("span", { class: "hint" }, "arrastrar = mover capa")),
              this.partView),
            h("div", { class: "cp-view-block" },
              h("div", { class: "cp-view-label" },
                h("span", null, "Conjunto"),
                h("span", { class: "hint" }, "clic = elegir celda")),
              this.ensView)))));

      this.bindCanvasEvents();
      this.bindKeys(host);
      this.drainQueue();
      this.rebuildGroupList();
      this.rebuildProps();
      this.schedule();

      Aura.composerBridge = {
        pushResult: (result, meta) => this.pushResult(result, meta),
      };
    }

    bindKeys(host) {
      host.tabIndex = 0;
      host.addEventListener("keydown", (e) => {
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key === "c") { e.preventDefault(); this.copyLayer(); }
        else if (mod && e.key === "x") { e.preventDefault(); this.cutLayer(); }
        else if (mod && e.key === "v") { e.preventDefault(); this.pasteLayer(); }
        else if (mod && e.key === "d") { e.preventDefault(); this.duplicateLayer(); }
        else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.removeSelected(); }
      });
    }

    bindCanvasEvents() {
      // Parte activa: arrastrar para shift de la capa seleccionada
      this.partCanvas.addEventListener("pointerdown", (e) => {
        const L = this.layer();
        if (!L) return;
        const scale = this.#partScale();
        this.#drag = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          originShiftX: L.shiftX || 0,
          originShiftY: L.shiftY || 0,
          layer: L,
          scale,
        };
        this.partCanvas.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      this.partCanvas.addEventListener("pointermove", (e) => {
        if (!this.#drag || this.#drag.pointerId !== e.pointerId) return;
        const L = this.#drag.layer;
        const s = this.#drag.scale || 1;
        const dx = Math.round((e.clientX - this.#drag.startX) / s);
        const dy = Math.round((e.clientY - this.#drag.startY) / s);
        const src = this.layerSourceRgba(L);
        const size = L.size || this.doc.size || 64;
        let sx = this.#drag.originShiftX + dx;
        let sy = this.#drag.originShiftY + dy;
        if (src?.color) {
          const c = clampShift(src.color, size, sx, sy);
          sx = c.x; sy = c.y;
        }
        L.shiftX = sx; L.shiftY = sy;
        this.schedule();
      });
      const endDrag = (e) => {
        if (!this.#drag || this.#drag.pointerId !== e.pointerId) return;
        this.#drag = null;
        this.savePrefsMeta();
        this.rebuildProps();
      };
      this.partCanvas.addEventListener("pointerup", endDrag);
      this.partCanvas.addEventListener("pointercancel", endDrag);

      // Conjunto: clic en celda → seleccionar grupo
      this.ensembleCanvas.addEventListener("pointerdown", (e) => {
        if (!this.preview?.outlines?.length) return;
        const rect = this.ensembleCanvas.getBoundingClientRect();
        const scale = this.#ensScale();
        const x = (e.clientX - rect.left) / scale;
        const y = (e.clientY - rect.top) / scale;
        // Buscar celda de atrás hacia adelante (la activa encima)
        let hit = null;
        for (const o of this.preview.outlines) {
          if (x >= o.x && y >= o.y && x < o.x + o.w && y < o.y + o.h) hit = o;
        }
        if (!hit) return;
        const gi = this.doc.groups.findIndex((g) =>
          (g.multipart ? (g.offsetX | 0) : 0) === hit.ox &&
          (g.multipart ? (g.offsetY | 0) : 0) === hit.oy &&
          (g.multipart ? (g.offsetZ | 0) : 0) === hit.oz &&
          g.visible);
        if (gi >= 0) {
          this.doc.selectedGroup = gi;
          this.doc.selectedLayer = 0;
          this.rebuildGroupList();
          this.rebuildProps();
          this.schedule();
        }
      });
    }

    #partScale() {
      const S = this.activeCell?.size || this.doc.size || 64;
      if (this.zoomPart > 0) return this.zoomPart;
      const box = this.partView || this.partCanvas.parentElement;
      const avail = Math.min(box?.clientWidth || 320, box?.clientHeight || 320) * 0.92;
      return Math.max(1, Math.floor(avail / S));
    }

    #ensScale() {
      const W = this.preview?.w || this.doc.size || 64;
      const H = this.preview?.h || this.doc.size || 64;
      if (this.zoomEnsemble > 0) return this.zoomEnsemble;
      const box = this.ensView || this.ensembleCanvas.parentElement;
      return Math.max(1, Math.floor(Math.min(
        (box?.clientWidth || 480) / W,
        (box?.clientHeight || 480) / H,
        6)));
    }

    bumpZoom(which, dir) {
      if (which === "part") {
        const cur = this.zoomPart || this.#partScale();
        this.zoomPart = Math.max(1, Math.min(16, cur + dir));
        this.paintPart();
      } else {
        const cur = this.zoomEnsemble || this.#ensScale();
        this.zoomEnsemble = Math.max(1, Math.min(16, cur + dir));
        this.paintEnsemble();
      }
      this.syncZoomLabels();
    }

    syncZoomLabels() {
      if (this.zoomPartLabel) {
        this.zoomPartLabel.textContent = this.zoomPart ? (this.zoomPart + "×") : "auto";
      }
      if (this.zoomEnsLabel) {
        this.zoomEnsLabel.textContent = this.zoomEnsemble ? (this.zoomEnsemble + "×") : "auto";
      }
    }

    /** Copia profunda de una capa (incl. buffers). */
    cloneLayer(L) {
      return {
        ...JSON.parse(JSON.stringify({ ...L, color: null, normal: null })),
        id: uid(),
        color: L.color ? new Uint8ClampedArray(L.color) : null,
        normal: L.normal ? new Uint8ClampedArray(L.normal) : null,
      };
    }

    copyLayer() {
      const L = this.layer();
      if (!L) { this.studio?.toast("No hay capa seleccionada", { kind: "warn" }); return; }
      this.clipboard = { mode: "copy", layer: this.cloneLayer(L) };
      this.studio?.toast("Capa copiada", { kind: "ok" });
    }

    cutLayer() {
      const g = this.group();
      const L = this.layer();
      if (!g || !L) { this.studio?.toast("No hay capa seleccionada", { kind: "warn" }); return; }
      this.clipboard = { mode: "cut", layer: this.cloneLayer(L) };
      g.layers.splice(this.doc.selectedLayer, 1);
      if (!g.layers.length) g.layers.push(defaultShapeLayer(0));
      this.doc.selectedLayer = Math.min(this.doc.selectedLayer, g.layers.length - 1);
      this.touch();
      this.studio?.toast("Capa cortada", { kind: "ok" });
    }

    pasteLayer() {
      if (!this.clipboard?.layer) { this.studio?.toast("Nada que pegar", { kind: "warn" }); return; }
      const g = this.group();
      if (!g) return;
      const copy = this.cloneLayer(this.clipboard.layer);
      copy.name = (copy.name || "Capa") + (this.clipboard.mode === "copy" ? " copia" : "");
      g.layers.splice(this.doc.selectedLayer + 1, 0, copy);
      this.doc.selectedLayer++;
      this.touch();
      this.studio?.toast("Capa pegada", { kind: "ok" });
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
      // Planta multipart: result.parts = [abajo…arriba], una celda por parte.
      const parts = (result?.parts && result.parts.length) ? result.parts : null;
      if (parts && parts.length > 1) {
        const baseName = meta.name || meta.source || "planta";
        const size = result.size || parts[0].size || 64;
        this.doc.size = Math.max(this.doc.size || 64, size);
        // Cada parte → grupo multipart con offsetY = índice (sistema de plantas del juego).
        for (let k = 0; k < parts.length; k++) {
          const part = parts[k];
          if (!part?.color) continue;
          const g = defaultGroup(this.doc.groups.length, true);
          g.name = baseName + " p" + (k + 1);
          g.offsetX = 0;
          g.offsetY = k;
          g.offsetZ = 0;
          g.multipart = true;
          const layer = spriteLayerFromResult(part, {
            name: baseName + " p" + (k + 1),
            source: meta.source || "planta",
          });
          if (part.depth) layer.depth = new Uint8ClampedArray(part.depth);
          // Plantas: sin AO de generador; el Composer puede ocluir entre celdas si el usuario quiere.
          g.layers = [layer];
          this.doc.groups.push(g);
        }
        this.doc.selectedGroup = this.doc.groups.length - 1;
        this.doc.selectedLayer = 0;
        this.dirty = true;
        this.touch();
        return;
      }

      const color = result?.color || (parts && parts[0]?.color);
      if (!color) {
        this.studio?.toast("No hay preview para añadir", { kind: "warn" });
        return;
      }
      const single = parts && parts.length === 1
        ? { ...result, color: parts[0].color, normal: parts[0].normal, depth: parts[0].depth, size: parts[0].size || result.size }
        : result;

      let g = this.group();
      if (!g) {
        this.addGroup(false);
        g = this.group();
      }
      const layer = spriteLayerFromResult(single, meta);
      if (single.depth) layer.depth = new Uint8ClampedArray(single.depth);
      g.layers.push(layer);
      this.doc.selectedLayer = g.layers.length - 1;
      if (single.size) this.doc.size = Math.max(this.doc.size, single.size);
      this.dirty = true;
      this.touch();
    }

    drainQueue() {
      try {
        const q = prefs.get(QUEUE_KEY, []);
        if (!q?.length) return;
        prefs.set(QUEUE_KEY, []);
        for (const item of q) {
          if (item.multipart && item.parts?.length) {
            this.pushResult({
              size: item.size || 64,
              parts: item.parts.map((p) => ({
                size: p.size || item.size || 64,
                color: new Uint8ClampedArray(p.color),
                normal: p.normal ? new Uint8ClampedArray(p.normal) : null,
              })),
            }, item.meta || {});
          } else {
            this.pushResult({
              size: item.size || 64,
              w: item.w, h: item.h,
              color: new Uint8ClampedArray(item.color),
              normal: item.normal ? new Uint8ClampedArray(item.normal) : null,
            }, item.meta || {});
          }
        }
      } catch (err) {
        console.warn("composer queue", err);
      }
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
        ao: this.doc.ao,
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
      const ao = this.doc.ao || (this.doc.ao = { enabled: true, strength: 0.5, radius: 3, samples: 12, crossCell: true });
      const setAo = (fn) => { fn(); this.savePrefsMeta(); this.schedule(); };

      kids.push(section({ id: "cp-ao", title: "Ambient occlusion" },
        h("p", { class: "note" }, "Oscurece contactos entre capas de la misma celda y entre celdas vecinas."),
        h("label", { class: "field check" },
          h("input", {
            type: "checkbox", checked: ao.enabled !== false || null,
            onchange: (e) => setAo(() => { ao.enabled = e.target.checked; }),
          }),
          h("span", null, "Activar AO")),
        h("label", { class: "field check" },
          h("input", {
            type: "checkbox", checked: ao.crossCell !== false || null,
            onchange: (e) => setAo(() => { ao.crossCell = e.target.checked; }),
          }),
          h("span", null, "AO entre celdas (conjunto)")),
        slider({
          label: "Intensidad", min: 0, max: 1, step: 0.05,
          value: ao.strength ?? 0.5,
          onChange: (v) => setAo(() => { ao.strength = Number(v); }),
        }).el,
        slider({
          label: "Radio (px)", min: 1, max: 12, step: 1,
          value: ao.radius ?? 3,
          onChange: (v) => setAo(() => { ao.radius = Number(v); }),
        }).el,
        slider({
          label: "Muestras", min: 4, max: 24, step: 2,
          value: ao.samples ?? 12,
          onChange: (v) => setAo(() => { ao.samples = Number(v); }),
        }).el,
      ).el);

      // Group props
      kids.push(h("div", { class: "cp-sub" }, "Grupo / carpeta"));
      kids.push(h("label", { class: "field" }, h("span", null, "Nombre"),
        h("input", {
          value: g.name,
          oninput: (e) => {
            g.name = e.target.value;
            // Actualiza solo el texto de la lista, sin reconstruir el panel (mantiene el foco).
            const head = this.groupList?.querySelector(".cp-group-head.active .cp-group-name");
            if (head) head.textContent = g.name;
            this.savePrefsMeta();
          },
          onchange: () => this.savePrefsMeta(),
        })));
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
        h("input", {
          value: L.name,
          oninput: (e) => {
            L.name = e.target.value;
            const row = this.groupList?.querySelector(".cp-layer.active .cp-layer-name");
            if (row) row.textContent = L.name;
            this.savePrefsMeta();
          },
          onchange: () => this.savePrefsMeta(),
        })));
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
        const size = L.size || this.doc.size;
        return {
          size,
          color: L.color,
          normal: L.normal,
          depth: L.depth ? depthFromMap(L.depth, size) : null,
        };
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
        // AO del motor apagado aquí: el Composer aplica AO entre capas/celdas después.
        const r = E.render(E.merge({ size: L.size || this.doc.size, shading: true, ao: false }), tex, piece);
        return {
          size: r.size,
          color: r.color,
          normal: r.normal,
          depth: r.depth ? depthFromMap(r.depth, r.size) : null,
        };
      } catch (err) {
        console.warn(err);
        return null;
      }
    }

    /** Compone las capas visibles de un grupo en un buffer size×size, con depth y AO entre capas. */
    renderGroup(g) {
      const S = this.doc.size || 64;
      const color = new Uint8ClampedArray(S * S * 4);
      const depth = new Float32Array(S * S).fill(-Infinity);
      let normal = null;
      const layers = (g.layers || []).filter((L) => L.visible);
      layers.forEach((L, li) => {
        const src = this.layerSourceRgba(L);
        if (!src?.color) return;
        let rgba = src.color;
        if (L.tint) rgba = applyTint(rgba, L.tint);
        const c = clampShift(rgba, src.size, L.shiftX || 0, L.shiftY || 0);
        L.shiftX = c.x; L.shiftY = c.y;
        let srcDepth = src.depth;
        if (!srcDepth) srcDepth = syntheticDepth(src.size, li, layers.length, c.y);
        // Bonus de cercanía por orden de capa (las de arriba en la lista quedan delante).
        const orderBias = (li + 1) * 0.02;
        for (let y = 0; y < src.size; y++) {
          for (let x = 0; x < src.size; x++) {
            const si = (y * src.size + x) * 4;
            if (rgba[si + 3] < 1) continue;
            const dx = x + c.x, dy = y + c.y;
            if (dx < 0 || dy < 0 || dx >= S || dy >= S) continue;
            const di = dy * S + dx;
            const d = srcDepth[y * src.size + x] + orderBias;
            const pi = di * 4;
            const dest = [color[pi], color[pi + 1], color[pi + 2], color[pi + 3]];
            const srcPx = [rgba[si], rgba[si + 1], rgba[si + 2], rgba[si + 3]];
            blendPixel(dest, srcPx, L.blend || "normal", L.opacity ?? 1);
            color[pi] = dest[0]; color[pi + 1] = dest[1]; color[pi + 2] = dest[2]; color[pi + 3] = dest[3];
            if (d > depth[di]) depth[di] = d;
          }
        }
        if (src.normal) {
          if (!normal) normal = new Uint8ClampedArray(S * S * 4);
          blitShifted(normal, S, src.normal, src.size, c.x, c.y, "normal", 1);
        }
      });

      const ao = this.doc.ao || {};
      let finalColor = color;
      if (ao.enabled !== false && (ao.strength ?? 0.5) > 0) {
        finalColor = applyScreenAO(color, depth, S, S, {
          strength: ao.strength ?? 0.5,
          radius: ao.radius ?? 3,
          samples: ao.samples ?? 12,
        });
      }
      return { size: S, color: finalColor, normal, depth };
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
        // Componer todos los grupos de esta celda → un 64×64 + depth combinado
        const color = new Uint8ClampedArray(S * S * 4);
        const depth = new Float32Array(S * S).fill(-Infinity);
        let normal = null;
        for (const g of c.groups) {
          const r = this.renderGroup(g);
          // renderGroup ya aplicó AO intra-grupo; re-fusionamos depth para AO entre celdas
          for (let i = 0; i < S * S; i++) {
            const pi = i * 4;
            if (r.color[pi + 3] < 1) continue;
            const dest = [color[pi], color[pi + 1], color[pi + 2], color[pi + 3]];
            const srcPx = [r.color[pi], r.color[pi + 1], r.color[pi + 2], r.color[pi + 3]];
            blendPixel(dest, srcPx, "normal", 1);
            color[pi] = dest[0]; color[pi + 1] = dest[1]; color[pi + 2] = dest[2]; color[pi + 3] = dest[3];
            if (r.depth && r.depth[i] > depth[i]) depth[i] = r.depth[i];
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
          depth,
          px: d.x,
          py: d.y,
          sort: this.sortKey(c.offsetX, c.offsetY, c.offsetZ),
        };
      });
      cells.sort((a, b) => a.sort - b.sort);
      return cells;
    }

    exportCells() {
      // Orden estable para Atlas: horizontal (offsetY, offsetX, offsetZ) — celdas en fila.
      const cells = this.buildCells().slice().sort((a, b) =>
        (a.offsetY - b.offsetY) || (a.offsetX - b.offsetX) || (a.offsetZ - b.offsetZ));
      return cells.map((c) => ({
        size: c.size,
        color: c.color,
        normal: c.normal,
        offsetX: c.offsetX,
        offsetY: c.offsetY,
        offsetZ: c.offsetZ,
        label: c.label,
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

      const ensDepth = new Float32Array(W * H).fill(-Infinity);
      for (const c of cells) {
        const dx = c.px - minX;
        const dy = c.py - minY;
        // Depth bias por altura de celda: más alto (offsetY) = un poco más cerca en pantalla iso
        const cellBias = (c.offsetY | 0) * 0.05 + (c.offsetX + c.offsetZ) * 0.001;
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const si = (y * S + x) * 4;
            if (c.color[si + 3] < 1) continue;
            const di = ((dy + y) * W + (dx + x)) * 4;
            const d = [color[di], color[di + 1], color[di + 2], color[di + 3]];
            const s = [c.color[si], c.color[si + 1], c.color[si + 2], c.color[si + 3]];
            blendPixel(d, s, "normal", 1);
            color[di] = d[0]; color[di + 1] = d[1]; color[di + 2] = d[2]; color[di + 3] = d[3];
            const zi = (dy + y) * W + (dx + x);
            const zd = (c.depth ? c.depth[y * S + x] : 0.5) + cellBias;
            if (zd > ensDepth[zi]) ensDepth[zi] = zd;
          }
        }
      }

      // AO entre celdas del conjunto (contactos, huecos, solapes iso).
      const ao = this.doc.ao || {};
      let ensColor = color;
      if (ao.enabled !== false && ao.crossCell !== false && (ao.strength ?? 0.5) > 0) {
        ensColor = applyScreenAO(color, ensDepth, W, H, {
          strength: (ao.strength ?? 0.5) * 0.85,
          radius: Math.max(2, (ao.radius ?? 3) + 1),
          samples: ao.samples ?? 12,
        });
      }

      this.preview = {
        size: S, w: W, h: H, color: ensColor,
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
      const scale = this.#partScale();
      c.width = S * scale;
      c.height = S * scale;
      this.syncZoomLabels();
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      this.fillChecker(ctx, c.width, c.height);
      if (!this.activeCell) return;
      const off = document.createElement("canvas");
      off.width = S; off.height = S;
      off.getContext("2d").putImageData(
        new ImageData(new Uint8ClampedArray(this.activeCell.color), S, S), 0, 0);
      ctx.drawImage(off, 0, 0, c.width, c.height);
      // Marco de la celda 64×64 (el arte iso deja las esquinas vacías a propósito)
      ctx.strokeStyle = "rgba(95, 211, 176, 0.35)";
      ctx.lineWidth = Math.max(1, Math.round(scale / 2));
      ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
      // Diamante del suelo del tile (donde ancla el juego: centro en 32,16)
      const hw = c.width / 2, hh = c.height / 4;
      ctx.strokeStyle = "rgba(95, 211, 176, 0.9)";
      ctx.beginPath();
      ctx.moveTo(hw, 0.5);
      ctx.lineTo(c.width - 0.5, hh);
      ctx.lineTo(hw, hh * 2);
      ctx.lineTo(0.5, hh);
      ctx.closePath();
      ctx.stroke();
    }

    paintEnsemble() {
      const W = this.preview?.w || this.doc.size;
      const H = this.preview?.h || this.doc.size;
      const S = this.preview?.size || this.doc.size;
      const c = this.ensembleCanvas;
      const scale = this.#ensScale();
      c.width = W * scale;
      c.height = H * scale;
      this.syncZoomLabels();
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      this.fillChecker(ctx, c.width, c.height);
      if (!this.preview) return;
      const off = document.createElement("canvas");
      off.width = W; off.height = H;
      off.getContext("2d").putImageData(
        new ImageData(new Uint8ClampedArray(this.preview.color), W, H), 0, 0);
      ctx.drawImage(off, 0, 0, c.width, c.height);
      // Contorno: diamante isométrico de la celda (no el cuadrado vacío de las esquinas).
      // El cuadrado 64×64 tiene esquinas transparentes por diseño del iso; el diamante es el “suelo” real.
      if (this.preview.outlines) {
        ctx.font = `${Math.max(10, 9 * scale)}px sans-serif`;
        for (const o of this.preview.outlines) {
          const x = o.x * scale, y = o.y * scale, s = S * scale;
          const hw = s / 2, hh = s / 4; // HalfTileW / HalfTileH en pantalla
          ctx.strokeStyle = o.active
            ? "rgba(95, 211, 176, 0.95)"
            : (o.multipart ? "rgba(127, 178, 255, 0.65)" : "rgba(255,255,255,0.3)");
          ctx.lineWidth = o.active ? 2 : 1;
          // Diamante superior (centro del tile en y = hh desde el top-left del sprite)
          ctx.beginPath();
          ctx.moveTo(x + hw, y);           // top
          ctx.lineTo(x + s, y + hh);       // right
          ctx.lineTo(x + hw, y + hh * 2);  // bottom of diamond
          ctx.lineTo(x, y + hh);           // left
          ctx.closePath();
          ctx.stroke();
          // Línea vertical de altura de bloque (LayerStepY = s/2) para ver el “cuerpo”
          ctx.beginPath();
          ctx.moveTo(x + hw, y + hh * 2);
          ctx.lineTo(x + hw, y + s);
          ctx.stroke();
          if (scale >= 2) {
            ctx.fillStyle = o.active ? "rgba(95, 211, 176, 0.9)" : "rgba(180,190,200,0.75)";
            ctx.fillText(`${o.ox},${o.oy},${o.oz}`, x + 4, y + 12);
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
    // Multipart planta: tiene parts[] aunque result.color pueda ser un stack compuesto.
    const hasParts = result?.parts && result.parts.length > 0;
    if (!result?.color && !hasParts) return false;
    if (Aura.composerBridge?.pushResult) {
      Aura.composerBridge.pushResult(result, meta);
      return true;
    }
    const q = prefs.get(QUEUE_KEY, []);
    if (hasParts && result.parts.length > 1) {
      q.push({
        multipart: true,
        size: result.size || result.parts[0].size || 64,
        parts: result.parts.map((p) => ({
          size: p.size || result.size || 64,
          color: Array.from(p.color),
          normal: p.normal ? Array.from(p.normal) : null,
        })),
        meta: { name: meta.name, source: meta.source },
      });
    } else {
      const src = hasParts ? result.parts[0] : result;
      q.push({
        size: src.size || result.size || result.w || 64,
        w: result.w, h: result.h,
        color: Array.from(src.color || result.color),
        normal: (src.normal || result.normal) ? Array.from(src.normal || result.normal) : null,
        meta: { name: meta.name, source: meta.source },
      });
    }
    prefs.set(QUEUE_KEY, q);
    return true;
  }

  Aura.composerTool = { composerTool, queueResult, spriteLayerFromResult };
})(window.Aura ??= {});
