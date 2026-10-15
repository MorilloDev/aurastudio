"use strict";

(function (Aura) {
  const { baseName, dirName, joinPath } = Aura.fs;

  /**
   * Adds "<sheet>_n.png" (or _d) to an mgcb's text by copying the sheet's own block — same importer, processor and size
   * options, so the two textures line up — with the settings that would corrupt a normal map switched off: compressed
   * formats, the colour key, and premultiplied alpha (the map is data; premultiplying would scale its RGB by alpha).
   * Pure: text in, text out, so it can be tested without a project.
   *
   * Returns { text, result } with result "already" | "copied" | "new". Line endings of the file are kept.
   */
  function addToMgcb(text, sheetRel, newName) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const norm = (p) => p.trim().replace(/\\/g, "/").toLowerCase();
    const newRel = joinPath(dirName(sheetRel.replace(/\\/g, "/")), newName);

    if (lines.some((l) => l.startsWith("#begin ") && norm(l.slice(7)) === norm(newRel))) return { text, result: "already" };

    const start = lines.findIndex((l) => l.startsWith("#begin ") && norm(l.slice(7)) === norm(sheetRel));
    let block, insertAt;
    if (start >= 0) {
      let end = start + 1;
      while (end < lines.length && lines[end].trim() !== "" && !lines[end].startsWith("#begin ")) end++;
      const written = lines[start].slice(7).trim();
      const target = written.slice(0, written.length - baseName(written.replace(/\\/g, "/")).length) + newName;
      block = lines.slice(start, end).map((l) => {
        let out = l.split(written).join(target);
        if (/^\/processorParam:TextureFormat=/i.test(out)) out = "/processorParam:TextureFormat=Color";
        if (/^\/processorParam:ColorKeyEnabled=/i.test(out)) out = "/processorParam:ColorKeyEnabled=False";
        if (/^\/processorParam:PremultiplyAlpha=/i.test(out)) out = "/processorParam:PremultiplyAlpha=False";
        return out;
      });
      insertAt = end;
    } else {
      block = [
        "#begin " + newRel,
        "/importer:TextureImporter",
        "/processor:TextureProcessor",
        "/processorParam:ColorKeyEnabled=False",
        "/processorParam:GenerateMipmaps=False",
        "/processorParam:PremultiplyAlpha=False",
        "/processorParam:ResizeToPowerOfTwo=False",
        "/processorParam:MakeSquare=False",
        "/processorParam:TextureFormat=Color",
        "/build:" + newRel,
      ];
      insertAt = lines.length;
      while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
    }
    lines.splice(insertAt, 0, "", ...block);
    return { text: lines.join(eol), result: start >= 0 ? "copied" : "new" };
  }

  Aura.mgcb = { addToMgcb };
})(window.Aura ??= {});
