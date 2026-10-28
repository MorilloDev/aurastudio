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

  function defaultGroup(i = 0, multipart = false, folder = false) {
    return {
      id: uid(),
      name: folder ? ("Carpeta " + (i + 1)) : (multipart ? ("Parte " + (i + 1)) : ("Grupo " + (i + 1))),
      visible: true,
      collapsed: false,
      locked: false,
      folder: !!folder,          // solo organización; no es celda
      multipart: !!multipart && !folder,
      offsetX: multipart && !folder ? i : 0,
      offsetY: 0,
      offsetZ: 0,
      layers: [],
      children: [],              // grupos anidados
      view: "front",             // front | back | inverted | horizontal
    };
  }

  /** Recorre el árbol de grupos (profundidad). */
  function walkGroups(list, fn, parent = null, depth = 0) {
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      fn(g, { parent, index: i, list, depth });
      if (g.children?.length) walkGroups(g.children, fn, g, depth + 1);
    }
  }

  function findGroup(list, id, parent = null) {
    if (!list || id == null) return null;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (g.id === id) return { group: g, parent, index: i, list };
      const nested = findGroup(g.children || [], id, g);
      if (nested) return nested;
    }
    return null;
  }

  function cloneLayer(L) {
    return {
      ...JSON.parse(JSON.stringify({ ...L, color: null, normal: null, depth: null })),
      id: uid(),
      color: L.color ? new Uint8ClampedArray(L.color) : null,
      normal: L.normal ? new Uint8ClampedArray(L.normal) : null,
      depth: L.depth ? new Uint8ClampedArray(L.depth) : null,
    };
  }

  function cloneGroup(g, deep = true) {
    const out = {
      ...JSON.parse(JSON.stringify({
        ...g, layers: [], children: [], color: undefined,
      })),
      id: uid(),
      layers: deep ? (g.layers || []).map(cloneLayer) : [],
      children: deep ? (g.children || []).map((c) => cloneGroup(c, true)) : [],
    };
    return out;
  }


  function defaultDoc() {
    return {
      size: 64, groups: [], selectedGroupId: null, selectedLayer: -1,
      filter: "",
      ao: { enabled: true, strength: 0.5, radius: 3, samples: 12, crossCell: true },
    };
  }

  /** Migra docs antiguos (layers planos con offset) al modelo de grupos. */
  function normalizeGroup(g, gi = 0) {
    const base = defaultGroup(gi, !!g.multipart, !!g.folder);
    const layers = (g.layers || []).map((l, li) => {
      const b = l.kind === "sprite"
        ? spriteLayerFromResult({ size: l.size || 64, color: null }, l)
        : defaultShapeLayer(li);
      return { ...b, ...l, color: null, normal: null };
    });
    const children = (g.children || []).map((c, ci) => normalizeGroup(c, ci));
    return {
      ...base, ...g,
      folder: !!g.folder,
      locked: !!g.locked,
      view: ["front","back","inverted","horizontal"].includes(g.view) ? g.view : "front",
      children,
      layers,
    };
  }

  function migrateDoc(raw) {
    if (raw?.groups && Array.isArray(raw.groups)) {
      const groups = raw.groups.map((g, gi) => normalizeGroup(g, gi));
      let selectedGroupId = raw.selectedGroupId || null;
      if (!selectedGroupId && groups.length) {
        const idx = Math.max(0, Math.min(raw.selectedGroup | 0, groups.length - 1));
        selectedGroupId = groups[idx]?.id || null;
      }
      return {
        size: raw.size || 64,
        selectedGroupId,
        selectedLayer: raw.selectedLayer | 0,
        filter: raw.filter || "",
        ao: { enabled: true, strength: 0.5, radius: 3, samples: 12, crossCell: true, ...(raw.ao || {}) },
        groups,
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
      if (!groups.length) return { size: raw.size || 64, groups: [], selectedGroupId: null, selectedLayer: -1, ao: { enabled: true, strength: 0.5, radius: 3, samples: 12, crossCell: true, ...(raw.ao || {}) } };
      return { size: raw.size || 64, groups, selectedGroupId: groups[0]?.id || null, selectedLayer: 0 };
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


  /** Normal por defecto (cara superior del motor: #80EEBF) para píxeles opacos sin mapa. */
  const DEFAULT_TOP_N = [128, 238, 191];

  /**
   * Asegura un buffer _n del tamaño de la celda, alineado al alpha del color.
   * - Si hay normal de capas, se usa.
   * - Píxeles opacos sin normal → cara superior por defecto (como un bloque sin detalle).
   * - Transparentes → alpha 0 (el Atlas no pinta basura).
   * Así el Atlas siempre puede escribir _n.png igual que Bloque/Planta.
   */
  function ensureCellNormal(color, normal, size) {
    const n = size * size * 4;
    const out = new Uint8ClampedArray(n);
    for (let i = 0; i < size * size; i++) {
      const a = color[i * 4 + 3];
      if (a < 1) continue;
      const pi = i * 4;
      if (normal && normal[pi + 3] > 0) {
        out[pi] = normal[pi];
        out[pi + 1] = normal[pi + 1];
        out[pi + 2] = normal[pi + 2];
        out[pi + 3] = 255;
      } else {
        out[pi] = DEFAULT_TOP_N[0];
        out[pi + 1] = DEFAULT_TOP_N[1];
        out[pi + 2] = DEFAULT_TOP_N[2];
        out[pi + 3] = 255;
      }
    }
    return out;
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
          h("button", { title: "Grupo organización", onclick: () => this.addGroup(false) }, "+ Grupo"),
          h("button", { class: "primary", title: "Celda multipart", onclick: () => this.addGroup(true) }, "+ Parte"),
          h("button", { title: "Carpeta (anida grupos)", onclick: () => this.addFolder() }, "+ Carpeta"),
          h("button", { title: "Deshacer", onclick: () => this.undo() }, "↶")),
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
          h("button", { title: "Ajustar parte", onclick: () => { this.zoomPart = 0; this.paintPart(); this.syncZoomLabels(); } }, "Ajustar"),
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

      // Layout 3 columnas: árbol | lienzo | inspector
      host.appendChild(h("div", { class: "cp cp-3col" },
        h("aside", { class: "cp-left" },
          h("div", { class: "cp-side-head" },
            h("b", null, "Grupos / Partes"),
            h("span", { class: "grow" }),
            h("button", {
              type: "button", class: "cp-mini-btn", title: "Grupo de organización",
              onclick: () => this.addGroup(false),
            }, "+ Grupo"),
            h("button", {
              type: "button", class: "cp-mini-btn primary", title: "Nueva celda multipart",
              onclick: () => this.addGroup(true),
            }, "+ Parte"),
            h("button", {
              type: "button", class: "cp-mini-btn", title: "Carpeta contenedora",
              onclick: () => this.addFolder(),
            }, "+ Carpeta")),
          this.groupList,
          h("div", { class: "cp-gen-block" },
            h("div", { class: "cp-side-head" }, h("b", null, "Generar")),
            h("button", {
              type: "button", class: "cp-gen-btn",
              title: "Abrir generador de bloques",
              onclick: () => this.studio?.tools?.find?.((x) => x.id === "create")?.openGenerator?.("blocks")
                || this.studio?.tools?.find?.((x) => x.id === "create")?.show?.("blocks"),
            }, "▣ Bloque…"),
            h("button", {
              type: "button", class: "cp-gen-btn plant",
              title: "Abrir generador de plantas",
              onclick: () => this.studio?.tools?.find?.((x) => x.id === "create")?.openGenerator?.("plants")
                || this.studio?.tools?.find?.((x) => x.id === "create")?.show?.("plants"),
            }, "🌿 Planta…"),
            h("button", {
              type: "button", class: "cp-gen-btn form",
              onclick: () => this.addShapeLayer(),
            }, "◇ Forma"))),
        h("div", { class: "cp-center" },
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
              this.ensView))),
        h("aside", { class: "cp-right" },
          h("div", { class: "cp-side-head" }, h("b", null, "Inspector")),
          this.propsHost)));

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
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); this.undo(); }
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
        let hitId = null;
        walkGroups(this.doc.groups, (g) => {
          if (!g.visible || g.folder) return;
          const ox = g.multipart ? (g.offsetX | 0) : 0;
          const oy = g.multipart ? (g.offsetY | 0) : 0;
          const oz = g.multipart ? (g.offsetZ | 0) : 0;
          if (ox === hit.ox && oy === hit.oy && oz === hit.oz) hitId = g.id;
        });
        if (hitId) this.selectGroup(hitId, 0);
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
      const id = this.doc.selectedGroupId;
      if (!id) return null;
      return findGroup(this.doc.groups, id)?.group || null;
    }

    groupRef() {
      const id = this.doc.selectedGroupId;
      if (!id) return null;
      return findGroup(this.doc.groups, id);
    }

    layer() {
      const g = this.group();
      if (!g || !g.layers?.length) return null;
      const i = this.doc.selectedLayer;
      if (i == null || i < 0 || i >= g.layers.length) return null;
      return g.layers[i];
    }

    selectGroup(id, layerIndex = -1) {
      this.doc.selectedGroupId = id;
      this.doc.selectedLayer = layerIndex;
      this.rebuildGroupList();
      this.rebuildProps();
      this.schedule();
    }

    pushHistory() {
      try {
        this._undo = this._undo || [];
        this._redo = [];
        const snap = {
          selectedGroupId: this.doc.selectedGroupId,
          selectedLayer: this.doc.selectedLayer,
          groups: JSON.parse(JSON.stringify(this.doc.groups, (k, v) => {
            if (v instanceof Uint8ClampedArray || v instanceof Float32Array) return null;
            return v;
          })),
          pixels: {},
        };
        walkGroups(this.doc.groups, (g) => {
          for (const L of g.layers || []) {
            if (L.color) snap.pixels[L.id] = {
              color: Array.from(L.color),
              normal: L.normal ? Array.from(L.normal) : null,
            };
          }
        });
        this._undo.push(snap);
        if (this._undo.length > 30) this._undo.shift();
      } catch (err) { console.warn("composer history", err); }
    }

    restoreSnap(snap) {
      if (!snap) return;
      const restoreG = (list) => (list || []).map((g) => {
        const layers = (g.layers || []).map((l) => {
          const px = snap.pixels[l.id];
          return {
            ...l,
            color: px?.color ? new Uint8ClampedArray(px.color) : null,
            normal: px?.normal ? new Uint8ClampedArray(px.normal) : null,
          };
        });
        return { ...g, layers, children: restoreG(g.children) };
      });
      this.doc.groups = restoreG(snap.groups);
      this.doc.selectedGroupId = snap.selectedGroupId;
      this.doc.selectedLayer = snap.selectedLayer;
      this.touch();
    }

    undo() {
      if (!this._undo?.length) return;
      const cur = this._undo.pop();
      this._redo = this._redo || [];
      // push current before restore
      const before = cur; // already popped current tip is the state to restore TO... 
      // Fix: undo stack stores past states; on mutation we push. So pop and restore.
      this.restoreSnap(before);
      this.studio?.toast("Deshacer", { kind: "ok" });
    }

    // ── mutations ───────────────────────────────────────────────────────────

    addGroup(multipart, folder = false) {
      this.pushHistory();
      const count = { n: 0 };
      walkGroups(this.doc.groups, () => { count.n++; });
      const g = defaultGroup(count.n, multipart, folder);
      if (multipart && !folder) {
        const used = new Set();
        walkGroups(this.doc.groups, (x) => {
          if (x.multipart) used.add(x.offsetX + "," + x.offsetY + "," + x.offsetZ);
        });
        let x = 0;
        while (used.has(x + ",0,0")) x++;
        g.offsetX = x;
      }
      // Si el grupo activo es carpeta, anidar dentro; si no, top-level
      const cur = this.group();
      if (cur?.folder) {
        cur.children = cur.children || [];
        cur.children.push(g);
        cur.collapsed = false;
      } else {
        this.doc.groups.push(g);
      }
      this.doc.selectedGroupId = g.id;
      this.doc.selectedLayer = -1;
      this.touch();
    }

    addFolder() {
      this.addGroup(false, true);
    }

    duplicateGroup() {
      const ref = this.groupRef();
      if (!ref) return;
      this.pushHistory();
      const copy = cloneGroup(ref.group, true);
      copy.name = (ref.group.name || "Grupo") + " copia";
      ref.list.splice(ref.index + 1, 0, copy);
      this.doc.selectedGroupId = copy.id;
      this.doc.selectedLayer = -1;
      this.touch();
      this.studio?.toast("Grupo duplicado", { kind: "ok" });
    }

    addShapeLayer() {
      let g = this.group();
      if (!g) {
        this.addGroup(false);
        g = this.group();
      }
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
      if (g.locked) {
        this.studio?.toast("Grupo bloqueado", { kind: "warn" });
        return;
      }
      this.pushHistory();

      // Capa seleccionada → solo esa capa
      if (g.layers && g.layers.length && this.doc.selectedLayer >= 0 && this.doc.selectedLayer < g.layers.length) {
        const L = g.layers[this.doc.selectedLayer];
        if (L.locked) {
          this.studio?.toast("Capa bloqueada", { kind: "warn" });
          return;
        }
        g.layers.splice(this.doc.selectedLayer, 1);
        this.doc.selectedLayer = g.layers.length
          ? Math.min(this.doc.selectedLayer, g.layers.length - 1)
          : -1;
        this.touch();
        return;
      }

      // Borrar grupo del árbol
      const ref = this.groupRef();
      if (!ref) return;
      ref.list.splice(ref.index, 1);
      if (!this.doc.groups.length) {
        this.doc.selectedGroupId = null;
        this.doc.selectedLayer = -1;
      } else {
        // seleccionar vecino o padre
        if (ref.parent) {
          this.doc.selectedGroupId = ref.parent.id;
        } else if (ref.list.length) {
          const ni = Math.min(ref.index, ref.list.length - 1);
          this.doc.selectedGroupId = ref.list[ni].id;
        } else if (ref.parent) {
          this.doc.selectedGroupId = ref.parent.id;
        } else {
          this.doc.selectedGroupId = this.doc.groups[0]?.id || null;
        }
        this.doc.selectedLayer = -1;
      }
      this.touch();
    }


    pushResult(result, meta = {}) {
      // Planta multipart: result.parts = [abajo…arriba]
      const parts = (result?.parts && result.parts.length) ? result.parts : null;
      if (parts && parts.length > 1) {
        const baseName = meta.name || meta.source || "planta";
        const size = result.size || parts[0].size || 64;
        this.doc.size = Math.max(this.doc.size || 64, size);
        for (let k = 0; k < parts.length; k++) {
          const part = parts[k];
          if (!part?.color) continue;
          const g = defaultGroup(this.doc.groups.length, true);
          g.name = baseName + " p" + (k + 1);
          g.offsetX = 0; g.offsetY = k; g.offsetZ = 0;
          g.multipart = true;
          const layer = spriteLayerFromResult(part, {
            name: baseName + " p" + (k + 1),
            source: meta.source || "planta",
          });
          if (part.depth) layer.depth = new Uint8ClampedArray(part.depth);
          g.layers = [layer];
          this.doc.groups.push(g);
        }
        this.doc.selectedGroupId = this.doc.groups[this.doc.groups.length - 1]?.id || null;
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
      if (!g) return;

      const layer = spriteLayerFromResult(single, meta);
      if (single.depth) layer.depth = new Uint8ClampedArray(single.depth);
      if (single.size) this.doc.size = Math.max(this.doc.size || 64, single.size);

      // Si hay capa seleccionada → reemplazar su contenido (mismo slot).
      // Si no hay capa → crear una nueva en el grupo.
      const L = this.layer();
      if (L) {
        L.kind = "sprite";
        L.name = layer.name || L.name;
        L.color = layer.color;
        L.normal = layer.normal;
        L.depth = layer.depth || null;
        L.size = layer.size;
        L.source = layer.source;
        L.shape = null;
        // mantener shift/blend/opacity/tint del usuario
      } else {
        g.layers.push(layer);
        this.doc.selectedLayer = g.layers.length - 1;
      }
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
      const serG = (g) => ({
        id: g.id, name: g.name, visible: g.visible, collapsed: g.collapsed,
        locked: !!g.locked, folder: !!g.folder,
        multipart: g.multipart, view: g.view || "front", offsetX: g.offsetX, offsetY: g.offsetY, offsetZ: g.offsetZ,
        layers: (g.layers || []).map((l) => ({
          id: l.id, kind: l.kind, name: l.name, visible: l.visible, locked: !!l.locked,
          shiftX: l.shiftX, shiftY: l.shiftY,
          blend: l.blend, opacity: l.opacity, tint: l.tint,
          shape: l.shape, params: l.params, rot3d: l.rot3d,
          size: l.size, source: l.source,
        })),
        children: (g.children || []).map(serG),
      });
      prefs.set(PREFS_KEY, {
        size: this.doc.size,
        selectedGroupId: this.doc.selectedGroupId,
        selectedLayer: this.doc.selectedLayer,
        filter: this.doc.filter || "",
        ao: this.doc.ao,
        groups: this.doc.groups.map(serG),
      });
    }

    // ── UI lists ────────────────────────────────────────────────────────────

    rebuildGroupList() {
      const filter = (this.doc.filter || "").trim().toLowerCase();
      const tools = h("div", { class: "cp-tree-tools" }, this.#treeTools());

      if (!this.doc.groups.length) {
        this.groupList.replaceChildren(
          tools,
          h("p", { class: "note cp-tree-empty" },
            "Sin grupos. + Grupo / + Parte / + Carpeta, o aplica Bloque/Planta."));
        return;
      }

      const frag = [tools];
      const matches = (g) => {
        if (!filter) return true;
        if ((g.name || "").toLowerCase().includes(filter)) return true;
        if ((g.layers || []).some((L) => (L.name || "").toLowerCase().includes(filter))) return true;
        return (g.children || []).some(matches);
      };

      const renderGroup = (g, depth) => {
        if (filter && !matches(g)) return;
        const isSel = g.id === this.doc.selectedGroupId;
        const depthCls = "cp-depth-" + Math.min(depth, 4);

        const head = h("div", {
          class: ["cp-row", "cp-group-head", isSel && this.doc.selectedLayer < 0 && "active",
            g.multipart && "multipart", g.folder && "folder", g.locked && "locked", depthCls],
          style: { "--d": depth },
          "data-drop": "group",
          "data-id": g.id,
          onclick: () => this.selectGroup(g.id, -1),
          oncontextmenu: (e) => { e.preventDefault(); this.selectGroup(g.id, -1); this.#openCtx(e, { type: "group", id: g.id }); },
        },
          h("span", {
            class: "cp-grip",
            title: "Arrastrar",
            draggable: !g.locked,
            ondragstart: (e) => {
              e.stopPropagation();
              e.dataTransfer.setData("application/x-cp-group", g.id);
              e.dataTransfer.setData("text/plain", "group:" + g.id);
              e.dataTransfer.effectAllowed = "move";
              e.currentTarget.closest(".cp-row")?.classList.add("cp-dragging");
            },
            ondragend: (e) => {
              e.currentTarget.closest(".cp-row")?.classList.remove("cp-dragging");
              this.groupList.querySelectorAll(".cp-drop").forEach((el) => el.classList.remove("cp-drop"));
            },
          }, "⠿"),
          h("input", {
            type: "checkbox", class: "cp-vis",
            checked: g.visible !== false || null,
            title: "Visible",
            onclick: (e) => e.stopPropagation(),
            onchange: (e) => { g.visible = e.target.checked; this.touch(); },
          }),
          h("button", {
            type: "button", class: "cp-collapse",
            onclick: (e) => { e.stopPropagation(); g.collapsed = !g.collapsed; this.rebuildGroupList(); },
          }, g.collapsed ? "▸" : "▾"),
          h("span", { class: "cp-row-name" }, g.folder ? "📁 " + g.name : g.name),
          g.locked ? h("span", { class: "cp-tag muted" }, "🔒") : null,
          g.folder
            ? h("span", { class: "cp-tag muted" }, "carpeta")
            : g.multipart
              ? h("span", { class: "cp-tag mp" }, (g.offsetX | 0) + "," + (g.offsetY | 0) + "," + (g.offsetZ | 0))
              : h("span", { class: "cp-tag muted" }, "grupo"),
          !g.folder ? h("button", {
            type: "button",
            class: ["cp-mp-btn", g.multipart && "on"],
            title: "Multipart",
            onclick: (e) => {
              e.stopPropagation();
              if (g.locked) return;
              g.multipart = !g.multipart;
              this.touch();
            },
          }, "MP") : null,
        );
        frag.push(head);

        if (!g.collapsed) {
          (g.layers || []).forEach((L, li) => {
            if (filter && !(L.name || "").toLowerCase().includes(filter) && !(g.name || "").toLowerCase().includes(filter)) return;
            const row = h("div", {
              class: ["cp-row", "cp-layer", isSel && li === this.doc.selectedLayer && "active", L.locked && "locked", depthCls],
              style: { "--d": depth + 1 },
              "data-drop": "layer",
              "data-id": L.id,
              "data-gid": g.id,
              "data-li": String(li),
              onclick: () => this.selectGroup(g.id, li),
              oncontextmenu: (e) => {
                e.preventDefault();
                this.selectGroup(g.id, li);
                this.#openCtx(e, { type: "layer", id: L.id, groupId: g.id, index: li });
              },
            },
              h("span", {
                class: "cp-grip",
                title: "Arrastrar capa",
                draggable: !L.locked && !g.locked,
                ondragstart: (e) => {
                  e.stopPropagation();
                  e.dataTransfer.setData("application/x-cp-layer", L.id);
                  e.dataTransfer.setData("text/plain", "layer:" + L.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.currentTarget.closest(".cp-row")?.classList.add("cp-dragging");
                },
                ondragend: (e) => {
                  e.currentTarget.closest(".cp-row")?.classList.remove("cp-dragging");
                  this.groupList.querySelectorAll(".cp-drop").forEach((el) => el.classList.remove("cp-drop"));
                },
              }, "⠿"),
              h("input", {
                type: "checkbox", class: "cp-vis",
                checked: L.visible !== false || null,
                onclick: (e) => e.stopPropagation(),
                onchange: (e) => { L.visible = e.target.checked; this.touch(); },
              }),
              h("span", { class: "cp-row-name" }, L.name || "Capa"),
              h("span", { class: "cp-tag muted" }, L.kind === "sprite" ? (L.source || "sprite") : (L.shape || "shape")),
            );
            frag.push(row);
          });
          (g.children || []).forEach((ch) => renderGroup(ch, depth + 1));
        }
      };

      this.doc.groups.forEach((g) => renderGroup(g, 0));
      this.groupList.replaceChildren(...frag);
      this.#bindTreeDnD();
    }

    #treeTools() {
      return [
        h("input", {
          type: "search", class: "cp-tree-filter", placeholder: "Buscar…",
          value: this.doc.filter || "",
          oninput: (e) => { this.doc.filter = e.target.value; this.rebuildGroupList(); },
        }),
        h("button", { type: "button", title: "Deshacer (Ctrl+Z)", onclick: () => this.undo() }, "↶"),
      ];
    }

    #bindTreeDnD() {
      if (this._dndBound) return;
      this._dndBound = true;
      const root = this.groupList;
      root.addEventListener("dragover", (e) => {
        const row = e.target.closest?.(".cp-row");
        if (!row || !root.contains(row)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        root.querySelectorAll(".cp-drop").forEach((el) => { if (el !== row) el.classList.remove("cp-drop"); });
        row.classList.add("cp-drop");
      });
      root.addEventListener("dragleave", (e) => {
        if (!root.contains(e.relatedTarget)) {
          root.querySelectorAll(".cp-drop").forEach((el) => el.classList.remove("cp-drop"));
        }
      });
      root.addEventListener("drop", (e) => {
        e.preventDefault();
        const row = e.target.closest?.(".cp-row");
        root.querySelectorAll(".cp-drop").forEach((el) => el.classList.remove("cp-drop"));
        if (!row) return;
        const layerId = e.dataTransfer.getData("application/x-cp-layer") ||
          (e.dataTransfer.getData("text/plain") || "").replace(/^layer:/, "");
        const groupId = e.dataTransfer.getData("application/x-cp-group") ||
          ((e.dataTransfer.getData("text/plain") || "").startsWith("group:")
            ? e.dataTransfer.getData("text/plain").slice(6) : "");
        const dropType = row.getAttribute("data-drop");
        const dropId = row.getAttribute("data-id");
        const dropGid = row.getAttribute("data-gid");
        const dropLi = Number(row.getAttribute("data-li") || 0);

        if (layerId && layerId !== "layer:") {
          if (dropType === "group") this.moveLayerToGroup(layerId, dropId);
          else if (dropType === "layer") this.moveLayerBefore(layerId, dropGid, dropLi);
          return;
        }
        if (groupId && groupId !== "group:") {
          if (dropType === "group") this.moveGroupTo(groupId, dropId);
        }
      });
    }

    #closeCtx() {
      this._ctx?.remove();
      this._ctx = null;
    }

    #openCtx(e, target) {
      this.#closeCtx();
      const items = [];
      if (target.type === "layer") {
        const g = findGroup(this.doc.groups, target.groupId)?.group;
        const li = target.index;
        // Subir/bajar: solo reordena dentro del mismo grupo (no sale del grupo).
        items.push(
          { label: "Subir en el grupo", disabled: !g || li <= 0, action: () => this.moveLayerInGroup(target.groupId, li, -1) },
          { label: "Bajar en el grupo", disabled: !g || !g.layers || li >= g.layers.length - 1, action: () => this.moveLayerInGroup(target.groupId, li, 1) },
          { sep: true },
        );
        const destinations = [];
        walkGroups(this.doc.groups, (gg) => {
          if (!gg.folder && gg.id !== target.groupId) destinations.push(gg);
        });
        if (destinations.length) {
          items.push({ label: "Mover a otro grupo…", disabled: true });
          destinations.forEach((gg) => {
            items.push({
              label: "  → " + (gg.name || "Grupo"),
              action: () => this.moveLayerToGroup(target.id, gg.id),
            });
          });
          items.push({ sep: true });
        }
        items.push(
          { label: "Duplicar capa", action: () => this.duplicateLayer() },
          { label: "Eliminar capa", danger: true, action: () => { this.selectGroup(target.groupId, li); this.removeSelected(); } },
        );
      } else if (target.type === "group") {
        const g = findGroup(this.doc.groups, target.id)?.group;
        const ref = findGroup(this.doc.groups, target.id);
        items.push(
          { label: "Subir en la lista", disabled: !ref || ref.index <= 0, action: () => this.moveGroupInList(target.id, -1) },
          { label: "Bajar en la lista", disabled: !ref || ref.index >= ref.list.length - 1, action: () => this.moveGroupInList(target.id, 1) },
          { sep: true },
          { label: g?.locked ? "Desbloquear" : "Bloquear", action: () => { if (g) { g.locked = !g.locked; this.touch(); } } },
          { label: "Duplicar grupo", action: () => { this.selectGroup(target.id, -1); this.duplicateGroup(); } },
          { sep: true },
        );
        const folders = [];
        walkGroups(this.doc.groups, (gg) => {
          if (gg.folder && gg.id !== target.id) folders.push(gg);
        });
        if (folders.length) {
          folders.forEach((ff) => {
            items.push({
              label: "Mover a 📁 " + ff.name,
              action: () => this.moveGroupTo(target.id, ff.id),
            });
          });
          items.push({ sep: true });
        }
        items.push(
          { label: "Sacar de carpeta (raíz)", action: () => this.moveGroupToRoot(target.id) },
          { sep: true },
          { label: "Eliminar grupo", danger: true, action: () => { this.selectGroup(target.id, -1); this.doc.selectedLayer = -1; this.removeSelected(); } },
        );
      }

      const menu = h("div", { class: "cp-ctx" },
        ...items.map((it) => {
          if (it.sep) return h("div", { class: "cp-ctx-sep" });
          return h("button", {
            type: "button",
            class: ["cp-ctx-item", it.danger && "danger", it.disabled && "disabled"],
            disabled: it.disabled || null,
            onclick: () => { this.#closeCtx(); if (!it.disabled) it.action(); },
          }, it.label);
        }));
      menu.style.position = "fixed";
      menu.style.left = "0px";
      menu.style.top = "0px";
      menu.style.visibility = "hidden";
      document.body.appendChild(menu);
      const mw = menu.offsetWidth || 220;
      const mh = menu.offsetHeight || 200;
      let left = e.clientX;
      let top = e.clientY;
      if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
      if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
      if (left < 8) left = 8;
      if (top < 8) top = 8;
      menu.style.left = left + "px";
      menu.style.top = top + "px";
      menu.style.visibility = "visible";
      this._ctx = menu;
      const closer = (ev) => {
        if (menu.contains(ev.target)) return;
        this.#closeCtx();
        document.removeEventListener("pointerdown", closer, true);
      };
      setTimeout(() => document.addEventListener("pointerdown", closer, true), 0);
    }

    moveLayerInGroup(groupId, li, dir) {
      const g = findGroup(this.doc.groups, groupId)?.group;
      if (!g) return;
      const j = li + dir;
      if (j < 0 || j >= g.layers.length) return;
      this.pushHistory();
      [g.layers[li], g.layers[j]] = [g.layers[j], g.layers[li]];
      this.doc.selectedGroupId = groupId;
      this.doc.selectedLayer = j;
      this.touch();
    }

    moveGroupInList(groupId, dir) {
      const ref = findGroup(this.doc.groups, groupId);
      if (!ref) return;
      const j = ref.index + dir;
      if (j < 0 || j >= ref.list.length) return;
      this.pushHistory();
      const a = ref.list;
      [a[ref.index], a[j]] = [a[j], a[ref.index]];
      this.doc.selectedGroupId = groupId;
      this.doc.selectedLayer = -1;
      this.touch();
    }

    moveGroupToRoot(groupId) {
      const ref = findGroup(this.doc.groups, groupId);
      if (!ref || !ref.parent) return;
      this.pushHistory();
      const [node] = ref.list.splice(ref.index, 1);
      this.doc.groups.push(node);
      this.doc.selectedGroupId = node.id;
      this.touch();
    }

    /** Mueve capa (por id) al final del grupo destino. */
    moveLayerToGroup(layerId, toGroupId) {
      this.pushHistory();
      let from = null, layer = null, fromIdx = -1;
      walkGroups(this.doc.groups, (g) => {
        const i = (g.layers || []).findIndex((L) => L.id === layerId);
        if (i >= 0) { from = g; layer = g.layers[i]; fromIdx = i; }
      });
      const to = findGroup(this.doc.groups, toGroupId)?.group;
      if (!layer || !to || to.folder) {
        this.studio?.toast(to?.folder ? "Suelta en un grupo, no en carpeta" : "No se pudo mover", { kind: "warn" });
        return;
      }
      if (to.locked || from?.locked) return;
      from.layers.splice(fromIdx, 1);
      to.layers = to.layers || [];
      to.layers.push(layer);
      this.doc.selectedGroupId = to.id;
      this.doc.selectedLayer = to.layers.length - 1;
      this.touch();
    }

    moveLayerBefore(layerId, toGroupId, beforeIndex) {
      this.pushHistory();
      let from = null, layer = null, fromIdx = -1;
      walkGroups(this.doc.groups, (g) => {
        const i = (g.layers || []).findIndex((L) => L.id === layerId);
        if (i >= 0) { from = g; layer = g.layers[i]; fromIdx = i; }
      });
      const to = findGroup(this.doc.groups, toGroupId)?.group;
      if (!layer || !to || to.folder) return;
      from.layers.splice(fromIdx, 1);
      let idx = beforeIndex;
      if (from === to && fromIdx < beforeIndex) idx--;
      to.layers.splice(Math.max(0, idx), 0, layer);
      this.doc.selectedGroupId = to.id;
      this.doc.selectedLayer = to.layers.indexOf(layer);
      this.touch();
    }

    moveGroupTo(groupId, toParentId) {
      if (groupId === toParentId) return;
      this.pushHistory();
      const ref = findGroup(this.doc.groups, groupId);
      const toRef = findGroup(this.doc.groups, toParentId);
      if (!ref || !toRef) return;
      // Evitar ciclos: toParent no puede ser descendiente de groupId
      let cycle = false;
      walkGroups(ref.group.children || [], (c) => { if (c.id === toParentId) cycle = true; });
      if (cycle) return;
      const [node] = ref.list.splice(ref.index, 1);
      const dest = toRef.group;
      if (dest.folder) {
        dest.children = dest.children || [];
        dest.children.push(node);
        dest.collapsed = false;
      } else {
        // insertar después del destino en su lista
        toRef.list.splice(toRef.index + 1, 0, node);
      }
      this.doc.selectedGroupId = node.id;
      this.touch();
    }

    moveLayer(gi, li, dir) {
      const g = this.group();
      if (!g) return;
      this.moveLayerInGroup(g.id, li, dir);
    }

    // ── props ───────────────────────────────────────────────────────────────

    rebuildProps() {
      const g = this.group();
      const L = this.layer();
      const set = (fn) => { fn(); this.savePrefsMeta(); this.schedule(); this.rebuildGroupList(); };
      // Sin grupo seleccionado: inspector vacío (no error).
      if (!g) {
        this.propsHost.replaceChildren(
          h("p", { class: "note" }, "Ningún grupo seleccionado. Crea un grupo o parte, o elige uno en la lista."));
        return;
      }

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

      kids.push(h("div", { class: "field" },
        h("label", null, "Vista"),
        h("select", {
          value: g.view || "front",
          onchange: (e) => set(() => { g.view = e.target.value; }),
        },
          h("option", { value: "front" }, "Front (default)"),
          h("option", { value: "back" }, "Back"),
          h("option", { value: "inverted" }, "Inverted"),
          h("option", { value: "horizontal" }, "Horizontal"),
        ),
      ));
      kids.push(h("p", { class: "note" },
        "Vista del sprite como en bloques: front, back (espejo), inverted (arriba/abajo), horizontal (rotado)."));

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
        kids.push(h("div", { class: "cp-sub" }, "Capa"));
        kids.push(h("p", { class: "note" }, "Este grupo no tiene capas. Añade una forma o aplica un bloque/planta."));
        kids.push(h("button", { type: "button", class: "primary", onclick: () => this.addShapeLayer() }, "+ Forma"));
        kids.push(h("label", { class: "field check" },
          h("input", {
            type: "checkbox", checked: g.locked || null,
            onchange: (e) => { g.locked = e.target.checked; this.touch(); },
          }),
          h("span", null, "Bloquear grupo")));
        this.propsHost.replaceChildren(...kids);
        return;
      }

      kids.push(h("label", { class: "field check" },
        h("input", {
          type: "checkbox", checked: g.locked || null,
          onchange: (e) => { g.locked = e.target.checked; this.touch(); },
        }),
        h("span", null, "Bloquear grupo")));

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
      const active = this.group();
      // Carpetas no aportan celdas; solo grupos visibles con capas (multipart o ancla).
      walkGroups(this.doc.groups, (g, ctx) => {
        // Cascada: si un ancestro está oculto, no dibujar
        let anc = ctx.parent;
        while (anc) {
          if (anc.visible === false) return;
          const pref = findGroup(this.doc.groups, anc.id);
          anc = pref?.parent || null;
        }
        if (g.folder || !g.visible) return;
        if (!(g.layers && g.layers.length)) return;
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
        if (active && g.id === active.id) cell.active = true;
        if (g.multipart) cell.label = g.name;
      });
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
      // Cada celda lleva color + normal (_n) listos, como Bloque/Planta.
      const cells = this.buildCells().slice().sort((a, b) =>
        (a.offsetY - b.offsetY) || (a.offsetX - b.offsetX) || (a.offsetZ - b.offsetZ));
      return cells.map((c) => {
        const size = c.size || this.doc.size || 64;
        return {
          size,
          color: c.color,
          normal: ensureCellNormal(c.color, c.normal, size),
          offsetX: c.offsetX,
          offsetY: c.offsetY,
          offsetZ: c.offsetZ,
          label: c.label,
        };
      });
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
      // Mismo contrato que Bloque → Atlas: pendingPlacement + activate("atlas").
      // El usuario hace clic en la primera celda; el Atlas coloca N celdas en fila horizontal.
      this.render();
      const cells = this.exportCells();
      if (!cells.length) {
        this.studio?.toast("No hay grupos visibles para enviar", { kind: "warn" });
        return;
      }
      const S = cells[0].size || this.doc.size || 64;
      // Clonar buffers: el Composer puede re-renderizar y reutilizar arrays.
      const items = cells.map((c) => ({
        color: new Uint8ClampedArray(c.color),
        // Siempre hay normal (ensureCellNormal en exportCells): el Atlas escribe _n.png
        normal: new Uint8ClampedArray(c.normal),
        label: c.label || ("celda " + c.offsetX + "," + c.offsetY + "," + c.offsetZ),
      }));
      const offsets = cells.map((c) => ({
        offsetX: c.offsetX | 0,
        offsetY: c.offsetY | 0,
        offsetZ: c.offsetZ | 0,
      }));

      this.studio.pendingPlacement = {
        label: "Composer",
        name: "",
        kind: "composer",
        size: S,
        sheetKey: null,
        items,
        buildTile: (coords) => {
          if (!coords?.length) return null;
          if (coords.length === 1 && offsets.length === 1) {
            return { art: { default: { front: coords[0] } } };
          }
          return {
            parts: offsets.map((o, i) => ({
              offsetX: o.offsetX,
              offsetY: o.offsetY,
              offsetZ: o.offsetZ,
              art: { default: { front: coords[i] || coords[0] } },
            })),
          };
        },
        snippet: (coords) => {
          if (!coords?.length) return "";
          if (coords.length === 1 && offsets.length === 1) {
            const cell = coords[0];
            return '"art": { "default": { "front": [' + cell[0] + ", " + cell[1] + "] } }";
          }
          const lines = offsets.map((o, i) => {
            const cell = coords[i] || coords[0];
            return '    { "offsetX": ' + o.offsetX + ', "offsetY": ' + o.offsetY + ', "offsetZ": ' + o.offsetZ +
              ', "art": { "default": { "front": [' + cell[0] + ", " + cell[1] + "] } } }";
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
