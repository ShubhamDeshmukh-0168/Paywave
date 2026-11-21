'use strict';

const log = require('./log');
const { getDbPassword } = require('./secrets');

let pool;
let readyPromise;

function getPool() {
  if (pool) return pool;
  const { Pool } = require('pg');
  pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    // pg accepts an async function, so every new connection uses the current secret
    password: () => getDbPassword(),
    // RDS PostgreSQL 15+ enforces TLS. rejectUnauthorized:false keeps the link encrypted
    // without bundling the RDS CA; pin the RDS CA bundle for stricter verification.
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 2, // one request per Lambda container at a time; keep connections low
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
    statement_timeout: 10000,
    allowExitOnIdle: true,
  });
  pool.on('error', (err) => log('error', 'idle pg client error', { error: err.message }));
  return pool;
}

function ready() {
  if (!readyPromise) {
    const { runMigrations } = require('./schema');
    readyPromise = runMigrations(getPool()).catch((err) => {
      readyPromise = undefined; // retry on the next invocation
      throw err;
    });
  }
  return readyPromise;
}

async function query(text, params) {
  await ready();
  return getPool().query(text, params);
}

async function tx(fn) {
  await ready();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, tx, ready };
