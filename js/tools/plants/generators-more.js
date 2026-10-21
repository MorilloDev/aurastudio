"use strict";

// More plant types for the Foliage tab — water plants, mushrooms, rocks, crystals, ferns, clover, reeds, papyrus,
// bamboo, vines and hanging plants — ported from the Stylized Foliage Generator add-on (v18), plus the variety
// presets of every type (grass kinds, flower kinds…), each with its own colours. Registers into Aura.plantGen.
(function (Aura) {
  const G = Aura.plantGen;
  const M = Aura.plantMesh;
  const { V, UP, clamp01, smooth, jitterColor, gradient, anyPerp, bezierPath, arcPath, headMatrix, crack, noise3 } = M;
  const { L, deg, vary, kink, nodeColors, featherLeaf, petal, flowerCenter, segmentedStem } = G.helpers;

  // ── Shared pieces ────────────────────────────────────────────────────────────────────────────────────────────────

  /** A curl that winds tighter toward its end: vine tendrils, a fern's young fiddlehead. */
  function coil(mb, base, direction, length, width, color, turns = 2) {
    const d = V.len(direction) > 1e-6 ? V.norm(direction) : UP;
    const side = anyPerp(d), up = V.norm(V.cross(d, side));
    const steps = 14, pts = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, a = t * turns * 2 * Math.PI, r = length * 0.35 * (1 - 0.8 * t);
      pts.push(V.add(V.add(base, V.mul(d, length * 0.6 * t)), V.mul(V.add(V.mul(side, Math.sin(a)), V.mul(up, 1 - Math.cos(a))), r)));
    }
    mb.tube(pts, pts.map((_, s) => width * (1 - 0.6 * s / steps)), 3, pts.map(() => color));
  }

  // ── Climbers ─────────────────────────────────────────────────────────────────────────────────────────────────────

  function genVine(mb, p, r, pos) {
    const seg = Math.max(4, p.vineSegments);
    const cb = jitterColor(r, p.baseColorL, p.colorVariation), ct = jitterColor(r, p.tipColorL, p.colorVariation);
    let a = r.uniform(0, 2 * Math.PI);
    const step = p.vineLength / seg;
    const path = [pos.slice()];
    for (let i = 0; i < seg; i++) {
      a += r.uniform(-p.vineWobble, p.vineWobble);
      const horiz = V.mul([Math.cos(a), Math.sin(a), 0], step * Math.max(0, 1 - Math.abs(p.vineClimb) * 0.5));
      path.push(V.add(V.add(path[path.length - 1], horiz), V.mul(UP, step * p.vineClimb)));
    }
    mb.tube(path, path.map((_, i) => p.vineWidth * (1 - 0.5 * i / seg)), p.tubeSides, gradient(cb, ct, seg + 1));
    const lc = p.vineLeafColorL;
    for (let i = 0; i < p.vineLeaves; i++) {
      const idx = Math.min(seg, Math.floor((i + 1) / (p.vineLeaves + 1) * seg));
      const tan = V.norm(V.sub(path[Math.min(seg, idx + 1)], path[Math.max(0, idx - 1)]));
      let out = V.cross(tan, UP);
      out = V.mul(V.len(out) > 1e-6 ? V.norm(out) : anyPerp(tan), i % 2 === 0 ? 1 : -1);
      const size = p.vineLeafSize * r.uniform(0.8, 1.2);
      mb.leaf(path[idx], out, size, size * 0.55, [jitterColor(r, V.mul(lc, 0.85), 0.05), lc], { lift: 0.25, droop: 0.3, fold: 0.2, shape: "HEART" });
    }
    for (let i = 0; i < p.vineTendrils; i++) {
      const idx = Math.min(seg, Math.floor((i + 0.5) / p.vineTendrils * seg));
      coil(mb, path[idx], [r.uniform(-1, 1), r.uniform(-1, 1), 0.4], p.vineLeafSize * 0.5, p.vineWidth * 0.35, ct, r.uniform(1.5, 2.5));
    }
  }

  /** Roots, moss or vines hanging from the block above (caves, overhangs): anchored at the ceiling, growing down. */
  function genHanging(mb, p, r, pos) {
    const H = Aura.blockEngine.BLOCK_HEIGHT;
    const ceiling = V.add(pos, [0, 0, p.hangCeiling * H]);
    const cv = p.colorVariation;
    const c0 = jitterColor(r, p.baseColorL, cv), c1 = jitterColor(r, p.tipColorL, cv), lc = jitterColor(r, p.stemLeafColorL, cv);
    const bc = p.berryColorL;
    for (let s = 0; s < p.hangStrands; s++) {
      const a = r.uniform(0, 2 * Math.PI);
      const start = V.add(ceiling, V.mul([Math.cos(a), Math.sin(a), 0], r.uniform(0, p.areaSize * 0.2)));
      const length = Math.max(0.05, vary(r, p.hangLength, p.heightVariation));
      const seg = Math.max(4, p.segments * 2);
      const sway = V.mul([r.uniform(-1, 1), r.uniform(-1, 1), 0], length * 0.12);
      const path = [];
      for (let i = 0; i <= seg; i++) path.push(V.add(V.sub(start, V.mul(UP, length * i / seg)), V.mul(sway, Math.sin(i / seg * Math.PI))));
      mb.tube(path, path.map((_, i) => p.vineWidth * (1 - 0.5 * i / seg)), Math.max(3, p.tubeSides), gradient(c0, c1, seg + 1));
      for (let k = 0; k < p.hangLeaves; k++) {
        const i = Math.min(seg, Math.floor((k + 1) / (p.hangLeaves + 1) * seg));
        const la = r.uniform(0, 2 * Math.PI), size = p.vineLeafSize * r.uniform(0.7, 1.2);
        mb.leaf(path[i], [Math.cos(la), Math.sin(la), -0.4], size, size * 0.45, [V.mul(lc, 0.85), lc], { lift: -0.1, droop: 0.3, fold: 0.25, shape: "LANCE" });
      }
      for (let b = 0; b < p.hangBerries; b++) {
        const i = r.int(Math.floor(seg / 3), seg);
        mb.blob(V.add(path[i], V.mul([r.uniform(-1, 1), r.uniform(-1, 1), 0], p.vineWidth * 2)), p.vineWidth * 1.8, () => bc, r, { subdiv: 1 });
      }
    }
  }

  // ── Fungi, rocks, crystals ───────────────────────────────────────────────────────────────────────────────────────

  function genMushroom(mb, p, r, pos) {
    const cv = p.colorVariation;
    const sh = Math.max(0.02, vary(r, p.mushroomStemHeight, p.mushroomStemVar));
    const cr = Math.max(0.01, vary(r, p.mushroomCapSize, p.mushroomCapVar));
    const sc = jitterColor(r, p.mushroomStemColorL, cv), cb = jitterColor(r, p.mushroomCapColorL, cv), ct = jitterColor(r, p.mushroomCapTipColorL, cv);
    const gc = p.mushroomGillColorL;
    const seg = Math.max(3, p.segments);
    const path = arcPath(pos, [r.uniform(-1, 1), r.uniform(-1, 1), 0], sh, r.uniform(0, 12), 0.2, seg);
    const widths = path.map((_, i) => p.mushroomStemWidth * 0.5 * (1 + 0.35 * Math.sin(i / seg * Math.PI) + 0.2 * (1 - i / seg)));
    mb.tube(path, widths, Math.max(5, p.tubeSides), path.map(() => sc), { capTip: false });
    const axis = V.norm(V.sub(path[seg], path[seg - 1]));
    const Mh = headMatrix(axis), top = path[seg];
    // Cap: a surface of revolution, the dome down to the rim, then the gills back to the stem.
    const cracked = p.mushroomCracks > 0;
    const rings = 6 + (cracked ? 4 : 0), sides = Math.max(8, p.tubeSides * 2) * (cracked ? 2 : 1);
    const fl = p.mushroomCapFlatten, zspan = cr * fl;
    const ringPts = [];
    for (let k = 0; k <= rings; k++) {
      const phi = Math.PI * 0.5 * (1 - k / rings);
      const rad = k < rings ? cr * Math.cos(phi) : cr, z = cr * fl * Math.sin(phi);
      ringPts.push(Array.from({ length: sides }, (_, s) => {
        const a = 2 * Math.PI * s / sides, wave = 1 + 0.06 * Math.sin(a * p.mushroomCapWaves) * (k / rings);
        return { q: V.add(top, Mh([Math.cos(a) * rad * wave, Math.sin(a) * rad * wave, z])), h: z };
      }));
    }
    const crackSeed = r.random() * 100, crackDark = V.mul(cb, 1 - p.mushroomCrackDark);
    const capCol = (v) => {
      const c = V.lerp(ct, cb, clamp01(1 - v.h / Math.max(1e-6, zspan)));
      return V.lerp(c, crackDark, crack(V.sub(v.q, top), 1 / Math.max(1e-4, cr * 0.45), p.mushroomCracks, crackSeed));
    };
    for (let k = 0; k < rings; k++) {
      for (let s = 0; s < sides; s++) {
        const j = (s + 1) % sides, a = ringPts[k], b = ringPts[k + 1];
        mb.quad(a[s].q, b[s].q, b[j].q, a[j].q, capCol(a[s]), capCol(b[s]), capCol(b[j]), capCol(a[j]));
      }
    }
    const inner = Array.from({ length: sides }, (_, s) => V.add(top, Mh([Math.cos(2 * Math.PI * s / sides) * widths[seg] * 1.1, Math.sin(2 * Math.PI * s / sides) * widths[seg] * 1.1, -0.002])));
    const rim = ringPts[rings];
    for (let s = 0; s < sides; s++) {
      const j = (s + 1) % sides, shade = V.mul(gc, s % 2 === 0 ? 0.85 : 1);
      mb.quad(rim[s].q, rim[j].q, inner[j], inner[s], shade, shade, shade, shade);
    }
    const spot = p.mushroomSpotColorL;
    for (let i = 0; i < p.mushroomSpots; i++) {
      const a = r.uniform(0, 2 * Math.PI), phi = r.uniform(0.25, 1.2);
      const at = V.add(top, Mh([Math.cos(a) * cr * Math.cos(phi), Math.sin(a) * cr * Math.cos(phi), cr * fl * Math.sin(phi)]));
      mb.blob(at, cr * r.uniform(0.08, 0.14), () => spot, r, { subdiv: 1, squash: [1, 1, 0.4] });
    }
  }

  /**
   * Mineral inclusions in a stone: 0 = plain stone, otherwise 0..1, how deep inside the ore the point is (its edge →
   * its heart), so the ore can run from its base colour to its shine. Read from the point's place in the world, not the
   * face, so a speck or a vein carries on round the corner of a block onto the next face.
   */
  function oreAt(q, p, seed) {
    if (!(p.oreAmount > 0)) return 0;
    const f = 1 / Math.max(0.01, p.oreSize);
    const o = [seed * 1.7 + 37, seed * 0.9 + 11, seed * 0.3 + 5];
    if (p.oreStyle === "VEINS") {
      // Veins: the zero line of a smooth noise is a winding thread; its width grows with the amount.
      const n = Math.abs(noise3([q[0] * f * 0.6 + o[0], q[1] * f * 0.6 + o[1], q[2] * f * 0.6 + o[2]]));
      const w = p.oreAmount * 0.16;
      return n < w ? clamp01(1 - n / w) : 0;
    }
    // Specks and nuggets: the tops of a noise. Nuggets add a second, coarser noise so the specks gather in clumps.
    let n = noise3([q[0] * f + o[0], q[1] * f + o[1], q[2] * f + o[2]]);
    if (p.oreStyle === "NUGGETS") n = n * 0.6 + noise3([q[0] * f * 0.35 + o[1], q[1] * f * 0.35 + o[2], q[2] * f * 0.35 + o[0]]) * 0.7;
    const thr = 0.5 - p.oreAmount * 0.75;
    return n > thr ? clamp01((n - thr) / 0.22) : 0;
  }
  /** The stone's colour with its ore laid over; t from oreAt, k the cube's own small shade. */
  function withOre(col, t, p, k = 1) {
    if (!(t > 0)) return col;
    const ore = V.lerp(p.oreColorL, p.oreTipColorL, clamp01(t * p.oreShine * 1.6));
    return V.mul(ore, k);
  }

  function genPebbles(mb, p, r, pos) {
    const cv = p.colorVariation;
    const c0 = jitterColor(r, p.rockColorL, cv), c1 = jitterColor(r, p.rockTipColorL, cv);
    const sz = Math.max(0.01, vary(r, p.rockSize, p.rockVar));
    const flat = p.rockFlatten;
    const seed = r.random() * 100;
    const crackScale = 1 / Math.max(1e-4, sz * p.rockCrackSize);
    const crackDark = V.mul(c0, 1 - p.rockCrackDark);
    const moss = p.mossColorL;
    const squash = [r.uniform(0.9, 1.3), r.uniform(0.8, 1.1), flat];
    if (p.rockStyle === "VOXEL") {
      // Cubes on a grid, so the rock reads as pixel art: a noisy ellipsoid, surface cubes knocked out along cracks,
      // moss on patches of the upward faces, every cube its own small shade.
      const vs = Math.max(0.01, p.rockVoxel);
      const rx = sz * squash[0], ry = sz * squash[1], rz = sz * squash[2];
      const centre = V.add(pos, [0, 0, rz * 0.45]);
      const nx = Math.ceil(rx / vs) + 1, ny = Math.ceil(ry / vs) + 1, nz = Math.ceil(rz / vs) + 1;
      const ns = 2.5 / Math.max(1e-4, sz);
      const cells = new Set();
      for (let i = -nx; i < nx; i++) for (let j = -ny; j < ny; j++) for (let k = -nz; k < nz; k++) {
        const q = [(i + 0.5) * vs, (j + 0.5) * vs, (k + 0.5) * vs];
        if (centre[2] + q[2] < pos[2] - vs * 0.5) continue;
        let e = (q[0] / rx) ** 2 + (q[1] / ry) ** 2 + (q[2] / rz) ** 2;
        e += noise3([(centre[0] + q[0]) * ns + seed, (centre[1] + q[1]) * ns + seed * 0.5, (centre[2] + q[2]) * ns]) * p.rockNoise;
        if (e <= 1) cells.add(`${i},${j},${k}`);
      }
      const cellPos = (c) => V.add(centre, [(c[0] + 0.5) * vs, (c[1] + 0.5) * vs, (c[2] + 0.5) * vs]);
      if (p.rockCracks > 0) {
        const surface = (c) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some((d) => !cells.has(`${c[0] + d[0]},${c[1] + d[1]},${c[2] + d[2]}`));
        const gone = [...cells].filter((key) => {
          const c = key.split(",").map(Number);
          return surface(c) && crack(cellPos(c), crackScale, p.rockCracks, seed) > 0.5;
        });
        // Never split a small rock into floating crumbs.
        if (gone.length < cells.size * 0.35) for (const g of gone) cells.delete(g);
      }
      const span = Math.max(1e-6, 2 * rz);
      const shade = new Map([...cells].map((c) => [c, 1 + r.uniform(-p.rockDither, p.rockDither)]));
      const origin = centre;
      mb.voxels(cells, [origin[0], origin[1], origin[2]], vs, (c, di) => {
        const q = cellPos(c), k = shade.get(c.join(","));
        let col = V.mul(V.lerp(c0, c1, clamp01((q[2] - pos[2]) / span)), k);
        col = V.lerp(col, crackDark, crack(q, crackScale, p.rockCracks, seed) * 0.8);
        col = withOre(col, oreAt(q, p, seed), p, k);
        if (di === 4 && p.mossAmount > 0) {
          const m = clamp01(0.5 + noise3(V.add(V.mul(q, 6 / Math.max(1e-4, sz)), [seed, 0, 0])) * 1.5 - (1 - p.mossAmount));
          if (m > 0.5) col = V.mul(moss, k);
        }
        return col;
      });
      return;
    }
    const centre = V.add(pos, [0, 0, sz * flat * 0.55]);
    const span = Math.max(1e-6, 2 * sz * flat);
    mb.blob(centre, sz, (q, n) => {
      let c = V.lerp(c0, c1, clamp01((q[2] - pos[2]) / span));
      let m = clamp01((n[2] - (1 - p.mossAmount * 1.4)) * 3);
      m *= clamp01(0.5 + noise3(V.add(V.mul(q, 6 / Math.max(1e-4, sz)), [seed, 0, 0])) * 1.5);
      c = withOre(c, oreAt(q, p, seed), p);
      if (p.mossAmount > 0) c = V.lerp(c, moss, m);
      return V.lerp(c, crackDark, crack(q, crackScale, p.rockCracks, seed));
    }, r, { subdiv: p.rockDetail, noise: p.rockNoise, squash, displace: (q) => -crack(q, crackScale, p.rockCracks, seed) * sz * p.rockCrackDepth });
  }

  function genCrystal(mb, p, r, pos) {
    const base = V.add(pos, [0, 0, -0.01]);
    const cv = p.colorVariation;
    const cb = jitterColor(r, p.crystalColorL, cv), ct = jitterColor(r, p.crystalTipColorL, cv);
    const spread = deg(p.crystalSpread);
    for (let k = 0; k < p.crystalCount; k++) {
      let axis = UP, length = p.crystalLength;
      if (k > 0) {
        const tilt = r.uniform(0.3, 1) * spread, a = r.uniform(0, 2 * Math.PI);
        axis = [Math.sin(tilt) * Math.cos(a), Math.sin(tilt) * Math.sin(a), Math.cos(tilt)];
        length = p.crystalLength * r.uniform(0.35, 0.8);
      }
      const radius = p.crystalRadius * Math.pow(length / p.crystalLength, 0.6);
      const first = mb.triangleCount;
      mb.prism(V.add(base, V.mul([axis[0], axis[1], 0], radius * 0.6)), axis, length, radius, p.crystalSides, cb, ct, p.crystalTip, r.uniform(0, 1));
      mb.facetShade(first, r, p.crystalFacets);
    }
    for (let i = 0; i < p.crystalShards; i++) {
      const a = r.uniform(0, 2 * Math.PI), rr = p.crystalRadius * r.uniform(1.5, 3);
      const at = V.add(base, [Math.cos(a) * rr, Math.sin(a) * rr, 0]);
      const first = mb.triangleCount;
      mb.prism(at, V.norm([Math.cos(a) * 0.6, Math.sin(a) * 0.6, 1]), p.crystalLength * r.uniform(0.12, 0.25), p.crystalRadius * 0.35, Math.max(3, p.crystalSides - 2), cb, ct, 0.5, r.uniform(0, 1));
      mb.facetShade(first, r, p.crystalFacets);
    }
  }

  // ── Herbs ────────────────────────────────────────────────────────────────────────────────────────────────────────

  function genFern(mb, p, r, pos) {
    const lc = jitterColor(r, p.tipColorL, p.colorVariation);
    for (let f = 0; f < p.fernFronds; f++) {
      const a = 2 * Math.PI * f / p.fernFronds + r.uniform(-0.3, 0.3);
      featherLeaf(mb, p, pos, [Math.cos(a), Math.sin(a), 0], vary(r, p.bladeHeight, p.heightVariation), lc, p.fernPinnae, p.fernLift);
    }
    const young = V.mul(lc, 1.15);
    for (let f = 0; f < p.fernFiddleheads; f++) {
      const a = r.uniform(0, 2 * Math.PI);
      const stalkTop = V.add(V.add(pos, V.mul([Math.cos(a), Math.sin(a), 0], 0.03)), [0, 0, p.bladeHeight * 0.35]);
      mb.tube([pos, stalkTop], [p.bladeHeight * 0.012, p.bladeHeight * 0.012], 3, [V.mul(lc, 0.8), young], { capTip: false });
      coil(mb, stalkTop, [Math.cos(a), Math.sin(a), 0.6], p.bladeHeight * 0.22, p.bladeHeight * 0.02, young, 1.6);
    }
  }

  function genClover(mb, p, r, pos) {
    const lc = jitterColor(r, p.tipColorL, p.colorVariation), sc = jitterColor(r, p.baseColorL, p.colorVariation);
    for (let s = 0; s < p.cloverStems; s++) {
      const path = arcPath(pos, [r.uniform(-1, 1), r.uniform(-1, 1), 0], p.cloverHeight * r.uniform(0.7, 1.1), r.uniform(5, 25), 0.3, 3);
      mb.tube(path, path.map(() => p.stemWidth * 0.2), 3, gradient(sc, lc, 4));
      const spin = r.uniform(0, 2 * Math.PI);
      for (let k = 0; k < p.cloverLeaflets; k++) {
        const a = spin + 2 * Math.PI * k / p.cloverLeaflets;
        mb.leaf(path[3], [Math.cos(a), Math.sin(a), 0], p.cloverLeafSize, p.cloverLeafSize * 0.55, [V.mul(lc, 0.85), lc],
          { lift: 0.05, droop: 0.1, fold: 0.15, shape: "HEART", segments: 3 });
      }
    }
    if (p.cloverFlower && r.random() < 0.5) {
      const fc = p.petalColorL;
      const path = arcPath(pos, [1, 0, 0], p.cloverHeight * 1.4, 8, 0.1, 3);
      mb.tube(path, path.map(() => p.stemWidth * 0.2), 3, gradient(sc, lc, 4));
      mb.blob(V.add(path[3], [0, 0, p.cloverLeafSize * 0.3]), p.cloverLeafSize * 0.45, () => fc, r, { subdiv: 1, noise: 0.25 });
    }
  }

  function genReeds(mb, p, r, pos) {
    const cv = p.colorVariation;
    const cb = jitterColor(r, p.baseColorL, cv), ct = jitterColor(r, p.tipColorL, cv);
    const h = Math.max(0.05, vary(r, p.bladeHeight, p.heightVariation));
    for (let li = 0; li < p.reedLeaves; li++) {
      const d = [Math.cos(li * 2.4 + r.uniform(-0.5, 0.5)), Math.sin(li * 2.4 + r.uniform(-0.5, 0.5)), 0];
      const path = kink(arcPath(pos, d, h * r.uniform(0.7, 1), r.uniform(3, 15) + p.inclination, p.bend, Math.max(3, p.segments)), r, p);
      const last = path.length - 1;
      mb.ribbon(path, path.map((_, i) => p.reedLeafWidth * 0.5 * Math.max(0, 1 - (i / last) ** 1.8)), V.norm(V.cross(UP, d)),
        gradient(cb, ct, last + 1), { fold: 0.6, details: "LEAF" });
    }
    const hc = p.reedHeadColorL;
    for (let hi = 0; hi < p.reedHeads; hi++) {
      const d = [r.uniform(-1, 1), r.uniform(-1, 1), 0];
      const sh = h * r.uniform(1, 1.25);
      const path = arcPath(V.add(pos, V.mul(d, 0.01)), d, sh, r.uniform(0, 8), 0.1, 4);
      mb.tube(path, path.map(() => p.reedLeafWidth * 0.12), 4, nodeColors(p, gradient(cb, ct, 5)));
      const axis = V.norm(V.sub(path[4], path[3]));
      const hl = sh * p.reedHeadLength;
      const start = V.sub(path[4], V.mul(axis, hl * 1.1));
      const pts = [0, 1, 2, 3, 4].map((i) => V.add(start, V.mul(axis, hl * i / 4)));
      const rad = p.reedLeafWidth * 0.45;
      mb.tube(pts, [rad * 0.7, rad, rad, rad, rad * 0.6], 6, gradient(V.mul(hc, 0.85), hc, 5), { capBase: true });
      mb.tube([pts[4], V.add(pts[4], V.mul(axis, hl * 0.35))], [rad * 0.15, rad * 0.05], 3, [cb, ct]);
    }
  }

  function genPapyrus(mb, p, r, pos) {
    const cv = p.colorVariation;
    const c0 = jitterColor(r, p.baseColorL, cv), c1 = jitterColor(r, p.tipColorL, cv);
    for (let s = 0; s < p.papyrusStems; s++) {
      const a = r.uniform(0, 2 * Math.PI), d = [Math.cos(a), Math.sin(a), 0];
      const h = Math.max(0.1, vary(r, p.bladeHeight, p.heightVariation));
      const path = arcPath(V.add(pos, V.mul(d, 0.02 * s)), d, h, r.uniform(2, 12) + p.inclination, p.bend * 0.5 + p.wilt * 0.3, Math.max(4, p.segments));
      // Papyrus stems are triangular in section.
      mb.tube(path, path.map((_, i) => p.stemWidth * 0.5 * (1 - 0.4 * i / (path.length - 1))), 3, gradient(c0, c1, path.length));
      const top = path[path.length - 1], axis = V.norm(V.sub(top, path[path.length - 2]));
      for (let k = 0; k < p.papyrusRays; k++) {
        const ra = 2 * Math.PI * k / p.papyrusRays + r.uniform(-0.15, 0.15), out = [Math.cos(ra), Math.sin(ra), 0];
        const length = p.papyrusRayLength * r.uniform(0.75, 1.15);
        const mid = V.add(V.add(top, V.mul(out, length * 0.5)), V.mul(axis, length * 0.25));
        const end = V.sub(V.add(top, V.mul(out, length)), V.mul(UP, length * r.uniform(0, 0.35)));
        mb.ribbon(bezierPath(top, mid, end, 3), [p.stemWidth * 0.25, p.stemWidth * 0.25, p.stemWidth * 0.25, 0], V.norm(V.cross(UP, out)),
          gradient(c1, V.mul(c1, 1.15), 4), { details: "LEAF" });
      }
    }
  }

  function genBamboo(mb, p, r, pos) {
    const cv = p.colorVariation;
    const c0 = jitterColor(r, p.baseColorL, cv), c1 = jitterColor(r, p.tipColorL, cv), lc = jitterColor(r, p.stemLeafColorL, cv);
    for (let c = 0; c < p.bambooCulms; c++) {
      const a = r.uniform(0, 2 * Math.PI), d = [Math.cos(a), Math.sin(a), 0];
      const start = V.add(pos, V.mul(d, p.bambooRadius * 2.2 * c * 0.6));
      const h = Math.max(0.1, vary(r, p.bambooHeight, p.heightVariation));
      const path = segmentedStem(mb, p, start, d, h, r.uniform(0, 6) + p.inclination, p.bambooRadius, p.bambooNodes, c0, c1, 0.05 + p.wilt * 0.3);
      // Leaves sprout from the upper nodes, in small drooping fans.
      const nodes = [];
      for (let i = 3; i < path.length - 1; i += 3) nodes.push(i);
      for (const i of nodes.slice(Math.floor(nodes.length / 2))) {
        for (let k = 0; k < p.bambooLeaves; k++) {
          const la = r.uniform(0, 2 * Math.PI), size = p.stemLeafSize * r.uniform(0.8, 1.3);
          mb.leaf(path[i], [Math.cos(la), Math.sin(la), 0], size, size * 0.18, [V.mul(lc, 0.85), lc], { lift: 0.25, droop: 0.5, fold: 0.35, shape: "LANCE" });
        }
      }
    }
  }

  // Sugar cane: a tight clump of thin, jointed canes, straight and pale, with long narrow leaves arching out of the
  // joints — more of them low on the cane, and a small tuft at each tip.
  function genSugarCane(mb, p, r, pos) {
    const cv = p.colorVariation;
    const c0 = jitterColor(r, p.baseColorL, cv), c1 = jitterColor(r, p.tipColorL, cv), lc = jitterColor(r, p.stemLeafColorL, cv);
    for (let c = 0; c < p.caneCount; c++) {
      const a = r.uniform(0, 2 * Math.PI), d = [Math.cos(a), Math.sin(a), 0];
      const start = V.add(pos, V.mul(d, r.uniform(0, p.caneSpread)));
      const h = Math.max(0.1, vary(r, p.caneHeight, p.heightVariation));
      const path = segmentedStem(mb, p, start, d, h, r.uniform(0, 4) + p.inclination, p.caneRadius, p.caneNodes, c0, c1, 0.02 + p.wilt * 0.2);
      for (let i = 3; i < path.length - 1; i += 3) {
        const t = i / (path.length - 1);
        if (r.random() > p.caneLeafChance * (1.2 - t * 0.6)) continue;
        const la = r.uniform(0, 2 * Math.PI), size = p.stemLeafSize * r.uniform(0.75, 1.2) * (1.1 - t * 0.4);
        mb.leaf(path[i], [Math.cos(la), Math.sin(la), 0], size, size * 0.09, [V.mul(lc, 0.85), lc], { lift: 0.45, droop: 0.65, fold: 0.3, shape: "LANCE" });
      }
      const tip = path[path.length - 1];
      for (let k = 0; k < p.caneTipLeaves; k++) {
        const la = r.uniform(0, 2 * Math.PI), size = p.stemLeafSize * r.uniform(0.5, 0.8);
        mb.leaf(tip, [Math.cos(la), Math.sin(la), 0], size, size * 0.09, [V.mul(lc, 0.85), lc], { lift: 0.8, droop: 0.4, fold: 0.3, shape: "LANCE" });
      }
    }
  }

  // ── Water ────────────────────────────────────────────────────────────────────────────────────────────────────────

  function genSeaweed(mb, p, r, pos) {
    const seg = Math.max(8, p.seaweedSegments);
    const cb = jitterColor(r, p.seaweedColorL, p.colorVariation), ct = jitterColor(r, p.seaweedTipColorL, p.colorVariation);
    const a = r.uniform(0, 2 * Math.PI), sway = [Math.cos(a), Math.sin(a), 0];
    const len = vary(r, p.seaweedLength, 0.25);
    const path = [];
    for (let s = 0; s <= seg; s++) {
      const t = s / seg, wave = Math.sin(t * Math.PI * p.seaweedWaves + r.uniform(-0.2, 0.2)) * p.seaweedAmplitude * t;
      path.push(V.add(V.add(pos, V.mul(UP, len * t)), V.mul(sway, wave)));
    }
    const widths = path.map((_, s) => p.seaweedWidth * (0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, s / seg + 0.1))));
    widths[seg] = 0;
    const side = V.norm(V.cross(UP, sway));
    mb.ribbon(path, widths, side, gradient(cb, ct, seg + 1), { fold: 0.25, details: "LEAF" });
    const bc = p.seaweedBladderColorL;
    for (let b = 0; b < p.seaweedBladders; b++) {
      const idx = Math.min(seg, Math.floor((b + 1) / (p.seaweedBladders + 1) * seg));
      mb.blob(V.add(path[idx], V.mul(side, p.seaweedWidth * (b % 2 ? 1 : -1))), p.seaweedWidth * 0.7, () => bc, r, { subdiv: 1, squash: [1, 1, 1.3] });
    }
    const lc = p.seaweedLeafColorL;
    for (let i = 0; i < p.seaweedLeafCount; i++) {
      const idx = Math.min(seg, Math.floor((i + 1) / (p.seaweedLeafCount + 1) * seg));
      const size = p.seaweedLeafSize * r.uniform(0.8, 1.2);
      mb.leaf(path[idx], V.mul(side, i % 2 === 0 ? 1 : -1), size, size * 0.3, [V.mul(lc, 0.85), lc], { lift: 0.6, droop: 0.1, fold: 0.2, shape: "LANCE" });
    }
  }

  function genSeagrass(mb, p, r, pos) {
    const cb = jitterColor(r, p.baseColorL, p.colorVariation), ct = jitterColor(r, p.tipColorL, p.colorVariation);
    for (let b = 0; b < p.seagrassBlades; b++) {
      const a = r.uniform(0, 2 * Math.PI), sway = [Math.cos(a), Math.sin(a), 0];
      const h = Math.max(0.05, vary(r, p.bladeHeight, p.heightVariation));
      const seg = Math.max(6, p.segments * 2), phase = r.uniform(0, 6.28);
      const path = [];
      for (let s = 0; s <= seg; s++) {
        path.push(V.add(V.add(V.add(pos, V.mul(sway, 0.01 * b)), V.mul(UP, h * s / seg)), V.mul(sway, Math.sin(s / seg * Math.PI * 1.5 + phase) * p.seaweedAmplitude * s / seg)));
      }
      const widths = path.map((_, s) => p.seagrassWidth * 0.5 * (1 - 0.3 * s / seg));
      widths[seg] = p.seagrassWidth * 0.15;
      mb.ribbon(path, widths, V.norm(V.cross(UP, sway)), gradient(cb, ct, seg + 1), { fold: 0.2, details: "LEAF" });
    }
  }

  function genCoral(mb, p, r, pos) {
    const cb = jitterColor(r, p.coralColorL, p.colorVariation), ct = jitterColor(r, p.coralTipColorL, p.colorVariation);
    const depthMax = Math.max(1, p.coralDepth);
    const branch = (start, direction, length, thick, depth) => {
      if (depth <= 0 || length < 0.01) return;
      const seg = Math.max(2, p.coralSegments);
      const bend = [r.uniform(-0.3, 0.3), r.uniform(-0.3, 0.3), 0.25];
      const end = V.add(start, V.mul(V.norm(V.add(direction, bend)), length));
      const mid = V.add(V.lerp(start, end, 0.5), V.mul(bend, length * 0.2));
      const path = bezierPath(start, mid, end, seg);
      const level = depthMax > 1 ? 1 - (depth - 1) / (depthMax - 1) : 1;
      const c0 = V.lerp(cb, ct, level * 0.7), c1 = V.lerp(cb, ct, Math.min(1, level * 0.7 + 0.3));
      mb.tube(path, path.map((_, i) => thick * (1 - 0.35 * i / seg)), Math.max(4, p.tubeSides), gradient(c0, c1, seg + 1));
      if (depth === 1 && p.coralPolyps > 0) {
        const pc = p.coralPolypColorL;
        for (let k = 0; k < p.coralPolyps; k++) {
          const off = V.mul(V.rot(anyPerp(direction), V.norm(direction), 2 * Math.PI * k / p.coralPolyps), thick);
          mb.blob(V.add(V.add(end, off), V.mul(direction, thick * 0.3)), thick * 0.45, () => pc, r, { subdiv: 1 });
        }
        return;
      }
      const spin = r.uniform(0, 2 * Math.PI);
      for (let c = 0; c < p.coralBranchCount; c++) {
        // Children fan out evenly around the parent and tilt away from it, so the coral spreads like a bush.
        const a = spin + 2 * Math.PI * c / p.coralBranchCount + r.uniform(-0.4, 0.4);
        let nd = V.norm(V.add(V.mul(direction, 1 - 0.5 * p.coralBranchAngle), V.mul([Math.cos(a), Math.sin(a), 0], p.coralBranchAngle)));
        if (nd[2] < 0.15) nd = V.norm(V.add(nd, [0, 0, 0.3]));
        branch(end, nd, length * p.coralBranchLength, thick * 0.7, depth - 1);
      }
    };
    const a = r.uniform(0, 2 * Math.PI);
    branch(pos, V.norm([Math.cos(a) * 0.3, Math.sin(a) * 0.3, 1]), p.coralLength, p.coralThickness, depthMax);
  }

  function genAnemone(mb, p, r, pos) {
    const body = jitterColor(r, p.anemoneColorL, p.colorVariation), tip = jitterColor(r, p.anemoneTipColorL, p.colorVariation);
    const size = Math.max(0.02, vary(r, p.anemoneSize, 0.25));
    const column = [0, 1, 2, 3].map((s) => V.add(pos, [0, 0, size * 0.8 * s / 3]));
    mb.tube(column, [size * 0.45, size * 0.38, size * 0.4, size * 0.5], Math.max(8, p.tubeSides * 2), gradient(V.mul(body, 0.8), body, 4));
    const top = column[3];
    for (let row = 0; row < p.anemoneRows; row++) {
      const n = p.anemoneTentacles, rr = size * (0.45 - 0.12 * row);
      for (let k = 0; k < n; k++) {
        const a = 2 * Math.PI * k / n + row * Math.PI / n + r.uniform(-0.1, 0.1), out = [Math.cos(a), Math.sin(a), 0];
        const start = V.add(top, V.mul(out, rr));
        const length = size * p.anemoneTentacleLength * r.uniform(0.8, 1.2) * (1 - 0.15 * row);
        const mid = V.add(V.add(start, V.mul(out, length * 0.45)), [0, 0, length * (0.5 + 0.15 * row)]);
        const end = V.add(V.add(V.add(start, V.mul(out, length * 0.75)), [0, 0, length * (0.45 + 0.3 * row)]), V.mul([r.uniform(-1, 1), r.uniform(-1, 1), 0], length * 0.15));
        const path = bezierPath(start, mid, end, 4);
        mb.tube(path, path.map((_, s) => size * 0.07 * (1 - 0.6 * s / 4)), 4, gradient(body, tip, 5));
      }
    }
  }

  function genLilypad(mb, p, r, pos) {
    const cv = p.colorVariation;
    const cIn = jitterColor(r, p.baseColorL, cv), cOut = jitterColor(r, p.tipColorL, cv);
    const rad = Math.max(0.02, vary(r, p.lilySize, 0.3));
    const sides = 24, notch = deg(p.lilyNotch);
    const vein = V.mul(cOut, 1 + p.lilyVeins);
    const bite = r.random() < p.biteChance, biteAt = r.int(3, sides - 4), biteSize = r.uniform(0.25, 0.5);
    const rot = r.uniform(0, 2 * Math.PI);
    const hub = V.add(pos, [0, 0, 0.002]);
    const rim = [];
    for (let k = 0; k <= sides; k++) {
      const a = rot + notch * 0.5 + (2 * Math.PI - notch) * k / sides;
      let rr = rad * (1 + r.uniform(-0.04, 0.04));
      if (bite) rr *= 1 - biteSize * Math.exp(-(((k - biteAt) / 1.6) ** 2));
      rim.push(V.add(pos, [Math.cos(a) * rr, Math.sin(a) * rr, p.lilyCup * rad]));
    }
    // Every third spoke carries a vein: lighter (or darker) from the stem to the rim.
    for (let k = 0; k < sides; k++) mb.tri(hub, rim[k], rim[k + 1], cIn, k % 3 === 0 ? vein : cOut, (k + 1) % 3 === 0 ? vein : cOut);
    if (p.lilyStems && p.waterModeResolved === "SURFACE" && p.waterSurface > 1e-3) {
      // Built at the pad's height and lifted with it, so it always ends on the bottom.
      const bottom = V.add(V.sub(pos, [0, 0, p.waterSurface]), V.mul([r.uniform(-1, 1), r.uniform(-1, 1), 0], rad * 0.4));
      mb.tube(bezierPath(pos, V.add(V.lerp(pos, bottom, 0.5), [rad * 0.3, 0, 0]), bottom, 5), Array(6).fill(rad * 0.05), 4, gradient(cIn, V.mul(cIn, 0.6), 6), { capTip: false });
    }
    if (p.lilyFlower && r.random() < p.lilyFlowerChance) {
      const Mh = headMatrix(UP);
      const tip = V.add(pos, [r.uniform(-rad, rad) * 0.3, r.uniform(-rad, rad) * 0.3, 0.01]);
      for (let layer = 0; layer < 2; layer++) {
        for (let i = 0; i < 8; i++) {
          const a = 2 * Math.PI * i / 8 + layer * Math.PI / 8;
          petal(mb, p, Mh, tip, [Math.cos(a), Math.sin(a), 0], rad * (0.5 - 0.1 * layer), rad * 0.14, 35 + 25 * layer, 0.2, p.petalColorL, p.petalTipColorL);
        }
      }
      flowerCenter(mb, p, r, tip, Mh, rad * 0.08, cIn, rad * 0.05);
    }
  }

  /** Floating carpet of tiny round fronds, some with a short root hanging below. */
  function genDuckweed(mb, p, r, pos) {
    const c0 = jitterColor(r, p.baseColorL, p.colorVariation), c1 = jitterColor(r, p.tipColorL, p.colorVariation);
    for (let f = 0; f < p.duckweedFronds; f++) {
      const a = r.uniform(0, 2 * Math.PI), rr = p.areaSize * 0.15 * Math.sqrt(r.random());
      const at = V.add(pos, [Math.cos(a) * rr, Math.sin(a) * rr, r.uniform(0, 0.004)]);
      const rad = p.duckweedSize * r.uniform(0.7, 1.3);
      const hub = V.add(at, [0, 0, rad * 0.08]);
      const rim = Array.from({ length: 7 }, (_, k) => V.add(at, [Math.cos(2 * Math.PI * k / 7) * rad * r.uniform(0.85, 1.1), Math.sin(2 * Math.PI * k / 7) * rad * r.uniform(0.85, 1.1), 0]));
      const col = V.lerp(c0, c1, r.random());
      for (let k = 0; k < 7; k++) mb.tri(hub, rim[k], rim[(k + 1) % 7], V.mul(col, 1.12), col, col);
      if (p.duckweedRoots && r.random() < 0.5) {
        mb.tube([at, V.sub(at, [0, 0, rad * r.uniform(1.5, 3)])], [rad * 0.08, rad * 0.04], 3, [V.mul(c0, 0.6), V.mul(c0, 0.5)], { capTip: false });
      }
    }
  }

  // ── Registration ─────────────────────────────────────────────────────────────────────────────────────────────────

  G.register("VINE", {
    category: "climbers", label: "Enredadera",
    params: { "Enredadera": [
      ["vineLength", "Longitud", "num", 1.5, 0.1, 3, 0.01], ["vineSegments", "Segmentos", "int", 24, 4, 60, 1],
      ["vineWidth", "Grosor", "num", 0.02, 0.003, 0.1, 0.001], ["vineWobble", "Serpenteo", "num", 0.5, 0, 2, 0.01],
      ["vineClimb", "Subida", "num", 0.7, -1, 2, 0.01], ["vineLeaves", "Nº hojas", "int", 8, 0, 40, 1],
      ["vineLeafSize", "Tam. hoja", "num", 0.1, 0.01, 0.4, 0.005], ["vineLeafColor", "Color hoja", "color", L(0.2, 0.6, 0.15)],
      ["vineTendrils", "Zarcillos", "int", 3, 0, 20, 1],
    ] },
    defaults: { count: 3, separation: 0.4, tubeSides: 4, baseColor: L(0.25, 0.35, 0.12), tipColor: L(0.35, 0.55, 0.15) },
  }, genVine, [
    { key: "IVY", label: "Hiedra", values: {} },
    { key: "GRAPE", label: "Parra", values: { vineLeafColor: L(0.25, 0.5, 0.1), vineLeafSize: 0.14, vineTendrils: 6, baseColor: L(0.3, 0.2, 0.1), tipColor: L(0.4, 0.3, 0.15) } },
    { key: "FLOWER", label: "Con flores", values: { vineLeafColor: L(0.15, 0.5, 0.12), vineTendrils: 2 } },
  ]);

  G.register("HANGING", {
    category: "climbers", label: "Colgante", water: "HANGING",
    params: { "Colgante": [
      ["hangCeiling", "Techo (bloques)", "num", 1, 0.3, 1.5, 0.01, "Altura del bloque del que cuelga"],
      ["hangStrands", "Hebras", "int", 8, 1, 40, 1], ["hangLength", "Largo", "num", 0.7, 0.05, 1.5, 0.01],
      ["hangLeaves", "Hojas por hebra", "int", 4, 0, 12, 1], ["hangBerries", "Bayas por hebra", "int", 0, 0, 8, 1],
      ["vineWidth", "Grosor", "num", 0.012, 0.003, 0.06, 0.001], ["vineLeafSize", "Tam. hoja", "num", 0.07, 0.01, 0.3, 0.005],
      ["heightVariation", "Var. largo", "num", 0.3, 0, 1, 0.01],
      ["stemLeafColor", "Color hoja", "color", L(0.25, 0.5, 0.18)], ["berryColor", "Color bayas", "color", L(0.75, 0.15, 0.2)],
    ] },
    defaults: { count: 1, areaSize: 0.8, segments: 5, baseColor: L(0.3, 0.25, 0.15), tipColor: L(0.4, 0.5, 0.2) },
  }, genHanging, [
    { key: "ROOTS", label: "Raíces", values: { baseColor: L(0.3, 0.22, 0.12), tipColor: L(0.45, 0.35, 0.2), hangLeaves: 0, hangBerries: 0, vineWidth: 0.014 } },
    { key: "MOSS", label: "Musgo colgante", values: { baseColor: L(0.2, 0.35, 0.1), tipColor: L(0.4, 0.6, 0.2), hangLeaves: 6, vineLeafSize: 0.05, stemLeafColor: L(0.25, 0.5, 0.15), hangBerries: 0 } },
    { key: "BERRIES", label: "Enredadera con bayas", values: { baseColor: L(0.3, 0.25, 0.15), tipColor: L(0.4, 0.5, 0.2), hangLeaves: 4, hangBerries: 2 } },
  ]);

  G.register("MUSHROOM", {
    category: "fungi", label: "Seta",
    params: { "Seta": [
      ["mushroomStemHeight", "Altura tallo", "num", 0.35, 0.02, 1, 0.01], ["mushroomStemVar", "Var. tallo", "num", 0.25, 0, 1, 0.01],
      ["mushroomStemWidth", "Ancho tallo", "num", 0.06, 0.005, 0.2, 0.001], ["mushroomCapSize", "Tamaño sombrero", "num", 0.2, 0.02, 0.5, 0.005],
      ["mushroomCapVar", "Var. sombrero", "num", 0.25, 0, 1, 0.01], ["mushroomCapFlatten", "Altura sombrero", "num", 0.55, 0.1, 1.5, 0.01],
      ["mushroomCapWaves", "Ondas borde", "int", 6, 0, 20, 1], ["mushroomSpots", "Manchas", "int", 6, 0, 30, 1],
      ["mushroomCracks", "Grietas", "num", 0, 0, 0.5, 0.01], ["mushroomCrackDark", "Oscuridad grietas", "num", 0.45, 0, 1, 0.01],
      ["mushroomCapColor", "Sombrero base", "color", L(0.8, 0.2, 0.1)], ["mushroomCapTipColor", "Sombrero punta", "color", L(0.95, 0.5, 0.2)],
      ["mushroomSpotColor", "Color manchas", "color", L(0.98, 0.95, 0.9)], ["mushroomStemColor", "Color tallo", "color", L(0.9, 0.85, 0.7)],
      ["mushroomGillColor", "Color láminas", "color", L(0.85, 0.8, 0.7)],
    ] },
    defaults: { count: 5, distribution: "CLUSTERS", areaSize: 1, clusterCount: 2, clusterSpread: 0.25, segments: 5, tubeSides: 6 },
  }, genMushroom, [
    { key: "AMANITA", label: "Amanita (roja)", values: { mushroomCapColor: L(0.75, 0.04, 0.02), mushroomCapTipColor: L(0.95, 0.18, 0.04), mushroomSpots: 8, mushroomSpotColor: L(0.98, 0.95, 0.9), mushroomStemColor: L(0.9, 0.87, 0.75) } },
    { key: "BUTTON", label: "Champiñón", values: { mushroomCapColor: L(0.78, 0.68, 0.52), mushroomCapTipColor: L(0.95, 0.9, 0.8), mushroomSpots: 0, mushroomCapFlatten: 0.7, mushroomStemColor: L(0.92, 0.88, 0.8) } },
    { key: "BOLETE", label: "Boletus (marrón)", values: { mushroomCapColor: L(0.3, 0.13, 0.04), mushroomCapTipColor: L(0.5, 0.25, 0.08), mushroomSpots: 0, mushroomCapFlatten: 0.75, mushroomStemColor: L(0.85, 0.75, 0.55), mushroomStemWidth: 0.09 } },
    { key: "GLOW", label: "Brillante (mágica)", values: { mushroomCapColor: L(0.03, 0.25, 0.85), mushroomCapTipColor: L(0.25, 0.85, 1), mushroomSpots: 6, mushroomSpotColor: L(0.6, 1, 1), mushroomStemColor: L(0.75, 0.85, 0.95) } },
  ]);

  G.register("PEBBLES", {
    category: "fungi", label: "Piedras",
    params: {
      "Piedras": [
        ["rockStyle", "Estilo", [["VOXEL", "Voxel (cubitos)"], ["SMOOTH", "Suave"]], "VOXEL"],
        ["rockVoxel", "Tamaño cubito", "num", 0.0625, 0.02, 0.2, 0.0025, "En bloques: 0.0625 = 1/16 de bloque, 4 px del sprite de 64"],
        ["rockDither", "Variación por cubito", "num", 0.06, 0, 0.4, 0.01], ["rockSize", "Tamaño", "num", 0.1, 0.02, 0.5, 0.005],
        ["rockVar", "Var. tamaño", "num", 0.4, 0, 1, 0.01], ["rockFlatten", "Aplanado", "num", 0.55, 0.1, 1, 0.01],
        ["rockNoise", "Irregularidad", "num", 0.2, 0, 1, 0.01], ["rockDetail", "Detalle (suave)", "int", 2, 1, 4, 1],
        ["rockColor", "Color base", "color", L(0.32, 0.31, 0.3)], ["rockTipColor", "Color punta", "color", L(0.55, 0.53, 0.5)],
      ],
      "Grietas y musgo": [
        ["rockCracks", "Grietas", "num", 0.12, 0, 0.5, 0.01], ["rockCrackSize", "Tamaño trozos", "num", 0.6, 0.1, 3, 0.01],
        ["rockCrackDepth", "Profundidad grietas", "num", 0.06, 0, 0.3, 0.005], ["rockCrackDark", "Oscuridad grietas", "num", 0.5, 0, 1, 0.01],
        ["mossAmount", "Musgo", "num", 0, 0, 1, 0.01], ["mossColor", "Color musgo", "color", L(0.25, 0.42, 0.15)],
      ],
      "Minerales": [
        ["oreAmount", "Cantidad", "num", 0, 0, 1, 0.01, "0 = piedra sin mineral"],
        ["oreStyle", "Forma", [["SPECKS", "Motas"], ["NUGGETS", "Pepitas (en grupos)"], ["VEINS", "Vetas"]], "SPECKS"],
        ["oreSize", "Tamaño", "num", 0.12, 0.03, 0.5, 0.005, "En bloques: lo grande que es cada mota o lo ancha que ondula la veta"],
        ["oreColor", "Color", "color", L(0.02, 0.02, 0.025)],
        ["oreTipColor", "Color brillo", "color", L(0.12, 0.12, 0.14)],
        ["oreShine", "Brillo", "num", 0.5, 0, 1, 0.01, "Cuánto llega el color de brillo al centro de cada mota o veta"],
      ],
    },
    defaults: { count: 6, distribution: "DISC", areaSize: 0.9, minDistance: 0.15 },
  }, genPebbles, [
    { key: "GREY", label: "Gris", values: { rockColor: L(0.32, 0.31, 0.3), rockTipColor: L(0.55, 0.53, 0.5), mossAmount: 0, oreAmount: 0 } },
    { key: "SAND", label: "Arenisca", values: { rockColor: L(0.5, 0.36, 0.2), rockTipColor: L(0.8, 0.65, 0.42), mossAmount: 0, oreAmount: 0 } },
    { key: "DARK", label: "Oscura (basalto)", values: { rockColor: L(0.1, 0.1, 0.11), rockTipColor: L(0.28, 0.28, 0.3), mossAmount: 0, oreAmount: 0 } },
    { key: "MOSSY", label: "Con musgo", values: { rockColor: L(0.3, 0.3, 0.28), rockTipColor: L(0.5, 0.5, 0.46), mossAmount: 0.55, oreAmount: 0 } },
    { key: "COPPER_PEBBLES", label: "Guijarros con cobre", values: { rockColor: L(0.3, 0.3, 0.29), rockTipColor: L(0.5, 0.49, 0.47), mossAmount: 0, oreAmount: 0.4, oreStyle: "SPECKS", oreSize: 0.04, oreColor: L(0.42, 0.13, 0.03), oreTipColor: L(0.95, 0.5, 0.18), oreShine: 0.6 } },
  ]);

  G.register("CRYSTAL", {
    category: "fungi", label: "Cristales",
    params: { "Cristales": [
      ["crystalCount", "Cristales", "int", 6, 1, 30, 1], ["crystalLength", "Largo", "num", 0.7, 0.05, 1.4, 0.01],
      ["crystalRadius", "Radio", "num", 0.09, 0.01, 0.3, 0.005], ["crystalSides", "Caras", "int", 6, 3, 12, 1],
      ["crystalTip", "Punta", "num", 0.3, 0.05, 0.9, 0.01], ["crystalSpread", "Apertura", "num", 45, 0, 85, 1],
      ["crystalFacets", "Brillo facetas", "num", 0.15, 0, 0.6, 0.01], ["crystalShards", "Esquirlas", "int", 3, 0, 20, 1],
      ["crystalColor", "Color base", "color", L(0.35, 0.2, 0.75)], ["crystalTipColor", "Color punta", "color", L(0.8, 0.7, 1)],
    ] },
    defaults: { count: 1 },
  }, genCrystal, [
    { key: "AMETHYST", label: "Amatista", values: { crystalColor: L(0.35, 0.2, 0.75), crystalTipColor: L(0.8, 0.7, 1) } },
    { key: "EMERALD", label: "Esmeralda", values: { crystalColor: L(0.03, 0.45, 0.12), crystalTipColor: L(0.5, 1, 0.6) } },
    { key: "RUBY", label: "Rubí", values: { crystalColor: L(0.55, 0.01, 0.04), crystalTipColor: L(1, 0.4, 0.45) } },
    { key: "SAPPHIRE", label: "Zafiro", values: { crystalColor: L(0.04, 0.12, 0.65), crystalTipColor: L(0.5, 0.7, 1) } },
    { key: "QUARTZ", label: "Cuarzo", values: { crystalColor: L(0.75, 0.75, 0.8), crystalTipColor: L(1, 1, 1) } },
    { key: "TOPAZ", label: "Topacio", values: { crystalColor: L(0.85, 0.45, 0.03), crystalTipColor: L(1, 0.85, 0.4) } },
  ]);

  G.register("FERN", {
    category: "herbs", label: "Helecho",
    params: { "Helecho": [
      ["bladeHeight", "Largo fronda", "num", 0.8, 0.1, 1.4, 0.01], ["heightVariation", "Var. largo", "num", 0.2, 0, 1, 0.01],
      ["fernFronds", "Frondas", "int", 7, 1, 20, 1], ["fernPinnae", "Foliolos", "int", 8, 2, 20, 1],
      ["fernLift", "Elevación", "num", 0.7, 0, 1.5, 0.01], ["fernFiddleheads", "Brotes enrollados", "int", 0, 0, 8, 1],
    ] },
    defaults: { count: 1, tipColor: L(0.25, 0.6, 0.2) },
  }, genFern, [
    { key: "GREEN", label: "Verde", values: { tipColor: L(0.25, 0.6, 0.2), fernFiddleheads: 0 } },
    { key: "YOUNG", label: "Joven (con brotes)", values: { tipColor: L(0.35, 0.7, 0.2), fernFiddleheads: 3 } },
    { key: "DRY", label: "Seco", values: { tipColor: L(0.55, 0.4, 0.15), fernLift: 0.45 } },
  ]);

  G.register("CLOVER", {
    category: "herbs", label: "Trébol",
    params: { "Trébol": [
      ["cloverStems", "Hojas", "int", 5, 1, 20, 1], ["cloverHeight", "Altura", "num", 0.12, 0.02, 0.5, 0.005],
      ["cloverLeaflets", "Foliolos", "int", 3, 3, 4, 1], ["cloverLeafSize", "Tam. foliolo", "num", 0.06, 0.01, 0.2, 0.002],
      ["stemWidth", "Ancho tallo", "num", 0.03, 0.005, 0.1, 0.001],
      ["cloverFlower", "Flores", "bool", true], ["petalColor", "Color flor", "color", L(0.95, 0.85, 0.95)],
    ] },
    defaults: { count: 12, distribution: "DISC", areaSize: 0.9, minDistance: 0.1, baseColor: L(0.15, 0.4, 0.1), tipColor: L(0.28, 0.62, 0.22) },
  }, genClover, [
    { key: "WHITE", label: "Flor blanca", values: { petalColor: L(0.95, 0.9, 0.95), cloverFlower: true, cloverLeaflets: 3 } },
    { key: "PINK", label: "Flor rosa", values: { petalColor: L(0.95, 0.35, 0.6), cloverFlower: true, cloverLeaflets: 3 } },
    { key: "LUCKY", label: "Cuatro hojas", values: { cloverFlower: false, cloverLeaflets: 4 } },
  ]);

  G.register("REEDS", {
    category: "herbs", label: "Juncos / espadañas", water: "EMERGENT",
    params: { "Juncos": [
      ["bladeHeight", "Altura", "num", 1.4, 0.2, 1.6, 0.01], ["heightVariation", "Var. altura", "num", 0.2, 0, 1, 0.01],
      ["reedLeaves", "Hojas", "int", 6, 0, 20, 1], ["reedLeafWidth", "Ancho hoja", "num", 0.05, 0.005, 0.15, 0.001],
      ["reedHeads", "Espigas", "int", 2, 0, 8, 1], ["reedHeadLength", "Largo espiga", "num", 0.18, 0.02, 0.6, 0.01],
      ["reedHeadColor", "Color espiga", "color", L(0.35, 0.2, 0.1)],
      ["stemNodes", "Nudos", "int", 0, 0, 6, 1], ["stemNodeDark", "Oscuridad nudos", "num", 0.25, 0, 0.8, 0.01],
      ["brokenChance", "Rotas", "num", 0, 0, 1, 0.01],
    ] },
    defaults: { count: 3, distribution: "CLUSTERS", areaSize: 0.8, clusterCount: 1, clusterSpread: 0.3, segments: 5, inclination: 4, bend: 0.3, waterDepth: 0.8, emergeHeight: 0.8, multipart: true,
      baseColor: L(0.18, 0.38, 0.12), tipColor: L(0.5, 0.72, 0.3) },
  }, genReeds, [
    { key: "CATTAIL", label: "Espadaña (enea)", values: { reedHeads: 2, reedHeadColor: L(0.35, 0.2, 0.1) } },
    { key: "RUSH", label: "Junco sin espiga", values: { reedHeads: 0, reedLeafWidth: 0.03 } },
    { key: "DRY", label: "Seco", values: { baseColor: L(0.4, 0.35, 0.15), tipColor: L(0.75, 0.65, 0.35), reedHeadColor: L(0.3, 0.2, 0.12) } },
  ]);

  G.register("PAPYRUS", {
    category: "herbs", label: "Papiro", water: "EMERGENT",
    params: { "Papiro": [
      ["bladeHeight", "Altura", "num", 1.4, 0.2, 1.6, 0.01], ["heightVariation", "Var. altura", "num", 0.2, 0, 1, 0.01],
      ["papyrusStems", "Tallos", "int", 5, 1, 15, 1], ["papyrusRays", "Rayos", "int", 18, 4, 40, 1],
      ["papyrusRayLength", "Largo rayos", "num", 0.25, 0.03, 0.6, 0.01], ["stemWidth", "Ancho tallo", "num", 0.03, 0.005, 0.1, 0.001],
    ] },
    defaults: { count: 1, segments: 5, bend: 0.2, baseColor: L(0.2, 0.45, 0.15), tipColor: L(0.45, 0.7, 0.25) },
  }, genPapyrus);

  G.register("BAMBOO", {
    category: "herbs", label: "Bambú",
    params: { "Bambú": [
      ["bambooCulms", "Cañas", "int", 3, 1, 10, 1], ["bambooHeight", "Altura", "num", 1.5, 0.2, 2.2, 0.01],
      ["heightVariation", "Var. altura", "num", 0.15, 0, 1, 0.01], ["bambooRadius", "Radio", "num", 0.035, 0.005, 0.12, 0.001],
      ["bambooNodes", "Nudos", "int", 6, 1, 14, 1], ["bambooLeaves", "Hojas por nudo", "int", 3, 0, 8, 1],
      ["stemLeafSize", "Tam. hoja", "num", 0.22, 0.03, 0.5, 0.005], ["stemNodeDark", "Oscuridad nudos", "num", 0.2, 0, 0.8, 0.01],
      ["stemLeafColor", "Color hoja", "color", L(0.3, 0.6, 0.2)],
    ] },
    defaults: { count: 1, inclination: 2, baseColor: L(0.35, 0.55, 0.18), tipColor: L(0.5, 0.7, 0.25), multipart: true, cells: 2, fillCells: true },
  }, genBamboo, [
    { key: "GREEN", label: "Verde", values: { baseColor: L(0.35, 0.55, 0.18), tipColor: L(0.5, 0.7, 0.25) } },
    { key: "GOLDEN", label: "Dorado", values: { baseColor: L(0.7, 0.55, 0.12), tipColor: L(0.85, 0.75, 0.3) } },
    { key: "BLACK", label: "Negro", values: { baseColor: L(0.06, 0.05, 0.04), tipColor: L(0.15, 0.13, 0.1) } },
  ]);

  G.register("SUGAR_CANE", {
    category: "herbs", label: "Caña de azúcar",
    params: { "Caña": [
      ["caneCount", "Cañas", "int", 4, 1, 10, 1], ["caneHeight", "Altura", "num", 1.5, 0.2, 2.2, 0.01],
      ["heightVariation", "Var. altura", "num", 0.15, 0, 1, 0.01], ["caneSpread", "Separación", "num", 0.12, 0, 0.4, 0.005],
      ["caneRadius", "Radio", "num", 0.028, 0.005, 0.1, 0.001], ["caneNodes", "Nudos", "int", 8, 1, 16, 1],
      ["stemNodeDark", "Oscuridad nudos", "num", 0.18, 0, 0.8, 0.01],
      ["caneLeafChance", "Hojas en nudos", "num", 0.7, 0, 1, 0.01, "Probabilidad de una hoja en cada nudo; más abajo, más"],
      ["caneTipLeaves", "Hojas en la punta", "int", 2, 0, 6, 1],
      ["stemLeafSize", "Largo hoja", "num", 0.4, 0.05, 0.8, 0.005], ["stemLeafColor", "Color hoja", "color", L(0.25, 0.55, 0.15)],
    ] },
    defaults: { count: 1, inclination: 2, baseColor: L(0.35, 0.6, 0.2), tipColor: L(0.55, 0.75, 0.3), multipart: true, cells: 2, fillCells: true },
  }, genSugarCane, [
    { key: "GREEN", label: "Verde", values: { baseColor: L(0.35, 0.6, 0.2), tipColor: L(0.55, 0.75, 0.3), stemLeafColor: L(0.25, 0.55, 0.15) } },
    { key: "PURPLE", label: "Morada", values: { baseColor: L(0.25, 0.08, 0.15), tipColor: L(0.45, 0.2, 0.3), stemLeafColor: L(0.22, 0.45, 0.12) } },
    { key: "DRY", label: "Seca", values: { baseColor: L(0.55, 0.45, 0.15), tipColor: L(0.75, 0.65, 0.3), stemLeafColor: L(0.55, 0.45, 0.18) } },
  ]);

  G.register("SEAWEED", {
    category: "water", label: "Alga (kelp)", water: "UNDERWATER",
    params: { "Alga": [
      ["seaweedLength", "Longitud", "num", 1.2, 0.1, 1.6, 0.01], ["seaweedSegments", "Segmentos", "int", 16, 4, 40, 1],
      ["seaweedWidth", "Ancho cinta", "num", 0.05, 0.005, 0.2, 0.001], ["seaweedWaves", "Ondas", "num", 3, 0.5, 8, 0.1],
      ["seaweedAmplitude", "Amplitud", "num", 0.15, 0, 0.6, 0.01], ["seaweedLeafCount", "Nº hojas", "int", 4, 0, 16, 1],
      ["seaweedLeafSize", "Tam. hoja", "num", 0.15, 0.02, 0.4, 0.005], ["seaweedBladders", "Vesículas", "int", 0, 0, 12, 1],
      ["seaweedColor", "Color base", "color", L(0.1, 0.35, 0.2)], ["seaweedTipColor", "Color punta", "color", L(0.2, 0.6, 0.3)],
      ["seaweedLeafColor", "Color hoja", "color", L(0.15, 0.5, 0.25)], ["seaweedBladderColor", "Color vesículas", "color", L(0.35, 0.45, 0.15)],
    ] },
    defaults: { count: 4, separation: 0.5, waterDepth: 2, waterFill: true, multipart: true },
  }, genSeaweed, [
    { key: "KELP", label: "Kelp verde", values: { seaweedColor: L(0.1, 0.35, 0.2), seaweedTipColor: L(0.2, 0.6, 0.3), seaweedLeafColor: L(0.15, 0.5, 0.25), seaweedBladders: 0 } },
    { key: "BROWN", label: "Alga parda", values: { seaweedColor: L(0.22, 0.16, 0.04), seaweedTipColor: L(0.45, 0.35, 0.1), seaweedLeafColor: L(0.35, 0.28, 0.08), seaweedBladders: 4 } },
    { key: "RED", label: "Alga roja", values: { seaweedColor: L(0.3, 0.03, 0.04), seaweedTipColor: L(0.65, 0.15, 0.12), seaweedLeafColor: L(0.5, 0.1, 0.1), seaweedBladders: 0 } },
  ]);

  G.register("SEAGRASS", {
    category: "water", label: "Hierba marina", water: "UNDERWATER",
    params: { "Hierba marina": [
      ["seagrassBlades", "Hojas por mata", "int", 8, 1, 30, 1], ["seagrassWidth", "Ancho hoja", "num", 0.035, 0.003, 0.12, 0.001],
      ["bladeHeight", "Altura", "num", 0.6, 0.05, 1.4, 0.01], ["heightVariation", "Var. altura", "num", 0.3, 0, 1, 0.01],
      ["seaweedAmplitude", "Ondulación", "num", 0.12, 0, 0.5, 0.01],
    ] },
    defaults: { count: 5, distribution: "CLUSTERS", areaSize: 0.8, clusterCount: 2, clusterSpread: 0.25, baseColor: L(0.12, 0.35, 0.18), tipColor: L(0.3, 0.6, 0.3) },
  }, genSeagrass, [
    { key: "GREEN", label: "Verde", values: { baseColor: L(0.12, 0.35, 0.18), tipColor: L(0.3, 0.6, 0.3) } },
    { key: "TEAL", label: "Verde azulado", values: { baseColor: L(0.05, 0.3, 0.28), tipColor: L(0.2, 0.6, 0.5) } },
    { key: "OLIVE", label: "Oliva", values: { baseColor: L(0.25, 0.3, 0.08), tipColor: L(0.5, 0.55, 0.2) } },
  ]);

  G.register("CORAL", {
    category: "water", label: "Coral", water: "UNDERWATER",
    params: { "Coral": [
      ["coralLength", "Longitud rama", "num", 0.5, 0.05, 1, 0.01], ["coralThickness", "Grosor rama", "num", 0.06, 0.01, 0.2, 0.002],
      ["coralDepth", "Niveles", "int", 3, 1, 5, 1], ["coralBranchCount", "Ramas por nudo", "int", 2, 1, 4, 1],
      ["coralBranchAngle", "Apertura", "num", 0.8, 0.1, 1.5, 0.01], ["coralBranchLength", "Long. rama hija", "num", 0.6, 0.3, 0.9, 0.01],
      ["coralSegments", "Segmentos", "int", 4, 2, 10, 1], ["coralPolyps", "Pólipos", "int", 0, 0, 8, 1],
      ["coralColor", "Color base", "color", L(0.9, 0.3, 0.5)], ["coralTipColor", "Color punta", "color", L(1, 0.5, 0.7)],
      ["coralPolypColor", "Color pólipos", "color", L(1, 0.85, 0.9)],
    ] },
    defaults: { count: 3, separation: 0.6, tubeSides: 5 },
  }, genCoral, [
    { key: "PINK", label: "Rosa", values: { coralColor: L(0.9, 0.3, 0.5), coralTipColor: L(1, 0.5, 0.7) } },
    { key: "ORANGE", label: "Naranja", values: { coralColor: L(0.95, 0.3, 0.06), coralTipColor: L(1, 0.6, 0.25) } },
    { key: "PURPLE", label: "Morado", values: { coralColor: L(0.4, 0.08, 0.55), coralTipColor: L(0.75, 0.4, 0.9) } },
    { key: "YELLOW", label: "Amarillo", values: { coralColor: L(0.85, 0.65, 0.05), coralTipColor: L(1, 0.95, 0.4) } },
    { key: "BLUE", label: "Azul", values: { coralColor: L(0.05, 0.25, 0.7), coralTipColor: L(0.4, 0.75, 1) } },
  ]);

  G.register("ANEMONE", {
    category: "water", label: "Anémona", water: "UNDERWATER",
    params: { "Anémona": [
      ["anemoneSize", "Tamaño", "num", 0.2, 0.03, 0.5, 0.005], ["anemoneTentacles", "Tentáculos", "int", 12, 3, 40, 1],
      ["anemoneTentacleLength", "Largo tentáculos", "num", 1.2, 0.2, 3, 0.01], ["anemoneRows", "Filas", "int", 2, 1, 4, 1],
      ["anemoneColor", "Color cuerpo", "color", L(0.85, 0.35, 0.45)], ["anemoneTipColor", "Color puntas", "color", L(1, 0.8, 0.85)],
    ] },
    defaults: { count: 2, distribution: "DISC", areaSize: 0.6, minDistance: 0.25, tubeSides: 5 },
  }, genAnemone, [
    { key: "PINK", label: "Rosa", values: { anemoneColor: L(0.85, 0.35, 0.45), anemoneTipColor: L(1, 0.8, 0.85) } },
    { key: "ORANGE", label: "Naranja", values: { anemoneColor: L(0.95, 0.35, 0.04), anemoneTipColor: L(1, 0.85, 0.7) } },
    { key: "GREEN", label: "Verde", values: { anemoneColor: L(0.1, 0.45, 0.22), anemoneTipColor: L(0.6, 1, 0.5) } },
    { key: "PURPLE", label: "Morada", values: { anemoneColor: L(0.35, 0.1, 0.55), anemoneTipColor: L(0.85, 0.6, 1) } },
  ]);

  G.register("LILYPAD", {
    category: "water", label: "Nenúfar", water: "SURFACE",
    params: { "Nenúfar": [
      ["lilySize", "Tamaño hoja", "num", 0.22, 0.03, 0.5, 0.005], ["lilyNotch", "Corte", "num", 30, 0, 90, 1],
      ["lilyCup", "Borde levantado", "num", 0.05, 0, 0.5, 0.01], ["lilyVeins", "Nervios", "num", 0.15, -0.6, 0.6, 0.01],
      ["lilyStems", "Tallos hasta el fondo", "bool", false],
      ["lilyFlower", "Flores", "bool", true], ["lilyFlowerChance", "Prob. flor", "num", 0.35, 0, 1, 0.01],
      ["petalSegments", "Segmentos pétalo", "int", 4, 3, 8, 1],
      ["petalColor", "Pétalo base", "color", L(0.98, 0.85, 0.92)], ["petalTipColor", "Pétalo punta", "color", L(0.95, 0.55, 0.75)],
      ["centerColor", "Color centro", "color", L(1, 0.85, 0.2)],
    ] },
    defaults: { count: 5, distribution: "DISC", areaSize: 1, minDistance: 0.3, baseColor: L(0.12, 0.38, 0.12), tipColor: L(0.3, 0.6, 0.22) },
  }, genLilypad, [
    { key: "PINK", label: "Flor rosa", values: { petalColor: L(0.98, 0.85, 0.92), petalTipColor: L(0.95, 0.55, 0.75), lilyFlower: true } },
    { key: "WHITE", label: "Flor blanca", values: { petalColor: L(1, 1, 0.95), petalTipColor: L(1, 0.97, 0.88), lilyFlower: true } },
    { key: "YELLOW", label: "Flor amarilla", values: { petalColor: L(1, 0.85, 0.15), petalTipColor: L(1, 0.95, 0.5), lilyFlower: true } },
    { key: "NONE", label: "Sin flor", values: { lilyFlower: false } },
  ]);

  G.register("DUCKWEED", {
    category: "water", label: "Lenteja de agua", water: "SURFACE",
    params: { "Lenteja de agua": [
      ["duckweedFronds", "Hojitas", "int", 40, 1, 300, 1], ["duckweedSize", "Tam. hojita", "num", 0.025, 0.005, 0.08, 0.001],
      ["duckweedRoots", "Raicillas", "bool", true],
    ] },
    defaults: { count: 3, distribution: "DISC", areaSize: 1, baseColor: L(0.3, 0.55, 0.12), tipColor: L(0.5, 0.75, 0.2) },
  }, genDuckweed);

  // ── Varieties of the first types ─────────────────────────────────────────────────────────────────────────────────

  G.PRESETS.GRASS = [
    { key: "CLUMP", label: "Mata", values: { count: 40, separation: 0.10, positionJitter: 0.6, bladeHeight: 1.0, heightVariation: 0.45, segments: 4, widthScale: 0.055, widthBase: 1, widthMid: 0.7, widthTip: 0.15, inclination: 10, inclinationVariation: 12, bend: 0.15, leanMode: "RADIAL", leanSpread: 20, baseColor: L(0.12, 0.35, 0.08), tipColor: L(0.55, 0.85, 0.25) } },
    { key: "LAWN", label: "Césped corto", values: { count: 200, separation: 0.06, positionJitter: 0.5, bladeHeight: 0.35, heightVariation: 0.25, segments: 3, widthScale: 0.028, widthBase: 1, widthMid: 0.8, widthTip: 0.25, inclination: 12, inclinationVariation: 10, bend: 0.2, leanMode: "RADIAL", leanSpread: 25, baseColor: L(0.08, 0.32, 0.06), tipColor: L(0.38, 0.78, 0.18) } },
    { key: "WILD", label: "Silvestre", values: { count: 60, separation: 0.12, positionJitter: 0.85, gridRotation: 15, bladeHeight: 0.9, heightVariation: 0.6, segments: 5, widthScale: 0.03, widthBase: 1, widthMid: 0.6, widthTip: 0.1, inclination: 30, inclinationVariation: 25, bend: 0.7, leanMode: "RANDOM", leanSpread: 45, baseColor: L(0.15, 0.33, 0.07), tipColor: L(0.6, 0.78, 0.3), grassSeedChance: 0.2 } },
    { key: "THICK", label: "Gruesa", values: { count: 35, separation: 0.15, positionJitter: 0.5, bladeHeight: 1.2, heightVariation: 0.4, segments: 6, bladeFlatten: 0.7, widthScale: 0.07, widthBase: 1, widthMid: 0.8, widthTip: 0.3, inclination: 12, inclinationVariation: 15, bend: 0.3, leanMode: "RADIAL", leanSpread: 22, baseColor: L(0.07, 0.28, 0.05), tipColor: L(0.33, 0.68, 0.16) } },
    { key: "TALL", label: "Alta", values: { count: 80, separation: 0.14, positionJitter: 0.7, bladeHeight: 1.6, heightVariation: 0.55, segments: 6, widthScale: 0.035, widthBase: 1, widthMid: 0.9, widthTip: 0.2, inclination: 20, inclinationVariation: 20, bend: 0.5, leanMode: "RANDOM", leanSpread: 35, baseColor: L(0.14, 0.36, 0.09), tipColor: L(0.6, 0.85, 0.35) } },
    { key: "WINDY", label: "Con viento", values: { count: 60, separation: 0.11, positionJitter: 0.6, bladeHeight: 1.0, heightVariation: 0.4, segments: 5, widthScale: 0.035, inclination: 28, inclinationVariation: 8, bend: 0.6, leanMode: "WIND", leanSpread: 15, baseColor: L(0.12, 0.35, 0.08), tipColor: L(0.55, 0.85, 0.25) } },
    { key: "AUTUMN", label: "Otoño", values: { count: 50, separation: 0.11, positionJitter: 0.7, bladeHeight: 0.9, heightVariation: 0.5, widthScale: 0.04, inclination: 15, inclinationVariation: 15, bend: 0.3, leanMode: "RADIAL", leanSpread: 25, baseColor: L(0.2, 0.3, 0.05), tipColor: L(0.85, 0.55, 0.1) } },
    { key: "DRY", label: "Seca", values: { count: 45, separation: 0.11, positionJitter: 0.7, bladeHeight: 0.85, heightVariation: 0.55, segments: 5, widthScale: 0.03, widthBase: 1, widthMid: 0.6, widthTip: 0.1, inclination: 25, inclinationVariation: 20, bend: 0.6, leanMode: "RANDOM", leanSpread: 40, baseColor: L(0.3, 0.28, 0.1), tipColor: L(0.75, 0.65, 0.3) } },
    { key: "TROPICAL", label: "Tropical", values: { count: 55, separation: 0.10, positionJitter: 0.6, bladeHeight: 1.1, heightVariation: 0.4, segments: 5, widthScale: 0.05, widthBase: 1, widthMid: 0.85, widthTip: 0.25, inclination: 18, inclinationVariation: 15, bend: 0.4, leanMode: "RADIAL", leanSpread: 30, baseColor: L(0.05, 0.4, 0.08), tipColor: L(0.3, 0.95, 0.2) } },
    { key: "SNOWY", label: "Nevada", values: { baseColor: L(0.1, 0.25, 0.1), tipColor: L(0.85, 0.9, 0.95), bladeHeight: 0.7, tipDry: 0 } },
  ];

  // Flower varieties are keyed like the head shapes: picking a head also gives it its flower's colours.
  G.TYPES.FLOWER.presetParam = "headShape";
  const stem = { stemColor: L(0.15, 0.45, 0.1), stemLeafColor: L(0.2, 0.55, 0.15) };
  G.PRESETS.FLOWER = [
    { key: "DAISY", label: "Margarita", values: { ...stem, headShape: "DAISY", petalColor: L(0.92, 0.92, 0.88), petalTipColor: L(1, 1, 1), centerColor: L(1, 0.72, 0.08), showCenter: true, petalCount: 12, petalLayers: 1, petalLength: 0.17, petalWidth: 0.04, petalTilt: 10, petalCurl: 0.15, centerSize: 0.03, stemHeight: 0.6, headFaceUp: 0.5 } },
    { key: "ROSE", label: "Rosa", values: { ...stem, headShape: "ROSE", petalColor: L(0.5, 0.01, 0.03), petalTipColor: L(0.85, 0.06, 0.08), showCenter: false, petalCount: 6, petalLayers: 4, petalLength: 0.13, petalWidth: 0.07, petalTilt: 30, petalCurl: 0.4, stemColor: L(0.1, 0.35, 0.08), stemHeight: 0.7, headFaceUp: 0.6 } },
    { key: "TULIP", label: "Tulipán", values: { ...stem, headShape: "TULIP", petalColor: L(0.8, 0.06, 0.04), petalTipColor: L(1, 0.3, 0.12), petalCount: 3, petalLayers: 2, petalLength: 0.16, petalWidth: 0.06, stemHeight: 0.65, headFaceUp: 0.8, stemLeafCount: 2, stemLeafSize: 0.2 } },
    { key: "SUNFLOWER", label: "Girasol", values: { ...stem, headShape: "SUNFLOWER", petalColor: L(1, 0.62, 0.01), petalTipColor: L(1, 0.82, 0.08), centerColor: L(0.22, 0.1, 0.02), petalCount: 14, petalLayers: 1, petalLength: 0.22, petalWidth: 0.045, petalTilt: 20, stemHeight: 1.1, stemWidth: 0.04, headFaceUp: 0.2, count: 2, stemLeafSize: 0.18 } },
    { key: "LAVENDER", label: "Lavanda", values: { ...stem, headShape: "LAVENDER", petalColor: L(0.3, 0.15, 0.7), petalTipColor: L(0.55, 0.38, 0.9), petalCount: 8, petalLength: 0.1, petalWidth: 0.03, stemHeight: 0.55, count: 8, separation: 0.3, stemLeafCount: 2, stemColor: L(0.25, 0.42, 0.2), headFaceUp: 0.8 } },
    { key: "BELL", label: "Campanilla", values: { ...stem, headShape: "BELL", petalColor: L(0.2, 0.3, 0.85), petalTipColor: L(0.5, 0.55, 1), petalCount: 6, petalLength: 0.1, petalWidth: 0.04, bend: 0.6, stemHeight: 0.55, headFaceUp: 0 } },
    { key: "DANDELION", label: "Diente de león", values: { ...stem, headShape: "DANDELION", petalColor: L(0.92, 0.92, 0.88), petalTipColor: L(0.72, 0.72, 0.66), petalCount: 6, petalLength: 0.12, petalWidth: 0.06, stemHeight: 0.5, stemColor: L(0.25, 0.45, 0.1), headFaceUp: 0.6 } },
    { key: "POPPY", label: "Amapola", values: { ...stem, headShape: "POPPY", petalColor: L(0.8, 0.02, 0.01), petalTipColor: L(1, 0.12, 0.05), centerColor: L(0.04, 0.03, 0.03), showCenter: true, centerSize: 0.03, petalLength: 0.14, petalWidth: 0.06, petalTilt: 30, stemHeight: 0.6, headFaceUp: 0.6 } },
  ];

  G.TYPES.PUMPKIN.presetParam = "pumpkinStyle";
  G.PRESETS.PUMPKIN = [
    { key: "PUMPKIN", label: "Calabaza", values: { pumpkinStyle: "PUMPKIN", fruitColor: L(0.95, 0.42, 0.04), fruitGreenColor: L(0.25, 0.45, 0.12), fruitStripeColor: L(0.08, 0.25, 0.06), fruitRibs: 8, fruitRibDepth: 0.12, fruitSize: 0.3 } },
    { key: "MELON", label: "Sandía", values: { pumpkinStyle: "MELON", fruitColor: L(0.06, 0.32, 0.05), fruitGreenColor: L(0.2, 0.5, 0.15), fruitStripeColor: L(0.01, 0.1, 0.01), fruitRibs: 8, fruitSize: 0.28 } },
  ];

  G.PRESETS.WHEAT = [
    { key: "WHEAT", label: "Trigo", values: { ripeColor: L(0.85, 0.7, 0.25), ripeTipColor: L(0.95, 0.85, 0.45), awns: 0.25 } },
    { key: "BARLEY", label: "Cebada", values: { ripeColor: L(0.8, 0.72, 0.4), ripeTipColor: L(0.92, 0.88, 0.6), awns: 0.9, grainCount: 16 } },
    { key: "RYE", label: "Centeno", values: { ripeColor: L(0.6, 0.5, 0.28), ripeTipColor: L(0.75, 0.68, 0.45), awns: 0.6 } },
  ];
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
