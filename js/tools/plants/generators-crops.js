"use strict";

// More crops for the Foliage tab: tomato and rice. Both follow "Crecimiento" (0 = just sown, 1 = ready to harvest), so
// the Variantes stages and «Enviar crecimiento al Atlas» give a full set of growth tiles like wheat or carrot.
// Registers into Aura.plantGen.
(function (Aura) {
  const G = Aura.plantGen;
  const M = Aura.plantMesh;
  const { V, UP, clamp01, smooth, jitterColor, gradient, anyPerp, bezierPath, arcPath } = M;
  const { L, vary, leanDirection, featherLeaf, growthColor } = G.helpers;

  // 0 below a, 1 above b, smooth in between: when a part of the plant shows up along the growth.
  const phase = (g, a, b) => smooth((g - a) / Math.max(1e-6, b - a));

  // ── Tomato ───────────────────────────────────────────────────────────────────────────────────────────────────────

  // A tomato plant left to grow on its own, with no stake: a low bush of branches that rise from the base and flop over
  // under their own weight, compound leaves along them, small yellow flowers mid-season and trusses of fruit that swell
  // green, turn their colour as they ripen and end up resting on the ground.
  function genTomato(mb, p, r, pos) {
    const g = p.growth, cv = p.colorVariation;
    const stemC = jitterColor(r, p.baseColorL, cv), stemTip = jitterColor(r, p.tipColorL, cv);
    const leafGreen = jitterColor(r, p.stemLeafColorL, cv);
    // Old leaves yellow a little at the end of the season, never as much as a cereal.
    const leafC = growthColor(p, leafGreen, V.lerp(leafGreen, L2(0.45, 0.42, 0.08), 0.35), 0.85);
    const grown = phase(g, 0, 0.7);
    const h = Math.max(0.05, vary(r, p.tomatoHeight, p.heightVariation)) * (0.25 + 0.75 * grown);
    // A seedling is one shoot; the bush fills out as it grows.
    const branches = Math.max(1, Math.round(p.tomatoBranches * (0.25 + 0.75 * phase(g, 0.1, 0.6))));
    const seg = 6;
    const w = p.stemWidth * (0.5 + 0.5 * phase(g, 0, 0.5));
    const leafSize = p.stemLeafSize * (0.45 + 0.55 * phase(g, 0, 0.5));
    let a0 = r.uniform(0, 2 * Math.PI);
    const paths = [];

    for (let b = 0; b < branches; b++) {
      const a = a0 + (b / branches) * 2 * Math.PI + r.uniform(-0.35, 0.35);
      const d = [Math.cos(a), Math.sin(a), 0];
      // The first shoot stands; the others lean out and, once long, bend back toward the ground.
      const lean = branches === 1 ? r.uniform(0, 10) : p.tomatoSprawl * 60 * r.uniform(0.6, 1);
      const bend = branches === 1 ? 0.1 : 0.4 + p.tomatoSprawl * 1.4 * grown;
      const len = h * (b === 0 ? 1 : r.uniform(0.75, 1.05)) * (1 + p.tomatoSprawl * 0.6);
      const path = arcPath(pos, d, len, lean, bend, seg).map((q) => [q[0], q[1], Math.max(w, q[2])]);
      mb.tube(path, path.map((_, i) => w * (1 - 0.5 * i / seg)), Math.max(4, p.tubeSides), gradient(stemC, stemTip, seg + 1));
      paths.push({ path, d });

      // Compound leaves alternate along the branch, longest near the base.
      for (let i = 1; i <= seg; i += 1) {
        if (i % 2 === 0 && i < seg) continue;
        const t = i / seg;
        const la = a + (i % 4 < 2 ? 1 : -1) * r.uniform(0.6, 1.4);
        featherLeaf(mb, p, path[i], [Math.cos(la), Math.sin(la), 0], leafSize * (1.1 - 0.4 * t) * r.uniform(0.85, 1.1), leafC, p.tomatoPinnae, 0.45);
      }
    }

    // Flowers: from a third of the way, gone once the fruit has set.
    const flowerAmt = phase(g, 0.35, 0.5) * (1 - phase(g, 0.7, 0.85));
    // Fruit: sets at about half, swells, then changes colour from 0.75.
    const fruitAmt = phase(g, 0.5, 0.8);
    const fruitGreen = jitterColor(r, p.fruitGreenColorL, cv), fruitRipe = jitterColor(r, p.fruitColorL, cv);
    const fruitC = V.lerp(fruitGreen, fruitRipe, phase(g, 0.75, 1));
    const calyx = V.mul(leafGreen, 0.8);

    for (let c = 0; c < p.tomatoTrusses && paths.length; c++) {
      const { path, d } = paths[c % paths.length];
      // Trusses come off the outer half of a branch and droop outward, past the leaves: under the canopy they would
      // be hidden, and a sprawling plant shows its fruit around its edge.
      const from = path[Math.min(seg - 1, 3 + (c % 2))];
      const out = V.norm(V.add(d, [r.uniform(-0.4, 0.4), r.uniform(-0.4, 0.4), 0]));
      const reach = V.add(from, V.mul(out, p.fruitSize * 3.5));
      const hang = [reach[0], reach[1], Math.max(0, reach[2] - p.fruitSize * (1.5 + 3 * fruitAmt))];
      if (flowerAmt > 0.02) {
        for (let k = 0; k < p.tomatoFruits; k++) {
          const at = V.add(reach, [r.uniform(-1, 1) * p.fruitSize * 1.4, r.uniform(-1, 1) * p.fruitSize * 1.4, r.uniform(0, 1) * p.fruitSize]);
          flowerStar(mb, at, p.fruitSize * 0.9 * flowerAmt, p.petalColorL);
        }
      }
      if (fruitAmt <= 0.02) continue;
      const stalk = bezierPath(from, reach, hang, 4);
      mb.tube(stalk, stalk.map(() => w * 0.2), 3, stalk.map(() => stemC), { capTip: false });
      for (let k = 0; k < p.tomatoFruits; k++) {
        const size = p.fruitSize * fruitAmt * r.uniform(0.75, 1.15) * (1 - 0.1 * k);
        const off = [r.uniform(-1, 1) * p.fruitSize * 1.5, r.uniform(-1, 1) * p.fruitSize * 1.5, -k * p.fruitSize * 0.5];
        const at = V.add(hang, off);
        // Never under the ground: the lowest tomatoes sit on it.
        at[2] = Math.max(size * p.fruitFlatten, at[2]);
        const col = jitterColor(r, fruitC, 0.04);
        const hi = V.lerp(col, [1, 1, 1], p.fruitShine * 0.35);
        mb.blob(at, size, (q, n) => V.lerp(V.mul(col, 0.75), hi, clamp01(n[2] * 0.6 + 0.45)), r,
          { subdiv: 1, squash: [1, 1, p.fruitFlatten], noise: 0.04 });
        // Little green star on top: what makes a red ball read as a tomato.
        flowerStar(mb, V.add(at, [0, 0, size * p.fruitFlatten * 0.95]), size * 0.55, calyx);
      }
    }
  }

  /** Five flat pointed sepals or petals in a star, facing up. */
  function flowerStar(mb, at, size, color) {
    if (size <= 1e-4) return;
    for (let k = 0; k < 5; k++) {
      const a = 2 * Math.PI * k / 5;
      mb.leaf(at, [Math.cos(a), Math.sin(a), 0], size, size * 0.4, [V.mul(color, 0.85), color], { lift: 0.1, droop: 0.2, fold: 0, shape: "LANCE", segments: 2 });
    }
  }

  const L2 = (r, g, b) => [r, g, b];

  G.register("TOMATO", {
    category: "crops", label: "Tomatera",
    params: { "Tomatera": [
      ["growth", "Crecimiento", "num", 1, 0, 1, 0.01],
      ["tomatoHeight", "Altura", "num", 0.5, 0.1, 1.2, 0.01], ["heightVariation", "Var. altura", "num", 0.12, 0, 1, 0.01],
      ["tomatoBranches", "Ramas", "int", 5, 1, 10, 1],
      ["tomatoSprawl", "Tumbada", "num", 0.6, 0, 1, 0.01, "0 = erguida, 1 = las ramas se tumban sobre el suelo"],
      ["stemWidth", "Ancho tallo", "num", 0.026, 0.005, 0.1, 0.001],
      ["stemLeafSize", "Largo hoja", "num", 0.3, 0.05, 0.6, 0.005], ["tomatoPinnae", "Foliolos", "int", 4, 1, 6, 1],
      ["stemLeafColor", "Color hoja", "color", L(0.1, 0.35, 0.06)],
      ["tomatoTrusses", "Racimos", "int", 4, 0, 8, 1], ["tomatoFruits", "Frutos por racimo", "int", 4, 1, 6, 1],
      ["fruitSize", "Tamaño fruto", "num", 0.06, 0.01, 0.12, 0.001], ["fruitFlatten", "Aplanado fruto", "num", 0.85, 0.5, 1.2, 0.01],
      ["fruitColor", "Color maduro", "color", L(0.85, 0.03, 0.02)], ["fruitGreenColor", "Color verde", "color", L(0.25, 0.5, 0.1)],
      ["fruitShine", "Brillo", "num", 0.4, 0, 1, 0.01], ["petalColor", "Color flor", "color", L(1, 0.8, 0.05)],
    ] },
    defaults: { count: 1, tubeSides: 5, baseColor: L(0.12, 0.3, 0.06), tipColor: L(0.2, 0.45, 0.1) },
    growth: true,
  }, genTomato, [
    { key: "RED", label: "Tomate rojo", values: { fruitColor: L(0.85, 0.03, 0.02), fruitSize: 0.06, tomatoFruits: 4, fruitFlatten: 0.85 } },
    { key: "CHERRY", label: "Cherry", values: { fruitColor: L(0.8, 0.05, 0.02), fruitSize: 0.03, tomatoFruits: 5, tomatoTrusses: 4, fruitFlatten: 1 } },
    { key: "BEEF", label: "Corazón de buey", values: { fruitColor: L(0.7, 0.06, 0.03), fruitSize: 0.065, tomatoFruits: 2, tomatoTrusses: 2, fruitFlatten: 0.7 } },
    { key: "YELLOW", label: "Amarillo", values: { fruitColor: L(0.95, 0.6, 0.02), fruitSize: 0.04, tomatoFruits: 3 } },
    { key: "BUSH", label: "Mata baja", values: { tomatoHeight: 0.35, tomatoSprawl: 0.9, tomatoBranches: 6 } },
  ]);

  // ── Rice ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  // A rice hill: a tuft of tillers that start as a few bright blades, grow long arching leaves, push out a panicle
  // each, and bow under the weight of the grain as it turns gold. Several hills per tile, in rows like a paddy.
  function genRice(mb, p, r, pos) {
    const g = p.growth, cv = p.colorVariation;
    const green = jitterColor(r, p.baseColorL, cv), leafGreen = jitterColor(r, p.stemLeafColorL, cv);
    const ripe = jitterColor(r, p.ripeColorL, cv), ripeTip = jitterColor(r, p.ripeTipColorL, cv);
    // Leaves go straw-coloured from 0.8; the grain turns from 0.7.
    const leafC = growthColor(p, leafGreen, V.lerp(leafGreen, V.mul(ripe, 0.8), 0.65), 0.85);
    const stemC = growthColor(p, green, V.lerp(green, V.mul(ripe, 0.8), 0.7), 0.85);
    const tillers = Math.max(2, Math.round(p.riceTillers * (0.35 + 0.65 * phase(g, 0, 0.45))));
    const height = Math.max(0.05, vary(r, p.riceHeight, p.heightVariation)) * (0.2 + 0.8 * phase(g, 0, 0.6));
    const base = leanDirection(p, r, pos);

    for (let t = 0; t < tillers; t++) {
      // Tillers fan out from the hill: the outer ones lean more.
      const a = Math.atan2(base[1], base[0]) + (t / tillers) * 2 * Math.PI + r.uniform(-0.3, 0.3);
      const d = [Math.cos(a), Math.sin(a), 0];
      const lean = p.inclination + r.uniform(0, p.inclinationVariation) + 6 * (t % 3);
      const start = V.add(pos, V.mul(d, p.stemWidth * 0.6 * (t % 3)));
      const h = height * r.uniform(0.85, 1.05);
      const seg = Math.max(3, p.segments);

      // Seedling: only blades, no stem to speak of.
      const hasStem = g >= 0.3;
      const path = arcPath(start, d, hasStem ? h : h * 0.15, lean, 0.1, seg);
      if (hasStem) mb.tube(path, path.map((_, i) => p.stemWidth * 0.3 * (1 - 0.4 * i / seg)), 3, gradient(V.mul(stemC, 0.85), stemC, seg + 1));

      // Long narrow leaves arching out from the base and the lower joints.
      for (let k = 0; k < p.riceLeaves; k++) {
        const at = path[Math.min(seg, Math.floor(k * 0.4))];
        const la = a + r.uniform(-0.9, 0.9);
        const size = h * p.riceLeafLength * r.uniform(0.75, 1.1) * (hasStem ? 1 : 2.4);
        mb.leaf(at, [Math.cos(la), Math.sin(la), 0], size, size * p.riceLeafWidth, [V.mul(leafC, 0.85), leafC],
          { lift: 0.95 - 0.2 * phase(g, 0.6, 1), droop: 0.35 + 0.25 * phase(g, 0.8, 1), fold: 0.4, shape: "BLADE" });
      }

      const head = phase(g, 0.5, 0.7);
      if (!hasStem || head <= 0.02) continue;
      // Panicle: a rachis out of the top that bows over more as the grain fills.
      const tip = path[seg], axis = V.norm(V.sub(path[seg], path[seg - 1]));
      const droop = p.riceDroop * (0.25 + 0.75 * phase(g, 0.65, 1));
      const len = h * p.panicleLength * head;
      const p1 = V.add(tip, V.mul(axis, len * 0.55));
      const p2 = V.add(V.add(tip, V.mul(axis, len * (1 - droop) * 0.7)), V.add(V.mul(d, len * droop * 0.9), V.mul(UP, -len * droop * 0.9)));
      const rachis = bezierPath(tip, p1, p2, 5);
      mb.tube(rachis, rachis.map(() => p.stemWidth * 0.12), 3, rachis.map(() => stemC), { capTip: false });

      const grainA = V.lerp(V.mul(green, 1.15), ripe, phase(g, 0.7, 1));
      const grainB = V.lerp(V.mul(green, 1.3), ripeTip, phase(g, 0.7, 1));
      const n = Math.max(3, p.riceGrains);
      for (let k = 0; k < n; k++) {
        const s = (k + 0.5) / n;
        const i = Math.min(4, Math.floor(s * 5));
        const at = V.lerp(rachis[i], rachis[i + 1], s * 5 - i);
        const tan = V.norm(V.sub(rachis[i + 1], rachis[i]));
        let side = V.cross(tan, UP);
        side = V.len(side) > 1e-6 ? V.norm(side) : anyPerp(tan);
        const spin = k * 2.39996;
        const outward = V.norm(V.add(V.mul(tan, 0.6), V.mul(V.rot(side, tan, spin), 0.8)));
        // Grains hang off the rachis: heavier, more downward, when ripe.
        const dir = V.norm(V.add(outward, V.mul(UP, -0.6 * droop)));
        mb.prism(at, dir, p.grainSize * head, p.grainSize * 0.28, 4, grainA, grainB, 0.4, spin);
      }
    }
  }

  G.register("RICE", {
    category: "crops", label: "Arroz",
    params: { "Arroz": [
      ["growth", "Crecimiento", "num", 1, 0, 1, 0.01],
      ["riceHeight", "Altura", "num", 0.9, 0.2, 1.6, 0.01], ["heightVariation", "Var. altura", "num", 0.15, 0, 1, 0.01],
      ["riceTillers", "Tallos por mata", "int", 5, 2, 14, 1], ["stemWidth", "Ancho tallo", "num", 0.03, 0.005, 0.1, 0.001],
      ["riceLeaves", "Hojas por tallo", "int", 2, 1, 6, 1], ["riceLeafLength", "Largo hoja", "num", 0.55, 0.1, 1, 0.01],
      ["riceLeafWidth", "Ancho hoja", "num", 0.035, 0.01, 0.2, 0.005], ["stemLeafColor", "Color hoja", "color", L(0.12, 0.45, 0.08)],
      ["panicleLength", "Largo espiga", "num", 0.35, 0.1, 0.7, 0.01], ["riceGrains", "Granos", "int", 12, 4, 40, 1],
      ["grainSize", "Tam. grano", "num", 0.045, 0.005, 0.1, 0.001],
      ["riceDroop", "Espiga inclinada", "num", 0.7, 0, 1, 0.01, "Cuánto se dobla la espiga al llenarse de grano"],
      ["ripeColor", "Grano maduro", "color", L(0.75, 0.58, 0.18)], ["ripeTipColor", "Grano punta", "color", L(0.92, 0.8, 0.4)],
    ] },
    defaults: { count: 3, distribution: "GRID", separation: 0.5, positionJitter: 0.25, segments: 4, inclination: 4, inclinationVariation: 10,
      leanMode: "RADIAL", leanSpread: 30, baseColor: L(0.15, 0.4, 0.08), tipColor: L(0.3, 0.6, 0.15) },
    growth: true,
  }, genRice, [
    { key: "WHITE", label: "Arroz blanco", values: { ripeColor: L(0.75, 0.58, 0.18), ripeTipColor: L(0.92, 0.8, 0.4) } },
    { key: "RED", label: "Arroz rojo", values: { ripeColor: L(0.45, 0.12, 0.06), ripeTipColor: L(0.7, 0.3, 0.12) } },
    { key: "BLACK", label: "Arroz negro", values: { ripeColor: L(0.08, 0.04, 0.06), ripeTipColor: L(0.25, 0.12, 0.2), stemLeafColor: L(0.1, 0.3, 0.08) } },
    { key: "PADDY", label: "En arrozal (con agua)", values: { waterMode: "EMERGENT", waterDepth: 0.25, emergeHeight: 0.6 } },
  ]);
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
