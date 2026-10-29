"use strict";

// The game's texts (Data/Lang/<code>.json, read by Aura.Core.Localization.Lang): what the player reads for every tile,
// item, biome and weapon mod, by key — "item.aura.raw_meat.name". Spanish (es_es) is the base the game is written in,
// English (en_us) a translation; a JSON's own "name" is only the fallback when a key is missing. Loaded once per project
// by the shell and shared by every tool: the Atlas, Biomes and Recetas show and edit the same texts. Edits stay in memory
// until a tool saves (its Ctrl+S writes these files too).
(function (Aura) {
  const { Emitter } = Aura.emitter;
  const { readText, writeHandle, writeInDir, baseName, dirName } = Aura.fs;

  const BASE = "es_es";
  const NAMESPACE = "aura";

  // The languages the Studio edits side by side, base first. Others found in the folder are kept as they are.
  const EDITED = [
    { code: "es_es", label: "Español" },
    { code: "en_us", label: "English" },
  ];

  const isLangFile = (entry) => /(^|\/)data\/lang\/[^/]+\.json$/.test(entry.lower);

  /** "item.aura.raw_meat.name" for ("item", "raw_meat" or "aura:raw_meat", "name") — as Lang.ContentKey builds it. */
  function contentKey(kind, id, field) {
    const raw = String(id ?? "");
    const colon = raw.indexOf(":");
    const ns = colon > 0 ? raw.slice(0, colon) : NAMESPACE;
    const path = colon >= 0 ? raw.slice(colon + 1) : raw;
    return `${kind}.${ns}.${path}.${field}`;
  }

  class LangStore extends Emitter {
    docs = new Map();   // code -> { code, entry, eol, data: { language, strings }, dirty, isNew }
    folder = null;      // { dir handle, path } of the Lang folder new files go into
    errors = [];

    get languages() { return EDITED; }
    get available() { return this.docs.size > 0; }
    get dirty() { return [...this.docs.values()].some((d) => d.dirty); }

    /** Reads every Data/Lang/*.json of the base game (the first Data folder that has one). */
    async load(project) {
      this.docs.clear();
      this.errors = [];
      this.folder = null;

      const files = project.filter(isLangFile).sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
      if (!files.length) {
        // No Lang folder yet: it goes beside Data/Items, created on the first save.
        const items = project.filter((e) => /(^|\/)data\/items\/[^/]+\.json$/.test(e.lower))[0];
        if (items) this.folder = { dataPath: dirName(dirName(items.path)), dataDir: null };
        this.emit("changed");
        return;
      }

      const folderPath = dirName(files[0].path);
      this.folder = { path: folderPath, dir: files[0].dir };
      for (const entry of files) {
        if (dirName(entry.path) !== folderPath) continue;
        const code = baseName(entry.path).replace(/\.json$/i, "").toLowerCase();
        try {
          const text = await readText(entry.handle);
          const data = JSON.parse(text);
          if (!data.strings || typeof data.strings !== "object") data.strings = {};
          this.docs.set(code, { code, entry, eol: text.includes("\r\n") ? "\r\n" : "\n", data, dirty: false, isNew: false });
        } catch (err) {
          this.errors.push(`${entry.name}: ${err.message}`);
        }
      }
      this.emit("changed");
    }

    get(key, code = BASE) {
      return this.docs.get(code)?.data.strings[key];
    }

    /** What the player reads in the base language: the Spanish text, else the JSON's own name. */
    display(kind, id, fallback) {
      return this.get(contentKey(kind, id, "name")) ?? fallback;
    }

    /** Sets (or, with an empty text, removes) one key in one language. A new key goes after the last key of its
     * group ("item.", "tile."…) so the file stays grouped the way it was written. */
    set(key, code, text) {
      const doc = this.#docFor(code);
      if (!doc) return false;
      const strings = doc.data.strings;
      const value = typeof text === "string" ? text : "";
      if (!value) {
        if (!(key in strings)) return false;
        delete strings[key];
      } else if (key in strings) {
        if (strings[key] === value) return false;
        strings[key] = value;
      } else {
        doc.data.strings = insertGrouped(strings, key, value);
      }
      doc.dirty = true;
      this.emit("changed", key);
      return true;
    }

    /** Moves every text of a content id to its new id (a tile or item renamed in the Atlas). */
    renameContent(kind, oldId, newId) {
      if (!oldId || !newId || oldId === newId) return;
      const from = contentKey(kind, oldId, "");
      const to = contentKey(kind, newId, "");
      for (const doc of this.docs.values()) {
        let moved = false;
        const out = {};
        for (const [k, v] of Object.entries(doc.data.strings)) {
          if (k.startsWith(from)) { out[to + k.slice(from.length)] = v; moved = true; }
          else out[k] = v;
        }
        if (moved) { doc.data.strings = out; doc.dirty = true; }
      }
      this.emit("changed");
    }

    /** Keys the edited languages lack for these ids: [{ kind, id, field, code }]. */
    missing(kind, ids, fields = ["name"]) {
      const out = [];
      if (!this.available) return out;
      for (const id of ids)
        for (const field of fields)
          for (const { code } of EDITED)
            if (this.docs.has(code) && this.get(contentKey(kind, id, field), code) === undefined) out.push({ kind, id, field, code });
      return out;
    }

    /** Writes the changed language files. Returns their names. */
    async save() {
      const written = [];
      for (const doc of this.docs.values()) {
        if (!doc.dirty) continue;
        const text = JSON.stringify(doc.data, null, 2).replace(/\n/g, doc.eol) + doc.eol;
        if (doc.entry) {
          await writeHandle(doc.entry.handle, text);
        } else if (this.folder?.dir) {
          const handle = await writeInDir(this.folder.dir, `${doc.code}.json`, text);
          doc.entry = { handle, name: `${doc.code}.json`, path: `${this.folder.path}/${doc.code}.json` };
        } else {
          throw new Error("No hay carpeta Data/Lang donde escribir: créala junto a Data/Items.");
        }
        doc.dirty = false;
        doc.isNew = false;
        written.push(`${doc.code}.json`);
      }
      if (written.length) this.emit("saved", written);
      return written;
    }

    #docFor(code) {
      let doc = this.docs.get(code);
      if (doc) return doc;
      if (!this.folder?.dir) return null;
      const label = EDITED.find((l) => l.code === code)?.label ?? code;
      doc = { code, entry: null, eol: "\r\n", data: { language: label, strings: {} }, dirty: true, isNew: true };
      this.docs.set(code, doc);
      return doc;
    }
  }

  // Object key order is the file's order: a new key is placed after the last key sharing its first segment.
  function insertGrouped(strings, key, value) {
    const group = key.slice(0, key.indexOf(".") + 1);
    const keys = Object.keys(strings);
    let at = -1;
    for (let i = 0; i < keys.length; i++) if (group && keys[i].startsWith(group)) at = i;
    if (at < 0) return { ...strings, [key]: value };
    const out = {};
    keys.forEach((k, i) => {
      out[k] = strings[k];
      if (i === at) out[key] = value;
    });
    return out;
  }

  Aura.lang = new LangStore();
  Aura.langKeys = { contentKey, BASE };
})(window.Aura ??= {});
