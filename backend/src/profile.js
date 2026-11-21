'use strict';

const db = require('./db');
const v = require('./validate');
const { HttpError } = require('./http');

const MAX_AVATAR_CHARS = 140_000; // ~100 KB of JPEG; the browser resizes to 256x256 first
const AVATAR_PREFIX = 'data:image/jpeg;base64,';

/** Sets the mobile number once. Changing it later would need an OTP to the new number (not built). */
async function setMobile(userId, body) {
  const mobile = v.normalizeMobile(body.mobile);
  try {
    const r = await db.query('UPDATE users SET mobile = $2 WHERE id = $1 AND mobile IS NULL RETURNING mobile', [userId, mobile]);
    if (r.rowCount === 0) throw new HttpError(409, 'MOBILE_ALREADY_SET', 'Your mobile number is already set');
    return { mobile };
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'MOBILE_TAKEN', 'This mobile number is already registered');
    throw err;
  }
}

function checkJpeg(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(AVATAR_PREFIX) || dataUrl.length > MAX_AVATAR_CHARS) {
    throw new HttpError(400, 'INVALID_IMAGE', 'Upload a JPEG photo');
  }
  const b64 = dataUrl.slice(AVATAR_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new HttpError(400, 'INVALID_IMAGE', 'Upload a JPEG photo');
  const head = Buffer.from(b64.slice(0, 8), 'base64');
  if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) throw new HttpError(400, 'INVALID_IMAGE', 'Upload a JPEG photo');
}

async function setAvatar(userId, body) {
  checkJpeg(body.image);
  await db.query('UPDATE users SET avatar = $2 WHERE id = $1', [userId, body.image]);
  return { ok: true };
}

async function removeAvatar(userId) {
  await db.query('UPDATE users SET avatar = NULL WHERE id = $1', [userId]);
  return { ok: true };
}

/** Another user's photo is shown only for verified accounts (used next to names in lists). */
async function getAvatar(userId, query = {}) {
  let target;
  if (!query.to) target = { by: 'self' };
  else target = v.normalizeTarget(query.to);
  let rows;
  if (target.by === 'self') {
    ({ rows } = await db.query('SELECT avatar FROM users WHERE id = $1', [userId]));
  } else if (target.by === 'mobile') {
    ({ rows } = await db.query('SELECT avatar FROM users WHERE mobile = $1 AND is_verified', [target.value]));
  } else if (target.by === 'pay_id') {
    ({ rows } = await db.query('SELECT avatar FROM users WHERE pay_id = $1 AND is_verified', [target.value]));
  } else {
    throw new HttpError(400, 'INVALID_MOBILE', 'Enter a valid 10 digit mobile number');
  }
  return { image: (rows[0] && rows[0].avatar) || null };
}

module.exports = { setMobile, setAvatar, removeAvatar, getAvatar, MAX_AVATAR_CHARS };
