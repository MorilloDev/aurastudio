"use strict";

// Laying a sheet out again: where every cell should sit so the sheet reads like a catalogue instead of the order
// things happened to be drawn in. No DOM and no canvas, so it runs in the page and under Node.
//
// Cells are all the same size, so this is not rectangle packing: nothing is gained by a clever packer, and a plain
// grid wastes only the tail of a row. What is worth deciding is the *order* and the *shape*:
//
//   · One band per material, each starting on a fresh row, so a material is a block you can find by eye.
//   · Inside a band, families in a fixed order (block, log, slab, stairs, fence, door, ladder, leaves…), and inside a
//     family every cell of a tile together, in the order the tile lists them. A flight of stairs and its bends end up
//     side by side, and so do a slab and its vertical halves.
//   · A tile's cells never straddle two rows unless the tile alone is wider than the sheet.
//   · The width is chosen to leave the sheet as near square as it can be, which keeps it off both limits: a very wide
//     sheet runs into the driver's maximum texture size, and a very tall one wastes the same way.
//
// Every device in the wild takes 4096 px (web3dsurvey's MAX_TEXTURE_SIZE: 100 % at 4096, 98 % at 8192), so that is the
// ceiling here. Powers of two are preferred where they cost nothing: mipmaps and block compression want them, and the
// game resizes to one anyway.
(function (Aura) {
  const MAX_PX = 4096;

  // Longest first: "oak_trapdoor" must not be read as a door.
  const FAMILY_SUFFIX = [
    "thatchetroof", "trapdoor", "stairs", "planks", "ladder", "fence", "slab", "wall", "door", "gate", "log",
    "leaves", "torch", "sapling", "button", "plate", "sign", "bars", "pane", "post", "beam",
  ];

  // The order a band reads in: the whole block first, then what is cut out of it, then what is built with it.
  const FAMILY_ORDER = [
    "log", "block", "planks", "slab", "stairs", "fence", "wall", "gate", "door", "trapdoor", "ladder",
    "thatchetroof", "post", "beam", "bars", "pane", "button", "plate", "sign", "torch", "sapling", "leaves",
  ];

  /** The material and the family a tile id belongs to: "oak_stairs" → oak · stairs, "mycwood" → mycwood · block. */
  function classify(id) {
    const name = String(id ?? "").toLowerCase().replace(/^[^:]*:/, "");
    for (const family of FAMILY_SUFFIX) {
      if (name === family) return { material: name, family };
      if (name.endsWith("_" + family)) return { material: name.slice(0, -family.length - 1), family };
      // "oakleaves", written without the underscore.
      if (name.endsWith(family) && name.length > family.length) return { material: name.slice(0, -family.length), family };
    }
    return { material: name, family: "block" };
  }

  /** Lexicographic: the first number that differs decides. */
  const before = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };

  const familyRank = (family) => {
    const i = FAMILY_ORDER.indexOf(family);
    return i < 0 ? FAMILY_ORDER.length : i;
  };

  /**
   * Groups the sheet's references into the runs a band is made of.
   * refs: [{ tile, coord, … }] in the order they are read out of the files.
   * idOf(tile) → the tile's id. Returns [{ material, family, tile, cells: [[x, y], …] }] in band order.
   */
  function runs(refs, idOf) {
    const byTile = new Map();
    for (const ref of refs) {
      let run = byTile.get(ref.tile);
      if (!run) {
        const { material, family } = classify(idOf(ref.tile));
        run = { material, family, tile: ref.tile, refs: [] };
        byTile.set(ref.tile, run);
      }
      run.refs.push(ref);
    }

    // Materials keep the order they first appear in, so a sheet someone already knows does not shuffle on them.
    const materials = [];
    for (const run of byTile.values()) if (!materials.includes(run.material)) materials.push(run.material);

    return [...byTile.values()].sort((a, b) =>
      materials.indexOf(a.material) - materials.indexOf(b.material) ||
      familyRank(a.family) - familyRank(b.family) ||
      String(idOf(a.tile)).localeCompare(String(idOf(b.tile))));
  }

  /**
   * Lays the runs out in a grid `cols` wide. Each material starts a row; a run that would straddle two rows is pushed
   * to the next one, unless it is longer than a whole row. Returns { rows, places: Map(run → [[x, y], …]) }.
   */
  function place(ordered, cols) {
    const places = new Map();
    const bandSize = new Map();
    for (const run of ordered) bandSize.set(run.material, (bandSize.get(run.material) ?? 0) + run.refs.length);
    let x = 0, y = 0, material = null;

    for (const run of ordered) {
      // A material starts its own row, so a band is a block you can find by eye — unless the whole of it still fits in
      // what is left of this one. Otherwise every mushroom with a single block would cost a row of its own.
      if (material !== null && run.material !== material && x && bandSize.get(run.material) > cols - x) { x = 0; y++; }
      material = run.material;
      // A run that fits in a row gets a whole one rather than being split; one longer than a row is going to span
      // rows whatever is done with it, so it starts where the last one left off instead of wasting the tail.
      const n = run.refs.length;
      if (x && n <= cols && x + n > cols) { x = 0; y++; }

      const cells = [];
      for (let i = 0; i < n; i++) {
        cells.push([x, y]);
        if (++x >= cols) { x = 0; y++; }
      }
      places.set(run, cells);
    }

    return { rows: y + (x ? 1 : 0), places };
  }

  /**
   * The width that leaves the sheet nearest to square, among those that fit. cell: { w, h } in pixels.
   * extra = cells that have art but no reference, parked at the end.
   */
  function bestFit(ordered, cell, extra = 0, maxPx = MAX_PX) {
    const total = ordered.reduce((n, r) => n + r.refs.length, 0) + extra;
    if (!total) return null;
    let best = null;

    for (let cols = 1; cols * cell.w <= maxPx; cols++) {
      const { rows } = place(ordered, cols);
      const all = rows + Math.ceil(extra / cols);
      if (all * cell.h > maxPx) continue;
      const w = cols * cell.w, h = all * cell.h;
      // The longer side first — that is the one that runs into the driver's limit and the one that makes a sheet
      // awkward — and then the fewest cells, so two layouts of the same shape do not differ by a half-empty row.
      const score = [Math.max(w, h), cols * all, Math.abs(w - h)];
      if (!best || before(score, best.score)) best = { cols, rows: all, score, waste: cols * all - total };
    }

    return best;
  }

  /**
   * The whole plan for one sheet.
   *   refs:   the sheet's references, in file order.
   *   idOf:   tile → id.
   *   cell:   { w, h } in pixels.
   *   orphans: cells that hold art nothing points at, as [x, y]; they are kept, after everything else.
   *   cols:   a width to force, or null to pick the one nearest to square.
   * Returns { cols, rows, moves: [{ ref, from, to }], orphanMoves: [{ from, to }], bands: [{ material, row, cells }] }.
   */
  function plan({ refs, idOf, cell, orphans = [], cols = null }) {
    // Two tiles pointing at the same cell share one drawing, and they keep sharing it: the cell is laid out once,
    // where it first comes up, and both references end on it. Copying it would quietly grow the sheet instead.
    const seen = new Set();
    const first = refs.filter((r) => {
      const k = r.coord[0] + "," + r.coord[1];
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const ordered = runs(first, idOf);
    const fit = cols ? { cols, rows: place(ordered, cols).rows + Math.ceil(orphans.length / cols) }
                     : bestFit(ordered, cell, orphans.length);
    if (!fit) return null;

    const { places } = place(ordered, fit.cols);
    const moves = [], bands = [], dest = new Map();
    let lastMaterial = null;

    for (const run of ordered) {
      const cells = places.get(run);
      if (run.material !== lastMaterial) { bands.push({ material: run.material, row: cells[0][1], cells: 0 }); lastMaterial = run.material; }
      bands[bands.length - 1].cells += cells.length;
      run.refs.forEach((ref, i) => dest.set(ref.coord[0] + "," + ref.coord[1], cells[i]));
    }

    for (const ref of refs) {
      const to = dest.get(ref.coord[0] + "," + ref.coord[1]);
      if (to) moves.push({ ref, from: [ref.coord[0], ref.coord[1]], to });
    }

    // Art with nothing pointing at it is not thrown away: it goes under the bands, where it is easy to spot.
    let x = 0, y = Math.max(0, ...moves.map((m) => m.to[1] + 1), 0);
    const orphanMoves = orphans.map((from) => {
      const to = [x, y];
      if (++x >= fit.cols) { x = 0; y++; }
      return { from, to };
    });

    return { cols: fit.cols, rows: y + (x ? 1 : 0), moves, orphanMoves, bands };
  }

  Aura.atlasLayout = { plan, runs, place, bestFit, classify, FAMILY_ORDER, FAMILY_SUFFIX, MAX_PX };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
