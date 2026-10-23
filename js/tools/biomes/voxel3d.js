"use strict";

// A small WebGL2 voxel viewer for the Biomas 3D view: blocks as cubes with per-face shading and corner occlusion (the
// game's look of lit tops and darker sides), plants as crossed quads, water and glass see-through. Each tile is one flat
// colour — its sprite's average — so a biome reads by its colours and shapes, not by its art. Orbit with the left button,
// pan with the right one (or Shift), zoom with the wheel; "Iso" goes back to the game's angle.
(function (Aura) {
  const K = () => Aura.biomeScene.KIND;

  // Face order: +X, -X, +Y, -Y, +Z, -Z. Shades as the game's sprites light them: the top brightest, the two sides apart.
  const FACES = [
    { n: [1, 0, 0], shade: 0.8, quad: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { n: [-1, 0, 0], shade: 0.8, quad: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { n: [0, 1, 0], shade: 1.0, quad: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { n: [0, -1, 0], shade: 0.5, quad: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 0, 1], shade: 0.66, quad: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    { n: [0, 0, -1], shade: 0.66, quad: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  ];

  const VS = `#version 300 es
    in vec3 aPos; in vec4 aCol; uniform mat4 uMvp; out vec4 vCol;
    void main() { vCol = aCol; gl_Position = uMvp * vec4(aPos, 1.0); }`;
  const FS = `#version 300 es
    precision mediump float; in vec4 vCol; out vec4 outColor;
    void main() { outColor = vCol; }`;

  class VoxelView {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
      this.ok = !!this.gl;
      this.cam = { yaw: Math.PI / 4, pitch: Math.PI / 6, dist: 60, target: [0, 0, 0], ortho: true };
      this.meshes = [];
      this.sky = [0.17, 0.2, 0.24];
      if (!this.ok) return;
      this.#initGl();
      this.#bindInput();
    }

    /** colorOf(paletteEntry) → [r, g, b, a] 0..1. Keeps the camera unless reframe. */
    setScene(scene, colorOf, reframe) {
      if (!this.ok) return;
      const colors = scene.palette.map((p) => (p.kind ? colorOf(p) : null));
      const opaque = { pos: [], col: [], idx: [] }, clear = { pos: [], col: [], idx: [] };
      this.#mesh(scene, colors, opaque, clear);
      for (const m of this.meshes) this.#free(m);
      this.meshes = [this.#upload(opaque), this.#upload(clear)];
      if (reframe || !this.framed) {
        let top = 0;
        for (let y = scene.height - 1; y >= 0 && !top; y--)
          for (let i = 0; i < scene.size * scene.size && !top; i++) if (scene.cells[y * scene.size * scene.size + i]) top = y;
        this.cam.target = [scene.size / 2, Math.min(top, 10) * 0.7, scene.size / 2];
        this.cam.dist = scene.size * 1.25;
        this.framed = true;
      }
      this.render();
    }

    iso() {
      // The game's camera: looking down the diagonal, 2:1 tiles.
      const quarter = Math.round((this.cam.yaw - Math.PI / 4) / (Math.PI / 2));
      this.cam.yaw = Math.PI / 4 + quarter * Math.PI / 2;
      this.cam.pitch = Math.PI / 6;
      this.cam.ortho = true;
      this.render();
    }

    turn(quarters) {
      this.cam.yaw += quarters * Math.PI / 2;
      this.render();
    }

    togglePerspective() {
      this.cam.ortho = !this.cam.ortho;
      this.render();
      return this.cam.ortho;
    }

    render = () => {
      if (this.#queued || !this.ok) return;
      this.#queued = true;
      requestAnimationFrame(() => { this.#queued = false; this.#draw(); });
    };

    #queued = false;

    // ── Meshing ──────────────────────────────────────────────────────────────────────────────────────────────────────

    #mesh(scene, colors, opaque, clear) {
      const S = scene.size, H = scene.height, kinds = scene.palette.map((p) => p.kind), KIND = K();
      const at = (x, y, z) => scene.at(x, y, z);
      const blocks = (x, y, z) => {
        const k = kinds[at(x, y, z)];
        return k === KIND.solid;
      };
      // A face shows unless the cell in front is an opaque full block, or the same see-through tile (no inner faces).
      const hides = (self, x, y, z) => {
        const o = at(x, y, z), k = kinds[o];
        return k === KIND.solid || ((k === KIND.water || k === KIND.glass) && o === self);
      };

      for (let y = 0; y < H; y++)
        for (let z = 0; z < S; z++)
          for (let x = 0; x < S; x++) {
            const p = at(x, y, z);
            if (!p) continue;
            const k = kinds[p], col = colors[p];
            if (k === KIND.plant) { this.#cross(opaque, x, y, z, col); continue; }
            const out = col[3] < 1 || k === KIND.water ? clear : opaque;
            const h = k === KIND.slab ? 0.5 : k === KIND.water ? 0.88 : 1;
            for (let f = 0; f < 6; f++) {
              const { n, shade, quad } = FACES[f];
              if (k === KIND.water && n[1] !== 1 && !(n[1] === 0 && !at(x + n[0], y, z + n[2]))) continue;
              if (k === KIND.water && n[1] === 1 && kinds[at(x, y + 1, z)] === KIND.water) continue;
              if (k !== KIND.water && !(k === KIND.slab && n[1] === 1) && hides(p, x + n[0], y + n[1], z + n[2])) continue;
              const base = out.pos.length / 3;
              for (const v of quad) {
                // Corner occlusion, Minecraft style: the two cells beside the corner and the one across it, in the layer
                // in front of the face.
                const ax = v[0] * 2 - 1, ay = v[1] * 2 - 1, az = v[2] * 2 - 1;
                const fx = x + n[0], fy = y + n[1], fz = z + n[2];
                const t = [n[0] ? 0 : ax, n[1] ? 0 : ay, n[2] ? 0 : az];
                const a1 = n[0] ? [0, t[1], 0] : [t[0], 0, 0];
                const a2 = n[2] ? [0, t[1], 0] : [0, 0, t[2]];
                const s1 = blocks(fx + a1[0], fy + a1[1], fz + a1[2]) ? 1 : 0;
                const s2 = blocks(fx + a2[0], fy + a2[1], fz + a2[2]) ? 1 : 0;
                const c = blocks(fx + t[0], fy + t[1], fz + t[2]) ? 1 : 0;
                const ao = k === KIND.water ? 3 : s1 && s2 ? 0 : 3 - (s1 + s2 + c);
                const light = shade * (0.58 + 0.14 * ao);
                out.pos.push(x + v[0], y + v[1] * h, z + v[2]);
                out.col.push(col[0] * light, col[1] * light, col[2] * light, col[3]);
              }
              out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
            }
          }
    }

    // A plant: two crossed quads, a bit lighter at the top, as the sprites read.
    #cross(out, x, y, z, col) {
      const a = 0.12, b = 0.88, top = 0.8;
      for (const [x0, z0, x1, z1] of [[a, a, b, b], [a, b, b, a]]) {
        const base = out.pos.length / 3;
        const pts = [[x0, 0, z0], [x0, top, z0], [x1, top, z1], [x1, 0, z1]];
        for (const p of pts) {
          const light = p[1] ? 1.05 : 0.7;
          out.pos.push(x + p[0], y + p[1], z + p[2]);
          out.col.push(Math.min(1, col[0] * light), Math.min(1, col[1] * light), Math.min(1, col[2] * light), 1);
        }
        out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }

    // ── GL ───────────────────────────────────────────────────────────────────────────────────────────────────────────

    #initGl() {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      this.prog = p;
      this.aPos = gl.getAttribLocation(p, "aPos");
      this.aCol = gl.getAttribLocation(p, "aCol");
      this.uMvp = gl.getUniformLocation(p, "uMvp");
    }

    #upload({ pos, col, idx }) {
      const gl = this.gl;
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = (data, loc, size) => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
        return b;
      };
      const bp = buf(pos, this.aPos, 3), bc = buf(col, this.aCol, 4);
      const bi = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bi);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return { vao, buffers: [bp, bc, bi], count: idx.length };
    }

    #free(m) {
      const gl = this.gl;
      gl.deleteVertexArray(m.vao);
      for (const b of m.buffers) gl.deleteBuffer(b);
    }

    #draw() {
      const gl = this.gl, c = this.canvas;
      const dpr = window.devicePixelRatio || 1, W = Math.max(1, Math.round(c.clientWidth * dpr)), H = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      gl.viewport(0, 0, W, H);
      gl.clearColor(...this.sky, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!this.meshes.length) return;

      const { yaw, pitch, dist, target, ortho } = this.cam;
      const eye = [target[0] + Math.cos(pitch) * Math.cos(yaw) * dist, target[1] + Math.sin(pitch) * dist, target[2] + Math.cos(pitch) * Math.sin(yaw) * dist];
      const aspect = W / H;
      const proj = ortho ? orthoM(dist * 0.5 * aspect, dist * 0.5, 0.1, dist * 4) : perspective(Math.PI / 4, aspect, 0.1, dist * 6);
      const mvp = mul(proj, lookAt(eye, target, [0, 1, 0]));

      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(this.uMvp, false, mvp);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      const [opaque, clear] = this.meshes;
      gl.bindVertexArray(opaque.vao);
      gl.drawElements(gl.TRIANGLES, opaque.count, gl.UNSIGNED_INT, 0);
      if (clear.count) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.bindVertexArray(clear.vao);
        gl.drawElements(gl.TRIANGLES, clear.count, gl.UNSIGNED_INT, 0);
        gl.depthMask(true);
      }
      gl.bindVertexArray(null);
    }

    // ── Input ────────────────────────────────────────────────────────────────────────────────────────────────────────

    #bindInput() {
      const c = this.canvas;
      let drag = null;
      c.addEventListener("contextmenu", (e) => e.preventDefault());
      c.addEventListener("pointerdown", (e) => {
        drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey };
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX;
        drag.y = e.clientY;
        const cam = this.cam;
        if (drag.pan) {
          const k = cam.dist / Math.max(200, c.clientHeight);
          // The camera's right on the ground: the scene follows the mouse.
          const rx = Math.sin(cam.yaw), rz = -Math.cos(cam.yaw);
          cam.target[0] -= (rx * dx) * k;
          cam.target[2] -= (rz * dx) * k;
          cam.target[1] += dy * k;
        } else {
          cam.yaw += dx * 0.008;
          cam.pitch = Math.min(1.5, Math.max(0.05, cam.pitch + dy * 0.008));
        }
        this.render();
      });
      const end = () => { drag = null; };
      c.addEventListener("pointerup", end);
      c.addEventListener("pointercancel", end);
      c.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.cam.dist = Math.min(400, Math.max(6, this.cam.dist * Math.exp(e.deltaY * 0.0012)));
        this.render();
      }, { passive: false });
      c.addEventListener("dblclick", () => this.iso());
    }
  }

  // ── Matrices (column-major, as WebGL takes them) ────────────────────────────────────────────────────────────────

  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }

  function orthoM(hw, hh, near, far) {
    const nf = 1 / (near - far);
    return [1 / hw, 0, 0, 0, 0, 1 / hh, 0, 0, 0, 0, 2 * nf, 0, 0, 0, (far + near) * nf, 1];
  }

  function lookAt(eye, target, up) {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }

  function mul(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
        for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
  }

  Aura.voxelView = { VoxelView };
})(window.Aura ??= {});
