"use strict";

// Muebles: una sola carcasa paramétrica y un preset por pieza.
//
// Todo lo que hay aquí son cajas en dieciseisavos de celda (0..16), x ancho, y alto, z fondo — las mismas unidades
// que el generador de bloques lee en su forma "Personalizada", así que un mueble pasa por el mismo motor, la misma
// AO y las mismas texturas que un bloque del mundo. Esa es la razón de construirlo así y no con un mallado propio:
// una mesa hecha aquí pertenece al mismo mundo que la piedra que tiene al lado.
//
// Una pieza no es un modelo cerrado: es un cuerpo (mesa, caja, estantería o tabla) más las partes que se le cuelgan
// (patas, tapa, puertas, cajones, baldas, herrajes). Un preset solo elige valores; cambiar cualquiera de ellos sigue
// dando un mueble válido, que es lo que hace que de quince presets salgan cientos de muebles.
(function (Aura) {
  // ── Cajas ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const box = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /** Un cilindro de eje vertical, aproximado por tres cajas cruzadas: a 16 px de celda un octógono ya se lee redondo. */
  function disc(cx, cz, r, y0, y1) {
    const i = r * 0.72;
    return [
      box(cx - r, y0, cz - i, cx + r, y1, cz + i),
      box(cx - i, y0, cz - r, cx + i, y1, cz + r),
      box(cx - r * 0.86, y0, cz - r * 0.86, cx + r * 0.86, y1, cz + r * 0.86),
    ];
  }

  /** Un aro horizontal (una banda de metal alrededor de un cuerpo redondo). */
  function ring(cx, cz, r, y0, y1, thick) {
    const out = disc(cx, cz, r, y0, y1);
    const inner = disc(cx, cz, r - thick, y0 - 0.01, y1 + 0.01).map((b) => ({ ...b, hole: true }));
    return out.concat(inner);
  }

  // ── Patas ─────────────────────────────────────────────────────────────────────────────────────────────────────

  // Las cuatro esquinas, en el orden en que se enumeran en el panel: frente-izq, frente-der, fondo-izq, fondo-der.
  // Quitar una pata es quitarla de aquí, no un caso especial dentro de cada forma.
  function corners(p) {
    const t = p.legThick, { x0, x1, z0, z1 } = inner(p);
    const all = [[x0, z0], [x1 - t, z0], [x0, z1 - t], [x1 - t, z1 - t]];
    const mask = p.legMask ?? [1, 1, 1, 1];
    return all.filter((_, i) => mask[i] !== 0 && mask[i] !== false);
  }

  const LEGS = {
    none: () => [],

    // Cuatro postes rectos en las esquinas. Lo más barato de leer y lo que da a una mesa su silueta.
    square: (p, y) => {
      const t = p.legThick;
      return corners(p).map(([cx, cz]) => box(cx, 0, cz, cx + t, y, cz + t));
    },

    // Torneadas: estrechan en el medio y vuelven a abrirse, en tres tramos.
    turned: (p, y) => {
      const t = p.legThick;
      const out = [];
      for (const [cx, cz] of corners(p)) {
        const m = 0.5;
        out.push(box(cx, 0, cz, cx + t, y * 0.22, cz + t));
        out.push(box(cx + m, y * 0.22, cz + m, cx + t - m, y * 0.78, cz + t - m));
        out.push(box(cx, y * 0.78, cz, cx + t, y, cz + t));
      }
      return out;
    },

    // Abiertas hacia fuera: cada pata es una escalera de tres pasos que sale de la esquina.
    splayed: (p, y) => {
      const t = p.legThick, { x0, z0 } = inner(p);
      const out = [];
      const steps = 3;
      for (const [sx, sz] of corners(p)) {
        const dx = sx <= x0 + 0.01 ? -1 : 1, dz = sz <= z0 + 0.01 ? -1 : 1;
        for (let s = 0; s < steps; s++) {
          const o = (s * 0.7) * -1;
          const y0 = (y / steps) * (steps - 1 - s), y1 = (y / steps) * (steps - s);
          const ox = sx + dx * o, oz = sz + dz * o;
          out.push(box(clamp(ox, 0, 16), y0, clamp(oz, 0, 16), clamp(ox + t, 0, 16), y1, clamp(oz + t, 0, 16)));
        }
      }
      return out;
    },

    // Patines: dos tablas de lado a lado, como un arcón o un banco de taller. Usa las dos primeras casillas de la
    // máscara, que en el panel se leen como "izquierda" y "derecha".
    sled: (p, y) => {
      const t = p.legThick, { x0, x1, z0, z1 } = inner(p);
      const mask = p.legMask ?? [1, 1, 1, 1];
      const out = [];
      if (mask[0]) out.push(box(x0, 0, z0, x0 + t, y, z1));
      if (mask[1]) out.push(box(x1 - t, 0, z0, x1, y, z1));
      return out;
    },

    // Zócalo: un cajón macizo retranqueado, que es como se apoya un armario.
    plinth: (p, y) => {
      const { x0, x1, z0, z1 } = inner(p);
      return [box(x0 + 1, 0, z0 + 1, x1 - 1, y, z1 - 1)];
    },
  };

  // El rectángulo del cuerpo en planta, centrado en la celda.
  function inner(p) {
    const w = clamp(p.width, 2, 16), d = clamp(p.depth, 2, 16);
    return { x0: (16 - w) / 2, x1: (16 + w) / 2, z0: (16 - d) / 2, z1: (16 + d) / 2 };
  }

  // ── Herrajes ──────────────────────────────────────────────────────────────────────────────────────────────────

  function handle(kind, x, y, z, face) {
    if (kind === "none") return [];
    const out = [];
    const zf = face === "front" ? z - 0.6 : z + 0.6;
    if (kind === "knob") out.push(box(x - 0.6, y - 0.6, Math.min(z, zf), x + 0.6, y + 0.6, Math.max(z, zf)));
    if (kind === "bar") out.push(box(x - 1.6, y - 0.4, Math.min(z, zf), x + 1.6, y + 0.4, Math.max(z, zf)));
    if (kind === "ring") {
      out.push(box(x - 1.2, y - 1.2, Math.min(z, zf), x + 1.2, y + 1.2, Math.max(z, zf)));
      out.push({ ...box(x - 0.5, y - 0.5, Math.min(z, zf) - 0.1, x + 0.5, y + 0.5, Math.max(z, zf) + 0.1), hole: true });
    }
    return out;
  }

  // ── Cuerpos ───────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Mesa: patas, faldón y tablero. El voladizo del tablero es lo que separa una mesa de una caja con patas, así que
   * es un parámetro y no un número fijo.
   */
  function bodyTable(p, g) {
    const { x0, x1, z0, z1 } = inner(p);
    const h = clamp(p.height, 2, 16);
    const topT = clamp(p.topThick, 0.5, 4);
    const legY = h - topT;
    const o = clamp(p.overhang, 0, 3);

    g.frame.push(...(LEGS[p.legs] ?? LEGS.square)(p, legY));

    if (p.apron > 0) {
      const a = clamp(p.apron, 0.5, 4), t = p.legThick;
      const ay = legY - a;
      g.frame.push(box(x0 + t, ay, z0, x1 - t, legY, z0 + 1));
      g.frame.push(box(x0 + t, ay, z1 - 1, x1 - t, legY, z1));
      g.frame.push(box(x0, ay, z0 + t, x0 + 1, legY, z1 - t));
      g.frame.push(box(x1 - 1, ay, z0 + t, x1, legY, z1 - t));
    }

    // Travesaños: la barra baja que une las patas. Es lo que separa una mesa de taller de una de comedor.
    if (p.stretcher > 0 && p.legs !== "none" && p.legs !== "plinth") {
      const t = p.legThick, sy = clamp(p.stretcher, 0.5, 8);
      g.frame.push(box(x0 + t, sy, z0 + t * 0.35, x1 - t, sy + 0.8, z0 + t * 0.35 + 0.8));
      g.frame.push(box(x0 + t, sy, z1 - t * 0.35 - 0.8, x1 - t, sy + 0.8, z1 - t * 0.35));
    }

    // Zapatas: un taco bajo cada pata, que apoya el mueble en vez de clavarlo en el suelo.
    if (p.feet && p.legs !== "none" && p.legs !== "plinth") {
      const t = p.legThick;
      for (const [cx, cz] of corners(p)) g.frame.push(box(cx - 0.4, 0, cz - 0.4, cx + t + 0.4, 0.8, cz + t + 0.4));
    }

    if (p.round) g.top.push(...disc(8, 8, Math.min(x1 - x0, z1 - z0) / 2 + o, legY, h));
    else g.top.push(box(clamp(x0 - o, 0, 16), legY, clamp(z0 - o, 0, 16), clamp(x1 + o, 0, 16), h, clamp(z1 + o, 0, 16)));

    // Un atril inclina el tablero cortándolo por un plano en vez de escalonarlo, que a esta resolución se nota.
    if (p.slope > 0) {
      const t = g.top[g.top.length - 1];
      t.cuts = [{ n: [0, 1, -p.slope], d: legY + topT - p.slope * z0 }];
      g.top.push(box(x0, legY, z1 - 1, x1, legY + 1, z1));
    }
  }

  /** Caja redonda: barril, tinaja, cubo. Duelas abombadas y aros, que es lo que la separa de un cilindro liso. */
  function bodyRound(p, g) {
    const { x0, x1 } = inner(p);
    const h = clamp(p.height, 2, 16), r = (x1 - x0) / 2;
    const footY = p.legs === "none" ? 0 : clamp(p.legHeight, 0, h - 2);
    if (footY > 0) g.frame.push(...(LEGS[p.legs] ?? LEGS.none)(p, footY));

    // Abombado: tres tramos, el del medio más ancho. Un barril recto se lee como un tubo.
    const belly = r, waist = r * 0.86;
    const t = (h - footY) / 3;
    g.body.push(...disc(8, 8, waist, footY, footY + t));
    g.body.push(...disc(8, 8, belly, footY + t, footY + t * 2));
    g.body.push(...disc(8, 8, waist, footY + t * 2, h));

    if (p.lid !== "none") g.top.push(...disc(8, 8, waist - 0.3, h - clamp(p.lidThick, 0.5, 3), h));

    const bands = clamp(p.bands | 0, 0, 4);
    for (let i = 0; i < bands; i++) {
      const y = footY + ((h - footY) / (bands + 1)) * (i + 1);
      const rr = (y > footY + t && y < footY + t * 2 ? belly : waist) + 0.35;
      g.metal.push(...ring(8, 8, rr, y - 0.6, y + 0.6, 0.8));
    }
  }

  /** Caja: cofre, arcón, armario, mesilla. Paredes, suelo, tapa o puertas, cajones y baldas. */
  function bodyBox(p, g) {
    if (p.round) return bodyRound(p, g);
    const { x0, x1, z0, z1 } = inner(p);
    const h = clamp(p.height, 2, 16);
    const wall = clamp(p.wall, 0.5, 3);
    const footY = p.legs === "none" ? 0 : clamp(p.legHeight, 0, h - 2);
    const lidY = p.lid === "none" ? h : h - clamp(p.lidThick, 1, 4);

    if (footY > 0) g.frame.push(...(LEGS[p.legs] ?? LEGS.square)(p, footY));

    // El casco: suelo, dos costados, fondo y, si la pieza no se abre, también el frente.
    g.body.push(box(x0, footY, z0, x1, footY + wall, z1));
    g.body.push(box(x0, footY, z0, x0 + wall, lidY, z1));
    g.body.push(box(x1 - wall, footY, z0, x1, lidY, z1));
    if (p.back) g.body.push(box(x0, footY, z1 - wall, x1, lidY, z1));

    const drawers = clamp(p.drawers | 0, 0, 4);
    const doors = clamp(p.doors | 0, 0, 2);
    const front = z0;

    // Los cajones ocupan la parte baja del frente y las puertas lo que queda.
    const drawerTop = drawers > 0 ? footY + wall + (lidY - footY - wall) * (drawers / (drawers + (doors ? 2 : 0))) : footY + wall;
    for (let i = 0; i < drawers; i++) {
      const y0 = footY + wall + ((drawerTop - footY - wall) / drawers) * i;
      const y1 = footY + wall + ((drawerTop - footY - wall) / drawers) * (i + 1);
      g.front.push(box(x0 + wall, y0 + 0.3, front, x1 - wall, y1 - 0.3, front + wall));
      g.metal.push(...handle((x1 - x0) > 9 ? p.handle : "knob", 8, (y0 + y1) / 2, front, "front"));
    }

    if (doors > 0) {
      const y0 = drawerTop, y1 = lidY;
      const open = clamp(p.open, 0, 1);
      if (doors === 1) {
        if (open <= 0.01) g.front.push(box(x0 + wall, y0, front, x1 - wall, y1, front + wall));
        else g.front.push(box(x0 + wall - open * (x1 - x0 - wall * 2), y0, front - open * 3, x0 + wall, y1, front + wall));
        g.metal.push(...handle(p.handle, x1 - wall - 2, (y0 + y1) / 2, front, "front"));
      } else {
        const mid = 8;
        if (open <= 0.01) {
          g.front.push(box(x0 + wall, y0, front, mid, y1, front + wall));
          g.front.push(box(mid, y0, front, x1 - wall, y1, front + wall));
        } else {
          const swing = open * ((mid - x0 - wall) * 0.9);
          g.front.push(box(x0 + wall - swing, y0, front - open * 3, x0 + wall, y1, front + wall));
          g.front.push(box(x1 - wall, y0, front - open * 3, x1 - wall + swing, y1, front + wall));
        }
        g.metal.push(...handle(p.handle, mid - 1.2, (y0 + y1) / 2, front, "front"));
        g.metal.push(...handle(p.handle, mid + 1.2, (y0 + y1) / 2, front, "front"));
      }
    } else if (!p.openFront) {
      g.front.push(box(x0 + wall, drawerTop, front, x1 - wall, lidY, front + wall));
    }

    // Baldas solo donde el frente está abierto o hay puertas que las tapen.
    const shelves = clamp(p.shelves | 0, 0, 4);
    for (let i = 1; i <= shelves; i++) {
      const y = footY + wall + ((lidY - footY - wall) / (shelves + 1)) * i;
      g.body.push(box(x0 + wall, y, z0, x1 - wall, y + wall * 0.7, z1 - wall));
    }

    if (p.lid === "flat") g.top.push(box(x0, lidY, z0, x1, h, z1));
    if (p.lid === "domed") {
      const steps = 3, t = h - lidY;
      for (let i = 0; i < steps; i++) {
        const k = (i / steps) * 1.6;
        g.top.push(box(x0 + k, lidY + (t / steps) * i, z0 + k, x1 - k, lidY + (t / steps) * (i + 1), z1 - k));
      }
      g.metal.push(box(7, lidY - 0.4, z0 - 0.4, 9, lidY + t * 0.5, z0 + 0.6));
    }

    // Bandas de metal: lo que convierte una caja de tablas en un cofre.
    const bands = clamp(p.bands | 0, 0, 4);
    for (let i = 0; i < bands; i++) {
      const bx = x0 + ((x1 - x0) / (bands + 1)) * (i + 1);
      g.metal.push(box(bx - 0.7, footY, z0 - 0.6, bx + 0.7, h, z0 + 0.4));
      g.metal.push(box(bx - 0.7, footY, z1 - 0.4, bx + 0.7, h, z1 + 0.6));
    }
  }

  /** Estantería: dos costados, baldas y, si se pide, un fondo. Sin frente nunca. */
  function bodyShelf(p, g) {
    const { x0, x1, z0, z1 } = inner(p);
    const h = clamp(p.height, 2, 16), wall = clamp(p.wall, 0.5, 3);
    const footY = p.legs === "none" ? 0 : clamp(p.legHeight, 0, h - 2);
    if (footY > 0) g.frame.push(...(LEGS[p.legs] ?? LEGS.plinth)(p, footY));

    g.body.push(box(x0, footY, z0, x0 + wall, h, z1));
    g.body.push(box(x1 - wall, footY, z0, x1, h, z1));
    g.body.push(box(x0, footY, z0, x1, footY + wall, z1));
    g.top.push(box(x0, h - wall, z0, x1, h, z1));
    if (p.back) g.body.push(box(x0, footY, z1 - wall * 0.6, x1, h, z1));

    const shelves = clamp(p.shelves | 0, 1, 4);
    for (let i = 1; i <= shelves; i++) {
      const y = footY + wall + ((h - wall - footY - wall) / (shelves + 1)) * i;
      g.body.push(box(x0 + wall, y, z0, x1 - wall, y + wall * 0.7, z1 - wall * 0.4));
    }
  }

  /** Tabla: cama, banco corrido, camastro. Un colchón o cojín encima y, si se pide, cabecero. */
  function bodySlab(p, g) {
    const { x0, x1, z0, z1 } = inner(p);
    const h = clamp(p.height, 2, 16);
    const deck = clamp(p.topThick, 1, 5);
    const legY = Math.max(0, h - deck);
    g.frame.push(...(LEGS[p.legs] ?? LEGS.square)(p, legY));
    g.frame.push(box(x0, legY, z0, x1, legY + deck * 0.4, z1));
    g.cloth.push(box(x0 + 0.5, legY + deck * 0.4, z0 + 0.5, x1 - 0.5, h, z1 - 0.5));
    if (p.headboard > 0) g.frame.push(box(x0, legY, z1 - 1, x1, h + clamp(p.headboard, 1, 8), z1));
  }

  const BODIES = { table: bodyTable, box: bodyBox, shelf: bodyShelf, slab: bodySlab };

  // ── Parámetros ────────────────────────────────────────────────────────────────────────────────────────────────

  const DEFAULTS = {
    body: "table",
    width: 14, depth: 14, height: 10,
    legs: "square", legThick: 2, legHeight: 2,
    topThick: 1.5, overhang: 1, apron: 1, round: false, slope: 0,
    wall: 1.5, back: true, openFront: false,
    doors: 0, drawers: 0, shelves: 0, bands: 0,
    lid: "none", lidThick: 2, open: 0,
    handle: "knob", headboard: 0,
    legMask: [1, 1, 1, 1], stretcher: 0, feet: false,
    hidden: [],
    materials: { frame: "wood_dark", body: "wood", top: "wood_light", front: "wood", metal: "iron", cloth: "cloth" },
  };

  // Un preset solo mueve números: cambiar cualquiera de ellos después sigue dando un mueble, que es de lo que se trata.
  const KINDS = [
    ["table", "Mesa", { body: "table", width: 14, depth: 14, height: 10, legs: "square", apron: 1 }],
    ["round_table", "Mesa redonda", { body: "table", width: 13, depth: 13, height: 10, legs: "turned", legThick: 3, apron: 0, round: true, overhang: 1.5 }],
    ["desk", "Escritorio", { body: "box", width: 15, depth: 11, height: 10, legs: "sled", legHeight: 1, drawers: 2, doors: 0, openFront: true, handle: "bar", wall: 1 }],
    ["bench", "Banco", { body: "table", width: 15, depth: 7, height: 6, legs: "sled", topThick: 2, apron: 0, overhang: 0.5 }],
    ["stool", "Taburete", { body: "table", width: 7, depth: 7, height: 7, legs: "splayed", legThick: 1.5, topThick: 1.5, apron: 0, round: true }],
    ["chest", "Cofre", { body: "box", width: 14, depth: 10, height: 9, legs: "none", lid: "domed", lidThick: 3, bands: 2, wall: 1.5, handle: "none" }],
    ["trunk", "Arcón", { body: "box", width: 15, depth: 12, height: 11, legs: "sled", legHeight: 1, lid: "flat", lidThick: 2, bands: 3, handle: "ring" }],
    ["crate", "Caja", { body: "box", width: 13, depth: 13, height: 12, legs: "none", lid: "flat", lidThick: 1.5, wall: 1.5, bands: 0, handle: "none" }],
    ["barrel", "Barril", { body: "box", round: true, width: 12, depth: 12, height: 14, legs: "none", lid: "flat", lidThick: 1.5, bands: 2, handle: "none" }],
    ["wardrobe", "Armario", { body: "box", width: 13, depth: 8, height: 16, legs: "plinth", legHeight: 1.5, doors: 2, handle: "knob", wall: 1.2, lid: "flat", lidThick: 1 }],
    ["cupboard", "Alacena", { body: "box", width: 14, depth: 8, height: 13, legs: "plinth", legHeight: 1, doors: 2, drawers: 1, shelves: 1, handle: "knob", wall: 1.2 }],
    ["bookshelf", "Estantería", { body: "shelf", width: 14, depth: 7, height: 16, legs: "plinth", legHeight: 1, shelves: 3, wall: 1.2 }],
    ["nightstand", "Mesilla", { body: "box", width: 9, depth: 9, height: 9, legs: "turned", legHeight: 2.5, legThick: 1.5, drawers: 2, handle: "knob", wall: 1, lid: "flat", lidThick: 1 }],
    ["bed", "Cama", { body: "slab", width: 14, depth: 16, height: 7, legs: "square", legThick: 2, topThick: 3, headboard: 4 }],
    ["lectern", "Atril", { body: "table", width: 7, depth: 7, height: 12, legs: "plinth", topThick: 1.5, apron: 0, slope: 0.6, overhang: 2.5 }],
  ];

  const PRESETS = Object.fromEntries(KINDS.map(([k, , v]) => [k, v]));

  function defaults(kind) {
    return {
      ...DEFAULTS,
      ...structuredClone(PRESETS[kind] ?? {}),
      materials: { ...DEFAULTS.materials },
      legMask: [1, 1, 1, 1],
      hidden: [],
    };
  }

  /**
   * Las cajas del mueble, agrupadas por material. Cada grupo se renderiza por separado y se apilan por profundidad,
   * que es lo que deja poner un tablero de madera clara sobre un armazón oscuro sin pintar nada a mano.
   */
  function build(p) {
    const g = { frame: [], body: [], top: [], front: [], metal: [], cloth: [] };
    (BODIES[p.body] ?? bodyTable)(p, g);

    const order = ["frame", "body", "top", "front", "metal", "cloth"];
    const hidden = new Set(p.hidden ?? []);
    return order
      .filter((k) => g[k].length && !hidden.has(k))
      .map((k) => ({ part: k, material: p.materials?.[k] ?? "wood", boxes: g[k] }));
  }

  Aura.furnitureParts = { DEFAULTS, KINDS, PRESETS, LEGS, defaults, build, box, disc, ring, inner };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
