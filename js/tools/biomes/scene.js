"use strict";

// The Biomas 3D view's world: a patch of a biome built the way the game's generator builds it — gentle hills of the
// biome's materials, a pond, the decoration rolled per column, and the biome's "structures" placed on their cell grids
// (StructurePlacer: chance per cell, slope, ground tile, priority between overlapping ones) with the trees grown by a port
// of TreeGenerator and the houses stamped from Worldgen/Templates (TemplateGenerator). The random numbers are the
// Studio's own, so a patch looks like the biome, never like a particular spot of a particular world.
(function (Aura) {
  const { readText, baseName } = Aura.fs;

  const isStructureFile = (e) => /(^|\/)data\/worldgen\/structures\/.+\.json$/.test(e.lower);
  const isTemplateFile = (e) => /(^|\/)data\/worldgen\/templates\/.+\.json$/.test(e.lower);

  /** "aura:oak_tree" and "oak_tree" are the same id here: the Studio only edits the base game's content. */
  const short = (id) => String(id ?? "").trim().replace(/^aura:/, "").toLowerCase();

  // Kinds of cell in the scene's palette: how the renderer draws them and what a structure may replace.
  const KIND = { solid: 1, plant: 2, water: 3, glass: 4, slab: 5 };

  // ─── Loading ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** { structures: Map<id, { id, path, root }>, templates: Map<id, template>, errors: [text] } */
  async function loadStructures(project) {
    const structures = new Map(), templates = new Map(), errors = [];
    for (const e of project.filter(isStructureFile)) {
      try {
        const root = JSON.parse(await readText(e.handle));
        const id = short(root.id ?? baseName(e.path).replace(/\.json$/i, ""));
        structures.set(id, { id, path: e.path, root });
      } catch (err) {
        errors.push(`${e.path}: ${err.message}`);
      }
    }
    for (const e of project.filter(isTemplateFile)) {
      try {
        const t = parseTemplate(JSON.parse(await readText(e.handle)));
        if (t) templates.set(short(baseName(e.path).replace(/\.json$/i, "")), t);
      } catch (err) {
        errors.push(`${e.path}: ${err.message}`);
      }
    }
    return { structures, templates, errors };
  }

  // The game's StructureTemplates.Parse, minus the checks: the game reports a broken template, the preview skips it.
  function parseTemplate(o) {
    const size = o?.size, anchor = o?.anchor;
    if (!Array.isArray(size) || !Array.isArray(anchor) || !Array.isArray(o.palette) || !Array.isArray(o.blocks)) return null;
    const palette = o.palette.map(short);
    const blocks = [];
    for (const b of o.blocks) {
      if (!Array.isArray(b) || b.length < 4 || !palette[b[3]]) continue;
      blocks.push({ x: b[0], y: b[1], z: b[2], tile: palette[b[3]], shape: b[5] | 0 });
    }
    const base = new Set(blocks.filter((b) => b.y === 0 && b.tile !== "air").map((b) => b.x + "," + b.z));
    const reachX = Math.max(anchor[0], size[0] - 1 - anchor[0]), reachZ = Math.max(anchor[2], size[2] - 1 - anchor[2]);
    return {
      sizeX: size[0], sizeY: size[1], sizeZ: size[2], anchorX: anchor[0], anchorY: anchor[1], anchorZ: anchor[2], blocks,
      baseCells: [...base].map((k) => k.split(",").map(Number)),
      footprint: Math.sqrt(reachX * reachX + reachZ * reachZ) + 0.5,
    };
  }

  /** Every tile id a structure writes, for loading their colours before the scene is built. */
  function structureTiles(def, templates) {
    const c = def?.root?.config ?? {};
    const out = [];
    if (c.trunk) out.push(c.trunk);
    if (c.crown?.tile) out.push(c.crown.tile);
    if (c.roots?.tile) out.push(c.roots.tile);
    if (c.branches?.tile) out.push(c.branches.tile);
    if (c.foundation) out.push(c.foundation);
    for (const v of Array.isArray(c.templates) ? c.templates : []) {
      const t = templates.get(short(typeof v === "string" ? v : v?.template));
      if (t) for (const b of t.blocks) out.push(b.tile);
    }
    return out.map(short);
  }

  // ─── Randomness ───────────────────────────────────────────────────────────────────────────────────────────────────

  const hash = (...v) => {
    let n = 0x9e3779b9 | 0;
    for (const x of v) {
      n = Math.imul(n ^ (x | 0), 0x85ebca6b);
      n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
      n ^= n >>> 16;
    }
    return (n >>> 0) / 4294967296;
  };

  /** A seeded stream, like GenRandom: next() 0..1, int(min, max) inclusive, range(min, max) float. */
  function rng(...seed) {
    let s = Math.floor(hash(...seed) * 4294967296) | 0;
    const next = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return { next, int: (a, b) => a + Math.floor(next() * (b - a + 1)), range: (a, b) => a + next() * (b - a) };
  }

  const stringHash = (s) => {
    let n = 0;
    for (const ch of String(s)) n = (Math.imul(n, 31) + ch.charCodeAt(0)) | 0;
    return n;
  };

  // Smooth value noise, -1..1 — stands in for the game's OpenSimplex warp: the same lumpiness, not the same lumps.
  function noise3(x, y, z) {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const s = (t) => t * t * (3 - 2 * t);
    const fx = s(x - x0), fy = s(y - y0), fz = s(z - z0);
    const v = (a, b, c) => hash(a, b, c, 7331) * 2 - 1;
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(v(x0, y0, z0), v(x0 + 1, y0, z0), fx), l(v(x0, y0 + 1, z0), v(x0 + 1, y0 + 1, z0), fx), fy),
      l(l(v(x0, y0, z0 + 1), v(x0 + 1, y0, z0 + 1), fx), l(v(x0, y0 + 1, z0 + 1), v(x0 + 1, y0 + 1, z0 + 1), fx), fy), fz);
  }

  function noise2(x, y, seed) {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const v = (a, b) => hash(a, b, seed);
    return (v(x0, y0) * (1 - sx) + v(x0 + 1, y0) * sx) * (1 - sy) + (v(x0, y0 + 1) * (1 - sx) + v(x0 + 1, y0 + 1) * sx) * sy;
  }

  // ─── The scene ────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A voxel patch. cells holds palette indices (0 = air) at ((y × size) + z) × size + x; palette[i] = { id, kind }.
   * set() follows the game's ReplaceRule: "any", "air" (air and plants), "soil" (also the ground materials).
   */
  class Scene {
    constructor(size, height) {
      this.size = size;
      this.height = height;
      this.cells = new Uint16Array(size * size * height);
      this.palette = [{ id: "air", kind: 0 }];
      this.index = new Map();
      this.soil = new Set();
    }

    tileOf(id, kind) {
      const key = id + "|" + kind;
      let i = this.index.get(key);
      if (i === undefined) {
        i = this.palette.length;
        this.palette.push({ id, kind });
        this.index.set(key, i);
      }
      return i;
    }

    inside(x, y, z) { return x >= 0 && z >= 0 && y >= 0 && x < this.size && z < this.size && y < this.height; }
    at(x, y, z) { return this.inside(x, y, z) ? this.cells[(y * this.size + z) * this.size + x] : 0; }

    set(x, y, z, p, rule = "any") {
      if (!this.inside(x, y, z)) return false;
      const i = (y * this.size + z) * this.size + x, cur = this.cells[i];
      if (rule !== "any" && cur !== 0) {
        const k = this.palette[cur].kind;
        const free = k === KIND.plant || (rule === "soil" && this.soil.has(cur));
        if (!free) return false;
      }
      this.cells[i] = p;
      return true;
    }
  }

  /**
   * Builds the patch. info(id) → { kind, tags } or null for a tile the project lacks; opts: { size, seed, relief, water,
   * density, structures (bool) }. Returns { scene, counts: Map<structure id, placed>, missing: Set<structure id> }.
   */
  function buildScene(root, defs, templates, info, opts) {
    const N = opts.size, BASE = 4, RELIEF = opts.relief ? 6 : 0, SKY = 34;
    const scene = new Scene(N, BASE + RELIEF + SKY);
    const m = root.materials ?? {};
    const kindOf = (id) => {
      const t = info(id);
      if (!t) return KIND.solid;
      if (t.liquid) return KIND.water;
      if (t.plant) return KIND.plant;
      if (t.slab) return KIND.slab;
      if (t.glass) return KIND.glass;
      return KIND.solid;
    };
    const P = (id) => scene.tileOf(short(id), kindOf(short(id)));
    const surfaceP = P(m.surface ?? "grass"), shallowP = P(m.shallow ?? "dirt"), deepP = P(m.deep ?? "stone");
    const waterP = scene.tileOf("water", KIND.water);
    scene.soil = new Set([surfaceP, shallowP, ...(m.surfaceVariants ?? []).map((v) => P(v.tile))]);

    // Heights: two octaves of value noise; the lowest sixth becomes a pond when asked.
    const field = new Float32Array(N * N);
    for (let x = 0; x < N; x++)
      for (let z = 0; z < N; z++)
        field[z * N + x] = noise2(x / 13, z / 13, opts.seed * 13 + 3) * 0.8 + noise2(x / 5, z / 5, opts.seed * 17 + 9) * 0.2;
    const sorted = [...field].sort((a, b) => a - b);
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    const waterCut = opts.water ? sorted[Math.floor(sorted.length * 0.14)] : -Infinity;
    const ground = new Int16Array(N * N);
    const land = new Int16Array(N * N);     // the ground with the pond filled to its surface: what slopes are measured on
    const wet = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const f = field[i];
      if (f <= waterCut) {
        wet[i] = 1;
        ground[i] = BASE - 1 - (f < sorted[Math.floor(sorted.length * 0.05)] ? 1 : 0);
        land[i] = BASE;
      } else {
        ground[i] = land[i] = BASE + Math.round(((f - lo) / Math.max(1e-6, hi - lo)) * RELIEF);
      }
    }
    const g = (x, z) => land[Math.min(N - 1, Math.max(0, z)) * N + Math.min(N - 1, Math.max(0, x))];
    const slopeAt = (x, z) => Math.hypot((g(x + 1, z) - g(x - 1, z)) / 2, (g(x, z + 1) - g(x, z - 1)) / 2);

    // Materials, top down — under water the surface is the shallow tile, on cliffs everything is the deep one.
    const topTile = new Uint16Array(N * N);
    const shallowDepth = Number(m.shallowDepth ?? 3);
    for (let x = 0; x < N; x++)
      for (let z = 0; z < N; z++) {
        const i = z * N + x, top = ground[i];
        const steep = slopeAt(x, z) > 1.5;
        let surface = surfaceP;
        let roll = hash(x, z, opts.seed, 1), acc = 0;
        for (const v of m.surfaceVariants ?? []) {
          acc += Number(v.chance) || 0;
          if (roll < acc) { surface = P(v.tile); break; }
        }
        if (wet[i]) surface = shallowP;
        if (steep) surface = deepP;
        for (let y = 0; y <= top; y++) {
          const depth = top - y;
          const p = depth === 0 ? surface : depth <= shallowDepth && !steep ? shallowP : deepP;
          scene.set(x, y, z, p);
        }
        topTile[i] = surface;
        // The water's surface is level with the lowest land, as the sea level is in the game.
        if (wet[i]) for (let y = top + 1; y <= BASE; y++) scene.set(x, y, z, waterP);
      }

    // Decoration: one roll per column over the summed chances, as Chunk.Decorate does.
    const placeOf = (d) => {
      if (d.on) return { surface: "land", seafloor: "bottom", shallows: "shore", watersurface: "top" }[d.on] ?? "land";
      const hab = info(short(d.tile))?.habitat ?? "land";
      return { land: "land", submerged: "bottom", emergent: "shore", floating: "top" }[hab] ?? "land";
    };
    const decoCounts = new Map();
    for (let x = 0; x < N; x++)
      for (let z = 0; z < N; z++) {
        const i = z * N + x, top = ground[i], depth = wet[i] ? BASE - top : 0;
        if (!wet[i] && slopeAt(x, z) > 1.5) continue;
        const roll = hash(x, z, opts.seed, 2);
        let acc = 0;
        for (const d of root.decoration ?? []) {
          acc += (Number(d.chance) || 0) * opts.density;
          if (roll >= acc) continue;
          const where = placeOf(d);
          const y = where === "top" ? BASE + 1 : top + 1;
          const ok = wet[i] ? where === "bottom" || where === "top" || (where === "shore" && depth === 1) : where === "land";
          if (ok && info(short(d.tile))) {
            scene.set(x, y, z, scene.tileOf(short(d.tile), KIND.plant));
            decoCounts.set(short(d.tile), (decoCounts.get(short(d.tile)) ?? 0) + 1);
          }
          break;
        }
      }

    const counts = new Map(), missing = new Set();
    if (opts.structures) placeStructures(root, defs, templates, scene, { N, ground, wet, topTile, slopeAt, P, opts, counts, missing });
    return { scene, counts, missing, decoCounts };
  }

  // ─── Structures (StructurePlacer) ────────────────────────────────────────────────────────────────────────────────

  function placeStructures(root, defs, templates, scene, ctx) {
    const { N, ground, wet, topTile, slopeAt, P, opts, counts, missing } = ctx;
    const candidates = [];
    const biomeId = short(root.id ?? root.name);

    for (const entry of Array.isArray(root.structures) ? root.structures : []) {
      const id = short(entry?.structure);
      const def = defs.get(id);
      const gen = def && makeGenerator(def, templates, P);
      if (!gen) { if (id) missing.add(id); continue; }
      const cell = Math.max(1, Number(entry.cellSize) || 8);
      const chance = Math.min(1, (entry.chance == null ? 0.5 : Number(entry.chance) || 0) * opts.density);
      const salt = stringHash(biomeId + "|" + id);
      const placement = def.root.placement ?? {};
      const on = new Set((placement.on ?? []).map((t) => P(t)));
      for (let cx = 0; cx * cell < N; cx++)
        for (let cz = 0; cz * cell < N; cz++) {
          const r = rng(opts.seed, cx, cz, salt);
          if (r.next() >= chance) continue;
          const x = cx * cell + r.int(0, cell - 1), z = cz * cell + r.int(0, cell - 1);
          const shape = gen.plan(r);
          // Whole or not at all: a tree cut by the edge of the patch reads as a broken generator.
          if (x - shape.reach < 0 || z - shape.reach < 0 || x + shape.reach >= N || z + shape.reach >= N) continue;
          candidates.push({ id, gen, shape, x, z, tiebreak: r.next(), priority: Number(placement.priority) || 0,
            maxSlope: Number(placement.maxSlope ?? 1.5), on });
        }
    }

    const valid = (c) => {
      if (c.ok !== undefined) return c.ok;
      const i = c.z * N + c.x;
      c.ground = ground[i];
      c.ok = !wet[i] && slopeAt(c.x, c.z) <= c.maxSlope && (!c.on.size || c.on.has(topTile[i]));
      if (c.ok && c.gen.fit) c.ok = c.gen.fit(c, ground, wet, N);
      return c.ok;
    };
    const outranks = (a, b) => a.priority !== b.priority ? a.priority > b.priority
      : a.tiebreak !== b.tiebreak ? a.tiebreak > b.tiebreak : a.x !== b.x ? a.x > b.x : a.z > b.z;

    for (const c of candidates) {
      if (!valid(c)) continue;
      const lost = candidates.some((o) => o !== c && Math.hypot(o.x - c.x, o.z - c.z) < c.shape.footprint + o.shape.footprint
        && outranks(o, c) && valid(o));
      if (lost) continue;
      c.gen.write(c.shape, c.x, c.ground, c.z, scene);
      counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
    }
  }

  function makeGenerator(def, templates, P) {
    const type = short(def.root.type);
    if (type === "tree") return treeGenerator(def.root.config ?? {}, P);
    if (type === "template") return templateGenerator(def.root.config ?? {}, templates, P);
    return null;
  }

  // ─── TreeGenerator, ported ───────────────────────────────────────────────────────────────────────────────────────

  const pair = (v, a, b) => (Array.isArray(v) ? [Number(v[0]), Number(v[1])] : typeof v === "number" ? [v, v] : [a, b]);
  const FRONTS = [[0, 1], [-1, 0], [0, -1], [1, 0]];
  const ROOT_DIRS = [[0, 1], [-1, 0], [0, -1], [1, 0], [1, 1], [-1, 1], [-1, -1], [1, -1]];

  function treeGenerator(c, P) {
    const trunk = c.trunk ? P(c.trunk) : 0;
    const [tMin, tMax] = pair(c.trunkHeight, 0, 0);
    const width = c.trunkWidth === 2 ? 2 : 1;
    const crown = c.crown ?? {};
    const leaves = crown.tile ? P(crown.tile) : 0;
    const shape = crown.shape ?? "blob";
    const warp = crown.warp ?? 0.3;
    const [rMin, rMax] = pair(crown.radius, 3, 4), [hMin, hMax] = pair(crown.height, 3, 4);
    const offset = crown.offset ?? 0;
    const layerStart = crown.start ?? 0, spacing = Math.max(1, crown.spacing ?? 3), count = Math.max(1, crown.count ?? 1);
    const [lBottom, lTop] = pair(crown.radius, 3, 1), thick = Math.max(0.5, crown.thickness ?? 2);
    const core = Math.min(1, Math.max(0, crown.core ?? 0));
    const droop = crown.droop ? { chance: crown.droop.chance ?? 0.3, len: pair(crown.droop.length, 1, 2) } : null;
    const roots = c.roots ? { tile: P(c.roots.tile ?? c.trunk), count: pair(c.roots.count, 0, 2), len: pair(c.roots.length, 1, 2),
      sink: c.roots.sink ?? 0.4, depth: c.roots.depth ?? 2, diagonal: c.roots.diagonal ?? true } : null;
    const branches = c.branches ? { tile: P(c.branches.tile ?? c.trunk), count: pair(c.branches.count, 2, 3), len: pair(c.branches.length, 2, 3),
      start: pair(c.branches.start, 0.5, 0.8), rise: c.branches.rise ?? 0.3,
      tip: c.branches.leaves ? { r: pair(c.branches.leaves.radius, 1.5, 2), h: pair(c.branches.leaves.height, 1, 1.5) } : null } : null;
    const maxRadius = shape === "blob" ? rMax : shape === "layers" ? Math.max(lBottom, lTop) : 0;

    const pick = (r, used, n) => {
      const all = (1 << n) - 1;
      if ((used.m & all) === all) used.m = 0;
      const free = [];
      for (let d = 0; d < n; d++) if (!(used.m & (1 << d))) free.push(d);
      const d = free[r.int(0, free.length - 1)];
      used.m |= 1 << d;
      return d;
    };
    const limb = (r, [dx, dz], level, length, rise, sink, minLevel) => {
      const cells = [];
      let x = width === 2 && dx > 0 ? 1 : 0, z = width === 2 && dz > 0 ? 1 : 0;
      for (let s = 0; s < length; s++) {
        const alongX = dx !== 0 && (dz === 0 || s % 2 === 0);
        if (alongX) x += dx; else z += dz;
        cells.push([x, level, z]);
        if (rise > 0 && r.next() < rise) cells.push([x, ++level, z]);
        else if (sink > 0 && r.next() < sink && level > minLevel) cells.push([x, --level, z]);
      }
      return cells;
    };

    return {
      plan(r) {
        const t = r.int(tMin, tMax);
        const blob = shape === "blob";
        const radius = blob ? r.range(rMin, rMax) : Math.max(lBottom, lTop);
        const height = blob ? r.range(hMin, hMax) : thick;
        const rootList = [], branchList = [];
        if (roots) {
          const used = { m: 0 };
          for (let i = r.int(roots.count[0], roots.count[1]); i > 0; i--)
            rootList.push(limb(r, ROOT_DIRS[pick(r, used, roots.diagonal ? 8 : 4)], 1, r.int(roots.len[0], roots.len[1]), 0, roots.sink, 1 - roots.depth));
        }
        if (branches) {
          const used = { m: 0 };
          for (let i = r.int(branches.count[0], branches.count[1]); i > 0; i--) {
            const dir = FRONTS[pick(r, used, 4)];
            const level = Math.min(Math.max(1, t), Math.max(1, Math.floor(r.range(branches.start[0], branches.start[1]) * t)));
            const cells = limb(r, dir, level, r.int(branches.len[0], branches.len[1]), branches.rise, 0, 0);
            const tip = branches.tip ? { r: r.range(branches.tip.r[0], branches.tip.r[1]), h: r.range(branches.tip.h[0], branches.tip.h[1]) } : null;
            branchList.push({ cells, tip });
          }
        }
        let reach = shape === "none" ? 1 : Math.ceil(radius * (1 + warp)) + 1;
        for (const cells of rootList) for (const [x, , z] of cells) reach = Math.max(reach, Math.abs(x) + 1, Math.abs(z) + 1);
        for (const b of branchList) {
          const tip = b.tip ? Math.ceil(b.tip.r * (1 + warp)) : 0;
          for (const [x, , z] of b.cells) reach = Math.max(reach, Math.abs(x) + 1 + tip, Math.abs(z) + 1 + tip);
        }
        return { trunk: t, radius, height, roots: rootList, branches: branchList, footprint: Math.max(1, radius * 0.6), reach: reach + width - 1 };
      },

      // Logs first, then leaves: leaves only replace air and plants, so they never cut into a trunk or a branch.
      write(tree, col, gnd, row, scene) {
        for (let i = 1; i <= tree.trunk; i++)
          for (let dx = 0; dx < width; dx++) for (let dz = 0; dz < width; dz++) scene.set(col + dx, gnd + i, row + dz, trunk, "air");
        let coreLevels = 0;
        if (core > 0 && shape !== "none") {
          const span = shape === "blob" ? 2 * tree.height - 1 + offset : 1 + layerStart + (count - 1) * spacing + 2 * thick - tree.trunk;
          coreLevels = Math.max(0, Math.floor(span * core));
        }
        for (let i = 1; i <= coreLevels; i++)
          for (let dx = 0; dx < width; dx++) for (let dz = 0; dz < width; dz++) scene.set(col + dx, gnd + tree.trunk + i, row + dz, trunk, "air");
        for (const cells of tree.roots) for (const [x, y, z] of cells) scene.set(col + x, gnd + y, row + z, roots.tile, "soil");
        for (const b of tree.branches) for (const [x, y, z] of b.cells) scene.set(col + x, gnd + y, row + z, branches.tile, "air");

        const cx = col + (width - 1) * 0.5, cz = row + (width - 1) * 0.5;
        if (shape === "blob") ellipsoid(scene, cx, gnd + tree.trunk + (tree.height - 1) + offset, cz, tree.radius, tree.height);
        else if (shape === "layers")
          for (let i = 0; i < count; i++) {
            const t = count > 1 ? i / (count - 1) : 0;
            ellipsoid(scene, cx, gnd + 1 + layerStart + i * spacing + thick, cz, lBottom + (lTop - lBottom) * t, thick);
          }
        for (const b of tree.branches) {
          if (!b.tip) continue;
          const [x, y, z] = b.cells[b.cells.length - 1];
          ellipsoid(scene, col + x, gnd + y + 1, row + z, b.tip.r, b.tip.h);
        }
      },
    };

    function ellipsoid(scene, cx, cy, cz, radius, radiusY) {
      const reach = Math.ceil(radius * (1 + warp)), reachY = Math.ceil(radiusY * (1 + warp)), y0 = Math.round(cy);
      for (let c = Math.floor(cx - reach); c <= Math.ceil(cx + reach); c++)
        for (let r = Math.floor(cz - reach); r <= Math.ceil(cz + reach); r++) {
          const dx = (c - cx) / radius, dz = (r - cz) / radius;
          let lowest = Infinity;
          for (let y = y0 - reachY; y <= y0 + reachY; y++) {
            const dy = (y - cy) / radiusY;
            if (dx * dx + dy * dy + dz * dz > 1 + warp * noise3(c * 0.5, y * 0.5, r * 0.5)) continue;
            scene.set(c, y, r, leaves, "air");
            if (y < lowest) lowest = y;
          }
          if (droop && lowest !== Infinity) {
            const d = rng(0x5eed, c, r, lowest);
            if (d.next() >= droop.chance) continue;
            for (let i = d.int(droop.len[0], droop.len[1]); i >= 1; i--) scene.set(c, lowest - i, r, leaves, "air");
          }
        }
    }
  }

  // ─── TemplateGenerator, ported ───────────────────────────────────────────────────────────────────────────────────

  function templateGenerator(c, templates, P) {
    const variants = [];
    for (const v of Array.isArray(c.templates) ? c.templates : []) {
      const t = templates.get(short(typeof v === "string" ? v : v?.template));
      const w = typeof v === "object" ? Number(v.weight ?? 1) : 1;
      if (t && w > 0) variants.push({ t, w });
    }
    if (!variants.length) return null;
    const total = variants.reduce((s, v) => s + v.w, 0);
    const rotate = c.rotate ?? true;
    const foundation = String(c.adaptation ?? "none").toLowerCase() === "foundation" ? P(c.foundation ?? "stone") : 0;
    const maxDiff = Math.max(0, c.maxHeightDifference ?? 2);
    const turn = (x, z, r) => (r === 1 ? [-z, x] : r === 2 ? [-x, -z] : r === 3 ? [z, -x] : [x, z]);

    return {
      plan(r) {
        let roll = r.int(0, total - 1), k = 0;
        while (roll >= variants[k].w) roll -= variants[k++].w;
        const t = variants[k].t;
        const reach = Math.max(t.anchorX, t.sizeX - 1 - t.anchorX, t.anchorZ, t.sizeZ - 1 - t.anchorZ);
        return { t, rotation: rotate ? r.int(0, 3) : 0, footprint: t.footprint, reach };
      },

      // The footprint's corners, edge midpoints and centre: too uneven, or touching water, and it does not go there.
      fit(cand, ground, wet, N) {
        const { t, rotation } = cand.shape;
        let min = Infinity, max = -Infinity;
        for (let i = 0; i <= 2; i++)
          for (let j = 0; j <= 2; j++) {
            const [dx, dz] = turn(Math.floor((t.sizeX - 1) * i / 2) - t.anchorX, Math.floor((t.sizeZ - 1) * j / 2) - t.anchorZ, rotation);
            const x = Math.min(N - 1, Math.max(0, cand.x + dx)), z = Math.min(N - 1, Math.max(0, cand.z + dz));
            if (wet[z * N + x]) return false;
            min = Math.min(min, ground[z * N + x]);
            max = Math.max(max, ground[z * N + x]);
          }
        if (max - min > maxDiff) return false;
        if (foundation) cand.ground = max;
        return true;
      },

      write({ t, rotation }, col, gnd, row, scene) {
        const bottom = gnd + 1 - t.anchorY;
        for (const b of t.blocks) {
          const [dx, dz] = turn(b.x - t.anchorX, b.z - t.anchorZ, rotation);
          scene.set(col + dx, bottom + b.y, row + dz, b.tile === "air" ? 0 : P(b.tile), "any");
        }
        if (!foundation) return;
        for (const [x, z] of t.baseCells) {
          const [dx, dz] = turn(x - t.anchorX, z - t.anchorZ, rotation);
          for (let d = 1; d <= 24; d++) if (!scene.set(col + dx, bottom - d, row + dz, foundation, "air")) break;
        }
      },
    };
  }

  Aura.biomeScene = { KIND, short, loadStructures, structureTiles, buildScene };
})(window.Aura ??= {});
