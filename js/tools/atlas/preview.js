(function () {
  "use strict";

  // How a piece looks once its parts are put together, the way the game puts them: the same projection, the same
  // facing rules, the same swap between the two halves and the same choice of front or back art. Ported from
  // IsoProjection and WorldQuery.ResolvePieceArt — if either of those changes, this has to change with it.
  //
  // The point of it is the art: half a table drawn on its own tells you nothing about whether the legs land on the
  // corners, whether the top meets in the middle, or whether the back is the same picture as the front.

  const HALF_W = 32;   // IsoProjection.HalfTileW
  const HALF_H = 16;   // IsoProjection.HalfTileH
  const LAYER = 32;    // IsoProjection.LayerStepY

  // WorldQuery.UnflippedFrontFacesSouthWest: the side the art faces before any mirroring.
  const UNFLIPPED_FRONT_FACES_SW = false;

  const DIRS = ["north", "east", "south", "west"];
  const DIR_LABEL = { north: "N", east: "E", south: "S", west: "O" };

  /** WorldQuery.RotateOffset: turns a part's offset by the piece's placement. */
  function rotateOffset(ox, oz, dir) {
    switch (dir) {
      case 1: return [-oz, ox];
      case 2: return [-ox, -oz];
      case 3: return [oz, -ox];
      default: return [ox, oz];
    }
  }

  /** IsoProjection.RotateXZ: turns the world by the camera. */
  function rotateXZ(x, z, cam) {
    switch (cam) {
      case 1: return [z, -x];
      case 2: return [-x, -z];
      case 3: return [-z, x];
      default: return [x, z];
    }
  }

  const dirToScreen = (x, z, cam) => {
    const [rx, rz] = rotateXZ(x, z, cam);
    return [(rx - rz) * HALF_W, (rx + rz) * HALF_H];
  };

  const toScreen = (x, y, z, cam) => {
    const [rx, rz] = rotateXZ(x, z, cam);
    return [(rx - rz) * HALF_W, (rx + rz) * HALF_H - y * LAYER];
  };

  const isCoord = (c) => Array.isArray(c) && c.length === 2 && c.every((n) => Number.isFinite(n));

  /** The front or back cell of an owner's art, falling back to the front when it has no back. */
  function artCell(owner, side) {
    const art = owner && owner.art;
    if (!art || typeof art !== "object" || Array.isArray(art)) return null;
    const frame = art.default;
    if (isCoord(frame)) return frame;                       // an early draft of the format: a bare [x, y]
    if (!frame || typeof frame !== "object") return null;
    if (side === "back" && isCoord(frame.back)) return frame.back;
    return isCoord(frame.front) ? frame.front : null;
  }

  const isAnchor = (p) => !(p.offsetX | 0) && !(p.offsetY | 0) && !(p.offsetZ | 0);

  /** The piece's cells: the parts if it has them, otherwise the tile itself as one cell at the origin. */
  function ownersOf(tile) {
    if (Array.isArray(tile.parts) && tile.parts.length) {
      return tile.parts.filter((p) => p && typeof p === "object").map((p) => ({
        owner: p, x: p.offsetX | 0, y: p.offsetY | 0, z: p.offsetZ | 0,
      }));
    }
    return [{ owner: tile, x: 0, y: 0, z: 0 }];
  }

  /**
   * Lays the piece out for one placement and one camera angle. Returns the cells in draw order, each with the art
   * cell to use, where it goes relative to the anchor, and whether it is mirrored.
   */
  function compose(tile, { dir = 0, cam = 0 } = {}) {
    const cells = ownersOf(tile);
    const rotatable = !!tile.rotatable;

    // WorldQuery.ResolvePieceArt: the front's screen direction decides both the mirror and the back art.
    const [fx, fz] = rotateOffset(0, 1, dir);
    const front = dirToScreen(fx, fz, cam);
    const flip = rotatable && ((front[0] * front[1] > 0) === UNFLIPPED_FRONT_FACES_SW);
    const useBack = rotatable && front[1] < 0;

    // The two halves of a flat piece trade their art when the piece's own axis points up the screen. A vertical
    // stack (the furnace) never swaps: there is no "above on screen" for it.
    let swap = false;
    const second = cells.length === 2 && cells.some(isAnchorCell) ? cells.find((c) => !isAnchorCell(c)) : null;
    if (rotatable && second && second.y === 0) {
      const [ax, az] = rotateOffset(second.x, second.z, dir);
      swap = dirToScreen(ax, az, cam)[1] < 0;
    }

    const out = [];
    for (const cell of cells) {
      const source = swap && cells.length === 2 ? cells[cells.indexOf(cell) === 0 ? 1 : 0] : cell;
      const coord = artCell(source.owner, useBack ? "back" : "front");
      if (!coord) continue;
      const [rx, rz] = rotateOffset(cell.x, cell.z, dir);
      const [sx, sy] = toScreen(rx, cell.y, rz, cam);
      out.push({ coord, x: sx, y: sy, flip, depth: rx + rz + cell.y * 0.5, back: useBack && coord !== artCell(source.owner, "front") });
    }
    // Back to front, bottom first: the same order the draw list ends up in.
    out.sort((a, b) => a.depth - b.depth || a.y - b.y);
    return { cells: out, flip, back: useBack, swap };
  }

  function isAnchorCell(c) { return !c.x && !c.y && !c.z; }

  /** True when the piece is worth previewing: more than one cell, or art with a back of its own. */
  function worthPreview(tile) {
    if (Array.isArray(tile.parts) && tile.parts.length > 1) return true;
    const frame = tile.art && tile.art.default;
    return !!(frame && typeof frame === "object" && isCoord(frame.back));
  }

  /**
   * Draws a composition into a canvas. `cellAt(coord)` hands back the source rectangle on the sheet; `image` is the
   * sheet canvas. Returns the canvas, sized to what it drew.
   */
  function draw(canvas, image, composition, { tw, th, zoom = 2, pad = 2 }) {
    const cells = composition.cells;
    let minX = 0, minY = 0, maxX = tw, maxY = th;
    for (const c of cells) {
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + tw); maxY = Math.max(maxY, c.y + th);
    }
    const w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
    canvas.width = w * zoom;
    canvas.height = h * zoom;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(zoom, 0, 0, zoom, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const c of cells) {
      const dx = c.x - minX + pad, dy = c.y - minY + pad;
      const sx = c.coord[0] * tw, sy = c.coord[1] * th;
      if (c.flip) {
        ctx.save();
        ctx.translate(dx + tw, dy);
        ctx.scale(-1, 1);
        ctx.drawImage(image, sx, sy, tw, th, 0, 0, tw, th);
        ctx.restore();
      } else {
        ctx.drawImage(image, sx, sy, tw, th, dx, dy, tw, th);
      }
    }
    return canvas;
  }

  globalThis.Aura = globalThis.Aura || {};
  globalThis.Aura.atlasPreview = { compose, draw, worthPreview, DIRS, DIR_LABEL };
})();
