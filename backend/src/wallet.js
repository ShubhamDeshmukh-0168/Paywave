'use strict';

const db = require('./db');
const v = require('./validate');
const notify = require('./notify');
const { HttpError } = require('./http');

const TOPUP_MIN = 100; // Rs 1.00
const TOPUP_MAX = 5_000_000; // Rs 50,000.00
const TRANSFER_MIN = 100; // Rs 1.00
const TRANSFER_MAX = 10_000_000; // Rs 1,00,000.00
const RECHARGE_MIN = 1000; // Rs 10.00
const RECHARGE_MAX = 300_000; // Rs 3,000.00

const money = (paise) => ({ paise: Number(paise), display: v.formatPaise(paise) });
const ref = (txId) => txId.slice(0, 8).toUpperCase();
const maskMobile = (m) => `${m.slice(0, 2)}XXXXX${m.slice(-3)}`;
const cardLabel = (c) => `${c.kind === 'CREDIT' ? 'credit' : 'debit'} card ending ${c.last4}`;

async function getMe(userId) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.full_name, u.mobile, u.pay_id, u.avatar, w.balance_paise
       FROM users u JOIN wallets w ON w.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  if (!rows[0]) throw new HttpError(401, 'UNAUTHORIZED', 'Account not found');
  const u = rows[0];
  return {
    id: u.id,
    email: u.email,
    fullName: u.full_name,
    mobile: u.mobile,
    payId: u.pay_id,
    avatar: u.avatar,
    balance: money(u.balance_paise),
  };
}

// ---------------------------------------------------------------- shared building blocks
async function findReplay(client, userId, key) {
  if (!key) return null;
  const { rows } = await client.query(
    `SELECT t.id, t.type, t.amount_paise, t.note, t.created_at, u.full_name, u.mobile, u.pay_id
       FROM transactions t
       LEFT JOIN users u ON u.id = t.to_user AND t.type = 'TRANSFER'
      WHERE t.initiated_by = $1 AND t.idempotency_key = $2`,
    [userId, key],
  );
  return rows[0] || null;
}

async function currentBalance(client, userId) {
  const { rows } = await client.query('SELECT balance_paise FROM wallets WHERE user_id = $1', [userId]);
  return rows[0].balance_paise;
}

/**
 * Runs one money movement in a transaction with idempotency, then sends the queued emails.
 * `work(client, outbox)` returns the response body.
 */
async function runMoney(userId, key, work) {
  const outbox = [];
  const attempt = () =>
    db.tx(async (client) => {
      const replay = await findReplay(client, userId, key);
      if (replay) {
        return {
          transactionId: replay.id,
          amount: money(replay.amount_paise),
          balance: money(await currentBalance(client, userId)),
          to: replay.type === 'TRANSFER' ? { fullName: replay.full_name, mobile: replay.mobile, payId: replay.pay_id } : undefined,
          note: replay.note,
          createdAt: replay.created_at,
          replayed: true,
        };
      }
      return work(client, outbox);
    });

  let result;
  try {
    result = await attempt();
  } catch (err) {
    // Two identical requests raced: the loser hits the unique index, so replay it
    if (err.code === '23505' && key) result = await attempt();
    else throw err;
  }
  await notify.flushEmails(outbox);
  return result;
}

const RECIPIENT_COLUMN = { mobile: 'mobile', pay_id: 'pay_id', email: 'email' }; // fixed whitelist

async function findRecipient(client, target) {
  const column = RECIPIENT_COLUMN[target.by];
  const { rows } = await client.query(
    `SELECT id, full_name, email, mobile, pay_id FROM users WHERE ${column} = $1 AND is_verified`,
    [target.value],
  );
  if (!rows[0]) throw new HttpError(404, 'RECIPIENT_NOT_FOUND', 'No PayWave account found for that number');
  return rows[0];
}

/** Locks the wallet row and subtracts, or throws INSUFFICIENT_FUNDS. Returns the new balance. */
async function debitWallet(client, userId, amount, lockIds) {
  const locked = await client.query(
    `SELECT user_id, balance_paise FROM wallets
      WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE`,
    [lockIds || [userId]],
  );
  const mine = locked.rows.find((r) => r.user_id === userId);
  if (!mine) throw new HttpError(401, 'UNAUTHORIZED', 'Account not found');
  if (Number(mine.balance_paise) < amount) {
    throw new HttpError(422, 'INSUFFICIENT_FUNDS', 'Not enough balance in your wallet');
  }
  const res = await client.query(
    'UPDATE wallets SET balance_paise = balance_paise - $2, updated_at = now() WHERE user_id = $1 RETURNING balance_paise',
    [userId, amount],
  );
  return res.rows[0].balance_paise;
}

// ---------------------------------------------------------------- transfer
/**
 * Moves money between two wallets inside an open transaction and notifies both people.
 * Also used by AutoPay. `recipient` is a row from findRecipient().
 */
async function transferCore(client, { fromId, recipient, amount, note, key, meta, outbox }) {
  if (recipient.id === fromId) throw new HttpError(400, 'SELF_TRANSFER', 'You cannot send money to yourself');

  const balance = await debitWallet(client, fromId, amount, [fromId, recipient.id]);
  await client.query(
    'UPDATE wallets SET balance_paise = balance_paise + $2, updated_at = now() WHERE user_id = $1',
    [recipient.id, amount],
  );
  const ins = await client.query(
    `INSERT INTO transactions (type, from_user, to_user, initiated_by, amount_paise, note, idempotency_key, meta)
     VALUES ('TRANSFER', $1, $2, $1, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [fromId, recipient.id, amount, note, key || null, meta ? JSON.stringify(meta) : null],
  );
  const txId = ins.rows[0].id;
  const sender = (await client.query('SELECT full_name, email, mobile FROM users WHERE id = $1', [fromId])).rows[0];
  const amountText = v.formatInr(amount);
  const auto = meta && meta.autopay ? ' (AutoPay)' : '';

  await notify.create(client, fromId, {
    kind: 'PAYMENT_SENT',
    title: `Paid ${amountText} to ${recipient.full_name}${auto}`,
    body: [note, `Ref ${ref(txId)}`].filter(Boolean).join(' · '),
    txId,
  });
  await notify.create(client, recipient.id, {
    kind: 'PAYMENT_RECEIVED',
    title: `Received ${amountText} from ${sender.full_name}${auto}`,
    body: [note, `Ref ${ref(txId)}`].filter(Boolean).join(' · '),
    txId,
  });
  notify.queueEmail(outbox, {
    to: sender.email,
    name: sender.full_name,
    subject: `You paid ${amountText} to ${recipient.full_name}`,
    lines: [note && `Note: ${note}`, `Reference: ${ref(txId)}`, `Balance: ${v.formatInr(balance)}`],
  });
  notify.queueEmail(outbox, {
    to: recipient.email,
    name: recipient.full_name,
    subject: `You received ${amountText} from ${sender.full_name}`,
    lines: [note && `Note: ${note}`, `Reference: ${ref(txId)}`],
  });

  return { transactionId: txId, balance, createdAt: ins.rows[0].created_at };
}

/** Accepts `to` (mobile number, PayWave ID or email) plus the older toMobile/toPayId/toEmail fields. */
function parseRecipient(body) {
  const raw = [body.to, body.toMobile, body.toPayId, body.toEmail].find((x) => x !== undefined && x !== null && x !== '');
  if (raw === undefined) throw new HttpError(400, 'RECIPIENT_REQUIRED', "Enter the recipient's mobile number");
  return v.normalizeTarget(raw);
}

async function transfer(userId, body, idempotencyKey) {
  const target = parseRecipient(body);
  const amount = v.parseAmountToPaise(body.amount, { minPaise: TRANSFER_MIN, maxPaise: TRANSFER_MAX });
  const note = v.validateNote(body.note);
  const key = v.validateIdempotencyKey(idempotencyKey);

  return runMoney(userId, key, async (client, outbox) => {
    const recipient = await findRecipient(client, target);
    const r = await transferCore(client, { fromId: userId, recipient, amount, note, key, outbox });
    return {
      transactionId: r.transactionId,
      amount: money(amount),
      balance: money(r.balance),
      to: { fullName: recipient.full_name, mobile: recipient.mobile, payId: recipient.pay_id },
      note,
      createdAt: r.createdAt,
      replayed: false,
    };
  });
}

// ---------------------------------------------------------------- add money (card)
/**
 * Simulated top-up. There is no payment gateway here: the browser sends only the card brand,
 * the last 4 digits and credit/debit, never the full number or CVV. A real product would credit
 * the wallet only after a gateway (Razorpay, Stripe, ...) confirms the payment by signed webhook.
 */
async function addMoney(userId, body, idempotencyKey) {
  const amount = v.parseAmountToPaise(body.amount, { minPaise: TOPUP_MIN, maxPaise: TOPUP_MAX });
  const key = v.validateIdempotencyKey(idempotencyKey);
  const card = body.card === undefined || body.card === null ? null : v.validateCard(body.card);
  const meta = card ? { method: 'CARD', brand: card.brand, kind: card.kind, last4: card.last4 } : { method: 'DEMO' };

  return runMoney(userId, key, async (client, outbox) => {
    const upd = await client.query(
      `UPDATE wallets SET balance_paise = balance_paise + $2, updated_at = now()
        WHERE user_id = $1 RETURNING balance_paise`,
      [userId, amount],
    );
    if (upd.rowCount === 0) throw new HttpError(401, 'UNAUTHORIZED', 'Account not found');
    const ins = await client.query(
      `INSERT INTO transactions (type, to_user, initiated_by, amount_paise, note, idempotency_key, meta)
       VALUES ('TOPUP', $1, $1, $2, 'Added to wallet', $3, $4)
       RETURNING id, created_at`,
      [userId, amount, key, JSON.stringify(meta)],
    );
    const txId = ins.rows[0].id;
    const user = (await client.query('SELECT full_name, email FROM users WHERE id = $1', [userId])).rows[0];
    const via = card ? ` using your ${cardLabel(card)}` : '';
    await notify.create(client, userId, {
      kind: 'WALLET_TOPUP',
      title: `${v.formatInr(amount)} added to your wallet`,
      body: `${card ? `Paid with ${cardLabel(card)} · ` : ''}Ref ${ref(txId)}`,
      txId,
    });
    notify.queueEmail(outbox, {
      to: user.email,
      name: user.full_name,
      subject: `${v.formatInr(amount)} added to your wallet${via}`,
      lines: [`Reference: ${ref(txId)}`, `Balance: ${v.formatInr(upd.rows[0].balance_paise)}`],
    });
    return {
      transactionId: txId,
      amount: money(amount),
      balance: money(upd.rows[0].balance_paise),
      createdAt: ins.rows[0].created_at,
      replayed: false,
    };
  });
}

// ---------------------------------------------------------------- mobile recharge
/** Debits the wallet for a (simulated) prepaid recharge. A real product would call a recharge aggregator API. */
async function rechargeCore(client, { userId, mobile, operator, amount, plan, key, meta, outbox }) {
  const balance = await debitWallet(client, userId, amount);
  const details = { operator, mobile, ...(plan ? { plan } : {}), ...(meta || {}) };
  const ins = await client.query(
    `INSERT INTO transactions (type, from_user, initiated_by, amount_paise, note, idempotency_key, meta)
     VALUES ('RECHARGE', $1, $1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [userId, amount, `${v.OPERATORS[operator]} recharge for ${mobile}`, key || null, JSON.stringify(details)],
  );
  const txId = ins.rows[0].id;
  const user = (await client.query('SELECT full_name, email FROM users WHERE id = $1', [userId])).rows[0];
  const amountText = v.formatInr(amount);
  const auto = meta && meta.autopay ? ' (AutoPay)' : '';
  await notify.create(client, userId, {
    kind: 'RECHARGE',
    title: `Recharge of ${amountText} successful${auto}`,
    body: `${v.OPERATORS[operator]} ${maskMobile(mobile)}${plan ? ` · ${plan}` : ''} · Ref ${ref(txId)}`,
    txId,
  });
  notify.queueEmail(outbox, {
    to: user.email,
    name: user.full_name,
    subject: `Recharge of ${amountText} successful for ${v.OPERATORS[operator]} ${maskMobile(mobile)}`,
    lines: [plan && `Plan: ${plan}`, `Reference: ${ref(txId)}`, `Balance: ${v.formatInr(balance)}`],
  });
  return { transactionId: txId, balance, createdAt: ins.rows[0].created_at };
}

async function recharge(userId, body, idempotencyKey) {
  const mobile = v.normalizeMobile(body.mobile);
  const operator = v.validateOperator(body.operator);
  const amount = v.parseAmountToPaise(body.amount, { minPaise: RECHARGE_MIN, maxPaise: RECHARGE_MAX });
  const plan = typeof body.plan === 'string' && body.plan.trim() ? body.plan.trim().slice(0, 40) : null;
  const key = v.validateIdempotencyKey(idempotencyKey);

  return runMoney(userId, key, async (client, outbox) => {
    const r = await rechargeCore(client, { userId, mobile, operator, amount, plan, key, outbox });
    return {
      transactionId: r.transactionId,
      amount: money(amount),
      balance: money(r.balance),
      recharge: { operator, mobile, plan },
      createdAt: r.createdAt,
      replayed: false,
    };
  });
}

// ---------------------------------------------------------------- read models
/** Shows who owns a mobile number (or PayWave ID) so the sender can confirm before paying. */
async function lookup(userId, query = {}) {
  const target = v.normalizeTarget(query.to ?? query.mobile ?? query.payId);
  if (target.by === 'email') throw new HttpError(400, 'INVALID_MOBILE', 'Enter a valid 10 digit mobile number');
  const column = RECIPIENT_COLUMN[target.by];
  const { rows } = await db.query(
    `SELECT id, full_name, mobile, pay_id, (avatar IS NOT NULL) AS has_avatar
       FROM users WHERE ${column} = $1 AND is_verified`,
    [target.value],
  );
  if (!rows[0]) throw new HttpError(404, 'RECIPIENT_NOT_FOUND', 'No PayWave account found for that number');
  const u = rows[0];
  return { fullName: u.full_name, mobile: u.mobile, payId: u.pay_id, hasAvatar: u.has_avatar, isSelf: u.id === userId };
}

async function listTransactions(userId, query = {}) {
  let limit = Number.parseInt(query.limit ?? '20', 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 20;
  limit = Math.min(limit, 50);

  let before = null;
  if (query.before) {
    if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(query.before)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid "before" cursor');
    }
    before = query.before;
  }

  const { rows } = await db.query(
    `SELECT t.id, t.type, t.amount_paise, t.note, t.status, t.meta,
            to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            CASE WHEN t.to_user = $1 THEN 'CREDIT' ELSE 'DEBIT' END AS direction,
            CASE WHEN t.type <> 'TRANSFER' THEN NULL
                 WHEN t.to_user = $1 THEN fu.full_name ELSE tu.full_name END AS counterparty_name,
            CASE WHEN t.type <> 'TRANSFER' THEN NULL
                 WHEN t.to_user = $1 THEN fu.pay_id ELSE tu.pay_id END AS counterparty_pay_id,
            CASE WHEN t.type <> 'TRANSFER' THEN NULL
                 WHEN t.to_user = $1 THEN fu.mobile ELSE tu.mobile END AS counterparty_mobile
       FROM transactions t
       LEFT JOIN users fu ON fu.id = t.from_user
       LEFT JOIN users tu ON tu.id = t.to_user
      WHERE (t.from_user = $1 OR t.to_user = $1)
        AND ($2::timestamptz IS NULL OR t.created_at < $2::timestamptz)
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $3`,
    [userId, before, limit],
  );

  const items = rows.map((r) => ({
    id: r.id,
    type: r.type,
    direction: r.direction,
    amount: money(r.amount_paise),
    note: r.note,
    status: r.status,
    detail: r.meta || null,
    counterparty: r.counterparty_pay_id
      ? { fullName: r.counterparty_name, payId: r.counterparty_pay_id, mobile: r.counterparty_mobile }
      : null,
    createdAt: r.created_at,
  }));

  return { items, nextBefore: items.length === limit ? items[items.length - 1].createdAt : null };
}

/** Totals for the last 30 days and a per-day series (UTC) for the last 7 days. "Spent" = transfers sent + recharges. */
async function insights(userId) {
  const totals = await db.query(
    `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE type IN ('TRANSFER', 'RECHARGE') AND from_user = $1), 0) AS sent,
            COALESCE(SUM(amount_paise) FILTER (WHERE type = 'TRANSFER' AND to_user = $1), 0)                  AS received,
            COALESCE(SUM(amount_paise) FILTER (WHERE type = 'TOPUP' AND to_user = $1), 0)                     AS added,
            COUNT(*)                                                                                          AS count
       FROM transactions
      WHERE (from_user = $1 OR to_user = $1)
        AND created_at >= now() - interval '30 days'`,
    [userId],
  );

  const daily = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(t.amount_paise) FILTER (WHERE t.from_user = $1), 0) AS sent,
            COALESCE(SUM(t.amount_paise) FILTER (WHERE t.to_user = $1), 0)   AS received
       FROM generate_series(((now() AT TIME ZONE 'UTC')::date - 6)::timestamp,
                            (now() AT TIME ZONE 'UTC')::date::timestamp,
                            interval '1 day') AS d
       LEFT JOIN transactions t
              ON t.type IN ('TRANSFER', 'RECHARGE')
             AND (t.from_user = $1 OR t.to_user = $1)
             AND (t.created_at AT TIME ZONE 'UTC')::date = d::date
      GROUP BY d
      ORDER BY d`,
    [userId],
  );

  const t = totals.rows[0];
  return {
    last30Days: {
      sent: money(t.sent),
      received: money(t.received),
      added: money(t.added),
      transactions: Number(t.count),
    },
    daily: daily.rows.map((r) => ({ day: r.day, sent: money(r.sent), received: money(r.received) })),
  };
}

/** People the user paid most recently (for one tap "send again"). */
async function contacts(userId) {
  const { rows } = await db.query(
    `SELECT full_name, pay_id, mobile, has_avatar FROM (
       SELECT DISTINCT ON (u.id) u.full_name, u.pay_id, u.mobile, (u.avatar IS NOT NULL) AS has_avatar, t.created_at
         FROM transactions t
         JOIN users u ON u.id = t.to_user
        WHERE t.from_user = $1 AND t.type = 'TRANSFER'
        ORDER BY u.id, t.created_at DESC
     ) recent
     ORDER BY created_at DESC
     LIMIT 8`,
    [userId],
  );
  return { items: rows.map((r) => ({ fullName: r.full_name, payId: r.pay_id, mobile: r.mobile, hasAvatar: r.has_avatar })) };
}

module.exports = {
  getMe,
  addMoney,
  transfer,
  recharge,
  lookup,
  listTransactions,
  insights,
  contacts,
  // used by AutoPay
  core: { findRecipient, transferCore, rechargeCore },
  LIMITS: { TRANSFER_MIN, TRANSFER_MAX, RECHARGE_MIN, RECHARGE_MAX },
};
