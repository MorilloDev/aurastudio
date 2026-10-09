"use strict";

(function (Aura) {
  const { baseName, dirName, joinPath, stripExt } = Aura.fs;

  // Companion files kept next to a sheet: the normal map (_n), the relief-only map (_d), painted/imported faces (_faces)
  // and an optional painted height (_height).
  const COMPANION = /_(n|d|faces|height)\.png$/i;

  function companionPath(sheetPath, suffix) {
    return joinPath(dirName(sheetPath), stripExt(baseName(sheetPath)) + suffix + ".png");
  }

  /**
   * The sheets a project offers: every atlas from atlases.json first (by id), then every other png that is not itself a
   * companion, so a texture not listed in any atlas can still get a map. Each entry:
   * { key, id, path, name, entry, atlas (bool), mgcb, rel, has: { n, d, faces, height } }
   */
  function listSheets(project) {
    const sheets = [];
    const used = new Set();
    for (const atlas of project.atlases) {
      if (!atlas.png || used.has(atlas.png.lower)) continue;
      used.add(atlas.png.lower);
      sheets.push(makeSheet(project, atlas.png, atlas.id, true));
    }
    for (const entry of project.files.values()) {
      if (!entry.lower.endsWith(".png") || used.has(entry.lower) || COMPANION.test(entry.name)) continue;
      sheets.push(makeSheet(project, entry, stripExt(entry.name), false));
    }
    sheets.sort((a, b) => (a.atlas === b.atlas ? a.id.localeCompare(b.id) : a.atlas ? -1 : 1));
    return sheets;
  }

  function makeSheet(project, entry, id, atlas) {
    const mgcb = project.mgcbFor(entry.path);
    const sheet = {
      key: entry.path, id, path: entry.path, name: entry.name, entry, atlas, mgcb,
      rel: mgcb ? project.contentPath(entry.path) : null,
    };
    refreshCompanions(project, sheet);
    return sheet;
  }

  function refreshCompanions(project, sheet) {
    sheet.has = {};
    for (const suffix of ["n", "d", "faces", "height"]) {
      sheet.has[suffix] = !!project.get(companionPath(sheet.path, "_" + suffix));
    }
  }

  /** A sheet opened from loose files (no project): companions come from the same batch, by name. */
  function looseSheet(files) {
    const byName = new Map();
    let main = null;
    for (const f of files) {
      if (!/\.png$/i.test(f.name)) continue;
      byName.set(f.name.toLowerCase(), f);
      if (!main && !COMPANION.test(f.name)) main = f;
    }
    if (!main) return null;
    const stem = stripExt(main.name).toLowerCase();
    const has = {};
    for (const suffix of ["n", "d", "faces", "height"]) has[suffix] = byName.has(`${stem}_${suffix}.png`);
    return { key: "loose:" + main.name, id: stripExt(main.name), path: main.name, name: main.name, file: main, files: byName, atlas: false, mgcb: null, rel: null, has };
  }

  Aura.normalsSheets = { COMPANION, companionPath, listSheets, refreshCompanions, looseSheet };
})(window.Aura ??= {});
