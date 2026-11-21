-- PayWave initial schema. Money is stored as integer paise (1 rupee = 100 paise).

CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT        NOT NULL,
  full_name             TEXT        NOT NULL,
  password_hash         TEXT        NOT NULL,
  is_verified           BOOLEAN     NOT NULL DEFAULT FALSE,
  failed_login_attempts INTEGER     NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX ux_users_email ON users (email);

CREATE TABLE wallets (
  user_id       UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  balance_paise BIGINT      NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     TEXT        NOT NULL DEFAULT 'VERIFY_EMAIL',
  code_hash   TEXT        NOT NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_otp_user ON otp_codes (user_id, purpose, id DESC);

CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT        NOT NULL CHECK (type IN ('TOPUP', 'TRANSFER')),
  from_user       UUID REFERENCES users (id),
  to_user         UUID NOT NULL REFERENCES users (id),
  initiated_by    UUID        NOT NULL REFERENCES users (id),
  amount_paise    BIGINT      NOT NULL CHECK (amount_paise > 0),
  note            TEXT,
  status          TEXT        NOT NULL DEFAULT 'SUCCESS',
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transfer_has_sender CHECK (type <> 'TRANSFER' OR from_user IS NOT NULL),
  CONSTRAINT no_self_transfer CHECK (from_user IS NULL OR from_user <> to_user)
);
CREATE INDEX ix_tx_from ON transactions (from_user, created_at DESC);
CREATE INDEX ix_tx_to ON transactions (to_user, created_at DESC);
-- The same Idempotency-Key from the same user can only create one transaction
CREATE UNIQUE INDEX ux_tx_idempotency ON transactions (initiated_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
