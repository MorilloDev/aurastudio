"use strict";

(function (Aura) {


  /** Minimal event emitter. on() returns the function that removes the listener. */
  class Emitter {
    #listeners = new Map();

    on(event, fn) {
      if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
      this.#listeners.get(event).add(fn);
      return () => this.#listeners.get(event)?.delete(fn);
    }

    emit(event, ...args) {
      for (const fn of this.#listeners.get(event) ?? []) {
        try {
          fn(...args);
        } catch (err) {
          console.error(`[${event}]`, err);
        }
      }
    }
  }

  Aura.emitter = { Emitter };
})(window.Aura ??= {});
