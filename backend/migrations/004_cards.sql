-- 004: PayWave virtual cards (one debit and one credit card per user) and card bill payments.

CREATE TABLE cards (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind               TEXT        NOT NULL CHECK (kind IN ('DEBIT', 'CREDIT')),
  last4              TEXT        NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  -- The full number and the CVV are encrypted by the application (AES-256-GCM) and only decrypted
  -- for the owner, after a password check. pan_hash is a keyed hash that keeps card numbers unique.
  pan_enc            TEXT        NOT NULL,
  pan_hash           TEXT        NOT NULL,
  cvv_enc            TEXT        NOT NULL,
  exp_month          INTEGER     NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year           INTEGER     NOT NULL CHECK (exp_year BETWEEN 2020 AND 2100),
  holder             TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN')),
  cvv_failures       INTEGER     NOT NULL DEFAULT 0,
  credit_limit_paise BIGINT      NOT NULL DEFAULT 0 CHECK (credit_limit_paise >= 0),
  outstanding_paise  BIGINT      NOT NULL DEFAULT 0 CHECK (outstanding_paise >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cards_within_limit CHECK (outstanding_paise <= credit_limit_paise),
  CONSTRAINT ux_cards_user_kind UNIQUE (user_id, kind),
  CONSTRAINT ux_cards_pan UNIQUE (pan_hash)
);

-- Paying the credit card bill from the wallet
ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('TOPUP', 'TRANSFER', 'RECHARGE', 'CARD_BILL'));
ALTER TABLE transactions DROP CONSTRAINT tx_shape;
ALTER TABLE transactions ADD CONSTRAINT tx_shape CHECK (
  (type = 'TOPUP'    AND to_user IS NOT NULL AND from_user IS NULL) OR
  (type = 'TRANSFER' AND to_user IS NOT NULL AND from_user IS NOT NULL) OR
  (type IN ('RECHARGE', 'CARD_BILL') AND from_user IS NOT NULL AND to_user IS NULL)
);
