"use strict";

(function (Aura) {
  const { decode } = Aura.normalsGenerator;

  // Alpha the Blender add-on writes on normals that already include their relief: imported as "final", never bumped again.
  const RELIEF_ALPHA = 254;

  /**
   * Faces painted by hand or imported from Blender, per pixel: has (0/1), n (normal xyz), fixed (1 = final, from Blender).
   * Every change goes through a Patch, which remembers each touched pixel's old and new value — an undo step costs the
   * pixels it changed, not a copy of the sheet.
   */
  class Overrides {
    constructor(w, h) {
      this.w = w;
      this.h = h;
      const n = w * h;
      this.has = new Uint8Array(n);
      this.n = new Float32Array(n * 3);
      this.fixed = new Uint8Array(n);
    }

    /** From a saved _faces.png: alpha ≥ 128 is a face, 254 marks it final. */
    static fromFacesPng(w, h, rgba) {
      const ov = new Overrides(w, h);
      if (!rgba) return ov;
      for (let i = 0; i < w * h; i++) {
        if (rgba[i * 4 + 3] < 128) continue;
        ov.has[i] = 1;
        ov.fixed[i] = rgba[i * 4 + 3] === RELIEF_ALPHA ? 1 : 0;
        ov.n.set(decode(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]), i * 3);
      }
      return ov;
    }

    count() {
      let c = 0;
      for (let i = 0; i < this.has.length; i++) c += this.has[i];
      return c;
    }

    begin() {
      return new Patch(this);
    }
  }

  class Patch {
    #old = new Map();   // index -> [has, nx, ny, nz, fixed]

    constructor(ov) {
      this.ov = ov;
    }

    get size() { return this.#old.size; }

    #remember(i) {
      if (this.#old.has(i)) return;
      const o = this.ov;
      this.#old.set(i, [o.has[i], o.n[i * 3], o.n[i * 3 + 1], o.n[i * 3 + 2], o.fixed[i]]);
    }

    set(i, normal, fixed) {
      this.#remember(i);
      this.ov.has[i] = 1;
      this.ov.n[i * 3] = normal[0];
      this.ov.n[i * 3 + 1] = normal[1];
      this.ov.n[i * 3 + 2] = normal[2];
      this.ov.fixed[i] = fixed ? 1 : 0;
    }

    clear(i) {
      this.#remember(i);
      this.ov.has[i] = 0;
      this.ov.fixed[i] = 0;
    }

    /** Puts every touched pixel back as it was (used to re-place an import at a new offset within the same step). */
    revert() {
      const o = this.ov;
      for (const [i, v] of this.#old) {
        o.has[i] = v[0]; o.n[i * 3] = v[1]; o.n[i * 3 + 1] = v[2]; o.n[i * 3 + 2] = v[3]; o.fixed[i] = v[4];
      }
      this.#old.clear();
    }

    /** Freezes the patch into an undo command, or null when nothing actually changed. */
    toCommand(label, onApply) {
      const o = this.ov;
      const idx = [], before = [], after = [];
      for (const [i, v] of this.#old) {
        const now = [o.has[i], o.n[i * 3], o.n[i * 3 + 1], o.n[i * 3 + 2], o.fixed[i]];
        if (now.every((x, k) => x === v[k]) || (!v[0] && !now[0])) continue;
        idx.push(i);
        before.push(...v);
        after.push(...now);
      }
      if (!idx.length) return null;
      const indices = Int32Array.from(idx), b = Float32Array.from(before), a = Float32Array.from(after);
      const write = (values) => {
        for (let k = 0; k < indices.length; k++) {
          const i = indices[k];
          o.has[i] = values[k * 5];
          o.n[i * 3] = values[k * 5 + 1];
          o.n[i * 3 + 1] = values[k * 5 + 2];
          o.n[i * 3 + 2] = values[k * 5 + 3];
          o.fixed[i] = values[k * 5 + 4];
        }
        onApply?.();
      };
      return { label, pixels: indices.length, undo: () => write(b), redo: () => write(a) };
    }
  }

  Aura.normalsOverrides = { RELIEF_ALPHA, Overrides, Patch };
})(window.Aura ??= {});
