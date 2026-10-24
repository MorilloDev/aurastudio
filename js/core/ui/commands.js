"use strict";

(function (Aura) {
  const { $$, clear, h, isTyping } = Aura.dom;

  /**
   * Every action the studio offers, in one place: the keyboard shortcuts, the command palette (Ctrl+K) and the shortcut
   * sheet (?) are all built from this list, so a new action gets all three by being registered once.
   *
   * command: {
   *   id, title, group,             shown in the palette and the sheet
   *   keys: ["Ctrl+S", "S"],        "Ctrl" means Ctrl or Cmd; letters match without case; symbols match as typed
   *   run(event),                   the action
   *   enabled: () => bool,          optional; disabled commands are listed but don't run
   *   scope: "normals",             optional; only while that tool is active (global otherwise)
   *   whileTyping: true,            also fires inside text fields (Ctrl+S, Escape…)
   *   hidden: true,                 key-only, not in the palette
   * }
   */
  class Commands {
    #list = [];
    #scope = null;

    register(command) {
      this.#list = this.#list.filter((c) => c.id !== command.id);
      this.#list.push({ keys: [], group: "General", ...command });
      return () => { this.#list = this.#list.filter((c) => c !== command); };
    }

    registerAll(commands, scope) {
      const offs = commands.map((c) => this.register({ scope, ...c }));
      return () => offs.forEach((off) => off());
    }

    setScope(scope) {
      this.#scope = scope;
    }

    /** Commands that apply right now (global plus the active tool's). */
    active() {
      return this.#list.filter((c) => !c.scope || c.scope === this.#scope);
    }

    run(id, event) {
      const command = this.active().find((c) => c.id === id);
      if (!command || (command.enabled && !command.enabled())) return false;
      command.run(event);
      return true;
    }

    attach(target = window) {
      target.addEventListener("keydown", (e) => this.#onKey(e));
    }

    #onKey(e) {
      if (e.defaultPrevented || document.querySelector(".overlay")) return;
      const typing = isTyping(e.target);
      for (const command of this.active()) {
        if (!command.keys.some((k) => matches(k, e))) continue;
        if (typing && !command.whileTyping) continue;
        if (command.enabled && !command.enabled()) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        command.run(e);
        return;
      }
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Palette

    openPalette() {
      const items = this.active().filter((c) => !c.hidden);
      let shown = items;
      let selected = 0;

      const list = h("div", { class: "items scroll", role: "listbox" });
      const input = h("input", { type: "search", placeholder: "Escribe un comando…", spellcheck: false, autofocus: true });
      const overlay = h("div", { class: "overlay" }, h("div", { class: "palette" }, input, list));

      const close = () => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
      };
      const runAt = (i) => {
        const command = shown[i];
        if (!command || (command.enabled && !command.enabled())) return;
        close();
        command.run();
      };
      const render = () => {
        clear(list);
        if (!shown.length) list.appendChild(h("div", { class: "none" }, "Ningún comando coincide."));
        shown.forEach((c, i) => {
          const disabled = c.enabled && !c.enabled();
          list.appendChild(h("div", {
            class: ["item", i === selected && "sel", disabled && "disabled"], role: "option",
            onmousemove: () => { if (selected !== i) { selected = i; render(); } },
            onclick: () => runAt(i),
          }, h("span", { class: "group" }, c.group), h("span", { class: "title" }, c.title),
          c.keys[0] ? h("span", { class: "kbd" }, prettyKey(c.keys[0])) : null));
        });
        list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
      };
      input.addEventListener("input", () => {
        shown = rank(items, input.value);
        selected = 0;
        render();
      });
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); selected = Math.min(shown.length - 1, selected + 1); render(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); selected = Math.max(0, selected - 1); render(); }
        else if (e.key === "Enter") { e.preventDefault(); runAt(selected); }
      };
      overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(overlay);
      render();
      input.focus();
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Shortcut sheet

    openKeysheet(extra = []) {
      const groups = new Map();
      for (const c of [...this.active(), ...extra]) {
        if (!c.keys?.length) continue;
        if (!groups.has(c.group)) groups.set(c.group, []);
        groups.get(c.group).push(c);
      }
      const overlay = h("div", { class: "overlay" });
      const close = () => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
      };
      const onKey = (e) => {
        if (e.key === "Escape" || e.key === "?") { e.preventDefault(); close(); }
      };
      overlay.appendChild(h("div", { class: "keysheet" },
        h("h2", null, "Atajos de teclado"),
        h("div", { class: "cols" }, [...groups].map(([group, commands]) => h("div", { class: "grp" },
          h("h3", null, group),
          commands.map((c) => h("div", { class: "k" }, h("span", null, c.title),
            h("span", null, c.keys.map((k, i) => [i ? " " : "", h("span", { class: "kbd" }, prettyKey(k))])))))))));
      overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(overlay);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Keys

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  function matches(spec, e) {
    // "+" alone is the plus key itself (splitting it on "+" would leave nothing); the layout decides whether it needs Shift.
    if (spec === "+") return !(e.ctrlKey || e.metaKey || e.altKey) && e.key === "+";
    const parts = spec.split("+");
    const key = parts.pop();
    const want = { ctrl: parts.includes("Ctrl"), shift: parts.includes("Shift"), alt: parts.includes("Alt") };
    if ((e.ctrlKey || e.metaKey) !== want.ctrl || e.altKey !== want.alt) return false;

    if (key.length === 1 && /[a-z]/i.test(key)) {
      return e.shiftKey === want.shift && e.key.toLowerCase() === key.toLowerCase();
    }
    if (key === "Space") return e.key === " " && e.shiftKey === want.shift;
    if (/^(Arrow|Page|Home|End|Escape|Enter|Delete|Backspace|Tab|F\d)/.test(key)) {
      return e.key === key && e.shiftKey === want.shift;
    }
    // Symbols ("?", "[", "+") are matched as typed: which Shift they need depends on the keyboard layout.
    return e.key === key;
  }

  function prettyKey(spec) {
    return spec
      .replace("Ctrl", isMac ? "⌘" : "Ctrl")
      .replace("ArrowUp", "↑").replace("ArrowDown", "↓").replace("ArrowLeft", "←").replace("ArrowRight", "→")
      .replace("PageUp", "RePág").replace("PageDown", "AvPág").replace("Escape", "Esc").replace("Space", "Espacio");
  }

  // Subsequence match, words in order: "gn" finds "Guardar normal map". Earlier and tighter matches rank first.
  function rank(items, query) {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const scored = [];
    for (const c of items) {
      const text = (c.group + " " + c.title).toLowerCase();
      let pos = -1, score = 0, gaps = 0;
      for (const ch of q) {
        if (ch === " ") continue;
        const next = text.indexOf(ch, pos + 1);
        if (next < 0) { score = -1; break; }
        gaps += next - pos - 1;
        pos = next;
      }
      if (score < 0) continue;
      const direct = c.title.toLowerCase().includes(q) ? -1000 : 0;
      scored.push({ c, s: direct + gaps });
    }
    return scored.sort((a, b) => a.s - b.s).map((x) => x.c);
  }

  function keyHint(spec) {
    return spec ? ` (${prettyKey(spec)})` : "";
  }

  function markActive(buttons, predicate) {
    for (const b of $$(buttons)) b.classList.toggle("on", predicate(b));
  }

  Aura.commands = { Commands, prettyKey, keyHint, markActive };
})(window.Aura ??= {});
