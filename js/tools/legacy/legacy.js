"use strict";

(function (Aura) {
  const { h } = Aura.dom;

  /**
   * A tool not migrated into the studio yet: its original page, unchanged, in a frame. Its text lives in
   * legacy/<source>.js and is loaded the first time the tab is opened. The frame is built from that text (srcdoc), so it
   * shares the studio's origin and folder access works inside it as it did on its own.
   */
  function legacyTool({ id, title, source }) {
    let frame = null;
    return {
      id,
      title,
      legacy: true,
      mount(host) {
        const status = h("div", { class: "empty-state" }, `Cargando «${title}»…`);
        host.appendChild(status);
        loadScript(`legacy/${source}.js`).then(() => {
          const html = Aura.legacyPages?.[source];
          if (!html) throw new Error("legacy/" + source + ".js no define la página");
          frame = h("iframe", { title, srcdoc: html });
          status.replaceWith(frame);
          frame.addEventListener("load", () => frame.contentWindow?.focus());
        }).catch((err) => {
          status.textContent = `No pude cargar «${title}»: ${err.message}`;
        });
      },
      activate() {
        // Keys go to the frame while it is shown, as they did in its own tab.
        setTimeout(() => frame?.contentWindow?.focus(), 0);
      },
      isDirty: () => false,
    };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("no encontré " + src));
      document.head.appendChild(s);
    });
  }

  Aura.legacy = { legacyTool };
})(window.Aura ??= {});
