'use strict';
/**
 * Document numbers: one format, handed out once.
 *
 * Three formats used to coexist in the same collections — `PR-2609-0001` from
 * the teacher portal, `REQ-2026-018` from the admin screens, `ISS-…` from a
 * real issue while the screens all said `IR-…`. They are one format now:
 *
 *     REQ-2026-001   a purchase request
 *     PO-2026-001    a purchase order
 *     IR-2026-001    an issue
 *
 * and the counter behind them is a row incremented in the database, not a
 * count of the rows that happen to exist.
 */
const { query } = require('../db/pool');
const { newId } = require('../db/schema');

const PREFIX = { request: 'REQ', order: 'PO', issue: 'IR', item: 'ITM', asset: 'AST' };

/**
 * The next number for `kind`, reset each calendar year.
 *
 * `UPDATE … RETURNING` is atomic, so two callers at the same instant get two
 * different numbers. The row is created on first use.
 */
async function next(school, kind) {
    const prefix = PREFIX[kind];
    if (!prefix) throw new Error(`Unknown document kind "${kind}"`);
    const period = String(new Date().getFullYear());

    const { rows } = await query(
        `INSERT INTO "inventorycounters" ("_id","school","kind","period","value","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,1, now(), now())
         ON CONFLICT ("school","kind","period") DO UPDATE
             SET "value" = "inventorycounters"."value" + 1, "updatedAt" = now()
         RETURNING "value"`,
        [newId(), school, kind, period],
    );
    const n = rows[0]?.value || 1;
    return `${prefix}-${period}-${String(n).padStart(3, '0')}`;
}

/**
 * Bring the counter up to whatever is already in the table.
 *
 * A school seeded or migrated with documents already numbered would otherwise
 * start again at 001 and collide. Called once, lazily, per kind per year.
 */
async function syncFrom(school, kind, table, column) {
    const period = String(new Date().getFullYear());
    const prefix = PREFIX[kind];
    const { rows } = await query(
        `SELECT COALESCE(MAX(NULLIF(regexp_replace(${column}, '^.*-', ''), '')::int), 0) AS high
           FROM ${table} WHERE "school" = $1 AND ${column} LIKE $2`,
        [school, `${prefix}-${period}-%`],
    );
    const high = Number(rows[0]?.high) || 0;
    if (!high) return;
    await query(
        `INSERT INTO "inventorycounters" ("_id","school","kind","period","value","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5, now(), now())
         ON CONFLICT ("school","kind","period") DO UPDATE
             SET "value" = GREATEST("inventorycounters"."value", $5), "updatedAt" = now()`,
        [newId(), school, kind, period, high],
    );
}

const TABLES = {
    request: ['"purchaserequests"', '"requestNumber"'],
    order: ['"purchaseorders"', '"poNumber"'],
    issue: ['"inventoryissues"', '"issueNumber"'],
    item: ['"inventoryitems"', '"itemCode"'],
    asset: ['"inventoryassets"', '"assetCode"'],
};
const synced = new Set();

/** `next`, having first caught the counter up to any existing documents. */
async function nextNumber(school, kind) {
    const key = `${school}:${kind}:${new Date().getFullYear()}`;
    if (!synced.has(key)) {
        synced.add(key);
        const [table, column] = TABLES[kind] || [];
        if (table) await syncFrom(school, kind, table, column).catch(() => { /* first run on an empty table */ });
    }
    return next(school, kind);
}

module.exports = { nextNumber, next, syncFrom };
