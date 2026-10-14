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

  // Procedural edge masks: the faces of the piece carry on past some of their edges in a ragged outline (fibres on a
  // log, grass over a dirt block, roots under a slab), painted with the same texture so there is no seam.
  const MASK_DEFAULTS = {
    enabled: true,
    zones: { backLeft: true, backRight: true, frontLeft: false, frontRight: false, bottomLeft: true, bottomRight: true },
    length: 3,                  // longest tongue, in voxels
    density: 0.55,              // share of the edge that sticks out
    variation: 0.7,             // 0 = every tongue full length, 1 = from one voxel to full length
    style: "spikes",            // "spikes": one-voxel fibres; "waves": a smooth ragged edge; "blocks": square teeth
    width: 1,                   // voxels per tongue (spikes / blocks) or per wave
    seed: 7,
  };

  // Cover: the top's texture running over the top edge and down the side faces to a ragged line (snow on dirt, grass
  // over a cliff), painted as if the top carried on bent over the edge, so it joins the top with no seam.
  const COVER_DEFAULTS = {
    enabled: false,
    left: true, right: true,    // which side faces it runs down
    depth: 5,                   // voxels down from the top edge, before the ragged part
    ragged: 5,                  // extra voxels the ragged line reaches below the depth
    style: "waves",             // "waves", "spikes" or "blocks", as the edge masks
    width: 2,
    density: 0.75,
    variation: 0.6,
    thickness: 0,               // voxels it stands out of the side (0 = painted on, 1–2 = a layer with volume)
    seed: 11,
  };

  const DEFAULTS = {
    size: 64,                   // sprite width and height, px; a full block always fills it
    res: 32,                    // voxels per block edge: 32 = one voxel per 2 px of a 64 px sprite, 64 = one per pixel
    blockHeight: BLOCK_HEIGHT,
    mask: MASK_DEFAULTS,
    cover: COVER_DEFAULTS,
    autoFit: true,              // shorten tongues and hairs that would leave the sprite
    texMode: "auto",            // "follow": textures turn with the piece; "world": top texture always on top; "auto"
    uvMode: "world",            // "world": a slab shows half the side texture; "fit": the texture is squeezed onto it
    chips: 0,                   // 0..1 chance that a voxel on an edge of the piece is chipped away
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
    o.shade = { ...DEFAULTS.shade, ...(opts.shade || {}) };
    o.mask = { ...MASK_DEFAULTS, ...(opts.mask || {}) };
    o.mask.zones = { ...MASK_DEFAULTS.zones, ...(opts.mask?.zones || {}) };
    o.cover = { ...COVER_DEFAULTS, ...(opts.cover || {}) };
    o.hair = { ...HAIR_DEFAULTS, ...(opts.hair || {}) };
    o.hair.edges = { ...HAIR_DEFAULTS.edges, ...(opts.hair?.edges || {}) };
    return o;
  }

  const CUBE = { boxes: [{ min: [0, 0, 0], max: [1, 1, 1] }], state: "default", facing: "front" };

  // Texture coordinates past a face's edge wrap around: atlas textures tile, so a tongue or a hair that carries on
  // past the edge keeps the pattern going instead of smearing the edge texel.
  const wrap01 = (x) => (x >= 0 && x <= 1 ? Math.min(x, 1 - 1e-6) : x - Math.floor(x));

  // ── Edge mask profiles ───────────────────────────────────────────────────────────────────────────────────────────

  function hash(a, b, c, d) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647) ^ Math.imul(d | 0, 1103515245);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /** Length (voxels) of the tongue at position t along one edge line. zone and line keep different edges unrelated. */
  function profile(m, zone, line, t) {
    const L = Math.max(0, Math.round(m.length));
    if (!L) return 0;
    const w = Math.max(1, Math.round(m.width));
    if (m.style === "waves") {
      // Smooth value noise along the edge, cut at the density so the gaps are part of the wave.
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
   */
  function buildVoxels(o, tex, piece) {
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

    // The piece itself.
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
    for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      if (base[bIdx(i, j, k)]) grid[idx(i, j, k)] = 255;
    }

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
    /** World unit point + world direction of the surface → [texture name, u, v], wrapped past the face's edges. */
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
        const [px, py] = project([-0.5 + (i + dx) * vx, -0.5 + (j + dy) * vx, (k + dz) * vz], S, H);
        if (px < -1e-6 || px > S + 1e-6 || py < -1e-6 || py > S + 1e-6) return false;
      }
      return true;
    };

    const random = rng(o.seed);
    const solidNow = (i, j, k) => (inside(i, j, k) ? grid[idx(i, j, k)] : 0);

    // Chipped edges: piece voxels with two open sides (the bottom does not count) are knocked off now and then.
    if (o.chips > 0) {
      const chip = [];
      for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
        if (!base[bIdx(i, j, k)]) continue;
        let open = 0;
        for (let wd = 0; wd < 5; wd++) {
          const d = DIRS[wd];
          if (!isBase(i + d[0], j + d[1], k + d[2])) open++;
        }
        if (open >= 2 && random() < o.chips) chip.push(idx(i, j, k));
      }
      for (const c of chip) grid[c] = 0;
    }

    // Edge masks. Each zone: the two open sides that make the edge, which texture carries on (world direction of its
    // face), how the tongue grows, and the axis the edge runs along (for the profile). Back and bottom tongues are the
    // face itself carrying on in its own plane; front tongues fold over the edge and hang down the side face.
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
          if (z.open.some((wd) => isBase(i + DIRS[wd][0], j + DIRS[wd][1], k + DIRS[wd][2]))) continue;
          const cell = [i, j, k];
          const line = z.along === 0 ? j * 4096 + k : i * 4096 + k;
          const len = profile(m, zi + 1, line, cell[z.along]);
          for (let s = 0; s < len; s++) {
            // Back and bottom tongues are the face carrying on in its own plane; front ones fold over the top's edge
            // and hang just outside the side face, one voxel lower per step.
            const a = z.fold ? i + z.fold[0] : i + z.step[0] * (s + 1);
            const b = z.fold ? j + z.fold[1] : j + z.step[1] * (s + 1);
            const c = z.fold ? k - s : k + z.step[2] * (s + 1);
            if (!inside(a, b, c) || isBase(a, b, c) || !spriteFits(a, b, c)) break;
            if (!grid[idx(a, b, c)]) grid[idx(a, b, c)] = zi + 1;
          }
        }
      });
    }

    // Cover. coverTop(i, j, k, wd): for a voxel on a side face (wd = left or right), the k of the top edge it hangs
    // under when it lies in the covered band, else -1. A side whose column is capped by more of the piece (a face
    // under an overhang) has no top edge there, so nothing runs down it.
    const cv = o.cover;
    const coverRagged = { ...cv, length: cv.ragged };
    const coverTop = (i, j, k, wd) => {
      if (!cv.enabled || (wd === W_LEFT ? !cv.left : wd === W_RIGHT ? !cv.right : true)) return -1;
      const d = DIRS[wd];
      let kk = k;
      while (isBase(i, j, kk + 1) && !isBase(i + d[0], j + d[1], kk + 1)) kk++;
      if (isBase(i, j, kk + 1)) return -1;
      const t = wd === W_LEFT ? i : j, line = wd === W_LEFT ? j : i;
      const reach = Math.round(cv.depth) + profile(coverRagged, wd === W_LEFT ? 21 : 22, line, t);
      return kk - k < reach ? kk : -1;
    };
    if (cv.enabled && cv.thickness > 0) {
      // A layer with volume: voxels in front of the covered band, marked as front tongues so they unfold the same way.
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
      solid: solidNow,
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
      for (const z of [V.kLo * V.vz, V.kHi * V.vz]) {
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
        // The piece's own faces always show their own texture, right up to the edge. A mask voxel shows the texture of
        // the face it carries on, at the point that face would have there (wrapped), so the tongue has no seam.
        const zone = hit.owner !== 255 ? V.zones[hit.owner - 1] : null;
        const ownerDir = zone ? zone.owner : hitDir;
        let unit = [p[0] + 0.5, p[1] + 0.5, p[2] / H];
        if (zone?.fold) {
          // A front tongue hangs from the top's edge: unfold it back onto the top's plane, the drop becoming distance
          // past the edge, so the top's pattern runs over the edge and down without a break.
          let kt = hit.k;
          while (V.solid(hit.i, hit.j, kt + 1) === hit.owner) kt++;
          const topZ = (kt + 1) * V.vz, drop = topZ - p[2];
          unit = zone.fold[1] < 0
            ? [p[0] + 0.5, (hit.j + 1) * V.vx - drop, topZ / H]
            : [hit.i * V.vx + drop, p[1] + 0.5, topZ / H];
        }
        let texDir = ownerDir;
        if (!zone && (hitDir === W_LEFT || hitDir === W_RIGHT)) {
          // Covered band of a side face: the top's texture bent over the edge, the same unfolding as a front tongue.
          const kt = V.coverTop(hit.i, hit.j, hit.k, hitDir);
          if (kt >= 0) {
            const topZ = (kt + 1) * V.vz, drop = topZ - p[2];
            texDir = W_UP;
            unit = hitDir === W_LEFT
              ? [p[0] + 0.5, hit.j * V.vx - drop, topZ / H]
              : [(hit.i + 1) * V.vx + drop, p[1] + 0.5, topZ / H];
          }
        }
        const [name, u, v] = V.uvAt(unit, texDir);
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

  Aura.blockEngine = { DEFAULTS, HAIR_DEFAULTS, MASK_DEFAULTS, COVER_DEFAULTS, BLOCK_HEIGHT, FACE, CUBE, faceTexture, render, project, upscale, merge };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
