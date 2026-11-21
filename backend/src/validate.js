'use strict';

// Pure input validation helpers (no I/O, no dependencies).
const { HttpError } = require('./http');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function bad(message, code = 'VALIDATION_ERROR') {
  return new HttpError(400, code, message);
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw bad('A valid email address is required');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw bad('A valid email address is required');
  return email;
}

const PAYID_RE = /^PW[A-Z0-9]{8}$/;

/** Accepts "pw7k3m9qxa", "PW7K-3M9Q-XA" and so on; returns the canonical form. */
function normalizePayId(value) {
  if (typeof value !== 'string') throw bad('A valid PayWave ID is required', 'INVALID_PAY_ID');
  const id = value.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!PAYID_RE.test(id)) throw bad('PayWave ID looks like PW7K3M9QXA', 'INVALID_PAY_ID');
  return id;
}

function validateName(value) {
  if (typeof value !== 'string') throw bad('Full name is required');
  const name = value.trim().replace(/\s+/g, ' ');
  // eslint-disable-next-line no-control-regex
  if (name.length < 2 || name.length > 80 || /[\u0000-\u001f<>]/.test(name)) {
    throw bad('Full name must be 2 to 80 characters');
  }
  return name;
}

function validatePassword(value) {
  if (typeof value !== 'string') throw bad('Password is required');
  if (value.length < 8 || value.length > 128) throw bad('Password must be 8 to 128 characters');
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw bad('Password must contain at least one letter and one number');
  }
  return value;
}

function validateOtp(value) {
  const otp = typeof value === 'number' ? String(value).padStart(6, '0') : value;
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) throw bad('Enter the 6 digit code');
  return otp.trim();
}

/**
 * Converts a rupee amount (number or string, max 2 decimals) to integer paise
 * without floating point arithmetic.
 */
function parseAmountToPaise(value, { minPaise, maxPaise }) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(text.trim())) {
    throw bad('Amount must be a positive number with at most 2 decimals', 'INVALID_AMOUNT');
  }
  const [rupees, fraction = ''] = text.trim().split('.');
  const paise = Number(rupees) * 100 + Number(fraction.padEnd(2, '0'));
  if (paise < minPaise || paise > maxPaise) {
    throw bad(
      `Amount must be between ${formatPaise(minPaise)} and ${formatPaise(maxPaise)}`,
      'INVALID_AMOUNT',
    );
  }
  return paise;
}

function formatPaise(paise) {
  const n = Number(paise);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function validateNote(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw bad('Note must be text');
  const note = value.trim();
  // eslint-disable-next-line no-control-regex
  if (note.length > 100 || /[\u0000-\u001f]/.test(note)) throw bad('Note can be at most 100 characters');
  return note || null;
}

function validateIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
    throw bad('Idempotency-Key must be 8 to 64 characters (letters, digits, - and _)');
  }
  return value;
}

const OPERATORS = { JIO: 'Jio', AIRTEL: 'Airtel', VI: 'Vi', BSNL: 'BSNL' };
const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'];
const CARD_BRANDS = ['VISA', 'MASTERCARD', 'RUPAY', 'AMEX', 'DINERS', 'DISCOVER', 'OTHER'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Indian mobile number: 10 digits starting 6-9. Accepts +91, 91 and 0 prefixes and spaces. */
function normalizeMobile(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw bad('Enter a valid 10 digit mobile number', 'INVALID_MOBILE');
  }
  let digits = String(value).replace(/[\s\-()]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) throw bad('Enter a valid 10 digit mobile number', 'INVALID_MOBILE');
  return digits;
}

/** Who to pay: a mobile number (normal case), a PayWave ID (PW...), or a registered email. */
function normalizeTarget(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw bad("Enter the recipient's mobile number", 'RECIPIENT_REQUIRED');
  const text = String(value).trim();
  if (text.includes('@')) return { by: 'email', value: normalizeEmail(text) };
  if (/^pw/i.test(text)) return { by: 'pay_id', value: normalizePayId(text) };
  return { by: 'mobile', value: normalizeMobile(text) };
}

function validateOperator(value) {
  const key = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!OPERATORS[key]) throw bad('Choose Jio, Airtel, Vi or BSNL', 'INVALID_OPERATOR');
  return key;
}

function validateFrequency(value) {
  const f = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!FREQUENCIES.includes(f)) throw bad('Choose daily, weekly or monthly', 'INVALID_FREQUENCY');
  return f;
}

/** Only non-sensitive card details are accepted: the full number and CVV never reach the server. */
function validateCard(card) {
  if (!card || typeof card !== 'object') throw bad('Card details are required', 'INVALID_CARD');
  const brand = typeof card.brand === 'string' ? card.brand.trim().toUpperCase() : '';
  const kind = typeof card.kind === 'string' ? card.kind.trim().toUpperCase() : '';
  const last4 = typeof card.last4 === 'string' ? card.last4.trim() : '';
  if (!CARD_BRANDS.includes(brand) || !['CREDIT', 'DEBIT'].includes(kind) || !/^\d{4}$/.test(last4)) {
    throw bad('Card details are invalid', 'INVALID_CARD');
  }
  return { brand, kind, last4 };
}

function validateUuid(value, label = 'id') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw bad(`Invalid ${label}`);
  return value.toLowerCase();
}

/** 1234567 paise -> "\u20B912,345.67" with Indian digit grouping. */
function formatInr(paise) {
  const n = Number(paise);
  const abs = Math.abs(n);
  const rupees = String(Math.floor(abs / 100));
  const frac = String(abs % 100).padStart(2, '0');
  let grouped = rupees;
  if (rupees.length > 3) {
    const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${rupees.slice(-3)}`;
  }
  return `${n < 0 ? '-' : ''}\u20B9${grouped}.${frac}`;
}

module.exports = {
  OPERATORS,
  FREQUENCIES,
  normalizeMobile,
  normalizeTarget,
  validateOperator,
  validateFrequency,
  validateCard,
  validateUuid,
  formatInr,
  normalizeEmail,
  normalizePayId,
  validateName,
  validatePassword,
  validateOtp,
  parseAmountToPaise,
  formatPaise,
  validateNote,
  validateIdempotencyKey,
};
