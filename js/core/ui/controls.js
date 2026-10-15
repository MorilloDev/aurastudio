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

  /** Range + editable number. Double-click the label to reset to the default. */
  function slider({ label, min, max, step = 1, value, unit = "", title = "", onInput, onChange, defaultValue = value }) {
    const range = h("input", { type: "range", min, max, step, value, "aria-label": label });
    const number = h("input", { type: "number", min, max, step, value, "aria-label": label });
    const clamp = (v) => Math.min(Number(max), Math.max(Number(min), v));
    let committed = Number(value);

    const commit = () => {
      const v = Number(range.value);
      if (v !== committed) {
        committed = v;
        onChange?.(v);
      }
    };
    range.addEventListener("input", () => {
      number.value = range.value;
      onInput?.(Number(range.value));
    });
    range.addEventListener("change", commit);
    number.addEventListener("input", () => {
      if (number.value === "" || Number.isNaN(Number(number.value))) return;
      range.value = String(clamp(Number(number.value)));
      onInput?.(Number(range.value));
    });
    number.addEventListener("change", () => {
      number.value = range.value;
      commit();
    });
    const labelEl = h("label", {
      title: (title ? title + "\n" : "") + "Doble clic: valor por defecto (" + defaultValue + unit + ")",
      ondblclick: () => api.set(defaultValue, true),
    }, label);
    const el = h("div", { class: "field slider" }, labelEl, h("div", { class: "ctl" }, range, number));
    const api = {
      el,
      get: () => Number(range.value),
      set(v, notify = false) {
        range.value = String(v);
        number.value = range.value;
        if (notify) {
          onInput?.(Number(range.value));
          commit();
        } else {
          committed = Number(range.value);
        }
      },
      setDisabled(disabled) { range.disabled = disabled; number.disabled = disabled; },
    };
    return api;
  }

  function select({ label, options, value, title = "", onChange }) {
    const sel = h("select", { title, "aria-label": label },
      options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)));
    sel.addEventListener("change", () => onChange?.(sel.value));
    const el = label ? h("div", { class: "field" }, h("label", null, label), sel) : sel;
    return { el, input: sel, get: () => sel.value, set: (v) => { sel.value = v; } };
  }

  function checkbox({ label, value, title = "", onChange }) {
    const input = h("input", { type: "checkbox", checked: !!value });
    input.addEventListener("change", () => onChange?.(input.checked));
    // A span, not a label: a label inside the label has no control of its own and swallows the click on the text.
    const el = h("label", { class: "field check", title }, input, h("span", null, label));
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

  Aura.controls = { section, slider, select, checkbox, segmented, numberPair, kbd };
})(window.Aura ??= {});
