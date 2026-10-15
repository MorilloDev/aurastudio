"use strict";

// The context view of the Crear tab: what was just generated, laid out 3 × 3 in the game's own projection — blocks next
// to each other, plants standing on a ground of grass blocks — under a biome colour (with the game's small per-tile hue
// shift), at day, dusk or night, swaying in the wind like TileInstanced.fx bends a sprite. It answers "does it tile, and
// how does it look in the world" before anything is saved.
(function (Aura) {
  const { h } = Aura.dom;
  const { select, segmented, checkbox } = Aura.controls;
  const Tint = Aura.tint;

  const LIGHTS = {
    day: [1, 1, 1],
    dusk: [1, 0.78, 0.6],
    night: [0.36, 0.42, 0.66],
  };

  // Chunk.BiomeVarianceHueShiftDegrees: how far one tile's biome colour may turn from its neighbours'.
  const HUE_SHIFT = 10;

  const hash = (x, y) => {
    let n = (x * 374761393 + y * 668265263) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };

  function shiftHue([r, g, b], degrees) {
    // Rotation in RGB around the grey axis: close enough to the game's HSL shift for ±10°.
    const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), k = 1 / 3, q = Math.sqrt(k);
    const m = (i, j) => (i === j ? c + k * (1 - c) : k * (1 - c) + (((i + 1) % 3 === j) ? -1 : 1) * q * s);
    const v = [r, g, b];
    return [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(v[0] * m(i, 0) + v[1] * m(i, 1) + v[2] * m(i, 2)))));
  }

  class ContextView {
    /** host: the element the view lives in (positioned). Hidden until show(). */
    constructor(host, { biomes = [Tint.DEFAULT_TINT], onChange = null } = {}) {
      this.canvas = h("canvas", { class: "ctx-canvas", hidden: true });
      this.biomes = biomes;
      this.state = { biome: "", light: "day", wind: true, vary: true };
      this.content = null;
      this.tiles = null;
      this.onChange = onChange;
      this.bar = h("div", { class: "ctx-bar", hidden: true });
      host.append(this.canvas, this.bar);
      this.#buildBar();
    }

    #raf = 0;

    setBiomes(list) {
      this.biomes = list;
      this.#buildBar();
      this.tiles = null;
      this.draw();
    }

    #buildBar() {
      const biome = select({ value: this.state.biome, title: "Bioma: colorea el suelo y lo que sea biome_tinted",
        options: this.biomes.map((b) => [b.id, `${b.name}`]), onChange: (v) => { this.state.biome = v; this.tiles = null; this.draw(); } });
      const light = segmented({ label: "Luz", value: this.state.light, onChange: (v) => { this.state.light = v; this.tiles = null; this.draw(); },
        options: [["day", "Día"], ["dusk", "Atardecer"], ["night", "Noche"]] });
      const wind = checkbox({ label: "Viento", value: this.state.wind, onChange: (v) => { this.state.wind = v; this.#loop(); this.draw(); } });
      const vary = checkbox({ label: "Variar", value: this.state.vary, title: "Cada tile con su tono de bioma y su variante, como en el mundo",
        onChange: (v) => { this.state.vary = v; this.tiles = null; this.draw(); } });
      this.bar.replaceChildren(biome.el, light.el, wind.el, vary.el);
    }

    get visible() { return !this.canvas.hidden; }

    show(on) {
      this.canvas.hidden = !on;
      this.bar.hidden = !on;
      this.#loop();
      if (on) this.draw();
    }

    /**
     * kind: "block" (3 × 3 of the sprite, no ground) or "plant" (on grass blocks). variants: [{ parts: [rgba…] }], each
     * part a size × size sprite, bottom first. tinted: the art is biome_tinted. sways: plants that move in the wind.
     */
    setContent({ kind, size, variants, tinted, sways }) {
      this.content = { kind, size, variants: variants.filter((v) => v?.parts?.length), tinted, sways };
      this.tiles = null;
      this.#loop();
      this.draw();
    }

    #loop() {
      const animate = this.visible && this.state.wind && this.content?.sways;
      if (animate && !this.#raf) this.#raf = requestAnimationFrame(this.#frame);
      if (!animate && this.#raf) { cancelAnimationFrame(this.#raf); this.#raf = 0; }
    }

    #frame = (t) => {
      this.#raf = 0;
      this.draw(t);
      this.#loop();
    };

    // Every tile's sprites, tinted, varied and lit once per change; the frames only place them.
    #build() {
      const c = this.content, S = c.size, E = Aura.blockEngine, H = E.BLOCK_HEIGHT;
      const o = E.project([0, 0, 0], S, H), px = E.project([1, 0, 0], S, H), py = E.project([0, 1, 0], S, H), pz = E.project([0, 0, H], S, H);
      const ex = [px[0] - o[0], px[1] - o[1]], ey = [py[0] - o[0], py[1] - o[1]], ez = [pz[0] - o[0], pz[1] - o[1]];
      const light = LIGHTS[this.state.light];
      const biomeRgb = Tint.hexToRgb((this.biomes.find((b) => b.id === this.state.biome) ?? Tint.DEFAULT_TINT).hex);
      const ground = c.kind === "plant" ? groundSprite(S, H) : null;
      const tiles = [];
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const n = hash(i + 7, j + 13);
          const tint = this.state.vary ? shiftHue(biomeRgb, (n * 2 - 1) * HUE_SHIFT) : biomeRgb;
          const v = c.variants[this.state.vary ? Math.floor(hash(i + 3, j + 5) * c.variants.length) : 0];
          const at = (level) => [i * ex[0] + j * ey[0] + level * ez[0], i * ex[1] + j * ey[1] + level * ez[1]];
          const base = c.kind === "plant" ? 1 : 0;
          if (ground) tiles.push({ x: at(0)[0], y: at(0)[1], depth: i + j, level: 0, img: finish(ground, S, tint, light), sway: null });
          v.parts.forEach((rgba, k) => {
            const [x, y] = at(base + k);
            tiles.push({
              x, y, depth: i + j, level: base + k, img: finish(c.tinted ? Tint.applyTint(rgba, tint) : rgba, S, null, light),
              sway: c.sways ? { phase: n * Math.PI * 2, part: k, parts: v.parts.length } : null,
            });
          });
        }
      }
      // Painter's order: the row farther from the camera first, then upward.
      tiles.sort((a, b) => a.depth - b.depth || a.level - b.level);
      const xs = tiles.map((t) => t.x), ys = tiles.map((t) => t.y);
      this.tiles = { list: tiles, S, minX: Math.min(...xs), minY: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + S, h: Math.max(...ys) - Math.min(...ys) + S };
      this.scene = new OffscreenCanvas(Math.ceil(this.tiles.w), Math.ceil(this.tiles.h) + 8);
    }

    draw(time = performance.now()) {
      if (!this.visible || !this.content?.variants.length) return;
      if (!this.tiles) this.#build();
      const { list, S, minX, minY } = this.tiles;
      const g = this.scene.getContext("2d");
      g.clearRect(0, 0, this.scene.width, this.scene.height);
      const t = time / 1000;
      for (const tile of list) {
        const x = Math.round(tile.x - minX), y = Math.round(tile.y - minY) + 4;
        if (!tile.sway || !this.state.wind) { g.drawImage(tile.img, x, y); continue; }
        // TileInstanced.fx: the bend grows linearly with height from the foot of the bottom part to the top of the top
        // one, one phase per plant, so stacked parts move as one.
        const amp = S * 0.06 * (0.6 + 0.4 * Math.sin(t * 0.7 + tile.sway.phase * 0.5));
        const swing = Math.sin(t * 2.1 + tile.sway.phase) * amp;
        const total = S * (1 + (tile.sway.parts - 1) * 0.5);
        for (let row = 0; row < S; row++) {
          const fromFoot = (S - row) + tile.sway.part * S * 0.5;
          const dx = Math.round(swing * Math.min(1, fromFoot / total));
          g.drawImage(tile.img, 0, row, S, 1, x + dx, y + row, S, 1);
        }
      }
      const c = this.canvas, dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, Hh = c.clientHeight;
      if (!W || !Hh) return;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(Hh * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(Hh * dpr); }
      const v = c.getContext("2d");
      v.setTransform(dpr, 0, 0, dpr, 0, 0);
      v.clearRect(0, 0, W, Hh);
      v.fillStyle = this.state.light === "night" ? "#151a26" : this.state.light === "dusk" ? "#3a2f33" : "#3d4a55";
      v.fillRect(0, 0, W, Hh);
      const k = Math.max(1, Math.floor(Math.min((W - 40) / this.scene.width, (Hh - 80) / this.scene.height)));
      v.imageSmoothingEnabled = false;
      v.drawImage(this.scene, Math.round((W - this.scene.width * k) / 2), Math.round((Hh - 40 - this.scene.height * k) / 2), this.scene.width * k, this.scene.height * k);
    }
  }

  // A sprite with the biome (for the ground) and the light multiplied in, as a canvas.
  function finish(rgba, S, tint, light) {
    const out = new Uint8ClampedArray(rgba);
    for (let i = 0; i < out.length; i += 4) {
      if (!out[i + 3]) continue;
      for (let ch = 0; ch < 3; ch++) {
        let v = out[i + ch];
        if (tint && out[i + 3] === 254) v = v * tint[ch] / 255;
        out[i + ch] = v * light[ch];
      }
      if (out[i + 3] === 254) out[i + 3] = 255;
    }
    const c = new OffscreenCanvas(S, S);
    c.getContext("2d").putImageData(new ImageData(out, S, S), 0, 0);
    return c;
  }

  /**
   * A grass block for plants to stand on: a grey top (alpha 254 marks it as the part the biome colours), dirt sides,
   * the three face lights of the block materials, a little noise so it does not read as flat paint.
   */
  function groundSprite(S, H) {
    const E = Aura.blockEngine, P = (x, y, z) => E.project([x, y, z], S, H);
    const c = new OffscreenCanvas(S, S), g = c.getContext("2d");
    const poly = (pts, fill) => { g.fillStyle = fill; g.beginPath(); pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); };
    const top = [P(-0.5, -0.5, H), P(0.5, -0.5, H), P(0.5, 0.5, H), P(-0.5, 0.5, H)];
    // The two faces toward the camera are the ones whose outward normal points at it; drawing all four sides and the
    // top last gives the same picture without knowing which they are.
    const sides = [
      [P(-0.5, -0.5, 0), P(0.5, -0.5, 0), P(0.5, -0.5, H), P(-0.5, -0.5, H)],
      [P(0.5, -0.5, 0), P(0.5, 0.5, 0), P(0.5, 0.5, H), P(0.5, -0.5, H)],
      [P(0.5, 0.5, 0), P(-0.5, 0.5, 0), P(-0.5, 0.5, H), P(0.5, 0.5, H)],
      [P(-0.5, 0.5, 0), P(-0.5, -0.5, 0), P(-0.5, -0.5, H), P(-0.5, 0.5, H)],
    ];
    g.imageSmoothingEnabled = false;
    sides.forEach((s, k) => poly(s, k % 2 ? "rgb(76,54,35)" : "rgb(104,74,48)"));
    poly(top, "rgb(200,200,200)");
    const img = g.getImageData(0, 0, S, S), d = img.data;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (!d[i + 3]) continue;
      d[i + 3] = 255;
      const n = 0.9 + 0.2 * hash(x * 3 + 1, y * 5 + 2);
      for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.min(255, d[i + ch] * n);
      // The grey top is the biome-coloured part.
      if (Math.abs(d[i] - d[i + 1]) < 3 && Math.abs(d[i + 1] - d[i + 2]) < 3) d[i + 3] = 254;
    }
    return d;
  }

  Aura.contextView = { ContextView };
})(window.Aura ??= {});
