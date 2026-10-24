"use strict";

// Formas para construir rápido: cada una devuelve la lista de celdas [x, y, z] que ocuparía. Es lógica pura (no sabe nada
// de tiles ni de vistas): la herramienta las pone, las quita y las previsualiza con las mismas celdas.
//
// Las formas redondas se miden desde el centro de la celda donde haces clic: una celda está dentro si su centro queda a
// menos de r + 0.5 del centro de la forma, así radio 1 es una cruz gorda y radio 2 un círculo de 5 de ancho, sin esquinas raras.
(function (Aura) {
  const MAX_CELLS = 30000;

  /**
   * points: cuántos clics hacen falta (1: se pone en la celda; 2: esquina y esquina opuesta / extremo y extremo).
   * params: los controles que usa. Los que no aparecen aquí no se muestran para esa forma.
   */
  const TYPES = [
    { id: "brush", name: "Pincel", points: 1, params: [], hint: "Un tile por clic." },
    { id: "select", name: "Seleccionar", points: 1, params: ["onlyLevel"], hint: "Clic: elige un bloque (una pieza grande, entera). Ctrl+clic: suma o quita. Shift+arrastrar: una caja (con el derecho: quitar de la selección). Ctrl+A: todo." },
    { id: "line", name: "Línea", points: 2, params: [], hint: "Dos clics: de un extremo a otro, también en diagonal y en altura." },
    { id: "box", name: "Caja", points: 2, params: ["h", "hollow", "t", "caps"], hint: "Dos clics: esquinas opuestas. Alto con el control; hueca = muros, con o sin techo y suelo." },
    { id: "walls", name: "Paredes", points: 2, params: ["h", "t"], hint: "Dos clics: esquinas opuestas. Solo el contorno, sin techo ni suelo." },
    { id: "disc", name: "Disco", points: 1, params: ["r", "ha", "plane"], hint: "Círculo macizo centrado en la celda. Con alto, un cilindro macizo (en vertical, un grosor)." },
    { id: "ring", name: "Anillo", points: 1, params: ["r", "t", "ha", "plane"], hint: "Círculo sin centro: solo el borde. Con alto, un muro redondo." },
    { id: "sphere", name: "Esfera", points: 1, params: ["r", "ha", "hollow", "t", "grounded"], hint: "Maciza o hueca (cáscara). Con alto distinto del diámetro, se estira como un huevo." },
    { id: "dome", name: "Cúpula", points: 1, params: ["r", "ha", "hollow", "t"], hint: "Media esfera apoyada en el nivel; el alto la achata o la alarga." },
    { id: "cylinder", name: "Cilindro", points: 1, params: ["r", "h", "hollow", "t", "caps"], hint: "Torre redonda, maciza o hueca. Sube desde el nivel." },
    { id: "cone", name: "Cono", points: 1, params: ["r", "ha", "hollow", "t"], hint: "Se estrecha hasta la punta (automático: alto = radio + 1)." },
    { id: "pyramid", name: "Pirámide", points: 1, params: ["r", "ha", "hollow", "t"], hint: "Cuadrada, escalonada (automático: alto = radio + 1)." },
  ];

  const DEFAULTS = { onlyLevel: false, r: 3, h: 5, ha: 0, t: 1, hollow: false, capTop: true, capBottom: true, plane: "h", grounded: true };
  const LIMITS = { r: [1, 30], h: [1, 64], ha: [0, 64], t: [1, 10] };

  const typeOf = (id) => TYPES.find((t) => t.id === id) ?? TYPES[0];
  const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));

  /** Dentro de un círculo (o esfera) de radio r, medido en cuadrado de distancias. */
  const inside = (d2, r) => d2 <= (r + 0.5) * (r + 0.5);
  /** En la cáscara: dentro de r y fuera del hueco interior de radio r - t. Con grosor >= radio, es maciza. */
  function inShell(d2, r, t) {
    if (!inside(d2, r)) return false;
    const inner = r - t + 0.5;
    return inner <= 0 || d2 > inner * inner;
  }

  // ── Las formas ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** A disc (or ring) of `layers` thick: up for a horizontal one, along z / x for the two vertical planes. */
  function disc(out, [cx, cy, cz], r, t, hollow, plane, layers = 1) {
    for (let u = -r; u <= r; u++)
      for (let v = -r; v <= r; v++) {
        const d2 = u * u + v * v;
        if (!(hollow ? inShell(d2, r, t) : inside(d2, r))) continue;
        for (let k = 0; k < layers; k++) {
          if (plane === "ns") out.push([cx + u, cy + v, cz + k]);
          else if (plane === "ew") out.push([cx + k, cy + v, cz + u]);
          else out.push([cx + u, cy + k, cz + v]);
        }
      }
  }

  /**
   * A sphere, or its upper half for a dome. Alto (o.ha, 0 = automatic) is the height in cells: the automatic one is the
   * round shape; any other stretches or squashes it into an ellipsoid. The dome stands on the level; a sphere stands on it
   * (grounded) or is centred on the cell.
   */
  function sphere(out, [cx, cy, cz], o, half) {
    const { r, t, hollow } = o;
    const H = o.ha || (half ? r + 1 : 2 * r + 1);
    const R = r + 0.5, A = half ? H - 0.5 : H / 2;           // horizontal and vertical semi-axes
    const y0 = half || o.grounded ? cy : cy - Math.floor(H / 2);
    const ri = r - t + 0.5, ai = A - t;
    const shell = hollow && ri > 0 && ai > 0;
    for (let i = 0; i < H; i++) {
      const dy = half ? i : i - (H - 1) / 2;
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          const h2 = dx * dx + dz * dz;
          if (h2 / (R * R) + (dy * dy) / (A * A) > 1) continue;
          if (shell && h2 / (ri * ri) + (dy * dy) / (ai * ai) <= 1) continue;
          out.push([cx + dx, y0 + i, cz + dz]);
        }
    }
  }

  function cylinder(out, [cx, cy, cz], o) {
    const { r, h, t, hollow } = o;
    for (let y = 0; y < h; y++) {
      const cap = hollow && ((o.capBottom && y < t) || (o.capTop && y >= h - t));
      disc(out, [cx, cy + y, cz], r, t, hollow && !cap, "h");
    }
  }

  /** Radius left at layer i of a taper that is H layers tall: r at the base, 0 at the tip (the automatic H is r + 1). */
  const taper = (r, i, H) => (H > 1 ? Math.round((r * (H - 1 - i)) / (H - 1)) : r);

  function cone(out, [cx, cy, cz], o) {
    const H = o.ha || o.r + 1;
    for (let i = 0; i < H; i++) disc(out, [cx, cy + i, cz], taper(o.r, i, H), o.t, o.hollow && i < H - 1, "h");
  }

  function pyramid(out, [cx, cy, cz], o) {
    const H = o.ha || o.r + 1;
    for (let i = 0; i < H; i++) {
      const w = taper(o.r, i, H);
      for (let dx = -w; dx <= w; dx++)
        for (let dz = -w; dz <= w; dz++) {
          const edge = Math.max(Math.abs(dx), Math.abs(dz));
          if (!o.hollow || edge > w - o.t || i === H - 1) out.push([cx + dx, cy + i, cz + dz]);
        }
    }
  }

  /** Dos esquinas: la huella la dan las dos; el alto, el control (o la diferencia de altura de los clics si es mayor). */
  function box(out, a, b, o, walls) {
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
    const z0 = Math.min(a[2], b[2]), z1 = Math.max(a[2], b[2]);
    const y0 = Math.min(a[1], b[1]);
    const y1 = Math.max(y0 + o.h - 1, Math.max(a[1], b[1]));
    const hollow = walls || o.hollow, t = o.t;
    for (let y = y0; y <= y1; y++) {
      const cap = !walls && hollow && ((o.capBottom && y < y0 + t) || (o.capTop && y > y1 - t));
      for (let x = x0; x <= x1; x++)
        for (let z = z0; z <= z1; z++) {
          const rim = x < x0 + t || x > x1 - t || z < z0 + t || z > z1 - t;
          if (!hollow || cap || rim) out.push([x, y, z]);
        }
    }
  }

  function line(out, a, b) {
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]));
    const seen = new Set();
    for (let i = 0; i <= n; i++) {
      const f = n ? i / n : 0;
      const c = [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
      const key = c.join(",");
      if (!seen.has(key)) { seen.add(key); out.push(c); }
    }
  }

  /**
   * Las celdas de una forma. a: la celda del clic (o la primera esquina); b: la segunda, para las de dos clics.
   * Devuelve { cells, error }: una forma que pasa de MAX_CELLS no se genera.
   */
  function cells(typeId, opts, a, b = a) {
    const type = typeOf(typeId);
    const o = { ...DEFAULTS, ...opts };
    o.r = clamp(o.r, LIMITS.r); o.h = clamp(o.h, LIMITS.h); o.ha = clamp(o.ha, LIMITS.ha); o.t = clamp(o.t, LIMITS.t);
    const out = [];
    switch (type.id) {
      case "brush": out.push(a.slice()); break;
      case "line": line(out, a, b); break;
      case "box": box(out, a, b, o, false); break;
      case "walls": box(out, a, b, o, true); break;
      case "disc": disc(out, a, o.r, o.t, false, o.plane, o.ha || 1); break;
      case "ring": disc(out, a, o.r, o.t, true, o.plane, o.ha || 1); break;
      case "sphere": sphere(out, a, o, false); break;
      case "dome": sphere(out, a, o, true); break;
      case "cylinder": cylinder(out, a, o); break;
      case "cone": cone(out, a, o); break;
      case "pyramid": pyramid(out, a, o); break;
    }
    if (out.length > MAX_CELLS) return { cells: [], error: `La forma tiene ${out.length} celdas: baja el tamaño (máximo ${MAX_CELLS}).` };
    return { cells: out, error: null };
  }

  Aura.structShapes = { TYPES, DEFAULTS, LIMITS, MAX_CELLS, typeOf, cells };
})(window.Aura ??= {});
