"use strict";

// Partículas — tool nativo: Data/Particles, texturas Assets/Effects, curvas y sub-emisores.
(function (Aura) {
  const { h, clear } = Aura.dom;
  const { writeHandle, joinPath } = Aura.fs;
  const { slider, checkbox, select } = Aura.controls;
  const { decodePng } = Aura.png;
  const M = Aura.particlesModel;

  function particlesTool() {
    return new ParticlesTool();
  }

  class ParticlesTool {
    id = "particles";
    title = "Partículas";
    project = null;
    docs = [];
    texturePaths = [];
    textures = new Map(); // path key -> HTMLImageElement | ImageBitmap-like canvas
    sel = 0;
    query = "";
    playing = true;
    loop = true;
    #raf = 0;
    #particles = [];
    #emitAcc = 0;
    #burstOnce = false;
    #subQueue = []; // { fxId, delay }

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
          keys: ["Ctrl+N"], enabled: () => !!this.project, run: () => this.#addEffect(),
        },
      ], this.id);
      this.#renderAll();
      this.#startLoop();
    }

    activate() { this.playing = true; this.#startLoop(); }
    deactivate() { this.playing = false; cancelAnimationFrame(this.#raf); }
    isDirty() { return this.docs.some(M.isDirty); }
    dirtyLabel() { return "Partículas"; }

    async onProject(project) {
      this.project = project;
      if (this.isDirty()) {
        this.studio.toast("Carpeta releída. Hay efectos sin guardar: los mantengo.", { kind: "warn" });
        return;
      }
      await this.studio.busy(this.#load());
    }

    async #load() {
      this.docs = this.project ? await M.loadFiles(this.project) : [];
      this.texturePaths = this.project ? M.listTextures(this.project) : [];
      this.textures.clear();
      // preload textures referenced by effects
      for (const doc of this.docs) {
        const tex = doc.data.texture || doc.fx?.texture;
        if (tex) await this.#ensureTexture(tex);
      }
      this.sel = Math.min(this.sel, Math.max(0, this.docs.length - 1));
      this.#restart();
      this.#renderAll();
      this.studio.setStatus(
        this.docs.length
          ? `${this.docs.length} efecto(s) · ${this.texturePaths.length} texturas Effects`
          : "Sin efectos en Data/Particles · + Nuevo",
        "ok",
      );
    }

    #current() { return this.docs[this.sel] || null; }

    #fx() {
      const doc = this.#current();
      if (!doc) return null;
      if (!doc.fx) doc.fx = M.compile(doc.data);
      return doc.fx;
    }

    #docById(id) {
      const bare = M.bareId(id);
      return this.docs.find((d) => M.bareId(d.data.id) === bare || d.name.replace(/\.json$/i, "") === bare);
    }

    async #ensureTexture(path) {
      if (!path || !this.project) return null;
      const key = path.replace(/\\/g, "/").replace(/\.png$/i, "");
      if (this.textures.has(key)) return this.textures.get(key);
      // match project entry
      const lower = key.toLowerCase();
      const entry = this.project.find((e) => {
        const p = e.lower.replace(/\\/g, "/");
        return p.includes(lower) && p.endsWith(".png");
      });
      if (!entry) return null;
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
        if (decodePng) {
          const img = decodePng(buf);
          const c = document.createElement("canvas");
          c.width = img.width; c.height = img.height;
          c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
          this.textures.set(key, c);
          return c;
        }
      } catch { /* fall through */ }
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
        return null;
      }
    }

    #buildLayout() {
      this.root = h("div", { class: "fx" });
      this.listEl = h("div", { class: "fx-list" });
      this.canvas = h("canvas", { class: "fx-canvas" });
      this.inspEl = h("div", { class: "fx-insp" });
      this.saveBtn = h("button", { class: "primary", disabled: true, onclick: () => this.save() }, "Guardar");
      this.playBtn = h("button", { onclick: () => { this.playing = !this.playing; this.#syncToolbar(); if (this.playing) this.#startLoop(); } }, "❚❚ Pausa");
      this.loopBtn = h("button", { class: "on", onclick: () => { this.loop = !this.loop; this.#syncToolbar(); } }, "Loop");
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
    }

    #renderAll() {
      this.#renderList();
      this.#renderInsp();
      this.#syncToolbar();
      this.#resizeCanvas();
    }

    #renderList() {
      clear(this.listEl);
      if (!this.project) {
        this.listEl.append(h("div", { class: "empty-state" }, "Abre la carpeta del proyecto (Content)."));
        return;
      }
      const q = this.query.trim().toLowerCase();
      const list = this.docs.filter((d) => {
        const id = M.bareId(d.data.id || d.name);
        return !q || id.includes(q) || d.name.toLowerCase().includes(q);
      });
      if (!list.length) {
        this.listEl.append(h("div", { class: "empty-state" },
          this.docs.length ? "Ningún efecto coincide." : "Sin efectos en Data/Particles.",
          h("div", null, h("button", { class: "primary", onclick: () => this.#addEffect() }, "+ Primer efecto")),
        ));
        return;
      }
      for (const doc of list) {
        const i = this.docs.indexOf(doc);
        this.listEl.append(h("div", {
          class: ["fx-item", i === this.sel && "on"],
          onclick: () => { this.sel = i; this.#restart(); this.#renderAll(); },
        },
          h("span", { class: "name" }, M.bareId(doc.data.id || doc.name)),
          M.isDirty(doc) ? h("span", { class: "dot", title: "Sin guardar" }) : null,
        ));
      }
    }

    #touch(label) {
      const doc = this.#current();
      if (!doc) return;
      doc.fx = M.compile(doc.data);
      this.#renderInsp();
      this.#renderList();
      this.#syncToolbar();
      if (label) this.studio.setStatus(label + " · " + M.bareId(doc.data.id), "ok");
    }

    #ensureBehaviors(d) {
      d.behaviors = d.behaviors || {};
      return d.behaviors;
    }

    #ensureEmission(d) {
      d.emission = d.emission || { type: "burst", count: [8, 12], rate: 30 };
      return d.emission;
    }

    #ensureSpawn(d) {
      d.spawn = d.spawn || { shape: "sphere", radius: 0.35 };
      return d.spawn;
    }

    #curveEditor(label, key) {
      const d = this.#current()?.data;
      if (!d) return null;
      const bh = this.#ensureBehaviors(d);
      let c = Array.isArray(bh[key]) && bh[key].length >= 4 ? bh[key].slice() : [1, 1, 0.5, 0];
      const set = (i, v) => {
        c = c.slice();
        c[i] = v;
        bh[key] = c;
        this.#touch(label);
      };
      return h("div", { class: "fx-curve" },
        h("div", { class: "fx-pair-label" }, label + " (4 claves 0→1)"),
        h("div", { class: "fx-curve-rows" },
          [0, 1, 2, 3].map((i) => slider({
            label: String(i + 1), min: 0, max: 1.5, step: 0.05, value: c[i],
            onInput: (v) => set(i, v),
          }).el),
        ),
        h("canvas", { class: "fx-curve-preview", width: 200, height: 36, $ref: (el) => this.#drawCurvePreview(el, c) }),
      );
    }

    #drawCurvePreview(canvas, c) {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const w = canvas.width, ht = canvas.height;
      ctx.clearRect(0, 0, w, ht);
      ctx.strokeStyle = "rgba(110,207,154,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = 0; x <= w; x++) {
        const t = x / w;
        const y = M.evalCurve(c, t);
        const py = ht - 4 - Math.max(0, Math.min(1.2, y)) / 1.2 * (ht - 8);
        if (x === 0) ctx.moveTo(x, py); else ctx.lineTo(x, py);
      }
      ctx.stroke();
    }

    #renderInsp() {
      clear(this.inspEl);
      const doc = this.#current();
      if (!doc) {
        this.inspEl.append(h("div", { class: "empty-state" }, "Selecciona o crea un efecto."));
        return;
      }
      if (doc.error) {
        this.inspEl.append(h("div", { class: "empty-state" }, doc.error));
        return;
      }
      const d = doc.data;
      const em = this.#ensureEmission(d);
      const sp = this.#ensureSpawn(d);
      const bh = this.#ensureBehaviors(d);
      d.render = d.render || {};

      const field = (label, el) => h("div", { class: "field" }, h("label", null, label), el);

      // Texture options
      const texOpts = [["", "— ninguna —"], ...this.texturePaths.map((p) => [p, p.split("/").slice(-2).join("/")])];
      const texVal = (d.texture || "").replace(/\.png$/i, "");

      this.inspEl.append(
        h("div", { class: "at-sub" }, "Identidad"),
        field("Id", h("input", {
          type: "text", value: M.bareId(d.id),
          onchange: (e) => {
            d.id = "aura:" + e.target.value.trim().replace(/^aura:/, "");
            this.#touch("Id");
          },
        })),
        select({
          label: "Textura",
          value: texOpts.some(([v]) => v === texVal) ? texVal : "",
          options: texOpts,
          onChange: async (v) => {
            d.texture = v;
            if (v) await this.#ensureTexture(v);
            this.#touch("Textura");
            this.#restart();
          },
        }).el,
        field("O ruta", h("input", {
          type: "text", value: d.texture || "", placeholder: "Assets/Effects/Smoke/…",
          onchange: async (e) => {
            d.texture = e.target.value.trim();
            if (d.texture) await this.#ensureTexture(d.texture);
            this.#touch("Textura");
            this.#restart();
          },
        })),
        slider({
          label: "FPS sheet", min: 1, max: 60, step: 1, value: d.fps ?? 24,
          onInput: (v) => { d.fps = v; this.#touch("FPS"); },
        }).el,
        slider({
          label: "Frames", min: 1, max: 32, step: 1, value: d.frameCount ?? 1,
          onInput: (v) => { d.frameCount = v | 0; this.#touch("Frames"); },
        }).el,

        h("div", { class: "at-sub" }, "Emisión"),
        select({
          label: "Modo",
          value: em.type === "continuous" ? "continuous" : em.type === "interval" ? "interval" : "burst",
          options: [["burst", "Ráfaga"], ["continuous", "Continua"], ["interval", "Intervalo"]],
          onChange: (v) => { em.type = v; this.#touch("Emisión"); this.#restart(); },
        }).el,
        slider({
          label: "Burst min", min: 1, max: 64, step: 1,
          value: Array.isArray(em.count) ? em.count[0] : 8,
          onInput: (v) => {
            const mx = Array.isArray(em.count) ? em.count[1] : v;
            em.count = [v, Math.max(v, mx)];
            this.#touch("Burst");
          },
        }).el,
        slider({
          label: "Burst max", min: 1, max: 64, step: 1,
          value: Array.isArray(em.count) ? em.count[1] : 12,
          onInput: (v) => {
            const mn = Array.isArray(em.count) ? em.count[0] : 1;
            em.count = [Math.min(mn, v), v];
            this.#touch("Burst");
          },
        }).el,
        slider({
          label: "Rate", min: 1, max: 200, step: 1, value: em.rate ?? 30,
          onInput: (v) => { em.rate = v; this.#touch("Rate"); },
        }).el,

        h("div", { class: "at-sub" }, "Spawn"),
        select({
          label: "Forma",
          value: sp.shape || "sphere",
          options: [["point", "Punto"], ["sphere", "Esfera"], ["box", "Caja"], ["cone", "Cono"], ["hemisphere", "Hemisferio"]],
          onChange: (v) => { sp.shape = v; this.#touch("Forma"); },
        }).el,
        slider({
          label: "Radio", min: 0, max: 3, step: 0.05, value: sp.radius ?? 0.35,
          onInput: (v) => { sp.radius = v; this.#touch("Radio"); },
        }).el,

        h("div", { class: "at-sub" }, "Partícula"),
        slider({
          label: "Vida min", min: 0.05, max: 5, step: 0.05,
          value: Array.isArray(d.lifetime) ? d.lifetime[0] : 0.6,
          onInput: (v) => {
            const mx = Array.isArray(d.lifetime) ? d.lifetime[1] : v;
            d.lifetime = [v, Math.max(v, mx)];
            this.#touch("Vida");
          },
        }).el,
        slider({
          label: "Vida max", min: 0.05, max: 5, step: 0.05,
          value: Array.isArray(d.lifetime) ? d.lifetime[1] : 1.2,
          onInput: (v) => {
            const mn = Array.isArray(d.lifetime) ? d.lifetime[0] : 0.05;
            d.lifetime = [Math.min(mn, v), v];
            this.#touch("Vida");
          },
        }).el,
        slider({
          label: "Escala min", min: 0.02, max: 2, step: 0.02,
          value: Array.isArray(d.scale) ? (Array.isArray(d.scale[0]) ? d.scale[0][0] : d.scale[0]) : 0.2,
          onInput: (v) => {
            const mx = Array.isArray(d.scale) ? (Array.isArray(d.scale[0]) ? d.scale[0][1] : d.scale[1]) : v;
            d.scale = [v, Math.max(v, mx)];
            this.#touch("Escala");
          },
        }).el,
        slider({
          label: "Escala max", min: 0.02, max: 2, step: 0.02,
          value: Array.isArray(d.scale) ? (Array.isArray(d.scale[0]) ? d.scale[0][1] : d.scale[1]) : 0.35,
          onInput: (v) => {
            const mn = Array.isArray(d.scale) ? (Array.isArray(d.scale[0]) ? d.scale[0][0] : d.scale[0]) : 0.02;
            d.scale = [Math.min(mn, v), v];
            this.#touch("Escala");
          },
        }).el,
        slider({
          label: "Gravedad Y", min: -20, max: 5, step: 0.1,
          value: Array.isArray(bh.gravity) ? bh.gravity[1] : -2.5,
          onInput: (v) => {
            bh.gravity = Array.isArray(bh.gravity) ? [bh.gravity[0], v, bh.gravity[2]] : [0, v, 0];
            this.#touch("Gravedad");
          },
        }).el,
        slider({
          label: "Drag", min: 0, max: 2, step: 0.02, value: bh.drag ?? 0,
          onInput: (v) => { bh.drag = v; this.#touch("Drag"); },
        }).el,
        checkbox({
          label: "Alinear a velocidad",
          value: !!d.render.alignToVelocity,
          onChange: (v) => { d.render.alignToVelocity = v; this.#touch("Alinear"); },
        }).el,

        h("div", { class: "at-sub" }, "Curvas (vida 0→1)"),
        this.#curveEditor("Alpha", "alphaCurve"),
        this.#curveEditor("Escala", "scaleCurve"),

        h("div", { class: "at-sub" }, "Sub-emisores"),
        this.#subEmittersSection(d),

        h("p", { class: "note" },
          "JSON anidado como el juego (emission / spawn / behaviors / subEmitters). ",
          "Preview con textura si está en Assets/Effects."),
      );

      // draw curve previews after mount
      this.inspEl.querySelectorAll(".fx-curve").forEach((wrap, idx) => {
        const key = idx === 0 ? "alphaCurve" : "scaleCurve";
        const c = bh[key] || [1, 1, 0.5, 0];
        const cv = wrap.querySelector("canvas");
        if (cv) this.#drawCurvePreview(cv, c);
      });
    }

    #subEmittersSection(d) {
      d.subEmitters = d.subEmitters || [];
      const effectOpts = [
        ["", "— efecto —"],
        ...this.docs.map((doc) => {
          const id = M.bareId(doc.data.id || doc.name);
          return [id, id];
        }),
      ];
      const rows = d.subEmitters.map((s, i) => h("div", { class: "fx-sub" },
        select({
          label: "Evento",
          value: s.event || "death",
          options: [["spawn", "Al nacer"], ["death", "Al morir"], ["collision", "Colisión"]],
          onChange: (v) => { s.event = v; this.#touch("Sub"); },
        }).el,
        select({
          label: "Efecto",
          value: M.bareId(s.effect || ""),
          options: effectOpts,
          onChange: (v) => { s.effect = v; this.#touch("Sub"); },
        }).el,
        slider({
          label: "Chance", min: 0, max: 1, step: 0.05, value: s.chance ?? 1,
          onInput: (v) => { s.chance = v; this.#touch("Chance"); },
        }).el,
        slider({
          label: "Count", min: 0, max: 16, step: 1, value: s.count ?? 1,
          onInput: (v) => { s.count = v | 0; this.#touch("Count"); },
        }).el,
        h("button", {
          class: "ghost",
          onclick: () => { d.subEmitters.splice(i, 1); this.#touch("Quitar sub"); },
        }, "Quitar"),
      ));
      return h("div", null,
        ...rows,
        h("button", {
          class: "primary",
          onclick: () => {
            d.subEmitters.push({ event: "death", effect: "", chance: 1, count: 1 });
            this.#touch("Sub +");
          },
        }, "+ Sub-emisor"),
      );
    }

    #addEffect() {
      if (!this.project) {
        this.studio.toast("Abre la carpeta del proyecto primero.", { kind: "warn" });
        return;
      }
      const id = "efecto_" + (this.docs.length + 1);
      const data = M.defaults(id);
      const dir = M.particlesDir(this.project, this.docs) || "Assets/Data/Particles";
      const doc = {
        entry: null, path: joinPath(dir, id + ".json"), name: id + ".json",
        data, baseline: "", isNew: true, error: null, fx: M.compile(data),
      };
      this.docs.push(doc);
      this.sel = this.docs.length - 1;
      this.#restart();
      this.#renderAll();
    }

    async save() {
      const dirty = this.docs.filter(M.isDirty);
      if (!dirty.length) return;
      let n = 0;
      for (const doc of dirty) {
        const text = M.serialize(doc.data);
        if (!doc.entry?.handle) {
          this.studio.toast(
            `«${doc.name}» es nuevo: crea el archivo en Data/Particles y vuelve a abrir el proyecto, o guarda los existentes.`,
            { kind: "warn" },
          );
          continue;
        }
        await writeHandle(doc.entry.handle, text);
        doc.baseline = text;
        doc.isNew = false;
        doc.fx = M.compile(doc.data);
        n++;
      }
      this.#renderAll();
      if (n) this.studio.toast(`Guardados ${n} efecto(s).`, { kind: "ok" });
    }

    #restart() {
      this.#particles = [];
      this.#emitAcc = 0;
      this.#burstOnce = false;
      this.#subQueue = [];
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

    #spawnFromFx(fx, origin = null) {
      if (!fx) return;
      const life = this.#rand(fx.lifetime[0], fx.lifetime[1]);
      const sx = this.#rand(fx.scaleX[0], fx.scaleX[1]);
      const sy = this.#rand(fx.scaleY[0], fx.scaleY[1]);
      const r = fx.radius || 0.2;
      const ang = Math.random() * Math.PI * 2;
      const rad = fx.shape === "point" ? 0 : Math.random() * r;
      const ox = origin ? origin.x : 0;
      const oy = origin ? origin.y : 0;
      const oz = origin ? origin.z : 0;
      return {
        x: ox + Math.cos(ang) * rad,
        y: oy,
        z: oz + Math.sin(ang) * rad,
        vx: this.#rand(fx.velMin[0], fx.velMax[0]),
        vy: this.#rand(fx.velMin[1], fx.velMax[1]),
        vz: this.#rand(fx.velMin[2], fx.velMax[2]),
        age: 0, life,
        baseScale: [sx, sy],
        tint: (fx.tint || [255, 220, 140, 255]).slice(),
        fxId: fx.id,
        tex: fx.texture,
      };
    }

    #emitBurst(fx) {
      const n = Math.floor(this.#rand(fx.burst[0], fx.burst[1]));
      for (let i = 0; i < n && this.#particles.length < fx.maxParticles; i++) {
        this.#particles.push(this.#spawnFromFx(fx));
      }
      // spawn sub-emitters
      for (const s of fx.subEmitters || []) {
        if (s.event !== "spawn") continue;
        if (Math.random() > (s.chance ?? 1)) continue;
        const sub = this.#docById(s.effect)?.fx || (this.#docById(s.effect) && M.compile(this.#docById(s.effect).data));
        if (!sub) continue;
        for (let i = 0; i < (s.count || 1); i++) this.#particles.push(this.#spawnFromFx(sub));
      }
    }

    #step(dt) {
      const fx = this.#fx();
      if (!fx) return;

      if (fx.emission === "continuous") {
        this.#emitAcc += (fx.rate || 10) * dt;
        while (this.#emitAcc >= 1) {
          this.#emitAcc -= 1;
          if (this.#particles.length < fx.maxParticles) this.#particles.push(this.#spawnFromFx(fx));
        }
      } else if (!this.#burstOnce) {
        this.#emitBurst(fx);
        this.#burstOnce = true;
      } else if (this.loop && this.#particles.length === 0) {
        this.#burstOnce = false;
      }

      const gy = fx.gravity ? fx.gravity[1] : -2.5;
      const drag = fx.drag || 0;
      const next = [];
      for (const p of this.#particles) {
        p.age += dt;
        if (p.age >= p.life) {
          // death sub-emitters
          const parent = this.#docById(p.fxId)?.fx || fx;
          for (const s of parent.subEmitters || []) {
            if (s.event !== "death") continue;
            if (Math.random() > (s.chance ?? 1)) continue;
            const subDoc = this.#docById(s.effect);
            const sub = subDoc?.fx || (subDoc && M.compile(subDoc.data));
            if (!sub) continue;
            for (let i = 0; i < (s.count || 1); i++) next.push(this.#spawnFromFx(sub, p));
          }
          continue;
        }
        p.vy += gy * dt;
        const damp = Math.max(0, 1 - drag * dt);
        p.vx *= damp; p.vy *= damp; p.vz *= damp;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        next.push(p);
      }
      this.#particles = next;
    }

    #draw() {
      const c = this.canvas;
      if (!c) return;
      const ctx = c.getContext("2d");
      const w = c.width, ht = c.height;
      ctx.clearRect(0, 0, w, ht);
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(0, ht * 0.72, w, ht * 0.28);

      const fx = this.#fx();
      const cx = w * 0.5, cy = ht * 0.65;
      const scale = Math.min(w, ht) * 0.38;

      const sorted = this.#particles.slice().sort((a, b) => a.z - b.z);
      for (const p of sorted) {
        const t = Math.min(1, p.age / p.life);
        const parent = this.#docById(p.fxId)?.fx || fx;
        const scMul = parent?.scaleCurve ? M.evalCurve(parent.scaleCurve, t) : 1;
        const alMul = parent?.alphaCurve ? M.evalCurve(parent.alphaCurve, t) : (1 - t * 0.15);
        let col = parent?.colorCurve ? M.evalColorCurve(parent.colorCurve, t) : p.tint;
        if (!col) col = p.tint;
        const size = (p.baseScale[0] * scMul) * scale;
        const sx = cx + (p.x - p.z) * scale * 0.7;
        const sy = cy - p.y * scale * 0.7 - (p.x + p.z) * scale * 0.25;
        const alpha = Math.max(0, Math.min(1, (col[3] / 255) * alMul));

        const texKey = (p.tex || parent?.texture || "").replace(/\.png$/i, "");
        const img = texKey && this.textures.get(texKey);
        if (img) {
          ctx.save();
          ctx.globalAlpha = alpha;
          const iw = size * 1.2;
          ctx.drawImage(img, sx - iw / 2, sy - iw / 2, iw, iw);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.fillStyle = `rgba(${col[0]|0},${col[1]|0},${col[2]|0},${alpha})`;
          ctx.arc(sx, sy, Math.max(1.2, size * 0.45), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (!fx) {
        ctx.fillStyle = "rgba(163,172,166,0.7)";
        ctx.font = `${13 * (this._dpr || 1)}px system-ui`;
        ctx.textAlign = "center";
        ctx.fillText("Sin efecto seleccionado", w / 2, ht / 2);
      }
    }
  }

  Aura.particlesTool = { particlesTool };
})(window.Aura ??= {});
