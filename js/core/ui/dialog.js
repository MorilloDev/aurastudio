"use strict";

(function (Aura) {
  const { h } = Aura.dom;

  // In-page replacements for confirm() and prompt(): they don't freeze the page, keep the studio's look, and say what each
  // button does instead of OK / Cancel.

  function open(build) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const overlay = h("div", { class: "overlay center" });
      const done = (value) => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        previous?.focus?.();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
      };
      overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(null); });
      overlay.appendChild(build(done));
      document.body.appendChild(overlay);
      document.addEventListener("keydown", onKey, true);
      (overlay.querySelector("[autofocus]") ?? overlay.querySelector("button.primary, button"))?.focus();
    });
  }

  /** Resolves true for the confirm button, false/null otherwise. */
  function confirmDialog({ title, message, confirm = "Aceptar", cancel = "Cancelar", danger = false }) {
    return open((done) => h("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
      h("h2", null, title),
      message ? h("p", null, message) : null,
      h("div", { class: "actions" },
        h("button", { onclick: () => done(false) }, cancel),
        h("button", { class: danger ? "primary danger" : "primary", onclick: () => done(true) }, confirm)),
    )).then((v) => v === true);
  }

  /** Three-way choice for unsaved work: "save" | "discard" | null (cancel). */
  function unsavedDialog(what) {
    return open((done) => h("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
      h("h2", null, "Cambios sin guardar"),
      h("p", null, `${what} tiene cambios sin guardar.`),
      h("div", { class: "actions" },
        h("button", { onclick: () => done(null) }, "Cancelar"),
        h("button", { class: "danger", onclick: () => done("discard") }, "Descartar"),
        h("button", { class: "primary", onclick: () => done("save") }, "Guardar")),
    ));
  }

  /** Text input. validate(value) returns an error message or "". Resolves the trimmed value, or null. */
  function promptDialog({ title, message = "", value = "", placeholder = "", confirm = "Aceptar", validate = () => "" }) {
    return open((done) => {
      const input = h("input", { type: "text", value, placeholder, autofocus: true, spellcheck: false });
      const error = h("p", { style: "color: var(--bad); min-height: 1em; font-size: 12px" });
      const submit = () => {
        const v = input.value.trim();
        const problem = validate(v);
        if (problem) { error.textContent = problem; input.focus(); return; }
        done(v);
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      input.addEventListener("input", () => { error.textContent = ""; });
      setTimeout(() => input.select(), 0);
      return h("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
        h("h2", null, title),
        message ? h("p", null, message) : null,
        input, error,
        h("div", { class: "actions" },
          h("button", { onclick: () => done(null) }, "Cancelar"),
          h("button", { class: "primary", onclick: submit }, confirm)));
    });
  }

  Aura.dialog = { confirmDialog, unsavedDialog, promptDialog };
})(window.Aura ??= {});
