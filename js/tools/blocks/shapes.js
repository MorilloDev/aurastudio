"use strict";

// Block shapes for the Bloques tool: each piece is a list of boxes in its own cell (the same format as a tile's
// "collision" key), plus the states and facings the game asks art for. No DOM: runs in the page and under Node.
//
// Local frame (a piece "facing front", like the game's collision boxes written facing North):
//   x 0..1 left to right, y 0..1 bottom to top (1 = the block's full height), z 0..1 front to back.
// "Front" is the side that faces the camera's left face (world -Y). The game draws the other two facings by mirroring
// front and back, so those two are what gets saved; the side facings are only previewed.
(function (Aura) {
  // ── Directions ───────────────────────────────────────────────────────────────────────────────────────────────────
  // Index → unit vector. World: x, y (depth), z (up). Local: x, y (up), z (depth).
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const dirIndex = (v) => DIRS.findIndex((d) => d[0] === v[0] && d[1] === v[1] && d[2] === v[2]);

  // Matrices act on centred coordinates (p - 0.5), so rotations and mirrors keep the piece inside its cell.
  const mul = (A, B) => A.map((row) => [0, 1, 2].map((c) => row[0] * B[0][c] + row[1] * B[1][c] + row[2] * B[2][c]));
  const apply = (M, v) => [0, 1, 2].map((r) => M[r][0] * v[0] + M[r][1] * v[1] + M[r][2] * v[2]);
  const transpose = (M) => [0, 1, 2].map((r) => [0, 1, 2].map((c) => M[c][r]));
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  // Local (x, y up, z depth) → world (x, y depth, z up).
  const BASE = [[1, 0, 0], [0, 0, 1], [0, 1, 0]];

  // Applied in the local frame, before BASE. Vertical and horizontal both lay the piece's up axis along its depth: a
  // bottom slab becomes the front half of the cell, a column becomes a log lying front to back.
  const STATE = {
    default: I,
    inverted: [[1, 0, 0], [0, -1, 0], [0, 0, 1]],
    vertical: [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
    horizontal: [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
  };
  const STATE_LABEL = { default: "Normal", inverted: "Invertida", vertical: "Vertical", horizontal: "Horizontal" };

  // Turns about the world's up axis. Front looks at world -Y; each step turns it to the next facing.
  const FACING = {
    front: I,
    right: [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    back: [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    left: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],
  };
  const FACING_LABEL = { front: "Frente", right: "Derecha", back: "Atrás", left: "Izquierda" };

  // Isometric rotation of the whole piece, in quarter turns about its own axes (local x right, y up, z depth), before
  // its state and facing: the piece is turned like a 3D model — a stair on its side, a slab standing up the other way —
  // and, when textures follow, each face takes its texture along.
  const ROT_X = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
  const ROT_Y = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]];
  const ROT_Z = [[0, -1, 0], [1, 0, 0], [0, 0, 1]];
  const power = (R, n) => { let out = I; for (let s = 0; s < (n & 3); s++) out = mul(R, out); return out; };
  /** iso: { x, y, z } quarter turns (missing = 0). */
  const isoMatrix = (iso) => mul(power(ROT_Z, iso?.z | 0), mul(power(ROT_Y, iso?.y | 0), power(ROT_X, iso?.x | 0)));
  const hasIso = (iso) => !!iso && ((iso.x | 0) & 3 || (iso.y | 0) & 3 || (iso.z | 0) & 3) !== 0;

  /**
   * Local → world mapping of one variant. toWorld / toLocal take unit coordinates (0..1 on every axis);
   * dirToLocal turns a world direction index into the local one, for picking a voxel face's texture.
   * texFollow false keeps textures fixed to the world (top texture always on top) whatever the state or facing.
   */
  function transform(state, facing, texFollow = true, iso = null) {
    const M = mul(FACING[facing] ?? I, mul(BASE, mul(STATE[state] ?? I, isoMatrix(iso))));
    const Mi = transpose(M);
    // Texture frame: the piece's own frame, or the plain front-facing one when textures stay put.
    const T = texFollow ? M : BASE;
    const Ti = transpose(T);
    const centred = (p) => [p[0] - 0.5, p[1] - 0.5, p[2] - 0.5];
    const back = (c) => [c[0] + 0.5, c[1] + 0.5, c[2] + 0.5];
    return {
      toWorld: (p) => back(apply(M, centred(p))),
      toLocal: (p) => back(apply(Mi, centred(p))),
      texLocal: (p) => back(apply(Ti, centred(p))),
      texDir: (wd) => dirIndex(apply(Ti, DIRS[wd])),
      // World rotation taking the upright piece's texture frame to this one's: identity when textures stay put. Hairs
      // use it so they grow from the face that carries the top texture, wherever the piece has turned it.
      texRot: mul(T, transpose(BASE)),
      // The same as a direction-index map (world index → world index).
      texDirWorld: (wd) => dirIndex(apply(mul(T, transpose(BASE)), DIRS[wd])),
    };
  }

  /** Boxes (local) → world boxes, same unit coordinates. */
  function boxesToWorld(boxes, tf) {
    return boxes.map((b) => {
      const a = tf.toWorld(b.min), c = tf.toWorld(b.max);
      return { min: [0, 1, 2].map((i) => Math.min(a[i], c[i])), max: [0, 1, 2].map((i) => Math.max(a[i], c[i])) };
    });
  }

  // ── Presets ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // Sizes in sixteenths of the block, like Minecraft's model editor, then divided down.
  const box = (x0, y0, z0, x1, y1, z1) => ({ min: [x0 / 16, y0 / 16, z0 / 16], max: [x1 / 16, y1 / 16, z1 / 16] });

  /** Turns local boxes a quarter turn about the cell's vertical centre line, n times (front → right → back → left). */
  function turnLocal(boxes, n) {
    let out = boxes;
    for (let s = 0; s < (n & 3); s++) {
      out = out.map((b) => {
        // (x, z) → (1 - z, x): what faced front (z = 0) now faces the piece's right (x = 1).
        const p = [1 - b.min[2], b.min[1], b.min[0]], q = [1 - b.max[2], b.max[1], b.max[0]];
        return { min: [Math.min(p[0], q[0]), p[1], Math.min(p[2], q[2])], max: [Math.max(p[0], q[0]), q[1], Math.max(p[2], q[2])] };
      });
    }
    return out;
  }

  /** A box sliced by planes: solid where n·p ≤ d for every cut (p in the local frame, 0..1). Ramps and slanted panels
   *  are built from these; the renderer draws the cut planes as true slopes, not voxel steps. */
  const cut = (b, ...cuts) => ({ ...b, cuts: cuts.map(([n, d]) => ({ n, d })) });
  const FULL = box(0, 0, 0, 16, 16, 16);

  // Connection sides of fences and walls, as quarter turns of the arm that points front.
  const SIDES = [["f", "frente", 0], ["r", "derecha", 1], ["b", "atrás", 2], ["l", "izquierda", 3]];

  const SHAPES = {
    cube: {
      label: "Cubo", states: ["default", "horizontal"],
      boxes: () => [box(0, 0, 0, 16, 16, 16)],
    },
    slab: {
      label: "Losa", states: ["default", "inverted", "vertical"],
      boxes: () => [box(0, 0, 0, 16, 8, 16)],
    },
    layer: {
      label: "Losa fina", states: ["default", "inverted", "vertical"],
      boxes: (p) => [box(0, 0, 0, 16, p.layer, 16)],
    },
    small: {
      label: "Pieza pequeña", states: ["default", "inverted"],
      boxes: (p) => {
        const s = p.small, o = (16 - s) / 2;
        return [box(o, 0, o, o + s, p.smallHeight, o + s)];
      },
    },
    stair: {
      label: "Escalera", states: ["default", "inverted"],
      boxes: () => [box(0, 0, 0, 16, 8, 16), box(0, 8, 8, 16, 16, 16)],
    },
    stairOuter: {
      label: "Escalera esquina ext.", states: ["default", "inverted"],
      boxes: () => [box(0, 0, 0, 16, 8, 16), box(8, 8, 8, 16, 16, 16)],
    },
    stairInner: {
      label: "Escalera esquina int.", states: ["default", "inverted"],
      boxes: () => [box(0, 0, 0, 16, 8, 16), box(0, 8, 8, 16, 16, 16), box(8, 8, 0, 16, 16, 8)],
    },
    ramp: {
      label: "Rampa", states: ["default", "inverted"],
      // Rises from the front edge (bottom) to the back edge (top).
      boxes: () => [cut(FULL, [[0, 1, -1], 0])],
    },
    rampLow: {
      label: "Rampa larga (abajo)", states: ["default", "inverted"],
      // First half of a ramp two blocks long: from the floor to half height.
      boxes: () => [cut(FULL, [[0, 1, -0.5], 0])],
    },
    rampHigh: {
      label: "Rampa larga (arriba)", states: ["default", "inverted"],
      // Second half: from half height to the top.
      boxes: () => [cut(FULL, [[0, 1, -0.5], 0.5])],
    },
    rampOuter: {
      label: "Rampa esquina ext.", states: ["default", "inverted"],
      // Two slopes meeting at an outside corner (hip roof): only the back-right corner reaches the top.
      boxes: () => [cut(FULL, [[0, 1, -1], 0], [[-1, 1, 0], 0])],
    },
    rampInner: {
      label: "Rampa esquina int.", states: ["default", "inverted"],
      // Two slopes meeting at an inside corner (valley): the union of both ramps.
      boxes: () => [cut(FULL, [[0, 1, -1], 0]), cut(FULL, [[-1, 1, 0], 0])],
    },
    slopePanel: {
      label: "Panel inclinado", states: ["default", "inverted"],
      // A thin panel lying on the ramp's diagonal, from the bottom front edge to the top back edge.
      boxes: (p) => {
        const w = Math.SQRT2 * p.panel / 32;
        return [cut(FULL, [[0, 1, -1], w], [[0, -1, 1], w])];
      },
    },
    diagonalWall: {
      label: "Pared diagonal", states: ["default"],
      // A thin full-height wall across the cell, from the front-left corner to the back-right one.
      boxes: (p) => {
        const w = Math.SQRT2 * p.panel / 32;
        return [cut(FULL, [[1, 0, -1], w], [[-1, 0, 1], w])];
      },
    },
    pillar: {
      label: "Columna", states: ["default", "horizontal"],
      boxes: (p) => {
        const o = (16 - p.pillar) / 2;
        return [box(o, 0, o, o + p.pillar, 16, o + p.pillar)];
      },
    },
    panel: {
      label: "Panel", states: ["default"],
      boxes: (p) => {
        const o = (16 - p.panel) / 2;
        return [box(0, 0, o, 16, 16, o + p.panel)];
      },
    },
    fence: {
      label: "Valla", connects: true,
      post: () => [box(6, 0, 6, 10, 16, 10)],
      arm: () => [box(7, 6, 0, 9, 9, 6), box(7, 12, 0, 9, 15, 6)],
    },
    wall: {
      label: "Muro", connects: true,
      post: () => [box(4, 0, 4, 12, 16, 12)],
      arm: () => [box(5, 0, 0, 11, 14, 4)],
    },

    // Curvas y marcos: solid "sphere"|"cylinder"|… se rellena por distancia en el motor;
    // hole: true resta del sólido (agujeros / marcos huecos).
    sphere: {
      label: "Esfera", states: ["default"],
      boxes: (p) => {
        const r = (p.radius ?? 8) / 16;
        const c = 0.5;
        return [{ min: [c - r, c - r, c - r], max: [c + r, c + r, c + r], solid: "sphere", center: [c, c, c], radius: r }];
      },
    },
    hemisphere: {
      label: "Semiesfera", states: ["default", "inverted"],
      boxes: (p) => {
        const r = (p.radius ?? 8) / 16;
        const c = 0.5;
        return [{ min: [c - r, 0, c - r], max: [c + r, c, c + r], solid: "hemisphere", center: [c, c, c], radius: r }];
      },
    },
    cylinder: {
      label: "Cilindro", states: ["default", "horizontal"],
      boxes: (p) => {
        const r = (p.radius ?? 6) / 16;
        const c = 0.5;
        return [{ min: [c - r, 0, c - r], max: [c + r, 1, c + r], solid: "cylinder", center: [c, 0.5, c], radius: r, axis: "y" }];
      },
    },
    semicircle: {
      label: "Semicírculo", states: ["default", "inverted"],
      boxes: (p) => {
        const r = (p.radius ?? 8) / 16;
        const h = (p.panel ?? 2) / 16;
        const c = 0.5;
        return [{ min: [c - r, 0, c - r], max: [c + r, h, c + r], solid: "semicircle", center: [c, h / 2, c], radius: r }];
      },
    },
    arch: {
      label: "Arco", states: ["default"],
      boxes: (p) => {
        const thick = p.frameThick ?? 2;
        const r = (p.radius ?? 7) / 16;
        const c = 0.5;
        return [
          box(0, 0, 0, thick, 8, 16),
          box(16 - thick, 0, 0, 16, 8, 16),
          {
            min: [0, 0.5, 0], max: [1, 0.5 + r, 1],
            solid: "arch", center: [c, 0.5, c], radius: r,
            inner: Math.max(0.05, r - thick / 16),
          },
        ];
      },
    },
    frame: {
      label: "Marco", states: ["default"],
      boxes: (p) => {
        const t = p.frameThick ?? 2;
        const d = p.panel ?? 2;
        const o = (16 - d) / 2;
        return [box(0, 0, o, 16, 16, o + d), { ...box(t, t, o - 1, 16 - t, 16 - t, o + d + 1), hole: true }];
      },
    },
    frameRound: {
      label: "Marco redondo", states: ["default"],
      boxes: (p) => {
        const t = p.frameThick ?? 2;
        const d = p.panel ?? 2;
        const r = (p.radius ?? 7) / 16;
        const o = (16 - d) / 2;
        const c = 0.5;
        return [
          { min: [c - r, c - r, o / 16], max: [c + r, c + r, (o + d) / 16], solid: "cylinder", center: [c, c, 0.5], radius: r, axis: "z" },
          { min: [c - r, c - r, o / 16 - 0.05], max: [c + r, c + r, (o + d) / 16 + 0.05], solid: "cylinder", center: [c, c, 0.5], radius: Math.max(0.05, r - t / 16), axis: "z", hole: true },
        ];
      },
    },
    tube: {
      label: "Tubo", states: ["default", "horizontal"],
      boxes: (p) => {
        const r = (p.radius ?? 6) / 16;
        const t = (p.frameThick ?? 2) / 16;
        const c = 0.5;
        return [
          { min: [c - r, 0, c - r], max: [c + r, 1, c + r], solid: "cylinder", center: [c, 0.5, c], radius: r, axis: "y" },
          { min: [c - r, -0.05, c - r], max: [c + r, 1.05, c + r], solid: "cylinder", center: [c, 0.5, c], radius: Math.max(0.05, r - t), axis: "y", hole: true },
        ];
      },
    },
    custom: {
      label: "Personalizada", states: ["default", "inverted", "vertical", "horizontal"],
      boxes: (p) => parseCustom(p.custom),
    },
  };

  const PARAM_DEFAULTS = {
    layer: 4, small: 8, smallHeight: 8, pillar: 8, panel: 2,
    radius: 7, frameThick: 2,
    custom: '[ { "min": [0, 0, 0], "max": [1, 0.5, 1] } ]',
  };

  /**
   * Boxes typed by hand. Accepts the tile JSON "collision" list ({ min, max } in cell units 0..1, y up, written facing
   * front) or the same numbers in sixteenths (any value above 1 means sixteenths). A box may carry "cuts" to slope it.
   */
  function parseCustom(text) {
    let list;
    try { list = JSON.parse(text); } catch { throw new Error("Las cajas no son JSON válido."); }
    if (!Array.isArray(list) || !list.length) throw new Error("Escribe una lista de cajas: [ { \"min\": [...], \"max\": [...] } ]");
    const sixteenths = list.some((b) => [...(b.min ?? []), ...(b.max ?? [])].some((v) => v > 1));
    const k = sixteenths ? 1 / 16 : 1;
    return list.map((b, i) => {
      if (!Array.isArray(b.min) || !Array.isArray(b.max) || b.min.length !== 3 || b.max.length !== 3) {
        throw new Error(`La caja ${i + 1} necesita "min" y "max" con 3 números.`);
      }
      const min = b.min.map((v) => Math.max(0, Math.min(1, v * k))), max = b.max.map((v) => Math.max(0, Math.min(1, v * k)));
      const out = { min: min.map((v, a) => Math.min(v, max[a])), max: max.map((v, a) => Math.max(v, min[a])) };
      // Optional slope cuts: [{ "n": [x, y, z], "d": number }], solid where n·p ≤ d (d in the same units as the box).
      if (Array.isArray(b.cuts) && b.cuts.length) {
        out.cuts = b.cuts.map((c, ci) => {
          if (!Array.isArray(c.n) || c.n.length !== 3 || typeof c.d !== "number") throw new Error(`El corte ${ci + 1} de la caja ${i + 1} necesita "n" (3 números) y "d".`);
          return { n: c.n.map(Number), d: c.d * k };
        });
      }
      // Agujero: resta este volumen del sólido ya pintado. solid: "sphere"|"cylinder"|… para formas implícitas.
      if (b.hole) out.hole = true;
      if (typeof b.solid === "string") {
        out.solid = b.solid;
        if (Array.isArray(b.center) && b.center.length === 3) out.center = b.center.map((v) => v * k);
        if (typeof b.radius === "number") out.radius = b.radius * (sixteenths && b.radius > 1 ? 1 / 16 : 1);
        if (typeof b.inner === "number") out.inner = b.inner * (sixteenths && b.inner > 1 ? 1 / 16 : 1);
        if (b.axis) out.axis = b.axis;
      }
      return out;
    });
  }

  /** True when local point lp (0..1) is inside an implicit solid box (sphere, cylinder…). */
  function inSolid(b, lp) {
    if (!b.solid) return true;
    const c = b.center || [0.5, 0.5, 0.5];
    const r = b.radius ?? 0.5;
    const dx = lp[0] - c[0], dy = lp[1] - c[1], dz = lp[2] - c[2];
    if (b.solid === "sphere") return dx * dx + dy * dy + dz * dz <= r * r;
    if (b.solid === "hemisphere") return dy <= 0 && dx * dx + dy * dy + dz * dz <= r * r;
    if (b.solid === "cylinder") {
      const axis = b.axis || "y";
      if (axis === "y") return dx * dx + dz * dz <= r * r;
      if (axis === "z") return dx * dx + dy * dy <= r * r;
      return dy * dy + dz * dz <= r * r;
    }
    if (b.solid === "semicircle") {
      // Disco plano: cilindro en Y corto; solo la mitad frontal (z ≤ centro).
      return dx * dx + dz * dz <= r * r && dz <= 0;
    }
    if (b.solid === "arch") {
      // Medio anillo sobre y = center.y: entre radius e inner, solo la mitad superior.
      const dist = Math.hypot(dx, dy);
      const inner = b.inner ?? r * 0.6;
      return dy >= 0 && dist <= r && dist >= inner;
    }
    return true;
  }

  /**
   * Every sprite the chosen shape needs, in save order. Each variant: { id, label, boxes (local), state, facing,
   * art: { key, side } } where art says where it goes in the tile's "art" map (or a part name for fences / walls).
   * opts: { shape, params, states: { default: true, … }, back: true, combos: false }
   */
  function variants(opts) {
    const def = SHAPES[opts.shape] ?? SHAPES.cube;
    const p = { ...PARAM_DEFAULTS, ...(opts.params || {}) };
    const out = [];
    if (def.connects) {
      const post = def.post(p), arm = def.arm(p);
      out.push({ id: "post", label: "Poste", boxes: post, state: "default", facing: "front", art: { key: "post" } });
      out.push({ id: "arm_front", label: "Brazo · frente", boxes: arm, state: "default", facing: "front", art: { key: "arm", side: "front" } });
      if (opts.back !== false) {
        out.push({ id: "arm_back", label: "Brazo · atrás", boxes: arm, state: "default", facing: "back", art: { key: "arm", side: "back" } });
      }
      if (opts.combos) {
        // All 16 joins baked whole, for engines (or tiles) that want one sprite per neighbour pattern.
        for (let mask = 0; mask < 16; mask++) {
          const sides = SIDES.filter((_, i) => mask & (1 << i));
          const boxes = [...post, ...sides.flatMap(([, , turns]) => turnLocal(arm, turns))];
          const tag = sides.map(([c]) => c).join("") || "solo";
          out.push({ id: "join_" + tag, label: "Unión · " + (sides.map(([, t]) => t).join(" + ") || "sola"), boxes,
            state: "default", facing: "front", art: { key: "joins", side: tag } });
        }
      }
      return out;
    }
    const boxes = def.boxes(p);
    const iso = hasIso(opts.iso) ? { x: opts.iso.x | 0, y: opts.iso.y | 0, z: opts.iso.z | 0 } : null;
    for (const st of def.states) {
      if (!(opts.states?.[st] ?? st === "default")) continue;
      const front = { id: st + "_front", label: STATE_LABEL[st] + " · frente", boxes, state: st, facing: "front", iso, art: { key: st, side: "front" } };
      const back = { id: st + "_back", label: STATE_LABEL[st] + " · atrás", boxes, state: st, facing: "back", iso, art: { key: st, side: "back" } };
      if (opts.back === false) { out.push(front); continue; }
      // The project's sheets keep a vertical slab's far half before its near half (back, then front); every other state
      // reads front first. Save order is sheet order, so this is where that convention lives.
      if (st === "vertical") out.push(back, front);
      else out.push(front, back);
    }
    return out;
  }

  /**
   * The tile JSON for the saved cells: the "art" map for ordinary pieces, a "parts" proposal for fences and walls
   * (the game has no connecting pieces yet). cells: [{ variant, cell: [x, y] }].
   */
  function artSnippet(shape, cells) {
    const def = SHAPES[shape] ?? SHAPES.cube;
    const map = {};
    for (const { variant, cell } of cells) {
      const { key, side } = variant.art;
      if (!side) { map[key] = cell; continue; }
      (map[key] ??= {})[side] = cell;
    }
    const body = def.connects ? { parts: map } : { art: map };
    // One state per line, like the atlas tool writes it.
    const inner = Object.entries(Object.values(body)[0]).map(([k, v]) => `    "${k}": ${JSON.stringify(v).replace(/,/g, ", ").replace(/:/g, ": ")}`);
    return `"${Object.keys(body)[0]}": {\n${inner.join(",\n")}\n}`;
  }

  Aura.blockShapes = {
    SHAPES, PARAM_DEFAULTS, STATE_LABEL, FACING_LABEL, DIRS,
    transform, boxesToWorld, variants, artSnippet, parseCustom, turnLocal, isoMatrix, hasIso, inSolid,
  };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
