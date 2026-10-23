"use strict";

// The Biomas 3D view's world: a patch of a biome built the way the game's generator builds it — gentle hills of the
// biome's materials, a pond, the decoration rolled per column, and the biome's "structures" placed on their cell grids
// (StructurePlacer: chance per cell, slope, ground tile, priority between overlapping ones) with the trees grown by a port
// of TreeGenerator and the houses stamped from Worldgen/Templates (TemplateGenerator), both exact (Aura.structGen). The
// terrain is the Studio's own, so a patch looks like the biome, never like a particular spot of a particular world.
(function (Aura) {
  const { readText, baseName } = Aura.fs;

  const isStructureFile = (e) => /(^|\/)data\/worldgen\/structures\/.+\.json$/.test(e.lower);
  const isTemplateFile = (e) => /(^|\/)data\/worldgen\/templates\/.+\.json$/.test(e.lower);

  /** "aura:oak_tree" and "oak_tree" are the same id here: the Studio only edits the base game's content. */
  const short = (id) => String(id ?? "").trim().replace(/^aura:/, "").toLowerCase();

  // Kinds of cell in the scene's palette: how the renderer draws them and what a structure may replace.
  const KIND = Aura.voxelView.KIND;

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
        const t = Aura.structGen.parseTemplate(JSON.parse(await readText(e.handle)));
        if (t) templates.set(short(baseName(e.path).replace(/\.json$/i, "")), t);
      } catch (err) {
        errors.push(`${e.path}: ${err.message}`);
      }
    }
    return { structures, templates, errors };
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
  // The game's own rolls (GenRandom, StableHash) and generators (Aura.structGen), so with the same world seed a structure
  // lands where the game puts it on the same cell grid; only the terrain under it is the Studio's.

  const qualify = (id) => (String(id).includes(":") ? String(id) : "aura:" + id);

  function placeStructures(root, defs, templates, scene, ctx) {
    const G = Aura.structGen;
    const { N, ground, wet, topTile, slopeAt, P, opts, counts, missing } = ctx;
    const candidates = [];
    const biomeId = qualify(short(root.id ?? root.name));

    for (const entry of Array.isArray(root.structures) ? root.structures : []) {
      const id = short(entry?.structure);
      const def = defs.get(id);
      const gen = def && G.generatorFor(def.root, templates);
      if (!gen) { if (id) missing.add(id); continue; }
      const cell = Math.max(1, Number(entry.cellSize) || 8);
      const chance = Math.min(1, (entry.chance == null ? 0.5 : Number(entry.chance) || 0) * opts.density);
      const salt = G.stableHash(biomeId + "|" + qualify(id));
      const placement = def.root.placement ?? {};
      const on = new Set((placement.on ?? []).map((t) => P(t)));
      for (let cx = 0; cx * cell < N; cx++)
        for (let cz = 0; cz * cell < N; cz++) {
          const r = new G.GenRandom(opts.seed, cx, cz, salt);
          if (r.nextFloat() >= chance) continue;
          const x = cx * cell + r.rangeInt(0, cell - 1), z = cz * cell + r.rangeInt(0, cell - 1);
          const shape = gen.plan(r);
          // Whole or not at all: a tree cut by the edge of the patch reads as a broken generator.
          if (x - shape.reach < 0 || z - shape.reach < 0 || x + shape.reach >= N || z + shape.reach >= N) continue;
          candidates.push({ id, gen, shape, x, z, tiebreak: r.nextFloat(), priority: Number(placement.priority) || 0,
            maxSlope: Number(placement.maxSlope ?? 1.5), on });
        }
    }

    const valid = (c) => {
      if (c.ok !== undefined) return c.ok;
      const i = c.z * N + c.x;
      c.ground = ground[i];
      c.ok = !wet[i] && slopeAt(c.x, c.z) <= c.maxSlope && (!c.on.size || c.on.has(topTile[i]));
      if (c.ok && c.gen instanceof G.TemplateGenerator) c.ok = fitTemplate(c, ground, wet, N);
      return c.ok;
    };
    const outranks = (a, b) => a.priority !== b.priority ? a.priority > b.priority
      : a.tiebreak !== b.tiebreak ? a.tiebreak > b.tiebreak : a.x !== b.x ? a.x > b.x : a.z > b.z;

    // StructureWriter.Set: "any" writes over everything, "plants" over air and plants, "soil" also over the ground.
    const set = (col, level, row, tile, dir, shape, rule) =>
      scene.set(col, level, row, tile && tile !== "air" ? P(tile) : 0, rule === "any" ? "any" : rule === "soil" ? "soil" : "air");

    for (const c of candidates) {
      if (!valid(c)) continue;
      const lost = candidates.some((o) => o !== c && Math.hypot(o.x - c.x, o.z - c.z) < c.shape.footprint + o.shape.footprint
        && outranks(o, c) && valid(o));
      if (lost) continue;
      c.gen.write(c.shape, c.x, c.ground, c.z, set);
      counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
    }
  }

  // TemplateGenerator.TryFit: the footprint's corners, edge midpoints and centre — too uneven, or in water, and it does not
  // go there; with a foundation it rests on the highest of them.
  function fitTemplate(c, ground, wet, N) {
    const { t, rotation } = c.shape;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i <= 2; i++)
      for (let j = 0; j <= 2; j++) {
        const [dx, dz] = Aura.structGen.turn(Math.floor((t.sizeX - 1) * i / 2) - t.anchorX, Math.floor((t.sizeZ - 1) * j / 2) - t.anchorZ, rotation);
        const x = Math.min(N - 1, Math.max(0, c.x + dx)), z = Math.min(N - 1, Math.max(0, c.z + dz));
        if (wet[z * N + x]) return false;
        min = Math.min(min, ground[z * N + x]);
        max = Math.max(max, ground[z * N + x]);
      }
    if (max - min > c.gen.maxHeightDifference) return false;
    if (c.gen.foundation) c.ground = max;
    return true;
  }

  Aura.biomeScene = { KIND, short, loadStructures, structureTiles, buildScene };
})(window.Aura ??= {});
