"use strict";

(function (Aura) {
  const { h } = Aura.dom;
  const { prefs } = Aura.storage;

  // Panel controls with one shape: build(options) returns { el, get(), set(value) }. onInput fires while the value moves
  // (slider drag), onChange when it settles, so a tool can preview live and record one undo step per change.

  /** Collapsible section; its open/closed state is remembered per id. */
  function section({ id, title, extra = null, collapsed = false }, ...content) {
    const key = id ? "section:" + id : null;
    const startCollapsed = key ? prefs.get(key, collapsed) : collapsed;
    const body = h("div", { class: "section-body" }, content);
    const el = h("section", { class: ["section", startCollapsed && "collapsed"] });
    const head = h("button", {
      class: "section-head", "aria-expanded": String(!startCollapsed),
      onclick: () => {
        const now = el.classList.toggle("collapsed");
        head.setAttribute("aria-expanded", String(!now));
        if (key) prefs.set(key, now);
      },
    }, h("span", { class: "chev" }, "▾"), title, extra ? h("span", { class: "extra" }, extra) : null);
    el.append(head, body);
    return { el, body, head };
  }

  /** A "?" that shows the explanation on hover, after a label (only when there is one). */
  function help(title) {
    return title ? h("span", { class: "ctl-help", title, "aria-label": title }, "?") : null;
  }

  /** Range + editable number + ↺ (shown while the value is not the default) + "?" with the explanation. */
  function slider({ label, min, max, step = 1, value, unit = "", title = "", onInput, onChange, defaultValue = value }) {
    const range = h("input", { type: "range", min, max, step, value, "aria-label": label });
    const number = h("input", { type: "number", min, max, step, value, "aria-label": label });
    const clamp = (v) => Math.min(Number(max), Math.max(Number(min), v));
    let committed = Number(value);
    const reset = h("button", { class: "ctl-reset", tabIndex: -1, title: "Volver a " + defaultValue + unit, onclick: () => api.set(defaultValue, true) }, "↺");
    const syncReset = () => { reset.classList.toggle("off", Number(range.value) === Number(defaultValue)); };

    const commit = () => {
      const v = Number(range.value);
      if (v !== committed) {
        committed = v;
        onChange?.(v);
      }
    };
    range.addEventListener("input", () => {
      number.value = range.value;
      syncReset();
      onInput?.(Number(range.value));
    });
    range.addEventListener("change", commit);
    number.addEventListener("input", () => {
      if (number.value === "" || Number.isNaN(Number(number.value))) return;
      range.value = String(clamp(Number(number.value)));
      syncReset();
      onInput?.(Number(range.value));
    });
    number.addEventListener("change", () => {
      number.value = range.value;
      commit();
    });
    const labelEl = h("label", {
      title: "Doble clic: valor por defecto (" + defaultValue + unit + ")",
      ondblclick: () => api.set(defaultValue, true),
    }, label, help(title));
    const el = h("div", { class: "field slider" }, labelEl, h("div", { class: "ctl" }, range, number, reset));
    const api = {
      el,
      get: () => Number(range.value),
      set(v, notify = false) {
        range.value = String(v);
        number.value = range.value;
        syncReset();
        if (notify) {
          onInput?.(Number(range.value));
          commit();
        } else {
          committed = Number(range.value);
        }
      },
      setDisabled(disabled) { range.disabled = disabled; number.disabled = disabled; },
    };
    syncReset();
    return api;
  }

  function select({ label, options, value, title = "", onChange }) {
    const sel = h("select", { title, "aria-label": label },
      options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)));
    sel.addEventListener("change", () => onChange?.(sel.value));
    const el = label ? h("div", { class: "field" }, h("label", null, label, help(title)), sel) : sel;
    return { el, input: sel, get: () => sel.value, set: (v) => { sel.value = v; } };
  }

  function checkbox({ label, value, title = "", onChange }) {
    const input = h("input", { type: "checkbox", checked: !!value });
    input.addEventListener("change", () => onChange?.(input.checked));
    // A span, not a label: a label inside the label has no control of its own and swallows the click on the text.
    const el = h("label", { class: "field check", title }, input, h("span", null, label, help(title)));
    return { el, input, get: () => input.checked, set: (v) => { input.checked = !!v; } };
  }

  /** A few exclusive choices as buttons. options: [value, text, title?] */
  function segmented({ options, value, onChange, label = "" }) {
    const buttons = new Map();
    const el = h("div", { class: "seg", role: "radiogroup", "aria-label": label });
    let current = value;
    for (const [v, text, title] of options) {
      const b = h("button", {
        class: v === value ? "on" : "", role: "radio", "aria-checked": String(v === value), title: title ?? "",
        onclick: () => {
          if (current === v) return;
          api.set(v);
          onChange?.(v);
        },
      }, text);
      buttons.set(v, b);
      el.appendChild(b);
    }
    const api = {
      el,
      get: () => current,
      set(v) {
        current = v;
        for (const [k, b] of buttons) {
          b.classList.toggle("on", k === v);
          b.setAttribute("aria-checked", String(k === v));
        }
      },
      setDisabled(v, disabled) { const b = buttons.get(v); if (b) b.disabled = disabled; },
    };
    return api;
  }

  /** Two numbers side by side (width × height, dx / dy). */
  function numberPair({ label, values, min, max, titles = ["", ""], onChange }) {
    const inputs = values.map((v, i) => h("input", { type: "number", value: v, min, max, title: titles[i] }));
    for (const input of inputs) {
      input.addEventListener("change", () => onChange?.(inputs.map((x) => Number(x.value) || 0)));
    }
    const el = h("div", { class: "field" }, h("label", null, label), h("div", { class: "pair" }, inputs));
    return {
      el, inputs,
      get: () => inputs.map((x) => Number(x.value) || 0),
      set: (vals) => vals.forEach((v, i) => { inputs[i].value = v; }),
    };
  }

  function kbd(text) {
    return h("span", { class: "kbd" }, text);
  }

  /** Normaliza a #RRGGBB o null. Acepta #rgb, #rrggbb, rgb sin #. */
  function normalizeHex(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    if (s[0] !== "#") s = "#" + s;
    const m3 = /^#([0-9a-f]{3})$/i.exec(s);
    if (m3) {
      const [r, g, b] = m3[1].split("");
      s = "#" + r + r + g + g + b + b;
    }
    if (!/^#[0-9a-f]{6}$/i.test(s)) return null;
    return s.toUpperCase();
  }

  /**
   * Color nativo + campo hex editable (#84966A).
   * onInput / onChange reciben siempre #RRGGBB en mayúsculas.
   */
  function colorPicker({ label, value = "#FFFFFF", title = "", onInput, onChange }) {
    let hex = normalizeHex(value) || "#FFFFFF";
    const picker = h("input", {
      type: "color", value: hex, title: title || label || "Color", "aria-label": label || "Color",
    });
    const text = h("input", {
      type: "text", class: "ctl-hex", value: hex, spellcheck: "false",
      maxlength: 7, title: "Código hex (#RRGGBB)", "aria-label": (label || "Color") + " hex",
      placeholder: "#RRGGBB",
    });
    const commit = (v, settle) => {
      const n = normalizeHex(v);
      if (!n) {
        text.value = hex;
        return;
      }
      hex = n;
      picker.value = n;
      text.value = n;
      onInput?.(n);
      if (settle) onChange?.(n);
    };
    picker.addEventListener("input", () => {
      hex = picker.value.toUpperCase();
      text.value = hex;
      onInput?.(hex);
    });
    picker.addEventListener("change", () => {
      hex = picker.value.toUpperCase();
      text.value = hex;
      onChange?.(hex);
    });
    text.addEventListener("input", () => {
      const n = normalizeHex(text.value);
      if (n) {
        hex = n;
        picker.value = n;
        onInput?.(n);
      }
    });
    text.addEventListener("change", () => commit(text.value, true));
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); text.blur(); }
    });
    const el = h("div", { class: "field field-color" },
      label ? h("label", null, label, title ? help(title) : null) : null,
      h("div", { class: "color-row" }, picker, text));
    return {
      el, picker, text,
      get: () => hex,
      set: (v) => {
        const n = normalizeHex(v) || "#FFFFFF";
        hex = n;
        picker.value = n;
        text.value = n;
      },
    };
  }

  /**
   * Básico / Avanzado for a panel: in Básico the sections marked "adv" are hidden, so a first look shows only what
   * changes how the thing looks. The choice is shared by every panel that uses the same key.
   */
  function detailSwitch(target, key = "panel:detail") {
    const apply = (v) => target.classList.toggle("basic", v === "basic");
    const seg = segmented({ label: "Nivel de detalle", value: prefs.get(key, "basic"), onChange: (v) => { prefs.set(key, v); apply(v); },
      options: [["basic", "Básico", "Solo lo que cambia el aspecto"], ["advanced", "Avanzado", "Todos los ajustes: luz, mapas, pixel art, reparto…"]] });
    apply(seg.get());
    return seg.el;
  }

  Aura.controls = { section, slider, select, checkbox, segmented, numberPair, kbd, help, detailSwitch, colorPicker, normalizeHex };
})(window.Aura ??= {});
