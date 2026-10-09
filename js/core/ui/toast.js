"use strict";

(function (Aura) {
  const { h } = Aura.dom;

  // Notifications that stack instead of replacing each other. Errors stay until closed; the rest fade on their own.
  const MAX_VISIBLE = 5;
  const DURATION = { ok: 3500, info: 4000, warn: 7000, bad: 0 };

  let host = null;

  function container() {
    if (!host) {
      host = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
      document.body.appendChild(host);
    }
    return host;
  }

  /**
   * kind: ok | info | warn | bad. detail: a second, quieter line. action: { label, run } adds a button (e.g. "Deshacer").
   * Returns a function that closes the toast.
   */
  function toast(message, { kind = "info", detail = "", action = null, duration } = {}) {
    const el = h("div", { class: ["toast", kind] },
      h("div", { class: "body" }, message, detail ? h("small", null, detail) : null));
    const close = () => {
      if (!el.isConnected) return;
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 200);
    };
    if (action) {
      el.appendChild(h("button", { onclick: () => { action.run(); close(); } }, action.label));
    }
    el.appendChild(h("button", { class: "ghost", title: "Cerrar", "aria-label": "Cerrar", onclick: close }, "×"));

    const list = container();
    list.appendChild(el);
    while (list.children.length > MAX_VISIBLE) list.firstElementChild.remove();

    const ms = duration ?? DURATION[kind] ?? 4000;
    if (ms > 0) {
      let timer = setTimeout(close, ms);
      el.addEventListener("mouseenter", () => clearTimeout(timer));
      el.addEventListener("mouseleave", () => { timer = setTimeout(close, 1500); });
    }
    return close;
  }

  Aura.toast = { toast };
})(window.Aura ??= {});
