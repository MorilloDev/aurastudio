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
  //
  // The free rotation the tool offers is a *camera orbit*: the piece stays axis-aligned in world space (the voxel
  // grid and the ray marcher do not care about the camera), and the four basis vectors below are rotated by the
  // inverse of the requested rotation. A point q of the piece therefore appears in the sprite at (q · RIGHT', q · UP'),
  // which is the same as (R q · RIGHT, R q · UP): rotating the camera by R⁻¹ is the same as rotating the piece by R.
  // The ORDER of the Euler angles is Rz · Ry · Rx (pitch, then yaw, then roll), right-handed around the world axes.
  const RIGHT0 = [Math.SQRT1_2, Math.SQRT1_2, 0];
  const UP0 = [-0.3535534, 0.3535534, 0.8660254];
  const FWD0 = [-0.6123724, 0.6123724, -0.5];
  const BACK0 = [-FWD0[0], -FWD0[1], -FWD0[2]];
  const BASE_CAMERA = { RIGHT: RIGHT0, UP: UP0, FWD: FWD0, BACK: BACK0, identity: true };

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
  const deg2rad = (d) => (d * Math.PI) / 180;

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

  /** Camera basis after rotating the *piece* by rotation {x, y, z} (degrees). Identity when all angles are 0. */
  function cameraBasis(rot) {
    if (!rot || (!rot.x && !rot.y && !rot.z)) return BASE_CAMERA;
    const cx = Math.cos(deg2rad(rot.x)), sx = Math.sin(deg2rad(rot.x));
    const cy = Math.cos(deg2rad(rot.y)), sy = Math.sin(deg2rad(rot.y));
    const cz = Math.cos(deg2rad(rot.z)), sz = Math.sin(deg2rad(rot.z));
    // R = Rz · Ry · Rx (rows are the images of the basis vectors).
    const R = [
      [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
      [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
      [-sy, cy * sx, cy * cx],
    ];
    // Each basis vector b of the sprite becomes Rᵀ b: (R q) · b = q · (Rᵀ b).
    const applyT = (b) => [
      R[0][0] * b[0] + R[1][0] * b[1] + R[2][0] * b[2],
      R[0][1] * b[0] + R[1][1] * b[1] + R[2][1] * b[2],
      R[0][2] * b[0] + R[1][2] * b[1] + R[2][2] * b[2],
    ];
    return { RIGHT: applyT(RIGHT0), UP: applyT(UP0), FWD: applyT(FWD0), BACK: applyT(BACK0), identity: false };
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
    tipShade: 0,                // tip darker (< 0) or lighter (> 0); 0 keeps the texture's own colours
    seed: 3,
  };

  const MASK_DEFAULTS = {
    enabled: true,
    zones: { backLeft: true, backRight: true, frontLeft: false, frontRight: false, bottomLeft: true, bottomRight: true },
    length: 3,
    density: 0.55,
    variation: 0.7,
    style: "spikes",
    width: 1,
    seed: 7,
  };

  const COVER_DEFAULTS = {
    enabled: false,
    left: true, right: true,
    depth: 5,
    ragged: 5,
    style: "waves",
    width: 2,
    density: 0.75,
    variation: 0.6,
    thickness: 0,
    seed: 11,
  };

  const DEFAULTS = {
    size: 64,
    res: 32,
    blockHeight: BLOCK_HEIGHT,
    rotation: { x: 0, y: 0, z: 0 },   // free camera orbit, in degrees
    mask: MASK_DEFAULTS,
    cover: COVER_DEFAULTS,
    autoFit: true,
    texMode: "auto",
    uvMode: "world",
    chips: 0,
    seed: 1,
    shading: true,
    shade: { top: 1, left: 0.75, right: 0.55 },
    ao: true,
    aoDistance: 0.25,
    aoStrength: 0.6,
    aoSamples: 16,
    aoSteps: 4,
    grayFromTexture: false,
    edgeLight: 0.12,
    outline: 0,
    cleanup: true,
    hair: HAIR_DEFAULTS,
  };

  function merge(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    o.shade = { ...DEFAULTS.shade, ...(opts.shade || {}) };
    o.mask = { ...MASK_DEFAULTS, ...(opts.mask || {}) };
    o.mask.zones = { ...MASK_DEFAULTS.zones, ...(opts.mask?.zones || {}) };
    o.cover = { ...COVER_DEFAULTS, ...(opts.cover || {}) };
    o.hair = { ...HAIR_DEFAULTS, ...(opts.hair || {}) };
    o.hair.edges = { ...HAIR_DEFAULTS.edges, ...(opts.hair?.edges || {}) };
    o.rotation = { ...DEFAULTS.rotation, ...(opts.rotation || {}) };
    return o;
  }

  const CUBE = { boxes: [{ min: [0, 0, 0], max: [1, 1, 1] }], state: "default", facing: "front" };

  const wrap01 = (x) => (x >= 0 && x <= 1 ? Math.min(x, 1 - 1e-6) : x - Math.floor(x));

  // ── Edge mask profiles ───────────────────────────────────────────────────────────────────────────────────────────

  function hash(a, b, c, d) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647) ^ Math.imul(d | 0, 1103515245);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function profile(m, zone, line, t) {
    const L = Math.max(0, Math.round(m.length));
    if (!L) return 0;
    const w = Math.max(1, Math.round(m.width));
    if (m.style === "waves") {
      const x = t / (w * 3), x0 = Math.floor(x), f = x - x0, s = f * f * (3 - 2 * f);
      const n = hash(zone, line, x0, m.seed) * (1 - s) + hash(zone, line, x0 + 1, m.seed) * s;
      const v = clamp01((n - (1 - m.density)) / Math.max(0.05, m.density));
      return Math.round(L * Math.pow(v, 0.8));
    }
    const group = Math.floor(t / (m.style === "blocks" ? w * 2 : w));
    if (hash(zone, line, group, m.seed) >= m.density) return 0;
    const k = 1 - m.variation * hash(zone, line, group, m.seed + 911);
    return Math.max(1, Math.round(L * k));
  }

  // ── Voxels ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The piece as a voxel grid. Cell voxels are i, j, k in 0..res-1 (x, y, z, z up); the edge masks spill past the cell
   * by up to their length on every side. Grid values: 0 empty, 255 the piece itself (coloured by whichever of its
   * faces is seen), 1..254 a mask voxel, whose record in V.ext says which texture it carries on.
   * `basis` is used only by spriteFits, which projects a candidate voxel with the current camera.
   */
  function buildVoxels(o, tex, piece, basis) {
    const R = o.res;
    const m = o.mask;
    const pad = m.enabled ? Math.max(1, Math.round(m.length)) + 1 : 1;
    const iLo = -pad, iHi = R + pad, jLo = -pad, jHi = R + pad, kLo = -pad, kHi = R + pad;
    const nx = iHi - iLo, ny = jHi - jLo, nz = kHi - kLo;
    const grid = new Uint8Array(nx * ny * nz);
    const idx = (i, j, k) => ((k - kLo) * ny + (j - jLo)) * nx + (i - iLo);
    const inside = (i, j, k) => i >= iLo && i < iHi && j >= jLo && j < jHi && k >= kLo && k < kHi;
    const vx = 1 / R, vz = o.blockHeight / R;

    const follow = o.texMode === "follow" || (o.texMode === "auto" && piece.state === "horizontal");
    const tf = Shapes.transform(piece.state, piece.facing, follow);
    const worldBoxes = Shapes.boxesToWorld(piece.boxes, tf);

    const base = new Uint8Array(R * R * R);
    const partOf = new Uint8Array(R * R * R);
    const bIdx = (i, j, k) => (k * R + j) * R + i;
    const inCell = (i, j, k) => i >= 0 && i < R && j >= 0 && j < R && k >= 0 && k < R;
    const parts = piece.boxes.map((b, pi) => slopePart(b, tf, o.blockHeight));
    piece.boxes.forEach((b, pi) => {
      const lo = worldBoxes[pi].min.map((v) => Math.round(v * R)), hi = worldBoxes[pi].max.map((v) => Math.round(v * R));
      const sloped = !!b.cuts?.length;
      for (let k = lo[2]; k < hi[2]; k++) for (let j = lo[1]; j < hi[1]; j++) for (let i = lo[0]; i < hi[0]; i++) {
        if (!inCell(i, j, k)) continue;
        if (sloped && !touchesPart(b, tf, i, j, k, R)) continue;
        const n = bIdx(i, j, k);
        if (!base[n] || !sloped) partOf[n] = pi + 1;
        base[n] = 1;
      }
    });
    const isBase = (i, j, k) => inCell(i, j, k) && base[bIdx(i, j, k)] === 1;
    const isSloped = (i, j, k) => inCell(i, j, k) && !!parts[partOf[bIdx(i, j, k)] - 1];
    for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      if (base[bIdx(i, j, k)]) grid[idx(i, j, k)] = 255;
    }

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
    const uvAt = (up, wd) => {
      let lp = tf.texLocal(up);
      if (o.uvMode === "fit") lp = lp.map((v, a) => (v - fitLo[a]) / Math.max(1e-6, fitHi[a] - fitLo[a]));
      const [name, u, v] = localUV(lp, tf.texDir(wd));
      return [name, wrap01(u), wrap01(v)];
    };

    const spriteFits = (i, j, k) => {
      if (!o.autoFit) return true;
      const S = o.size, H = o.blockHeight;
      for (const dx of [0, 1]) for (const dy of [0, 1]) for (const dz of [0, 1]) {
        const [px, py] = project([-0.5 + (i + dx) * vx, -0.5 + (j + dy) * vx, (k + dz) * vz], S, H, basis);
        if (px < -1e-6 || px > S + 1e-6 || py < -1e-6 || py > S + 1e-6) return false;
      }
      return true;
    };

    const random = rng(o.seed);
    const solidNow = (i, j, k) => (inside(i, j, k) ? grid[idx(i, j, k)] : 0);

    if (o.chips > 0) {
      const chip = [];
      for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
        if (!base[bIdx(i, j, k)] || isSloped(i, j, k)) continue;
        let open = 0;
        for (let wd = 0; wd < 5; wd++) {
          const d = DIRS[wd];
          if (!isBase(i + d[0], j + d[1], k + d[2])) open++;
        }
        if (open >= 2 && random() < o.chips) chip.push(idx(i, j, k));
      }
      for (const c of chip) grid[c] = 0;
    }

    const ZONES = [
      { key: "backLeft", open: [4, 1], owner: W_UP, step: [-1, 0, 0], along: 1 },
      { key: "backRight", open: [4, 2], owner: W_UP, step: [0, 1, 0], along: 0 },
      { key: "frontLeft", open: [4, 3], owner: W_UP, fold: [0, -1, 0], along: 0 },
      { key: "frontRight", open: [4, 0], owner: W_UP, fold: [1, 0, 0], along: 1 },
      { key: "bottomLeft", open: [3, 5], owner: W_LEFT, step: [0, 0, -1], along: 0 },
      { key: "bottomRight", open: [0, 5], owner: W_RIGHT, step: [0, 0, -1], along: 1 },
    ];
    if (m.enabled && m.length > 0) {
      ZONES.forEach((z, zi) => {
        if (!m.zones[z.key]) return;
        for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
          if (!isBase(i, j, k) || !solidNow(i, j, k)) continue;
          if (z.open.includes(W_UP) && isSloped(i, j, k)) continue;
          if (z.open.some((wd) => isBase(i + DIRS[wd][0], j + DIRS[wd][1], k + DIRS[wd][2]))) continue;
          const cell = [i, j, k];
          const line = z.along === 0 ? j * 4096 + k : i * 4096 + k;
          const len = profile(m, zi + 1, line, cell[z.along]);
          for (let s = 0; s < len; s++) {
            const a = z.fold ? i + z.fold[0] : i + z.step[0] * (s + 1);
            const b = z.fold ? j + z.fold[1] : j + z.step[1] * (s + 1);
            const c = z.fold ? k - s : k + z.step[2] * (s + 1);
            if (!inside(a, b, c) || isBase(a, b, c) || !spriteFits(a, b, c)) break;
            if (!grid[idx(a, b, c)]) grid[idx(a, b, c)] = zi + 1;
          }
        }
      });
    }

    const cv = o.cover;
    const coverRagged = { ...cv, length: cv.ragged };
    const coverTop = (i, j, k, wd) => {
      if (!cv.enabled || (wd === W_LEFT ? !cv.left : wd === W_RIGHT ? !cv.right : true)) return -1;
      const d = DIRS[wd];
      let kk = k;
      while (isBase(i, j, kk + 1) && !isBase(i + d[0], j + d[1], kk + 1)) kk++;
      if (isBase(i, j, kk + 1) || isSloped(i, j, kk)) return -1;
      const t = wd === W_LEFT ? i : j, line = wd === W_LEFT ? j : i;
      const reach = Math.round(cv.depth) + profile(coverRagged, wd === W_LEFT ? 21 : 22, line, t);
      return kk - k < reach ? kk : -1;
    };
    if (cv.enabled && cv.thickness > 0) {
      for (const [wd, zone] of [[W_LEFT, 3], [W_RIGHT, 4]]) {
        const d = DIRS[wd];
        for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
          if (!isBase(i, j, k) || !solidNow(i, j, k) || isBase(i + d[0], j + d[1], k)) continue;
          if (coverTop(i, j, k, wd) < 0) continue;
          for (let s = 1; s <= Math.round(cv.thickness); s++) {
            const a = i + d[0] * s, b = j + d[1] * s;
            if (!inside(a, b, k) || !spriteFits(a, b, k)) break;
            if (!grid[idx(a, b, k)]) grid[idx(a, b, k)] = zone;
          }
        }
      }
    }

    return {
      R, grid, nx, ny, nz, iLo, jLo, kLo, iHi, jHi, kHi, vx, vz, tf, uvAt, isBase, zones: ZONES, coverTop,
      part: (i, j, k) => (inCell(i, j, k) ? parts[partOf[bIdx(i, j, k)] - 1] ?? null : null),
      slopeParts: parts.filter(Boolean), isSloped,
      solid: solidNow,
    };
  }

  // ── Slopes ───────────────────────────────────────────────────────────────────────────────────────────────────────

  function inPart(b, lp, eps = 1e-6) {
    for (let a = 0; a < 3; a++) if (lp[a] < b
