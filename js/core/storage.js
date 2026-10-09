"use strict";

(function (Aura) {


  // Persistence for conveniences (remembered folder, panel layout, per-sheet settings). Every call tolerates storage
  // being unavailable (private window, blocked site data): the studio must work without it.

  const PREFIX = "aura-studio:";

  const prefs = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch { /* optional */ }
    },
    remove(key) {
      try {
        localStorage.removeItem(PREFIX + key);
      } catch { /* optional */ }
    },
  };

  // File System Access handles can only be stored in IndexedDB.
  const DB_NAME = "aura-studio";
  let dbPromise = null;

  function db() {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  const idb = {
    async get(key) {
      try {
        const database = await db();
        return await new Promise((resolve) => {
          const req = database.transaction("kv").objectStore("kv").get(key);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
        });
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        const database = await db();
        await new Promise((resolve) => {
          const tx = database.transaction("kv", "readwrite");
          tx.objectStore("kv").put(value, key);
          tx.oncomplete = resolve;
          tx.onerror = resolve;
        });
      } catch { /* optional */ }
    },
  };

  Aura.storage = { prefs, idb };
})(window.Aura ??= {});
