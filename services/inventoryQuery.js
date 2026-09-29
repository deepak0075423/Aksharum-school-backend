'use strict';
/**
 * The inventory boards, in SQL.
 *
 * Every board used to read its whole table into Node — every item, every stock
 * row, every issue and every return the school had ever recorded — decorate it,
 * then filter, sort and page the array. It gave the right answer and the shape
 * the screens want, and it is fine for a school with two hundred items. It is
 * not fine for one with twenty thousand issues: the work grows with everything
 * the school has ever done rather than with the ten rows on the page, and the
 * whole lot is resident in one process while it happens.
 *
 * The tables that grow without bound — issues, purchase orders, requests, the
 * stock ledger, the audit log — now filter, sort, count and page in the
 * database. The four master boards (vendors, categories, stores, budgets) are
 * bounded by how many of those a school defines, which is dozens; rewriting
 * them would add risk and save nothing, so they were left alone.
 *
 * Everything here returns the same shape the boards already returned, so the
 * screens did not change.
 */
const pool = require('../db/pool');

/** `"tablename"`, quoted, from a model. */
const T = (Model) => `"${Model.tableName}"`;

/** Positional parameters, accumulated as the SQL is built. */
function params() {
    const list = [];
    const $ = (v) => { list.push(v); return `$${list.length}`; };
    return { list, $ };
}

const num = (v) => (Number.isFinite(+v) ? +v : 0);

/** ILIKE pattern for a user's search box, with the wildcards escaped. */
function like(p, search) {
    const clean = String(search || '').trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    return p.$(`%${clean}%`);
}

/**
 * One page of a base query, plus the number of rows that matched.
 *
 * `count(*) OVER ()` rides along on the page rather than costing a second
 * scan, which is what a separate COUNT query would be.
 */
async function page(baseSql, p, { sort, dir = 'asc', page: pg = 1, limit = 10, sorts = {}, fallback }) {
    const order = sorts[sort] || sorts[fallback] || Object.values(sorts)[0] || '1';
    const way = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const lim = Math.max(1, Math.min(500, num(limit) || 10));
    const at = Math.max(1, num(pg) || 1);
    const rowParams = [...p.list, lim, (at - 1) * lim];
    const sql = `${baseSql}
         ORDER BY ${order} ${way} NULLS LAST
         LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`;
    const { rows } = await pool.query(sql, rowParams);
    const matched = rows[0]?.__matched ?? 0;
    return {
        rows: rows.map(({ __matched, ...r }) => r),
        total: matched, matched,
        page: at, pages: Math.max(1, Math.ceil(matched / lim)), limit: lim,
    };
}

/**
 * Per-item stock, as a CTE.
 *
 * On hand, reserved, value at weighted-average cost, how many stores hold any,
 * and — when exactly one does — which one, because an item's location is where
 * its stock actually sits and only the single-store case has an answer.
 */
const STOCK_CTE = (t) => `
    stk AS (
        SELECT s."item",
               COALESCE(SUM(s."quantity"), 0)::numeric                                    AS "qty",
               COALESCE(SUM(COALESCE(s."reserved", 0)), 0)::numeric                        AS "reserved",
               COALESCE(SUM(s."quantity" * COALESCE(s."avgCost", 0)), 0)::numeric          AS "value",
               COUNT(*) FILTER (WHERE s."quantity" > 0)::int                               AS "places",
               MAX(s."updatedAt")                                                          AS "stockAt",
               (array_agg(s."warehouse" ORDER BY s."quantity" DESC)
                  FILTER (WHERE s."quantity" > 0))[1]                                      AS "onlyWarehouse"
          FROM ${t} s
         WHERE s."school" = $1
         GROUP BY s."item"
    )`;

/** Item ids with at least one asset away for repair, as a CTE. */
const REPAIR_CTE = (t) => `
    fix AS (
        SELECT DISTINCT a."item" AS "item"
          FROM ${t} a
         WHERE a."school" = $1 AND a."status" = 'under_repair' AND a."item" IS NOT NULL
    )`;

/**
 * Which of the five buckets an item sits in, as SQL.
 *
 * The order matters and matches `itemState` in the controller: a repair beats
 * everything, an item no store has ever held is "not tracked" rather than "out
 * of stock", and a reorder level of zero means the school is not watching it.
 */
const STATE_SQL = `
    CASE
        WHEN fix."item" IS NOT NULL                                         THEN 'under_repair'
        WHEN stk."item" IS NULL OR COALESCE(stk."places", 0) = 0            THEN 'not_tracked'
        WHEN COALESCE(stk."qty", 0) <= 0                                    THEN 'out_of_stock'
        WHEN COALESCE(i."reorderLevel", 0) > 0
             AND COALESCE(stk."qty", 0) <= i."reorderLevel"                 THEN 'low_stock'
        ELSE 'in_stock'
    END`;

/**
 * Six monthly buckets of a count, in the same shape `monthlySeries` returns.
 *
 * `sql` must produce one row per thing being counted with a `at` timestamp
 * column; the months come from generate_series so an empty month is a zero
 * rather than a missing bucket.
 */
async function monthly(innerSql, list, { months = 6 } = {}) {
    const sql = `
        WITH src AS (${innerSql}),
             mon AS (
                 SELECT generate_series(
                     date_trunc('month', now()) - INTERVAL '${months - 1} months',
                     date_trunc('month', now()),
                     INTERVAL '1 month') AS "m"
             )
        SELECT mon."m",
               count(src."at") FILTER (
                   WHERE src."at" >= mon."m" AND src."at" < mon."m" + INTERVAL '1 month')::int AS "value"
          FROM mon LEFT JOIN src ON true
         GROUP BY mon."m" ORDER BY mon."m"`;
    const { rows } = await pool.query(sql, list);
    return rows.map(r => r.value);
}

/** ISO date → the start of that day, for "overdue" comparisons done in SQL. */
const TODAY = `date_trunc('day', now())`;

/**
 * A CASE expression from a {value: label} map, so a classification that lives
 * in a JS object can be applied inside a query without shipping the table to
 * Node to do it. Keys and fallback are inlined, so pass only literals you
 * control — these come from constants in the controller, never from a request.
 */
function caseOf(expr, map, fallback) {
    const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
    const whens = Object.entries(map).map(([k, v]) => `WHEN ${expr} = ${lit(k)} THEN ${lit(v)}`).join('\n             ');
    return `CASE ${whens} ELSE ${lit(fallback)} END`;
}

/**
 * An ordered list of [test, label] turned into a CASE, for a classification
 * written as a chain of ifs. `test` is SQL, with `%s` standing for the column.
 */
function chainOf(expr, chain, fallback) {
    const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
    const whens = chain.map(([test, label]) =>
        `WHEN ${test.split('%s').join(expr)} THEN ${lit(label)}`).join('\n             ');
    return `CASE ${whens} ELSE ${lit(fallback)} END`;
}

module.exports = { T, params, like, page, monthly, num, caseOf, chainOf,
    STOCK_CTE, REPAIR_CTE, STATE_SQL, TODAY, pool };
