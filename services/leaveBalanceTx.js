'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  THE writer for leave balances.
//
//  Every day that enters or leaves a balance goes through this file: filing an
//  application (the hold), approving, rejecting, cancelling, reversing or
//  shortening it, allocating, clearing, accruing, carrying forward, closing a
//  year, settling an exit — and, for comp off, crediting, spending and lapsing
//  the FIFO lots.
//
//  Why one writer:
//   · The ORM's save()/updateOne() read a row and write EVERY column back, so an
//     `$inc` through it is a read-modify-write that loses concurrent updates.
//     Everything here is SQL on one client inside BEGIN/COMMIT, under an
//     advisory lock per (employee, type, year).
//   · Status changes are compare-and-set: the application's status is re-read
//     under the lock, so of two racing decisions exactly one moves the balance.
//   · Every movement writes its ledger row in the same transaction, with the
//     true signed change and the balance it left — so SUM(delta) over the
//     ledger is the balance, and an audit row can never describe a move that
//     did not happen (or miss one that did).
//
//  Follows services/dbTx.js (hostel allocation, library circulation).
// ─────────────────────────────────────────────────────────────────────────────
const { withTransaction, lock, buildInsert, qi } = require('./dbTx');
const { patch, insert } = require('../db/patch');
const { reviveRow } = require('../db/schema');
const LeaveBalance     = require('../models/LeaveBalance');
const LeaveLedger      = require('../models/LeaveLedger');
const LeaveApplication = require('../models/LeaveApplication');
const { remainingOf, rawRemainingOf } = require('../utils/leaveDays');

const T_BAL = () => qi(LeaveBalance.tableName);
const T_APP = () => qi(LeaveApplication.tableName);
const T_LED = () => qi(LeaveLedger.tableName);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** One employee's balance for one type and year is the unit of contention. */
const balanceKey = (schoolId, teacherId, leaveTypeId, academicYear) =>
    `leave:balance:${schoolId}:${teacherId}:${leaveTypeId}:${academicYear}`;
/** Everything one employee files is serialised, so two overlapping applications cannot both pass. */
const teacherKey = (schoolId, teacherId) => `leave:teacher:${schoolId}:${teacherId}`;

const keyArgs = (k) => [String(k.schoolId), String(k.teacherId), String(k.leaveTypeId), String(k.academicYear)];
const WHERE_KEY = `"school" = $1::uuid AND "teacher" = $2::uuid AND "leaveType" = $3::uuid AND "academicYear" = $4`;

const revive = (Model, row) => {
    if (row) reviveRow(Model.schema.parsed(), row);
    return row;
};

/** The balance row, locked for the rest of the transaction. `create` inserts a zero row when there is none. */
async function balanceRow(q, k, { create = false } = {}) {
    const read = async () => (await q(`SELECT * FROM ${T_BAL()} WHERE ${WHERE_KEY} FOR UPDATE`, keyArgs(k))).rows[0] || null;
    let row = await read();
    if (!row && create) {
        const { sql, params } = buildInsert(LeaveBalance, {
            teacher: k.teacherId, school: k.schoolId, leaveType: k.leaveTypeId, academicYear: k.academicYear,
            totalAllocated: 0, carriedForward: 0, carriedOut: 0, used: 0, pending: 0, expired: 0,
        });
        // A concurrent first write for the same key meets the unique index —
        // whoever lost simply reads the row the winner made.
        await q(sql.replace(/ RETURNING \*$/, ' ON CONFLICT DO NOTHING RETURNING *'), params);
        row = await read();
    }
    return revive(LeaveBalance, row);
}

/**
 * Write `set` and `inc` to one balance row (creating it at zero first). `inc`
 * floors each counter at 0 — the movement still applies to a legacy row that
 * is already out of step, it just cannot go below nothing.
 */
async function writeBalance(q, k, { set = {}, inc = {} } = {}) {
    await balanceRow(q, k, { create: true });
    const params = keyArgs(k);
    const sets = [];
    const fields = LeaveBalance.schema.parsed().fields;
    for (const [col, val] of Object.entries(set)) {
        if (val === undefined) continue;
        if (!fields[col]) throw new Error(`leaveBalanceTx: LeaveBalance has no field "${col}"`);
        params.push(val);
        sets.push(`${qi(col)} = $${params.length}`);
    }
    for (const [col, by] of Object.entries(inc)) {
        if (!Number(by)) continue;
        if (!fields[col]) throw new Error(`leaveBalanceTx: LeaveBalance has no field "${col}"`);
        params.push(Number(by));
        sets.push(`${qi(col)} = GREATEST(COALESCE(${qi(col)}, 0) + $${params.length}, 0)`);
    }
    if (!sets.length) return balanceRow(q, k);
    const { rows } = await q(
        `UPDATE ${T_BAL()} SET ${sets.join(', ')}, "updatedAt" = now() WHERE ${WHERE_KEY} RETURNING *`, params);
    return revive(LeaveBalance, rows[0] || null);
}

/** One ledger row, written on the transaction. `balanceAfter` is taken from `balance` when given. */
async function writeLedger(q, k, entry, balance = null) {
    const { sql, params } = buildInsert(LeaveLedger, {
        school: k.schoolId, teacher: k.teacherId, leaveType: k.leaveTypeId, academicYear: k.academicYear,
        source: 'leave', referenceType: 'Manual', referenceId: null,
        ...entry,
        days: round2(Math.abs(Number(entry.days ?? entry.delta) || 0)),
        delta: round2(entry.delta),
        balanceAfter: entry.balanceAfter ?? (balance ? remainingOf(balance) : 0),
    });
    const { rows } = await q(sql, params);
    return revive(LeaveLedger, rows[0]);
}

// ── Comp off lots ────────────────────────────────────────────────────────────
//
// A lot is a ledger row that put spendable comp off days into the account and
// still holds some of them (`remainingDays`): an EARNED credit, a positive
// manual ADJUSTMENT, or a carried-forward lot. Spending walks them oldest
// expiry first, so the days closest to lapsing leave the account first.

const LOT_WHERE = `${WHERE_KEY} AND "entryType" IN ('EARNED', 'ADJUSTMENT') AND COALESCE("delta", 0) > 0`;

/** Spend `days` from the lots. Returns the part no lot could cover (legacy balances seeded outside the ledger). */
async function drainLots(q, k, days) {
    let left = round2(days);
    if (!(left > 0)) return 0;
    const { rows } = await q(
        `SELECT "_id", "remainingDays" FROM ${T_LED()}
          WHERE ${LOT_WHERE} AND COALESCE("remainingDays", 0) > 0
          ORDER BY "expiresAt" ASC NULLS LAST, "createdAt" ASC
          FOR UPDATE`, keyArgs(k));
    for (const lot of rows) {
        if (left <= 0) break;
        const take = Math.min(Number(lot.remainingDays) || 0, left);
        if (take <= 0) continue;
        await q(`UPDATE ${T_LED()} SET "remainingDays" = $2 WHERE "_id" = $1::uuid`,
            [String(lot._id), round2(Number(lot.remainingDays) - take)]);
        left = round2(left - take);
    }
    return left;
}

/**
 * Put `days` back into the lots they came from, latest expiry first. A lot whose
 * validity has ended does not spring back to life — those days stay spent.
 */
async function refillLots(q, k, days) {
    let left = round2(days);
    if (!(left > 0)) return 0;
    const { rows } = await q(
        `SELECT "_id", "days", "remainingDays" FROM ${T_LED()}
          WHERE ${LOT_WHERE} AND COALESCE("remainingDays", 0) < COALESCE("days", 0)
            AND ("expiresAt" IS NULL OR "expiresAt" > now())
          ORDER BY "expiresAt" DESC NULLS FIRST, "createdAt" DESC
          FOR UPDATE`, keyArgs(k));
    for (const lot of rows) {
        if (left <= 0) break;
        const room = round2((Number(lot.days) || 0) - (Number(lot.remainingDays) || 0));
        const give = Math.min(room, left);
        if (give <= 0) continue;
        await q(`UPDATE ${T_LED()} SET "remainingDays" = $2 WHERE "_id" = $1::uuid`,
            [String(lot._id), round2((Number(lot.remainingDays) || 0) + give)]);
        left = round2(left - give);
    }
    return round2(days - left);
}

// ── Application lifecycle ────────────────────────────────────────────────────

/**
 * File an application and hold its paid days, as one unit.
 *
 * The checks that decide whether it may be filed run again here under the
 * employee's lock — the overlap test and the balance — so two submits racing
 * each other cannot both pass on the same days.
 *
 * @param decide  (balanceRow|null) => { ok, paidDays, lopDays, message }
 * @param data    the LeaveApplication fields (lopDays is taken from decide)
 * @returns { ok: true, app } | { ok: false, message, code }
 */
async function fileApplication({ schoolId, teacherId, leaveTypeId, academicYear, from, to, data, decide }) {
    const k = { schoolId, teacherId, leaveTypeId, academicYear };
    return withTransaction(async (q) => {
        await lock(q, teacherKey(schoolId, teacherId));
        await lock(q, balanceKey(schoolId, teacherId, leaveTypeId, academicYear));

        const { rows: clash } = await q(
            `SELECT "_id" FROM ${T_APP()}
              WHERE "teacher" = $1::uuid AND "school" = $2::uuid
                AND "status" IN ('pending', 'approved')
                AND "fromDate" <= $4 AND "toDate" >= $3
              LIMIT 1`,
            [String(teacherId), String(schoolId), from, to]);
        if (clash.length) return { ok: false, code: 'overlap' };

        const bal = await balanceRow(q, k);
        const verdict = decide(bal);
        if (!verdict.ok) return { ok: false, code: 'balance', message: verdict.message };

        const app = await insert(LeaveApplication, { ...data, lopDays: verdict.lopDays || 0 }, { q });
        if (verdict.paidDays > 0) await writeBalance(q, k, { inc: { pending: verdict.paidDays } });
        return { ok: true, app, paidDays: verdict.paidDays, lopDays: verdict.lopDays || 0 };
    });
}

/**
 * Move an application and its balance together.
 *
 * @param expectStatus statuses the application must still be in (re-read under
 *                     the lock — whoever loses a race moves nothing)
 * @param expectFields columns that must still hold these values (e.g. the
 *                     totalDays a shorten was computed from)
 * @param statusPatch  columns to write on the application
 * @param push         JSON-array appends on the application (approvals trail)
 * @param inc          signed balance adjustments, e.g. { used: +2, pending: -2 }
 * @param lots         { drain: n } | { refill: n } — comp off FIFO lots
 * @param ledger       the ledger row explaining the move, or null for a released
 *                     hold (nothing was consumed, so nothing is recorded)
 * @returns { applied, currentStatus?, balance, app, unbacked? }
 */
async function commitTransition({
    schoolId, appId, teacherId, leaveTypeId, academicYear,
    statusPatch = {}, expectStatus = null, expectFields = null, push = null,
    inc = {}, lots = null, ledger = null,
}) {
    const k = { schoolId, teacherId, leaveTypeId, academicYear };
    return withTransaction(async (q) => {
        await lock(q, balanceKey(schoolId, teacherId, leaveTypeId, academicYear));

        const { rows } = await q(
            `SELECT * FROM ${T_APP()} WHERE "_id" = $1::uuid AND "school" = $2::uuid FOR UPDATE`,
            [String(appId), String(schoolId)]);
        const current = revive(LeaveApplication, rows[0] || null);
        if (!current) return { applied: false, currentStatus: null, balance: null };
        if (expectStatus && !expectStatus.includes(current.status)) {
            return { applied: false, currentStatus: current.status, balance: null };
        }
        if (expectFields) {
            for (const [f, v] of Object.entries(expectFields)) {
                // A legacy NULL counter reads as 0, the value it always meant.
                const raw = current[f] == null && typeof v === 'number' ? 0 : current[f];
                const have = raw instanceof Date ? raw.getTime() : raw;
                const want = v instanceof Date ? v.getTime() : v;
                if (String(have) !== String(want)) return { applied: false, currentStatus: current.status, stale: f, balance: null };
            }
        }

        let app = current;
        if (Object.keys(statusPatch).length || push) {
            app = await patch(LeaveApplication, appId, statusPatch, { q, push: push || {} });
        }

        let balance = null;
        if (Object.values(inc).some((v) => Number(v))) balance = await writeBalance(q, k, { inc });
        else balance = await balanceRow(q, k);

        let unbacked = 0;
        if (lots?.drain) unbacked = await drainLots(q, k, lots.drain);
        if (lots?.refill) await refillLots(q, k, lots.refill);

        if (ledger) {
            await writeLedger(q, k, {
                source: 'leave', referenceType: 'LeaveApplication', referenceId: appId, ...ledger,
            }, balance);
        }
        return { applied: true, balance, app, unbacked };
    });
}

// ── Direct balance changes (no application involved) ─────────────────────────

/**
 * Apply a batch of balance changes — allocation, clearing, accrual, carry
 * forward, year close, exit settlement — in ONE transaction, each with its
 * ledger row.
 *
 * Each entry: { schoolId, teacherId, leaveTypeId, academicYear,
 *               compute(row|null) => { set, inc, skip } | null,
 *               create (default true: write even when no row exists yet),
 *               entryType, source, referenceType, referenceId, createdBy,
 *               describe(delta, before, after) | description,
 *               lot: { expiresAt } (comp off: a positive change opens a lot),
 *               drainLots (comp off: a negative change spends the lots) }
 *
 * The ledger's delta is measured, not assumed: the remaining balance after the
 * write minus before it. Re-allocating 12 over 10 is +2, not +12.
 *
 * @returns the entries that changed something, each with { before, after, delta, row }
 */
async function adjustBalances(entries = []) {
    if (!entries.length) return [];
    return withTransaction(async (q) => {
        const done = [];
        for (const e of entries) {
            const k = { schoolId: e.schoolId, teacherId: e.teacherId, leaveTypeId: e.leaveTypeId, academicYear: e.academicYear };
            await lock(q, balanceKey(k.schoolId, k.teacherId, k.leaveTypeId, k.academicYear));
            const row = await balanceRow(q, k);
            if (!row && e.create === false) continue;
            const change = e.compute ? e.compute(row) : { set: e.set, inc: e.inc };
            if (!change || change.skip) continue;

            const before = rawRemainingOf(row);
            const after_ = await writeBalance(q, k, { set: change.set || {}, inc: change.inc || {} });
            const after = rawRemainingOf(after_);
            const delta = round2(after - before);

            if (delta !== 0 || e.alwaysLedger) {
                if (delta < 0 && e.drainLots) await drainLots(q, k, -delta);
                const description = typeof e.describe === 'function' ? e.describe(delta, before, after) : (e.description || '');
                await writeLedger(q, k, {
                    entryType: e.entryType || 'ADJUSTMENT',
                    days: Math.abs(delta), delta,
                    source: e.source || 'manual',
                    referenceType: e.referenceType || 'Manual',
                    referenceId: e.referenceId || null,
                    createdBy: e.createdBy || null,
                    description,
                    ...(delta > 0 && e.lot
                        ? { remainingDays: delta, expiresAt: e.lot.expiresAt || null }
                        : { remainingDays: 0 }),
                }, after_);
            }
            done.push({ ...e, before, after, delta, row: after_ });
        }
        return done;
    });
}

module.exports = {
    balanceKey, teacherKey,
    withTransaction, lock,
    balanceRow, writeBalance, writeLedger, drainLots, refillLots,
    fileApplication, commitTransition, adjustBalances,
};
