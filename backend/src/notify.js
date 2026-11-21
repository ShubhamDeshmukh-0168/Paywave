'use strict';

// In-app notifications (rows in the same database transaction as the payment) plus
// best-effort email copies that are sent after the payment is committed.
const db = require('./db');
const log = require('./log');
const { HttpError } = require('./http');
const { sendEmail } = require('./mailer');

/** Call inside the payment's transaction so the notification exists if, and only if, the payment does. */
async function create(client, userId, { kind, title, body = '', txId = null }) {
  await client.query(
    'INSERT INTO notifications (user_id, kind, title, body, tx_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, kind, title, body, txId],
  );
}

/** Adds an email to the outbox; flushEmails() sends it once the transaction has committed. */
function queueEmail(outbox, { to, name, subject, lines = [] }) {
  if (outbox && to) outbox.push({ to, name, subject, headline: subject, lines: lines.filter(Boolean) });
}

/**
 * Sends queued emails without ever failing the payment. Bounded by a timeout because
 * a Lambda must not hang on a slow SMTP server.
 */
async function flushEmails(outbox, timeoutMs = 4500) {
  if (!outbox || outbox.length === 0) return;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const sending = Promise.allSettled(outbox.map((m) => sendEmail(m)));
  const result = await Promise.race([sending, timeout]);
  clearTimeout(timer);
  if (result === 'timeout') {
    log('warn', 'notification emails timed out', { count: outbox.length });
    return;
  }
  result.forEach((r) => {
    if (r.status === 'rejected') log('error', 'notification email failed', { error: r.reason && r.reason.message });
  });
}

async function list(userId, query = {}) {
  let limit = Number.parseInt(query.limit ?? '30', 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 30;
  limit = Math.min(limit, 50);

  const [items, unread] = await Promise.all([
    db.query(
      `SELECT id, kind, title, body, tx_id,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
              read_at IS NOT NULL AS read
         FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
      [userId, limit],
    ),
    db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]),
  ]);
  return {
    unread: unread.rows[0].n,
    items: items.rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      title: r.title,
      body: r.body,
      txId: r.tx_id,
      createdAt: r.created_at,
      read: r.read,
    })),
  };
}

async function markRead(userId, body = {}) {
  if (body.all === true) {
    await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
    return { ok: true };
  }
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 100 || !body.ids.every((n) => Number.isInteger(n) && n > 0)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Send {"all":true} or a list of notification ids');
  }
  await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [userId, body.ids]);
  return { ok: true };
}

module.exports = { create, queueEmail, flushEmails, list, markRead };
