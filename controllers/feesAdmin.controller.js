'use strict';
/**
 * Read models behind the ten admin Fees screens (Sep 2026 redesign).
 *
 * Each screen states a handful of figures about tables that grow for years —
 * the ledger alone gains a row for every charge, payment and concession — so
 * every figure here is counted in SQL (db/aggregate.js runs $lookup in JS and
 * would pull whole tables into memory). The writers stay in fees.controller.js;
 * this file only reads, plus the few actions that exist purely for these
 * screens (bulk concession assignment, other-fine charging, reminders, report
 * email/schedules, backup, copying structures between years).
 *
 * Money lives on the ledger (FeeLedger), which is the canonical balance:
 *   charged  = fee_charged + fine debits
 *   paid     = payment credits − refund debits
 *   waived   = concession credits − concession withdrawals
 *   due      = every debit − every credit (negative = paid in advance)
 * "Total fees" on a row is charged − waived, so total = paid + due.
 */
const pool          = require('../db/pool');
const { isUuid }    = require('../db/schema');
const TZ            = require('../config/timezone');
const XLSX          = require('xlsx');

const AcademicYear         = require('../models/AcademicYear');
const Class                = require('../models/Class');
const ClassSection         = require('../models/ClassSection');
const StudentProfile       = require('../models/StudentProfile');
const User                 = require('../models/User');
const School               = require('../models/School');
const FeeCategory          = require('../models/FeeCategory');
const FeeHead              = require('../models/FeeHead');
const FeeStructure         = require('../models/FeeStructure');
const FeeLedger            = require('../models/FeeLedger');
const FeePayment           = require('../models/FeePayment');
const FeeConcession        = require('../models/FeeConcession');
const StudentConcession    = require('../models/StudentConcession');
const StudentFeeAssignment = require('../models/StudentFeeAssignment');
const FineRule             = require('../models/FineRule');
const FeeSettings          = require('../models/FeeSettings');
const FeeAuditLog          = require('../models/FeeAuditLog');
const FeeReminderLog       = require('../models/FeeReminderLog');
const reminders            = require('../services/feeReminders');
const Designation          = require('../models/Designation');
const ReceiptTemplate      = require('../models/ReceiptTemplate');

const feesCtl = require('./fees.controller');
const { logFeeAudit } = require('../services/feeAudit');
const { appendLedger, roundMoney } = require('../services/feeConcessions');
const { legacyStart } = require('../services/feeCharging');
const Sched = require('../services/feeSchedule');
const { notify, withParents } = require('../services/notifyService');
const { sendSchoolMail, emailHeaderHtml } = require('../utils/schoolMailer');
const { renderReceipt, defaultTemplate } = require('../services/receiptRenderer');

// ── Plumbing ─────────────────────────────────────────────────────────────────

const T = (Model) => `"${Model.tableName}"`;
const ok   = (res, data, extra) => res.json({ success: true, data, ...(extra || {}) });
const bad  = (res, message) => res.status(400).json({ success: false, message });
const fail = (res, e) => {
    console.error('[FeesAdmin]', e);
    res.status(500).json({ success: false, message: e.message || 'Something went wrong' });
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const uuidOr = (v) => (isUuid(String(v || '')) ? String(v) : null);
const UUID_RE = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

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

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
/** A YYYY-MM-DD read as the school's local midnight (config/timezone pins TZ). */
const localDay = (v) => (isDay(v) ? new Date(`${v}T00:00:00`) : null);
const endOfDay = (d) => { const e = new Date(d); e.setHours(23, 59, 59, 999); return e; };
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Percent change, or null when there is nothing to compare against. */
const change = (now, before) => (before > 0 ? r2((now - before) / before * 100) : (now > 0 ? null : 0));

// Counter modes grouped the way the screens count them.
const MODE_GROUP  = { online: 'online', upi: 'online', bank_transfer: 'online', cash: 'cash', card: 'card', cheque: 'other', dd: 'other' };
const GROUP_MODES = { online: ['online', 'upi', 'bank_transfer'], cash: ['cash'], card: ['card'], other: ['cheque', 'dd'] };
const groupSql = (col) => `CASE WHEN ${col} IN ('online','upi','bank_transfer') THEN 'online'
                                WHEN ${col} = 'cash' THEN 'cash' WHEN ${col} = 'card' THEN 'card' ELSE 'other' END`;

/** "10A" for Class 10 section A; the class name alone when there is no number. */
function classLabel(classNumber, className, sectionName) {
    const base = classNumber != null && classNumber !== '' ? String(Number(classNumber)) : String(className || '').replace(/^class\s*/i, '');
    if (!sectionName) return base || '—';
    return `${base}${String(sectionName).length <= 2 ? '' : ' '}${sectionName}`;
}
const classTitle = (classNumber, className) => className || (classNumber != null ? `Class ${Number(classNumber)}` : '—');

/**
 * The academic year a screen shows: the one asked for, else the one Fees →
 * Settings names as default, else the school's active year.
 */
async function resolveYear(schoolId, requested) {
    const [years, settings] = await Promise.all([
        AcademicYear.find({ school: schoolId }).sort({ startDate: -1 }).lean(),
        feesCtl.getOrCreateSettings(schoolId),
    ]);
    const byId = (id) => years.find(y => String(y._id) === String(id));
    const year = (requested && uuidOr(requested) && byId(requested))
        || (settings?.defaultAcademicYear && byId(settings.defaultAcademicYear))
        || years.find(y => y.status === 'active')
        || years[0] || null;
    return { year, years, settings };
}
/** The year before `year`, for "vs last year" comparisons. */
const previousYear = (years, year) => (year ? years.find(y => new Date(y.startDate) < new Date(year.startDate)) || null : null);

const yearOut = (y) => y && ({ _id: y._id, yearName: y.yearName, status: y.status, startDate: y.startDate, endDate: y.endDate });

/**
 * CTEs `secs` (sections in scope with their class) and `roster` (one row per
 * active student in them, with the ONE section they count under). Membership
 * is read from both places it is recorded — the profile pointer and the
 * section's enrolledStudents — and the profile wins, as on the attendance
 * screens (see project notes on the two sources of truth).
 */
function rosterCtes($, { schoolId, yearId, classId, sectionId }) {
    const school = $(String(schoolId));
    const f = [`cs."school" = ${school}`, `COALESCE(cs."status", 'active') = 'active'`];
    if (yearId)    f.push(`cs."academicYear" = ${$(String(yearId))}`);
    if (classId)   f.push(`cs."class" = ${$(String(classId))}`);
    if (sectionId) f.push(`cs."_id" = ${$(String(sectionId))}`);
    return `
    secs AS (
        SELECT cs."_id", cs."sectionName", c."_id" AS "classId", c."className", c."classNumber"
          FROM ${T(ClassSection)} cs JOIN ${T(Class)} c ON c."_id" = cs."class"
         WHERE ${f.join(' AND ')}
    ),
    members AS (
        SELECT sp."user" AS "student", sp."currentSection" AS "section", 0 AS "pref"
          FROM ${T(StudentProfile)} sp JOIN secs ON secs."_id" = sp."currentSection"
        UNION ALL
        SELECT CASE WHEN e.id ~* ${UUID_RE} THEN e.id::uuid END, cs."_id", 1
          FROM ${T(ClassSection)} cs JOIN secs ON secs."_id" = cs."_id"
         CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(cs."enrolledStudents") = 'array' THEN cs."enrolledStudents" ELSE '[]'::jsonb END) AS e(id)
    ),
    roster AS (
        SELECT DISTINCT ON (m."student") m."student", m."section", s."sectionName", s."classId", s."className", s."classNumber"
          FROM members m
          JOIN secs s ON s."_id" = m."section"
          JOIN ${T(User)} u ON u."_id" = m."student" AND u."role" = 'student'
               AND u."school" = ${school} AND u."isActive" IS NOT FALSE
         WHERE m."student" IS NOT NULL
         ORDER BY m."student", m."pref"
    )`;
}

/** CTE `bal`: one row per student with money on the ledger in the year. */
function balanceCte($, { schoolId, yearId, asOf = null }) {
    const cut = asOf ? `AND l."createdAt" < ${$(asOf)}` : '';
    return `
    bal AS (
        SELECT l."student",
               SUM(CASE WHEN l."entryType" = 'debit' AND l."category" IN ('fee_charged','fine') THEN l."amount" ELSE 0 END) AS "charged",
               SUM(CASE WHEN l."entryType" = 'debit' AND l."category" = 'fine' THEN l."amount" ELSE 0 END) AS "fine",
               SUM(CASE WHEN l."category" = 'payment' AND l."entryType" = 'credit' THEN l."amount"
                        WHEN l."category" = 'refund'  AND l."entryType" = 'debit'  THEN -l."amount" ELSE 0 END) AS "paid",
               SUM(CASE WHEN l."category" = 'concession' AND l."entryType" = 'credit' THEN l."amount"
                        WHEN l."referenceType" = 'StudentConcession' AND l."entryType" = 'debit' THEN -l."amount" ELSE 0 END) AS "waived",
               SUM(CASE WHEN l."entryType" = 'debit' THEN l."amount" ELSE -l."amount" END) AS "due"
          FROM ${T(FeeLedger)} l
         WHERE l."school" = ${$(String(schoolId))} AND l."academicYear" = ${$(String(yearId))} ${cut}
         GROUP BY l."student"
    )`;
}

const STATUS_SQL = `CASE WHEN COALESCE(b."charged", 0) <= 0.004 THEN 'none'
                         WHEN COALESCE(b."due", 0) <= 0.004 THEN 'paid'
                         WHEN COALESCE(b."paid", 0) > 0.004 THEN 'partial'
                         ELSE 'pending' END`;

/**
 * Per month in [from, to): what was collected, what was charged, and how much
 * of that month's charge is still open. "Open" is worked out first-in
 * first-out per student — a student's credits settle their oldest charges
 * first — which is how the fee book allocates payments to months too.
 */
async function monthlyMoney({ schoolId, yearId, from, to, classId = null, sectionId = null }) {
    const p = params();
    const scoped = classId || sectionId;
    const ctes = scoped ? `${rosterCtes(p.$, { schoolId, yearId, classId, sectionId })},` : '';
    const inScope = (alias) => (scoped ? `AND ${alias}."student" IN (SELECT "student" FROM roster)` : '');
    const school = p.$(String(schoolId));
    const year = p.$(String(yearId));
    const tz = p.$(TZ);
    const fromP = p.$(from);
    const toP = p.$(to);
    const sql = `WITH ${ctes}
      deb AS (
        SELECT l."student", l."amount", COALESCE(l."periodStart", l."createdAt") AS "createdAt",
               SUM(l."amount") OVER (PARTITION BY l."student" ORDER BY COALESCE(l."periodStart", l."createdAt"), l."createdAt", l."_id") AS "cum"
          FROM ${T(FeeLedger)} l
         WHERE l."school" = ${school} AND l."academicYear" = ${year} AND l."entryType" = 'debit' ${inScope('l')}
      ),
      cred AS (
        SELECT l."student", SUM(l."amount") AS "c"
          FROM ${T(FeeLedger)} l
         WHERE l."school" = ${school} AND l."academicYear" = ${year} AND l."entryType" = 'credit' ${inScope('l')}
         GROUP BY l."student"
      ),
      charged AS (
        SELECT to_char(date_trunc('month', d."createdAt" AT TIME ZONE ${tz}), 'YYYY-MM') AS "m",
               SUM(d."amount") AS "charged",
               SUM(GREATEST(0, LEAST(d."amount", d."cum" - COALESCE(c."c", 0)))) AS "open"
          FROM deb d LEFT JOIN cred c ON c."student" = d."student"
         WHERE d."createdAt" >= ${fromP} AND d."createdAt" < ${toP}
         GROUP BY 1
      ),
      paid AS (
        SELECT to_char(date_trunc('month', fp."paymentDate" AT TIME ZONE ${tz}), 'YYYY-MM') AS "m",
               SUM(fp."amount") AS "collected", COUNT(*) AS "n"
          FROM ${T(FeePayment)} fp
         WHERE fp."school" = ${school} AND fp."paymentStatus" = 'completed'
           AND fp."paymentDate" >= ${fromP} AND fp."paymentDate" < ${toP} ${inScope('fp')}
         GROUP BY 1
      )
      SELECT COALESCE(a."m", b."m") AS "m", COALESCE(a."charged", 0) AS "charged", COALESCE(a."open", 0) AS "open",
             COALESCE(b."collected", 0) AS "collected", COALESCE(b."n", 0) AS "n"
        FROM charged a FULL OUTER JOIN paid b ON a."m" = b."m"`;
    const { rows } = await pool.query(sql, p.list);
    return new Map(rows.map(r => [r.m, {
        charged: r2(r.charged), open: r2(r.open), collected: r2(r.collected), count: Number(r.n) || 0,
    }]));
}

/** Every month from `from` up to (not including) `to`, as {key,label,start}. */
function monthsBetween(from, to) {
    const out = [];
    const d = new Date(from.getFullYear(), from.getMonth(), 1);
    for (let i = 0; i < 36 && d < to; i++) {
        out.push({ key: monthKey(d), label: MONTHS[d.getMonth()], year: d.getFullYear(), start: new Date(d) });
        d.setMonth(d.getMonth() + 1);
    }
    return out;
}

/** The window a "Last N months" select means: the current month and N−1 before it. */
function lastMonths(n) {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { from, to };
}

/** The months a trend select covers: 'year' is the academic year to date. */
function trendWindow(range, year) {
    if (range === 'year' && year) {
        const now = new Date();
        const from = new Date(year.startDate);
        const end = new Date(year.endDate);
        const to = new Date(Math.min(end.getTime() + 86400000, new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()));
        return { from: new Date(from.getFullYear(), from.getMonth(), 1), to };
    }
    return lastMonths(range === '12' ? 12 : 6);
}

/**
 * Collected money split across fee heads. A payment line that names its head
 * counts for that head; a generic payment is shared across the student's own
 * charges in proportion — what they were charged is what they were paying.
 * Returns Map(headId|'_other' → amount). `students` limits the students.
 */
async function collectedByHead({ schoolId, yearId, from = null, to = null, studentFilter = null }) {
    const p = params();
    const school = p.$(String(schoolId));
    const year = p.$(String(yearId));
    const range = [
        from ? `AND fp."paymentDate" >= ${p.$(from)}` : '',
        to   ? `AND fp."paymentDate" <  ${p.$(to)}`   : '',
    ].join(' ');
    const only = studentFilter ? `AND fp."student" = ANY(${p.$(studentFilter)}::uuid[])` : '';
    const onlyL = studentFilter ? `AND l."student" = ANY(${p.$(studentFilter)}::uuid[])` : '';
    const sql = `
      WITH lines AS (
        SELECT fp."student", (ln->>'feeHead') AS "head", COALESCE((ln->>'amount')::float, 0) AS "amt"
          FROM ${T(FeePayment)} fp
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fp."lines") = 'array' AND jsonb_array_length(fp."lines") > 0
                                                      THEN fp."lines" ELSE jsonb_build_array(jsonb_build_object('amount', fp."amount")) END) ln
         WHERE fp."school" = ${school} AND fp."academicYear" = ${year} AND fp."paymentStatus" = 'completed' ${range} ${only}
      ),
      items AS (
        SELECT l."student", (it->>'feeHead') AS "head",
               CASE WHEN l."feeItemId" IS NOT NULL
                    THEN CASE WHEN (it->>'_id') = l."feeItemId"::text THEN l."amount" ELSE 0 END
                    ELSE l."amount" * COALESCE((it->>'amount')::float, 0) / NULLIF(tot."t", 0) END AS "amt"
          FROM ${T(FeeLedger)} l
          JOIN ${T(FeeStructure)} fs ON fs."_id" = l."referenceId"
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fs."items") = 'array' THEN fs."items" ELSE '[]'::jsonb END) it
         CROSS JOIN LATERAL (SELECT SUM(COALESCE((x->>'amount')::float, 0)) AS "t"
                               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(fs."items") = 'array' THEN fs."items" ELSE '[]'::jsonb END) x
                              WHERE COALESCE((x->>'isActive')::boolean, true)) tot
         WHERE l."school" = ${school} AND l."academicYear" = ${year} AND l."category" = 'fee_charged'
           AND l."entryType" = 'debit' AND l."referenceType" = 'FeeStructure'
           AND COALESCE((it->>'isActive')::boolean, true) ${onlyL}
      ),
      share AS (
        SELECT i."student", i."head", SUM(i."amt") / NULLIF(SUM(SUM(i."amt")) OVER (PARTITION BY i."student"), 0) AS "w"
          FROM items i GROUP BY i."student", i."head"
      ),
      named AS (SELECT "head", SUM("amt") AS "amt" FROM lines WHERE "head" ~* ${UUID_RE} GROUP BY 1),
      generic AS (SELECT "student", SUM("amt") AS "amt" FROM lines WHERE "head" IS NULL OR NOT ("head" ~* ${UUID_RE}) GROUP BY 1),
      spread AS (
        SELECT COALESCE(s."head", '_other') AS "head", SUM(g."amt" * COALESCE(s."w", 1)) AS "amt"
          FROM generic g LEFT JOIN share s ON s."student" = g."student"
         GROUP BY 1
      )
      SELECT "head", SUM("amt") AS "amt" FROM (SELECT * FROM named UNION ALL SELECT * FROM spread) u GROUP BY 1`;
    const { rows } = await pool.query(sql, p.list);
    return new Map(rows.map(r => [r.head, r2(r.amt)]));
}

// ── Meta: what every screen's pickers need ───────────────────────────────────

exports.meta = async (req, res) => {
    try {
        const { year, years, settings } = await resolveYear(req.schoolId, req.query.academicYearId);
        const [classes, sections, categories, heads, structures] = await Promise.all([
            year ? Class.find({ school: req.schoolId, academicYear: year._id }).sort({ classNumber: 1 }).lean() : [],
            year ? ClassSection.find({ school: req.schoolId, academicYear: year._id }).sort({ sectionName: 1 }).lean() : [],
            FeeCategory.find({ school: req.schoolId }).sort({ name: 1 }).lean(),
            FeeHead.find({ school: req.schoolId, isArchived: { $ne: true } }).sort({ name: 1 }).lean(),
            // The structures a student can be moved onto — live ones only.
            year ? FeeStructure.find({ school: req.schoolId, academicYear: year._id, isActive: true }).select('name class section level').sort({ name: 1 }).lean() : [],
        ]);
        const s = settings || {};
        ok(res, {
            year: yearOut(year),
            years: years.map(yearOut),
            classes: classes.map(c => ({
                _id: c._id, className: classTitle(c.classNumber, c.className), classNumber: c.classNumber,
                sections: sections.filter(x => String(x.class) === String(c._id) && (x.status || 'active') === 'active')
                    .map(x => ({ _id: x._id, sectionName: x.sectionName })),
            })),
            categories: categories.map(c => ({ _id: c._id, name: c.name, isActive: c.isActive !== false })),
            structures: structures.map(st => {
                const sec = st.section ? sections.find(x => String(x._id) === String(st.section)) : null;
                const cls = classes.find(c => String(c._id) === String(st.class || sec?.class || ''));
                return { _id: st._id, name: st.name, level: st.level,
                    label: [cls ? classTitle(cls.classNumber, cls.className) : null, st.level === 'section' && sec ? `Section ${sec.sectionName}` : null].filter(Boolean).join(' · ') };
            }),
            heads: heads.map(h => ({
                _id: h._id, name: h.name, type: h.type, amountType: h.amountType || 'fixed',
                defaultAmount: h.defaultAmount || 0, category: h.category, isActive: h.isActive !== false,
            })),
            settings: {
                currencySymbol: s.currencySymbol || '₹',
                acceptedModes: Array.isArray(s.acceptedModes) && s.acceptedModes.length ? s.acceptedModes : FeeSettings.COUNTER_MODES,
                allowPartialPayments: s.allowPartialPayments !== false,
                autoGenerateReceipt: s.autoGenerateReceipt !== false,
                showPreviousDues: s.showPreviousDues !== false,
                collectionStart: s.collectionStart || null,
                collectionEnd: s.collectionEnd || null,
                defaultGraceDays: s.defaultGraceDays ?? 5,
                lateFeeCalculation: s.lateFeeCalculation || 'per_day',
                minPaymentAmount: s.minPaymentAmount || 0,
            },
        });
    } catch (e) { fail(res, e); }
};

// ── Dashboard ────────────────────────────────────────────────────────────────

exports.overview = async (req, res) => {
    try {
        const { year } = await resolveYear(req.schoolId, req.query.academicYearId);
        if (!year) return ok(res, { year: null });
        const schoolId = req.schoolId;
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const monthAgo = new Date(now); monthAgo.setMonth(monthAgo.getMonth() - 1);
        const classId = uuidOr(req.query.classId);

        // Tiles ─ one pass over payments, one over balances now and a month ago.
        const pt = params();
        const tilesSql = `
          SELECT COALESCE(SUM(fp."amount"), 0) AS "collected", COUNT(*) AS "n",
                 COALESCE(SUM(fp."amount") FILTER (WHERE fp."paymentDate" >= ${pt.$(monthStart)}), 0) AS "thisMonth",
                 COALESCE(SUM(fp."amount") FILTER (WHERE fp."paymentDate" >= ${pt.$(lastMonthStart)} AND fp."paymentDate" < ${pt.$(monthStart)}), 0) AS "lastMonth",
                 COUNT(*) FILTER (WHERE fp."paymentDate" >= ${pt.$(monthStart)}) AS "nThis",
                 COUNT(*) FILTER (WHERE fp."paymentDate" >= ${pt.$(lastMonthStart)} AND fp."paymentDate" < ${pt.$(monthStart)}) AS "nLast"
            FROM ${T(FeePayment)} fp
           WHERE fp."school" = ${pt.$(String(schoolId))} AND fp."academicYear" = ${pt.$(String(year._id))} AND fp."paymentStatus" = 'completed'`;

        const dueSql = (asOf) => {
            const p = params();
            const sql = `WITH ${balanceCte(p.$, { schoolId, yearId: year._id, asOf })}
              SELECT COALESCE(SUM(GREATEST(b."due", 0)), 0) AS "pending",
                     COUNT(*) FILTER (WHERE b."due" > 0.004) AS "owing",
                     COALESCE(SUM(b."waived"), 0) AS "waived"
                FROM bal b`;
            return pool.query(sql, p.list);
        };

        const pr = params();
        const rosterSql = `WITH ${rosterCtes(pr.$, { schoolId, yearId: year._id })},
          ${balanceCte(pr.$, { schoolId, yearId: year._id })}
          SELECT r."student", r."classId", r."className", r."classNumber", r."section", r."sectionName",
                 u."createdAt", COALESCE(b."charged", 0) - COALESCE(b."waived", 0) AS "net",
                 COALESCE(b."paid", 0) AS "paid", COALESCE(b."due", 0) AS "due"
            FROM roster r JOIN ${T(User)} u ON u."_id" = r."student"
            LEFT JOIN bal b ON b."student" = r."student"`;

        const range = String(req.query.range || '6');
        const win = trendWindow(range, year);
        const [tiles, dueNow, dueBefore, rosterRows, trendMap, recent] = await Promise.all([
            pool.query(tilesSql, pt.list),
            dueSql(null),
            dueSql(monthAgo),
            pool.query(rosterSql, pr.list),
            monthlyMoney({ schoolId, yearId: year._id, from: win.from, to: win.to }),
            recentPayments(schoolId, { yearId: year._id, limit: 5 }),
        ]);
        const t = tiles.rows[0] || {};
        const dn = dueNow.rows[0] || {};
        const db = dueBefore.rows[0] || {};
        const students = rosterRows.rows;
        const newStudents = students.filter(s => new Date(s.createdAt) >= monthAgo).length;

        // Collection by class (or by section of one class).
        const groups = new Map();
        for (const s of students) {
            if (classId && String(s.classId) !== classId) continue;
            const key = classId ? String(s.section) : String(s.classId);
            const g = groups.get(key) || {
                _id: key,
                label: classId ? `Section ${s.sectionName}` : classTitle(s.classNumber, s.className),
                order: classId ? String(s.sectionName) : Number(s.classNumber) || 0,
                net: 0, paid: 0, students: 0, owing: 0,
            };
            // An advance is not collection against this year's fees: each
            // student counts for at most what they owe.
            const net = Math.max(0, Number(s.net) || 0);
            g.net += net;
            g.paid += Math.min(net, Math.max(0, Number(s.paid) || 0));
            g.students += 1;
            if (Number(s.due) > 0.004) g.owing += 1;
            groups.set(key, g);
        }
        const byGroup = [...groups.values()]
            .map(g => ({ _id: g._id, label: g.label, order: g.order, students: g.students, owing: g.owing,
                net: r2(g.net), paid: r2(g.paid), pct: g.net > 0 ? Math.min(100, Math.round(g.paid / g.net * 100)) : null }))
            .sort((a, b) => (classId ? String(a.order).localeCompare(String(b.order)) : b.order - a.order));

        // Pending dues alert: students owing, by class, three worst then the rest.
        const owingByClass = [...students.reduce((m, s) => {
            if (Number(s.due) <= 0.004) return m;
            const k = String(s.classId);
            const g = m.get(k) || { classId: k, label: classTitle(s.classNumber, s.className), count: 0, amount: 0 };
            g.count += 1; g.amount += Number(s.due) || 0;
            m.set(k, g);
            return m;
        }, new Map()).values()].sort((a, b) => b.count - a.count || b.amount - a.amount);
        const owingTotal = owingByClass.reduce((s, g) => s + g.count, 0);

        const collected = r2(t.collected);
        const pending = r2(dn.pending);
        const waived = r2(dn.waived);
        ok(res, {
            year: yearOut(year),
            tiles: {
                collected, collectedChange: change(Number(t.thisMonth), Number(t.lastMonth)),
                pending, pendingChange: change(Number(dn.pending), Number(db.pending)),
                students: students.length, newStudents,
                transactions: Number(t.n) || 0, transactionsChange: change(Number(t.nThis), Number(t.nLast)),
            },
            trend: monthsBetween(win.from, win.to).map(m => {
                const v = trendMap.get(m.key) || { charged: 0, open: 0, collected: 0 };
                return { month: m.key, label: m.label, year: m.year, collected: v.collected, charged: v.charged,
                    pending: v.open, settled: r2(v.charged - v.open) };
            }),
            byGroup,
            recent,
            alert: {
                students: owingTotal,
                top: owingByClass.slice(0, 3).map(g => ({ classId: g.classId, label: g.label, count: g.count, amount: r2(g.amount) })),
                others: owingByClass.slice(3).reduce((s, g) => s + g.count, 0),
            },
            summary: {
                collected, pending, notApplicable: waived,
                pct: collected + pending > 0 ? Math.round(collected / (collected + pending) * 100) : 0,
            },
        });
    } catch (e) { fail(res, e); }
};

/** The latest payments with the student's name, admission number and class. */
async function recentPayments(schoolId, { yearId = null, limit = 5 } = {}) {
    const p = params();
    const sql = `
      SELECT fp."_id", fp."student", fp."amount", fp."paymentMode", fp."paymentStatus", fp."paymentDate",
             fp."receiptNumber", fp."gateway", fp."lines", u."name",
             sp."admissionNumber", cs."sectionName", c."className", c."classNumber"
        FROM ${T(FeePayment)} fp
        LEFT JOIN ${T(User)} u ON u."_id" = fp."student"
        LEFT JOIN ${T(StudentProfile)} sp ON sp."user" = fp."student" AND sp."school" = fp."school"
        LEFT JOIN ${T(ClassSection)} cs ON cs."_id" = sp."currentSection"
        LEFT JOIN ${T(Class)} c ON c."_id" = cs."class"
       WHERE fp."school" = ${p.$(String(schoolId))} ${yearId ? `AND fp."academicYear" = ${p.$(String(yearId))}` : ''}
       ORDER BY fp."paymentDate" DESC, fp."createdAt" DESC
       LIMIT ${p.$(limit)}`;
    const { rows } = await pool.query(sql, p.list);
    return rows.map(paymentRow);
}

function paymentRow(r) {
    const lines = Array.isArray(r.lines) ? r.lines : [];
    const named = lines.filter(l => l && l.feeName && l.feeName !== 'Fee Payment');
    return {
        _id: r._id,
        student: { _id: r.student, name: r.name || r.studentName || '—' },
        admissionNumber: r.admissionNumber || '',
        classLabel: r.sectionName || r.classNumber != null || r.className ? classLabel(r.classNumber, r.className, r.sectionName) : '—',
        feeHead: named.length ? named[0].feeName + (named.length > 1 ? ` +${named.length - 1}` : '') : 'Fee payment',
        amount: r2(r.amount),
        mode: r.paymentMode,
        group: MODE_GROUP[r.paymentMode] || 'other',
        status: r.paymentStatus,
        date: r.paymentDate,
        receiptNumber: r.receiptNumber || null,
        gateway: r.gateway || 'manual',
        transactionRef: r.transactionRef || '',
        remarks: r.remarks || '',
        collectedBy: r.collectedByName || null,
        voidReason: r.voidReason || '',
        refundedAt: r.refundedAt || null,
    };
}

// ── Student Fees ─────────────────────────────────────────────────────────────

const STUDENT_SORTS = {
    name:  `u."name" ASC`,
    '-name': `u."name" DESC`,
    due:   `"due" ASC, u."name" ASC`,
    '-due': `"due" DESC, u."name" ASC`,
    class: `r."classNumber" ASC NULLS LAST, r."sectionName" ASC, u."name" ASC`,
};

/**
 * The student list with money columns. The tiles and tab counts are counted
 * over every filter EXCEPT status, so they do not move when a tab is pressed.
 */
exports.studentFees = async (req, res) => {
    try {
        const q = req.query;
        const { year, settings } = await resolveYear(req.schoolId, q.academicYearId);
        if (!year) return ok(res, { year: null, rows: [], counts: {} }, { total: 0, page: 1, pages: 0 });
        const { page, limit, offset } = pageArgs(q, 10);

        const p = params();
        const prevOn = settings?.showPreviousDues !== false;
        const conds = [];
        if (q.q && String(q.q).trim()) {
            const like = p.$(`%${String(q.q).trim()}%`);
            conds.push(`(u."name" ILIKE ${like} OR sp."admissionNumber" ILIKE ${like} OR sp."rollNumber" ILIKE ${like} OR u."email" ILIKE ${like})`);
        }
        if (uuidOr(q.structureId)) conds.push(`EXISTS (SELECT 1 FROM ${T(StudentFeeAssignment)} a WHERE a."student" = r."student" AND a."academicYear" = ${p.$(String(year._id))} AND a."feeStructure" = ${p.$(q.structureId)})`);
        if (q.concession === 'with' || q.concession === 'without') {
            conds.push(`${q.concession === 'with' ? '' : 'NOT'} EXISTS (SELECT 1 FROM ${T(StudentConcession)} sc WHERE sc."student" = r."student" AND sc."academicYear" = ${p.$(String(year._id))} AND sc."isActive" IS NOT FALSE)`);
        }
        if (isDay(q.lastFrom)) conds.push(`lp."at" >= ${p.$(localDay(q.lastFrom))}`);
        if (isDay(q.lastTo)) conds.push(`lp."at" <= ${p.$(endOfDay(localDay(q.lastTo)))}`);

        const base = `WITH ${rosterCtes(p.$, { schoolId: req.schoolId, yearId: year._id, classId: uuidOr(q.classId), sectionId: uuidOr(q.sectionId) })},
          ${balanceCte(p.$, { schoolId: req.schoolId, yearId: year._id })},
          lp AS (
            SELECT fp."student", MAX(fp."paymentDate") AS "at"
              FROM ${T(FeePayment)} fp
             WHERE fp."school" = ${p.$(String(req.schoolId))} AND fp."academicYear" = ${p.$(String(year._id))} AND fp."paymentStatus" = 'completed'
             GROUP BY fp."student"
          )${prevOn ? `,
          prev AS (
            SELECT l."student", SUM(CASE WHEN l."entryType" = 'debit' THEN l."amount" ELSE -l."amount" END) AS "due"
              FROM ${T(FeeLedger)} l JOIN ${T(AcademicYear)} y ON y."_id" = l."academicYear"
             WHERE l."school" = ${p.$(String(req.schoolId))} AND y."startDate" < ${p.$(year.startDate)}
             GROUP BY l."student"
          )` : ''},
          rows AS (
            SELECT r."student", u."name", u."email", sp."admissionNumber", sp."rollNumber",
                   r."classId", r."className", r."classNumber", r."section", r."sectionName",
                   COALESCE(b."charged", 0) AS "charged", COALESCE(b."waived", 0) AS "waived",
                   COALESCE(b."fine", 0) AS "fine", COALESCE(b."paid", 0) AS "paid", COALESCE(b."due", 0) AS "due",
                   ${prevOn ? 'GREATEST(COALESCE(pv."due", 0), 0)' : '0'} AS "prevDue",
                   lp."at" AS "lastPayment", ${STATUS_SQL} AS "status"
              FROM roster r
              JOIN ${T(User)} u ON u."_id" = r."student"
              LEFT JOIN ${T(StudentProfile)} sp ON sp."user" = r."student" AND sp."school" = u."school"
              LEFT JOIN bal b ON b."student" = r."student"
              LEFT JOIN lp ON lp."student" = r."student"
              ${prevOn ? 'LEFT JOIN prev pv ON pv."student" = r."student"' : ''}
             ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
          )`;

        const status = ['paid', 'partial', 'pending', 'none'].includes(q.status) ? q.status : null;
        const baseParams = p.list.slice();   // the counts query uses exactly these
        const statusP = status ? p.$(status) : null;
        const sort = STUDENT_SORTS[q.sort] ? q.sort : 'name';
        const orderBy = STUDENT_SORTS[sort].replace(/u\."name"/g, 'x."name"').replace(/r\./g, 'x.').replace(/"due"/g, 'x."due"');
        const countsSql = `${base}
          SELECT COUNT(*) AS "all",
                 COUNT(*) FILTER (WHERE "status" = 'paid') AS "paid",
                 COUNT(*) FILTER (WHERE "status" = 'partial') AS "partial",
                 COUNT(*) FILTER (WHERE "status" = 'pending') AS "pending",
                 COUNT(*) FILTER (WHERE "status" = 'none') AS "none",
                 COALESCE(SUM(GREATEST("due", 0)), 0) AS "dueTotal",
                 COUNT(*) FILTER (WHERE "status" = ANY(ARRAY['paid','partial','pending'])) AS "charged"
            FROM rows`;
        const listSql = `${base}
          SELECT x.*, COUNT(*) OVER () AS "_total" FROM rows x
           ${statusP ? `WHERE x."status" = ${statusP}` : ''}
           ORDER BY ${orderBy}
           LIMIT ${p.$(limit)} OFFSET ${p.$(offset)}`;
        // The counts query shares the list's leading parameters; the list
        // adds status/limit/offset after them.
        const [counts, list] = await Promise.all([
            pool.query(countsSql, baseParams),
            pool.query(listSql, p.list),
        ]);
        const c = counts.rows[0] || {};
        const total = Number(list.rows[0]?._total) || 0;
        ok(res, {
            year: yearOut(year),
            counts: {
                all: Number(c.all) || 0, paid: Number(c.paid) || 0, partial: Number(c.partial) || 0,
                pending: Number(c.pending) || 0, none: Number(c.none) || 0, charged: Number(c.charged) || 0,
                dueTotal: r2(c.dueTotal),
            },
            showPreviousDues: prevOn,
            rows: list.rows.map(r => ({
                _id: r.student,
                name: r.name, email: r.email,
                admissionNumber: r.admissionNumber || '', rollNumber: r.rollNumber || '',
                classId: r.classId, sectionId: r.section,
                classLabel: classLabel(r.classNumber, r.className, r.sectionName),
                total: r2(Number(r.charged) - Number(r.waived)),
                charged: r2(r.charged), waived: r2(r.waived), fine: r2(r.fine),
                paid: r2(r.paid), due: r2(Math.max(0, Number(r.due))), advance: r2(Math.max(0, -Number(r.due))),
                prevDue: r2(r.prevDue),
                status: r.status, lastPayment: r.lastPayment,
            })),
        }, { total, page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};

/** Everything the student drawer shows: who, what they are charged, what they paid, what was waived. */
exports.studentCard = async (req, res) => {
    try {
        const studentId = uuidOr(req.params.studentId);
        if (!studentId) return bad(res, 'Choose a student');
        const { year } = await resolveYear(req.schoolId, req.query.academicYearId);
        const student = await User.findOne({ _id: studentId, school: req.schoolId, role: 'student' }).select('name email phone').lean();
        if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

        const [profile, ledger, payments, concessions, assignment, otherRules] = await Promise.all([
            StudentProfile.findOne({ user: studentId, school: req.schoolId })
                .select('admissionNumber rollNumber gender currentSection parent')
                .populate({ path: 'currentSection', select: 'sectionName class', populate: { path: 'class', select: 'className classNumber' } })
                .lean(),
            year ? FeeLedger.find({ school: req.schoolId, student: studentId, academicYear: year._id }).sort({ createdAt: -1 }).limit(200).lean() : [],
            year ? FeePayment.find({ school: req.schoolId, student: studentId, academicYear: year._id }).sort({ paymentDate: -1 }).populate('collectedBy', 'name').lean() : [],
            year ? StudentConcession.find({ school: req.schoolId, student: studentId, academicYear: year._id, isActive: true }).populate('concession').lean() : [],
            year ? StudentFeeAssignment.findOne({ school: req.schoolId, student: studentId, academicYear: year._id }).populate('feeStructure', 'name totalAmount').lean() : null,
            FineRule.find({ school: req.schoolId, ruleType: 'other', isActive: true }).sort({ name: 1 }).lean(),
        ]);

        const sum = (rows, pred) => r2(rows.filter(pred).reduce((s, e) => s + (Number(e.amount) || 0), 0));
        const charged = sum(ledger, e => e.entryType === 'debit' && ['fee_charged', 'fine'].includes(e.category));
        const fine = sum(ledger, e => e.entryType === 'debit' && e.category === 'fine');
        const paid = r2(sum(ledger, e => e.entryType === 'credit' && e.category === 'payment') - sum(ledger, e => e.entryType === 'debit' && e.category === 'refund'));
        const waived = r2(sum(ledger, e => e.entryType === 'credit' && e.category === 'concession') - sum(ledger, e => e.entryType === 'debit' && e.referenceType === 'StudentConcession'));
        const balance = r2(ledger.reduce((s, e) => s + (e.entryType === 'debit' ? 1 : -1) * (Number(e.amount) || 0), 0));

        const credited = new Map();
        for (const e of ledger) {
            if (e.referenceType !== 'StudentConcession') continue;
            const k = String(e.referenceId);
            credited.set(k, (credited.get(k) || 0) + (e.entryType === 'credit' ? 1 : -1) * e.amount);
        }
        const sec = profile?.currentSection;
        // The months the office can collect, by the fee book's own rule —
        // only for the year that is running, which is the one it pays into.
        let schedule = null;
        if (year && year.status === 'active') {
            const book = await require('./feesStudent.controller').buildFeeBook(req.schoolId, studentId);
            schedule = { months: book.monthlySchedule || [], otherDue: book.otherDue || 0, dueTotal: book.dueTotal || 0 };
        }
        ok(res, {
            year: yearOut(year),
            schedule,
            student: {
                _id: student._id, name: student.name, email: student.email, phone: student.phone || '',
                admissionNumber: profile?.admissionNumber || '', rollNumber: profile?.rollNumber || '',
                classLabel: sec ? classLabel(sec.class?.classNumber, sec.class?.className, sec.sectionName) : '—',
            },
            structure: assignment?.feeStructure ? { _id: assignment.feeStructure._id, name: assignment.feeStructure.name, totalAmount: assignment.feeStructure.totalAmount } : null,
            totals: { charged, fine, paid, waived, total: r2(charged - waived), balance, due: r2(Math.max(0, balance)), advance: r2(Math.max(0, -balance)) },
            ledger: ledger.map(e => ({
                _id: e._id, at: e.createdAt, entryType: e.entryType, category: e.category, amount: r2(e.amount),
                description: e.description, periodLabel: e.periodLabel || '', runningBalance: r2(e.runningBalance),
            })),
            payments: payments.map(pm => ({
                _id: pm._id, amount: r2(pm.amount), mode: pm.paymentMode, status: pm.paymentStatus, date: pm.paymentDate,
                receiptNumber: pm.receiptNumber, gateway: pm.gateway, collectedBy: pm.collectedBy?.name || null,
                feeHead: (pm.lines || []).map(l => l.feeName).filter(n => n && n !== 'Fee Payment').join(', ') || 'Fee payment',
            })),
            concessions: concessions.map(sc => ({
                _id: sc._id, concessionId: sc.concession?._id, name: sc.concession?.name || '—',
                concessionType: sc.concession?.concessionType, value: sc.concession?.value,
                credited: r2(credited.get(String(sc._id)) || 0), since: sc.createdAt,
            })),
            otherFines: otherRules.map(r => ({ _id: r._id, name: r.name, fineType: r.fineType, flatAmount: r.flatAmount, perDayAmount: r.perDayAmount, maxCap: r.maxCap })),
        });
    } catch (e) { fail(res, e); }
};

/**
 * Charge one of the office's "other" fines (lost ID card, damaged equipment)
 * to a student. A per-day rule needs the number of days; the cap still holds.
 */
exports.chargeFine = async (req, res) => {
    try {
        const studentId = uuidOr(req.params.studentId);
        const rule = uuidOr(req.body.ruleId) && await FineRule.findOne({ _id: req.body.ruleId, school: req.schoolId }).lean();
        if (!rule) return bad(res, 'Choose a fine');
        if (rule.ruleType !== 'other') return bad(res, 'Late-payment fines are charged by the rules themselves, not by hand');
        if (!rule.isActive) return bad(res, 'This fine rule is switched off');
        const student = studentId && await User.findOne({ _id: studentId, school: req.schoolId, role: 'student' }).select('name').lean();
        if (!student) return res.status(404).json({ success: false, message: 'Student not found' });
        const ay = await feesCtl.getActiveYear(req.schoolId);
        if (!ay) return bad(res, 'No active academic year');

        let amount = rule.fineType === 'flat' ? Number(rule.flatAmount) : 0;
        let days = 0;
        if (rule.fineType === 'per_day') {
            days = Math.round(Number(req.body.days));
            if (!Number.isFinite(days) || days < 1 || days > 3650) return bad(res, 'Enter the number of days');
            amount = Number(rule.perDayAmount) * days;
        }
        if (rule.maxCap > 0) amount = Math.min(amount, rule.maxCap);
        amount = roundMoney(amount, await feesCtl.getOrCreateSettings(req.schoolId));
        if (!(amount > 0)) return bad(res, 'This fine works out to nothing — check the rule amount');

        const note = String(req.body.remarks || '').trim().slice(0, 200);
        const entry = await appendLedger({
            school: req.schoolId, student: studentId, academicYear: ay._id,
            entryType: 'debit', category: 'fine', amount,
            description: `Fine — ${rule.name}${days ? ` (${days} day${days === 1 ? '' : 's'})` : ''}${note ? ` · ${note}` : ''}`,
            referenceType: 'FineRule', referenceId: rule._id, createdBy: req.userId,
        });
        logFeeAudit(req, { action: 'fine_charged', entityType: 'FineRule', entityId: rule._id, after: { student: studentId, name: student.name, amount: r2(amount) } });
        ok(res, { _id: entry._id, amount: r2(amount) });
    } catch (e) { fail(res, e); }
};

// ── Payments ─────────────────────────────────────────────────────────────────

/**
 * The payment list and everything around it. The date range drives the tiles,
 * the donut and the table; the trend has its own month window. Tab counts are
 * counted over every filter except the mode tab.
 */
exports.payments = async (req, res) => {
    try {
        const q = req.query;
        const { year, settings } = await resolveYear(req.schoolId, q.academicYearId);
        if (!year) return ok(res, { year: null, rows: [] }, { total: 0, page: 1, pages: 0 });
        const { page, limit, offset } = pageArgs(q, 10);

        // Range: what was asked, else the collection window in Settings, else the year.
        const from = localDay(q.from) || (settings?.collectionStart ? new Date(settings.collectionStart) : new Date(year.startDate));
        const to = q.to && isDay(q.to) ? endOfDay(localDay(q.to))
            : settings?.collectionEnd ? endOfDay(new Date(settings.collectionEnd)) : endOfDay(new Date(year.endDate));
        const span = to.getTime() - from.getTime();
        const prevFrom = new Date(from.getTime() - span - 1);
        const prevTo = new Date(from.getTime() - 1);

        const classId = uuidOr(q.classId), sectionId = uuidOr(q.sectionId);
        const scoped = classId || sectionId;
        const grp = ['online', 'cash', 'card', 'other'].includes(q.group) ? q.group : null;
        const joins = `
          FROM ${T(FeePayment)} fp
          LEFT JOIN ${T(User)} u ON u."_id" = fp."student"
          LEFT JOIN ${T(StudentProfile)} sp ON sp."user" = fp."student" AND sp."school" = fp."school"
          LEFT JOIN ${T(ClassSection)} cs ON cs."_id" = sp."currentSection"
          LEFT JOIN ${T(Class)} c ON c."_id" = cs."class"
          LEFT JOIN ${T(User)} cb ON cb."_id" = fp."collectedBy"`;
        // Every query gets its own parameter list: Postgres refuses a
        // parameter a statement never references.
        const scope = (p) => {
            const ctes = scoped ? `WITH ${rosterCtes(p.$, { schoolId: req.schoolId, yearId: year._id, classId, sectionId })}` : '';
            const w = [`fp."school" = ${p.$(String(req.schoolId))}`, `fp."academicYear" = ${p.$(String(year._id))}`];
            if (scoped) w.push(`fp."student" IN (SELECT "student" FROM roster)`);
            if (['completed', 'pending', 'failed', 'refunded'].includes(q.status)) w.push(`fp."paymentStatus" = ${p.$(q.status)}`);
            if (q.mode && feesCtl.PAY_MODES.includes(q.mode)) w.push(`fp."paymentMode" = ${p.$(q.mode)}`);
            if (q.q && String(q.q).trim()) {
                const like = p.$(`%${String(q.q).trim()}%`);
                w.push(`(u."name" ILIKE ${like} OR sp."admissionNumber" ILIKE ${like} OR fp."receiptNumber" ILIKE ${like} OR fp."transactionRef" ILIKE ${like})`);
            }
            const inRange = `fp."paymentDate" >= ${p.$(from)} AND fp."paymentDate" <= ${p.$(to)}`;
            return { ctes, where: w.join(' AND '), inRange };
        };

        const tp = params();
        const ts = scope(tp);
        const tilesSql = `${ts.ctes}
          SELECT ${groupSql('fp."paymentMode"')} AS "grp",
                 COALESCE(SUM(fp."amount") FILTER (WHERE fp."paymentStatus" = 'completed' AND ${ts.inRange}), 0) AS "amt",
                 COUNT(*) FILTER (WHERE ${ts.inRange}) AS "n",
                 COALESCE(SUM(fp."amount") FILTER (WHERE fp."paymentStatus" = 'completed'
                          AND fp."paymentDate" >= ${tp.$(prevFrom)} AND fp."paymentDate" <= ${tp.$(prevTo)}), 0) AS "prev"
            ${joins}
           WHERE ${ts.where}
           GROUP BY 1`;
        const lp = params();
        const ls = scope(lp);
        const listSql = `${ls.ctes}
          SELECT fp.*, u."name", sp."admissionNumber", cs."sectionName", c."className", c."classNumber",
                 cb."name" AS "collectedByName", COUNT(*) OVER () AS "_total"
            ${joins}
           WHERE ${ls.where} AND ${ls.inRange}${grp ? ` AND ${groupSql('fp."paymentMode"')} = ${lp.$(grp)}` : ''}
           ORDER BY fp."paymentDate" DESC, fp."createdAt" DESC
           LIMIT ${lp.$(limit)} OFFSET ${lp.$(offset)}`;

        const months = trendWindow(String(q.range || '6'), year);
        const trendP = params();
        const tctes = scoped ? `WITH ${rosterCtes(trendP.$, { schoolId: req.schoolId, yearId: year._id, classId, sectionId })}` : '';
        const trendSql = `${tctes}
          SELECT to_char(date_trunc('month', fp."paymentDate" AT TIME ZONE ${trendP.$(TZ)}), 'YYYY-MM') AS "m",
                 ${groupSql('fp."paymentMode"')} AS "grp", SUM(fp."amount") AS "amt"
            FROM ${T(FeePayment)} fp
           WHERE fp."school" = ${trendP.$(String(req.schoolId))} AND fp."paymentStatus" = 'completed'
             AND fp."paymentDate" >= ${trendP.$(months.from)} AND fp."paymentDate" < ${trendP.$(months.to)}
             ${scoped ? 'AND fp."student" IN (SELECT "student" FROM roster)' : ''}
           GROUP BY 1, 2`;

        const [tiles, list, trend] = await Promise.all([
            pool.query(tilesSql, tp.list),
            pool.query(listSql, lp.list),
            pool.query(trendSql, trendP.list),
        ]);
        const byGroup = { online: 0, cash: 0, card: 0, other: 0 };
        const countBy = { online: 0, cash: 0, card: 0, other: 0 };
        let prevTotal = 0;
        for (const r of tiles.rows) {
            byGroup[r.grp] = r2(r.amt);
            countBy[r.grp] = Number(r.n) || 0;
            prevTotal += Number(r.prev) || 0;
        }
        const totalAmt = r2(Object.values(byGroup).reduce((s, v) => s + v, 0));
        const tmap = new Map();
        for (const r of trend.rows) {
            const m = tmap.get(r.m) || { online: 0, cash: 0, card: 0, other: 0 };
            m[r.grp] = r2(r.amt);
            tmap.set(r.m, m);
        }
        const total = Number(list.rows[0]?._total) || 0;
        ok(res, {
            year: yearOut(year),
            range: { from, to },
            tiles: {
                total: totalAmt, change: change(totalAmt, r2(prevTotal)),
                ...Object.fromEntries(Object.entries(byGroup).map(([k, v]) => [k, { amount: v, share: totalAmt > 0 ? r2(v / totalAmt * 100) : 0 }])),
            },
            counts: { all: Object.values(countBy).reduce((s, v) => s + v, 0), ...countBy },
            trend: monthsBetween(months.from, months.to).map(m => ({ month: m.key, label: m.label, year: m.year, ...(tmap.get(m.key) || { online: 0, cash: 0, card: 0, other: 0 }) })),
            rows: list.rows.map(paymentRow),
        }, { total, page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};

/**
 * Several receipts as one printable page — one sheet each, a page break
 * between. Only completed payments have receipts. The old web screen saved the
 * HTML receipt as "receipt.pdf", which no PDF reader could open.
 */
exports.receipts = async (req, res) => {
    try {
        const ids = String(req.query.ids || '').split(',').map(uuidOr).filter(Boolean).slice(0, 100);
        if (!ids.length) return bad(res, 'Choose the payments to print');
        const payments = await FeePayment.find({ _id: { $in: ids }, school: req.schoolId, paymentStatus: 'completed' }).sort({ paymentDate: 1 }).lean();
        if (!payments.length) return bad(res, 'None of these payments has a receipt yet — only completed payments do');
        const [school, templates, settings] = await Promise.all([
            School.findById(req.schoolId).select('name address logo').lean(),
            ReceiptTemplate.find({ school: req.schoolId, module: 'fees' }).lean(),
            feesCtl.getOrCreateSettings(req.schoolId),
        ]);
        const origin = `${req.protocol}://${req.get('host')}`;
        const docs = payments.map(pm => {
            const mode = pm.paymentMode === 'online' ? 'online' : 'offline';
            const tpl = templates.find(t => t.paymentMode === mode);
            const st = pm.studentSnapshot || {};
            return renderReceipt({
                module: 'fees', number: pm.receiptNumber || '', date: pm.paymentDate || pm.createdAt,
                paidBy: st.name || '', paidByDetailLabel: 'Class',
                paidByDetail: [st.className, st.section].filter(Boolean).join(' · ') || st.rollNumber || '',
                title: 'Fee receipt', paymentMode: mode, offlineModeLabel: feesCtl.MODE_LABEL[pm.paymentMode] || pm.paymentMode || 'Cash',
                reference: pm.gatewayPaymentId || pm.transactionRef || '',
                lines: (pm.lines || []).map(l => ({ label: l.feeName, amount: l.amount })),
                total: pm.amount || 0, currencySymbol: settings?.currencySymbol || '₹',
            }, tpl || defaultTemplate('fees', mode), {
                school: school && { name: school.name, address: school.address,
                    logoUrl: school.logo ? (/^https?:/.test(school.logo) ? school.logo : `${origin}${school.logo}`) : '' },
            });
        });
        if (docs.length === 1) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(docs[0]);
        }
        const head = docs[0].slice(0, docs[0].indexOf('<body>'));
        const sheets = docs.map(html => {
            const accent = /--accent:\s*(#[0-9a-f]{3,8})/i.exec(html)?.[1] || '#4F46E5';
            const body = html.slice(html.indexOf('<div class="sheet">'), html.lastIndexOf('</body>'));
            return `<div class="many" style="--accent:${accent}">${body}</div>`;
        }).join('\n');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`${head}<style>.many + .many { margin-top: 28px } @media print { .many { break-after: page } .many:last-child { break-after: auto } }</style>
<body><div class="actions"><button onclick="window.print()">Print or save as PDF</button></div>${sheets}</body></html>`);
    } catch (e) { fail(res, e); }
};

// ── Structures ───────────────────────────────────────────────────────────────

/**
 * A structure is upcoming until its year has begun AND its effective month
 * has come; inactive when switched off; active otherwise.
 */
function structureStatus(s, year) {
    if (s.isActive === false) return 'inactive';
    const now = Date.now();
    if (year && new Date(year.startDate).getTime() > now) return 'upcoming';
    if (s.effectiveFrom && new Date(s.effectiveFrom).getTime() > now) return 'upcoming';
    return 'active';
}

exports.structures = async (req, res) => {
    try {
        const q = req.query;
        const { year } = await resolveYear(req.schoolId, q.academicYearId);
        if (!year) return ok(res, { year: null, rows: [], counts: {} }, { total: 0, page: 1, pages: 0 });
        const { page, limit, offset } = pageArgs(q, 10);

        const [structures, heads, categories, sections, classes] = await Promise.all([
            FeeStructure.find({ school: req.schoolId, academicYear: year._id }).sort({ name: 1 }).lean(),
            FeeHead.find({ school: req.schoolId }).select('name type category amountType isActive isArchived').lean(),
            FeeCategory.find({ school: req.schoolId }).select('name').lean(),
            ClassSection.find({ school: req.schoolId, academicYear: year._id }).select('sectionName class').lean(),
            Class.find({ school: req.schoolId, academicYear: year._id }).select('className classNumber').lean(),
        ]);
        const headBy = new Map(heads.map(h => [String(h._id), h]));
        const catBy = new Map(categories.map(c => [String(c._id), c.name]));
        const secBy = new Map(sections.map(s => [String(s._id), s]));
        const classBy = new Map(classes.map(c => [String(c._id), c]));

        // Students each structure reaches and how many it has charged.
        const ids = structures.map(s => String(s._id));
        const charged = ids.length ? (await pool.query(
            `SELECT l."referenceId" AS id, COUNT(DISTINCT l."student") AS n, SUM(l."amount") AS amt,
                    to_char(MAX(COALESCE(l."periodStart", l."createdAt")), 'YYYY-MM') AS through
               FROM ${T(FeeLedger)} l
              WHERE l."school" = $1 AND l."referenceType" = 'FeeStructure' AND l."category" = 'fee_charged'
                AND l."referenceId" = ANY($2::uuid[])
              GROUP BY 1`, [String(req.schoolId), ids])).rows : [];
        const chargedBy = new Map(charged.map(r => [String(r.id), { students: Number(r.n) || 0, amount: r2(r.amt), through: r.through || null }]));

        const bounds = Sched.yearBounds(year);
        // Items saved before windows existed start where their structure first charged.
        const fallbacks = new Map();
        for (const s of structures) {
            if ((s.items || []).some(i => !Sched.isMonthKey(i.startMonth))) fallbacks.set(String(s._id), await legacyStart(s));
        }
        const all = structures.map(s => {
            const fallback = fallbacks.get(String(s._id)) || null;
            const items = (s.items || []).map(i => {
                const h = headBy.get(String(i.feeHead)) || {};
                const w = Sched.windowFor(i, h.type || 'recurring', bounds, fallback);
                // A head switched off charges nothing wherever it sits, so it
                // must not count towards what this structure charges either.
                const headOff = h.isActive === false || !!h.isArchived;
                return { _id: i._id, feeHead: { _id: i.feeHead, name: h.name || 'Removed fee head', type: h.type, amountType: h.amountType || 'fixed',
                    category: h.category ? { _id: h.category, name: catBy.get(String(h.category)) || '' } : null },
                    amount: r2(i.amount), isActive: i.isActive !== false && !headOff, headOff,
                    startMonth: w.start, endMonth: w.end,
                    charges: Sched.periodsFor(i, h.type || 'recurring', bounds, fallback).length };
            });
            const annual = r2(items.filter(i => i.isActive).reduce((sum, i) => sum + i.amount * i.charges, 0));
            const cats = [...new Set(items.filter(i => i.isActive && i.feeHead.category?.name).map(i => i.feeHead.category.name))];
            const sec = s.section ? secBy.get(String(s.section)) : null;
            const cls = classBy.get(String(s.class || sec?.class || '')) || null;
            return {
                _id: s._id, name: s.name, description: s.description || '',
                academicYear: { _id: year._id, yearName: year.yearName },
                level: s.level,
                class: cls ? { _id: cls._id, className: classTitle(cls.classNumber, cls.className), classNumber: cls.classNumber } : null,
                section: sec ? { _id: sec._id, sectionName: sec.sectionName } : null,
                categories: cats, categoryIds: [...new Set(items.filter(i => i.isActive && i.feeHead.category?._id).map(i => String(i.feeHead.category._id)))],
                headCount: items.filter(i => i.isActive).length,
                items,
                // What the structure charges over the whole year.
                totalAmount: annual,
                periodic: !!s.periodicSince,
                dueDay: s.dueDay || null, effectiveFrom: s.effectiveFrom || null,
                demandGeneratedAt: s.demandGeneratedAt || null,
                // Lifecycle: when it was switched off, the months it was off
                // for, and how far it has charged — the screens ask before
                // offering to cancel charges or catch up.
                deactivatedAt: s.deactivatedAt || null,
                skippedMonths: s.skippedMonths || [],
                chargedThrough: (chargedBy.get(String(s._id)) || {}).through || null,
                yearEnd: bounds.last,
                charged: chargedBy.get(String(s._id)) || { students: 0, amount: 0, through: null },
                isActive: s.isActive !== false,
                status: structureStatus(s, year),
                createdAt: s.createdAt, updatedAt: s.updatedAt,
            };
        });

        const classId = uuidOr(q.classId), sectionId = uuidOr(q.sectionId), categoryId = uuidOr(q.categoryId);
        const secClass = sectionId ? String(secBy.get(sectionId)?.class || '') : null;
        const term = String(q.q || '').trim().toLowerCase();
        const filtered = all.filter(s =>
            (!classId || String(s.class?._id) === classId)
            && (!sectionId || (s.level === 'section' ? String(s.section?._id) === sectionId : String(s.class?._id) === secClass))
            && (!categoryId || s.categoryIds.includes(categoryId))
            && (!term || s.name.toLowerCase().includes(term) || (s.class?.className || '').toLowerCase().includes(term)));
        const counts = {
            all: filtered.length,
            active: filtered.filter(s => s.status === 'active').length,
            upcoming: filtered.filter(s => s.status === 'upcoming').length,
            inactive: filtered.filter(s => s.status === 'inactive').length,
        };
        const status = ['active', 'upcoming', 'inactive'].includes(q.status) ? q.status : null;
        const shown = status ? filtered.filter(s => s.status === status) : filtered;
        // Classes in their natural order, then name.
        shown.sort((a, b) => (Number(b.class?.classNumber) || 0) - (Number(a.class?.classNumber) || 0) || a.name.localeCompare(b.name));
        ok(res, { year: yearOut(year), counts, rows: shown.slice(offset, offset + limit) },
            { total: shown.length, page, pages: Math.ceil(shown.length / limit) });
    } catch (e) { fail(res, e); }
};

/**
 * Copy every structure of one year into another (Structures → More Actions,
 * and Settings → Import Settings). Classes are matched by class number and
 * sections by class number + section name, because each year has its own
 * class rows. Copies start switched on with no demand generated; a structure
 * whose class does not exist in the target year, or whose name is already
 * taken there, is skipped and reported.
 */
exports.copyStructures = async (req, res) => {
    try {
        const fromId = uuidOr(req.body.fromYearId), toId = uuidOr(req.body.toYearId);
        if (!fromId || !toId || fromId === toId) return bad(res, 'Choose two different academic years');
        const [fromYear, toYear] = await Promise.all([
            AcademicYear.findOne({ _id: fromId, school: req.schoolId }).lean(),
            AcademicYear.findOne({ _id: toId, school: req.schoolId }).lean(),
        ]);
        if (!fromYear || !toYear) return bad(res, 'That academic year does not exist');
        const [source, existing, fromClasses, toClasses, fromSecs, toSecs] = await Promise.all([
            FeeStructure.find({ school: req.schoolId, academicYear: fromId }).lean(),
            FeeStructure.find({ school: req.schoolId, academicYear: toId }).select('name').lean(),
            Class.find({ school: req.schoolId, academicYear: fromId }).lean(),
            Class.find({ school: req.schoolId, academicYear: toId }).lean(),
            ClassSection.find({ school: req.schoolId, academicYear: fromId }).lean(),
            ClassSection.find({ school: req.schoolId, academicYear: toId }).lean(),
        ]);
        if (!source.length) return bad(res, `${fromYear.yearName} has no fee structures to copy`);
        const taken = new Set(existing.map(s => s.name.toLowerCase()));
        const fromClassNo = new Map(fromClasses.map(c => [String(c._id), c.classNumber]));
        const toClassByNo = new Map(toClasses.map(c => [String(c.classNumber), c]));
        const created = [], skipped = [];
        for (const s of source) {
            if (taken.has(s.name.toLowerCase())) { skipped.push({ name: s.name, reason: 'already exists' }); continue; }
            let classId = null, sectionId = null;
            if (s.level === 'section') {
                const sec = fromSecs.find(x => String(x._id) === String(s.section));
                const no = sec && fromClassNo.get(String(sec.class));
                const tc = no != null && toClassByNo.get(String(no));
                const ts = tc && toSecs.find(x => String(x.class) === String(tc._id) && x.sectionName === sec.sectionName);
                if (!ts) { skipped.push({ name: s.name, reason: 'no matching section' }); continue; }
                classId = tc._id; sectionId = ts._id;
            } else {
                const no = fromClassNo.get(String(s.class));
                const tc = no != null && toClassByNo.get(String(no));
                if (!tc) { skipped.push({ name: s.name, reason: 'no matching class' }); continue; }
                classId = tc._id;
            }
            const copy = await FeeStructure.create({
                school: req.schoolId, academicYear: toId, name: s.name, description: s.description || '',
                level: s.level, class: classId, section: sectionId, dueDay: s.dueDay || null,
                items: (s.items || []).map(i => ({ feeHead: i.feeHead, amount: i.amount, isActive: i.isActive !== false })),
                totalAmount: s.totalAmount, isActive: true, createdBy: req.userId,
            });
            taken.add(s.name.toLowerCase());
            created.push(copy._id);
        }
        logFeeAudit(req, { action: 'copied', entityType: 'FeeStructure', after: { from: fromYear.yearName, to: toYear.yearName, created: created.length, skipped: skipped.length } });
        ok(res, { created: created.length, skipped });
    } catch (e) { fail(res, e); }
};

// ── Fee heads ────────────────────────────────────────────────────────────────

const headStatus = (h) => (h.isArchived ? 'archived' : h.isActive === false ? 'inactive' : 'active');

/** Structures of a year that use each head, and the classes they reach. */
async function headUsage(schoolId, yearId) {
    if (!yearId) return new Map();
    const { rows } = await pool.query(
        `SELECT (it->>'feeHead') AS head, fs."_id" AS sid, fs."name", fs."level", COALESCE((it->>'amount')::float, 0) AS amount,
                c."_id" AS "classId", c."className", c."classNumber", cs."sectionName"
           FROM ${T(FeeStructure)} fs
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fs."items") = 'array' THEN fs."items" ELSE '[]'::jsonb END) it
           LEFT JOIN ${T(ClassSection)} cs ON cs."_id" = fs."section"
           LEFT JOIN ${T(Class)} c ON c."_id" = COALESCE(fs."class", cs."class")
          WHERE fs."school" = $1 AND fs."academicYear" = $2 AND fs."isActive" IS NOT FALSE
            AND COALESCE((it->>'isActive')::boolean, true)`,
        [String(schoolId), String(yearId)]);
    const out = new Map();
    for (const r of rows) {
        const u = out.get(r.head) || { structures: [], classes: new Map() };
        u.structures.push({ _id: r.sid, name: r.name, amount: r2(r.amount),
            appliesTo: r.level === 'section' ? `${classTitle(r.classNumber, r.className)} · Section ${r.sectionName}` : classTitle(r.classNumber, r.className) });
        if (r.classId) u.classes.set(String(r.classId), { label: classTitle(r.classNumber, r.className), n: Number(r.classNumber) || 0 });
        out.set(r.head, u);
    }
    return out;
}

/** "All Classes" when a head reaches every class of the year; else the list. */
function appliesToLabel(usage, classCount) {
    if (!usage || !usage.classes.size) return 'Not used in any structure';
    if (classCount && usage.classes.size >= classCount) return 'All Classes';
    return [...usage.classes.values()].sort((a, b) => a.n - b.n).map(c => c.label).join(', ');
}

exports.heads = async (req, res) => {
    try {
        const q = req.query;
        const { year } = await resolveYear(req.schoolId, q.academicYearId);
        const { page, limit, offset } = pageArgs(q, 10);
        const [heads, categories, classCount, usage] = await Promise.all([
            FeeHead.find({ school: req.schoolId }).sort({ name: 1 }).populate('createdBy', 'name').populate('updatedBy', 'name').lean(),
            FeeCategory.find({ school: req.schoolId }).select('name').lean(),
            year ? Class.countDocuments({ school: req.schoolId, academicYear: year._id }) : 0,
            headUsage(req.schoolId, year?._id),
        ]);
        const catBy = new Map(categories.map(c => [String(c._id), c.name]));
        const term = String(q.q || '').trim().toLowerCase();
        const categoryId = uuidOr(q.categoryId);
        const rows = heads.map(h => {
            const u = usage.get(String(h._id));
            return {
                _id: h._id, name: h.name, description: h.description || '',
                category: h.category ? { _id: h.category, name: catBy.get(String(h.category)) || '' } : null,
                type: h.type, amountType: h.amountType || 'fixed', defaultAmount: r2(h.defaultAmount),
                status: headStatus(h), isActive: h.isActive !== false, isArchived: !!h.isArchived, archivedAt: h.archivedAt || null,
                // When it was switched off, and months it was off for: a head
                // that is off charges nothing, and those months never will be.
                deactivatedAt: h.deactivatedAt || null, skippedMonths: h.skippedMonths || [],
                structures: u ? u.structures.length : 0,
                appliesTo: appliesToLabel(u, classCount),
                createdAt: h.createdAt, updatedAt: h.updatedAt,
                createdBy: h.createdBy?.name || null, updatedBy: h.updatedBy?.name || null,
            };
        }).filter(h =>
            (!categoryId || String(h.category?._id) === categoryId)
            && (!q.frequency || h.type === q.frequency)
            && (!q.amountType || h.amountType === q.amountType)
            && (!term || h.name.toLowerCase().includes(term) || (h.description || '').toLowerCase().includes(term)));
        const counts = {
            all: rows.length,
            active: rows.filter(h => h.status === 'active').length,
            inactive: rows.filter(h => h.status === 'inactive').length,
            archived: rows.filter(h => h.status === 'archived').length,
        };
        const status = ['active', 'inactive', 'archived'].includes(q.status) ? q.status : null;
        const shown = status ? rows.filter(h => h.status === status) : rows;
        ok(res, { year: yearOut(year), counts, rows: shown.slice(offset, offset + limit) },
            { total: shown.length, page, pages: Math.ceil(shown.length / limit) });
    } catch (e) { fail(res, e); }
};

/** Audit rows about one record, newest first, with who did it. */
async function historyFor(schoolId, entityType, entityId, limit = 30) {
    const rows = await FeeAuditLog.find({ school: schoolId, entityType, entityId: String(entityId) })
        .sort({ timestamp: -1 }).limit(limit).populate('user', 'name').lean();
    return rows.map(r => ({
        _id: r._id, action: r.actionType, at: r.timestamp, by: r.user?.name || 'System',
        changed: r.newValue?._changed || [], note: r.newValue?._note || '',
        detail: r.newValue && !r.newValue._changed ? r.newValue : null,
    }));
}

exports.headActivity = async (req, res) => {
    try {
        const id = uuidOr(req.params.id);
        const head = id && await FeeHead.findOne({ _id: id, school: req.schoolId }).lean();
        if (!head) return res.status(404).json({ success: false, message: 'Fee head not found' });
        const { year } = await resolveYear(req.schoolId, req.query.academicYearId);
        const [usage, collected, history] = await Promise.all([
            headUsage(req.schoolId, year?._id),
            year ? collectedByHead({ schoolId: req.schoolId, yearId: year._id }) : new Map(),
            historyFor(req.schoolId, 'FeeHead', id),
        ]);
        const u = usage.get(String(id));
        ok(res, {
            year: yearOut(year),
            structures: u ? u.structures : [],
            collected: collected.get(String(id)) || 0,
            history,
        });
    } catch (e) { fail(res, e); }
};

const FREQ_WORDS = {
    monthly: 'recurring', recurring: 'recurring', 'one time': 'one_time', onetime: 'one_time', one_time: 'one_time',
    quarterly: 'quarterly', 'half yearly': 'half_yearly', 'half-yearly': 'half_yearly', half_yearly: 'half_yearly',
    yearly: 'yearly', annual: 'yearly', annually: 'yearly',
};

/**
 * Create fee heads from rows the page parsed out of a CSV. A category named
 * in the file is created when it does not exist. Names already taken are
 * skipped, never overwritten.
 */
exports.importHeads = async (req, res) => {
    try {
        const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 500) : [];
        if (!rows.length) return bad(res, 'The file has no rows to import');
        const [existing, cats] = await Promise.all([
            FeeHead.find({ school: req.schoolId }).select('name').lean(),
            FeeCategory.find({ school: req.schoolId }).lean(),
        ]);
        const taken = new Set(existing.map(h => h.name.toLowerCase()));
        const catByName = new Map(cats.map(c => [c.name.toLowerCase(), c]));
        const created = [], skipped = [], errors = [];
        for (const [i, r] of rows.entries()) {
            const line = i + 2; // header is line 1
            const name = String(r.name || '').trim();
            if (!name) { errors.push({ line, message: 'Name is missing' }); continue; }
            if (taken.has(name.toLowerCase())) { skipped.push({ line, name, reason: 'already exists' }); continue; }
            const type = FREQ_WORDS[String(r.frequency || 'monthly').trim().toLowerCase()];
            if (!type) { errors.push({ line, message: `Unknown frequency "${r.frequency}"` }); continue; }
            const amount = r.amount === undefined || r.amount === '' ? 0 : Number(String(r.amount).replace(/[,₹\s]/g, ''));
            if (!Number.isFinite(amount) || amount < 0) { errors.push({ line, message: 'The amount is not a number' }); continue; }
            const amountType = String(r.amountType || r.type || 'fixed').trim().toLowerCase().startsWith('var') ? 'variable' : 'fixed';
            let category = null;
            const catName = String(r.category || '').trim();
            if (catName) {
                category = catByName.get(catName.toLowerCase());
                if (!category) {
                    category = (await FeeCategory.create({ school: req.schoolId, name: catName, createdBy: req.userId })).toObject();
                    catByName.set(catName.toLowerCase(), category);
                }
            }
            const head = await FeeHead.create({
                school: req.schoolId, name, category: category?._id || null, type, amountType, defaultAmount: amount,
                description: String(r.description || '').trim(), createdBy: req.userId,
            });
            taken.add(name.toLowerCase());
            created.push(head._id);
        }
        if (created.length) logFeeAudit(req, { action: 'imported', entityType: 'FeeHead', after: { created: created.length } });
        ok(res, { created: created.length, skipped, errors });
    } catch (e) { fail(res, e); }
};

// ── Categories ───────────────────────────────────────────────────────────────

exports.categories = async (req, res) => {
    try {
        const q = req.query;
        const { page, limit, offset } = pageArgs(q, 10);
        const [cats, heads] = await Promise.all([
            FeeCategory.find({ school: req.schoolId }).populate('createdBy', 'name').populate('updatedBy', 'name').lean(),
            FeeHead.find({ school: req.schoolId, isArchived: { $ne: true } }).select('name category isActive').sort({ name: 1 }).lean(),
        ]);
        const term = String(q.q || '').trim().toLowerCase();
        const rows = cats.map(c => {
            const own = heads.filter(h => String(h.category) === String(c._id));
            return {
                _id: c._id, name: c.name, description: c.description || '',
                headCount: own.length, heads: own.map(h => ({ _id: h._id, name: h.name, isActive: h.isActive !== false })),
                isActive: c.isActive !== false, status: c.isActive !== false ? 'active' : 'inactive',
                createdAt: c.createdAt, updatedAt: c.updatedAt,
                createdBy: c.createdBy?.name || null, updatedBy: c.updatedBy?.name || null,
            };
        }).filter(c => !term || c.name.toLowerCase().includes(term) || c.description.toLowerCase().includes(term));
        const counts = {
            all: rows.length,
            active: rows.filter(c => c.isActive).length,
            inactive: rows.filter(c => !c.isActive).length,
            heads: heads.length,
            uncategorised: heads.filter(h => !h.category).length,
        };
        const status = ['active', 'inactive'].includes(q.status) ? q.status : null;
        const shown = status ? rows.filter(c => c.status === status) : rows;
        const sorts = {
            name: (a, b) => a.name.localeCompare(b.name),
            heads: (a, b) => b.headCount - a.headCount || a.name.localeCompare(b.name),
            newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
            oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
        };
        shown.sort(sorts[q.sort] || sorts.name);
        ok(res, { counts, rows: shown.slice(offset, offset + limit) }, { total: shown.length, page, pages: Math.ceil(shown.length / limit) });
    } catch (e) { fail(res, e); }
};

exports.categoryActivity = async (req, res) => {
    try {
        const id = uuidOr(req.params.id);
        const cat = id && await FeeCategory.findOne({ _id: id, school: req.schoolId }).lean();
        if (!cat) return res.status(404).json({ success: false, message: 'Category not found' });
        const { year } = await resolveYear(req.schoolId, req.query.academicYearId);
        const heads = await FeeHead.find({ school: req.schoolId, category: id }).select('_id name').lean();
        const headIds = new Set(heads.map(h => String(h._id)));
        const [usage, collected, history] = await Promise.all([
            headUsage(req.schoolId, year?._id),
            year ? collectedByHead({ schoolId: req.schoolId, yearId: year._id }) : new Map(),
            historyFor(req.schoolId, 'FeeCategory', id),
        ]);
        const structures = new Map();
        for (const [head, u] of usage) {
            if (!headIds.has(head)) continue;
            for (const s of u.structures) {
                const e = structures.get(String(s._id)) || { _id: s._id, name: s.name, appliesTo: s.appliesTo, amount: 0, heads: 0 };
                e.amount = r2(e.amount + s.amount); e.heads += 1;
                structures.set(String(s._id), e);
            }
        }
        ok(res, {
            year: yearOut(year),
            structures: [...structures.values()].sort((a, b) => a.name.localeCompare(b.name)),
            collected: r2([...headIds].reduce((s, h) => s + (collected.get(h) || 0), 0)),
            history,
        });
    } catch (e) { fail(res, e); }
};

// ── Concessions ──────────────────────────────────────────────────────────────

/** Switched off, or its window has ended → inactive; window not begun → upcoming. */
function concessionStatus(c) {
    if (c.isActive === false) return 'inactive';
    const now = Date.now();
    if (c.validTo && endOfDay(new Date(c.validTo)).getTime() < now) return 'inactive';
    if (c.validFrom && new Date(c.validFrom).getTime() > now) return 'upcoming';
    return 'active';
}

/** Net credited per concession scheme (and per student) for one year, or all years. */
async function concessionMoney(schoolId, yearId) {
    const p = params();
    const sql = `
      SELECT sc."concession" AS "cid", sc."student",
             SUM(CASE WHEN l."entryType" = 'credit' THEN l."amount" ELSE -l."amount" END) AS "amt"
        FROM ${T(FeeLedger)} l
        JOIN ${T(StudentConcession)} sc ON sc."_id" = l."referenceId"
       WHERE l."school" = ${p.$(String(schoolId))} AND l."referenceType" = 'StudentConcession'
             ${yearId ? `AND l."academicYear" = ${p.$(String(yearId))}` : ''}
       GROUP BY 1, 2`;
    const { rows } = await pool.query(sql, p.list);
    return rows.map(r => ({ cid: String(r.cid), student: String(r.student), amt: Number(r.amt) || 0 }));
}

exports.concessions = async (req, res) => {
    try {
        const q = req.query;
        const { year, years } = await resolveYear(req.schoolId, q.academicYearId);
        const prev = previousYear(years, year);
        const { page, limit, offset } = pageArgs(q, 10);
        const [schemes, heads, assigned, money, prevMoney, activity] = await Promise.all([
            FeeConcession.find({ school: req.schoolId }).sort({ name: 1 }).lean(),
            FeeHead.find({ school: req.schoolId }).select('name').lean(),
            year ? StudentConcession.find({ school: req.schoolId, academicYear: year._id, isActive: true }).select('concession student').lean() : [],
            year ? concessionMoney(req.schoolId, year._id) : [],
            prev ? concessionMoney(req.schoolId, prev._id) : [],
            FeeAuditLog.find({ school: req.schoolId, entityType: 'FeeConcession' }).sort({ timestamp: -1 }).limit(6).populate('user', 'name').lean(),
        ]);
        const headBy = new Map(heads.map(h => [String(h._id), h.name]));

        // Class / section filter: schemes with at least one beneficiary there.
        let inScope = null;
        if (year && (uuidOr(q.classId) || uuidOr(q.sectionId))) {
            const p = params();
            const { rows } = await pool.query(`WITH ${rosterCtes(p.$, { schoolId: req.schoolId, yearId: year._id, classId: uuidOr(q.classId), sectionId: uuidOr(q.sectionId) })}
              SELECT "student" FROM roster`, p.list);
            inScope = new Set(rows.map(r => String(r.student)));
        }
        const holders = new Map();
        for (const a of assigned) {
            if (inScope && !inScope.has(String(a.student))) continue;
            const k = String(a.concession);
            holders.set(k, (holders.get(k) || 0) + 1);
        }
        const amountBy = new Map();
        for (const m of money) amountBy.set(m.cid, (amountBy.get(m.cid) || 0) + m.amt);

        const term = String(q.q || '').trim().toLowerCase();
        const rows = schemes.map(c => ({
            _id: c._id, name: c.name, description: c.description || '',
            concessionType: c.concessionType, value: c.value,
            applicableTo: c.applicableTo || 'all',
            applicableHeads: (c.applicableHeads || []).map(id => ({ _id: id, name: headBy.get(String(id)) || 'Removed fee head' })),
            eligibility: c.eligibility || 'selected',
            beneficiaries: holders.get(String(c._id)) || 0,
            amount: r2(amountBy.get(String(c._id)) || 0),
            validFrom: c.validFrom || null, validTo: c.validTo || null,
            isActive: c.isActive !== false, status: concessionStatus(c),
            createdAt: c.createdAt, updatedAt: c.updatedAt,
        })).filter(c =>
            (!q.type || c.concessionType === q.type)
            && (!inScope || c.beneficiaries > 0)
            && (!q.eligibility || c.eligibility === q.eligibility)
            && (!term || c.name.toLowerCase().includes(term) || c.description.toLowerCase().includes(term)));

        const counts = {
            all: rows.length,
            active: rows.filter(c => c.status === 'active').length,
            upcoming: rows.filter(c => c.status === 'upcoming').length,
            inactive: rows.filter(c => c.status === 'inactive').length,
        };
        const status = ['active', 'upcoming', 'inactive'].includes(q.status) ? q.status : null;
        const shown = status ? rows.filter(c => c.status === status) : rows;

        const benefited = new Set(assigned.map(a => String(a.student))).size;
        const prevBenefited = new Set(prevMoney.filter(m => m.amt > 0).map(m => m.student)).size;
        const totalAmount = r2(money.reduce((s, m) => s + m.amt, 0));
        const prevAmount = r2(prevMoney.reduce((s, m) => s + m.amt, 0));

        // Insights: the donut, this year or all time, four biggest + the rest.
        const insightRows = q.insight === 'all' ? await concessionMoney(req.schoolId, null) : money;
        const byScheme = new Map();
        for (const m of insightRows) byScheme.set(m.cid, (byScheme.get(m.cid) || 0) + m.amt);
        const nameOf = new Map(schemes.map(c => [String(c._id), c.name]));
        const ranked = [...byScheme.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        const insightTotal = r2(ranked.reduce((s, [, v]) => s + v, 0));
        const slices = ranked.slice(0, 4).map(([k, v]) => ({ _id: k, name: nameOf.get(k) || 'Removed concession', amount: r2(v) }));
        if (ranked.length > 4) slices.push({ _id: '_others', name: 'Others', amount: r2(ranked.slice(4).reduce((s, [, v]) => s + v, 0)),
            names: ranked.slice(4).map(([k]) => nameOf.get(k) || 'Removed concession') });

        ok(res, {
            year: yearOut(year), previousYear: prev ? prev.yearName : null,
            tiles: {
                total: schemes.length,
                benefited, benefitedChange: prev ? change(benefited, prevBenefited) : null,
                amount: totalAmount, amountChange: prev ? change(totalAmount, prevAmount) : null,
                active: schemes.filter(c => concessionStatus(c) === 'active').length,
                upcoming: schemes.filter(c => concessionStatus(c) === 'upcoming').length,
                inactive: schemes.filter(c => concessionStatus(c) === 'inactive').length,
            },
            counts,
            rows: shown.slice(offset, offset + limit),
            insights: { total: insightTotal, slices: slices.map(s => ({ ...s, pct: insightTotal > 0 ? r2(s.amount / insightTotal * 100) : 0 })) },
            activity: activity.map(a => ({
                _id: a._id, action: a.actionType, at: a.timestamp, by: a.user?.name || 'System',
                name: a.newValue?.name || nameOf.get(String(a.entityId)) || '',
                students: a.newValue?.students || null,
            })),
        }, { total: shown.length, page, pages: Math.ceil(shown.length / limit) });
    } catch (e) { fail(res, e); }
};

exports.concessionBeneficiaries = async (req, res) => {
    try {
        const id = uuidOr(req.params.id);
        const c = id && await FeeConcession.findOne({ _id: id, school: req.schoolId }).lean();
        if (!c) return res.status(404).json({ success: false, message: 'Concession not found' });
        const { year } = await resolveYear(req.schoolId, req.query.academicYearId);
        if (!year) return ok(res, { rows: [] });
        const p = params();
        const { rows } = await pool.query(`WITH ${rosterCtes(p.$, { schoolId: req.schoolId, yearId: year._id })}
          SELECT sc."_id", sc."student", sc."createdAt", u."name", sp."admissionNumber",
                 r."className", r."classNumber", r."sectionName",
                 COALESCE((SELECT SUM(CASE WHEN l."entryType" = 'credit' THEN l."amount" ELSE -l."amount" END)
                             FROM ${T(FeeLedger)} l WHERE l."referenceType" = 'StudentConcession' AND l."referenceId" = sc."_id"), 0) AS "credited"
            FROM ${T(StudentConcession)} sc
            JOIN ${T(User)} u ON u."_id" = sc."student"
            LEFT JOIN ${T(StudentProfile)} sp ON sp."user" = sc."student" AND sp."school" = sc."school"
            LEFT JOIN roster r ON r."student" = sc."student"
           WHERE sc."school" = ${p.$(String(req.schoolId))} AND sc."academicYear" = ${p.$(String(year._id))}
             AND sc."concession" = ${p.$(id)} AND sc."isActive" IS NOT FALSE
           ORDER BY u."name"`, p.list);
        ok(res, {
            history: await historyFor(req.schoolId, 'FeeConcession', id),
            rows: rows.map(r => ({
                _id: r._id, studentId: r.student, name: r.name, admissionNumber: r.admissionNumber || '',
                classLabel: r.sectionName ? classLabel(r.classNumber, r.className, r.sectionName) : '—',
                credited: r2(r.credited), since: r.createdAt,
            })),
        });
    } catch (e) { fail(res, e); }
};

/**
 * Students the assign dialog offers, narrowed by the scheme's eligibility:
 * female students, siblings (a parent with two or more children here), new
 * admissions (joined since the year began), or the whole roster for the
 * groups the school records nowhere (staff and alumni children, selected).
 */
exports.concessionCandidates = async (req, res) => {
    try {
        const id = uuidOr(req.params.id);
        const c = id && await FeeConcession.findOne({ _id: id, school: req.schoolId }).lean();
        if (!c) return res.status(404).json({ success: false, message: 'Concession not found' });
        const { year } = await resolveYear(req.schoolId, req.query.academicYearId);
        if (!year) return ok(res, { rows: [], narrowed: false });
        const p = params();
        const conds = [];
        const elig = c.eligibility || 'selected';
        if (elig === 'female') conds.push(`LOWER(COALESCE(sp."gender", '')) IN ('female', 'f', 'girl')`);
        if (elig === 'new_admissions') conds.push(`u."createdAt" >= ${p.$(new Date(year.startDate))}`);
        if (elig === 'siblings') conds.push(`sp."parent" IS NOT NULL AND (SELECT COUNT(*) FROM ${T(StudentProfile)} s2 WHERE s2."parent" = sp."parent" AND s2."school" = sp."school") > 1`);
        if (req.query.q && String(req.query.q).trim()) {
            const like = p.$(`%${String(req.query.q).trim()}%`);
            conds.push(`(u."name" ILIKE ${like} OR sp."admissionNumber" ILIKE ${like})`);
        }
        const sql = `WITH ${rosterCtes(p.$, { schoolId: req.schoolId, yearId: year._id, classId: uuidOr(req.query.classId), sectionId: uuidOr(req.query.sectionId) })}
          SELECT r."student", u."name", sp."admissionNumber", sp."gender", r."className", r."classNumber", r."sectionName",
                 EXISTS (SELECT 1 FROM ${T(StudentConcession)} sc WHERE sc."student" = r."student" AND sc."concession" = ${p.$(id)}
                          AND sc."academicYear" = ${p.$(String(year._id))} AND sc."isActive" IS NOT FALSE) AS "held"
            FROM roster r
            JOIN ${T(User)} u ON u."_id" = r."student"
            LEFT JOIN ${T(StudentProfile)} sp ON sp."user" = r."student" AND sp."school" = u."school"
           ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
           ORDER BY r."classNumber" NULLS LAST, r."sectionName", u."name"
           LIMIT 1000`;
        const { rows } = await pool.query(sql, p.list);
        ok(res, {
            eligibility: elig,
            narrowed: ['female', 'new_admissions', 'siblings'].includes(elig),
            rows: rows.map(r => ({
                _id: r.student, name: r.name, admissionNumber: r.admissionNumber || '',
                classLabel: classLabel(r.classNumber, r.className, r.sectionName), held: !!r.held,
            })),
        });
    } catch (e) { fail(res, e); }
};

exports.assignConcession = async (req, res) => {
    try {
        const out = await feesCtl.assignConcessionTo(req, req.params.id, req.body.studentIds, req.body);
        if (out.error) return bad(res, out.error);
        ok(res, out);
    } catch (e) { fail(res, e); }
};

// ── Fine rules ───────────────────────────────────────────────────────────────

exports.fineRules = async (req, res) => {
    try {
        const q = req.query;
        const { year } = await resolveYear(req.schoolId, q.academicYearId);
        const { page, limit, offset } = pageArgs(q, 10);
        const [rules, classes] = await Promise.all([
            FineRule.find({ school: req.schoolId }).sort({ name: 1 }).populate('createdBy', 'name').populate('updatedBy', 'name').lean(),
            Class.find({ school: req.schoolId }).select('className classNumber').lean(),
        ]);
        const classBy = new Map(classes.map(c => [String(c._id), classTitle(c.classNumber, c.className)]));

        // Per rule and overall: students fined this year, and how much of the
        // fines has been settled — credits pay a student's oldest charges first.
        let perRule = new Map(), affected = 0, collected = 0, charged = 0;
        if (year) {
            const { rows } = await pool.query(`
              WITH deb AS (
                SELECT l."student", l."amount", l."category", l."referenceId",
                       SUM(l."amount") OVER (PARTITION BY l."student" ORDER BY COALESCE(l."periodStart", l."createdAt"), l."createdAt", l."_id") AS "cum"
                  FROM ${T(FeeLedger)} l
                 WHERE l."school" = $1 AND l."academicYear" = $2 AND l."entryType" = 'debit'
              ),
              cred AS (
                SELECT l."student", SUM(l."amount") AS "c" FROM ${T(FeeLedger)} l
                 WHERE l."school" = $1 AND l."academicYear" = $2 AND l."entryType" = 'credit' GROUP BY 1
              )
              SELECT d."referenceId" AS "rule", COUNT(DISTINCT d."student") AS "students", SUM(d."amount") AS "charged",
                     SUM(d."amount" - GREATEST(0, LEAST(d."amount", d."cum" - COALESCE(c."c", 0)))) AS "settled"
                FROM deb d LEFT JOIN cred c ON c."student" = d."student"
               WHERE d."category" = 'fine'
               GROUP BY ROLLUP (d."referenceId")`, [String(req.schoolId), String(year._id)]);
            for (const r of rows) {
                if (r.rule === null) { affected = Number(r.students) || 0; collected = r2(r.settled); charged = r2(r.charged); }
                else perRule.set(String(r.rule), { students: Number(r.students) || 0, charged: r2(r.charged), settled: r2(r.settled) });
            }
        }
        const term = String(q.q || '').trim().toLowerCase();
        const rows = rules.map(r => ({
            _id: r._id, name: r.name, description: r.description || '',
            ruleType: r.ruleType || 'late_payment', fineType: r.fineType,
            flatAmount: r2(r.flatAmount), perDayAmount: r2(r.perDayAmount), gracePeriodDays: r.gracePeriodDays || 0, maxCap: r2(r.maxCap),
            appliesTo: r.appliesTo || 'all',
            classes: (r.classes || []).map(id => ({ _id: id, name: classBy.get(String(id)) || 'Removed class' })),
            isActive: r.isActive !== false, status: r.isActive !== false ? 'active' : 'inactive',
            students: perRule.get(String(r._id))?.students || 0,
            charged: perRule.get(String(r._id))?.charged || 0,
            settled: perRule.get(String(r._id))?.settled || 0,
            createdAt: r.createdAt, updatedAt: r.updatedAt,
            createdBy: r.createdBy?.name || null, updatedBy: r.updatedBy?.name || null,
        })).filter(r =>
            (!q.ruleType || r.ruleType === q.ruleType)
            && (!q.appliesTo || r.appliesTo === q.appliesTo)
            && (!term || r.name.toLowerCase().includes(term) || r.description.toLowerCase().includes(term)));
        const counts = { all: rows.length, active: rows.filter(r => r.isActive).length, inactive: rows.filter(r => !r.isActive).length };
        const status = ['active', 'inactive'].includes(q.status) ? q.status : null;
        const shown = status ? rows.filter(r => r.status === status) : rows;
        ok(res, {
            year: yearOut(year),
            tiles: { total: rules.length, active: rules.filter(r => r.isActive !== false).length,
                inactive: rules.filter(r => r.isActive === false).length, affected, collected, charged },
            counts,
            rows: shown.slice(offset, offset + limit),
        }, { total: shown.length, page, pages: Math.ceil(shown.length / limit) });
    } catch (e) { fail(res, e); }
};

exports.fineRuleActivity = async (req, res) => {
    try {
        const id = uuidOr(req.params.id);
        const rule = id && await FineRule.findOne({ _id: id, school: req.schoolId }).lean();
        if (!rule) return res.status(404).json({ success: false, message: 'Fine rule not found' });
        const { year } = await resolveYear(req.schoolId, req.query.academicYearId);
        const [history, fined] = await Promise.all([
            historyFor(req.schoolId, 'FineRule', id),
            year ? pool.query(`
              SELECT l."student", u."name", SUM(l."amount") AS "amt", COUNT(*) AS "n", MAX(l."createdAt") AS "last"
                FROM ${T(FeeLedger)} l JOIN ${T(User)} u ON u."_id" = l."student"
               WHERE l."school" = $1 AND l."academicYear" = $2 AND l."category" = 'fine' AND l."referenceId" = $3
               GROUP BY 1, 2 ORDER BY "last" DESC LIMIT 50`, [String(req.schoolId), String(year._id), id]).then(r => r.rows) : [],
        ]);
        ok(res, {
            history,
            students: fined.map(r => ({ _id: r.student, name: r.name, amount: r2(r.amt), times: Number(r.n) || 0, last: r.last })),
        });
    } catch (e) { fail(res, e); }
};

// ── Reports ──────────────────────────────────────────────────────────────────

/**
 * The window a report covers. A term is half of the academic year — there are
 * no terms stored anywhere, so "Term 1" means the year's first six months and
 * says so in its label. Otherwise the from/to asked for, else the whole year.
 */
function reportWindow(q, year) {
    const ys = new Date(year.startDate), ye = endOfDay(new Date(year.endDate));
    const mid = new Date(ys.getFullYear(), ys.getMonth() + 6, 1);
    if (q.term === 't1') return { from: ys, to: new Date(mid.getTime() - 1), term: true };
    if (q.term === 't2') return { from: mid, to: ye, term: true };
    const from = localDay(q.from) || ys;
    const to = isDay(q.to) ? endOfDay(localDay(q.to)) : ye;
    return { from, to, term: false };
}
const prevWindow = ({ from, to }) => {
    const span = to.getTime() - from.getTime();
    return { from: new Date(from.getTime() - span - 1), to: new Date(from.getTime() - 1) };
};

/**
 * Students in scope with their year's money — the dataset behind the dues and
 * custom reports and the report tiles. `studentType`: new | existing |
 * with_concession | without_concession.
 */
async function studentDataset(schoolId, year, q) {
    const p = params();
    const conds = [];
    if (q.studentType === 'new') conds.push(`u."createdAt" >= ${p.$(new Date(year.startDate))}`);
    if (q.studentType === 'existing') conds.push(`u."createdAt" < ${p.$(new Date(year.startDate))}`);
    if (q.studentType === 'with_concession' || q.studentType === 'without_concession') {
        conds.push(`${q.studentType === 'with_concession' ? '' : 'NOT'} EXISTS (SELECT 1 FROM ${T(StudentConcession)} sc
                    WHERE sc."student" = r."student" AND sc."academicYear" = ${p.$(String(year._id))} AND sc."isActive" IS NOT FALSE)`);
    }
    const sql = `WITH ${rosterCtes(p.$, { schoolId, yearId: year._id, classId: uuidOr(q.classId), sectionId: uuidOr(q.sectionId) })},
      ${balanceCte(p.$, { schoolId, yearId: year._id })},
      lp AS (SELECT fp."student", MAX(fp."paymentDate") AS "at" FROM ${T(FeePayment)} fp
              WHERE fp."school" = ${p.$(String(schoolId))} AND fp."academicYear" = ${p.$(String(year._id))} AND fp."paymentStatus" = 'completed'
              GROUP BY 1)
      SELECT r."student", u."name", sp."admissionNumber", sp."rollNumber", r."classId", r."className", r."classNumber",
             r."section", r."sectionName", COALESCE(b."charged", 0) AS "charged", COALESCE(b."waived", 0) AS "waived",
             COALESCE(b."fine", 0) AS "fine", COALESCE(b."paid", 0) AS "paid", COALESCE(b."due", 0) AS "due",
             lp."at" AS "lastPayment", ${STATUS_SQL} AS "status"
        FROM roster r JOIN ${T(User)} u ON u."_id" = r."student"
        LEFT JOIN ${T(StudentProfile)} sp ON sp."user" = r."student" AND sp."school" = u."school"
        LEFT JOIN bal b ON b."student" = r."student"
        LEFT JOIN lp ON lp."student" = r."student"
       ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
       ORDER BY r."classNumber" NULLS LAST, r."sectionName", u."name"`;
    const { rows } = await pool.query(sql, p.list);
    const status = ['paid', 'partial', 'pending', 'none'].includes(q.status) ? q.status : null;
    return rows.filter(r => !status || r.status === status).map(r => ({
        _id: String(r.student), name: r.name, admissionNumber: r.admissionNumber || '', rollNumber: r.rollNumber || '',
        classId: String(r.classId), className: classTitle(r.classNumber, r.className), classNumber: Number(r.classNumber) || 0,
        sectionId: String(r.section), sectionName: r.sectionName, classLabel: classLabel(r.classNumber, r.className, r.sectionName),
        total: r2(Number(r.charged) - Number(r.waived)), charged: r2(r.charged), waived: r2(r.waived), fine: r2(r.fine),
        paid: r2(r.paid), due: r2(Math.max(0, Number(r.due))), lastPayment: r.lastPayment, status: r.status,
    }));
}

/** Completed payments in a window for a set of students (null = everyone). */
async function paymentsIn(schoolId, yearId, { from, to, students = null, status = 'completed' }) {
    const p = params();
    const sql = `
      SELECT fp."_id", fp."student", fp."amount", fp."paymentMode", fp."paymentStatus", fp."paymentDate", fp."receiptNumber",
             fp."lines", fp."gateway", u."name", sp."admissionNumber", cs."sectionName", c."className", c."classNumber"
        FROM ${T(FeePayment)} fp
        LEFT JOIN ${T(User)} u ON u."_id" = fp."student"
        LEFT JOIN ${T(StudentProfile)} sp ON sp."user" = fp."student" AND sp."school" = fp."school"
        LEFT JOIN ${T(ClassSection)} cs ON cs."_id" = sp."currentSection"
        LEFT JOIN ${T(Class)} c ON c."_id" = cs."class"
       WHERE fp."school" = ${p.$(String(schoolId))} AND fp."academicYear" = ${p.$(String(yearId))}
         AND fp."paymentDate" >= ${p.$(from)} AND fp."paymentDate" <= ${p.$(to)}
         ${status ? `AND fp."paymentStatus" = ${p.$(status)}` : ''}
         ${students ? `AND fp."student" = ANY(${p.$(students)}::uuid[])` : ''}
       ORDER BY fp."paymentDate" DESC`;
    const { rows } = await pool.query(sql, p.list);
    return rows.map(paymentRow);
}

const sumBy = (rows, key) => r2(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0));

exports.reportOverview = async (req, res) => {
    try {
        const q = req.query;
        const { year } = await resolveYear(req.schoolId, q.academicYearId);
        if (!year) return ok(res, { year: null });
        const win = reportWindow(q, year);
        const prev = prevWindow(win);
        const scoped = uuidOr(q.classId) || uuidOr(q.sectionId) || q.studentType;
        const students = await studentDataset(req.schoolId, year, { ...q, status: null });
        const ids = scoped ? students.map(s => s._id) : null;

        const concessionsIn = async (w) => {
            const p = params();
            const { rows } = await pool.query(`
              SELECT COALESCE(SUM(CASE WHEN l."entryType" = 'credit' THEN l."amount" ELSE -l."amount" END), 0) AS "amt"
                FROM ${T(FeeLedger)} l
               WHERE l."school" = ${p.$(String(req.schoolId))} AND l."academicYear" = ${p.$(String(year._id))}
                 AND l."referenceType" = 'StudentConcession' AND l."createdAt" >= ${p.$(w.from)} AND l."createdAt" <= ${p.$(w.to)}
                 ${ids ? `AND l."student" = ANY(${p.$(ids)}::uuid[])` : ''}`, p.list);
            return r2(rows[0]?.amt);
        };
        const duesAsOf = async (asOf) => {
            const p = params();
            const { rows } = await pool.query(`WITH ${balanceCte(p.$, { schoolId: req.schoolId, yearId: year._id, asOf })}
              SELECT COALESCE(SUM(GREATEST(b."due", 0)), 0) AS "due" FROM bal b
               ${ids ? `WHERE b."student" = ANY(${p.$(ids)}::uuid[])` : ''}`, p.list);
            return r2(rows[0]?.due);
        };
        const [inWin, allWin, inPrev, concNow, concPrev, duesEnd, duesStart, trendMap, byHead, heads] = await Promise.all([
            paymentsIn(req.schoolId, year._id, { ...win, students: ids }),
            paymentsIn(req.schoolId, year._id, { ...win, students: ids, status: null }),
            paymentsIn(req.schoolId, year._id, { ...prev, students: ids }),
            concessionsIn(win), concessionsIn(prev),
            duesAsOf(win.to.getTime() > Date.now() ? null : win.to), duesAsOf(win.from),
            monthlyMoney({ schoolId: req.schoolId, yearId: year._id, from: new Date(win.from.getFullYear(), win.from.getMonth(), 1),
                to: new Date(win.to.getFullYear(), win.to.getMonth() + 1, 1), classId: uuidOr(q.classId), sectionId: uuidOr(q.sectionId) }),
            collectedByHead({ schoolId: req.schoolId, yearId: year._id, from: win.from, to: win.to, studentFilter: ids }),
            FeeHead.find({ school: req.schoolId }).select('name category').lean(),
        ]);
        const collected = sumBy(inWin, 'amount');
        const charged = students.filter(s => s.status !== 'none');
        const paidUp = charged.filter(s => s.status === 'paid').length;

        // Donut by fee head; a category filter keeps only that category's heads.
        const categoryId = uuidOr(q.categoryId);
        const headBy = new Map(heads.map(h => [String(h._id), h]));
        const slices = [...byHead.entries()]
            .filter(([k]) => !categoryId || String(headBy.get(k)?.category) === categoryId)
            .map(([k, v]) => ({ _id: k, name: k === '_other' ? 'Unallocated payments' : (headBy.get(k)?.name || 'Removed fee head'), amount: v }))
            .filter(s => s.amount > 0).sort((a, b) => b.amount - a.amount);
        const donutTotal = r2(slices.reduce((s, x) => s + x.amount, 0));
        const top = slices.slice(0, 5);
        if (slices.length > 5) top.push({ _id: '_rest', name: 'Other Fees', amount: r2(slices.slice(5).reduce((s, x) => s + x.amount, 0)), names: slices.slice(5).map(s => s.name) });

        // Class summary: students, collected in the window, dues now, share.
        const paidByStudent = new Map();
        for (const pm of inWin) paidByStudent.set(String(pm.student._id), (paidByStudent.get(String(pm.student._id)) || 0) + pm.amount);
        const classes = new Map();
        for (const s of students) {
            const c = classes.get(s.classId) || { _id: s.classId, label: s.className, n: s.classNumber, students: 0, collected: 0, dues: 0, net: 0, paid: 0 };
            c.students += 1; c.collected += paidByStudent.get(s._id) || 0; c.dues += s.due; c.net += Math.max(0, s.total); c.paid += s.paid;
            classes.set(s.classId, c);
        }
        const months = monthsBetween(new Date(win.from.getFullYear(), win.from.getMonth(), 1), new Date(win.to.getFullYear(), win.to.getMonth() + 1, 1));
        ok(res, {
            year: yearOut(year),
            window: { from: win.from, to: win.to, term: win.term },
            compareLabel: win.term ? 'vs last term' : 'vs previous period',
            tiles: {
                collection: collected, collectionChange: change(collected, sumBy(inPrev, 'amount')),
                dues: duesEnd, duesChange: change(duesEnd, duesStart),
                studentsPaid: paidUp, studentsCharged: charged.length,
                pendingPayments: charged.length - paidUp,
                concessions: concNow, concessionsChange: change(concNow, concPrev),
            },
            trend: months.map(m => {
                const v = trendMap.get(m.key) || { collected: 0, open: 0 };
                return { month: m.key, label: m.label, year: m.year, collected: v.collected, dues: v.open };
            }),
            byHead: { total: donutTotal, slices: top.map(s => ({ ...s, pct: donutTotal > 0 ? r2(s.amount / donutTotal * 100) : 0 })) },
            classSummary: [...classes.values()].sort((a, b) => b.n - a.n).map(c => ({
                _id: c._id, label: c.label, students: c.students, collected: r2(c.collected), dues: r2(c.dues),
                pct: c.net > 0 ? Math.min(100, Math.round(c.paid / c.net * 100)) : null,
            })),
            recent: allWin.slice(0, 5),
        });
    } catch (e) { fail(res, e); }
};

const MODE_NAMES = { online: 'Online (gateway)', upi: 'UPI', bank_transfer: 'Net banking', cash: 'Cash', card: 'Card', cheque: 'Cheque', dd: 'Demand draft' };
const STATUS_NAMES = { paid: 'Paid', partial: 'Partial', pending: 'Pending', none: 'Not charged' };

/**
 * One report as columns + rows + totals, so the table, the Excel export, the
 * email and the scheduled send all print the same thing.
 */
async function buildReport(type, schoolId, q) {
    const { year } = await resolveYear(schoolId, q.academicYearId);
    if (!year) return { title: 'No academic year', columns: [], rows: [], totals: null };
    const win = reportWindow(q, year);
    const money = (key, label) => ({ key, label, type: 'money' });
    const text = (key, label) => ({ key, label });
    const scoped = uuidOr(q.classId) || uuidOr(q.sectionId) || q.studentType;

    if (type === 'class') {
        const students = await studentDataset(schoolId, year, q);
        const inWin = await paymentsIn(schoolId, year._id, { ...win, students: scoped ? students.map(s => s._id) : null });
        const paidBy = new Map();
        for (const pm of inWin) paidBy.set(String(pm.student._id), (paidBy.get(String(pm.student._id)) || 0) + pm.amount);
        const groups = new Map();
        for (const s of students) {
            const k = s.sectionId;
            const g = groups.get(k) || { cls: s.className, n: s.classNumber, section: s.sectionName, students: 0, total: 0, collected: 0, paid: 0, due: 0 };
            g.students += 1; g.total += Math.max(0, s.total); g.collected += paidBy.get(s._id) || 0; g.paid += s.paid; g.due += s.due;
            groups.set(k, g);
        }
        const rows = [...groups.values()].sort((a, b) => b.n - a.n || String(a.section).localeCompare(String(b.section))).map(g => ({
            class: g.cls, section: g.section, students: g.students, total: r2(g.total), collected: r2(g.collected), due: r2(g.due),
            pct: g.total > 0 ? Math.min(100, Math.round(g.paid / g.total * 100)) : null,
        }));
        return { title: 'Class-wise collection', year, window: win,
            columns: [text('class', 'Class'), text('section', 'Section'), { key: 'students', label: 'Students', type: 'number' },
                money('total', 'Total fees'), money('collected', 'Collected (period)'), money('due', 'Dues'), { key: 'pct', label: 'Collection %', type: 'pct' }],
            rows, totals: { class: 'Total', students: sumBy(rows, 'students'), total: sumBy(rows, 'total'), collected: sumBy(rows, 'collected'), due: sumBy(rows, 'due') } };
    }
    if (type === 'category') {
        const students = scoped ? await studentDataset(schoolId, year, q) : null;
        const ids = students ? students.map(s => s._id) : null;
        const [collected, chargedMap, heads, cats] = await Promise.all([
            collectedByHead({ schoolId, yearId: year._id, from: win.from, to: win.to, studentFilter: ids }),
            chargedByHead(schoolId, year._id, ids),
            FeeHead.find({ school: schoolId }).select('name category').lean(),
            FeeCategory.find({ school: schoolId }).select('name').lean(),
        ]);
        const catOf = new Map(heads.map(h => [String(h._id), h.category ? String(h.category) : '_none']));
        const catName = new Map(cats.map(c => [String(c._id), c.name]));
        const groups = new Map();
        const add = (head, key, v) => {
            const cid = head === '_other' ? '_unalloc' : (catOf.get(head) || '_none');
            const g = groups.get(cid) || { heads: new Set(), charged: 0, collected: 0 };
            if (head !== '_other') g.heads.add(head);
            g[key] += v; groups.set(cid, g);
        };
        for (const [h, v] of chargedMap) add(h, 'charged', v);
        for (const [h, v] of collected) add(h, 'collected', v);
        const all = r2([...groups.values()].reduce((s, g) => s + g.collected, 0));
        const rows = [...groups.entries()].map(([cid, g]) => ({
            category: cid === '_none' ? 'Uncategorised' : cid === '_unalloc' ? 'Unallocated payments' : (catName.get(cid) || 'Removed category'),
            heads: g.heads.size, charged: r2(g.charged), collected: r2(g.collected),
            share: all > 0 ? r2(g.collected / all * 100) : 0,
        })).filter(r => !uuidOr(q.categoryId) || r.category === catName.get(q.categoryId)).sort((a, b) => b.collected - a.collected);
        return { title: 'Category-wise collection', year, window: win,
            columns: [text('category', 'Category'), { key: 'heads', label: 'Fee heads', type: 'number' }, money('charged', 'Charged (year)'),
                money('collected', 'Collected (period)'), { key: 'share', label: 'Share %', type: 'pct' }],
            rows, totals: { category: 'Total', charged: sumBy(rows, 'charged'), collected: sumBy(rows, 'collected') } };
    }
    if (type === 'mode') {
        const students = scoped ? await studentDataset(schoolId, year, q) : null;
        const inWin = await paymentsIn(schoolId, year._id, { ...win, students: students ? students.map(s => s._id) : null });
        const all = sumBy(inWin, 'amount');
        const groups = new Map();
        for (const pm of inWin) {
            const g = groups.get(pm.mode) || { count: 0, amount: 0 };
            g.count += 1; g.amount += pm.amount; groups.set(pm.mode, g);
        }
        const rows = [...groups.entries()].map(([m, g]) => ({
            mode: MODE_NAMES[m] || m, count: g.count, amount: r2(g.amount), average: r2(g.amount / g.count),
            share: all > 0 ? r2(g.amount / all * 100) : 0,
        })).sort((a, b) => b.amount - a.amount);
        return { title: 'Payment-mode report', year, window: win,
            columns: [text('mode', 'Payment mode'), { key: 'count', label: 'Payments', type: 'number' }, money('amount', 'Amount'),
                money('average', 'Average'), { key: 'share', label: 'Share %', type: 'pct' }],
            rows, totals: { mode: 'Total', count: sumBy(rows, 'count'), amount: all } };
    }
    if (type === 'dues') {
        const students = (await studentDataset(schoolId, year, q)).filter(s => s.due > 0.004);
        const rows = students.sort((a, b) => b.due - a.due).map(s => ({
            name: s.name, admissionNumber: s.admissionNumber, class: s.classLabel, total: s.total, paid: s.paid, due: s.due,
            lastPayment: s.lastPayment, status: STATUS_NAMES[s.status],
        }));
        return { title: 'Dues report', year, window: null,
            columns: [text('name', 'Student'), text('admissionNumber', 'Adm. No.'), text('class', 'Class'), money('total', 'Total fees'),
                money('paid', 'Paid'), money('due', 'Due'), { key: 'lastPayment', label: 'Last payment', type: 'date' }, text('status', 'Status')],
            rows, totals: { name: `${rows.length} students`, total: sumBy(rows, 'total'), paid: sumBy(rows, 'paid'), due: sumBy(rows, 'due') } };
    }
    if (type === 'concession') {
        const students = await studentDataset(schoolId, year, q);
        const inScope = new Map(students.map(s => [s._id, s]));
        const scs = await StudentConcession.find({ school: schoolId, academicYear: year._id, isActive: true }).populate('concession').lean();
        const credited = await concessionMoney(schoolId, year._id);
        const creditBy = new Map();
        for (const c of credited) creditBy.set(`${c.cid}:${c.student}`, (creditBy.get(`${c.cid}:${c.student}`) || 0) + c.amt);
        const rows = scs.filter(sc => inScope.has(String(sc.student))).map(sc => {
            const s = inScope.get(String(sc.student));
            const c = sc.concession || {};
            return {
                name: s.name, class: s.classLabel, concession: c.name || '—',
                discount: c.concessionType === 'percentage' ? `${c.value}%` : `₹${Number(c.value || 0).toLocaleString('en-IN')}`,
                credited: r2(creditBy.get(`${c._id}:${s._id}`) || 0), since: sc.createdAt,
            };
        }).sort((a, b) => a.name.localeCompare(b.name));
        return { title: 'Concession report', year, window: null,
            columns: [text('name', 'Student'), text('class', 'Class'), text('concession', 'Concession'), text('discount', 'Discount'),
                money('credited', 'Credited'), { key: 'since', label: 'Assigned on', type: 'date' }],
            rows, totals: { name: `${rows.length} concessions`, credited: sumBy(rows, 'credited') } };
    }
    if (type === 'fine') {
        const students = await studentDataset(schoolId, year, q);
        const inScope = new Map(students.map(s => [s._id, s]));
        const entries = await FeeLedger.find({ school: schoolId, academicYear: year._id, category: 'fine',
            createdAt: { $gte: win.from, $lte: win.to } }).sort({ createdAt: -1 }).limit(2000).lean();
        const rules = await FineRule.find({ school: schoolId }).select('name').lean();
        const ruleBy = new Map(rules.map(r => [String(r._id), r.name]));
        const rows = entries.filter(e => inScope.has(String(e.student))).map(e => {
            const s = inScope.get(String(e.student));
            return { date: e.createdAt, name: s.name, class: s.classLabel, rule: ruleBy.get(String(e.referenceId)) || '—', amount: r2(e.amount), description: e.description };
        });
        return { title: 'Fine report', year, window: win,
            columns: [{ key: 'date', label: 'Date', type: 'date' }, text('name', 'Student'), text('class', 'Class'), text('rule', 'Fine rule'),
                money('amount', 'Amount'), text('description', 'Details')],
            rows, totals: { date: `${rows.length} fines`, amount: sumBy(rows, 'amount') } };
    }
    if (type === 'collection') {
        const students = scoped ? await studentDataset(schoolId, year, q) : null;
        const inWin = await paymentsIn(schoolId, year._id, { ...win, students: students ? students.map(s => s._id) : null });
        const rows = inWin.map(pm => ({ date: pm.date, receipt: pm.receiptNumber || '—', name: pm.student.name, class: pm.classLabel,
            feeHead: pm.feeHead, mode: MODE_NAMES[pm.mode] || pm.mode, amount: pm.amount }));
        return { title: 'Collection summary', year, window: win,
            columns: [{ key: 'date', label: 'Date', type: 'date' }, text('receipt', 'Receipt'), text('name', 'Student'), text('class', 'Class'),
                text('feeHead', 'Fee head'), text('mode', 'Mode'), money('amount', 'Amount')],
            rows, totals: { date: `${rows.length} payments`, amount: sumBy(rows, 'amount') } };
    }
    // custom: one row per student, every money column; the page picks which to show.
    const students = await studentDataset(schoolId, year, q);
    const rows = students.map(s => ({
        name: s.name, admissionNumber: s.admissionNumber, rollNumber: s.rollNumber, class: s.classLabel,
        charged: s.charged, waived: s.waived, fine: s.fine, total: s.total, paid: s.paid, due: s.due,
        status: STATUS_NAMES[s.status], lastPayment: s.lastPayment,
    }));
    return { title: 'Student fee report', year, window: null,
        columns: [text('name', 'Student'), text('admissionNumber', 'Adm. No.'), text('rollNumber', 'Roll No.'), text('class', 'Class'),
            money('charged', 'Charged'), money('waived', 'Concession'), money('fine', 'Fine'), money('total', 'Total fees'),
            money('paid', 'Paid'), money('due', 'Due'), text('status', 'Status'), { key: 'lastPayment', label: 'Last payment', type: 'date' }],
        rows, totals: { name: `${rows.length} students`, charged: sumBy(rows, 'charged'), waived: sumBy(rows, 'waived'), fine: sumBy(rows, 'fine'),
            total: sumBy(rows, 'total'), paid: sumBy(rows, 'paid'), due: sumBy(rows, 'due') } };
}

/** What each head has charged this year (lump demands split by their items). */
async function chargedByHead(schoolId, yearId, students = null) {
    const p = params();
    const { rows } = await pool.query(`
      SELECT (it->>'feeHead') AS "head",
             SUM(CASE WHEN l."feeItemId" IS NOT NULL
                      THEN CASE WHEN (it->>'_id') = l."feeItemId"::text THEN l."amount" ELSE 0 END
                      ELSE l."amount" * COALESCE((it->>'amount')::float, 0) / NULLIF(tot."t", 0) END) AS "amt"
        FROM ${T(FeeLedger)} l
        JOIN ${T(FeeStructure)} fs ON fs."_id" = l."referenceId"
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fs."items") = 'array' THEN fs."items" ELSE '[]'::jsonb END) it
       CROSS JOIN LATERAL (SELECT SUM(COALESCE((x->>'amount')::float, 0)) AS "t"
                             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(fs."items") = 'array' THEN fs."items" ELSE '[]'::jsonb END) x
                            WHERE COALESCE((x->>'isActive')::boolean, true)) tot
       WHERE l."school" = ${p.$(String(schoolId))} AND l."academicYear" = ${p.$(String(yearId))} AND l."category" = 'fee_charged'
         AND l."entryType" = 'debit' AND l."referenceType" = 'FeeStructure' AND COALESCE((it->>'isActive')::boolean, true)
         ${students ? `AND l."student" = ANY(${p.$(students)}::uuid[])` : ''}
       GROUP BY 1`, p.list);
    return new Map(rows.map(r => [r.head, r2(r.amt)]));
}

const REPORT_TYPES = ['collection', 'class', 'category', 'mode', 'dues', 'concession', 'fine', 'custom'];

exports.report = async (req, res) => {
    try {
        const type = req.params.type;
        if (!REPORT_TYPES.includes(type)) return bad(res, 'Unknown report');
        const r = await buildReport(type, req.schoolId, req.query);
        ok(res, { ...r, year: yearOut(r.year) });
    } catch (e) { fail(res, e); }
};

const cellValue = (col, v) => {
    if (v == null || v === '') return '';
    if (col.type === 'date') return new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    if (col.type === 'pct') return v == null ? '' : Number(v);
    return v;
};

exports.reportExport = async (req, res) => {
    try {
        const type = req.params.type;
        if (!REPORT_TYPES.includes(type)) return bad(res, 'Unknown report');
        const r = await buildReport(type, req.schoolId, req.query);
        const cols = (String(req.query.columns || '').split(',').filter(Boolean).length
            ? r.columns.filter(c => String(req.query.columns).split(',').includes(c.key)) : r.columns);
        const aoa = [cols.map(c => c.label), ...r.rows.map(row => cols.map(c => cellValue(c, row[c.key])))];
        if (r.totals) aoa.push(cols.map(c => cellValue(c, r.totals[c.key])));
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = cols.map(c => ({ wch: Math.max(10, c.label.length + 2, c.type === 'money' ? 14 : 12) }));
        XLSX.utils.book_append_sheet(wb, ws, r.title.slice(0, 31));
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const name = `${r.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${r.year?.yearName || ''}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.send(buf);
    } catch (e) { fail(res, e); }
};

/** A report as an HTML email: the heading, the totals and the first 200 rows. */
async function reportEmailHtml(schoolId, r, sym = '₹') {
    const school = await School.findById(schoolId).lean();
    const fmt = (c, v) => {
        if (v == null || v === '') return '';
        if (c.type === 'money') return `${sym}${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
        if (c.type === 'pct') return `${v}%`;
        if (c.type === 'date') return new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        return String(v).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    };
    const th = r.columns.map(c => `<th style="text-align:${c.type ? 'right' : 'left'};padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#6b7280">${c.label}</th>`).join('');
    const tr = (row, bold) => `<tr>${r.columns.map(c => `<td style="text-align:${c.type ? 'right' : 'left'};padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:13px${bold ? ';font-weight:700' : ''}">${fmt(c, row[c.key])}</td>`).join('')}</tr>`;
    const period = r.window ? `${new Date(r.window.from).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} – ${new Date(r.window.to).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}` : `Academic year ${r.year?.yearName || ''}`;
    return `${emailHeaderHtml(school, 'Fees report')}
      <h2 style="margin:16px 0 4px;font-size:18px">${r.title}</h2>
      <p style="margin:0 0 14px;color:#6b7280;font-size:13px">${period}${r.rows.length > 200 ? ` · first 200 of ${r.rows.length} rows — download the Excel file for all of them` : ''}</p>
      <table style="border-collapse:collapse;width:100%"><thead><tr>${th}</tr></thead>
        <tbody>${r.rows.slice(0, 200).map(row => tr(row)).join('')}${r.totals ? tr(r.totals, true) : ''}</tbody></table>`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const recipientsOf = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map(s => String(s).trim().toLowerCase()).filter(Boolean))];

exports.reportEmail = async (req, res) => {
    try {
        const type = String(req.body.type || 'collection');
        if (!REPORT_TYPES.includes(type)) return bad(res, 'Unknown report');
        const to = recipientsOf(req.body.to);
        if (!to.length) return bad(res, 'Enter at least one email address');
        const wrong = to.find(e => !EMAIL_RE.test(e));
        if (wrong) return bad(res, `"${wrong}" is not an email address`);
        if (to.length > 20) return bad(res, 'Send to 20 addresses at most');
        const r = await buildReport(type, req.schoolId, req.body.filters || {});
        const settings = await feesCtl.getOrCreateSettings(req.schoolId);
        await sendSchoolMail(req.schoolId, { to: to.join(', '), subject: `${r.title} — ${r.year?.yearName || ''}`, html: await reportEmailHtml(req.schoolId, r, settings.currencySymbol), rethrow: true });
        logFeeAudit(req, { action: 'report_emailed', entityType: 'FeeSettings', after: { report: r.title, to } });
        ok(res, { sent: to.length });
    } catch (e) {
        if (/smtp|mail|auth|connect/i.test(e.message || '')) return res.status(502).json({ success: false, message: `The email could not be sent: ${e.message}` });
        fail(res, e);
    }
};

// Scheduled reports live on FeeSettings.scheduledReports.
exports.reportSchedules = async (req, res) => {
    try {
        const s = await feesCtl.getOrCreateSettings(req.schoolId);
        ok(res, Array.isArray(s.scheduledReports) ? s.scheduledReports : []);
    } catch (e) { fail(res, e); }
};

exports.addReportSchedule = async (req, res) => {
    try {
        const { type, frequency } = req.body;
        if (!REPORT_TYPES.includes(type)) return bad(res, 'Choose a report');
        if (!['weekly', 'monthly'].includes(frequency)) return bad(res, 'Choose weekly or monthly');
        const day = Number(req.body.day);
        if (frequency === 'weekly' && !(Number.isInteger(day) && day >= 0 && day <= 6)) return bad(res, 'Choose a day of the week');
        if (frequency === 'monthly' && !(Number.isInteger(day) && day >= 1 && day <= 28)) return bad(res, 'Choose a day between 1 and 28');
        const to = recipientsOf(req.body.recipients);
        if (!to.length) return bad(res, 'Enter at least one email address');
        const wrong = to.find(e => !EMAIL_RE.test(e));
        if (wrong) return bad(res, `"${wrong}" is not an email address`);
        const s = await feesCtl.getOrCreateSettings(req.schoolId);
        const list = Array.isArray(s.scheduledReports) ? s.scheduledReports : [];
        if (list.length >= 10) return bad(res, 'A school can keep 10 scheduled reports at most');
        const entry = { _id: require('crypto').randomUUID(), type, frequency, day, recipients: to.slice(0, 20), lastSentAt: null, createdBy: req.userId, createdAt: new Date() };
        await FeeSettings.updateOne({ school: req.schoolId }, { scheduledReports: [...list, entry] });
        logFeeAudit(req, { action: 'schedule_added', entityType: 'FeeSettings', entityId: s._id, after: { type, frequency, day, recipients: to } });
        ok(res, entry);
    } catch (e) { fail(res, e); }
};

exports.removeReportSchedule = async (req, res) => {
    try {
        const s = await feesCtl.getOrCreateSettings(req.schoolId);
        const list = Array.isArray(s.scheduledReports) ? s.scheduledReports : [];
        const next = list.filter(x => x._id !== req.params.sid);
        if (next.length === list.length) return res.status(404).json({ success: false, message: 'Schedule not found' });
        await FeeSettings.updateOne({ school: req.schoolId }, { scheduledReports: next });
        logFeeAudit(req, { action: 'schedule_removed', entityType: 'FeeSettings', entityId: s._id });
        ok(res, { removed: true });
    } catch (e) { fail(res, e); }
};

/**
 * Send whichever scheduled reports fall due today. Idempotent by date: a
 * schedule remembers the local day it last went out, so the hourly tick (and
 * every worker restart) sends each one at most once a day.
 */
async function runScheduledReports(schoolId) {
    const s = await FeeSettings.findOne({ school: schoolId }).lean();
    const list = Array.isArray(s?.scheduledReports) ? s.scheduledReports : [];
    if (!list.length) return 0;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let sent = 0;
    const next = [];
    for (const item of list) {
        const due = item.frequency === 'weekly' ? now.getDay() === Number(item.day) : now.getDate() === Number(item.day);
        if (!due || item.lastSentDay === today || now.getHours() < 7) { next.push(item); continue; }
        try {
            const r = await buildReport(item.type, schoolId, {});
            await sendSchoolMail(schoolId, { to: item.recipients.join(', '), subject: `${r.title} — ${r.year?.yearName || ''} (scheduled)`,
                html: await reportEmailHtml(schoolId, r, s.currencySymbol || '₹'), rethrow: true });
            next.push({ ...item, lastSentAt: new Date(), lastSentDay: today, lastError: null });
            sent++;
        } catch (e) {
            next.push({ ...item, lastSentDay: today, lastError: e.message });
        }
    }
    await FeeSettings.updateOne({ school: schoolId }, { scheduledReports: next });
    return sent;
}
exports.runScheduledReports = runScheduledReports;

/** Schools with at least one scheduled fees report — what the sweep visits. */
exports.schoolsWithSchedules = async () => {
    const { rows } = await pool.query(`SELECT "school" FROM ${T(FeeSettings)}
        WHERE jsonb_typeof("scheduledReports") = 'array' AND jsonb_array_length("scheduledReports") > 0`);
    return rows.map(r => r.school);
};

// ── Reminders ────────────────────────────────────────────────────────────────

/**
 * "Send Fee Reminder": one notice to each student who owes money in scope,
 * and to their parents, naming the amount. Only students with dues are
 * contacted; the reply says how many.
 */
/**
 * Who a reminder sent now would reach. Money a family has already sent and
 * the office has not approved yet is taken off what they owe — chasing
 * someone who has paid is the fastest way to be ignored, and the automatic
 * sweep already leaves them alone.
 */
async function reminderAudience(schoolId, ay, q) {
    let owing = (await studentDataset(schoolId, ay, { classId: q.classId, sectionId: q.sectionId })).filter(s => s.due > 0.004);
    const only = Array.isArray(q.studentIds) && q.studentIds.length ? new Set(q.studentIds.map(String)) : null;
    if (only) owing = owing.filter(s => only.has(s._id));
    if (!owing.length) return owing;

    const { rows } = await pool.query(
        `SELECT "student", SUM("amount") AS amt FROM ${T(FeePayment)}
          WHERE "school" = $1 AND "academicYear" = $2 AND "paymentStatus" = 'pending'
            AND "student" = ANY($3::uuid[]) GROUP BY 1`,
        [String(schoolId), String(ay._id), owing.map(s => String(s._id))]);
    const pendingBy = new Map(rows.map(r => [String(r.student), Number(r.amt) || 0]));
    return owing
        .map(s => ({ ...s, due: r2(s.due - (pendingBy.get(String(s._id)) || 0)) }))
        .filter(s => s.due > 0.004);
}

/** The preview the dialog shows before anything is sent. */
exports.reminderPreview = async (req, res) => {
    try {
        const ay = await feesCtl.getActiveYear(req.schoolId);
        if (!ay) return bad(res, 'No active academic year');
        const q = { ...req.query, studentIds: String(req.query.studentIds || '').split(',').filter(Boolean) };
        const owing = await reminderAudience(req.schoolId, ay, q);
        const ids = owing.map(s => String(s._id));
        // When each of them was last chased, however it was sent.
        const last = ids.length ? (await pool.query(
            `SELECT DISTINCT ON ("student") "student", "sentOn", "kind", "auto"
               FROM ${T(FeeReminderLog)}
              WHERE "school" = $1 AND "student" = ANY($2::uuid[])
              ORDER BY "student", "createdAt" DESC`,
            [String(req.schoolId), ids])).rows : [];
        const lastBy = new Map(last.map(r => [String(r.student), r]));
        const today = reminders.localDay();
        ok(res, {
            students: owing.length,
            amount: r2(owing.reduce((s, x) => s + x.due, 0)),
            remindedToday: last.filter(r => r.sentOn === today).length,
            rows: owing.slice(0, 50).map(s => ({
                _id: s._id, name: s.name, classLabel: s.classLabel, due: r2(s.due),
                lastReminded: lastBy.get(String(s._id))?.sentOn || null,
            })),
        });
    } catch (e) { fail(res, e); }
};

/**
 * Send a reminder by hand. It goes through the same writer the automatic
 * sweep uses, so every reminder — however it was set off — lands in one log
 * the office can read.
 */
exports.sendReminders = async (req, res) => {
    try {
        const ay = await feesCtl.getActiveYear(req.schoolId);
        if (!ay) return bad(res, 'No active academic year');
        const q = req.body || {};
        const settings = await feesCtl.getOrCreateSettings(req.schoolId);
        const owing = await reminderAudience(req.schoolId, ay, q);
        if (!owing.length) return ok(res, { sent: 0 });
        if (owing.length > 2000) return bad(res, 'Narrow this down to a class — more than 2,000 students owe fees');
        const note = String(q.message || '').trim().slice(0, 300);
        const sym = settings.currencySymbol || '₹';
        const emailParents = settings.notifications?.emailParents !== false;

        let sent = 0;
        for (const s of owing) {
            const done = await reminders.send({
                schoolId: req.schoolId, student: { _id: s._id, name: s.name }, year: ay,
                amount: s.due, kind: 'manual', note, auto: false,
                sentBy: req.userId, sender: req.userId, senderRole: req.userRole,
                emailParents, sym,
            });
            if (done) sent++;
        }
        logFeeAudit(req, { action: 'reminders_sent', entityType: 'FeeSettings', after: { students: sent } });
        ok(res, { sent });
    } catch (e) { fail(res, e); }
};

/** Every reminder this school has sent, newest first. */
exports.reminderHistory = async (req, res) => {
    try {
        const { page, limit, offset } = pageArgs(req.query, 20);
        const studentId = uuidOr(req.query.studentId);
        const p = params();
        const where = [`r."school" = ${p.$(String(req.schoolId))}`];
        if (studentId) where.push(`r."student" = ${p.$(studentId)}`);
        if (req.query.auto === 'true') where.push(`r."auto" IS TRUE`);
        if (req.query.auto === 'false') where.push(`r."auto" IS NOT TRUE`);
        const { rows } = await pool.query(
            `SELECT r.*, u."name", sp."admissionNumber", c."className", c."classNumber", cs."sectionName",
                    b."name" AS "byName", COUNT(*) OVER () AS "_total"
               FROM ${T(FeeReminderLog)} r
               LEFT JOIN ${T(User)} u ON u."_id" = r."student"
               LEFT JOIN ${T(StudentProfile)} sp ON sp."user" = r."student" AND sp."school" = r."school"
               LEFT JOIN ${T(ClassSection)} cs ON cs."_id" = sp."currentSection"
               LEFT JOIN ${T(Class)} c ON c."_id" = cs."class"
               LEFT JOIN ${T(User)} b ON b."_id" = r."sentBy"
              WHERE ${where.join(' AND ')}
              ORDER BY r."createdAt" DESC
              LIMIT ${p.$(limit)} OFFSET ${p.$(offset)}`, p.list);
        const total = Number(rows[0]?._total) || 0;
        ok(res, rows.map(x => ({
            _id: x._id,
            student: { _id: x.student, name: x.name || '—' },
            admissionNumber: x.admissionNumber || '',
            classLabel: classLabel(x.classNumber, x.className, x.sectionName),
            kind: x.kind, monthKey: x.monthKey, amount: r2(x.amount),
            sentOn: x.sentOn, at: x.createdAt, channel: x.channel,
            auto: !!x.auto, by: x.byName || (x.auto ? 'Automatic' : '—'),
        })), { total, page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};

// ── Settings screen extras ───────────────────────────────────────────────────

const APP_VERSION = (() => { try { return require('../package.json').version || '1.0.0'; } catch { return '1.0.0'; } })();

exports.settingsFull = async (req, res) => {
    try {
        const settings = await feesCtl.getOrCreateSettings(req.schoolId);
        const { year, years } = await resolveYear(req.schoolId, null);
        const active = years.find(y => y.status === 'active');
        const [school, heads, cats, concessions, rules, structures, pending, updatedBy] = await Promise.all([
            School.findById(req.schoolId).select('paymentGateway modules').lean(),
            FeeHead.countDocuments({ school: req.schoolId }),
            FeeCategory.countDocuments({ school: req.schoolId }),
            FeeConcession.countDocuments({ school: req.schoolId }),
            FineRule.countDocuments({ school: req.schoolId }),
            active ? FeeStructure.find({ school: req.schoolId, academicYear: active._id, isActive: true }).select('demandGeneratedAt').lean() : [],
            FeePayment.countDocuments({ school: req.schoolId, paymentStatus: 'pending' }),
            settings.updatedBy ? User.findById(settings.updatedBy).select('name').lean() : null,
        ]);
        const notCharged = structures.filter(s => !s.demandGeneratedAt).length;
        const gatewayOn = !!(school?.paymentGateway?.enabled && school.paymentGateway.modules?.fees);
        // Each check is a real condition the module needs; "operational" means
        // none of the blocking ones failed.
        const checks = [
            { key: 'year', ok: !!active, blocking: true, label: active ? `Active academic year ${active.yearName}` : 'No active academic year — fees cannot be charged or collected' },
            { key: 'structures', ok: structures.length > 0, blocking: true, label: structures.length ? `${structures.length} active fee structure${structures.length === 1 ? '' : 's'} this year` : 'No active fee structure this year' },
            { key: 'demand', ok: notCharged === 0, blocking: false, label: notCharged ? `${notCharged} structure${notCharged === 1 ? ' has' : 's have'} not charged anyone yet` : 'Every structure has generated its demand' },
            { key: 'pending', ok: pending === 0, blocking: false, label: pending ? `${pending} payment${pending === 1 ? '' : 's'} waiting for approval` : 'No payments waiting for approval' },
            { key: 'gateway', ok: true, blocking: false, label: gatewayOn ? 'Online payment is live' : 'Online payment is off (counter payments only)' },
        ];
        ok(res, {
            settings,
            years: years.map(yearOut),
            defaultYear: yearOut(year),
            status: {
                moduleOn: school?.modules?.fees !== false,
                operational: checks.every(c => c.ok || !c.blocking),
                checkedAt: new Date(),
                checks,
                gateway: { on: gatewayOn, provider: school?.paymentGateway?.provider || 'none' },
            },
            info: {
                version: APP_VERSION, lastUpdated: settings.updatedAt || null, updatedBy: updatedBy?.name || null,
                heads, categories: cats, concessions, fineRules: rules,
                nextReceipt: `${settings.receiptPrefix || 'REC'}-${String((settings.lastReceiptNumber || 0) + 1).padStart(6, '0')}`,
            },
        });
    } catch (e) { fail(res, e); }
};

/** Everything the module is configured with, as one JSON file. No money moves. */
exports.backup = async (req, res) => {
    try {
        const [settings, categories, heads, structures, concessions, rules, years, classes, sections] = await Promise.all([
            FeeSettings.findOne({ school: req.schoolId }).lean(),
            FeeCategory.find({ school: req.schoolId }).lean(),
            FeeHead.find({ school: req.schoolId }).lean(),
            FeeStructure.find({ school: req.schoolId }).lean(),
            FeeConcession.find({ school: req.schoolId }).lean(),
            FineRule.find({ school: req.schoolId }).lean(),
            AcademicYear.find({ school: req.schoolId }).select('yearName').lean(),
            Class.find({ school: req.schoolId }).select('className classNumber').lean(),
            ClassSection.find({ school: req.schoolId }).select('sectionName').lean(),
        ]);
        const yearBy = new Map(years.map(y => [String(y._id), y.yearName]));
        const classBy = new Map(classes.map(c => [String(c._id), classTitle(c.classNumber, c.className)]));
        const secBy = new Map(sections.map(s => [String(s._id), s.sectionName]));
        const onlyWhat = req.query.only === 'settings';
        const payload = onlyWhat ? { exportedAt: new Date(), settings } : {
            exportedAt: new Date(), settings, categories, heads,
            structures: structures.map(s => ({ ...s, yearName: yearBy.get(String(s.academicYear)) || '', className: classBy.get(String(s.class)) || '', sectionName: secBy.get(String(s.section)) || '' })),
            concessions, fineRules: rules,
        };
        logFeeAudit(req, { action: onlyWhat ? 'settings_exported' : 'backup_downloaded', entityType: 'FeeSettings', entityId: settings?._id });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="fees-${onlyWhat ? 'settings' : 'backup'}-${new Date().toISOString().slice(0, 10)}.json"`);
        res.send(JSON.stringify(payload, null, 2));
    } catch (e) { fail(res, e); }
};

const ENTITY_WORDS = { FeeCategory: 'Category', FeeHead: 'Fee head', FeeStructure: 'Structure', FineRule: 'Fine rule',
    FeeConcession: 'Concession', StudentConcession: 'Concession', FeePayment: 'Payment', FeeSettings: 'Settings', FeeLedger: 'Ledger', StudentFeeAssignment: 'Assignment' };

exports.auditLogs = async (req, res) => {
    try {
        const { page, limit, offset } = pageArgs(req.query, 15);
        const filter = { school: req.schoolId };
        if (ENTITY_WORDS[req.query.entityType]) filter.entityType = req.query.entityType;
        const [rows, total] = await Promise.all([
            FeeAuditLog.find(filter).sort({ timestamp: -1 }).skip(offset).limit(limit).populate('user', 'name').lean(),
            FeeAuditLog.countDocuments(filter),
        ]);
        ok(res, rows.map(r => ({
            _id: r._id, at: r.timestamp, by: r.user?.name || 'System', role: r.role || '',
            action: r.actionType, entityType: r.entityType, entity: ENTITY_WORDS[r.entityType] || r.entityType || '—',
            name: r.newValue?.name || r.oldValue?.name || r.newValue?.report || '',
            changed: r.newValue?._changed || [],
        })), { total, page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};

/** Who can run fees: school admins, plus designations granted fees access. */
exports.access = async (req, res) => {
    try {
        const [admins, designations] = await Promise.all([
            User.find({ school: req.schoolId, role: 'school_admin', isActive: { $ne: false } }).select('name email').sort({ name: 1 }).lean(),
            Designation.find({ school: req.schoolId, isActive: { $ne: false } }).select('name permissions').sort({ name: 1 }).lean(),
        ]);
        ok(res, {
            admins: admins.map(a => ({ _id: a._id, name: a.name, email: a.email })),
            designations: designations.map(d => ({ _id: d._id, name: d.name, level: (d.permissions || {}).fees || 'none' })),
        });
    } catch (e) { fail(res, e); }
};
