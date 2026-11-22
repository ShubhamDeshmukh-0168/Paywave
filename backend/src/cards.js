'use strict';

// PayWave virtual cards: every user gets one debit card (spends the wallet balance) and one credit
// card (spends a credit limit that is paid back from the wallet). They are demo cards: no real card
// network is involved. Numbers and CVVs are encrypted at rest and shown only after a password check.
const nodeCrypto = require('node:crypto');
const db = require('./db');
const c = require('./crypto');
const v = require('./validate');
const { HttpError } = require('./http');
const { getAppConfig } = require('./secrets');

const CREDIT_LIMIT_PAISE = 2_500_000; // Rs 25,000.00
const BIN = { DEBIT: '607087', CREDIT: '607088' }; // 6 digit prefix of the generated numbers
const MAX_CVV_FAILURES = 5;
const CARD_COLUMNS = 'id, kind, last4, exp_month, exp_year, holder, status, credit_limit_paise, outstanding_paise';

const money = (paise) => ({ paise: Number(paise), display: v.formatPaise(paise) });
const group = (pan) => pan.replace(/(\d{4})(?=\d)/g, '$1 ');

function expired(card, now = new Date()) {
  // A card works until the end of its expiry month
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return card.exp_year < y || (card.exp_year === y && card.exp_month < m);
}

function present(row) {
  const credit = row.kind === 'CREDIT';
  const item = {
    id: row.id,
    kind: row.kind,
    last4: row.last4,
    masked: `\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 ${row.last4}`,
    expMonth: row.exp_month,
    expYear: row.exp_year,
    holder: row.holder,
    status: row.status,
  };
  if (credit) {
    item.creditLimit = money(row.credit_limit_paise);
    item.outstanding = money(row.outstanding_paise);
    item.available = money(Number(row.credit_limit_paise) - Number(row.outstanding_paise));
  }
  return item;
}

/** Issues the missing card(s) for a user. Safe to call any number of times. */
async function ensureCards(userId) {
  const have = new Set((await db.query('SELECT kind FROM cards WHERE user_id = $1', [userId])).rows.map((r) => r.kind));
  if (have.size >= 2) return;

  const user = (await db.query('SELECT full_name FROM users WHERE id = $1', [userId])).rows[0];
  if (!user) throw new HttpError(401, 'UNAUTHORIZED', 'Account not found');
  const secret = (await getAppConfig()).jwt_secret;
  const holder = user.full_name.toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 26) || 'PAYWAVE USER';
  const now = new Date();

  for (const kind of ['DEBIT', 'CREDIT']) {
    if (have.has(kind)) continue;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const pan = c.generateCardNumber(BIN[kind]);
      try {
        await db.query(
          `INSERT INTO cards (user_id, kind, last4, pan_enc, pan_hash, cvv_enc, exp_month, exp_year, holder, credit_limit_paise)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (user_id, kind) DO NOTHING`,
          [
            userId, kind, pan.slice(-4), c.encryptField(secret, pan), c.hmacHex(secret, `pan:${pan}`),
            c.encryptField(secret, c.generateCvv()), now.getUTCMonth() + 1, now.getUTCFullYear() + 5, holder,
            kind === 'CREDIT' ? CREDIT_LIMIT_PAISE : 0,
          ],
        );
        break;
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'ux_cards_pan') continue; // same number already issued: draw another
        throw err;
      }
    }
  }
}

async function list(userId) {
  await ensureCards(userId);
  const { rows } = await db.query(`SELECT ${CARD_COLUMNS} FROM cards WHERE user_id = $1 ORDER BY kind DESC`, [userId]);
  const wallet = (await db.query('SELECT balance_paise FROM wallets WHERE user_id = $1', [userId])).rows[0];
  return { items: rows.map(present), walletBalance: money(wallet ? wallet.balance_paise : 0) };
}

/** Full number, expiry and CVV. The route checks the user's password first. */
async function reveal(userId, body) {
  const kind = v.validateCardKind(body.kind);
  await ensureCards(userId);
  const row = (await db.query('SELECT * FROM cards WHERE user_id = $1 AND kind = $2', [userId, kind])).rows[0];
  if (!row) throw new HttpError(404, 'CARD_NOT_FOUND', 'Card not found');
  const secret = (await getAppConfig()).jwt_secret;
  return {
    kind,
    number: group(c.decryptField(secret, row.pan_enc)),
    cvv: c.decryptField(secret, row.cvv_enc),
    expMonth: row.exp_month,
    expYear: row.exp_year,
    holder: row.holder,
  };
}

/** Freeze or unfreeze a card. The route asks for the password when unfreezing. */
async function setStatus(userId, body) {
  const kind = v.validateCardKind(body.kind);
  if (typeof body.frozen !== 'boolean') throw new HttpError(400, 'VALIDATION_ERROR', 'frozen must be true or false');
  await ensureCards(userId);
  const { rows } = await db.query(
    `UPDATE cards SET status = $3, cvv_failures = 0 WHERE user_id = $1 AND kind = $2 RETURNING ${CARD_COLUMNS}`,
    [userId, kind, body.frozen ? 'FROZEN' : 'ACTIVE'],
  );
  if (!rows[0]) throw new HttpError(404, 'CARD_NOT_FOUND', 'Card not found');
  return present(rows[0]);
}

/**
 * Checks the CVV before any money moves. Runs outside the payment transaction on purpose: a wrong
 * CVV must be counted even though the payment is rejected. Five wrong tries in a row freeze the card.
 */
async function verifyCvv(userId, kind, cvv) {
  await ensureCards(userId);
  const row = (await db.query('SELECT * FROM cards WHERE user_id = $1 AND kind = $2', [userId, kind])).rows[0];
  if (!row) throw new HttpError(404, 'CARD_NOT_FOUND', 'Card not found');
  if (row.status === 'FROZEN') throw new HttpError(403, 'CARD_FROZEN', `Your ${kind.toLowerCase()} card is frozen. Unfreeze it in Cards.`);
  if (expired(row)) throw new HttpError(422, 'CARD_EXPIRED', 'This card has expired');

  const secret = (await getAppConfig()).jwt_secret;
  const expected = Buffer.from(c.decryptField(secret, row.cvv_enc));
  const given = Buffer.from(cvv);
  if (given.length !== expected.length || !nodeCrypto.timingSafeEqual(given, expected)) {
    const upd = await db.query(
      `UPDATE cards SET cvv_failures = cvv_failures + 1,
              status = CASE WHEN cvv_failures + 1 >= $2 THEN 'FROZEN' ELSE status END
        WHERE id = $1 RETURNING status`,
      [row.id, MAX_CVV_FAILURES],
    );
    if (upd.rows[0].status === 'FROZEN') {
      throw new HttpError(403, 'CARD_FROZEN', 'Wrong CVV too many times. The card is frozen: unfreeze it in Cards.');
    }
    throw new HttpError(403, 'INVALID_CVV', 'Incorrect CVV');
  }
  if (row.cvv_failures > 0) await db.query('UPDATE cards SET cvv_failures = 0 WHERE id = $1', [row.id]);
  return { id: row.id, kind: row.kind, last4: row.last4 };
}

/** Inside a payment transaction: locks the card row (always before any wallet row) and re-checks it. */
async function lockCard(client, cardId) {
  const row = (await client.query(
    `SELECT ${CARD_COLUMNS} FROM cards WHERE id = $1 FOR UPDATE`, [cardId],
  )).rows[0];
  if (!row) throw new HttpError(404, 'CARD_NOT_FOUND', 'Card not found');
  if (row.status === 'FROZEN') throw new HttpError(403, 'CARD_FROZEN', `Your ${row.kind.toLowerCase()} card is frozen. Unfreeze it in Cards.`);
  if (expired(row)) throw new HttpError(422, 'CARD_EXPIRED', 'This card has expired');
  return row;
}

module.exports = { ensureCards, list, reveal, setStatus, verifyCvv, lockCard, CREDIT_LIMIT_PAISE, present };
