"use strict";

(function (Aura) {
  const { Emitter } = Aura.emitter;
  const { baseName, dirName, ensurePermission, hasFolderAccess, joinPath, normalizePath, readJson } = Aura.fs;
  const { idb } = Aura.storage;

  // Folders never worth walking: build output, packages, editor and VCS data.
  const SKIP_FOLDERS = new Set(["bin", "obj", "node_modules", "packages", ".git", ".vs", ".idea", ".vscode", "dist",
    "testresults"]);
  const MAX_DEPTH = 14;

  /**
   * The open project folder, scanned once and shared by every tool. A file entry is
   * { path, name, lower, handle, dir } — path relative to the folder the user picked, lower its lowercase for lookups.
   *
   * The user may pick the repository root, the game project, Content or Assets: lookups that need a specific folder
   * (Assets/Data…) search for it instead of assuming where the root is.
   */
  class Project extends Emitter {
    constructor(root) {
      super();
      this.root = root;
      this.name = root.name;
      this.files = new Map();   // lower path -> entry
      this.mgcbs = [];          // entries of *.mgcb
      this.atlases = [];        // { id, texture, json: entry } from atlases.json
      this.scannedAt = 0;
    }

    /** Walks the whole folder once. Cheap enough to repeat after writes that add files (a few thousand entries). */
    async scan() {
      const files = new Map();
      const mgcbs = [];
      const walk = async (dir, path, depth) => {
        if (depth > MAX_DEPTH) return;
        for await (const [name, handle] of dir.entries()) {
          const lowerName = name.toLowerCase();
          const p = joinPath(path, name);
          if (handle.kind === "directory") {
            if (SKIP_FOLDERS.has(lowerName) || lowerName.startsWith(".")) continue;
            await walk(handle, p, depth + 1);
            continue;
          }
          const entry = { path: p, name, lower: p.toLowerCase(), handle, dir };
          files.set(entry.lower, entry);
          if (lowerName.endsWith(".mgcb")) mgcbs.push(entry);
        }
      };
      await walk(this.root, "", 0);
      this.files = files;
      this.mgcbs = mgcbs;
      this.atlases = await this.#readAtlases();
      this.scannedAt = Date.now();
      this.emit("scanned");
      return this;
    }

    /** Registers a file a tool just wrote, so lookups see it without walking the folder again. */
    addFile(path, handle, dir) {
      const entry = { path, name: baseName(path), lower: path.toLowerCase(), handle, dir };
      this.files.set(entry.lower, entry);
      return entry;
    }

    get(path) {
      return this.files.get(normalizePath(path).toLowerCase()) ?? null;
    }

    /** Every file whose path ends with suffix (lowercase compare), e.g. ".png" or "/data/tiles/". */
    filter(predicate) {
      const out = [];
      for (const entry of this.files.values()) if (predicate(entry)) out.push(entry);
      return out;
    }

    /** The .mgcb whose folder holds the path (the deepest, when several are nested): the content root for that file. */
    mgcbFor(path) {
      const lower = path.toLowerCase();
      let best = null;
      for (const m of this.mgcbs) {
        const folder = dirName(m.lower);
        if (folder === "" || lower.startsWith(folder + "/")) {
          if (!best || folder.length > dirName(best.lower).length) best = m;
        }
      }
      return best;
    }

    /** Path of a file relative to its content root (what ContentManager and the mgcb call it). */
    contentPath(path) {
      const mgcb = this.mgcbFor(path);
      const folder = mgcb ? dirName(mgcb.path) : "";
      return folder ? path.slice(folder.length + 1) : path;
    }

    /** Finds the png of a ContentManager path ("Assets/Tiles/Stone"), trying each content root. */
    resolveContentPng(contentPath) {
      const rel = contentPath.replace(/\.png$/i, "") + ".png";
      for (const m of this.mgcbs) {
        const hit = this.get(joinPath(dirName(m.path), rel));
        if (hit) return hit;
      }
      // Atlas paths start at Content; a project opened at Content itself or above without an mgcb still resolves.
      const tail = normalizePath(rel).toLowerCase();
      for (const entry of this.files.values()) {
        if (entry.lower === tail || entry.lower.endsWith("/" + tail)) return entry;
      }
      return null;
    }

    // atlases.json anywhere ({ "atlases": { id: "Content/path" } }), and any json inside a folder named Atlases.
    async #readAtlases() {
      const out = [];
      const seen = new Set();
      for (const entry of this.files.values()) {
        const isAtlasFile = entry.name.toLowerCase() === "atlases.json"
          || (entry.lower.endsWith(".json") && baseName(dirName(entry.lower)) === "atlases");
        if (!isAtlasFile) continue;
        let json;
        try {
          json = await readJson(entry.handle);
        } catch {
          continue;
        }
        if (!json || typeof json.atlases !== "object") continue;
        for (const [id, texture] of Object.entries(json.atlases)) {
          if (typeof texture !== "string" || seen.has(id)) continue;
          seen.add(id);
          out.push({ id, texture, json: entry, png: this.resolveContentPng(texture) });
        }
      }
      return out;
    }

    // -------------------------------------------------------------------------------------------------------------------
    // Opening

    static async pick() {
      const handle = await window.showDirectoryPicker({ id: "aura-project", mode: "readwrite" });
      await idb.set("project", handle);
      return new Project(handle);
    }

    /** The folder opened last time, if the browser still has it. Reopening needs a click (permission prompt). */
    static async recall() {
      if (!hasFolderAccess) return null;
      return idb.get("project");
    }

    static async reopen(handle) {
      if (!(await ensurePermission(handle))) throw new Error("Sin permiso para la carpeta.");
      return new Project(handle);
    }
  }

  Aura.project = { Project };
})(window.Aura ??= {});
