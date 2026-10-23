"use strict";

// A small WebGL2 voxel viewer, shared by the Biomas and Estructuras 3D views: blocks as cubes with per-face shading and
// corner occlusion (the game's look of lit tops and darker sides), slabs as half boxes, plants as crossed quads, water,
// glass and ghosts see-through. Each tile is one flat colour — its sprite's average.
//
// Camera: drag with the left button to orbit, with the right one (or Shift, or the middle button) to pan, wheel to zoom,
// double click for the game's angle. With an editor attached, a left or right click that does not move becomes a click
// for it, Shift + drag a rectangle, and the mouse a ray it can pick cells with (ray()).
(function (Aura) {
  /** What a palette entry is drawn as. */
  const KIND = { solid: 1, plant: 2, water: 3, glass: 4, slab: 5, ghost: 6 };

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

  const CLICK_SLOP = 4;

  class VoxelView {
    /** editor (optional): { hover(ray), click(ray, button, event), rectStart(ray, remove), rectMove(ray), rectEnd() }. */
    constructor(canvas, editor = null) {
      this.canvas = canvas;
      this.editor = editor;
      this.gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
      this.ok = !!this.gl;
      this.cam = { yaw: Math.PI / 4, pitch: Math.PI / 6, dist: 60, target: [0, 0, 0], ortho: true };
      this.meshes = [];
      this.overlay = null;
      this.sky = [0.17, 0.2, 0.24];
      if (!this.ok) return;
      this.#initGl();
      this.#bindInput();
    }

    /**
     * scene: { sizeX, sizeZ (or size), height, at(x, y, z) → palette index, palette: [{ kind }], boxAt?(x, y, z) → [x0, y0,
     * z0, x1, y1, z1] in the cell for a slab }. colorOf(entry) → [r, g, b, a] 0..1. Keeps the camera unless reframe.
     */
    setScene(scene, colorOf, reframe) {
      if (!this.ok) return;
      const colors = scene.palette.map((p) => (p.kind ? colorOf(p) : null));
      const opaque = mesh(), clear = mesh();
      this.#mesh(scene, colors, opaque, clear);
      for (const m of this.meshes) this.#free(m);
      this.meshes = [this.#upload(opaque, this.gl.TRIANGLES), this.#upload(clear, this.gl.TRIANGLES)];
      const sx = scene.sizeX ?? scene.size, sz = scene.sizeZ ?? scene.size;
      if (reframe || !this.framed) {
        let top = 0;
        for (let y = scene.height - 1; y >= 0 && !top; y--)
          for (let z = 0; z < sz && !top; z++) for (let x = 0; x < sx && !top; x++) if (scene.at(x, y, z)) top = y;
        this.cam.target = [sx / 2, Math.min(top, 12) * 0.6, sz / 2];
        this.cam.dist = Math.max(sx, sz, top * 1.3, 8) * 1.3;
        this.framed = true;
      }
      this.render();
    }

    /**
     * Drawn over the scene: lines [{ a: [x, y, z], b: [x, y, z], color: [r, g, b, a] }] (outlines, the level's grid) and boxes
     * [{ min, max, color }] (ghost pieces, the rectangle), see-through.
     */
    setOverlay({ lines = [], boxes = [] } = {}) {
      if (!this.ok) return;
      if (this.overlay) for (const m of this.overlay) this.#free(m);
      const l = mesh(), b = mesh();
      for (const { a, b: e, color } of lines) {
        const i = l.pos.length / 3;
        l.pos.push(...a, ...e);
        l.col.push(...color, ...color);
        l.idx.push(i, i + 1);
      }
      for (const { min, max, color } of boxes) {
        for (const { n, shade, quad } of FACES) {
          const i = b.pos.length / 3;
          for (const v of quad) {
            b.pos.push(v[0] ? max[0] : min[0], v[1] ? max[1] : min[1], v[2] ? max[2] : min[2]);
            b.col.push(color[0] * shade, color[1] * shade, color[2] * shade, color[3]);
          }
          b.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
          void n;
        }
      }
      this.overlay = [this.#upload(l, this.gl.LINES), this.#upload(b, this.gl.TRIANGLES)];
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

    /** The ray under a canvas point, in scene coordinates: { o, d } with d normalised. */
    ray(mx, my) {
      const c = this.canvas;
      const nx = (mx / c.clientWidth) * 2 - 1, ny = 1 - (my / c.clientHeight) * 2;
      const inv = invert(this.#mvp(c.clientWidth / Math.max(1, c.clientHeight)));
      const un = (z) => {
        const v = [nx, ny, z, 1], o = [0, 0, 0, 0];
        for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[r] += inv[k * 4 + r] * v[k];
        return [o[0] / o[3], o[1] / o[3], o[2] / o[3]];
      };
      const a = un(-1), b = un(1);
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d) || 1;
      return { o: a, d: [d[0] / l, d[1] / l, d[2] / l] };
    }

    render = () => {
      if (this.#queued || !this.ok) return;
      this.#queued = true;
      requestAnimationFrame(() => { this.#queued = false; this.#draw(); });
    };

    #queued = false;

    // ── Meshing ──────────────────────────────────────────────────────────────────────────────────────────────────────

    #mesh(scene, colors, opaque, clear) {
      const SX = scene.sizeX ?? scene.size, SZ = scene.sizeZ ?? scene.size, H = scene.height;
      const kinds = scene.palette.map((p) => p.kind);
      const at = (x, y, z) => scene.at(x, y, z);
      const blocks = (x, y, z) => kinds[at(x, y, z)] === KIND.solid;
      // A face shows unless the cell in front is an opaque full block, or the same see-through tile (no inner faces).
      const hides = (self, x, y, z) => {
        const o = at(x, y, z), k = kinds[o];
        return k === KIND.solid || ((k === KIND.water || k === KIND.glass || k === KIND.ghost) && o === self);
      };

      for (let y = 0; y < H; y++)
        for (let z = 0; z < SZ; z++)
          for (let x = 0; x < SX; x++) {
            const p = at(x, y, z);
            if (!p) continue;
            const k = kinds[p], col = colors[p];
            if (!col) continue;
            if (k === KIND.plant) { this.#cross(col[3] < 1 ? clear : opaque, x, y, z, col); continue; }
            const out = col[3] < 1 || k === KIND.water ? clear : opaque;
            let box = [0, 0, 0, 1, 1, 1];
            if (k === KIND.water) box = [0, 0, 0, 1, 0.88, 1];
            else if (k === KIND.slab) box = scene.boxAt?.(x, y, z) ?? [0, 0, 0, 1, 0.5, 1];
            const full = box[0] === 0 && box[1] === 0 && box[2] === 0 && box[3] === 1 && box[4] === 1 && box[5] === 1;
            for (let f = 0; f < 6; f++) {
              const { n, shade, quad } = FACES[f];
              if (k === KIND.water) {
                if (n[1] === -1) continue;
                if (n[1] === 1 && kinds[at(x, y + 1, z)] === KIND.water) continue;
                if (n[1] === 0 && at(x + n[0], y, z + n[2])) continue;
              } else if (hides(p, x + n[0], y + n[1], z + n[2])) {
                // A half box's inner face still shows: only the faces on the cell's own boundary are covered.
                const onBoundary = full || (n[0] === 1 && box[3] === 1) || (n[0] === -1 && box[0] === 0) || (n[1] === 1 && box[4] === 1)
                  || (n[1] === -1 && box[1] === 0) || (n[2] === 1 && box[5] === 1) || (n[2] === -1 && box[2] === 0);
                if (onBoundary) continue;
              }
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
                const ao = k === KIND.water || k === KIND.ghost ? 3 : s1 && s2 ? 0 : 3 - (s1 + s2 + c);
                const light = shade * (0.58 + 0.14 * ao);
                out.pos.push(x + (v[0] ? box[3] : box[0]), y + (v[1] ? box[4] : box[1]), z + (v[2] ? box[5] : box[2]));
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
        for (const p of [[x0, 0, z0], [x0, top, z0], [x1, top, z1], [x1, 0, z1]]) {
          const light = p[1] ? 1.05 : 0.7;
          out.pos.push(x + p[0], y + p[1], z + p[2]);
          out.col.push(Math.min(1, col[0] * light), Math.min(1, col[1] * light), Math.min(1, col[2] * light), col[3]);
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

    #upload({ pos, col, idx }, mode) {
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
      return { vao, buffers: [bp, bc, bi], count: idx.length, mode };
    }

    #free(m) {
      const gl = this.gl;
      gl.deleteVertexArray(m.vao);
      for (const b of m.buffers) gl.deleteBuffer(b);
    }

    #mvp(aspect) {
      const { yaw, pitch, dist, target, ortho } = this.cam;
      const eye = [target[0] + Math.cos(pitch) * Math.cos(yaw) * dist, target[1] + Math.sin(pitch) * dist, target[2] + Math.cos(pitch) * Math.sin(yaw) * dist];
      const proj = ortho ? orthoM(dist * 0.5 * aspect, dist * 0.5, 0.1, dist * 4) : perspective(Math.PI / 4, aspect, 0.1, dist * 6);
      return mul(proj, lookAt(eye, target, [0, 1, 0]));
    }

    #draw() {
      const gl = this.gl, c = this.canvas;
      if (!c.clientWidth || !c.clientHeight) return;
      const dpr = window.devicePixelRatio || 1, W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      gl.viewport(0, 0, W, H);
      gl.clearColor(...this.sky, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!this.meshes.length) return;

      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(this.uMvp, false, this.#mvp(W / H));
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      const [opaque, clear] = this.meshes;
      this.#drawMesh(opaque);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      this.#drawMesh(clear);
      if (this.overlay) {
        const [lines, boxes] = this.overlay;
        this.#drawMesh(boxes);
        // Outlines read through what stands in front of them, faint, then solid where they are seen.
        gl.depthFunc(gl.GREATER);
        gl.blendColor(0, 0, 0, 0.3);
        gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
        this.#drawMesh(lines);
        gl.depthFunc(gl.LEQUAL);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this.#drawMesh(lines);
      }
      gl.depthMask(true);
      gl.bindVertexArray(null);
    }

    #drawMesh(m) {
      if (!m?.count) return;
      const gl = this.gl;
      gl.bindVertexArray(m.vao);
      gl.drawElements(m.mode, m.count, gl.UNSIGNED_INT, 0);
    }

    // ── Input ────────────────────────────────────────────────────────────────────────────────────────────────────────

    #bindInput() {
      const c = this.canvas;
      let drag = null;
      const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      c.addEventListener("contextmenu", (e) => e.preventDefault());
      c.addEventListener("pointerdown", (e) => {
        const [mx, my] = local(e);
        c.setPointerCapture(e.pointerId);
        if (this.editor && e.shiftKey && (e.button === 0 || e.button === 2)) {
          drag = { rect: true };
          this.editor.rectStart(this.ray(mx, my), e.button === 2);
          return;
        }
        drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button, moved: false,
          pan: e.button !== 0 || (!this.editor && e.shiftKey), event: e };
      });
      c.addEventListener("pointermove", (e) => {
        const [mx, my] = local(e);
        if (!drag) {
          this.editor?.hover(this.ray(mx, my));
          return;
        }
        if (drag.rect) { this.editor.rectMove(this.ray(mx, my)); return; }
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < CLICK_SLOP) return;
        drag.moved = true;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX;
        drag.y = e.clientY;
        const cam = this.cam;
        if (drag.pan) {
          const k = cam.dist / Math.max(200, c.clientHeight);
          // The camera's right on the ground: the scene follows the mouse.
          const rx = Math.sin(cam.yaw), rz = -Math.cos(cam.yaw);
          cam.target[0] -= rx * dx * k;
          cam.target[2] -= rz * dx * k;
          cam.target[1] += dy * k;
        } else {
          cam.yaw += dx * 0.008;
          cam.pitch = Math.min(1.5, Math.max(0.05, cam.pitch + dy * 0.008));
        }
        this.render();
      });
      const end = (e) => {
        const d = drag;
        drag = null;
        if (!d) return;
        if (d.rect) { this.editor.rectEnd(); return; }
        if (!d.moved && this.editor && e.type === "pointerup") {
          const [mx, my] = local(e);
          this.editor.click(this.ray(mx, my), d.button, d.event);
        }
      };
      c.addEventListener("pointerup", end);
      c.addEventListener("pointercancel", end);
      c.addEventListener("pointerleave", () => { if (!drag) this.editor?.hover(null); });
      c.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.cam.dist = Math.min(600, Math.max(4, this.cam.dist * Math.exp(e.deltaY * 0.0012)));
        this.render();
      }, { passive: false });
      c.addEventListener("dblclick", () => this.iso());
    }
  }

  const mesh = () => ({ pos: [], col: [], idx: [] });

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

  // General 4×4 inverse (cofactors), column-major in and out.
  function invert(m) {
    const inv = new Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12] || 1e-12;
    return inv.map((v) => v / det);
  }

  Aura.voxelView = { VoxelView, KIND };
})(window.Aura ??= {});
