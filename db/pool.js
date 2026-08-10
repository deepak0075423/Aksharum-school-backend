'use strict';
// node-pg connection pool.
//
// In production this points at PgBouncer (transaction pooling) via DATABASE_URL
// on port 6432 — see deploy/pgbouncer/. All queries here go through pool.query()
// as single unnamed parameterized statements (no BEGIN/COMMIT, no session state),
// which is exactly what transaction pooling requires — so no code change is
// needed to run behind the pooler. `max` below then sizes cheap app→PgBouncer
// client connections; the real Postgres backend ceiling lives in pgbouncer.ini.
// If you ever add multi-statement transactions, check them out on ONE client
// (pool.connect()) so PgBouncer keeps them on a single backend.
const { Pool } = require('pg');

let pool = null;

function getPool() {
    if (!pool) {
        const connectionString = process.env.DATABASE_URL || 'postgres://localhost:5432/aksharum_erp';
        pool = new Pool({
            connectionString,
            max: Number(process.env.PG_POOL_MAX) || 20,
            idleTimeoutMillis: 30000,       // release idle clients back to Postgres after 30s
            connectionTimeoutMillis: 5000,  // fail fast instead of queueing forever under load
            query_timeout: 20000,           // safety net against a runaway/blocked query
            keepAlive: true,
        });
        pool.on('error', (err) => console.error('[pg] pool error:', err.message));
    }
    return pool;
}

async function query(text, params) {
    return getPool().query(text, params);
}

async function end() {
    if (pool) { await pool.end(); pool = null; }
}

module.exports = { getPool, query, end };
