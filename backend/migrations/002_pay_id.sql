-- Every account gets a unique PayWave ID (like PW7K3M9QXA) that other people use to pay it.
-- New accounts get a random ID from the application; this backfills any existing rows.

ALTER TABLE users ADD COLUMN pay_id TEXT;

UPDATE users
   SET pay_id = 'PW' || upper(substr(md5(id::text || clock_timestamp()::text), 1, 8))
 WHERE pay_id IS NULL;

ALTER TABLE users ALTER COLUMN pay_id SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_pay_id_format CHECK (pay_id ~ '^PW[A-Z0-9]{8}$');
CREATE UNIQUE INDEX ux_users_pay_id ON users (pay_id);
