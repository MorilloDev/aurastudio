"use strict";

(function (Aura) {
  // The whole generator is one self-contained function: its source text starts the Web Worker (normals/compute.js), since
  // a page opened from disk cannot load a worker from a separate file. Nothing inside may refer to anything outside it.
  function normalsGeneratorFactory() {
    // Aura normal maps — the generator. Same algorithm as the Aura Iso Normals Aseprite extension (v3.4), ported so it runs
    // in a Web Worker. Input: the sheet's RGBA, optional height RGBA, face overrides painted in the tool, and the settings.
    // Output: one normal per opaque pixel (OpenGL style, green up) plus the base orientation (faces without bumps).

    const FACE_TOP = [128, 238, 191];
    const FACE_LEFT = [37, 83, 206];
    const FACE_RIGHT = [218, 83, 206];
    const FACE_FRONT = [128, 128, 255];

    function normalize(x, y, z) {
      const len = Math.sqrt(x * x + y * y + z * z);
      if (len < 1e-6) return [0, 0, 1];
      return [x / len, y / len, z / len];
    }

    function decode(r, g, b) {
      return normalize(r / 255 * 2 - 1, g / 255 * 2 - 1, b / 255 * 2 - 1);
    }

    function encodeChannel(v) {
      const n = Math.floor((v * 0.5 + 0.5) * 255 + 0.5);
      return n < 0 ? 0 : (n > 255 ? 255 : n);
    }

    // Reoriented normal mapping: bends a detail normal made for a flat picture onto the base normal. Same formula as the
    // game's NormalMapLoader.Reorient.
    function reorient(bx, by, bz, dx, dy, dz) {
      const tx = bx, ty = by, tz = bz + 1;
      const ux = -dx, uy = -dy, uz = dz;
      if (tz < 1e-4) return [bx, by, bz];
      const k = (tx * ux + ty * uy + tz * uz) / tz;
      return normalize(tx * k - ux, ty * k - uy, tz * k - uz);
    }

    // Inverse of reorient: the detail normal that reorient(b, detail) turns into n. Reorient rotates (0,0,1) onto b along the
    // shortest arc; rotating back is the same construction toward b mirrored in x and y.
    function unorient(bx, by, bz, nx, ny, nz) {
      return reorient(-bx, -by, bz, nx, ny, nz);
    }

    // Pixel-art normals: the lean snapped to a few steps, so shading comes out in flat bands. steps 0 = untouched.
    function quantize(x, y, z, steps) {
      if (steps <= 0) return [x, y, z];
      const qx = Math.floor(x * steps + 0.5) / steps;
      const qy = Math.floor(y * steps + 0.5) / steps;
      return normalize(qx, qy, Math.max(0.2, z));
    }

    const TOP = decode(...FACE_TOP);
    const LEFT = decode(...FACE_LEFT);
    const RIGHT = decode(...FACE_RIGHT);
    const FRONT = decode(...FACE_FRONT);

    const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    // Everything one run needs, so the helpers do not pass a dozen arrays around.
    function makeContext(w, h) {
      const n = w * h;
      return {
        w, h,
        alpha: new Uint8Array(n),
        lum: new Float32Array(n),
        colour: new Int32Array(n),
        sat: new Float32Array(n),
        hue: new Float32Array(n),
        pieces: new Int32Array(n),
        dist: new Int32Array(n),
        near: new Float32Array(n),
        wide: new Float32Array(n),
        rowSum: new Float32Array(n),
        rowCount: new Float32Array(n),
        loc: new Int32Array(n).fill(-1),
        label: new Int8Array(n),
        region: new Int32Array(n),
        regionMean: [],
        bx: new Float32Array(n), by: new Float32Array(n), bz: new Float32Array(n),
        hasBase: new Uint8Array(n),
        key: new Float64Array(n),
      };
    }

    function setBase(ctx, i, v, k) {
      ctx.bx[i] = v[0]; ctx.by[i] = v[1]; ctx.bz[i] = v[2];
      ctx.hasBase[i] = 1;
      ctx.key[i] = k;
    }

    // ---------------------------------------------------------------------------------------------------------------------
    // Pieces: connected groups of opaque pixels, never crossing a cell border (two tiles touching are two pieces)
    // ---------------------------------------------------------------------------------------------------------------------

    function findPieces(ctx, cellW, cellH) {
      const { w, h, alpha, pieces } = ctx;
      const members = [null];
      let count = 0;
      for (let sy = 0; sy < h; sy++) {
        for (let sx = 0; sx < w; sx++) {
          const s = sy * w + sx;
          if (alpha[s] === 0 || pieces[s] !== 0) continue;
          count++;
          const list = [s];
          pieces[s] = count;
          const cx = Math.floor(sx / cellW), cy = Math.floor(sy / cellH);
          for (let head = 0; head < list.length; head++) {
            const i = list[head];
            const x = i % w, y = (i / w) | 0;
            for (let oy = -1; oy <= 1; oy++) {
              for (let ox = -1; ox <= 1; ox++) {
                const nx = x + ox, ny = y + oy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                if (Math.floor(nx / cellW) !== cx || Math.floor(ny / cellH) !== cy) continue;
                const j = ny * w + nx;
                if (alpha[j] > 0 && pieces[j] === 0) {
                  pieces[j] = count;
                  list.push(j);
                }
              }
            }
          }
          members.push(list);
        }
      }
      return members;
    }

    // Distance of every opaque pixel to its piece's outline (1 on the edge).
    function pieceDistances(ctx, members) {
      const { w, h, pieces, dist } = ctx;
      for (let p = 1; p < members.length; p++) {
        const list = members[p];
        const queue = [];
        for (const i of list) {
          const x = i % w, y = (i / w) | 0;
          let edge = false;
          for (let oy = -1; oy <= 1 && !edge; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const nx = x + ox, ny = y + oy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h || pieces[ny * w + nx] !== pieces[i]) { edge = true; break; }
            }
          }
          if (edge) { dist[i] = 1; queue.push(i); }
        }
        for (let head = 0; head < queue.length; head++) {
          const i = queue[head];
          const x = i % w, y = (i / w) | 0;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const nx = x + ox, ny = y + oy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const j = ny * w + nx;
              if (pieces[j] === pieces[i] && dist[j] === 0) {
                dist[j] = dist[i] + 1;
                queue.push(j);
              }
            }
          }
        }
      }
    }

    // ---------------------------------------------------------------------------------------------------------------------
    // Tones
    // ---------------------------------------------------------------------------------------------------------------------

    // Mean of values in a square window (radius r) over the piece's own pixels — two separable passes.
    function boxMean(ctx, values, list, r, out) {
      const { w, h, pieces, rowSum, rowCount } = ctx;
      for (const i of list) {
        const x = i % w, y = (i / w) | 0, p = pieces[i];
        let sum = 0, n = 0;
        for (let ox = -r; ox <= r; ox++) {
          const nx = x + ox;
          if (nx < 0 || nx >= w) continue;
          const j = y * w + nx;
          if (pieces[j] === p) { sum += values[j]; n++; }
        }
        rowSum[i] = sum; rowCount[i] = n;
      }
      for (const i of list) {
        const x = i % w, y = (i / w) | 0, p = pieces[i];
        let sum = 0, n = 0;
        for (let oy = -r; oy <= r; oy++) {
          const ny = y + oy;
          if (ny < 0 || ny >= h) continue;
          const j = ny * w + x;
          if (pieces[j] === p) { sum += rowSum[j]; n += rowCount[j]; }
        }
        out[i] = sum / n;
      }
    }

    // Median brightness around each pixel from a 32-step histogram: ignores specks and keeps borders in place.
    function boxMedian(ctx, list, r, out) {
      const { w, h, pieces, lum } = ctx;
      const bins = new Int32Array(32);
      for (const i of list) {
        const x = i % w, y = (i / w) | 0, p = pieces[i];
        bins.fill(0);
        let n = 0;
        for (let oy = -r; oy <= r; oy++) {
          const ny = y + oy;
          if (ny < 0 || ny >= h) continue;
          for (let ox = -r; ox <= r; ox++) {
            const nx = x + ox;
            if (nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (pieces[j] === p) {
              bins[Math.min(31, Math.floor(lum[j] * 32))]++;
              n++;
            }
          }
        }
        const half = n / 2;
        let run = 0;
        for (let b = 0; b < 32; b++) {
          run += bins[b];
          if (run >= half) {
            const before = run - bins[b];
            out[i] = (b + (half - before) / Math.max(bins[b], 1)) / 32;
            break;
          }
        }
      }
    }

    // The tone a face is painted in: the most common tone in a 5×5 window, colours within a few steps counting as one.
    const ToneTolerance = 0.025;

    function modeTone(ctx, list, out) {
      const { w, h, pieces, colour, lum } = ctx;
      const cols = [], cnt = [], lums = [];
      for (const i of list) {
        const x = i % w, y = (i / w) | 0;
        cols.length = 0; cnt.length = 0; lums.length = 0;
        for (let oy = -2; oy <= 2; oy++) {
          for (let ox = -2; ox <= 2; ox++) {
            const nx = x + ox, ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (pieces[j] !== pieces[i]) continue;
            const k = cols.indexOf(colour[j]);
            if (k < 0) { cols.push(colour[j]); cnt.push(1); lums.push(lum[j]); } else cnt[k]++;
          }
        }
        let best = lum[i], bestScore = -1;
        for (let a = 0; a < cols.length; a++) {
          let score = 0, weighted = 0;
          for (let b = 0; b < cols.length; b++) {
            if (Math.abs(lums[b] - lums[a]) <= ToneTolerance) { score += cnt[b]; weighted += cnt[b] * lums[b]; }
          }
          if (score > bestScore) { best = weighted / score; bestScore = score; }
        }
        out[i] = best;
      }
    }

    // 1D k-means into three tones, sorted dark → light.
    function threeTones(values) {
      values.sort();
      const n = values.length;
      const at = (f) => values[Math.max(1, Math.floor(n * f)) - 1];
      const c = [at(0.15), at(0.5), at(0.85)];
      for (let it = 0; it < 10; it++) {
        const sum = [0, 0, 0], cnt = [0, 0, 0];
        for (let q = 0; q < n; q++) {
          const v = values[q];
          let best = 0, bd = Math.abs(v - c[0]);
          for (let k = 1; k < 3; k++) {
            const d = Math.abs(v - c[k]);
            if (d < bd) { best = k; bd = d; }
          }
          sum[best] += v; cnt[best]++;
        }
        for (let k = 0; k < 3; k++) if (cnt[k] > 0) c[k] = sum[k] / cnt[k];
      }
      c.sort((a, b) => a - b);
      return c;
    }

    // ---------------------------------------------------------------------------------------------------------------------
    // Segmentation of one piece into its painted faces
    // ---------------------------------------------------------------------------------------------------------------------

    // Returns { c (tone centres or null), count (last region id) }; writes ctx.label / ctx.region / ctx.regionMean.
    function segmentPiece(ctx, list, minContrast, regionBase) {
      const { w, h, pieces, colour, lum, near, wide, loc } = ctx;
      const n = list.length;

      const flat = () => {
        for (const i of list) { ctx.label[i] = 0; ctx.region[i] = regionBase + 1; }
        ctx.regionMean[regionBase + 1] = 0.5;
        return { c: null, count: regionBase + 1 };
      };
      if (n < 6) return flat();

      // Flat-colour art is read by its most common tones (crisp borders); noisy textures by medians (see through noise).
      const seen = new Set();
      for (const i of list) seen.add(colour[i]);
      const noisy = seen.size > n * 0.12;
      if (!noisy) {
        modeTone(ctx, list, near);
        boxMean(ctx, near, list, 1, wide);
      } else {
        boxMedian(ctx, list, 4, wide);
        boxMedian(ctx, list, 2, near);
      }

      const values = new Float64Array(n);
      for (let k = 0; k < n; k++) values[k] = wide[list[k]];
      const c = threeTones(values);
      const range = c[2] - c[0];
      if (range < minContrast) return flat();

      for (let k = 0; k < n; k++) loc[list[k]] = k;

      let label = new Int8Array(n);
      for (let k = 0; k < n; k++) {
        const v = wide[list[k]];
        let best = 1, bd = Math.abs(v - c[0]);
        for (let q = 2; q <= 3; q++) {
          const d = Math.abs(v - c[q - 1]);
          if (d < bd) { best = q; bd = d; }
        }
        label[k] = best;
      }

      // Contrast-sensitive smoothing: a neighbour's pull fades with the tone difference, so borders stay on painted edges.
      const nb = new Int32Array(n * 8), nbw = new Float32Array(n * 8), nbc = new Uint8Array(n);
      let sqSum = 0, sqCount = 0;
      for (let k = 0; k < n; k++) {
        const i = list[k];
        const x = i % w, y = (i / w) | 0, p = pieces[i];
        let m = 0;
        for (const [ox, oy] of N8) {
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (pieces[j] !== p) continue;
          nb[k * 8 + m] = loc[j];
          const d = near[i] - near[j];
          sqSum += d * d; sqCount++;
          m++;
        }
        nbc[k] = m;
      }
      const falloff = 1 / (2 * Math.max(sqSum / Math.max(sqCount, 1), 0.0004));
      for (let k = 0; k < n; k++) {
        const i = list[k];
        for (let m = 0; m < nbc[k]; m++) {
          const d = near[i] - near[list[nb[k * 8 + m]]];
          nbw[k * 8 + m] = Math.exp(-falloff * d * d);
        }
      }

      const beta = noisy ? 2.2 : 1.2;
      for (let it = 0; it < 6; it++) {
        const out = new Int8Array(n);
        for (let k = 0; k < n; k++) {
          const same = [0, 0, 0, 0];
          let total = 0;
          for (let m = 0; m < nbc[k]; m++) {
            const wgt = nbw[k * 8 + m];
            same[label[nb[k * 8 + m]]] += wgt;
            total += wgt;
          }
          const v = near[list[k]];
          let best = label[k], bestCost = Infinity;
          for (let q = 1; q <= 3; q++) {
            const cost = Math.abs(v - c[q - 1]) / range + beta * (total - same[q]) / Math.max(nbc[k], 1);
            if (cost < bestCost) { best = q; bestCost = cost; }
          }
          out[k] = best;
        }
        label = out;
      }

      // Regions: connected runs of one label. Specks, interior strips (plank grooves) and enclosed patches (stains, ore
      // veins) take the label most common around them.
      const minRegion = Math.max(8, Math.floor(n * 0.015));
      const regionOf = new Int32Array(n);
      const mark = new Int32Array(n);
      const depth = new Int32Array(n);
      let stamp = 0;

      const inBoundsLocal = (nx, ny, p) => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return -1;
        const j = ny * w + nx;
        return pieces[j] === p ? j : -1;
      };

      const isInteriorStrip = (members) => {
        stamp++;
        for (const k of members) mark[k] = stamp;
        let onOutline = 0;
        const queue = [];
        for (const k of members) {
          const i = list[k];
          const x = i % w, y = (i / w) | 0;
          let border = false, outline = false;
          for (const [ox, oy] of N4) {
            const j = inBoundsLocal(x + ox, y + oy, pieces[i]);
            if (j < 0) { border = true; outline = true; } else if (mark[loc[j]] !== stamp) border = true;
          }
          if (outline) onOutline++;
          depth[k] = 0;
          if (border) { depth[k] = 1; queue.push(k); }
        }
        let deepest = 1;
        for (let head = 0; head < queue.length; head++) {
          const k = queue[head];
          const i = list[k];
          const x = i % w, y = (i / w) | 0;
          for (const [ox, oy] of N4) {
            const j = inBoundsLocal(x + ox, y + oy, pieces[i]);
            if (j < 0) continue;
            const q = loc[j];
            if (mark[q] === stamp && depth[q] === 0) {
              depth[q] = depth[k] + 1;
              if (depth[q] > deepest) deepest = depth[q];
              queue.push(q);
            }
          }
        }
        return deepest <= 2 && onOutline < members.length * 0.3;
      };

      const isEnclosedPatch = (members) => {
        stamp++;
        for (const k of members) mark[k] = stamp;
        const around = [0, 0, 0, 0];
        let aroundTotal = 0;
        for (const k of members) {
          const i = list[k];
          const x = i % w, y = (i / w) | 0;
          for (const [ox, oy] of N4) {
            const j = inBoundsLocal(x + ox, y + oy, pieces[i]);
            if (j < 0) return false;
            const q = loc[j];
            if (mark[q] !== stamp) { around[label[q]]++; aroundTotal++; }
          }
        }
        if (aroundTotal === 0 || members.length > n * 0.2) return false;
        for (let q = 1; q <= 3; q++) if (around[q] >= aroundTotal * 0.75) return true;
        return false;
      };

      for (let pass = 1; pass <= 3; pass++) {
        regionOf.fill(0);
        const regions = [];
        let count = regionBase;
        for (let s = 0; s < n; s++) {
          if (regionOf[s] !== 0) continue;
          count++;
          const members = [s];
          regionOf[s] = count;
          for (let head = 0; head < members.length; head++) {
            const i = list[members[head]];
            const x = i % w, y = (i / w) | 0;
            for (let oy = -1; oy <= 1; oy++) {
              for (let ox = -1; ox <= 1; ox++) {
                const j = inBoundsLocal(x + ox, y + oy, pieces[list[s]]);
                if (j < 0) continue;
                const q = loc[j];
                if (regionOf[q] === 0 && label[q] === label[s]) {
                  regionOf[q] = count;
                  members.push(q);
                }
              }
            }
          }
          regions.push([count, members]);
        }

        if (pass === 3) {
          for (const [id, members] of regions) {
            let sum = 0;
            for (const k of members) sum += wide[list[k]];
            ctx.regionMean[id] = sum / members.length;
          }
          for (let k = 0; k < n; k++) {
            const i = list[k];
            ctx.label[i] = label[k];
            ctx.region[i] = regionOf[k];
            loc[i] = -1;
          }
          return { c, count };
        }

        for (const [, members] of regions) {
          if (members.length < minRegion || isInteriorStrip(members) || isEnclosedPatch(members)) {
            const votes = [0, 0, 0, 0];
            for (const k of members) {
              const i = list[k];
              const x = i % w, y = (i / w) | 0;
              for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                  const j = inBoundsLocal(x + ox, y + oy, pieces[i]);
                  if (j < 0) continue;
                  const q = loc[j];
                  if (regionOf[q] !== regionOf[k]) votes[label[q]]++;
                }
              }
            }
            let best = label[members[0]];
            for (let q = 1; q <= 3; q++) if (votes[q] > votes[best]) best = q;
            for (const k of members) label[k] = best;
          }
        }
      }
      return null;
    }

    // Splits a piece into materials (noisy thatch vs flat wood) before reading faces; each large part gets its own id.
    function splitByMaterial(ctx, list, nextId) {
      const { w, h, lum, pieces, loc } = ctx;
      const n = list.length;
      for (let k = 0; k < n; k++) loc[list[k]] = k;

      let noisyAt = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        const i = list[k];
        const x = i % w, y = (i / w) | 0, p = pieces[i];
        let sum = 0, sq = 0, c = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox, ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (pieces[j] === p) { sum += lum[j]; sq += lum[j] * lum[j]; c++; }
          }
        }
        const mean = sum / c;
        noisyAt[k] = Math.sqrt(Math.max(0, sq / c - mean * mean)) > 0.05 ? 1 : 0;
      }

      for (let it = 0; it < 3; it++) {
        const out = new Uint8Array(n);
        for (let k = 0; k < n; k++) {
          const i = list[k];
          const x = i % w, y = (i / w) | 0, p = pieces[i];
          let yes = 0, c = 0;
          for (let oy = -2; oy <= 2; oy++) {
            for (let ox = -2; ox <= 2; ox++) {
              const nx = x + ox, ny = y + oy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const j = ny * w + nx;
              if (pieces[j] === p) { c++; if (noisyAt[loc[j]]) yes++; }
            }
          }
          out[k] = yes * 2 > c ? 1 : 0;
        }
        noisyAt = out;
      }

      let noisyCount = 0;
      for (let k = 0; k < n; k++) noisyCount += noisyAt[k];
      const minPart = Math.max(24, Math.floor(n * 0.08));
      const done = (result) => { for (const i of list) loc[i] = -1; return result; };
      if (noisyCount < minPart || n - noisyCount < minPart) return done({ parts: [list], nextId });

      const original = pieces[list[0]];
      const assigned = new Uint8Array(n);
      let parts = [];
      for (let s = 0; s < n; s++) {
        if (assigned[s]) continue;
        const members = [list[s]];
        assigned[s] = 1;
        for (let head = 0; head < members.length; head++) {
          const i = members[head];
          const x = i % w, y = (i / w) | 0;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const nx = x + ox, ny = y + oy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const j = ny * w + nx;
              if (pieces[j] !== original) continue;
              const q = loc[j];
              if (!assigned[q] && noisyAt[q] === noisyAt[s]) { assigned[q] = 1; members.push(j); }
            }
          }
        }
        parts.push(members);
      }

      parts = parts.map((p, order) => [p, order]).sort((a, b) => b[0].length - a[0].length || a[1] - b[1]).map((e) => e[0]);
      const result = [parts[0]];
      for (let k = 1; k < parts.length; k++) {
        if (parts[k].length >= minPart) {
          nextId++;
          for (const i of parts[k]) pieces[i] = nextId;
          result.push(parts[k]);
        } else {
          for (const i of parts[k]) parts[0].push(i);
        }
      }
      return done({ parts: result, nextId });
    }

    // Light = top, mid = lit side, dark = shaded side; a large region between two tones gets a normal between those faces.
    function shadedNormals(ctx, list, c, litLeft) {
      const lit = litLeft ? LEFT : RIGHT, shade = litLeft ? RIGHT : LEFT;
      const byLabel = [null, shade, lit, TOP];
      const regionSize = new Map();
      for (const i of list) regionSize.set(ctx.region[i], (regionSize.get(ctx.region[i]) || 0) + 1);
      for (const i of list) {
        const l = ctx.label[i];
        let v = FRONT;
        if (l > 0) {
          v = byLabel[l];
          const m = ctx.regionMean[ctx.region[i]];
          for (let k = 1; k <= 2; k++) {
            if (regionSize.get(ctx.region[i]) >= list.length * 0.06 && m > c[k - 1] && m < c[k]) {
              const f = (m - c[k - 1]) / (c[k] - c[k - 1]);
              if (f > 0.38 && f < 0.62) {
                const a = byLabel[k], b = byLabel[k + 1];
                v = normalize(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
              }
            }
          }
        }
        setBase(ctx, i, v, ctx.region[i]);
      }
    }

    // Which side the artist lit: across all shaded pieces, is the mid tone mostly left of the dark one?
    function litSideFromArt(ctx, segments) {
      const w = ctx.w;
      let leftVotes = 0, rightVotes = 0;
      for (const seg of segments) {
        if (!seg.c) continue;
        let sx = 0;
        for (const i of seg.list) sx += i % w;
        const centre = sx / seg.list.length;
        let mid = 0, midN = 0, dark = 0, darkN = 0;
        for (const i of seg.list) {
          const l = ctx.label[i];
          if (l === 2) { mid += i % w - centre; midN++; } else if (l === 1) { dark += i % w - centre; darkN++; }
        }
        if (midN > 0 && darkN > 0) {
          if (mid / midN < dark / darkN) leftVotes += seg.list.length; else rightVotes += seg.list.length;
        }
      }
      return leftVotes >= rightVotes;
    }

    // One piece as a dome rising from its outline.
    function roundedFaces(ctx, list, radius) {
      const { w, h, pieces, dist } = ctx;
      const height = (j) => {
        const d = dist[j];
        if (d === 0) return 0;
        const t = Math.min(d, radius) / radius;
        return Math.sqrt(1 - (1 - t) * (1 - t));
      };
      for (const i of list) {
        const p = pieces[i];
        const x = i % w, y = (i / w) | 0;
        const at = (nx, ny) => {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) return 0;
          const j = ny * w + nx;
          return pieces[j] === p ? height(j) : 0;
        };
        const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * radius * 0.6;
        const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * radius * 0.6;
        setBase(ctx, i, normalize(-dx, dy, 1), -1 - p);
      }
    }

    // A whole cube: covers nearly all of its cell's cube outline and little lies outside it.
    function matchesCube(ctx, list, cellW, cellH) {
      const w = ctx.w;
      const i0 = list[0];
      const cx = Math.floor((i0 % w) / cellW), cy = Math.floor(((i0 / w) | 0) / cellH);
      let inside = 0;
      for (const i of list) {
        const u = ((i % w) - cx * cellW + 0.5) / cellW;
        const v = (((i / w) | 0) - cy * cellH + 0.5) / cellH;
        if (Math.abs(u - 0.5) * 2 + Math.abs(v - 0.25) * 4 <= 1.06 || (v > 0.25 && v <= 1 - Math.abs(u - 0.5) * 0.5 + 0.03)) {
          inside++;
        }
      }
      const cube = cellW * cellH * 0.75;
      return inside >= cube * 0.95 && inside >= list.length * 0.9;
    }

    // Auto, per piece: whole block → cell faces; thin or multi-hue → rounded; else read from the painted shading.
    function classifyPiece(ctx, list, cellW, cellH) {
      if (matchesCube(ctx, list, cellW, cellH)) return "block";
      let distSum = 0, coloured = 0;
      const bins = new Array(12).fill(0);
      for (const i of list) {
        distSum += ctx.dist[i] || 1;
        if (ctx.sat[i] > 0.25) {
          coloured++;
          const b = ((Math.floor(ctx.hue[i] / (2 * Math.PI) * 12) % 12) + 12) % 12;
          bins[b]++;
        }
      }
      if (distSum / list.length < 2.2) return "rounded";
      if (coloured >= list.length * 0.15) {
        const strong = [];
        for (let b = 0; b < 12; b++) if (bins[b] >= coloured * 0.1) strong.push(b);
        for (let a = 0; a < strong.length; a++) {
          for (let c = a + 1; c < strong.length; c++) {
            const gap = Math.abs(strong[a] - strong[c]);
            if (Math.min(gap, 12 - gap) >= 2) return "rounded";
          }
        }
      }
      return "shading";
    }

    // 1 top, 2 left, 3 right, 4 front: the face a normal is closest to.
    function dominantFace(v) {
      const faces = [TOP, LEFT, RIGHT, FRONT];
      let best = 0, bestDot = -Infinity;
      for (let k = 0; k < 4; k++) {
        const d = v[0] * faces[k][0] + v[1] * faces[k][1] + v[2] * faces[k][2];
        if (d > bestDot) { best = k; bestDot = d; }
      }
      return best + 1;
    }

    function cubeFace(x, y, cellW, cellH) {
      const u = ((x % cellW) + 0.5) / cellW;
      const v = ((y % cellH) + 0.5) / cellH;
      if (v <= 0.5 - Math.abs(u - 0.5) * 0.5) return 1;
      return u < 0.5 ? 2 : 3;
    }

    function cellKey(x, y, cellW, cellH, face) {
      return (Math.floor(y / cellH) * 100000 + Math.floor(x / cellW)) * 4 + face;
    }

    function cellFacesFor(ctx, list, cellW, cellH, negate) {
      const w = ctx.w;
      for (const i of list) {
        const x = i % w, y = (i / w) | 0;
        const face = cubeFace(x, y, cellW, cellH);
        const k = cellKey(x, y, cellW, cellH, face);
        setBase(ctx, i, face === 1 ? TOP : (face === 2 ? LEFT : RIGHT), negate ? -1 - k : k);
      }
    }

    // ---------------------------------------------------------------------------------------------------------------------
    // Bumps
    // ---------------------------------------------------------------------------------------------------------------------

    function smoothHeights(ctx, height, key, has, passes) {
      const { w, h } = ctx;
      for (let pass = 0; pass < passes; pass++) {
        const out = new Float32Array(height.length);
        for (let i = 0; i < height.length; i++) {
          if (!has[i]) continue;
          const x = i % w, y = (i / w) | 0, k = key[i];
          let sum = 0, n = 0;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const nx = x + ox, ny = y + oy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const j = ny * w + nx;
              if (has[j] && key[j] === k) { sum += height[j]; n++; }
            }
          }
          out[i] = sum / n;
        }
        height = out;
      }
      return height;
    }

    // Each region's heights spread over 0..1, so a face's overall darkness is not read as a slope.
    function stretchHeights(height, key, has) {
      const lo = new Map(), hi = new Map();
      for (let i = 0; i < height.length; i++) {
        if (!has[i]) continue;
        const k = key[i], v = height[i];
        if (!lo.has(k) || v < lo.get(k)) lo.set(k, v);
        if (!hi.has(k) || v > hi.get(k)) hi.set(k, v);
      }
      const out = new Float32Array(height.length);
      for (let i = 0; i < height.length; i++) {
        if (!has[i]) continue;
        const k = key[i];
        const range = hi.get(k) - lo.get(k);
        out[i] = range > 1e-4 ? (height[i] - lo.get(k)) / range : 0.5;
      }
      return out;
    }

    function slopeAt(ctx, height, key, has, x, y, ox, oy) {
      const { w, h } = ctx;
      const i = y * w + x, k = key[i];
      const at = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return null;
        const j = ny * w + nx;
        return has[j] && key[j] === k ? height[j] : null;
      };
      const a = at(x - ox, y - oy), b = at(x + ox, y + oy), c = height[i];
      if (a !== null && b !== null) return (b - a) * 0.5;
      if (b !== null) return b - c;
      if (a !== null) return c - a;
      return 0;
    }

    // ---------------------------------------------------------------------------------------------------------------------
    // Run
    // ---------------------------------------------------------------------------------------------------------------------

    /**
     * input: { w, h, rgba, heightRgba?, ovHas?, ovN?, ovFixed?, settings }
     * ovFixed marks imported normals that already carry their relief (Blender add-on renders): no bumps are added there.
     * settings: { faces: auto|shading|rounded|cells, litSide: auto|left|right, minContrast, roundness, cellW, cellH,
     *             strength, steps, smooth, invert, perFace, output: n|d }
     */
    function computeNormals(input) {
      const { w, h, rgba, heightRgba, ovHas, ovN, ovFixed } = input;
      const s = input.settings;
      const cellW = Math.max(1, s.cellW | 0), cellH = Math.max(1, s.cellH | 0);
      const ctx = makeContext(w, h);
      const N = w * h;

      for (let i = 0; i < N; i++) {
        const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
        ctx.alpha[i] = a;
        ctx.lum[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        ctx.colour[i] = (r << 16) | (g << 8) | b;
        const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
        ctx.sat[i] = hi > 0 ? (hi - lo) / hi : 0;
        let hue = 0;
        if (hi > lo) {
          if (hi === r) hue = (((g - b) / (hi - lo)) % 6 + 6) % 6;
          else if (hi === g) hue = (b - r) / (hi - lo) + 2;
          else hue = (r - g) / (hi - lo) + 4;
        }
        ctx.hue[i] = hue / 6 * 2 * Math.PI;
      }

      const kinds = new Uint8Array(N); // 1 block, 2 rounded, 3 shading — shown in the tool's Faces view legend
      if (s.faces === "cells") {
        for (let i = 0; i < N; i++) {
          if (ctx.alpha[i] === 0) continue;
          const x = i % w, y = (i / w) | 0;
          const face = cubeFace(x, y, cellW, cellH);
          setBase(ctx, i, face === 1 ? TOP : (face === 2 ? LEFT : RIGHT), cellKey(x, y, cellW, cellH, face));
          kinds[i] = 1;
        }
      } else {
        const members = findPieces(ctx, cellW, cellH);
        pieceDistances(ctx, members);
        const segments = [];
        let regionCount = 0;
        let nextPiece = members.length - 1;
        const minContrast = s.minContrast / 100;
        for (let p = 1; p < members.length; p++) {
          const list = members[p];
          let kind = s.faces === "rounded" ? "rounded" : "shading";
          if (s.faces === "auto") kind = classifyPiece(ctx, list, cellW, cellH);

          if (kind === "block") {
            cellFacesFor(ctx, list, cellW, cellH, true);
            for (const i of list) kinds[i] = 1;
          } else if (kind === "rounded") {
            roundedFaces(ctx, list, Math.max(1, s.roundness));
            for (const i of list) kinds[i] = 2;
          } else {
            const split = splitByMaterial(ctx, list, nextPiece);
            nextPiece = split.nextId;
            for (const part of split.parts) {
              const seg = segmentPiece(ctx, part, minContrast, regionCount);
              regionCount = seg.count;
              segments.push({ list: part, c: seg.c });
            }
            for (const i of list) kinds[i] = 3;
          }
        }

        let litLeft = s.litSide === "left";
        if (s.litSide === "auto") litLeft = litSideFromArt(ctx, segments);
        for (const seg of segments) shadedNormals(ctx, seg.list, seg.c || [0, 0.5, 1], litLeft);
        ctx.litLeft = litLeft;
      }

      // Faces painted in the tool or imported from Blender win over anything detected. Their bump region is the cube face
      // they mostly look at, within their cell: a Blender render of a curved or bevelled model has many slightly different
      // normals, and one region per exact colour would leave every pixel alone with nothing to read bumps from.
      if (ovHas) {
        for (let i = 0; i < N; i++) {
          if (!ovHas[i] || ctx.alpha[i] === 0) continue;
          const v = [ovN[i * 3], ovN[i * 3 + 1], ovN[i * 3 + 2]];
          const x = i % w, y = (i / w) | 0;
          const cell = Math.floor(y / cellH) * 100000 + Math.floor(x / cellW);
          setBase(ctx, i, v, 1e12 + cell * 8 + dominantFace(v));
        }
      }

      // Bump height: the art's brightness, or a height image painted in greys (white = high).
      let height = new Float32Array(N);
      for (let i = 0; i < N; i++) height[i] = ctx.lum[i];
      if (heightRgba) {
        for (let i = 0; i < N; i++) {
          if (heightRgba[i * 4 + 3] > 0) {
            height[i] = (0.299 * heightRgba[i * 4] + 0.587 * heightRgba[i * 4 + 1] + 0.114 * heightRgba[i * 4 + 2]) / 255;
          }
        }
      }
      if (s.invert) for (let i = 0; i < N; i++) height[i] = 1 - height[i];

      let bumpKey = ctx.key;
      if (!s.perFace) {
        bumpKey = new Float64Array(N);
        for (let i = 0; i < N; i++) if (ctx.hasBase[i]) bumpKey[i] = 1;
      }
      height = stretchHeights(smoothHeights(ctx, height, bumpKey, ctx.hasBase, s.smooth | 0), bumpKey, ctx.hasBase);

      const strength = s.strength / 100 * 6;
      const detailOnly = s.output === "d";
      const nx = new Float32Array(N), ny = new Float32Array(N), nz = new Float32Array(N);
      const has = new Uint8Array(N);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!ctx.hasBase[i] || ctx.alpha[i] === 0) continue;
          const fixed = ovFixed && ovHas && ovHas[i] && ovFixed[i];
          let v = detailOnly ? [0, 0, 1] : [ctx.bx[i], ctx.by[i], ctx.bz[i]];
          if (fixed && detailOnly) {
            // A final Blender normal already holds its faces and relief. A _d map is bent back onto the cube face in game
            // (NormalMapLoader.Combine), so it stores the normal relative to that face: the inverse of that reorientation.
            const f = cubeFace(x, y, cellW, cellH);
            const b = f === 1 ? TOP : (f === 2 ? LEFT : RIGHT);
            v = unorient(b[0], b[1], b[2], ctx.bx[i], ctx.by[i], ctx.bz[i]);
          }
          if (strength > 0 && !fixed) {
            const dx = slopeAt(ctx, height, bumpKey, ctx.hasBase, x, y, 1, 0);
            const dy = slopeAt(ctx, height, bumpKey, ctx.hasBase, x, y, 0, 1);
            // Image rows grow downward, the map's green points up: a height rising down the image leans the normal up.
            let d = normalize(-dx * strength, dy * strength, 1);
            d = quantize(d[0], d[1], d[2], s.steps | 0);
            v = reorient(v[0], v[1], v[2], d[0], d[1], d[2]);
          }
          nx[i] = v[0]; ny[i] = v[1]; nz[i] = v[2];
          has[i] = 1;
        }
      }

      return { w, h, nx, ny, nz, has, bx: ctx.bx, by: ctx.by, bz: ctx.bz, hasBase: ctx.hasBase, kinds,
               litLeft: ctx.litLeft };
    }

    return { computeNormals, encodeChannel, decode, normalize, reorient, unorient, cubeFace, dominantFace, TOP, LEFT, RIGHT, FRONT };
  }

  Aura.normalsGeneratorFactory = normalsGeneratorFactory;
  Aura.normalsGenerator = normalsGeneratorFactory();
})(window.Aura ??= {});
