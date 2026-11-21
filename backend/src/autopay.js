'use strict';

// Recurring payments. A scheduled EventBridge rule invokes the Lambda every 5 minutes and runDue()
// executes whatever is due. Every run uses a deterministic idempotency key, so a retried or
// overlapping invocation can never pay twice.
const db = require('./db');
const v = require('./validate');
const log = require('./log');
const notify = require('./notify');
const wallet = require('./wallet');
const { HttpError } = require('./http');

const MAX_ACTIVE = 10;
const BATCH = 25;

/** Next run after `from`, for the given frequency. Monthly clamps to the last day of shorter months. */
function advance(from, frequency) {
  const d = new Date(from.getTime());
  if (frequency === 'DAILY') d.setUTCDate(d.getUTCDate() + 1);
  else if (frequency === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d;
}

/** First run strictly after `now` (missed runs are skipped, not caught up). */
function nextAfter(from, frequency, now = new Date()) {
  let d = advance(from, frequency);
  let guard = 0;
  while (d.getTime() <= now.getTime() && guard < 4000) {
    d = advance(d, frequency);
    guard += 1;
  }
  return d;
}

const row = (r) => ({
  id: r.id,
  kind: r.kind,
  amount: { paise: Number(r.amount_paise), display: v.formatPaise(r.amount_paise) },
  frequency: r.frequency,
  note: r.note,
  nextRunAt: r.next_run_at,
  status: r.status,
  lastRunAt: r.last_run_at,
  lastStatus: r.last_status,
  lastError: r.last_error,
  to: r.kind === 'TRANSFER' ? { fullName: r.to_name, mobile: r.to_mobile } : null,
  recharge: r.kind === 'RECHARGE' ? { mobile: r.recharge_mobile, operator: r.operator } : null,
});

const SELECT = `SELECT a.*, tu.full_name AS to_name, tu.mobile AS to_mobile
                  FROM autopays a LEFT JOIN users tu ON tu.id = a.to_user`;

async function list(userId) {
  const { rows } = await db.query(
    `${SELECT} WHERE a.user_id = $1 AND a.status <> 'CANCELLED' ORDER BY a.created_at DESC LIMIT 50`,
    [userId],
  );
  return { items: rows.map(row) };
}

async function create(userId, body) {
  const kind = body.kind === 'RECHARGE' ? 'RECHARGE' : body.kind === 'TRANSFER' ? 'TRANSFER' : null;
  if (!kind) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a payment or a recharge');
  const frequency = v.validateFrequency(body.frequency);
  const note = v.validateNote(body.note);

  const startAt = new Date(body.startAt);
  const now = Date.now();
  if (Number.isNaN(startAt.getTime()) || startAt.getTime() < now - 60_000 || startAt.getTime() > now + 366 * 86_400_000) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Pick a start time within the next year');
  }

  let toUser = null;
  let mobile = null;
  let operator = null;
  let amount;
  if (kind === 'TRANSFER') {
    amount = v.parseAmountToPaise(body.amount, { minPaise: wallet.LIMITS.TRANSFER_MIN, maxPaise: wallet.LIMITS.TRANSFER_MAX });
    const recipient = await wallet.core.findRecipient(db, v.normalizeTarget(body.to));
    if (recipient.id === userId) throw new HttpError(400, 'SELF_TRANSFER', 'You cannot send money to yourself');
    toUser = recipient.id;
  } else {
    amount = v.parseAmountToPaise(body.amount, { minPaise: wallet.LIMITS.RECHARGE_MIN, maxPaise: wallet.LIMITS.RECHARGE_MAX });
    mobile = v.normalizeMobile(body.mobile);
    operator = v.validateOperator(body.operator);
  }

  // The cap check and insert run in one transaction on the user's row lock so two requests cannot exceed it
  const id = await db.tx(async (client) => {
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const n = await client.query("SELECT count(*)::int AS n FROM autopays WHERE user_id = $1 AND status <> 'CANCELLED'", [userId]);
    if (n.rows[0].n >= MAX_ACTIVE) throw new HttpError(422, 'AUTOPAY_LIMIT', `You can have at most ${MAX_ACTIVE} AutoPays`);
    const r = await client.query(
      `INSERT INTO autopays (user_id, kind, to_user, recharge_mobile, operator, amount_paise, frequency, note, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [userId, kind, toUser, mobile, operator, amount, frequency, note, startAt.toISOString()],
    );
    return r.rows[0].id;
  });
  const { rows } = await db.query(`${SELECT} WHERE a.id = $1`, [id]);
  return row(rows[0]);
}

async function action(userId, body) {
  const id = v.validateUuid(body.id, 'AutoPay id');
  const act = body.action;
  const next = { pause: 'PAUSED', resume: 'ACTIVE', cancel: 'CANCELLED' }[act];
  if (!next) throw new HttpError(400, 'VALIDATION_ERROR', 'Action must be pause, resume or cancel');

  const r = await db.query(
    `UPDATE autopays
        SET status = $3,
            next_run_at = CASE WHEN $3 = 'ACTIVE' AND next_run_at <= now() THEN now() + interval '5 minutes' ELSE next_run_at END
      WHERE id = $1 AND user_id = $2 AND status <> 'CANCELLED' RETURNING id`,
    [id, userId, next],
  );
  if (r.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'AutoPay not found');
  return { ok: true };
}

function describe(a) {
  return a.kind === 'TRANSFER' ? `payment of ${v.formatInr(a.amount_paise)}` : `recharge of ${v.formatInr(a.amount_paise)} for ${a.recharge_mobile}`;
}

/** Executes one due AutoPay. Returns 'paid', 'failed' or 'skipped'. */
async function runOne(id) {
  const outbox = [];
  let tried = null;
  try {
    const status = await db.tx(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM autopays WHERE id = $1 AND status = 'ACTIVE' AND next_run_at <= now() FOR UPDATE SKIP LOCKED`,
        [id],
      );
      const a = rows[0];
      if (!a) return 'skipped';
      tried = a;
      const key = `ap_${a.id.replace(/-/g, '')}_${Math.floor(new Date(a.next_run_at).getTime() / 1000)}`;
      const meta = { autopay: a.id };

      if (a.kind === 'TRANSFER') {
        const rec = await client.query('SELECT id, full_name, email, mobile, pay_id FROM users WHERE id = $1 AND is_verified', [a.to_user]);
        if (!rec.rows[0]) throw new HttpError(404, 'RECIPIENT_NOT_FOUND', 'Recipient no longer exists');
        await wallet.core.transferCore(client, { fromId: a.user_id, recipient: rec.rows[0], amount: Number(a.amount_paise), note: a.note, key, meta, outbox });
      } else {
        await wallet.core.rechargeCore(client, {
          userId: a.user_id, mobile: a.recharge_mobile, operator: a.operator, amount: Number(a.amount_paise), plan: null, key, meta, outbox,
        });
      }
      await client.query(
        `UPDATE autopays SET last_run_at = now(), last_status = 'PAID', last_error = NULL, next_run_at = $2 WHERE id = $1`,
        [a.id, nextAfter(new Date(a.next_run_at), a.frequency).toISOString()],
      );
      return 'paid';
    });
    await notify.flushEmails(outbox);
    return status;
  } catch (err) {
    if (!tried) throw err;
    const reason = err instanceof HttpError ? err.message : 'Something went wrong';
    if (!(err instanceof HttpError)) log('error', 'autopay failed', { id, error: err.message });
    // Record the failure and move on; guarded on the same next_run_at so a concurrent run is not double counted
    const failOutbox = [];
    await db.tx(async (client) => {
      const u = await client.query(
        `UPDATE autopays SET last_run_at = now(), last_status = 'FAILED', last_error = $3, next_run_at = $4
          WHERE id = $1 AND status = 'ACTIVE' AND next_run_at = $2 RETURNING id`,
        [tried.id, tried.next_run_at, reason, nextAfter(new Date(tried.next_run_at), tried.frequency).toISOString()],
      );
      if (u.rowCount === 0) return;
      await notify.create(client, tried.user_id, {
        kind: 'AUTOPAY_FAILED',
        title: `AutoPay ${describe(tried)} failed`,
        body: `${reason}. We will try again on the next date.`,
      });
      const user = (await client.query('SELECT full_name, email FROM users WHERE id = $1', [tried.user_id])).rows[0];
      notify.queueEmail(failOutbox, {
        to: user.email, name: user.full_name,
        subject: `AutoPay ${describe(tried)} failed`, lines: [reason],
      });
    });
    await notify.flushEmails(failOutbox);
    return 'failed';
  }
}

async function runDue() {
  const { rows } = await db.query(
    `SELECT id FROM autopays WHERE status = 'ACTIVE' AND next_run_at <= now() ORDER BY next_run_at LIMIT $1`,
    [BATCH],
  );
  const result = { due: rows.length, paid: 0, failed: 0, skipped: 0, errors: 0 };
  for (const { id } of rows) {
    try {
      result[await runOne(id)] += 1;
    } catch (err) {
      result.errors += 1;
      log('error', 'autopay run error', { id, error: err.message });
    }
  }
  log('info', 'autopay run', result);
  return result;
}

module.exports = { list, create, action, runDue, runOne, advance, nextAfter, MAX_ACTIVE };
