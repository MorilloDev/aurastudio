"use strict";

// The game's structure generators, ported so a structure comes out here cell for cell as the game builds it: GenRandom
// (SplitMix64 in BigInt), StableHash (FNV-1a), FastNoiseLite's OpenSimplex2 with every step rounded to float, and
// TreeGenerator stage for stage, draw for draw. Writing goes through a set(col, level, row, tile, dir, shape, rule)
// callback, so the Estructuras editor (a map of cells) and the Biomas 3D view (a voxel scene) share one tree.
(function (Aura) {
  const f32 = Math.fround;
  const MASK_64 = (1n << 64n) - 1n;

  // ── OpenSimplex2 (FastNoiseLite, C#) ─────────────────────────────────────────────────────────────────────────────

  const PRIME_X = 501125321, PRIME_Y = 1136930381, PRIME_Z = 1720413743;
  const GRADIENTS_3D = new Float32Array([
    0, 1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 1, 0, -1, 0, -1, 0, -1, 0,
    1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0,
    1, 0, 1, 0, -1, 0, 1, 0, 1, 0, -1, 0, -1, 0, -1, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0, 0,
    0, 1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 1, 0, -1, 0, -1, 0, -1, 0,
    1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0,
    1, 0, 1, 0, -1, 0, 1, 0, 1, 0, -1, 0, -1, 0, -1, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0, 0,
    0, 1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 1, 0, -1, 0, -1, 0, -1, 0,
    1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 0, 0, -1, -1, 0, 0, 1, 1, 0, 0, 0, -1, 1, 0, -1, 1, 0, 0, 0, -1, -1, 0,
  ]);

  const fastRound = (v) => (v >= 0 ? Math.trunc(f32(v + 0.5)) : Math.trunc(f32(v - 0.5)));

  function gradCoord(seed, xp, yp, zp, xd, yd, zd) {
    let hash = Math.imul(seed ^ xp ^ yp ^ zp, 0x27d4eb2d);
    hash ^= hash >> 15;
    hash &= 63 << 2;
    return f32(f32(f32(xd * GRADIENTS_3D[hash]) + f32(yd * GRADIENTS_3D[hash | 1])) + f32(zd * GRADIENTS_3D[hash | 2]));
  }

  function openSimplex2(seed, x, y, z) {
    let i = fastRound(x), j = fastRound(y), k = fastRound(z);
    let x0 = f32(x - i), y0 = f32(y - j), z0 = f32(z - k);
    let xs = Math.trunc(f32(-1 - x0)) | 1, ys = Math.trunc(f32(-1 - y0)) | 1, zs = Math.trunc(f32(-1 - z0)) | 1;
    let ax0 = f32(xs * -x0), ay0 = f32(ys * -y0), az0 = f32(zs * -z0);
    i = Math.imul(i, PRIME_X); j = Math.imul(j, PRIME_Y); k = Math.imul(k, PRIME_Z);

    let value = 0;
    let a = f32(f32(f32(0.6) - f32(x0 * x0)) - f32(f32(y0 * y0) + f32(z0 * z0)));
    const add = (t, g) => { value = f32(value + f32(f32(f32(t * t) * f32(t * t)) * g)); };

    for (let l = 0; ; l++) {
      if (a > 0) add(a, gradCoord(seed, i, j, k, x0, y0, z0));
      if (ax0 >= ay0 && ax0 >= az0) {
        let b = f32(f32(a + ax0) + ax0);
        if (b > 1) { b = f32(b - 1); add(b, gradCoord(seed, (i - Math.imul(xs, PRIME_X)) | 0, j, k, f32(x0 + xs), y0, z0)); }
      } else if (ay0 > ax0 && ay0 >= az0) {
        let b = f32(f32(a + ay0) + ay0);
        if (b > 1) { b = f32(b - 1); add(b, gradCoord(seed, i, (j - Math.imul(ys, PRIME_Y)) | 0, k, x0, f32(y0 + ys), z0)); }
      } else {
        let b = f32(f32(a + az0) + az0);
        if (b > 1) { b = f32(b - 1); add(b, gradCoord(seed, i, j, (k - Math.imul(zs, PRIME_Z)) | 0, x0, y0, f32(z0 + zs))); }
      }
      if (l === 1) break;
      ax0 = f32(0.5 - ax0); ay0 = f32(0.5 - ay0); az0 = f32(0.5 - az0);
      x0 = f32(xs * ax0); y0 = f32(ys * ay0); z0 = f32(zs * az0);
      a = f32(a + f32(f32(0.75 - ax0) - f32(ay0 + az0)));
      i = (i + ((xs >> 1) & PRIME_X)) | 0; j = (j + ((ys >> 1) & PRIME_Y)) | 0; k = (k + ((zs >> 1) & PRIME_Z)) | 0;
      xs = -xs; ys = -ys; zs = -zs;
      seed = ~seed;
    }
    return f32(value * 32.69428253173828125);
  }

  /** GetNoise(x, y, z): the frequency, then the default R3 rotation, then OpenSimplex2. */
  class OpenSimplex2Noise {
    constructor(seed, frequency) {
      this.seed = seed | 0;
      this.frequency = f32(frequency);
    }

    get(x, y, z) {
      x = f32(f32(x) * this.frequency);
      y = f32(f32(y) * this.frequency);
      z = f32(f32(z) * this.frequency);
      const r = f32(f32(f32(x + y) + z) * f32(2 / 3));
      return openSimplex2(this.seed, f32(r - x), f32(r - y), f32(r - z));
    }
  }

  // ── GenRandom, StableHash ────────────────────────────────────────────────────────────────────────────────────────

  function mix64(z) {
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK_64;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK_64;
    return z ^ (z >> 31n);
  }

  /** The stream the game rolls for a structure cell: new GenRandom(worldSeed, cellX, cellZ, salt). */
  class GenRandom {
    constructor(seed, x, z, salt) {
      const u = (v) => BigInt(v >>> 0);
      this.state = mix64((u(seed) ^ ((u(x) << 32n) & MASK_64) ^ ((u(z) * 0x9E3779B97F4A7C15n) & MASK_64)
        ^ ((u(salt) * 0xC2B2AE3D27D4EB4Fn) & MASK_64)) & MASK_64);
    }

    nextFloat() {
      this.state = (this.state + 0x9E3779B97F4A7C15n) & MASK_64;
      return Number(mix64(this.state) >> 40n) / 16777216;
    }

    // float × int is a float product in C#, then truncated.
    rangeInt(min, max) { return Math.min(max, min + Math.trunc(f32(this.nextFloat() * (max - min + 1)))); }
    rangeFloat(min, max) { return f32(min + f32(this.nextFloat() * f32(max - min))); }
  }

  /** GenRandom.StableHash: FNV-1a over the UTF-16 code units. */
  function stableHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash | 0;
  }

  // MathF.Round: a midpoint goes to the even neighbour.
  function roundEven(v) {
    const r = Math.round(v);
    return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  }

  // ── TreeGenerator ───────────────────────────────────────────────────────────────────────────────────────────────

  const FRONTS = [[0, 1], [-1, 0], [0, -1], [1, 0]];
  const ROOT_DIRECTIONS = [[0, 1], [-1, 0], [0, -1], [1, 0], [1, 1], [-1, 1], [-1, -1], [1, -1]];
  const STANDING = -1;
  const DROOP_SALT = 0x5EED;
  const SHAPE_LYING = 8;

  const short = (id) => String(id ?? "").trim().replace(/^aura:/, "").toLowerCase();

  function readIntRange(token, defMin, defMax) {
    if (token == null) return [defMin, defMax];
    if (typeof token === "number") return [Math.trunc(token), Math.trunc(token)];
    if (Array.isArray(token) && token.length === 2 && token[0] <= token[1]) return [Math.trunc(token[0]), Math.trunc(token[1])];
    return [defMin, defMax];
  }

  function readPair(token, a, b) {
    if (typeof token === "number") return [f32(token), f32(token)];
    if (Array.isArray(token) && token.length === 2) return [f32(token[0]), f32(token[1])];
    return [f32(a), f32(b)];
  }

  function readFloatRange(token, a, b) {
    const [x, y] = readPair(token, a, b);
    return x <= y ? [x, y] : [f32(a), f32(b)];
  }

  function pickDirection(rng, used, directions) {
    const all = (1 << directions) - 1;
    if ((used.mask & all) === all) used.mask = 0;
    let free = 0;
    for (let d = 0; d < directions; d++) if (!(used.mask & (1 << d))) free++;
    let pick = rng.rangeInt(0, free - 1);
    for (let d = 0; d < directions; d++) {
      if (used.mask & (1 << d)) continue;
      if (pick-- === 0) { used.mask |= 1 << d; return d; }
    }
    return 0;
  }

  const facingOf = (dx, dz) => Math.max(0, FRONTS.findIndex(([fx, fz]) => fx === dx && fz === dz));

  /** Tile ids are short ("oak_log"); "" for none. */
  class TreeGenerator {
    constructor(config) {
      const crown = config.crown && typeof config.crown === "object" ? config.crown : {};
      this.trunkTile = config.trunk != null ? short(config.trunk) : "";
      [this.trunkMin, this.trunkMax] = readIntRange(config.trunkHeight, 0, 0);
      this.trunkWidth = config.trunkWidth === 2 ? 2 : 1;
      this.crownTile = crown.tile != null ? short(crown.tile) : "";
      this.warp = f32(crown.warp ?? 0.3);
      this.shape = crown.shape === "layers" ? "layers" : crown.shape === "none" ? "none" : "blob";

      let maxRadius = 0;
      if (this.shape === "blob") {
        [this.radiusMin, this.radiusMax] = readFloatRange(crown.radius, 3, 4);
        [this.heightMin, this.heightMax] = readFloatRange(crown.height, 3, 4);
        this.offset = f32(crown.offset ?? 0);
        maxRadius = this.radiusMax;
      } else if (this.shape === "layers") {
        this.layerStart = crown.start ?? 0;
        this.layerSpacing = Math.max(1, crown.spacing ?? 3);
        this.layerCount = Math.max(1, crown.count ?? 1);
        [this.layerRadiusBottom, this.layerRadiusTop] = readPair(crown.radius, 3, 1);
        this.layerThickness = f32(Math.max(0.5, crown.thickness ?? 2));
        maxRadius = Math.max(this.layerRadiusBottom, this.layerRadiusTop);
      } else {
        this.layerRadiusBottom = this.layerRadiusTop = 0;
        this.layerThickness = 0;
      }
      this.crownCore = f32(Math.min(1, Math.max(0, crown.core ?? 0)));

      this.droopChance = 0;
      if (crown.droop && typeof crown.droop === "object") {
        this.droopChance = f32(Math.min(1, Math.max(0, crown.droop.chance ?? 0.3)));
        [this.droopMin, this.droopMax] = readIntRange(crown.droop.length, 1, 2);
      }

      const roots = config.roots && typeof config.roots === "object" ? config.roots : null;
      this.hasRoots = !!roots;
      if (roots) {
        this.rootTile = short(roots.tile ?? config.trunk ?? "");
        [this.rootCountMin, this.rootCountMax] = readIntRange(roots.count, 0, 2);
        [this.rootLengthMin, this.rootLengthMax] = readIntRange(roots.length, 1, 2);
        this.rootSink = f32(Math.min(1, Math.max(0, roots.sink ?? 0.4)));
        this.rootDepth = Math.max(0, roots.depth ?? 2);
        this.rootDiagonal = roots.diagonal ?? true;
      }

      const branches = config.branches && typeof config.branches === "object" ? config.branches : null;
      this.hasBranches = !!branches;
      let tipReach = 0;
      if (branches) {
        this.branchTile = short(branches.tile ?? config.trunk ?? "");
        [this.branchCountMin, this.branchCountMax] = readIntRange(branches.count, 2, 3);
        [this.branchLengthMin, this.branchLengthMax] = readIntRange(branches.length, 2, 3);
        [this.branchStartMin, this.branchStartMax] = readFloatRange(branches.start, 0.5, 0.8);
        this.branchRise = f32(Math.min(1, Math.max(0, branches.rise ?? 0.3)));
        this.branchLeaves = !!(branches.leaves && typeof branches.leaves === "object");
        if (this.branchLeaves) {
          [this.tipRadiusMin, this.tipRadiusMax] = readFloatRange(branches.leaves.radius, 1.5, 2);
          [this.tipHeightMin, this.tipHeightMax] = readFloatRange(branches.leaves.height, 1, 1.5);
          tipReach = Math.ceil(f32(this.tipRadiusMax * f32(1 + this.warp)));
        }
      }

      const crownReach = Math.ceil(f32(maxRadius * f32(1 + this.warp))) + 1;
      const branchReach = this.hasBranches ? this.branchLengthMax + tipReach + 1 : 0;
      const rootReach = this.hasRoots ? this.rootLengthMax + 1 : 0;
      this.maxReach = this.trunkWidth - 1 + Math.max(crownReach, branchReach, rootReach);
      this.maxFootprint = Math.max(1, f32(maxRadius * 0.6));
      this.noise = new OpenSimplex2Noise(7331, 0.5);
    }

    plan(rng) {
      const blob = this.shape === "blob";
      const trunk = rng.rangeInt(this.trunkMin, this.trunkMax);
      const radius = blob ? rng.rangeFloat(this.radiusMin, this.radiusMax) : f32(Math.max(this.layerRadiusBottom, this.layerRadiusTop));
      const height = blob ? rng.rangeFloat(this.heightMin, this.heightMax) : this.layerThickness;

      let roots = null;
      if (this.hasRoots) {
        roots = [];
        const count = rng.rangeInt(this.rootCountMin, this.rootCountMax);
        const used = { mask: 0 };
        for (let i = 0; i < count; i++) {
          const [dx, dz] = ROOT_DIRECTIONS[pickDirection(rng, used, this.rootDiagonal ? 8 : 4)];
          const length = rng.rangeInt(this.rootLengthMin, this.rootLengthMax);
          roots.push(this.#limb(dx, dz, 1, length, 0, this.rootSink, 1 - this.rootDepth, rng));
        }
      }

      let branches = null;
      if (this.hasBranches) {
        branches = [];
        const count = rng.rangeInt(this.branchCountMin, this.branchCountMax);
        const used = { mask: 0 };
        for (let i = 0; i < count; i++) {
          const [dx, dz] = FRONTS[pickDirection(rng, used, 4)];
          const start = rng.rangeFloat(this.branchStartMin, this.branchStartMax);
          const level = Math.min(Math.max(Math.trunc(f32(start * trunk)), 1), Math.max(1, trunk));
          const length = rng.rangeInt(this.branchLengthMin, this.branchLengthMax);
          const branch = this.#limb(dx, dz, level, length, this.branchRise, 0, 0, rng);
          if (this.branchLeaves) {
            branch.tipRadius = rng.rangeFloat(this.tipRadiusMin, this.tipRadiusMax);
            branch.tipHeight = rng.rangeFloat(this.tipHeightMin, this.tipHeightMax);
          }
          branches.push(branch);
        }
      }

      return { trunk, radius, height, roots, branches, footprint: Math.max(1, f32(radius * 0.6)), reach: this.maxReach };
    }

    #limb(dirX, dirZ, level, length, rise, sink, minLevel, rng) {
      const limb = { cells: [] };
      let x = this.trunkWidth === 2 && dirX > 0 ? 1 : 0;
      let z = this.trunkWidth === 2 && dirZ > 0 ? 1 : 0;
      for (let step = 0; step < length; step++) {
        const alongX = dirX !== 0 && (dirZ === 0 || step % 2 === 0);
        if (alongX) x += dirX; else z += dirZ;
        limb.cells.push([x, level, z, facingOf(alongX ? dirX : 0, alongX ? 0 : dirZ)]);
        if (rise > 0 && rng.nextFloat() < rise) { level++; limb.cells.push([x, level, z, STANDING]); }
        else if (sink > 0 && rng.nextFloat() < sink && level > minLevel) { level--; limb.cells.push([x, level, z, STANDING]); }
      }
      return limb;
    }

    /** set(col, level, row, tile, dir, shape, rule): rule "plants" (air and plants only) or "soil" (and the ground). */
    write(tree, col, ground, row, set) {
      const w = this.trunkWidth;
      for (let i = 1; i <= tree.trunk; i++)
        for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < w; dz++) set(col + dx, ground + i, row + dz, this.trunkTile, 0, 0, "plants");
      const core = this.#coreLevels(tree);
      for (let i = 1; i <= core; i++)
        for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < w; dz++) set(col + dx, ground + tree.trunk + i, row + dz, this.trunkTile, 0, 0, "plants");

      if (tree.roots) this.#limbs(tree.roots, this.rootTile, "soil", col, ground, row, set);
      if (tree.branches) this.#limbs(tree.branches, this.branchTile, "plants", col, ground, row, set);

      const cc = f32(col + (w - 1) * 0.5), cr = f32(row + (w - 1) * 0.5);
      if (this.shape === "blob") {
        const center = f32(f32(f32(ground + tree.trunk) + f32(tree.height - 1)) + this.offset);
        this.#ellipsoid(cc, center, cr, tree.radius, tree.height, set);
      } else if (this.shape === "layers") {
        for (let i = 0; i < this.layerCount; i++) {
          const t = this.layerCount > 1 ? f32(i / (this.layerCount - 1)) : 0;
          const radius = f32(this.layerRadiusBottom + f32(f32(this.layerRadiusTop - this.layerRadiusBottom) * t));
          const center = f32((ground + 1 + this.layerStart + i * this.layerSpacing) + this.layerThickness);
          this.#ellipsoid(cc, center, cr, radius, this.layerThickness, set);
        }
      }
      if (!tree.branches || !this.branchLeaves) return;
      for (const b of tree.branches) {
        const [tx, tl, tz] = b.cells[b.cells.length - 1];
        this.#ellipsoid(col + tx, f32(ground + tl + 1), row + tz, b.tipRadius, b.tipHeight, set);
      }
    }

    #coreLevels(tree) {
      if (this.crownCore <= 0 || this.shape === "none") return 0;
      const span = this.shape === "blob"
        ? f32(f32(f32(2 * tree.height) - 1) + this.offset)
        : f32(f32((1 + this.layerStart + (this.layerCount - 1) * this.layerSpacing) + f32(2 * this.layerThickness)) - tree.trunk);
      return Math.max(0, Math.trunc(f32(span * this.crownCore)));
    }

    #limbs(limbs, tile, rule, col, ground, row, set) {
      for (const limb of limbs)
        for (const [dx, level, dz, facing] of limb.cells)
          set(col + dx, ground + level, row + dz, tile, facing === STANDING ? 0 : facing, facing === STANDING ? 0 : SHAPE_LYING, rule);
    }

    #ellipsoid(cc, cy, cr, radius, radiusY, set) {
      const reach = Math.ceil(f32(radius * f32(1 + this.warp)));
      const reachY = Math.ceil(f32(radiusY * f32(1 + this.warp)));
      const minC = Math.floor(f32(cc - reach)), maxC = Math.ceil(f32(cc + reach));
      const minR = Math.floor(f32(cr - reach)), maxR = Math.ceil(f32(cr + reach));
      const y0 = roundEven(cy);
      for (let c = minC; c <= maxC; c++)
        for (let r = minR; r <= maxR; r++) {
          const dx = f32(f32(c - cc) / radius), dz = f32(f32(r - cr) / radius);
          let lowest = Infinity;
          for (let level = y0 - reachY; level <= y0 + reachY; level++) {
            const dy = f32(f32(level - cy) / radiusY);
            const limit = f32(1 + f32(this.warp * this.noise.get(c, level, r)));
            if (f32(f32(f32(dx * dx) + f32(dy * dy)) + f32(dz * dz)) > limit) continue;
            set(c, level, r, this.crownTile, 0, 0, "plants");
            if (level < lowest) lowest = level;
          }
          if (lowest !== Infinity && this.droopChance > 0) {
            const rng = new GenRandom(DROOP_SALT, c, r, lowest);
            if (rng.nextFloat() >= this.droopChance) continue;
            const length = rng.rangeInt(this.droopMin, this.droopMax);
            for (let i = 1; i <= length; i++) set(c, lowest - i, r, this.crownTile, 0, 0, "plants");
          }
        }
    }
  }

  // ── TemplateGenerator ───────────────────────────────────────────────────────────────────────────────────────────

  /** Quarter turns about the anchor, as TemplateGenerator.Rotate (and WorldQuery.RotateOffset). */
  const turn = (x, z, r) => (r === 1 ? [-z, x] : r === 2 ? [-x, -z] : r === 3 ? [z, -x] : [x, z]);

  /** templates: Map<short id, parsed template { sizeX.., anchorX.., blocks: [{ x, y, z, tile, dir, shape }], baseCells }>. */
  class TemplateGenerator {
    constructor(config, templates) {
      this.variants = [];
      for (const v of Array.isArray(config.templates) ? config.templates : []) {
        const t = templates.get(short(typeof v === "string" ? v : v?.template));
        const w = typeof v === "object" && v ? Number(v.weight ?? 1) : 1;
        if (t && w > 0) this.variants.push({ t, w });
      }
      this.total = this.variants.reduce((s, v) => s + v.w, 0);
      this.rotate = config.rotate ?? true;
      this.foundation = String(config.adaptation ?? "none").toLowerCase() === "foundation" ? short(config.foundation ?? "stone") : "";
      this.maxHeightDifference = Math.max(0, config.maxHeightDifference ?? 2);
      this.maxReach = Math.max(0, ...this.variants.map(({ t }) => reachOf(t) + 1));
      this.maxFootprint = Math.max(0, ...this.variants.map(({ t }) => t.footprint));
    }

    get ok() { return this.variants.length > 0; }

    plan(rng) {
      let roll = rng.rangeInt(0, this.total - 1), k = 0;
      while (roll >= this.variants[k].w) roll -= this.variants[k++].w;
      const t = this.variants[k].t;
      return { t, rotation: this.rotate ? rng.rangeInt(0, 3) : 0, footprint: t.footprint, reach: reachOf(t) };
    }

    write({ t, rotation }, col, ground, row, set) {
      const bottom = ground + 1 - t.anchorY;
      for (const b of t.blocks) {
        const [dx, dz] = turn(b.x - t.anchorX, b.z - t.anchorZ, rotation);
        set(col + dx, bottom + b.y, row + dz, b.tile, b.turns ? (b.dir + rotation) & 3 : b.dir, b.shape, "any");
      }
      if (!this.foundation) return;
      for (const [x, z] of t.baseCells) {
        const [dx, dz] = turn(x - t.anchorX, z - t.anchorZ, rotation);
        for (let d = 1; d <= 24; d++) if (!set(col + dx, bottom - d, row + dz, this.foundation, 0, 0, "plants")) break;
      }
    }
  }

  const reachOf = (t) => Math.max(t.anchorX, t.sizeX - 1 - t.anchorX, t.anchorZ, t.sizeZ - 1 - t.anchorZ);

  /** A template file as StructureTemplates reads it. turnsOf(id) says whether a tile turns with the template. */
  function parseTemplate(o, turnsOf = () => false) {
    if (!Array.isArray(o?.size) || !Array.isArray(o.anchor) || !Array.isArray(o.palette) || !Array.isArray(o.blocks)) return null;
    const palette = o.palette.map(short);
    const blocks = [];
    for (const b of o.blocks) {
      if (!Array.isArray(b) || b.length < 4 || palette[b[3]] == null) continue;
      const tile = palette[b[3]], dir = (b[4] | 0) & 3, shape = b[5] | 0;
      blocks.push({ x: b[0], y: b[1], z: b[2], tile, dir, shape, turns: dir !== 0 || turnsOf(tile, shape) });
    }
    const base = new Set(blocks.filter((b) => b.y === 0 && b.tile !== "air").map((b) => b.x + "," + b.z));
    const [sx, sy, sz] = o.size, [ax, ay, az] = o.anchor;
    const rx = Math.max(ax, sx - 1 - ax), rz = Math.max(az, sz - 1 - az);
    return {
      sizeX: sx, sizeY: sy, sizeZ: sz, anchorX: ax, anchorY: ay, anchorZ: az, blocks,
      baseCells: [...base].map((k) => k.split(",").map(Number)),
      footprint: Math.sqrt(rx * rx + rz * rz) + 0.5,
    };
  }

  /** The generator for a structure file, or null when its type is not one the Studio grows. */
  function generatorFor(root, templates) {
    const type = short(root?.type);
    if (type === "tree") return new TreeGenerator(root.config ?? {});
    if (type === "template") {
      const g = new TemplateGenerator(root.config ?? {}, templates);
      return g.ok ? g : null;
    }
    return null;
  }

  // ── Leaves that fall when a neighbour is felled ─────────────────────────────────────────────────────────────────

  /** WorldQuery.LeafReach. */
  const LEAF_REACH = 10;

  /**
   * Leaves farther than LEAF_REACH from every log, measured like the game's felling: steps through leaves, edges and
   * corners included, a one-cell gap bridged at twice the cost. cells: Map "x,y,z" → { id }; isLeaf(id), isLog(id).
   */
  function farLeaves(cells, isLeaf, isLog) {
    const leafAt = (key) => { const c = cells.get(key); return !!c && isLeaf(c.id); };
    const distance = new Map();
    const buckets = Array.from({ length: LEAF_REACH + 1 }, () => []);
    for (const [key, c] of cells) if (isLog(c.id)) { distance.set(key, 0); buckets[0].push(key); }
    for (let d = 0; d <= LEAF_REACH; d++)
      for (const key of buckets[d]) {
        if (distance.get(key) !== d) continue;
        const [x, y, z] = key.split(",").map(Number);
        for (let dx = -2; dx <= 2; dx++)
          for (let dy = -2; dy <= 2; dy++)
            for (let dz = -2; dz <= 2; dz++) {
              const big = Math.abs(dx) === 2 || Math.abs(dy) === 2 || Math.abs(dz) === 2;
              if (big && Math.abs(dx) + Math.abs(dy) + Math.abs(dz) !== 2) continue;
              if (!dx && !dy && !dz) continue;
              const next = d + (big ? 2 : 1);
              if (next > LEAF_REACH) continue;
              const n = `${x + dx},${y + dy},${z + dz}`;
              if (!leafAt(n) || (distance.has(n) && distance.get(n) <= next)) continue;
              distance.set(n, next);
              buckets[next].push(n);
            }
      }
    const far = new Set();
    for (const key of cells.keys()) if (leafAt(key) && !distance.has(key)) far.add(key);
    return far;
  }

  Aura.structGen = { f32, GenRandom, stableHash, OpenSimplex2Noise, TreeGenerator, TemplateGenerator, parseTemplate, generatorFor, turn, farLeaves, LEAF_REACH, short };
})(window.Aura ??= {});
