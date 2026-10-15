"use strict";

// Writing generated sprites into cells of a project sheet (and their normals into its _n), shared by the Bloques and
// Plantas tools. Every write keeps the previous files so a toast can put them back.
(function (Aura) {
  const { decodePng, encodePng } = Aura.png;
  const { joinPath, dirName, stripExt, writeInDir } = Aura.fs;
  const { companionPath, refreshCompanions } = Aura.sheetFiles;

  /** Cells for n sprites, row by row from start, wrapping at the sheet's width. */
  function layoutCells(start, n, cols) {
    const [cx, cy] = start;
    return Array.from({ length: n }, (_, i) => {
      const flat = cy * cols + cx + i;
      return [flat % cols, Math.floor(flat / cols)];
    });
  }

  /**
   * items: [{ cell: [x, y], result: { size, color, normal } }]. ctx: { project, studio }. Returns { written, backups,
   * dir } after writing; throws when a cell does not fit in the sheet.
   */
  async function writeCells(ctx, sheet, items, { saveN = true, sheetImg = null } = {}) {
    const { project } = ctx;
    const S = items[0].result.size;
    sheetImg ??= await decodePng(await sheet.entry.handle.getFile());
    for (const { cell: [cx, cy] } of items) {
      if ((cx + 1) * S > sheetImg.w || (cy + 1) * S > sheetImg.h) {
        throw new Error(`La celda [${cx}, ${cy}] de ${S} px no cabe en la hoja (${sheetImg.w}×${sheetImg.h}). Agranda la hoja o elige otra celda.`);
      }
    }
    const dir = sheet.entry.dir, folder = dirName(sheet.path);
    const backups = [];
    const write = async (name, w, hgt, rgba) => {
      const path = joinPath(folder, name);
      const existing = project.get(path);
      backups.push({ name, path, previous: existing ? await existing.handle.getFile() : null });
      const handle = await writeInDir(dir, name, await encodePng(w, hgt, rgba));
      project.addFile(path, handle, dir);
    };
    const paste = (target, tw, src, cx, cy) => {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const si = (y * S + x) * 4, di = ((cy * S + y) * tw + cx * S + x) * 4;
        for (let c = 0; c < 4; c++) target[di + c] = src[si + c];
      }
    };
    for (const { cell: [cx, cy], result } of items) paste(sheetImg.rgba, sheetImg.w, result.color, cx, cy);
    await write(sheet.name, sheetImg.w, sheetImg.h, sheetImg.rgba);
    const written = [sheet.name];
    if (saveN) {
      const nEntry = project.get(companionPath(sheet.path, "_n"));
      let nImg = nEntry ? await decodePng(await nEntry.handle.getFile()) : null;
      if (!nImg || nImg.w !== sheetImg.w || nImg.h !== sheetImg.h) {
        nImg = { w: sheetImg.w, h: sheetImg.h, rgba: new Uint8ClampedArray(sheetImg.w * sheetImg.h * 4) };
      }
      for (const { cell: [cx, cy], result } of items) paste(nImg.rgba, nImg.w, result.normal, cx, cy);
      const nName = stripExt(sheet.name) + "_n.png";
      await write(nName, nImg.w, nImg.h, nImg.rgba);
      written.push(nName);
    }
    refreshCompanions(project, sheet);
    return { written, backups, dir };
  }

  async function restore(ctx, dir, backups) {
    const { project, studio } = ctx;
    try {
      for (const b of backups) {
        if (b.previous) {
          const handle = await writeInDir(dir, b.name, b.previous);
          project.addFile(b.path, handle, dir);
        } else {
          await dir.removeEntry(b.name).catch(() => {});
          project.files.delete(b.path.toLowerCase());
        }
      }
      studio.toast("Archivos restaurados.", { kind: "ok" });
    } catch (err) {
      studio.toast("No pude restaurar.", { kind: "bad", detail: err.message });
    }
  }

  /** Status line and toast after a write, with the "Restaurar anterior" action. */
  function announce(ctx, sheet, items, { written, backups, dir }) {
    const where = items.length === 1 ? `[${items[0].cell.join(", ")}]` : `${items.length} celdas desde [${items[0].cell.join(", ")}]`;
    ctx.studio.setStatus(`Guardado en ${where}: ${written.join(", ")}.`, "ok");
    ctx.studio.toast("Guardado " + written.join(", "), {
      kind: "ok", detail: `${where} de ${sheet.id}`,
      action: { label: "Restaurar anterior", run: () => restore(ctx, dir, backups) },
    });
  }

  /** One PNG strip per map key: the results side by side, scaled up nearest-neighbour. */
  async function strip(results, key, scale) {
    const S = results[0].size, k = scale, W = S * k * results.length, H = S * k;
    const out = new Uint8ClampedArray(W * H * 4);
    results.forEach((result, i) => {
      const src = k > 1 ? Aura.blockEngine.upscale(result[key], S, k) : result[key];
      for (let y = 0; y < H; y++) out.set(src.subarray(y * S * k * 4, (y + 1) * S * k * 4), (y * W + i * S * k) * 4);
    });
    return encodePng(W, H, out);
  }

  Aura.sheetCells = { layoutCells, writeCells, restore, announce, strip };
})(window.Aura ??= {});
