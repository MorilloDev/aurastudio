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
      }
    }

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
    if (cells <= 1) return [render(mesh, opts, ground)];
    return split(mesh, cells).map((part) => render(part, opts, ground - part.offset, lowered(mesh, part.offset)));
  }

  Aura.plantRaster = { DEFAULTS, merge, render, renderParts, split };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
