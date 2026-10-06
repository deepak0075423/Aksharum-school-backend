'use strict';
/**
 * A school code is unique across the whole platform (Oct 2026) — "APS",
 * "aps" and " APS " are one code. Checked before a school is created or its
 * code changed (super-admin school form, a school admin's own settings); the
 * index in db/migrate.js holds the line if two saves race.
 */
const pool = require('../db/pool');

/** The school already using `code` (other than `exceptId`), or null. */
async function schoolWithCode(code, exceptId = null) {
    const c = String(code ?? '').trim();
    if (!c) return null;
    const { rows: [hit] } = await pool.query(
        `SELECT "_id", "name" FROM "schools"
          WHERE lower(btrim("code")) = lower($1) AND ($2::uuid IS NULL OR "_id" <> $2::uuid)
          LIMIT 1`,
        [c, exceptId ? String(exceptId) : null],
    );
    return hit || null;
}

/** True for the error Postgres raises when the unique index on codes is hit. */
const isCodeClash = (e) => (e?.code === 11000 || e?.code === '23505') && /code/i.test(`${e?.constraint || ''} ${JSON.stringify(e?.keyPattern || {})}`);

module.exports = { schoolWithCode, isCodeClash };
