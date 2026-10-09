"use strict";

(function (Aura) {
  const { computeNormals } = Aura.normalsGenerator;

  /**
   * Runs the generator in a worker started from the generator's own source text, on the page itself if workers can't
   * start. Only
   * the latest request counts: an older result arriving late is dropped. whenIdle() resolves once the result matches the
   * last request, so Save never writes a stale map.
   */
  class Compute {
    #worker = null;
    #id = 0;
    #timer = 0;
    #waiters = [];
    #scheduled = false;
    pending = false;

    constructor(onResult) {
      this.onResult = onResult;
      const source = `"use strict";
const generator = (${Aura.normalsGeneratorFactory.toString()})();
self.onmessage = (e) => {
  const started = performance.now();
  const r = generator.computeNormals(e.data.input);
  r.ms = performance.now() - started;
  r.id = e.data.id;
  self.postMessage(r, [r.nx.buffer, r.ny.buffer, r.nz.buffer, r.has.buffer, r.bx.buffer, r.by.buffer, r.bz.buffer,
    r.hasBase.buffer, r.kinds.buffer]);
};`;
      try {
        this.#worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        this.#worker.onmessage = (e) => this.#done(e.data);
        this.#worker.onerror = (e) => {
          e.preventDefault();
          this.#worker = null;
          if (this.pending) this.#runNow(this.lastInput);
        };
      } catch {
        this.#worker = null;
      }
    }

    get inWorker() { return !!this.#worker; }

    request(input, delay = 120) {
      this.lastInput = input;
      this.pending = true;
      this.#scheduled = true;
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.#runNow(input), delay);
    }

    cancel() {
      this.#scheduled = false;
      clearTimeout(this.#timer);
      this.#id++;
      this.pending = false;
      this.#flushWaiters();
    }

    #runNow(input) {
      this.#scheduled = false;
      const id = ++this.#id;
      // Copies, since the worker would otherwise take the buffers the page still paints into.
      const message = { id, input: { ...input, ovHas: input.ovHas?.slice(), ovN: input.ovN?.slice(), ovFixed: input.ovFixed?.slice() } };
      if (this.#worker) {
        this.#worker.postMessage(message);
        return;
      }
      setTimeout(() => {
        const started = performance.now();
        const r = computeNormals(message.input);
        r.ms = performance.now() - started;
        r.id = id;
        this.#done(r);
      }, 0);
    }

    #done(r) {
      if (r.id !== this.#id) return;
      this.pending = false;
      this.onResult(r);
      this.#flushWaiters();
    }

    #flushWaiters() {
      while (this.#waiters.length) this.#waiters.shift()();
    }

    whenIdle() {
      return new Promise((resolve) => {
        if (!this.pending) return resolve();
        if (this.#scheduled) {
          clearTimeout(this.#timer);
          this.#runNow(this.lastInput);
        }
        this.#waiters.push(resolve);
      });
    }
  }

  Aura.normalsCompute = { Compute };
})(window.Aura ??= {});
