"use strict";

// The isometric view of a template, drawn with the game's sprites exactly as the game projects and sorts them
// (IsoProjection, Chunk sort depth, WorldQuery.ResolveTileArt for facings, back art, swapped halves and shapes). The
// working level is a plane: blocks above it show as ghosts, are hidden ("cut") or drawn whole ("all"). The mouse picks
// the front-most cell under it; the face it points at decides where a new block goes, and with nothing under it the
// level's plane does. Editing goes through the tool (place, remove, eyedropper, rectangles).
(function (Aura) {
  const { SHAPE, AIR, CELL } = Aura.structTiles;
  const { key, parse, rotateOffset } = Aura.structModel;
  const AO = Aura.ao;

  const HALF_W = 32, HALF_H = 16, LAYER_STEP = 32;
  const UPPER_HALF_OFFSET = -LAYER_STEP / 2;
  const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
  const GRID_RADIUS = 12;

  // WorldQuery.UnflippedFrontFacesSouthWest — which screen side the unflipped art of a rotatable piece faces.
  const UNFLIPPED_FRONT_FACES_SW = false;

  // IsoProjection.RotateXZ / InverseRotateXZ.
  function rotate(x, z, r) {
    switch (r) { case 1: return [z, -x]; case 2: return [-x, -z]; case 3: return [-z, x]; default: return [x, z]; }
  }
  function inverseRotate(rx, rz, r) {
    switch (r) { case 1: return [-rz, rx]; case 2: return [-rx, -rz]; case 3: return [rz, -rx]; default: return [rx, rz]; }
  }

  class IsoView {
    rotation = 0;

    // Ambient occlusion (shared/ao.js, the game's own). Per cell the bake is rotation-free (North corner order), as the game
    // keeps it; a mask per distinct setup darkens the sprite's own pixels, and the shaded sprite is kept per sprite + mask.
    #aoCells = null;            // { doc, sig, cells: Map "x,y,z" → { edge, side, rot: [] } | null } — rebuilt when the cells change
    #aoWeights = new Map();     // tile id → caster weight
    #aoMasks = new Map();       // mask key → canvas (black, alpha = the darkening)
    #aoSprites = new Map();     // sprite + flips + mask key → canvas
    #imgIds = new WeakMap();
    #imgCount = 0;
    zoomIndex = 4;
    pan = { x: 0, y: 0 };
    hover = null;            // { hit: [x,y,z] | null, place: [x,y,z] }
    mouse = { x: 0, y: 0, inside: false };
    rect = null;             // { start: [x,z], end: [x,z], remove }
    #panning = null;
    #space = false;
    #queued = false;

    /** host: { doc, registry, foliage, level, viewMode, editable, selected, facing, shape, farLeaves (Set|null),
     *          onPlace(cell), onRemove(cell), onPick(cell), onRect(start, end, remove), onHover() } */
    constructor(canvas, host) {
      this.canvas = canvas;
      this.g = canvas.getContext("2d");
      this.host = host;
      this.#bindInput();
    }

    get zoom() { return ZOOMS[this.zoomIndex]; }

    render = () => {
      if (this.#queued) return;
      this.#queued = true;
      requestAnimationFrame(() => { this.#queued = false; this.#draw(); });
    };

    // ── Projection ──────────────────────────────────────────────────────────────────────────────────────────────

    #project(x, y, z) {
      const [rx, rz] = rotate(x, z, this.rotation);
      return [(rx - rz) * HALF_W, (rx + rz) * HALF_H - y * LAYER_STEP];
    }

    #dirToScreen(x, z) {
      const [rx, rz] = rotate(x, z, this.rotation);
      return [(rx - rz) * HALF_W, (rx + rz) * HALF_H];
    }

    // Chunk.EnsureProjection: GetSortDepth * 16 + level * 0.5, foliage a hair in front.
    #depth(x, y, z, foliage) {
      const [rx, rz] = rotate(x, z, this.rotation);
      return (rx + rz) * 16 + y * 0.5 + (foliage ? 0.05 : 0);
    }

    #toScreen(wx, wy) { return [Math.round(wx * this.zoom + this.pan.x), Math.round(wy * this.zoom + this.pan.y)]; }
    #toWorld(mx, my) { return [(mx - this.pan.x) / this.zoom, (my - this.pan.y) / this.zoom]; }

    #worldAtLevel(mx, my, level) {
      const [wx, wy] = this.#toWorld(mx, my);
      const a = (wx - HALF_W) / HALF_W, b = (wy - HALF_H + level * LAYER_STEP) / HALF_H;
      return inverseRotate((a + b) / 2, (b - a) / 2, this.rotation);
    }

    cellAtLevel(mx, my, level) {
      const [wx, wy] = this.#toWorld(mx, my);
      const a = (wx - HALF_W) / HALF_W, b = (wy - HALF_H + level * LAYER_STEP) / HALF_H;
      const [x, z] = inverseRotate(Math.round((a + b) / 2), Math.round((b - a) / 2), this.rotation);
      return [x + 0, level, z + 0];
    }

    // ── View ────────────────────────────────────────────────────────────────────────────────────────────────────

    center() {
      const doc = this.host.doc;
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      let sx = 0, sy = 0, n = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const k of doc?.blocks.keys() ?? []) {
        const [px, py] = this.#project(...parse(k));
        sx += px + HALF_W; sy += py + HALF_H; n++;
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px + CELL); y1 = Math.max(y1, py + CELL);
      }
      if (!n) { const [px, py] = this.#project(0, this.host.level, 0); sx = px + HALF_W; sy = py + HALF_H; n = 1; }
      else {
        // The largest zoom step the whole build fits in.
        for (let i = ZOOMS.length - 1; i >= 0; i--)
          if ((x1 - x0) * ZOOMS[i] <= w * 0.9 && (y1 - y0) * ZOOMS[i] <= h * 0.85) { this.zoomIndex = Math.min(i, 5); break; }
      }
      this.pan.x = w / 2 - (sx / n) * this.zoom;
      this.pan.y = h / 2 - (sy / n) * this.zoom;
      this.render();
    }

    /** Turns the camera a quarter, keeping the point at the view centre in place. */
    turn(step) {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight, level = this.host.level;
      const [cx, cz] = this.#worldAtLevel(w / 2, h / 2, level);
      this.rotation = (this.rotation + step + 4) % 4;
      const [rx, rz] = rotate(cx, cz, this.rotation);
      this.pan.x = w / 2 - ((rx - rz) * HALF_W + HALF_W) * this.zoom;
      this.pan.y = h / 2 - ((rx + rz) * HALF_H - level * LAYER_STEP + HALF_H) * this.zoom;
      this.updateHover();
      this.render();
    }

    zoomAt(mx, my, step) {
      const next = Math.max(0, Math.min(ZOOMS.length - 1, this.zoomIndex + step));
      if (next === this.zoomIndex) return;
      const ratio = ZOOMS[next] / this.zoom;
      this.pan.x = mx - (mx - this.pan.x) * ratio;
      this.pan.y = my - (my - this.pan.y) * ratio;
      this.zoomIndex = next;
      this.updateHover();
      this.render();
    }

    // ── Picking ─────────────────────────────────────────────────────────────────────────────────────────────────

    #pickable(y, k) {
      if (this.host.doc.hidden.has(k)) return false;
      return this.host.viewMode === "all" || y <= this.host.level;
    }

    /** Front-most block whose cell hexagon holds the mouse; the face under it decides the neighbour a new block goes in. */
    updateHover() {
      const doc = this.host.doc;
      if (!this.mouse.inside || !doc) { this.hover = null; this.host.onHover?.(); return; }
      const [wx, wy] = this.#toWorld(this.mouse.x, this.mouse.y);
      let best = null;
      for (const [k, id] of doc.blocks) {
        const [x, y, z] = parse(k);
        if (!this.#pickable(y, k)) continue;
        const [px, py] = this.#project(x, y, z);
        const lx = wx - px, ly = wy - py;
        if (lx < 0 || lx > CELL) continue;
        const edge = Math.abs(lx - HALF_W) / 2;
        if (ly < edge || ly > CELL - edge) continue;
        const depth = this.#depth(x, y, z, this.host.registry.get(id)?.category === "foliage");
        if (!best || depth > best.depth) best = { cell: [x, y, z], depth, lx, ly };
      }
      if (!best) {
        this.hover = { hit: null, place: this.cellAtLevel(this.mouse.x, this.mouse.y, this.host.level) };
      } else {
        const [x, y, z] = best.cell;
        const onTop = Math.abs(best.lx - HALF_W) / HALF_W + Math.abs(best.ly - HALF_H) / HALF_H <= 1;
        let place;
        if (onTop) place = [x, y + 1, z];
        else {
          // The left face looks along +rz, the right face along +rx (both toward the viewer).
          const [rx, rz] = rotate(x, z, this.rotation);
          const [nx, nz] = best.lx < HALF_W ? inverseRotate(rx, rz + 1, this.rotation) : inverseRotate(rx + 1, rz, this.rotation);
          place = [nx + 0, y, nz + 0];
        }
        this.hover = { hit: best.cell, place };
      }
      this.host.onHover?.();
    }

    // ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────────────

    #draw() {
      const c = this.canvas, g = this.g;
      const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.imageSmoothingEnabled = false;
      g.fillStyle = "#101216";
      g.fillRect(0, 0, w, h);
      const doc = this.host.doc;
      if (!doc) return;

      const { level, viewMode } = this.host;
      const list = [];
      for (const [k, id] of doc.blocks) {
        if (doc.hidden.has(k)) continue;
        const [x, y, z] = parse(k);
        const above = y > level;
        if (above && viewMode === "cut") continue;
        list.push({ x, y, z, id, dir: doc.dirs.get(k) ?? 0, shape: doc.shapes.get(k) ?? 0, ghost: above && viewMode === "ghost",
          depth: this.#depth(x, y, z, this.host.registry.get(id)?.category === "foliage") });
      }
      // The working level's grid is the top face of each cell of that level: it is sorted in among the tiles by depth (just
      // after the tile on the same cell), so whatever stands in front of it hides it instead of it showing through.
      for (const [x, z] of this.#gridCells()) list.push({ grid: true, x, y: level, z, depth: this.#depth(x, level, z, false) + 0.001 });
      list.sort((a, b) => a.depth - b.depth);
      let run = false;
      g.beginPath();
      const flushGrid = () => {
        if (!run) return;
        g.strokeStyle = "rgba(255, 255, 255, 0.1)";
        g.lineWidth = 1;
        g.stroke();
        g.beginPath();
        run = false;
      };
      for (const e of list) {
        if (e.grid) { this.#diamond(e.x, e.y, e.z); run = true; }
        else { flushGrid(); this.#drawCell(e.x, e.y, e.z, e.id, e.ghost ? 0.16 : 1, e.dir, e.shape, !e.ghost); }
      }
      flushGrid();
      if (this.host.editable && !doc.blocks.size) {
        g.save();
        g.fillStyle = "rgba(255, 255, 255, 0.45)";
        g.font = "13px system-ui, sans-serif";
        g.textAlign = "center";
        g.fillText(this.host.selected ? "Lienzo vacío: haz clic para poner el primer tile" : "Lienzo vacío: elige un tile en la paleta y haz clic para ponerlo", w / 2, 28);
        g.restore();
      }
      this.#drawSelection();
      this.#drawFloat();
      this.#drawFar();
      this.#drawRect();
      this.#drawAnchor();
      this.#drawShapeStart();
      this.#drawHover();
      for (const label of this.host.labels ?? []) this.#drawLabel(label);
    }

    // WorldQuery.ResolveTileArt: for a cell of a rotatable piece, the mirror flag and which art draws under this camera.
    #resolveTileArt(id, dir) {
      const piece = this.host.registry.pieceOf(id);
      return piece?.rotatable ? this.#resolvePieceArt(id, dir) : { id, flip: false };
    }

    // WorldQuery.ResolvePieceArt: the facing rules alone, for any art tile.
    #resolvePieceArt(id, dir) {
      const reg = this.host.registry;
      const tile = reg.get(id);
      const [fx, fz] = rotateOffset(0, 1, dir);
      const [frontX, frontY] = this.#dirToScreen(fx, fz);
      const flip = (frontX * frontY > 0) === UNFLIPPED_FRONT_FACES_SW;
      let drawId = id;
      if (tile?.swap) {
        const [rx, rz] = rotateOffset(tile.swap.ox, tile.swap.oz, dir);
        if (this.#dirToScreen(rx, rz)[1] < 0) drawId = tile.swap.partnerId;
      }
      // After the swap on purpose, as in the game: each half carries its own back sibling.
      if (frontY < 0) {
        const backId = reg.get(drawId)?.backId;
        if (backId) drawId = backId;
      }
      return { id: drawId, flip };
    }

    // The sprites one cell draws, as DrawListBuilder.BuildTiles emits them. Two for a double slab, far half first.
    #cellSprites(id, dir, shape) {
      const tile = this.host.registry.get(id);
      if (!tile) return [{ id, flip: false, flipV: false, dy: 0 }];
      const one = (art, dy = 0, flipV = false) => ({ ...art, flipV, dy });
      if (tile.slab && (shape & SHAPE.VERTICAL) && tile.verticalId) {
        if (!(shape & SHAPE.DOUBLE)) return [one(this.#resolvePieceArt(tile.verticalId, dir))];
        const opposite = (dir + 2) & 3;
        const [fx, fz] = rotateOffset(0, 1, dir);
        const [near, far] = this.#dirToScreen(-fx, -fz)[1] > 0 ? [dir, opposite] : [opposite, dir];
        return [one(this.#resolvePieceArt(tile.verticalId, far)), one(this.#resolvePieceArt(tile.verticalId, near))];
      }
      if (tile.wallId && !tile.slab && (shape & SHAPE.WALL)) return [one(this.#resolvePieceArt(tile.wallId, dir))];
      if (tile.horizontalId && !tile.slab && (shape & SHAPE.HORIZONTAL)) return [one(this.#resolvePieceArt(tile.horizontalId, dir))];
      if (tile.rotatableVertical && (shape & SHAPE.UPPER)) {
        if (tile.invertedId) return [one(tile.rotatable ? this.#resolvePieceArt(tile.invertedId, dir) : { id: tile.invertedId, flip: false })];
        return [one(this.#resolveTileArt(id, dir), 0, true)];
      }
      const art = this.#resolveTileArt(id, dir);
      if (tile.slab && (shape & SHAPE.DOUBLE)) return [one(art), one(art, UPPER_HALF_OFFSET)];
      if (tile.slab && (shape & SHAPE.UPPER)) return [one(art, UPPER_HALF_OFFSET)];
      return [one(art)];
    }

    /** ao: shade it with the occlusion of the cells around it (only the cells of the template itself, not ghosts or carried ones). */
    #drawCell(x, y, z, id, alpha, dir = 0, shape = 0, ao = false) {
      const reg = this.host.registry, tile = reg.get(id);
      const foliage = this.host.foliage;
      const sprites = tile && id !== AIR ? this.#cellSprites(id, dir, shape).map((a) => ({ ...a, img: reg.sprite(a.id, foliage) })).filter((a) => a.img) : [];
      if (!sprites.length) { this.#placeholder(x, y, z, id === AIR, alpha); return; }
      const [px, py] = this.#project(x, y, z);
      const z0 = this.zoom, g = this.g;
      // BuildTiles' offset for sprites larger than one cell: centred horizontally, grown upward.
      const ox = (tile.tw - CELL) / 2, oy = tile.th - CELL;
      const shade = ao && this.host.ao ? this.#aoShade(x, y, z, id, tile, shape) : null;
      for (const a of sprites) {
        const [sx, sy] = this.#toScreen(px - ox, py - oy + a.dy);
        const w = Math.round(tile.tw * z0), h = Math.round(tile.th * z0);
        g.globalAlpha = alpha;
        if (shade && a.img.width === CELL && a.img.height === CELL) {
          g.drawImage(this.#aoSprite(a, shade), sx, sy, w, h);
          continue;
        }
        g.save();
        g.translate(sx + (a.flip ? w : 0), sy + (a.flipV ? h : 0));
        g.scale(a.flip ? -1 : 1, a.flipV ? -1 : 1);
        g.drawImage(a.img, 0, 0, w, h);
        g.restore();
      }
      g.globalAlpha = 1;
    }

    // Air shows as a blue outline (it clears the terrain); a tile with no art, or one that no longer exists, in magenta.
    #placeholder(x, y, z, air, alpha) {
      const [sx, sy] = this.#toScreen(...this.#project(x, y, z));
      this.g.globalAlpha = alpha;
      if (air) this.#hexagon(sx, sy, "rgba(120, 200, 255, 0.07)", "rgba(120, 200, 255, 0.7)", true);
      else this.#hexagon(sx, sy, "rgba(255, 0, 255, 0.45)", "rgba(255, 0, 255, 0.9)", true);
      this.g.globalAlpha = 1;
    }

    #hexagon(sx, sy, fill, stroke, inner) {
      const g = this.g, z0 = this.zoom, p = (x, y) => [sx + x * z0, sy + y * z0];
      g.beginPath();
      g.moveTo(...p(32, 0)); g.lineTo(...p(64, 16)); g.lineTo(...p(64, 48)); g.lineTo(...p(32, 64)); g.lineTo(...p(0, 48)); g.lineTo(...p(0, 16));
      g.closePath();
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (inner) { g.moveTo(...p(0, 16)); g.lineTo(...p(32, 32)); g.lineTo(...p(64, 16)); g.moveTo(...p(32, 32)); g.lineTo(...p(32, 64)); }
      g.strokeStyle = stroke;
      g.lineWidth = 1;
      g.stroke();
    }

    #diamond(x, y, z) {
      const [sx, sy] = this.#toScreen(...this.#project(x, y, z));
      const z0 = this.zoom, g = this.g;
      g.moveTo(sx + 32 * z0, sy); g.lineTo(sx + 64 * z0, sy + 16 * z0); g.lineTo(sx + 32 * z0, sy + 32 * z0); g.lineTo(sx, sy + 16 * z0);
      g.closePath();
    }

    /** The cells [x, z] of the grid around the middle of the view, on the working level. */
    #gridCells() {
      const level = this.host.level;
      const [cx, cz] = this.#worldAtLevel(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, level);
      const ix = Math.round(cx), iz = Math.round(cz), cells = [];
      for (let x = ix - GRID_RADIUS; x <= ix + GRID_RADIUS; x++)
        for (let z = iz - GRID_RADIUS; z <= iz + GRID_RADIUS; z++) cells.push([x, z]);
      return cells;
    }

    // Leaves too far from every log (they fall when a neighbouring tree is felled), outlined in red.
    #drawFar() {
      const far = this.host.farLeaves;
      if (!far?.size) return;
      const g = this.g;
      g.beginPath();
      for (const k of far) {
        const [x, y, z] = parse(k);
        if (this.host.viewMode === "cut" && y > this.host.level) continue;
        this.#diamond(x, y, z);
      }
      g.strokeStyle = "rgba(255, 90, 80, 0.9)";
      g.lineWidth = 1.5;
      g.stroke();
    }

    #drawRect() {
      if (!this.rect) return;
      const [x0, z0] = this.rect.start, [x1, z1] = this.rect.end, g = this.g;
      g.beginPath();
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) this.#diamond(x, this.host.level, z);
      g.fillStyle = this.rect.remove ? "rgba(224, 112, 108, 0.25)" : "rgba(111, 191, 115, 0.25)";
      g.fill();
    }

    #drawAnchor() {
      const a = this.host.doc.anchor;
      if (!a || !this.host.editable) return;
      const g = this.g;
      g.beginPath();
      this.#diamond(...a);
      g.strokeStyle = "#e5c07b";
      g.lineWidth = 2;
      g.stroke();
    }

    /** The selected blocks: a gold hexagon over each (the ones lifted into a move are drawn by #drawFloat instead). */
    #drawSelection() {
      const sel = this.host.selection, doc = this.host.doc;
      if (!sel?.size || !this.host.editable || !doc) return;
      for (const k of sel) {
        if (doc.hidden.has(k)) continue;
        const [x, y, z] = parse(k);
        const [sx, sy] = this.#toScreen(...this.#project(x, y, z));
        this.#hexagon(sx, sy, "rgba(255, 210, 80, 0.2)", "rgba(255, 210, 80, 0.95)", false);
      }
    }

    /** What is being carried (a paste, or a selection lifted to move): translucent, following the mouse, outlined as selected. */
    #drawFloat() {
      const list = this.host.floatCells?.();
      if (!list?.length) return;
      if (list.length <= 5000) {
        const sorted = list.map((e) => ({ e, d: this.#depth(...e.p, false) })).sort((a, b) => a.d - b.d);
        for (const { e } of sorted) this.#drawCell(...e.p, e.id, 0.75, e.dir, e.shape);
        if (list.length <= 1500)
          for (const { e } of sorted) {
            const [sx, sy] = this.#toScreen(...this.#project(...e.p));
            this.#hexagon(sx, sy, null, "rgba(255, 210, 80, 0.9)", false);
          }
        return;
      }
      const g = this.g;
      g.beginPath();
      for (const e of list) this.#diamond(...e.p);
      g.fillStyle = "rgba(255, 210, 80, 0.3)";
      g.fill();
    }

    // ── Ambient occlusion ─────────────────────────────────────────────────────────────────────────────────────────────

    /** The caster weight of a tile id (Chunk.GetAOCasterWeight), remembered. */
    #casterOf(id) {
      let w = this.#aoWeights.get(id);
      if (w === undefined) { w = AO.casterWeight(this.host.registry.get(id)); this.#aoWeights.set(id, w); }
      return w;
    }

    /**
     * What shades the cell at x, y, z for this camera: { key, edge, left, right, topOffset }, or null when it takes none.
     * Only what is really there casts: hidden cells, and the ghosts / cut cells above the working level, do not.
     */
    #aoShade(x, y, z, id, tile, shape) {
      if (!AO.receives(tile) || id === AIR) return null;
      const doc = this.host.doc, { level, viewMode } = this.host, editable = this.host.editable;
      const sig = `${doc.rev}|${level}|${viewMode}|${editable ? 1 : 0}`;
      if (!this.#aoCells || this.#aoCells.doc !== doc || this.#aoCells.sig !== sig) this.#aoCells = { doc, sig, cells: new Map() };
      const k = key(x, y, z), cells = this.#aoCells.cells;
      let cell = cells.get(k);
      if (cell === undefined) {
        const weight = (cx, cy, cz) => {
          const ck = key(cx, cy, cz), cid = doc.blocks.get(ck);
          if (cid === undefined || cid === AIR || doc.hidden.has(ck)) return 0;
          if (editable && cy > level && viewMode !== "all") return 0;
          return this.#casterOf(cid);
        };
        const bottomSlab = !!tile.slab && !(shape & (SHAPE.UPPER | SHAPE.DOUBLE | SHAPE.VERTICAL));
        const b = AO.bake((dx, dy, dz) => weight(x + dx, y + dy, z + dz), bottomSlab);
        cell = b.side || b.edge.some((v) => v > 0) ? { edge: b.edge, side: b.side, rot: [] } : null;
        cells.set(k, cell);
      }
      if (!cell) return null;
      const r = this.rotation & 3;
      // A bottom slab's top face sits a quarter of the sprite down; its walls start there too.
      const topOffset = tile.slab && !(shape & SHAPE.VERTICAL) ? 0.25 : 0;
      const memo = cell.rot[r]?.topOffset === topOffset ? cell.rot[r] : null;
      if (memo) return memo.none ? null : memo;
      const edge = AO.rotateCorners(cell.edge, r), [left, right] = AO.sideFaces(cell.side, r);
      const out = edge.some((v) => v > 0) || left || right ? { key: AO.keyOf(edge, left, right, topOffset), edge, left, right, topOffset } : null;
      cell.rot[r] = out ?? { topOffset, none: true };
      return out;
    }

    /** The darkening for one setup: black pixels whose alpha is what the game's shader takes off (value / 3 * strength). */
    #aoMask(s) {
      let mask = this.#aoMasks.get(s.key);
      if (mask) return mask;
      mask = document.createElement("canvas");
      mask.width = mask.height = CELL;
      const ctx = mask.getContext("2d"), img = ctx.createImageData(CELL, CELL);
      for (let py = 0; py < CELL; py++)
        for (let px = 0; px < CELL; px++)
          img.data[(py * CELL + px) * 4 + 3] = Math.round(AO.pixelAO((px + 0.5) / CELL, (py + 0.5) / CELL, s.topOffset, s.edge, s.left, s.right) * AO.STRENGTH * 255);
      ctx.putImageData(img, 0, 0);
      if (this.#aoMasks.size > 3000) this.#aoMasks.clear();
      this.#aoMasks.set(s.key, mask);
      return mask;
    }

    /** The sprite with its shade laid on its own pixels only (source-atop keeps the art's silhouette), flips included. */
    #aoSprite(a, s) {
      let id = this.#imgIds.get(a.img);
      if (id === undefined) { id = ++this.#imgCount; this.#imgIds.set(a.img, id); }
      const k = `${id}|${a.flip ? 1 : 0}${a.flipV ? 1 : 0}|${s.key}`;
      let out = this.#aoSprites.get(k);
      if (out) return out;
      out = document.createElement("canvas");
      out.width = out.height = CELL;
      const ctx = out.getContext("2d");
      ctx.translate(a.flip ? CELL : 0, a.flipV ? CELL : 0);
      ctx.scale(a.flip ? -1 : 1, a.flipV ? -1 : 1);
      ctx.drawImage(a.img, 0, 0, CELL, CELL);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-atop";
      ctx.drawImage(this.#aoMask(s), 0, 0);
      if (this.#aoSprites.size > 6000) this.#aoSprites.clear();
      this.#aoSprites.set(k, out);
      return out;
    }

    /** The first corner of a two-click shape. */
    #drawShapeStart() {
      const start = this.host.shapeStart;
      if (!start || !this.host.editable) return;
      this.g.beginPath();
      this.#diamond(...start.cell);
      this.g.strokeStyle = "#e5c07b";
      this.g.lineWidth = 2;
      this.g.stroke();
    }

    /** What a shape would fill: the tile in hand, translucent, when there are few cells; the footprints when there are many. */
    #drawShapeGhost(cells) {
      if (!cells.length) return;
      const g = this.g, host = this.host, remove = !!host.shapeStart?.remove;
      const piece = host.selected && !host.registry.get(host.selected)?.parts;
      if (piece && !remove && cells.length <= 1200) {
        const probe = new Map();
        host.doc.placeInto(probe, [0, 0, 0], host.selected, host.facing, host.shape);
        const proto = [...probe.values()][0];
        if (proto) {
          const sorted = cells.map((c) => ({ c, d: this.#depth(...c, false) })).sort((a, b) => a.d - b.d);
          for (const { c } of sorted) this.#drawCell(...c, proto.id, 0.5, proto.dir, proto.shape ?? 0);
          return;
        }
      }
      g.beginPath();
      for (const c of cells) this.#diamond(...c);
      g.fillStyle = remove ? "rgba(224, 112, 108, 0.3)" : "rgba(111, 191, 115, 0.3)";
      g.fill();
      g.strokeStyle = remove ? "rgba(224, 112, 108, 0.7)" : "rgba(111, 191, 115, 0.7)";
      g.lineWidth = 1;
      g.stroke();
    }

    #drawHover() {
      const hover = this.hover;
      if (!hover || this.#panning || this.rect || !this.host.editable || this.host.floating) return;
      const g = this.g, host = this.host;
      if (hover.hit) {
        const [sx, sy] = this.#toScreen(...this.#project(...hover.hit));
        this.#hexagon(sx, sy, null, "rgba(255, 255, 255, 0.55)", false);
      }
      const shapeCells = host.shapeGhost?.(hover.place);
      if (shapeCells) { this.#drawShapeGhost(shapeCells); return; }
      if (host.selected) {
        // Every cell of the piece, turned as it would be placed.
        const ghost = new Map();
        host.doc.placeInto(ghost, hover.place, host.selected, host.facing, host.shape);
        const cells = [...ghost].map(([k, c]) => [parse(k), c]).sort((a, b) => this.#depth(...a[0], false) - this.#depth(...b[0], false));
        for (const [p, c] of cells) this.#drawCell(...p, c.id, 0.5, c.dir, c.shape ?? 0);
        const shape = cells[0]?.[1].shape ?? 0;
        if (host.registry.get(host.selected)?.rotatable || (shape & (SHAPE.VERTICAL | SHAPE.HORIZONTAL | SHAPE.WALL))) this.#arrow(hover.place, host.facing);
      } else {
        g.beginPath();
        this.#diamond(...hover.place);
        g.strokeStyle = "rgba(111, 191, 115, 0.8)";
        g.lineWidth = 1.5;
        g.stroke();
      }
    }

    // The piece's front, like the game's placement arrow.
    #arrow(cell, dir) {
      const [px, py] = this.#project(...cell);
      const [fx, fz] = rotateOffset(0, 1, dir);
      const [dx, dy] = this.#dirToScreen(fx, fz);
      const z0 = this.zoom, g = this.g;
      const [cx, cy] = this.#toScreen(px + HALF_W, py + HALF_H);
      const ex = cx + dx * 0.55 * z0, ey = cy + dy * 0.55 * z0;
      const len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, head = 7 * z0;
      g.beginPath();
      g.moveTo(cx, cy); g.lineTo(ex, ey);
      g.moveTo(ex - ux * head - uy * head * 0.6, ey - uy * head + ux * head * 0.6);
      g.lineTo(ex, ey);
      g.lineTo(ex - ux * head + uy * head * 0.6, ey - uy * head - ux * head * 0.6);
      g.strokeStyle = "#e5c07b";
      g.lineWidth = 2;
      g.stroke();
    }

    #drawLabel({ x, y, z, text }) {
      const [px, py] = this.#project(x, y, z);
      const [sx, sy] = this.#toScreen(px + HALF_W, py + CELL);
      const g = this.g;
      g.font = "12px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "top";
      const w = g.measureText(text).width + 10;
      g.fillStyle = "rgba(0, 0, 0, 0.6)";
      g.fillRect(sx - w / 2, sy + 4, w, 17);
      g.fillStyle = "#e4e6eb";
      g.fillText(text, sx, sy + 6);
      g.textAlign = "start";
    }

    // ── Input ───────────────────────────────────────────────────────────────────────────────────────────────────

    #bindInput() {
      const c = this.canvas;
      const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      c.addEventListener("contextmenu", (e) => e.preventDefault());
      c.addEventListener("pointerdown", (e) => {
        const [mx, my] = local(e);
        c.setPointerCapture(e.pointerId);
        const host = this.host;
        if (e.button === 1 || (e.button === 0 && this.#space) || !host.editable) {
          if (e.button === 0 || e.button === 1) this.#panning = { x: mx, y: my };
          return;
        }
        if (e.shiftKey && !host.floating && (e.button === 0 || e.button === 2)) {
          const [x, , z] = this.cellAtLevel(mx, my, host.level);
          this.rect = { start: [x, z], end: [x, z], remove: e.button === 2 };
          this.render();
          return;
        }
        if (!this.hover) return;
        if (e.button === 0 && e.altKey) host.onPick?.(this.hover.hit);
        else if (e.button === 0) host.onPlace?.(this.hover.place, e, this.hover.hit);
        else if (e.button === 2) host.onRemove?.(this.hover.hit, this.hover.place);
      });
      c.addEventListener("pointermove", (e) => {
        const [mx, my] = local(e);
        this.mouse = { x: mx, y: my, inside: true };
        if (this.#panning) {
          this.pan.x += mx - this.#panning.x;
          this.pan.y += my - this.#panning.y;
          this.#panning = { x: mx, y: my };
        } else if (this.rect) {
          const [x, , z] = this.cellAtLevel(mx, my, this.host.level);
          this.rect.end = [x, z];
        }
        this.updateHover();
        this.render();
      });
      c.addEventListener("pointerleave", () => { this.mouse.inside = false; this.updateHover(); this.render(); });
      const end = () => {
        this.#panning = null;
        if (this.rect) {
          const r = this.rect;
          this.rect = null;
          this.host.onRect?.(r.start, r.end, r.remove);
        }
        this.render();
      };
      c.addEventListener("pointerup", end);
      c.addEventListener("pointercancel", end);
      c.addEventListener("wheel", (e) => {
        e.preventDefault();
        const [mx, my] = local(e);
        this.zoomAt(mx, my, e.deltaY < 0 ? 1 : -1);
      }, { passive: false });
      window.addEventListener("keydown", (e) => { if (e.key === " " && document.activeElement === document.body) this.#space = true; });
      window.addEventListener("keyup", (e) => { if (e.key === " ") this.#space = false; });
    }
  }

  Aura.structIso = { IsoView };
})(window.Aura ??= {});
