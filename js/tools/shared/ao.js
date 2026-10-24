"use strict";

// Ambient occlusion exactly as the game does it (Chunk.BakeAO / VertexAO / GetSideAO and TileInstanced.fx), so a tile
// looks here the way it does in the game. Pure logic, no drawing: the iso view paints it over the sprites and the 3D view
// feeds it to its shader.
//
// The rule, as in any voxel game: a face vertex takes its value from the three cells that meet at it in the layer in front
// of the face — the two beside it and the one across the corner. Two solid sides shut the corner off whatever it holds;
// otherwise the three add up. 0 = open, 3 = enclosed. Every face sharing a world vertex reads the same cells, so the
// shading runs across tiles without a seam. The shader then blends the four vertices across the face (a plateau of
// REACH near each vertex) and darkens the colour by value / 3 * STRENGTH.
(function (Aura) {
  /** Darkening at an enclosed vertex (value 3): 30 %. */
  const STRENGTH = 0.30;
  /** How far into a face a vertex holds before blending to the next one (1 = plain bilinear; smaller = a tighter band). */
  const REACH = 0.45;
  /** What foliage, furniture and fences weigh as occluders: mostly open space, so only a faint seam. */
  const PARTIAL = 0.1;
  /** The top diamond's edge, a hair wide: a 2:1 pixel-art staircase would leave a light fringe between tiles otherwise. */
  const TOP_TOLERANCE = 0.085;

  /** The four side directions in the game's order: +X, +Z, -X, -Z (Chunk.SideOffsets). */
  const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]];

  // ── What occludes, and what receives ─────────────────────────────────────────────────────────────────────────────

  /** Tag names compare the way the game normalises them: "see_through", "SeeThrough" and "see-through" are one. */
  const norm = (t) => String(t).toLowerCase().replace(/[-_\s]/g, "");

  /** The flags of TileInfo that AO cares about, read off a registry tile ({ category, tags, liquid, layer? }). */
  function flags(tile) {
    const tags = new Set((tile?.tags ?? []).map(norm));
    const category = String(tile?.category ?? "").toLowerCase();
    const foliage = category === "foliage";
    const furniture = category === "tables" || category === "furniture";
    return {
      liquid: !!tile?.liquid,
      foliage,
      furniture,
      nonOccluder: foliage || furniture || tags.has("seethrough") || tags.has("tiny") || !!tile?.layer,
      transparent: tags.has("transparent"),
    };
  }

  /** Chunk.GetAOCasterWeight for a tile: how much shade it throws on the cells beside it. (Air is 0; ask before calling.) */
  function casterWeight(tile) {
    if (!tile) return 1;
    const f = flags(tile);
    if (f.liquid) return 0;
    if (f.foliage || f.furniture || f.nonOccluder) return PARTIAL;
    if (f.transparent) return 0;
    return 1;
  }

  /** Chunk.ReceivesAO: only full blocks have a real top diamond to shade (a plant or a table draws something else there). */
  function receives(tile) {
    if (!tile) return true;
    const f = flags(tile);
    return !f.liquid && !f.foliage && !f.furniture && !f.nonOccluder;
  }

  // ── The bake: from the 27 cells around a tile to the values of its faces' vertices ───────────────────────────────

  /** C#'s MathF.Round goes to the even neighbour at .5 (0.5 → 0, 1.5 → 2, 2.5 → 2); Math.round does not. */
  function roundEven(v) {
    const f = Math.floor(v), d = v - f;
    if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
    return Math.round(v);
  }

  /** Chunk.VertexAO: two solid sides shut the corner off; otherwise the three add up (capped at 3). */
  function vertexAO(side1, side2, corner) {
    if (side1 >= 1 && side2 >= 1) return 3;
    // The game sums 32-bit floats; fround keeps the same sums (0.3 + 0.2 is exactly 0.5 there, which then rounds to even).
    return Math.min(3, Math.fround(Math.fround(side1 + side2) + corner));
  }

  const cubeIndex = (dx, dy, dz) => (dy + 1) * 9 + (dz + 1) * 3 + (dx + 1);

  /**
   * Chunk.BakeAO. weightAt(dx, dy, dz) is the caster weight of the cell at that offset from the tile (dx along +X, dz along
   * +Z, dy levels), 0 for air. bottomSlab: the top sits half a level down, so its layer is the tile's own level.
   * Returns { edge: [top, right, bottom, left] of the top face (the game's North corner order, floats), side: the four side
   * faces packed in one number (see sideFaces) }.
   */
  function bake(weightAt, bottomSlab = false) {
    const cube = new Float32Array(27);
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (dx || dy || dz) cube[cubeIndex(dx, dy, dz)] = weightAt(dx, dy, dz);

    const dy = bottomSlab ? 0 : 1;
    const topVertex = (sx, sz) => vertexAO(cube[cubeIndex(sx, dy, 0)], cube[cubeIndex(0, dy, sz)], cube[cubeIndex(sx, dy, sz)]);
    // A full block directly above covers the top face under every rotation.
    const edge = dy === 1 && cube[cubeIndex(0, 1, 0)] >= 1 ? [0, 0, 0, 0] : [topVertex(-1, -1), topVertex(1, -1), topVertex(1, 1), topVertex(-1, 1)];

    // The vertex of side face d on its t edge, at the top (dy 1) or the bottom (dy -1): the cell beside it along t, the one
    // above / below in front of the face, and the corner of the two. Sides round to whole numbers (2 bits each).
    const sideVertex = (d, t, vy) => roundEven(vertexAO(
      cube[cubeIndex(d[0] + t[0], 0, d[1] + t[1])], cube[cubeIndex(d[0], vy, d[1])], cube[cubeIndex(d[0] + t[0], vy, d[1] + t[1])]));
    let side = 0;
    for (let i = 0; i < 4; i++) {
      const d = SIDES[i];
      if (cube[cubeIndex(d[0], 0, d[1])] >= 1) continue;   // a full block in front: never seen
      const p = SIDES[(i + 1) & 3], m = SIDES[(i + 3) & 3];
      const face = sideVertex(d, p, 1) | (sideVertex(d, p, -1) << 2) | (sideVertex(d, m, 1) << 4) | (sideVertex(d, m, -1) << 6);
      side |= face << (i * 8);
    }
    return { edge, side: side >>> 0 };
  }

  /** Chunk.RotateCorners: the top face's corners for a camera rotation 0..3 — each quarter turn cycles them one place. */
  function rotateCorners(c, rotation) {
    switch (rotation & 3) {
      case 1: return [c[1], c[2], c[3], c[0]];
      case 2: return [c[2], c[3], c[0], c[1]];
      case 3: return [c[3], c[0], c[1], c[2]];
      default: return c;
    }
  }

  /**
   * Chunk.GetSideAO: the sprite's left and right faces under a camera rotation, each as one number 0..255 the shading
   * unpacks: back top * 64 + front top * 16 + back bottom * 4 + front bottom (each 0..3).
   */
  function sideFaces(sideAO, rotation) {
    if (!sideAO) return [0, 0];
    const left = (sideAO >>> (((rotation + 1) & 3) * 8)) & 0xff, right = (sideAO >>> ((rotation & 3) * 8)) & 0xff;
    const screen = (face, backIsP) => {
      const pTop = face & 3, pBottom = (face >> 2) & 3, mTop = (face >> 4) & 3, mBottom = (face >> 6) & 3;
      const backTop = backIsP ? pTop : mTop, backBottom = backIsP ? pBottom : mBottom;
      const frontTop = backIsP ? mTop : pTop, frontBottom = backIsP ? mBottom : pBottom;
      return backTop * 64 + frontTop * 16 + backBottom * 4 + frontBottom;
    };
    return [screen(left, true), screen(right, false)];
  }

  // ── The shading: TileInstanced.fx's pixel shader, for one pixel of a sprite ─────────────────────────────────────

  const saturate = (v) => Math.max(0, Math.min(1, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  /** 0..1 across a face with the plateau REACH gives: 0 / 1 hold near each end, the blend sits in the middle. */
  const aoBlend = (x) => saturate((x - 0.5) / REACH + 0.5);

  /** The top face's four corner values blended across its diamond (a, c: centred diamond coordinates, ±0.5 at the corners). */
  function diamondBilinear(a, c, corners) {
    const u = saturate((a + c) / REACH + 0.5), v = saturate((a - c) / REACH + 0.5);
    return lerp(lerp(corners[3], corners[2], u), lerp(corners[0], corners[1], u), v);
  }

  /** Whether a sprite pixel (u, v in 0..1) lies on the top diamond, which sits `topOffset` down for a slab. */
  const onTopFace = (u, v, topOffset = 0) => Math.abs(u - 0.5) * 2 + Math.abs(v - 0.25 - topOffset) * 4 <= 1 + TOP_TOLERANCE;

  function unpackFace(packed) {
    let v = Math.round(packed);
    const backTop = Math.floor(v / 64); v -= backTop * 64;
    const frontTop = Math.floor(v / 16); v -= frontTop * 16;
    const backBottom = Math.floor(v / 4);
    return [backTop, frontTop, backBottom, v - backBottom * 4];
  }

  /** AO of a side face at a pixel, 0..3: `along` runs from the face's back vertical edge (0) to its front one (1). */
  function sideFaceAO(u, v, topOffset, packed, leftFace) {
    const along = saturate(leftFace ? u * 2 : (1 - u) * 2);
    const topY = 0.25 + topOffset + along * 0.25, bottomY = 0.75 + along * 0.25;
    const down = saturate((v - topY) / Math.max(bottomY - topY, 0.01));
    const q = unpackFace(packed), k = aoBlend(along);
    return lerp(lerp(q[0], q[1], k), lerp(q[2], q[3], k), aoBlend(down));
  }

  /**
   * The AO a sprite pixel gets, 0..1 (value / 3). u, v: the pixel's place in the sprite, 0..1. edge: the top corners already
   * rotated for the camera; left / right: the side faces from sideFaces. The darkening is then ao * STRENGTH.
   */
  function pixelAO(u, v, topOffset, edge, left, right) {
    if (onTopFace(u, v, topOffset)) return saturate(diamondBilinear(u - 0.5, (v - topOffset) * 2 - 0.5, edge) / 3);
    return saturate(sideFaceAO(u, v, topOffset, u < 0.5 ? left : right, u < 0.5) / 3);
  }

  /** A short key for one AO setup, so equal ones share a mask (the corner values come in tenths). */
  const keyOf = (edge, left, right, topOffset) => `${edge.map((e) => Math.round(e * 10)).join(",")}|${left}|${right}|${topOffset}`;

  Aura.ao = { STRENGTH, REACH, PARTIAL, SIDES, roundEven, flags, casterWeight, receives, vertexAO, bake, rotateCorners, sideFaces, aoBlend, diamondBilinear, onTopFace, sideFaceAO, pixelAO, keyOf };
})(window.Aura ??= {});
