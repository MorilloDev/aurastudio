"use strict";

// What a piece asks of its neighbours before it is drawn — the game's TileConnections, rule for rule: the arms a fence
// puts out, and the bend a flight of steps takes where two of them meet.
//
// None of this is stored in the template. It is read off the neighbours every time, so moving one step changes how the
// one beside it is drawn, and a fence closes itself against whatever is put next to it.
//
// Both answers go through the projection rather than through world directions: an arm is named by the side of the
// screen it runs to and a bend by the corner of the diamond it lands on, which is what lets four drawings serve the
// four turns of the camera instead of needing art for each.
(function (Aura) {
  const { SHAPE } = Aura.structTiles;
  const { key, rotateOffset } = Aura.structModel;

  // TileConnections.Neighbours, in the same order.
  const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // ConnectArm: 0 Nw (up-left), 1 Ne, 2 Se, 3 Sw. toScreen(x, z) → [sx, sy] under the camera as it stands.
  function armTowards(toScreen, x, z) {
    const [sx, sy] = toScreen(x, z);
    return sx >= 0 ? (sy >= 0 ? 2 : 1) : (sy >= 0 ? 3 : 0);
  }

  // CornerVertex: 0 N, 1 E, 2 S, 3 W — the corner of the diamond a quarter of the cell shows up on.
  function vertexTowards(toScreen, x, z) {
    const [sx, sy] = toScreen(x, z);
    if (sx > 0) return 1;
    if (sx < 0) return 3;
    return sy < 0 ? 0 : 2;
  }

  /** The arms of this cell, as a flag per ConnectArm. */
  function armsAt(registry, doc, tile, x, y, z, toScreen) {
    const arms = [false, false, false, false];

    for (const [dx, dz] of NEIGHBOURS) {
      const other = registry.get(doc.blocks.get(key(x + dx, y, z + dz)));
      if (registry.joins(tile, other)) arms[armTowards(toScreen, dx, dz)] = true;
    }

    return arms;
  }

  // The facing of the step in that cell, or null when it is not one of these stairs standing the same way up.
  function stepFacing(doc, tile, x, y, z, upsideDown) {
    const k = key(x, y, z);
    if (doc.blocks.get(k) !== tile.id) return null;
    if (!!((doc.shapes.get(k) ?? 0) & SHAPE.UPPER) !== upsideDown) return null;
    return doc.dirs.get(k) ?? 0;
  }

  const crosses = (a, b) => ((a - b) & 1) !== 0;

  /**
   * The bend this step takes, as an index into the tile's sixteen corner drawings (state * 4 + vertex, states in the
   * order outer, outerInverted, inner, innerInverted), or null when it is a straight step.
   */
  function stairCorner(doc, tile, x, y, z, dir, upsideDown, toScreen) {
    const [fx, fz] = rotateOffset(0, 1, dir);
    const ahead = stepFacing(doc, tile, x + fx, y, z + fz, upsideDown);
    const behind = stepFacing(doc, tile, x - fx, y, z - fz, upsideDown);

    // Running into the back of a step that crosses us: our raised half overshoots the turn, so it is cut back to the
    // quarter the two of them share — the one away from both low sides.
    if (behind != null && crosses(dir, behind) && ahead !== behind) {
      const [bx, bz] = rotateOffset(0, 1, behind);
      return (upsideDown ? 1 : 0) * 4 + vertexTowards(toScreen, -fx - bx, -fz - bz);
    }

    // A step that crosses us where we step down: its raised half starts a cell further on, so ours grows the quarter
    // that bridges the gap and only the one across both low sides is left open.
    if (ahead != null && crosses(dir, ahead) && behind !== ahead) {
      const [ax, az] = rotateOffset(0, 1, ahead);
      return (upsideDown ? 3 : 2) * 4 + vertexTowards(toScreen, fx + ax, fz + az);
    }

    return null;
  }

  Aura.structConnect = { armsAt, stairCorner, armTowards, vertexTowards, NEIGHBOURS };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
