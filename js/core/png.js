"use strict";

(function (Aura) {


  // PNG decode/encode with exact pixels: no colour management and no premultiplication, since normal maps and masks are
  // data, not pictures.

  async function decodePng(blob) {
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    try {
      const canvas = makeCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      return { w: bitmap.width, h: bitmap.height, rgba: new Uint8ClampedArray(data) };
    } finally {
      bitmap.close();
    }
  }

  function encodePng(w, h, rgba) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG vacío"))), "image/png"));
  }

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  Aura.png = { decodePng, encodePng };
})(window.Aura ??= {});
