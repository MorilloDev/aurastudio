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
    { id: "disc", name: "Disco", points: 1, params: ["r", "plane"], hint: "Círculo macizo centrado en la celda." },
    { id: "ring", name: "Anillo", points: 1, params: ["r", "t", "plane"], hint: "Círculo sin centro: solo el borde." },
    { id: "sphere", name: "Esfera", points: 1, params: ["r", "hollow", "t", "grounded"], hint: "Maciza o hueca (cáscara)." },
    { id: "dome", name: "Cúpula", points: 1, params: ["r", "hollow", "t"], hint: "Media esfera apoyada en el nivel." },
    { id: "cylinder", name: "Cilindro", points: 1, params: ["r", "h", "hollow", "t", "caps"], hint: "Torre redonda, maciza o hueca. Sube desde el nivel." },
    { id: "cone", name: "Cono", points: 1, params: ["r", "hollow", "t"], hint: "Se estrecha hasta la punta (alto = radio + 1)." },
    { id: "pyramid", name: "Pirámide", points: 1, params: ["r", "hollow", "t"], hint: "Cuadrada, escalonada (alto = radio + 1)." },
  ];

  const DEFAULTS = { onlyLevel: false, r: 3, h: 5, t: 1, hollow: false, capTop: true, capBottom: true, plane: "h", grounded: true };
  const LIMITS = { r: [1, 30], h: [1, 64], t: [1, 10] };

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

  function disc(out, [cx, cy, cz], r, t, hollow, plane) {
    for (let u = -r; u <= r; u++)
      for (let v = -r; v <= r; v++) {
        const d2 = u * u + v * v;
        if (!(hollow ? inShell(d2, r, t) : inside(d2, r))) continue;
        if (plane === "ns") out.push([cx + u, cy + v, cz]);
        else if (plane === "ew") out.push([cx, cy + v, cz + u]);
        else out.push([cx + u, cy, cz + v]);
      }
  }

  function sphere(out, [cx, cy, cz], o, half) {
    const { r, t, hollow } = o;
    const y0 = half || o.grounded ? cy + (half ? 0 : r) : cy;
    for (let dy = half ? 0 : -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          const d2 = dx * dx + dy * dy + dz * dz;
          if (hollow ? inShell(d2, r, t) : inside(d2, r)) out.push([cx + dx, y0 + dy, cz + dz]);
        }
  }

  function cylinder(out, [cx, cy, cz], o) {
    const { r, h, t, hollow } = o;
    for (let y = 0; y < h; y++) {
      const cap = hollow && ((o.capBottom && y < t) || (o.capTop && y >= h - t));
      disc(out, [cx, cy + y, cz], r, t, hollow && !cap, "h");
    }
  }

  function cone(out, [cx, cy, cz], o) {
    for (let i = 0; i <= o.r; i++) disc(out, [cx, cy + i, cz], o.r - i, o.t, o.hollow && i < o.r, "h");
  }

  function pyramid(out, [cx, cy, cz], o) {
    for (let i = 0; i <= o.r; i++) {
      const w = o.r - i;
      for (let dx = -w; dx <= w; dx++)
        for (let dz = -w; dz <= w; dz++) {
          const edge = Math.max(Math.abs(dx), Math.abs(dz));
          if (!o.hollow || edge > w - o.t || i === o.r) out.push([cx + dx, cy + i, cz + dz]);
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
    o.r = clamp(o.r, LIMITS.r); o.h = clamp(o.h, LIMITS.h); o.t = clamp(o.t, LIMITS.t);
    const out = [];
    switch (type.id) {
      case "brush": out.push(a.slice()); break;
      case "line": line(out, a, b); break;
      case "box": box(out, a, b, o, false); break;
      case "walls": box(out, a, b, o, true); break;
      case "disc": disc(out, a, o.r, o.t, false, o.plane); break;
      case "ring": disc(out, a, o.r, o.t, true, o.plane); break;
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
