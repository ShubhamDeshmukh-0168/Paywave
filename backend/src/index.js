'use strict';

const { HttpError, json, empty, errorBody, getHeader, parseBody } = require('./http');
const log = require('./log');
const auth = require('./auth');
const wallet = require('./wallet');
const db = require('./db');
const profile = require('./profile');
const autopay = require('./autopay');
const notify = require('./notify');

// ROUTE_MODE decides which routes this process serves:
//   payments  AWS Lambda behind API Gateway: only the routes that move money (plus the AutoPay schedule)
//   core      the Kubernetes API service: everything else (sign-up, profile, history, notifications ...)
//   all       both (local development and tests)
const MODE = () => (process.env.ROUTE_MODE || 'all').toLowerCase();
const served = (route) => MODE() === 'all' || route.scope === 'both' || (MODE() === 'payments') === (route.scope === 'payments');

// method + path -> handler(ctx). `auth: true` routes require a valid bearer token.
// `scope: 'payments'` marks the money-moving routes. /health is served by both.
const routes = {
  'GET /health': {
    scope: 'both',
    handler: async (ctx) => {
      const out = { status: 'ok', time: new Date().toISOString() };
      if (ctx.query.deep === '1') {
        await db.query('SELECT 1');
        out.database = 'ok';
      }
      return [200, out];
    },
  },
  'POST /auth/register': { handler: async (ctx) => [202, await auth.register(ctx.body())] },
  'POST /auth/resend-otp': { handler: async (ctx) => [202, await auth.resendOtp(ctx.body())] },
  'POST /auth/verify-otp': { handler: async (ctx) => [200, await auth.verifyOtp(ctx.body())] },
  'POST /auth/login': { handler: async (ctx) => [200, await auth.login(ctx.body())] },

  'GET /me': { auth: true, handler: async (ctx) => [200, await wallet.getMe(ctx.user.id)] },
  'POST /wallet/add-money': {
    scope: 'payments',
    auth: true,
    handler: async (ctx) => [201, await wallet.addMoney(ctx.user.id, ctx.body(), ctx.idempotencyKey)],
  },
  'POST /wallet/transfer': {
    scope: 'payments',
    auth: true,
    handler: async (ctx) => [201, await wallet.transfer(ctx.user.id, ctx.body(), ctx.idempotencyKey)],
  },
  'GET /transactions': {
    auth: true,
    handler: async (ctx) => [200, await wallet.listTransactions(ctx.user.id, ctx.query)],
  },
  'GET /lookup': { auth: true, handler: async (ctx) => [200, await wallet.lookup(ctx.user.id, ctx.query)] },
  'GET /insights': { auth: true, handler: async (ctx) => [200, await wallet.insights(ctx.user.id)] },
  'GET /contacts': { auth: true, handler: async (ctx) => [200, await wallet.contacts(ctx.user.id)] },

  'POST /wallet/recharge': {
    scope: 'payments',
    auth: true,
    handler: async (ctx) => [201, await wallet.recharge(ctx.user.id, ctx.body(), ctx.idempotencyKey)],
  },
  'POST /profile/mobile': { auth: true, handler: async (ctx) => [200, await profile.setMobile(ctx.user.id, ctx.body())] },
  'POST /profile/avatar': {
    auth: true,
    handler: async (ctx) => [200, await profile.setAvatar(ctx.user.id, ctx.body(160 * 1024))],
  },
  'POST /profile/avatar/remove': { auth: true, handler: async (ctx) => [200, await profile.removeAvatar(ctx.user.id)] },
  'GET /avatar': { auth: true, handler: async (ctx) => [200, await profile.getAvatar(ctx.user.id, ctx.query)] },
  'GET /notifications': { auth: true, handler: async (ctx) => [200, await notify.list(ctx.user.id, ctx.query)] },
  'POST /notifications/read': { auth: true, handler: async (ctx) => [200, await notify.markRead(ctx.user.id, ctx.body())] },
  'GET /autopay': { auth: true, handler: async (ctx) => [200, await autopay.list(ctx.user.id)] },
  'POST /autopay': { auth: true, handler: async (ctx) => [201, await autopay.create(ctx.user.id, ctx.body())] },
  'POST /autopay/action': { auth: true, handler: async (ctx) => [200, await autopay.action(ctx.user.id, ctx.body())] },
};

function normalizePath(path) {
  let p = path || '/';
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

exports.handler = async (event, context = {}) => {
  const requestId = context.awsRequestId || 'local';

  // EventBridge schedule (every 5 minutes): run the AutoPays that are due
  if (event && event.source === 'aws.events' && MODE() !== 'core') {
    try {
      return await autopay.runDue();
    } catch (err) {
      log('error', 'scheduled autopay run failed', { requestId, error: err.message });
      throw err; // lets EventBridge/Lambda record the failure
    }
  }

  const started = Date.now();
  const method = String(event.httpMethod || '').toUpperCase();
  const path = normalizePath(event.path);

  try {
    if (method === 'OPTIONS') return empty(204);

    const found = routes[`${method} ${path}`];
    const route = found && served(found) ? found : null;
    if (!route) {
      const pathExists = Object.entries(routes).some(([k, r]) => served(r) && k.split(' ')[1] === path);
      if (pathExists) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      throw new HttpError(404, 'NOT_FOUND', 'Route not found');
    }

    const ctx = {
      query: event.queryStringParameters || {},
      body: (maxBytes) => parseBody(event, maxBytes),
      idempotencyKey: getHeader(event, 'idempotency-key'),
      user: null,
    };
    if (route.auth) ctx.user = await auth.authenticate(event);

    const [status, payload] = await route.handler(ctx);
    log('info', 'request', { requestId, method, path, status, ms: Date.now() - started });
    return json(status, payload);
  } catch (err) {
    if (err instanceof HttpError) {
      log('info', 'request', { requestId, method, path, status: err.status, code: err.code, ms: Date.now() - started });
      return json(err.status, errorBody(err.code, err.message));
    }
    log('error', 'unhandled error', {
      requestId,
      method,
      path,
      error: err && err.message,
      stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join(' | ') : undefined,
    });
    return json(500, errorBody('INTERNAL_ERROR', 'Something went wrong. Please try again.'));
  }
};
