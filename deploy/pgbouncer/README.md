# PgBouncer — connection pooling for School 2.0

Removes the single hardest ceiling on the app at 5k concurrent users: the
`workers × PG_POOL_MAX < Postgres max_connections` limit. PgBouncer multiplexes
**all** app-worker connections onto a small pool of real Postgres backends, so
the app can open plenty of (cheap) connections while Postgres never sees more
than ~40–50.

```
app worker 1 ┐
app worker 2 ┤   many cheap client conns      few real backends
   ...       ├──────────────▶  PgBouncer  ──────────────▶  PostgreSQL
app worker N ┘   (max_client_conn=2000)      (default_pool_size=40)  :5432
                                    :6432
```

## Why transaction pooling is safe here

`pool_mode = transaction` is the aggressive mode that gives the multiplexing
above. It's only safe if the app never relies on state that lives on a specific
backend across queries. This app was audited and has **none**:

- no `BEGIN/COMMIT/ROLLBACK` — every query is single-statement autocommit
- no `LISTEN/NOTIFY` — real-time is Redis pub/sub, not Postgres
- no advisory locks, `SET`/`search_path`, or `WITH HOLD` cursors
- no **named** prepared statements — node-pg sends unnamed parameterized queries

> ⚠️ If you later add multi-statement transactions, run them on a single
> checked-out client (`pool.connect()` … `client.release()`) so they stay on one
> backend. If you enable named/server-side prepared statements, you must switch
> to `pool_mode = session` and redo the math (session mode pins one backend per
> client and loses most of the scaling benefit).

## The math

| Setting | Value | Meaning |
|---|---:|---|
| Postgres `max_connections` | 100 | unchanged — the whole point is you don't need more |
| PgBouncer `default_pool_size` | 40 | **real** Postgres backends per (user,db) |
| PgBouncer `min_pool_size` | 10 | warm backends kept ready for the login spike |
| PgBouncer `reserve_pool_size` | 10 | short-lived burst headroom |
| PgBouncer `max_db_connections` | 90 | hard cap on real backends (< 100, leaves admin headroom) |
| PgBouncer `max_client_conn` | 2000 | cheap app→pooler connections it will accept |
| App `PG_TOTAL_POOL` (PGBOUNCER=true) | 400 | app→pooler client conns, split across workers |

**Why 40 backends serve 5k users:** the [auth cache](../../utils/authCache.js)
already absorbs the hottest read (the per-request user lookup), so most requests
never touch Postgres. Under transaction pooling a backend is held only for the
duration of one query (~single-digit ms) and immediately returned. 40 backends ×
(1000 ms ÷ ~4 ms/query) ≈ **~10,000 statements/sec sustained** — far above the
real query rate of 5k users, whose per-user rate is well under one query/sec.
`reserve_pool_size` + `query_wait_timeout` handle bursts by shedding load fast
instead of piling up.

Worst case real backends = `default_pool_size (40) + reserve_pool_size (10) = 50`,
hard-capped at `max_db_connections (90)` — always under Postgres' 100.

---

## Setup

### 0. Prep Postgres

```bash
# Confirm the app user exists and check its password encryption (scram vs md5).
psql -h 127.0.0.1 -U postgres -d aksharum_erp -c \
  "SELECT rolname, left(rolpassword,14) AS pw_kind FROM pg_authid WHERE rolname='erp_user';"
# 'SCRAM-SHA-256$' -> keep auth_type = scram-sha-256 in pgbouncer.ini
# 'md5'            -> change auth_type = md5

# (optional) verify headroom
psql -h 127.0.0.1 -U postgres -c "SHOW max_connections;"   # expect ~100
```

### 1. Build the auth file

```bash
cp userlist.txt.example userlist.txt

# Pull the app user's verifier straight from Postgres (matches byte-for-byte):
psql -h 127.0.0.1 -U postgres -d aksharum_erp -Atq -c \
  "SELECT '\"'||rolname||'\" \"'||rolpassword||'\"' FROM pg_authid WHERE rolname='erp_user';" \
  >> userlist.txt
# then edit userlist.txt: remove the placeholder erp_user line, set pgb_admin/pgb_stats passwords
```

### 2a. Install — native (recommended for the PM2/VM deploy)

```bash
sudo apt-get update && sudo apt-get install -y pgbouncer
sudo install -o pgbouncer -g pgbouncer -m 644 pgbouncer.ini /etc/pgbouncer/pgbouncer.ini
sudo install -o pgbouncer -g pgbouncer -m 600 userlist.txt   /etc/pgbouncer/userlist.txt
sudo systemctl enable --now pgbouncer
sudo systemctl status pgbouncer --no-pager
```

### 2b. Install — Docker (alternative)

```bash
# Edit the [databases] host in pgbouncer.ini first — inside a container,
# 127.0.0.1 is NOT the host. See the comments in docker-compose.pgbouncer.yml.
docker compose -f docker-compose.pgbouncer.yml up -d
```

### 3. Point the app at the pooler

In the backend `.env`:

```dotenv
DATABASE_URL=postgres://erp_user:password@127.0.0.1:6432/aksharum_erp
```

Then restart PM2 **with `PGBOUNCER=true` in the shell env** (ecosystem.config.js
reads it there, not from `.env`, to size the larger app→pooler pools):

```bash
PGBOUNCER=true pm2 restart ecosystem.config.js --update-env
# or export it once in the systemd unit / shell profile that launches PM2
```

---

## Verify it's working

```bash
# 1) App is healthy through the pooler
curl -s localhost:3010/health

# 2) PgBouncer console — the key screen. cl_active = clients busy,
#    sv_active = real backends in use, cl_waiting should be ~0.
psql -h 127.0.0.1 -p 6432 -U pgb_admin pgbouncer -c "SHOW POOLS;"
psql -h 127.0.0.1 -p 6432 -U pgb_admin pgbouncer -c "SHOW STATS;"

# 3) Confirm the real backend count stays small under load (should hover near
#    default_pool_size, NOT climb with user count):
psql -h 127.0.0.1 -U postgres -c \
  "SELECT count(*) FROM pg_stat_activity WHERE usename='erp_user' AND datname='aksharum_erp';"
```

Success looks like: hundreds of app connections in `SHOW CLIENTS`, but
`pg_stat_activity` for `erp_user` staying around 40–50.

## Tuning under real load

Read `SHOW POOLS` while load-testing:

- **`cl_waiting` consistently > 0** → clients are queuing for a backend.
  Raise `default_pool_size` (e.g. 40 → 60), keeping `default_pool_size + reserve_pool_size`
  under `max_db_connections`, and raise `max_db_connections` toward Postgres'
  limit if needed (bump Postgres `max_connections` first if you go near 90).
- **`maxwait` climbing (seconds)** → same signal; the pool is the bottleneck, not Postgres.
- **backends near `max_db_connections` but Postgres CPU fine** → you can safely
  raise both caps; Postgres has headroom.
- **backends low, latency high** → the bottleneck is elsewhere (slow queries,
  Postgres CPU/IO). PgBouncer won't help; profile the queries.

## Rollback (instant, no code change)

```dotenv
# .env — point back at Postgres directly
DATABASE_URL=postgres://erp_user:password@127.0.0.1:5432/aksharum_erp
```
```bash
pm2 restart ecosystem.config.js --update-env   # (drop PGBOUNCER=true)
```
The app is unchanged — it never knew PgBouncer was there. Stop the pooler with
`sudo systemctl stop pgbouncer` (or `docker compose ... down`) once traffic drains.

## Notes / gotchas

- **First-boot "unsupported startup parameter"** → add the named parameter to
  `ignore_startup_parameters` in `pgbouncer.ini`. `extra_float_digits` is already
  whitelisted (the common node-pg one).
- **`query_wait_timeout` (15s) is deliberately below the app's pg `query_timeout`
  (20s)** so the pooler sheds load before the app's own timeout fires.
- **Schema sync at boot** (`orm.syncAll()` — `CREATE ... IF NOT EXISTS`) is
  idempotent single-statement DDL and runs fine through transaction pooling; no
  special handling needed. Use `DIRECT_DATABASE_URL` only for manual admin/psql.
- **Remote app servers** → don't expose 6432 in the clear. Bind PgBouncer to the
  private interface, or terminate TLS (`client_tls_sslmode`) — never send DB
  traffic across a public network unencrypted.
