"use strict";

// Biome tint, exactly as TileInstanced.fx draws a "biome_tinted" tile: a pixel's HSV saturation decides how much of the
// biome colour it takes (fully at ≤ 0.05, none at ≥ 0.20, a smoothstep between), and the colour multiplies it. So the
// art of such a tile is grey where the biome should colour it and clearly coloured where it must stay as painted
// (dirt under grass, stems, petals). This module turns art into that form, previews it under any biome, and finds the
// pixels that fall between — tinted halfway, the muddy look the game gives a pale painted colour.
(function (Aura) {
  const { readJson } = Aura.fs;

  const SAT_LOW = 0.05;
  const SAT_HIGH = 0.20;

  // Chunk.DefaultFoliageTint: what a column with no biome colour gets.
  const DEFAULT_TINT = { id: "", name: "Por defecto", hex: "#5ce365" };

  // The project's own biome colours, for previews when no folder is open.
  const FALLBACK_BIOMES = [
    { id: "aura:plains", name: "Plains", hex: "#76b53f" },
    { id: "aura:forest", name: "Forest", hex: "#42a33c" },
    { id: "aura:taiga", name: "Taiga", hex: "#52de7d" },
    { id: "aura:beach", name: "Beach", hex: "#a1dc59" },
    { id: "aura:mountains", name: "Mountains", hex: "#a1d4b0" },
    { id: "aura:desert", name: "Desert", hex: "#e8f0aa" },
    { id: "aura:tundra", name: "Tundra", hex: "#eaf0ee" },
  ];

  const DEFAULTS = {
    enabled: false,
    mode: "hue",       // which pixels go grey: "hue" (a hue range), "sat" (anything below a saturation), "all"
    hue: 105,          // centre of the range, degrees (105 = leaf green)
    hueWidth: 70,      // full width of the range, degrees
    keepSat: 0.25,     // "sat" mode: pixels at or above this saturation keep their colour
    black: 0,          // levels on the grey: input black and white points, then gamma
    white: 255,
    gamma: 1,
    fit: "",           // colour (hex) the grey is fitted to, so under it the tile matches the art; the panel stores a biome id
    protect: true,     // kept colours too pale for the shader are pushed to 0.20 so it leaves them alone
    preview: "",       // biome shown in the preview ("" = the default foliage colour)
  };

  const merge = (o = {}) => ({ ...DEFAULTS, ...o });

  const hexToRgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };

  // TileInstanced.fx GetSaturation.
  function saturation(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max <= 0 ? 0 : (max - min) / max;
  }

  function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /** How much of the biome colour a pixel takes, 0..1. */
  const tintAmount = (r, g, b) => 1 - smoothstep(SAT_LOW, SAT_HIGH, saturation(r, g, b));

  function hueOf(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return 0;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }

  // Rec. 709 luma on the stored values: what reads as "how bright" in the art.
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  /** The art as the game draws it under a biome colour (no light, no hue variance). */
  function applyTint(rgba, rgb) {
    const out = new Uint8ClampedArray(rgba);
    if (!rgb) return out;
    const [tr, tg, tb] = rgb.map((c) => c / 255);
    for (let i = 0; i < out.length; i += 4) {
      if (!out[i + 3]) continue;
      const r = out[i], g = out[i + 1], b = out[i + 2];
      const k = tintAmount(r, g, b);
      if (!k) continue;
      out[i] = r + (r * tr - r) * k;
      out[i + 1] = g + (g * tg - g) * k;
      out[i + 2] = b + (b * tb - b) * k;
    }
    return out;
  }

  // Whether a pixel of the source art is one the biome should colour.
  function wantsTint(o, r, g, b) {
    const s = saturation(r, g, b);
    if (s <= SAT_LOW) return true;
    if (o.mode === "all") return true;
    if (o.mode === "sat") return s < o.keepSat;
    const d = Math.abs(((hueOf(r, g, b) - o.hue + 540) % 360) - 180);
    return d <= o.hueWidth / 2;
  }

  /**
   * The art made ready for "biome_tinted": the pixels the biome should colour become grey — the luma of the original,
   * divided by the fit biome's when one is chosen, so under that biome the tile looks as painted — through the levels;
   * the rest keep their colour, nudged up to the saturation where the shader stops touching them.
   */
  function toTinted(rgba, opts) {
    const o = merge(opts);
    const out = new Uint8ClampedArray(rgba.length);
    const fit = o.fit ? hexToRgb(o.fit) : null;
    const fitLuma = fit ? Math.max(1, luma(...fit)) : 255;
    const range = Math.max(1, o.white - o.black);
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      if (!a) continue;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      out[i + 3] = a;
      if (wantsTint(o, r, g, b)) {
        let v = Math.min(1, luma(r, g, b) / fitLuma);
        v = Math.min(1, Math.max(0, (v * 255 - o.black) / range));
        v = Math.pow(v, 1 / Math.max(0.05, o.gamma));
        out[i] = out[i + 1] = out[i + 2] = Math.round(v * 255);
        continue;
      }
      out[i] = r; out[i + 1] = g; out[i + 2] = b;
      if (o.protect) protect(out, i);
    }
    return out;
  }

  // Raises a kept pixel's saturation to just past SAT_HIGH, same hue and brightness, so the tint never reaches it.
  function protect(px, i) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const target = SAT_HIGH + 0.02;
    if (max === 0 || max === min || (max - min) / max >= target) return;
    const newMin = max * (1 - target), scale = (max - newMin) / (max - min);
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(max - (max - px[i + c]) * scale);
  }

  /** Pixels by how the shader treats them: tinted fully, halfway (the band to avoid) or left as painted. */
  function analyze(rgba) {
    let full = 0, partial = 0, kept = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (!rgba[i + 3]) continue;
      const s = saturation(rgba[i], rgba[i + 1], rgba[i + 2]);
      if (s <= SAT_LOW) full++;
      else if (s < SAT_HIGH) partial++;
      else kept++;
    }
    return { full, partial, kept, total: full + partial + kept };
  }

  /** The pixels tinted halfway, as an overlay (magenta where they are), for marking them on a preview. */
  function partialMask(rgba) {
    const out = new Uint8ClampedArray(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      if (!rgba[i + 3]) continue;
      const s = saturation(rgba[i], rgba[i + 1], rgba[i + 2]);
      if (s > SAT_LOW && s < SAT_HIGH) { out[i] = 255; out[i + 1] = 0; out[i + 2] = 255; out[i + 3] = 255; }
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Biomes of the project

  let cache = { key: null, list: null };

  /** The project's land biomes with their foliage colour ({ id, name, hex }), the default colour first. */
  async function listBiomes(project) {
    if (!project) return [DEFAULT_TINT, ...FALLBACK_BIOMES];
    if (cache.key === project && cache.at === project.scannedAt) return cache.list;
    const list = [DEFAULT_TINT];
    const entries = project.filter((e) => /(^|\/)data\/(worldgen\/)?biomes\/.+\.json$/.test(e.lower)).sort((a, b) => a.path.localeCompare(b.path));
    for (const entry of entries) {
      try {
        const json = await readJson(entry.handle);
        if (json?.placement?.ocean) continue;   // decoration-only (BiomeData.OceanDecoration): no colour of its own
        const foliage = json?.colors?.foliage;
        list.push({ id: json.id ?? entry.name.replace(/\.json$/i, ""), name: json.name ?? json.id ?? entry.name, hex: hexToRgb(foliage) ? foliage : DEFAULT_TINT.hex });
      } catch {
        // A broken biome file is the biome tool's business; it just isn't offered here.
      }
    }
    cache = { key: project, at: project.scannedAt, list: list.length > 1 ? list : [DEFAULT_TINT, ...FALLBACK_BIOMES] };
    return cache.list;
  }

  Aura.tint = { SAT_LOW, SAT_HIGH, DEFAULTS, DEFAULT_TINT, merge, hexToRgb, saturation, tintAmount, applyTint, toTinted, analyze, partialMask, listBiomes };
})(window.Aura ??= {});
