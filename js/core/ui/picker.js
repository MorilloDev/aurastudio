"use strict";

// Un selector de catálogo: buscador arriba y los elementos en rejilla, agrupados.
//
// Un desplegable sirve para cinco opciones; con cuarenta formas de bloque o quince muebles obliga a abrirlo, leerlo
// entero y acordarse de cómo se llamaba lo que buscabas. Aquí se escribe media palabra y queda lo que importa, y los
// grupos dan de un vistazo qué hay en el catálogo sin leerlo entero.
//
// Lo usan el generador de bloques y el de muebles, que es la razón de que viva en core y no dentro de uno de ellos.
(function (Aura) {
  const { h } = Aura.dom;

  // Sin acentos ni mayúsculas: "piramide" tiene que encontrar "Pirámide".
  const fold = (s) => (s ?? "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  /**
   * items: [{ id, label, group?, hint?, keywords? }]
   * Devuelve { el, set(id), focus() }.
   */
  function gallery({ items, value, onPick, placeholder = "Buscar…", columns = 2, emptyText = "Nada coincide." }) {
    const search = h("input", { type: "search", class: "pick-search", placeholder, spellcheck: false });
    const grid = h("div", { class: "pick-grid" });
    const empty = h("p", { class: "hint pick-empty", hidden: true }, emptyText);
    const el = h("div", { class: "pick" }, search, grid, empty);
    el.style.setProperty("--pick-cols", String(columns));

    const buttons = new Map();
    let current = value;

    function mark() {
      for (const [id, b] of buttons) b.classList.toggle("on", id === current);
    }

    function build(filter) {
      Aura.dom.clear(grid);
      buttons.clear();
      const q = fold(filter);
      const shown = items.filter((it) => !q
        || fold(it.label).includes(q) || fold(it.id).includes(q)
        || fold(it.group).includes(q) || fold(it.keywords).includes(q));

      empty.hidden = shown.length > 0;

      let lastGroup = null;
      for (const it of shown) {
        // Con una búsqueda escrita los títulos de grupo estorban más de lo que ayudan: el resultado ya es corto.
        if (!q && it.group && it.group !== lastGroup) {
          grid.appendChild(h("div", { class: "pick-group" }, it.group));
          lastGroup = it.group;
        }
        const b = h("button", {
          type: "button", class: "pick-item", title: it.hint ?? it.label,
          onclick: () => {
            if (current === it.id) return;
            current = it.id;
            mark();
            onPick?.(it.id);
          },
        }, it.label);
        buttons.set(it.id, b);
        grid.appendChild(b);
      }
      mark();
    }

    let timer = 0;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => build(search.value), 80);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const first = grid.querySelector(".pick-item");
      if (first) first.click();
    });

    build("");

    return {
      el,
      set(id) { current = id; mark(); },
      focus() { search.focus(); },
    };
  }

  Aura.picker = { gallery, fold };
})(window.Aura ??= {});
