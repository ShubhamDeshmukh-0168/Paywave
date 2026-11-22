'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/crypto');

function luhnValid(num) {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i -= 1) {
    let d = Number(num[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

test('generated card numbers are 16 digits, keep their prefix and pass the Luhn check', () => {
  for (let i = 0; i < 200; i += 1) {
    const n = c.generateCardNumber('607087');
    assert.match(n, /^607087\d{10}$/);
    assert.ok(luhnValid(n), n);
  }
});

test('CVVs are 3 digits', () => {
  for (let i = 0; i < 200; i += 1) assert.match(c.generateCvv(), /^\d{3}$/);
});

test('card fields round-trip, are randomised, and need the right key', () => {
  const a = c.encryptField('secret-one', '6070871234567890');
  const b = c.encryptField('secret-one', '6070871234567890');
  assert.notEqual(a, b);
  assert.equal(c.decryptField('secret-one', a), '6070871234567890');
  assert.throws(() => c.decryptField('another-secret', a));
  // flip one bit of the ciphertext: the GCM tag must reject it
  const [iv, tag, enc] = a.split('.').map((p) => Buffer.from(p, 'base64'));
  enc[0] ^= 1;
  const tampered = [iv, tag, enc].map((x) => x.toString('base64')).join('.');
  assert.throws(() => c.decryptField('secret-one', tampered));
});
