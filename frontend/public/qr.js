/*
 * PayWave QR: a dependency-free QR code encoder and decoder.
 *   QR.encode(text, 'M')           -> { version, size, modules }   (byte mode, versions 1-10)
 *   QR.toPath(modules, border)     -> { size, d }                  (SVG path of the dark modules)
 *   QR.decode(gray, width, height) -> string | null                (gray = luminance, 1 byte per pixel)
 *   QR.decodeImageData(imageData)  -> string | null                (canvas ImageData, RGBA)
 * The encoder follows ISO/IEC 18004. The decoder finds the three finder patterns, samples the grid
 * through a perspective transform, and corrects errors with Reed-Solomon.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ tables (versions 1..10)
  const ECC_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
  };
  const NUM_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
  };
  const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  const ECL_FROM_BITS = ['M', 'L', 'H', 'Q']; // index = the 2 format bits
  const MAX_VERSION = 10;

  const sizeOf = (ver) => ver * 4 + 17;

  function rawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  const rawCodewords = (ver) => Math.floor(rawDataModules(ver) / 8);
  const dataCodewords = (ver, ecl) => rawCodewords(ver) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];

  function alignmentPositions(ver) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const size = sizeOf(ver);
    const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  // ------------------------------------------------------------------ Reed-Solomon over GF(256)
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initTables() {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  })();
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
  const gfDiv = (a, b) => (a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]);

  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i += 1) {
      for (let j = 0; j < degree; j += 1) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 2);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
    }
    return result;
  }

  /** Corrects `received` (data + ecc bytes) in place. Returns false when it cannot be repaired. */
  function rsCorrect(received, eccLen) {
    const n = received.length;
    const synd = new Array(eccLen).fill(0);
    let clean = true;
    for (let j = 0; j < eccLen; j += 1) {
      let s = 0;
      const alpha = EXP[j];
      for (let k = 0; k < n; k += 1) s = gfMul(s, alpha) ^ received[k];
      synd[j] = s;
      if (s !== 0) clean = false;
    }
    if (clean) return true;

    // Berlekamp-Massey
    let C = [1];
    let B = [1];
    let L = 0;
    let m = 1;
    let b = 1;
    for (let i = 0; i < eccLen; i += 1) {
      let d = synd[i];
      for (let j = 1; j <= L; j += 1) d ^= gfMul(C[j] || 0, synd[i - j]);
      if (d === 0) {
        m += 1;
      } else {
        const coef = gfDiv(d, b);
        const T = C.slice();
        while (C.length < B.length + m) C.push(0);
        B.forEach((bv, j) => { C[j + m] ^= gfMul(coef, bv); });
        if (2 * L <= i) {
          L = i + 1 - L;
          B = T;
          b = d;
          m = 1;
        } else {
          m += 1;
        }
      }
    }
    if (L === 0 || L * 2 > eccLen) return false;

    // Chien search: error at exponent e (position n-1-e) when Lambda(alpha^-e) == 0
    const evalPoly = (poly, x) => {
      let r = 0;
      for (let i = poly.length - 1; i >= 0; i -= 1) r = gfMul(r, x) ^ poly[i];
      return r;
    };
    const errors = [];
    for (let e = 0; e < n; e += 1) {
      if (evalPoly(C, EXP[(255 - (e % 255)) % 255]) === 0) errors.push(e);
    }
    if (errors.length !== L) return false;

    // Omega = S(x) * Lambda(x) mod x^eccLen
    const omega = new Array(eccLen).fill(0);
    for (let i = 0; i < eccLen; i += 1) {
      for (let j = 0; j < C.length && i + j < eccLen; j += 1) omega[i + j] ^= gfMul(synd[i], C[j]);
    }
    // Lambda'(x): only odd-degree terms survive in characteristic 2
    const dLambda = [];
    for (let i = 1; i < C.length; i += 2) dLambda[i - 1] = C[i];
    for (let i = 0; i < dLambda.length; i += 1) if (dLambda[i] === undefined) dLambda[i] = 0;

    for (const e of errors) {
      const xInv = EXP[(255 - (e % 255)) % 255];
      const num = evalPoly(omega, xInv);
      const den = evalPoly(dLambda, xInv);
      if (den === 0) return false;
      const magnitude = gfMul(EXP[e % 255], gfDiv(num, den));
      received[n - 1 - e] ^= magnitude;
    }
    // verify
    for (let j = 0; j < eccLen; j += 1) {
      let s = 0;
      for (let k = 0; k < n; k += 1) s = gfMul(s, EXP[j]) ^ received[k];
      if (s !== 0) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ function patterns
  function newGrid(size, fill) {
    return Array.from({ length: size }, () => new Array(size).fill(fill));
  }

  /** Draws everything that is not data: finders, timing, alignment, format and version areas. */
  function drawFunctionPatterns(ver, modules, isFunc) {
    const size = sizeOf(ver);
    const set = (x, y, dark) => {
      modules[y][x] = dark;
      isFunc[y][x] = true;
    };
    for (let i = 0; i < size; i += 1) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
        }
      }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);

    const pos = alignmentPositions(ver);
    const n = pos.length;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    drawFormat(modules, isFunc, size, 'M', 0);
    drawVersion(modules, isFunc, ver, size);
  }

  function drawFormat(modules, isFunc, size, ecl, mask) {
    const data = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    const set = (x, y, dark) => {
      modules[y][x] = dark;
      isFunc[y][x] = true;
    };
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  }

  function drawVersion(modules, isFunc, ver, size) {
    if (ver < 7) return;
    let rem = ver;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      modules[b][a] = dark;
      isFunc[b][a] = true;
      modules[a][b] = dark;
      isFunc[a][b] = true;
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0,
    (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
  ];

  /** Visits data modules in the standard zig-zag order. cb(x, y, bitIndex). */
  function walkDataModules(size, isFunc, cb) {
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunc[y][x]) {
            cb(x, y, i);
            i += 1;
          }
        }
      }
    }
    return i;
  }

  // ------------------------------------------------------------------ encoder
  function penalty(m, size) {
    let result = 0;
    const patA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const patB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let pass = 0; pass < 2; pass += 1) {
      for (let a = 0; a < size; a += 1) {
        const line = new Array(size);
        for (let b = 0; b < size; b += 1) line[b] = (pass === 0 ? m[a][b] : m[b][a]) ? 1 : 0;
        let run = 1;
        for (let b = 1; b < size; b += 1) {
          if (line[b] === line[b - 1]) {
            run += 1;
            if (run === 5) result += 3;
            else if (run > 5) result += 1;
          } else run = 1;
        }
        const padded = [0, 0, 0, 0, ...line, 0, 0, 0, 0];
        for (let b = 0; b + 11 <= padded.length; b += 1) {
          let ma = true;
          let mb = true;
          for (let k = 0; k < 11 && (ma || mb); k += 1) {
            if (padded[b + k] !== patA[k]) ma = false;
            if (padded[b + k] !== patB[k]) mb = false;
          }
          if (ma) result += 40;
          if (mb) result += 40;
        }
      }
    }
    let dark = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (m[y][x]) dark += 1;
        if (x + 1 < size && y + 1 < size) {
          const c = m[y][x];
          if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
        }
      }
    }
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }

  function encode(text, ecl = 'M') {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let ver = 0;
    for (let v = 1; v <= MAX_VERSION; v += 1) {
      const ccBits = v <= 9 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= dataCodewords(v, ecl) * 8 && (ccBits === 16 || bytes.length < 256)) {
        ver = v;
        break;
      }
    }
    if (!ver) throw new Error('Text is too long for the QR code');

    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1); };
    put(0x4, 4);
    put(bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    const capacityBits = dataCodewords(ver, ecl) * 8;
    put(0, Math.min(4, capacityBits - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let k = 0; k < 8; k += 1) b = (b << 1) | bits[i + k];
      data.push(b);
    }

    // error correction + interleave
    const numBlocks = NUM_BLOCKS[ecl][ver];
    const eccLen = ECC_PER_BLOCK[ecl][ver];
    const raw = rawCodewords(ver);
    const numShort = numBlocks - (raw % numBlocks);
    const shortLen = Math.floor(raw / numBlocks);
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i += 1) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const stream = [];
    for (let i = 0; i < blocks[0].length; i += 1) {
      blocks.forEach((blk, j) => {
        if (i !== shortLen - eccLen || j >= numShort) stream.push(blk[i]);
      });
    }

    const size = sizeOf(ver);
    const modules = newGrid(size, false);
    const isFunc = newGrid(size, false);
    drawFunctionPatterns(ver, modules, isFunc);
    walkDataModules(size, isFunc, (x, y, i) => {
      modules[y][x] = i < stream.length * 8 && ((stream[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
    });

    const applyMask = (mask) => {
      for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!isFunc[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
    };
    let best = 0;
    let bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask += 1) {
      applyMask(mask);
      drawFormat(modules, isFunc, size, ecl, mask);
      const p = penalty(modules, size);
      if (p < bestPenalty) { bestPenalty = p; best = mask; }
      applyMask(mask); // undo
    }
    applyMask(best);
    drawFormat(modules, isFunc, size, ecl, best);
    return { version: ver, size, modules, mask: best, ecl };
  }

  function toPath(modules, border = 4) {
    const n = modules.length;
    let d = '';
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) if (modules[y][x]) d += `M${x + border} ${y + border}h1v1h-1z`;
    }
    return { size: n + border * 2, d };
  }

  /** Renders to a grayscale pixel array (used by tests and for PNG download). */
  function render(modules, scale = 8, border = 4) {
    const n = modules.length + border * 2;
    const w = n * scale;
    const gray = new Uint8Array(w * w).fill(255);
    for (let y = 0; y < modules.length; y += 1) {
      for (let x = 0; x < modules.length; x += 1) {
        if (!modules[y][x]) continue;
        for (let dy = 0; dy < scale; dy += 1) {
          const row = ((y + border) * scale + dy) * w + (x + border) * scale;
          gray.fill(0, row, row + scale);
        }
      }
    }
    return { width: w, height: w, gray };
  }

  // ------------------------------------------------------------------ decoder: matrix -> text
  function readFormat(m, size) {
    const bitAt = (x, y) => (m[y][x] ? 1 : 0);
    let a = 0;
    for (let i = 0; i <= 5; i += 1) a |= bitAt(8, i) << i;
    a |= bitAt(8, 7) << 6;
    a |= bitAt(8, 8) << 7;
    a |= bitAt(7, 8) << 8;
    for (let i = 9; i < 15; i += 1) a |= bitAt(14 - i, 8) << i;
    let b = 0;
    for (let i = 0; i < 8; i += 1) b |= bitAt(size - 1 - i, 8) << i;
    for (let i = 8; i < 15; i += 1) b |= bitAt(8, size - 15 + i) << i;

    const popcount = (v) => { let c = 0; for (let x = v; x; x &= x - 1) c += 1; return c; };
    let best = null;
    let bestDist = 4;
    for (let data = 0; data < 32; data += 1) {
      let rem = data;
      for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const word = ((data << 10) | rem) ^ 0x5412;
      const dist = Math.min(popcount(word ^ a), popcount(word ^ b));
      if (dist < bestDist) { bestDist = dist; best = data; }
    }
    if (best === null) return null;
    return { ecl: ECL_FROM_BITS[best >>> 3], mask: best & 7 };
  }

  function decodeMatrix(m, ver) {
    const size = sizeOf(ver);
    if (m.length !== size) return null;
    const fmt = readFormat(m, size);
    if (!fmt) return null;
    const { ecl, mask } = fmt;
    const isFunc = newGrid(size, false);
    drawFunctionPatterns(ver, newGrid(size, false), isFunc);

    const total = rawCodewords(ver);
    const stream = new Array(total).fill(0);
    walkDataModules(size, isFunc, (x, y, i) => {
      if (i >= total * 8) return;
      let bit = m[y][x];
      if (MASKS[mask](x, y)) bit = !bit;
      if (bit) stream[i >>> 3] |= 0x80 >>> (i & 7);
    });

    const numBlocks = NUM_BLOCKS[ecl][ver];
    const eccLen = ECC_PER_BLOCK[ecl][ver];
    const numShort = numBlocks - (total % numBlocks);
    const shortLen = Math.floor(total / numBlocks);
    const dataLens = [];
    for (let i = 0; i < numBlocks; i += 1) dataLens.push(shortLen - eccLen + (i < numShort ? 0 : 1));
    const maxData = Math.max(...dataLens);
    const blocks = dataLens.map((len) => ({ data: new Array(len).fill(0), ecc: new Array(eccLen).fill(0) }));
    let k = 0;
    for (let p = 0; p < maxData; p += 1) blocks.forEach((blk) => { if (p < blk.data.length) blk.data[p] = stream[k++]; });
    for (let p = 0; p < eccLen; p += 1) blocks.forEach((blk) => { blk.ecc[p] = stream[k++]; });

    const out = [];
    for (const blk of blocks) {
      const word = blk.data.concat(blk.ecc);
      if (!rsCorrect(word, eccLen)) return null;
      out.push(...word.slice(0, blk.data.length));
    }
    return parseSegments(out, ver);
  }

  function parseSegments(bytes, ver) {
    let pos = 0;
    const totalBits = bytes.length * 8;
    const read = (n) => {
      if (pos + n > totalBits) throw new Error('eof');
      let v = 0;
      for (let i = 0; i < n; i += 1, pos += 1) v = (v << 1) | ((bytes[pos >>> 3] >>> (7 - (pos & 7))) & 1);
      return v;
    };
    const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
    const chunks = [];
    try {
      while (pos + 4 <= totalBits) {
        const mode = read(4);
        if (mode === 0) break;
        if (mode === 4) {
          const n = read(ver <= 9 ? 8 : 16);
          const part = [];
          for (let i = 0; i < n; i += 1) part.push(read(8));
          chunks.push(new TextDecoder('utf-8').decode(Uint8Array.from(part)));
        } else if (mode === 2) {
          let n = read(ver <= 9 ? 9 : 11);
          let s = '';
          while (n >= 2) { const v = read(11); s += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45]; n -= 2; }
          if (n === 1) s += ALNUM[read(6)];
          chunks.push(s);
        } else if (mode === 1) {
          let n = read(ver <= 9 ? 10 : 12);
          let s = '';
          while (n >= 3) { s += String(read(10)).padStart(3, '0'); n -= 3; }
          if (n === 2) s += String(read(7)).padStart(2, '0');
          else if (n === 1) s += String(read(4));
          chunks.push(s);
        } else return null; // ECI / kanji / structured append are not needed here
      }
    } catch { return null; }
    return chunks.length ? chunks.join('') : null;
  }

  const transpose = (m) => m.map((_, y) => m.map((row) => row[y]));

  // ------------------------------------------------------------------ decoder: image -> matrix
  function otsu(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
    const total = gray.length;
    let sum = 0;
    for (let t = 0; t < 256; t += 1) sum += t * hist[t];
    let sumB = 0;
    let wB = 0;
    let best = 0;
    let threshold = 127;
    for (let t = 0; t < 256; t += 1) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; threshold = t; }
    }
    return threshold;
  }

  function binarizeGlobal(gray) {
    const t = otsu(gray);
    const bin = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i += 1) bin[i] = gray[i] <= t ? 1 : 0;
    return bin;
  }

  function binarizeAdaptive(gray, w, h) {
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y += 1) {
      let rowSum = 0;
      for (let x = 0; x < w; x += 1) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum;
      }
    }
    const r = Math.max(12, Math.round(Math.min(w, h) / 8));
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x += 1) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w, x + r + 1);
        const area = (x1 - x0) * (y1 - y0);
        const s = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        bin[y * w + x] = gray[y * w + x] * area < s * 0.9 ? 1 : 0;
      }
    }
    return bin;
  }

  const ratiosOk = (c) => {
    const total = c[0] + c[1] + c[2] + c[3] + c[4];
    if (total < 7 || c.some((v) => v === 0)) return false;
    const mod = total / 7;
    const v = mod / 2 + 0.01;
    return Math.abs(mod - c[0]) < v && Math.abs(mod - c[1]) < v && Math.abs(3 * mod - c[2]) < 3 * v && Math.abs(mod - c[3]) < v && Math.abs(mod - c[4]) < v;
  };

  /** Counts the 5 runs of a finder pattern through (x0,y0) along direction (dx,dy). */
  function runsAround(bin, w, h, x0, y0, dx, dy) {
    const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? bin[y * w + x] : -1);
    const c = [0, 0, 0, 0, 0];
    let x = x0;
    let y = y0;
    let n2 = 0;
    while (at(x, y) === 1) { n2 += 1; x -= dx; y -= dy; }
    if (at(x, y) === -1) return null;
    while (at(x, y) === 0) { c[1] += 1; x -= dx; y -= dy; }
    if (at(x, y) === -1) return null;
    while (at(x, y) === 1) { c[0] += 1; x -= dx; y -= dy; }
    x = x0 + dx;
    y = y0 + dy;
    let p2 = 0;
    while (at(x, y) === 1) { p2 += 1; x += dx; y += dy; }
    if (at(x, y) === -1) return null;
    while (at(x, y) === 0) { c[3] += 1; x += dx; y += dy; }
    if (at(x, y) === -1) return null;
    while (at(x, y) === 1) { c[4] += 1; x += dx; y += dy; }
    c[2] = n2 + p2;
    const along = dx !== 0 ? x0 : y0;
    const start = along - (n2 - 1);
    const end = along + p2;
    return { c, center: (start + end) / 2 };
  }

  function findFinders(bin, w, h) {
    const cands = [];
    const step = h > 900 ? 2 : 1;
    for (let y = 0; y < h; y += step) {
      const runs = [];
      let start = 0;
      for (let x = 1; x <= w; x += 1) {
        if (x === w || bin[y * w + x] !== bin[y * w + start]) {
          runs.push({ color: bin[y * w + start], start, len: x - start });
          start = x;
        }
      }
      for (let i = 0; i + 4 < runs.length; i += 1) {
        if (runs[i].color !== 1) continue;
        const c = [runs[i].len, runs[i + 1].len, runs[i + 2].len, runs[i + 3].len, runs[i + 4].len];
        if (!ratiosOk(c)) continue;
        const total = c.reduce((a, b) => a + b, 0);
        const cx = Math.round(runs[i + 2].start + (runs[i + 2].len - 1) / 2);
        const vert = runsAround(bin, w, h, cx, y, 0, 1);
        if (!vert || !ratiosOk(vert.c)) continue;
        const vTotal = vert.c.reduce((a, b) => a + b, 0);
        if (Math.abs(vTotal - total) > total * 0.5) continue;
        const cy = Math.round(vert.center);
        const horiz = runsAround(bin, w, h, cx, cy, 1, 0);
        if (!horiz || !ratiosOk(horiz.c)) continue;
        const fx = horiz.center;
        const fy = vert.center;
        const mod = (total + vTotal) / 14;
        const hit = cands.find((q) => Math.abs(q.x - fx) <= mod * 1.5 && Math.abs(q.y - fy) <= mod * 1.5 && Math.abs(q.mod - mod) <= mod);
        if (hit) {
          hit.x = (hit.x * hit.n + fx) / (hit.n + 1);
          hit.y = (hit.y * hit.n + fy) / (hit.n + 1);
          hit.mod = (hit.mod * hit.n + mod) / (hit.n + 1);
          hit.n += 1;
        } else cands.push({ x: fx, y: fy, mod, n: 1 });
      }
    }
    return cands;
  }

  function pickTriple(cands) {
    let pool = cands.filter((c) => c.n >= 2);
    if (pool.length < 3) pool = cands.slice();
    pool.sort((a, b) => b.n - a.n);
    pool = pool.slice(0, 10);
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let best = null;
    for (let i = 0; i < pool.length; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1) {
        for (let k = j + 1; k < pool.length; k += 1) {
          const tri = [pool[i], pool[j], pool[k]];
          for (let t = 0; t < 3; t += 1) {
            const tl = tri[t];
            const p = tri[(t + 1) % 3];
            const q = tri[(t + 2) % 3];
            const l1 = dist(tl, p);
            const l2 = dist(tl, q);
            const hyp = dist(p, q);
            const avg = (l1 + l2) / 2;
            const cos = ((p.x - tl.x) * (q.x - tl.x) + (p.y - tl.y) * (q.y - tl.y)) / (l1 * l2);
            const modSpread = Math.max(tl.mod, p.mod, q.mod) / Math.min(tl.mod, p.mod, q.mod);
            if (Math.abs(l1 - l2) / avg > 0.4 || Math.abs(cos) > 0.5 || Math.abs(hyp / avg - Math.SQRT2) > 0.4 || modSpread > 1.8) continue;
            const score = Math.abs(l1 - l2) / avg + Math.abs(cos) + Math.abs(hyp / avg - Math.SQRT2);
            if (!best || score < best.score) best = { score, tl, p, q };
          }
        }
      }
    }
    if (!best) return null;
    const { tl, p, q } = best;
    const cross = (p.x - tl.x) * (q.y - tl.y) - (p.y - tl.y) * (q.x - tl.x);
    return cross > 0 ? { tl, tr: p, bl: q } : { tl, tr: q, bl: p };
  }

  function homography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i += 1) {
      const [x, y] = src[i];
      const [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
    }
    for (let col = 0; col < 8; col += 1) {
      let piv = col;
      for (let r = col + 1; r < 8; r += 1) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-12) return null;
      [A[col], A[piv]] = [A[piv], A[col]];
      for (let r = 0; r < 8; r += 1) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        for (let c = col; c < 9; c += 1) A[r][c] -= f * A[col][c];
      }
    }
    const hm = A.map((row, i) => row[8] / row[i]);
    return (x, y) => {
      const d = hm[6] * x + hm[7] * y + 1;
      return [(hm[0] * x + hm[1] * y + hm[2]) / d, (hm[3] * x + hm[4] * y + hm[5]) / d];
    };
  }

  function sampleGrid(bin, w, h, map, size) {
    const m = newGrid(size, false);
    const offs = [[0, 0], [-0.25, 0], [0.25, 0], [0, -0.25], [0, 0.25]];
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        let dark = 0;
        for (const [ox, oy] of offs) {
          const [px, py] = map(c + 0.5 + ox, r + 0.5 + oy);
          const ix = Math.round(px - 0.5);
          const iy = Math.round(py - 0.5);
          if (ix >= 0 && iy >= 0 && ix < w && iy < h && bin[iy * w + ix]) dark += 1;
        }
        m[r][c] = dark >= 3;
      }
    }
    return m;
  }

  function findAlignment(bin, w, h, map, size, mod) {
    const [cx, cy] = map(size - 6.5, size - 6.5);
    const [ax, ay] = map(size - 5.5, size - 6.5);
    const [bx, by] = map(size - 6.5, size - 5.5);
    const ux = [ax - cx, ay - cy];
    const uy = [bx - cx, by - cy];
    const at = (x, y) => {
      const ix = Math.round(x);
      const iy = Math.round(y);
      return ix >= 0 && iy >= 0 && ix < w && iy < h ? bin[iy * w + ix] : -1;
    };
    const pts = [[0, 0, 1]];
    for (let a = -1; a <= 1; a += 1) for (let b = -1; b <= 1; b += 1) if (a || b) pts.push([a, b, 0]);
    for (let a = -2; a <= 2; a += 1) for (let b = -2; b <= 2; b += 1) if (Math.max(Math.abs(a), Math.abs(b)) === 2 && (a % 2 === 0) && (b % 2 === 0)) pts.push([a, b, 1]);
    let best = null;
    const radius = Math.ceil(mod * 3);
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const px = cx + dx;
        const py = cy + dy;
        let ok = 0;
        for (const [a, b, want] of pts) {
          if (at(px + ux[0] * a + uy[0] * b, py + ux[1] * a + uy[1] * b) === want) ok += 1;
        }
        const score = ok / pts.length;
        if (!best || score > best.score) best = { score, x: px, y: py };
      }
    }
    return best && best.score >= 0.9 ? [best.x, best.y] : null;
  }

  /**
   * Module size measured along the QR code's own axis (unit vector ux,uy) from a finder centre:
   * the finder's outer edge is 3.5 modules from its centre. Immune to the image being rotated.
   */
  function axisModule(bin, w, h, c, ux, uy) {
    const at = (x, y) => {
      const ix = Math.round(x - 0.5);
      const iy = Math.round(y - 0.5);
      return ix >= 0 && iy >= 0 && ix < w && iy < h ? bin[iy * w + ix] : -1;
    };
    const reach = (sign) => {
      let state = 1; // 1 = in the black centre, then white ring, then black ring, then outside
      let transitions = 0;
      for (let d = 0.25; d < c.mod * 6; d += 0.25) {
        const v = at(c.x + 0.5 + sign * ux * d, c.y + 0.5 + sign * uy * d);
        if (v < 0) return null;
        if (v !== state) {
          state = v;
          transitions += 1;
          if (transitions === 3) return d;
        }
      }
      return null;
    };
    const a = reach(1);
    const b = reach(-1);
    if (a === null && b === null) return c.mod;
    return ((a === null ? b : a) + (b === null ? a : b)) / 2 / 3.5;
  }

  function decodeBinary(bin, w, h) {
    const cands = findFinders(bin, w, h);
    if (cands.length < 3) return null;
    const tri = pickTriple(cands);
    if (!tri) return null;
    const { tl, tr, bl } = tri;
    const lenA = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const lenB = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const modA = axisModule(bin, w, h, tl, (tr.x - tl.x) / lenA, (tr.y - tl.y) / lenA);
    const modB = axisModule(bin, w, h, tl, (bl.x - tl.x) / lenB, (bl.y - tl.y) / lenB);
    const mod = (modA + modB) / 2;
    const dim = (lenA / modA + lenB / modB) / 2 + 7;
    const guess = Math.round((dim - 17) / 4);
    const versions = [guess, guess - 1, guess + 1].filter((v) => v >= 1 && v <= MAX_VERSION);
    for (const ver of versions) {
      const size = sizeOf(ver);
      const est = [tr.x + bl.x - tl.x, tr.y + bl.y - tl.y];
      const src = [[3.5, 3.5], [size - 3.5, 3.5], [3.5, size - 3.5], [size - 3.5, size - 3.5]];
      const dst = [[tl.x + 0.5, tl.y + 0.5], [tr.x + 0.5, tr.y + 0.5], [bl.x + 0.5, bl.y + 0.5], [est[0] + 0.5, est[1] + 0.5]];
      let map = homography(src, dst);
      const attempt = (fn) => {
        const m = sampleGrid(bin, w, h, fn, size);
        return decodeMatrix(m, ver) || decodeMatrix(transpose(m), ver);
      };
      let text = map && attempt(map);
      if (text) return text;
      if (ver >= 2 && map) {
        const align = findAlignment(bin, w, h, map, size, mod);
        if (align) {
          src[3] = [size - 6.5, size - 6.5];
          dst[3] = [align[0] + 0.5, align[1] + 0.5];
          map = homography(src, dst);
          text = map && attempt(map);
          if (text) return text;
        }
      }
    }
    return null;
  }

  function downscale(gray, w, h, f) {
    const nw = Math.floor(w / f);
    const nh = Math.floor(h / f);
    const out = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y += 1) {
      for (let x = 0; x < nw; x += 1) {
        let s = 0;
        for (let dy = 0; dy < f; dy += 1) for (let dx = 0; dx < f; dx += 1) s += gray[(y * f + dy) * w + x * f + dx];
        out[y * nw + x] = Math.round(s / (f * f));
      }
    }
    return { gray: out, w: nw, h: nh };
  }

  function decode(gray, width, height) {
    const attempts = [{ gray, w: width, h: height }];
    const longest = Math.max(width, height);
    if (longest > 1100) attempts.unshift(downscale(gray, width, height, Math.ceil(longest / 800)));
    for (const a of attempts) {
      const text = decodeBinary(binarizeGlobal(a.gray), a.w, a.h) || decodeBinary(binarizeAdaptive(a.gray, a.w, a.h), a.w, a.h);
      if (text) return text;
    }
    return null;
  }

  function decodeImageData(img) {
    const { data, width, height } = img;
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    return decode(gray, width, height);
  }

  const QR = { encode, toPath, render, decode, decodeImageData, _internals: { rsCorrect, rsDivisor, rsRemainder, MAX_VERSION } };
  if (typeof module !== 'undefined' && module.exports) module.exports = QR;
  else root.QR = QR;
})(typeof window !== 'undefined' ? window : globalThis);
