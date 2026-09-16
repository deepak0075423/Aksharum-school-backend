'use strict';
/**
 * Admin → Attendance.
 *
 * The screen reads student attendance across the whole school — four headline
 * figures against last month, today's register for every student, a feed of
 * what just happened, and a reports tab over any window — and lets the office
 * take or correct a register for any section.
 *
 * Everything is counted in Postgres. A session belongs to a section, a record
 * to a session, and a student to a section through two pointers that can drift
 * (see utils/sectionMembership.js); walking that through the ORM would pull
 * every record the school has kept into the process to add them up.
 *
 * Dates: a session is stored at UTC midnight of the LOCAL calendar day it
 * belongs to. Every window here is built from local 'YYYY-MM-DD' keys and
 * compared as UTC midnights — taking the UTC date of "now" would lose today's
 * registers between 00:00 and 05:30 IST.
 */
const pool             = require('../db/pool');
const { isUuid }       = require('../db/schema');
const Attendance       = require('../models/Attendance');
const AttendanceRecord = require('../models/AttendanceRecord');
const AttendanceCorrection = require('../models/AttendanceCorrection');
const AcademicYear     = require('../models/AcademicYear');
const ClassSection     = require('../models/ClassSection');
const Class            = require('../models/Class');
const Holiday          = require('../models/Holiday');
const StudentProfile   = require('../models/StudentProfile');
const TeacherAttendance = require('../models/TeacherAttendance');
const TeacherAttendanceRegularization = require('../models/TeacherAttendanceRegularization');
const TeacherProfile   = require('../models/TeacherProfile');
const User             = require('../models/User');
const { resolvePage }  = require('../utils/focusPage');
const days             = require('../services/staffAttendanceDays');
const { saveSectionMarks, capStatus } = require('../services/attendanceMarks');

const ok  = (res, d, s = 200) => res.status(s).json({ success: true, data: d });
const err = (res, e, s = 500) => res.status(s).json({ success: false, message: e.message || e });

const T = (Model) => `"${Model.tableName}"`;
const { localToday, keyDate, dateKey, addDays } = days;

const isKey = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const uuidOr = (v) => (isUuid(String(v || '')) ? String(v) : null);
const low = (s) => (s == null ? null : String(s).toLowerCase());

/** A fresh positional-parameter list: `$(value)` pushes and returns "$n". */
function params() {
    const list = [];
    const $ = (v) => { list.push(v); return `$${list.length}`; };
    return { list, $ };
}

// ── Academic years ───────────────────────────────────────────────────────────

const schoolYears = (schoolId) => AcademicYear.find({ school: schoolId })
    .select('yearName startDate endDate status').sort({ startDate: -1 }).lean();

/**
 * The year a question is about: the one asked for by id; otherwise the one that
 * holds `day` (the running year first, since two rows can overlap); otherwise
 * the running year; otherwise the newest.
 */
function pickYear(years, { id, day } = {}) {
    if (id) {
        const hit = years.find((y) => String(y._id) === String(id));
        if (hit) return hit;
    }
    if (day) {
        const holding = years.filter((y) => dateKey(y.startDate) <= day && day <= dateKey(y.endDate));
        const hit = holding.find((y) => y.status === 'active') || holding[0];
        if (hit) return hit;
    }
    return years.find((y) => y.status === 'active') || years[0] || null;
}

const yearOut = (y) => (y ? {
    _id: y._id, yearName: y.yearName, status: y.status,
    startDate: dateKey(y.startDate), endDate: dateKey(y.endDate),
} : null);

/** A year's classes with their active sections — the filter dropdowns. */
async function classOptions(schoolId, yearId) {
    if (!yearId) return [];
    const { rows } = await pool.query(
        `SELECT c."_id", c."className", c."classNumber", cs."_id" AS "sectionId", cs."sectionName"
           FROM ${T(Class)} c
           LEFT JOIN ${T(ClassSection)} cs ON cs."class" = c."_id" AND cs."status" = 'active'
          WHERE c."school" = $1 AND c."academicYear" = $2 AND c."status" IS DISTINCT FROM 'archived'
          ORDER BY c."classNumber", cs."sectionName"`,
        [String(schoolId), String(yearId)],
    );
    const byClass = new Map();
    for (const r of rows) {
        if (!byClass.has(r._id)) byClass.set(r._id, { _id: r._id, className: r.className, classNumber: r.classNumber, sections: [] });
        if (r.sectionId) byClass.get(r._id).sections.push({ _id: r.sectionId, sectionName: r.sectionName });
    }
    return [...byClass.values()];
}

// ── The roster ───────────────────────────────────────────────────────────────

/**
 * CTEs `secs` (the sections in scope, with their class) and `roster` (one row
 * per active student in them, with the ONE section they count under).
 *
 * A student's section is read from both places it is recorded — the profile
 * pointer and the section's enrolledStudents — and the profile wins where they
 * disagree. Reading only one would lose students the other still holds: past
 * years exist only in the rosters, and a freshly admitted student may exist
 * only in the profile.
 */
function scopeCtes($, { schoolId, yearId, classId, sectionId }) {
    const school = $(String(schoolId));
    const filters = [
        `cs."school" = ${school}`,
        `cs."status" = 'active'`,
        yearId    ? `cs."academicYear" = ${$(String(yearId))}` : null,
        classId   ? `cs."class" = ${$(classId)}`             : null,
        sectionId ? `cs."_id" = ${$(sectionId)}`             : null,
    ].filter(Boolean).join(' AND ');

    return `
    secs AS (
        SELECT cs."_id", cs."sectionName", c."_id" AS "classId", c."className", c."classNumber"
          FROM ${T(ClassSection)} cs
          JOIN ${T(Class)} c ON c."_id" = cs."class"
         WHERE ${filters}
    ),
    members AS (
        SELECT sp."user" AS "student", sp."currentSection" AS "section", 0 AS "pref"
          FROM ${T(StudentProfile)} sp
          JOIN secs ON secs."_id" = sp."currentSection"
        UNION ALL
        SELECT CASE WHEN e.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN e.id::uuid END,
               cs."_id", 1
          FROM ${T(ClassSection)} cs
          JOIN secs ON secs."_id" = cs."_id"
         CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(cs."enrolledStudents") = 'array'
                    THEN cs."enrolledStudents" ELSE '[]'::jsonb END) AS e(id)
    ),
    roster AS (
        SELECT DISTINCT ON (m."student") m."student", m."section"
          FROM members m
          JOIN ${T(User)} u ON u."_id" = m."student"
               AND u."role" = 'student' AND u."school" = ${school} AND u."isActive" IS NOT FALSE
         WHERE m."student" IS NOT NULL
         ORDER BY m."student", m."pref"
    )`;
}

/**
 * Students in scope with their mark for one day. `status` narrows to
 * present | absent | late | unmarked; without `limit` every row comes back.
 */
async function studentDay({ schoolId, yearId, classId, sectionId, day, search, status, page = 1, limit = null }) {
    const p = params();
    const ctes = scopeCtes(p.$, { schoolId, yearId, classId, sectionId });
    const from = p.$(keyDate(day));
    const to   = p.$(keyDate(addDays(day, 1)));
    const q = String(search || '').trim();
    const like = q ? p.$(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`) : null;

    const base = `
    WITH ${ctes},
    day AS (
        SELECT u."_id", u."name", u."profileImage" AS "photo", sp."rollNumber",
               secs."className", secs."classNumber", secs."sectionName", roster."section",
               r."status", COALESCE(r."markedAt", CASE WHEN r."_id" IS NOT NULL THEN a."createdAt" END) AS "markedAt",
               mb."name" AS "markedBy", r."remarks"
          FROM roster
          JOIN ${T(User)} u ON u."_id" = roster."student"
          JOIN secs ON secs."_id" = roster."section"
          LEFT JOIN ${T(StudentProfile)} sp ON sp."user" = roster."student" AND sp."school" = $1
          LEFT JOIN ${T(Attendance)} a ON a."section" = roster."section" AND a."date" >= ${from} AND a."date" < ${to}
          LEFT JOIN ${T(AttendanceRecord)} r ON r."attendance" = a."_id" AND r."student" = roster."student"
          LEFT JOIN ${T(User)} mb ON mb."_id" = COALESCE(r."markedBy", CASE WHEN r."_id" IS NOT NULL THEN a."createdBy" END)
         ${like ? `WHERE (u."name" ILIKE ${like} OR sp."rollNumber" ILIKE ${like})` : ''}
    )`;

    const STATUS_SQL = {
        present:  `"status" = 'Present'`,
        absent:   `"status" = 'Absent'`,
        late:     `"status" = 'Late'`,
        unmarked: `"status" IS NULL`,
    };
    const where = STATUS_SQL[status] ? `WHERE ${STATUS_SQL[status]}` : '';

    const countSql = `${base}
        SELECT count(*)::int AS "total",
               count(*) FILTER (WHERE "status" = 'Present')::int AS "present",
               count(*) FILTER (WHERE "status" = 'Absent')::int  AS "absent",
               count(*) FILTER (WHERE "status" = 'Late')::int    AS "late",
               count(*) FILTER (WHERE "status" IS NULL)::int     AS "unmarked"
          FROM day`;

    const rowParams = [...p.list];
    let paging = '';
    if (limit) {
        rowParams.push(limit, (Math.max(1, page) - 1) * limit);
        paging = `LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`;
    }
    const rowSql = `${base}
        SELECT *, count(*) OVER ()::int AS "matched"
          FROM day ${where}
         ORDER BY "classNumber", "sectionName",
                  NULLIF(regexp_replace(COALESCE("rollNumber", ''), '\\D', '', 'g'), '')::numeric NULLS LAST,
                  "name"
         ${paging}`;

    const [counts, rows] = await Promise.all([
        pool.query(countSql, p.list),
        pool.query(rowSql, rowParams),
    ]);
    return {
        counts:  counts.rows[0],
        matched: rows.rows[0]?.matched || 0,
        rows:    rows.rows.map(({ matched, ...r }) => ({ ...r, status: low(r.status) })),
    };
}

// ── Comparisons ──────────────────────────────────────────────────────────────

/** Percent change of a count; null when there is nothing to compare against. */
function change(cur, prev) {
    if (prev > 0) return Math.round(((cur - prev) / prev) * 100);
    return cur > 0 ? null : 0;
}

const pctOf = (attended, total) => (total ? Math.round((attended / total) * 100) : null);

/** [first of the anchor's month, anchor] and the same days of the month before. */
function monthWindows(anchor) {
    const [y, m, d] = anchor.split('-').map(Number);
    const pad = (n) => String(n).padStart(2, '0');
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    const prevLast = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    return {
        cur:  { from: `${y}-${pad(m)}-01`,  to: anchor },
        prev: { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(Math.min(d, prevLast))}` },
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /admin/attendance/overview?academicYear=&class=
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The four figures the page leads with, each against the same days of last
 * month — the 1st to the 16th against the 1st to the 16th, because a
 * half-finished month against a whole one reads as a collapse.
 *
 * For a year that has ended, "this month" is its final month; for one not yet
 * begun there is nothing to count and every figure is zero.
 */
exports.overview = async (req, res) => {
    try {
        const schoolId = req.schoolId;
        const today    = localToday();
        const years    = await schoolYears(schoolId);
        const year     = pickYear(years, { id: uuidOr(req.query.academicYear), day: today });
        const classId  = uuidOr(req.query.class);

        let anchor = today;
        if (year) {
            const start = dateKey(year.startDate);
            const end   = dateKey(year.endDate);
            if (today > end) anchor = end;
            else if (today < start) anchor = start;
        }
        const { cur, prev } = monthWindows(anchor);

        // Students in scope now, and how many of them already existed on the 1st.
        const r = params();
        const rosterSql = `WITH ${scopeCtes(r.$, { schoolId, yearId: year?._id, classId })}
            SELECT count(*)::int AS "total",
                   count(*) FILTER (WHERE u."createdAt" < ${r.$(keyDate(cur.from))})::int AS "before"
              FROM roster JOIN ${T(User)} u ON u."_id" = roster."student"`;

        const m = params();
        const ctes = scopeCtes(m.$, { schoolId, yearId: year?._id, classId });
        const cf = m.$(keyDate(cur.from)),  ct = m.$(keyDate(addDays(cur.to, 1)));
        const pf = m.$(keyDate(prev.from)), pt = m.$(keyDate(addDays(prev.to, 1)));
        const marksSql = `WITH ${ctes}
            SELECT
              count(*) FILTER (WHERE a."date" >= ${cf} AND a."date" < ${ct})::int AS "curTotal",
              count(*) FILTER (WHERE a."date" >= ${cf} AND a."date" < ${ct} AND r."status" IN ('Present','Late'))::int AS "curAttended",
              count(DISTINCT r."student") FILTER (WHERE a."date" >= ${cf} AND a."date" < ${ct} AND r."status" = 'Absent')::int AS "curAbsentees",
              count(*) FILTER (WHERE a."date" >= ${pf} AND a."date" < ${pt})::int AS "prevTotal",
              count(*) FILTER (WHERE a."date" >= ${pf} AND a."date" < ${pt} AND r."status" IN ('Present','Late'))::int AS "prevAttended",
              count(DISTINCT r."student") FILTER (WHERE a."date" >= ${pf} AND a."date" < ${pt} AND r."status" = 'Absent')::int AS "prevAbsentees"
              FROM ${T(AttendanceRecord)} r
              JOIN ${T(Attendance)} a ON a."_id" = r."attendance"
              JOIN secs ON secs."_id" = a."section"
             WHERE a."date" >= ${pf} AND a."date" < ${ct}`;

        // The queue as it stands, and as it stood a month ago: raised by then
        // and not yet decided by then.
        const monthAgo = new Date();
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        const pendingSql = `
            SELECT count(*) FILTER (WHERE "status" = 'Pending')::int AS "now",
                   count(*) FILTER (WHERE "createdAt" <= $2
                                    AND ("status" = 'Pending' OR "reviewedAt" > $2))::int AS "before"
              FROM ${T(TeacherAttendanceRegularization)} WHERE "school" = $1`;

        const [roster, marks, pending, classes] = await Promise.all([
            pool.query(rosterSql, r.list),
            pool.query(marksSql, m.list),
            pool.query(pendingSql, [String(schoolId), monthAgo]),
            classOptions(schoolId, year?._id),
        ]);
        const R = roster.rows[0], M = marks.rows[0], Q = pending.rows[0];
        const avgNow  = pctOf(M.curAttended, M.curTotal);
        const avgPrev = pctOf(M.prevAttended, M.prevTotal);

        ok(res, {
            years:   years.map(yearOut),
            year:    yearOut(year),
            classes,
            window:  { ...cur, previous: prev },
            tiles: {
                students:  { value: R.total, previous: R.before, change: change(R.total, R.before) },
                average:   {
                    value: avgNow, previous: avgPrev,
                    // A rate moves in points, not percent of itself.
                    change: avgNow != null && avgPrev != null ? avgNow - avgPrev : null,
                    marks: M.curTotal,
                },
                absentees: { value: M.curAbsentees, previous: M.prevAbsentees, change: change(M.curAbsentees, M.prevAbsentees) },
                pending:   { value: Q.now, previous: Q.before, change: change(Q.now, Q.before) },
            },
        });
    } catch (e) { err(res, e); }
};

// ═══════════════════════════════════════════════════════════════════════════
//  GET /admin/attendance/today?date=&class=&section=&search=&status=&page=&limit=
// ═══════════════════════════════════════════════════════════════════════════

exports.today = async (req, res) => {
    try {
        const schoolId = req.schoolId;
        const today = localToday();
        const day   = isKey(req.query.date) && req.query.date <= today ? req.query.date : today;
        const years = await schoolYears(schoolId);
        const year  = pickYear(years, { day });
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
        const page  = Math.max(1, Number(req.query.page) || 1);

        const [result, classes] = await Promise.all([
            studentDay({
                schoolId, yearId: year?._id, day,
                classId:   uuidOr(req.query.class),
                sectionId: uuidOr(req.query.section),
                search:    req.query.search,
                status:    req.query.status,
                page, limit,
            }),
            classOptions(schoolId, year?._id),
        ]);

        res.json({
            success: true,
            data:    result.rows,
            total:   result.matched,
            page, limit,
            pages:   Math.max(1, Math.ceil(result.matched / limit)),
            counts:  result.counts,
            classes,
            date:    day,
            year:    yearOut(year),
        });
    } catch (e) { err(res, e); }
};

// ═══════════════════════════════════════════════════════════════════════════
//  POST /admin/attendance/mark      { date, records: [{ studentId, section?, status }] }
//  POST /admin/attendance/mark-all  { date, status, class?, section?, search? }
// ═══════════════════════════════════════════════════════════════════════════

/** Refuse a day that has not happened yet; answer with the key otherwise. */
function markableDay(date) {
    if (!isKey(date)) return { error: 'date must be YYYY-MM-DD' };
    if (date > localToday()) return { error: 'Attendance cannot be marked for a future date' };
    return { day: date };
}

/** Group resolved marks by section and write each register. */
async function writeMarks(req, day, marks) {
    const bySection = new Map();
    for (const mk of marks) {
        if (!bySection.has(mk.section)) bySection.set(mk.section, []);
        bySection.get(mk.section).push({ studentId: mk.studentId, status: mk.status });
    }
    let changed = 0, saved = 0;
    for (const [sectionId, records] of bySection) {
        const out = await saveSectionMarks({
            schoolId: req.schoolId, sectionId, date: day, records,
            actor: { userId: req.userId, role: req.userRole },
        });
        changed += out.changed.length;
        saved   += out.records.length;
    }
    return { saved, changed, sections: bySection.size };
}

exports.mark = async (req, res) => {
    try {
        const { day, error } = markableDay(req.body.date);
        if (error) return err(res, error, 400);
        const input = Array.isArray(req.body.records) ? req.body.records : [];
        if (!input.length) return err(res, 'records are required', 400);
        if (input.length > 5000) return err(res, 'Too many records in one request', 400);

        const studentIds = [...new Set(input.map((r) => uuidOr(r.studentId)).filter(Boolean))];
        const profiles = await StudentProfile.find({ user: { $in: studentIds }, school: req.schoolId })
            .select('user currentSection').lean();
        const profileOf = new Map(profiles.map((p) => [String(p.user), p]));
        // The sections named in the request plus each student's own — membership
        // is then checked against both of the places it is recorded.
        const sectionIds = [...new Set([
            ...input.map((r) => uuidOr(r.section)),
            ...profiles.map((p) => (p.currentSection ? String(p.currentSection) : null)),
        ].filter(Boolean))];
        const sections = sectionIds.length
            ? await ClassSection.find({ _id: { $in: sectionIds }, school: req.schoolId }).select('_id enrolledStudents').lean()
            : [];
        const sectionOf = new Map(sections.map((s) => [String(s._id), s]));

        // Each mark must name a real student of this school, in a section of this
        // school that actually holds them. A mark that fails is reported back,
        // never silently written somewhere else.
        const marks = [], refused = [];
        for (const r of input) {
            const studentId = uuidOr(r.studentId);
            const status    = capStatus(r.status);
            const profile   = studentId && profileOf.get(studentId);
            const wanted    = uuidOr(r.section) || (profile?.currentSection ? String(profile.currentSection) : null);
            const section   = wanted && sectionOf.get(wanted);
            const holds     = section && (
                String(profile?.currentSection || '') === wanted
                || (section.enrolledStudents || []).map(String).includes(studentId));
            if (!status)  refused.push({ studentId: r.studentId, reason: 'status must be present, absent or late' });
            else if (!profile || !holds) refused.push({ studentId: r.studentId, reason: 'Student is not in that section' });
            else marks.push({ studentId, section: wanted, status });
        }
        if (!marks.length) return err(res, refused[0]?.reason || 'Nothing to mark', 400);

        const out = await writeMarks(req, day, marks);
        ok(res, { ...out, refused, date: day });
    } catch (e) { err(res, e); }
};

/**
 * Everyone in the filter who has no mark for the day gets `status`. Already
 * marked students are left exactly as they are — "mark all present" on a
 * half-taken register must not overwrite the absences a teacher recorded.
 */
exports.markAll = async (req, res) => {
    try {
        const { day, error } = markableDay(req.body.date);
        if (error) return err(res, error, 400);
        const status = capStatus(req.body.status);
        if (!status) return err(res, 'status must be present, absent or late', 400);

        const years = await schoolYears(req.schoolId);
        const year  = pickYear(years, { day });
        const { rows } = await studentDay({
            schoolId: req.schoolId, yearId: year?._id, day,
            classId:   uuidOr(req.body.class),
            sectionId: uuidOr(req.body.section),
            search:    req.body.search,
            status:    'unmarked',
        });
        if (!rows.length) return ok(res, { saved: 0, changed: 0, sections: 0, date: day });

        const out = await writeMarks(req, day, rows.map((s) => ({ studentId: s._id, section: s.section, status })));
        ok(res, { ...out, date: day });
    } catch (e) { err(res, e); }
};

// ═══════════════════════════════════════════════════════════════════════════
//  GET /admin/attendance/register?section=&date=
// ═══════════════════════════════════════════════════════════════════════════

/** One section's register for one day — the Mark Attendance dialog. */
exports.register = async (req, res) => {
    try {
        const sectionId = uuidOr(req.query.section);
        const { day, error } = markableDay(req.query.date || localToday());
        if (error) return err(res, error, 400);
        if (!sectionId) return err(res, 'section is required', 400);

        const section = await ClassSection.findOne({ _id: sectionId, school: req.schoolId })
            .select('_id sectionName class academicYear classTeacher').lean();
        if (!section) return err(res, 'Section not found', 404);

        const [klass, teacher, session, result, holidays] = await Promise.all([
            Class.findById(section.class).select('className').lean(),
            section.classTeacher ? User.findById(section.classTeacher).select('name').lean() : null,
            Attendance.findOne({ section: sectionId, date: { $gte: keyDate(day), $lt: keyDate(addDays(day, 1)) } }).lean(),
            studentDay({ schoolId: req.schoolId, yearId: section.academicYear, sectionId, day }),
            Holiday.find({ school: req.schoolId, startDate: { $lte: new Date(`${day}T23:59:59.999Z`) }, endDate: { $gte: keyDate(day) } })
                .select('name applicability').lean().catch(() => []),
        ]);

        // A holiday applies to this class when it is school-wide, or names a class
        // of the same name. Holidays name class rows, and "Class 8" is a new row
        // every academic year — matching the id would miss last year's entries.
        let holiday = null;
        for (const h of holidays) {
            const scope = h.applicability?.scope || 'all';
            if (scope === 'all') { holiday = h.name; break; }
            if (scope === 'specific_classes' && (h.applicability.classes || []).length) {
                const names = await Class.find({ _id: { $in: h.applicability.classes } }).select('className').lean();
                if (names.some((n) => n.className === klass?.className)) { holiday = h.name; break; }
            }
        }
        const author = session?.createdBy ? await User.findById(session.createdBy).select('name').lean() : null;

        ok(res, {
            date: day,
            section: {
                _id: section._id, sectionName: section.sectionName,
                className: klass?.className || '', classTeacher: teacher?.name || '',
            },
            session: session ? { _id: session._id, createdAt: session.createdAt, createdBy: author?.name || '' } : null,
            students: result.rows,
            counts:   result.counts,
            holiday,
            sunday:   keyDate(day).getUTCDay() === 0,
        });
    } catch (e) { err(res, e); }
};

// ═══════════════════════════════════════════════════════════════════════════
//  GET /admin/attendance/activity?limit=
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What just happened, newest first, from five sources:
 *   marked    — a register was taken
 *   updated   — marks changed well after the register was first taken
 *   request / reviewed — staff regularization raised, or decided
 *   streak    — a student absent on each of their last 3+ marked days
 *   staffFix  — the office corrected a staff member's punches directly
 *
 * Each source is limited on its own and merged here; every query is bounded to
 * recent dates so the feed costs the same in a school's tenth year as its first.
 */
exports.activity = async (req, res) => {
    try {
        const school = String(req.schoolId);
        const limit  = Math.min(50, Math.max(1, Number(req.query.limit) || 6));
        const today  = localToday();
        const since30 = keyDate(addDays(today, -30));
        const since60 = keyDate(addDays(today, -60));
        const recent  = keyDate(addDays(today, -7));

        const [marked, updated, requests, streaks, fixes] = await Promise.all([
            pool.query(
                `WITH recent AS (
                    SELECT a.* FROM ${T(Attendance)} a
                      JOIN ${T(ClassSection)} cs ON cs."_id" = a."section"
                     WHERE cs."school" = $1 AND a."date" >= $3
                     ORDER BY a."createdAt" DESC LIMIT $2
                 )
                 SELECT a."_id", a."section", a."date", a."createdAt" AS "at", cs."sectionName", c."className", u."name" AS "by",
                        count(r."_id")::int AS "count",
                        count(r."_id") FILTER (WHERE r."status" = 'Absent')::int AS "absent"
                   FROM recent a
                   JOIN ${T(ClassSection)} cs ON cs."_id" = a."section"
                   JOIN ${T(Class)} c ON c."_id" = cs."class"
                   LEFT JOIN ${T(User)} u ON u."_id" = a."createdBy"
                   JOIN ${T(AttendanceRecord)} r ON r."attendance" = a."_id"
                  GROUP BY a."_id", a."section", a."date", a."createdAt", cs."sectionName", c."className", u."name"`,
                [school, limit * 2, since30],
            ),
            pool.query(
                `SELECT a."_id" AS "session", a."section", a."date", cs."sectionName", c."className", mb."name" AS "by",
                        date_trunc('minute', r."markedAt") AS "at", count(*)::int AS "count"
                   FROM ${T(AttendanceRecord)} r
                   JOIN ${T(Attendance)} a ON a."_id" = r."attendance"
                   JOIN ${T(ClassSection)} cs ON cs."_id" = a."section"
                   JOIN ${T(Class)} c ON c."_id" = cs."class"
                   LEFT JOIN ${T(User)} mb ON mb."_id" = r."markedBy"
                  WHERE cs."school" = $1 AND a."date" >= $3
                    AND r."markedAt" > a."createdAt" + interval '10 minutes'
                  GROUP BY a."_id", a."section", a."date", cs."sectionName", c."className", mb."name", date_trunc('minute', r."markedAt")
                  ORDER BY "at" DESC LIMIT $2`,
                [school, limit, since30],
            ),
            pool.query(
                `SELECT g."_id", g."date", g."createdAt", g."status", g."reviewedAt", u."name", u."role", rv."name" AS "reviewer"
                   FROM ${T(TeacherAttendanceRegularization)} g
                   JOIN ${T(User)} u ON u."_id" = g."teacher"
                   LEFT JOIN ${T(User)} rv ON rv."_id" = g."reviewedBy"
                  WHERE g."school" = $1
                  ORDER BY GREATEST(g."createdAt", COALESCE(g."reviewedAt", g."createdAt")) DESC
                  LIMIT $2`,
                [school, limit],
            ),
            pool.query(
                `WITH recs AS (
                    SELECT r."student", r."status", a."date",
                           COALESCE(r."markedAt", a."createdAt") AS "at", cs."sectionName", c."className",
                           row_number() OVER (PARTITION BY r."student" ORDER BY a."date" DESC) AS "rn"
                      FROM ${T(AttendanceRecord)} r
                      JOIN ${T(Attendance)} a ON a."_id" = r."attendance"
                      JOIN ${T(ClassSection)} cs ON cs."_id" = a."section"
                      JOIN ${T(Class)} c ON c."_id" = cs."class"
                     WHERE cs."school" = $1 AND a."date" >= $3
                 ),
                 runs AS (
                    SELECT "student",
                           COALESCE(min("rn") FILTER (WHERE "status" <> 'Absent'), max("rn") + 1) - 1 AS "streak"
                      FROM recs GROUP BY "student"
                 )
                 SELECT s."student" AS "_id", s."streak"::int, u."name", l."className", l."sectionName", l."date", l."at"
                   FROM runs s
                   JOIN recs l ON l."student" = s."student" AND l."rn" = 1
                   JOIN ${T(User)} u ON u."_id" = s."student" AND u."isActive" IS NOT FALSE
                  WHERE s."streak" >= 3 AND l."date" >= $4
                  ORDER BY l."at" DESC LIMIT $2`,
                [school, limit, since60, recent],
            ),
            pool.query(
                `SELECT t."_id", t."date", t."updatedAt" AS "at", u."name", u."role", mb."name" AS "by"
                   FROM ${T(TeacherAttendance)} t
                   JOIN ${T(User)} u ON u."_id" = t."teacher"
                   LEFT JOIN ${T(User)} mb ON mb."_id" = t."markedBy"
                  WHERE t."school" = $1 AND t."remarks" LIKE 'Regularized by admin%'
                  ORDER BY t."updatedAt" DESC LIMIT $2`,
                [school, limit],
            ),
        ]);

        const items = [];
        for (const s of marked.rows) {
            items.push({ id: `m-${s._id}`, kind: 'marked', at: s.at, date: dateKey(s.date), section: s.section,
                className: s.className, sectionName: s.sectionName, count: s.count, absent: s.absent, by: s.by });
        }
        for (const u of updated.rows) {
            items.push({ id: `u-${u.session}-${new Date(u.at).getTime()}`, kind: 'updated', at: u.at, date: dateKey(u.date), section: u.section,
                className: u.className, sectionName: u.sectionName, count: u.count, by: u.by });
        }
        for (const g of requests.rows) {
            items.push({ id: `q-${g._id}`, kind: 'request', at: g.createdAt, date: dateKey(g.date),
                name: g.name, role: g.role, requestId: g._id });
            if (g.reviewedAt && g.status !== 'Pending') {
                items.push({ id: `v-${g._id}`, kind: 'reviewed', at: g.reviewedAt, date: dateKey(g.date),
                    name: g.name, role: g.role, status: low(g.status), by: g.reviewer, requestId: g._id });
            }
        }
        for (const s of streaks.rows) {
            items.push({ id: `s-${s._id}`, kind: 'streak', at: s.at, date: dateKey(s.date),
                name: s.name, studentId: s._id, className: s.className, sectionName: s.sectionName, count: s.streak });
        }
        for (const f of fixes.rows) {
            items.push({ id: `f-${f._id}`, kind: 'staffFix', at: f.at, date: dateKey(f.date), name: f.name, role: f.role, by: f.by });
        }

        items.sort((a, b) => new Date(b.at) - new Date(a.at));
        ok(res, items.slice(0, limit));
    } catch (e) { err(res, e); }
};

// ═══════════════════════════════════════════════════════════════════════════
//  GET /admin/attendance/reports?view=students|staff&from=&to=&class=&section=&academicYear=
// ═══════════════════════════════════════════════════════════════════════════

const LOW_ATTENDANCE = 75;

/** Bucket size for a window: daily bars stop being readable past ~6 weeks. */
const bucketFor = (span) => (span <= 45 ? 'day' : span <= 190 ? 'week' : 'month');

exports.reports = async (req, res) => {
    try {
        const schoolId = req.schoolId;
        const today = localToday();
        let from = isKey(req.query.from) ? req.query.from : `${today.slice(0, 8)}01`;
        let to   = isKey(req.query.to)   ? req.query.to   : today;
        if (from > to) [from, to] = [to, from];
        if (addDays(from, 365) < to) return err(res, 'A report can cover at most one year', 400);
        // Days that have not happened hold no attendance; a window ending in the
        // future is read to today so its averages are not diluted by them.
        const until = to > today ? today : to;
        const span  = Math.round((keyDate(to) - keyDate(from)) / 86400000) + 1;

        const years = await schoolYears(schoolId);
        const year  = pickYear(years, { id: uuidOr(req.query.academicYear), day: until < from ? from : until });
        const window = { from, to, until, days: span };

        if (req.query.view === 'staff') {
            return ok(res, { view: 'staff', window, year: yearOut(year), ...(await staffReport(schoolId, from, until)) });
        }

        const scope = { schoolId, yearId: year?._id, classId: uuidOr(req.query.class), sectionId: uuidOr(req.query.section) };
        const bucket = bucketFor(span);

        const p = params();
        const ctes = scopeCtes(p.$, scope);
        const f = p.$(keyDate(from));
        const t = p.$(keyDate(addDays(until < from ? from : until, 1)));
        const withMarks = `WITH ${ctes},
            marks AS (
                SELECT r."student", r."status", a."date", a."section"
                  FROM ${T(AttendanceRecord)} r
                  JOIN ${T(Attendance)} a ON a."_id" = r."attendance"
                  JOIN secs ON secs."_id" = a."section"
                 WHERE a."date" >= ${f} AND a."date" < ${t}
            )`;
        const tally = `
            count(m."status")::int AS "total",
            count(m."status") FILTER (WHERE m."status" = 'Present')::int AS "present",
            count(m."status") FILTER (WHERE m."status" = 'Late')::int    AS "late",
            count(m."status") FILTER (WHERE m."status" = 'Absent')::int  AS "absent"`;

        const [trend, sections, students, totals] = await Promise.all([
            pool.query(`${withMarks}
                SELECT to_char(date_trunc('${bucket}', m."date" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "key", ${tally}
                  FROM marks m GROUP BY 1`, p.list),
            pool.query(`${withMarks}
                SELECT s."_id", s."className", s."classNumber", s."sectionName",
                       (SELECT count(*) FROM roster WHERE roster."section" = s."_id")::int AS "students",
                       count(DISTINCT m."date")::int AS "days", max(m."date") AS "lastMarked", ${tally}
                  FROM secs s LEFT JOIN marks m ON m."section" = s."_id"
                 GROUP BY s."_id", s."className", s."classNumber", s."sectionName"
                 ORDER BY s."classNumber", s."sectionName"`, p.list),
            pool.query(`${withMarks}
                SELECT u."_id", u."name", u."profileImage" AS "photo", sp."rollNumber",
                       s."className", s."sectionName", ${tally}
                  FROM roster
                  JOIN ${T(User)} u ON u."_id" = roster."student"
                  JOIN secs s ON s."_id" = roster."section"
                  LEFT JOIN ${T(StudentProfile)} sp ON sp."user" = roster."student" AND sp."school" = $1
                  LEFT JOIN marks m ON m."student" = roster."student"
                 GROUP BY u."_id", u."name", u."profileImage", sp."rollNumber", s."className", s."sectionName"`, p.list),
            pool.query(`${withMarks}
                SELECT ${tally}, count(DISTINCT m."date")::int AS "days",
                       count(DISTINCT (m."section", m."date"))::int AS "registers",
                       (SELECT count(*) FROM roster)::int AS "students"
                  FROM marks m`, p.list),
        ]);

        const withPct = (row) => ({ ...row, percentage: pctOf(row.present + row.late, row.total) });

        // Every bucket in the window, marked or not: an unmarked day is a gap in
        // the chart, never a bar at zero.
        const byKey = new Map(trend.rows.map((r) => [r.key, r]));
        const series = [];
        const startOf = (key) => {
            const d = keyDate(key);
            if (bucket === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
            if (bucket === 'month') d.setUTCDate(1);
            return dateKey(d);
        };
        for (let k = startOf(from), guard = 0; k <= to && guard < 400; guard++) {
            const hit = byKey.get(k);
            series.push(hit ? { ...withPct(hit), key: k, marked: true } : { key: k, total: 0, present: 0, late: 0, absent: 0, percentage: null, marked: false });
            if (bucket === 'day') k = addDays(k, 1);
            else if (bucket === 'week') k = addDays(k, 7);
            else { const d = keyDate(k); d.setUTCMonth(d.getUTCMonth() + 1); k = dateKey(d); }
        }

        const studentRows = students.rows.map(withPct);
        const below = studentRows
            .filter((s) => s.total > 0 && s.percentage < LOW_ATTENDANCE)
            .sort((a, b) => a.percentage - b.percentage || b.absent - a.absent || a.name.localeCompare(b.name));

        ok(res, {
            view: 'students',
            window, bucket, threshold: LOW_ATTENDANCE,
            year: yearOut(year),
            classes: await classOptions(schoolId, year?._id),
            totals: {
                ...withPct(totals.rows[0]),
                studentsMarked: studentRows.filter((s) => s.total > 0).length,
                below: below.length,
            },
            trend: series,
            sections: sections.rows.map((s) => ({ ...withPct(s), lastMarked: s.lastMarked ? dateKey(s.lastMarked) : null })),
            students: below.slice(0, 200),
        });
    } catch (e) { err(res, e); }
};

/**
 * Every active teacher's derived days over [from, until], summed.
 *
 * Teachers only: self attendance belongs to the teacher role, and a school_admin
 * post never clocks in, so every working day of one would classify as absent. A
 * person who is also a teacher is counted once, through their teacher post.
 */
async function staffReport(schoolId, from, until) {
    const { rows: staff } = await pool.query(
        `SELECT u."_id", u."name", u."role", u."profileImage" AS "photo",
                tp."designation", tp."department", tp."employeeId"
           FROM ${T(User)} u
           LEFT JOIN ${T(TeacherProfile)} tp ON tp."user" = u."_id"
          WHERE u."school" = $1 AND u."role" = 'teacher' AND u."isActive" IS NOT FALSE
          ORDER BY u."name"`,
        [String(schoolId)],
    );
    if (from > until || !staff.length) {
        return { staff: [], totals: { staff: staff.length, present: 0, absent: 0, leave: 0, halfDay: 0, working: 0, percentage: null } };
    }

    const [inputs, since] = await Promise.all([
        days.loadInputs(schoolId, staff.map((s) => s._id), from, until),
        days.startDates(schoolId, staff.map((s) => s._id)),
    ]);
    const totals = { staff: staff.length, present: 0, absent: 0, leave: 0, halfDay: 0, holiday: 0 };
    const rows = staff.map((s) => {
        const { summary } = days.classify(inputs, { userId: s._id, role: s.role, since: since.get(String(s._id)) }, from, until);
        const working = summary.present + summary.absent + summary.leave + summary['half-day'];
        totals.present += summary.present;
        totals.absent  += summary.absent;
        totals.leave   += summary.leave;
        totals.halfDay += summary['half-day'];
        return {
            ...s,
            present: summary.present, absent: summary.absent, leave: summary.leave,
            halfDay: summary['half-day'], holiday: summary.holiday, working,
            percentage: days.percentOf(summary),
        };
    });
    totals.working    = totals.present + totals.absent + totals.leave + totals.halfDay;
    totals.percentage = days.percentOf({ present: totals.present, absent: totals.absent, 'half-day': totals.halfDay });
    return { staff: rows, totals };
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /admin/regularization-requests?status=&search=&from=&to=&page=&limit=&focus=
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The staff regularization queue. Same contract as before — `data` is the page,
 * `total` the matched count — plus the status counts for the filter, the page
 * a notification's `focus` id sits on, and for each request what that day
 * currently holds, so the approver sees the correction next to what it corrects.
 */
exports.requests = async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
        const filter = { school: req.schoolId };
        const status = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' }[low(req.query.status)];
        if (status) filter.status = status;

        const dateRange = {};
        if (isKey(req.query.from)) dateRange.$gte = keyDate(req.query.from);
        if (isKey(req.query.to))   dateRange.$lte = keyDate(req.query.to);
        if (Object.keys(dateRange).length) filter.date = dateRange;

        // Resolved to ids first: focusPage() writes its own $or onto the filter.
        // school_admin stays searchable: requests raised by admin posts before
        // self attendance became teacher-only are still in the queue's history.
        const q = String(req.query.search || '').trim();
        if (q) {
            const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
            const { rows } = await pool.query(
                `SELECT "_id" FROM ${T(User)} WHERE "school" = $1 AND "role" IN ('teacher','school_admin')
                   AND ("name" ILIKE $2 OR "email" ILIKE $2)`,
                [String(req.schoolId), like],
            );
            filter.teacher = { $in: rows.map((r) => r._id) };
        }

        const sort = { createdAt: -1 };
        const { page, focusFound } = await resolvePage(
            TeacherAttendanceRegularization, filter, sort, limit, uuidOr(req.query.focus), req.query.page);

        const [requests, total, counts] = await Promise.all([
            TeacherAttendanceRegularization.find(filter)
                .populate('teacher', 'name email role profileImage')
                .populate('reviewedBy', 'name')
                .sort(sort).skip((page - 1) * limit).limit(limit).lean(),
            TeacherAttendanceRegularization.countDocuments(filter),
            pool.query(
                `SELECT "status", count(*)::int AS "n" FROM ${T(TeacherAttendanceRegularization)}
                  WHERE "school" = $1 GROUP BY "status"`,
                [String(req.schoolId)],
            ),
        ]);

        const teacherIds = [...new Set(requests.map((r) => String(r.teacher?._id || r.teacher)).filter(Boolean))];
        let profiles = [], recorded = [];
        if (requests.length) {
            const dates = requests.map((r) => dateKey(r.date)).sort();
            [profiles, recorded] = await Promise.all([
                TeacherProfile.find({ user: { $in: teacherIds } }).select('user designation department employeeId').lean(),
                TeacherAttendance.find({
                    teacher: { $in: teacherIds },
                    date: { $gte: keyDate(dates[0]), $lt: keyDate(addDays(dates[dates.length - 1], 1)) },
                }).select('teacher date status checkIn checkOut').lean(),
            ]);
        }
        const profileOf  = new Map(profiles.map((p) => [String(p.user), p]));
        const recordedOf = new Map(recorded.map((r) => [`${r.teacher}|${dateKey(r.date)}`, r]));

        const byStatus = Object.fromEntries(counts.rows.map((r) => [low(r.status), r.n]));
        res.json({
            success: true,
            data: requests.map((r) => {
                const tid  = String(r.teacher?._id || r.teacher);
                const prof = profileOf.get(tid);
                const rec  = recordedOf.get(`${tid}|${dateKey(r.date)}`);
                return {
                    ...r,
                    status: low(r.status),
                    requestedStatus: low(r.requestedStatus),
                    teacher: r.teacher && typeof r.teacher === 'object'
                        ? { ...r.teacher, designation: prof?.designation || '', department: prof?.department || '', employeeId: prof?.employeeId || '' }
                        : r.teacher,
                    recorded: rec ? { status: low(rec.status), checkIn: rec.checkIn || '', checkOut: rec.checkOut || '' } : null,
                    own: tid === String(req.userId),
                };
            }),
            total, page, limit,
            pages: Math.max(1, Math.ceil(total / limit)),
            counts: {
                all:      (byStatus.pending || 0) + (byStatus.approved || 0) + (byStatus.rejected || 0),
                pending:  byStatus.pending  || 0,
                approved: byStatus.approved || 0,
                rejected: byStatus.rejected || 0,
            },
            ...(req.query.focus ? { focusFound } : {}),
        });
    } catch (e) { err(res, e); }
};

// ═══════════════════════════════════════════════════════════════════════════
//  GET /admin/regularization/day?userId=&date=
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What one person's day holds right now — shown beside the Regularise form so
 * the office corrects the record it can see rather than one it assumes.
 */
exports.personDay = async (req, res) => {
    try {
        const userId = uuidOr(req.query.userId);
        const day    = isKey(req.query.date) ? req.query.date : null;
        if (!userId || !day) return err(res, 'userId and date are required', 400);

        const person = await User.findOne({ _id: userId, school: req.schoolId }).select('_id name role email').lean();
        if (!person || !['teacher', 'student'].includes(person.role)) return err(res, 'Person not found', 404);

        if (person.role !== 'student') {
            const since = (await days.startDates(req.schoolId, [userId])).get(userId);
            const [{ days: [entry] }, rec, pending] = await Promise.all([
                days.staffDays({ schoolId: req.schoolId, userId, role: person.role, since }, day, day),
                TeacherAttendance.findOne({ teacher: userId, date: { $gte: keyDate(day), $lt: keyDate(addDays(day, 1)) } })
                    .select('remarks markedBy updatedAt').lean(),
                TeacherAttendanceRegularization.findOne({
                    teacher: userId, school: req.schoolId, status: 'Pending',
                    date: { $gte: keyDate(day), $lt: keyDate(addDays(day, 1)) },
                }).select('_id checkIn checkOut reason createdAt').lean(),
            ]);
            const by = rec?.markedBy ? await User.findById(rec.markedBy).select('name').lean() : null;
            return ok(res, {
                kind: 'staff', date: day,
                person: { _id: person._id, name: person.name, role: person.role, email: person.email },
                status: entry?.status || null, label: entry?.label || '',
                checkIn: entry?.checkIn || '', checkOut: entry?.checkOut || '',
                remarks: rec?.remarks || '', markedBy: by?.name || '', markedAt: rec?.updatedAt || null,
                pendingRequest: pending || null,
            });
        }

        const profile = await StudentProfile.findOne({ user: userId, school: req.schoolId }).select('currentSection rollNumber').lean();
        const section = profile?.currentSection
            ? await ClassSection.findOne({ _id: profile.currentSection, school: req.schoolId }).select('_id sectionName class').lean()
            : null;
        const klass   = section ? await Class.findById(section.class).select('className').lean() : null;
        const session = section
            ? await Attendance.findOne({ section: section._id, date: { $gte: keyDate(day), $lt: keyDate(addDays(day, 1)) } }).lean()
            : null;
        const record  = session ? await AttendanceRecord.findOne({ attendance: session._id, student: userId }).lean() : null;
        const [by, pending] = await Promise.all([
            (record?.markedBy || (record && session?.createdBy))
                ? User.findById(record.markedBy || session.createdBy).select('name').lean() : null,
            AttendanceCorrection.findOne({
                student: userId, status: 'Pending', date: { $gte: keyDate(day), $lt: keyDate(addDays(day, 1)) },
            }).select('_id requestedStatus reason createdAt').lean(),
        ]);

        ok(res, {
            kind: 'student', date: day,
            person: {
                _id: person._id, name: person.name, role: person.role, email: person.email,
                className: klass?.className || '', sectionName: section?.sectionName || '', rollNumber: profile?.rollNumber || '',
            },
            enrolled: !!section,
            registerTaken: !!session,
            status: low(record?.status),
            remarks: record?.remarks || '',
            markedAt: record ? (record.markedAt || session.createdAt) : null,
            markedBy: by?.name || '',
            pendingRequest: pending ? { ...pending, requestedStatus: low(pending.requestedStatus) } : null,
        });
    } catch (e) { err(res, e); }
};
