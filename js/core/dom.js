"use strict";

(function (Aura) {


  // Small DOM helpers. h() builds elements from plain objects so UI code reads like the markup it makes, without a
  // framework: h("button", { class: "primary", onclick: save }, "Guardar").

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /**
   * props: class (string or array, falsy entries skipped), style (object or string), dataset (object), on<event>
   * (listener), any other key becomes an attribute (true = present, false/null/undefined = absent) or, for known DOM
   * properties (value, checked, disabled, hidden…), the property.
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) applyProps(el, props);
    append(el, children);
    return el;
  }

  const PROPERTY_KEYS = new Set(["value", "checked", "disabled", "hidden", "selected", "indeterminate", "tabIndex",
    "textContent", "innerHTML", "title", "min", "max", "step", "type", "placeholder", "spellcheck"]);

  function applyProps(el, props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined) continue;
      if (key === "class") {
        el.className = Array.isArray(value) ? value.filter(Boolean).join(" ") : value;
      } else if (key === "style") {
        if (typeof value === "string") el.style.cssText = value;
        else Object.assign(el.style, value);
      } else if (key === "dataset") {
        Object.assign(el.dataset, value);
      } else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === "ref") {
        value(el);
      } else if (PROPERTY_KEYS.has(key)) {
        el[key] = value;
      } else if (value === true) {
        el.setAttribute(key, "");
      } else if (value !== false && value !== null) {
        el.setAttribute(key, String(value));
      }
    }
  }

  function append(el, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  /** True while the keyboard is busy with a text field: shortcuts that are plain letters must not fire then. */
  function isTyping(target = document.activeElement) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    if (target.tagName === "TEXTAREA") return true;
    if (target.tagName === "SELECT") return false;
    if (target.tagName !== "INPUT") return false;
    return !["range", "checkbox", "radio", "button", "submit", "color", "file"].includes(target.type);
  }

  function debounce(fn, ms) {
    let timer = 0;
    const wrapped = (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
    wrapped.cancel = () => clearTimeout(timer);
    wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
    return wrapped;
  }

  /** Runs fn at most once per animation frame, with the latest arguments. */
  function rafThrottle(fn) {
    let queued = false, lastArgs = [];
    return (...args) => {
      lastArgs = args;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fn(...lastArgs);
      });
    };
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  Aura.dom = { $, $$, h, append, clear, isTyping, debounce, rafThrottle, formatBytes };
})(window.Aura ??= {});
