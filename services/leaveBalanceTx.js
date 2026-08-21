'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Atomic balance movement for the leave module.
//
//  Every status change used to write the application, then move the balance in
//  a separate statement. A crash between the two left leave approved but never
//  deducted. Each movement here is one transaction over one advisory lock, so
//  it either lands completely or not at all — and two concurrent approvals of
//  the same employee serialise instead of interleaving.
//
//  Each movement also writes the LeaveLedger row that explains it. The ledger
//  was previously only written by comp off, which left ordinary leave with a
//  balance number and no record of how it got there.
//
//  Follows the pattern established by services/hostelAllocation.js and
//  services/libraryRules.js — see services/dbTx.js.
// ─────────────────────────────────────────────────────────────────────────────
const { withTransaction, lock, buildInsert, qi } = require('./dbTx');
const LeaveBalance     = require('../models/LeaveBalance');
const LeaveLedger      = require('../models/LeaveLedger');
const LeaveApplication = require('../models/LeaveApplication');
const { remainingOf }  = require('../utils/leaveDays');

const T_BAL = () => qi(LeaveBalance.tableName);
const T_APP = () => qi(LeaveApplication.tableName);

/** One employee's balance for one type and year is the unit of contention. */
const balanceKey = (schoolId, teacherId, leaveTypeId, academicYear) =>
    `leave:balance:${schoolId}:${teacherId}:${leaveTypeId}:${academicYear}`;

/**
 * Apply a signed adjustment to a balance row, inside an open transaction.
 * Returns the updated row, or null when no row matched.
 */
async function bumpBalance(q, { schoolId, teacherId, leaveTypeId, academicYear, inc }) {
    const sets = [];
    const params = [String(schoolId), String(teacherId), String(leaveTypeId), String(academicYear)];
    for (const [col, by] of Object.entries(inc)) {
        params.push(by);
        // GREATEST keeps a counter from going negative when a legacy row is
        // already out of step — the movement still applies, it just floors.
        sets.push(`${qi(col)} = GREATEST(COALESCE(${qi(col)}, 0) + $${params.length}, 0)`);
    }
    const { rows } = await q(
        `UPDATE ${T_BAL()} SET ${sets.join(', ')}, "updatedAt" = now()
          WHERE "school" = $1::uuid AND "teacher" = $2::uuid
            AND "leaveType" = $3::uuid AND "academicYear" = $4
      RETURNING *`,
        params,
    );
    return rows[0] || null;
}

/**
 * Move an application to a new status and adjust the balance as one unit.
 *
 * @param statusPatch  columns to set on the application row
 * @param expectStatus array of statuses the application must still be in for the
 *                     move to apply. This is the compare-and-swap that makes the
 *                     whole thing safe: callers read the application before the
 *                     lock is taken, so two concurrent approvals both saw
 *                     'pending' and both deducted. The status is re-checked here
 *                     inside the transaction, and a caller that lost the race
 *                     gets { applied: false } and moves nothing.
 * @param inc          signed balance adjustments, e.g. { used: +2, pending: -2 }
 * @param ledger       optional { entryType, days, delta, description, source,
 *                     referenceType, referenceId, createdBy } — omitted when the
 *                     movement only releases a hold, since nothing was consumed
 *                     and a SUM(delta) over the ledger must stay meaningful.
 */
async function commitTransition({
    schoolId, appId, teacherId, leaveTypeId, academicYear,
    statusPatch = {}, expectStatus = null, inc = {}, ledger = null,
}) {
    return withTransaction(async (q) => {
        await lock(q, balanceKey(schoolId, teacherId, leaveTypeId, academicYear));

        // Re-check the status under the lock. Whoever gets here second finds the
        // application already moved and does nothing.
        if (expectStatus) {
            const { rows } = await q(
                `SELECT "status" FROM ${T_APP()} WHERE "_id" = $1::uuid AND "school" = $2::uuid`,
                [String(appId), String(schoolId)],
            );
            if (!rows.length || !expectStatus.includes(rows[0].status)) {
                return { applied: false, currentStatus: rows[0]?.status ?? null, balance: null };
            }
        }

        if (Object.keys(statusPatch).length) {
            const cols = [];
            const params = [String(appId), String(schoolId)];
            for (const [col, val] of Object.entries(statusPatch)) {
                params.push(val);
                cols.push(`${qi(col)} = $${params.length}`);
            }
            await q(
                `UPDATE ${T_APP()} SET ${cols.join(', ')}, "updatedAt" = now()
                  WHERE "_id" = $1::uuid AND "school" = $2::uuid`,
                params,
            );
        }

        let balance = null;
        if (Object.keys(inc).length) {
            balance = await bumpBalance(q, { schoolId, teacherId, leaveTypeId, academicYear, inc });
        }

        if (ledger) {
            const { sql, params } = buildInsert(LeaveLedger, {
                school: schoolId, teacher: teacherId, leaveType: leaveTypeId, academicYear,
                balanceAfter: balance ? remainingOf(balance) : 0,
                source: 'leave', referenceType: 'LeaveApplication', referenceId: appId,
                ...ledger,
            });
            await q(sql, params);
        }

        return { applied: true, balance };
    });
}

/**
 * Record a balance change an admin made directly — allocation, clearing, carry
 * forward, year-end lapse. No application is involved, so this only writes the
 * ledger; the caller owns the balance write.
 *
 * Best-effort on purpose: an audit row must never be the reason a bulk
 * allocation over hundreds of employees fails.
 */
async function recordAdjustments(entries = []) {
    if (!entries.length) return 0;
    try {
        return await withTransaction(async (q) => {
            for (const e of entries) {
                const { sql, params } = buildInsert(LeaveLedger, {
                    source: 'manual', referenceType: 'Manual', referenceId: null, ...e,
                });
                await q(sql, params);
            }
            return entries.length;
        });
    } catch (err) {
        console.error('[leave] ledger write failed:', err.message);
        return 0;
    }
}

module.exports = { commitTransition, recordAdjustments, balanceKey };
