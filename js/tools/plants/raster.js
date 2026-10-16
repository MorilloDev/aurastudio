"use strict";

// Plant renderer for the Plantas tool: draws the triangles of a plant with the game's camera into a sprite and its
// maps — colour, normals, depth, ambient occlusion and grayscale — the same set the Bloques tool writes.
//
// Plants have no flat faces, so the normal map stores each pixel's real normal in the encoding the game decodes
// ((n·right, n·up, n·back), the same one the three cube colours come from): NormalMapLoader turns any normal into
// top / left / right weights, so stems and leaves take light by the way they actually face. "Por caras" snaps every
// pixel to the nearest of the three cube colours instead, for a harder, hand-drawn look.
(function (Aura) {
  const RIGHT = [Math.SQRT1_2, Math.SQRT1_2, 0];
  const UP = [-0.3535534, 0.3535534, 0.8660254];
  const BACK = [0.6123724, -0.6123724, 0.5];
  const FACE_NORMAL_RGB = [[128, 238, 191], [37, 83, 206], [218, 83, 206]];   // top, left, right
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const toSrgb = Aura.plantMesh.toSrgb;

  const DEFAULTS = {
    size: 64,
    supersample: 3,            // samples per pixel side; thin blades survive as long as one sample hits them
    coverage: 1,               // samples (of supersample²) a pixel needs to be drawn
    shading: true,             // the Blender materials' face light: top 1.0, left 0.75, right 0.55
    shade: { top: 1, left: 0.75, right: 0.55 },
    normals: "smooth",         // "smooth": real normals; "faces": snapped to the three cube colours
    ao: true,
    aoDistance: 0.12,          // in blocks
    aoStrength: 0.55,
    aoSamples: 12,
    aoSteps: 3,
    aoGround: true,            // the ground under the plant occludes too
    lightSteps: 0,             // 0 = smooth; n quantizes the final light into n steps (cel look)
    outline: 0,                // darken the silhouette's edge pixels by this much
    toneSteps: 0,              // 0 = off; n flattens the finished colours into n tones spread over the sprite's own
                               // light range — the flat, painted look of hand-made leaves (one value per leaf face)
    innerEdges: 0,             // darken a pixel by this much where something nearer covers its neighbour: a thin dark
                               // line where one leaf lies over another, so overlapping leaves keep their outline
    innerEdgeGap: 0.04,
    monochrome: false,         // the colour sheet in grays (its own brightness): for biome_tinted art the game colours        // how much nearer (in blocks along the view) the neighbour must be to cut a line
    grayFromColor: false,
    // Depth shade: what lies further back in the plant takes a darker, cooler colour, baked into the sprite itself —
    // the game reads no depth map, so this is how a dense bush keeps its volume once exported.
    depthShade: 0.45,          // 0 = off; how strongly the furthest pixels take the tint
    depthTint: "#5a6a8c",      // multiplied into the colour at full depth
    depthCurve: 1,             // >1 keeps the shade in the deepest part; <1 spreads it forward
    depthMode: "back",         // "back": behind, along the ground; "view": along the view ray (lower reads deeper too)
  };

  function merge(opts = {}) {
    return { ...DEFAULTS, ...opts, shade: { ...DEFAULTS.shade, ...(opts.shade || {}) } };
  }

  /** World point → supersampled sprite coordinates, a full block centred in the sprite as in the Bloques tool. */
  function projector(S, H) {
    const s = Math.SQRT2 / S;
    return (x, y, z) => {
      const c = [x, y, z - H / 2];
      return [dot(c, RIGHT) / s + S / 2, -dot(c, UP) / s + S / 2];
    };
  }

  // ── Occupancy, for AO ────────────────────────────────────────────────────────────────────────────────────────────

  /** Voxel grid marked wherever a triangle passes; AO rays march through it. */
  function occupancy(mesh, cell, pad) {
    const { pos } = mesh;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], pos[i + a]); hi[a] = Math.max(hi[a], pos[i + a]);
    }
    for (let a = 0; a < 3; a++) { lo[a] -= pad; hi[a] += pad; }
    const n = [0, 1, 2].map((a) => Math.max(1, Math.ceil((hi[a] - lo[a]) / cell)));
    const grid = new Uint8Array(n[0] * n[1] * n[2]);
    const mark = (x, y, z) => {
      const i = Math.floor((x - lo[0]) / cell), j = Math.floor((y - lo[1]) / cell), k = Math.floor((z - lo[2]) / cell);
      if (i >= 0 && j >= 0 && k >= 0 && i < n[0] && j < n[1] && k < n[2]) grid[(k * n[1] + j) * n[0] + i] = 1;
    };
    for (let t = 0; t < pos.length; t += 9) {
      const a = [pos[t], pos[t + 1], pos[t + 2]], b = [pos[t + 3], pos[t + 4], pos[t + 5]], c = [pos[t + 6], pos[t + 7], pos[t + 8]];
      const longest = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]),
        Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]));
      const steps = Math.max(1, Math.ceil(longest / (cell * 0.5)));
      for (let u = 0; u <= steps; u++) for (let v = 0; v <= steps - u; v++) {
        const wu = u / steps, wv = v / steps, ww = 1 - wu - wv;
        mark(a[0] * ww + b[0] * wu + c[0] * wv, a[1] * ww + b[1] * wu + c[1] * wv, a[2] * ww + b[2] * wu + c[2] * wv);
      }
    }
    return {
      solid(x, y, z) {
        const i = Math.floor((x - lo[0]) / cell), j = Math.floor((y - lo[1]) / cell), k = Math.floor((z - lo[2]) / cell);
        return i >= 0 && j >= 0 && k >= 0 && i < n[0] && j < n[1] && k < n[2] && grid[(k * n[1] + j) * n[0] + i] === 1;
      },
    };
  }

  // Fixed cosine-weighted hemisphere (Fibonacci spiral): the same directions every render, so AO never flickers.
  function hemisphere(n) {
    const out = [];
    for (let s = 0; s < n; s++) {
      const r = Math.sqrt((s + 0.5) / n), a = s * 2.399963;
      out.push([r * Math.cos(a), r * Math.sin(a), Math.sqrt(Math.max(0, 1 - r * r))]);
    }
    return out;
  }
  function orient(d, n) {
    const t = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let bx = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
    const l = Math.hypot(bx[0], bx[1], bx[2]);
    bx = [bx[0] / l, bx[1] / l, bx[2] / l];
    const by = [n[1] * bx[2] - n[2] * bx[1], n[2] * bx[0] - n[0] * bx[2], n[0] * bx[1] - n[1] * bx[0]];
    return [bx[0] * d[0] + by[0] * d[1] + n[0] * d[2], bx[1] * d[0] + by[1] * d[1] + n[1] * d[2], bx[2] * d[0] + by[2] * d[1] + n[2] * d[2]];
  }

  // ── Render ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * mesh: { pos, col } from plantGen.build (linear colours). ground: the z the plant stands on (for ground AO).
   * occluders: the mesh AO is traced against when it is not the drawn one — the whole plant, when drawing one part of
   * a multipart plant, so the shade carries on across the cut.
   * Returns S × S RGBA maps: color, normal, depth (white = near), ao (white = open), gray, plus mask.
   */
  function render(mesh, opts = {}, ground = 0, occluders = null) {
    const o = merge(opts);
    const S = o.size, ss = Math.max(1, Math.round(o.supersample)), W = S * ss;
    const H = Aura.blockEngine.BLOCK_HEIGHT;
    const project = projector(W, H);
    const { pos, col } = mesh;

    // Per sample: depth (larger = nearer), colour, normal, world position.
    const n = W * W;
    const zs = new Float32Array(n).fill(-Infinity);
    const cs = new Float32Array(n * 3), ns = new Float32Array(n * 3), ps = new Float32Array(n * 3);

    for (let t = 0; t < pos.length; t += 9) {
      const A = [pos[t], pos[t + 1], pos[t + 2]], B = [pos[t + 3], pos[t + 4], pos[t + 5]], C = [pos[t + 6], pos[t + 7], pos[t + 8]];
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      let nr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const nl = Math.hypot(nr[0], nr[1], nr[2]);
      if (nl < 1e-14) continue;
      nr = [nr[0] / nl, nr[1] / nl, nr[2] / nl];
      // Two-sided: leaves and petals are seen from both sides, and on closed shapes the faces turned away are hidden
      // behind the near ones anyway, so every triangle is lit as facing the camera.
      if (dot(nr, BACK) < 0) nr = [-nr[0], -nr[1], -nr[2]];
      const [ax, ay] = project(A[0], A[1], A[2]), [bx, by] = project(B[0], B[1], B[2]), [cx, cy] = project(C[0], C[1], C[2]);
      const da = dot(A, BACK), db = dot(B, BACK), dc = dot(C, BACK);
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(W - 1, Math.ceil(Math.max(ay, by, cy)));
      const ca = t, cb = t + 3, cc = t + 6;
      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
          const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const d = w0 * da + w1 * db + w2 * dc;
          const i = y * W + x;
          if (d <= zs[i]) continue;
          zs[i] = d;
          for (let k = 0; k < 3; k++) {
            cs[i * 3 + k] = w0 * col[ca + k] + w1 * col[cb + k] + w2 * col[cc + k];
            ns[i * 3 + k] = nr[k];
            ps[i * 3 + k] = w0 * A[k] + w1 * B[k] + w2 * C[k];
          }
        }
      }
    }

    // Supersamples → pixels: the nearest covered sample decides, so colours stay the plant's own (no blending into
    // in-between shades that pixel art would have to clean up).
    const color = new Uint8ClampedArray(S * S * 4), normal = new Uint8ClampedArray(S * S * 4);
    const depth = new Uint8ClampedArray(S * S * 4), aoMap = new Uint8ClampedArray(S * S * 4), gray = new Uint8ClampedArray(S * S * 4);
    const mask = new Uint8Array(S * S);
    const pz = new Float32Array(S * S).fill(-Infinity);
    let dMin = Infinity, dMax = -Infinity;
    // A fixed range per cell (not per plant), so every part of a multipart plant writes depth on the same scale.
    for (const x of [-0.75, 0.75]) for (const y of [-0.75, 0.75]) for (const z of [-0.2, 1.6]) {
      const d = dot([x, y, z], BACK);
      dMin = Math.min(dMin, d); dMax = Math.max(dMax, d);
    }

    const cell = 1 / 48;
    const occ = o.ao && o.aoStrength > 0 ? occupancy(occluders ?? mesh, cell, o.aoDistance + cell) : null;
    const hemi = hemisphere(Math.max(1, o.aoSamples));
    const blockedAt = (x, y, z) => (o.aoGround && z < ground) || occ.solid(x, y, z);
    const depthOf = depthMeasure(o.depthMode);
    const shadeRange = o.depthShade > 0 ? extent(occluders ?? mesh, depthOf) : null;
    const tint = o.depthShade > 0 ? Aura.plantMesh.hexToLinear(o.depthTint) : null;

    for (let py = 0; py < S; py++) {
      for (let px = 0; px < S; px++) {
        let best = -1, count = 0;
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
          const i = (py * ss + sy) * W + px * ss + sx;
          if (zs[i] === -Infinity) continue;
          count++;
          if (best < 0 || zs[i] > zs[best]) best = i;
        }
        if (best < 0 || count < o.coverage) continue;
        const nrm = [ns[best * 3], ns[best * 3 + 1], ns[best * 3 + 2]];
        const p = [ps[best * 3], ps[best * 3 + 1], ps[best * 3 + 2]];

        let ao = 1;
        if (occ) {
          // Start a voxel and a half off the surface, so a leaf does not shade itself.
          const start = [p[0] + nrm[0] * cell * 1.5, p[1] + nrm[1] * cell * 1.5, p[2] + nrm[2] * cell * 1.5];
          let blocked = 0;
          for (const h of hemi) {
            const d = orient(h, nrm);
            for (let t = cell * 0.75; t <= o.aoDistance; t += cell * 0.75) {
              if (blockedAt(start[0] + d[0] * t, start[1] + d[1] * t, start[2] + d[2] * t)) { blocked++; break; }
            }
          }
          ao = 1 - o.aoStrength * blocked / hemi.length;
          if (o.aoSteps > 1) ao = 1 - Math.round((1 - ao) * (o.aoSteps - 1) / o.aoStrength) * o.aoStrength / (o.aoSteps - 1);
        }

        // Face light: the normal's share of each cube face (squared, so a facet mostly takes one face's light).
        const wt = Math.max(0, nrm[2]) ** 2, wl = Math.max(0, -nrm[1]) ** 2, wr = Math.max(0, nrm[0]) ** 2;
        const sum = wt + wl + wr || 1;
        const shade = o.shading ? (wt * o.shade.top + wl * o.shade.left + wr * o.shade.right) / sum : 1;
        let light = shade * ao;
        if (o.lightSteps > 1) light = Math.max(1 / o.lightSteps, Math.round(light * o.lightSteps) / o.lightSteps);

        const k = (py * S + px) * 4;
        const c = [cs[best * 3], cs[best * 3 + 1], cs[best * 3 + 2]];
        let far = 0;
        if (shadeRange) {
          const t = clamp01((shadeRange[1] - depthOf(p)) / Math.max(1e-6, shadeRange[1] - shadeRange[0]));
          far = o.depthShade * Math.pow(t, Math.max(0.05, o.depthCurve));
        }
        const tinted = (a) => (tint ? 1 - far + far * tint[a] : 1);
        for (let a = 0; a < 3; a++) color[k + a] = Math.round(clamp01(toSrgb(c[a] * light * tinted(a))) * 255);
        color[k + 3] = 255;
        if (o.normals === "faces") {
          const f = wt >= wl && wt >= wr ? 0 : wl >= wr ? 1 : 2;
          normal.set(FACE_NORMAL_RGB[f], k);
        } else {
          normal[k] = Math.round((dot(nrm, RIGHT) * 0.5 + 0.5) * 255);
          normal[k + 1] = Math.round((dot(nrm, UP) * 0.5 + 0.5) * 255);
          normal[k + 2] = Math.round((dot(nrm, BACK) * 0.5 + 0.5) * 255);
        }
        normal[k + 3] = 255;
        const dv = Math.round(255 * clamp01((zs[best] - dMin) / Math.max(1e-6, dMax - dMin)));
        depth[k] = depth[k + 1] = depth[k + 2] = dv; depth[k + 3] = 255;
        aoMap[k] = aoMap[k + 1] = aoMap[k + 2] = Math.round(255 * ao); aoMap[k + 3] = 255;
        const base = o.grayFromColor ? clamp01(toSrgb(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])) : 1;
        const grayShade = tint ? 1 - far + far * (0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2]) : 1;
        gray[k] = gray[k + 1] = gray[k + 2] = Math.round(255 * base * light * grayShade); gray[k + 3] = 255;
        mask[py * S + px] = 1;
        pz[py * S + px] = zs[best];
      }
    }

    if (o.innerEdges > 0) innerEdges(color, gray, mask, pz, S, o.innerEdges, o.innerEdgeGap);

    if (o.monochrome) {
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const k = i * 4, l = Math.round(0.2126 * color[k] + 0.7152 * color[k + 1] + 0.0722 * color[k + 2]);
        color[k] = color[k + 1] = color[k + 2] = l;
      }
    }
    if (o.toneSteps > 1) posterize(color, gray, mask, o.toneSteps);

    if (o.outline > 0) {
      const edge = [];
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        if (!mask[y * S + x]) continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const X = x + dx, Y = y + dy;
          return X < 0 || Y < 0 || X >= S || Y >= S || !mask[Y * S + X];
        })) edge.push((y * S + x) * 4);
      }
      for (const k of edge) for (let a = 0; a < 3; a++) color[k + a] *= 1 - o.outline;
    }
    return { size: S, color, normal, depth, ao: aoMap, gray, mask };
  }

  // ── Inner edges ─────────────────────────────────────────────────────────────────────────────────────────────────

  // The farther pixel of every pair where the depth jumps gets darker. Decided on a copy of the depths, so a line never
  // grows into the next pixel; the silhouette's own edge is the outline option's job, not this one's.
  function innerEdges(color, gray, mask, pz, S, amount, gap) {
    const dark = [];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (!mask[i]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
        const j = Y * S + X;
        if (mask[j] && pz[j] - pz[i] > gap) { dark.push(i); break; }
      }
    }
    const f = 1 - amount;
    for (const i of dark) {
      const k = i * 4;
      for (let a = 0; a < 3; a++) color[k + a] = Math.round(color[k + a] * f);
      gray[k] = gray[k + 1] = gray[k + 2] = Math.round(gray[k] * f);
    }
  }

  // ── Tones ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Snaps every pixel's brightness to one of n tones spread between the sprite's darkest and brightest pixel, keeping
   * its hue: the gradients that AO and depth leave across a leaf become flat bands, and the band edges fall where the
   * light changes most (between leaves) instead of inside them. The gray map follows the same tones.
   */
  function posterize(color, gray, mask, n) {
    const lum = (k) => 0.2126 * color[k] + 0.7152 * color[k + 1] + 0.0722 * color[k + 2];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const l = lum(i * 4);
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
    if (!(hi > lo)) return;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const k = i * 4, l = lum(k);
      const t = Math.round((l - lo) / (hi - lo) * (n - 1)) / (n - 1);
      const target = lo + t * (hi - lo), f = l > 0 ? target / l : 0;
      for (let a = 0; a < 3; a++) color[k + a] = Math.round(Math.min(255, color[k + a] * f));
      const g = gray[k] * f;
      gray[k] = gray[k + 1] = gray[k + 2] = Math.round(Math.min(255, g));
    }
  }

  // ── Depth shade ──────────────────────────────────────────────────────────────────────────────────────────────────

  // Larger = nearer the camera. "back" drops the view ray's vertical part, so a tall plant is not darker at its foot
  // just for being lower; "view" keeps it, which also shades a bush's low inside.
  function depthMeasure(mode) {
    if (mode === "view") return (p) => dot(p, BACK);
    return (p) => p[0] * BACK[0] + p[1] * BACK[1];
  }

  // Measured on the whole plant (the occluders when one part is drawn): every part of a multipart plant is moved
  // down by the same offset as its occluders, so all parts share one range and the shade carries on across the cut.
  function extent(mesh, depthOf) {
    let lo = Infinity, hi = -Infinity;
    const pos = mesh.pos;
    for (let i = 0; i < pos.length; i += 3) {
      const d = depthOf([pos[i], pos[i + 1], pos[i + 2]]);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    return lo < hi ? [lo, hi] : null;
  }

  // ── Painted leaves ───────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A leaf block painted straight into the sprite, the way a hand-drawn one is made: whole leaves facing the camera,
   * laid in layers from the back, each one a flat shape cut in two tones along its midrib — instead of 3D leaves seen
   * edge-on, which at 64 px turn into slivers and noise. Every species keeps its real leaf: lobed oak, toothed birch,
   * needle tufts, palm fronds, split monstera… (PAINT_SHAPES, and the clustered kinds in paintAnchor).
   *
   * What makes the leaves read, measured on Dalvin's hand-made block: each leaf casts a 1 px seam one tone darker on the
   * side away from the light, and some seam pixels stay open as pinholes. The crown is the block's outline rounded
   * off; the tone falls off from the top down and toward the right; back layers sit a tone lower.
   *
   * spec (lengths in pixels of a 64 px sprite, scaled to opts.size): { seed, shape, length, lengthVar, width, point,
   * spacing (× length), backSpacing, jitter, hang, layers, holes, backHoles, pinholes, round, fill, clip, darker,
   * lighter, highlight, edge, edgeTones, edgeShadow, light, dark, tones, altChance, altColor, blossoms, blossomColor,
   * blossomCenter, vines, vineLength, vineColor }
   */
  function paintLeaves(spec, opts) {
    const S = opts.size, k = S / 64, N = S * S;
    const out = {
      size: S, color: new Uint8ClampedArray(N * 4), normal: new Uint8ClampedArray(N * 4), depth: new Uint8ClampedArray(N * 4),
      ao: new Uint8ClampedArray(N * 4), gray: new Uint8ClampedArray(N * 4), mask: new Uint8Array(N),
    };
    const seam = new Uint8Array(N);
    const rnd = mulberry(spec.seed >>> 0 || 1);
    const uni = (a, b) => a + (b - a) * rnd();
    const nTones = Math.max(3, spec.tones | 0);
    const mainPal = tonePalette(spec.dark, spec.light, nTones);
    const altPal = spec.altChance > 0 ? tonePalette(scaleHex(spec.altColor, 0.55), spec.altColor, nTones) : null;
    const top = nTones - 1;
    const crown = crownShape(k, spec.round);
    // Needles and fronds are mostly air: a third layer behind fills the crown the way a dense shoot does.
    const layers = Math.max(1, spec.layers | 0) + (spec.shape === "NEEDLE" || spec.shape === "PALM" ? 1 : 0);
    const shapeOf = PAINT_SHAPES[spec.shape] ?? PAINT_SHAPES.LANCE;

    // One pixel of a leaf (or of its seam). face: 0 top, 1 left, 2 right — the normal map's cube face.
    const put = (x, y, rgb, face, fromFront, isSeam) => {
      const i = y * S + x, kk = i * 4;
      writePixel(out, kk, rgb, PAINT_FACE_N[face], Math.round(255 * (1 - fromFront / layers)), 255 - fromFront * 40);
      out.mask[i] = 1;
      seam[i] = isSeam ? 1 : 0;
    };

    /**
     * One blade from (bx, by) along (dx, dy): the shape's outline, two tones split by the midrib, and the seam behind it.
     * half(u) gives the half width (in units of wid) at u = 0 (stalk) … 1 (tip); cut(u, |v|/half) opens notches.
     */
    const blade = (b) => {
      const { bx, by, dx, dy, len, wid, shape, tones, face, fromFront } = b;
      const px = -dy, py = dx;
      const rim = Math.max(0, spec.edge) * k;
      const mx = bx + dx * len * 0.5, my = by + dy * len * 0.5;
      const reach = len + wid + rim + 1;
      const x0 = Math.max(0, Math.floor(mx - reach)), x1 = Math.min(S - 1, Math.ceil(mx + reach));
      const y0 = Math.max(0, Math.floor(my - reach)), y1 = Math.min(S - 1, Math.ceil(my + reach));
      const litSide = px * PAINT_LIGHT[0] + py * PAINT_LIGHT[1] > 0 ? 1 : -1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5 - bx, qy = y + 0.5 - by;
        const along = qx * dx + qy * dy, v = qx * px + qy * py;
        if (along <= -rim || along >= len + rim) continue;
        const u = along / len, uc = Math.min(1, Math.max(0, u));
        // Never thinner than a pixel's half, so needles and ribs stay drawn at any size.
        const half = Math.max(b.minHalf ?? 0, wid * shape.half(uc, spec.point));
        let inLeaf = u > 0 && u < 1 && Math.abs(v) <= half;
        if (inLeaf && shape.cut && shape.cut(uc, Math.abs(v) / Math.max(1e-6, half), v)) inLeaf = false;
        if (!inLeaf && (rim <= 0 || Math.abs(v) > half + rim)) continue;
        if (!crown.inside(x + 0.5, y + 0.5, spec.clip) && !b.free) continue;
        const i = y * S + x;
        // The seam only darkens what is already painted behind, on the side away from the light ("edgeShadow").
        if (!inLeaf) {
          if (!out.mask[i]) continue;
          if (spec.edgeShadow && (x + 0.5 - mx) * PAINT_LIGHT[0] + (y + 0.5 - my) * PAINT_LIGHT[1] > 0) continue;
          put(x, y, tones.pal[tones.rim], face, fromFront, true);
          continue;
        }
        const t = b.single ? tones.lit : (v >= 0 ? 1 : -1) === litSide ? tones.lit : tones.shade;
        put(x, y, tones.pal[t], face, fromFront, false);
      }
    };

    // The leaf's tones from where it sits on the crown — bright over the top, darker down and to the right, the hand-
    // made block's measured falloff — plus its layer and a random shift so neighbours differ.
    const tonesAt = (ax, ay, fromFront, pal, face) => {
      const sm = (a, b, t) => { const q = Math.min(1, Math.max(0, (t - a) / (b - a))); return q * q * (3 - 2 * q); };
      const lightness = 1 - 0.8 * sm(0.22, 0.7, ay / S) - 0.6 * Math.max(0, ax / S - 0.5) * 2;
      let base = top - 2 + Math.round(Math.max(0, lightness) - 0.05) - fromFront;
      const roll = rnd();
      if (roll < spec.darker) base -= 1; else if (roll > 1 - spec.lighter) base += 1;
      const clamp = (t) => Math.max(0, Math.min(top, t));
      const lit = clamp(base + (face === 0 && fromFront === 0 && rnd() < spec.highlight ? 1 : 0));
      const shade = clamp(base - 1);
      return { pal, lit, shade, rim: clamp(shade - Math.max(1, spec.edgeTones | 0)) };
    };

    // Where a leaf at (ax, ay) points: out of the crown (the top's leaves out of the top's own centre, so the top reads
    // as a star of tips), turned by "jitter", then pulled down by "hang" (willow).
    const angleAt = (ax, ay, face) => {
      const cx = crown.cx, cy = face === 0 ? 16 * k : 30 * k;
      let ang = Math.hypot(ax - cx, ay - cy) < 2 * k ? uni(0, Math.PI * 2) : Math.atan2(ay - cy, ax - cx);
      ang += uni(-1, 1) * spec.jitter * Math.PI / 180;
      if (spec.hang > 0) {
        const down = Math.PI / 2;
        let d = Math.atan2(Math.sin(down - ang), Math.cos(down - ang));
        ang += d * spec.hang;
      }
      return ang;
    };

    for (let L = 0; L < layers; L++) {
      const fromFront = layers - 1 - L;
      // Shapes with detail in their outline (lobes, slits, a tuft's fan) get more room, or neighbours hide it.
      const unit = spec.length * k * (PAINT_SPACING[spec.shape] ?? 1);
      const spacing = Math.max(2 * k, unit * spec.spacing * (fromFront === 0 ? 1 : spec.backSpacing));
      for (const [ax, ay] of scatter(spacing, S, crown, spec.fill, rnd, fromFront === 0 ? spec.holes : spec.backHoles)) {
        const face = crown.faceOf(ax, ay);
        const pal = altPal && rnd() < spec.altChance ? altPal : mainPal;
        const tones = tonesAt(ax, ay, fromFront, pal, face);
        const ang = angleAt(ax, ay, face);
        const len = spec.length * k * (1 + uni(-spec.lengthVar, spec.lengthVar)) * (fromFront ? 1.1 : 1);
        paintAnchor({ blade, uni, rnd, ax, ay, ang, len, wid: len * spec.width * 0.5, shape: shapeOf, kind: spec.shape,
          tones, face, fromFront, k });
      }
    }

    if (spec.vines > 0) paintVines(spec, out, blade, rnd, uni, k, nTones, mainPal);
    if (spec.blossoms > 0) paintBlossoms(spec, out, put, crown, rnd, k);

    // Pinholes: some seam pixels left open, so the block is seen through in specks between the leaves (the
    // reference's many one- and two-pixel gaps) instead of in a few big holes.
    if (spec.pinholes > 0) {
      for (let i = 0; i < N; i++) {
        if (seam[i] !== 1 || rnd() >= spec.pinholes) continue;
        out.mask[i] = 0;
        for (const map of [out.color, out.normal, out.depth, out.ao, out.gray]) map.fill(0, i * 4, i * 4 + 4);
      }
    }
    return out;
  }

  // Room around each leaf, × its length × "spacing", per shape.
  const PAINT_SPACING = { TINY: 2.2, NEEDLE: 1.15, LOBED: 1.2, SPLIT: 1.25, HEART: 1.1, SERRATED: 1.1, PALM: 0.8 };

  // Screen direction the light comes from (up and a little left), and the normal of each cube face for the normal map.
  const PAINT_LIGHT = [-0.55, -0.83];
  const PAINT_FACE_N = [[0, 0, 1], [0, -1, 0], [1, 0, 0]];

  /**
   * Leaf outlines, as half widths along the blade: u 0 = stalk, 1 = tip. cut(u, w, v) opens notches (w = |v| / half).
   * Drawn from what the real leaves look like, kept to what still reads at 6–15 px.
   */
  const PAINT_SHAPES = {
    // Willow-like and the hand-made reference: widest before the middle, pointed at both ends.
    LANCE: { half: (u, point) => Math.pow(Math.sin(Math.PI * Math.pow(u, 0.75)), point) },
    NARROW: { half: (u, point) => Math.pow(Math.sin(Math.PI * Math.pow(u, 0.7)), point * 1.2) },
    // Cherry, mangrove: an egg shape, round at the stalk, a short point at the tip.
    OVAL: { half: (u) => Math.pow(Math.sin(Math.PI * Math.pow(u, 0.85)), 0.6) * (u > 0.85 ? 1 - (u - 0.85) * 3 : 1) },
    ROUND: { half: (u) => Math.sqrt(Math.max(0, Math.sin(Math.PI * u))) },
    // Birch: a triangle-ish egg, widest near the stalk, long point, toothed edge.
    SERRATED: {
      half: (u) => Math.pow(Math.sin(Math.PI * Math.pow(u, 0.5)), 0.85) * (1 - 0.18 * ((u * 7) % 1)),
    },
    // Oak: wider toward the tip, with three or four round lobes a side and deep sinuses between them.
    LOBED: {
      half: (u) => {
        const env = Math.pow(Math.sin(Math.PI * Math.pow(u, 1.15)), 0.6);
        return u < 0.12 ? env * 0.4 : env * (0.35 + 0.65 * Math.abs(Math.sin(Math.PI * 3.5 * (u - 0.12) / 0.88)));
      },
    },
    // Jungle: a heart, widest near the stalk, with the notch there.
    HEART: {
      half: (u) => Math.pow(Math.sin(Math.PI * Math.pow(u, 0.5)), 0.7),
      cut: (u, w) => u < 0.14 && w < 0.35,
    },
    // Monstera: the heart with slits cut in from the edge.
    SPLIT: {
      half: (u) => Math.pow(Math.sin(Math.PI * Math.pow(u, 0.55)), 0.65),
      cut: (u, w) => (u < 0.12 && w < 0.3) || (w > 0.25 && u > 0.2 && u < 0.9 && (u * 5) % 1 < 0.3),
    },
    // Sub-shapes of the clustered kinds.
    NEEDLE: { half: (u) => 1 - u * 0.6 },
    RIB: { half: (u) => 1 - u * 0.5 },
  };

  /** One anchor: a single leaf, or the cluster its kind is made of (a needle tuft, a palm frond, tiny leaflets). */
  function paintAnchor(a) {
    const { blade, uni, rnd, ax, ay, ang, len, wid, shape, kind, tones, face, fromFront, k } = a;
    const one = (x, y, angle, l, w, sh, extra = {}) => {
      const dx = Math.cos(angle), dy = Math.sin(angle);
      blade({ bx: x - dx * l * 0.3, by: y - dy * l * 0.3, dx, dy, len: l, wid: w, shape: sh, tones, face, fromFront, ...extra });
    };

    if (kind === "NEEDLE") {
      // A tuft: needles fanned from one point, each a single tone, alternating, so the tuft reads as strands.
      const n = 7 + Math.floor(rnd() * 3), spread = 0.85;
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1) - 0.5;
        const angle = ang + t * spread * 2 + uni(-0.1, 0.1);
        const nt = { ...tones, lit: i % 2 ? tones.lit : tones.shade };
        const dx = Math.cos(angle), dy = Math.sin(angle);
        blade({ bx: ax, by: ay, dx, dy, len: len * uni(0.7, 1), wid: 0.5 * k, minHalf: 0.5 * k, shape: PAINT_SHAPES.NEEDLE,
          tones: nt, face, fromFront, single: true });
      }
      return;
    }

    if (kind === "PALM") {
      // A frond: a drooping rib with narrow leaflets in pairs, swept toward the tip.
      const droop = 0.35;
      const rib = [];
      const steps = 8;
      let x = ax, y = ay, angle = ang;
      for (let s = 0; s <= steps; s++) {
        rib.push([x, y, angle]);
        x += Math.cos(angle) * len / steps;
        y += Math.sin(angle) * len / steps;
        angle += Math.atan2(Math.sin(Math.PI / 2 - angle), Math.cos(Math.PI / 2 - angle)) * droop / steps;
      }
      for (let s = 1; s < steps; s++) {
        const [px, py, pa] = rib[s];
        const leaflet = len * 0.42 * (1 - s / steps * 0.5);
        for (const side of [-1, 1]) one(px, py, pa + side * 0.9, leaflet, leaflet * 0.18, PAINT_SHAPES.LANCE);
      }
      for (let s = 0; s < steps; s++) {
        const [px, py, pa] = rib[s];
        const dx = Math.cos(pa), dy = Math.sin(pa);
        blade({ bx: px, by: py, dx, dy, len: len / steps + 0.5, wid: 0.5 * k, minHalf: 0.5 * k, shape: PAINT_SHAPES.RIB,
          tones: { ...tones, lit: tones.shade }, face, fromFront, single: true });
      }
      return;
    }

    if (kind === "TINY") {
      // Acacia: a few small round leaflets close together.
      const n = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const r = len * uni(0.2, 0.9), t = uni(0, Math.PI * 2);
        one(ax + Math.cos(t) * r, ay + Math.sin(t) * r, ang + uni(-1, 1), len * uni(0.7, 1), len * 0.4, PAINT_SHAPES.ROUND);
      }
      return;
    }

    one(ax, ay, ang, len, wid, shape);
  }

  // A jittered triangular grid of anchors inside the crown, top rows first so lower leaves are drawn over upper ones.
  function scatter(spacing, S, crown, fill, rnd, holes) {
    const pts = [];
    const rowStep = spacing * 0.866;
    const ox = rnd() * spacing, oy = rnd() * spacing;
    for (let gy = -spacing, row = 0; gy < S + spacing; gy += rowStep, row++) {
      for (let gx = -spacing + (row & 1) * spacing / 2; gx < S + spacing; gx += spacing) {
        const x = gx + ox + (rnd() - 0.5) * 0.7 * spacing, y = gy + oy + (rnd() - 0.5) * 0.7 * spacing;
        if (crown.norm(x, y) > fill) continue;
        if (rnd() < holes) continue;
        pts.push([x, y]);
      }
    }
    return pts.sort((a, b) => a[1] - b[1]);
  }

  // The block's outline in sprite pixels — top diamond (0,16)-(32,0)-(64,16)-(32,32), sides down to y 48 / 64 —
  // blended toward a circle by "round". norm is 1 on the outline, less inside.
  function crownShape(k, round) {
    const cx = 32 * k, cy = 32 * k;
    const hex = [[0, 16], [32, 0], [64, 16], [64, 48], [32, 64], [0, 48]].map(([x, y]) => [x * k, y * k]);
    const edges = hex.map((a, i) => {
      const b = hex[(i + 1) % hex.length];
      let nx = b[1] - a[1], ny = a[0] - b[0];
      const len = Math.hypot(nx, ny);
      nx /= len; ny /= len;
      if (nx * (cx - a[0]) + ny * (cy - a[1]) > 0) { nx = -nx; ny = -ny; }
      return { nx, ny, h: nx * (a[0] - cx) + ny * (a[1] - cy) };
    });
    const norm = (x, y) => {
      const dx = x - cx, dy = y - cy;
      let hx = 0;
      for (const e of edges) hx = Math.max(hx, (e.nx * dx + e.ny * dy) / e.h);
      return hx + (Math.hypot(dx, dy) / (32 * k) - hx) * round;
    };
    return {
      cx, cy, norm,
      inside: (x, y, clip) => norm(x, y) <= clip,
      faceOf: (x, y) => (y < (32 - Math.abs(x / k - 32) / 2) * k ? 0 : x < cx ? 1 : 2),
    };
  }

  // Vines, willow strands, mangrove roots: thin strands hanging from the crown's underside, with small leaves.
  function paintVines(spec, out, blade, rnd, uni, k, nTones, mainPal) {
    const S = out.size;
    const pal = tonePalette(scaleHex(spec.vineColor, 0.6), scaleHex(spec.vineColor, 1.35), nTones);
    const tones = { pal, lit: nTones - 2, shade: nTones - 3, rim: Math.max(0, nTones - 5) };
    const leafTones = { pal: mainPal, lit: nTones - 3, shade: nTones - 4, rim: Math.max(0, nTones - 5) };
    for (let i = 0; i < spec.vines; i++) {
      const x = Math.floor(uni(10, 54) * k);
      // From inside the crown: the lowest painted pixel of the column, a few pixels up.
      let y = S - 1;
      while (y > 0 && !out.mask[y * S + x]) y--;
      y = Math.max(0, y - Math.floor(uni(2, 8) * k));
      const len = spec.vineLength * 24 * k * uni(0.5, 1);
      blade({ bx: x + 0.5, by: y, dx: uni(-0.08, 0.08), dy: 1, len, wid: 0.5 * k, minHalf: 0.5 * k, shape: PAINT_SHAPES.RIB,
        tones, face: 1, fromFront: 0, single: true, free: true });
      for (let s = 3 * k, side = 1; s < len; s += uni(2.5, 4) * k, side = -side) {
        const a = Math.PI / 2 + side * 0.9;
        const l = spec.length * k * 0.5;
        blade({ bx: x + 0.5, by: y + s, dx: Math.cos(a), dy: Math.sin(a), len: l, wid: l * 0.3, shape: PAINT_SHAPES.LANCE,
          tones: leafTones, face: 1, fromFront: 0, free: true });
      }
    }
  }

  // Blossoms: small five-pixel flowers over the front leaves, more of them toward the top.
  function paintBlossoms(spec, out, put, crown, rnd, k) {
    const S = out.size;
    const petal = hexRgb(spec.blossomColor), centre = hexRgb(spec.blossomCenter);
    const shade = petal.map((c) => Math.round(c * 0.8));
    const count = Math.round(spec.blossoms * 0.6);
    for (let i = 0; i < count; i++) {
      const x = Math.floor(rnd() * S), y = Math.floor(Math.pow(rnd(), 1.4) * S);
      if (crown.norm(x, y) > 0.9 || !out.mask[y * S + x]) continue;
      const face = crown.faceOf(x, y);
      const r = Math.max(1, Math.round(k));
      for (const [dx, dy, c] of [[0, -r, petal], [-r, 0, petal], [r, 0, shade], [0, r, shade], [0, 0, centre]]) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < S && Y < S) put(X, Y, c, face, 0, false);
      }
    }
  }

  function writePixel(out, kk, rgb, n, depth, ao) {
    out.color[kk] = rgb[0]; out.color[kk + 1] = rgb[1]; out.color[kk + 2] = rgb[2]; out.color[kk + 3] = 255;
    const g = Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
    out.gray[kk] = out.gray[kk + 1] = out.gray[kk + 2] = g; out.gray[kk + 3] = 255;
    out.normal[kk] = Math.round((dot(n, RIGHT) * 0.5 + 0.5) * 255);
    out.normal[kk + 1] = Math.round((dot(n, UP) * 0.5 + 0.5) * 255);
    out.normal[kk + 2] = Math.round((dot(n, BACK) * 0.5 + 0.5) * 255);
    out.normal[kk + 3] = 255;
    out.depth[kk] = out.depth[kk + 1] = out.depth[kk + 2] = depth; out.depth[kk + 3] = 255;
    out.ao[kk] = out.ao[kk + 1] = out.ao[kk + 2] = ao; out.ao[kk + 3] = 255;
  }

  function scaleHex(hex, f) {
    return "#" + hexRgb(hex).map((c) => Math.max(0, Math.min(255, Math.round(c * f))).toString(16).padStart(2, "0")).join("");
  }

  // n tones from dark to light in sRGB, eased toward both ends — six of them land on the hand-made reference's own
  // (99, 113, 134, 158, 176, 185) from its darkest and lightest.
  function tonePalette(darkHex, lightHex, n) {
    const a = hexRgb(darkHex), b = hexRgb(lightHex);
    return Array.from({ length: n }, (_, i) => {
      const u = i / (n - 1), t = Math.pow(u * u * (3 - 2 * u), 0.9);
      return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * t));
    });
  }

  function hexRgb(hex) {
    const h = String(hex || "#808080").replace("#", "");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  }

  function mulberry(a) {
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Multipart ────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Cuts a plant into cells stacked one block height apart: part k keeps what lies between z = k·H and (k+1)·H
   * (the bottom part also keeps anything under the ground, the top part anything above), clipped exactly at the cut
   * so the parts meet without a gap, and moved down into the first cell so each renders with the same camera.
   * Returns [{ pos, col, offset }] bottom first; offset is the z each part was moved down by.
   */
  function split(mesh, cells) {
    const H = Aura.blockEngine.BLOCK_HEIGHT;
    const parts = [];
    for (let k = 0; k < cells; k++) {
      const lo = k === 0 ? -Infinity : k * H, hi = k === cells - 1 ? Infinity : (k + 1) * H;
      const pos = [], col = [];
      for (let t = 0; t < mesh.pos.length; t += 9) {
        let poly = [0, 1, 2].map((v) => ({ p: [mesh.pos[t + v * 3], mesh.pos[t + v * 3 + 1], mesh.pos[t + v * 3 + 2]], c: [mesh.col[t + v * 3], mesh.col[t + v * 3 + 1], mesh.col[t + v * 3 + 2]] }));
        if (lo > -Infinity) poly = clip(poly, (q) => q[2] - lo);
        if (hi < Infinity && poly.length) poly = clip(poly, (q) => hi - q[2]);
        for (let i = 1; i < poly.length - 1; i++) {
          for (const v of [poly[0], poly[i], poly[i + 1]]) {
            pos.push(v.p[0], v.p[1], v.p[2] - k * H);
            col.push(v.c[0], v.c[1], v.c[2]);
          }
        }
      }
      parts.push({ pos: Float32Array.from(pos), col: Float32Array.from(col), offset: k * H });
    }
    return parts;
  }

  /** Sutherland–Hodgman against one plane: keeps the side where side(p) ≥ 0, colours interpolated at the cut. */
  function clip(poly, side) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = side(a.p), db = side(b.p);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push({ p: a.p.map((v, j) => v + (b.p[j] - v) * t), c: a.c.map((v, j) => v + (b.c[j] - v) * t) });
      }
    }
    return out;
  }

  /** A mesh moved down by dz (the occluders seen from one part's cell). */
  function lowered(mesh, dz) {
    if (!dz) return mesh;
    const pos = Float32Array.from(mesh.pos);
    for (let j = 2; j < pos.length; j += 3) pos[j] -= dz;
    return { pos, col: mesh.col };
  }

  /**
   * Renders every part of a plant: [{ size, color, normal, … }] bottom first. A one-cell plant gives one part.
   * ground: the z the plant stands on.
   */
  function renderParts(mesh, opts, ground, cells) {
    if (mesh.painted) return [paintLeaves(mesh.painted, opts)];
    if (cells <= 1) return [render(mesh, opts, ground)];
    return split(mesh, cells).map((part) => render(part, opts, ground - part.offset, lowered(mesh, part.offset)));
  }

  Aura.plantRaster = { DEFAULTS, merge, render, renderParts, split, paintLeaves };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
