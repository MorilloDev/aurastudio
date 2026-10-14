"use strict";

// Block generator engine: builds a piece (cube, slab, stair, fence…) out of voxels from the textures of its faces and
// renders it with the game's camera into a sprite, with its normal map, depth, ambient occlusion and a grayscale pass.
// No DOM, no canvas: plain arrays in, plain arrays out, so the same code runs in the page, in a worker or under Node.
// Needs shapes.js (Aura.blockShapes); hair.js (Aura.blockHair) is optional and draws the fringe strands.
(function (Aura) {
  const Shapes = Aura.blockShapes;

  // ── Camera ───────────────────────────────────────────────────────────────────────────────────────────────────────
  // Blender camera rotation (60°, 0°, 45°), orthographic. These are its right / up / forward axes in world space; the
  // normal map stores a normal as (n·right, n·up, n·back), which is what NormalMapLoader decodes (top = #80EEBF…).
  const RIGHT = [Math.SQRT1_2, Math.SQRT1_2, 0];
  const UP = [-0.3535534, 0.3535534, 0.8660254];
  const FWD = [-0.6123724, 0.6123724, -0.5];
  const BACK = [-FWD[0], -FWD[1], -FWD[2]];

  // √(2/3): the block height that makes a 1 × 1 block fill a square sprite (32 px diamond over 32 px sides at 64).
  const BLOCK_HEIGHT = 0.8164966;

  // The faces the camera can see. A voxel side pointing -X, +Y or down never faces this camera.
  const FACE = { TOP: 1, LEFT: 2, RIGHT: 3 };

  // #80EEBF, #2553CE, #DA53CE — see NormalMapLoader.FaceTop / FaceLeft / FaceRight in the game.
  const FACE_NORMAL_RGB = { 1: [128, 238, 191], 2: [37, 83, 206], 3: [218, 83, 206] };

  // World direction indices (Shapes.DIRS): 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z (up), 5 -Z.
  const DIRS = Shapes.DIRS;
  const W_RIGHT = 0, W_LEFT = 3, W_UP = 4;
  const VISIBLE_DIRS = [W_UP, W_LEFT, W_RIGHT];
  const DIR_FACE = { [W_UP]: FACE.TOP, [W_LEFT]: FACE.LEFT, [W_RIGHT]: FACE.RIGHT };

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

  /** Small deterministic random generator (mulberry32), so a seed always gives the same chips, lips and hairs. */
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Textures ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * One face's picture: a rectangle of an RGBA image (an atlas cell or a whole loose texture), plus how it is laid on
   * the face. Face coordinates are 0..1 (u to the right as seen from outside, v up), after the face's rotation
   * (0/90/180/270) and mirror.
   */
  function faceTexture(img, rect, rotate = 0, flip = false) {
    const { x, y, w, h } = rect;
    return {
      img, rect, w, h,
      texel(u, v) {
        let a = flip ? 1 - u : u;
        let b = v;
        for (let r = 0; r < ((rotate / 90) & 3); r++) [a, b] = [b, 1 - a];
        const tx = Math.min(w - 1, Math.max(0, Math.floor(a * w)));
        const ty = Math.min(h - 1, Math.max(0, Math.floor((1 - b) * h)));
        return ((y + ty) * img.w + (x + tx)) * 4;
      },
      color(u, v) {
        const i = this.texel(u, v);
        return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
      },
      /** Height (0..1) of the texels a voxel column covers. mode "min" keeps thin dark lines (mortar, cracks) that an
       *  average would wash out at a coarse resolution; "avg" and "max" are there for soft or bright-lined pictures. */
      height(u0, v0, u1, v1, source, invert, mode = "min") {
        let sum = 0;
        let n = 0;
        let mn = Infinity, mx = -Infinity;
        const steps = Math.max(1, Math.round(Math.max(w, h) * Math.max(u1 - u0, v1 - v0)));
        for (let a = 0; a < steps; a++) {
          for (let b = 0; b < steps; b++) {
            const i = this.texel(u0 + (u1 - u0) * (a + 0.5) / steps, v0 + (v1 - v0) * (b + 0.5) / steps);
            const al = img.rgba[i + 3] / 255;
            let hgt = source === "alpha" ? al
              : al < 0.02 ? 0 : (0.2126 * img.rgba[i] + 0.7152 * img.rgba[i + 1] + 0.0722 * img.rgba[i + 2]) / 255;
            if (invert) hgt = 1 - hgt;
            sum += hgt;
            n++;
            if (hgt < mn) mn = hgt;
            if (hgt > mx) mx = hgt;
          }
        }
        if (!n) return 0;
        return mode === "max" ? mx : mode === "avg" ? sum / n : mn;
      },
    };
  }

  /**
   * Which texture and where on it, for a point of the piece seen through one of its faces. lp: point in the texture
   * frame (unit cube), ld: that face's direction in the same frame. Caps (up / down) take the top texture, the front
   * and back take the left one, the two sides the right one; on the sides v always runs up the piece, so a slab's side
   * shows the lower half of the side texture, like Minecraft.
   */
  function localUV(lp, ld) {
    switch (ld) {
      case 2: return ["top", lp[0], lp[2]];
      case 3: return ["top", lp[0], 1 - lp[2]];
      case 5: return ["left", lp[0], lp[1]];
      case 4: return ["left", 1 - lp[0], lp[1]];
      case 0: return ["right", lp[2], lp[1]];
      default: return ["right", 1 - lp[2], lp[1]];
    }
  }

  // ── Defaults ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const HAIR_DEFAULTS = {
    enabled: false,
    edges: { backLeft: true, backRight: true, frontTop: true, corner: false, bottomLeft: true, bottomRight: true },
    density: 0.35,              // strands per sprite pixel of edge
    length: 4,                  // sprite pixels
    lengthVar: 0.6,             // 0 = all the same, 1 = from nothing to full length
    lean: 0.35,                 // 0 = straight up (or down at the bottom), 1 = straight out of the face
    spread: 0.35,               // random turn of each strand
    droop: 0,                   // strands bend down toward the tip
    width: 1,                   // pixels at the root (tapers to 1)
    tipShade: -0.25,            // tip darker (< 0) or lighter (> 0)
    seed: 3,
  };

  const DEFAULTS = {
    size: 64,                   // sprite width and height, px; a full block always fills it
    res: 32,                    // voxels per block edge
    blockHeight: BLOCK_HEIGHT,
    relief: "out",              // "out": bright texels rise off the piece; "in": dark texels are carved in; "none"
    source: "luma",             // height from "luma" (brightness) or "alpha"
    invert: false,
    autoContrast: true,         // stretch each face's darkest..brightest texel to 0..1 before thresholding
    sampling: "min",            // how a voxel column reads the texels under it: "min", "avg" or "max"
    threshold: 0,
    steps: 2,                   // height levels: few levels read as clean pixel-art steps
    depth: 1,                   // relief depth in voxels
    faces: { top: true, left: true, right: true },     // which textures get relief
    edges: { topLeft: true, topRight: true, bottomLeft: true, bottomRight: true, sides: false },
    edgeFalloff: 2,             // voxels over which relief fades out toward an edge that must stay flat
    autoFit: true,              // shorten bumps and hairs that would leave the sprite
    texMode: "auto",            // "follow": textures turn with the piece; "world": top texture always on top; "auto"
    uvMode: "world",            // "world": a slab shows half the side texture; "fit": the texture is squeezed onto it
    chips: 0,                   // 0..1 chance that a voxel on an edge of the piece is chipped away
    lip: 0,                     // longest overhang hanging from a top edge, in voxels (0 = none)
    lipChance: 0.6,
    seed: 1,
    shading: true,              // bake the face light like the Blender materials
    shade: { top: 1, left: 0.75, right: 0.55 },
    ao: true,
    aoDistance: 0.25,           // in blocks
    aoStrength: 0.6,
    aoSamples: 16,
    aoSteps: 4,                 // AO quantized to this many levels (0 = smooth): pixel art reads cleaner in steps
    grayFromTexture: false,     // grayscale pass keeps the texture's own brightness
    edgeLight: 0.12,            // brighten the top faces' rim
    outline: 0,                 // darken the silhouette's inner edge pixels by this much
    cleanup: true,              // replace lone pixels surrounded by one colour
    hair: HAIR_DEFAULTS,
  };

  function merge(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    o.faces = { ...DEFAULTS.faces, ...(opts.faces || {}) };
    o.edges = { ...DEFAULTS.edges, ...(opts.edges || {}) };
    o.shade = { ...DEFAULTS.shade, ...(opts.shade || {}) };
    o.hair = { ...HAIR_DEFAULTS, ...(opts.hair || {}) };
    o.hair.edges = { ...HAIR_DEFAULTS.edges, ...(opts.hair?.edges || {}) };
    return o;
  }

  const CUBE = { boxes: [{ min: [0, 0, 0], max: [1, 1, 1] }], state: "default", facing: "front" };

  // ── Voxels ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The piece as a voxel grid. Cell voxels are i, j, k in 0..res-1 (x, y, z, z up); relief that rises out of the piece
   * and lips can spill past the cell by a few voxels on every side. Each solid voxel stores 0 (coloured by whatever
   * face of it is seen) or 1 + the world direction of the surface whose texture colours it.
   */
  function buildVoxels(o, tex, piece) {
    const R = o.res;
    const D = o.relief === "none" ? 0 : Math.max(1, Math.round(o.depth));
    const out = o.relief === "out";
    const pad = (out ? D : 0) + (o.lip > 0 ? 1 : 0);
    const iLo = -pad, iHi = R + pad, jLo = -pad, jHi = R + pad, kLo = 0, kHi = R + pad;
    const nx = iHi - iLo, ny = jHi - jLo, nz = kHi - kLo;
    const grid = new Uint8Array(nx * ny * nz);
    const idx = (i, j, k) => ((k - kLo) * ny + (j - jLo)) * nx + (i - iLo);
    const inside = (i, j, k) => i >= iLo && i < iHi && j >= jLo && j < jHi && k >= kLo && k < kHi;
    const vx = 1 / R, vz = o.blockHeight / R;

    const follow = o.texMode === "follow" || (o.texMode === "auto" && piece.state === "horizontal");
    const tf = Shapes.transform(piece.state, piece.facing, follow);
    const worldBoxes = Shapes.boxesToWorld(piece.boxes, tf);

    // The piece itself, before any relief.
    const base = new Uint8Array(R * R * R);
    const bIdx = (i, j, k) => (k * R + j) * R + i;
    const inCell = (i, j, k) => i >= 0 && i < R && j >= 0 && j < R && k >= 0 && k < R;
    for (const b of worldBoxes) {
      const lo = b.min.map((v) => Math.round(v * R)), hi = b.max.map((v) => Math.round(v * R));
      for (let k = lo[2]; k < hi[2]; k++) for (let j = lo[1]; j < hi[1]; j++) for (let i = lo[0]; i < hi[0]; i++) {
        if (inCell(i, j, k)) base[bIdx(i, j, k)] = 1;
      }
    }
    const isBase = (i, j, k) => inCell(i, j, k) && base[bIdx(i, j, k)] === 1;

    // Texture frame bounds, for squeezing the textures onto the piece ("fit").
    let fitLo = [0, 0, 0], fitHi = [1, 1, 1];
    if (o.uvMode === "fit") {
      fitLo = [1, 1, 1]; fitHi = [0, 0, 0];
      for (const b of worldBoxes) {
        for (const p of [b.min, b.max]) {
          const l = tf.texLocal(p);
          for (let a = 0; a < 3; a++) { fitLo[a] = Math.min(fitLo[a], l[a]); fitHi[a] = Math.max(fitHi[a], l[a]); }
        }
      }
    }
    /** World unit point + world direction of the surface → [texture name, u, v]. */
    const uvAt = (up, wd) => {
      let lp = tf.texLocal(up);
      if (o.uvMode === "fit") lp = lp.map((v, a) => (v - fitLo[a]) / Math.max(1e-6, fitHi[a] - fitLo[a]));
      const [name, u, v] = localUV(lp, tf.texDir(wd));
      return [name, clamp01(u), clamp01(v)];
    };

    // Relief levels per texture, 0..D, on an R × R grid of each texture.
    const levels = {};
    const lvlSteps = Math.max(1, o.steps);
    for (const name of ["top", "left", "right"]) {
      const L = new Uint8Array(R * R);
      levels[name] = L;
      if (!o.faces[name] || D === 0) { L.fill(out ? 0 : D); continue; }
      // Raw heights first, so auto contrast can stretch this texture's own range: a texture drawn in a narrow band of
      // values (a mid-grey stone) still gets its full relief.
      const raw = new Float32Array(R * R);
      let lo = Infinity, hi = -Infinity;
      for (let a = 0; a < R; a++) for (let b = 0; b < R; b++) {
        const v = tex[name].height(a / R, b / R, (a + 1) / R, (b + 1) / R, o.source, o.invert, o.sampling);
        raw[b * R + a] = v;
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      const span = hi - lo;
      for (let n = 0; n < R * R; n++) {
        let hgt = raw[n];
        if (o.autoContrast && span > 1e-3) hgt = (hgt - lo) / span;
        hgt = clamp01((hgt - o.threshold) / Math.max(1e-4, 1 - o.threshold));
        hgt = hgt > 0 ? Math.ceil(hgt * lvlSteps - 1e-6) / lvlSteps : 0;
        L[n] = Math.round(hgt * D);
      }
    }

    // Edges that must stay flat fade the relief out: the four corner zones of the sprite are measured from the cell's
    // borders, and the cell's outer vertical edges always stay flat unless "sides" is on (past them a bump would leave
    // the sprite sideways).
    const fall = Math.max(0, o.edgeFalloff);
    const edgeMask = (d) => (fall <= 0 ? (d <= 0 ? 0 : 1) : clamp01(d / fall));
    const zoneMask = (wd, i, j, k) => {
      let m = 1;
      if (wd === W_UP) {
        if (!o.edges.topLeft) m = Math.min(m, edgeMask(i));
        if (!o.edges.topRight) m = Math.min(m, edgeMask(R - 1 - j));
      } else if (wd === W_LEFT) {
        if (!o.edges.sides) m = Math.min(m, edgeMask(i));
        if (!o.edges.bottomLeft) m = Math.min(m, edgeMask(k));
      } else {
        if (!o.edges.sides) m = Math.min(m, edgeMask(R - 1 - j));
        if (!o.edges.bottomRight) m = Math.min(m, edgeMask(k));
      }
      return m;
    };
    const centre = (i, j, k) => [(i + 0.5) / R, (j + 0.5) / R, (k + 0.5) / R];
    /** Relief level of the surface voxel (i, j, k) seen from world direction wd. */
    const levelAt = (wd, i, j, k) => {
      const d = DIRS[wd];
      const c = centre(i, j, k);
      const up = [c[0] + d[0] * 0.5 / R, c[1] + d[1] * 0.5 / R, c[2] + d[2] * 0.5 / R];
      const [name, u, v] = uvAt(up, wd);
      const a = Math.min(R - 1, Math.floor(u * R)), b = Math.min(R - 1, Math.floor(v * R));
      const lv = levels[name][b * R + a];
      const m = zoneMask(wd, i, j, k);
      // In: the mask keeps the edge uncarved. Out: it keeps the edge from rising.
      return out ? Math.round(lv * m) : Math.round(D - (D - lv) * m);
    };

    // Owners: a voxel within reach of a visible surface takes that surface's texture (top wins ties), so a rim shows
    // the top's pixels like a hand-drawn tile, and a pit carved into a face keeps that face's colours on its walls.
    const reach = Math.max(1, D);
    for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      if (!base[bIdx(i, j, k)]) continue;
      let owner = 0, best = reach;
      for (const wd of VISIBLE_DIRS) {
        const d = DIRS[wd];
        let t = 0;
        while (t < best && isBase(i + d[0] * (t + 1), j + d[1] * (t + 1), k + d[2] * (t + 1))) t++;
        if (t < best) { best = t; owner = wd + 1; }
      }
      grid[idx(i, j, k)] = owner || 255;
    }

    const spriteFits = (i, j, k) => {
      if (!o.autoFit) return true;
      const S = o.size, H = o.blockHeight;
      for (const dx of [0, 1]) for (const dy of [0, 1]) for (const dz of [0, 1]) {
        const [px, py] = project([-0.5 + (i + dx) * vx, -0.5 + (j + dy) * vx, (k + dz) * vz], S, H);
        if (px < -1e-6 || px > S + 1e-6 || py < -1e-6 || py > S + 1e-6) return false;
      }
      return true;
    };

    // Relief, from every visible surface of the piece.
    if (D > 0) {
      const carve = [];
      for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
        if (!base[bIdx(i, j, k)]) continue;
        for (const wd of VISIBLE_DIRS) {
          const d = DIRS[wd];
          if (isBase(i + d[0], j + d[1], k + d[2])) continue;
          const lv = levelAt(wd, i, j, k);
          if (out) {
            for (let s = 1; s <= lv; s++) {
              const a = i + d[0] * s, b = j + d[1] * s, c = k + d[2] * s;
              if (!inside(a, b, c) || isBase(a, b, c) || !spriteFits(a, b, c)) break;
              if (!grid[idx(a, b, c)]) grid[idx(a, b, c)] = wd + 1;
            }
          } else {
            // Never carve through: thin pieces (panels, fence rails) keep at least one voxel.
            let thick = 0;
            while (thick <= D && isBase(i - d[0] * thick, j - d[1] * thick, k - d[2] * thick)) thick++;
            const n = Math.min(D - lv, thick - 1);
            for (let s = 0; s < n; s++) carve.push(idx(i - d[0] * s, j - d[1] * s, k - d[2] * s));
          }
        }
      }
      for (const c of carve) grid[c] = 0;
    }

    const solid = (i, j, k) => (inside(i, j, k) ? grid[idx(i, j, k)] : 0);
    const random = rng(o.seed);

    // Chipped edges: piece voxels with two open sides (the bottom does not count) are knocked off now and then.
    if (o.chips > 0) {
      const chip = [];
      for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
        if (!base[bIdx(i, j, k)] || !solid(i, j, k)) continue;
        let open = 0;
        for (let wd = 0; wd < 5; wd++) {
          const d = DIRS[wd];
          if (!solid(i + d[0], j + d[1], k + d[2])) open++;
        }
        if (open >= 2 && random() < o.chips) chip.push(idx(i, j, k));
      }
      for (const c of chip) grid[c] = 0;
    }

    // Lip: a top surface hanging over the side faces below its front edges (grass, snow, moss). Owned by the top, so it
    // shows the top texture's edge pixels.
    if (o.lip > 0) {
      for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
        if (!base[bIdx(i, j, k)] || isBase(i, j, k + 1)) continue;
        for (const [di, dj] of [[0, -1], [1, 0]]) {
          if (isBase(i + di, j + dj, k) || random() >= o.lipChance) continue;
          const len = 1 + Math.floor(random() * o.lip);
          for (let s = 0; s < len; s++) {
            const a = i + di, b = j + dj, c = k - s;
            if (!inside(a, b, c) || isBase(a, b, c)) break;
            if (!grid[idx(a, b, c)]) grid[idx(a, b, c)] = W_UP + 1;
          }
        }
      }
    }

    return {
      R, D, grid, nx, ny, nz, iLo, jLo, kLo, iHi, jHi, kHi, vx, vz, tf, uvAt, isBase,
      solid,
      levels,
    };
  }

  /** World point -> sprite pixel coordinates (x right, y down), a full block centred in an S × S sprite. */
  function project(p, S, H) {
    const c = [p[0], p[1], p[2] - H / 2];
    const s = Math.SQRT2 / S;
    return [dot(c, RIGHT) / s + S / 2, -dot(c, UP) / s + S / 2];
  }

  // ── Ray casting ──────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Walks a ray through the voxel grid (Amanatides & Woo). Returns { t, owner, axis, sign, i, j, k } for the first
   * solid voxel within maxT, or null. axis/sign give the side that was entered, i.e. the hit face's normal is
   * -sign along axis.
   */
  function march(V, origin, dir, maxT) {
    const size = [V.vx, V.vx, V.vz];
    const lo = [V.iLo, V.jLo, V.kLo];
    const hi = [V.iHi, V.jHi, V.kHi];
    const minW = [-0.5 + V.iLo * V.vx, -0.5 + V.jLo * V.vx, V.kLo * V.vz];
    const maxW = [-0.5 + V.iHi * V.vx, -0.5 + V.jHi * V.vx, V.kHi * V.vz];
    // Clip the ray to the grid's box.
    let t0 = 0, t1 = maxT, enterAxis = -1;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dir[a]) < 1e-12) {
        if (origin[a] < minW[a] || origin[a] > maxW[a]) return null;
        continue;
      }
      let ta = (minW[a] - origin[a]) / dir[a];
      let tb = (maxW[a] - origin[a]) / dir[a];
      if (ta > tb) [ta, tb] = [tb, ta];
      if (ta > t0) { t0 = ta; enterAxis = a; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    }
    const p = [origin[0] + dir[0] * (t0 + 1e-9), origin[1] + dir[1] * (t0 + 1e-9), origin[2] + dir[2] * (t0 + 1e-9)];
    const cell = [0, 0, 0], step = [0, 0, 0], tMax = [0, 0, 0], tDelta = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const rel = (p[a] - minW[a]) / size[a];
      cell[a] = Math.min(hi[a] - lo[a] - 1, Math.max(0, Math.floor(rel))) + lo[a];
      step[a] = dir[a] > 0 ? 1 : dir[a] < 0 ? -1 : 0;
      const boundary = minW[a] + (cell[a] - lo[a] + (step[a] > 0 ? 1 : 0)) * size[a];
      tMax[a] = step[a] === 0 ? Infinity : t0 + (boundary - p[a]) / dir[a];
      tDelta[a] = step[a] === 0 ? Infinity : size[a] / Math.abs(dir[a]);
    }
    let axis = enterAxis, t = t0;
    for (;;) {
      const owner = V.solid(cell[0], cell[1], cell[2]);
      if (owner) {
        return { t, owner, axis: axis < 0 ? 2 : axis, sign: axis < 0 ? Math.sign(dir[2]) || -1 : step[axis],
          i: cell[0], j: cell[1], k: cell[2] };
      }
      axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      t = tMax[axis];
      if (t > t1) return null;
      cell[axis] += step[axis];
      if (cell[axis] < lo[axis] || cell[axis] >= hi[axis]) return null;
      tMax[axis] += tDelta[axis];
    }
  }

  // Fixed cosine-weighted hemisphere directions around +Z (Fibonacci spiral), turned to each normal. Fixed rather than
  // random, so the AO never flickers between renders.
  function hemisphere(n) {
    const dirs = [];
    for (let s = 0; s < n; s++) {
      const r = Math.sqrt((s + 0.5) / n);
      const a = s * 2.399963;
      dirs.push([r * Math.cos(a), r * Math.sin(a), Math.sqrt(Math.max(0, 1 - r * r))]);
    }
    return dirs;
  }

  function orient(d, n) {
    // Basis with n as its Z.
    const t = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const bx = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
    const len = Math.hypot(bx[0], bx[1], bx[2]);
    bx[0] /= len; bx[1] /= len; bx[2] /= len;
    const by = [n[1] * bx[2] - n[2] * bx[1], n[2] * bx[0] - n[0] * bx[2], n[0] * bx[1] - n[1] * bx[0]];
    return [bx[0] * d[0] + by[0] * d[1] + n[0] * d[2], bx[1] * d[0] + by[1] * d[1] + n[1] * d[2],
      bx[2] * d[0] + by[2] * d[1] + n[2] * d[2]];
  }

  // ── Render ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Renders one piece. tex: { top, left, right } from faceTexture(); piece: { boxes, state, facing } (a cube when
   * left out). Returns S × S RGBA arrays: color, normal (_n encoding), depth (white = near), ao (white = open), gray
   * (light and AO without the texture's colour), plus mask (1 where the piece is).
   */
  function render(opts, tex, piece = CUBE) {
    const o = merge(opts);
    const S = o.size, H = o.blockHeight;
    const V = buildVoxels(o, tex, piece);
    const s = Math.SQRT2 / S;
    const centre = [0, 0, H / 2];
    const far = 4;
    const n = S * S;
    const color = new Uint8ClampedArray(n * 4), normal = new Uint8ClampedArray(n * 4);
    const depth = new Uint8ClampedArray(n * 4), aoMap = new Uint8ClampedArray(n * 4), gray = new Uint8ClampedArray(n * 4);
    const mask = new Uint8Array(n);
    const faceN = new Int8Array(n);      // which visible face each pixel shows, for the pixel-art passes
    const zbuf = new Float32Array(n).fill(-Infinity);  // dot(p, BACK): larger is nearer, for the hair pass
    const hemi = hemisphere(Math.max(1, o.aoSamples));
    const aoDist = o.aoDistance;

    // Depth range: the grid's corners along the view direction (the same for every piece, so depth maps line up).
    let dMin = Infinity, dMax = -Infinity;
    for (const x of [-0.5 + V.iLo * V.vx, -0.5 + V.iHi * V.vx]) for (const y of [-0.5 + V.jLo * V.vx, -0.5 + V.jHi * V.vx]) {
      for (const z of [0, V.kHi * V.vz]) {
        const d = dot([x, y, z], BACK);
        dMin = Math.min(dMin, d); dMax = Math.max(dMax, d);
      }
    }
    const depthByte = (d) => Math.round(255 * clamp01((d - dMin) / Math.max(1e-6, dMax - dMin)));
    const shadeOf = (face) => (o.shading ? (face === FACE.TOP ? o.shade.top : face === FACE.LEFT ? o.shade.left : o.shade.right) : 1);
    const quantAO = (ao) => (o.aoSteps > 1 && o.aoStrength > 0
      ? 1 - Math.round((1 - ao) * (o.aoSteps - 1) / o.aoStrength) * o.aoStrength / (o.aoSteps - 1) : ao);

    const put = (k, texel, face, ao, d) => {
      const shade = shadeOf(face);
      color[k] = texel[0] * shade * ao;
      color[k + 1] = texel[1] * shade * ao;
      color[k + 2] = texel[2] * shade * ao;
      color[k + 3] = 255;
      // Voxel faces only ever point along the three visible axes: write the exact colours the Aura Iso Normals
      // extension uses for them, so these maps match the hand-made ones bit for bit.
      const enc = FACE_NORMAL_RGB[face];
      normal[k] = enc[0]; normal[k + 1] = enc[1]; normal[k + 2] = enc[2]; normal[k + 3] = 255;
      depth[k] = depth[k + 1] = depth[k + 2] = depthByte(d); depth[k + 3] = 255;
      aoMap[k] = aoMap[k + 1] = aoMap[k + 2] = Math.round(255 * ao); aoMap[k + 3] = 255;
      const base = o.grayFromTexture ? (0.2126 * texel[0] + 0.7152 * texel[1] + 0.0722 * texel[2]) / 255 : 1;
      gray[k] = gray[k + 1] = gray[k + 2] = Math.round(255 * base * shade * ao); gray[k + 3] = 255;
    };

    for (let py = 0; py < S; py++) {
      for (let px = 0; px < S; px++) {
        const ox = (px + 0.5 - S / 2) * s, oy = (py + 0.5 - S / 2) * s;
        const origin = [
          centre[0] + RIGHT[0] * ox - UP[0] * oy - FWD[0] * far,
          centre[1] + RIGHT[1] * ox - UP[1] * oy - FWD[1] * far,
          centre[2] + RIGHT[2] * ox - UP[2] * oy - FWD[2] * far,
        ];
        const hit = march(V, origin, FWD, far * 2);
        if (!hit) continue;
        const p = [origin[0] + FWD[0] * hit.t, origin[1] + FWD[1] * hit.t, origin[2] + FWD[2] * hit.t];
        const nrm = [0, 0, 0];
        nrm[hit.axis] = -hit.sign;
        const hitDir = hit.axis * 2 + (nrm[hit.axis] > 0 ? 0 : 1);
        const visible = DIR_FACE[hitDir] ?? FACE.TOP;
        // The surface whose texture colours this voxel: its owner, or the side that was hit.
        const ownerDir = hit.owner > 0 && hit.owner < 255 ? hit.owner - 1 : hitDir;
        // A step's wall shows the lower pixel's colour (the neighbour on the open side of the wall): with the taller
        // pixel's colour, one-pixel grooves vanished from this angle. Faces that point the owner's way sample in place.
        const ownerAxis = ownerDir >> 1;
        const q = hit.axis === ownerAxis ? p : [p[0] + nrm[0] * V.vx * 0.5, p[1] + nrm[1] * V.vx * 0.5, p[2] + nrm[2] * V.vz * 0.5];
        const [name, u, v] = V.uvAt([q[0] + 0.5, q[1] + 0.5, q[2] / H], ownerDir);
        const texel = tex[name].color(u, v);
        if (texel[3] < 8) continue;

        let ao = 1;
        if (o.ao && o.aoStrength > 0) {
          const start = [p[0] + nrm[0] * 1e-4, p[1] + nrm[1] * 1e-4, p[2] + nrm[2] * 1e-4];
          let blocked = 0;
          for (const d of hemi) {
            if (march(V, start, orient(d, nrm), aoDist)) blocked++;
          }
          ao = quantAO(1 - o.aoStrength * (blocked / hemi.length));
        }
        const i = py * S + px;
        put(i * 4, texel, visible, ao, dot(p, BACK));
        mask[i] = 1;
        faceN[i] = visible;
        zbuf[i] = dot(p, BACK);
      }
    }

    pixelArtPasses(o, S, color, mask, faceN);

    // Hairs go on after the pixel-art passes: lone-pixel cleanup would eat one-pixel strands.
    if (o.hair.enabled && Aura.blockHair) {
      Aura.blockHair.draw({ o, V, tex, S, H, zbuf, mask, faceN, put, project, BACK, FACE, quantAO, rng });
    }
    return { size: S, color, normal, depth, ao: aoMap, gray, mask, voxels: V, options: o };
  }

  // ── Pixel-art passes ─────────────────────────────────────────────────────────────────────────────────────────────

  function pixelArtPasses(o, S, color, mask, faceN) {
    const at = (x, y) => (x < 0 || y < 0 || x >= S || y >= S ? -1 : y * S + x);
    // Rim light: top-face pixels with nothing (or another face) right above them catch the light, like the bright edge
    // hand-drawn tiles give their top.
    if (o.edgeLight > 0) {
      const lit = [];
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (faceN[i] !== FACE.TOP) continue;
        const up = at(x, y - 1);
        if (up < 0 || !mask[up] || faceN[up] !== FACE.TOP) lit.push(i);
      }
      for (const i of lit) for (let c = 0; c < 3; c++) color[i * 4 + c] = Math.min(255, color[i * 4 + c] * (1 + o.edgeLight));
    }
    // Inner outline: pixels on the silhouette, darkened.
    if (o.outline > 0) {
      const edge = [];
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (!mask[i]) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = at(x + dx, y + dy);
          if (j < 0 || !mask[j]) { edge.push(i); break; }
        }
      }
      for (const i of edge) for (let c = 0; c < 3; c++) color[i * 4 + c] *= 1 - o.outline;
    }
    // Lone pixels: one pixel whose four neighbours all share another colour takes theirs.
    if (o.cleanup) {
      const copy = color.slice();
      for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
        const i = y * S + x;
        if (!mask[i]) continue;
        const ns = [i - 1, i + 1, i - S, i + S];
        if (!ns.every((j) => mask[j] && faceN[j] === faceN[i])) continue;
        const same = (a, b) => copy[a * 4] === copy[b * 4] && copy[a * 4 + 1] === copy[b * 4 + 1] && copy[a * 4 + 2] === copy[b * 4 + 2];
        if (ns.every((j) => same(j, ns[0])) && !same(i, ns[0])) {
          for (let c = 0; c < 3; c++) color[i * 4 + c] = copy[ns[0] * 4 + c];
        }
      }
    }
  }

  /** Nearest-neighbour upscale of an RGBA image, for exports bigger than the sprite. */
  function upscale(rgba, size, factor) {
    const W = size * factor;
    const out = new Uint8ClampedArray(W * W * 4);
    for (let y = 0; y < W; y++) {
      const sy = Math.floor(y / factor);
      for (let x = 0; x < W; x++) {
        const si = (sy * size + Math.floor(x / factor)) * 4;
        const di = (y * W + x) * 4;
        out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
      }
    }
    return out;
  }

  Aura.blockEngine = { DEFAULTS, HAIR_DEFAULTS, BLOCK_HEIGHT, FACE, CUBE, faceTexture, render, project, upscale, merge };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
