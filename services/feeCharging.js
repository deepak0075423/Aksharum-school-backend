'use strict';
/**
 * Putting a structure's charges on the ledger, month by month.
 *
 * Until Sep 2026 "Generate demand" posted each structure as ONE debit of its
 * item amounts added once — so a ₹2,000-a-month tuition head charged ₹2,000
 * for the whole year, and nothing ever posted the following months (the
 * scripts/feeCron.js meant to do it was never scheduled and could not run).
 *
 * Now every head is charged per period of its window (services/feeSchedule):
 * one ledger debit per student, per head, per period, carrying feeItemId +
 * feePeriod so it is posted at most once, and periodStart so screens file it
 * under the month it belongs to. A period is posted when its month arrives:
 * "Generate demand" posts everything due so far, and the hourly sweep in
 * server.js posts each new month for structures generated this way.
 *
 * A student charged under the old lump (a fee_charged row with no feeItemId)
 * is taken to have paid for the first period of every head — that is what the
 * lump was — so nothing is charged twice.
 */
const pool = require('../db/pool');
const FeeLedger = require('../models/FeeLedger');
const FeeStructure = require('../models/FeeStructure');
const FeeHead = require('../models/FeeHead');
const AcademicYear = require('../models/AcademicYear');
const { applyStudentConcessions, appendLedger } = require('./feeConcessions');
const StudentFeeAssignment = require('../models/StudentFeeAssignment');
const User = require('../models/User');
const { withTransaction, buildInsert } = require('./dbTx');
const S = require('./feeSchedule');

const T = (M) => `"${M.tableName}"`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Many ledger rows in one INSERT. buildInsert gives each row exactly what
 * Model.create would write; every row here carries the same fields, so they
 * share one column list and only the parameter numbers move.
 */
function multiInsert(rows) {
    const built = rows.map(r => buildInsert(FeeLedger, r));
    const head = built[0].sql.slice(0, built[0].sql.indexOf(' VALUES ('));
    const params = [];
    const tuples = built.map(b => {
        const vals = b.sql.slice(b.sql.indexOf(' VALUES (') + 9, b.sql.lastIndexOf(') RETURNING'));
        const offset = params.length;
        params.push(...b.params);
        return `(${vals.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`)})`;
    });
    return { sql: `${head} VALUES ${tuples.join(', ')}`, params };
}

/**
 * Where an item saved before windows existed starts: the month its structure
 * first charged (the old lump), else its demand start, else its effective date.
 */
async function legacyStart(structure) {
    if (structure.demandStartedAt) return S.monthKey(structure.demandStartedAt);
    const { rows } = await pool.query(
        `SELECT MIN("createdAt") AS at FROM ${T(FeeLedger)}
          WHERE "referenceType" = 'FeeStructure' AND "referenceId" = $1 AND "category" = 'fee_charged' AND "feeItemId" IS NULL`,
        [String(structure._id)]);
    if (rows[0]?.at) return S.monthKey(rows[0].at);
    return structure.effectiveFrom ? S.monthKey(structure.effectiveFrom) : null;
}

/**
 * The periods of one structure, head by head, with what each head is called
 * and how often it charges. `upTo` (a Date) keeps only periods whose month
 * has begun.
 */
async function structurePeriods(structure, { year = null, upTo = null } = {}) {
    const y = year || await AcademicYear.findById(structure.academicYear).lean();
    if (!y) return { year: null, items: [] };
    const bounds = S.yearBounds(y);
    const fallback = await legacyStart(structure);
    const headIds = [...new Set((structure.items || []).map(i => String(i.feeHead?._id || i.feeHead)))];
    const heads = await FeeHead.find({ _id: { $in: headIds } }).select('name type isActive isArchived skippedMonths').lean();
    const headBy = new Map(heads.map(h => [String(h._id), h]));
    const cutoff = upTo ? S.monthKey(upTo) : null;
    // Months the structure was switched off for are not charged, and neither
    // are months a switched-off head would have charged in.
    const skipped = new Set(structure.skippedMonths || []);
    // A head that is switched off charges nothing, anywhere, until it is
    // switched back on — the same meaning "off" has for a structure. A head
    // that was off for a while carries its own gap, which is never billed.
    const items = (structure.items || []).filter(i => {
        if (i.isActive === false) return false;
        const h = headBy.get(String(i.feeHead?._id || i.feeHead));
        return !h || (h.isActive !== false && !h.isArchived);
    }).map(i => {
        const head = headBy.get(String(i.feeHead?._id || i.feeHead)) || { name: 'Fee', type: 'recurring' };
        const headGap = new Set(head.skippedMonths || []);
        const periods = S.periodsFor(i, head.type, bounds, fallback)
            .filter(p => (!cutoff || p.month <= cutoff) && !skipped.has(p.month) && !headGap.has(p.month));
        return { item: i, head, periods, window: S.windowFor(i, head.type, bounds, fallback) };
    });
    return { year: y, bounds, fallback, items };
}

/**
 * Post every period of `structure` that is due by `upTo` and not yet on the
 * ledger, for each of `studentIds`, then bring their concessions up to date.
 * Returns { students, entries, amount }.
 */
async function postDueCharges({ schoolId, structure, studentIds, userId = null, upTo = new Date() }) {
    const ids = [...new Set((studentIds || []).map(String))];
    if (!ids.length) return { students: 0, entries: 0, amount: 0, concession: 0 };
    const { year, items } = await structurePeriods(structure, { upTo });
    if (!year || !items.length) return { students: 0, entries: 0, amount: 0, concession: 0 };

    // Where each student joined this structure (a mid-year admission, or a
    // move): months before that are not theirs to pay.
    const assignments = await StudentFeeAssignment.find({
        school: schoolId, academicYear: structure.academicYear, student: { $in: ids }, feeStructure: structure._id,
    }).select('student fromMonth').lean();
    const joinedAt = new Map(assignments.map(a => [String(a.student), a.fromMonth || null]));

    const [done, last] = await Promise.all([
        pool.query(
            `SELECT "student", "feeItemId", "feePeriod" FROM ${T(FeeLedger)}
              WHERE "school" = $1 AND "referenceType" = 'FeeStructure' AND "referenceId" = $2
                AND "category" = 'fee_charged' AND "entryType" = 'debit' AND "student" = ANY($3::uuid[])`,
            [String(schoolId), String(structure._id), ids]),
        pool.query(
            `SELECT DISTINCT ON ("student") "student", "runningBalance" FROM ${T(FeeLedger)}
              WHERE "school" = $1 AND "academicYear" = $2 AND "student" = ANY($3::uuid[])
              ORDER BY "student", "createdAt" DESC`,
            [String(schoolId), String(year._id), ids]),
    ]);
    const charged = new Set();
    const lump = new Set();
    for (const r of done.rows) {
        if (r.feeItemId) charged.add(`${r.student}:${r.feeItemId}:${Number(r.feePeriod)}`);
        else lump.add(String(r.student));
    }
    const running = new Map(last.rows.map(r => [String(r.student), Number(r.runningBalance) || 0]));

    // Oldest month first, so a student's running balance climbs in order.
    const periods = items.flatMap(({ item, head, periods: ps }) => ps.map(p => ({ item, head, p })))
        .sort((a, b) => a.p.month.localeCompare(b.p.month) || String(a.head.name).localeCompare(String(b.head.name)));

    const rows = [];
    const touched = new Set();
    let stamp = Date.now();
    for (const sid of ids) {
        let bal = running.get(sid) || 0;
        const from = joinedAt.get(sid) || null;
        for (const { item, head, p } of periods) {
            if (p.period === 0 && lump.has(sid)) continue;
            if (from && p.month < from) continue;
            if (charged.has(`${sid}:${item._id}:${p.period}`)) continue;
            const amount = r2(item.amount);
            if (!(amount > 0)) continue;
            bal = r2(bal + amount);
            rows.push({
                school: schoolId, student: sid, academicYear: year._id,
                entryType: 'debit', category: 'fee_charged', amount,
                description: `${head.name} — ${p.label}`,
                referenceType: 'FeeStructure', referenceId: structure._id,
                feeItemId: item._id, feePeriod: p.period, periodLabel: p.label, periodStart: p.start,
                feeHeadName: head.name || '', runningBalance: bal, createdBy: userId,
                // Distinct instants keep "latest row = current balance" true.
                createdAt: new Date(stamp++),
            });
            touched.add(sid);
        }
    }
    // All of a demand or none of it.
    if (rows.length) {
        await withTransaction(async (q) => {
            for (let i = 0; i < rows.length; i += 400) {
                const { sql, params } = multiInsert(rows.slice(i, i + 400));
                await q(sql, params);
            }
        });
    }
    let concession = 0;
    for (const sid of touched) {
        concession += await applyStudentConcessions({ schoolId, studentId: sid, academicYearId: year._id, userId });
    }
    return { students: touched.size, entries: rows.length, amount: r2(rows.reduce((s, r) => s + r.amount, 0)), concession: r2(concession) };
}

async function structureRoll(schoolId, structure) {
    const { rows } = await pool.query(
        `SELECT a."student" FROM ${T(StudentFeeAssignment)} a
           JOIN ${T(User)} u ON u."_id" = a."student"
          WHERE a."school" = $1 AND a."feeStructure" = $2 AND a."isActive" IS NOT FALSE
            AND u."role" = 'student' AND u."isActive" IS NOT FALSE`,
        [String(schoolId), String(structure._id)]);
    return rows.map(r => String(r.student));
}

/**
 * The monthly sweep for one school: every structure charging month by month
 * posts whatever has fallen due since, for the students who are on it now —
 * so a student who has left, or been moved to another structure, stops being
 * charged, and a structure that is switched off charges nothing at all.
 */
async function runChargingSweep(schoolId) {
    const structures = await FeeStructure.find({ school: schoolId, isActive: true, periodicSince: { $ne: null } }).lean();
    let entries = 0;
    for (const st of structures) {
        const students = await structureRoll(schoolId, st);
        if (!students.length) continue;
        const r = await postDueCharges({ schoolId, structure: st, studentIds: students });
        entries += r.entries;
    }
    return entries;
}

/** Schools with at least one structure charging month by month. */
async function schoolsToCharge() {
    const { rows } = await pool.query(`SELECT DISTINCT "school" FROM ${T(FeeStructure)} WHERE "periodicSince" IS NOT NULL AND "isActive" IS NOT FALSE`);
    return rows.map(r => r.school);
}

module.exports = { structurePeriods, postDueCharges, runChargingSweep, schoolsToCharge, legacyStart, structureRoll };

/**
 * What switching a structure off would touch: how many students it charges,
 * what it has charged them, and how much of that is still unpaid.
 * (`unpaid` is close enough for a warning — the cancellation below works it
 * out month by month.)
 */
async function structureImpact(schoolId, structure) {
    const { rows } = await pool.query(
        `WITH l AS (
            SELECT * FROM ${T(FeeLedger)} WHERE "school" = $1 AND "academicYear" = $2
         ), agg AS (
            SELECT "student",
                   SUM(CASE WHEN "entryType" = 'debit'  AND "category" = 'fee_charged' AND "referenceType" = 'FeeStructure' AND "referenceId" = $3 THEN "amount"
                            WHEN "entryType" = 'credit' AND "category" = 'adjustment'  AND "referenceType" = 'FeeStructure' AND "referenceId" = $3 THEN -"amount" ELSE 0 END) AS "net_this",
                   SUM(CASE WHEN "entryType" = 'debit'  AND "category" = 'fee_charged' AND "referenceType" = 'FeeStructure' THEN "amount"
                            WHEN "entryType" = 'credit' AND "category" = 'adjustment'  AND "referenceType" = 'FeeStructure' THEN -"amount" ELSE 0 END) AS "net_all",
                   SUM(CASE WHEN "entryType" = 'debit'  AND "category" = 'fee_charged' AND "referenceType" = 'FeeStructure' THEN "amount" ELSE 0 END) AS "struct_debits",
                   SUM(CASE WHEN "entryType" = 'credit' AND NOT ("category" = 'adjustment' AND "referenceType" = 'FeeStructure') THEN "amount" ELSE 0 END) AS "credits",
                   SUM(CASE WHEN "entryType" = 'debit' THEN "amount" ELSE 0 END) AS "debits"
              FROM l GROUP BY "student"
         )
         SELECT COUNT(*) FILTER (WHERE "net_this" > 0.004) AS "students",
                COALESCE(SUM(GREATEST("net_this", 0)), 0) AS "charged",
                COALESCE(SUM(LEAST(GREATEST("net_this", 0),
                    GREATEST(0, "net_all" - GREATEST(0, "credits" - ("debits" - "struct_debits"))))), 0) AS "unpaid"
           FROM agg`,
        [String(schoolId), String(structure.academicYear), String(structure._id)]);
    const roll = await structureRoll(schoolId, structure);
    const { items } = await structurePeriods(structure);
    const now = S.monthKey(new Date());
    const toCome = items.reduce((sum, { item, periods }) => sum + periods.filter(p => p.month > now).length * (Number(item.amount) || 0), 0);
    return {
        onRoll: roll.length,
        students: Number(rows[0]?.students) || 0,
        charged: r2(rows[0]?.charged),
        unpaid: r2(rows[0]?.unpaid),
        toCome: r2(toCome * roll.length),
        monthsToCome: items.reduce((n, { periods }) => Math.max(n, periods.filter(p => p.month > now).length), 0),
    };
}

/**
 * Drop this structure's unpaid charges: for every student it charged, each
 * head-period that is not settled gets a credit naming the same head and
 * period, so the fee book shows it cancelled rather than paid and nobody is
 * asked for it again. Returns what was cancelled.
 *
 * Money already handed over is never cancelled, and neither is a month a
 * family has paid for but the office has not approved yet — that payment is
 * about to land on it.
 */
async function cancelUnpaidCharges({ schoolId, structure, userId = null }) {
    const { buildSchedule } = require('./feeBook');
    const year = await AcademicYear.findById(structure.academicYear).lean();
    if (!year) return { students: 0, amount: 0 };
    const { rows } = await pool.query(
        `SELECT DISTINCT "student" FROM ${T(FeeLedger)}
          WHERE "school" = $1 AND "referenceType" = 'FeeStructure' AND "referenceId" = $2 AND "category" = 'fee_charged'`,
        [String(schoolId), String(structure._id)]);
    const assignments = await StudentFeeAssignment.find({ school: schoolId, academicYear: year._id, feeStructure: structure._id }).select('student fromMonth').lean();
    const joinedAt = new Map(assignments.map(a => [String(a.student), a.fromMonth || null]));
    const FeePayment = require('../models/FeePayment');
    const pendingRows = rows.length ? (await pool.query(
        `SELECT "student", SUM("amount") AS amt FROM ${T(FeePayment)}
          WHERE "school" = $1 AND "academicYear" = $2 AND "paymentStatus" = 'pending'
            AND "student" = ANY($3::uuid[]) GROUP BY 1`,
        [String(schoolId), String(year._id), rows.map(r => String(r.student))])).rows : [];
    const pendingBy = new Map(pendingRows.map(r => [String(r.student), Number(r.amt) || 0]));

    let students = 0, amount = 0;
    for (const { student } of rows) {
        const ledger = await FeeLedger.find({ school: schoolId, student, academicYear: year._id }).lean();
        const book = await buildSchedule({
            year, ledger, primaryStructureId: structure._id,
            fromMonth: joinedAt.get(String(student)) || null,
            pendingTotal: pendingBy.get(String(student)) || 0,
        });
        let posted = 0;
        for (const m of book.months) {
            if (m.payable <= 0.004 || m.totalAmount <= 0.004) continue;
            const share = m.payable / m.totalAmount;   // unpaid, and not already answered for
            for (const it of m.items) {
                if (!it.isGenerated || it.cancelled || it.lump) continue;
                if (String(it.structureId) !== String(structure._id)) continue;
                const cancel = r2(it.amount * share);
                if (cancel <= 0.004) continue;
                await appendLedger({
                    school: schoolId, student, academicYear: year._id,
                    entryType: 'credit', category: 'adjustment', amount: cancel,
                    description: `Charge cancelled — ${it.name} ${it.label || m.monthLabel}`,
                    referenceType: 'FeeStructure', referenceId: structure._id,
                    feeItemId: it.feeItemId, feePeriod: it.period, periodLabel: it.label || m.monthLabel,
                    createdBy: userId,
                });
                posted += cancel;
            }
        }
        if (posted > 0) { students++; amount += posted; }
    }
    return { students, amount: r2(amount) };
}

/** Charge whatever is due right now for the students on a structure. */
async function chargeStructureNow({ schoolId, structure, userId = null }) {
    const students = await structureRoll(schoolId, structure);
    if (!students.length) return { students: 0, entries: 0, amount: 0, concession: 0 };
    return postDueCharges({ schoolId, structure, studentIds: students, userId });
}

module.exports.structureImpact = structureImpact;
module.exports.cancelUnpaidCharges = cancelUnpaidCharges;
module.exports.chargeStructureNow = chargeStructureNow;
