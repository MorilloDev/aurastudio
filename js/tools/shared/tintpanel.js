"use strict";

// The "Bioma" panel section shared by the generators and the Atlas: turns the art into the grey a "biome_tinted" tile
// needs, with the levels to tune that grey, the biome to fit it to, the biome to preview it under, and a count of the
// pixels the shader would tint only halfway.
(function (Aura) {
  const { h } = Aura.dom;
  const { section, slider, select, checkbox, segmented } = Aura.controls;
  const Tint = Aura.tint;

  /**
   * state: the tool's tint options (Tint.DEFAULTS shape), changed in place. biomes: [{ id, name, hex }].
   * onChange(kind): "art" when the grey changes, "preview" when only the preview biome does.
   * withToggle: show the "biome_tinted" switch (the Atlas acts on a selection instead).
   * Returns { el, setStats(stats) }.
   */
  function tintSection({ id, state, biomes, onChange, withToggle = true, title = "Bioma" }) {
    const changed = (kind = "art") => { refresh(); onChange(kind); };
    const set = (key) => (v) => { state[key] = v; changed(); };
    const biomeOptions = (first) => [["", first], ...biomes.filter((b) => b.id).map((b) => [b.id, `${b.name} (${b.hex})`])];

    const toggle = withToggle ? checkbox({ label: "Teñido por bioma (biome_tinted)", value: state.enabled,
      title: "El juego multiplica los pixeles grises por el color del bioma; los que tienen color se quedan como están",
      onChange: (v) => { state.enabled = v; changed(); } }) : null;
    const mode = segmented({ label: "Qué pasa a gris", value: state.mode, onChange: set("mode"), options: [
      ["hue", "Por tono", "Solo los colores de un rango de tono (p. ej. los verdes): pétalos, tierra y tallos se quedan"],
      ["sat", "Por saturación", "Lo poco saturado pasa a gris; lo muy saturado se queda"],
      ["all", "Todo", "Todo el sprite se tiñe"]] });
    const swatch = h("span", { class: "tint-hue" });
    const hue = slider({ label: "Tono", min: 0, max: 359, step: 1, value: state.hue, defaultValue: Tint.DEFAULTS.hue, unit: "°",
      title: "Centro del rango que se tiñe", onInput: (v) => { state.hue = v; paintSwatch(); }, onChange: set("hue") });
    const hueWidth = slider({ label: "Margen", min: 10, max: 180, step: 1, value: state.hueWidth, defaultValue: Tint.DEFAULTS.hueWidth, unit: "°",
      title: "Ancho del rango de tono", onChange: set("hueWidth") });
    const keepSat = slider({ label: "Conservar desde", min: 0.06, max: 0.8, step: 0.01, value: state.keepSat, defaultValue: Tint.DEFAULTS.keepSat,
      title: "Saturación a partir de la cual un pixel conserva su color", onChange: set("keepSat") });
    const black = slider({ label: "Negro", min: 0, max: 200, step: 1, value: state.black, defaultValue: Tint.DEFAULTS.black,
      title: "Lo que era así de oscuro queda negro: más contraste en las sombras", onChange: set("black") });
    const white = slider({ label: "Blanco", min: 55, max: 255, step: 1, value: state.white, defaultValue: Tint.DEFAULTS.white,
      title: "Lo que era así de claro queda blanco: el color del bioma sale más puro en las luces", onChange: set("white") });
    const gamma = slider({ label: "Gamma", min: 0.3, max: 3, step: 0.05, value: state.gamma, defaultValue: Tint.DEFAULTS.gamma,
      title: "Más de 1 aclara los medios tonos, menos de 1 los oscurece", onChange: set("gamma") });
    const fit = select({ label: "Ajustar a", value: state.fit, options: biomeOptions("— sin ajuste —"),
      title: "Divide el gris por el brillo de ese bioma: bajo él, el tile se ve con el mismo brillo que el original",
      onChange: set("fit") });
    const protect = checkbox({ label: "Proteger colores pálidos", value: state.protect,
      title: `Los colores que se conservan pero tienen menos de ${Tint.SAT_HIGH} de saturación se saturan lo justo para que el bioma no los manche`,
      onChange: set("protect") });
    const preview = select({ label: "Ver con", value: state.preview, options: [["", `${Tint.DEFAULT_TINT.name} (${Tint.DEFAULT_TINT.hex})`], ...biomeOptions("").slice(1)],
      title: "Bioma de la vista «Bioma»", onChange: (v) => { state.preview = v; onChange("preview"); } });
    const stats = h("div", { class: "tint-stats" });

    const body = h("div", { class: "tint-body" },
      mode.el,
      h("div", { class: "tint-hue-row" }, hue.el, swatch), hueWidth.el, keepSat.el,
      black.el, white.el, gamma.el, fit.el, protect.el);
    const refresh = () => {
      body.hidden = withToggle && !state.enabled;
      hue.el.parentElement.hidden = state.mode !== "hue";
      hueWidth.el.hidden = state.mode !== "hue";
      keepSat.el.hidden = state.mode !== "sat";
    };
    const paintSwatch = () => { swatch.style.background = `hsl(${state.hue}, 70%, 45%)`; };
    paintSwatch();
    refresh();

    const sec = section({ id, title }, toggle?.el, body, preview.el, stats,
      h("p", { class: "note" }, "Vista ", h("b", null, "Bioma"), ": cómo lo pinta el juego. Los pixeles ",
        h("b", null, "a medias"), ` (saturación entre ${Tint.SAT_LOW} y ${Tint.SAT_HIGH}) se tiñen solo en parte y salen sucios.`));
    return {
      el: sec.el,
      setStats(s) {
        if (!s?.total) { stats.textContent = ""; return; }
        stats.replaceChildren(
          h("span", { class: "badge plain", title: "Toman el color del bioma" }, `${s.full} gris`),
          h("span", { class: ["badge", s.partial ? "warn" : "plain"], title: "Se tiñen solo en parte" }, `${s.partial} a medias`),
          h("span", { class: "badge plain", title: "El bioma no los toca" }, `${s.kept} con color`));
      },
    };
  }

  /** The tint options with the fit biome resolved to its colour, as Tint.toTinted takes them. */
  function resolve(state, biomes) {
    return { ...state, fit: biomes.find((b) => b.id && b.id === state.fit)?.hex ?? "" };
  }

  function previewRgb(state, biomes) {
    return Tint.hexToRgb((biomes.find((b) => b.id === state.preview) ?? Tint.DEFAULT_TINT).hex);
  }

  Aura.tintPanel = { tintSection, resolve, previewRgb };
})(window.Aura ??= {});
