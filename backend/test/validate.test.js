'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validate');

const LIMITS = { minPaise: 100, maxPaise: 5_000_000 };

test('parseAmountToPaise converts rupees exactly', () => {
  assert.equal(v.parseAmountToPaise('100', LIMITS), 10000);
  assert.equal(v.parseAmountToPaise('100.5', LIMITS), 10050);
  assert.equal(v.parseAmountToPaise('100.55', LIMITS), 10055);
  assert.equal(v.parseAmountToPaise(10.1, LIMITS), 1010); // float 10.1 must not become 1009
  assert.equal(v.parseAmountToPaise('1.15', LIMITS), 115);
  assert.equal(v.parseAmountToPaise(1.15, LIMITS), 115);
});

test('parseAmountToPaise rejects bad input', () => {
  for (const bad of ['0', '0.99', '-5', '1e3', '12.345', 'abc', '', null, undefined, {}, [], '50000.01', '1234567890']) {
    assert.throws(() => v.parseAmountToPaise(bad, LIMITS), { code: 'INVALID_AMOUNT' }, `should reject ${String(bad)}`);
  }
});

test('formatPaise', () => {
  assert.equal(v.formatPaise(0), '0.00');
  assert.equal(v.formatPaise(5), '0.05');
  assert.equal(v.formatPaise(10050), '100.50');
  assert.equal(v.formatPaise('12345'), '123.45');
});

test('normalizeEmail', () => {
  assert.equal(v.normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
  for (const bad of ['', 'a@b', 'no-at.com', 'a b@c.com', 5, null, 'x'.repeat(250) + '@a.com']) {
    assert.throws(() => v.normalizeEmail(bad), { code: 'VALIDATION_ERROR' });
  }
});

test('validatePassword', () => {
  assert.equal(v.validatePassword('abcdefg1'), 'abcdefg1');
  for (const bad of ['short1', 'allletters', '12345678', 'a'.repeat(129) + '1', 42]) {
    assert.throws(() => v.validatePassword(bad), { code: 'VALIDATION_ERROR' });
  }
});

test('validateName strips extra spaces and blocks markup characters', () => {
  assert.equal(v.validateName('  Asha   Rao '), 'Asha Rao');
  assert.throws(() => v.validateName('<script>'), { code: 'VALIDATION_ERROR' });
  assert.throws(() => v.validateName('A'), { code: 'VALIDATION_ERROR' });
});

test('validateOtp', () => {
  assert.equal(v.validateOtp('012345'), '012345');
  assert.equal(v.validateOtp(12345), '012345');
  for (const bad of ['12345', '1234567', 'abcdef', '', null]) {
    assert.throws(() => v.validateOtp(bad), { code: 'VALIDATION_ERROR' });
  }
});

test('validateNote and validateIdempotencyKey', () => {
  assert.equal(v.validateNote(undefined), null);
  assert.equal(v.validateNote('  rent  '), 'rent');
  assert.throws(() => v.validateNote('x'.repeat(101)));
  assert.equal(v.validateIdempotencyKey(undefined), null);
  assert.equal(v.validateIdempotencyKey('abc12345-XYZ_'), 'abc12345-XYZ_');
  assert.throws(() => v.validateIdempotencyKey('short'));
  assert.throws(() => v.validateIdempotencyKey('has space in it'));
});

test('normalizePayId accepts messy input and rejects bad IDs', () => {
  assert.equal(v.normalizePayId('pw7k3m9qxa'), 'PW7K3M9QXA');
  assert.equal(v.normalizePayId(' PW7K-3M9Q-XA '), 'PW7K3M9QXA');
  for (const bad of ['', 'PW123', 'XX7K3M9QXA', 'PW7K3M9QXA1', 'PW7K3M9Q!A', null, 5, undefined]) {
    assert.throws(() => v.normalizePayId(bad), { code: 'INVALID_PAY_ID' }, `should reject ${String(bad)}`);
  }
});

test('normalizeMobile accepts common formats and rejects bad numbers', () => {
  assert.equal(v.normalizeMobile('9876543210'), '9876543210');
  assert.equal(v.normalizeMobile('+91 98765-43210'), '9876543210');
  assert.equal(v.normalizeMobile('919876543210'), '9876543210');
  assert.equal(v.normalizeMobile('09876543210'), '9876543210');
  for (const bad of ['', '5876543210', '98765432', '98765432100', 'abcdefghij', null, undefined, {}]) {
    assert.throws(() => v.normalizeMobile(bad), { code: 'INVALID_MOBILE' }, `should reject ${String(bad)}`);
  }
});

test('normalizeTarget picks mobile, PayWave ID or email', () => {
  assert.deepEqual(v.normalizeTarget('98765 43210'), { by: 'mobile', value: '9876543210' });
  assert.deepEqual(v.normalizeTarget('pw7k3m9qxa'), { by: 'pay_id', value: 'PW7K3M9QXA' });
  assert.deepEqual(v.normalizeTarget(' A@B.co '), { by: 'email', value: 'a@b.co' });
  assert.throws(() => v.normalizeTarget(undefined), { code: 'RECIPIENT_REQUIRED' });
});

test('operator, frequency, card validators', () => {
  assert.equal(v.validateOperator(' jio '), 'JIO');
  assert.throws(() => v.validateOperator('tata'), { code: 'INVALID_OPERATOR' });
  assert.equal(v.validateFrequency('weekly'), 'WEEKLY');
  assert.throws(() => v.validateFrequency('hourly'), { code: 'INVALID_FREQUENCY' });
});

test('payment source: wallet needs nothing, a card needs its kind and CVV', () => {
  assert.equal(v.validatePaymentSource(undefined), null);
  assert.equal(v.validatePaymentSource(null), null);
  assert.equal(v.validatePaymentSource({ type: 'wallet' }), null);
  assert.deepEqual(v.validatePaymentSource({ type: 'card', kind: 'credit', cvv: '123' }), { kind: 'CREDIT', cvv: '123' });
  assert.deepEqual(v.validatePaymentSource({ type: 'CARD', kind: 'DEBIT', cvv: 7 }), { kind: 'DEBIT', cvv: '007' });
  assert.throws(() => v.validatePaymentSource({ type: 'CARD', kind: 'DEBIT' }), { code: 'INVALID_CVV' });
  assert.throws(() => v.validatePaymentSource({ type: 'CARD', kind: 'DEBIT', cvv: '12' }), { code: 'INVALID_CVV' });
  assert.throws(() => v.validatePaymentSource({ type: 'CARD', kind: 'GIFT', cvv: '123' }), { code: 'INVALID_CARD' });
  assert.throws(() => v.validatePaymentSource({ type: 'BITCOIN' }), { code: 'INVALID_SOURCE' });
  assert.throws(() => v.validatePaymentSource('card'), { code: 'INVALID_SOURCE' });
});

test('formatInr uses Indian grouping', () => {
  assert.equal(v.formatInr(0), '\u20B90.00');
  assert.equal(v.formatInr(123456), '\u20B91,234.56');
  assert.equal(v.formatInr(12345678), '\u20B91,23,456.78');
  assert.equal(v.formatInr(1000000000), '\u20B91,00,00,000.00');
});
