'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const QR = require('../public/qr.js');

const URL_TEXT = 'http://add2cc5ceeae2477998c78a68d0cb799-9e6776358a9b8b15.elb.us-east-1.amazonaws.com/#pay=9876543210';

function lcg(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

test('encode then decode round trip for every version and error level', () => {
  const rnd = lcg(42);
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/.#=-_';
  const seen = new Set();
  for (const ecl of ['L', 'M', 'Q', 'H']) {
    for (let len = 1; len <= 200; len += 7) {
      let text = '';
      for (let i = 0; i < len; i += 1) text += chars[Math.floor(rnd() * chars.length)];
      let q;
      try { q = QR.encode(text, ecl); } catch { break; }
      seen.add(q.version);
      const img = QR.render(q.modules, 5, 4);
      assert.equal(QR.decode(img.gray, img.width, img.height), text, `ecl ${ecl} version ${q.version} length ${len}`);
    }
  }
  assert.ok(seen.size >= 8, `covered versions: ${[...seen].join(',')}`);
});

test('payment link and unicode text survive a round trip', () => {
  for (const text of [URL_TEXT, 'paywave://pay?m=9876543210&n=Asha Rao', 'Zoë ₹250']) {
    const q = QR.encode(text, 'M');
    const img = QR.render(q.modules, 6, 4);
    assert.equal(QR.decode(img.gray, img.width, img.height), text);
  }
});

test('the real payment URL fits in version 6 and 7 or lower', () => {
  assert.ok(QR.encode(URL_TEXT, 'M').version <= 7);
});

test('too much text is rejected', () => {
  assert.throws(() => QR.encode('x'.repeat(400), 'M'), /too long/);
});

test('decoder repairs a lightly damaged code (Reed-Solomon)', () => {
  const rnd = lcg(7);
  let ok = 0;
  for (let t = 0; t < 20; t += 1) {
    const q = QR.encode(URL_TEXT, 'Q');
    const n = q.size;
    for (let k = 0; k < Math.round(n * n * 0.02); k += 1) {
      const x = Math.floor(rnd() * n);
      const y = Math.floor(rnd() * n);
      if ((x < 9 && y < 9) || (x > n - 9 && y < 9) || (x < 9 && y > n - 9)) continue;
      q.modules[y][x] = !q.modules[y][x];
    }
    const img = QR.render(q.modules, 6, 4);
    if (QR.decode(img.gray, img.width, img.height) === URL_TEXT) ok += 1;
  }
  assert.ok(ok >= 17, `only ${ok}/20 damaged codes decoded`);
});

test('decoder handles a rotated, offset image', () => {
  const q = QR.encode(URL_TEXT, 'M');
  const base = QR.render(q.modules, 6, 4);
  const W = 640;
  const H = 640;
  for (const deg of [0, 33, 123, 200, 305]) {
    const gray = new Uint8Array(W * H).fill(200);
    const a = (deg * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        // inverse rotation about the centre, then sample the source image (nearest)
        const dx = x - W / 2;
        const dy = y - H / 2;
        const sx = Math.round(cos * dx + sin * dy + base.width / 2);
        const sy = Math.round(-sin * dx + cos * dy + base.height / 2);
        if (sx >= 0 && sy >= 0 && sx < base.width && sy < base.height) gray[y * W + x] = base.gray[sy * base.width + sx];
      }
    }
    assert.equal(QR.decode(gray, W, H), URL_TEXT, `rotation ${deg} degrees`);
  }
});

test('blank and noise images return null instead of throwing', () => {
  const blank = new Uint8Array(300 * 300).fill(255);
  assert.equal(QR.decode(blank, 300, 300), null);
  const noise = new Uint8Array(300 * 300);
  const rnd = lcg(3);
  for (let i = 0; i < noise.length; i += 1) noise[i] = rnd() * 255;
  assert.equal(QR.decode(noise, 300, 300), null);
});

test('toPath produces a drawable path', () => {
  const { size, d } = QR.toPath(QR.encode('hello', 'M').modules, 4);
  assert.ok(size > 21 && d.startsWith('M') && d.includes('h1v1h-1z'));
});
