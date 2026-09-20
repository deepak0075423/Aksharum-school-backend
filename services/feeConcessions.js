'use strict';
/**
 * How a concession reaches what a student owes.
 *
 * Until Sep 2026 assigning a concession only wrote a StudentConcession row. The
 * fee book printed a "total concession" beside the dues, but the dues are read
 * off the ledger, and nothing ever posted the concession to the ledger — so a
 * student given 50% off still owed the whole fee. The Concessions screen says
 * "concessions are applied at the time of fee generation", and this is where
 * that now happens:
 *
 *   • after a demand is generated, every charged student's active concessions
 *     are applied (fees.controller.generateFeeDemand);
 *   • when a concession is assigned to a student who has already been charged,
 *     it is applied at once (assignStudentConcession);
 *   • when one is taken away, what it credited is reversed (removeStudentConcession).
 *
 * Applying is a TOP-UP, never a blind post: the credit a concession is owed is
 * worked out from what the student has actually been charged, what it already
 * credited is subtracted, and only the difference is written. Running it twice
 * therefore writes nothing the second time, and running it after a later
 * demand credits exactly the new share.
 */
const pool = require('../db/pool');
const FeeLedger = require('../models/FeeLedger');
const StudentConcession = require('../models/StudentConcession');
const FeeStructure = require('../models/FeeStructure');
require('../models/FeeConcession'); // populate('concession') needs it registered

const FeeSettings = require('../models/FeeSettings');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * An amount the system worked out (a percentage concession, a per-day fine),
 * rounded the way Fees → Settings says: nearest / up / down, to whole rupees
 * or to paise. 'none' keeps it exact to the paisa. Typed amounts never pass
 * through here.
 */
function roundMoney(n, s = {}) {
    const v = Number(n) || 0;
    const rule = s.roundingRule || 'none';
    if (rule === 'none') return round2(v);
    const f = s.decimalPlaces === 2 ? 100 : 1;
    const x = v * f;
    const r = rule === 'ceil' ? Math.ceil(x - 1e-9) : rule === 'floor' ? Math.floor(x + 1e-9) : Math.round(x);
    return r / f;
}

/**
 * The amount a concession takes off a set of charged items.
 * items: [{ feeHeadId, amount }]. A percentage applies to every item it covers;
 * a fixed amount is ONE sum off the covered total — the old per-item loop took
 * a ₹5,000 concession off each of eight heads.
 */
function concessionOnItems(items, c) {
    if (!c) return 0;
    const heads = new Set((c.applicableHeads || []).map(String));
    const covered = (items || []).filter(i =>
        c.applicableTo !== 'specific_heads' || heads.has(String(i.feeHeadId || '')));
    const base = covered.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    if (base <= 0) return 0;
    const amt = c.concessionType === 'percentage'
        ? base * Math.min(100, Number(c.value) || 0) / 100
        : Math.min(Number(c.value) || 0, base);
    return round2(amt);
}

/** Next running balance for one student-year, as every other ledger writer computes it. */
async function appendLedger(entry) {
    const prev = await FeeLedger.findOne(
        { school: entry.school, student: entry.student, academicYear: entry.academicYear },
        { runningBalance: 1 }, { sort: { createdAt: -1 } },
    );
    const delta = entry.entryType === 'debit' ? entry.amount : -entry.amount;
    return FeeLedger.create({
        ...entry,
        amount: round2(entry.amount),
        runningBalance: round2((prev?.runningBalance || 0) + delta),
    });
}

/**
 * What the student has been charged this year, per fee head, with the day each
 * charge was raised. A demand posted as one lump (generateFeeDemand) is split
 * across its structure's items in proportion; a per-item charge names its item.
 * Only fee-structure charges count — a hostel invoice is not a school fee.
 */
async function chargedItems(schoolId, studentId, academicYearId) {
    const { rows } = await pool.query(
        `SELECT l."amount", l."feeItemId", COALESCE(l."periodStart", l."createdAt") AS "createdAt", fs."items"
           FROM "${FeeLedger.tableName}" l
           JOIN "${FeeStructure.tableName}" fs ON fs."_id" = l."referenceId"
          WHERE l."school" = $1 AND l."student" = $2 AND l."academicYear" = $3
            AND l."category" = 'fee_charged' AND l."entryType" = 'debit'
            AND l."referenceType" = 'FeeStructure'`,
        [String(schoolId), String(studentId), String(academicYearId)],
    );
    const out = [];
    for (const r of rows) {
        const items = (Array.isArray(r.items) ? r.items : []).filter(i => i && i.isActive !== false);
        if (r.feeItemId) {
            const it = items.find(i => String(i._id) === String(r.feeItemId));
            out.push({ feeHeadId: it ? String(it.feeHead) : null, amount: Number(r.amount) || 0, at: r.createdAt });
            continue;
        }
        const sum = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
        if (sum <= 0) continue;
        for (const it of items) {
            out.push({ feeHeadId: String(it.feeHead), amount: (Number(it.amount) || 0) * (Number(r.amount) || 0) / sum, at: r.createdAt });
        }
    }
    return out;
}

const within = (at, from, to) => {
    const t = new Date(at).getTime();
    if (from && t < new Date(from).getTime()) return false;
    if (to) {
        const end = new Date(to); end.setHours(23, 59, 59, 999);
        if (t > end.getTime()) return false;
    }
    return true;
};

/** Net credit a StudentConcession has already put on the ledger. */
async function creditedSoFar(scId) {
    const { rows } = await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN "entryType" = 'credit' THEN "amount" ELSE -"amount" END), 0) AS n
           FROM "${FeeLedger.tableName}"
          WHERE "referenceType" = 'StudentConcession' AND "referenceId" = $1`,
        [String(scId)],
    );
    return Number(rows[0]?.n) || 0;
}

/**
 * Bring every active concession of one student-year up to date. Returns the
 * total newly credited.
 */
async function applyStudentConcessions({ schoolId, studentId, academicYearId, userId = null }) {
    const assigned = await StudentConcession.find({
        school: schoolId, student: studentId, academicYear: academicYearId, isActive: true,
    }).populate('concession').lean();
    if (!assigned.length) return 0;

    const items = await chargedItems(schoolId, studentId, academicYearId);
    if (!items.length) return 0;
    const settings = await FeeSettings.findOne({ school: schoolId }).select('roundingRule decimalPlaces').lean();

    let posted = 0;
    for (const sc of assigned) {
        const c = sc.concession;
        if (!c || c.isActive === false) continue;
        const from = sc.validFrom || c.validFrom;
        const to   = sc.validTo   || c.validTo;
        const due  = roundMoney(concessionOnItems(items.filter(i => within(i.at, from, to)), c), settings || {});
        const gap  = round2(due - await creditedSoFar(sc._id));
        if (gap <= 0.004) continue;
        await appendLedger({
            school: schoolId, student: studentId, academicYear: academicYearId,
            entryType: 'credit', category: 'concession', amount: gap,
            description: `Concession — ${c.name}`,
            referenceType: 'StudentConcession', referenceId: sc._id,
            createdBy: userId,
        });
        posted += gap;
    }
    return round2(posted);
}

/** Take back everything one StudentConcession credited. */
async function reverseStudentConcession(sc, userId = null) {
    const credited = await creditedSoFar(sc._id);
    if (credited <= 0.004) return 0;
    await appendLedger({
        school: sc.school, student: sc.student, academicYear: sc.academicYear,
        entryType: 'debit', category: 'adjustment', amount: credited,
        description: 'Concession withdrawn',
        referenceType: 'StudentConcession', referenceId: sc._id,
        createdBy: userId,
    });
    return round2(credited);
}

module.exports = { concessionOnItems, applyStudentConcessions, reverseStudentConcession, appendLedger, chargedItems, roundMoney };
