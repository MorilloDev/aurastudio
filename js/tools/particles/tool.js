"use strict";

// Partículas: tool nativo — lista de efectos en Data/Particles, preview en canvas, inspector.
(function (Aura) {
  const { h, clear } = Aura.dom;
  const { writeHandle, joinPath, baseName } = Aura.fs;
  const { slider, checkbox, select, section } = Aura.controls;
  const M = Aura.particlesModel;

  function particlesTool() {
    return new ParticlesTool();
  }

  class ParticlesTool {
    id = "particles";
    title = "Partículas";
    project = null;
    docs = [];
    sel = 0;
    query = "";
    playing = true;
    loop = true;
    #raf = 0;
    #particles = [];
    #t0 = 0;
    #emitAcc = 0;
    #burstOnce = false;

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
      this.sel = Math.min(this.sel, Math.max(0, this.docs.length - 1));
      this.#particles = [];
      this.#renderAll();
      this.studio.setStatus(
        this.docs.length
          ? `${this.docs.length} efecto(s) en Data/Particles`
          : "Sin efectos · + Nuevo o abre un proyecto con Data/Particles",
        "ok",
      );
    }

    #current() {
      return this.docs[this.sel] || null;
    }

    #buildLayout() {
      this.root = h("div", { class: "fx" });
      this.listEl = h("div", { class: "fx-list" });
      this.canvas = h("canvas", { class: "fx-canvas" });
      this.inspEl = h("div", { class: "fx-insp" });
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
            h("button", {
              onclick: () => { this.playing = !this.playing; this.#renderToolbar(); if (this.playing) this.#startLoop(); },
            }, this.playing ? "❚❚ Pausa" : "▶ Play"),
            h("button", {
              onclick: () => { this.loop = !this.loop; this.#renderToolbar(); },
            }, "Loop"),
            h("button", { onclick: () => this.#restart() }, "Reiniciar"),
            h("span", { style: "flex:1" }),
            h("button", {
              class: "primary", disabled: true,
              onclick: () => this.save(),
            }, "Guardar"),
          ),
          h("div", { class: "fx-view" }, this.canvas),
        ),
        h("div", { class: "fx-panel" },
          h("div", { class: "fx-head" }, "Inspector"),
          this.inspEl,
        ),
      );
      this.saveBtn = this.root.querySelector(".fx-toolbar .primary");
      this.playBtn = this.root.querySelector(".fx-toolbar button");
      this.loopBtn = this.root.querySelectorAll(".fx-toolbar button")[1];
      return this.root;
    }

    #renderToolbar() {
      if (this.playBtn) this.playBtn.textContent = this.playing ? "❚❚ Pausa" : "▶ Play";
      if (this.loopBtn) this.loopBtn.classList.toggle("on", this.loop);
      if (this.saveBtn) this.saveBtn.disabled = !this.isDirty();
    }

    #renderAll() {
      this.#renderList();
      this.#renderInsp();
      this.#renderToolbar();
      this.#resizeCanvas();
    }

    #renderList() {
      clear(this.listEl);
      if (!this.project) {
        this.listEl.append(h("div", { class: "empty-state" }, "Abre la carpeta del proyecto (Content)."));
        return;
      }
      const q = this.query.trim().toLowerCase();
      const list = this.docs.filter((d) => !q || d.name.toLowerCase().includes(q) || (d.data.id || "").toLowerCase().includes(q));
      if (!list.length) {
        this.listEl.append(h("div", { class: "empty-state" },
          this.docs.length ? "Ningún efecto coincide." : "Sin efectos todavía.",
          h("div", null, h("button", { class: "primary", onclick: () => this.#addEffect() }, "+ Primer efecto")),
        ));
        return;
      }
      for (const doc of list) {
        const i = this.docs.indexOf(doc);
        this.listEl.append(h("div", {
          class: ["fx-item", i === this.sel && "on", M.isDirty(doc) && "dirty"],
          onclick: () => { this.sel = i; this.#restart(); this.#renderAll(); },
        },
          h("span", { class: "name" }, doc.data.id || doc.name),
          M.isDirty(doc) ? h("span", { class: "dot", title: "Sin guardar" }) : null,
        ));
      }
    }

    #edit(label, fn) {
      const doc = this.#current();
      if (!doc) return;
      fn(doc.data);
      this.#renderInsp();
      this.#renderList();
      this.#renderToolbar();
      this.studio.setStatus(`${label} · ${doc.data.id}`, "ok");
    }

    #num(label, key, min, max, step = 0.05) {
      const d = this.#current()?.data;
      if (!d) return null;
      const v = Array.isArray(d[key]) ? d[key][0] : (d[key] ?? 0);
      return slider({
        label, min, max, step, value: Number(v) || 0,
        onInput: (n) => this.#edit(label, (data) => {
          if (Array.isArray(data[key])) data[key] = [n, Math.max(n, data[key][1] ?? n)];
          else data[key] = n;
        }),
      }).el;
    }

    #rangePair(label, key, min, max, step = 0.05) {
      const d = this.#current()?.data;
      if (!d) return null;
      const arr = Array.isArray(d[key]) ? d[key] : [d[key] ?? 0, d[key] ?? 0];
      return h("div", { class: "fx-pair" },
        h("div", { class: "fx-pair-label" }, label),
        slider({
          label: "min", min, max, step, value: arr[0],
          onInput: (n) => this.#edit(label, (data) => {
            data[key] = [n, Math.max(n, (data[key] && data[key][1]) ?? n)];
          }),
        }).el,
        slider({
          label: "max", min, max, step, value: arr[1],
          onInput: (n) => this.#edit(label, (data) => {
            const a = data[key] || [0, 0];
            data[key] = [Math.min(a[0], n), n];
          }),
        }).el,
      );
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
      const field = (label, el) => h("div", { class: "field" }, h("label", null, label), el);

      this.inspEl.append(
        h("div", { class: "at-sub" }, "Identidad"),
        field("Id", h("input", {
          type: "text", value: d.id || "",
          onchange: (e) => this.#edit("Id", (x) => { x.id = e.target.value.trim() || x.id; }),
        })),
        field("Textura", h("input", {
          type: "text", value: d.texture || "", placeholder: "Assets/Effects/…",
          onchange: (e) => this.#edit("Textura", (x) => { x.texture = e.target.value.trim(); }),
        })),
        h("div", { class: "at-sub" }, "Emisión"),
        select({
          label: "Modo", value: d.emission || "burst",
          options: [["burst", "Ráfaga"], ["rate", "Continua"]],
          onChange: (v) => this.#edit("Emisión", (x) => { x.emission = v; }),
        }).el,
        this.#rangePair("Burst", "burst", 1, 64, 1),
        this.#num("Rate", "rate", 1, 200, 1),
        this.#num("Duración", "duration", -1, 10, 0.1),
        h("div", { class: "at-sub" }, "Forma"),
        select({
          label: "Shape", value: d.shape || "sphere",
          options: [["point", "Punto"], ["sphere", "Esfera"], ["box", "Caja"], ["cone", "Cono"]],
          onChange: (v) => this.#edit("Shape", (x) => { x.shape = v; }),
        }).el,
        this.#num("Radio", "radius", 0, 3, 0.05),
        h("div", { class: "at-sub" }, "Partícula"),
        this.#rangePair("Vida (s)", "lifetime", 0.05, 5, 0.05),
        this.#rangePair("Tamaño ini", "startSize", 0.02, 2, 0.02),
        this.#rangePair("Tamaño fin", "endSize", 0.02, 2, 0.02),
        slider({
          label: "Gravedad Y", min: -20, max: 5, step: 0.1,
          value: Array.isArray(d.gravity) ? d.gravity[1] : (d.gravity ?? -2.5),
          onInput: (n) => this.#edit("Gravedad", (x) => {
            x.gravity = Array.isArray(x.gravity) ? [x.gravity[0], n, x.gravity[2]] : [0, n, 0];
          }),
        }).el,
        checkbox({
          label: "Alinear a velocidad",
          value: !!d.alignToVelocity,
          onChange: (v) => this.#edit("Alinear", (x) => { x.alignToVelocity = v; }),
        }).el,
        h("p", { class: "note" },
          "Preview simplificado en el studio. El JSON se guarda como el juego lo lee en Data/Particles."),
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
        data, baseline: "", isNew: true, error: null,
      };
      this.docs.push(doc);
      this.sel = this.docs.length - 1;
      this.#restart();
      this.#renderAll();
      this.studio.setStatus("Efecto nuevo · guarda con Ctrl+S", "ok");
    }

    async save() {
      const dirty = this.docs.filter(M.isDirty);
      if (!dirty.length) return;
      for (const doc of dirty) {
        const text = M.serialize(doc.data);
        if (doc.isNew || !doc.entry) {
          // New file: need folder handle — write via project helper if available
          if (!doc.entry?.handle) {
            this.studio.toast(
              `«${doc.name}» es nuevo: créalo en ${doc.path} o guarda desde el sistema de archivos del proyecto.`,
              { kind: "warn" },
            );
            // Still mark baseline so UI settles when we can't write yet
            continue;
          }
          await writeHandle(doc.entry.handle, text);
        } else {
          await writeHandle(doc.entry.handle, text);
        }
        doc.baseline = text;
        doc.isNew = false;
      }
      this.#renderAll();
      this.studio.toast(`Guardados ${dirty.length} efecto(s).`, { kind: "ok" });
    }

    #restart() {
      this.#particles = [];
      this.#emitAcc = 0;
      this.#t0 = performance.now();
      this.#burstOnce = false;
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
      new ResizeObserver(() => this.#resizeCanvas()).observe(this.canvas.parentElement || this.root);
    }

    #rand(a, b) { return a + Math.random() * (b - a); }

    #spawnOne(d) {
      const life = Array.isArray(d.lifetime) ? this.#rand(d.lifetime[0], d.lifetime[1]) : (d.lifetime || 1);
      const ss = Array.isArray(d.startSize) ? this.#rand(d.startSize[0], d.startSize[1]) : 0.2;
      const es = Array.isArray(d.endSize) ? this.#rand(d.endSize[0], d.endSize[1]) : 0.05;
      const r = d.radius || 0.2;
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random() * r;
      const vx = Array.isArray(d.velMin) ? this.#rand(d.velMin[0], d.velMax?.[0] ?? d.velMin[0]) : 0;
      const vy = Array.isArray(d.velMin) ? this.#rand(d.velMin[1], d.velMax?.[1] ?? d.velMin[1]) : 1;
      const vz = Array.isArray(d.velMin) ? this.#rand(d.velMin[2], d.velMax?.[2] ?? d.velMin[2]) : 0;
      return {
        x: Math.cos(ang) * rad, y: 0, z: Math.sin(ang) * rad,
        vx, vy, vz,
        age: 0, life,
        ss, es,
        sc: d.startColor || [255, 200, 100, 255],
        ec: d.endColor || [40, 20, 10, 0],
      };
    }

    #step(dt) {
      const doc = this.#current();
      if (!doc) return;
      const d = doc.data;
      const gy = Array.isArray(d.gravity) ? d.gravity[1] : (typeof d.gravity === "number" ? d.gravity : -2.5);

      if (d.emission === "rate") {
        this.#emitAcc += (d.rate || 10) * dt;
        while (this.#emitAcc >= 1) {
          this.#emitAcc -= 1;
          if (this.#particles.length < (d.maxParticles || 256)) this.#particles.push(this.#spawnOne(d));
        }
      } else if (!this.#burstOnce) {
        const [a, b] = Array.isArray(d.burst) ? d.burst : [8, 12];
        const n = Math.floor(this.#rand(a, b));
        for (let i = 0; i < n; i++) this.#particles.push(this.#spawnOne(d));
        this.#burstOnce = true;
      } else if (this.loop && this.#particles.length === 0) {
        this.#burstOnce = false;
      }

      const drag = d.drag || 0;
      for (const p of this.#particles) {
        p.age += dt;
        p.vy += gy * dt;
        p.vx *= 1 - drag * dt;
        p.vy *= 1 - drag * dt;
        p.vz *= 1 - drag * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
      }
      this.#particles = this.#particles.filter((p) => p.age < p.life);
    }

    #draw() {
      const c = this.canvas;
      if (!c) return;
      const ctx = c.getContext("2d");
      const w = c.width, ht = c.height;
      ctx.clearRect(0, 0, w, ht);
      // soft ground
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(0, ht * 0.72, w, ht * 0.28);

      const cx = w * 0.5, cy = ht * 0.65;
      const scale = Math.min(w, ht) * 0.35;

      const sorted = this.#particles.slice().sort((a, b) => (a.z - b.z));
      for (const p of sorted) {
        const t = Math.min(1, p.age / p.life);
        const size = (p.ss * (1 - t) + p.es * t) * scale;
        const r = (p.sc[0] * (1 - t) + p.ec[0] * t) | 0;
        const g = (p.sc[1] * (1 - t) + p.ec[1] * t) | 0;
        const b = (p.sc[2] * (1 - t) + p.ec[2] * t) | 0;
        const a = ((p.sc[3] * (1 - t) + p.ec[3] * t) / 255) * (1 - t * 0.2);
        // simple iso-ish projection
        const sx = cx + (p.x - p.z) * scale * 0.7;
        const sy = cy - p.y * scale * 0.7 - (p.x + p.z) * scale * 0.25;
        ctx.beginPath();
        ctx.fillStyle = `rgba(${r},${g},${b},${Math.max(0, a)})`;
        ctx.arc(sx, sy, Math.max(1.2, size * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }

      if (!this.#current()) {
        ctx.fillStyle = "rgba(163,172,166,0.7)";
        ctx.font = `${13 * (this._dpr || 1)}px system-ui`;
        ctx.textAlign = "center";
        ctx.fillText("Sin efecto seleccionado", w / 2, ht / 2);
      }
    }
  }

  Aura.particlesTool = { particlesTool };
})(window.Aura ??= {});
