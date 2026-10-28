"use strict";

// Partículas nativo — carga Data/Particles, demos, sim al estilo ParticleSystem.cs
(function (Aura) {
  const { h, clear } = Aura.dom;
  const { writeHandle, joinPath } = Aura.fs;
  const { slider, checkbox, select } = Aura.controls;
  const { decodePng } = Aura.png;
  const M = Aura.particlesModel;

  // Same idea as ParticleOverlay.ReferenceUnitSize — scale is in "tile units"
  const REF_UNIT = 32;
  // World units visible roughly across the preview height (so vel 12 is readable)
  const WORLD_VIEW = 8;

  function particlesTool() {
    return new ParticlesTool();
  }

  class ParticlesTool {
    id = "particles";
    title = "Partículas";
    project = null;
    docs = [];
    texturePaths = [];
    textures = new Map();
    sel = 0;
    query = "";
    playing = true;
    loop = true;
    usingDemo = false;
    #raf = 0;
    #particles = [];
    #emitAcc = 0;
    #burstOnce = false;
    #emitterAge = 0;
    #groundY = 0;

    mount(host, studio) {
      this.studio = studio;
      host.appendChild(this.#buildLayout());
      this.studio.commands.registerAll([
        {
          id: "particles.save", title: "Guardar efectos", group: "Partículas",
          keys: ["Ctrl+S"], whileTyping: true,
          enabled: () => this.isDirty(), run: () => this.save(),
        },
        {
          id: "particles.new", title: "Efecto nuevo", group: "Partículas",
          keys: ["Ctrl+N"], enabled: () => !!this.project && !this.usingDemo, run: () => this.#addEffect(),
        },
      ], this.id);
      // Show demos immediately so something always works
      this.docs = M.loadDemoDocs();
      this.usingDemo = true;
      this.#renderAll();
      this.#startLoop();
      this.studio.setStatus("Demos de partículas · abre Content para Data/Particles del juego", "ok");
    }

    activate() { this.playing = true; this.#startLoop(); }
    deactivate() { this.playing = false; cancelAnimationFrame(this.#raf); }
    isDirty() { return this.docs.some((d) => !d.demo && M.isDirty(d)); }
    dirtyLabel() { return "Partículas"; }

    async onProject(project) {
      this.project = project;
      if (this.isDirty()) {
        this.studio.toast("Hay efectos sin guardar: los mantengo.", { kind: "warn" });
        return;
      }
      await this.studio.busy(this.#load());
    }

    async #load() {
      const fromDisk = this.project ? await M.loadFiles(this.project) : [];
      if (fromDisk.length) {
        this.docs = fromDisk;
        this.usingDemo = false;
      } else {
        this.docs = M.loadDemoDocs();
        this.usingDemo = true;
      }
      this.texturePaths = this.project ? M.listTextures(this.project) : [];
      this.textures.clear();
      for (const doc of this.docs) {
        const tex = doc.fx?.texture || doc.data.texture;
        if (tex) await this.#ensureTexture(tex);
      }
      this.sel = Math.min(this.sel, Math.max(0, this.docs.length - 1));
      this.#restart();
      this.#renderAll();
      this.studio.setStatus(
        this.usingDemo
          ? `${this.docs.length} demos (no hay Data/Particles en el proyecto)`
          : `${this.docs.length} efecto(s) · ${this.texturePaths.length} texturas`,
        this.usingDemo ? "warn" : "ok",
      );
    }

    #current() { return this.docs[this.sel] || null; }
    #fx() {
      const doc = this.#current();
      if (!doc) return null;
      if (!doc.fx) doc.fx = M.compile(doc.data, doc.fileId);
      return doc.fx;
    }
    #docById(id) {
      const bare = M.bareId(id);
      return this.docs.find((d) => M.bareId(d.data.id || d.fileId) === bare || d.fileId === bare);
    }

    async #ensureTexture(path) {
      if (!path || !this.project) return null;
      const key = path.replace(/\\/g, "/").replace(/\.png$/i, "");
      if (this.textures.has(key)) return this.textures.get(key);
      const lower = key.toLowerCase();
      const base = lower.split("/").pop();
      let entry =
        (typeof this.project.pngOf === "function" && (this.project.pngOf(key) || this.project.pngOf(key + ".png"))) ||
        this.project.get?.(key + ".png") ||
        this.project.get?.(key) ||
        this.project.find((e) => {
          const p = e.lower.replace(/\\/g, "/");
          if (!p.endsWith(".png")) return false;
          if (p === lower + ".png" || p.endsWith("/" + base + ".png")) return true;
          return p.includes(lower) || p.endsWith(base + ".png");
        });
      if (!entry) {
        console.warn("[particles] texture not found:", path);
        return null;
      }
      try {
        const file = await entry.handle.getFile();
        const buf = await file.arrayBuffer();
        return this.#pngToImage(key, buf);
      } catch {
        return null;
      }
    }

    async #pngToImage(key, buf) {
      try {
        const blob = new Blob([buf], { type: "image/png" });
        const url = URL.createObjectURL(blob);
        const im = await new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = url;
        });
        this.textures.set(key, im);
        return im;
      } catch {
        try {
          if (decodePng) {
            const img = await decodePng(new Blob([buf]));
            const c = document.createElement("canvas");
            c.width = img.width; c.height = img.height;
            const rgba = img.data || img.rgba;
            c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), img.width, img.height), 0, 0);
            this.textures.set(key, c);
            return c;
          }
        } catch { /* */ }
        return null;
      }
    }

    #buildLayout() {
      this.root = h("div", { class: "fx" });
      this.listEl = h("div", { class: "fx-list" });
      this.canvas = h("canvas", { class: "fx-canvas" });
      this.inspEl = h("div", { class: "fx-insp" });
      this.saveBtn = h("button", { class: "primary", disabled: true, onclick: () => this.save() }, "Guardar");
      this.playBtn = h("button", {
        onclick: () => { this.playing = !this.playing; this.#syncToolbar(); if (this.playing) this.#startLoop(); },
      }, "❚❚ Pausa");
      this.loopBtn = h("button", { class: "on", onclick: () => { this.loop = !this.loop; this.#syncToolbar(); } }, "Loop");
      this.banner = h("div", { class: "fx-banner" });
      this.root.append(
        h("div", { class: "fx-side" },
          h("div", { class: "fx-head" },
            h("span", null, "Efectos"),
            h("span", { style: "flex:1" }),
            h("button", { class: "primary", onclick: () => this.#addEffect() }, "+ Nuevo"),
          ),
          h("input", {
            type: "search", class: "fx-search", placeholder: "Buscar…",
            oninput: (e) => { this.query = e.target.value; this.#renderList(); },
          }),
          this.listEl,
        ),
        h("div", { class: "fx-stage" },
          this.banner,
          h("div", { class: "fx-toolbar" },
            this.playBtn, this.loopBtn,
            h("button", { onclick: () => this.#restart() }, "Reiniciar"),
            h("span", { style: "flex:1" }),
            this.saveBtn,
          ),
          h("div", { class: "fx-view" }, this.canvas),
        ),
        h("div", { class: "fx-panel" },
          h("div", { class: "fx-head" }, "Inspector"),
          this.inspEl,
        ),
      );
      return this.root;
    }

    #syncToolbar() {
      this.playBtn.textContent = this.playing ? "❚❚ Pausa" : "▶ Play";
      this.loopBtn.classList.toggle("on", this.loop);
      this.saveBtn.disabled = !this.isDirty();
      if (this.banner) {
        this.banner.textContent = this.usingDemo
          ? "Modo demo — abre la carpeta Content del juego para editar Data/Particles"
          : "";
        this.banner.hidden = !this.usingDemo;
      }
    }

    #renderAll() {
      this.#renderList();
      this.#renderInsp();
      this.#syncToolbar();
      this.#resizeCanvas();
    }

    #renderList() {
      clear(this.listEl);
      const q = this.query.trim().toLowerCase();
      const list = this.docs.filter((d) => {
        const id = M.bareId(d.data.id || d.fileId);
        return !q || id.includes(q);
      });
      if (!list.length) {
        this.listEl.append(h("div", { class: "empty-state" }, "Sin efectos."));
        return;
      }
      for (const doc of list) {
        const i = this.docs.indexOf(doc);
        this.listEl.append(h("div", {
          class: ["fx-item", i === this.sel && "on"],
          onclick: () => { this.sel = i; this.#restart(); this.#renderAll(); },
        },
          h("span", { class: "name" }, M.bareId(doc.data.id || doc.fileId)),
          doc.demo ? h("span", { class: "fx-tag" }, "demo") : null,
          !doc.demo && M.isDirty(doc) ? h("span", { class: "dot" }) : null,
        ));
      }
    }

    #touch(label) {
      const doc = this.#current();
      if (!doc) return;
      doc.fx = M.compile(doc.data, doc.fileId);
      this.#renderInsp();
      this.#renderList();
      this.#syncToolbar();
      if (label) this.studio.setStatus(label + " · " + M.bareId(doc.data.id || doc.fileId), "ok");
    }


    #rgbaRow(label, arr, onChange) {
      const a = Array.isArray(arr) ? arr.slice(0, 4) : [255, 255, 255, 255];
      while (a.length < 4) a.push(255);
      const mk = (i, name, max = 255) => slider({
        label: name, min: 0, max, step: 1, value: a[i] | 0,
        onInput: (v) => {
          const next = a.slice();
          next[i] = v | 0;
          onChange(next);
        },
      }).el;
      return h("div", { class: "fx-rgba" },
        h("div", { class: "fx-pair-label" }, label),
        h("div", {
          class: "fx-swatch",
          style: { background: `rgba(${a[0]},${a[1]},${a[2]},${(a[3]/255).toFixed(3)})` },
        }),
        mk(0, "R"), mk(1, "G"), mk(2, "B"), mk(3, "A"),
      );
    }

    #renderInsp() {
      clear(this.inspEl);
      const doc = this.#current();
      if (!doc) {
        this.inspEl.append(h("div", { class: "empty-state" }, "Selecciona un efecto."));
        return;
      }
      const d = doc.data;
      d.emission = d.emission || { type: "burst", count: [4, 8] };
      d.spawn = d.spawn || {};
      d.behaviors = d.behaviors || {};
      d.render = d.render || {};
      const em = d.emission, sp = d.spawn, bh = d.behaviors;
      const field = (label, el) => h("div", { class: "field" }, h("label", null, label), el);

      const texOpts = [["", "— ninguna —"], ...this.texturePaths.map((p) => [p, p.split("/").slice(-2).join("/")])];
      const texVal = (d.texture || "").replace(/\.png$/i, "");

      this.inspEl.append(
        h("div", { class: "at-sub" }, "Identidad"),
        field("Id (archivo)", h("div", { class: "ctl-ro" }, doc.fileId || M.bareId(d.id))),
        select({
          label: "Textura",
          value: texOpts.some(([v]) => v === texVal) ? texVal : "",
          options: texOpts,
          onChange: async (v) => {
            d.texture = v; if (v) await this.#ensureTexture(v);
            this.#touch("Textura"); this.#restart();
          },
        }).el,
        field("Ruta", h("input", {
          type: "text", value: d.texture || "", placeholder: "Assets/Effects/Smoke/Smoke_3",
          onchange: async (e) => {
            d.texture = e.target.value.trim();
            if (d.texture) await this.#ensureTexture(d.texture);
            this.#touch("Textura"); this.#restart();
          },
        })),

        h("div", { class: "at-sub" }, "Emisión"),
        select({
          label: "Modo",
          value: em.type || "burst",
          options: [["burst", "Ráfaga"], ["continuous", "Continua"], ["interval", "Intervalo"]],
          onChange: (v) => { em.type = v; this.#touch("Emisión"); this.#restart(); },
        }).el,
        slider({
          label: "Burst min", min: 1, max: 80, step: 1,
          value: Array.isArray(em.count) ? em.count[0] : 1,
          onInput: (v) => {
            const mx = Array.isArray(em.count) ? em.count[1] : v;
            em.count = [v, Math.max(v, mx)]; this.#touch("Burst");
          },
        }).el,
        slider({
          label: "Burst max", min: 1, max: 80, step: 1,
          value: Array.isArray(em.count) ? em.count[1] : 1,
          onInput: (v) => {
            const mn = Array.isArray(em.count) ? em.count[0] : 1;
            em.count = [Math.min(mn, v), v]; this.#touch("Burst");
          },
        }).el,
        slider({
          label: "Rate", min: 1, max: 60, step: 1, value: em.rate ?? 20,
          onInput: (v) => { em.rate = v; this.#touch("Rate"); },
        }).el,

        h("div", { class: "at-sub" }, "Spawn"),
        select({
          label: "Forma",
          value: sp.shape || (sp.positionOffset ? "box" : "sphere"),
          options: [["point", "Punto"], ["sphere", "Esfera"], ["hemisphere", "Hemisferio"],
            ["ring", "Anillo"], ["cone", "Cono"], ["box", "Caja"]],
          onChange: (v) => { sp.shape = v; this.#touch("Forma"); },
        }).el,
        slider({
          label: "Radio", min: 0, max: 3, step: 0.05, value: sp.radius ?? 0.2,
          onInput: (v) => { sp.radius = v; this.#touch("Radio"); },
        }).el,

        h("div", { class: "at-sub" }, "Partícula"),
        slider({
          label: "Vida min", min: 0.05, max: 12, step: 0.05,
          value: Array.isArray(d.lifetime) ? d.lifetime[0] : 1,
          onInput: (v) => {
            const mx = Array.isArray(d.lifetime) ? d.lifetime[1] : v;
            d.lifetime = [v, Math.max(v, mx)]; this.#touch("Vida");
          },
        }).el,
        slider({
          label: "Vida max", min: 0.05, max: 12, step: 0.05,
          value: Array.isArray(d.lifetime) ? d.lifetime[1] : 1,
          onInput: (v) => {
            const mn = Array.isArray(d.lifetime) ? d.lifetime[0] : 0.05;
            d.lifetime = [Math.min(mn, v), v]; this.#touch("Vida");
          },
        }).el,
        slider({
          label: "Escala min", min: 0.02, max: 2, step: 0.01,
          value: Array.isArray(d.scale) ? (Array.isArray(d.scale[0]) ? Math.min(d.scale[0][0], d.scale[0][1]) : d.scale[0]) : 0.2,
          onInput: (v) => {
            const cur = Array.isArray(d.scale) && !Array.isArray(d.scale[0]) ? d.scale : [0.2, 0.5];
            d.scale = [v, Math.max(v, cur[1] ?? v)]; this.#touch("Escala");
          },
        }).el,
        slider({
          label: "Escala max", min: 0.02, max: 2, step: 0.01,
          value: Array.isArray(d.scale) ? (Array.isArray(d.scale[0]) ? Math.max(d.scale[0][0], d.scale[0][1]) : d.scale[1]) : 0.5,
          onInput: (v) => {
            const cur = Array.isArray(d.scale) && !Array.isArray(d.scale[0]) ? d.scale : [0.2, 0.5];
            d.scale = [Math.min(cur[0] ?? 0.02, v), v]; this.#touch("Escala");
          },
        }).el,
        slider({
          label: "Gravedad Y", min: -25, max: 5, step: 0.1,
          value: Array.isArray(bh.gravity) ? bh.gravity[1] : -9.8,
          onInput: (v) => {
            bh.gravity = Array.isArray(bh.gravity) ? [bh.gravity[0], v, bh.gravity[2]] : [0, v, 0];
            this.#touch("Gravedad");
          },
        }).el,
        slider({
          label: "Drag (pow)", min: 0.01, max: 1, step: 0.01, value: bh.drag ?? 1,
          onInput: (v) => { bh.drag = v; this.#touch("Drag"); },
        }).el,
        checkbox({
          label: "Alinear a velocidad",
          value: !!d.render.alignToVelocity,
          onChange: (v) => { d.render.alignToVelocity = v; this.#touch("Alinear"); },
        }).el,

        h("div", { class: "at-sub" }, "Color / render"),
        this.#rgbaRow("Tint base", d.render.tint || [255, 255, 255, 255], (c) => {
          d.render.tint = c;
          this.#touch("Tint");
          this.#restart();
        }),
        select({
          label: "Lighting",
          value: d.render.lighting === "emissive" ? "emissive" : "lit",
          options: [["lit", "Lit (luz mundo)"], ["emissive", "Emissive"]],
          onChange: (v) => { d.render.lighting = v; this.#touch("Lighting"); },
        }).el,
        this.#rgbaRow("ColorCurve start", (bh.colorCurve && bh.colorCurve.start) || (d.render.tint || [255, 255, 255, 255]), (c) => {
          bh.colorCurve = bh.colorCurve || {};
          bh.colorCurve.start = c;
          if (!bh.colorCurve.mid) bh.colorCurve.mid = c.slice();
          if (!bh.colorCurve.end) bh.colorCurve.end = [c[0], c[1], c[2], 0];
          this.#touch("Color start");
        }),
        this.#rgbaRow("ColorCurve mid", (bh.colorCurve && bh.colorCurve.mid) || [255, 180, 80, 220], (c) => {
          bh.colorCurve = bh.colorCurve || {};
          bh.colorCurve.mid = c;
          this.#touch("Color mid");
        }),
        this.#rgbaRow("ColorCurve end", (bh.colorCurve && bh.colorCurve.end) || [40, 20, 10, 0], (c) => {
          bh.colorCurve = bh.colorCurve || {};
          bh.colorCurve.end = c;
          this.#touch("Color end");
        }),
        h("button", {
          class: "ghost",
          onclick: () => { delete bh.colorCurve; this.#touch("Sin colorCurve"); this.#restart(); },
        }, "Quitar colorCurve"),

        h("div", { class: "at-sub" }, "Física extra"),
        slider({
          label: "Wind", min: 0, max: 3, step: 0.05, value: bh.wind ?? 0,
          onInput: (v) => { bh.wind = v; this.#touch("Wind"); },
        }).el,
        slider({
          label: "Angular vel min", min: -12, max: 12, step: 0.1,
          value: Array.isArray(d.angularVelocity) ? d.angularVelocity[0] : 0,
          onInput: (v) => {
            const mx = Array.isArray(d.angularVelocity) ? d.angularVelocity[1] : v;
            d.angularVelocity = [v, Math.max(v, mx)];
            this.#touch("Ang");
          },
        }).el,
        slider({
          label: "Angular vel max", min: -12, max: 12, step: 0.1,
          value: Array.isArray(d.angularVelocity) ? d.angularVelocity[1] : 0,
          onInput: (v) => {
            const mn = Array.isArray(d.angularVelocity) ? d.angularVelocity[0] : 0;
            d.angularVelocity = [Math.min(mn, v), v];
            this.#touch("Ang");
          },
        }).el,
        select({
          label: "Collision",
          value: (bh.collision && bh.collision.mode) || "none",
          options: [["none", "Ninguna"], ["bounce", "Bounce"], ["kill", "Kill"]],
          onChange: (v) => {
            if (v === "none") bh.collision = { mode: "none" };
            else bh.collision = { mode: v, bounciness: bh.collision?.bounciness ?? 0.5, friction: bh.collision?.friction ?? 0.3 };
            this.#touch("Collision");
          },
        }).el,
        slider({
          label: "Bounciness", min: 0, max: 1, step: 0.05,
          value: bh.collision?.bounciness ?? 0.5,
          onInput: (v) => {
            bh.collision = bh.collision || { mode: "bounce" };
            bh.collision.bounciness = v;
            this.#touch("Bounce");
          },
        }).el,
        checkbox({
          label: "Essential (no se reduce con calidad)",
          value: !!d.essential,
          onChange: (v) => { d.essential = v; this.#touch("Essential"); },
        }).el,

        h("div", { class: "at-sub" }, "Curvas"),
        this.#curveEditor("Alpha", "alphaCurve", bh),
        this.#curveEditor("Escala", "scaleCurve", bh),

        h("div", { class: "at-sub" }, "Sub-emisores / trail"),
        this.#subsSection(d),
        h("p", { class: "note" },
          "Formato idéntico al juego (ParticleEffectRegistry). ",
          "Drag usa Pow(drag, dt) como en C#. Escala × 16 px (ReferenceUnitSize)."),
      );
      this.inspEl.querySelectorAll(".fx-curve").forEach((wrap, idx) => {
        const key = idx === 0 ? "alphaCurve" : "scaleCurve";
        const c = Array.isArray(bh[key]) ? bh[key] : [1, 1, 0.5, 0];
        const cv = wrap.querySelector("canvas");
        if (cv) this.#drawCurvePreview(cv, c);
      });
    }

    #curveEditor(label, key, bh) {
      let c = Array.isArray(bh[key]) && bh[key].length >= 4 ? bh[key].slice(0, 4) : [1, 1, 0.5, 0];
      const set = (i, v) => {
        c = c.slice(); c[i] = v; bh[key] = c; this.#touch(label);
      };
      return h("div", { class: "fx-curve" },
        h("div", { class: "fx-pair-label" }, label),
        h("div", { class: "fx-curve-rows" },
          [0, 1, 2, 3].map((i) => slider({
            label: String(i + 1), min: 0, max: 2.5, step: 0.05, value: c[i] ?? 0,
            onInput: (v) => set(i, v),
          }).el),
        ),
        h("canvas", { class: "fx-curve-preview", width: 220, height: 36 }),
      );
    }

    #drawCurvePreview(canvas, c) {
      const ctx = canvas.getContext("2d");
      const w = canvas.width, ht = canvas.height;
      ctx.clearRect(0, 0, w, ht);
      ctx.strokeStyle = "rgba(110,207,154,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = 0; x <= w; x++) {
        const y = M.evalCurve(c, x / w);
        const py = ht - 4 - Math.max(0, Math.min(2, y)) / 2 * (ht - 8);
        if (x === 0) ctx.moveTo(x, py); else ctx.lineTo(x, py);
      }
      ctx.stroke();
    }

    #subsSection(d) {
      d.subEmitters = d.subEmitters || [];
      const opts = [["", "—"], ...this.docs.map((doc) => {
        const id = M.bareId(doc.data.id || doc.fileId);
        return [id, id];
      })];
      const rows = d.subEmitters.map((s, i) => h("div", { class: "fx-sub" },
        select({
          label: "Evento", value: s.event || "death",
          options: [["spawn", "Spawn"], ["death", "Death"], ["collision", "Collision"]],
          onChange: (v) => { s.event = v; this.#touch("Sub"); },
        }).el,
        select({
          label: "Efecto", value: M.bareId(s.effect || ""),
          options: opts, onChange: (v) => { s.effect = v; this.#touch("Sub"); },
        }).el,
        slider({
          label: "Chance", min: 0, max: 1, step: 0.05, value: s.chance ?? 1,
          onInput: (v) => { s.chance = v; this.#touch("Chance"); },
        }).el,
        h("button", { class: "ghost", onclick: () => { d.subEmitters.splice(i, 1); this.#touch("Quitar"); } }, "Quitar"),
      ));
      // trail
      const trail = d.trail || { effect: "", rate: 30 };
      return h("div", null,
        ...rows,
        h("button", {
          class: "primary",
          onclick: () => { d.subEmitters.push({ event: "death", effect: "", chance: 1 }); this.#touch("Sub+"); },
        }, "+ Sub-emisor"),
        h("div", { class: "at-sub" }, "Trail"),
        select({
          label: "Efecto trail",
          value: M.bareId(trail.effect || ""),
          options: opts,
          onChange: (v) => {
            if (!v) d.trail = null;
            else d.trail = { effect: v, rate: trail.rate || 30 };
            this.#touch("Trail");
          },
        }).el,
        slider({
          label: "Rate trail", min: 1, max: 60, step: 1, value: trail.rate || 30,
          onInput: (v) => {
            if (d.trail) d.trail.rate = v;
            else d.trail = { effect: trail.effect || "", rate: v };
            this.#touch("Trail rate");
          },
        }).el,
      );
    }

    #addEffect() {
      if (!this.project || this.usingDemo) {
        this.studio.toast("Abre Content del juego (con Data/Particles) para crear efectos nuevos.", { kind: "warn" });
        return;
      }
      const id = "efecto_" + (this.docs.length + 1);
      const data = M.defaults(id);
      const dir = M.particlesDir(this.project, this.docs);
      const doc = {
        entry: null, path: joinPath(dir, id + ".json"), name: id + ".json", fileId: id,
        data, baseline: "", isNew: true, error: null, fx: M.compile(data, id),
      };
      this.docs.push(doc);
      this.sel = this.docs.length - 1;
      this.#restart();
      this.#renderAll();
    }

    async save() {
      const dirty = this.docs.filter((d) => !d.demo && M.isDirty(d));
      if (!dirty.length) return;
      let n = 0;
      for (const doc of dirty) {
        if (!doc.entry?.handle) {
          this.studio.toast(`«${doc.name}» es nuevo: créalo en Data/Particles y reabre el proyecto.`, { kind: "warn" });
          continue;
        }
        await writeHandle(doc.entry.handle, M.serialize(doc.data));
        doc.baseline = M.serialize(doc.data);
        doc.isNew = false;
        doc.fx = M.compile(doc.data, doc.fileId);
        n++;
      }
      this.#renderAll();
      if (n) this.studio.toast(`Guardados ${n} efecto(s).`, { kind: "ok" });
    }

    #restart() {
      this.#particles = [];
      this.#emitAcc = 0;
      this.#burstOnce = false;
      this.#emitterAge = 0;
    }

    #resizeCanvas() {
      const view = this.canvas?.parentElement;
      if (!view || !this.canvas) return;
      const w = view.clientWidth | 0, ht = view.clientHeight | 0;
      if (w < 8 || ht < 8) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(ht * dpr);
      this.canvas.style.width = w + "px";
      this.canvas.style.height = ht + "px";
      this._dpr = dpr;
      this._cssW = w;
      this._cssH = ht;
    }

    #startLoop() {
      cancelAnimationFrame(this.#raf);
      let last = performance.now();
      const tick = (now) => {
        this.#raf = requestAnimationFrame(tick);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (this.playing) this.#step(dt);
        this.#draw();
      };
      this.#raf = requestAnimationFrame(tick);
      if (this.canvas.parentElement) {
        new ResizeObserver(() => this.#resizeCanvas()).observe(this.canvas.parentElement);
      }
    }

    #rand(a, b) { return a + Math.random() * ((b ?? a) - a); }

    #spawnParticles(fx, origin, count) {
      if (!fx || count <= 0) return;
      for (let i = 0; i < count; i++) {
        if (this.#particles.length >= fx.maxParticles) return;
        const off = M.sampleSpawn(fx);
        const ox = origin ? origin.x : 0;
        const oy = origin ? origin.y : 0;
        const oz = origin ? origin.z : 0;
        const p = {
          x: ox + off[0], y: oy + off[1], z: oz + off[2],
          vx: this.#rand(fx.velMin[0], fx.velMax[0]),
          vy: this.#rand(fx.velMin[1], fx.velMax[1]),
          vz: this.#rand(fx.velMin[2], fx.velMax[2]),
          age: 0,
          life: this.#rand(fx.lifetime[0], fx.lifetime[1]),
          rot: this.#rand(fx.rotation[0], fx.rotation[1]),
          ang: this.#rand(fx.angularVelocity[0], fx.angularVelocity[1]),
          baseScale: [
            this.#rand(fx.scaleX[0], fx.scaleX[1]),
            this.#rand(fx.scaleY[0], fx.scaleY[1]),
          ],
          tint: (fx.tint || [255, 255, 255, 255]).slice(),
          baseTint: (fx.tint || [255, 255, 255, 255]).slice(),
          fxId: fx.id,
          tex: fx.texture,
          trailTimer: 0,
          resting: false,
        };
        this.#particles.push(p);
        // spawn sub-emitters
        this.#triggerSubs(fx, p, "spawn");
      }
    }

    #triggerSubs(fx, p, event) {
      for (const s of fx.subEmitters || []) {
        if (s.event !== event) continue;
        if (Math.random() > (s.chance ?? 1)) continue;
        const subDoc = this.#docById(s.effect);
        if (!subDoc) continue;
        const sub = subDoc.fx || M.compile(subDoc.data, subDoc.fileId);
        const count = s.count > 0 ? s.count : this.#rand(sub.burst[0], sub.burst[1]) | 0;
        this.#spawnParticles(sub, p, Math.max(1, count | 0));
      }
    }

    #step(dt) {
      const fx = this.#fx();
      if (!fx) return;
      this.#emitterAge += dt;

      if (fx.emission === "continuous") {
        this.#emitAcc += (fx.rate || 10) * dt;
        const whole = this.#emitAcc | 0;
        if (whole > 0) {
          this.#emitAcc -= whole;
          this.#spawnParticles(fx, null, whole);
        }
      } else if (fx.emission === "interval") {
        // simple: burst every interval
        if (!this.#burstOnce) {
          this.#spawnParticles(fx, null, this.#rand(fx.burst[0], fx.burst[1]) | 0);
          this.#burstOnce = true;
          this._nextInterval = fx.interval || 1;
        } else if (this.#emitterAge >= (this._nextInterval || 1)) {
          this.#spawnParticles(fx, null, this.#rand(fx.burst[0], fx.burst[1]) | 0);
          this._nextInterval = this.#emitterAge + (fx.interval || 1);
        }
      } else if (!this.#burstOnce) {
        this.#spawnParticles(fx, null, this.#rand(fx.burst[0], fx.burst[1]) | 0);
        this.#burstOnce = true;
      } else if (this.loop && this.#particles.length === 0) {
        this.#burstOnce = false;
        this.#emitterAge = 0;
      }

      const next = [];
      for (const p of this.#particles) {
        p.age += dt;
        if (p.age >= p.life) {
          const parent = this.#docById(p.fxId)?.fx || fx;
          this.#triggerSubs(parent, p, "death");
          continue;
        }
        const parent = this.#docById(p.fxId)?.fx || fx;

        if (!p.resting) {
          // Gravity
          if (parent.gravity) {
            p.vx += parent.gravity[0] * dt;
            p.vy += parent.gravity[1] * dt;
            p.vz += parent.gravity[2] * dt;
          }
          // Drag: Velocity *= Pow(drag, dt)  — C# ParticleSystem
          if (parent.drag != null && parent.drag > 0) {
            const f = Math.pow(parent.drag, dt);
            p.vx *= f; p.vy *= f; p.vz *= f;
          }
          // Soft wind (preview): constant +X bias
          if (parent.wind) {
            p.vx += parent.wind * 0.5 * dt;
          }
          if (parent.maxSpeed != null) {
            const sp = Math.hypot(p.vx, p.vy, p.vz);
            if (sp > parent.maxSpeed) {
              const s = parent.maxSpeed / sp;
              p.vx *= s; p.vy *= s; p.vz *= s;
            }
          }

          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.z += p.vz * dt;

          // Ground plane collision (y = 0) when bounce/kill configured
          if (parent.collision && parent.collision.mode !== "none" && p.y < this.#groundY) {
            p.y = this.#groundY;
            if (parent.collision.mode === "kill") {
              this.#triggerSubs(parent, p, "collision");
              continue;
            }
            const bounce = parent.collision.bounciness ?? 0.5;
            const friction = Math.max(0, Math.min(1, 1 - (parent.collision.friction ?? 0)));
            p.vy = -p.vy * bounce;
            p.vx *= friction;
            p.vz *= friction;
            if (Math.hypot(p.vx, p.vy, p.vz) < 0.05) {
              p.vx = p.vy = p.vz = 0;
              p.resting = true;
            }
            this.#triggerSubs(parent, p, "collision");
          }
        }

        p.rot += p.ang * dt;
        if (parent.alignToVelocity && (p.vx * p.vx + p.vz * p.vz + p.vy * p.vy) > 0.0001) {
          // screen-ish angle from velocity
          p.rot = Math.atan2(-p.vy * 0.5 - (p.vx + p.vz) * 0.25, (p.x !== undefined ? p.vx - p.vz : p.vx));
        }

        // Trail
        if (parent.trail && parent.trail.effect) {
          p.trailTimer += dt;
          const interval = 1 / Math.max(parent.trail.rate, 0.001);
          let spawns = 0;
          while (p.trailTimer >= interval && spawns < 6) {
            p.trailTimer -= interval;
            spawns++;
            const trailDoc = this.#docById(parent.trail.effect);
            if (trailDoc) {
              const tf = trailDoc.fx || M.compile(trailDoc.data, trailDoc.fileId);
              this.#spawnParticles(tf, p, 1);
            }
          }
        }

        next.push(p);
      }
      this.#particles = next;
    }

    #worldToScreen(x, y, z, cx, cy, unit) {
      // Iso-ish: same spirit as game projection for preview
      const sx = cx + (x - z) * unit * 0.7;
      const sy = cy - y * unit * 0.85 - (x + z) * unit * 0.22;
      return [sx, sy];
    }

    #draw() {
      const c = this.canvas;
      if (!c) return;
      const ctx = c.getContext("2d");
      const w = c.width, ht = c.height;
      const dpr = this._dpr || 1;
      ctx.clearRect(0, 0, w, ht);

      // floor grid
      const cx = w * 0.5, cy = ht * 0.62;
      const unit = Math.min(w, ht) / WORLD_VIEW;
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth = 1;
      for (let i = -6; i <= 6; i++) {
        const [x0, y0] = this.#worldToScreen(i, 0, -6, cx, cy, unit);
        const [x1, y1] = this.#worldToScreen(i, 0, 6, cx, cy, unit);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        const [a0, b0] = this.#worldToScreen(-6, 0, i, cx, cy, unit);
        const [a1, b1] = this.#worldToScreen(6, 0, i, cx, cy, unit);
        ctx.beginPath(); ctx.moveTo(a0, b0); ctx.lineTo(a1, b1); ctx.stroke();
      }

      const fx = this.#fx();
      const sorted = this.#particles.slice().sort((a, b) => (a.x + a.z) - (b.x + b.z) || a.y - b.y);

      for (const p of sorted) {
        const t = Math.min(1, p.age / p.life);
        const parent = this.#docById(p.fxId)?.fx || fx;
        const scMul = parent?.scaleCurve ? M.evalCurve(parent.scaleCurve, t) : 1;
        const alMul = parent?.alphaCurve ? M.evalCurve(parent.alphaCurve, t) : 1;
        let col = parent?.colorCurve ? M.evalColorCurve(parent.colorCurve, t) : p.baseTint.slice();
        if (!col) col = p.baseTint.slice();
        const alpha = Math.max(0, Math.min(1, (col[3] / 255) * alMul));

        const sizePx = Math.max(2, p.baseScale[0] * scMul * REF_UNIT * (unit / 16) * dpr);
        const [sx, sy] = this.#worldToScreen(p.x, p.y, p.z, cx, cy, unit);

        const texKey = (p.tex || parent?.texture || "").replace(/\.png$/i, "");
        const img = texKey && this.textures.get(texKey);

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(p.rot || 0);
        ctx.globalAlpha = alpha;
        if (img) {
          const iw = sizePx * (img.width / Math.max(img.height, 1));
          const ih = sizePx;
          const px = parent?.pivot?.[0] ?? 0.5;
          const py = parent?.pivot?.[1] ?? 0.5;
          ctx.drawImage(img, -iw * px, -ih * py, iw, ih);
        } else {
          ctx.fillStyle = `rgb(${col[0]|0},${col[1]|0},${col[2]|0})`;
          ctx.beginPath();
          ctx.arc(0, 0, sizePx * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // HUD
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(163,172,166,0.75)";
      ctx.font = `${12 * dpr}px system-ui`;
      ctx.textAlign = "left";
      const name = fx ? fx.id : "—";
      ctx.fillText(`${name} · ${this.#particles.length} partículas`, 12 * dpr, 20 * dpr);

      if (!fx) {
        ctx.textAlign = "center";
        ctx.fillText("Selecciona un efecto", w / 2, ht / 2);
      }
    }
  }

  Aura.particlesTool = { particlesTool };
})(window.Aura ??= {});
