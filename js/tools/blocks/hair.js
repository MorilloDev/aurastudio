"use strict";

// Hairs (fringe) for the Bloques tool: one-pixel strands growing from the edges of a piece — bark fibres on a log,
// grass blades on a dirt block, roots under a slab — painted with the texture of the face they grow from. They are
// drawn straight into the sprite at its own pixel size (voxels are too coarse for a one-pixel strand), against the
// depth of what is already there, so a strand behind the piece stays hidden and one in front covers it.
(function (Aura) {
  // World direction indices, as in shapes.js: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z (up), 5 -Z.
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  /**
   * Edge groups: which two open sides make the edge, the axis it runs along, and the strand's way out (outward side,
   * then vertical sense: +1 stands up, -1 hangs). Back edges are the top diamond's two upper sides — the corner zones
   * marked in the sprite; front-top edges are where the top meets the faces we see.
   */
  const GROUPS = [
    { key: "backLeft", open: [1, 4], along: 1, out: [-1, 0, 0], vertical: 1, texDir: 4, face: "TOP" },
    { key: "backRight", open: [2, 4], along: 0, out: [0, 1, 0], vertical: 1, texDir: 4, face: "TOP" },
    { key: "frontTop", open: [3, 4], along: 0, out: [0, -1, 0], vertical: 1, texDir: 4, face: "TOP" },
    { key: "frontTop", open: [0, 4], along: 1, out: [1, 0, 0], vertical: 1, texDir: 4, face: "TOP" },
    { key: "corner", open: [0, 3], along: 2, out: [Math.SQRT1_2, -Math.SQRT1_2, 0], vertical: 0, texDir: 3, face: "LEFT" },
    { key: "bottomLeft", open: [3, 5], along: 0, out: [0, -1, 0], vertical: -1, texDir: 3, face: "LEFT" },
    { key: "bottomRight", open: [0, 5], along: 1, out: [1, 0, 0], vertical: -1, texDir: 0, face: "RIGHT" },
  ];

  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };

  /** ctx: what render() hands over — options, voxels, textures, sprite size, depth buffer and its pixel writer. */
  function draw(ctx) {
    const { o, V, tex, S, H, zbuf, mask, faceN, put, project, BACK, FACE, quantAO, rng } = ctx;
    const hp = o.hair;
    const R = V.R;
    const random = rng(hp.seed);
    const pxWorld = Math.SQRT2 / S;              // one sprite pixel, in world units, across the screen
    const pxPerVoxel = S / R * 0.75;             // rough edge length of one voxel on screen
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const isOpen = (i, j, k, wd) => {
      const d = DIRS[wd];
      return !V.isBase(i + d[0], j + d[1], k + d[2]);
    };

    // Groups are written for an upright piece. A piece whose textures turn with it (a log lying down, a slab on its side,
    // an isometric rotation) carries its top texture on another face: the groups turn the same way, so the hairs grow
    // from the edges of that face and lean out of it, not from whatever happens to face the sky.
    const rot = V.tf.texRot;
    const turn = (v) => [0, 1, 2].map((r) => rot[r][0] * v[0] + rot[r][1] * v[1] + rot[r][2] * v[2]);
    const dirIdx = (v) => DIRS.findIndex((d) => Math.abs(d[0] - v[0]) < 1e-6 && Math.abs(d[1] - v[1]) < 1e-6 && Math.abs(d[2] - v[2]) < 1e-6);
    const up = turn([0, 0, 1]);
    const groups = GROUPS.map((g) => {
      const axis = [0, 0, 0]; axis[g.along] = 1;
      const a = turn(axis);
      const texDir = dirIdx(turn(DIRS[g.texDir]));
      const face = texDir === 4 ? "TOP" : texDir === 3 ? "LEFT" : texDir === 0 ? "RIGHT"
        : Math.abs(up[2]) >= 0.5 ? "TOP" : up[1] < 0 ? "LEFT" : "RIGHT";
      return { ...g, open: g.open.map((wd) => dirIdx(turn(DIRS[wd]))), along: a.findIndex((x) => Math.abs(x) > 0.5),
        out: turn(g.out), texDir, face };
    });

    const strands = [];
    for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      if (!V.isBase(i, j, k) || !V.solid(i, j, k)) continue;
      const sloped = V.isSloped?.(i, j, k);
      for (const g of groups) {
        if (!hp.edges[g.key] || (sloped && g.open.includes(4))) continue;
        if (!isOpen(i, j, k, g.open[0]) || !isOpen(i, j, k, g.open[1])) continue;
        // The edge line: the voxel's corner shared by its two open sides, running along g.along.
        const corner = [i, j, k];
        for (const wd of g.open) {
          const d = DIRS[wd];
          for (let a = 0; a < 3; a++) if (d[a] > 0) corner[a] += 1;
        }
        const count = Math.floor(hp.density * pxPerVoxel + random());
        for (let c = 0; c < count; c++) {
          const p = corner.slice();
          p[g.along] += random();
          strands.push({ g, cell: p });
        }
      }
    }

    const vz = H / R;
    for (const { g, cell } of strands) {
      const root = [-0.5 + cell[0] / R, -0.5 + cell[1] / R, cell[2] * vz];
      // Direction: between straight out of the face (lean 1) and straight up / down (lean 0), turned at random.
      const vert = g.vertical === 0 ? (random() - 0.5) * 0.6 : g.vertical;
      // "Up" is the piece's own up: away from its top face, whichever way that face now looks.
      const rise = 1 - hp.lean;
      let dir = [g.out[0] * hp.lean + up[0] * vert * rise, g.out[1] * hp.lean + up[1] * vert * rise, g.out[2] * hp.lean + up[2] * vert * rise];
      dir = norm([dir[0] + (random() - 0.5) * hp.spread * 2, dir[1] + (random() - 0.5) * hp.spread * 2, dir[2] + (random() - 0.5) * hp.spread]);
      let len = hp.length * (1 - hp.lengthVar * random()) * pxWorld;
      if (len < pxWorld * 0.75) continue;

      const pointAt = (t) => [
        root[0] + dir[0] * len * t,
        root[1] + dir[1] * len * t,
        root[2] + dir[2] * len * t - hp.droop * len * t * t,
      ];
      // Strands never leave the sprite: shorten until the tip is inside, drop the strand if nothing is left.
      if (o.autoFit) {
        let tries = 0;
        for (;;) {
          const [x, y] = project(pointAt(1), S, H);
          if (x >= 0 && x < S && y >= 0 && y < S) break;
          len *= 0.8;
          if (++tries > 12 || len < pxWorld) { len = 0; break; }
        }
        if (!len) continue;
      }

      // Colour: the texture of the face it grows out of, read where that face would carry on under each point of the
      // strand (wrapped), the same way the edge masks are painted, so a strand never stands out from its face.
      const colorAt = (q) => {
        const [name, u, v] = V.uvAt([q[0] + 0.5, q[1] + 0.5, q[2] / H], g.texDir);
        return tex[name].color(u, v);
      };
      if (colorAt(root)[3] < 8) continue;
      const face = g.face === "TOP" ? FACE.TOP : g.face === "LEFT" ? FACE.LEFT
        : (g.key === "corner" && random() < 0.5 ? FACE.RIGHT : FACE[g.face]);

      const steps = Math.max(2, Math.ceil(len / pxWorld * 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const p = pointAt(t);
        const [fx, fy] = project(p, S, H);
        const d = dot(p, BACK);
        const k = 1 + hp.tipShade * t;
        const base = colorAt(p);
        if (base[3] < 8) continue;
        const texel = [base[0] * k, base[1] * k, base[2] * k, 255];
        // Darker at the root, where the strand meets the piece.
        const ao = o.ao ? quantAO(1 - o.aoStrength * 0.4 * (1 - t)) : 1;
        const width = t < 0.5 ? Math.max(1, Math.round(hp.width)) : 1;
        for (let w = 0; w < width; w++) {
          const x = Math.floor(fx) + w, y = Math.floor(fy);
          if (x < 0 || y < 0 || x >= S || y >= S) continue;
          const pi = y * S + x;
          if (d <= zbuf[pi] + 1e-6) continue;
          zbuf[pi] = d;
          put(pi * 4, texel, face, ao, d);
          mask[pi] = 1;
          faceN[pi] = face;
        }
      }
    }
  }

  Aura.blockHair = { draw, GROUPS };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
