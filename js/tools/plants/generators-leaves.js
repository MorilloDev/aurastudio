"use strict";

// Leaves and seeds for the Crear tab. Leaves come in three forms — a leaf block (a tree's canopy cube, kept inside the
// block so it tiles with its neighbours), leaves lying on the ground, and a pile — each with the species presets (oak,
// birch, pine, spruce, five jungle kinds, acacia, dark oak, cherry, mangrove, willow, autumn, dead). Seeds are the item
// a crop is planted from: grains, flat seeds, kernels or a seed potato, as a small pile, scattered, or in a pouch.
// Registers into Aura.plantGen; no DOM, so it also runs under Node.
(function (Aura) {
  const G = Aura.plantGen;
  const M = Aura.plantMesh;
  const { V, UP, clamp01, jitterColor, anyPerp, noise3 } = M;
  const { L } = G.helpers;

  const blockH = () => Aura.blockEngine.BLOCK_HEIGHT;

  // Leaf outlines: half-width along the leaf (t = 0 at the stalk, 1 at the tip), before the width option.
  const OUTLINES = {
    LOBED: (t) => Math.sin(Math.PI * Math.pow(t, 0.8)) * (0.7 + 0.3 * Math.abs(Math.cos(t * Math.PI * 3.5))),
    OVAL: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.05)), 0.7),
    ROUND: (t) => Math.pow(Math.sin(Math.PI * t), 0.5),
    LANCE: (t) => Math.sin(Math.PI * Math.pow(t, 0.8)),
    NARROW: (t) => 0.9 * Math.sin(Math.PI * Math.pow(t, 0.7)),
    HEART: (t) => Math.sin(Math.PI * Math.pow(t, 0.75)) * (1.15 - 0.3 * t),
    // Monstera: a heart cut by slits from the edge toward the rib.
    SPLIT: (t) => {
      const w = Math.sin(Math.PI * Math.pow(t, 0.75)) * (1.15 - 0.3 * t);
      return t > 0.22 && t < 0.92 && (t * 6) % 1 < 0.3 ? w * 0.22 : w;
    },
    TINY: (t) => Math.sin(Math.PI * t),
  };

  // ── Pieces ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A flat leaf from base along dir, lying in the plane whose normal is normal; curl bends it toward that normal (a
   * cupped leaf), fold creases it along the rib.
   */
  function flatLeaf(mb, base, dir, normal, length, width, c0, c1, shape, curl, fold, seg = 4) {
    const d = V.norm(dir);
    let n = V.sub(normal, V.mul(d, V.dot(normal, d)));
    n = V.len(n) > 1e-6 ? V.norm(n) : anyPerp(d);
    const side = V.norm(V.cross(d, n));
    const outline = OUTLINES[shape] ?? OUTLINES.LANCE;
    const path = [], widths = [], cols = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      path.push(V.add(V.add(base, V.mul(d, length * t)), V.mul(n, length * curl * 0.45 * t * t)));
      widths.push(Math.max(0, outline(t)) * width * 0.5);
      cols.push(V.lerp(c0, c1, t));
    }
    mb.ribbon(path, widths, side, cols, { fold, details: "LEAF" });
  }

  /** Pine / spruce: a green rib with needles fanned around it. */
  function needleSpray(mb, base, dir, normal, length, c0, c1, r, needles = 9) {
    const d = V.norm(dir);
    const tip = V.add(base, V.mul(d, length));
    mb.tube([base, tip], [length * 0.03, length * 0.015], 3, [V.mul(c0, 0.7), c0], { capTip: false });
    for (let k = 0; k < needles; k++) {
      const t = 0.15 + 0.85 * k / Math.max(1, needles - 1);
      const at = V.lerp(base, tip, t);
      const around = V.rot(V.len(V.cross(d, normal)) > 1e-6 ? V.norm(V.cross(d, normal)) : anyPerp(d), d, k * 2.39996 + r.uniform(-0.3, 0.3));
      const nd = V.norm(V.add(V.mul(d, 0.55), V.add(around, V.mul(normal, 0.35))));
      const nl = length * 0.42 * (1 - 0.35 * t);
      mb.tube([at, V.add(at, V.mul(nd, nl))], [length * 0.012, length * 0.004], 3, [c0, c1], { capTip: false });
    }
  }

  /** Palm or fern frond: a drooping rib with narrow leaflets in pairs. */
  function frond(mb, base, dir, length, c0, c1, r, pinnae = 9) {
    const d = V.norm([dir[0], dir[1], 0]);
    const p1 = V.add(V.add(base, V.mul(d, length * 0.45)), V.mul(UP, length * 0.18));
    const p2 = V.add(V.add(base, V.mul(d, length)), V.mul(UP, -length * 0.25));
    const path = M.bezierPath(base, p1, p2, 6);
    mb.tube(path, path.map((_, i) => length * 0.014 * (1 - 0.6 * i / 6)), 3, path.map((_, i) => V.lerp(V.mul(c0, 0.8), c0, i / 6)), { capTip: false });
    const tans = M.tangents(path);
    for (let k = 0; k < pinnae; k++) {
      const t = (k + 1) / (pinnae + 1), i = Math.min(5, Math.floor(t * 6));
      const at = V.lerp(path[i], path[i + 1], t * 6 - i);
      let side = V.cross(tans[i], UP);
      side = V.len(side) > 1e-6 ? V.norm(side) : anyPerp(tans[i]);
      const size = length * 0.32 * (1 - 0.55 * t) * r.uniform(0.85, 1.1);
      for (const s of [-1, 1]) {
        const ld = V.norm(V.add(V.mul(side, s), V.add(V.mul(tans[i], 0.45), V.mul(UP, -0.25))));
        flatLeaf(mb, at, ld, UP, size, size * 0.22, c0, c1, "NARROW", 0.15, 0.25, 3);
      }
    }
  }

  /** Five petals round a centre, facing normal (cherry blossom). */
  function blossom(mb, centre, normal, size, petal, middle, r) {
    const n = V.norm(normal);
    const a0 = anyPerp(n);
    for (let k = 0; k < 5; k++) {
      const d = V.rot(a0, n, k * 2 * Math.PI / 5 + r.uniform(-0.2, 0.2));
      flatLeaf(mb, centre, V.norm(V.add(d, V.mul(n, 0.25))), n, size, size * 0.9, V.mul(petal, 0.92), petal, "ROUND", 0.3, 0.1, 3);
    }
    mb.blob(V.add(centre, V.mul(n, size * 0.15)), size * 0.22, () => middle, r, { subdiv: 0 });
  }

  // The colour of one leaf: the species' base → tip pair, sometimes its second colour (autumn mixes, dead patches).
  function leafColors(p, r) {
    const alt = p.leafAltChance > 0 && r.random() < p.leafAltChance;
    const c0 = jitterColor(r, alt ? V.mul(p.leafAltColorL, 0.8) : p.leafColorL, p.colorVariation);
    const c1 = jitterColor(r, alt ? p.leafAltColorL : p.leafTipColorL, p.colorVariation);
    return [c0, c1];
  }

  /** One leaf of the species' shape at base, facing normal, pointing along dir. */
  function speciesLeaf(mb, p, r, base, dir, normal) {
    const size = p.leafSize * (1 + r.uniform(-p.leafSizeVar, p.leafSizeVar));
    const [c0, c1] = leafColors(p, r);
    if (p.leafShape === "NEEDLE") { needleSpray(mb, base, dir, normal, size, c0, c1, r); return; }
    if (p.leafShape === "PALM") { frond(mb, base, dir, size, c0, c1, r); return; }
    const start = V.sub(base, V.mul(V.norm(dir), size * 0.35));
    flatLeaf(mb, start, dir, normal, size, size * p.leafWidth, c0, c1, p.leafShape, p.leafCurl, p.leafFold);
  }

  // ── Leaf forms ───────────────────────────────────────────────────────────────────────────────────────────────────

  // The canopy volume, in units where the block is [-1, 1] on every axis: a box whose corners round off with blockRound.
  function insideCanopy(q, round) {
    const rr = Math.max(1e-3, round);
    const ex = Math.max(Math.abs(q[0]) - (1 - rr), 0), ey = Math.max(Math.abs(q[1]) - (1 - rr), 0), ez = Math.max(Math.abs(q[2]) - (1 - rr), 0);
    return Math.hypot(ex, ey, ez) <= rr && Math.abs(q[0]) <= 1 && Math.abs(q[1]) <= 1 && Math.abs(q[2]) <= 1;
  }

  /**
   * Leaf block: leaves through the block, most of them near its skin and facing out, inside a box whose corners round
   * off; noise opens holes; a dark core hides what would be seen through. Every vertex is then kept inside the block,
   * so the sprite is exactly a block wherever the leaves are dense and neighbouring leaf blocks join.
   */
  function genLeafBlock(mb, p, r) {
    const H = blockH(), half = [0.5, 0.5, H / 2], centre = [0, 0, H / 2];
    const first = mb.pos.length;
    const toWorld = (q) => [q[0] * half[0], q[1] * half[1], centre[2] + q[2] * half[2]];
    if (p.blockCore > 0) coreBox(mb, half, centre, p.blockCore, p.coreColorL);
    for (let i = 0; i < p.leafCount; i++) {
      let q;
      for (let t = 0; t < 30; t++) {
        q = [r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-1, 1)];
        if (insideCanopy(q, p.blockRound)) break;
      }
      // Pushed out to the skin (minus a little): leaves inside a dense block are never seen.
      if (r.random() < p.blockShell) {
        let lo = 1, hi = 3;
        for (let it = 0; it < 12; it++) {
          const mid = (lo + hi) / 2;
          if (insideCanopy(V.mul(q, mid), p.blockRound)) lo = mid; else hi = mid;
        }
        q = V.mul(q, lo * (1 - r.uniform(0, 0.12)));
      }
      const w = toWorld(q);
      if (p.blockHoles > 0 && noise3([w[0] * 6 + p.seed, w[1] * 6, w[2] * 6]) > 1 - p.blockHoles * 1.6) continue;
      // Facing out: the box face it is nearest to, rounded toward the centre as the corners round.
      const a = q.map(Math.abs), axis = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
      const flat = [0, 0, 0];
      flat[axis] = Math.sign(q[axis]) || 1;
      const normal = V.norm(V.lerp(flat, V.norm(q), p.blockRound));
      let dir = V.rot(anyPerp(normal), normal, r.uniform(0, 2 * Math.PI));
      dir = V.norm(V.add(dir, V.mul(normal, p.leafTilt)));
      if (p.leafHang > 0) dir = V.norm(V.lerp(dir, [0, 0, -1], p.leafHang));
      speciesLeaf(mb, p, r, w, dir, normal);
    }
    for (let i = 0; i < p.blossomCount; i++) {
      const q = [r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-0.2, 1)];
      const s = Math.max(Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2]));
      const at = toWorld(V.mul(q, 0.97 / Math.max(1e-6, s)));
      blossom(mb, at, V.norm(q), p.blossomSize, p.blossomColorL, p.blossomCenterColorL, r);
    }
    hangingStrands(mb, p, r, half, centre);
    clampToBlock(mb.pos, first, H);
  }

  // Vines, willow strands, mangrove propagules: from the top edge down the outside of the block.
  function hangingStrands(mb, p, r, half, centre) {
    const H = blockH();
    for (let i = 0; i < p.vineCount; i++) {
      const face = r.int(0, 3), u = r.uniform(-0.45, 0.45);
      const out = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]][face];
      const x = out[0] ? out[0] * 0.49 : u, y = out[1] ? out[1] * 0.49 : u;
      const len = H * p.vineLength * r.uniform(0.5, 1);
      const pts = Array.from({ length: 5 }, (_, k) => [x + r.uniform(-0.02, 0.02), y + r.uniform(-0.02, 0.02), H - len * k / 4]);
      mb.tube(pts, pts.map(() => 0.007), 3, pts.map(() => p.vineColorL), { capTip: false });
      for (let k = 1; k < 5; k++) {
        if (r.random() > 0.7) continue;
        speciesLeaf(mb, { ...p, leafSize: p.leafSize * 0.6 }, r, pts[k], V.norm(V.add(out, [0, 0, -0.6])), out);
      }
    }
  }

  function coreBox(mb, half, centre, k, color) {
    const hx = half[0] * k, hy = half[1] * k, hz = half[2] * k;
    const c = (sx, sy, sz) => [centre[0] + sx * hx, centre[1] + sy * hy, centre[2] + sz * hz];
    const faces = [
      [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)], [c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1), c(1, -1, -1)],
      [c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1)], [c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1)],
      [c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1)], [c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)],
    ];
    for (const [a, b, cc, d] of faces) mb.quad(a, b, cc, d, color, color, color, color);
  }

  function clampToBlock(pos, first, H) {
    for (let j = first; j < pos.length; j += 3) {
      pos[j] = Math.max(-0.5, Math.min(0.5, pos[j]));
      pos[j + 1] = Math.max(-0.5, Math.min(0.5, pos[j + 1]));
      pos[j + 2] = Math.max(0, Math.min(H, pos[j + 2]));
    }
  }

  /** Leaves fallen on the ground: flat, a little cupped, overlapping in layers. */
  function genLeafGround(mb, p, r) {
    const reach = 0.5 - p.cellMargin;
    for (let i = 0; i < p.leafCount; i++) {
      const at = [r.uniform(-reach, reach), r.uniform(-reach, reach), 0.003 + 0.002 * (i / Math.max(1, p.leafCount)) * 6];
      const normal = V.norm([r.uniform(-0.25, 0.25), r.uniform(-0.25, 0.25), 1]);
      const a = r.uniform(0, 2 * Math.PI);
      const dir = [Math.cos(a), Math.sin(a), 0];
      if (p.leafShape === "NEEDLE") {
        const [c0, c1] = leafColors(p, r), l = p.leafSize * 0.5;
        mb.tube([at, V.add(at, V.mul(dir, l))], [l * 0.025, l * 0.02], 3, [c0, c1], { capTip: false });
        continue;
      }
      speciesLeaf(mb, { ...p, leafCurl: p.leafCurl * 0.5, leafShape: p.leafShape === "PALM" ? "NARROW" : p.leafShape }, r, at, dir, normal);
    }
  }

  /** A pile: a dome of leaves, most on its surface facing out, some inside so it never shows the ground through. */
  function genLeafPile(mb, p, r) {
    const R = p.pileRadius, Hp = p.pileHeight * blockH();
    const height = (x, y) => Hp * Math.max(0, 1 - (x * x + y * y) / (R * R));
    for (let i = 0; i < p.leafCount; i++) {
      const a = r.uniform(0, 2 * Math.PI), d = R * Math.sqrt(r.random()) * 0.98;
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      const top = height(x, y);
      const z = Math.max(0.003, top * (r.random() < 0.8 ? r.uniform(0.85, 1) : r.uniform(0.2, 0.8)));
      // The dome's normal: (−∂h/∂x, −∂h/∂y, 1).
      const gx = 2 * Hp * x / (R * R), gy = 2 * Hp * y / (R * R);
      const normal = V.norm([gx + r.uniform(-0.3, 0.3), gy + r.uniform(-0.3, 0.3), 1]);
      const b = r.uniform(0, 2 * Math.PI);
      const dir = V.norm(V.sub([Math.cos(b), Math.sin(b), 0], V.mul(normal, V.dot([Math.cos(b), Math.sin(b), 0], normal))));
      speciesLeaf(mb, { ...p, leafShape: p.leafShape === "PALM" ? "NARROW" : p.leafShape }, r, [x, y, z], dir, normal);
    }
  }

  function genLeaves(mb, p, r) {
    // Painted: no mesh at all — the raster paints the sprite from these numbers (Aura.plantRaster.paintLeaves). Its
    // tones run from the species' base colour (darkest) to its tip colour (lightest), so every species paints too.
    if (p.leafForm === "PAINTED") {
      mb.painted = {
        seed: p.seed, shape: p.leafShape, length: Math.max(3, Math.min(32, p.leafSize * 62 * p.paintScale)), lengthVar: p.leafSizeVar * 0.8,
        width: p.leafWidth, point: p.paintPoint, spacing: p.paintSpacing, backSpacing: 1.1, jitter: p.paintJitter,
        hang: p.leafHang, layers: p.paintLayers, holes: p.paintHoles + Math.max(0, p.blockHoles - 0.15) * 0.8,
        backHoles: p.paintBackHoles, pinholes: p.paintPinholes, round: p.paintRound, fill: p.paintFill, clip: p.paintClip,
        darker: p.paintDarker, lighter: p.paintLighter, highlight: p.paintHighlight,
        edge: p.paintEdge, edgeTones: 1, edgeShadow: p.paintEdgeShadow,
        light: p.leafTipColor, dark: p.leafColor, tones: p.paintTones,
        altChance: p.leafAltChance, altColor: p.leafAltColor,
        blossoms: p.blossomCount, blossomColor: p.blossomColor, blossomCenter: p.blossomCenterColor,
        vines: p.vineCount, vineLength: p.vineLength, vineColor: p.vineColor,
      };
      return;
    }
    if (p.leafForm === "GROUND") genLeafGround(mb, p, r);
    else if (p.leafForm === "PILE") genLeafPile(mb, p, r);
    else genLeafBlock(mb, p, r);
  }

  // ── Seeds ────────────────────────────────────────────────────────────────────────────────────────────────────────

  // Each shape as a squashed blob: [x (length), y (width), z (thickness)], plus its lumpiness.
  const SEED_SHAPES = {
    GRAIN: { squash: [1, 0.45, 0.4], noise: 0.04 },
    TEAR: { squash: [1, 0.62, 0.22], noise: 0.02, point: 0.45 },
    ROUND: { squash: [1, 1, 0.9], noise: 0.08 },
    KERNEL: { squash: [0.8, 1, 0.55], noise: 0.12 },
    CHUNK: { squash: [1, 0.85, 0.7], noise: 0.25 },
  };

  function seed(mb, p, r, at, yaw) {
    const shape = SEED_SHAPES[p.seedShape] ?? SEED_SHAPES.GRAIN;
    const size = p.seedSize * (1 + r.uniform(-p.seedSizeVar, p.seedSizeVar));
    const tilt = r.uniform(-0.25, 0.25);
    const ax = [Math.cos(yaw) * Math.cos(tilt), Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt)];
    const side = V.norm(V.cross(UP, ax)), up = V.norm(V.cross(ax, side));
    const orient = (d) => V.add(V.add(V.mul(ax, d[0]), V.mul(side, d[1])), V.mul(up, d[2]));
    const c0 = jitterColor(r, p.seedColorL, p.colorVariation), c1 = jitterColor(r, p.seedTipColorL, p.colorVariation);
    const centre = V.add(at, [0, 0, size * shape.squash[2] * 0.9]);
    mb.blob(centre, size, (q) => {
      const local = V.sub(q, centre);
      const u = V.dot(local, ax) / size, w = V.dot(local, side) / size;
      if (p.seedStripes && Math.floor((w * 0.5 + 0.5) * 5) % 2 === 1) return p.seedStripeColorL;
      return V.lerp(c0, c1, clamp01(u * 0.5 + 0.5));
    }, r, {
      subdiv: 1, noise: shape.noise, squash: shape.squash,
      orient: (d) => {
        // A teardrop narrows toward one end.
        const k = shape.point && d[0] > 0 ? 1 - shape.point * (d[0] / size) : 1;
        return orient([d[0], d[1] * k, d[2] * k]);
      },
    });
  }

  function genSeeds(mb, p, r) {
    if (p.seedForm === "POUCH") { seedPouch(mb, p, r); return; }
    const R = p.seedForm === "PILE" ? p.pileRadius * 0.8 : 0.5 - p.cellMargin;
    const Hp = p.seedForm === "PILE" ? p.pileHeight * blockH() * 0.4 : 0;
    for (let i = 0; i < p.seedCount; i++) {
      const a = r.uniform(0, 2 * Math.PI), d = R * Math.sqrt(r.random());
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      const z = Hp * Math.max(0, 1 - (d * d) / (R * R)) * r.uniform(0.6, 1);
      seed(mb, p, r, [x, y, z], r.uniform(0, 2 * Math.PI));
    }
  }

  /** A cloth pouch tied at the neck, open, with seeds on top and a few spilled in front. */
  function seedPouch(mb, p, r) {
    const H = blockH(), body = 0.24, cloth = p.pouchColorL;
    mb.blob([0, 0.04, body * 0.95], body, (q, n) => V.mul(cloth, 0.8 + 0.3 * n[2] + 0.08 * noise3(V.mul(q, 18))), r,
      { subdiv: 3, noise: 0.03, squash: [1, 1, 0.95] });
    const neck = [[0, 0.04, body * 1.75], [0, 0.04, body * 2.05], [0, 0.04, body * 2.25]];
    mb.tube(neck, [body * 0.45, body * 0.38, body * 0.55], 10, neck.map(() => V.mul(cloth, 1.05)), { capTip: false });
    const tieZ = body * 1.95;
    const ring = Array.from({ length: 13 }, (_, k) => [Math.cos(k / 12 * 2 * Math.PI) * body * 0.42, 0.04 + Math.sin(k / 12 * 2 * Math.PI) * body * 0.42, tieZ]);
    mb.tube(ring, ring.map(() => 0.012), 4, ring.map(() => p.pouchTieColorL), { capTip: false });
    for (let i = 0; i < Math.min(14, p.seedCount); i++) {
      const a = r.uniform(0, 2 * Math.PI), d = body * 0.35 * Math.sqrt(r.random());
      seed(mb, p, r, [Math.cos(a) * d, 0.04 + Math.sin(a) * d, body * 2.18], r.uniform(0, 2 * Math.PI));
    }
    for (let i = 0; i < Math.min(10, p.seedCount); i++) {
      seed(mb, p, r, [r.uniform(-0.35, 0.05), r.uniform(-0.42, -0.2), 0], r.uniform(0, 2 * Math.PI));
    }
    if (H < body * 2.4) clampToBlock(mb.pos, 0, H);
  }

  // ── Registration ─────────────────────────────────────────────────────────────────────────────────────────────────

  if (!G.CATEGORIES.some(([k]) => k === "leaves")) G.CATEGORIES.splice(1, 0, ["leaves", "Hojas y semillas"]);

  const SPECIES = [["AURA", "Aura (pintado, gris)"], ["OAK", "Roble"], ["BIRCH", "Abedul"], ["PINE", "Pino"], ["SPRUCE", "Abeto"], ["JUNGLE", "Jungla"],
    ["JUNGLE_PALM", "Jungla · palmera"], ["JUNGLE_MONSTERA", "Jungla · costilla de Adán"], ["JUNGLE_BANANA", "Jungla · platanera"],
    ["JUNGLE_VINES", "Jungla · con lianas"], ["ACACIA", "Acacia"], ["DARK_OAK", "Roble oscuro"], ["CHERRY", "Cerezo"],
    ["MANGROVE", "Manglar"], ["WILLOW", "Sauce"], ["AUTUMN", "Otoño"], ["DEAD", "Seca"]];

  G.register("LEAVES", {
    category: "leaves", label: "Hojas",
    common: ["Colores", "Vida y detalles", "Textura procedural"],
    presetParam: "leafSpecies",
    params: {
      "Hojas": [
        ["leafForm", "Forma", [["PAINTED", "Bloque pintado (2D)"], ["BLOCK", "Bloque de hojas (3D)"], ["GROUND", "En el suelo"], ["PILE", "Montón"]], "PAINTED", null, null, null,
          "Pintado: hojas enteras de frente, en capas, como un bloque dibujado a mano (se ajusta en «Pintado»). Bloque 3D: hojas modeladas. Suelo: hojarasca. Montón: un montículo"],
        ["leafSpecies", "Especie", SPECIES, "AURA"],
        ["leafShape", "Hoja", [["LOBED", "Lobulada"], ["OVAL", "Ovalada"], ["ROUND", "Redonda"], ["LANCE", "Lanceolada"], ["NARROW", "Estrecha"], ["SERRATED", "Dentada (abedul)"],
          ["HEART", "Corazón"], ["SPLIT", "Partida (monstera)"], ["TINY", "Diminuta"], ["NEEDLE", "Agujas"], ["PALM", "Fronda"]], "LOBED"],
        ["leafCount", "Cantidad", "int", 240, 5, 1500, 1],
        ["leafSize", "Tamaño", "num", 0.16, 0.02, 0.6, 0.005, "Largo de una hoja, en bloques"],
        ["leafSizeVar", "Var. tamaño", "num", 0.3, 0, 1, 0.01],
        ["leafWidth", "Ancho", "num", 0.6, 0.1, 1.2, 0.01, "Ancho respecto al largo"],
        ["leafCurl", "Curvatura", "num", 0.3, 0, 1, 0.01, "Hojas ahuecadas"],
        ["leafFold", "Pliegue", "num", 0.25, 0, 1, 0.01, "Dobladas por el nervio central"],
        ["leafTilt", "Hacia fuera", "num", 0.4, 0, 2, 0.01, "Bloque: cuánto apuntan hacia fuera de la copa"],
        ["leafHang", "Colgando", "num", 0, 0, 1, 0.01, "Sauce: las hojas caen"],
        ["leafColor", "Color base", "color", L(0.08, 0.25, 0.04)],
        ["leafTipColor", "Color punta", "color", L(0.25, 0.5, 0.1)],
        ["leafAltColor", "Segundo color", "color", L(0.65, 0.08, 0.02)],
        ["leafAltChance", "Hojas del 2.º color", "num", 0, 0, 1, 0.01, "Otoño: mezcla de colores"],
      ],
      "Bloque": [
        ["blockRound", "Esquinas redondas", "num", 0.25, 0, 1, 0.01, "0 = cubo; 1 = esfera dentro del bloque"],
        ["blockShell", "En la superficie", "num", 0.8, 0, 1, 0.01, "Parte de las hojas que va a la piel de la copa (las de dentro no se ven)"],
        ["blockHoles", "Huecos", "num", 0.15, 0, 1, 0.01, "Claros entre las hojas"],
        ["blockCore", "Núcleo oscuro", "num", 0, 0, 1, 0.01, "0 = sin núcleo: entre las hojas se ve a través (transparente). Más de 0: un cubo oscuro dentro tapa los huecos"],
        ["coreColor", "Color núcleo", "color", L(0.02, 0.08, 0.015)],
        ["blossomCount", "Flores", "int", 0, 0, 120, 1],
        ["blossomSize", "Tamaño flor", "num", 0.05, 0.015, 0.15, 0.005],
        ["blossomColor", "Color flor", "color", L(1, 0.6, 0.75)],
        ["blossomCenterColor", "Centro flor", "color", L(1, 0.85, 0.3)],
        ["vineCount", "Colgantes", "int", 0, 0, 30, 1, "Lianas, ramas de sauce, raíces de manglar por fuera"],
        ["vineLength", "Largo colgante", "num", 0.8, 0.1, 1, 0.01],
        ["vineColor", "Color colgante", "color", L(0.1, 0.3, 0.05)],
      ],
      "Pintado": [
        ["paintScale", "Escala de hoja", "num", 1.35, 0.5, 3, 0.05, "Multiplica «Tamaño»: a 64 px una hoja necesita unos 9–14 px para que se lea su forma"],
        ["paintPoint", "Punta", "num", 1.4, 0.5, 3, 0.05, "Más = hojas más afiladas"],
        ["paintSpacing", "Separación", "num", 0.52, 0.25, 1.5, 0.01, "Entre hojas, respecto a su largo: menos = más hojas. El largo y el ancho son «Tamaño» y «Ancho» de Hojas (tamaño × 62 = pixeles)"],
        ["paintJitter", "Desorden", "num", 70, 0, 180, 1, "Grados que se aparta cada hoja de apuntar hacia fuera"],
        ["paintLayers", "Capas", "int", 2, 1, 4, 1, "Las de atrás van un tono más oscuras y se ven entre las de delante"],
        ["paintEdge", "Borde entre hojas", "num", 1, 0, 3, 0.5, "Pixeles de la línea oscura que separa cada hoja de la de detrás: lo que deja ver su forma"],
        ["paintEdgeShadow", "Borde solo en la sombra", "bool", true, null, null, null, "La línea solo del lado contrario a la luz, como la sombra de la hoja; apagado: alrededor de toda la hoja"],
        ["paintPinholes", "Agujeritos", "num", 0.25, 0, 0.8, 0.01, "Parte de esa línea que queda abierta: se ve a través en puntitos, no en agujeros grandes"],
        ["paintHoles", "Huecos delante", "num", 0.06, 0, 0.6, 0.01],
        ["paintBackHoles", "Huecos detrás", "num", 0.08, 0, 0.8, 0.01, "Hojas de atrás que faltan: agujeros más grandes"],
        ["paintRound", "Redondez", "num", 0.6, 0, 1, 0.01, "0 = la silueta del bloque; 1 = un círculo"],
        ["paintFill", "Llenado", "num", 0.93, 0.5, 1.2, 0.01, "Hasta dónde llegan las hojas hacia el borde"],
        ["paintClip", "Puntas fuera", "num", 1.3, 1, 1.5, 0.01, "Cuánto pueden salir las puntas de la silueta"],
        ["paintDarker", "Hojas más oscuras", "num", 0.25, 0, 0.8, 0.01, "Parte de las hojas un tono por debajo"],
        ["paintLighter", "Hojas más claras", "num", 0.1, 0, 0.8, 0.01],
        ["paintHighlight", "Brillos arriba", "num", 0.35, 0, 1, 0.01, "Hojas de arriba con su mitad iluminada en el tono más claro"],
        ["paintTones", "Tonos", "int", 6, 3, 10, 1, "Entre el color base (el más oscuro) y el de la punta (el más claro)"],
      ],
      "Suelo y montón": [
        ["pileHeight", "Altura montón", "num", 0.45, 0.05, 1, 0.01, "En bloques"],
        ["pileRadius", "Radio montón", "num", 0.45, 0.15, 0.5, 0.01],
      ],
    },
    defaults: { count: 1, distribution: "GRID", keepInCell: false, fitSprite: false, aoBase: 0, colorVariation: 0.12, leafTwist: 25, leafSegments: 4, cellMargin: 0.04 },
  }, (mb, p, r) => genLeaves(mb, p, r), [
    // Dalvin's hand-made leaf block, measured: whole pointed leaves facing the camera in two layers, two tones each,
    // six grays from 99 to 185, lighter on top and darker down the right. Painted (no mesh); gray for biome_tinted.
    { key: "AURA", label: "Aura (pintado, gris)", values: { leafForm: "PAINTED", leafShape: "LANCE", leafSize: 0.161, paintScale: 1, leafSizeVar: 0.3, leafWidth: 0.55, leafHang: 0, paintPoint: 1.4, paintSpacing: 0.52, paintJitter: 70, paintLayers: 2, paintEdge: 1, paintEdgeShadow: true, paintPinholes: 0.25, paintHoles: 0.06, paintBackHoles: 0.08, paintRound: 0.6, paintFill: 0.93, paintClip: 1.3, paintDarker: 0.25, paintLighter: 0.1, paintHighlight: 0.35, paintTones: 6, leafColor: "#636363", leafTipColor: "#b9b9b9", leafAltChance: 0, blockHoles: 0.15, blossomCount: 0, vineCount: 0 } },
    { key: "OAK", label: "Roble", values: { leafShape: "LOBED", leafSize: 0.16, leafWidth: 0.6, leafCount: 240, leafCurl: 0.3, leafHang: 0, leafColor: L(0.08, 0.25, 0.04), leafTipColor: L(0.25, 0.5, 0.1), leafAltChance: 0, blockRound: 0.25, blockHoles: 0.15, blockCore: 0, coreColor: L(0.02, 0.08, 0.015), blossomCount: 0, vineCount: 0 } },
    { key: "BIRCH", label: "Abedul", values: { leafShape: "SERRATED", leafSize: 0.11, leafWidth: 0.7, leafCount: 320, leafCurl: 0.2, leafHang: 0, leafColor: L(0.18, 0.4, 0.07), leafTipColor: L(0.55, 0.75, 0.2), leafAltChance: 0, blockRound: 0.3, blockHoles: 0.22, blockCore: 0, coreColor: L(0.05, 0.12, 0.02), blossomCount: 0, vineCount: 0 } },
    { key: "PINE", label: "Pino", values: { leafShape: "NEEDLE", leafSize: 0.2, leafCount: 110, leafHang: 0.1, leafColor: L(0.03, 0.15, 0.05), leafTipColor: L(0.08, 0.3, 0.1), leafAltChance: 0, blockRound: 0.35, blockHoles: 0.18, blockCore: 0, coreColor: L(0.01, 0.05, 0.02), blossomCount: 0, vineCount: 0 } },
    { key: "SPRUCE", label: "Abeto", values: { leafShape: "NEEDLE", leafSize: 0.16, leafCount: 140, leafHang: 0.25, leafColor: L(0.02, 0.1, 0.06), leafTipColor: L(0.05, 0.22, 0.13), leafAltChance: 0, blockRound: 0.1, blockHoles: 0.08, blockCore: 0, coreColor: L(0.01, 0.04, 0.025), blossomCount: 0, vineCount: 0 } },
    { key: "JUNGLE", label: "Jungla", values: { leafShape: "HEART", leafSize: 0.22, leafWidth: 0.75, leafCount: 150, leafCurl: 0.35, leafHang: 0.15, veinStrength: 0.2, leafColor: L(0.02, 0.3, 0.03), leafTipColor: L(0.15, 0.65, 0.08), leafAltChance: 0, blockRound: 0.15, blockHoles: 0.1, blockCore: 0, coreColor: L(0.01, 0.08, 0.01), blossomCount: 0, vineCount: 6, vineColor: L(0.08, 0.28, 0.04) } },
    { key: "JUNGLE_PALM", label: "Jungla · palmera", values: { leafShape: "PALM", leafSize: 0.42, leafCount: 45, leafHang: 0, leafColor: L(0.05, 0.3, 0.05), leafTipColor: L(0.3, 0.6, 0.1), leafAltChance: 0, blockRound: 0.4, blockHoles: 0, blockCore: 0, coreColor: L(0.01, 0.05, 0.01), blossomCount: 0, vineCount: 0 } },
    { key: "JUNGLE_MONSTERA", label: "Jungla · costilla de Adán", values: { leafShape: "SPLIT", leafSize: 0.3, leafWidth: 0.95, leafCount: 120, leafCurl: 0.25, leafHang: 0.1, veinStrength: 0.25, leafColor: L(0.01, 0.2, 0.03), leafTipColor: L(0.08, 0.45, 0.08), leafAltChance: 0, blockRound: 0.2, blockHoles: 0.05, blockCore: 0, coreColor: L(0.005, 0.06, 0.01), blossomCount: 0, vineCount: 3, vineColor: L(0.08, 0.25, 0.04) } },
    { key: "JUNGLE_BANANA", label: "Jungla · platanera", values: { leafShape: "LANCE", leafSize: 0.36, leafWidth: 0.42, leafCount: 70, leafCurl: 0.15, leafHang: 0.2, leafRuffle: 0.3, biteChance: 0.25, leafColor: L(0.1, 0.4, 0.05), leafTipColor: L(0.4, 0.75, 0.15), leafAltChance: 0.1, leafAltColor: L(0.5, 0.45, 0.15), blockRound: 0.2, blockHoles: 0.08, blockCore: 0, coreColor: L(0.02, 0.1, 0.02), blossomCount: 0, vineCount: 0 } },
    { key: "JUNGLE_VINES", label: "Jungla · con lianas", values: { leafShape: "HEART", leafSize: 0.14, leafWidth: 0.8, leafCount: 210, leafCurl: 0.3, leafHang: 0.2, leafColor: L(0.03, 0.28, 0.03), leafTipColor: L(0.18, 0.6, 0.1), leafAltChance: 0, blockRound: 0.15, blockHoles: 0.12, blockCore: 0, coreColor: L(0.01, 0.07, 0.01), blossomCount: 0, vineCount: 16, vineLength: 1, vineColor: L(0.1, 0.32, 0.05) } },
    { key: "ACACIA", label: "Acacia", values: { leafShape: "TINY", leafSize: 0.07, leafWidth: 0.5, leafCount: 520, leafCurl: 0.1, leafHang: 0, leafColor: L(0.15, 0.25, 0.04), leafTipColor: L(0.4, 0.48, 0.12), leafAltChance: 0, blockRound: 0.45, blockHoles: 0.35, blockCore: 0, coreColor: L(0.05, 0.08, 0.02), blossomCount: 0, vineCount: 0 } },
    { key: "DARK_OAK", label: "Roble oscuro", values: { leafShape: "LOBED", leafSize: 0.18, leafWidth: 0.65, leafCount: 300, leafCurl: 0.3, leafHang: 0.05, leafColor: L(0.02, 0.12, 0.02), leafTipColor: L(0.1, 0.28, 0.05), leafAltChance: 0, blockRound: 0.1, blockHoles: 0.05, blockCore: 0, coreColor: L(0.005, 0.03, 0.005), blossomCount: 0, vineCount: 0 } },
    { key: "CHERRY", label: "Cerezo", values: { leafShape: "OVAL", leafSize: 0.1, leafWidth: 0.7, leafCount: 260, leafCurl: 0.3, leafHang: 0, leafColor: L(0.8, 0.35, 0.5), leafTipColor: L(1, 0.7, 0.82), leafAltChance: 0.15, leafAltColor: L(0.2, 0.45, 0.1), blockRound: 0.35, blockHoles: 0.18, blockCore: 0, coreColor: L(0.35, 0.12, 0.2), blossomCount: 40, blossomColor: L(1, 0.85, 0.9), blossomCenterColor: L(1, 0.6, 0.7), vineCount: 0 } },
    { key: "MANGROVE", label: "Manglar", values: { leafShape: "OVAL", leafSize: 0.12, leafWidth: 0.55, leafCount: 280, leafCurl: 0.2, leafHang: 0.05, leafColor: L(0.05, 0.25, 0.06), leafTipColor: L(0.2, 0.45, 0.12), leafAltChance: 0, blockRound: 0.2, blockHoles: 0.15, blockCore: 0, coreColor: L(0.02, 0.07, 0.02), blossomCount: 0, vineCount: 5, vineLength: 0.6, vineColor: L(0.28, 0.3, 0.1) } },
    { key: "WILLOW", label: "Sauce", values: { leafShape: "NARROW", leafSize: 0.22, leafWidth: 0.25, leafCount: 260, leafCurl: 0.1, leafHang: 0.8, leafColor: L(0.15, 0.38, 0.12), leafTipColor: L(0.45, 0.65, 0.25), leafAltChance: 0, blockRound: 0.3, blockHoles: 0.2, blockCore: 0, coreColor: L(0.04, 0.1, 0.03), blossomCount: 0, vineCount: 10, vineLength: 1, vineColor: L(0.2, 0.4, 0.12) } },
    { key: "AUTUMN", label: "Otoño", values: { leafShape: "LOBED", leafSize: 0.15, leafWidth: 0.62, leafCount: 240, leafCurl: 0.35, leafHang: 0, leafColor: L(0.8, 0.28, 0.02), leafTipColor: L(1, 0.62, 0.05), leafAltChance: 0.35, leafAltColor: L(0.65, 0.05, 0.02), blockRound: 0.25, blockHoles: 0.2, blockCore: 0, coreColor: L(0.2, 0.05, 0.01), blossomCount: 0, vineCount: 0 } },
    { key: "DEAD", label: "Seca", values: { leafShape: "OVAL", leafSize: 0.12, leafWidth: 0.55, leafCount: 90, leafCurl: 0.8, leafHang: 0.1, leafColor: L(0.25, 0.15, 0.05), leafTipColor: L(0.45, 0.3, 0.12), leafAltChance: 0.3, leafAltColor: L(0.15, 0.1, 0.05), blockRound: 0.3, blockHoles: 0.5, blockCore: 0, blossomCount: 0, vineCount: 0 } },
  ]);

  G.register("SEEDS", {
    category: "leaves", label: "Semillas",
    common: ["Colores", "Textura procedural"],
    presetParam: "seedKind",
    params: {
      "Semillas": [
        ["seedKind", "De", [["WHEAT", "Trigo"], ["CARROT", "Zanahoria"], ["POTATO", "Patata (de siembra)"], ["CORN", "Maíz"], ["PUMPKIN", "Calabaza"],
          ["MELON", "Sandía"], ["SUNFLOWER", "Girasol"], ["BEET", "Remolacha"], ["GENERIC", "Genéricas"]], "WHEAT"],
        ["seedForm", "Presentación", [["PILE", "Montoncito"], ["SCATTER", "Esparcidas"], ["POUCH", "En bolsita"]], "PILE"],
        ["seedShape", "Forma", [["GRAIN", "Grano"], ["TEAR", "Plana (lágrima)"], ["ROUND", "Redonda"], ["KERNEL", "Grano de maíz"], ["CHUNK", "Trozo"]], "GRAIN"],
        ["seedCount", "Cantidad", "int", 40, 1, 200, 1],
        ["seedSize", "Tamaño", "num", 0.056, 0.008, 0.2, 0.001],
        ["seedSizeVar", "Var. tamaño", "num", 0.2, 0, 0.8, 0.01],
        ["seedColor", "Color base", "color", L(0.6, 0.42, 0.12)],
        ["seedTipColor", "Color punta", "color", L(0.85, 0.68, 0.3)],
        ["seedStripes", "Rayas", "bool", false],
        ["seedStripeColor", "Color rayas", "color", L(0.85, 0.85, 0.8)],
        ["pileHeight", "Altura montón", "num", 0.45, 0.05, 1, 0.01],
        ["pileRadius", "Radio montón", "num", 0.45, 0.15, 0.5, 0.01],
        ["pouchColor", "Color bolsita", "color", L(0.55, 0.4, 0.22)],
        ["pouchTieColor", "Color cordel", "color", L(0.35, 0.2, 0.08)],
      ],
    },
    defaults: { count: 1, distribution: "GRID", keepInCell: false, fitSprite: true, aoBase: 0, colorVariation: 0.08, cellMargin: 0.08 },
  }, (mb, p, r) => genSeeds(mb, p, r), [
    { key: "WHEAT", label: "Trigo", values: { seedShape: "GRAIN", seedCount: 45, seedSize: 0.056, seedColor: L(0.6, 0.42, 0.12), seedTipColor: L(0.85, 0.68, 0.3), seedStripes: false } },
    { key: "CARROT", label: "Zanahoria", values: { seedShape: "TEAR", seedCount: 60, seedSize: 0.035, seedColor: L(0.3, 0.2, 0.08), seedTipColor: L(0.45, 0.33, 0.15), seedStripes: false } },
    { key: "POTATO", label: "Patata (de siembra)", values: { seedShape: "CHUNK", seedCount: 3, seedSize: 0.176, seedColor: L(0.55, 0.38, 0.18), seedTipColor: L(0.75, 0.58, 0.3), seedStripes: false } },
    { key: "CORN", label: "Maíz", values: { seedShape: "KERNEL", seedCount: 35, seedSize: 0.064, seedColor: L(0.95, 0.6, 0.05), seedTipColor: L(1, 0.85, 0.35), seedStripes: false } },
    { key: "PUMPKIN", label: "Calabaza", values: { seedShape: "TEAR", seedCount: 22, seedSize: 0.088, seedColor: L(0.85, 0.78, 0.55), seedTipColor: L(0.98, 0.95, 0.82), seedStripes: false } },
    { key: "MELON", label: "Sandía", values: { seedShape: "TEAR", seedCount: 28, seedSize: 0.064, seedColor: L(0.03, 0.025, 0.02), seedTipColor: L(0.12, 0.1, 0.08), seedStripes: false } },
    { key: "SUNFLOWER", label: "Girasol", values: { seedShape: "TEAR", seedCount: 28, seedSize: 0.08, seedColor: L(0.04, 0.035, 0.03), seedTipColor: L(0.1, 0.09, 0.08), seedStripes: true, seedStripeColor: L(0.75, 0.75, 0.7) } },
    { key: "BEET", label: "Remolacha", values: { seedShape: "ROUND", seedCount: 30, seedSize: 0.056, seedColor: L(0.3, 0.12, 0.08), seedTipColor: L(0.45, 0.25, 0.15), seedStripes: false } },
    { key: "GENERIC", label: "Genéricas", values: { seedShape: "ROUND", seedCount: 40, seedSize: 0.045, seedColor: L(0.25, 0.16, 0.08), seedTipColor: L(0.4, 0.28, 0.14), seedStripes: false } },
  ]);

  // A variety also names itself in its own option, so the species / kind select follows the buttons.
  for (const pr of G.PRESETS.LEAVES) pr.values.leafSpecies = pr.key;
  for (const pr of G.PRESETS.SEEDS) pr.values.seedKind = pr.key;

  Aura.plantLeaves = { OUTLINES, SEED_SHAPES, SPECIES };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
