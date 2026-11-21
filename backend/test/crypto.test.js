'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/crypto');

const SECRET = 'a-test-secret-that-is-long-enough-1234567890';

test('password hash verifies only the right password', async () => {
  const hash = await c.hashPassword('Correct-horse-1');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await c.verifyPassword('Correct-horse-1', hash), true);
  assert.equal(await c.verifyPassword('Wrong-horse-1', hash), false);
  assert.equal(await c.verifyPassword('x', 'not-a-hash'), false);
});

test('two hashes of the same password differ (random salt)', async () => {
  assert.notEqual(await c.hashPassword('same-pass-1'), await c.hashPassword('same-pass-1'));
});

test('JWT round trip', () => {
  const token = c.signJwt({ sub: 'user-1', email: 'a@b.co' }, SECRET, 60);
  const claims = c.verifyJwt(token, SECRET);
  assert.equal(claims.sub, 'user-1');
  assert.equal(claims.email, 'a@b.co');
  assert.ok(claims.exp > claims.iat);
});

test('JWT rejects wrong secret, tampering, expiry and alg=none', () => {
  const token = c.signJwt({ sub: 'user-1' }, SECRET, 60);
  assert.equal(c.verifyJwt(token, 'another-secret-another-secret-123456'), null);

  const [h, p, s] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', exp: 9999999999 })).toString('base64url');
  assert.equal(c.verifyJwt(`${h}.${forgedPayload}.${s}`, SECRET), null);

  assert.equal(c.verifyJwt(c.signJwt({ sub: 'x' }, SECRET, -10), SECRET), null);

  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(c.verifyJwt(`${noneHeader}.${p}.`, SECRET), null);

  for (const junk of ['', 'abc', 'a.b', 'a.b.c.d', null, undefined, 42]) {
    assert.equal(c.verifyJwt(junk, SECRET), null);
  }
});

test('OTP is six digits and hashing is comparable', () => {
  for (let i = 0; i < 200; i += 1) assert.match(c.randomOtp(), /^\d{6}$/);
  const a = c.hmacHex(SECRET, 'u:123456');
  assert.equal(c.safeEqualHex(a, c.hmacHex(SECRET, 'u:123456')), true);
  assert.equal(c.safeEqualHex(a, c.hmacHex(SECRET, 'u:123457')), false);
  assert.equal(c.safeEqualHex(a, ''), false);
});

test('generatePayId makes well formed, effectively unique IDs without look-alike characters', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) {
    const id = c.generatePayId();
    assert.match(id, /^PW[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 5000);
});
