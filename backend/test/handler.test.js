'use strict';

// Router tests that never reach the database: they cover routing, CORS, body
// parsing, input validation and auth rejection.
process.env.LOCAL_MODE = 'true';
process.env.JWT_SECRET = 'a-test-secret-that-is-long-enough-1234567890';
process.env.CORS_ORIGIN = '*';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../src/index');
const { signJwt } = require('../src/crypto');

const call = (method, path, { body, headers, query } = {}) =>
  handler(
    {
      httpMethod: method,
      path,
      headers: headers || {},
      queryStringParameters: query || null,
      body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    },
    { awsRequestId: 'test' },
  );

const parse = (res) => JSON.parse(res.body);

test('GET /health works without a database', async () => {
  const res = await call('GET', '/health');
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).status, 'ok');
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('OPTIONS returns 204 with CORS headers', async () => {
  const res = await call('OPTIONS', '/wallet/transfer');
  assert.equal(res.statusCode, 204);
  assert.match(res.headers['Access-Control-Allow-Headers'], /Authorization/);
});

test('unknown route is 404 and wrong method is 405', async () => {
  assert.equal((await call('GET', '/nope')).statusCode, 404);
  assert.equal((await call('GET', '/auth/login')).statusCode, 405);
  assert.equal(parse(await call('GET', '/nope')).error.code, 'NOT_FOUND');
});

test('trailing slash is accepted', async () => {
  assert.equal((await call('GET', '/health/')).statusCode, 200);
});

test('invalid JSON and non-object bodies are 400', async () => {
  assert.equal(parse(await call('POST', '/auth/login', { body: '{oops' })).error.code, 'INVALID_JSON');
  assert.equal(parse(await call('POST', '/auth/login', { body: '[1,2]' })).error.code, 'INVALID_JSON');
});

test('oversized body is 413', async () => {
  const res = await call('POST', '/auth/login', { body: JSON.stringify({ x: 'a'.repeat(20000) }) });
  assert.equal(res.statusCode, 413);
});

test('register validates input before touching the database', async () => {
  const base = { fullName: 'Asha Rao', email: 'asha@example.com', password: 'Passw0rdOK', mobile: '9876543210' };
  assert.equal((await call('POST', '/auth/register', { body: { ...base, email: 'bad' } })).statusCode, 400);
  assert.equal((await call('POST', '/auth/register', { body: { ...base, password: 'short' } })).statusCode, 400);
  assert.equal((await call('POST', '/auth/register', { body: { ...base, fullName: '' } })).statusCode, 400);
  const noMobile = await call('POST', '/auth/register', { body: { ...base, mobile: undefined } });
  assert.equal(parse(noMobile).error.code, 'INVALID_MOBILE');
  const badMobile = await call('POST', '/auth/register', { body: { ...base, mobile: '12345' } });
  assert.equal(parse(badMobile).error.code, 'INVALID_MOBILE');
});

test('verify-otp and login validate input', async () => {
  assert.equal((await call('POST', '/auth/verify-otp', { body: { email: 'a@b.co', otp: '12' } })).statusCode, 400);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'a@b.co' } })).statusCode, 400);
});

test('protected routes reject missing, malformed and forged tokens', async () => {
  for (const [method, path] of [
    ['GET', '/me'],
    ['GET', '/transactions'],
    ['POST', '/wallet/add-money'],
    ['POST', '/wallet/transfer'],
  ]) {
    assert.equal((await call(method, path)).statusCode, 401, `${method} ${path} without token`);
    assert.equal((await call(method, path, { headers: { Authorization: 'Bearer abc.def.ghi' } })).statusCode, 401);
    const forged = signJwt({ sub: 'u1' }, 'not-the-real-secret-not-the-real-secret', 60);
    assert.equal((await call(method, path, { headers: { authorization: `Bearer ${forged}` } })).statusCode, 401);
  }
});

test('authenticated money routes validate amount before the database', async () => {
  const token = signJwt({ sub: '11111111-1111-1111-1111-111111111111' }, process.env.JWT_SECRET, 60);
  const headers = { Authorization: `Bearer ${token}` };

  const topup = await call('POST', '/wallet/add-money', { headers, body: { amount: '-5' } });
  assert.equal(parse(topup).error.code, 'INVALID_AMOUNT');

  const transfer = await call('POST', '/wallet/transfer', { headers, body: { toEmail: 'x@y.co', amount: '1.234' } });
  assert.equal(parse(transfer).error.code, 'INVALID_AMOUNT');

  const badKey = await call('POST', '/wallet/transfer', {
    headers: { ...headers, 'Idempotency-Key': 'short' },
    body: { toEmail: 'x@y.co', amount: '10' },
  });
  assert.equal(badKey.statusCode, 400);
});

test('new read routes require a token', async () => {
  for (const path of ['/lookup', '/insights', '/contacts']) {
    assert.equal((await call('GET', path)).statusCode, 401, path);
  }
});

test('lookup and transfer validate the PayWave ID before the database', async () => {
  const token = signJwt({ sub: '11111111-1111-1111-1111-111111111111' }, process.env.JWT_SECRET, 60);
  const headers = { Authorization: `Bearer ${token}` };

  const badLookup = await call('GET', '/lookup', { headers, query: { payId: 'PWnope' } });
  assert.equal(parse(badLookup).error.code, 'INVALID_PAY_ID');
  const badMobileLookup = await call('GET', '/lookup', { headers, query: { to: '12345' } });
  assert.equal(parse(badMobileLookup).error.code, 'INVALID_MOBILE');

  const noRecipient = await call('POST', '/wallet/transfer', { headers, body: { amount: '10' } });
  assert.equal(parse(noRecipient).error.code, 'RECIPIENT_REQUIRED');

  const badId = await call('POST', '/wallet/transfer', { headers, body: { toPayId: 'PW12', amount: '10' } });
  assert.equal(parse(badId).error.code, 'INVALID_PAY_ID');
});

test('new routes require a token', async () => {
  for (const [m, path] of [['GET', '/notifications'], ['POST', '/notifications/read'], ['GET', '/autopay'], ['POST', '/autopay'],
    ['POST', '/autopay/action'], ['POST', '/wallet/recharge'], ['POST', '/profile/mobile'], ['POST', '/profile/avatar'], ['GET', '/avatar'],
    ['GET', '/cards'], ['POST', '/cards/reveal'], ['POST', '/cards/status'], ['POST', '/cards/repay']]) {
    assert.equal((await call(m, path)).statusCode, 401, `${m} ${path}`);
  }
});

test('recharge, card and AutoPay inputs are validated before the database', async () => {
  const token = signJwt({ sub: '11111111-1111-1111-1111-111111111111' }, process.env.JWT_SECRET, 60);
  const headers = { Authorization: `Bearer ${token}` };
  const code = async (m, path, body) => parse(await call(m, path, { headers, body })).error.code;

  assert.equal(await code('POST', '/wallet/recharge', { mobile: '123', operator: 'JIO', amount: '299' }), 'INVALID_MOBILE');
  assert.equal(await code('POST', '/wallet/recharge', { mobile: '9876543210', operator: 'XYZ', amount: '299' }), 'INVALID_OPERATOR');
  assert.equal(await code('POST', '/wallet/recharge', { mobile: '9876543210', operator: 'JIO', amount: '5' }), 'INVALID_AMOUNT');
  assert.equal(await code('POST', '/wallet/add-money', { amount: '0' }), 'INVALID_AMOUNT');
  assert.equal(await code('POST', '/cards/repay', { amount: '0' }), 'INVALID_AMOUNT');
  assert.equal(await code('POST', '/autopay', { kind: 'NOPE' }), 'VALIDATION_ERROR');
  assert.equal(await code('POST', '/autopay', { kind: 'TRANSFER', frequency: 'YEARLY' }), 'INVALID_FREQUENCY');
  assert.equal(await code('POST', '/autopay', { kind: 'TRANSFER', frequency: 'DAILY', startAt: 'yesterday', amount: '10', to: '9876543210' }), 'VALIDATION_ERROR');
  assert.equal(await code('POST', '/autopay/action', { id: 'nope', action: 'pause' }), 'VALIDATION_ERROR');
  assert.equal(await code('POST', '/profile/mobile', { mobile: 'abc' }), 'INVALID_MOBILE');
  assert.equal(await code('POST', '/profile/avatar', { image: 'data:image/png;base64,AAAA' }), 'INVALID_IMAGE');
  assert.equal(await code('POST', '/notifications/read', { ids: [] }), 'VALIDATION_ERROR');
});

test('ROUTE_MODE splits the API: Lambda serves payments, Kubernetes serves the rest', async () => {
  const old = process.env.ROUTE_MODE;
  try {
    process.env.ROUTE_MODE = 'payments';
    assert.equal((await call('POST', '/wallet/transfer')).statusCode, 401); // served (needs a token)
    assert.equal((await call('GET', '/notifications')).statusCode, 404);
    assert.equal((await call('POST', '/auth/login', { body: {} })).statusCode, 404);
    assert.equal((await call('GET', '/health')).statusCode, 200);

    process.env.ROUTE_MODE = 'core';
    assert.equal((await call('POST', '/wallet/transfer')).statusCode, 404);
    assert.equal((await call('POST', '/wallet/recharge')).statusCode, 404);
    assert.equal((await call('POST', '/wallet/add-money')).statusCode, 404);
    assert.equal((await call('GET', '/notifications')).statusCode, 401); // served (needs a token)
    assert.equal((await call('GET', '/health')).statusCode, 200);
  } finally {
    if (old === undefined) delete process.env.ROUTE_MODE; else process.env.ROUTE_MODE = old;
  }
});
