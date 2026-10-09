"use strict";

(function (Aura) {
  const { cubeFace, normalize, reorient, LEFT, RIGHT, TOP } = Aura.normalsGenerator;

  // Draws the sheet in any of the views — lit as in game, normal map, base faces, art, the saved file — scaled and panned,
  // with an optional split that shows the art on the left of a divider. On WebGL2 the lighting runs on the GPU, so the
  // light sliders and zoom answer at once even on a 2048² sheet; without WebGL2 the same maths runs on the CPU (the code
  // the shader was written from, TileInstanced.fx).

  const VIEWS = { game: 0, normal: 1, faces: 2, art: 3, file: 4 };

  // The shader's relief light and strengths (TileInstanced.fx), so the Game view matches the game.
  const RELIEF_LIGHT = normalize(-0.42, 0.56, 0.71);
  const DETAIL_RELIEF = 0.6;
  const SUN_FACE_STRENGTH = 0.45;

  /** The sun as UpdateSunUniforms builds it; neutral = what the three flat faces get on average. */
  function sunVector(light) {
    const c = Math.cos(light.height);
    const up = Math.sin(light.height), right = Math.cos(light.angle) * c, left = Math.sin(light.angle) * c;
    const sun = normalize(
      TOP[0] * up + RIGHT[0] * right + LEFT[0] * left,
      TOP[1] * up + RIGHT[1] * right + LEFT[1] * left,
      TOP[2] * up + RIGHT[2] * right + LEFT[2] * left);
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const neutral = (Math.max(0, dot(TOP, sun)) + Math.max(0, dot(LEFT, sun)) + Math.max(0, dot(RIGHT, sun))) / 3;
    return { sun, neutral };
  }

  const VERTEX = `#version 300 es
  in vec2 aPos;
  void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FRAGMENT = `#version 300 es
  precision highp float;
  precision highp int;
  uniform sampler2D uArt, uNormal, uBase, uFile;
  uniform vec2 uSheet, uPan, uCell;
  uniform float uZoom, uDpr, uCanvasH, uSplit;
  uniform int uView, uDetail, uHasNormal, uHasFile;
  uniform vec3 uTop, uLeft, uRight, uSun, uReliefLight;
  uniform float uNeutral, uSunAmount, uLightTop, uLightLeft, uLightRight;
  uniform vec3 uBg;
  out vec4 outColor;

  vec3 decodeN(vec4 t) { return normalize(t.rgb * 2.0 - 1.0); }

  int cubeFace(vec2 p) {
    float u = (mod(p.x, uCell.x) + 0.5) / uCell.x;
    float v = (mod(p.y, uCell.y) + 0.5) / uCell.y;
    if (v <= 0.5 - abs(u - 0.5) * 0.5) return 1;
    return u < 0.5 ? 2 : 3;
  }

  vec3 reorient(vec3 b, vec3 d) {
    vec3 t = vec3(b.xy, b.z + 1.0);
    vec3 u = vec3(-d.xy, d.z);
    if (t.z < 1e-4) return b;
    float k = dot(t, u) / t.z;
    return normalize(t * k - u);
  }

  vec3 shadeGame(vec2 p, vec4 art, ivec2 ip) {
    float k;
    float relief = 0.0;
    vec4 nt = texelFetch(uNormal, ip, 0);
    if (uHasNormal == 1 && nt.a > 0.5) {
      vec3 n = decodeN(nt);
      if (uDetail == 1) {
        int f = cubeFace(p);
        vec3 b = f == 1 ? uTop : (f == 2 ? uLeft : uRight);
        n = reorient(b, n);
      }
      float wt = max(0.0, dot(n, uTop)), wl = max(0.0, dot(n, uLeft)), wr = max(0.0, dot(n, uRight));
      float total = wt + wl + wr;
      if (total > 0.001) { wt /= total; wl /= total; wr /= total; } else { wt = 1.0; wl = 0.0; wr = 0.0; }
      k = uLightTop * wt + uLightLeft * wl + uLightRight * wr;
      bool onTop = wt >= wl && wt >= wr;
      vec3 baseN = onTop ? uTop : (wl >= wr ? uLeft : uRight);
      relief = dot(n - baseN, uReliefLight) * (1.0 - uSunAmount);
      k *= max(0.0, 1.0 + ${SUN_FACE_STRENGTH.toFixed(3)} * uSunAmount * (max(0.0, dot(n, uSun)) - uNeutral));
    } else {
      int f = cubeFace(p);
      k = f == 1 ? uLightTop : (f == 2 ? uLightLeft : uLightRight);
    }
    k *= min(1.6, max(0.0, 1.0 + relief * ${DETAIL_RELIEF.toFixed(3)}));
    return art.rgb * k;
  }

  void main() {
    vec2 css = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y) / uDpr;
    vec2 p = floor((css - uPan) / uZoom);
    if (p.x < 0.0 || p.y < 0.0 || p.x >= uSheet.x || p.y >= uSheet.y) { outColor = vec4(uBg, 1.0); return; }
    ivec2 ip = ivec2(p);
    vec4 art = texelFetch(uArt, ip, 0);
    int view = uView;
    if (uSplit >= 0.0 && css.x < uSplit) view = 3;

    vec3 c = uBg;
    if (view == 3) {
      if (art.a > 0.0) c = mix(uBg, art.rgb, art.a);
    } else if (view == 4) {
      vec4 f = texelFetch(uFile, ip, 0);
      if (uHasFile == 1 && f.a > 0.0) c = f.rgb;
    } else if (view == 1) {
      vec4 n = texelFetch(uNormal, ip, 0);
      if (uHasNormal == 1 && n.a > 0.5) c = n.rgb;
    } else if (view == 2) {
      vec4 b = texelFetch(uBase, ip, 0);
      if (uHasNormal == 1 && b.a > 0.5 && art.a > 0.0) c = b.rgb;
    } else if (art.a > 0.0) {
      c = shadeGame(p, art, ip);
    }
    outColor = vec4(c, 1.0);
  }`;

  class SheetRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
      this.sheet = null;
      this.hasNormal = false;
      this.hasFile = false;
      if (this.gl) this.#initGl();
      else this.ctx = canvas.getContext("2d");
    }

    get usesGpu() { return !!this.gl; }

    #initGl() {
      const gl = this.gl;
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      this.program = program;
      this.uniforms = {};
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const name = gl.getActiveUniform(program, i).name;
        this.uniforms[name] = gl.getUniformLocation(program, name);
      }
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(program, "aPos");
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.textures = {};
      for (const [name, unit] of [["uArt", 0], ["uNormal", 1], ["uBase", 2], ["uFile", 3]]) {
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.textures[name] = { t, unit };
      }
    }

    #upload(name, w, h, rgba) {
      const gl = this.gl, { t, unit } = this.textures[name];
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        rgba ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) : new Uint8Array(w * h * 4));
    }

    /** A new sheet: art and (optionally) the saved file. Normals come later with setResult. */
    setSheet(sheet) {
      this.sheet = sheet;
      this.hasNormal = false;
      this.hasFile = false;
      this.cpuNormal = null;
      if (!this.gl || !sheet) return;
      this.#upload("uArt", sheet.w, sheet.h, sheet.rgba);
      this.#upload("uNormal", sheet.w, sheet.h, null);
      this.#upload("uBase", sheet.w, sheet.h, null);
      this.setFile(null);
    }

    setFile(rgba) {
      this.hasFile = !!rgba;
      this.fileRgba = rgba;
      if (this.gl && this.sheet) this.#upload("uFile", this.sheet.w, this.sheet.h, rgba);
    }

    /** The generator's output, encoded as RGBA (a = has). */
    setResult(normalRgba, baseRgba) {
      this.hasNormal = true;
      this.cpuNormal = normalRgba;
      this.cpuBase = baseRgba;
      if (!this.gl || !this.sheet) return;
      this.#upload("uNormal", this.sheet.w, this.sheet.h, normalRgba);
      this.#upload("uBase", this.sheet.w, this.sheet.h, baseRgba);
    }

    /**
     * opts: { view, zoom, panX, panY, cellW, cellH, detail, light, split (css px or -1) }
     */
    draw(opts) {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      const W = Math.max(1, Math.round(rect.width * dpr)), H = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
      if (this.gl) this.#drawGl(opts, dpr, W, H);
      else this.#drawCpu(opts, dpr, W, H);
    }

    #drawGl(o, dpr, W, H) {
      const gl = this.gl, u = this.uniforms, s = this.sheet;
      gl.viewport(0, 0, W, H);
      const bg = [0x26 / 255, 0x28 / 255, 0x2b / 255];
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!s) return;
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      for (const [name, { t, unit }] of Object.entries(this.textures)) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.uniform1i(u[name], unit);
      }
      const { sun, neutral } = sunVector(o.light);
      gl.uniform2f(u.uSheet, s.w, s.h);
      gl.uniform2f(u.uPan, o.panX, o.panY);
      gl.uniform2f(u.uCell, Math.max(1, o.cellW), Math.max(1, o.cellH));
      gl.uniform1f(u.uZoom, o.zoom);
      gl.uniform1f(u.uDpr, dpr);
      gl.uniform1f(u.uCanvasH, H);
      gl.uniform1f(u.uSplit, o.split ?? -1);
      gl.uniform1i(u.uView, VIEWS[o.view] ?? 0);
      gl.uniform1i(u.uDetail, o.detail ? 1 : 0);
      gl.uniform1i(u.uHasNormal, this.hasNormal ? 1 : 0);
      gl.uniform1i(u.uHasFile, this.hasFile ? 1 : 0);
      gl.uniform3fv(u.uTop, TOP);
      gl.uniform3fv(u.uLeft, LEFT);
      gl.uniform3fv(u.uRight, RIGHT);
      gl.uniform3fv(u.uSun, sun);
      gl.uniform3fv(u.uReliefLight, RELIEF_LIGHT);
      gl.uniform1f(u.uNeutral, neutral);
      gl.uniform1f(u.uSunAmount, o.light.amount);
      gl.uniform1f(u.uLightTop, o.light.top);
      gl.uniform1f(u.uLightLeft, o.light.left);
      gl.uniform1f(u.uLightRight, o.light.right);
      gl.uniform3fv(u.uBg, bg);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // -------------------------------------------------------------------------------------------------------------------
    // CPU fallback: renders the sheet at 1:1 into an offscreen canvas only when the view or light changed, then scales it.

    #drawCpu(o, dpr, W, H) {
      const ctx = this.ctx, s = this.sheet;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#26282b";
      ctx.fillRect(0, 0, W, H);
      if (!s) return;
      const key = JSON.stringify([o.view, o.cellW, o.cellH, o.detail, o.light, this.hasNormal, this.hasFile, this.version]);
      if (key !== this.cpuKey) {
        this.cpuKey = key;
        this.cpuCanvas ??= document.createElement("canvas");
        this.cpuCanvas.width = s.w;
        this.cpuCanvas.height = s.h;
        this.cpuCanvas.getContext("2d").putImageData(new ImageData(this.#cpuPixels(o.view, o), s.w, s.h), 0, 0);
        if (o.split >= 0) {
          this.cpuArt ??= document.createElement("canvas");
          this.cpuArt.width = s.w;
          this.cpuArt.height = s.h;
          this.cpuArt.getContext("2d").putImageData(new ImageData(this.#cpuPixels("art", o), s.w, s.h), 0, 0);
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.cpuCanvas, o.panX, o.panY, s.w * o.zoom, s.h * o.zoom);
      if (o.split >= 0 && this.cpuArt) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, o.split, H);
        ctx.clip();
        ctx.fillStyle = "#26282b";
        ctx.fillRect(0, 0, o.split, H);
        ctx.drawImage(this.cpuArt, o.panX, o.panY, s.w * o.zoom, s.h * o.zoom);
        ctx.restore();
      }
    }

    /** Bumped by the owner when the normals change, so the CPU path re-renders. */
    invalidate() {
      this.version = (this.version || 0) + 1;
    }

    #cpuPixels(view, o) {
      const s = this.sheet, n = s.w * s.h;
      const out = new Uint8ClampedArray(n * 4);
      const bg = [0x26, 0x28, 0x2b];
      for (let i = 0; i < n; i++) { out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = 255; }
      const art = s.rgba;
      if (view === "art") {
        for (let i = 0; i < n; i++) {
          const a = art[i * 4 + 3] / 255;
          if (!a) continue;
          for (let c = 0; c < 3; c++) out[i * 4 + c] = bg[c] + (art[i * 4 + c] - bg[c]) * a;
        }
        return out;
      }
      if (view === "file" || view === "normal" || view === "faces") {
        const src = view === "file" ? this.fileRgba : (view === "normal" ? this.cpuNormal : this.cpuBase);
        if (!src) return out;
        for (let i = 0; i < n; i++) {
          if (src[i * 4 + 3] === 0 || (view === "faces" && art[i * 4 + 3] === 0)) continue;
          out[i * 4] = src[i * 4]; out[i * 4 + 1] = src[i * 4 + 1]; out[i * 4 + 2] = src[i * 4 + 2];
        }
        return out;
      }
      // Game view.
      const { sun, neutral } = sunVector(o.light);
      const L = o.light, cw = Math.max(1, o.cellW), ch = Math.max(1, o.cellH);
      const faceLight = [0, L.top, L.left, L.right];
      const nm = this.cpuNormal;
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      for (let y = 0; y < s.h; y++) {
        for (let x = 0; x < s.w; x++) {
          const i = y * s.w + x;
          if (art[i * 4 + 3] === 0) continue;
          let k, relief = 0;
          if (nm && nm[i * 4 + 3]) {
            let v = normalize(nm[i * 4] / 127.5 - 1, nm[i * 4 + 1] / 127.5 - 1, nm[i * 4 + 2] / 127.5 - 1);
            if (o.detail) {
              const f = cubeFace(x, y, cw, ch);
              const b = f === 1 ? TOP : (f === 2 ? LEFT : RIGHT);
              v = reorient(b[0], b[1], b[2], v[0], v[1], v[2]);
            }
            let wt = Math.max(0, dot(v, TOP)), wl = Math.max(0, dot(v, LEFT)), wr = Math.max(0, dot(v, RIGHT));
            const total = wt + wl + wr;
            if (total > 0.001) { wt /= total; wl /= total; wr /= total; } else { wt = 1; wl = 0; wr = 0; }
            k = L.top * wt + L.left * wl + L.right * wr;
            const baseN = wt >= wl && wt >= wr ? TOP : (wl >= wr ? LEFT : RIGHT);
            relief = ((v[0] - baseN[0]) * RELIEF_LIGHT[0] + (v[1] - baseN[1]) * RELIEF_LIGHT[1]
              + (v[2] - baseN[2]) * RELIEF_LIGHT[2]) * (1 - L.amount);
            k *= Math.max(0, 1 + SUN_FACE_STRENGTH * L.amount * (Math.max(0, dot(v, sun)) - neutral));
          } else {
            k = faceLight[cubeFace(x, y, cw, ch)];
          }
          k *= Math.min(1.6, Math.max(0, 1 + relief * DETAIL_RELIEF));
          out[i * 4] = art[i * 4] * k;
          out[i * 4 + 1] = art[i * 4 + 1] * k;
          out[i * 4 + 2] = art[i * 4 + 2] * k;
        }
      }
      return out;
    }
  }

  Aura.normalsRenderer = { VIEWS, sunVector, SheetRenderer };
})(window.Aura ??= {});
