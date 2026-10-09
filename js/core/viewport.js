"use strict";

(function (Aura) {
  const { isTyping } = Aura.dom;
  const { Emitter } = Aura.emitter;

  /**
   * Pan and zoom for a canvas that shows a picture made of pixels (a sheet, an atlas). Wheel zooms at the cursor (smooth,
   * snapping to whole multiples above 1× so pixel art stays crisp); middle or right drag, or Space + drag, pans.
   * Coordinates: "screen" = CSS pixels inside the canvas; "image" = pixels of the picture.
   *
   * Emits "change" whenever the view moves. The owner draws; this only keeps the transform.
   */
  class Viewport extends Emitter {
    zoom = 1;
    panX = 0;
    panY = 0;
    minZoom = 0.1;
    maxZoom = 48;
    spaceHeld = false;
    #drag = null;

    constructor(canvas) {
      super();
      this.canvas = canvas;
      canvas.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false });
      canvas.addEventListener("pointerdown", (e) => this.#onDown(e));
      canvas.addEventListener("pointermove", (e) => this.#onMove(e));
      canvas.addEventListener("pointerup", (e) => this.#onUp(e));
      canvas.addEventListener("pointercancel", (e) => this.#onUp(e));
      canvas.addEventListener("contextmenu", (e) => e.preventDefault());
      window.addEventListener("keydown", (e) => {
        if (e.key !== " " || isTyping(e.target) || document.querySelector(".overlay")) return;
        // Held Space pans, also while a button has focus (it would otherwise press it).
        e.preventDefault();
        if (!e.repeat) { this.spaceHeld = true; this.#cursor(); }
      });
      window.addEventListener("keyup", (e) => {
        if (e.key === " ") { this.spaceHeld = false; this.#cursor(); }
      });
      window.addEventListener("blur", () => { this.spaceHeld = false; this.#cursor(); });
    }

    get isPanning() { return !!this.#drag; }

    /** Set by the owner when a plain left drag should pan too (a "move" tool). */
    leftPans = () => false;

    /** True when a pointerdown should pan rather than reach the tool. */
    wantsPan(e) {
      return e.button === 1 || e.button === 2 || this.spaceHeld || (e.button === 0 && this.leftPans());
    }

    toImage(clientX, clientY) {
      const r = this.canvas.getBoundingClientRect();
      return { x: (clientX - r.left - this.panX) / this.zoom, y: (clientY - r.top - this.panY) / this.zoom };
    }

    toScreen(x, y) {
      return { x: this.panX + x * this.zoom, y: this.panY + y * this.zoom };
    }

    size() {
      const r = this.canvas.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }

    setZoom(z, cx, cy) {
      const { w, h } = this.size();
      if (cx === undefined) { cx = w / 2; cy = h / 2; }
      z = Math.min(this.maxZoom, Math.max(this.minZoom, z));
      const ix = (cx - this.panX) / this.zoom, iy = (cy - this.panY) / this.zoom;
      this.zoom = z;
      this.panX = Math.round(cx - ix * z);
      this.panY = Math.round(cy - iy * z);
      this.emit("change");
    }

    /** One notch in or out: ×1.25 below 1×, whole steps above, so 2×, 3×, 4× are always reachable. */
    step(dir, cx, cy) {
      const z = this.zoom;
      let next;
      if (dir > 0) next = z < 1 ? Math.min(1, z * 1.25) : Math.floor(z + 1e-6) + 1;
      else next = z <= 1 ? z / 1.25 : Math.ceil(z - 1e-6) - 1;
      this.setZoom(next, cx, cy);
    }

    /** Fits an image of w × h with a margin; whole-number zoom when it fits at 1× or more. */
    fit(w, h, margin = 24) {
      const size = this.size();
      let z = Math.min((size.w - margin) / w, (size.h - margin) / h);
      if (z >= 1) z = Math.floor(z);
      z = Math.min(this.maxZoom, Math.max(this.minZoom, z));
      this.zoom = z;
      this.panX = Math.round((size.w - w * z) / 2);
      this.panY = Math.round((size.h - h * z) / 2);
      this.emit("change");
    }

    /** Centres image point (x, y) at the current zoom, or at zoom when given. */
    centerOn(x, y, zoom) {
      const { w, h } = this.size();
      if (zoom) this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
      this.panX = Math.round(w / 2 - x * this.zoom);
      this.panY = Math.round(h / 2 - y * this.zoom);
      this.emit("change");
    }

    #onWheel(e) {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      if (e.ctrlKey || Math.abs(e.deltaY) >= 40 || e.deltaMode !== 0) {
        // A mouse wheel notch (or a pinch): one zoom step.
        this.step(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
      } else {
        // Touchpad two-finger scroll: pan.
        this.panX -= e.deltaX;
        this.panY -= e.deltaY;
        this.emit("change");
      }
    }

    #onDown(e) {
      if (!this.wantsPan(e)) return;
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      this.#drag = { id: e.pointerId, x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY };
      this.#cursor();
    }

    #onMove(e) {
      if (!this.#drag || e.pointerId !== this.#drag.id) return;
      this.panX = this.#drag.panX + (e.clientX - this.#drag.x);
      this.panY = this.#drag.panY + (e.clientY - this.#drag.y);
      this.emit("change");
    }

    #onUp(e) {
      if (!this.#drag || e.pointerId !== this.#drag.id) return;
      this.#drag = null;
      this.#cursor();
    }

    #cursor() {
      this.canvas.classList.toggle("panning", !!this.#drag);
      this.canvas.classList.toggle("can-pan", this.spaceHeld && !this.#drag);
    }
  }

  Aura.viewport = { Viewport };
})(window.Aura ??= {});
