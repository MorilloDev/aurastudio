"use strict";

// Loads the Studio's plant pipeline outside the browser. The generators, the mesh builder and the rasterizer have no
// DOM in them on purpose (see js/tools/plants/raster.js), so the same code that draws the preview in the page draws the
// sprites that go into the game — a plant made here and one made in the Plantas tab come out identical.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILES = [
  "js/tools/blocks/shapes.js",
  "js/tools/blocks/engine.js",
  "js/tools/plants/mesh.js",
  "js/tools/plants/generators.js",
  "js/tools/plants/generators-more.js",
  "js/tools/plants/generators-crops.js",
  "js/tools/plants/generators-leaves.js",
  "js/tools/plants/raster.js",
];

globalThis.Aura ??= {};
for (const file of FILES) new Function(fs.readFileSync(path.join(ROOT, file), "utf8"))();

const A = globalThis.Aura;

/** The varieties of a type, by key: presets("FLOWER").ROSE is the rose's own values. */
const presets = (type) => Object.fromEntries((A.plantGen.PRESETS[type] ?? []).map((p) => [p.key, p.values]));

/**
 * Renders one plant. Returns its cells bottom first, each { size, color, normal } as RGBA byte arrays.
 * opts are the same options the Plantas panel writes.
 */
function render(type, opts, rasterOpts = {}) {
  const mesh = A.plantGen.build(type, opts);
  return A.plantRaster.renderParts(mesh, A.plantRaster.merge(rasterOpts), opts.groundZ ?? 0, mesh.cells);
}

// ── PNG ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A minimal encoder: one IDAT, no interlacing, filter 0 per row. Enough for a sprite sheet, and it keeps this script
// free of any dependency to install.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** rgba: a width*height*4 byte array. */
function encodePNG(rgba, width, height) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer ?? rgba, (rgba.byteOffset ?? 0) + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", require("zlib").deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function decodePNG(file) {
  const zlib = require("zlib");
  const buf = fs.readFileSync(file);
  let at = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2))
    throw new Error(`${path.basename(file)}: only 8-bit RGB/RGBA is read here (depth ${bitDepth}, type ${colorType})`);

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  const line = Buffer.alloc(stride), prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xFF;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4 + 0] = line[x * channels + 0];
      out[(y * width + x) * 4 + 1] = line[x * channels + 1];
      out[(y * width + x) * 4 + 2] = line[x * channels + 2];
      out[(y * width + x) * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    line.copy(prev);
  }
  return { width, height, rgba: out };
}

/** A sheet in memory: read it, paste cells into it, write it back. */
class Sheet {
  constructor(file, cell = 64) {
    this.file = file;
    this.cell = cell;
    const img = decodePNG(file);
    this.width = img.width;
    this.height = img.height;
    this.rgba = img.rgba;
  }

  get cols() { return Math.floor(this.width / this.cell); }
  get rows() { return Math.floor(this.height / this.cell); }

  /** Grows the sheet downward to hold `rows` rows of cells; new space is transparent. */
  ensureRows(rows) {
    const wanted = rows * this.cell;
    if (wanted <= this.height) return;
    const grown = new Uint8Array(this.width * wanted * 4);
    grown.set(this.rgba, 0);
    this.rgba = grown;
    this.height = wanted;
  }

  paste(col, row, cellRgba) {
    this.ensureRows(row + 1);
    const c = this.cell;
    for (let y = 0; y < c; y++) {
      const src = y * c * 4;
      const dst = ((row * c + y) * this.width + col * c) * 4;
      this.rgba.set(cellRgba.subarray(src, src + c * 4), dst);
    }
  }

  /** True when every pixel of a cell is transparent. */
  isEmpty(col, row) {
    const c = this.cell;
    if ((row + 1) * c > this.height || (col + 1) * c > this.width) return true;
    for (let y = 0; y < c; y++) {
      const at = ((row * c + y) * this.width + col * c) * 4;
      for (let x = 0; x < c; x++) if (this.rgba[at + x * 4 + 3] > 8) return false;
    }
    return true;
  }

  save() { fs.writeFileSync(this.file, encodePNG(this.rgba, this.width, this.height)); }
}

module.exports = { A, presets, render, Sheet, encodePNG, decodePNG };
