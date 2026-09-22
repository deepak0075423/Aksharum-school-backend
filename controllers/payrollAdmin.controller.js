'use strict';
/**
 * The five admin Payroll screens (Sep 2026 redesign): Dashboard, Payroll Runs,
 * Assignments, Structures and Reports.
 *
 * Reads are raw SQL. An employee list joins User → TeacherProfile →
 * EmployeeSalaryAssignment → SalaryStructure and counts entries across every
 * run ever made; db/aggregate.js performs $lookup in JS and would pull all of
 * those tables into memory to answer one screen. The writers that were already
 * correct stay in payroll.controller.js; the ones that were not are rewritten
 * here and that file now delegates to them, so there is exactly one code path
 * per action however it is reached.
 *
 * Vocabulary the screens share:
 *   employee     a User in this school with role teacher or school_admin
 *   assignment   employee ↔ salary structure ↔ CTC, with a validity window
 *   run          one month of payroll for the school
 *   entry        one employee's line inside a run
 */
const pool     = require('../db/pool');
const { isUuid } = require('../db/schema');

const SalaryStructure          = require('../models/SalaryStructure');
const EmployeeSalaryAssignment = require('../models/EmployeeSalaryAssignment');
const PayrollRun               = require('../models/PayrollRun');
const PayrollEntry             = require('../models/PayrollEntry');
const PayrollAuditLog          = require('../models/PayrollAuditLog');
const PayrollSettings          = require('../models/PayrollSettings');
const PayrollReport            = require('../models/PayrollReport');
const Payslip                  = require('../models/Payslip');
const User                     = require('../models/User');
const TeacherProfile           = require('../models/TeacherProfile');
const School                   = require('../models/School');
const AcademicYear             = require('../models/AcademicYear');
const Designation              = require('../models/Designation');
const SalaryAdvance            = require('../models/SalaryAdvance');
const SalaryClaim              = require('../models/SalaryClaim');

const calc = require('../services/payrollCalc');
const tax  = require('../services/incomeTax');
const { notify } = require('../services/notifyService');

const MONTHS      = calc.MONTHS;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Plumbing ─────────────────────────────────────────────────────────────────

const T    = (Model) => `"${Model.tableName}"`;
const ok   = (res, data, extra) => res.json({ success: true, data, ...(extra || {}) });
const bad  = (res, message, code = 400) => res.status(code).json({ success: false, message });
const fail = (res, e) => {
    console.error('[PayrollAdmin]', e);
    res.status(500).json({ success: false, message: e.message || 'Something went wrong' });
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2  = (n) => Math.round(num(n) * 100) / 100;
const uuidOr = (v) => (isUuid(String(v || '')) ? String(v) : null);
const trim = (s) => String(s ?? '').trim();

/** A fresh positional-parameter list: `$(value)` pushes and returns "$n". */
function params() {
    const list = [];
    const $ = (v) => { list.push(v); return `$${list.length}`; };
    return { list, $ };
}

function pageArgs(q, def = 10) {
    const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || def));
    const page  = Math.max(1, parseInt(q.page, 10) || 1);
    return { page, limit, offset: (page - 1) * limit };
}

/** % change, or null when there is nothing to compare against. */
const change = (now, before) => (before > 0 ? r2(((now - before) / before) * 100) : (now > 0 ? null : 0));

const monthLabel  = (m, y) => `${MONTHS[(num(m) || 1) - 1]} ${y}`;
const shortLabel  = (m, y) => `${MONTHS_SHORT[(num(m) || 1) - 1]} ${y}`;
const defaultRunName = (m, y) => `${monthLabel(m, y)} Payroll`;

/** The month before {y, m}. */
const prevMonth = (y, m) => (m > 1 ? { year: y, month: m - 1 } : { year: y - 1, month: 12 });

/**
 * Employees on the payroll: teachers and school admins who are still active.
 * The old dashboard counted `role: 'teacher'` only, so every administrator was
 * invisible to a module that pays them.
 */
const EMPLOYEE_ROLES = ['teacher', 'school_admin'];
const employeeWhere = ($, schoolId, alias = 'u') =>
    `${alias}."school" = ${$(String(schoolId))} AND ${alias}."role" = ANY(${$(EMPLOYEE_ROLES)}) AND COALESCE(${alias}."isActive", true) = true`;

/**
 * Which bucket of the workforce someone falls in — the Dashboard's employee
 * distribution and the Reports department split both read this one expression,
 * so the two can never disagree.
 */
const SUPPORT_WORDS = ['support', 'housekeeping', 'security', 'maintenance', 'janitor', 'peon', 'driver', 'helper', 'cleaning'];
const staffBucketSql = (u = 'u', tp = 'tp') => `
    CASE
      WHEN ${u}."role" = 'school_admin' THEN 'admin'
      WHEN lower(COALESCE(${tp}."department", '')) = ANY(ARRAY['administration','admin','management'])
        THEN 'admin'
      WHEN COALESCE(${tp}."staffType", '') = 'non_teaching' AND (
             lower(COALESCE(${tp}."department", '')) ~ '${SUPPORT_WORDS.join('|')}'
          OR lower(COALESCE(${tp}."designation", '')) ~ '${SUPPORT_WORDS.join('|')}')
        THEN 'support'
      WHEN COALESCE(${tp}."staffType", '') = 'non_teaching' THEN 'non_teaching'
      ELSE 'teaching'
    END`;

const BUCKETS = [
    { key: 'teaching',     label: 'Teaching Staff' },
    { key: 'non_teaching', label: 'Non-Teaching Staff' },
    { key: 'admin',        label: 'Admin Staff' },
    { key: 'support',      label: 'Support Staff' },
];

/** One row per school, created on first read so no screen has to cope with null. */
async function settingsFor(schoolId) {
    let s = await PayrollSettings.findOne({ school: schoolId }).lean();
    if (!s) {
        try { s = (await PayrollSettings.create({ school: schoolId })).toObject?.() || await PayrollSettings.findOne({ school: schoolId }).lean(); }
        catch { s = await PayrollSettings.findOne({ school: schoolId }).lean(); }
    }
    return s || { workingDaysBasis: 'fixed', fixedWorkingDays: 26, weeklyOffs: [0], payDay: 1, roundTo: 1, useLeaveForLop: true, notifyOnPublish: true, requireApproval: true, financialYearStartMonth: 4, payslipPrefix: 'PS' };
}

/** The academic year a screen is looking at: the one asked for, else the active one. */
async function resolveYear(schoolId, requested) {
    const years = await AcademicYear.find({ school: schoolId }).sort({ startDate: -1 }).lean();
    const byId  = (id) => years.find(y => String(y._id) === String(id));
    const year  = (uuidOr(requested) && byId(requested)) || years.find(y => y.status === 'active') || years[0] || null;
    return { year, years };
}
const yearOut = (y) => (y ? { _id: y._id, yearName: y.yearName, status: y.status, startDate: y.startDate, endDate: y.endDate } : null);

/** The months an academic year spans, oldest first — the run pickers use it. */
function yearMonths(year) {
    if (!year) return [];
    const out = [];
    const s = new Date(year.startDate), e = new Date(year.endDate);
    let y = s.getUTCFullYear(), m = s.getUTCMonth() + 1;
    for (let i = 0; i < 24; i++) {
        out.push({ month: m, year: y, label: monthLabel(m, y) });
        if (y > e.getUTCFullYear() || (y === e.getUTCFullYear() && m >= e.getUTCMonth() + 1)) break;
        if (m === 12) { m = 1; y++; } else m++;
    }
    return out;
}

async function logAudit(req, actionType, entityType, entityId, note, oldValue, newValue) {
    try {
        await PayrollAuditLog.create({
            school: req.schoolId, user: req.userId, role: req.userRole,
            actionType, entityType, entityId,
            note: note || '',
            oldValue: oldValue === undefined ? null : oldValue,
            newValue: newValue === undefined ? null : newValue,
            timestamp: new Date(),
        });
    } catch (e) { console.warn('[PayrollAdmin] audit write failed:', e.message); }
}

/**
 * Unpaid leave days per employee for a pay month, keyed by employee id.
 * Empty when the Leave module is off, or on any failure — a leave lookup must
 * never be the reason a payroll run cannot be processed.
 */
async function leaveLopDaysFor(schoolId, year, month) {
    try {
        const { schoolModuleFlags } = require('../config/modules');
        const school = await School.findById(schoolId).select('modules').lean();
        if (!schoolModuleFlags(school).leave) return {};

        const LeaveApplication = require('../models/LeaveApplication');
        const monthStart = new Date(Date.UTC(year, month - 1, 1));
        const monthEnd   = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

        const apps = await LeaveApplication.find({
            school: schoolId, status: 'approved', lopDays: { $gt: 0 },
            fromDate: { $lte: monthEnd }, toDate: { $gte: monthStart },
        }).select('teacher lopDays fromDate toDate totalDays').lean();

        const out = {};
        for (const a of apps) {
            // A leave spanning a month boundary is charged pro-rata to the part
            // inside this pay month, so no day is deducted twice.
            const from = new Date(Math.max(new Date(a.fromDate), monthStart));
            const to   = new Date(Math.min(new Date(a.toDate), monthEnd));
            const inMonth = Math.max(0, Math.round((to - from) / 86400000) + 1);
            const span    = Math.max(1, Math.round((new Date(a.toDate) - new Date(a.fromDate)) / 86400000) + 1);
            const share   = span > 0 ? (a.lopDays * inMonth) / span : a.lopDays;
            out[String(a.teacher)] = r2((out[String(a.teacher)] || 0) + share);
        }
        return out;
    } catch (err) {
        console.error('[payroll←leave] LOP lookup failed:', err.message);
        return {};
    }
}

// ── The run engine ───────────────────────────────────────────────────────────

/**
 * The assignments a run should pay, one per employee.
 *
 * Three rules the old engine had none of:
 *   • the validity window must cover the pay month (a leaver stops being paid
 *     the month after their assignment ends);
 *   • the employee must still be an active employee of THIS school;
 *   • one assignment per employee. Two active assignments used to produce two
 *     entries for one person, which the (run, employee) unique index rejected
 *     — taking the whole insertMany, and therefore the whole run, down with a
 *     raw Postgres error. The newest assignment wins and the other is reported
 *     as skipped.
 */
async function eligibleAssignments(schoolId, year, month) {
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd   = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
    const { $, list } = params();
    const sql = `
      SELECT a."_id", a."employee", a."structure", a."ctc", a."ctcRevisions",
             a."componentOverrides", a."effectiveDate", a."endDate", a."paymentMode",
             u."name" AS "employeeName", u."role" AS "employeeRole",
             tp."employeeId" AS "empCode", tp."department", tp."designation",
             tp."joiningDate", tp."bankAccountNumber", tp."bankIfsc", tp."bankBranch",
             tp."panNumber", tp."uanNumber"
        FROM ${T(EmployeeSalaryAssignment)} a
        JOIN ${T(User)} u ON u."_id" = a."employee"
        LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = a."school"
       WHERE a."school" = ${$(String(schoolId))}
         AND COALESCE(a."isActive", true) = true
         AND a."effectiveDate" <= ${$(monthEnd)}
         AND (a."endDate" IS NULL OR a."endDate" >= ${$(monthStart)})
         AND ${employeeWhere($, schoolId, 'u')}
       ORDER BY a."employee", a."effectiveDate" DESC, a."createdAt" DESC`;
    const { rows } = await pool.query(sql, list);

    const byEmployee = new Map();
    const duplicates = [];
    for (const row of rows) {
        const key = String(row.employee);
        if (byEmployee.has(key)) { duplicates.push({ employee: key, name: row.employeeName, reason: 'More than one active salary assignment — the newest was used' }); continue; }
        byEmployee.set(key, row);
    }
    return { assignments: [...byEmployee.values()], duplicates };
}

/**
 * The working days of a month that fall OUTSIDE an employment window.
 *
 * A run used to include anyone whose assignment merely overlapped the month, at
 * a full month's pay — so somebody who joined on the 28th drew a whole salary,
 * and so did a leaver who left on the 3rd. The window is intersected with the
 * month and the uncovered share of the working days is charged back.
 *
 * Expressed as a share of CALENDAR days rather than counted working day by
 * working day: the run's divisor may be a notional 26 that has no particular
 * dates attached to it, so the only honest conversion is proportional.
 */
function notEmployedDaysFor({ effectiveDate, endDate }, year, month, workingDays) {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthStart = Date.UTC(year, month - 1, 1);
    const monthEnd   = Date.UTC(year, month - 1, daysInMonth);

    const from = effectiveDate ? Date.UTC(
        new Date(effectiveDate).getUTCFullYear(), new Date(effectiveDate).getUTCMonth(), new Date(effectiveDate).getUTCDate()) : monthStart;
    const to = endDate ? Date.UTC(
        new Date(endDate).getUTCFullYear(), new Date(endDate).getUTCMonth(), new Date(endDate).getUTCDate()) : monthEnd;

    const start = Math.max(monthStart, from);
    const end   = Math.min(monthEnd, to);
    const covered = end < start ? 0 : Math.round((end - start) / 86400000) + 1;
    if (covered >= daysInMonth) return 0;
    return r2(workingDays * (1 - covered / daysInMonth));
}

/**
 * Arrears owed because a CTC revision was back-dated over months that have
 * already been paid.
 *
 * Back-dating used to be refused outright, which left a school that agreed a
 * raise in July effective from April with no way to pay the difference at all.
 * Now the revision is allowed and each already-published month is recomputed at
 * the CTC that should have applied; the shortfall is carried into this run as
 * arrears, and each settled entry is stamped so it can never be paid twice.
 */
async function arrearsFor(schoolId, asgn, structure, run, settings) {
    const { $, list } = params();
    const { rows } = await pool.query(`
      SELECT e."_id", e."month", e."year", e."netSalary", e."grossSalary", e."annualCtc",
             e."workingDays", e."lopDays", e."notEmployedDays", e."units"
        FROM ${T(PayrollEntry)} e
        JOIN ${T(PayrollRun)} r ON r."_id" = e."payrollRun"
       WHERE e."school" = ${$(String(schoolId))} AND e."employee" = ${$(String(asgn.employee))}
         AND r."status" = 'published' AND e."arrearsSettledBy" IS NULL
         AND make_date(e."year"::int, e."month"::int, 1) < make_date(${$(num(run.year))}::int, ${$(num(run.month))}::int, 1)
       ORDER BY e."year", e."month"`, list);

    let total = 0;
    const settled = [], detail = [];
    for (const past of rows) {
        const shouldHave = EmployeeSalaryAssignment.activeCtc(asgn, num(past.year), num(past.month));
        if (Math.abs(shouldHave - num(past.annualCtc)) < 1) continue;   // paid on the right CTC
        const redone = calc.computePay({
            structure,
            annualCtc: shouldHave,
            overrides: asgn.componentOverrides || [],
            lopDays: num(past.lopDays), notEmployedDays: num(past.notEmployedDays),
            workingDays: num(past.workingDays) || run.workingDays,
            units: num(past.units),
            roundTo: settings.roundTo,
        });
        const diff = r2(redone.netSalary - num(past.netSalary));
        if (diff <= 0) continue;   // never claw back through arrears — that is a recovery decision
        total += diff;
        settled.push(past._id);
        detail.push({ month: num(past.month), year: num(past.year), label: shortLabel(past.month, past.year), amount: diff });
    }
    return { total: r2(total), settled, detail };
}

/**
 * Unpaid days the staff attendance register says were not worked.
 *
 * Only days marked Absent with no approved leave behind them — a day covered
 * by leave is the Leave module's business and counting it here would dock the
 * same day twice. A Half-Day costs half a day. Empty unless the school has
 * switched this on, and empty on any failure: the register must never be the
 * reason a payroll run cannot be made.
 */
async function attendanceLopFor(schoolId, year, month, settings) {
    if (settings.useAttendanceForLop !== true) return {};
    try {
        const { schoolModuleFlags } = require('../config/modules');
        const school = await School.findById(schoolId).select('modules').lean();
        if (!schoolModuleFlags(school).attendance) return {};

        const TeacherAttendance = require('../models/TeacherAttendance');
        const from = new Date(Date.UTC(year, month - 1, 1));
        const to   = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
        const rows = await TeacherAttendance.find({
            school: schoolId, date: { $gte: from, $lte: to },
            status: { $in: ['Absent', 'Half-Day'] },
        }).select('teacher status').lean();

        const out = {};
        for (const r of rows) {
            const cost = r.status === 'Half-Day' ? 0.5 : 1;
            out[String(r.teacher)] = r2((out[String(r.teacher)] || 0) + cost);
        }
        return out;
    } catch (err) {
        console.error('[payroll←attendance] lookup failed:', err.message);
        return {};
    }
}

/**
 * The financial year a month falls in, as the month range it spans.
 * Mirrors financialYear() in payslip.controller.js — one definition of "year"
 * for the whole module.
 */
function fyRange(startMonth, month, year) {
    const sm = Math.min(12, Math.max(1, num(startMonth) || 4));
    const startYear = month >= sm ? year : year - 1;
    const endYear = sm === 1 ? startYear : startYear + 1;
    const endMonth = sm === 1 ? 12 : sm - 1;
    return { startMonth: sm, from: { year: startYear, month: sm }, to: { year: endYear, month: endMonth },
        label: sm === 1 ? String(startYear) : `${startYear}-${String(endYear).slice(-2)}` };
}
/** Months left in the financial year, counting the one being computed. */
function monthsLeftInFy(fy, month, year) {
    const idx = (y, m) => y * 12 + m;
    return Math.max(1, idx(fy.to.year, fy.to.month) - idx(year, month) + 1);
}

/**
 * What every employee has been paid, and had deducted as tax, so far this
 * financial year — the context monthly TDS needs and a single month cannot know.
 * Only PUBLISHED months count: a draft is not money anybody has received.
 */
async function taxContext(schoolId, fy, month, year) {
    const { $, list } = params();
    const { rows } = await pool.query(`
      SELECT e."employee",
             COALESCE(SUM(e."grossSalary"), 0) AS "paid",
             COALESCE(SUM((SELECT COALESCE(SUM((d->>'amount')::numeric), 0)
                             FROM jsonb_array_elements(COALESCE(e."deductions", '[]'::jsonb)) d
                            WHERE upper(COALESCE(d->>'code', '')) = 'TDS')), 0) AS "tds"
        FROM ${T(PayrollEntry)} e
        JOIN ${T(PayrollRun)} r ON r."_id" = e."payrollRun"
       WHERE e."school" = ${$(String(schoolId))} AND r."status" = 'published'
         AND make_date(e."year"::int, e."month"::int, 1)
             BETWEEN make_date(${$(fy.from.year)}::int, ${$(fy.from.month)}::int, 1)
                 AND make_date(${$(year)}::int, ${$(month)}::int, 1) - interval '1 day'
       GROUP BY e."employee"`, list);
    return new Map(rows.map(r => [String(r.employee), { paid: r2(r.paid), tds: r2(r.tds) }]));
}

/**
 * What each employee owes in advance instalments this month, and what they are
 * owed in approved expenses.
 *
 * Both are read once for the whole run rather than per employee, and both are
 * capped by what is actually outstanding: an advance whose last instalment is
 * smaller than the rest takes only the remainder, and never more.
 */
async function advancesAndClaims(schoolId, run) {
    const key = (y, m) => y * 12 + m;
    const [advances, claims] = await Promise.all([
        SalaryAdvance.find({ school: schoolId, status: 'active' }).lean(),
        SalaryClaim.find({ school: schoolId, status: 'approved' }).lean(),
    ]);

    const owed = new Map();     // employee -> { amount, advances: [{id, amount}] }
    for (const a of advances) {
        // Recovery has not started yet.
        if (key(num(a.startYear), num(a.startMonth)) > key(run.year, run.month)) continue;
        const outstanding = r2(num(a.amount) - num(a.recovered));
        if (outstanding <= 0) continue;
        const instalment = num(a.instalmentAmount) > 0
            ? num(a.instalmentAmount)
            : r2(num(a.amount) / Math.max(1, num(a.instalments)));
        const take = r2(Math.min(instalment, outstanding));
        if (take <= 0) continue;
        const bucket = owed.get(String(a.employee)) || { amount: 0, advances: [] };
        bucket.amount = r2(bucket.amount + take);
        bucket.advances.push({ id: a._id, amount: take, kind: a.kind });
        owed.set(String(a.employee), bucket);
    }

    const due = new Map();      // employee -> { amount, claims: [id] }
    for (const c of claims) {
        const bucket = due.get(String(c.employee)) || { amount: 0, claims: [] };
        bucket.amount = r2(bucket.amount + num(c.amount));
        bucket.claims.push(c._id);
        due.set(String(c.employee), bucket);
    }
    return { owed, due };
}

/**
 * Compute every line of a run and write the entries.
 *
 * `preserve` keeps hand-edited and held entries exactly as they are, which is
 * what makes "Recompute" safe to press after fixing one person's CTC.
 */
async function computeRunEntries(schoolId, run, settings, { preserve = false, actorId = null } = {}) {
    const { assignments, duplicates } = await eligibleAssignments(schoolId, run.year, run.month);
    const structureIds = [...new Set(assignments.map(a => String(a.structure)).filter(Boolean))];
    const structures = structureIds.length
        ? await SalaryStructure.find({ _id: { $in: structureIds }, school: schoolId }).lean()
        : [];
    const structById = new Map(structures.map(s => [String(s._id), s]));

    const [lopFromLeave, lopFromRegister] = await Promise.all([
        settings.useLeaveForLop === false ? {} : leaveLopDaysFor(schoolId, run.year, run.month),
        attendanceLopFor(schoolId, run.year, run.month, settings),
    ]);

    const { owed, due } = await advancesAndClaims(schoolId, run);
    const advanceTaken = [];   // [{ id, amount, employee }] — written back after the entries
    const claimsPaid   = [];

    // Income tax needs the year, not the month — see services/incomeTax.js.
    const taxOn = tax.config(settings).regime !== 'none';
    const fy = fyRange(settings.financialYearStartMonth, run.month, run.year);
    const ytd = taxOn ? await taxContext(schoolId, fy, run.month, run.year) : new Map();
    const monthsLeft = monthsLeftInFy(fy, run.month, run.year);

    const existing = preserve
        ? await PayrollEntry.find({ payrollRun: run._id }).lean()
        : [];
    const keepById = new Map(existing.filter(e => e.isEdited || e.isOnHold).map(e => [String(e.employee), e]));

    /**
     * Release the past months this run had previously settled BEFORE anything
     * is recomputed. A recompute that ran with its own stamps still in place
     * would see those months as already paid and quietly drop the arrears.
     */
    await PayrollEntry.updateMany({ arrearsSettledBy: run._id }, { arrearsSettledBy: null });

    const skipped = [...duplicates];
    const warnings = [];
    const arrearsToStamp = [];
    const docs = [];

    for (const a of assignments) {
        const structure = structById.get(String(a.structure));
        if (!structure) {
            skipped.push({ employee: String(a.employee), name: a.employeeName, reason: 'Salary structure missing or deleted' });
            continue;
        }
        if (structure.isActive === false) {
            skipped.push({ employee: String(a.employee), name: a.employeeName, reason: `Structure "${structure.name}" is inactive` });
            continue;
        }
        const kept = keepById.get(String(a.employee));
        if (kept) continue;   // hand-edited or held: leave untouched

        const annualCtc = EmployeeSalaryAssignment.activeCtc(a, run.year, run.month);
        if (structure.payBasis !== 'rate' && !(annualCtc > 0)) {
            skipped.push({ employee: String(a.employee), name: a.employeeName, reason: 'No CTC set for this month' });
            continue;
        }

        const manualLop = existing.find(e => String(e.employee) === String(a.employee) && e.lopSource === 'manual');
        // Leave and the register are added, not maxed: they describe different
        // days. attendanceLopFor() already excludes days covered by leave, so
        // nothing is counted twice.
        const fromLeave    = num(lopFromLeave[String(a.employee)] || 0);
        const fromRegister = num(lopFromRegister[String(a.employee)] || 0);
        const lopDays = manualLop ? num(manualLop.lopDays) : r2(fromLeave + fromRegister);
        const lopSource = manualLop ? 'manual'
            : fromRegister > 0 && fromLeave > 0 ? 'leave'
            : fromRegister > 0 ? 'attendance'
            : fromLeave > 0 ? 'leave' : 'none';
        const prior   = existing.find(e => String(e.employee) === String(a.employee));
        const notEmployedDays = notEmployedDaysFor(a, run.year, run.month, run.workingDays);

        // A back-dated raise settles here, unless the admin has already typed
        // an arrears figure by hand on this entry.
        const backPay = prior && prior.isEdited
            ? { total: num(prior.arrears), settled: [], detail: [] }
            : await arrearsFor(schoolId, a, structure, run, settings);
        if (backPay.settled.length) arrearsToStamp.push(...backPay.settled);

        const pay = calc.computePay({
            structure,
            annualCtc,
            overrides: a.componentOverrides || [],
            lopDays, notEmployedDays,
            workingDays: run.workingDays,
            units: prior ? num(prior.units) : 0,
            arrears: backPay.total,
            bonus: prior ? num(prior.bonus) : 0,
            otherDeductions: prior ? num(prior.otherDeductions) : 0,
            roundTo: settings.roundTo,
        });

        /**
         * Overtime, expenses and advance instalments.
         *
         * Overtime is an EARNING (taxable, part of gross). A reimbursement is
         * not earnings at all — it is money being handed back — so it is added
         * to the net without touching gross or tax. An advance instalment is a
         * recovery, taken after everything else, and capped by what is left to
         * pay so nobody is taken below zero.
         */
        const otRate = prior && num(prior.overtimeRate) > 0 ? num(prior.overtimeRate) : num(structure.overtimeRate);
        const otHours = prior ? num(prior.overtimeHours) : 0;
        const otAmount = calc.roundAmount(otHours * otRate, settings.roundTo);
        if (otAmount > 0) {
            pay.earnings.push({ name: 'Overtime', code: 'OT', amount: otAmount, fullAmount: otAmount });
            pay.grossSalary = r2(pay.grossSalary + otAmount);
        }

        /**
         * TDS replaces any hand-set TDS line rather than joining it: a
         * structure that carries a flat "TDS ₹0" placeholder would otherwise
         * deduct tax twice, once as the placeholder and once as the real thing.
         */
        if (taxOn && structure.payBasis !== 'rate') {
            const seen = ytd.get(String(a.employee)) || { paid: 0, tds: 0 };
            const thisMonthTaxable = tax.taxableEarnings(pay.earnings, structure);
            const due = tax.monthlyTds({
                taxablePaidToDate: seen.paid,
                taxableThisMonth: thisMonthTaxable,
                tdsPaidToDate: seen.tds,
                monthsRemaining: monthsLeft,
                settings,
            });
            pay.deductions = pay.deductions.filter(d => String(d.code || '').toUpperCase() !== 'TDS');
            if (due.amount > 0) {
                pay.deductions.push({
                    name: 'Income Tax (TDS)', code: 'TDS',
                    amount: calc.roundAmount(due.amount, settings.roundTo),
                    fullAmount: calc.roundAmount(due.amount, settings.roundTo),
                });
            }
            pay.totalDeductions = r2(pay.deductions.reduce((t, d) => t + num(d.amount), 0));
            const raw = pay.grossSalary - pay.totalDeductions + pay.arrears + pay.bonus - pay.otherDeductions;
            pay.netSalary   = calc.roundAmount(Math.max(0, raw), settings.roundTo);
            pay.unrecovered = calc.roundAmount(Math.max(0, -raw), settings.roundTo);
        }

        const claim = due.get(String(a.employee));
        const reimbursement = claim ? claim.amount : 0;

        // Recover what the month can actually bear, and no more.
        const wanted = owed.get(String(a.employee));
        const payable = r2(pay.grossSalary - pay.totalDeductions + pay.arrears + pay.bonus + reimbursement - pay.otherDeductions);
        const advanceRecovery = wanted ? r2(Math.min(wanted.amount, Math.max(0, payable))) : 0;
        if (wanted && advanceRecovery > 0) {
            // Instalments are taken in order until the month's capacity runs out.
            let left = advanceRecovery;
            for (const one of wanted.advances) {
                if (left <= 0) break;
                const take = r2(Math.min(one.amount, left));
                advanceTaken.push({ id: one.id, amount: take, employee: a.employee });
                left = r2(left - take);
            }
        }
        if (claim && reimbursement > 0) claimsPaid.push(...claim.claims);

        const finalRaw = r2(payable - advanceRecovery);
        pay.netSalary   = calc.roundAmount(Math.max(0, finalRaw), settings.roundTo);
        pay.unrecovered = calc.roundAmount(Math.max(0, -finalRaw), settings.roundTo);

        if (wanted && advanceRecovery < wanted.amount) {
            warnings.push({
                employee: String(a.employee), name: a.employeeName, kind: 'advance_short',
                message: `Only ${inr(advanceRecovery)} of a ${inr(wanted.amount)} advance instalment could be recovered this month`,
            });
        }

        if (pay.overpaysCtc) {
            warnings.push({
                employee: String(a.employee), name: a.employeeName, kind: 'over_ctc',
                message: `Paid ${inr(pay.monthlyCost)} against a monthly CTC of ${inr(pay.monthlyCtc)} — the “${structure.name}” structure's fixed components come to more than this CTC`,
            });
        }
        if (pay.zeroPay) {
            warnings.push({
                employee: String(a.employee), name: a.employeeName, kind: 'zero_pay',
                message: notEmployedDays >= run.workingDays
                    ? 'Not on the payroll for any day of this month'
                    : 'Every working day of this month is unpaid leave',
            });
        }
        if (backPay.total > 0) {
            warnings.push({
                employee: String(a.employee), name: a.employeeName, kind: 'arrears',
                message: `${inr(backPay.total)} of arrears for ${backPay.detail.map(d => d.label).join(', ')}`,
            });
        }

        docs.push({
            payrollRun: run._id, employee: a.employee, school: schoolId,
            month: run.month, year: run.year,
            salaryAssignment: a._id, structure: structure._id,
            annualCtc: pay.annualCtc,
            earnings: pay.earnings, deductions: pay.deductions,
            employerContributions: pay.employerContributions,
            grossSalary: pay.grossSalary, totalDeductions: pay.totalDeductions,
            employerCost: pay.employerCost, netSalary: pay.netSalary,
            workingDays: pay.workingDays, paidDays: pay.paidDays,
            notEmployedDays: pay.notEmployedDays,
            lopDays: pay.lopDays, lopAmount: pay.lopAmount,
            lopSource,
            units: prior ? num(prior.units) : 0,
            rate: structure.payBasis === 'rate' ? num(structure.rate) : 0,
            arrears: pay.arrears, bonus: pay.bonus, otherDeductions: pay.otherDeductions,
            overtimeHours: otHours, overtimeRate: otRate, overtimeAmount: otAmount,
            reimbursement, advanceRecovery,
            unrecovered: pay.unrecovered,
            remarks: prior ? (prior.remarks || '') : '',
            isOnHold: false, isEdited: false,
        });
    }

    // Replace everything that is not being preserved, so an employee whose
    // assignment ended stops appearing in a recomputed run.
    const keepIds = [...keepById.values()].map(e => e._id);
    if (existing.length) {
        const doomed = existing.filter(e => !keepIds.some(id => String(id) === String(e._id))).map(e => e._id);
        if (doomed.length) await PayrollEntry.deleteMany({ _id: { $in: doomed } });
    }
    if (docs.length) await PayrollEntry.insertMany(docs);

    // Stamp the past months whose arrears this run settles, so a later
    // recompute cannot pay the same difference a second time.
    if (arrearsToStamp.length) {
        await PayrollEntry.updateMany({ _id: { $in: arrearsToStamp } }, { arrearsSettledBy: run._id });
    }

    /**
     * Advances and claims are only MARKED here — the run has computed what it
     * will take and pay. The actual ledger movement happens on publish, so a
     * draft that is recomputed or thrown away never leaves an advance
     * half-recovered or a claim marked paid for a month nobody was paid in.
     */
    await PayrollRun.updateOne({ _id: run._id }, {
        pendingRecovery: advanceTaken.length ? advanceTaken.map(x => ({ ...x, id: String(x.id), employee: String(x.employee) })) : null,
        pendingClaims: claimsPaid.length ? claimsPaid.map(String) : null,
    });

    await refreshRunTotals(run._id, { skipped, warnings, actorId });
    return { count: docs.length + keepIds.length, skipped, warnings };
}

/**
 * Indian grouping, for the sentences a run writes about itself. Named `inr`
 * rather than `money` because buildReport() has its own local `money` that
 * returns a NUMBER for the report columns — two things called the same would
 * be one rename away from putting "₹48,200" in a numeric CSV column.
 */
const inr = (n) => `₹${Math.round(num(n)).toLocaleString('en-IN')}`;

/**
 * Re-sum a run from its entries.
 *
 * The previous module summed once, at creation, and never again — so editing
 * an entry left the run row (and every tile, list and report reading it)
 * stating figures that no longer matched the payslips it would publish.
 * Everything that touches an entry now ends here.
 */
async function refreshRunTotals(runId, { skipped, warnings, actorId } = {}) {
    const { $, list } = params();
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS "n",
             COALESCE(SUM("grossSalary"), 0)     AS "gross",
             COALESCE(SUM("totalDeductions"), 0) AS "ded",
             COALESCE(SUM("netSalary"), 0)       AS "net",
             COALESCE(SUM("lopAmount"), 0)       AS "lop",
             COALESCE(SUM("employerCost"), 0)    AS "cost"
        FROM ${T(PayrollEntry)}
       WHERE "payrollRun" = ${$(String(runId))} AND COALESCE("isOnHold", false) = false`, list);
    const t = rows[0] || {};
    const update = {
        totalEmployees: num(t.n),
        totalGross: r2(t.gross), totalDeductions: r2(t.ded), totalNet: r2(t.net),
        totalLop: r2(t.lop), totalEmployerCost: r2(t.cost),
        computedAt: new Date(),
    };
    if (skipped !== undefined) update.skipped = skipped && skipped.length ? skipped : null;
    if (warnings !== undefined) update.warnings = warnings && warnings.length ? warnings : null;
    if (actorId) update.processedBy = actorId;
    await PayrollRun.updateOne({ _id: runId }, update);
    return update;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

/** Headcount and the workforce split, in one pass. */
async function workforce(schoolId) {
    const { $, list } = params();
    const { rows } = await pool.query(`
      SELECT ${staffBucketSql('u', 'tp')} AS "bucket", COUNT(*)::int AS "n"
        FROM ${T(User)} u
        LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = u."school"
       WHERE ${employeeWhere($, schoolId, 'u')}
       GROUP BY 1`, list);
    const by = Object.fromEntries(rows.map(r => [r.bucket, num(r.n)]));
    const total = rows.reduce((s, r) => s + num(r.n), 0);
    return { total, distribution: BUCKETS.map(b => ({ ...b, count: by[b.key] || 0 })) };
}

exports.getOverview = async (req, res) => {
    try {
        const now   = new Date();
        const month = Math.min(12, Math.max(1, parseInt(req.query.month, 10) || (now.getMonth() + 1)));
        const year  = parseInt(req.query.year, 10) || now.getFullYear();
        const prev  = prevMonth(year, month);

        const [{ year: acYear, years }, settings] = await Promise.all([
            resolveYear(req.schoolId, req.query.academicYear),
            settingsFor(req.schoolId),
        ]);

        const p1 = params();
        const staffP = params();
        const [
            staff,
            assignRows,
            runRows,
            seriesRows,
            recentRows,
            unassignedRows,
            upcomingCtc,
        ] = await Promise.all([
            workforce(req.schoolId),
            // Active assignments now, and how many were already in force a month ago.
            pool.query(`
              SELECT COUNT(*) FILTER (WHERE COALESCE(a."isActive", true))::int AS "active",
                     COUNT(*) FILTER (WHERE COALESCE(a."isActive", true) AND a."effectiveDate" <= ${p1.$(new Date(Date.UTC(prev.year, prev.month, 0, 23, 59, 59)))})::int AS "activeBefore"
                FROM ${T(EmployeeSalaryAssignment)} a
                JOIN ${T(User)} u ON u."_id" = a."employee"
               WHERE a."school" = ${p1.$(String(req.schoolId))} AND ${employeeWhere(p1.$, req.schoolId, 'u')}`, p1.list),
            PayrollRun.find({ school: req.schoolId, $or: [{ year, month }, { year: prev.year, month: prev.month }] }).lean(),
            // The last six months of published or in-flight runs, for the bar chart.
            (async () => {
                const s = params();
                const from = new Date(Date.UTC(year, month - 6, 1));
                return (await pool.query(`
                  SELECT "month", "year", "totalGross", "totalDeductions", "totalNet", "status"
                    FROM ${T(PayrollRun)}
                   WHERE "school" = ${s.$(String(req.schoolId))}
                     AND make_date("year"::int, "month"::int, 1) >= ${s.$(from)}
                     AND make_date("year"::int, "month"::int, 1) <= ${s.$(new Date(Date.UTC(year, month - 1, 1)))}
                     AND "status" <> 'cancelled'`, s.list)).rows;
            })(),
            (async () => {
                const s = params();
                return (await pool.query(`
                  SELECT r."_id", r."runName", r."month", r."year", r."status", r."totalEmployees",
                         r."totalGross", r."totalDeductions", r."totalNet", r."createdAt",
                         pu."name" AS "processedByName"
                    FROM ${T(PayrollRun)} r
                    LEFT JOIN ${T(User)} pu ON pu."_id" = r."processedBy"
                   WHERE r."school" = ${s.$(String(req.schoolId))}
                   ORDER BY r."year" DESC, r."month" DESC
                   LIMIT 5`, s.list)).rows;
            })(),
            pool.query(`
              SELECT COUNT(*)::int AS "n"
                FROM ${T(User)} u
               WHERE ${employeeWhere(staffP.$, req.schoolId, 'u')}
                 AND NOT EXISTS (
                   SELECT 1 FROM ${T(EmployeeSalaryAssignment)} a
                    WHERE a."employee" = u."_id" AND a."school" = u."school" AND COALESCE(a."isActive", true))`, staffP.list),
            // CTC revisions that have not taken effect yet — a real "salary revision" date.
            (async () => {
                const s = params();
                return (await pool.query(`
                  SELECT rev->>'effectiveMonth' AS "m", rev->>'effectiveYear' AS "y", COUNT(*)::int AS "n"
                    FROM ${T(EmployeeSalaryAssignment)} a,
                         LATERAL jsonb_array_elements(COALESCE(a."ctcRevisions", '[]'::jsonb)) rev
                   WHERE a."school" = ${s.$(String(req.schoolId))} AND COALESCE(a."isActive", true)
                     AND ((rev->>'effectiveYear')::int > ${s.$(year)}
                       OR ((rev->>'effectiveYear')::int = ${s.$(year)} AND (rev->>'effectiveMonth')::int > ${s.$(month)}))
                   GROUP BY 1, 2 ORDER BY 2, 1 LIMIT 1`, s.list)).rows;
            })(),
        ]);

        const thisRun = runRows.find(r => r.year === year && r.month === month) || null;
        const prevRun = runRows.find(r => r.year === prev.year && r.month === prev.month) || null;

        // Six month series, zero-filled so the axis never jumps a month.
        const byKey = new Map(seriesRows.map(r => [`${r.year}-${r.month}`, r]));
        const series = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(Date.UTC(year, month - 1 - i, 1));
            const m = d.getUTCMonth() + 1, y = d.getUTCFullYear();
            const row = byKey.get(`${y}-${m}`);
            series.push({
                month: m, year: y, label: shortLabel(m, y),
                gross: r2(row?.totalGross), deductions: r2(row?.totalDeductions), net: r2(row?.totalNet),
                status: row?.status || null,
            });
        }

        // Upcoming: this month's payroll, the next salary revision, and Form 16.
        const fyStart   = num(settings.financialYearStartMonth) || 4;
        const payDay    = Math.min(28, Math.max(1, num(settings.payDay) || 1));
        const dueDate   = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, payDay));
        const daysToDue = Math.round((dueDate - new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))) / 86400000);
        const fyEndYear = month >= fyStart ? year + 1 : year;
        const rev = upcomingCtc[0];

        const upcoming = [
            {
                key: 'run', glyph: 'calendar', tone: 'indigo',
                title: `${monthLabel(month, year)} Payroll`,
                subtitle: thisRun ? `${RUN_STAGE[thisRun.status]?.label || thisRun.status} · ${thisRun.totalEmployees || 0} employees` : 'Not generated yet',
                due: dueDate,
                badge: thisRun && thisRun.status === 'published' ? { text: 'Completed', tone: 'green' }
                    : daysToDue < 0 ? { text: `${Math.abs(daysToDue)} days overdue`, tone: 'red' }
                    : { text: daysToDue === 0 ? 'Due today' : `Due in ${daysToDue} day${daysToDue === 1 ? '' : 's'}`, tone: daysToDue <= 5 ? 'red' : 'amber' },
            },
            {
                key: 'revision', glyph: 'trending', tone: 'blue',
                title: 'Salary Revision',
                subtitle: rev ? `${num(rev.n)} employee${num(rev.n) === 1 ? '' : 's'} · ${monthLabel(num(rev.m), num(rev.y))}` : 'Academic year update',
                due: rev ? new Date(Date.UTC(num(rev.y), num(rev.m) - 1, 1))
                    : (acYear ? new Date(acYear.endDate) : new Date(Date.UTC(fyEndYear, fyStart - 1, 1))),
            },
            {
                key: 'form16', glyph: 'doc', tone: 'purple',
                title: 'Generate Form 16',
                subtitle: tax.config(settings).regime === 'none'
                    ? 'Set up a tax regime first'
                    : `For FY ${fyRange(settings.financialYearStartMonth, month, year).label}`,
                due: new Date(Date.UTC(fyEndYear, 4, 15)),
                // The dashboard card now points at a report that exists.
                to: '/admin/payroll/reports?type=form16',
                ready: tax.config(settings).regime !== 'none',
            },
        ];

        ok(res, {
            month, year, monthLabel: monthLabel(month, year),
            isCurrentMonth: month === now.getMonth() + 1 && year === now.getFullYear(),
            academicYear: yearOut(acYear), academicYears: years.map(yearOut),
            settings: publicSettings(settings),
            tiles: {
                totalEmployees: { value: staff.total, deltaPct: 0, caption: 'Active staff members' },
                activeAssignments: {
                    value: num(assignRows.rows[0]?.active),
                    deltaPct: change(num(assignRows.rows[0]?.active), num(assignRows.rows[0]?.activeBefore)),
                    caption: 'Teachers, staff & admin',
                },
                thisMonth: {
                    status: thisRun?.status || null,
                    runId: thisRun?._id || null,
                    value: thisRun ? r2(thisRun.totalNet) : null,
                    caption: monthLabel(month, year),
                },
                lastMonth: {
                    value: prevRun ? r2(prevRun.totalNet) : null,
                    deltaPct: thisRun && prevRun ? change(num(thisRun.totalNet), num(prevRun.totalNet)) : null,
                    caption: prevRun ? monthLabel(prev.month, prev.year) : 'No previous run',
                },
            },
            distribution: staff.distribution,
            series,
            recentRuns: recentRows.map(shapeRun),
            upcoming,
            unassigned: num(unassignedRows.rows[0]?.n),
        });
    } catch (e) { fail(res, e); }
};

/** The stage a run is at, and how every screen writes it. */
const RUN_STAGE = {
    draft:      { step: 1, label: 'Configure',  state: 'in_progress', tone: 'blue'  },
    reviewed:   { step: 2, label: 'Review',     state: 'in_progress', tone: 'amber' },
    approved:   { step: 3, label: 'Process',    state: 'in_progress', tone: 'indigo' },
    publishing: { step: 4, label: 'Publishing', state: 'in_progress', tone: 'indigo' },
    published: { step: 4, label: 'Completed',  state: 'completed',   tone: 'green' },
    failed:    { step: 0, label: 'Failed',     state: 'failed',      tone: 'red'   },
    cancelled: { step: 0, label: 'Cancelled',  state: 'cancelled',   tone: 'slate' },
};
exports.RUN_STAGE = RUN_STAGE;

function shapeRun(r) {
    const stage = RUN_STAGE[r.status] || RUN_STAGE.draft;
    return {
        _id: r._id,
        runName: r.runName || defaultRunName(r.month, r.year),
        month: r.month, year: r.year,
        period: shortLabel(r.month, r.year),
        periodRange: periodRange(r.month, r.year),
        status: r.status, stage: stage.step, stageLabel: stage.label, state: stage.state,
        totalEmployees: num(r.totalEmployees),
        totalGross: r2(r.totalGross), totalDeductions: r2(r.totalDeductions), totalNet: r2(r.totalNet),
        totalLop: r2(r.totalLop), totalEmployerCost: r2(r.totalEmployerCost),
        workingDays: num(r.workingDays) || 26,
        notes: r.notes || '',
        failureReason: r.failureReason || '',
        skipped: r.skipped || null,
        warnings: r.warnings || null,
        processedByName: r.processedByName || null,
        approvedByName: r.approvedByName || null,
        publishedByName: r.publishedByName || null,
        createdAt: r.createdAt, publishedAt: r.publishedAt, payDate: r.payDate,
    };
}

/** "01 Sep – 30 Sep". */
function periodRange(month, year) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const m = MONTHS_SHORT[(num(month) || 1) - 1];
    return `01 ${m} – ${last} ${m}`;
}

/**
 * How many accounts could approve a payroll run — school admins plus teachers
 * whose designation grants administrative access to payroll. Used only to let a
 * one-admin school past the separation-of-duties rule.
 */
async function approverCount(schoolId) {
    const { $, list } = params();
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS "n"
        FROM ${T(User)} u
        LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = u."school"
        LEFT JOIN ${T(Designation)} d ON d."school" = u."school"
                                     AND lower(d."name") = lower(COALESCE(tp."designation", ''))
                                     AND COALESCE(d."isActive", true)
       WHERE ${employeeWhere($, schoolId, 'u')}
         AND (u."role" = 'school_admin'
              OR COALESCE(d."permissions" ->> 'payroll', '') = 'admin')`, list);
    return num(rows[0]?.n);
}

const publicSettings = (s) => ({
    workingDaysBasis: s.workingDaysBasis, fixedWorkingDays: num(s.fixedWorkingDays) || 26,
    weeklyOffs: s.weeklyOffs || [0], payDay: num(s.payDay) || 1, roundTo: num(s.roundTo) || 1,
    financialYearStartMonth: num(s.financialYearStartMonth) || 4,
    useLeaveForLop: s.useLeaveForLop !== false,
    useAttendanceForLop: s.useAttendanceForLop === true,
    notifyOnPublish: s.notifyOnPublish !== false,
    requireApproval: s.requireApproval !== false,
    separateApprover: s.separateApprover !== false,
    autoOpenRun: s.autoOpenRun === true, autoOpenDay: num(s.autoOpenDay) || 25,
    remindBeforePayDay: s.remindBeforePayDay === true, remindDaysBefore: num(s.remindDaysBefore) || 3,
    payslipPrefix: s.payslipPrefix || 'PS', payslipNote: s.payslipNote || '',
    bankName: s.bankName || '', bankAccountNumber: s.bankAccountNumber || '', bankIfsc: s.bankIfsc || '',
    tax: tax.config(s),
});

// ── Payroll Runs ─────────────────────────────────────────────────────────────

const RUN_SORTS = {
    runName: `COALESCE(NULLIF(r."runName", ''), '')`,
    period:  `make_date(r."year"::int, r."month"::int, 1)`,
    employees: `r."totalEmployees"`,
    gross: `r."totalGross"`, deductions: `r."totalDeductions"`, net: `r."totalNet"`,
    status: `r."status"`,
};

exports.listRuns = async (req, res) => {
    try {
        const { page, limit, offset } = pageArgs(req.query, 10);
        const { $, list } = params();
        const where = [`r."school" = ${$(String(req.schoolId))}`];

        const search = trim(req.query.search);
        if (search) {
            const like = $(`%${search}%`);
            where.push(`(COALESCE(r."runName", '') ILIKE ${like} OR COALESCE(r."notes", '') ILIKE ${like}
                         OR to_char(make_date(r."year"::int, r."month"::int, 1), 'FMMonth YYYY') ILIKE ${like})`);
        }
        if (req.query.month && num(req.query.month) >= 1) where.push(`r."month" = ${$(num(req.query.month))}`);
        if (req.query.year) where.push(`r."year" = ${$(num(req.query.year))}`);
        const status = trim(req.query.status);
        if (status === 'in_progress') where.push(`r."status" IN ('draft','reviewed','approved','publishing')`);
        else if (status && RUN_STAGE[status]) where.push(`r."status" = ${$(status)}`);
        else if (status === 'completed') where.push(`r."status" = 'published'`);

        // The academic year filter is a date window, because a run is a month
        // and a year is a span of months — matching on a stored id would miss
        // every run created before the column existed.
        const { year: acYear, years } = await resolveYear(req.schoolId, req.query.academicYear);
        if (acYear && req.query.academicYear !== 'all') {
            where.push(`make_date(r."year"::int, r."month"::int, 1) BETWEEN ${$(new Date(acYear.startDate))} AND ${$(new Date(acYear.endDate))}`);
        }

        const sortKey = RUN_SORTS[trim(req.query.sort)] || RUN_SORTS.period;
        const dir = trim(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

        const base = `FROM ${T(PayrollRun)} r WHERE ${where.join(' AND ')}`;
        const [page1, counts] = await Promise.all([
            pool.query(`
              SELECT r.*, pu."name" AS "processedByName", au."name" AS "approvedByName", bu."name" AS "publishedByName"
                FROM ${T(PayrollRun)} r
                LEFT JOIN ${T(User)} pu ON pu."_id" = r."processedBy"
                LEFT JOIN ${T(User)} au ON au."_id" = r."approvedBy"
                LEFT JOIN ${T(User)} bu ON bu."_id" = r."publishedBy"
               WHERE ${where.join(' AND ')}
               ORDER BY ${sortKey} ${dir}, make_date(r."year"::int, r."month"::int, 1) DESC
               LIMIT ${limit} OFFSET ${offset}`, list),
            // Tiles count the whole year in view, not the filtered page.
            (async () => {
                const s = params();
                const w = [`r."school" = ${s.$(String(req.schoolId))}`];
                if (acYear && req.query.academicYear !== 'all') {
                    w.push(`make_date(r."year"::int, r."month"::int, 1) BETWEEN ${s.$(new Date(acYear.startDate))} AND ${s.$(new Date(acYear.endDate))}`);
                }
                return (await pool.query(`
                  SELECT COUNT(*)::int AS "total",
                         COUNT(*) FILTER (WHERE r."status" = 'published')::int AS "completed",
                         COUNT(*) FILTER (WHERE r."status" IN ('draft','reviewed','approved','publishing'))::int AS "inProgress",
                         COUNT(*) FILTER (WHERE r."status" = 'failed')::int AS "failed",
                         COUNT(*) FILTER (WHERE r."status" = 'cancelled')::int AS "cancelled"
                    FROM ${T(PayrollRun)} r WHERE ${w.join(' AND ')}`, s.list)).rows[0];
            })(),
        ]);

        // Same predicates and the same parameter list the page query used.
        const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS "n" ${base}`, list);

        const summary = {
            total: num(counts.total), completed: num(counts.completed),
            inProgress: num(counts.inProgress), failed: num(counts.failed), cancelled: num(counts.cancelled),
        };
        const total = num(cnt[0]?.n);
        ok(res, page1.rows.map(shapeRun), {
            summary, total, page, pages: Math.max(1, Math.ceil(total / limit)), limit,
            academicYear: yearOut(acYear), academicYears: years.map(yearOut),
        });
    } catch (e) { fail(res, e); }
};

/** One run with its entries — the detail screen and the right-hand rail. */
exports.getRun = async (req, res) => {
    try {
        const id = uuidOr(req.params.id);
        if (!id) return bad(res, 'Run not found', 404);
        const { $, list } = params();
        const { rows } = await pool.query(`
          SELECT r.*, pu."name" AS "processedByName", au."name" AS "approvedByName", bu."name" AS "publishedByName"
            FROM ${T(PayrollRun)} r
            LEFT JOIN ${T(User)} pu ON pu."_id" = r."processedBy"
            LEFT JOIN ${T(User)} au ON au."_id" = r."approvedBy"
            LEFT JOIN ${T(User)} bu ON bu."_id" = r."publishedBy"
           WHERE r."_id" = ${$(id)} AND r."school" = ${$(String(req.schoolId))}`, list);
        if (!rows.length) return bad(res, 'Payroll run not found', 404);
        const run = rows[0];

        const e = params();
        const ew = [`e."payrollRun" = ${e.$(id)}`];
        const search = trim(req.query.search);
        if (search) {
            const like = e.$(`%${search}%`);
            ew.push(`(u."name" ILIKE ${like} OR COALESCE(tp."employeeId", '') ILIKE ${like} OR u."email" ILIKE ${like})`);
        }
        if (trim(req.query.department)) ew.push(`COALESCE(tp."department", '') = ${e.$(trim(req.query.department))}`);
        if (trim(req.query.entryStatus) === 'hold') ew.push(`COALESCE(e."isOnHold", false) = true`);
        if (trim(req.query.entryStatus) === 'edited') ew.push(`COALESCE(e."isEdited", false) = true`);
        if (trim(req.query.entryStatus) === 'lop') ew.push(`COALESCE(e."lopDays", 0) > 0`);

        const { rows: entries } = await pool.query(`
          SELECT e.*, u."name" AS "employeeName", u."email" AS "employeeEmail", u."role" AS "employeeRole",
                 tp."employeeId" AS "empCode", tp."department", tp."designation",
                 tp."bankAccountNumber", tp."bankIfsc",
                 s."name" AS "structureName", s."type" AS "structureType",
                 p."_id" AS "payslipId", p."slipNo"
            FROM ${T(PayrollEntry)} e
            JOIN ${T(User)} u ON u."_id" = e."employee"
            LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = e."school"
            LEFT JOIN ${T(SalaryStructure)} s ON s."_id" = e."structure"
            LEFT JOIN ${T(Payslip)} p ON p."payrollEntry" = e."_id"
           WHERE ${ew.join(' AND ')}
           ORDER BY u."name" ASC`, e.list);

        const d = params();
        const { rows: depts } = await pool.query(`
          SELECT DISTINCT COALESCE(tp."department", '') AS "department"
            FROM ${T(PayrollEntry)} e
            JOIN ${T(User)} u ON u."_id" = e."employee"
            LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = e."school"
           WHERE e."payrollRun" = ${d.$(id)} AND COALESCE(tp."department", '') <> ''
           ORDER BY 1`, d.list);

        ok(res, {
            ...shapeRun(run),
            entries: entries.map(shapeEntry),
            departments: depts.map(r => r.department),
            // Held entries sit outside the totals, so say how much is being withheld.
            held: entries.filter(x => x.isOnHold).length,
            heldAmount: r2(entries.filter(x => x.isOnHold).reduce((s, x) => s + num(x.netSalary), 0)),
        });
    } catch (e) { fail(res, e); }
};

function shapeEntry(e) {
    return {
        _id: e._id,
        employee: { _id: e.employee, name: e.employeeName, email: e.employeeEmail, employeeId: e.empCode || '', department: e.department || '', designation: e.designation || '', role: e.employeeRole },
        structure: e.structure ? { _id: e.structure, name: e.structureName, type: e.structureType } : null,
        annualCtc: r2(e.annualCtc),
        earnings: e.earnings || [], deductions: e.deductions || [], employerContributions: e.employerContributions || [],
        grossSalary: r2(e.grossSalary), totalDeductions: r2(e.totalDeductions),
        employerCost: r2(e.employerCost), netSalary: r2(e.netSalary),
        workingDays: num(e.workingDays), paidDays: num(e.paidDays),
        notEmployedDays: num(e.notEmployedDays),
        lopDays: num(e.lopDays), lopAmount: r2(e.lopAmount), lopSource: e.lopSource || 'none',
        units: num(e.units), rate: r2(e.rate),
        arrears: r2(e.arrears), bonus: r2(e.bonus), otherDeductions: r2(e.otherDeductions),
        overtimeHours: num(e.overtimeHours), overtimeRate: r2(e.overtimeRate), overtimeAmount: r2(e.overtimeAmount),
        reimbursement: r2(e.reimbursement), advanceRecovery: r2(e.advanceRecovery),
        unrecovered: r2(e.unrecovered),
        remarks: e.remarks || '', isOnHold: !!e.isOnHold, isEdited: !!e.isEdited,
        bank: { accountNumber: e.bankAccountNumber || '', ifsc: e.bankIfsc || '' },
        payslip: e.payslipId ? { _id: e.payslipId, slipNo: e.slipNo || '' } : null,
    };
}

exports.createRun = async (req, res) => {
    try {
        const month = num(req.body.month), year = num(req.body.year);
        if (!(month >= 1 && month <= 12)) return bad(res, 'Choose a month');
        // A run more than a year ahead is a typo, not a plan. Behind is fine —
        // schools do back-fill a month they never ran.
        const thisYear = new Date().getFullYear();
        if (!(year >= thisYear - 10 && year <= thisYear + 1)) {
            return bad(res, `Choose a year between ${thisYear - 10} and ${thisYear + 1}`);
        }

        const existing = await PayrollRun.findOne({ school: req.schoolId, year, month }).lean();
        if (existing) {
            return bad(res, `A payroll run for ${monthLabel(month, year)} already exists (${RUN_STAGE[existing.status]?.label || existing.status}).`);
        }

        const settings = await settingsFor(req.schoolId);
        const workingDays = num(req.body.workingDays) > 0
            ? Math.min(31, num(req.body.workingDays))
            : await calc.workingDaysFor(req.schoolId, year, month, settings);
        const { year: acYear } = await resolveYear(req.schoolId, req.body.academicYear);
        const payDay = Math.min(28, Math.max(1, num(settings.payDay) || 1));

        let run;
        try {
            run = await PayrollRun.create({
                school: req.schoolId, month, year,
                runName: trim(req.body.runName) || defaultRunName(month, year),
                academicYear: acYear?._id || null,
                status: 'draft', workingDays,
                payDate: new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, payDay)),
                processedBy: req.userId, processedAt: new Date(),
                notes: trim(req.body.notes),
            });
        } catch (err) {
            // Two admins pressing Create at the same second hit the unique
            // (school, year, month) index. Say so in words rather than leaking
            // a Postgres constraint name.
            if (String(err.message || '').includes('unique') || err.code === '23505' || err.code === 11000) {
                return bad(res, `A payroll run for ${monthLabel(month, year)} already exists.`);
            }
            throw err;
        }

        try {
            const { count, skipped } = await computeRunEntries(req.schoolId, run, settings, { actorId: req.userId });
            await logAudit(req, 'RUN_CREATED', 'PayrollRun', run._id,
                `Created ${defaultRunName(month, year)} for ${count} employee${count === 1 ? '' : 's'}`);
            const fresh = await PayrollRun.findById(run._id).lean();
            return res.status(201).json({ success: true, data: { ...shapeRun(fresh), skipped } });
        } catch (err) {
            // A run that could not be computed is marked failed and kept, with
            // the reason on it — the old engine threw and left a draft run with
            // no entries and nothing to say why.
            await PayrollRun.updateOne({ _id: run._id }, { status: 'failed', failureReason: err.message || 'Computation failed' });
            await logAudit(req, 'RUN_FAILED', 'PayrollRun', run._id, err.message);
            return bad(res, `Payroll could not be computed: ${err.message}`);
        }
    } catch (e) { fail(res, e); }
};

/** Recompute a run in place. Hand-edited and held entries are left alone. */
exports.recomputeRun = async (req, res) => {
    try {
        const run = await PayrollRun.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!run) return bad(res, 'Payroll run not found', 404);
        if (run.status === 'published') return bad(res, 'A published run is locked. Reverse the publish first if it must be recomputed.');
        if (run.status === 'cancelled') return bad(res, 'This run was cancelled.');

        const settings = await settingsFor(req.schoolId);
        const preserve = req.body?.keepEdits !== false;
        if (num(req.body?.workingDays) > 0) {
            await PayrollRun.updateOne({ _id: run._id }, { workingDays: Math.min(31, num(req.body.workingDays)) });
            run.workingDays = Math.min(31, num(req.body.workingDays));
        }
        const { count, skipped } = await computeRunEntries(req.schoolId, run, settings, { preserve, actorId: req.userId });
        await PayrollRun.updateOne({ _id: run._id }, { status: run.status === 'failed' ? 'draft' : run.status, failureReason: '' });
        await logAudit(req, 'RUN_RECOMPUTED', 'PayrollRun', run._id, `Recomputed ${count} entries${preserve ? ' (edits kept)' : ''}`);
        const fresh = await PayrollRun.findById(run._id).lean();
        ok(res, { ...shapeRun(fresh), skipped });
    } catch (e) { fail(res, e); }
};

/** draft → reviewed → approved. Nothing else moves through here. */
exports.updateRunStatus = async (req, res) => {
    try {
        const status = trim(req.body.status);
        // Strictly one step at a time. Turning approval off (settings) lets a
        // REVIEWED run publish without an approve step; it never lets a draft
        // jump the review.
        const FLOW = { reviewed: ['draft'], approved: ['reviewed'] };
        if (!FLOW[status]) return bad(res, 'Status must be one of: reviewed, approved');

        const run = await PayrollRun.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!run) return bad(res, 'Payroll run not found', 404);
        if (run.status === 'published') return bad(res, 'This run is already published.');
        if (run.status === 'cancelled') return bad(res, 'This run was cancelled.');
        if (!FLOW[status].includes(run.status)) {
            return bad(res, `A ${RUN_STAGE[run.status]?.label.toLowerCase() || run.status} run cannot be marked ${status}.`);
        }
        const entryCount = await PayrollEntry.countDocuments({ payrollRun: run._id, isOnHold: false });
        if (!entryCount) return bad(res, 'This run has no payable entries. Recompute it or release a held entry first.');

        // Separation of duties: whoever put the figures together does not get
        // to sign them off as well — unless there is nobody else who could.
        const settings = await settingsFor(req.schoolId);
        if (status === 'approved' && settings.separateApprover !== false
            && String(run.processedBy) === String(req.userId)) {
            if (await approverCount(req.schoolId) > 1) {
                return bad(res, 'You processed this run, so someone else has to approve it. Turn off “separate approver” in Payroll settings if this school works differently.');
            }
        }

        const update = { status };
        if (status === 'reviewed') { update.reviewedBy = req.userId; update.reviewedAt = new Date(); }
        if (status === 'approved') { update.approvedBy = req.userId; update.approvedAt = new Date(); }
        await PayrollRun.updateOne({ _id: run._id }, update);
        await logAudit(req, `RUN_${status.toUpperCase()}`, 'PayrollRun', run._id,
            `${defaultRunName(run.month, run.year)} marked ${status}`, { status: run.status }, { status });
        const fresh = await PayrollRun.findById(run._id).lean();
        ok(res, shapeRun(fresh));
    } catch (e) { fail(res, e); }
};

/**
 * Publish: freeze the run, write one payslip per payable entry, tell everyone.
 *
 * Idempotent by construction. The old version flipped the run to `published`
 * FIRST and then generated payslips in a loop; a failure at slip 40 of 200
 * left a published run, 40 slips, and no way back in (re-publishing was
 * refused because the status was no longer `approved`). Here the slips are
 * written first, the run is flipped only once they all exist, and a slip that
 * already exists for an entry is never written twice.
 */
exports.publishRun = async (req, res) => {
    try {
        const run = await PayrollRun.findOne({ _id: req.params.id, school: req.schoolId });
        if (!run) return bad(res, 'Payroll run not found', 404);
        if (run.status === 'published') return bad(res, 'This run is already published.');
        if (run.status === 'cancelled' || run.status === 'failed') return bad(res, `A ${run.status} run cannot be published.`);

        /**
         * Claim the run before doing any work. Two admins pressing Publish at
         * the same moment both passed the status check above and both went on
         * to issue payslips; this conditional flip means exactly one of them
         * wins, and the loser is told so rather than double-paying everyone.
         *
         * `publishing` is not a status the rest of the module reasons about —
         * it exists for the length of this handler and is replaced by
         * `published` at the end, or put back on failure.
         */
        const claimed = await PayrollRun.updateOne(
            { _id: run._id, school: req.schoolId, status: run.status },
            { status: 'publishing' });
        if (!claimed.modifiedCount) {
            return bad(res, 'Someone else is publishing this run right now.');
        }
        const priorStatus = run.status;
        const unclaim = () => PayrollRun.updateOne({ _id: run._id, status: 'publishing' }, { status: priorStatus });

        const settings = await settingsFor(req.schoolId);
        const needsApproval = settings.requireApproval !== false;
        if (needsApproval && priorStatus !== 'approved') { await unclaim(); return bad(res, 'The run must be approved before it can be published.'); }
        if (!needsApproval && priorStatus === 'draft')   { await unclaim(); return bad(res, 'The run must be reviewed before it can be published.'); }

        // Totals are re-summed immediately before the freeze, so what is
        // published is what the entries actually say.
        await refreshRunTotals(run._id);

        const entries = await PayrollEntry.find({ payrollRun: run._id, isOnHold: false }).lean();
        if (!entries.length) { await unclaim(); return bad(res, 'This run has no payable entries.'); }

        const alreadySlipped = await Payslip.find({ payrollEntry: { $in: entries.map(e => e._id) } })
            .select('payrollEntry').lean();
        const haveSlip = new Set(alreadySlipped.map(p => String(p.payrollEntry)));

        const employeeIds = [...new Set(entries.map(e => String(e.employee)))];
        const [emps, profiles, school] = await Promise.all([
            User.find({ _id: { $in: employeeIds } }).lean(),
            TeacherProfile.find({ user: { $in: employeeIds }, school: req.schoolId }).lean(),
            School.findById(req.schoolId).lean(),
        ]);
        const empById     = new Map(emps.map(u => [String(u._id), u]));
        const profileById = new Map(profiles.map(p => [String(p.user), p]));
        const asgnById    = new Map((await EmployeeSalaryAssignment.find({
            _id: { $in: [...new Set(entries.map(e => e.salaryAssignment).filter(Boolean))] },
        }).select('paymentMode').lean()).map(a => [String(a._id), a]));

        const prefix = trim(settings.payslipPrefix) || 'PS';
        const payable = entries.filter(e => !haveSlip.has(String(e._id)));
        // Continue the year's numbering from the highest slip number already
        // issued, not from a row count — reversing a publish deletes rows, and
        // counting them would hand the next run numbers that have been used.
        let seq = await nextSlipSeq(req.schoolId, run.year, prefix, settings);

        /**
         * Built as a list and written in ONE insert, rather than a create plus
         * an update per employee inside the request. At 500 staff that was a
         * thousand sequential round-trips; a school that size would have
         * watched the request time out halfway and left the run half-published.
         */
        const slipDocs = [];
        for (const entry of payable) {
            const emp     = empById.get(String(entry.employee));
            const profile = profileById.get(String(entry.employee));
            const asgn    = asgnById.get(String(entry.salaryAssignment));
            seq += 1;

            slipDocs.push({
                payrollEntry: entry._id, payrollRun: run._id, employee: entry.employee, school: req.schoolId,
                slipNo: `${prefix}/${run.year}/${String(seq).padStart(4, '0')}`,
                month: run.month, year: run.year,
                employeeSnapshot: {
                    name: emp?.name || '', email: emp?.email || '',
                    employeeId: profile?.employeeId || '',
                    designation: profile?.designation || '', department: profile?.department || '',
                    joiningDate: profile?.joiningDate || null,
                    bankAccountNumber: profile?.bankAccountNumber || '', bankIfsc: profile?.bankIfsc || '',
                    bankName: profile?.bankBranch || '',
                    panNumber: profile?.panNumber || '', uanNumber: profile?.uanNumber || '',
                    paymentMode: asgn?.paymentMode || 'bank_transfer',
                },
                schoolSnapshot: {
                    name: school?.name || '', address: school?.address || '',
                    email: school?.email || '', phone: school?.phone || '',
                },
                earnings: entry.earnings, deductions: entry.deductions,
                employerContributions: entry.employerContributions || [],
                grossSalary: entry.grossSalary, totalDeductions: entry.totalDeductions,
                employerCost: entry.employerCost, netSalary: entry.netSalary,
                workingDays: entry.workingDays, paidDays: entry.paidDays,
                notEmployedDays: entry.notEmployedDays,
                lopDays: entry.lopDays, lopAmount: entry.lopAmount,
                // These three were on the payslip schema all along and were
                // never copied across, so a slip carrying a bonus showed a net
                // that its own lines could not add up to.
                arrears: entry.arrears || 0, bonus: entry.bonus || 0, otherDeductions: entry.otherDeductions || 0,
                overtimeHours: entry.overtimeHours || 0, overtimeAmount: entry.overtimeAmount || 0,
                reimbursement: entry.reimbursement || 0, advanceRecovery: entry.advanceRecovery || 0,
                remarks: entry.remarks || '',
                generatedBy: req.userId,
            });
        }

        if (slipDocs.length) await Payslip.insertMany(slipDocs);

        // Read back what was written (insertMany does not hand ids back) and
        // point each entry at its slip in one statement per batch.
        const written = slipDocs.length
            ? await Payslip.find({ payrollEntry: { $in: payable.map(e => e._id) } })
                .select('_id payrollEntry slipNo').lean()
            : [];
        const slipByEntry = new Map(written.map(x => [String(x.payrollEntry), x]));
        await Promise.all(payable
            .filter(e => slipByEntry.has(String(e._id)))
            .map(e => PayrollEntry.updateOne({ _id: e._id }, { payslip: slipByEntry.get(String(e._id))._id })));

        const created = payable
            .filter(e => slipByEntry.has(String(e._id)))
            .map(e => ({ payslip: slipByEntry.get(String(e._id)), entry: e }));

        await recordSlipSeq(req.schoolId, run.year, seq, settings);

        /**
         * Now the run is really happening, move the ledger: take the advance
         * instalments and mark the reimbursed claims paid. Done here and not at
         * computation time so a draft can be recomputed freely.
         */
        for (const take of (run.pendingRecovery || [])) {
            const adv = await SalaryAdvance.findOne({ _id: take.id, school: req.schoolId });
            if (!adv || adv.status !== 'active') continue;
            adv.recovered = r2(num(adv.recovered) + num(take.amount));
            adv.history.push({ payrollRun: run._id, month: run.month, year: run.year, amount: num(take.amount) });
            if (adv.recovered >= num(adv.amount) - 0.5) {
                adv.status = 'closed';
                adv.closedAt = new Date();
                adv.closeNote = 'Fully recovered';
            }
            await adv.save();
        }
        if ((run.pendingClaims || []).length) {
            await SalaryClaim.updateMany(
                { _id: { $in: run.pendingClaims }, school: req.schoolId, status: 'approved' },
                { status: 'paid', paidInRun: run._id, paidOn: new Date() });
        }

        run.status      = 'published';
        run.publishedBy = req.userId;
        run.publishedAt = new Date();
        await run.save();

        // Notify after the state is safe, and in one call per employee rather
        // than awaiting each in turn inside the request.
        if (settings.notifyOnPublish !== false && created.length) {
            const { renderPayslipBuffer } = require('../utils/payslipPdf');
            const slipById = new Map((await Payslip.find({ _id: { $in: created.map(c => c.payslip._id) } }).lean())
                .map(x => [String(x._id), x]));

            Promise.allSettled(created.map(({ payslip, entry }) => notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '💵 Payslip published',
                body: `Your payslip for ${monthLabel(run.month, run.year)} is now available.\nNet salary: ₹${num(entry.netSalary).toLocaleString('en-IN')}`,
                recipients: [entry.employee],
                email: true,
                // The payslip itself rides along. People forward these to banks
                // and landlords; a link behind a login is no use to them.
                attachmentFor: async () => {
                    const full = slipById.get(String(payslip._id));
                    if (!full) return null;
                    return {
                        filename: `payslip_${MONTHS[run.month - 1]}_${run.year}.pdf`,
                        content: await renderPayslipBuffer(full, school),
                        contentType: 'application/pdf',
                    };
                },
                link: { type: 'payroll.payslips', entityId: payslip._id },
            }))).then((results) => {
                const failed = results.filter(r => r.status === 'rejected').length;
                if (failed) console.warn(`[PayrollAdmin] ${failed} payslip notifications failed for run ${run._id}`);
            });
        }

        await logAudit(req, 'RUN_PUBLISHED', 'PayrollRun', run._id,
            `Published ${defaultRunName(run.month, run.year)} — ${created.length} payslip${created.length === 1 ? '' : 's'}`);
        ok(res, { ...shapeRun(run.toObject ? run.toObject() : run), payslipsCreated: created.length });
    } catch (e) {
        // Never leave the run holding the publish lock: whatever went wrong,
        // the next person to press Publish has to be able to try again.
        try { await PayrollRun.updateOne({ _id: req.params.id, status: 'publishing' }, { status: 'approved' }); }
        catch { /* the flip below is best effort */ }
        fail(res, e);
    }
};

/**
 * The highest payslip number issued this year, so numbering never repeats.
 *
 * Read from BOTH the live rows and the stored high-water mark, and the higher
 * wins. The rows alone are not enough: reversing a publish deletes them, and
 * the next publish would reissue numbers that have already been sent out. The
 * mark alone is not enough either — it did not exist before this redesign, so
 * a school with payslips already on file has to be read from the rows once.
 */
async function nextSlipSeq(schoolId, year, prefix, settings) {
    const { $, list } = params();
    const { rows } = await pool.query(`
      SELECT COALESCE(MAX(NULLIF(regexp_replace("slipNo", '^.*/', ''), '')::int), 0) AS "n"
        FROM ${T(Payslip)}
       WHERE "school" = ${$(String(schoolId))} AND "year" = ${$(num(year))}
         AND "slipNo" ~ ${$(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[0-9]+/[0-9]+$`)}`, list);
    const stored = num((settings?.payslipSeq || {})[String(year)]);
    return Math.max(num(rows[0]?.n), stored);
}

/** Record the highest number issued, so it is never handed out twice. */
async function recordSlipSeq(schoolId, year, seq, settings) {
    const map = { ...(settings?.payslipSeq || {}) };
    if (num(map[String(year)]) >= seq) return;
    map[String(year)] = seq;
    try { await PayrollSettings.updateOne({ school: schoolId }, { payslipSeq: map }, { upsert: true }); }
    catch (e) { console.warn('[PayrollAdmin] payslip counter not stored:', e.message); }
}

/**
 * Reverse a publish: delete the payslips this run created and return it to
 * approved. Deliberately explicit and audited — there was no way back at all
 * before, so a run published with a wrong figure could only be fixed in the
 * database.
 */
exports.unpublishRun = async (req, res) => {
    try {
        const run = await PayrollRun.findOne({ _id: req.params.id, school: req.schoolId });
        if (!run) return bad(res, 'Payroll run not found', 404);
        if (run.status !== 'published') return bad(res, 'Only a published run can be reversed.');

        const entries = await PayrollEntry.find({ payrollRun: run._id }).select('_id').lean();
        const ids = entries.map(e => e._id);
        const slips = await Payslip.find({ payrollEntry: { $in: ids } }).select('_id').lean();
        if (slips.length) await Payslip.deleteMany({ _id: { $in: slips.map(s => s._id) } });
        await PayrollEntry.updateMany({ payrollRun: run._id }, { payslip: null });

        // Put the ledger back exactly as publish moved it: give the advance
        // instalments back and return the claims to approved-but-unpaid.
        for (const take of (run.pendingRecovery || [])) {
            const adv = await SalaryAdvance.findOne({ _id: take.id, school: req.schoolId });
            if (!adv) continue;
            adv.recovered = r2(Math.max(0, num(adv.recovered) - num(take.amount)));
            adv.history = (adv.history || []).filter(h => String(h.payrollRun) !== String(run._id));
            if (adv.status === 'closed' && adv.recovered < num(adv.amount)) {
                adv.status = 'active'; adv.closedAt = null; adv.closeNote = '';
            }
            await adv.save();
        }
        if ((run.pendingClaims || []).length) {
            await SalaryClaim.updateMany(
                { _id: { $in: run.pendingClaims }, school: req.schoolId, paidInRun: run._id },
                { status: 'approved', paidInRun: null, paidOn: null });
        }

        run.status = 'approved';
        run.publishedBy = null; run.publishedAt = null;
        await run.save();
        await logAudit(req, 'RUN_UNPUBLISHED', 'PayrollRun', run._id,
            `Reversed ${defaultRunName(run.month, run.year)} — ${slips.length} payslip${slips.length === 1 ? '' : 's'} withdrawn`);
        ok(res, shapeRun(run.toObject ? run.toObject() : run));
    } catch (e) { fail(res, e); }
};

exports.cancelRun = async (req, res) => {
    try {
        const run = await PayrollRun.findOne({ _id: req.params.id, school: req.schoolId });
        if (!run) return bad(res, 'Payroll run not found', 404);
        if (run.status === 'published') return bad(res, 'A published run cannot be cancelled. Reverse the publish first.');
        run.status = 'cancelled';
        run.cancelledBy = req.userId; run.cancelledAt = new Date();
        run.notes = trim(req.body?.reason) || run.notes;
        await run.save();
        await PayrollEntry.deleteMany({ payrollRun: run._id });
        await PayrollRun.updateOne({ _id: run._id }, { totalEmployees: 0, totalGross: 0, totalDeductions: 0, totalNet: 0, totalLop: 0, totalEmployerCost: 0 });
        await logAudit(req, 'RUN_CANCELLED', 'PayrollRun', run._id, trim(req.body?.reason) || 'Cancelled');
        const fresh = await PayrollRun.findById(run._id).lean();
        ok(res, shapeRun(fresh));
    } catch (e) { fail(res, e); }
};

/**
 * Delete a run outright. Only ever allowed while nothing has been published —
 * a published month is a financial record, and the way back from one is
 * `unpublish`, which leaves a trail.
 */
exports.deleteRun = async (req, res) => {
    try {
        const run = await PayrollRun.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!run) return bad(res, 'Payroll run not found', 404);
        if (run.status === 'published') return bad(res, 'A published run cannot be deleted. Reverse the publish first.');
        const slips = await Payslip.countDocuments({ payrollRun: run._id });
        if (slips) return bad(res, 'Payslips exist for this run. Reverse the publish first.');
        await PayrollEntry.deleteMany({ payrollRun: run._id });
        await PayrollRun.deleteOne({ _id: run._id });
        await logAudit(req, 'RUN_DELETED', 'PayrollRun', run._id, `Deleted ${defaultRunName(run.month, run.year)}`);
        ok(res, { _id: run._id });
    } catch (e) { fail(res, e); }
};

// ── Entries ──────────────────────────────────────────────────────────────────

/**
 * Edit one person's line in a run.
 *
 * Two modes. Change the inputs (loss-of-pay days, units worked, arrears, a
 * bonus) and the line is recomputed through the same engine the run used, so
 * every dependent figure — pro-rated allowances, PF on the reduced basic, the
 * net — moves together. Send explicit `earnings`/`deductions` and those lines
 * are taken literally, for the cases no rule covers.
 *
 * Either way the run's totals are re-summed. The previous version recomputed
 * the entry and left the run row stating the pre-edit figures.
 */
exports.updateEntry = async (req, res) => {
    try {
        const run = await PayrollRun.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!run) return bad(res, 'Payroll run not found', 404);
        if (run.status === 'published') return bad(res, 'A published run is locked. Reverse the publish to change an entry.');
        if (run.status === 'cancelled') return bad(res, 'This run was cancelled.');

        const entry = await PayrollEntry.findOne({ _id: req.params.entryId, payrollRun: run._id, school: req.schoolId });
        if (!entry) return bad(res, 'Entry not found', 404);

        const before = {
            grossSalary: entry.grossSalary, totalDeductions: entry.totalDeductions,
            netSalary: entry.netSalary, lopDays: entry.lopDays,
        };
        const b = req.body || {};
        const settings = await settingsFor(req.schoolId);

        const adj = {
            arrears: b.arrears !== undefined ? num(b.arrears) : num(entry.arrears),
            bonus: b.bonus !== undefined ? num(b.bonus) : num(entry.bonus),
            otherDeductions: b.otherDeductions !== undefined ? num(b.otherDeductions) : num(entry.otherDeductions),
        };
        if (adj.arrears < 0 || adj.bonus < 0 || adj.otherDeductions < 0) return bad(res, 'Adjustments cannot be negative');

        /**
         * A one-off adjustment above a year's gross is almost always a typo —
         * a ₹10,00,00,000 bonus was accepted silently before this. The ceiling
         * is deliberately generous and can be overridden with `force`, because
         * a genuine settlement or a long arrears catch-up can be large.
         */
        const ceiling = Math.max(100000, r2(num(entry.grossSalary) * 12));
        for (const [key, label] of [['arrears', 'Arrears'], ['bonus', 'A bonus'], ['otherDeductions', 'A deduction']]) {
            if (adj[key] > ceiling && b.force !== true) {
                return bad(res, `${label} of ${inr(adj[key])} is more than a year's gross pay for this employee (${inr(ceiling)}). Confirm to record it anyway.`);
            }
        }

        const lopDays = b.lopDays !== undefined
            ? Math.max(0, Math.min(num(entry.workingDays) || 26, num(b.lopDays)))
            : num(entry.lopDays);
        const units = b.units !== undefined ? Math.max(0, num(b.units)) : num(entry.units);

        // Overtime is an earning: taxable, inside gross, and therefore added to
        // the lines rather than bolted onto the net the way a bonus is.
        const otHours = b.overtimeHours !== undefined ? Math.max(0, num(b.overtimeHours)) : num(entry.overtimeHours);
        const otRate  = b.overtimeRate  !== undefined ? Math.max(0, num(b.overtimeRate))  : num(entry.overtimeRate);
        if (otHours > 744) return bad(res, 'There are not that many hours in a month');

        if (Array.isArray(b.earnings) || Array.isArray(b.deductions)) {
            const clean = (list, fallback) => (Array.isArray(list)
                ? list.filter(x => x && trim(x.name)).map(x => ({ name: trim(x.name), code: trim(x.code), amount: r2(x.amount), fullAmount: r2(x.fullAmount ?? x.amount) }))
                : fallback);
            entry.earnings   = clean(b.earnings, entry.earnings);
            entry.deductions = clean(b.deductions, entry.deductions);
            entry.grossSalary     = r2(entry.earnings.reduce((s, x) => s + num(x.amount), 0));
            entry.totalDeductions = r2(entry.deductions.reduce((s, x) => s + num(x.amount), 0));
            entry.lopAmount = r2(Math.max(0, entry.earnings.reduce((s, x) => s + num(x.fullAmount), 0) - entry.grossSalary));
        } else {
            const structure = entry.structure ? await SalaryStructure.findOne({ _id: entry.structure, school: req.schoolId }).lean() : null;
            const asgn = entry.salaryAssignment
                ? await EmployeeSalaryAssignment.findOne({ _id: entry.salaryAssignment, school: req.schoolId }).lean()
                : null;
            if (!structure) return bad(res, 'This entry has no salary structure, so it cannot be recomputed. Edit the lines directly instead.');
            const pay = calc.computePay({
                structure,
                annualCtc: asgn ? EmployeeSalaryAssignment.activeCtc(asgn, run.year, run.month) : num(entry.annualCtc),
                overrides: asgn?.componentOverrides || [],
                lopDays, units,
                notEmployedDays: num(entry.notEmployedDays),
                workingDays: num(entry.workingDays) || num(run.workingDays),
                ...adj,
                roundTo: settings.roundTo,
            });
            entry.earnings = pay.earnings; entry.deductions = pay.deductions;
            // computePay() knows nothing about overtime; it is added back here
            // so a recompute does not quietly drop it.
            const otAmount = calc.roundAmount(otHours * otRate, settings.roundTo);
            if (otAmount > 0) {
                entry.earnings = [...pay.earnings, { name: 'Overtime', code: 'OT', amount: otAmount, fullAmount: otAmount }];
                pay.grossSalary = r2(pay.grossSalary + otAmount);
            }
            entry.employerContributions = pay.employerContributions;
            entry.grossSalary = pay.grossSalary; entry.totalDeductions = pay.totalDeductions;
            entry.employerCost = pay.employerCost;
            entry.lopAmount = pay.lopAmount; entry.paidDays = pay.paidDays;
            entry.notEmployedDays = pay.notEmployedDays;
            entry.annualCtc = pay.annualCtc;
        }

        entry.lopDays = lopDays;
        if (b.lopDays !== undefined) entry.lopSource = lopDays > 0 ? 'manual' : 'none';
        entry.units = units;
        entry.overtimeHours = otHours;
        entry.overtimeRate = otRate;
        entry.overtimeAmount = calc.roundAmount(otHours * otRate, settings.roundTo);
        entry.arrears = adj.arrears; entry.bonus = adj.bonus; entry.otherDeductions = adj.otherDeductions;
        if (b.remarks !== undefined) entry.remarks = trim(b.remarks).slice(0, 500);
        entry.paidDays = r2(Math.max(0, (num(entry.workingDays) || 26) - num(entry.notEmployedDays) - lopDays));
        // Net never goes below zero — see services/payrollCalc.js. What could
        // not be taken this month is carried on the entry rather than turned
        // into a payslip that says the employee owes the school money.
        const rawNet = num(entry.grossSalary) - num(entry.totalDeductions)
            + adj.arrears + adj.bonus + num(entry.reimbursement)
            - adj.otherDeductions - num(entry.advanceRecovery);
        entry.netSalary  = calc.roundAmount(Math.max(0, rawNet), settings.roundTo);
        entry.unrecovered = calc.roundAmount(Math.max(0, -rawNet), settings.roundTo);
        entry.isEdited = true;
        await entry.save();

        await refreshRunTotals(run._id);
        await logAudit(req, 'ENTRY_UPDATED', 'PayrollEntry', entry._id,
            `Entry edited in ${defaultRunName(run.month, run.year)}`, before,
            { grossSalary: entry.grossSalary, totalDeductions: entry.totalDeductions, netSalary: entry.netSalary, lopDays: entry.lopDays });

        const fresh = await PayrollRun.findById(run._id).lean();
        ok(res, { entry: entry.toObject ? entry.toObject() : entry, run: shapeRun(fresh) });
    } catch (e) { fail(res, e); }
};

/** Withhold one person's pay without blocking the month. */
exports.holdEntry = async (req, res) => {
    try {
        const run = await PayrollRun.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!run) return bad(res, 'Payroll run not found', 404);
        if (run.status === 'published') return bad(res, 'A published run is locked.');
        const entry = await PayrollEntry.findOne({ _id: req.params.entryId, payrollRun: run._id, school: req.schoolId });
        if (!entry) return bad(res, 'Entry not found', 404);

        entry.isOnHold = req.body?.hold !== undefined ? !!req.body.hold : !entry.isOnHold;
        if (entry.isOnHold && trim(req.body?.reason)) entry.remarks = trim(req.body.reason).slice(0, 500);
        await entry.save();
        await refreshRunTotals(run._id);
        await logAudit(req, entry.isOnHold ? 'ENTRY_HELD' : 'ENTRY_RELEASED', 'PayrollEntry', entry._id,
            `${entry.isOnHold ? 'Held' : 'Released'} in ${defaultRunName(run.month, run.year)}`);
        const fresh = await PayrollRun.findById(run._id).lean();
        ok(res, { entry: entry.toObject ? entry.toObject() : entry, run: shapeRun(fresh) });
    } catch (e) { fail(res, e); }
};

// ── Exports ──────────────────────────────────────────────────────────────────

const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (columns, rows) => [
    columns.map(c => csvCell(c.label)).join(','),
    ...rows.map(r => columns.map(c => csvCell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(',')),
].join('\n');

function sendCsv(res, filename, columns, rows) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // A BOM so Excel opens ₹ and Indian names correctly instead of as mojibake.
    res.send('﻿' + toCsv(columns, rows));
}

/**
 * The salary register for one run: every employee, every line, one row each.
 * Columns follow the components actually used, so a school that renamed HRA
 * gets its own wording back.
 */
exports.exportRun = async (req, res) => {
    try {
        const id = uuidOr(req.params.id);
        if (!id) return bad(res, 'Run not found', 404);
        const run = await PayrollRun.findOne({ _id: id, school: req.schoolId }).lean();
        if (!run) return bad(res, 'Payroll run not found', 404);

        const { $, list } = params();
        const { rows } = await pool.query(`
          SELECT e.*, u."name" AS "employeeName", u."email" AS "employeeEmail",
                 tp."employeeId" AS "empCode", tp."department", tp."designation",
                 tp."bankAccountNumber", tp."bankIfsc", tp."panNumber", tp."uanNumber"
            FROM ${T(PayrollEntry)} e
            JOIN ${T(User)} u ON u."_id" = e."employee"
            LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = e."school"
           WHERE e."payrollRun" = ${$(id)}
           ORDER BY u."name"`, list);

        const earningNames   = [...new Set(rows.flatMap(r => (r.earnings || []).map(x => x.name)))];
        const deductionNames = [...new Set(rows.flatMap(r => (r.deductions || []).map(x => x.name)))];
        const amountOf = (list2, name) => r2((list2 || []).find(x => x.name === name)?.amount);

        const columns = [
            { label: 'Employee ID', value: r => r.empCode || '' },
            { label: 'Name', value: r => r.employeeName },
            { label: 'Department', value: r => r.department || '' },
            { label: 'Designation', value: r => r.designation || '' },
            { label: 'PAN', value: r => r.panNumber || '' },
            { label: 'UAN', value: r => r.uanNumber || '' },
            { label: 'Bank A/C', value: r => r.bankAccountNumber || '' },
            { label: 'IFSC', value: r => r.bankIfsc || '' },
            { label: 'Annual CTC', value: r => r2(r.annualCtc) },
            { label: 'Working Days', value: r => num(r.workingDays) },
            { label: 'Paid Days', value: r => num(r.paidDays) },
            { label: 'LOP Days', value: r => num(r.lopDays) },
            ...earningNames.map(n => ({ label: n, value: r => amountOf(r.earnings, n) })),
            { label: 'Gross', value: r => r2(r.grossSalary) },
            ...deductionNames.map(n => ({ label: n, value: r => amountOf(r.deductions, n) })),
            { label: 'Total Deductions', value: r => r2(r.totalDeductions) },
            { label: 'Arrears', value: r => r2(r.arrears) },
            { label: 'Bonus', value: r => r2(r.bonus) },
            { label: 'Other Deductions', value: r => r2(r.otherDeductions) },
            { label: 'Net Pay', value: r => r2(r.netSalary) },
            { label: 'Status', value: r => (r.isOnHold ? 'On hold' : 'Payable') },
            { label: 'Remarks', value: r => r.remarks || '' },
        ];
        sendCsv(res, `salary_register_${shortLabel(run.month, run.year).replace(' ', '_')}.csv`, columns, rows);
    } catch (e) { fail(res, e); }
};

/**
 * The bank transfer file: only rows that are actually being paid by transfer,
 * and only rows with an account to pay into. Anything missing a bank detail is
 * listed in the `X-Payroll-Skipped` header count rather than silently dropped.
 */
exports.bankFile = async (req, res) => {
    try {
        const id = uuidOr(req.params.id);
        if (!id) return bad(res, 'Run not found', 404);
        const run = await PayrollRun.findOne({ _id: id, school: req.schoolId }).lean();
        if (!run) return bad(res, 'Payroll run not found', 404);
        const settings = await settingsFor(req.schoolId);

        const { $, list } = params();
        const { rows } = await pool.query(`
          SELECT e."netSalary", u."name" AS "employeeName", tp."employeeId" AS "empCode",
                 tp."bankAccountNumber", tp."bankIfsc", tp."bankAccountHolder",
                 COALESCE(a."paymentMode", 'bank_transfer') AS "paymentMode"
            FROM ${T(PayrollEntry)} e
            JOIN ${T(User)} u ON u."_id" = e."employee"
            LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = e."school"
            LEFT JOIN ${T(EmployeeSalaryAssignment)} a ON a."_id" = e."salaryAssignment"
           WHERE e."payrollRun" = ${$(id)} AND COALESCE(e."isOnHold", false) = false
           ORDER BY u."name"`, list);

        const payable = rows.filter(r => r.paymentMode === 'bank_transfer' && trim(r.bankAccountNumber));
        res.setHeader('X-Payroll-Skipped', String(rows.length - payable.length));
        res.setHeader('Access-Control-Expose-Headers', 'X-Payroll-Skipped');
        const columns = [
            { label: 'Beneficiary Name', value: r => trim(r.bankAccountHolder) || r.employeeName },
            { label: 'Employee ID', value: r => r.empCode || '' },
            { label: 'Account Number', value: r => r.bankAccountNumber },
            { label: 'IFSC', value: r => r.bankIfsc || '' },
            { label: 'Amount', value: r => r2(r.netSalary) },
            { label: 'Debit Account', value: () => settings.bankAccountNumber || '' },
            { label: 'Narration', value: () => `SALARY ${shortLabel(run.month, run.year).toUpperCase()}` },
        ];
        sendCsv(res, `bank_transfer_${shortLabel(run.month, run.year).replace(' ', '_')}.csv`, columns, payable);
    } catch (e) { fail(res, e); }
};

// ── Assignments ──────────────────────────────────────────────────────────────

/**
 * An assignment's state is derived, never stored twice: a row can be switched
 * off (`isActive`), can have run out (`endDate` in the past) or can not have
 * started yet (`effectiveDate` in the future). One expression, so the list,
 * the filter and the tiles can never disagree about what "active" means.
 */
const ASSIGN_STATE = `
  CASE WHEN NOT COALESCE(a."isActive", true) THEN 'inactive'
       WHEN a."endDate" IS NOT NULL AND a."endDate" < now() THEN 'ended'
       WHEN a."effectiveDate" > now() THEN 'pending'
       ELSE 'active' END`;

exports.listAssignments = async (req, res) => {
    try {
        const { page, limit, offset } = pageArgs(req.query, 10);
        const { $, list } = params();
        const where = [`a."school" = ${$(String(req.schoolId))}`, employeeWhere($, req.schoolId, 'u')];

        const search = trim(req.query.search);
        if (search) {
            const like = $(`%${search}%`);
            where.push(`(u."name" ILIKE ${like} OR u."email" ILIKE ${like}
                         OR COALESCE(tp."employeeId", '') ILIKE ${like}
                         OR COALESCE(tp."department", '') ILIKE ${like}
                         OR COALESCE(tp."designation", '') ILIKE ${like}
                         OR COALESCE(s."name", '') ILIKE ${like})`);
        }
        const dept = trim(req.query.department);
        if (dept === 'Unassigned') where.push(`COALESCE(tp."department", '') = ''`);
        else if (dept) where.push(`COALESCE(tp."department", '') = ${$(dept)}`);
        const type = trim(req.query.type);
        if (type) where.push(`COALESCE(s."type", 'general') = ${$(type)}`);
        const status = trim(req.query.status) || 'active';
        if (status === 'active')   where.push(`${ASSIGN_STATE} = 'active'`);
        if (status === 'pending')  where.push(`${ASSIGN_STATE} = 'pending'`);
        if (status === 'inactive') where.push(`${ASSIGN_STATE} IN ('inactive','ended')`);

        const { year: acYear, years } = await resolveYear(req.schoolId, req.query.academicYear);
        if (acYear && req.query.academicYear !== 'all') {
            // Assignments written before the academicYear column existed carry
            // null, so they are matched on their effective date instead of
            // disappearing from every year's list.
            where.push(`(a."academicYear" = ${$(String(acYear._id))}
                      OR (a."academicYear" IS NULL AND a."effectiveDate" <= ${$(new Date(acYear.endDate))}))`);
        }

        const joins = `
            FROM ${T(EmployeeSalaryAssignment)} a
            JOIN ${T(User)} u ON u."_id" = a."employee"
            LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = a."school"
            LEFT JOIN ${T(SalaryStructure)} s ON s."_id" = a."structure"
            LEFT JOIN ${T(AcademicYear)} y ON y."_id" = a."academicYear"`;
        const from = `${joins} WHERE ${where.join(' AND ')}`;

        const [rows, cnt] = await Promise.all([
            pool.query(`
              SELECT a."_id", a."employee", a."structure", a."ctc", a."effectiveDate", a."endDate",
                     a."paymentMode", a."isActive", a."notes", a."componentOverrides", a."createdAt",
                     ${ASSIGN_STATE} AS "state",
                     u."name" AS "employeeName", u."email" AS "employeeEmail", u."role" AS "employeeRole",
                     tp."employeeId" AS "empCode", tp."department", tp."designation", tp."joiningDate",
                     tp."bankAccountNumber",
                     s."name" AS "structureName", s."type" AS "structureType",
                     s."payBasis", s."rate", s."rateUnit",
                     y."yearName" AS "academicYearName",
                     jsonb_array_length(COALESCE(a."ctcRevisions", '[]'::jsonb)) AS "revisions"
                ${from}
               ORDER BY u."name" ASC
               LIMIT ${limit} OFFSET ${offset}`, list),
            pool.query(`SELECT COUNT(*)::int AS "n" ${from}`, list),
        ]);

        const s = params();
        const [{ rows: tileRows }, { rows: staffRows }, { rows: deptRows }] = await Promise.all([
            pool.query(`
              SELECT ${ASSIGN_STATE} AS "state", COUNT(*)::int AS "n"
                FROM ${T(EmployeeSalaryAssignment)} a
                JOIN ${T(User)} u ON u."_id" = a."employee"
               WHERE a."school" = ${s.$(String(req.schoolId))} AND ${employeeWhere(s.$, req.schoolId, 'u')}
               GROUP BY 1`, s.list),
            (async () => { const q = params(); return pool.query(`SELECT COUNT(*)::int AS "n" FROM ${T(User)} u WHERE ${employeeWhere(q.$, req.schoolId, 'u')}`, q.list); })(),
            (async () => {
                const q = params();
                return pool.query(`
                  SELECT COALESCE(NULLIF(tp."department", ''), 'Unassigned') AS "name", COUNT(*)::int AS "n"
                    FROM ${T(User)} u
                    LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = u."school"
                   WHERE ${employeeWhere(q.$, req.schoolId, 'u')}
                   GROUP BY 1 ORDER BY 1`, q.list);
            })(),
        ]);
        const byState = Object.fromEntries(tileRows.map(r => [r.state, num(r.n)]));
        const total = num(cnt.rows[0]?.n);

        ok(res, rows.rows.map(shapeAssignment), {
            summary: {
                totalEmployees: num(staffRows[0]?.n),
                active: byState.active || 0,
                pending: byState.pending || 0,
                inactive: (byState.inactive || 0) + (byState.ended || 0),
            },
            departments: deptRows.map(r => ({ name: r.name, count: num(r.n) })),
            total, page, pages: Math.max(1, Math.ceil(total / limit)), limit,
            academicYear: yearOut(acYear), academicYears: years.map(yearOut),
        });
    } catch (e) { fail(res, e); }
};

const ASSIGN_STATE_LABEL = { active: 'Active', pending: 'Pending', inactive: 'Inactive', ended: 'Ended' };

function shapeAssignment(a) {
    const monthly = r2(num(a.ctc) / 12);
    return {
        _id: a._id,
        employee: {
            _id: a.employee, name: a.employeeName, email: a.employeeEmail,
            employeeId: a.empCode || '', department: a.department || '',
            designation: a.designation || '', joiningDate: a.joiningDate || null,
            role: a.employeeRole, hasBank: !!trim(a.bankAccountNumber),
        },
        structure: a.structure ? {
            _id: a.structure, name: a.structureName || '—', type: a.structureType || 'general',
            payBasis: a.payBasis || 'monthly', rate: r2(a.rate), rateUnit: a.rateUnit || 'class',
        } : null,
        ctc: r2(a.ctc), monthlyCtc: monthly,
        effectiveDate: a.effectiveDate, endDate: a.endDate,
        paymentMode: a.paymentMode || 'bank_transfer',
        academicYearName: a.academicYearName || null,
        state: a.state, stateLabel: ASSIGN_STATE_LABEL[a.state] || a.state,
        isActive: a.isActive !== false,
        overrides: a.componentOverrides || [],
        revisions: num(a.revisions),
        notes: a.notes || '',
        createdAt: a.createdAt,
    };
}

/** One assignment, with the pay it produces and its CTC timeline. */
exports.getAssignment = async (req, res) => {
    try {
        const id = uuidOr(req.params.id);
        if (!id) return bad(res, 'Assignment not found', 404);
        const { $, list } = params();
        const { rows } = await pool.query(`
          SELECT a.*, ${ASSIGN_STATE} AS "state",
                 u."name" AS "employeeName", u."email" AS "employeeEmail", u."role" AS "employeeRole",
                 tp."employeeId" AS "empCode", tp."department", tp."designation", tp."joiningDate",
                 tp."bankAccountNumber",
                 s."name" AS "structureName", s."type" AS "structureType", s."payBasis", s."rate", s."rateUnit",
                 y."yearName" AS "academicYearName"
            FROM ${T(EmployeeSalaryAssignment)} a
            JOIN ${T(User)} u ON u."_id" = a."employee"
            LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = a."school"
            LEFT JOIN ${T(SalaryStructure)} s ON s."_id" = a."structure"
            LEFT JOIN ${T(AcademicYear)} y ON y."_id" = a."academicYear"
           WHERE a."_id" = ${$(id)} AND a."school" = ${$(String(req.schoolId))}`, list);
        if (!rows.length) return bad(res, 'Assignment not found', 404);
        const row = rows[0];

        const settings = await settingsFor(req.schoolId);
        const structure = row.structure ? await SalaryStructure.findOne({ _id: row.structure, school: req.schoolId }).lean() : null;
        const now = new Date();
        // The CTC in force THIS month, which is what the breakdown below is
        // computed on. It is not always the stored `ctc`: a revision dated next
        // November is already on the timeline but is not what October pays, and
        // showing the stored figure beside a breakdown built from a different
        // one made the panel contradict itself.
        const activeCtc = EmployeeSalaryAssignment.activeCtc(row, now.getFullYear(), now.getMonth() + 1);
        const pending = [...(row.ctcRevisions || [])]
            .filter(r => r.effectiveYear > now.getFullYear()
                || (r.effectiveYear === now.getFullYear() && r.effectiveMonth > now.getMonth() + 1))
            .sort((a, b) => (a.effectiveYear - b.effectiveYear) || (a.effectiveMonth - b.effectiveMonth))[0] || null;
        const breakdown = structure ? calc.computePay({
            structure,
            annualCtc: activeCtc,
            overrides: row.componentOverrides || [],
            workingDays: await calc.workingDaysFor(req.schoolId, now.getFullYear(), now.getMonth() + 1, settings),
            roundTo: settings.roundTo,
        }) : null;

        // What this person has actually been paid, newest first.
        const h = params();
        const { rows: history } = await pool.query(`
          SELECT e."month", e."year", e."grossSalary", e."netSalary", e."lopDays", r."status"
            FROM ${T(PayrollEntry)} e
            JOIN ${T(PayrollRun)} r ON r."_id" = e."payrollRun"
           WHERE e."employee" = ${h.$(String(row.employee))} AND e."school" = ${h.$(String(req.schoolId))}
             AND r."status" = 'published'
           ORDER BY e."year" DESC, e."month" DESC LIMIT 12`, h.list);

        ok(res, {
            ...shapeAssignment(row),
            activeCtc: r2(activeCtc),
            activeMonthlyCtc: r2(activeCtc / 12),
            activeMonthLabel: monthLabel(now.getMonth() + 1, now.getFullYear()),
            pendingRevision: pending ? {
                annualCtc: r2(pending.annualCtc),
                effectiveLabel: monthLabel(pending.effectiveMonth, pending.effectiveYear),
                note: pending.note || '',
            } : null,
            ctcRevisions: [...(row.ctcRevisions || [])].sort((x, y2) =>
                (y2.effectiveYear - x.effectiveYear) || (y2.effectiveMonth - x.effectiveMonth)),
            breakdown,
            payHistory: history.map(x => ({
                month: x.month, year: x.year, label: shortLabel(x.month, x.year),
                gross: r2(x.grossSalary), net: r2(x.netSalary), lopDays: num(x.lopDays),
            })),
        });
    } catch (e) { fail(res, e); }
};

/** Employees available to assign, and the ones already covered. */
exports.getEmployees = async (req, res) => {
    try {
        const { page, limit, offset } = pageArgs(req.query, 200);
        const { $, list } = params();
        const where = [employeeWhere($, req.schoolId, 'u')];
        const search = trim(req.query.search);
        if (search) {
            const like = $(`%${search}%`);
            where.push(`(u."name" ILIKE ${like} OR u."email" ILIKE ${like} OR COALESCE(tp."employeeId", '') ILIKE ${like})`);
        }
        if (trim(req.query.department)) where.push(`COALESCE(tp."department", '') = ${$(trim(req.query.department))}`);
        if (req.query.unassigned === '1' || req.query.unassigned === 'true') {
            where.push(`NOT EXISTS (SELECT 1 FROM ${T(EmployeeSalaryAssignment)} a
                                     WHERE a."employee" = u."_id" AND a."school" = u."school"
                                       AND COALESCE(a."isActive", true))`);
        }
        const { rows } = await pool.query(`
          SELECT u."_id", u."name", u."email", u."role",
                 tp."employeeId" AS "empCode", tp."department", tp."designation", tp."joiningDate",
                 tp."bankAccountNumber", ${staffBucketSql('u', 'tp')} AS "bucket",
                 a."_id" AS "assignmentId", a."ctc", s."name" AS "structureName"
            FROM ${T(User)} u
            LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = u."school"
            LEFT JOIN LATERAL (
                 SELECT x."_id", x."ctc", x."structure" FROM ${T(EmployeeSalaryAssignment)} x
                  WHERE x."employee" = u."_id" AND x."school" = u."school" AND COALESCE(x."isActive", true)
                  ORDER BY x."effectiveDate" DESC LIMIT 1) a ON true
            LEFT JOIN ${T(SalaryStructure)} s ON s."_id" = a."structure"
           WHERE ${where.join(' AND ')}
           ORDER BY u."name" ASC
           LIMIT ${limit + 1} OFFSET ${offset}`, list);
        // A school with more staff than one page used to lose the rest of them
        // silently — the picker just stopped at 500 with no way to know.
        const more = rows.length > limit;
        ok(res, rows.slice(0, limit).map(r => ({
            _id: r._id, name: r.name, email: r.email, role: r.role,
            employeeId: r.empCode || '', department: r.department || '', designation: r.designation || '',
            joiningDate: r.joiningDate || null, hasBank: !!trim(r.bankAccountNumber), bucket: r.bucket,
            assignmentId: r.assignmentId || null, ctc: r2(r.ctc), structureName: r.structureName || null,
        })), { page, limit, hasMore: more });
    } catch (e) { fail(res, e); }
};

/** A YYYY-MM-DD (or any parseable date) as a UTC midnight, or null. */
const asDate = (v) => {
    if (!v) return null;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(`${v}T00:00:00Z`) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Everything an assignment must satisfy before it is written. Shared by the
 * single and the bulk path so a bulk upload cannot create a row the form would
 * have refused.
 */
async function validateAssignment(schoolId, { employeeId, structureId, effectiveDate, endDate, annualCtc, ignoreId }) {
    if (!uuidOr(employeeId))  return 'Choose an employee';
    if (!uuidOr(structureId)) return 'Choose a salary structure';
    const eff = asDate(effectiveDate);
    if (!eff) return 'Choose a start date';
    const end = asDate(endDate);
    if (end && end < eff) return 'The end date cannot be before the start date';

    // The employee must belong to THIS school. Nothing checked this before, so
    // a crafted request could put another school's staff on this payroll.
    const emp = await User.findOne({ _id: employeeId, school: schoolId, role: { $in: EMPLOYEE_ROLES } }).select('_id name isActive').lean();
    if (!emp) return 'That employee is not on this school’s staff';

    const structure = await SalaryStructure.findOne({ _id: structureId, school: schoolId }).select('_id name isActive payBasis').lean();
    if (!structure) return 'That salary structure does not exist';
    if (structure.isActive === false) return `“${structure.name}” is inactive — activate it first`;

    if (structure.payBasis !== 'rate' && !(num(annualCtc) > 0)) return 'Enter the annual CTC';
    if (num(annualCtc) < 0) return 'The annual CTC cannot be negative';

    // One live assignment per employee: two of them produced two entries for
    // one person in a run, which the unique (run, employee) index rejected —
    // and that rejection took the entire run down.
    const clash = await EmployeeSalaryAssignment.findOne({
        school: schoolId, employee: employeeId, isActive: true,
        ...(ignoreId ? { _id: { $ne: ignoreId } } : {}),
    }).select('_id endDate').lean();
    if (clash && (!clash.endDate || new Date(clash.endDate) >= eff)) {
        return `${emp.name} already has an active salary assignment. End it, or edit that one instead.`;
    }
    return null;
}

exports.assignEmployee = async (req, res) => {
    try {
        const b = req.body || {};
        // The old web form posted { employee, structure, effectiveFrom } while
        // the API required { employeeId, structureId, effectiveDate } — so
        // every assignment created from the UI failed with a 400. Both
        // spellings are accepted here and the screen sends the new one.
        const employeeId  = b.employeeId  || b.employee;
        const structureId = b.structureId || b.structure;
        const effectiveDate = b.effectiveDate || b.effectiveFrom;
        const annualCtc = num(b.annualCtc ?? b.ctc);

        const error = await validateAssignment(req.schoolId, { employeeId, structureId, effectiveDate, endDate: b.endDate, annualCtc });
        if (error) return bad(res, error);

        const eff = asDate(effectiveDate);
        const { year: acYear } = await resolveYear(req.schoolId, b.academicYear);
        const assignment = await EmployeeSalaryAssignment.create({
            employee: employeeId, school: req.schoolId, structure: structureId,
            academicYear: acYear?._id || null,
            effectiveDate: eff, endDate: asDate(b.endDate),
            ctc: annualCtc,
            ctcRevisions: [{
                annualCtc, previousCtc: 0, incrementType: 'initial', incrementValue: 0,
                effectiveMonth: eff.getUTCMonth() + 1, effectiveYear: eff.getUTCFullYear(),
                note: 'Initial CTC', updatedBy: req.userId,
            }],
            componentOverrides: Array.isArray(b.componentOverrides)
                ? b.componentOverrides.filter(o => o && trim(o.componentName)).map(o => ({ componentName: trim(o.componentName), value: num(o.value) }))
                : [],
            paymentMode: ['bank_transfer', 'cash', 'cheque'].includes(b.paymentMode) ? b.paymentMode : 'bank_transfer',
            assignedBy: req.userId, notes: trim(b.notes),
        });
        await logAudit(req, 'ASSIGNMENT_CREATED', 'EmployeeSalaryAssignment', assignment._id,
            `Assigned a salary structure at ₹${annualCtc.toLocaleString('en-IN')} a year`, null, { annualCtc, structureId });
        res.status(201).json({ success: true, data: assignment });
    } catch (e) { fail(res, e); }
};

/** Assign the same structure and CTC to several employees at once. */
exports.bulkAssign = async (req, res) => {
    try {
        const b = req.body || {};
        const ids = (Array.isArray(b.employeeIds) ? b.employeeIds : []).map(uuidOr).filter(Boolean);
        if (!ids.length) return bad(res, 'Choose at least one employee');
        const eff = asDate(b.effectiveDate);
        if (!eff) return bad(res, 'Choose a start date');

        const { year: acYear } = await resolveYear(req.schoolId, b.academicYear);
        const created = [], rejected = [];
        for (const employeeId of ids) {
            const error = await validateAssignment(req.schoolId, {
                employeeId, structureId: b.structureId, effectiveDate: b.effectiveDate,
                endDate: b.endDate, annualCtc: b.annualCtc,
            });
            if (error) { rejected.push({ employeeId, reason: error }); continue; }
            const doc = await EmployeeSalaryAssignment.create({
                employee: employeeId, school: req.schoolId, structure: b.structureId,
                academicYear: acYear?._id || null,
                effectiveDate: eff, endDate: asDate(b.endDate), ctc: num(b.annualCtc),
                ctcRevisions: [{
                    annualCtc: num(b.annualCtc), previousCtc: 0, incrementType: 'initial', incrementValue: 0,
                    effectiveMonth: eff.getUTCMonth() + 1, effectiveYear: eff.getUTCFullYear(),
                    note: 'Initial CTC', updatedBy: req.userId,
                }],
                paymentMode: ['bank_transfer', 'cash', 'cheque'].includes(b.paymentMode) ? b.paymentMode : 'bank_transfer',
                assignedBy: req.userId, notes: trim(b.notes),
            });
            created.push(doc._id);
        }
        await logAudit(req, 'ASSIGNMENT_CREATED', 'EmployeeSalaryAssignment', null,
            `Bulk assigned ${created.length} employee${created.length === 1 ? '' : 's'}`);
        ok(res, { created: created.length, rejected });
    } catch (e) { fail(res, e); }
};

/**
 * Carry every active assignment forward into the year selected, optionally
 * with an across-the-board increment. Employees who already have a live
 * assignment in the target year are left alone.
 */
exports.copyAssignments = async (req, res) => {
    try {
        const b = req.body || {};
        const { year: target, years } = await resolveYear(req.schoolId, b.toAcademicYear);
        if (!target) return bad(res, 'This school has no academic years set up yet');
        const source = years.find(y => String(y._id) === String(b.fromAcademicYear))
            || years.find(y => new Date(y.startDate) < new Date(target.startDate));
        if (!source) return bad(res, 'There is no earlier academic year to copy from');

        const hikePct = num(b.incrementPercent);
        const sourceRows = await EmployeeSalaryAssignment.find({
            school: req.schoolId, isActive: true,
            $or: [{ academicYear: source._id }, { academicYear: null }],
        }).lean();

        const created = [], skipped = [];
        const start = asDate(b.effectiveDate) || new Date(target.startDate);

        // Who already has a row in the target year — one query, not one per
        // employee. A 500-staff school was making 1,500 round-trips here.
        const taken = new Set((await EmployeeSalaryAssignment.find({
            school: req.schoolId, academicYear: target._id,
        }).select('employee').lean()).map(x => String(x.employee)));

        const toClose = [];
        const toOpen = [];
        for (const row of sourceRows) {
            if (taken.has(String(row.employee))) { skipped.push(String(row.employee)); continue; }
            const newCtc = calc.roundAmount(num(row.ctc) * (1 + hikePct / 100), 1);
            toClose.push(row);
            toOpen.push({
                employee: row.employee, school: req.schoolId, structure: row.structure,
                academicYear: target._id, effectiveDate: start, endDate: null,
                ctc: newCtc,
                ctcRevisions: [{
                    annualCtc: newCtc, previousCtc: num(row.ctc),
                    incrementType: hikePct ? 'increment_pct' : 'manual',
                    incrementValue: hikePct || 0,
                    effectiveMonth: start.getUTCMonth() + 1, effectiveYear: start.getUTCFullYear(),
                    note: `Carried forward to ${target.yearName}${hikePct ? ` with a ${hikePct}% increment` : ''}`,
                    updatedBy: req.userId,
                }],
                componentOverrides: row.componentOverrides || [],
                paymentMode: row.paymentMode || 'bank_transfer',
                assignedBy: req.userId, notes: row.notes || '',
            });
            created.push(String(row.employee));
        }

        // The source rows are closed the day before the new ones open, so the
        // two windows never overlap and no run can pick up both.
        if (toClose.length) {
            await Promise.all(toClose.map(row => EmployeeSalaryAssignment.updateOne({ _id: row._id }, {
                isActive: false,
                endDate: row.endDate || new Date(start.getTime() - 86400000),
            })));
        }
        if (toOpen.length) await EmployeeSalaryAssignment.insertMany(toOpen);

        await logAudit(req, 'ASSIGNMENT_CREATED', 'EmployeeSalaryAssignment', null,
            `Carried ${created.length} assignment${created.length === 1 ? '' : 's'} into ${target.yearName}${hikePct ? ` with a ${hikePct}% increment` : ''}`);
        ok(res, { created: created.length, skipped: skipped.length, from: source.yearName, to: target.yearName });
    } catch (e) { fail(res, e); }
};

exports.updateAssignment = async (req, res) => {
    try {
        const b = req.body || {};
        const asgn = await EmployeeSalaryAssignment.findOne({ _id: req.params.id, school: req.schoolId });
        if (!asgn) return bad(res, 'Assignment not found', 404);

        if (b.structureId !== undefined || b.structure !== undefined) {
            const structureId = b.structureId ?? b.structure;
            const structure = await SalaryStructure.findOne({ _id: structureId, school: req.schoolId }).select('_id isActive name').lean();
            if (!structure) return bad(res, 'That salary structure does not exist');
            if (structure.isActive === false) return bad(res, `“${structure.name}” is inactive`);
            asgn.structure = structureId;
        }
        if (b.effectiveDate !== undefined) {
            const d = asDate(b.effectiveDate);
            if (!d) return bad(res, 'Choose a valid start date');
            asgn.effectiveDate = d;
        }
        if (b.endDate !== undefined) {
            const d = asDate(b.endDate);
            if (b.endDate && !d) return bad(res, 'Choose a valid end date');
            if (d && d < new Date(asgn.effectiveDate)) return bad(res, 'The end date cannot be before the start date');
            asgn.endDate = d;
        }
        if (b.componentOverrides !== undefined) {
            asgn.componentOverrides = (Array.isArray(b.componentOverrides) ? b.componentOverrides : [])
                .filter(o => o && trim(o.componentName))
                .map(o => ({ componentName: trim(o.componentName), value: num(o.value) }));
        }
        if (b.paymentMode !== undefined && ['bank_transfer', 'cash', 'cheque'].includes(b.paymentMode)) asgn.paymentMode = b.paymentMode;
        if (b.notes !== undefined) asgn.notes = trim(b.notes).slice(0, 1000);
        await asgn.save();
        await logAudit(req, 'ASSIGNMENT_UPDATED', 'EmployeeSalaryAssignment', asgn._id, 'Assignment updated');
        ok(res, asgn);
    } catch (e) { fail(res, e); }
};

exports.setAssignmentActive = async (req, res) => {
    try {
        const active = req.body?.isActive !== undefined ? !!req.body.isActive : req.path.endsWith('/activate');
        const asgn = await EmployeeSalaryAssignment.findOne({ _id: req.params.id, school: req.schoolId });
        if (!asgn) return bad(res, 'Assignment not found', 404);

        if (active) {
            const clash = await EmployeeSalaryAssignment.findOne({
                school: req.schoolId, employee: asgn.employee, isActive: true, _id: { $ne: asgn._id },
            }).select('_id').lean();
            if (clash) return bad(res, 'This employee already has an active assignment. End that one first.');
        }
        asgn.isActive = active;
        if (!active && !asgn.endDate) asgn.endDate = asDate(req.body?.endDate) || new Date();
        if (active) asgn.endDate = asDate(req.body?.endDate) || null;
        await asgn.save();
        await logAudit(req, active ? 'ASSIGNMENT_REACTIVATED' : 'ASSIGNMENT_DEACTIVATED',
            'EmployeeSalaryAssignment', asgn._id, active ? 'Reactivated' : 'Deactivated');
        ok(res, asgn);
    } catch (e) { fail(res, e); }
};

/**
 * Delete an assignment. Refused once it has been paid against — a payroll
 * entry points at it, and deleting the row would orphan a published payslip's
 * provenance. Deactivating is the way to retire one.
 */
exports.deleteAssignment = async (req, res) => {
    try {
        const asgn = await EmployeeSalaryAssignment.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!asgn) return bad(res, 'Assignment not found', 404);
        const used = await PayrollEntry.countDocuments({ salaryAssignment: asgn._id });
        if (used) return bad(res, `This assignment has been paid in ${used} payroll ${used === 1 ? 'entry' : 'entries'}. Deactivate it instead of deleting it.`);
        await EmployeeSalaryAssignment.deleteOne({ _id: asgn._id });
        await logAudit(req, 'ASSIGNMENT_DELETED', 'EmployeeSalaryAssignment', asgn._id, 'Assignment deleted');
        ok(res, { _id: asgn._id });
    } catch (e) { fail(res, e); }
};

/** Revise the CTC — a new point on the salary timeline, never an overwrite. */
exports.updateCtc = async (req, res) => {
    try {
        const b = req.body || {};
        const asgn = await EmployeeSalaryAssignment.findOne({ _id: req.params.id, school: req.schoolId });
        if (!asgn) return bad(res, 'Assignment not found', 404);

        const prevCtc = num(asgn.ctc);
        const type = ['increment_pct', 'increment_value', 'manual'].includes(b.incrementType) ? b.incrementType : 'manual';
        let annualCtc = num(b.annualCtc);
        if (type === 'increment_pct')   annualCtc = calc.roundAmount(prevCtc * (1 + num(b.incrementValue) / 100), 1);
        if (type === 'increment_value') annualCtc = calc.roundAmount(prevCtc + num(b.incrementValue), 1);
        if (!(annualCtc > 0)) return bad(res, 'Enter the new annual CTC');

        const effectiveMonth = num(b.effectiveMonth), effectiveYear = num(b.effectiveYear);
        if (!(effectiveMonth >= 1 && effectiveMonth <= 12) || !(effectiveYear >= 2000 && effectiveYear <= 2100)) {
            return bad(res, 'Choose the month the new CTC takes effect');
        }
        /**
         * Back-dating over a month that has already been paid is allowed, and
         * is the normal case: a raise agreed in July and effective from April
         * is a thing schools do constantly. Refusing it left them with no way
         * to pay the difference at all. The published months are NOT rewritten
         * — a payslip is a record of what was paid — the shortfall is carried
         * into the next run as arrears by arrearsFor().
         */
        const publishedClash = await PayrollRun.findOne({
            school: req.schoolId, status: 'published',
            $or: [{ year: { $gt: effectiveYear } }, { year: effectiveYear, month: { $gte: effectiveMonth } }],
        }).select('month year').lean();

        asgn.ctc = annualCtc;
        asgn.ctcRevisions.push({
            annualCtc, previousCtc: prevCtc, incrementType: type,
            incrementValue: type === 'manual' ? r2(annualCtc - prevCtc) : num(b.incrementValue),
            effectiveMonth, effectiveYear, note: trim(b.note), updatedBy: req.userId,
        });
        await asgn.save();
        await logAudit(req, 'CTC_UPDATED', 'EmployeeSalaryAssignment', asgn._id,
            `CTC ₹${prevCtc.toLocaleString('en-IN')} → ₹${annualCtc.toLocaleString('en-IN')} from ${monthLabel(effectiveMonth, effectiveYear)}`
            + (publishedClash ? ' (back-dated — arrears will be settled in the next run)' : ''),
            { ctc: prevCtc }, { ctc: annualCtc, effectiveMonth, effectiveYear });
        ok(res, asgn, publishedClash ? {
            backDated: true,
            notice: `${monthLabel(publishedClash.month, publishedClash.year)} has already been published. Those payslips stand as issued — the difference is paid as arrears in the next payroll run.`,
        } : undefined);
    } catch (e) { fail(res, e); }
};

exports.getCtcHistory = async (req, res) => {
    try {
        const asgn = await EmployeeSalaryAssignment.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!asgn) return bad(res, 'Assignment not found', 404);
        const revs = [...(asgn.ctcRevisions || [])].sort((a, b) =>
            (b.effectiveYear - a.effectiveYear) || (b.effectiveMonth - a.effectiveMonth));
        const who = [...new Set(revs.map(r => String(r.updatedBy)).filter(Boolean))];
        const users = who.length ? await User.find({ _id: { $in: who } }).select('name').lean() : [];
        const byId = new Map(users.map(u => [String(u._id), u.name]));
        ok(res, revs.map(r => ({ ...r, updatedByName: byId.get(String(r.updatedBy)) || null, effectiveLabel: monthLabel(r.effectiveMonth, r.effectiveYear) })));
    } catch (e) { fail(res, e); }
};

// ── Salary Structures ────────────────────────────────────────────────────────

const STRUCTURE_TYPES = ['teaching', 'non_teaching', 'administration', 'contract', 'general'];

exports.listStructures = async (req, res) => {
    try {
        const { page, limit, offset } = pageArgs(req.query, 10);
        const { $, list } = params();
        const where = [`s."school" = ${$(String(req.schoolId))}`];
        const search = trim(req.query.search);
        if (search) {
            const like = $(`%${search}%`);
            where.push(`(s."name" ILIKE ${like} OR COALESCE(s."description", '') ILIKE ${like})`);
        }
        if (STRUCTURE_TYPES.includes(trim(req.query.type))) where.push(`COALESCE(s."type", 'general') = ${$(trim(req.query.type))}`);
        const tab = trim(req.query.tab) || 'all';
        if (tab === 'active')   where.push(`COALESCE(s."isActive", true) = true`);
        if (tab === 'inactive') where.push(`COALESCE(s."isActive", true) = false`);
        if (tab === 'default')  where.push(`COALESCE(s."isDefault", false) = true`);

        // The employee count is a correlated count over live assignments, not a
        // populate: a school with 400 staff should not load 400 rows to print
        // one number per structure.
        const usedSql = `(SELECT COUNT(*)::int FROM ${T(EmployeeSalaryAssignment)} a
                           WHERE a."structure" = s."_id" AND COALESCE(a."isActive", true))`;

        const [rows, cnt, tiles, tabCounts] = await Promise.all([
            pool.query(`
              SELECT s.*, ${usedSql} AS "employees", cu."name" AS "createdByName", uu."name" AS "updatedByName"
                FROM ${T(SalaryStructure)} s
                LEFT JOIN ${T(User)} cu ON cu."_id" = s."createdBy"
                LEFT JOIN ${T(User)} uu ON uu."_id" = s."updatedBy"
               WHERE ${where.join(' AND ')}
               ORDER BY COALESCE(s."isDefault", false) DESC, s."name" ASC
               LIMIT ${limit} OFFSET ${offset}`, list),
            pool.query(`SELECT COUNT(*)::int AS "n" FROM ${T(SalaryStructure)} s WHERE ${where.join(' AND ')}`, list),
            (async () => {
                const q = params();
                return (await pool.query(`
                  SELECT COUNT(*)::int AS "total",
                         COUNT(*) FILTER (WHERE COALESCE(s."isActive", true))::int AS "active",
                         COUNT(*) FILTER (WHERE NOT COALESCE(s."isActive", true))::int AS "inactive",
                         COUNT(*) FILTER (WHERE COALESCE(s."isDefault", false))::int AS "isDefault",
                         COALESCE(SUM(${usedSql}), 0)::int AS "employees"
                    FROM ${T(SalaryStructure)} s WHERE s."school" = ${q.$(String(req.schoolId))}`, q.list)).rows[0];
            })(),
            Promise.resolve(null),
        ]);
        const total = num(cnt.rows[0]?.n);
        ok(res, rows.rows.map(shapeStructure), {
            summary: {
                total: num(tiles.total), active: num(tiles.active), inactive: num(tiles.inactive),
                default: num(tiles.isDefault), employees: num(tiles.employees),
            },
            total, page, pages: Math.max(1, Math.ceil(total / limit)), limit,
        });
    } catch (e) { fail(res, e); }
};

/**
 * The headline figure a structure is recognised by. A rate-paid structure
 * shows its rate; a CTC-linked basic shows the rule rather than a rupee amount
 * that would be different for every employee on it.
 */
function basicOf(s) {
    if (s.payBasis === 'rate') return { value: r2(s.rate), label: `₹${r2(s.rate).toLocaleString('en-IN')}`, caption: `per ${s.rateUnit || 'class'}` };
    const comps = (s.components || []).filter(c => c && c.isActive !== false && c.type === 'earning');
    const basic = comps.find(c => /basic/i.test(c.name || '')) || comps[0];
    if (!basic) return { value: 0, label: '—', caption: 'no earnings' };
    if (basic.calculationType === 'fixed') return { value: r2(basic.value), label: `₹${r2(basic.value).toLocaleString('en-IN')}`, caption: '' };
    if (basic.calculationType === 'percentage') {
        return { value: 0, label: `${r2(basic.percentage)}%`, caption: `of ${basic.percentageOf || 'CTC'}` };
    }
    return { value: 0, label: 'Residual', caption: 'balance of CTC' };
}

function shapeStructure(s) {
    const comps = (s.components || []).filter(c => c && c.isActive !== false);
    const earnings  = comps.filter(c => c.type === 'earning').length;
    const deductions = comps.filter(c => c.type === 'deduction').length;
    const employer  = comps.filter(c => c.type === 'employer').length;
    return {
        _id: s._id, name: s.name, description: s.description || '',
        type: s.type || 'general',
        payBasis: s.payBasis || 'monthly', rate: r2(s.rate), rateUnit: s.rateUnit || 'class',
        basic: basicOf(s),
        components: s.components || [],
        counts: { total: comps.length, earnings, deductions, employer },
        componentsLabel: `${comps.length}`,
        componentsBreak: `(${earnings}E + ${deductions}D${employer ? ` + ${employer}C` : ''})`,
        employees: num(s.employees),
        isActive: s.isActive !== false, isDefault: !!s.isDefault,
        status: s.isDefault ? 'default' : (s.isActive !== false ? 'active' : 'inactive'),
        createdByName: s.createdByName || null, updatedByName: s.updatedByName || null,
        createdAt: s.createdAt, updatedAt: s.updatedAt,
    };
}

/** Everything a component must satisfy. Returns a message, or null. */
function validateComponents(components) {
    if (!Array.isArray(components) || !components.length) return 'Add at least one component';
    const names = new Set();
    let balances = 0, earnings = 0;
    const order = [];
    for (const c of components) {
        const name = trim(c?.name);
        if (!name) return 'Every component needs a name';
        if (names.has(name.toLowerCase())) return `“${name}” appears twice`;
        names.add(name.toLowerCase());
        if (!['earning', 'deduction', 'employer'].includes(c.type)) return `“${name}” needs a type`;
        if (!['fixed', 'percentage', 'balance'].includes(c.calculationType)) return `“${name}” needs a calculation`;
        if (c.type === 'earning') earnings++;
        if (c.calculationType === 'balance') {
            balances++;
            if (c.type !== 'earning') return `Only an earning can be the balance of CTC — “${name}” is not`;
        }
        if (c.calculationType === 'percentage') {
            if (!(num(c.percentage) > 0)) return `“${name}” needs a percentage above zero`;
            if (num(c.percentage) > 100) return `“${name}” cannot be more than 100%`;
            const base = trim(c.percentageOf);
            if (!base) return `“${name}” needs something to take its percentage of`;
            // A percentage may only name a component resolved before it.
            if (!/^ctc$/i.test(base) && !order.includes(base.toLowerCase())) {
                return `“${name}” takes a percentage of “${base}”, which is not defined above it`;
            }
        }
        if (num(c.value) < 0 || num(c.capAmount) < 0 || num(c.wageCeiling) < 0) return `“${name}” cannot hold a negative amount`;
        order.push(name.toLowerCase());
    }
    if (!earnings) return 'A structure needs at least one earning';
    if (balances > 1) return 'Only one component can be the balance of CTC';
    return null;
}

const cleanComponents = (components) => (components || []).map((c, i) => ({
    name: trim(c.name), code: trim(c.code).toUpperCase().slice(0, 12),
    type: c.type, calculationType: c.calculationType,
    value: num(c.value), percentage: num(c.percentage),
    percentageOf: trim(c.percentageOf) || 'CTC',
    wageCeiling: num(c.wageCeiling), capAmount: num(c.capAmount), minAmount: num(c.minAmount),
    proRated: c.proRated !== false, taxable: c.taxable !== false,
    order: c.order !== undefined ? num(c.order) : i + 1,
    isActive: c.isActive !== false,
}));

exports.createStructure = async (req, res) => {
    try {
        const b = req.body || {};
        const name = trim(b.name);
        if (!name) return bad(res, 'Give the structure a name');
        const payBasis = b.payBasis === 'rate' ? 'rate' : 'monthly';
        if (payBasis === 'rate' && !(num(b.rate) > 0)) return bad(res, 'Enter the rate per unit');

        // The old web form posted { basic, hra, allowances, deductions } — flat
        // numbers the model has no fields for — so every structure built in the
        // UI was saved with an empty component list and paid nobody anything.
        // Those four keys are accepted here and turned into real components, so
        // an old client (or a bookmarked form) still produces something valid.
        let components = Array.isArray(b.components) ? b.components : legacyComponents(b);
        // A caller that sends no components at all (the mobile screen does, and
        // tells the user to finish the structure on the web) gets the minimal
        // valid structure rather than an empty one: a single earning that is
        // the whole of CTC. An empty component list pays nobody anything, which
        // is exactly the failure this module already had.
        if (!components.length && !Array.isArray(b.components)) {
            components = [{ name: 'Basic Salary', code: 'BASIC', type: 'earning', calculationType: 'balance', order: 1 }];
        }
        components = cleanComponents(components);
        const error = validateComponents(components);
        if (error) return bad(res, error);

        const structure = await SalaryStructure.create({
            school: req.schoolId, name,
            description: trim(b.description),
            type: STRUCTURE_TYPES.includes(b.type) ? b.type : 'general',
            payBasis, rate: num(b.rate), rateUnit: ['class', 'hour', 'day'].includes(b.rateUnit) ? b.rateUnit : 'class',
            components, isActive: b.isActive !== false,
            createdBy: req.userId, updatedBy: req.userId,
        });
        if (b.isDefault) await setDefaultStructure(req.schoolId, structure._id);
        await logAudit(req, 'STRUCTURE_CREATED', 'SalaryStructure', structure._id, `Created “${name}”`);
        res.status(201).json({ success: true, data: shapeStructure(structure.toObject ? structure.toObject() : structure) });
    } catch (e) {
        if (e.code === 11000 || e.code === '23505' || /unique/i.test(e.message || '')) {
            return bad(res, 'A structure with that name already exists');
        }
        fail(res, e);
    }
};

/** The four flat numbers the old form sent, as components. */
function legacyComponents(b) {
    const out = [];
    let order = 1;
    const add = (name, code, type, value) => { if (num(value) > 0) out.push({ name, code, type, calculationType: 'fixed', value: num(value), order: order++ }); };
    add('Basic Salary', 'BASIC', 'earning', b.basic);
    add('House Rent Allowance', 'HRA', 'earning', b.hra);
    add('Other Allowances', 'ALLOW', 'earning', b.allowances);
    add('Deductions', 'DED', 'deduction', b.deductions);
    return out;
}

exports.updateStructure = async (req, res) => {
    try {
        const b = req.body || {};
        const existing = await SalaryStructure.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!existing) return bad(res, 'Structure not found', 404);

        const update = {};
        if (b.name !== undefined) {
            if (!trim(b.name)) return bad(res, 'Give the structure a name');
            update.name = trim(b.name);
        }
        if (b.description !== undefined) update.description = trim(b.description);
        if (b.type !== undefined && STRUCTURE_TYPES.includes(b.type)) update.type = b.type;
        if (b.payBasis !== undefined) update.payBasis = b.payBasis === 'rate' ? 'rate' : 'monthly';
        if (b.rate !== undefined) update.rate = num(b.rate);
        if (b.rateUnit !== undefined && ['class', 'hour', 'day'].includes(b.rateUnit)) update.rateUnit = b.rateUnit;
        if (b.components !== undefined) {
            const components = cleanComponents(b.components);
            const error = validateComponents(components);
            if (error) return bad(res, error);
            update.components = components;
        }
        if (b.isActive !== undefined) update.isActive = !!b.isActive;
        update.updatedBy = req.userId;

        // Changing a structure re-prices salaries the next time a run is made.
        // Say how many people that is rather than letting it be a surprise.
        const affected = await EmployeeSalaryAssignment.countDocuments({ school: req.schoolId, structure: existing._id, isActive: true });

        const saved = await SalaryStructure.findOneAndUpdate(
            { _id: existing._id, school: req.schoolId }, update, { new: true, runValidators: true }).lean();
        if (b.isDefault !== undefined) {
            if (b.isDefault) await setDefaultStructure(req.schoolId, existing._id);
            else await SalaryStructure.updateOne({ _id: existing._id }, { isDefault: false });
        }
        await logAudit(req, 'STRUCTURE_UPDATED', 'SalaryStructure', existing._id,
            `Updated “${saved.name}”${affected ? ` — affects ${affected} employee${affected === 1 ? '' : 's'}` : ''}`,
            { components: existing.components }, { components: saved.components });
        ok(res, shapeStructure(saved), { affected });
    } catch (e) {
        if (e.code === 11000 || e.code === '23505' || /unique/i.test(e.message || '')) {
            return bad(res, 'A structure with that name already exists');
        }
        fail(res, e);
    }
};

async function setDefaultStructure(schoolId, id) {
    await SalaryStructure.updateMany({ school: schoolId, isDefault: true }, { isDefault: false });
    await SalaryStructure.updateOne({ _id: id, school: schoolId }, { isDefault: true, isActive: true });
}

exports.setDefault = async (req, res) => {
    try {
        const s = await SalaryStructure.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!s) return bad(res, 'Structure not found', 404);
        await setDefaultStructure(req.schoolId, s._id);
        await logAudit(req, 'STRUCTURE_UPDATED', 'SalaryStructure', s._id, `“${s.name}” is now the default structure`);
        ok(res, { _id: s._id, isDefault: true });
    } catch (e) { fail(res, e); }
};

exports.toggleStructure = async (req, res) => {
    try {
        const s = await SalaryStructure.findOne({ _id: req.params.id, school: req.schoolId });
        if (!s) return bad(res, 'Structure not found', 404);
        const next = req.body?.isActive !== undefined ? !!req.body.isActive : !s.isActive;
        if (!next) {
            // Switching a structure off stops every run that would have used
            // it, so the people it pays have to be named first.
            const used = await EmployeeSalaryAssignment.countDocuments({ school: req.schoolId, structure: s._id, isActive: true });
            if (used && req.body?.force !== true) {
                return bad(res, `${used} employee${used === 1 ? ' is' : 's are'} paid on “${s.name}”. Move them to another structure first, or confirm to switch it off anyway.`);
            }
        }
        s.isActive = next;
        if (!next) s.isDefault = false;
        await s.save();
        await logAudit(req, 'STRUCTURE_TOGGLED', 'SalaryStructure', s._id, `“${s.name}” ${next ? 'activated' : 'deactivated'}`);
        ok(res, shapeStructure(s.toObject ? s.toObject() : s));
    } catch (e) { fail(res, e); }
};

exports.duplicateStructure = async (req, res) => {
    try {
        const s = await SalaryStructure.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!s) return bad(res, 'Structure not found', 404);
        let name = trim(req.body?.name) || `${s.name} (Copy)`;
        // Keep trying suffixes rather than failing on the unique index.
        for (let i = 2; await SalaryStructure.countDocuments({ school: req.schoolId, name }); i++) name = `${s.name} (Copy ${i})`;
        const copy = await SalaryStructure.create({
            school: req.schoolId, name, description: s.description, type: s.type,
            payBasis: s.payBasis, rate: s.rate, rateUnit: s.rateUnit,
            components: s.components, isActive: true, isDefault: false,
            createdBy: req.userId, updatedBy: req.userId,
        });
        await logAudit(req, 'STRUCTURE_DUPLICATED', 'SalaryStructure', copy._id, `Copied “${s.name}” to “${name}”`);
        res.status(201).json({ success: true, data: shapeStructure(copy.toObject ? copy.toObject() : copy) });
    } catch (e) { fail(res, e); }
};

exports.deleteStructure = async (req, res) => {
    try {
        const s = await SalaryStructure.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!s) return bad(res, 'Structure not found', 404);
        const [assigned, paid] = await Promise.all([
            EmployeeSalaryAssignment.countDocuments({ school: req.schoolId, structure: s._id }),
            PayrollEntry.countDocuments({ school: req.schoolId, structure: s._id }),
        ]);
        if (assigned) return bad(res, `${assigned} assignment${assigned === 1 ? '' : 's'} still point${assigned === 1 ? 's' : ''} at “${s.name}”. Move them first, or switch the structure off instead.`);
        if (paid) return bad(res, `“${s.name}” has been used in ${paid} payroll ${paid === 1 ? 'entry' : 'entries'}. Switch it off instead of deleting it.`);
        await SalaryStructure.deleteOne({ _id: s._id });
        await logAudit(req, 'STRUCTURE_DELETED', 'SalaryStructure', s._id, `Deleted “${s.name}”`);
        ok(res, { _id: s._id });
    } catch (e) { fail(res, e); }
};

/** Build a starter structure from one of the templates. */
exports.createFromTemplate = async (req, res) => {
    try {
        const key = trim(req.body?.template);
        const tpl = calc.TEMPLATES[key];
        if (!tpl) return bad(res, 'Unknown template');
        let name = trim(req.body?.name) || tpl.name;
        for (let i = 2; await SalaryStructure.countDocuments({ school: req.schoolId, name }); i++) name = `${tpl.name} ${i}`;
        const structure = await SalaryStructure.create({
            school: req.schoolId, name, description: tpl.description, type: tpl.type,
            payBasis: tpl.payBasis || 'monthly', rate: tpl.rate || 0, rateUnit: tpl.rateUnit || 'class',
            components: cleanComponents(tpl.components), isActive: true,
            createdBy: req.userId, updatedBy: req.userId,
        });
        await logAudit(req, 'STRUCTURE_CREATED', 'SalaryStructure', structure._id, `Created “${name}” from the ${key} template`);
        res.status(201).json({ success: true, data: shapeStructure(structure.toObject ? structure.toObject() : structure) });
    } catch (e) { fail(res, e); }
};

/** The starter templates and the component library the editor offers. */
exports.getLibrary = async (req, res) => {
    try {
        const used = await SalaryStructure.find({ school: req.schoolId }).select('components').lean();
        const seen = new Map();
        for (const s of used) {
            for (const c of s.components || []) {
                const key = trim(c.name).toLowerCase();
                if (key && !seen.has(key)) seen.set(key, { ...c, _fromSchool: true });
            }
        }
        for (const c of calc.COMMON_COMPONENTS) {
            const key = c.name.toLowerCase();
            if (!seen.has(key)) seen.set(key, c);
        }
        ok(res, {
            components: [...seen.values()],
            templates: Object.entries(calc.TEMPLATES).map(([key, t]) => ({
                key, name: t.name, description: t.description, type: t.type,
                payBasis: t.payBasis || 'monthly', rate: t.rate || 0,
                components: t.components.length,
            })),
            types: STRUCTURE_TYPES,
        });
    } catch (e) { fail(res, e); }
};

/**
 * What a structure pays at a given CTC — the live preview under the editor.
 * Takes either a saved structure id or an unsaved draft, so the preview works
 * while the form is still being filled in.
 */
exports.previewStructure = async (req, res) => {
    try {
        const b = req.body || {};
        let structure = null;
        if (uuidOr(b.structureId)) {
            structure = await SalaryStructure.findOne({ _id: b.structureId, school: req.schoolId }).lean();
            if (!structure) return bad(res, 'Structure not found', 404);
        } else if (b.structure) {
            structure = { ...b.structure, components: cleanComponents(b.structure.components) };
            const error = validateComponents(structure.components);
            if (error) return bad(res, error);
        } else return bad(res, 'Send a structure to preview');

        const settings = await settingsFor(req.schoolId);
        const annualCtc = num(b.annualCtc) || 600000;
        const breakdown = calc.computePay({
            structure, annualCtc,
            overrides: b.overrides || [],
            lopDays: num(b.lopDays),
            units: num(b.units),
            workingDays: num(b.workingDays) || num(settings.fixedWorkingDays) || 26,
            roundTo: settings.roundTo,
        });
        // A structure whose earnings and employer costs do not add up to CTC is
        // legal but almost never intended, so the preview says so out loud.
        const gap = r2(breakdown.monthlyCtc - breakdown.monthlyCost);
        ok(res, {
            ...breakdown,
            annualCtc,
            balances: Math.abs(gap) < 1,
            gap,
        });
    } catch (e) { fail(res, e); }
};

// ── Reports ──────────────────────────────────────────────────────────────────

const REPORT_TYPES = {
    summary:         { label: 'Payroll Summary',   hint: 'Complete payroll overview',        period: 'month' },
    salary_register: { label: 'Salary Register',   hint: 'Employee-wise salary details',     period: 'month' },
    deductions:      { label: 'Deductions Report', hint: 'PF, ESI, TDS and other deductions', period: 'month' },
    department:      { label: 'Department-wise',   hint: 'Payroll by department',            period: 'month' },
    annual:          { label: 'Annual Report',     hint: 'Yearly salary breakdown',          period: 'year'  },
    bank_transfer:   { label: 'Bank Transfer',     hint: 'Payment status and bank details',  period: 'month' },
    employee:        { label: 'Employee Report',   hint: 'One employee, month by month',     period: 'year'  },
    form16:          { label: 'Form 16 (Part B)',  hint: 'Annual salary and tax, per employee', period: 'year' },
};
exports.REPORT_TYPES = REPORT_TYPES;

/** Entries for a period, with the employee context every report needs. */
async function reportEntries(schoolId, { month, year, department, employeeId }) {
    const { $, list } = params();
    const where = [`e."school" = ${$(String(schoolId))}`, `e."year" = ${$(num(year))}`, `r."status" <> 'cancelled'`];
    if (month) where.push(`e."month" = ${$(num(month))}`);
    if (trim(department)) where.push(`COALESCE(tp."department", '') = ${$(trim(department))}`);
    if (uuidOr(employeeId)) where.push(`e."employee" = ${$(String(employeeId))}`);
    const { rows } = await pool.query(`
      SELECT e.*, r."status" AS "runStatus", r."runName",
             u."name" AS "employeeName", u."email" AS "employeeEmail",
             tp."employeeId" AS "empCode", tp."department", tp."designation",
             tp."bankAccountNumber", tp."bankIfsc", tp."bankAccountHolder", tp."panNumber", tp."uanNumber",
             COALESCE(a."paymentMode", 'bank_transfer') AS "paymentMode",
             ${staffBucketSql('u', 'tp')} AS "bucket"
        FROM ${T(PayrollEntry)} e
        JOIN ${T(PayrollRun)} r ON r."_id" = e."payrollRun"
        JOIN ${T(User)} u ON u."_id" = e."employee"
        LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = e."school"
        LEFT JOIN ${T(EmployeeSalaryAssignment)} a ON a."_id" = e."salaryAssignment"
       WHERE ${where.join(' AND ')}
       ORDER BY e."year", e."month", u."name"`, list);
    return rows;
}

const amountOf = (lines, name) => r2((lines || []).find(x => x.name === name)?.amount);

/** The financial-year label a year-scoped report covers. */
function fyLabelFor(schoolId, spec, settings) {
    return fyRange(settings.financialYearStartMonth, settings.financialYearStartMonth, num(spec.year)).label;
}

/**
 * Entries for a whole FINANCIAL year. A financial year spans two calendar
 * years and reportEntries() works one calendar year at a time, so both are
 * read and the months outside the window dropped.
 */
async function fyEntries(schoolId, spec) {
    const settings = await settingsFor(schoolId);
    const fy = fyRange(settings.financialYearStartMonth, settings.financialYearStartMonth, num(spec.year));
    const years = [...new Set([fy.from.year, fy.to.year])];
    const parts = await Promise.all(years.map(y => reportEntries(schoolId, { ...spec, year: y, month: null })));
    const key = (y, m) => y * 12 + m;
    return parts.flat().filter(e =>
        key(e.year, e.month) >= key(fy.from.year, fy.from.month) &&
        key(e.year, e.month) <= key(fy.to.year, fy.to.month));
}

/** Build one report: its title, its columns, its rows and its totals. */
async function buildReport(schoolId, spec) {
    const { type, month, year, department, employeeId } = spec;
    const rows = await reportEntries(schoolId, spec);
    const periodLabel = month ? monthLabel(month, year) : `${year}`;
    const money = (n) => r2(n);

    if (type === 'department') {
        const by = new Map();
        for (const e of rows) {
            const key = trim(e.department) || 'Unassigned';
            const g = by.get(key) || { department: key, employees: new Set(), gross: 0, deductions: 0, net: 0, employerCost: 0, lop: 0 };
            g.employees.add(String(e.employee));
            g.gross += num(e.grossSalary); g.deductions += num(e.totalDeductions);
            g.net += num(e.netSalary); g.employerCost += num(e.employerCost); g.lop += num(e.lopAmount);
            by.set(key, g);
        }
        const data = [...by.values()].map(g => ({ ...g, employees: g.employees.size, gross: money(g.gross), deductions: money(g.deductions), net: money(g.net), employerCost: money(g.employerCost), lop: money(g.lop) }))
            .sort((a, b) => b.net - a.net);
        return {
            title: 'Department-wise Payroll', periodLabel,
            columns: [
                { key: 'department', label: 'Department' },
                { key: 'employees', label: 'Employees', align: 'right' },
                { key: 'gross', label: 'Gross Pay', align: 'right', money: true },
                { key: 'deductions', label: 'Deductions', align: 'right', money: true },
                { key: 'net', label: 'Net Pay', align: 'right', money: true },
                { key: 'employerCost', label: 'Employer Cost', align: 'right', money: true },
            ],
            rows: data,
            summary: totalsOf(rows),
        };
    }

    if (type === 'annual') {
        // The financial year, not the calendar one. "Annual Report — 2026"
        // used to mean January to December while the employee's own statement
        // for "2026-27" meant April to March: one module, two different years.
        const yearRows = await fyEntries(schoolId, spec);
        const by = new Map();
        for (const e of yearRows) {
            const key = `${e.year}-${e.month}`;
            const g = by.get(key) || { key, month: e.month, year: e.year, period: shortLabel(e.month, e.year), employees: new Set(), gross: 0, deductions: 0, net: 0, employerCost: 0 };
            g.employees.add(String(e.employee));
            g.gross += num(e.grossSalary); g.deductions += num(e.totalDeductions);
            g.net += num(e.netSalary); g.employerCost += num(e.employerCost);
            by.set(key, g);
        }
        const data = [...by.values()].sort((a, b) => (a.year - b.year) || (a.month - b.month))
            .map(g => ({ ...g, employees: g.employees.size, gross: money(g.gross), deductions: money(g.deductions), net: money(g.net), employerCost: money(g.employerCost) }));
        return {
            title: 'Annual Payroll Report',
            periodLabel: `FY ${fyLabelFor(schoolId, spec, await settingsFor(schoolId))}`,
            columns: [
                { key: 'period', label: 'Period' },
                { key: 'employees', label: 'Employees', align: 'right' },
                { key: 'gross', label: 'Gross Pay', align: 'right', money: true },
                { key: 'deductions', label: 'Deductions', align: 'right', money: true },
                { key: 'net', label: 'Net Pay', align: 'right', money: true },
                { key: 'employerCost', label: 'Employer Cost', align: 'right', money: true },
            ],
            rows: data, summary: totalsOf(yearRows),
        };
    }

    if (type === 'employee') {
        const data = rows.map(e => ({
            period: shortLabel(e.month, e.year),
            name: e.employeeName, empCode: e.empCode || '',
            paidDays: num(e.paidDays), lopDays: num(e.lopDays),
            gross: money(e.grossSalary), deductions: money(e.totalDeductions), net: money(e.netSalary),
            status: RUN_STAGE[e.runStatus]?.label || e.runStatus,
        }));
        return {
            title: 'Employee Payroll Report', periodLabel,
            columns: [
                { key: 'period', label: 'Period' },
                { key: 'name', label: 'Employee' },
                { key: 'paidDays', label: 'Paid Days', align: 'right' },
                { key: 'lopDays', label: 'LOP Days', align: 'right' },
                { key: 'gross', label: 'Gross Pay', align: 'right', money: true },
                { key: 'deductions', label: 'Deductions', align: 'right', money: true },
                { key: 'net', label: 'Net Pay', align: 'right', money: true },
                { key: 'status', label: 'Status' },
            ],
            rows: data, summary: totalsOf(rows),
        };
    }

    if (type === 'bank_transfer') {
        const data = rows.filter(e => !e.isOnHold).map(e => ({
            beneficiary: trim(e.bankAccountHolder) || e.employeeName,
            empCode: e.empCode || '',
            account: e.bankAccountNumber || '',
            ifsc: e.bankIfsc || '',
            mode: e.paymentMode === 'bank_transfer' ? 'Bank Transfer' : (e.paymentMode === 'cash' ? 'Cash' : 'Cheque'),
            amount: money(e.netSalary),
            status: e.bankAccountNumber || e.paymentMode !== 'bank_transfer' ? 'Ready' : 'No bank details',
        }));
        return {
            title: 'Bank Transfer Report', periodLabel,
            columns: [
                { key: 'beneficiary', label: 'Beneficiary' },
                { key: 'empCode', label: 'Employee ID' },
                { key: 'account', label: 'Account Number' },
                { key: 'ifsc', label: 'IFSC' },
                { key: 'mode', label: 'Mode' },
                { key: 'amount', label: 'Amount', align: 'right', money: true },
                { key: 'status', label: 'Status' },
            ],
            rows: data, summary: totalsOf(rows.filter(e => !e.isOnHold)),
        };
    }

    if (type === 'deductions') {
        const names = [...new Set(rows.flatMap(e => (e.deductions || []).map(d => d.name)))];
        const data = rows.map(e => ({
            empCode: e.empCode || '', name: e.employeeName, department: e.department || '',
            gross: money(e.grossSalary),
            ...Object.fromEntries(names.map(n => [`d_${n}`, amountOf(e.deductions, n)])),
            other: money(e.otherDeductions),
            total: money(num(e.totalDeductions) + num(e.otherDeductions)),
        }));
        return {
            title: 'Deductions Report', periodLabel,
            columns: [
                { key: 'empCode', label: 'Employee ID' },
                { key: 'name', label: 'Employee' },
                { key: 'department', label: 'Department' },
                { key: 'gross', label: 'Gross Pay', align: 'right', money: true },
                ...names.map(n => ({ key: `d_${n}`, label: n, align: 'right', money: true })),
                { key: 'other', label: 'Other', align: 'right', money: true },
                { key: 'total', label: 'Total Deductions', align: 'right', money: true },
            ],
            rows: data, summary: totalsOf(rows),
        };
    }

    if (type === 'salary_register') {
        const earningNames   = [...new Set(rows.flatMap(e => (e.earnings || []).map(x => x.name)))];
        const deductionNames = [...new Set(rows.flatMap(e => (e.deductions || []).map(x => x.name)))];
        const data = rows.map(e => ({
            empCode: e.empCode || '', name: e.employeeName, department: e.department || '',
            designation: e.designation || '',
            paidDays: num(e.paidDays), lopDays: num(e.lopDays),
            ...Object.fromEntries(earningNames.map(n => [`e_${n}`, amountOf(e.earnings, n)])),
            gross: money(e.grossSalary),
            ...Object.fromEntries(deductionNames.map(n => [`d_${n}`, amountOf(e.deductions, n)])),
            totalDeductions: money(e.totalDeductions),
            net: money(e.netSalary),
        }));
        return {
            title: 'Salary Register', periodLabel,
            columns: [
                { key: 'empCode', label: 'Employee ID' },
                { key: 'name', label: 'Employee' },
                { key: 'department', label: 'Department' },
                { key: 'paidDays', label: 'Paid Days', align: 'right' },
                { key: 'lopDays', label: 'LOP', align: 'right' },
                ...earningNames.map(n => ({ key: `e_${n}`, label: n, align: 'right', money: true })),
                { key: 'gross', label: 'Gross', align: 'right', money: true },
                ...deductionNames.map(n => ({ key: `d_${n}`, label: n, align: 'right', money: true })),
                { key: 'totalDeductions', label: 'Deductions', align: 'right', money: true },
                { key: 'net', label: 'Net Pay', align: 'right', money: true },
            ],
            rows: data, summary: totalsOf(rows),
        };
    }

    if (type === 'form16') {
        /**
         * Form 16 Part B: what an employee earned in a financial year and what
         * tax was withheld from it. Built from the payslips that were actually
         * issued, never from a projection — this is a statement of what
         * happened, so the TDS figure has to agree with what left the payroll.
         */
        const cfg = tax.config(await settingsFor(schoolId));
        const inYear = await fyEntries(schoolId, spec);
        const stdDeduction = cfg.standardDeduction;

        const by = new Map();
        for (const e of inYear) {
            const key = String(e.employee);
            const g = by.get(key) || {
                empCode: e.empCode || '', name: e.employeeName, pan: e.panNumber || '',
                months: 0, gross: 0, exempt: 0, deductions: 0, tdsDeducted: 0, net: 0,
            };
            g.months += 1;
            g.gross      += num(e.grossSalary);
            g.net        += num(e.netSalary);
            g.deductions += num(e.totalDeductions);
            for (const d of e.deductions || []) {
                if (String(d.code || '').toUpperCase() === 'TDS') g.tdsDeducted += num(d.amount);
            }
            by.set(key, g);
        }

        const data = [...by.values()].map(g => {
            const taxable = Math.max(0, r2(g.gross - g.exempt - stdDeduction));
            const computed = tax.annualTax(taxable, { tax: cfg });
            return {
                empCode: g.empCode, name: g.name, pan: g.pan || '—', months: g.months,
                gross: r2(g.gross),
                standardDeduction: stdDeduction,
                taxable,
                taxPayable: computed.total,
                tdsDeducted: r2(g.tdsDeducted),
                balance: r2(computed.total - g.tdsDeducted),
                net: r2(g.net),
            };
        }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

        return {
            title: 'Form 16 (Part B) — Salary and Tax',
            periodLabel: `FY ${fyLabelFor(schoolId, spec, await settingsFor(schoolId))}`,
            columns: [
                { key: 'empCode', label: 'Employee ID' },
                { key: 'name', label: 'Employee' },
                { key: 'pan', label: 'PAN' },
                { key: 'months', label: 'Months', align: 'right' },
                { key: 'gross', label: 'Gross Salary', align: 'right', money: true },
                { key: 'standardDeduction', label: 'Std. Deduction', align: 'right', money: true },
                { key: 'taxable', label: 'Taxable Income', align: 'right', money: true },
                { key: 'taxPayable', label: 'Tax Payable', align: 'right', money: true },
                { key: 'tdsDeducted', label: 'TDS Deducted', align: 'right', money: true },
                { key: 'balance', label: 'Balance', align: 'right', money: true },
            ],
            rows: data,
            summary: totalsOf(inYear),
        };
    }

    // summary (the default)
    const data = rows.map(e => ({
        empCode: e.empCode || '', name: e.employeeName, department: e.department || '',
        designation: e.designation || '',
        ctc: money(e.annualCtc),
        paidDays: num(e.paidDays), lopDays: num(e.lopDays),
        gross: money(e.grossSalary), deductions: money(e.totalDeductions), net: money(e.netSalary),
        status: e.isOnHold ? 'On hold' : (RUN_STAGE[e.runStatus]?.label || e.runStatus),
    }));
    return {
        title: 'Payroll Summary', periodLabel,
        columns: [
            { key: 'empCode', label: 'Employee ID' },
            { key: 'name', label: 'Employee' },
            { key: 'department', label: 'Department' },
            { key: 'designation', label: 'Designation' },
            { key: 'ctc', label: 'Annual CTC', align: 'right', money: true },
            { key: 'paidDays', label: 'Paid Days', align: 'right' },
            { key: 'lopDays', label: 'LOP', align: 'right' },
            { key: 'gross', label: 'Gross Pay', align: 'right', money: true },
            { key: 'deductions', label: 'Deductions', align: 'right', money: true },
            { key: 'net', label: 'Net Pay', align: 'right', money: true },
            { key: 'status', label: 'Status' },
        ],
        rows: data, summary: totalsOf(rows),
    };
}

const totalsOf = (entries) => ({
    employees: new Set(entries.map(e => String(e.employee))).size,
    gross: r2(entries.reduce((s, e) => s + num(e.grossSalary), 0)),
    deductions: r2(entries.reduce((s, e) => s + num(e.totalDeductions), 0)),
    net: r2(entries.reduce((s, e) => s + num(e.netSalary), 0)),
    employerCost: r2(entries.reduce((s, e) => s + num(e.employerCost), 0)),
    lop: r2(entries.reduce((s, e) => s + num(e.lopAmount), 0)),
});

exports.getReportsOverview = async (req, res) => {
    try {
        const now = new Date();
        const month = Math.min(12, Math.max(1, parseInt(req.query.month, 10) || (now.getMonth() + 1)));
        const year  = parseInt(req.query.year, 10) || now.getFullYear();
        const prev  = prevMonth(year, month);

        const [{ year: acYear, years }, staff, entries, prevEntries, deptRows] = await Promise.all([
            resolveYear(req.schoolId, req.query.academicYear),
            workforce(req.schoolId),
            reportEntries(req.schoolId, { month, year }),
            reportEntries(req.schoolId, { month: prev.month, year: prev.year }),
            (async () => {
                const q = params();
                return (await pool.query(`
                  SELECT DISTINCT COALESCE(NULLIF(tp."department", ''), 'Unassigned') AS "name"
                    FROM ${T(User)} u
                    LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = u."school"
                   WHERE ${employeeWhere(q.$, req.schoolId, 'u')} ORDER BY 1`, q.list)).rows;
            })(),
        ]);

        const t = totalsOf(entries), p = totalsOf(prevEntries);

        // The salary component split for the month: every earning by name, plus
        // deductions as one slice, exactly as the mockup reads it.
        const byComponent = new Map();
        for (const e of entries) {
            for (const line of e.earnings || []) {
                byComponent.set(line.name, r2((byComponent.get(line.name) || 0) + num(line.amount)));
            }
        }
        const componentTotal = [...byComponent.values()].reduce((s, v) => s + v, 0) + t.deductions;
        const slices = [...byComponent.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([name, value]) => ({ name, value, pct: componentTotal > 0 ? r2((value / componentTotal) * 100) : 0 }));
        if (t.deductions > 0) slices.push({ name: 'Deductions', value: t.deductions, pct: componentTotal > 0 ? r2((t.deductions / componentTotal) * 100) : 0, isDeduction: true });

        // Six-month trend.
        const s6 = params();
        const { rows: trend } = await pool.query(`
          SELECT "month", "year", "totalGross", "totalDeductions", "totalNet"
            FROM ${T(PayrollRun)}
           WHERE "school" = ${s6.$(String(req.schoolId))} AND "status" <> 'cancelled'
             AND make_date("year"::int, "month"::int, 1) BETWEEN ${s6.$(new Date(Date.UTC(year, month - 6, 1)))} AND ${s6.$(new Date(Date.UTC(year, month - 1, 1)))}`, s6.list);
        const byKey = new Map(trend.map(r => [`${r.year}-${r.month}`, r]));
        const series = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(Date.UTC(year, month - 1 - i, 1));
            const m = d.getUTCMonth() + 1, y = d.getUTCFullYear();
            const row = byKey.get(`${y}-${m}`);
            series.push({ month: m, year: y, label: MONTHS_SHORT[m - 1], gross: r2(row?.totalGross), deductions: r2(row?.totalDeductions), net: r2(row?.totalNet) });
        }

        ok(res, {
            month, year, monthLabel: monthLabel(month, year),
            academicYear: yearOut(acYear), academicYears: years.map(yearOut),
            tiles: {
                employees: { value: staff.total, deltaPct: change(staff.total, staff.total) },
                gross: { value: t.gross, deltaPct: change(t.gross, p.gross), caption: `Gross salary` },
                deductions: { value: t.deductions, deltaPct: change(t.deductions, p.deductions), caption: 'PF, ESI, TDS etc.' },
                net: { value: t.net, deltaPct: change(t.net, p.net), caption: 'Amount disbursed' },
            },
            series,
            components: slices,
            componentTotal: r2(componentTotal),
            departments: deptRows.map(r => r.name),
            types: Object.entries(REPORT_TYPES).map(([key, v]) => ({ key, ...v })),
            months: yearMonths(acYear),
        });
    } catch (e) { fail(res, e); }
};

exports.listReports = async (req, res) => {
    try {
        const { page, limit, offset } = pageArgs(req.query, 10);
        const { $, list } = params();
        const where = [`r."school" = ${$(String(req.schoolId))}`];
        const search = trim(req.query.search);
        if (search) where.push(`(r."name" ILIKE ${$(`%${search}%`)} OR r."type" ILIKE ${$(`%${search}%`)})`);
        if (REPORT_TYPES[trim(req.query.type)]) where.push(`r."type" = ${$(trim(req.query.type))}`);

        const [rows, cnt] = await Promise.all([
            pool.query(`
              SELECT r.*, u."name" AS "generatedByName"
                FROM ${T(PayrollReport)} r
                LEFT JOIN ${T(User)} u ON u."_id" = r."generatedBy"
               WHERE ${where.join(' AND ')}
               ORDER BY r."generatedAt" DESC
               LIMIT ${limit} OFFSET ${offset}`, list),
            pool.query(`SELECT COUNT(*)::int AS "n" FROM ${T(PayrollReport)} r WHERE ${where.join(' AND ')}`, list),
        ]);
        const total = num(cnt.rows[0]?.n);
        ok(res, rows.rows.map(r => ({
            _id: r._id, name: r.name, type: r.type,
            typeLabel: REPORT_TYPES[r.type]?.label || r.type,
            hint: REPORT_TYPES[r.type]?.hint || '',
            month: r.month, year: r.year, periodLabel: r.periodLabel,
            format: r.format, rowCount: num(r.rowCount), summary: r.summary,
            generatedAt: r.generatedAt, generatedByName: r.generatedByName || null,
        })), { total, page, pages: Math.max(1, Math.ceil(total / limit)), limit });
    } catch (e) { fail(res, e); }
};

exports.generateReport = async (req, res) => {
    try {
        const b = req.body || {};
        const type = REPORT_TYPES[trim(b.type)] ? trim(b.type) : 'summary';
        // Form 16 is only meaningful once a regime is configured; without one
        // the tax column would be a guess presented as a statement.
        if (type === 'form16' && tax.config(await settingsFor(req.schoolId)).regime === 'none') {
            return bad(res, 'Set up a tax regime in Payroll settings before generating Form 16 — otherwise the tax figures would be invented.');
        }
        const wantsYear = REPORT_TYPES[type].period === 'year';
        const now = new Date();
        const year  = num(b.year) || now.getFullYear();
        const month = wantsYear ? null : (num(b.month) || now.getMonth() + 1);
        if (!wantsYear && !(month >= 1 && month <= 12)) return bad(res, 'Choose a month');
        if (type === 'employee' && !uuidOr(b.employeeId)) return bad(res, 'Choose an employee for this report');
        const format = ['pdf', 'excel', 'csv'].includes(b.format) ? b.format : 'pdf';

        const spec = { type, month, year, department: trim(b.department) === 'all' ? '' : trim(b.department), employeeId: uuidOr(b.employeeId) };
        const built = await buildReport(req.schoolId, spec);
        if (!built.rows.length) return bad(res, `There is no payroll data for ${built.periodLabel} to report on yet.`);

        const report = await PayrollReport.create({
            school: req.schoolId,
            name: `${built.title} - ${built.periodLabel}`,
            type, month, year, periodLabel: built.periodLabel, format,
            filters: spec, summary: built.summary, rowCount: built.rows.length,
            generatedBy: req.userId, generatedAt: new Date(),
        });
        await logAudit(req, 'REPORT_GENERATED', 'PayrollReport', report._id, `${built.title} for ${built.periodLabel}`);
        res.status(201).json({ success: true, data: { _id: report._id, name: report.name, type, format, periodLabel: built.periodLabel, rowCount: built.rows.length, summary: built.summary } });
    } catch (e) { fail(res, e); }
};

/**
 * Rebuild the report from its recipe and stream it. Nothing was stored but the
 * recipe, so a report downloaded twice is identical and the database holds no
 * blobs — and a report of a month that has since been recomputed reflects what
 * the month now says, which is the only honest answer.
 */
exports.downloadReport = async (req, res) => {
    try {
        const report = await PayrollReport.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!report) return bad(res, 'Report not found', 404);
        const built = await buildReport(req.schoolId, report.filters || { type: report.type, month: report.month, year: report.year });
        const base = `${report.type}_${(report.periodLabel || '').replace(/\s+/g, '_')}`;

        if (report.format === 'pdf') {
            const school = await School.findById(req.schoolId).select('name address email phone logo').lean();
            const { renderReportPdf } = require('../utils/payrollReportPdf');
            return renderReportPdf(res, {
                filename: `${base}.pdf`,
                title: built.title, period: built.periodLabel,
                school, columns: built.columns, rows: built.rows, summary: built.summary,
            });
        }
        sendCsv(res, `${base}.csv`, built.columns.map(c => ({ label: c.label, value: (r) => r[c.key] })), built.rows);
    } catch (e) { fail(res, e); }
};

exports.deleteReport = async (req, res) => {
    try {
        const report = await PayrollReport.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!report) return bad(res, 'Report not found', 404);
        await PayrollReport.deleteOne({ _id: report._id });
        await logAudit(req, 'REPORT_DELETED', 'PayrollReport', report._id, `Deleted “${report.name}”`);
        ok(res, { _id: report._id });
    } catch (e) { fail(res, e); }
};

// ── Settings ─────────────────────────────────────────────────────────────────

exports.getSettings = async (req, res) => {
    try {
        const s = await settingsFor(req.schoolId);
        const now = new Date();
        const preview = await calc.workingDaysFor(req.schoolId, now.getFullYear(), now.getMonth() + 1, s);
        ok(res, { ...publicSettings(s), workingDaysThisMonth: preview });
    } catch (e) { fail(res, e); }
};

exports.updateSettings = async (req, res) => {
    try {
        const b = req.body || {};
        const before = await settingsFor(req.schoolId);
        const update = { updatedBy: req.userId };
        if (['fixed', 'calendar', 'school'].includes(b.workingDaysBasis)) update.workingDaysBasis = b.workingDaysBasis;
        if (b.fixedWorkingDays !== undefined) {
            const d = num(b.fixedWorkingDays);
            if (!(d >= 1 && d <= 31)) return bad(res, 'Working days must be between 1 and 31');
            update.fixedWorkingDays = Math.round(d);
        }
        if (Array.isArray(b.weeklyOffs)) update.weeklyOffs = b.weeklyOffs.map(num).filter(d => d >= 0 && d <= 6);
        if (b.payDay !== undefined) {
            const d = num(b.payDay);
            if (!(d >= 1 && d <= 28)) return bad(res, 'The pay day must be between 1 and 28');
            update.payDay = Math.round(d);
        }
        for (const [key, lo, hi] of [['autoOpenDay', 1, 28], ['remindDaysBefore', 1, 15]]) {
            if (b[key] === undefined) continue;
            const v = num(b[key]);
            if (!(v >= lo && v <= hi)) return bad(res, `${key} must be between ${lo} and ${hi}`);
            update[key] = Math.round(v);
        }
        if (b.financialYearStartMonth !== undefined) {
            const m = num(b.financialYearStartMonth);
            if (!(m >= 1 && m <= 12)) return bad(res, 'Choose a valid month for the financial year');
            update.financialYearStartMonth = Math.round(m);
        }
        if (b.roundTo !== undefined) {
            const r = num(b.roundTo);
            if (![0.01, 0.5, 1, 5, 10].includes(r)) return bad(res, 'Rounding must be 0.01, 0.5, 1, 5 or 10');
            update.roundTo = r;
        }
        for (const key of ['useLeaveForLop', 'useAttendanceForLop', 'notifyOnPublish', 'requireApproval',
            'separateApprover', 'autoOpenRun', 'remindBeforePayDay']) {
            if (b[key] !== undefined) update[key] = !!b[key];
        }
        for (const key of ['payslipPrefix', 'payslipNote', 'bankName', 'bankAccountNumber', 'bankIfsc']) {
            if (b[key] !== undefined) update[key] = trim(b[key]).slice(0, 200);
        }
        if (b.tax !== undefined) {
            const t = b.tax || {};
            if (!['none', 'new', 'old'].includes(t.regime)) return bad(res, 'Choose a tax regime, or “none” to deduct no tax');
            const slabs = Array.isArray(t.slabs) ? t.slabs : [];
            // An open-ended top slab is what makes the table cover every income.
            if (t.regime !== 'none' && slabs.length && !slabs.some(x => x.upTo === null || x.upTo === undefined || x.upTo === '')) {
                return bad(res, 'The highest slab must be open-ended — leave its “up to” blank');
            }
            for (const x of slabs) {
                if (num(x.rate) < 0 || num(x.rate) > 100) return bad(res, 'A tax rate must be between 0 and 100');
            }
            update.tax = {
                regime: t.regime,
                slabs: slabs.map(x => ({ upTo: x.upTo === null || x.upTo === undefined || x.upTo === '' ? null : num(x.upTo), rate: num(x.rate) })),
                standardDeduction: num(t.standardDeduction),
                cessPercent: num(t.cessPercent),
                rebateUpTo: num(t.rebateUpTo),
                rebateMax: num(t.rebateMax),
            };
        }

        await PayrollSettings.updateOne({ school: req.schoolId }, update, { upsert: true });
        const after = await settingsFor(req.schoolId);
        await logAudit(req, 'SETTINGS_UPDATED', 'PayrollSettings', after._id, 'Payroll settings updated',
            publicSettings(before), publicSettings(after));
        ok(res, publicSettings(after));
    } catch (e) { fail(res, e); }
};

// ── Audit log ────────────────────────────────────────────────────────────────

exports.getAuditLog = async (req, res) => {
    try {
        const { page, limit, offset } = pageArgs(req.query, 30);
        const { $, list } = params();
        const where = [`l."school" = ${$(String(req.schoolId))}`];
        if (trim(req.query.actionType)) where.push(`l."actionType" = ${$(trim(req.query.actionType))}`);
        if (trim(req.query.entityType)) where.push(`l."entityType" = ${$(trim(req.query.entityType))}`);
        if (uuidOr(req.query.entityId))  where.push(`l."entityId" = ${$(String(req.query.entityId))}`);

        const [rows, cnt] = await Promise.all([
            pool.query(`
              SELECT l.*, u."name" AS "userName"
                FROM ${T(PayrollAuditLog)} l
                LEFT JOIN ${T(User)} u ON u."_id" = l."user"
               WHERE ${where.join(' AND ')}
               ORDER BY COALESCE(l."timestamp", l."createdAt") DESC
               LIMIT ${limit} OFFSET ${offset}`, list),
            pool.query(`SELECT COUNT(*)::int AS "n" FROM ${T(PayrollAuditLog)} l WHERE ${where.join(' AND ')}`, list),
        ]);
        const total = num(cnt.rows[0]?.n);
        ok(res, rows.rows.map(r => ({
            _id: r._id, actionType: r.actionType, entityType: r.entityType, entityId: r.entityId,
            note: r.note || '', oldValue: r.oldValue, newValue: r.newValue,
            userName: r.userName || 'System', role: r.role,
            timestamp: r.timestamp || r.createdAt,
        })), { total, page, pages: Math.max(1, Math.ceil(total / limit)), limit });
    } catch (e) { fail(res, e); }
};

// ── Legacy shims ─────────────────────────────────────────────────────────────

/**
 * The shape the mobile admin dashboard reads. Kept key-for-key so the app does
 * not have to ship at the same time as the web redesign, with the corrected
 * employee scope (admins are staff too) underneath it.
 */
exports.getDashboard = async (req, res) => {
    try {
        const now   = new Date();
        const month = now.getMonth() + 1, year = now.getFullYear();
        const [staff, activeAssignments, currentRun, recentRuns] = await Promise.all([
            workforce(req.schoolId),
            EmployeeSalaryAssignment.countDocuments({ school: req.schoolId, isActive: true }),
            PayrollRun.findOne({ school: req.schoolId, year, month }).lean(),
            PayrollRun.find({ school: req.schoolId }).sort({ year: -1, month: -1 }).limit(6).lean(),
        ]);
        ok(res, {
            totalEmployees: staff.total,
            activeAssignments,
            currentRun, recentRuns,
            distribution: staff.distribution,
        });
    } catch (e) { fail(res, e); }
};

exports.buildReport = buildReport;
exports.computeRunEntries = computeRunEntries;
exports.refreshRunTotals = refreshRunTotals;
exports.settingsFor = settingsFor;

// ── Advances and loans ───────────────────────────────────────────────────────

const shapeAdvance = (a) => ({
    _id: a._id,
    employee: { _id: a.employee, name: a.employeeName, employeeId: a.empCode || '', department: a.department || '' },
    kind: a.kind, amount: r2(a.amount),
    instalments: num(a.instalments), instalmentAmount: r2(a.instalmentAmount),
    recovered: r2(a.recovered), outstanding: r2(num(a.amount) - num(a.recovered)),
    progress: num(a.amount) > 0 ? r2((num(a.recovered) / num(a.amount)) * 100) : 0,
    startLabel: monthLabel(num(a.startMonth), num(a.startYear)),
    startMonth: num(a.startMonth), startYear: num(a.startYear),
    status: a.status, reason: a.reason || '',
    history: a.history || [],
    disbursedOn: a.disbursedOn, closedAt: a.closedAt, closeNote: a.closeNote || '',
});

exports.listAdvances = async (req, res) => {
    try {
        const { page, limit, offset } = pageArgs(req.query, 10);
        const { $, list } = params();
        const where = [`a."school" = ${$(String(req.schoolId))}`];
        const status = trim(req.query.status) || 'active';
        if (status !== 'all') where.push(`a."status" = ${$(status)}`);
        if (uuidOr(req.query.employee)) where.push(`a."employee" = ${$(String(req.query.employee))}`);
        const search = trim(req.query.search);
        if (search) {
            const like = $(`%${search}%`);
            where.push(`(u."name" ILIKE ${like} OR COALESCE(tp."employeeId", '') ILIKE ${like} OR COALESCE(a."reason", '') ILIKE ${like})`);
        }
        const from = `
            FROM ${T(SalaryAdvance)} a
            JOIN ${T(User)} u ON u."_id" = a."employee"
            LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = a."school"
           WHERE ${where.join(' AND ')}`;

        const [rows, cnt, tiles] = await Promise.all([
            pool.query(`SELECT a.*, u."name" AS "employeeName", tp."employeeId" AS "empCode", tp."department"
                        ${from} ORDER BY a."createdAt" DESC LIMIT ${limit} OFFSET ${offset}`, list),
            pool.query(`SELECT COUNT(*)::int AS "n" ${from}`, list),
            (async () => {
                const q = params();
                return (await pool.query(`
                  SELECT COUNT(*) FILTER (WHERE a."status" = 'active')::int AS "active",
                         COALESCE(SUM(a."amount") FILTER (WHERE a."status" = 'active'), 0) AS "lent",
                         COALESCE(SUM(a."recovered") FILTER (WHERE a."status" = 'active'), 0) AS "back",
                         COUNT(*) FILTER (WHERE a."status" = 'closed')::int AS "closed"
                    FROM ${T(SalaryAdvance)} a WHERE a."school" = ${q.$(String(req.schoolId))}`, q.list)).rows[0];
            })(),
        ]);
        const total = num(cnt.rows[0]?.n);
        ok(res, rows.rows.map(shapeAdvance), {
            summary: {
                active: num(tiles.active), closed: num(tiles.closed),
                lent: r2(tiles.lent), recovered: r2(tiles.back),
                outstanding: r2(num(tiles.lent) - num(tiles.back)),
            },
            total, page, pages: Math.max(1, Math.ceil(total / limit)), limit,
        });
    } catch (e) { fail(res, e); }
};

exports.createAdvance = async (req, res) => {
    try {
        const b = req.body || {};
        if (!uuidOr(b.employeeId)) return bad(res, 'Choose an employee');
        const emp = await User.findOne({ _id: b.employeeId, school: req.schoolId, role: { $in: EMPLOYEE_ROLES } }).select('name').lean();
        if (!emp) return bad(res, 'That employee is not on this school’s staff');

        const amount = num(b.amount);
        if (!(amount > 0)) return bad(res, 'Enter the amount');
        const instalments = Math.max(1, Math.round(num(b.instalments) || 1));
        const month = num(b.startMonth), year = num(b.startYear);
        if (!(month >= 1 && month <= 12) || !(year >= 2000)) return bad(res, 'Choose the month recovery starts');

        /**
         * An instalment bigger than a month's pay would be recovered over more
         * months than intended and look like a mistake on every payslip until
         * it cleared. The run caps what it takes anyway, but saying so here is
         * better than finding out at payroll time.
         */
        const asgn = await EmployeeSalaryAssignment.findOne({ school: req.schoolId, employee: b.employeeId, isActive: true }).select('ctc').lean();
        const instalmentAmount = r2(amount / instalments);
        const monthly = asgn ? r2(num(asgn.ctc) / 12) : 0;
        if (monthly > 0 && instalmentAmount > monthly && b.force !== true) {
            return bad(res, `An instalment of ${inr(instalmentAmount)} is more than ${emp.name}'s monthly CTC of ${inr(monthly)}. Spread it over more months, or confirm to record it anyway.`);
        }

        const adv = await SalaryAdvance.create({
            employee: b.employeeId, school: req.schoolId,
            kind: b.kind === 'loan' ? 'loan' : 'advance',
            amount, instalments, instalmentAmount,
            startMonth: month, startYear: year,
            reason: trim(b.reason), approvedBy: req.userId,
            disbursedOn: asDate(b.disbursedOn) || new Date(),
        });
        await logAudit(req, 'ADVANCE_CREATED', 'SalaryAdvance', adv._id,
            `${inr(amount)} ${adv.kind} to ${emp.name}, ${instalments} instalment${instalments === 1 ? '' : 's'} from ${monthLabel(month, year)}`);
        res.status(201).json({ success: true, data: adv });
    } catch (e) { fail(res, e); }
};

exports.closeAdvance = async (req, res) => {
    try {
        const adv = await SalaryAdvance.findOne({ _id: req.params.id, school: req.schoolId });
        if (!adv) return bad(res, 'Advance not found', 404);
        if (adv.status !== 'active') return bad(res, `This ${adv.kind} is already ${adv.status}.`);
        const outstanding = r2(num(adv.amount) - num(adv.recovered));
        // Cancelling is for one that was never handed over; writing off accepts
        // the loss. Both close it, and the audit log says which it was.
        const writeOff = num(adv.recovered) > 0 || req.body?.writeOff === true;
        adv.status = writeOff ? 'closed' : 'cancelled';
        adv.closedAt = new Date();
        adv.closeNote = trim(req.body?.note) || (writeOff ? `Written off with ${inr(outstanding)} outstanding` : 'Cancelled before any recovery');
        await adv.save();
        await logAudit(req, writeOff ? 'ADVANCE_WRITTEN_OFF' : 'ADVANCE_CANCELLED', 'SalaryAdvance', adv._id, adv.closeNote);
        ok(res, adv);
    } catch (e) { fail(res, e); }
};

// ── Reimbursement claims ─────────────────────────────────────────────────────

const shapeClaim = (c) => ({
    _id: c._id,
    employee: { _id: c.employee, name: c.employeeName, employeeId: c.empCode || '', department: c.department || '' },
    category: c.category || 'Other', amount: r2(c.amount),
    description: c.description || '', claimedOn: c.claimedOn,
    status: c.status, taxable: !!c.taxable,
    paidInRun: c.paidInRun, paidOn: c.paidOn,
    decidedByName: c.decidedByName || null, decisionNote: c.decisionNote || '',
    attachment: c.attachment || '',
});

exports.listClaims = async (req, res) => {
    try {
        const { page, limit, offset } = pageArgs(req.query, 10);
        const { $, list } = params();
        const where = [`c."school" = ${$(String(req.schoolId))}`];
        const status = trim(req.query.status) || 'pending';
        if (status !== 'all') where.push(`c."status" = ${$(status)}`);
        if (uuidOr(req.query.employee)) where.push(`c."employee" = ${$(String(req.query.employee))}`);
        const search = trim(req.query.search);
        if (search) {
            const like = $(`%${search}%`);
            where.push(`(u."name" ILIKE ${like} OR COALESCE(c."description", '') ILIKE ${like} OR COALESCE(c."category", '') ILIKE ${like})`);
        }
        const from = `
            FROM ${T(SalaryClaim)} c
            JOIN ${T(User)} u ON u."_id" = c."employee"
            LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id" AND tp."school" = c."school"
            LEFT JOIN ${T(User)} du ON du."_id" = c."decidedBy"
           WHERE ${where.join(' AND ')}`;

        const [rows, cnt, tiles] = await Promise.all([
            pool.query(`SELECT c.*, u."name" AS "employeeName", tp."employeeId" AS "empCode", tp."department",
                               du."name" AS "decidedByName"
                        ${from} ORDER BY c."claimedOn" DESC LIMIT ${limit} OFFSET ${offset}`, list),
            pool.query(`SELECT COUNT(*)::int AS "n" ${from}`, list),
            (async () => {
                const q = params();
                return (await pool.query(`
                  SELECT COUNT(*) FILTER (WHERE c."status" = 'pending')::int AS "pending",
                         COALESCE(SUM(c."amount") FILTER (WHERE c."status" = 'pending'), 0) AS "pendingAmount",
                         COALESCE(SUM(c."amount") FILTER (WHERE c."status" = 'approved'), 0) AS "approvedAmount",
                         COALESCE(SUM(c."amount") FILTER (WHERE c."status" = 'paid'), 0) AS "paidAmount"
                    FROM ${T(SalaryClaim)} c WHERE c."school" = ${q.$(String(req.schoolId))}`, q.list)).rows[0];
            })(),
        ]);
        const total = num(cnt.rows[0]?.n);
        ok(res, rows.rows.map(shapeClaim), {
            summary: {
                pending: num(tiles.pending), pendingAmount: r2(tiles.pendingAmount),
                approvedAmount: r2(tiles.approvedAmount), paidAmount: r2(tiles.paidAmount),
            },
            total, page, pages: Math.max(1, Math.ceil(total / limit)), limit,
        });
    } catch (e) { fail(res, e); }
};

exports.createClaim = async (req, res) => {
    try {
        const b = req.body || {};
        if (!uuidOr(b.employeeId)) return bad(res, 'Choose an employee');
        const emp = await User.findOne({ _id: b.employeeId, school: req.schoolId, role: { $in: EMPLOYEE_ROLES } }).select('name').lean();
        if (!emp) return bad(res, 'That employee is not on this school’s staff');
        if (!(num(b.amount) > 0)) return bad(res, 'Enter the amount claimed');

        const claim = await SalaryClaim.create({
            employee: b.employeeId, school: req.schoolId,
            category: trim(b.category) || 'Other',
            amount: num(b.amount), description: trim(b.description),
            claimedOn: asDate(b.claimedOn) || new Date(),
            attachment: trim(b.attachment),
            taxable: b.taxable === true,
            // Recorded by the office on someone's behalf is already approved;
            // there is no second desk for it to wait at.
            status: b.approve === true ? 'approved' : 'pending',
            decidedBy: b.approve === true ? req.userId : null,
            decidedAt: b.approve === true ? new Date() : null,
        });
        await logAudit(req, 'CLAIM_CREATED', 'SalaryClaim', claim._id,
            `${inr(b.amount)} ${claim.category} claim for ${emp.name}`);
        res.status(201).json({ success: true, data: claim });
    } catch (e) { fail(res, e); }
};

exports.decideClaim = async (req, res) => {
    try {
        const decision = trim(req.body?.status);
        if (!['approved', 'rejected'].includes(decision)) return bad(res, 'Decide approved or rejected');
        const claim = await SalaryClaim.findOne({ _id: req.params.id, school: req.schoolId });
        if (!claim) return bad(res, 'Claim not found', 404);
        if (claim.status === 'paid') return bad(res, 'This claim has already been paid through payroll.');

        claim.status = decision;
        claim.decidedBy = req.userId;
        claim.decidedAt = new Date();
        claim.decisionNote = trim(req.body?.note);
        await claim.save();
        await logAudit(req, `CLAIM_${decision.toUpperCase()}`, 'SalaryClaim', claim._id, claim.decisionNote || decision);
        ok(res, claim);
    } catch (e) { fail(res, e); }
};

exports.deleteClaim = async (req, res) => {
    try {
        const claim = await SalaryClaim.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!claim) return bad(res, 'Claim not found', 404);
        if (claim.status === 'paid') return bad(res, 'A paid claim is part of a payroll record and cannot be removed.');
        await SalaryClaim.deleteOne({ _id: claim._id });
        await logAudit(req, 'CLAIM_DELETED', 'SalaryClaim', claim._id, 'Claim removed');
        ok(res, { _id: claim._id });
    } catch (e) { fail(res, e); }
};

// ── Full and final settlement ────────────────────────────────────────────────

/**
 * What a leaver is owed, or owes, on their last day.
 *
 * A settlement is not a payroll run of its own: it is the final month's pay
 * plus what the employment relationship leaves behind. Computing it separately
 * and then ADDING it to that month's entry keeps one payslip per month per
 * person, which is what every downstream figure in this module assumes.
 *
 * Five parts, each of which a school can argue with — so each is returned
 * separately with its working, and the admin decides what actually goes on the
 * entry rather than the software deciding for them:
 *
 *   final salary       the last month, pro-rated to the leaving date
 *   leave encashment   unused paid leave, at a day's basic
 *   gratuity           statutory, after five years of service
 *   notice recovery    where notice was not served
 *   advances           whatever is still outstanding, recovered in full
 */
exports.settlementPreview = async (req, res) => {
    try {
        const asgn = await EmployeeSalaryAssignment.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!asgn) return bad(res, 'Assignment not found', 404);
        const lastDay = asDate(req.query.lastDay) || (asgn.endDate ? new Date(asgn.endDate) : new Date());

        const [emp, profile, structure, settings] = await Promise.all([
            User.findOne({ _id: asgn.employee, school: req.schoolId }).select('name email').lean(),
            TeacherProfile.findOne({ user: asgn.employee, school: req.schoolId }).select('employeeId designation joiningDate').lean(),
            SalaryStructure.findOne({ _id: asgn.structure, school: req.schoolId }).lean(),
            settingsFor(req.schoolId),
        ]);
        if (!structure) return bad(res, 'This assignment has no salary structure, so a settlement cannot be computed.');

        const month = lastDay.getUTCMonth() + 1, year = lastDay.getUTCFullYear();
        const workingDays = await calc.workingDaysFor(req.schoolId, year, month, settings);
        const annualCtc = EmployeeSalaryAssignment.activeCtc(asgn, year, month);

        // The final month, stopped at the leaving date.
        const notEmployedDays = notEmployedDaysFor(
            { effectiveDate: asgn.effectiveDate, endDate: lastDay }, year, month, workingDays);
        const finalMonth = calc.computePay({
            structure, annualCtc, overrides: asgn.componentOverrides || [],
            notEmployedDays, workingDays, roundTo: settings.roundTo,
        });

        // A day's basic, which is what leave is encashed at.
        const fullMonth = calc.computePay({ structure, annualCtc, overrides: asgn.componentOverrides || [], workingDays, roundTo: settings.roundTo });
        const basicLine = fullMonth.earnings.find(e => /basic/i.test(e.name)) || fullMonth.earnings[0];
        const dailyBasic = r2(num(basicLine?.fullAmount || basicLine?.amount) / workingDays);

        // Unused paid leave, when the Leave module is keeping the balance.
        let leaveDays = 0, leaveSource = 'none';
        try {
            const { schoolModuleFlags } = require('../config/modules');
            const school = await School.findById(req.schoolId).select('modules').lean();
            if (schoolModuleFlags(school).leave) {
                const LeaveBalance = require('../models/LeaveBalance');
                const balances = await LeaveBalance.find({ school: req.schoolId, teacher: asgn.employee }).lean();
                leaveDays = r2(balances.reduce((s, b) => s + Math.max(0, num(b.available ?? (num(b.allocated) - num(b.used)))), 0));
                leaveSource = 'leave module';
            }
        } catch (err) { console.warn('[settlement] leave balance lookup skipped:', err.message); }
        const leaveEncashment = r2(leaveDays * dailyBasic);

        // Gratuity: 15 days' basic per completed year, after five years.
        const joined = profile?.joiningDate ? new Date(profile.joiningDate) : (asgn.effectiveDate ? new Date(asgn.effectiveDate) : null);
        const years = joined ? Math.floor((lastDay - joined) / (365.25 * 86400000)) : 0;
        const gratuityEligible = years >= 5;
        const monthlyBasic = r2(num(basicLine?.fullAmount || basicLine?.amount));
        const gratuity = gratuityEligible ? r2((monthlyBasic * 15 * years) / 26) : 0;

        // Everything still owed on advances comes back in one go.
        const advances = await SalaryAdvance.find({ school: req.schoolId, employee: asgn.employee, status: 'active' }).lean();
        const advanceOutstanding = r2(advances.reduce((s, a) => s + Math.max(0, num(a.amount) - num(a.recovered)), 0));

        // Approved expenses not yet paid are still owed to them.
        const claims = await SalaryClaim.find({ school: req.schoolId, employee: asgn.employee, status: 'approved' }).lean();
        const claimsDue = r2(claims.reduce((s, c) => s + num(c.amount), 0));

        const payable = r2(finalMonth.netSalary + leaveEncashment + gratuity + claimsDue);
        const recoverable = advanceOutstanding;

        ok(res, {
            employee: {
                _id: asgn.employee, name: emp?.name || '', email: emp?.email || '',
                employeeId: profile?.employeeId || '', designation: profile?.designation || '',
                joiningDate: joined,
            },
            lastDay,
            service: { years, months: joined ? Math.max(0, Math.round((lastDay - joined) / (30.44 * 86400000))) : 0 },
            finalMonth: {
                label: monthLabel(month, year),
                workingDays, paidDays: finalMonth.paidDays, notEmployedDays: finalMonth.notEmployedDays,
                gross: finalMonth.grossSalary, deductions: finalMonth.totalDeductions, net: finalMonth.netSalary,
                earnings: finalMonth.earnings, deductionLines: finalMonth.deductions,
            },
            leaveEncashment: { days: leaveDays, dailyBasic, amount: leaveEncashment, source: leaveSource },
            gratuity: {
                eligible: gratuityEligible, years, monthlyBasic, amount: gratuity,
                basis: gratuityEligible ? '15 days’ basic per completed year, over a 26-day month' : 'Five years of service are required',
            },
            claims: { count: claims.length, amount: claimsDue },
            advances: {
                count: advances.length, outstanding: advanceOutstanding,
                items: advances.map(a => ({ _id: a._id, kind: a.kind, amount: r2(a.amount), recovered: r2(a.recovered), outstanding: r2(num(a.amount) - num(a.recovered)) })),
            },
            payable, recoverable,
            settlement: r2(payable - recoverable),
            // Nothing here has been written. The admin applies it to a run.
            applied: false,
        });
    } catch (e) { fail(res, e); }
};

/**
 * Put a settlement onto the leaver's entry in a run, as a one-off addition and
 * a one-off recovery. The entry is then an ordinary edited entry — it goes
 * through the same review, the same approval and the same payslip as everyone
 * else's month, which is the whole point of not making it a separate run.
 */
exports.applySettlement = async (req, res) => {
    try {
        const asgn = await EmployeeSalaryAssignment.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!asgn) return bad(res, 'Assignment not found', 404);
        const runId = uuidOr(req.body?.runId);
        if (!runId) return bad(res, 'Choose the payroll run to settle in');

        const run = await PayrollRun.findOne({ _id: runId, school: req.schoolId }).lean();
        if (!run) return bad(res, 'Payroll run not found', 404);
        if (run.status === 'published') return bad(res, 'That run is published. Settle in an open run.');

        const entry = await PayrollEntry.findOne({ payrollRun: run._id, employee: asgn.employee, school: req.schoolId });
        if (!entry) return bad(res, 'This employee has no entry in that run — recompute it first, or choose another month.');

        const addition = r2(num(req.body?.addition));
        const recovery = r2(num(req.body?.recovery));
        if (addition < 0 || recovery < 0) return bad(res, 'A settlement cannot be negative');

        const settings = await settingsFor(req.schoolId);
        entry.bonus = r2(num(entry.bonus) + addition);
        entry.otherDeductions = r2(num(entry.otherDeductions) + recovery);
        entry.remarks = trim(req.body?.note) || 'Full and final settlement';
        entry.isEdited = true;

        const raw = num(entry.grossSalary) - num(entry.totalDeductions)
            + num(entry.arrears) + num(entry.bonus) + num(entry.reimbursement)
            - num(entry.otherDeductions) - num(entry.advanceRecovery);
        entry.netSalary   = calc.roundAmount(Math.max(0, raw), settings.roundTo);
        entry.unrecovered = calc.roundAmount(Math.max(0, -raw), settings.roundTo);
        await entry.save();

        // The assignment ends here, so no later run picks this person up.
        const lastDay = asDate(req.body?.lastDay);
        await EmployeeSalaryAssignment.updateOne({ _id: asgn._id }, {
            isActive: false,
            endDate: lastDay || asgn.endDate || new Date(),
        });

        await refreshRunTotals(run._id);
        await logAudit(req, 'SETTLEMENT_APPLIED', 'PayrollEntry', entry._id,
            `Settlement in ${defaultRunName(run.month, run.year)}: ${inr(addition)} paid, ${inr(recovery)} recovered`);
        const fresh = await PayrollRun.findById(run._id).lean();
        ok(res, { entry: entry.toObject ? entry.toObject() : entry, run: shapeRun(fresh) });
    } catch (e) { fail(res, e); }
};
