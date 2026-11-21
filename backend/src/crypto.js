'use strict';

// Password hashing (scrypt), HS256 JWTs and OTP helpers, built on node:crypto only.
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(actual, expected);
}

let dummyHash;
/** Used to spend the same time on unknown emails as on real ones. */
async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing-1');
  await verifyPassword(password, dummyHash);
}

// ------------------------------------------------------------------ JWT (HS256 only)
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signJwt(claims, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds }));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64u(sig)}`;
}

/** Returns the claims, or null when the token is malformed, forged or expired. */
function verifyJwt(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  let head;
  try {
    head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!head || head.alg !== 'HS256') return null; // rejects "none" and algorithm confusion

  const expected = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

// ------------------------------------------------------------------ OTP
function randomOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ PayWave ID
// "PW" + 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L): ~8.5e11 combinations.
const PAYID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generatePayId() {
  let id = 'PW';
  for (let i = 0; i < 8; i += 1) id += PAYID_ALPHABET[crypto.randomInt(PAYID_ALPHABET.length)];
  return id;
}

module.exports = {
  generatePayId,
  hashPassword,
  verifyPassword,
  dummyVerify,
  signJwt,
  verifyJwt,
  randomOtp,
  hmacHex,
  safeEqualHex,
};
