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

  /** One cell's worth of a piece taller than a cell: everything between y = 16·level and the next, brought down to
   *  0..1 so it is drawn like any other cell. */
  function sliceBoxes(boxes, level) {
    const lo = level, hi = level + 1;
    const out = [];

    for (const b of boxes) {
      if (b.max[1] <= lo || b.min[1] >= hi) continue;

      out.push({ ...b,
        min: [b.min[0], Math.max(lo, b.min[1]) - lo, b.min[2]],
        max: [b.max[0], Math.min(hi, b.max[1]) - lo, b.max[2]] });
    }

    return out;
  }

  /** The boards of a door, floor to lintel, with the seam between them left open so the planking reads. */
  function doorPlanking(thick) {
    const out = [];
    for (let x = 0; x < 16; x += 4) out.push(box(x, 0, 0, x + 3.6, 48, thick));
    return out;
  }

  /** A handle and its plate, at the height a hand finds it: two thirds up, on the swinging edge. */
  function doorHandle(thick) {
    return [box(11, 22, thick, 14, 25, thick + 1), box(11.5, 23, thick + 1, 13.5, 24, thick + 2)];
  }

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

  /**
   * Agujeros tipo boolean 3D (como Blender): volumen que atraviesa el bloque.
   * Entrada en dieciseisavos: centro (cx,cy,cz), tamaño (sx,sy,sz), rotación ° (rx,ry,rz).
   * solid: "box" | "sphere" | "cylinder". El motor resta el volumen; el interior se ve 3D.
   */
  function invRotateEuler(p, rx, ry, rz) {
    // Inversa de ZYX (mismo orden que rot3d del motor, pero en local del agujero).
    const ax = -(rx || 0) * Math.PI / 180, ay = -(ry || 0) * Math.PI / 180, az = -(rz || 0) * Math.PI / 180;
    const cx = Math.cos(ax), sx = Math.sin(ax);
    const cy = Math.cos(ay), sy = Math.sin(ay);
    const cz = Math.cos(az), sz = Math.sin(az);
    let [x, y, z] = p;
    // inv Rz
    let x1 = x * cz + y * sz, y1 = -x * sz + y * cz, z1 = z;
    // inv Ry
    let x2 = x1 * cy - z1 * sy, y2 = y1, z2 = x1 * sy + z1 * cy;
    // inv Rx
    return [x2, y2 * cx + z2 * sx, -y2 * sx + z2 * cx];
  }

  function rotateEuler(p, rx, ry, rz) {
    const ax = (rx || 0) * Math.PI / 180, ay = (ry || 0) * Math.PI / 180, az = (rz || 0) * Math.PI / 180;
    const cx = Math.cos(ax), sx = Math.sin(ax);
    const cy = Math.cos(ay), sy = Math.sin(ay);
    const cz = Math.cos(az), sz = Math.sin(az);
    let [x, y, z] = p;
    // Rx
    let y1 = y * cx - z * sx, z1 = y * sx + z * cx, x1 = x;
    // Ry
    let x2 = x1 * cy + z1 * sy, z2 = -x1 * sy + z1 * cy, y2 = y1;
    // Rz
    return [x2 * cz - y2 * sz, x2 * sz + y2 * cz, z2];
  }

  /** ¿Punto local del bloque (0..1) dentro del volumen del agujero? */
  function inHoleVolume(b, lp) {
    if (!b.hole) return false;
    const c = b.center || [
      (b.min[0] + b.max[0]) * 0.5,
      (b.min[1] + b.max[1]) * 0.5,
      (b.min[2] + b.max[2]) * 0.5,
    ];
    let p = [lp[0] - c[0], lp[1] - c[1], lp[2] - c[2]];
    const r = b.rot || [0, 0, 0];
    if (r[0] || r[1] || r[2]) p = invRotateEuler(p, r[0], r[1], r[2]);
    const h = b.half || [
      (b.max[0] - b.min[0]) * 0.5,
      (b.max[1] - b.min[1]) * 0.5,
      (b.max[2] - b.min[2]) * 0.5,
    ];
    const solid = b.solid || "box";
    if (solid === "sphere") {
      const rad = Math.max(h[0], h[1], h[2]);
      return p[0] * p[0] + p[1] * p[1] + p[2] * p[2] <= rad * rad;
    }
    if (solid === "cylinder") {
      // Eje Y local del agujero (después de rotar = dirección del boolean).
      return Math.abs(p[1]) <= h[1] && (p[0] * p[0] + p[2] * p[2]) <= h[0] * h[0];
    }
    // Caja OBB
    return Math.abs(p[0]) <= h[0] && Math.abs(p[1]) <= h[1] && Math.abs(p[2]) <= h[2];
  }

  function holeBoxes(holes) {
    if (!holes?.length) return [];
    return holes.map((h) => {
      // Prefer center+size; fallback a esquina x,y,z + w,h,d.
      let cx = h.cx, cy = h.cy, cz = h.cz;
      let sx = h.sx ?? h.w ?? 8, sy = h.sy ?? h.h ?? 8, sz = h.sz ?? h.d ?? 8;
      if (cx == null) { cx = (h.x ?? 4) + sx / 2; }
      if (cy == null) { cy = (h.y ?? 4) + sy / 2; }
      if (cz == null) { cz = (h.z ?? 4) + sz / 2; }
      cx = Math.max(0, Math.min(16, cx));
      cy = Math.max(0, Math.min(16, cy));
      cz = Math.max(0, Math.min(16, cz));
      sx = Math.max(1, Math.min(16, sx));
      sy = Math.max(1, Math.min(16, sy));
      sz = Math.max(1, Math.min(16, sz));
      const rx = h.rx || 0, ry = h.ry || 0, rz = h.rz || 0;
      const half = [sx / 32, sy / 32, sz / 32]; // en unidades 0..1
      const center = [cx / 16, cy / 16, cz / 16];
      // AABB del OBB rotado (para el barrido de voxels).
      let min = [1, 1, 1], max = [0, 0, 0];
      for (const ix of [-1, 1]) for (const iy of [-1, 1]) for (const iz of [-1, 1]) {
        const q = rotateEuler([ix * half[0], iy * half[1], iz * half[2]], rx, ry, rz);
        const w = [center[0] + q[0], center[1] + q[1], center[2] + q[2]];
        for (let a = 0; a < 3; a++) {
          if (w[a] < min[a]) min[a] = w[a];
          if (w[a] > max[a]) max[a] = w[a];
        }
      }
      // Margen para no perder voxels en el borde.
      for (let a = 0; a < 3; a++) {
        min[a] = Math.max(0, min[a] - 0.02);
        max[a] = Math.min(1, max[a] + 0.02);
      }
      return {
        min, max,
        hole: true,
        solid: h.solid && h.solid !== "box" ? h.solid : "box",
        center, half, rot: [rx, ry, rz],
      };
    });
  }


  // The four arms of a fence or a wall, named by where they run on screen and given as quarter turns of the arm that
  // points front. The game knows a neighbour by its world direction and turns it into one of these, so these same four
  // cells serve the four turns of the camera: nothing has to be drawn again for a turned world.
  const SIDES = [["sw", "abajo-izquierda", 0], ["se", "abajo-derecha", 1], ["ne", "arriba-derecha", 2], ["nw", "arriba-izquierda", 3]];

  // Drawn far to near, which is also the order the game stacks them in: the two that go up are behind the post.
  const ARM_ORDER = ["nw", "ne", "se", "sw"];

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

    // Lo crudo: palos atados, que es lo primero que se levanta antes de serrar un tablón.
    stickWall: {
      label: "Pared de palos", connects: true,
      params: [["stickThick", "Grosor del palo", 1, 4, "Lado de cada palo en dieciseisavos"]],
      post: (p) => {
        const t = p.stickThick ?? 2;
        const c = 8 - t / 2;
        return [box(c, 0, c, c + t, 16, c + t)];
      },
      // Tres palos de pie, con dos ataduras cruzadas que los sujetan: lo que se ve desde el lado.
      arm: (p) => {
        const t = p.stickThick ?? 2;
        const c = 8 - t / 2;
        const out = [];
        for (const x of [c - 3, c, c + 3]) out.push(box(x, 0, 0, x + t, 15, t));
        out.push(box(c - 3, 4, 0, c + 3 + t, 4 + 1, t + 0.5), box(c - 3, 11, 0, c + 3 + t, 11 + 1, t + 0.5));
        return out;
      },
    },

    // Cancela: los dos postes de su celda y la hoja entre ellos. Una sola celda: el juego dibuja la abierta girando
    // esta misma (ver CellShape.Open), así que no hace falta arte aparte.
    gate: {
      label: "Cancela (puerta de valla)", states: ["default"],
      params: [["gateThick", "Grosor de la hoja", 1, 6, "Grosor de los travesaños en dieciseisavos"]],
      boxes: (p) => {
        const t = p.gateThick ?? 2;
        const z0 = 8 - t / 2, z1 = 8 + t / 2;
        const boxes = [box(0, 0, z0 - 1, 3, 16, z1 + 1), box(13, 0, z0 - 1, 16, 16, z1 + 1)];
        for (const [y0, y1] of [[4, 4 + t], [10, 10 + t]]) boxes.push(box(3, y0, z0, 13, y1, z1));
        boxes.push(box(3, 3, z0, 3 + t, 14, z1), box(13 - t, 3, z0, 13, 14, z1));
        return boxes;
      },
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
      // frameThick = grosor de pilares y del anillo; radius = altura del medio punto;
      // archHeight = altura de los pilares (dieciseisavos); archDepth = profundidad Z del arco.
      boxes: (p) => {
        const thick = Math.max(1, p.frameThick ?? 2);
        const r = Math.max(2, p.radius ?? 7) / 16;
        const pillarH = Math.max(1, Math.min(14, p.archHeight ?? 8));
        const depth = Math.max(2, Math.min(16, p.archDepth ?? 16));
        const z0 = (16 - depth) / 2;
        const z1 = z0 + depth;
        const c = 0.5;
        const yTop = pillarH / 16;
        return [
          box(0, 0, z0, thick, pillarH, z1),
          box(16 - thick, 0, z0, 16, pillarH, z1),
          {
            min: [0, yTop, z0 / 16], max: [1, yTop + r, z1 / 16],
            solid: "arch", center: [c, yTop, c], radius: r,
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

    // ---- Más piezas de construcción. "params" lista los deslizadores que usa cada una (clave, etiqueta, mín, máx,
    // ayuda); la pestaña los muestra sin tener que nombrar la forma en su código.
    quarter: {
      label: "Cuarto de bloque", states: ["default", "inverted", "vertical"],
      // Half a slab: the front half of the bottom half — the step of a narrow stair or a ledge.
      boxes: () => [box(0, 0, 0, 16, 8, 8)],
    },
    corner: {
      label: "Esquina (columna de cuarto)", states: ["default", "inverted"],
      // A full-height quarter in the back-right corner: the inside of a thick corner.
      boxes: () => [box(8, 0, 8, 16, 16, 16)],
    },
    pyramid: {
      label: "Pirámide", states: ["default", "inverted"],
      params: [["shapeHeight", "Altura", 2, 16, "Altura de la punta en dieciseisavos"]],
      // Four slopes meeting at the centre top: y ≤ height · (1 − 2·|x − ½|) and the same in z.
      boxes: (p) => {
        const hgt = (p.shapeHeight ?? 16) / 16, k = 2 * hgt;
        return [cut(box(0, 0, 0, 16, p.shapeHeight ?? 16, 16),
          [[-k, 1, 0], 0], [[k, 1, 0], k], [[0, 1, -k], 0], [[0, 1, k], k])];
      },
    },
    gable: {
      label: "Tejado a dos aguas", states: ["default", "inverted"],
      params: [["shapeHeight", "Altura", 2, 16, "Altura de la cumbrera en dieciseisavos"]],
      // Two slopes meeting along a ridge that runs left–right through the middle of the cell.
      boxes: (p) => {
        const k = 2 * (p.shapeHeight ?? 16) / 16;
        return [cut(box(0, 0, 0, 16, p.shapeHeight ?? 16, 16), [[0, 1, -k], 0], [[0, 1, k], k])];
      },
    },
    roofEdge: {
      label: "Alero (rampa fina)", states: ["default", "inverted"],
      params: [["panel", "Grosor", 1, 8, "Grosor de la teja en dieciseisavos"]],
      // A roof tile: the slanted panel standing on its lower edge, open underneath.
      boxes: (p) => {
        const w = Math.SQRT2 * (p.panel ?? 2) / 16;
        return [cut(FULL, [[0, 1, -1], 0], [[0, -1, 1], w])];
      },
    },
    octagon: {
      label: "Columna octogonal", states: ["default", "horizontal"],
      params: [["octWidth", "Grosor", 4, 16, "Ancho entre caras opuestas"]],
      // A regular octagon of apothem h: the square |x|, |z| ≤ h with the four corners cut at |x| + |z| ≤ h·√2.
      boxes: (p) => {
        const w = p.octWidth ?? 12, o = (16 - w) / 2, h = w / 32, d = h * Math.SQRT2;
        return [cut(box(o, 0, o, o + w, 16, o + w),
          [[1, 0, 1], 1 + d], [[-1, 0, 1], d], [[1, 0, -1], d], [[-1, 0, -1], d - 1])];
      },
    },
    beam: {
      label: "Viga", states: ["default", "vertical", "horizontal"],
      params: [["beamSize", "Grosor", 2, 16, "Lado de la viga en dieciseisavos"]],
      // A square beam across the cell at mid height, left to right.
      boxes: (p) => {
        const t = p.beamSize ?? 6, o = (16 - t) / 2;
        return [box(0, o, o, 16, o + t, o + t)];
      },
    },
    door: {
      label: "Puerta (panel en el borde)", states: ["default"],
      params: [["doorThick", "Grosor", 1, 8, "Grosor de la hoja en dieciseisavos"]],
      // A full-height panel against the front edge of the cell, where a door or a closed trapdoor sits.
      boxes: (p) => [box(0, 0, 0, 16, 16, p.doorThick ?? 3)],
    },
    // ── Puertas ───────────────────────────────────────────────────────────────────────────────────────────────
    // En el juego una puerta son tres celdas, una encima de otra (ver crude_oak_door). Aquí se dibuja entera, de 0 a
    // 48 de alto, y cada celda se queda con su rebanada; el JSON sale ya como "parts", con su offsetY.
    doorPlanks: {
      label: "Puerta · tablones", slices: 3, states: ["default"],
      params: [["doorThick", "Grosor", 1, 8, "Grosor de la hoja en dieciseisavos"]],
      boxes: (p) => doorPlanking(p.doorThick ?? 3).concat(doorHandle(p.doorThick ?? 3)),
    },
    doorBraced: {
      label: "Puerta · con refuerzo", slices: 3, states: ["default"],
      params: [["doorThick", "Grosor", 1, 8, "Grosor de la hoja en dieciseisavos"]],
      boxes: (p) => {
        const t = p.doorThick ?? 3;
        const out = doorPlanking(t);
        // Dos travesaños y una tranca en diagonal, por fuera de la hoja: lo que no deja que se abarquille.
        for (const y of [6, 38]) out.push(box(1, y, t, 15, y + 3, t + 1));
        for (let i = 0; i < 10; i++) out.push(box(1 + i * 1.4, 8 + i * 3, t, 1 + i * 1.4 + 2.5, 8 + i * 3 + 4, t + 1));
        return out.concat(doorHandle(t));
      },
    },
    doorBarred: {
      label: "Puerta · de barrotes", slices: 3, states: ["default"],
      params: [["doorThick", "Grosor", 1, 8, "Grosor del marco en dieciseisavos"]],
      boxes: (p) => {
        const t = p.doorThick ?? 3;
        const out = [box(0, 0, 0, 2, 48, t), box(14, 0, 0, 16, 48, t), box(0, 0, 0, 16, 2, t), box(0, 46, 0, 16, 48, t)];
        for (const y of [16, 31]) out.push(box(2, y, 0, 14, y + 2, t));
        for (let x = 3; x <= 12; x += 3) out.push(box(x, 2, t / 4, x + 1.5, 46, t / 4 + t / 2));
        return out.concat(doorHandle(t));
      },
    },
    doorSticks: {
      label: "Puerta · de palos", slices: 3, states: ["default"],
      params: [["stickThick", "Grosor del palo", 1, 4, "Lado de cada palo en dieciseisavos"]],
      boxes: (p) => {
        const t = p.stickThick ?? 2;
        const out = [];
        // Palos de pie, dos ataduras y una diagonal: una puerta antes de tener sierra.
        for (let x = 1; x + t <= 15; x += t + 1) out.push(box(x, 0, 0, x + t, 48, t));
        for (const y of [8, 24, 40]) out.push(box(0, y, t, 16, y + t, t + 1));
        for (let i = 0; i < 9; i++) out.push(box(1 + i * 1.5, 10 + i * 3, t, 1 + i * 1.5 + 2, 10 + i * 3 + 4, t + 1));
        return out;
      },
    },
    doorPanelled: {
      label: "Puerta · con cuarterones", slices: 3, states: ["default"],
      params: [["doorThick", "Grosor", 1, 8, "Grosor de la hoja en dieciseisavos"]],
      boxes: (p) => {
        const t = p.doorThick ?? 3;
        const out = [box(0, 0, 0, 16, 48, t * 0.6)];
        // Marco y dos cuarterones hundidos: la puerta buena, la que sustituye a la cruda.
        for (const [x0, y0, x1, y1] of [[0, 0, 3, 48], [13, 0, 16, 48], [0, 0, 16, 3], [0, 45, 16, 48], [0, 22, 16, 26]]) {
          out.push(box(x0, y0, 0, x1, y1, t));
        }
        return out.concat(doorHandle(t));
      },
    },
    trapdoor: {
      label: "Trampilla", states: ["default", "inverted"],
      params: [["doorThick", "Grosor", 1, 8, "Grosor en dieciseisavos"]],
      boxes: (p) => [box(0, 0, 0, 16, p.doorThick ?? 3, 16)],
    },
    ladder: {
      label: "Escalera de mano", states: ["default"],
      // Two rails against the back face and a rung every quarter.
      boxes: () => [
        box(2, 0, 14, 4, 16, 16), box(12, 0, 14, 14, 16, 16),
        box(4, 2, 14.5, 12, 3.5, 15.5), box(4, 6, 14.5, 12, 7.5, 15.5), box(4, 10, 14.5, 12, 11.5, 15.5), box(4, 14, 14.5, 12, 15.5, 15.5),
      ],
    },
    table: {
      label: "Mesa", states: ["default"],
      params: [["panel", "Grosor tablero", 1, 6, "Grosor del tablero"], ["legs", "Grosor patas", 1, 6, "Lado de cada pata"]],
      boxes: (p) => {
        const t = p.panel ?? 2, l = Math.min(6, p.legs ?? 2), top = 16 - t;
        return [box(0, top, 0, 16, 16, 16),
          box(1, 0, 1, 1 + l, top, 1 + l), box(15 - l, 0, 1, 15, top, 1 + l),
          box(1, 0, 15 - l, 1 + l, top, 15), box(15 - l, 0, 15 - l, 15, top, 15)];
      },
    },
    pedestal: {
      label: "Pedestal", states: ["default", "inverted"],
      // Wide base, narrower shaft, cap: a plinth, a lamp post foot or a statue stand.
      boxes: () => [box(1, 0, 1, 15, 3, 15), box(4, 3, 4, 12, 13, 12), box(2, 13, 2, 14, 16, 14)],
    },
    steps: {
      label: "Escalones (3)", states: ["default", "inverted"],
      // Three thin steps instead of the game's two-step stair: a gentler staircase.
      boxes: () => [box(0, 0, 0, 16, 5.33, 16), box(0, 5.33, 5.33, 16, 10.67, 16), box(0, 10.67, 10.67, 16, 16, 16)],
    },
    custom: {
      label: "Personalizada", states: ["default", "inverted", "vertical", "horizontal"],
      boxes: (p) => parseCustom(p.custom),
    },
  };

  const PARAM_DEFAULTS = {
    layer: 4, small: 8, smallHeight: 8, pillar: 8, panel: 2,
    radius: 7, frameThick: 2, archHeight: 8, archDepth: 16, shapeHeight: 16, octWidth: 12, beamSize: 6, legs: 2, doorThick: 3,
    // Escala de la forma dentro de la celda (1 = tamaño completo).
    scale: 1,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    // Posición de la forma principal en dieciseisavos (se sale de la celda = se recorta) y espejo izquierda ↔ derecha.
    offX: 0, offY: 0, offZ: 0, mirrorX: false,
    custom: '[ { "min": [0, 0, 0], "max": [1, 0.5, 1] } ]',
  };

  /** Escala cajas (y radios de sólidos implícitos) alrededor del centro de la celda. */
  /** Escala cajas alrededor del centro. sx/sy/sz pueden ser un número o {x,y,z}. Permite >1 hasta el borde. */
  function scaleBoxes(boxes, sx, sy, sz) {
    if (sx != null && typeof sx === "object") {
      sy = sx.y; sz = sx.z; sx = sx.x;
    }
    if (sy == null) sy = sx;
    if (sz == null) sz = sx;
    sx = Math.max(0.05, Math.min(1.25, Number(sx) || 1));
    sy = Math.max(0.05, Math.min(1.25, Number(sy) || 1));
    sz = Math.max(0.05, Math.min(1.25, Number(sz) || 1));
    if (sx === 1 && sy === 1 && sz === 1) return boxes;
    const sc = [sx, sy, sz];
    return boxes.map((b) => {
      const out = {
        ...b,
        min: b.min.map((v, i) => 0.5 + (v - 0.5) * sc[i]),
        max: b.max.map((v, i) => 0.5 + (v - 0.5) * sc[i]),
      };
      if (typeof b.radius === "number") out.radius = b.radius * Math.min(sx, sy, sz);
      if (typeof b.inner === "number") out.inner = b.inner * Math.min(sx, sy, sz);
      if (Array.isArray(b.center)) out.center = b.center.map((v, i) => 0.5 + (v - 0.5) * sc[i]);
      return out;
    });
  }

  // ── Placing pieces ───────────────────────────────────────────────────────────────────────────────────────────────
  // Moves, mirrors and turns work on whole parts — their cuts, curved solids and centres move with them — so a ramp or
  // a cylinder can be put anywhere in the cell and combined with others.

  /** Mirror left ↔ right (x → 1 − x). A cut n·p ≤ d becomes (−n₀, n₁, n₂)·p ≤ d − n₀. */
  function mirrorBoxes(boxes) {
    return boxes.map((b) => {
      const out = { ...b, min: [1 - b.max[0], b.min[1], b.min[2]], max: [1 - b.min[0], b.max[1], b.max[2]] };
      if (b.cuts) out.cuts = b.cuts.map((c) => ({ n: [-c.n[0], c.n[1], c.n[2]], d: c.d - c.n[0] }));
      if (Array.isArray(b.center)) out.center = [1 - b.center[0], b.center[1], b.center[2]];
      return out;
    });
  }

  /** Quarter turns about the vertical centre line, like turnLocal, but keeping cuts, centres and cylinder axes. */
  function turnBoxes(boxes, n) {
    let out = boxes;
    for (let s = 0; s < (n & 3); s++) {
      out = out.map((b) => {
        // (x, y, z) → (1 − z, y, x); a cut n·p ≤ d on the old point is (−n₂, n₁, n₀)·q ≤ d − n₂ on the new one.
        const a = [1 - b.min[2], b.min[1], b.min[0]], c = [1 - b.max[2], b.max[1], b.max[0]];
        const t = { ...b, min: [Math.min(a[0], c[0]), a[1], Math.min(a[2], c[2])], max: [Math.max(a[0], c[0]), c[1], Math.max(a[2], c[2])] };
        if (b.cuts) t.cuts = b.cuts.map((k) => ({ n: [-k.n[2], k.n[1], k.n[0]], d: k.d - k.n[2] }));
        if (Array.isArray(b.center)) t.center = [1 - b.center[2], b.center[1], b.center[0]];
        if (b.axis === "x") t.axis = "z"; else if (b.axis === "z") t.axis = "x";
        return t;
      });
    }
    return out;
  }

  /** Moves parts by (dx, dy, dz) sixteenths. What ends up outside the cell is cut off by the cell itself; a cut moves
   *  with its part (n·(p − t) ≤ d → n·p ≤ d + n·t). */
  function moveBoxes(boxes, dx = 0, dy = 0, dz = 0) {
    if (!dx && !dy && !dz) return boxes;
    const t = [dx / 16, dy / 16, dz / 16];
    const clamp = (v) => Math.max(0, Math.min(1, v));
    return boxes
      .map((b) => {
        const out = { ...b, min: b.min.map((v, i) => clamp(v + t[i])), max: b.max.map((v, i) => clamp(v + t[i])) };
        if (b.cuts) out.cuts = b.cuts.map((c) => ({ n: c.n, d: c.d + c.n[0] * t[0] + c.n[1] * t[1] + c.n[2] * t[2] }));
        if (Array.isArray(b.center)) out.center = b.center.map((v, i) => v + t[i]);
        return out;
      })
      .filter((b) => b.max.every((v, i) => v - b.min[i] > 1e-6));
  }

  /** Scale, mirror, turn and move, in that order: how the main shape and every extra piece are placed. */
  function placeBoxes(boxes, t) {
    let out = boxes;
    const sx = t.sx ?? 1, sy = t.sy ?? 1, sz = t.sz ?? 1;
    if (sx !== 1 || sy !== 1 || sz !== 1) out = scaleBoxes(out, sx, sy, sz);
    if (t.mirror) out = mirrorBoxes(out);
    if (t.turn) out = turnBoxes(out, t.turn);
    return moveBoxes(out, t.x, t.y, t.z);
  }

  /** Shapes an extra piece can be (fences and walls join with neighbours and cannot be stacked into one block). */
  const extraShapes = () => Object.entries(SHAPES).filter(([, s]) => !s.connects).map(([k, s]) => [k, s.label]);

  /**
   * Extra pieces combined with the main shape: [{ shape, params, sx, sy, sz, x, y, z, turn, mirror, mode }].
   * mode "add" joins the piece to the block; "subtract" carves it out (a ramp-shaped notch, a round hollow…).
   */
  function extraBoxes(extras) {
    const out = [];
    for (const e of extras ?? []) {
      const def = SHAPES[e.shape];
      if (!def || def.connects) continue;
      let boxes;
      try { boxes = def.boxes({ ...PARAM_DEFAULTS, ...(e.params || {}) }); } catch { continue; }
      boxes = placeBoxes(boxes, e);
      if (e.mode === "subtract") boxes = boxes.map((b) => ({ ...b, hole: true }));
      out.push(...boxes);
    }
    return out;
  }

  /** The block's boxes as the "custom" JSON, to keep editing them by hand. Units of the cell (0..1), 4 decimals. */
  function boxesToCustom(boxes) {
    const r = (v) => Math.round(v * 10000) / 10000;
    const list = boxes.filter((b) => !(b.hole && b.half)).map((b) => {
      const o = { min: b.min.map(r), max: b.max.map(r) };
      if (b.cuts?.length) o.cuts = b.cuts.map((c) => ({ n: c.n.map(r), d: r(c.d) }));
      if (b.hole) o.hole = true;
      if (b.solid) {
        o.solid = b.solid;
        if (b.center) o.center = b.center.map(r);
        if (typeof b.radius === "number") o.radius = r(b.radius);
        if (typeof b.inner === "number") o.inner = r(b.inner);
        if (b.axis) o.axis = b.axis;
      }
      return o;
    });
    return "[\n" + list.map((o) => "  " + JSON.stringify(o)).join(",\n") + "\n]";
  }

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

  /** The block's own boxes before the user's holes: the main shape placed (scale, mirror, move) plus its extra pieces. */
  function composeBoxes(opts) {
    const def = SHAPES[opts.shape] ?? SHAPES.cube;
    const p = { ...PARAM_DEFAULTS, ...(opts.params || {}) };
    const boxes = placeBoxes(def.boxes(p), {
      sx: (p.scaleX ?? 1) * (p.scale ?? 1), sy: (p.scaleY ?? 1) * (p.scale ?? 1), sz: (p.scaleZ ?? 1) * (p.scale ?? 1),
      mirror: !!p.mirrorX, x: p.offX, y: p.offY, z: p.offZ,
    });
    return boxes.concat(extraBoxes(opts.extras));
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

      // One cell per arm, each lit for the side it is really on. Two would do with a mirrored sprite, but the mirror
      // puts the light on the wrong face, and a rail is mostly its lit faces.
      for (const name of ARM_ORDER) {
        const [, label, turns] = SIDES.find(([id]) => id === name);
        out.push({ id: "arm_" + name, label: "Brazo · " + label, boxes: turnLocal(arm, turns),
          state: "default", facing: "front", art: { key: "connect", side: name } });
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
    let boxes = composeBoxes(opts);
    // Agujeros del usuario (movibles): se restan del sólido; el interior se ilumina como superficie 3D.
    if (opts.holes?.length) boxes = boxes.concat(holeBoxes(opts.holes));
    const iso = hasIso(opts.iso) ? { x: opts.iso.x | 0, y: opts.iso.y | 0, z: opts.iso.z | 0 } : null;

    // A piece taller than its cell (a door) is drawn whole and cut into one cell per floor, bottom first — the order
    // the tile's "parts" are written in.
    if (def.slices > 1) {
      for (let level = 0; level < def.slices; level++) {
        const cut = sliceBoxes(boxes, level);
        const label = ["Abajo", "Medio", "Arriba"][level] ?? "Celda " + (level + 1);
        const front = { id: "part" + level + "_front", label: label + " · frente", boxes: cut, state: "default",
          facing: "front", iso, art: { key: "part" + level, side: "front" } };
        const back = { id: "part" + level + "_back", label: label + " · atrás", boxes: cut, state: "default",
          facing: "back", iso, art: { key: "part" + level, side: "back" } };
        if (opts.back === false) out.push(front);
        else out.push(front, back);
      }
      return out;
    }

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

    // A fence writes the art the game reads: the post is what it looks like standing alone, and "connect" holds the
    // four arms. "connects" says what it reaches for — its own kind, and a solid block so a fence closes on a wall.
    if (def.connects) {
      const post = map.post, arms = map.connect ?? {};
      const lines = [`    "default": { "front": ${pair(post)} }`];
      const inner = Object.keys(arms).map((k) => `"${k}": ${pair(arms[k])}`).join(", ");
      if (inner) lines.push(`    "connect": { ${inner} }`);
      return `"art": {\n${lines.join(",\n")}\n},\n"connects": [ "${shape}", "solid" ]`;
    }

    // A door is three cells, one on top of the other: the tile names them as parts, bottom first.
    if (def.slices > 1) {
      const parts = [];
      for (let level = 0; level < def.slices; level++) {
        const sides = map["part" + level];
        if (!sides) continue;

        const art = Object.keys(sides).map((side) => `"${side}": ${pair(sides[side])}`).join(", ");
        parts.push(`  {\n    "offsetX": 0,\n    "offsetY": ${level},\n    "offsetZ": 0,\n` +
          `    "art": { "default": { ${art} } }\n  }`);
      }
      return `"parts": [\n${parts.join(",\n")}\n]`;
    }

    // One state per line, like the atlas tool writes it.
    const inner = Object.entries(map).map(([k, v]) => `    "${k}": ${JSON.stringify(v).replace(/,/g, ", ").replace(/:/g, ": ")}`);
    return `"art": {\n${inner.join(",\n")}\n}`;
  }

  const pair = (cell) => (Array.isArray(cell) ? `[ ${cell[0]}, ${cell[1]} ]` : "[ 0, 0 ]");

  Aura.blockShapes = {
    SHAPES, PARAM_DEFAULTS, STATE_LABEL, FACING_LABEL, DIRS,
    transform, boxesToWorld, variants, holeBoxes, inHoleVolume, artSnippet, parseCustom, turnLocal, isoMatrix, hasIso, inSolid, scaleBoxes,
    mirrorBoxes, turnBoxes, moveBoxes, placeBoxes, extraBoxes, extraShapes, composeBoxes, boxesToCustom,
  };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
