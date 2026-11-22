'use strict';

const db = require('./db');
const c = require('./crypto');
const v = require('./validate');
const log = require('./log');
const { HttpError, getHeader } = require('./http');
const { sendOtpEmail } = require('./mailer');
const { getAppConfig } = require('./secrets');
const cards = require('./cards');

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 10);
const MAX_OTP_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_LOGIN_FAILURES = 5;
const LOCK_MINUTES = 15;
const TOKEN_TTL_SECONDS = 3600;

// Same answer whether or not the address is already registered (no account enumeration)
const REGISTER_MESSAGE = 'If this email can be registered, a verification code has been sent to it.';

async function issueOtp(user, name) {
  const cfg = await getAppConfig();

  const last = await db.query(
    `SELECT created_at FROM otp_codes
      WHERE user_id = $1 AND purpose = 'VERIFY_EMAIL' AND consumed_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [user.id],
  );
  if (last.rows[0] && Date.now() - last.rows[0].created_at.getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
    throw new HttpError(429, 'OTP_COOLDOWN', 'Please wait a minute before requesting another code');
  }

  const code = c.randomOtp();
  await db.query(
    `UPDATE otp_codes SET consumed_at = now()
      WHERE user_id = $1 AND purpose = 'VERIFY_EMAIL' AND consumed_at IS NULL`,
    [user.id],
  );
  await db.query(
    `INSERT INTO otp_codes (user_id, purpose, code_hash, expires_at)
     VALUES ($1, 'VERIFY_EMAIL', $2, now() + make_interval(mins => $3::int))`,
    [user.id, c.hmacHex(cfg.jwt_secret, `${user.id}:${code}`), OTP_TTL_MINUTES],
  );

  try {
    await sendOtpEmail({ to: user.email, name, code, ttlMinutes: OTP_TTL_MINUTES });
  } catch (err) {
    log('error', 'otp email failed', { error: err.message });
    throw new HttpError(502, 'EMAIL_FAILED', 'We could not send the verification email. Please try again.');
  }
}

/** Creates the user and wallet, with a freshly generated unique PayWave ID. */
async function createUser(email, fullName, passwordHash, mobile) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.tx(async (client) => {
        const r = await client.query(
          'INSERT INTO users (email, full_name, password_hash, pay_id, mobile) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [email, fullName, passwordHash, c.generatePayId(), mobile],
        );
        await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [r.rows[0].id]);
        return r.rows[0].id;
      });
    } catch (err) {
      // Same random ID already taken (1 in ~10^11): the transaction rolled back, so draw another
      if (err.code === '23505' && err.constraint === 'ux_users_pay_id') continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a unique PayWave ID');
}

async function register(body) {
  const email = v.normalizeEmail(body.email);
  const fullName = v.validateName(body.fullName);
  v.validatePassword(body.password);
  const mobile = v.normalizeMobile(body.mobile);

  // A mobile number belongs to one verified account. (Not verified by SMS, see README.)
  const taken = await db.query('SELECT 1 FROM users WHERE mobile = $1 AND is_verified AND email <> $2', [mobile, email]);
  if (taken.rowCount > 0) throw new HttpError(409, 'MOBILE_TAKEN', 'This mobile number is already registered');

  const existing = (await db.query('SELECT id, is_verified FROM users WHERE email = $1', [email])).rows[0];
  if (existing && existing.is_verified) return { message: REGISTER_MESSAGE };

  const passwordHash = await c.hashPassword(body.password);
  let userId;

  if (existing) {
    // Unverified signup being retried: refresh the details, the OTP proves email ownership
    try {
      await db.query('UPDATE users SET full_name = $2, password_hash = $3, mobile = $4 WHERE id = $1', [
        existing.id,
        fullName,
        passwordHash,
        mobile,
      ]);
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'MOBILE_TAKEN', 'This mobile number is already registered');
      throw err;
    }
    userId = existing.id;
  } else {
    try {
      userId = await createUser(email, fullName, passwordHash, mobile);
    } catch (err) {
      if (err.code === '23505') return { message: REGISTER_MESSAGE }; // lost a race with another signup of the same email
      throw err;
    }
  }

  await issueOtp({ id: userId, email }, fullName);
  return { message: REGISTER_MESSAGE };
}

async function resendOtp(body) {
  const email = v.normalizeEmail(body.email);
  const user = (await db.query('SELECT id, email, full_name, mobile, pay_id, is_verified FROM users WHERE email = $1', [email])).rows[0];
  if (user && !user.is_verified) await issueOtp(user, user.full_name);
  return { message: REGISTER_MESSAGE };
}

function sessionFor(user, secret) {
  const token = c.signJwt({ sub: user.id, email: user.email, name: user.full_name }, secret, TOKEN_TTL_SECONDS);
  return {
    token,
    expiresIn: TOKEN_TTL_SECONDS,
    user: { id: user.id, email: user.email, fullName: user.full_name, mobile: user.mobile, payId: user.pay_id },
  };
}

async function verifyOtp(body) {
  const email = v.normalizeEmail(body.email);
  const otp = v.validateOtp(body.otp);
  const invalid = new HttpError(400, 'INVALID_OTP', 'Invalid or expired code');

  const user = (await db.query('SELECT id, email, full_name, mobile, pay_id, is_verified FROM users WHERE email = $1', [email])).rows[0];
  if (!user || user.is_verified) throw invalid;

  // Count the attempt first and atomically; stops brute forcing the 6 digit code
  const attempt = await db.query(
    `UPDATE otp_codes SET attempts = attempts + 1
      WHERE id = (SELECT id FROM otp_codes
                   WHERE user_id = $1 AND purpose = 'VERIFY_EMAIL'
                     AND consumed_at IS NULL AND expires_at > now() AND attempts < $2
                   ORDER BY id DESC LIMIT 1)
      RETURNING id, code_hash`,
    [user.id, MAX_OTP_ATTEMPTS],
  );
  if (attempt.rowCount === 0) throw invalid;

  const cfg = await getAppConfig();
  const expected = c.hmacHex(cfg.jwt_secret, `${user.id}:${otp}`);
  if (!c.safeEqualHex(expected, attempt.rows[0].code_hash)) throw invalid;

  try {
    await db.tx(async (client) => {
      await client.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [attempt.rows[0].id]);
      await client.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [user.id]);
    });
  } catch (err) {
    // Someone else verified the same mobile number first
    if (err.code === '23505' && err.constraint === 'ux_users_mobile') {
      throw new HttpError(409, 'MOBILE_TAKEN', 'This mobile number was registered by another account. Sign up again with your own number.');
    }
    throw err;
  }

  // The new account gets its debit and credit card now. Never blocks sign-up: cards are also issued on first use.
  try {
    await cards.ensureCards(user.id);
  } catch (err) {
    log('warn', 'card issue failed', { error: err.message });
  }

  return sessionFor(user, cfg.jwt_secret);
}

/** Counts a wrong password and locks the account for a while after too many in a row. */
async function recordFailedAttempt(userId) {
  await db.query(
    `UPDATE users
        SET locked_until = CASE WHEN failed_login_attempts + 1 >= $2
                                THEN now() + make_interval(mins => $3::int) ELSE locked_until END,
            failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= $2
                                         THEN 0 ELSE failed_login_attempts + 1 END
      WHERE id = $1`,
    [userId, MAX_LOGIN_FAILURES, LOCK_MINUTES],
  );
}

/** Re-checks the signed-in user's password before showing card details. Shares the login lockout. */
async function confirmPassword(userId, password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 128) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Enter your password to continue');
  }
  const user = (await db.query('SELECT id, password_hash, locked_until FROM users WHERE id = $1', [userId])).rows[0];
  if (!user) throw new HttpError(401, 'UNAUTHORIZED', 'Account not found');
  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    throw new HttpError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.');
  }
  if (!(await c.verifyPassword(password, user.password_hash))) {
    await recordFailedAttempt(user.id);
    throw new HttpError(403, 'INVALID_PASSWORD', 'Incorrect password');
  }
}

async function login(body) {
  const email = v.normalizeEmail(body.email);
  if (typeof body.password !== 'string' || body.password.length === 0 || body.password.length > 128) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Password is required');
  }
  const invalid = new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');

  const user = (
    await db.query(
      `SELECT id, email, full_name, mobile, pay_id, password_hash, is_verified, locked_until
         FROM users WHERE email = $1`,
      [email],
    )
  ).rows[0];

  if (!user) {
    await c.dummyVerify(body.password);
    throw invalid;
  }
  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    throw new HttpError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.');
  }

  const ok = await c.verifyPassword(body.password, user.password_hash);
  if (!ok) {
    await recordFailedAttempt(user.id);
    throw invalid;
  }

  if (!user.is_verified) {
    throw new HttpError(403, 'NOT_VERIFIED', 'Please verify your email first');
  }

  await db.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
  const cfg = await getAppConfig();
  return sessionFor(user, cfg.jwt_secret);
}

/** Returns { id, email } for a valid bearer token, otherwise throws 401. */
async function authenticate(event) {
  const header = getHeader(event, 'authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');

  const cfg = await getAppConfig();
  const claims = c.verifyJwt(match[1], cfg.jwt_secret);
  if (!claims || !claims.sub) throw new HttpError(401, 'UNAUTHORIZED', 'Session expired, please sign in again');
  return { id: claims.sub, email: claims.email };
}

module.exports = { register, resendOtp, verifyOtp, login, authenticate, confirmPassword };
