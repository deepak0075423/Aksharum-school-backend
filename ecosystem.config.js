/**
 * PM2 Ecosystem Config — cluster mode.
 *
 * Multi-worker cluster mode is now SAFE because the two pieces of single-process
 * state have been externalised / guarded:
 *   • Real-time chat + notifications run over Redis pub/sub and a separate
 *     WebSocket gateway (not in-process sockets).
 *   • The chat-broker Redis consumer and the monthly leave-accrual timer are
 *     guarded by utils/primaryWorker.js so they run on instance 0 only.
 * (The SSE endpoints that the old comment worried about are self-contained
 *  per-request progress streams — they never needed a shared registry.)
 *
 * Connection math — depends on whether PgBouncer sits in front (PGBOUNCER=true):
 *
 *   • DIRECT to Postgres (PGBOUNCER unset — dev / small deploys):
 *       total DB connections = workers × PG_POOL_MAX
 *     MUST stay under Postgres `max_connections` (default 100), so the budget is
 *     capped at 80 (~20 headroom for admin/monitoring). This is the safe default.
 *
 *   • BEHIND PgBouncer (PGBOUNCER=true — production 5k+ users):
 *       PgBouncer (transaction pooling) multiplexes ALL worker connections onto
 *       its small `default_pool_size` of real backends, so `workers × PG_POOL_MAX`
 *       no longer maps 1:1 to Postgres. This budget now sizes the (cheap)
 *       app→PgBouncer client connections, bounded by PgBouncer `max_client_conn`
 *       (2000), NOT by Postgres max_connections. The real DB-connection ceiling
 *       lives in deploy/pgbouncer/pgbouncer.ini (default_pool_size / max_db_connections).
 *       See deploy/pgbouncer/README.md.
 */
const os = require('os');

const usingPgBouncer = String(process.env.PGBOUNCER || '').toLowerCase() === 'true';
const workers = Number(process.env.WEB_CONCURRENCY) || os.cpus().length;
// Direct: keep under max_connections=100. Behind the pooler: plenty of cheap
// app→pooler client conns (real backends are capped by PgBouncer, not this).
const defaultBudget = usingPgBouncer ? 400 : 80;
const pgBudget = Number(process.env.PG_TOTAL_POOL) || defaultBudget;
const perWorkerPool = Math.max(usingPgBouncer ? 10 : 4, Math.floor(pgBudget / workers));

module.exports = {
    apps: [
        {
            name:        'school-backend',
            script:      'server.js',
            instances:   workers,      // one worker per CPU core by default
            exec_mode:   'cluster',    // load-balanced across workers by PM2
            watch:       false,
            max_memory_restart: '600M',
            error_file:  './logs/err.log',
            out_file:    './logs/out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            env: {
                NODE_ENV: 'production',
                // Frontend (raw IP mode) calls http://<IP>:3010/api directly, so the
                // API must listen on 3010. PM2 env overrides any PORT in .env.
                PORT: 3010,
                PG_POOL_MAX: String(perWorkerPool),
            },
        },
    ],
};
