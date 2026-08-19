'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Transaction helpers for the hostel module.
//
//  The ORM issues every statement as a standalone pool.query(), which is exactly
//  what PgBouncer transaction pooling wants — but bed allocation has to move
//  three tables or none. Following the note in db/pool.js (and the pattern
//  already used by services/timetable/persistence.js), the multi-statement work
//  is checked out on ONE client and wrapped in BEGIN/COMMIT.
//
//  buildInsert() exists so a row written inside such a transaction is identical
//  to one written by Model.create(): the same schema defaults, the same column
//  casting, the same generated _id.
// ─────────────────────────────────────────────────────────────────────────────
const pool = require('../db/pool');
const { qi } = require('../db/filter');
const { applyDefaults, toColumnValue, newId } = require('../db/schema');

/**
 * Run `fn(q)` inside a transaction. `q(sql, params)` is the client's query.
 * Commits on success, rolls back and rethrows on failure.
 */
async function withTransaction(fn) {
    const client = await pool.getPool().connect();
    const q = (sql, params) => client.query(sql, params);
    try {
        await q('BEGIN');
        const out = await fn(q);
        await q('COMMIT');
        return out;
    } catch (e) {
        try { await q('ROLLBACK'); } catch { /* connection already broken */ }
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Serialise concurrent work on one key for the life of the transaction.
 * Released automatically on COMMIT/ROLLBACK — no unlock call to forget.
 */
const lock = (q, key) => q('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [String(key)]);

/**
 * INSERT statement for `data` against `Model`, with schema defaults applied.
 * @returns {{sql: string, params: any[], id: string}}
 */
function buildInsert(Model, data) {
    const parsed = Model.schema.parsed();
    const doc = { ...data };
    applyDefaults(parsed, doc);
    if (parsed.fields.createdAt?._ts && doc.createdAt == null) doc.createdAt = new Date();
    if (parsed.fields.updatedAt?._ts) doc.updatedAt = new Date();
    const id = doc._id || newId();

    const cols = ['"_id"'];
    const vals = ['$1::uuid'];
    const params = [String(id)];
    for (const [fname, meta] of Object.entries(parsed.fields)) {
        if (doc[fname] === undefined) continue;
        const v = toColumnValue(meta, doc[fname]);
        cols.push(qi(fname));
        if (meta.kind === 'json' || meta.kind === 'mixed') {
            params.push(v == null ? null : JSON.stringify(v));
            vals.push(`$${params.length}::jsonb`);
        } else {
            params.push(v);
            vals.push(`$${params.length}`);
        }
    }
    const sql = `INSERT INTO ${qi(Model.tableName)} (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING *`;
    return { sql, params, id: String(id) };
}

/** Insert `data` on the transaction's client and return the stored row. */
async function insertRow(q, Model, data) {
    const { sql, params } = buildInsert(Model, data);
    const { rows } = await q(sql, params);
    return rows[0];
}

module.exports = { withTransaction, lock, buildInsert, insertRow, qi };
