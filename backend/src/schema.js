'use strict';

// Tiny migration runner: applies backend/migrations/*.sql in name order, once each.
// An advisory lock makes concurrent cold starts safe.
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');

const LOCK_ID = 727001;

async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount > 0) continue;

      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log('info', 'migration applied', { file });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    } catch {
      /* ignore */
    }
    client.release();
  }
}

module.exports = { runMigrations };
