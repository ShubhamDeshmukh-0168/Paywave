-- 003: mobile numbers, profile photos, recharges, card top-ups, notifications and AutoPay.

-- ---------------------------------------------------------------- users: mobile number + photo
ALTER TABLE users ADD COLUMN mobile TEXT;
ALTER TABLE users ADD COLUMN avatar TEXT; -- small JPEG as a data URL (resized to 256x256 by the browser)
ALTER TABLE users ADD CONSTRAINT users_mobile_format CHECK (mobile IS NULL OR mobile ~ '^[6-9][0-9]{9}$');
-- A number can belong to only one verified account, and an unverified sign-up can never block it
CREATE UNIQUE INDEX ux_users_mobile ON users (mobile) WHERE is_verified AND mobile IS NOT NULL;

-- ---------------------------------------------------------------- transactions: recharges + details
ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('TOPUP', 'TRANSFER', 'RECHARGE'));
ALTER TABLE transactions ALTER COLUMN to_user DROP NOT NULL;
ALTER TABLE transactions ADD COLUMN meta JSONB; -- card brand/last4, recharge operator/mobile, autopay flag
ALTER TABLE transactions ADD CONSTRAINT tx_shape CHECK (
  (type = 'TOPUP'    AND to_user IS NOT NULL AND from_user IS NULL) OR
  (type = 'TRANSFER' AND to_user IS NOT NULL AND from_user IS NOT NULL) OR
  (type = 'RECHARGE' AND from_user IS NOT NULL AND to_user IS NULL)
);

-- ---------------------------------------------------------------- in-app notifications
CREATE TABLE notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT        NOT NULL,
  title      TEXT        NOT NULL,
  body       TEXT        NOT NULL DEFAULT '',
  tx_id      UUID,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_user ON notifications (user_id, id DESC);
CREATE INDEX ix_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

-- ---------------------------------------------------------------- AutoPay (recurring payments)
CREATE TABLE autopays (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind            TEXT        NOT NULL CHECK (kind IN ('TRANSFER', 'RECHARGE')),
  to_user         UUID REFERENCES users (id),
  recharge_mobile TEXT,
  operator        TEXT,
  amount_paise    BIGINT      NOT NULL CHECK (amount_paise > 0),
  frequency       TEXT        NOT NULL CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  note            TEXT,
  next_run_at     TIMESTAMPTZ NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CANCELLED')),
  last_run_at     TIMESTAMPTZ,
  last_status     TEXT,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT autopay_target CHECK (
    (kind = 'TRANSFER' AND to_user IS NOT NULL) OR
    (kind = 'RECHARGE' AND recharge_mobile IS NOT NULL AND operator IS NOT NULL)
  )
);
CREATE INDEX ix_autopay_user ON autopays (user_id, created_at DESC);
CREATE INDEX ix_autopay_due ON autopays (next_run_at) WHERE status = 'ACTIVE';
