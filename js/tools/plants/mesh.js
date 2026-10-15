"use strict";

// Plant mesh building for the Plantas tool: a JavaScript port of the MeshBuilder of the Stylized Foliage Generator
// add-on (tubes, ribbons, leaves, blobs, prisms), producing plain triangles with a colour per corner. Colours are kept
// linear like Blender's, and turned to sRGB only when the sprite is written. No DOM: runs in the page and under Node.
(function (Aura) {
  // ── Vectors ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    norm(a) {
      const l = Math.hypot(a[0], a[1], a[2]);
      return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
    },
    /** Rotation of v about a unit axis by angle (Rodrigues). */
    rot(v, axis, angle) {
      const c = Math.cos(angle), s = Math.sin(angle);
      const k = V.dot(axis, v) * (1 - c);
      const x = V.cross(axis, v);
      return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
    },
  };
  const UP = [0, 0, 1];

  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };

  /** Deterministic random generator with the helpers the generators use (Python's random.Random, more or less). */
  function rng(seed) {
    let a = (Math.floor(seed) >>> 0) || 1;
    const next = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      random: next,
      uniform: (lo, hi) => lo + (hi - lo) * next(),
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      choice: (list) => list[Math.floor(next() * list.length)],
    };
  }

  // ── Colour ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
  /** "#rrggbb" → linear [r, g, b]. */
  function hexToLinear(hex) {
    const n = parseInt(String(hex).replace("#", ""), 16) || 0;
    return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
  }
  /** Linear [r, g, b] → "#rrggbb", for the colour pickers. */
  function linearToHex(c) {
    return "#" + c.map((v) => Math.round(clamp01(toSrgb(v)) * 255).toString(16).padStart(2, "0")).join("");
  }

  function rgbToHsv([r, g, b]) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 1e-9) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return [h, mx > 0 ? d / mx : 0, mx];
  }
  function hsvToRgb([h, s, v]) {
    const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  }
  /** Varies a colour in HSV so a variation keeps its hue family instead of drifting grey (as in the add-on). */
  function jitterColor(r, base, amount) {
    if (amount <= 0) return base.slice();
    let [h, s, v] = rgbToHsv(base);
    h = (h + r.uniform(-amount, amount) * 0.15 + 1) % 1;
    s = clamp01(s + r.uniform(-amount, amount) * 0.6);
    v = clamp01(v + r.uniform(-amount, amount) * 0.8);
    return hsvToRgb([h, s, v]);
  }
  const gradient = (c0, c1, n) => Array.from({ length: n }, (_, i) => V.lerp(c0, c1, i / Math.max(1, n - 1)));

  // ── Noise ────────────────────────────────────────────────────────────────────────────────────────────────────────
  // Smooth 3D value noise in -1..1, enough for mottling; Blender's Perlin is not reproduced exactly, only its look.
  function hash3(x, y, z) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296 * 2 - 1;
  }
  function noise3(p) {
    const x0 = Math.floor(p[0]), y0 = Math.floor(p[1]), z0 = Math.floor(p[2]);
    const fx = p[0] - x0, fy = p[1] - y0, fz = p[2] - z0;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    let out = 0;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const k = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
      out += k * hash3(x0 + dx, y0 + dy, z0 + dz);
    }
    return out;
  }

  /** 0..1, 1 right on a crack: the borders between Voronoi cells, the pattern dry mud or stone breaks into. */
  function crack(p, scale, width, seed) {
    if (width <= 0) return 0;
    const q = [p[0] * scale + seed * 13.1, p[1] * scale + seed * 7.7, p[2] * scale + seed * 3.3];
    const b = q.map(Math.floor);
    let f1 = Infinity, f2 = Infinity;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = b[0] + dx, cy = b[1] + dy, cz = b[2] + dz;
      const fx = cx + (hash3(cx, cy, cz) * 0.5 + 0.5), fy = cy + (hash3(cy, cz, cx) * 0.5 + 0.5), fz = cz + (hash3(cz, cx, cy) * 0.5 + 0.5);
      const d = Math.hypot(q[0] - fx, q[1] - fy, q[2] - fz);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return clamp01(1 - (f2 - f1) / width);
  }

  // ── Paths ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A unit vector perpendicular to t, preferring horizontal so a vertical stem gets an X/Y frame. */
  function anyPerp(t) {
    const ref = Math.abs(V.dot(t, UP)) < 0.95 ? UP : [1, 0, 0];
    const p = V.cross(t, ref);
    return V.len(p) > 1e-8 ? V.norm(p) : [1, 0, 0];
  }

  function tangents(path) {
    const n = path.length;
    return path.map((_, i) => {
      const d = V.sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)]);
      return V.len(d) > 1e-9 ? V.norm(d) : UP.slice();
    });
  }

  /** Parallel-transport frames along a path, so a leaning stem keeps round sections. */
  function frames(path, firstNormal = null) {
    const tans = tangents(path);
    let n = firstNormal ? firstNormal.slice() : anyPerp(tans[0]);
    const out = [];
    for (const t of tans) {
      n = V.sub(n, V.mul(t, V.dot(n, t)));
      n = V.len(n) > 1e-8 ? V.norm(n) : anyPerp(t);
      out.push([t, n, V.norm(V.cross(t, n))]);
    }
    return out;
  }

  function bezierPath(p0, p1, p2, segments) {
    const pts = [];
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      pts.push(V.lerp(V.lerp(p0, p1, t), V.lerp(p1, p2, t), t));
    }
    return pts;
  }

  /** Stem / blade path leaning leanDeg from vertical toward direction and bending further near the tip. */
  function arcPath(base, direction, height, leanDeg, bend, segments) {
    let d = [direction[0], direction[1], 0];
    d = V.len(d) > 1e-8 ? V.norm(d) : [1, 0, 0];
    const lean = leanDeg * Math.PI / 180;
    const tipAngle = Math.min(170 * Math.PI / 180, lean + bend * 70 * Math.PI / 180);
    const mid = V.add(base, V.mul(V.add(V.mul(UP, Math.cos(lean)), V.mul(d, Math.sin(lean))), height * 0.55));
    const tip = V.add(mid, V.mul(V.add(V.mul(UP, Math.cos(tipAngle)), V.mul(d, Math.sin(tipAngle))), height * 0.5));
    return bezierPath(base, mid, tip, segments);
  }

  /** Rotation taking local +Z to axis, as a function on local vectors. */
  function headMatrix(axis) {
    const z = V.norm(axis);
    const x = anyPerp(z);
    const y = V.norm(V.cross(z, x));
    return (v) => [x[0] * v[0] + y[0] * v[1] + z[0] * v[2], x[1] * v[0] + y[1] * v[1] + z[1] * v[2], x[2] * v[0] + y[2] * v[1] + z[2] * v[2]];
  }

  function leafProfile(shape, t) {
    if (shape === "ROUND") return Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.05)), 0.7);
    if (shape === "HEART") return Math.sin(Math.PI * Math.pow(t, 0.75)) * (1.15 - 0.3 * t);
    if (shape === "BLADE") return Math.max(0, 1 - Math.pow(t, 1.6));
    if (shape === "NEEDLE") return Math.max(0, 1 - t);
    return Math.sin(Math.PI * Math.pow(t, 0.8));
  }

  // ── Mesh builder ─────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Collects triangles: positions (flat xyz), colours (flat linear rgb, one per corner) and, per triangle, whether it is
   * part of a closed shape (normals point outward) or a thin sheet (seen from either side).
   * p: the plant options (wilt, leaf details, minimum width, base AO); see generators.js.
   */
  class MeshBuilder {
    constructor(p) {
      this.p = p;
      this.pos = [];
      this.col = [];
      this.rng = rng(1);
      this.aoStrength = p.aoBase;
      this.aoHeight = Math.max(0.001, p.aoBaseHeight);
      this.zGround = 0;
      // Half the minimum width: a blade thinner than a sprite pixel would vanish or flicker between renders.
      this.minWidth = p.minWidthPx > 0 ? p.minWidthPx / 45.25 * 0.5 : 0;
      this.dryColor = p.dryColorL;
    }

    get triangleCount() { return this.pos.length / 9; }

    /** Ground contact darkening baked into the colour, like the add-on: a plant's base reads as growing out of soil. */
    shade(c, z) {
      if (this.aoStrength <= 0) return c;
      const k = clamp01((z - this.zGround) / this.aoHeight);
      return V.mul(c, lerp(1 - this.aoStrength, 1, smooth(k)));
    }

    width(w) { return Math.max(w, this.minWidth, 0.0004); }

    tri(a, b, c, ca, cb, cc) {
      this.pos.push(...a, ...b, ...c);
      const sa = this.shade(ca, a[2]), sb = this.shade(cb, b[2]), sc = this.shade(cc, c[2]);
      this.col.push(...sa, ...sb, ...sc);
    }

    /** Quad or triangle; a zero-length edge (a pointed tip) becomes one triangle instead of a degenerate quad. */
    quad(a, b, c, d, ca, cb, cc, cd) {
      const same = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 1e-9;
      if (same(c, d)) { this.tri(a, b, c, ca, cb, cc); return; }
      if (same(a, b)) { this.tri(a, c, d, ca, cc, cd); return; }
      this.tri(a, b, c, ca, cb, cc);
      this.tri(a, c, d, ca, cc, cd);
    }

    poly(points, color) {
      for (let i = 1; i < points.length - 1; i++) this.tri(points[0], points[i], points[i + 1], color, color, color);
    }

    // ── tubes ──

    /** Stem along a path. flatten squashes the section into a blade (still solid); twist turns it along the length. */
    tube(path, widths, sides, colors, { capTip = true, capBase = false, firstNormal = null, flatten = 0, twist = 0 } = {}) {
      sides = Math.max(3, sides);
      const fr = frames(path, firstNormal);
      const last = Math.max(1, path.length - 1);
      const rings = path.map((p, i) => {
        let [t, n, b] = fr[i];
        if (twist) { n = V.rot(n, t, twist * i / last); b = V.rot(b, t, twist * i / last); }
        const w = this.width(widths[i]);
        const thin = flatten > 0 ? Math.max(this.width(widths[i] * (1 - flatten)), w * 0.15) : w;
        return Array.from({ length: sides }, (_, k) => {
          const a = 2 * Math.PI * k / sides;
          return V.add(p, V.add(V.mul(n, Math.cos(a) * w), V.mul(b, Math.sin(a) * thin)));
        });
      });
      for (let i = 0; i < rings.length - 1; i++) {
        for (let k = 0; k < sides; k++) {
          const j = (k + 1) % sides;
          this.quad(rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k], colors[i], colors[i], colors[i + 1], colors[i + 1]);
        }
      }
      if (capTip) this.poly(rings[rings.length - 1], colors[colors.length - 1]);
      if (capBase) this.poly(rings[0].slice().reverse(), colors[0]);
      return rings;
    }

    // ── leaves / ribbons ──

    /** Dry tip, or now and then a whole dead leaf, blended into a leaf's colours from base to tip. */
    leafColors(colors) {
      const p = this.p, r = this.rng;
      const dead = r.random() < p.dryLeafChance;
      const tip = p.tipDry * r.uniform(0.4, 1);
      const span = Math.max(1e-3, p.tipDryLength);
      return colors.map((c, i) => {
        const t = i / Math.max(1, colors.length - 1);
        const k = dead ? 0.85 : tip * smooth((t - (1 - span)) / span);
        return V.lerp(c, this.dryColor, clamp01(k));
      });
    }

    /**
     * Flat or V-folded strip along a path (blades, leaves, petals). sideRef sets which way it spreads; fold lifts the
     * midrib so a leaf reads as a leaf at 64 px. details "LEAF" / "PETAL" turns on the life details.
     */
    ribbon(path, widths, sideRef, colors, { fold = 0, centerColors = null, details = "NONE" } = {}) {
      const p = this.p;
      const count = path.length;
      const tans = tangents(path);
      colors = colors.slice();
      const wl = widths.slice(), wr = widths.slice();
      let twist = 0, ruffle = 0, phase = 0, vein = 0, edge = 0;
      if (details !== "NONE") {
        const r = this.rng;
        phase = r.uniform(0, 2 * Math.PI);
        if (details === "LEAF") {
          colors = this.leafColors(colors);
          twist = p.leafTwist * Math.PI / 180 * r.uniform(-1, 1);
          if (r.random() < p.biteChance) {
            const t0 = r.uniform(0.3, 0.85), size = r.uniform(0.6, 0.95);
            const side = r.random() < 0.5 ? wl : wr;
            for (let i = 0; i < count; i++) {
              const t = i / Math.max(1, count - 1);
              side[i] *= 1 - size * Math.exp(-(((t - t0) / 0.13) ** 2));
            }
          }
          ruffle = p.leafRuffle; vein = p.veinStrength;
        } else {
          ruffle = p.petalRuffle; vein = p.petalVein;
        }
        edge = p.edgeDarken;
      }
      if (!centerColors && Math.abs(vein) > 1e-4) centerColors = colors.map((c) => V.mul(c, 1 + vein));
      const edgeColors = edge > 1e-4 ? colors.map((c) => V.mul(c, 1 - edge)) : colors;
      const L = [], C = [], R = [];
      const freq = 2 * Math.PI * Math.max(0.5, p.ruffleWaves);
      for (let i = 0; i < count; i++) {
        const t = tans[i];
        const u = i / Math.max(1, count - 1);
        let s = V.sub(sideRef, V.mul(t, V.dot(sideRef, t)));
        s = V.len(s) > 1e-8 ? V.norm(s) : anyPerp(t);
        if (twist) s = V.rot(s, t, twist * u);
        const n = V.norm(V.cross(t, s));
        const wL = wl[i] > 0 ? this.width(wl[i]) : 0, wR = wr[i] > 0 ? this.width(wr[i]) : 0;
        const w = Math.max(wL, wR);
        const rl = Math.sin(u * freq + phase) * ruffle * wL;
        const rr = Math.sin(u * freq + phase + Math.PI) * ruffle * wR;
        L.push(V.add(V.sub(path[i], V.mul(s, wL)), V.mul(n, rl)));
        C.push(V.add(path[i], V.mul(n, fold * w)));
        R.push(V.add(V.add(path[i], V.mul(s, wR)), V.mul(n, rr)));
      }
      const cc = centerColors || colors;
      for (let i = 0; i < count - 1; i++) {
        this.quad(L[i], C[i], C[i + 1], L[i + 1], edgeColors[i], cc[i], cc[i + 1], edgeColors[i + 1]);
        this.quad(C[i], R[i], R[i + 1], C[i + 1], cc[i], edgeColors[i], edgeColors[i + 1], cc[i + 1]);
      }
      return { L, C, R };
    }

    /** One leaf from base toward direction, rising by lift and drooping at the tip; wilt adds droop to every leaf. */
    leaf(base, direction, length, width, colors, { lift = 0.3, droop = 0.2, fold = 0.35, shape = "LANCE", segments = null } = {}) {
      segments = segments || this.p.leafSegments;
      droop += this.p.wilt;
      const d = V.norm(direction);
      const horiz = [d[0], d[1], 0];
      const side = V.len(horiz) > 1e-6 ? V.norm(V.cross(UP, horiz)) : [1, 0, 0];
      const p1 = V.add(V.add(base, V.mul(d, length * 0.5)), V.mul(UP, length * lift));
      const p2 = V.add(V.add(base, V.mul(d, length)), V.mul(UP, length * (lift - droop)));
      const path = bezierPath(base, p1, p2, segments);
      const widths = path.map((_, s) => width * leafProfile(shape, s / segments));
      const cols = path.map((_, s) => V.lerp(colors[0], colors[1], s / segments));
      return this.ribbon(path, widths, side, cols, { fold, details: "LEAF" });
    }

    // ── solids ──

    /** Icosphere with radial noise — tubers, berries, buds, flower centres. colorFn(point, normal) -> colour. */
    blob(center, radius, colorFn, r, { subdiv = 2, noise = 0, squash = [1, 1, 1], orient = null, displace = null } = {}) {
      const { verts, faces } = icosphere(subdiv);
      const pts = verts.map((v) => {
        let d = V.mul(v, radius);
        if (noise > 0) d = V.mul(d, 1 + r.uniform(-noise, noise));
        d = [d[0] * squash[0], d[1] * squash[1], d[2] * squash[2]];
        if (orient) d = orient(d);
        let q = V.add(center, d);
        // displace(point, outward) pushes a vertex along its outward direction (cracks carved into a rock).
        if (displace) q = V.add(q, V.mul(V.norm(d), displace(q, V.norm(d))));
        return q;
      });
      const cols = pts.map((q) => colorFn(q, V.norm(V.sub(q, center))));
      for (const [a, b, c] of faces) this.tri(pts[a], pts[b], pts[c], cols[a], cols[b], cols[c]);
      return pts;
    }

    /**
     * Cubes on a grid: cells is a Set of "i,j,k" keys; only faces between a filled and an empty cell are built, so a
     * voxel rock costs its surface. colorFn(cell [i, j, k], direction index 0..5) -> colour.
     */
    voxels(cells, origin, size, colorFn) {
      const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      const h = size / 2;
      for (const key of cells) {
        const c = key.split(",").map(Number);
        const centre = [origin[0] + (c[0] + 0.5) * size, origin[1] + (c[1] + 0.5) * size, origin[2] + (c[2] + 0.5) * size];
        DIRS.forEach((d, di) => {
          if (cells.has(`${c[0] + d[0]},${c[1] + d[1]},${c[2] + d[2]}`)) return;
          const ax = d[0] ? 0 : d[1] ? 1 : 2;
          const [a1, a2] = [0, 1, 2].filter((a) => a !== ax).map((a) => { const e = [0, 0, 0]; e[a] = 1; return e; });
          const fc = V.add(centre, V.mul(d, h));
          const corner = (s1, s2) => V.add(fc, V.add(V.mul(a1, s1 * h), V.mul(a2, s2 * h)));
          const col = colorFn(c, di);
          this.quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), col, col, col, col);
        });
      }
    }

    /** Multiplies the colours of every triangle built since triangle index first by its own random factor. */
    facetShade(first, r, amount) {
      if (amount <= 0) return;
      for (let t = first; t < this.triangleCount; t++) {
        const k = 1 + r.uniform(-amount, amount);
        for (let i = t * 9; i < t * 9 + 9; i++) this.col[i] *= k;
      }
    }

    /** Pointed grain / crystal: a straight prism ending in a pyramid. */
    prism(base, axis, length, radius, sides, colorBase, colorTip, tipRatio = 0.3, twist = 0) {
      axis = V.norm(axis);
      const n = anyPerp(axis);
      const b = V.norm(V.cross(axis, n));
      const body = length * (1 - tipRatio);
      const r0 = [], r1 = [];
      for (let k = 0; k < sides; k++) {
        const a = 2 * Math.PI * k / sides + twist;
        const off = V.mul(V.add(V.mul(n, Math.cos(a)), V.mul(b, Math.sin(a))), Math.max(radius, this.minWidth));
        r0.push(V.add(base, off));
        r1.push(V.add(V.add(base, V.mul(axis, body)), off));
      }
      const tip = V.add(base, V.mul(axis, length));
      const mid = V.lerp(colorBase, colorTip, 0.6);
      for (let k = 0; k < sides; k++) {
        const j = (k + 1) % sides;
        this.quad(r0[k], r0[j], r1[j], r1[k], colorBase, colorBase, mid, mid);
        this.tri(r1[k], r1[j], tip, mid, mid, colorTip);
      }
      this.poly(r0.slice().reverse(), colorBase);
    }
  }

  // Unit icospheres, cached per subdivision level.
  const icoCache = new Map();
  function icosphere(subdiv) {
    if (icoCache.has(subdiv)) return icoCache.get(subdiv);
    const t = (1 + Math.sqrt(5)) / 2;
    let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(V.norm);
    let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6],
      [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let s = 0; s < subdiv; s++) {
      const mids = new Map();
      const mid = (a, b) => {
        const key = a < b ? a + "_" + b : b + "_" + a;
        if (!mids.has(key)) { verts.push(V.norm(V.lerp(verts[a], verts[b], 0.5))); mids.set(key, verts.length - 1); }
        return mids.get(key);
      };
      faces = faces.flatMap(([a, b, c]) => {
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
      });
    }
    const out = { verts, faces };
    icoCache.set(subdiv, out);
    return out;
  }

  Aura.plantMesh = {
    V, UP, clamp01, lerp, smooth, rng, noise3, crack,
    hexToLinear, linearToHex, toSrgb, jitterColor, gradient,
    anyPerp, tangents, frames, bezierPath, arcPath, headMatrix, leafProfile,
    MeshBuilder,
  };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
