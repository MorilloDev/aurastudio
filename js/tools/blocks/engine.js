"use strict";

// Block generator engine: builds a block out of voxels from the textures of its faces and renders it with the game's
// camera into a sprite, with its normal map, depth, ambient occlusion and a grayscale pass. No DOM, no canvas: plain
// arrays in, plain arrays out, so the same code runs in the page, in a worker or under Node for tests.
(function (Aura) {
  // ── Camera ───────────────────────────────────────────────────────────────────────────────────────────────────────
  // Blender camera rotation (60°, 0°, 45°), orthographic. These are its right / up / forward axes in world space; the
  // normal map stores a normal as (n·right, n·up, n·back), which is what NormalMapLoader decodes (top = #80EEBF…).
  const RIGHT = [Math.SQRT1_2, Math.SQRT1_2, 0];
  const UP = [-0.3535534, 0.3535534, 0.8660254];
  const FWD = [-0.6123724, 0.6123724, -0.5];
  const BACK = [-FWD[0], -FWD[1], -FWD[2]];

  // √(2/3): the block height that makes a 1 × 1 block fill a square sprite (32 px diamond over 32 px sides at 64).
  const BLOCK_HEIGHT = 0.8164966;

  // Faces the camera can see, by the outward normal of the voxel side that was hit. The block's -X, +Y and bottom sides
  // never face this camera.
  const FACE = { TOP: 1, LEFT: 2, RIGHT: 3 };

  // #80EEBF, #2553CE, #DA53CE — see NormalMapLoader.FaceTop / FaceLeft / FaceRight in the game.
  const FACE_NORMAL_RGB = { 1: [128, 238, 191], 2: [37, 83, 206], 3: [218, 83, 206] };

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

  /** Small deterministic random generator (mulberry32), so a seed always gives the same chips and lips. */
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
   * the face. sample(u, v) takes face coordinates 0..1 (u to the right as seen from outside, v up) and returns the
   * texel's index into rgba, after the face's rotation (0/90/180/270) and mirror.
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

  // ── Defaults ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const DEFAULTS = {
    size: 64,                   // sprite width and height, px; the block always fills it
    res: 32,                    // relief voxels per block edge
    blockHeight: BLOCK_HEIGHT,
    relief: "out",              // "out": bright texels rise off the block; "in": dark texels are carved in; "none"
    source: "luma",             // height from "luma" (brightness) or "alpha"
    invert: false,
    autoContrast: true,
    sampling: "min",            // how a voxel column reads the texels under it: "min", "avg" or "max"         // stretch each face's darkest..brightest texel to 0..1 before thresholding
    threshold: 0,
    steps: 2,                   // height levels: few levels read as clean pixel-art steps
    depth: 1,                   // relief depth in voxels
    faces: { top: true, left: true, right: true },     // which faces get relief
    edges: { topLeft: true, topRight: true, bottomLeft: true, bottomRight: true, sides: false },
    edgeFalloff: 2,             // voxels over which relief fades out toward an edge that must stay flat
    autoFit: true,              // lower bumps that would leave the sprite
    chips: 0,                   // 0..1 chance that a voxel on a block edge is chipped away
    lip: 0,                     // longest overhang hanging from the top edge, in voxels (0 = none)
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
    edgeLight: 0.12,            // brighten the top face's rim
    outline: 0,                 // darken the silhouette's inner edge pixels by this much
    cleanup: true,              // replace lone pixels surrounded by one colour
  };

  function merge(opts) {
    const o = { ...DEFAULTS, ...opts };
    o.faces = { ...DEFAULTS.faces, ...(opts.faces || {}) };
    o.edges = { ...DEFAULTS.edges, ...(opts.edges || {}) };
    o.shade = { ...DEFAULTS.shade, ...(opts.shade || {}) };
    return o;
  }

  // ── Voxels ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The block as a voxel grid. Core voxels are i, j, k in 0..res-1 (x, y, z); relief that rises out of the block
   * (and lips) lives outside the core on the visible sides only: k ≥ res (top), j < 0 (left face, -Y), i ≥ res (right
   * face, +X). Each solid voxel stores the face whose texture colours it.
   */
  function buildVoxels(o, tex) {
    const R = o.res;
    const D = o.relief === "none" ? 0 : Math.max(1, Math.round(o.depth));
    const out = o.relief === "out";
    const pad = (out ? D : 0) + (o.lip > 0 ? 1 : 0);
    const iLo = 0, iHi = R + pad;           // +X side grows (right face)
    const jLo = -pad, jHi = R;              // -Y side grows (left face)
    const kLo = 0, kHi = R + (out ? D : 0); // top grows
    const nx = iHi - iLo, ny = jHi - jLo, nz = kHi - kLo;
    const grid = new Uint8Array(nx * ny * nz);
    const idx = (i, j, k) => ((k - kLo) * ny + (j - jLo)) * nx + (i - iLo);
    const inside = (i, j, k) => i >= iLo && i < iHi && j >= jLo && j < jHi && k >= kLo && k < kHi;

    // Relief levels per face column, 0..D, with the flat-edge masks and the fit inside the sprite applied.
    const levels = {};
    const faceDefs = {
      top: { tex: tex.top, uv: (a, b) => [(a + 0.5) / R, (b + 0.5) / R] },      // a = i, b = j
      left: { tex: tex.left, uv: (a, b) => [(a + 0.5) / R, (b + 0.5) / R] },    // a = i, b = k
      right: { tex: tex.right, uv: (a, b) => [(a + 0.5) / R, (b + 0.5) / R] },  // a = j, b = k
    };
    const lvlSteps = Math.max(1, o.steps);
    const fall = Math.max(0, o.edgeFalloff);
    const edgeMask = (d) => (fall <= 0 ? (d <= 0 ? 0 : 1) : clamp01(d / fall));
    for (const name of ["top", "left", "right"]) {
      const L = new Uint8Array(R * R);
      const f = faceDefs[name];
      // Raw heights first, so auto contrast can stretch this face's own range: a texture drawn in a narrow band of
      // values (a mid-grey stone) still gets its full relief.
      const raw = new Float32Array(R * R);
      let lo = Infinity, hi = -Infinity;
      for (let a = 0; a < R; a++) for (let b = 0; b < R; b++) {
        const v = f.tex.height(a / R, b / R, (a + 1) / R, (b + 1) / R, o.source, o.invert, o.sampling);
        raw[b * R + a] = v;
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      const span = hi - lo;
      for (let a = 0; a < R; a++) {
        for (let b = 0; b < R; b++) {
          if (!o.faces[name] || D === 0) { L[b * R + a] = out ? 0 : D; continue; }
          let hgt = raw[b * R + a];
          if (o.autoContrast && span > 1e-3) hgt = (hgt - lo) / span;
          hgt = clamp01((hgt - o.threshold) / Math.max(1e-4, 1 - o.threshold));
          hgt = hgt > 0 ? Math.ceil(hgt * lvlSteps - 1e-6) / lvlSteps : 0;
          // Edges that must stay flat fade the relief out. The block's outer vertical edges always do: past them a
          // bump would leave the sprite sideways.
          let m = 1;
          if (name === "top") {
            if (!o.edges.topLeft) m = Math.min(m, edgeMask(a));           // -X edge: upper-left side of the diamond
            if (!o.edges.topRight) m = Math.min(m, edgeMask(R - 1 - b));  // +Y edge: upper-right side
          } else if (name === "left") {
            if (!o.edges.sides) m = Math.min(m, edgeMask(a));             // x = -0.5: left silhouette
            if (!o.edges.bottomLeft) m = Math.min(m, edgeMask(b));
          } else {
            if (!o.edges.sides) m = Math.min(m, edgeMask(R - 1 - a));     // y = +0.5: right silhouette
            if (!o.edges.bottomRight) m = Math.min(m, edgeMask(b));
          }
          // In: the mask keeps the edge uncarved. Out: it keeps the edge from rising.
          const lv = Math.round(hgt * D);
          L[b * R + a] = out ? Math.round(lv * m) : Math.round(D - (D - lv) * m);
        }
      }
      levels[name] = L;
    }

    const vx = 1 / R, vz = o.blockHeight / R;
    if (out && o.autoFit) fitInSprite(o, levels, R, vx, vz);

    // Core: every voxel, minus what IN carves. The owner is the visible face the voxel is closest to (top wins ties, so a
    // block's rim shows the top's pixels like a hand-drawn tile).
    for (let k = 0; k < R; k++) {
      for (let j = 0; j < R; j++) {
        for (let i = 0; i < R; i++) {
          const dTop = R - 1 - k, dLeft = j, dRight = R - 1 - i;
          if (!out && D > 0) {
            if (dTop < D - levels.top[j * R + i]) continue;
            if (dLeft < D - levels.left[k * R + i]) continue;
            if (dRight < D - levels.right[k * R + j]) continue;
          }
          let owner = FACE.TOP, best = dTop;
          if (dLeft < best) { owner = FACE.LEFT; best = dLeft; }
          if (dRight < best) { owner = FACE.RIGHT; best = dRight; }
          grid[idx(i, j, k)] = owner;
        }
      }
    }
    // Out: columns rising off each visible face.
    if (out) {
      for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
        for (let s = 1; s <= levels.top[j * R + i]; s++) grid[idx(i, j, R - 1 + s)] = FACE.TOP;
      }
      for (let k = 0; k < R; k++) for (let i = 0; i < R; i++) {
        for (let s = 1; s <= levels.left[k * R + i]; s++) grid[idx(i, -s, k)] = FACE.LEFT;
      }
      for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) {
        for (let s = 1; s <= levels.right[k * R + j]; s++) grid[idx(R - 1 + s, j, k)] = FACE.RIGHT;
      }
    }

    const random = rng(o.seed);
    // Chipped edges: voxels that sit on two of the block's sides at once are knocked off now and then, two deep at the
    // corners, like worn stone.
    if (o.chips > 0) {
      for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
        const onEdge = (i === 0 || i === R - 1) + (j === 0 || j === R - 1) + (k === R - 1);
        if (onEdge >= 2 && random() < o.chips) grid[idx(i, j, k)] = 0;
      }
    }
    // Lip: the top's surface hanging over the side faces from the top edge (grass, snow, moss). Owned by the top, so it
    // shows the top texture's edge pixels.
    if (o.lip > 0) {
      for (let i = 0; i < R; i++) {
        if (random() >= o.lipChance) continue;
        const len = 1 + Math.floor(random() * o.lip);
        for (let s = 0; s < len; s++) grid[idx(i, -1, R - 1 - s)] ||= FACE.TOP;
      }
      for (let j = 0; j < R; j++) {
        if (random() >= o.lipChance) continue;
        const len = 1 + Math.floor(random() * o.lip);
        for (let s = 0; s < len; s++) grid[idx(R, j, R - 1 - s)] ||= FACE.TOP;
      }
    }

    return {
      R, D, grid, nx, ny, nz, iLo, jLo, kLo, iHi, jHi, kHi, vx, vz,
      solid(i, j, k) { return inside(i, j, k) ? grid[idx(i, j, k)] : 0; },
      levels,
    };
  }

  /** Lowers bumps whose outer end would land outside the sprite (above its top edge or past its sides). */
  function fitInSprite(o, levels, R, vx, vz) {
    const S = o.size;
    const H = o.blockHeight;
    const insideSprite = (p) => {
      const [px, py] = project(p, S, H);
      return px >= 0 && px <= S && py >= 0 && py <= S;
    };
    const lower = (L, key, corners) => {
      while (L[key] > 0 && !corners(L[key]).every(insideSprite)) L[key]--;
    };
    for (let b = 0; b < R; b++) for (let a = 0; a < R; a++) {
      const x0 = -0.5 + a * vx, x1 = x0 + vx, y0 = -0.5 + b * vx, y1 = y0 + vx;
      lower(levels.top, b * R + a, (l) => {
        const z = H + l * vz;
        return [[x0, y0, z], [x1, y0, z], [x0, y1, z], [x1, y1, z]];
      });
      const z0 = b * vz, z1 = z0 + vz;
      lower(levels.left, b * R + a, (l) => {
        const y = -0.5 - l * vx;
        return [[x0, y, z0], [x1, y, z0], [x0, y, z1], [x1, y, z1]];
      });
      lower(levels.right, b * R + a, (l) => {
        const x = 0.5 + l * vx;
        return [[x, y0, z0], [x, y1, z0], [x, y0, z1], [x, y1, z1]];
      });
    }
  }

  /** World point -> sprite pixel coordinates (x right, y down), the block centred in an S × S sprite. */
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
   * Renders the block. tex: { top, left, right } from faceTexture(). Returns S × S RGBA arrays:
   * color, normal (_n encoding), depth (white = near), ao (white = open), gray (light and AO without the texture's
   * colour), plus mask (1 where the block is).
   */
  function render(opts, tex) {
    const o = merge(opts);
    const S = o.size, H = o.blockHeight;
    const V = buildVoxels(o, tex);
    const s = Math.SQRT2 / S;
    const centre = [0, 0, H / 2];
    const far = 4;
    const n = S * S;
    const color = new Uint8ClampedArray(n * 4), normal = new Uint8ClampedArray(n * 4);
    const depth = new Uint8ClampedArray(n * 4), aoMap = new Uint8ClampedArray(n * 4), gray = new Uint8ClampedArray(n * 4);
    const mask = new Uint8Array(n);
    const faceN = new Int8Array(n);      // which visible face each pixel shows, for the pixel-art passes
    const hemi = hemisphere(Math.max(1, o.aoSamples));
    const aoDist = o.aoDistance;

    // Depth range: the extended grid's corners along the view direction.
    let dMin = Infinity, dMax = -Infinity;
    for (const x of [-0.5 + V.iLo * V.vx, -0.5 + V.iHi * V.vx]) for (const y of [-0.5 + V.jLo * V.vx, -0.5 + V.jHi * V.vx]) {
      for (const z of [0, V.kHi * V.vz]) {
        const d = dot([x, y, z], BACK);
        dMin = Math.min(dMin, d); dMax = Math.max(dMax, d);
      }
    }

    const faceTex = { [FACE.TOP]: tex.top, [FACE.LEFT]: tex.left, [FACE.RIGHT]: tex.right };
    // Face coordinates (u right, v up as seen from outside) of a point, for the face that owns it.
    const faceUV = {
      [FACE.TOP]: (p) => [p[0] + 0.5, p[1] + 0.5],
      [FACE.LEFT]: (p) => [p[0] + 0.5, p[2] / H],
      [FACE.RIGHT]: (p) => [p[1] + 0.5, p[2] / H],
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
        const visible = nrm[2] > 0.5 ? FACE.TOP : nrm[1] < -0.5 ? FACE.LEFT : FACE.RIGHT;
        // A step's wall shows the lower pixel's colour (the neighbour on the open side of the wall): with the taller
        // pixel's colour, one-pixel grooves vanished from this angle. Faces that point the owner's way sample in place.
        const ownerAxis = hit.owner === FACE.TOP ? 2 : hit.owner === FACE.LEFT ? 1 : 0;
        const q = hit.axis === ownerAxis ? p : [p[0] + nrm[0] * V.vx * 0.5, p[1] + nrm[1] * V.vx * 0.5, p[2] + nrm[2] * V.vz * 0.5];
        const [u, v] = faceUV[hit.owner](q);
        const texel = faceTex[hit.owner].color(clamp01(u), clamp01(v));
        if (texel[3] < 8) continue;

        let ao = 1;
        if (o.ao && o.aoStrength > 0) {
          const start = [p[0] + nrm[0] * 1e-4, p[1] + nrm[1] * 1e-4, p[2] + nrm[2] * 1e-4];
          let blocked = 0;
          for (const d of hemi) {
            if (march(V, start, orient(d, nrm), aoDist)) blocked++;
          }
          ao = 1 - o.aoStrength * (blocked / hemi.length);
          if (o.aoSteps > 1) ao = 1 - Math.round((1 - ao) * (o.aoSteps - 1) / o.aoStrength) * o.aoStrength / (o.aoSteps - 1);
        }
        const shade = o.shading ? (visible === FACE.TOP ? o.shade.top : visible === FACE.LEFT ? o.shade.left : o.shade.right) : 1;
        const k = (py * S + px) * 4;
        color[k] = texel[0] * shade * ao;
        color[k + 1] = texel[1] * shade * ao;
        color[k + 2] = texel[2] * shade * ao;
        color[k + 3] = 255;
        // Voxel faces only ever point along the three visible axes: write the exact colours the Aura Iso Normals
        // extension uses for them, so these maps match the hand-made ones bit for bit.
        const enc = FACE_NORMAL_RGB[visible];
        normal[k] = enc[0]; normal[k + 1] = enc[1]; normal[k + 2] = enc[2]; normal[k + 3] = 255;
        const dv = Math.round(255 * clamp01((dot(p, BACK) - dMin) / Math.max(1e-6, dMax - dMin)));
        depth[k] = depth[k + 1] = depth[k + 2] = dv; depth[k + 3] = 255;
        const av = Math.round(255 * ao);
        aoMap[k] = aoMap[k + 1] = aoMap[k + 2] = av; aoMap[k + 3] = 255;
        const base = o.grayFromTexture ? (0.2126 * texel[0] + 0.7152 * texel[1] + 0.0722 * texel[2]) / 255 : 1;
        const gv = Math.round(255 * base * shade * ao);
        gray[k] = gray[k + 1] = gray[k + 2] = gv; gray[k + 3] = 255;
        mask[py * S + px] = 1;
        faceN[py * S + px] = visible;
      }
    }

    pixelArtPasses(o, S, color, mask, faceN);
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

  Aura.blockEngine = { DEFAULTS, BLOCK_HEIGHT, FACE, faceTexture, render, project, upscale, merge };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
