"use strict";

(function (Aura) {
  const { Emitter } = Aura.emitter;

  /**
   * Undo/redo for one document (a sheet, a template…). Each step is a command { label, undo(), redo() } that knows how to
   * reverse itself, so a step costs what it changed, not a copy of the document.
   *
   * Steps pushed with the same mergeKey within mergeMs merge into one (a slider drag, nudging an import with the arrows):
   * the first step's undo and the last step's redo are kept.
   *
   * Dirty state is "not at the step that was saved", so undoing back to the saved state makes the document clean again.
   */
  class History extends Emitter {
    #done = [];
    #undone = [];
    #savedDepth = 0;
    #savedLost = false;
    #lastPush = { key: null, at: 0 };

    constructor({ limit = 300, mergeMs = 800 } = {}) {
      super();
      this.limit = limit;
      this.mergeMs = mergeMs;
    }

    get canUndo() { return this.#done.length > 0; }
    get canRedo() { return this.#undone.length > 0; }
    get undoLabel() { return this.#done.at(-1)?.label ?? ""; }
    /** The step Undo would revert, so its owner can amend it while it is still the latest (e.g. nudging an import). */
    get last() { return this.#done.at(-1) ?? null; }
    get redoLabel() { return this.#undone.at(-1)?.label ?? ""; }
    get dirty() { return this.#savedLost || this.#done.length !== this.#savedDepth; }

    /** Records a step that was already applied. */
    push(command, { mergeKey = null } = {}) {
      const now = performance.now();
      const previous = this.#done.at(-1);

      // Anything undone is gone once something new is done; if the saved state was among it, it can't be reached again.
      if (this.#undone.length && this.#savedDepth > this.#done.length) this.#savedLost = true;

      const merge = mergeKey && previous && this.#lastPush.key === mergeKey && now - this.#lastPush.at < this.mergeMs
        && this.#undone.length === 0 && this.#done.length !== this.#savedDepth;

      if (merge) {
        previous.redo = command.redo;
        previous.label = command.label ?? previous.label;
      } else {
        this.#done.push(command);
        if (this.#done.length > this.limit) {
          this.#done.shift();
          if (this.#savedDepth > 0) this.#savedDepth--;
          else this.#savedLost = true;
        }
      }

      this.#undone.length = 0;
      this.#lastPush = { key: mergeKey, at: now };
      this.emit("change");
    }

    /** Applies a command now and records it. */
    run(command, options) {
      command.redo();
      this.push(command, options);
    }

    undo() {
      const command = this.#done.pop();
      if (!command) return null;
      command.undo();
      this.#undone.push(command);
      this.#lastPush = { key: null, at: 0 };
      this.emit("change");
      return command;
    }

    redo() {
      const command = this.#undone.pop();
      if (!command) return null;
      command.redo();
      this.#done.push(command);
      this.#lastPush = { key: null, at: 0 };
      this.emit("change");
      return command;
    }

    /** Breaks merging: the next push starts a new step even with the same key. */
    seal() {
      this.#lastPush = { key: null, at: 0 };
    }

    markSaved() {
      this.#savedDepth = this.#done.length;
      this.#savedLost = false;
      this.#lastPush = { key: null, at: 0 };
      this.emit("change");
    }

    clear() {
      this.#done.length = 0;
      this.#undone.length = 0;
      this.#savedDepth = 0;
      this.#savedLost = false;
      this.emit("change");
    }
  }

  Aura.history = { History };
})(window.Aura ??= {});
