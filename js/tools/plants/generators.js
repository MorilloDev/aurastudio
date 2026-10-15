"use strict";

// Plant generators for the Plantas tool: grass, flowers (eight heads), wheat, carrot, potato, corn and pumpkin / melon,
// ported from the Stylized Foliage Generator add-on (v18) with the same parameters and defaults. Also the option
// schema the panel is built from. No DOM: runs in the page and under Node.
(function (Aura) {
  const M = Aura.plantMesh;
  const { V, UP, clamp01, lerp, smooth, rng, jitterColor, gradient, anyPerp, tangents, bezierPath, arcPath, headMatrix } = M;

  // The add-on's colours are Blender scene-linear; the panel shows sRGB hex.
  const L = (r, g, b) => M.linearToHex([r, g, b]);
  const deg = (d) => d * Math.PI / 180;

  // ── Schema ───────────────────────────────────────────────────────────────────────────────────────────────────────
  // [key, label, kind, default, min, max, step, title]. kind: "num", "int", "color", "bool", or a list of [value, label].
  const COMMON = {
    "Reparto": [
      ["count", "Cantidad", "int", 40, 1, 400, 1],
      ["distribution", "Reparto", [["GRID", "Rejilla"], ["SCATTER", "Disperso"], ["DISC", "Disco"], ["CLUSTERS", "Grupos"]], "GRID"],
      ["separation", "Separación", "num", 0.10, 0, 1, 0.005, "Rejilla: distancia entre plantas, en bloques"],
      ["positionJitter", "Desorden", "num", 0.6, 0, 1, 0.01],
      ["gridRotation", "Giro rejilla", "num", 0, -90, 90, 1],
      ["areaSize", "Tamaño área", "num", 1, 0.05, 1.5, 0.01, "Disperso / disco / grupos, en bloques"],
      ["minDistance", "Distancia mínima", "num", 0, 0, 0.5, 0.005],
      ["clusterCount", "Grupos", "int", 3, 1, 12, 1],
      ["clusterSpread", "Radio grupo", "num", 0.2, 0.02, 0.8, 0.01],
      ["sizeVariation", "Var. tamaño", "num", 0, 0, 0.8, 0.01, "Escala cada planta entera"],
      ["keepInCell", "Dentro de la celda", "bool", true, null, null, null, "Encoge el reparto para que todas nazcan dentro del rombo de la celda"],
      ["cellMargin", "Margen celda", "num", 0.06, 0, 0.3, 0.01],
      ["seed", "Semilla", "int", 1, 1, 9999, 1],
    ],
    "Forma": [
      ["inclination", "Inclinación", "num", 10, 0, 90, 1],
      ["inclinationVariation", "Var. inclinación", "num", 12, 0, 90, 1],
      ["bend", "Curvatura", "num", 0.15, 0, 2, 0.01],
      ["leanMode", "Dirección", [["RADIAL", "Radial"], ["FAN", "Abanico"], ["WIND", "Viento"], ["RANDOM", "Aleatoria"]], "RADIAL"],
      ["leanSpread", "Disp. dirección", "num", 20, 0, 180, 1],
      ["windAngle", "Ángulo viento", "num", 0, -180, 180, 1],
      ["segments", "Segmentos", "int", 4, 2, 12, 1],
      ["tubeSides", "Lados tubo", "int", 5, 3, 10, 1],
      ["groundZ", "Altura del suelo", "num", 0, -0.5, 1, 0.01, "Dónde nace la planta, en bloques desde abajo de la celda"],
      ["scale", "Escala", "num", 1, 0.2, 2, 0.01],
      ["fitSprite", "Ajustar al sprite", "bool", true, null, null, null, "Encoge todo lo justo para que nada se salga del sprite"],
    ],
    "Colores": [
      ["baseColor", "Color base", "color", L(0.12, 0.35, 0.08)],
      ["tipColor", "Color punta", "color", L(0.55, 0.85, 0.25)],
      ["colorVariation", "Var. color", "num", 0.15, 0, 1, 0.01],
      ["dryColor", "Color seco", "color", L(0.55, 0.42, 0.18)],
    ],
    "Vida y detalles": [
      ["wilt", "Marchitez", "num", 0, 0, 1.5, 0.01, "Todo se dobla hacia el suelo"],
      ["tipDry", "Puntas secas", "num", 0, 0, 1, 0.01],
      ["tipDryLength", "Largo seco", "num", 0.3, 0.05, 1, 0.01],
      ["dryLeafChance", "Hojas muertas", "num", 0, 0, 1, 0.01],
      ["leafTwist", "Giro hojas", "num", 15, 0, 180, 1],
      ["leafRuffle", "Borde ondulado", "num", 0, 0, 1, 0.01],
      ["ruffleWaves", "Nº ondas", "num", 2, 0.5, 8, 0.1],
      ["biteChance", "Mordidas", "num", 0, 0, 1, 0.01],
      ["veinStrength", "Nervio central", "num", 0, -0.6, 0.6, 0.01],
      ["edgeDarken", "Bordes oscuros", "num", 0, 0, 0.6, 0.01],
      ["petalRuffle", "Pétalo ondulado", "num", 0, 0, 1, 0.01],
      ["petalVein", "Vena pétalo", "num", 0, -0.6, 0.6, 0.01],
      ["leafSegments", "Segmentos hoja", "int", 5, 2, 12, 1],
    ],
    "Textura procedural": [
      ["mottle", "Moteado", "num", 0, 0, 1, 0.01],
      ["speckle", "Puntitos", "num", 0, 0, 1, 0.01],
      ["patch", "Manchas", "num", 0, 0, 1, 0.01],
      ["patchColor", "Color manchas", "color", L(0.45, 0.4, 0.15)],
      ["noiseScale", "Escala ruido", "num", 0.2, 0.02, 2, 0.01],
    ],
    "Agua": [
      ["waterMode", "Agua", [["AUTO", "Automático"], ["LAND", "Tierra (sin agua)"], ["UNDERWATER", "Sumergida"],
        ["SURFACE", "Flotando"], ["EMERGENT", "Sale del agua"]], "AUTO", null, null, null,
        "Automático: cada planta donde vive (algas sumergidas, nenúfares flotando, juncos saliendo del agua)"],
      ["waterDepth", "Profundidad", "num", 1, 0.1, 4, 0.01, "Altura de la superficie del agua sobre el suelo, en bloques (más de 1 = varias celdas)"],
      ["waterFill", "Llegar a la superficie", "bool", false, null, null, null, "Sumergidas: se estiran desde el fondo hasta justo bajo la superficie"],
      ["waterFit", "Ajustar al agua", "bool", true, null, null, null, "Sumergidas: se encogen bajo la superficie; emergentes: se estiran hasta salir"],
      ["emergeHeight", "Sale del agua", "num", 0.3, 0, 2, 0.01, "Cuánto asoma una planta emergente, en bloques"],
    ],
    "Multiparte": [
      ["multipart", "Multiparte", "bool", false, null, null, null, "Apagado: la planta cabe en un solo tile (se encoge si hace falta). Encendido: puede ocupar varios tiles de alto, cada uno un sprite aparte"],
      ["cells", "Celdas de alto", "int", 0, 0, 4, 1, "Solo con Multiparte. 0 = automático (las que necesite la planta); 2 = un maíz de dos tiles, etc. Cada celda sale como un sprite aparte"],
      ["fillCells", "Llenar las celdas", "bool", false, null, null, null, "Estira la planta hacia arriba hasta el techo de sus celdas"],
    ],
    "Base": [
      ["aoBase", "Oscurecer base", "num", 0.25, 0, 1, 0.01, "Oscurece donde la planta toca el suelo"],
      ["aoBaseHeight", "Altura oscuro", "num", 0.3, 0.01, 1.5, 0.01],
      ["minWidthPx", "Ancho mínimo (px)", "num", 1, 0, 4, 0.1, "Nada más fino que esto, para que no parpadee"],
    ],
  };

  const TYPES = {
    GRASS: {
      category: "herbs",
      label: "Hierba",
      params: {
        "Hierba": [
          ["bladeHeight", "Altura", "num", 1.0, 0.05, 1.6, 0.01],
          ["heightVariation", "Var. altura", "num", 0.45, 0, 1, 0.01],
          ["widthScale", "Ancho", "num", 0.055, 0.005, 0.2, 0.001],
          ["widthBase", "Ancho base", "num", 1, 0, 2, 0.01],
          ["widthMid", "Ancho medio", "num", 0.7, 0, 2, 0.01],
          ["widthTip", "Ancho punta", "num", 0.15, 0, 2, 0.01],
          ["bladeFlatten", "Aplanado", "num", 0.6, 0, 0.95, 0.01, "Aplasta el tubo en una hoja (sigue siendo sólida)"],
          ["brokenChance", "Rotas", "num", 0, 0, 1, 0.01],
          ["grassSeedChance", "Espigas", "num", 0, 0, 1, 0.01],
          ["grassSeedCount", "Granos por espiga", "int", 6, 2, 20, 1],
          ["grassSeedSize", "Tam. grano", "num", 0.06, 0.005, 0.3, 0.005],
          ["grassSeedColor", "Color espiga", "color", L(0.75, 0.68, 0.4)],
        ],
      },
      defaults: { count: 40, separation: 0.10, positionJitter: 0.6, segments: 4, inclination: 10, inclinationVariation: 12, bend: 0.15, leanMode: "RADIAL", leanSpread: 20 },
    },
    FLOWER: {
      category: "herbs",
      label: "Flor",
      params: {
        "Tallo": [
          ["stemHeight", "Altura tallo", "num", 0.7, 0.05, 1.5, 0.01],
          ["stemHeightVar", "Var. altura", "num", 0.25, 0, 1, 0.01],
          ["stemWidth", "Ancho tallo", "num", 0.022, 0.002, 0.15, 0.001],
          ["stemColor", "Color tallo", "color", L(0.15, 0.45, 0.1)],
          ["stemLeafCount", "Hojas en tallo", "int", 3, 0, 12, 1],
          ["stemLeafSize", "Tam. hoja", "num", 0.12, 0.01, 0.6, 0.005],
          ["stemLeafColor", "Color hoja", "color", L(0.2, 0.55, 0.15)],
          ["stemLeafTilt", "Incl. hoja", "num", 40, 0, 80, 1],
          ["stemBranches", "Ramas", "int", 1, 1, 8, 1],
          ["stemBranchAngle", "Ángulo rama", "num", 30, 0, 80, 1],
          ["stemBranchLength", "Long. rama", "num", 0.7, 0.1, 1, 0.01],
        ],
        "Flor": [
          ["headShape", "Cabeza", [["DAISY", "Margarita"], ["ROSE", "Rosa"], ["TULIP", "Tulipán"], ["SUNFLOWER", "Girasol"],
            ["LAVENDER", "Lavanda"], ["BELL", "Campanilla"], ["DANDELION", "Diente de león"], ["POPPY", "Amapola"]], "DAISY"],
          ["headFaceUp", "Mira arriba", "num", 0.5, 0, 1, 0.01, "0 = sigue la punta del tallo, 1 = mira al cielo"],
          ["petalCount", "Nº pétalos", "int", 6, 3, 24, 1],
          ["petalLayers", "Capas", "int", 2, 1, 6, 1],
          ["petalLength", "Largo pétalo", "num", 0.2, 0.02, 0.6, 0.005],
          ["petalWidth", "Ancho pétalo", "num", 0.06, 0.005, 0.3, 0.001],
          ["petalTilt", "Inclinación", "num", 20, -30, 89, 1],
          ["petalCurl", "Rizo", "num", 0.25, -2, 2, 0.01],
          ["petalSegments", "Segmentos", "int", 4, 3, 10, 1],
          ["roseSpiral", "Espiral rosa", "num", 30, 0, 180, 1],
          ["petalColor", "Pétalo base", "color", L(0.9, 0.4, 0.6)],
          ["petalTipColor", "Pétalo punta", "color", L(1.0, 0.7, 0.85)],
          ["showCenter", "Mostrar centro", "bool", true],
          ["centerSize", "Tamaño centro", "num", 0.025, 0.002, 0.2, 0.001],
          ["centerColor", "Color centro", "color", L(1.0, 0.85, 0.2)],
        ],
      },
      defaults: { count: 6, separation: 0.6, positionJitter: 0.5, segments: 4, tubeSides: 5, inclination: 3, inclinationVariation: 6, bend: 0.15 },
    },
    WHEAT: {
      category: "crops",
      label: "Trigo",
      params: {
        "Trigo": [
          ["growth", "Crecimiento", "num", 1, 0, 1, 0.01],
          ["bladeHeight", "Altura", "num", 1.2, 0.1, 1.6, 0.01],
          ["heightVariation", "Var. altura", "num", 0.3, 0, 1, 0.01],
          ["stemWidth", "Ancho tallo", "num", 0.05, 0.005, 0.2, 0.001],
          ["stemNodes", "Nudos", "int", 0, 0, 8, 1],
          ["stemNodeDark", "Oscuridad nudos", "num", 0.25, 0, 0.8, 0.01],
          ["stemLeafCount", "Hojas", "int", 3, 0, 8, 1],
          ["stemLeafSize", "Tam. hoja", "num", 0.45, 0.05, 1, 0.01],
          ["stemLeafColor", "Color hoja", "color", L(0.2, 0.55, 0.15)],
          ["headRatio", "Ratio espiga", "num", 0.3, 0.05, 0.8, 0.01],
          ["grainCount", "Nº granos", "int", 12, 4, 40, 1],
          ["grainSize", "Tam. grano", "num", 0.06, 0.005, 0.3, 0.005],
          ["awns", "Barbas", "num", 0.25, 0, 1.5, 0.01],
          ["ripeColor", "Grano base", "color", L(0.85, 0.7, 0.25)],
          ["ripeTipColor", "Grano punta", "color", L(0.95, 0.85, 0.45)],
        ],
      },
      defaults: { count: 30, separation: 0.18, positionJitter: 0.4, segments: 4, tubeSides: 4, inclination: 6, inclinationVariation: 8, bend: 0.2, baseColor: L(0.25, 0.5, 0.12) },
      growth: true,
    },
    CARROT: {
      category: "crops",
      label: "Zanahoria",
      params: {
        "Zanahoria": [
          ["growth", "Crecimiento", "num", 1, 0, 1, 0.01],
          ["cropMode", "Forma", [["PLANTED", "Plantada"], ["ITEM", "Suelta (objeto)"]], "PLANTED"],
          ["rootLength", "Largo raíz", "num", 0.5, 0.05, 1.2, 0.01],
          ["rootVar", "Var. raíz", "num", 0.3, 0, 1, 0.01],
          ["rootWidth", "Ancho raíz", "num", 0.1, 0.01, 0.4, 0.005],
          ["rootVisible", "Parte visible", "num", 0.2, 0, 1, 0.01, "Plantada: cuánto asoma la raíz"],
          ["rootColor", "Raíz base", "color", L(0.95, 0.45, 0.1)],
          ["rootTipColor", "Raíz punta", "color", L(0.75, 0.25, 0.05)],
          ["leafCount", "Hojas", "int", 6, 3, 15, 1],
          ["leafSize", "Tam. hoja", "num", 0.35, 0.05, 1, 0.01],
          ["pinnae", "Foliolos", "int", 4, 0, 12, 1],
          ["leafColor", "Color hoja", "color", L(0.15, 0.55, 0.1)],
        ],
      },
      defaults: { count: 8, separation: 0.4, positionJitter: 0.5, segments: 6, tubeSides: 6 },
      growth: true,
    },
    POTATO: {
      category: "crops",
      label: "Patata",
      params: {
        "Patata": [
          ["growth", "Crecimiento", "num", 1, 0, 1, 0.01],
          ["cropMode", "Forma", [["PLANTED", "Plantada"], ["ITEM", "Suelta (objeto)"]], "ITEM"],
          ["potatoSize", "Tamaño", "num", 0.15, 0.02, 0.5, 0.005],
          ["potatoVar", "Var. tamaño", "num", 0.3, 0, 1, 0.01],
          ["potatoNoise", "Bultos", "num", 0.3, 0, 1, 0.01],
          ["potatoFlatten", "Aplanado", "num", 0.7, 0.1, 1, 0.01],
          ["potatoColor", "Color base", "color", L(0.75, 0.6, 0.35)],
          ["potatoTipColor", "Color punta", "color", L(0.6, 0.45, 0.25)],
          ["potatoStems", "Tallos", "int", 5, 3, 12, 1],
          ["stemHeight", "Altura planta", "num", 0.35, 0.05, 1, 0.01],
          ["stemWidth", "Ancho tallo", "num", 0.03, 0.005, 0.1, 0.001],
          ["stemLeafSize", "Tam. hoja", "num", 0.12, 0.02, 0.4, 0.005],
          ["stemLeafColor", "Color hoja", "color", L(0.2, 0.55, 0.15)],
          ["potatoFlowers", "Flores al madurar", "bool", true],
          ["petalColor", "Color flor", "color", L(0.9, 0.85, 0.95)],
        ],
      },
      defaults: { count: 10, separation: 0.35, positionJitter: 0.7 },
      growth: true,
    },
    CORN: {
      category: "crops",
      label: "Maíz",
      params: {
        "Maíz": [
          ["growth", "Crecimiento", "num", 0.8, 0, 1, 0.01],
          ["cornHeight", "Altura", "num", 1.4, 0.2, 1.6, 0.01],
          ["heightVariation", "Var. altura", "num", 0.1, 0, 1, 0.01],
          ["cornRadius", "Grosor", "num", 0.03, 0.005, 0.1, 0.001],
          ["stemNodes", "Nudos", "int", 5, 0, 10, 1],
          ["stemNodeDark", "Oscuridad nudos", "num", 0.25, 0, 0.8, 0.01],
          ["cornLeaves", "Hojas", "int", 8, 2, 16, 1],
          ["cornEars", "Mazorcas", "int", 1, 0, 3, 1],
          ["cobColor", "Color mazorca", "color", L(0.95, 0.75, 0.15)],
          ["tasselColor", "Color penacho", "color", L(0.8, 0.65, 0.3)],
        ],
      },
      defaults: { count: 4, separation: 0.45, positionJitter: 0.3, tubeSides: 5, baseColor: L(0.22, 0.48, 0.15), tipColor: L(0.35, 0.62, 0.22), multipart: true, cells: 2, fillCells: true },
      growth: true,
    },
    PUMPKIN: {
      category: "crops",
      label: "Calabaza / sandía",
      params: {
        "Fruto": [
          ["growth", "Crecimiento", "num", 1, 0, 1, 0.01],
          ["pumpkinStyle", "Fruto", [["PUMPKIN", "Calabaza"], ["MELON", "Sandía / melón"]], "PUMPKIN"],
          ["fruitSize", "Tamaño", "num", 0.3, 0.05, 0.5, 0.005],
          ["fruitRibs", "Gajos / rayas", "int", 8, 3, 16, 1],
          ["fruitRibDepth", "Profundidad gajos", "num", 0.12, 0, 0.4, 0.01],
          ["fruitColor", "Color maduro", "color", L(0.95, 0.45, 0.05)],
          ["fruitGreenColor", "Color verde", "color", L(0.25, 0.45, 0.12)],
          ["fruitStripeColor", "Color rayas", "color", L(0.08, 0.25, 0.06)],
          ["pumpkinLeaves", "Hojas", "int", 4, 0, 10, 1],
          ["pumpkinLeafSize", "Tam. hoja", "num", 0.3, 0.05, 0.7, 0.01],
          ["stemWidth", "Ancho tallo", "num", 0.04, 0.005, 0.1, 0.001],
          ["stemLeafColor", "Color hoja", "color", L(0.2, 0.5, 0.15)],
        ],
      },
      defaults: { count: 1 },
      growth: true,
    },
  };

  /** All options of a type with their defaults: common, then the type's own, then its overrides. */
  function defaults(type) {
    const t = TYPES[type] ?? TYPES.GRASS;
    const out = {};
    for (const group of [COMMON, t.params]) {
      for (const list of Object.values(group)) for (const [key, , , def] of list) out[key] = def;
    }
    return { ...out, ...t.defaults };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const vary = (r, value, v) => value * (1 + r.uniform(-v, v));

  function positions(p, r) {
    const n = p.count, mode = p.distribution, sep = p.separation;
    const out = [];
    if (mode === "GRID" || n <= 1) {
      if (n <= 1) return [[0, 0, 0]];
      const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
      const ox = -(cols - 1) * sep * 0.5, oy = -(rows - 1) * sep * 0.5;
      const a = deg(p.gridRotation), c = Math.cos(a), s = Math.sin(a);
      for (let i = 0; i < n; i++) {
        let x = ox + (i % cols) * sep, y = oy + Math.floor(i / cols) * sep;
        x += r.uniform(-p.positionJitter, p.positionJitter) * sep * 0.5;
        y += r.uniform(-p.positionJitter, p.positionJitter) * sep * 0.5;
        out.push([x * c - y * s, x * s + y * c, 0]);
      }
      return out;
    }
    const area = p.areaSize * 0.5;
    const centres = Array.from({ length: Math.max(1, p.clusterCount) }, () => [r.uniform(-area, area) * 0.7, r.uniform(-area, area) * 0.7, 0]);
    const sample = () => {
      if (mode === "DISC") {
        const a = r.uniform(0, 2 * Math.PI), rr = area * Math.sqrt(r.random());
        return [Math.cos(a) * rr, Math.sin(a) * rr, 0];
      }
      if (mode === "CLUSTERS") {
        const c = r.choice(centres), a = r.uniform(0, 2 * Math.PI), rr = p.clusterSpread * Math.sqrt(r.random());
        return [c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr, 0];
      }
      return [r.uniform(-area, area), r.uniform(-area, area), 0];
    };
    for (let i = 0; i < n; i++) {
      let best = sample();
      if (p.minDistance > 0) {
        for (let t = 0; t < 24 && !out.every((o) => V.len(V.sub(best, o)) >= p.minDistance); t++) best = sample();
      }
      out.push(best);
    }
    return out;
  }

  /** Shrinks the layout toward the cell's centre until every plant stands inside the cell (minus the margin): plants
   *  rooted outside their cell would float over the neighbouring tile in the game. */
  function keepInCell(pts, p) {
    if (!p.keepInCell || !pts.length) return pts;
    const limit = Math.max(0.01, 0.5 - p.cellMargin);
    const reach = Math.max(...pts.map((q) => Math.max(Math.abs(q[0]), Math.abs(q[1]))));
    if (reach <= limit) return pts;
    const k = limit / reach;
    return pts.map((q) => [q[0] * k, q[1] * k, q[2]]);
  }

  function leanDirection(p, r, pos) {
    const spread = deg(p.leanSpread);
    let a;
    if (p.leanMode === "RADIAL") a = (V.len(pos) > 1e-6 ? Math.atan2(pos[1], pos[0]) : r.uniform(0, 2 * Math.PI)) + r.uniform(-spread, spread);
    else if (p.leanMode === "FAN") a = r.choice([0, Math.PI]) + r.uniform(-spread, spread);
    else if (p.leanMode === "WIND") a = deg(p.windAngle) + r.uniform(-spread, spread);
    else a = r.uniform(0, 2 * Math.PI);
    return [Math.cos(a), Math.sin(a), 0];
  }

  const growthColor = (p, green, ripe, threshold = 0.7) => V.lerp(green, ripe, smooth((p.growth - threshold) / (1 - threshold)));

  // ── Grass ────────────────────────────────────────────────────────────────────────────────────────────────────────

  function widthProfile(t, p) {
    const w = t <= 0.5 ? lerp(p.widthBase, p.widthMid, t / 0.5) : lerp(p.widthMid, p.widthTip, (t - 0.5) / 0.5);
    return w * p.widthScale;
  }

  /** A broken blade: from a random point on, it bends over a little more at every segment, like a stepped-on stem. */
  function kink(path, r, p) {
    if (p.brokenChance <= 0 || r.random() >= p.brokenChance || path.length < 3) return path;
    const fine = [];
    for (let i = 0; i < path.length - 1; i++) for (let f = 0; f < 3; f++) fine.push(V.lerp(path[i], path[i + 1], f / 3));
    fine.push(path[path.length - 1]);
    const k = r.int(Math.floor(fine.length / 4), fine.length - 3);
    const total = r.uniform(0.6, 1.3), steps = fine.length - 1 - k;
    const out = fine.slice(0, k + 1);
    for (let j = k; j < fine.length - 1; j++) {
      const seg = V.sub(fine[j + 1], fine[j]);
      let axis = V.cross(seg, UP);
      axis = V.len(axis) > 1e-6 ? V.norm(axis) : anyPerp(seg);
      out.push(V.add(out[out.length - 1], V.rot(seg, axis, total * (j - k + 1) / steps)));
    }
    return out;
  }

  function seedHead(mb, p, path, stemColor) {
    const tip = path[path.length - 1], axis = V.norm(V.sub(tip, path[path.length - 2]));
    const sc = p.grassSeedColorL;
    const length = V.len(V.sub(tip, path[0])) * 0.25;
    for (let g = 0; g < p.grassSeedCount; g++) {
      const t = g / Math.max(1, p.grassSeedCount - 1);
      const at = V.sub(tip, V.mul(axis, length * (1 - t)));
      const side = V.rot(anyPerp(axis), axis, g * 2.39996);
      const out = V.norm(V.add(V.mul(axis, 0.8), V.mul(side, 0.6)));
      const size = p.grassSeedSize * (0.6 + 0.4 * t);
      mb.prism(at, out, size, size * 0.25, 4, V.mul(sc, 0.85), sc, 0.5, g);
    }
  }

  function genGrass(mb, p, r, pos) {
    const h = Math.max(0.01, vary(r, p.bladeHeight, p.heightVariation));
    const lean = clamp01((p.inclination + r.uniform(-p.inclinationVariation, p.inclinationVariation)) / 90) * 90;
    const d = leanDirection(p, r, pos);
    const cb = jitterColor(r, p.baseColorL, p.colorVariation), ct = jitterColor(r, p.tipColorL, p.colorVariation);
    const seg = Math.max(2, p.segments);
    const path = kink(arcPath(pos, d, h, lean, p.bend + p.wilt, seg), r, p);
    const last = path.length - 1;
    const widths = path.map((_, i) => widthProfile(i / last, p) * 0.5);
    const cols = mb.leafColors(gradient(cb, ct, last + 1));
    const side = V.norm(V.cross(UP, d));
    const twist = deg(p.leafTwist) * mb.rng.uniform(-1, 1);
    mb.tube(path, widths, p.tubeSides, cols, { firstNormal: side, flatten: p.bladeFlatten, twist });
    if (r.random() < p.grassSeedChance) seedHead(mb, p, path, ct);
  }

  // ── Flowers ──────────────────────────────────────────────────────────────────────────────────────────────────────

  function petalProfile(t) {
    if (t < 0.2) return 0.35 + 0.65 * (t / 0.2);
    if (t < 0.65) return 1;
    return Math.max(0, 1 - (t - 0.65) / 0.35 * 0.85);
  }

  /** One petal in head space; tilt raises it from flat, curl bends the tip, inward pulls the tip back (tulip cups). */
  function petal(mb, p, Mh, tip, radial, length, width, tiltDeg, curl, cb, ct, inward = 0) {
    const seg = Math.max(3, p.petalSegments);
    const tilt = deg(tiltDeg);
    const out = V.norm([radial[0], radial[1], 0]);
    const dir = V.add(V.mul(out, Math.cos(tilt)), [0, 0, Math.sin(tilt)]);
    const pts = [];
    for (let s = 0; s <= seg; s++) {
      const t = s / seg;
      let q = V.mul(dir, length * t);
      q = V.add(q, [0, 0, curl * length * t * t]);
      q = V.sub(q, V.mul(out, inward * length * t * t));
      pts.push(V.add(tip, Mh(q)));
    }
    const widths = pts.map((_, s) => width * petalProfile(s / seg));
    const side = Mh([-out[1], out[0], 0]);
    mb.ribbon(pts, widths, side, gradient(cb, ct, seg + 1), { fold: -0.15, details: "PETAL" });
  }

  function flowerCenter(mb, p, r, tip, Mh, radius, stemCol, heightOff = 0) {
    const centre = V.add(tip, Mh([0, 0, heightOff]));
    const cc = p.centerColorL;
    const zmin = centre[2] - radius, zmax = centre[2] + radius;
    mb.blob(centre, radius, (q) => V.lerp(stemCol, cc, smooth(((q[2] - zmin) / (zmax - zmin) - 0.4) / 0.2)), r, { subdiv: 1, squash: [1, 1, 0.7] });
  }

  function flowerHead(mb, p, r, tip, axis, stemCol, ci, co) {
    const Mh = headMatrix(axis);
    const pn = p.petalCount, ly = p.petalLayers, Lp = p.petalLength, W = p.petalWidth;
    const kind = p.headShape;
    const radialAt = (a) => [Math.cos(a), Math.sin(a), 0];
    if (kind === "DAISY") {
      for (let layer = 0; layer < ly; layer++) {
        const tl = ly > 1 ? layer / (ly - 1) : 1;
        const ro = Math.PI / Math.max(1, pn) * layer;
        const cin = V.mul(V.lerp(ci, co, tl * 0.5), 0.85), cout = V.lerp(ci, co, tl);
        for (let i = 0; i < pn; i++) {
          const radial = radialAt(2 * Math.PI * i / pn + ro + r.uniform(-0.1, 0.1));
          petal(mb, p, Mh, V.add(tip, Mh(V.mul(radial, Lp * 0.08 * (1 + tl)))), radial, Lp * (0.65 + 0.35 * tl), W,
            p.petalTilt + 25 * (1 - tl), p.petalCurl, cin, cout);
        }
      }
      if (p.showCenter) flowerCenter(mb, p, r, tip, Mh, p.centerSize, stemCol, Lp * 0.05);
    } else if (kind === "ROSE") {
      const spir = deg(p.roseSpiral);
      for (let layer = 0; layer < ly; layer++) {
        const tl = ly > 1 ? layer / (ly - 1) : 1;
        for (let i = 0; i < pn; i++) {
          const radial = radialAt(2 * Math.PI * i / pn + spir * layer + r.uniform(-0.05, 0.05));
          petal(mb, p, Mh, V.add(tip, Mh(V.mul(radial, Lp * (0.03 + 0.25 * tl)))), radial, Lp * (0.45 + 0.55 * tl), W * (0.7 + 0.5 * tl),
            lerp(80, p.petalTilt, tl), p.petalCurl * (1.6 - 1.4 * tl), V.mul(V.lerp(ci, co, tl), 0.85), V.lerp(ci, co, tl), 0.25 * (1 - tl));
        }
      }
      if (p.showCenter) flowerCenter(mb, p, r, tip, Mh, p.centerSize, stemCol, Lp * 0.2);
    } else if (kind === "TULIP") {
      for (let layer = 0; layer < Math.min(2, ly); layer++) {
        for (let i = 0; i < pn; i++) {
          const radial = radialAt(2 * Math.PI * i / pn + layer * Math.PI / pn);
          petal(mb, p, Mh, V.add(tip, Mh(V.mul(radial, W * 0.3))), radial, Lp * (1 - 0.1 * layer), W * 1.4, 72, 0.15, V.mul(ci, 0.9), co, 0.35);
        }
      }
    } else if (kind === "SUNFLOWER") {
      const discR = Lp * 0.55;
      for (let layer = 0; layer < Math.max(1, ly); layer++) {
        for (let i = 0; i < pn * 2; i++) {
          const radial = radialAt(2 * Math.PI * i / (pn * 2) + layer * Math.PI / (pn * 2));
          petal(mb, p, Mh, V.add(tip, Mh(V.mul(radial, discR * 0.9))), radial, Lp * 0.8, W, p.petalTilt * 0.3, p.petalCurl * 0.5, ci, co);
        }
      }
      const cc = p.centerColorL, dark = V.mul(cc, 0.55);
      const centre = V.add(tip, Mh([0, 0, Lp * 0.04]));
      mb.blob(centre, discR, (q) => V.lerp(cc, dark, clamp01(V.len(V.sub(q, centre)) / discR)), r, { subdiv: 2, squash: [1, 1, 0.25], orient: Mh });
    } else if (kind === "LAVENDER") {
      const spike = Lp * 3, whorls = Math.max(4, pn);
      for (let w = 0; w < whorls; w++) {
        const t = w / Math.max(1, whorls - 1);
        const z = spike * (0.15 + 0.85 * t), rad = W * 0.9 * (1 - 0.6 * t);
        for (let k = 0; k < 4; k++) {
          const a = 2 * Math.PI * k / 4 + w * 0.8;
          const c = V.lerp(ci, co, t);
          mb.blob(V.add(tip, Mh([Math.cos(a) * rad, Math.sin(a) * rad, z])), W * (0.75 - 0.35 * t), () => c, r, { subdiv: 1 });
        }
      }
      const pts = [0, 1, 2, 3, 4].map((s) => V.add(tip, Mh([0, 0, spike * s / 4])));
      mb.tube(pts, pts.map(() => p.stemWidth * 0.3), 4, pts.map(() => stemCol));
    } else if (kind === "DANDELION") {
      // Seed clock: rays spread evenly over a sphere (Fibonacci), each ending in a small tuft.
      const n = Math.max(20, pn * 5), Rr = Lp * 0.9;
      const centre = V.add(tip, Mh([0, 0, Rr * 0.8]));
      const white = V.lerp(ci, [1, 1, 1], 0.7), grey = co;
      for (let k = 0; k < n; k++) {
        const z = 1 - 2 * (k + 0.5) / n;
        if (z < -0.55) continue;
        const rr = Math.sqrt(Math.max(0, 1 - z * z)), a = k * 2.39996;
        const d = Mh([Math.cos(a) * rr, Math.sin(a) * rr, z]);
        mb.ribbon([centre, V.add(centre, V.mul(d, Rr))], [W * 0.06, W * 0.03], anyPerp(d), [grey, white]);
        mb.blob(V.add(centre, V.mul(d, Rr)), W * 0.22, () => white, r, { subdiv: 1, squash: [1, 1, 0.6] });
      }
      mb.blob(centre, Rr * 0.18, () => grey, r, { subdiv: 1 });
    } else if (kind === "POPPY") {
      for (let i = 0; i < 4; i++) {
        const radial = radialAt(2 * Math.PI * i / 4 + r.uniform(-0.15, 0.15));
        petal(mb, p, Mh, V.add(tip, Mh(V.mul(radial, W * 0.2))), radial, Lp, W * 2.2, p.petalTilt + 30, p.petalCurl * 0.5, ci, co, 0.15);
      }
      if (p.showCenter) flowerCenter(mb, p, r, tip, Mh, p.centerSize * 1.3, stemCol, Lp * 0.15);
    } else if (kind === "BELL") {
      // Hangs from the stem tip: the head turns down and the bell flares toward its mouth.
      const Md = headMatrix([axis[0] * 0.3, axis[1] * 0.3, -1]);
      const seg = 4;
      const pts = [0, 1, 2, 3, 4].map((s) => V.add(tip, Md([0, 0, Lp * s / seg])));
      const widths = pts.map((_, s) => W * (0.5 + 1.2 * Math.pow(s / seg, 1.5)));
      mb.tube(pts, widths, Math.max(5, pn), gradient(V.mul(ci, 0.85), co, seg + 1), { capTip: false });
    }
  }

  function stemLeaves(mb, p, r, path, color) {
    const n = p.stemLeafCount;
    const seg = path.length - 1;
    for (let li = 0; li < n; li++) {
      const t = 0.15 + 0.6 * (li + 0.5) / n;
      const idx = Math.min(seg, Math.floor(t * seg));
      const a = li * 2.4 + r.uniform(-0.3, 0.3);
      const size = p.stemLeafSize * r.uniform(0.85, 1.15);
      mb.leaf(path[idx], [Math.cos(a), Math.sin(a), 0], size, size * 0.32, [V.mul(color, 0.85), color],
        { lift: Math.sin(deg(p.stemLeafTilt)) * 0.6, droop: 0.25, fold: 0.4, shape: "LANCE" });
    }
  }

  function genFlower(mb, p, r, pos) {
    const cv = p.colorVariation;
    const sb = jitterColor(r, p.baseColorL, cv), st = jitterColor(r, p.stemColorL, cv);
    const leafC = jitterColor(r, p.stemLeafColorL, cv);
    const ci = jitterColor(r, p.petalColorL, cv), co = jitterColor(r, p.petalTipColorL, cv);
    for (let b = 0; b < p.stemBranches; b++) {
      let lengthMul = 1, offset = [0, 0, 0], lean = 0, d;
      if (b === 0) {
        const a0 = r.uniform(0, 2 * Math.PI);
        d = [Math.cos(a0), Math.sin(a0), 0];
      } else {
        const a = 2 * Math.PI * b / p.stemBranches + r.uniform(-0.4, 0.4);
        d = [Math.cos(a), Math.sin(a), 0];
        lengthMul = p.stemBranchLength; offset = V.mul(d, p.stemWidth); lean = p.stemBranchAngle;
      }
      const sh = Math.max(0.05, vary(r, p.stemHeight * lengthMul, p.stemHeightVar));
      lean += p.inclination + r.uniform(-p.inclinationVariation, p.inclinationVariation);
      const seg = Math.max(3, p.segments);
      const path = arcPath(V.add(pos, offset), d, sh, Math.max(0, lean), p.bend + p.wilt * 0.5, seg);
      mb.tube(path, path.map((_, i) => p.stemWidth * 0.5 * (1 - 0.4 * i / seg)), p.tubeSides, gradient(sb, st, seg + 1));
      stemLeaves(mb, p, r, path, leafC);
      const tipDir = V.norm(V.sub(path[seg], path[seg - 1]));
      let axis = V.lerp(tipDir, UP, clamp01(p.headFaceUp));
      axis = V.len(axis) > 1e-6 ? V.norm(axis) : UP;
      flowerHead(mb, p, r, path[seg], axis, st, ci, co);
    }
  }

  // ── Crops ────────────────────────────────────────────────────────────────────────────────────────────────────────

  function nodeColors(p, colors) {
    const n = p.stemNodes;
    if (n <= 0 || colors.length < 3) return colors;
    const out = colors.slice(), step = (colors.length - 1) / (n + 1);
    for (let k = 1; k <= n; k++) {
      const i = Math.round(k * step);
      out[i] = V.mul(out[i], 1 - p.stemNodeDark);
    }
    return out;
  }

  function genWheat(mb, p, r, pos) {
    const g = p.growth;
    const h = Math.max(0.05, vary(r, p.bladeHeight, p.heightVariation)) * (0.25 + 0.75 * g);
    const d = leanDirection(p, r, pos);
    const lean = p.inclination + r.uniform(-p.inclinationVariation, p.inclinationVariation);
    const cv = p.colorVariation;
    const green = jitterColor(r, p.baseColorL, cv);
    const ripeA = jitterColor(r, p.ripeColorL, cv), ripeB = jitterColor(r, p.ripeTipColorL, cv);
    const stemTop = growthColor(p, green, V.mul(ripeA, 0.8));
    const headFrac = g >= 0.35 ? p.headRatio : 0;
    const path = arcPath(pos, d, h, lean, p.bend + p.wilt * 0.5, Math.max(Math.max(3, p.segments), p.stemNodes * 2));
    const n = path.length;
    mb.tube(path, path.map((_, i) => p.stemWidth * 0.25 * (1 - 0.3 * i / (n - 1))), Math.max(3, p.tubeSides),
      nodeColors(p, gradient(green, stemTop, n)));
    const seg = n - 1;
    for (let li = 0; li < p.stemLeafCount; li++) {
      const idx = Math.min(seg, 1 + li % Math.max(1, seg - 1));
      const a = li * 2.6 + r.uniform(-0.4, 0.4);
      const size = p.stemLeafSize * (0.5 + 0.5 * g) * r.uniform(0.8, 1.2);
      const lc = growthColor(p, p.stemLeafColorL, V.mul(ripeA, 0.75));
      mb.leaf(path[idx], [Math.cos(a), Math.sin(a), 0], size, size * 0.09, [V.mul(lc, 0.85), lc], { lift: 0.55, droop: 0.6, fold: 0.5, shape: "BLADE" });
    }
    if (headFrac <= 0) return;
    const grow = clamp01((g - 0.35) / 0.65);
    const tip = path[seg], axis = V.norm(V.sub(path[seg], path[seg - 1]));
    const hh = h * headFrac * (0.4 + 0.6 * grow);
    const count = Math.max(4, p.grainCount);
    const gl = p.grainSize * (0.5 + 0.5 * grow);
    const ga = growthColor(p, V.mul(green, 1.1), ripeA), gb = growthColor(p, V.mul(green, 1.25), ripeB);
    for (let gi = 0; gi < count; gi++) {
      const t = gi / Math.max(1, count - 1);
      const at = V.add(tip, V.mul(axis, hh * t));
      const spin = gi * 2.39996;
      const side = V.rot(anyPerp(axis), axis, spin);
      const out = V.norm(V.add(axis, V.mul(side, 0.55)));
      mb.prism(at, out, gl * (1 - 0.3 * t), gl * 0.22, 4, ga, gb, 0.45, spin);
      if (p.awns > 0) {
        const a0 = V.add(at, V.mul(out, gl));
        mb.ribbon([a0, V.add(a0, V.mul(V.norm(V.add(out, axis)), p.awns * hh))], [gl * 0.03, 0], side, [gb, gb]);
      }
    }
  }

  /** Compound leaf (carrot top): a thin rachis with paired leaflets shrinking toward the tip. */
  function featherLeaf(mb, p, base, d, length, color, pinnae, lift = 0.8) {
    const seg = 5;
    d = V.norm([d[0], d[1], 0]);
    const p1 = V.add(V.add(base, V.mul(d, length * 0.35)), V.mul(UP, length * lift * 0.8));
    const p2 = V.add(V.add(base, V.mul(d, length)), V.mul(UP, length * (lift - 0.35)));
    const path = bezierPath(base, p1, p2, seg);
    mb.tube(path, path.map(() => length * 0.012), 3, gradient(V.mul(color, 0.8), color, seg + 1), { capTip: false });
    const tans = tangents(path);
    for (let k = 0; k < pinnae; k++) {
      const t = (k + 1) / (pinnae + 1);
      const i = Math.min(seg, Math.floor(t * seg));
      const at = V.lerp(path[i], path[Math.min(seg, i + 1)], t * seg - i);
      const tan = tans[i];
      let side = V.cross(tan, UP);
      side = V.len(side) > 1e-6 ? V.norm(side) : anyPerp(tan);
      const size = length * 0.28 * (1 - 0.7 * t);
      for (const sgn of [-1, 1]) {
        mb.leaf(at, V.norm(V.add(V.mul(side, sgn), V.mul(tan, 0.6))), size, size * 0.35, [V.mul(color, 0.9), V.mul(color, 1.05)],
          { lift: 0.15, droop: 0.25, fold: 0.3, shape: "LANCE", segments: 3 });
      }
    }
  }

  function genCarrot(mb, p, r, pos) {
    const g = p.growth, cv = p.colorVariation;
    const rb = jitterColor(r, p.rootColorL, cv), rt = jitterColor(r, p.rootTipColorL, cv), lc = jitterColor(r, p.leafColorL, cv);
    const rl = Math.max(0.05, vary(r, p.rootLength, p.rootVar)) * (0.3 + 0.7 * g);
    const rw = p.rootWidth * (0.35 + 0.65 * g);
    const seg = Math.max(6, p.segments);
    const planted = p.cropMode === "PLANTED";
    // Planted: only the shoulder shows above the soil (a buried root would still show: the sprite has no ground).
    const shown = planted ? p.rootVisible : 1;
    const top = V.add(pos, V.mul(UP, rl * shown));
    const lean = [r.uniform(-0.1, 0.1), r.uniform(-0.1, 0.1), 0];
    const path = [];
    for (let i = 0; i <= seg; i++) path.push(V.sub(top, V.mul(V.add(UP, lean), rl * shown * (i / seg))));
    const widths = path.map((_, i) => rw * 0.5 * Math.max(0.02, Math.pow(1 - shown * i / seg, 1.2)));
    const bands = path.map((_, i) => V.lerp(rb, rt, ((shown * i * 4 / seg) % 1) * 0.6 + 0.4 * shown * i / seg));
    mb.tube(path, widths, Math.max(6, p.tubeSides), bands, { capTip: planted, capBase: true });
    const n = Math.max(3, p.leafCount), length = p.leafSize * (0.3 + 0.7 * g);
    for (let li = 0; li < n; li++) {
      const a = 2 * Math.PI * li / n + r.uniform(-0.3, 0.3);
      featherLeaf(mb, p, top, [Math.cos(a), Math.sin(a), 0], length * r.uniform(0.8, 1.2), lc, p.pinnae);
    }
  }

  function genPotato(mb, p, r, pos) {
    const g = p.growth, cv = p.colorVariation;
    if (p.cropMode === "ITEM") {
      const sz = Math.max(0.01, vary(r, p.potatoSize, p.potatoVar));
      const centre = V.add(pos, V.mul(UP, sz * p.potatoFlatten));
      const c0 = jitterColor(r, p.potatoColorL, cv), c1 = jitterColor(r, p.potatoTipColorL, cv);
      const span = Math.max(1e-6, 2 * sz * p.potatoFlatten);
      const stretch = r.uniform(1, 1.4);
      mb.blob(centre, sz, (q) => V.lerp(c0, c1, clamp01((q[2] - pos[2]) / span)), r, { subdiv: 2, noise: p.potatoNoise, squash: [stretch, 1, p.potatoFlatten] });
      return;
    }
    const lc = jitterColor(r, p.stemLeafColorL, cv);
    const stems = Math.max(3, p.potatoStems), h = p.stemHeight * (0.3 + 0.7 * g);
    for (let s = 0; s < stems; s++) {
      const a = 2 * Math.PI * s / stems + r.uniform(-0.3, 0.3);
      const d = [Math.cos(a), Math.sin(a), 0];
      const path = arcPath(pos, d, h * r.uniform(0.7, 1.1), r.uniform(20, 45), 0.5, 4);
      mb.tube(path, path.map(() => p.stemWidth * 0.3), 4, gradient(V.mul(lc, 0.7), V.mul(lc, 0.9), 5));
      for (let k = 0; k < 3; k++) {
        for (const sgn of [-1, 1]) {
          const ld = V.norm(V.add(d, V.mul([-d[1], d[0], 0], sgn * 0.9)));
          const size = p.stemLeafSize * (0.4 + 0.6 * g) * (1 - 0.2 * k);
          mb.leaf(path[1 + k], ld, size, size * 0.6, [V.mul(lc, 0.85), lc], { lift: 0.2, droop: 0.3, fold: 0.25, shape: "ROUND" });
        }
      }
      if (p.potatoFlowers && g >= 0.8) {
        const fc = p.petalColorL;
        mb.blob(V.add(path[4], [0, 0, 0.02]), p.stemWidth * 0.9, () => fc, r, { subdiv: 1 });
      }
    }
  }

  /** Stem with raised, darker rings at its nodes (corn): the joint reads even when the stem is a few pixels wide. */
  function segmentedStem(mb, p, base, d, height, leanDeg, radius, nodes, c0, c1, bend) {
    const seg = Math.max(2, nodes + 1) * 3;
    const path = arcPath(base, d, height, leanDeg, bend, seg);
    const widths = [], colors = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg, node = i % 3 === 0 && i > 0 && i < seg;
      widths.push(radius * (1 - 0.25 * t) * (node ? 1.18 : 1));
      const c = V.lerp(c0, c1, t);
      colors.push(node ? V.mul(c, 1 - p.stemNodeDark) : c);
    }
    mb.tube(path, widths, Math.max(4, p.tubeSides), colors);
    return path;
  }

  function genCorn(mb, p, r, pos) {
    const g = p.growth, cv = p.colorVariation;
    const green = jitterColor(r, p.baseColorL, cv), tipGreen = jitterColor(r, p.tipColorL, cv), dry = p.dryColorL;
    const h = Math.max(0.1, vary(r, p.cornHeight, p.heightVariation)) * (0.2 + 0.8 * g);
    const a = r.uniform(0, 2 * Math.PI), d = [Math.cos(a), Math.sin(a), 0];
    const c0 = growthColor(p, green, V.mul(dry, 0.9), 0.85), c1 = growthColor(p, tipGreen, dry, 0.85);
    const path = segmentedStem(mb, p, pos, d, h, r.uniform(0, 5), p.cornRadius * (0.5 + 0.5 * g), p.stemNodes || 5, c0, c1, 0.05 + p.wilt * 0.3);
    const leafC = growthColor(p, tipGreen, dry, 0.85);
    const count = Math.max(2, Math.floor(p.cornLeaves * (0.4 + 0.6 * g)));
    for (let k = 0; k < count; k++) {
      const t = 0.12 + 0.75 * k / count;
      const i = Math.min(path.length - 1, Math.floor(t * (path.length - 1)));
      const la = a + Math.PI * k + r.uniform(-0.4, 0.4);
      const size = h * 0.55 * (1 - 0.4 * t) * r.uniform(0.85, 1.1);
      mb.leaf(path[i], [Math.cos(la), Math.sin(la), 0], size, size * 0.09, [V.mul(leafC, 0.9), leafC], { lift: 0.5, droop: 0.5, fold: 0.5, shape: "BLADE", segments: 6 });
    }
    if (g >= 0.5) {
      const grow = clamp01((g - 0.5) / 0.4);
      const cob = p.cobColorL, husk = growthColor(p, V.mul(tipGreen, 0.95), V.mul(dry, 1.05), 0.85);
      for (let e = 0; e < p.cornEars; e++) {
        const at = path[Math.floor(path.length * (0.42 + 0.12 * e))];
        const outA = a + Math.PI * 0.5 + e * Math.PI;
        const out = V.norm(V.add(V.mul([Math.cos(outA), Math.sin(outA), 0], 0.55), UP));
        const length = h * 0.16 * (0.5 + 0.5 * grow), rad = p.cornRadius * 1.5 * (0.5 + 0.5 * grow);
        const pts = [0, 1, 2, 3, 4].map((s) => V.add(at, V.mul(out, length * s / 4)));
        mb.tube(pts, [rad * 0.6, rad, rad, rad * 0.85, rad * 0.4], 6, gradient(V.mul(cob, 0.9), cob, 5));
        for (let hk = 0; hk < 3; hk++) {
          const side = V.rot(anyPerp(out), out, hk * 2.1);
          mb.ribbon([V.add(at, V.mul(side, rad * 0.6)), V.add(V.add(at, V.mul(out, length * 0.5)), V.mul(side, rad * 1.05)),
            V.add(V.add(at, V.mul(out, length * 0.85)), V.mul(side, rad * 0.4))],
          [rad * 0.9, rad, rad * 0.2], V.cross(side, out), [V.mul(husk, 0.9), husk, V.mul(husk, 1.05)], { fold: -0.3 });
        }
      }
    }
    if (g >= 0.7) {
      const tc = p.tasselColorL;
      const top = path[path.length - 1], axis = V.norm(V.sub(top, path[path.length - 2]));
      for (let k = 0; k < 7; k++) {
        const ta = 2 * Math.PI * k / 7 + r.uniform(-0.2, 0.2);
        const out = V.norm(V.add(V.mul([Math.cos(ta), Math.sin(ta), 0], 0.7), V.mul(axis, 0.6)));
        const length = h * 0.12 * r.uniform(0.8, 1.2);
        const mid = V.add(V.add(top, V.mul(out, length * 0.5)), V.mul(UP, length * 0.15));
        const end = V.sub(V.add(top, V.mul(out, length)), V.mul(UP, length * 0.25));
        mb.tube(bezierPath(top, mid, end, 3), [0, 1, 2, 3].map(() => p.cornRadius * 0.12), 3, gradient(V.mul(tc, 0.85), tc, 4));
      }
    }
  }

  function ribbedFruit(mb, centre, radius, squash, ribs, ribDepth, colorFn) {
    const rings = 8, sides = Math.max(12, ribs * 4);
    const verts = [];
    for (let rr = 0; rr <= rings; rr++) {
      const phi = Math.PI * rr / rings;
      const z = Math.cos(phi) * radius * squash, ring = Math.sin(phi) * radius;
      verts.push(Array.from({ length: sides }, (_, k) => {
        const a = 2 * Math.PI * k / sides;
        const dip = 1 - ribDepth * (0.5 - 0.5 * Math.cos(a * ribs));
        return V.add(centre, [Math.cos(a) * ring * dip, Math.sin(a) * ring * dip, z]);
      }));
    }
    for (let rr = 0; rr < rings; rr++) {
      for (let k = 0; k < sides; k++) {
        const j = (k + 1) % sides;
        const c = colorFn(k / sides);
        mb.quad(verts[rr][k], verts[rr][j], verts[rr + 1][j], verts[rr + 1][k], c, c, c, c);
      }
    }
  }

  function genPumpkin(mb, p, r, pos) {
    const g = p.growth, cv = p.colorVariation;
    const lc = jitterColor(r, p.stemLeafColorL, cv);
    for (let k = 0; k < p.pumpkinLeaves; k++) {
      const a = 2 * Math.PI * k / Math.max(1, p.pumpkinLeaves) + r.uniform(-0.4, 0.4);
      const d = [Math.cos(a), Math.sin(a), 0];
      const size = p.pumpkinLeafSize * (0.4 + 0.6 * g) * r.uniform(0.8, 1.2);
      const stalkTop = V.add(V.add(pos, V.mul(d, size * 0.3)), V.mul(UP, size * 0.35));
      mb.tube([pos, stalkTop], [p.stemWidth * 0.25, p.stemWidth * 0.25], 3, [V.mul(lc, 0.7), V.mul(lc, 0.85)], { capTip: false });
      mb.leaf(stalkTop, d, size, size * 0.75, [V.mul(lc, 0.85), lc], { lift: 0.05, droop: 0.15, fold: 0.2, shape: "HEART" });
    }
    if (g < 0.2) return;
    const grow = clamp01((g - 0.2) / 0.8);
    const rad = Math.max(0.02, vary(r, p.fruitSize, 0.2)) * (0.25 + 0.75 * grow);
    const melon = p.pumpkinStyle === "MELON";
    const squash = melon ? 0.9 : 0.72;
    const centre = V.add(pos, [r.uniform(-0.05, 0.05), r.uniform(-0.05, 0.05), rad * squash * 0.95]);
    const body = growthColor(p, p.fruitGreenColorL, jitterColor(r, p.fruitColorL, cv), 0.6);
    const stripe = p.fruitStripeColorL;
    const color = (u) => {
      if (melon) {
        const band = 0.5 + 0.5 * Math.cos(u * 2 * Math.PI * p.fruitRibs * 2);
        return band > 0.7 ? stripe : body;
      }
      return V.mul(body, 0.82 + 0.18 * (0.5 + 0.5 * Math.cos(u * 2 * Math.PI * p.fruitRibs)));
    };
    ribbedFruit(mb, centre, rad, squash, melon ? 0 : p.fruitRibs, melon ? 0 : p.fruitRibDepth, color);
    const stemC = melon ? lc : V.mul(p.dryColorL, 0.6);
    const top = V.add(centre, V.mul(UP, rad * squash * 0.9));
    mb.tube(bezierPath(top, V.add(top, V.mul(UP, rad * 0.25)), V.add(V.add(top, V.mul(UP, rad * 0.35)), [rad * 0.15, 0, 0]), 3),
      [rad * 0.12, rad * 0.1, rad * 0.09, rad * 0.08], 5, [V.mul(stemC, 0.8), stemC, stemC, stemC]);
  }

  const GENERATORS = { GRASS: genGrass, FLOWER: genFlower, WHEAT: genWheat, CARROT: genCarrot, POTATO: genPotato, CORN: genCorn, PUMPKIN: genPumpkin };

  // ── Build ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Procedural texture painted into the corner colours: mottling, speckles and patches, in world space. */
  function colorNoise(mb, p) {
    if (p.mottle <= 0 && p.speckle <= 0 && p.patch <= 0) return;
    const scale = 1 / Math.max(1e-4, p.noiseScale);
    const pc = p.patchColorL;
    const off = [p.seed * 0.137, p.seed * 0.071, 0];
    for (let i = 0; i < mb.pos.length; i += 3) {
      const q = [mb.pos[i] * scale + off[0], mb.pos[i + 1] * scale + off[1], mb.pos[i + 2] * scale];
      let m = 1 + M.noise3(q) * p.mottle;
      m *= 1 + M.noise3([q[0] * 7.3 + 5, q[1] * 7.3 + 1, q[2] * 7.3 + 3]) * p.speckle;
      const t = smooth(M.noise3([q[0] * 0.6 + 11, q[1] * 0.6 + 3, q[2] * 0.6 + 7]) * 1.5 + 0.5 - (1 - p.patch)) * p.patch;
      for (let c = 0; c < 3; c++) mb.col[i + c] = lerp(mb.col[i + c], pc[c], t) * m;
    }
  }

  /**
   * Scales everything about the cell's ground centre, as little as needed, so no vertex leaves its sprite: each vertex
   * is checked against the sprite of the cell (part) it falls in, cells stacked one block height apart.
   */
  function fitCells(pos, ground, cells) {
    const H = Aura.blockEngine.BLOCK_HEIGHT, project = Aura.blockEngine.project;
    const fits = (k) => {
      for (let j = 0; j < pos.length; j += 3) {
        const z = ground + (pos[j + 2] - ground) * k;
        const part = Math.max(0, Math.min(cells - 1, Math.floor(z / H)));
        const [x, y] = project([pos[j] * k, pos[j + 1] * k, z - part * H], 1, H);
        if (x < 0.008 || x > 0.992 || y < 0.008 || y > 0.992) return false;
      }
      return true;
    };
    if (fits(1)) return;
    let lo = 0.05, hi = 1;
    for (let it = 0; it < 14; it++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    for (let j = 0; j < pos.length; j += 3) {
      pos[j] *= lo; pos[j + 1] *= lo; pos[j + 2] = ground + (pos[j + 2] - ground) * lo;
    }
  }

  /** Cells the plant needs: one without Multiparte; else the panel's number, or (0) enough to hold its top, up to four. */
  function cellsFor(pos, p, H) {
    if (!p.multipart) return 1;
    if (p.cells > 0) return p.cells;
    let top = 0;
    for (let j = 2; j < pos.length; j += 3) top = Math.max(top, pos[j]);
    return Math.max(1, Math.min(4, Math.ceil((top - 1e-4) / H)));
  }

  /** Where this plant lives: the panel's choice, or for "Automático" the type's own habitat. */
  function waterMode(type, p) {
    const t = TYPES[type];
    if (t?.water === "HANGING") return "LAND";
    return p.waterMode === "AUTO" ? (t?.water ?? "LAND") : p.waterMode;
  }

  /**
   * The water this plant is drawn with, in blocks: { surface, emerge }. With Multiparte the panel's values as they are.
   * Without it everything must fit one tile, the same cells the game gives each habitat: a submerged plant fills (at
   * most) its one water cell; an emergent one shares its single cell between the water and what sticks out; a floating
   * one is the air cell over the water, so it rests on its own floor and its stems (which would be in the cell below)
   * are left out.
   */
  function waterLevels(type, p) {
    const mode = waterMode(type, p);
    if (p.multipart) return { surface: p.waterDepth, emerge: p.emergeHeight };
    if (mode === "UNDERWATER") return { surface: Math.min(p.waterDepth, 1), emerge: p.emergeHeight };
    if (mode === "EMERGENT") {
      const k = Math.min(1, 0.96 / Math.max(1e-6, p.waterDepth + p.emergeHeight));
      return { surface: p.waterDepth * k, emerge: p.emergeHeight * k };
    }
    if (mode === "SURFACE") return { surface: 0, emerge: p.emergeHeight };
    return { surface: p.waterDepth, emerge: p.emergeHeight };
  }

  /**
   * Moves or stretches one plant (vertices from first on, ground at z = 0) to respect the water: floating ones are
   * lifted to the surface, submerged ones squeezed to stay under it, emergent ones stretched until they reach out.
   */
  function fitToWater(pos, first, p, mode) {
    if (mode === "LAND" || first >= pos.length) return;
    const surface = p.waterSurface, H = Aura.blockEngine.BLOCK_HEIGHT;
    if (mode === "SURFACE") {
      for (let j = first + 2; j < pos.length; j += 3) pos[j] += surface;
      return;
    }
    if (!p.waterFit) return;
    let top = -Infinity;
    for (let j = first + 2; j < pos.length; j += 3) top = Math.max(top, pos[j]);
    if (top <= 1e-6) return;
    let k;
    if (mode === "UNDERWATER") {
      const limit = surface - H * 0.05;
      if (top <= limit && !p.waterFill) return;
      k = limit / top;
    } else {
      const want = surface + p.emergeResolved * H;
      if (top >= want) return;
      k = want / top;
    }
    for (let j = first + 2; j < pos.length; j += 3) pos[j] *= Math.max(0.05, k);
  }

  /**
   * Builds the whole patch of plants. opts: the panel options (see defaults()); type: a TYPES key.
   * Returns { pos: Float32Array, col: Float32Array, triangles } in blocks, z up, ground at opts.groundZ.
   */
  function build(type, opts) {
    const p = { ...defaults(type), ...opts };
    // Colours to linear once: every "...Color" option gets a "...ColorL" twin.
    for (const [k, v] of Object.entries(p)) if (/Color$/.test(k) && typeof v === "string") p[k + "L"] = M.hexToLinear(v);
    const mb = new M.MeshBuilder(p);
    const gen = GENERATORS[type] ?? genGrass;
    const pts = keepInCell(positions(p, rng(p.seed)), p);
    const H = Aura.blockEngine.BLOCK_HEIGHT;
    const ground = p.groundZ * H;
    const mode = waterMode(type, p);
    const water = waterLevels(type, p);
    p.waterSurface = water.surface * H;
    p.emergeResolved = water.emerge;
    p.waterModeResolved = mode;
    pts.forEach((pos, i) => {
      // One generator per plant, seeded by its index: changing the count adds or removes plants without reshuffling
      // the ones already there.
      const r = rng(p.seed * 1000003 + i * 7919);
      mb.rng = rng(p.seed * 31337 + i * 104729);
      const first = mb.pos.length;
      gen(mb, p, r, pos);
      const k = (p.sizeVariation > 0 ? 1 + r.uniform(-p.sizeVariation, p.sizeVariation) : 1) * p.scale;
      if (k !== 1) for (let j = first; j < mb.pos.length; j += 3) for (let a = 0; a < 3; a++) mb.pos[j + a] = pos[a] + (mb.pos[j + a] - pos[a]) * k;
      fitToWater(mb.pos, first, p, mode);
    });
    colorNoise(mb, p);
    if (ground) for (let j = 2; j < mb.pos.length; j += 3) mb.pos[j] += ground;
    const filled = p.multipart ? p.cells : 1;
    if (p.fillCells && filled > 0 && mode !== "SURFACE") {
      // Stretched upward only: "two tiles tall" should make a taller corn, not a wider one. Never a floating plant:
      // it lies on the water, and stretching its thickness only pushes it out of the sprite.
      let top = ground;
      for (let j = 2; j < mb.pos.length; j += 3) top = Math.max(top, mb.pos[j]);
      const k = (filled * H * 0.96 - ground) / Math.max(1e-6, top - ground);
      if (k > 0) for (let j = 2; j < mb.pos.length; j += 3) mb.pos[j] = ground + (mb.pos[j] - ground) * k;
    }
    const cells = cellsFor(mb.pos, p, H);
    // Without Multiparte the one-tile limit is a rule, not a preference: it is fitted even with "Ajustar al sprite" off.
    if (p.fitSprite || !p.multipart) fitCells(mb.pos, ground, cells);
    return { pos: Float32Array.from(mb.pos), col: Float32Array.from(mb.col), triangles: mb.triangleCount, cells };
  }

  // Variety presets: picking one sets the plant's shape and its own colours, which stay editable afterwards. A type
  // with presetParam also applies the preset named like that option's value when the option changes (a flower's head).
  const PRESETS = {};
  const CATEGORIES = [["herbs", "Hierbas y flores"], ["crops", "Cultivos"], ["water", "Agua"], ["fungi", "Hongos, rocas y cristales"], ["climbers", "Trepadoras y colgantes"]];

  /** Adds a plant type (used by generators-more.js). */
  function register(key, def, gen, presets = null) {
    TYPES[key] = def;
    GENERATORS[key] = gen;
    if (presets) PRESETS[key] = presets;
  }

  Aura.plantGen = {
    COMMON, TYPES, PRESETS, CATEGORIES, defaults, build, register, waterMode, waterLevels,
    helpers: { L, deg, vary, positions, leanDirection, kink, nodeColors, featherLeaf, petal, flowerCenter, segmentedStem, growthColor },
  };
})(typeof window !== "undefined" ? (window.Aura ??= {}) : (globalThis.Aura ??= {}));
