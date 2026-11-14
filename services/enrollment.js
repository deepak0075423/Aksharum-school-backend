'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Where a student is, year by year — the ONLY writer of placements.
//
//  The fact lives in StudentEnrollment (one row per student per academic year)
//  and is mirrored in two places that ~300 readers already use:
//    - ClassSection.enrolledStudents — a section's roster; sections belong to a
//      year, so a roster is that year's rows for that section;
//    - StudentProfile.currentClass / currentSection / rollNumber — a POINTER to
//      the student's row in the school's active year (or, when they have none
//      there, their latest row from an earlier year; failing that, their
//      latest row at all). It is derived, never written directly.
//
//  The rule this file exists to keep: a write for year Y touches year Y only.
//  Putting a student in a 2026-27 section takes them out of other 2026-27
//  sections and nothing else — their 2025-26 class, section and roll number
//  stay as they were. (Before this, the shared helper took a student off every
//  section in every year whenever they were placed or removed.)
//
//  Every write runs in a transaction, serialised per student, so the row, both
//  rosters it touches and the pointer can never be seen half-moved.
// ─────────────────────────────────────────────────────────────────────────────
const { withTransaction, buildInsert, lock } = require('./dbTx');
const StudentEnrollment = require('../models/StudentEnrollment');
const StudentProfile    = require('../models/StudentProfile');
const ClassSection      = require('../models/ClassSection');
const Class             = require('../models/Class');
const AcademicYear      = require('../models/AcademicYear');
const pool              = require('../db/pool');

const T = {
    enr:  `"${StudentEnrollment.tableName}"`,
    prof: `"${StudentProfile.tableName}"`,
    sec:  `"${ClassSection.tableName}"`,
    cls:  `"${Class.tableName}"`,
    year: `"${AcademicYear.tableName}"`,
};
const idOf = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : v ? String(v) : null);
const ARR = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;

class EnrollmentError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

/* ── Resolving the target ──────────────────────────────────────────────────── */

/**
 * The year, class and section a placement is about. A section names its class
 * and year; a class names its year. Anything that does not belong to the
 * school, or a section and class from different years, is refused.
 */
async function resolveTarget(q, { schoolId, sectionId, classId, academicYear }) {
    let section = null; let cls = null;
    if (sectionId) {
        section = (await q(`SELECT "_id", "class", "academicYear", "school" FROM ${T.sec} WHERE "_id" = $1::uuid`, [String(sectionId)])).rows[0];
        if (!section || String(section.school) !== String(schoolId)) throw new EnrollmentError('Section not found', 404);
    }
    const wantClass = classId || section?.class;
    if (wantClass) {
        cls = (await q(`SELECT "_id", "academicYear", "school" FROM ${T.cls} WHERE "_id" = $1::uuid`, [String(wantClass)])).rows[0];
        if (!cls || String(cls.school) !== String(schoolId)) throw new EnrollmentError('Class not found', 404);
    }
    if (section && cls && String(section.class) !== String(cls._id))
        throw new EnrollmentError('That section belongs to a different class');
    const year = idOf(section?.academicYear) || idOf(cls?.academicYear) || idOf(academicYear);
    if (!year) throw new EnrollmentError('An academic year is needed to place a student');
    if (academicYear && String(academicYear) !== year)
        throw new EnrollmentError('That class belongs to a different academic year');
    return { year, classId: cls ? String(cls._id) : null, sectionId: section ? String(section._id) : null };
}

/* ── The pointer ───────────────────────────────────────────────────────────── */

/**
 * The row a student's profile should point at, as SQL over `sp` (a profile):
 * the active year's row; else the latest row from a year that started before
 * the active one; else the latest row at all.
 */
const POINTER_PICK = `
    SELECT e."class", e."section", e."rollNumber"
      FROM ${T.enr} e
      JOIN ${T.year} y ON y."_id" = e."academicYear"
      LEFT JOIN ${T.year} act ON act."school" = e."school" AND act."status" = 'active'
     WHERE e."student" = sp."user"
     ORDER BY (e."academicYear" = act."_id") DESC NULLS LAST,
              (y."startDate" <= act."startDate") DESC NULLS LAST,
              y."startDate" DESC
     LIMIT 1`;

/** Recompute the pointer for some students (or every student of a school). */
async function refreshPointers(q, { studentIds = null, schoolId = null }) {
    const where = studentIds ? `sp."user" = ANY($1::uuid[])` : `sp."school" = $1::uuid`;
    const arg = studentIds ? [studentIds.map(String)] : [String(schoolId)];
    const { rowCount } = await q(
        `UPDATE ${T.prof} sp
            SET "currentClass" = p."class", "currentSection" = p."section", "rollNumber" = COALESCE(p."rollNumber", '')
           FROM ${T.prof} sp2
           LEFT JOIN LATERAL (${POINTER_PICK.replace(/sp\."user"/g, 'sp2."user"')}) p ON true
          WHERE sp2."_id" = sp."_id" AND ${where.replace(/sp\./g, 'sp2.')}
            AND (sp."currentClass"   IS DISTINCT FROM p."class"
              OR sp."currentSection" IS DISTINCT FROM p."section"
              OR COALESCE(sp."rollNumber", '') IS DISTINCT FROM COALESCE(p."rollNumber", ''))`,
        arg,
    );
    return rowCount;
}

/** A student without a profile gets one, so the pointer has somewhere to live. */
async function ensureProfile(q, studentId, schoolId) {
    const have = await q(`SELECT 1 FROM ${T.prof} WHERE "user" = $1::uuid LIMIT 1`, [String(studentId)]);
    if (have.rows.length) return;
    const { sql, params } = buildInsert(StudentProfile, { user: String(studentId), school: String(schoolId) });
    await q(sql, params);
}

/* ── Rosters (one year at a time) ──────────────────────────────────────────── */

/** Take the student off every section of `year` except `keep`. Returns the sections touched. */
async function pullFromYear(q, { schoolId, studentId, year, keep = null }) {
    const { rows } = await q(
        `UPDATE ${T.sec}
            SET "enrolledStudents" = ${ARR('"enrolledStudents"')} - $3::text,
                "currentCount"     = jsonb_array_length(${ARR('"enrolledStudents"')} - $3::text)
          WHERE "school" = $1::uuid AND "academicYear" = $2::uuid
            AND ${ARR('"enrolledStudents"')} ? $3::text
            AND ($4::uuid IS NULL OR "_id" <> $4::uuid)
          RETURNING "_id"`,
        [String(schoolId), String(year), String(studentId), keep ? String(keep) : null],
    );
    return rows.map((r) => String(r._id));
}

async function addToSection(q, { studentId, sectionId }) {
    await q(
        `UPDATE ${T.sec}
            SET "enrolledStudents" = CASE WHEN ${ARR('"enrolledStudents"')} ? $2::text THEN ${ARR('"enrolledStudents"')}
                                          ELSE ${ARR('"enrolledStudents"')} || to_jsonb($2::text) END,
                "currentCount" = jsonb_array_length(CASE WHEN ${ARR('"enrolledStudents"')} ? $2::text THEN ${ARR('"enrolledStudents"')}
                                          ELSE ${ARR('"enrolledStudents"')} || to_jsonb($2::text) END)
          WHERE "_id" = $1::uuid`,
        [String(sectionId), String(studentId)],
    );
}

/* ── Writes ────────────────────────────────────────────────────────────────── */

/**
 * Place a student for ONE academic year: in `sectionId`, or in `classId` with
 * no section (admitted, not placed yet). The year comes from the section or
 * class; other years are not read or written.
 *
 * `rollNumber`: a string sets it, '' clears it, undefined keeps the year's roll
 * when the section is unchanged and clears it when the section changes (roll
 * numbers belong to a section).
 *
 * Pass `q` to run inside a caller's transaction.
 * @returns {{ year, classId, sectionId, removedFrom: string[], rollNumber }}
 */
async function place(opts, q = null) {
    if (!q) return withTransaction((tq) => place(opts, tq));
    const { schoolId, studentId, actorId = null, source = 'manual' } = opts;
    if (!studentId) throw new EnrollmentError('A student is needed');
    await lock(q, `enrol:${studentId}`);
    const target = await resolveTarget(q, opts);
    if (!target.classId) throw new EnrollmentError('A class or section is needed to place a student');

    const before = (await q(
        `SELECT "_id", "section", "rollNumber" FROM ${T.enr} WHERE "student" = $1::uuid AND "academicYear" = $2::uuid`,
        [String(studentId), target.year],
    )).rows[0];
    const sameSection = before && String(before.section || '') === String(target.sectionId || '');
    const rollNumber = opts.rollNumber !== undefined ? String(opts.rollNumber ?? '').trim()
        : sameSection ? (before.rollNumber || '') : '';

    if (before) {
        await q(
            `UPDATE ${T.enr} SET "class" = $2::uuid, "section" = $3::uuid, "rollNumber" = $4,
                    "source" = $5, "updatedBy" = $6::uuid, "updatedAt" = now()
              WHERE "_id" = $1::uuid`,
            [before._id, target.classId, target.sectionId, rollNumber, source, actorId ? String(actorId) : null],
        );
    } else {
        const { sql, params } = buildInsert(StudentEnrollment, {
            school: String(schoolId), student: String(studentId), academicYear: target.year,
            class: target.classId, section: target.sectionId, rollNumber, source, updatedBy: actorId || null,
        });
        await q(sql, params);
    }

    const removedFrom = await pullFromYear(q, { schoolId, studentId, year: target.year, keep: target.sectionId });
    if (target.sectionId) await addToSection(q, { studentId, sectionId: target.sectionId });

    await ensureProfile(q, studentId, schoolId);
    await refreshPointers(q, { studentIds: [studentId] });
    return { ...target, removedFrom, rollNumber };
}

/**
 * Take a student out of their section for one year, keeping them in the class
 * (admitted, not placed). The year is the section's when `sectionId` is given.
 */
async function unplace(opts, q = null) {
    if (!q) return withTransaction((tq) => unplace(opts, tq));
    const { schoolId, studentId, actorId = null } = opts;
    await lock(q, `enrol:${studentId}`);
    const target = await resolveTarget(q, { schoolId, sectionId: opts.sectionId, academicYear: opts.academicYear });
    await q(
        `UPDATE ${T.enr} SET "section" = NULL, "rollNumber" = '', "source" = 'manual', "updatedBy" = $3::uuid, "updatedAt" = now()
          WHERE "student" = $1::uuid AND "academicYear" = $2::uuid`,
        [String(studentId), target.year, actorId ? String(actorId) : null],
    );
    const removedFrom = await pullFromYear(q, { schoolId, studentId, year: target.year });
    await refreshPointers(q, { studentIds: [studentId] });
    return { year: target.year, removedFrom };
}

/**
 * Remove a student's placement for one year altogether (class and section) —
 * a promotion taken back, say. Other years are untouched.
 */
async function withdraw({ schoolId, studentId, academicYear }, q = null) {
    if (!q) return withTransaction((tq) => withdraw({ schoolId, studentId, academicYear }, tq));
    await lock(q, `enrol:${studentId}`);
    await q(`DELETE FROM ${T.enr} WHERE "student" = $1::uuid AND "academicYear" = $2::uuid`, [String(studentId), String(academicYear)]);
    const removedFrom = await pullFromYear(q, { schoolId, studentId, year: academicYear });
    await refreshPointers(q, { studentIds: [studentId] });
    return { removedFrom };
}

/** A student's roll number in one section (and so one year). */
async function setRoll({ studentId, sectionId, rollNumber, actorId = null }, q = null) {
    if (!q) return withTransaction((tq) => setRoll({ studentId, sectionId, rollNumber, actorId }, tq));
    const { rowCount } = await q(
        `UPDATE ${T.enr} SET "rollNumber" = $3, "updatedBy" = $4::uuid, "updatedAt" = now()
          WHERE "student" = $1::uuid AND "section" = $2::uuid`,
        [String(studentId), String(sectionId), String(rollNumber ?? '').trim(), actorId ? String(actorId) : null],
    );
    if (!rowCount) throw new EnrollmentError('That student is not enrolled in this section');
    await refreshPointers(q, { studentIds: [studentId] });
}

/** Every placement a deleted student held — they are gone from every year. */
async function forgetStudents(studentIds) {
    const ids = studentIds.map(String);
    if (!ids.length) return;
    await withTransaction(async (q) => {
        await q(`DELETE FROM ${T.enr} WHERE "student" = ANY($1::uuid[])`, [ids]);
        for (const id of ids) {
            await q(
                `UPDATE ${T.sec}
                    SET "enrolledStudents" = ${ARR('"enrolledStudents"')} - $1::text,
                        "currentCount" = jsonb_array_length(${ARR('"enrolledStudents"')} - $1::text)
                  WHERE ${ARR('"enrolledStudents"')} ? $1::text`,
                [id],
            );
        }
    });
}

/** The active year changed: every student's pointer follows it. */
async function refreshSchool(schoolId) {
    return withTransaction((q) => refreshPointers(q, { schoolId }));
}

/* ── Reads ─────────────────────────────────────────────────────────────────── */

/** student id → roll number, for one section's year. */
async function rollsOfSection(sectionId) {
    const { rows } = await pool.query(
        `SELECT "student", "rollNumber" FROM ${T.enr} WHERE "section" = $1::uuid`, [String(sectionId)],
    );
    return new Map(rows.map((r) => [String(r.student), r.rollNumber || '']));
}

/** A student's row for one year, or null. */
async function inYear(studentId, academicYear) {
    const { rows } = await pool.query(
        `SELECT * FROM ${T.enr} WHERE "student" = $1::uuid AND "academicYear" = $2::uuid`,
        [String(studentId), String(academicYear)],
    );
    return rows[0] || null;
}

/** Every year a student has been placed in, oldest first, with names. */
async function history(studentId) {
    const { rows } = await pool.query(
        `SELECT e."_id", e."academicYear", y."yearName", y."status" AS "yearStatus", y."startDate",
                e."class", c."className", c."classNumber", e."section", s."sectionName", e."rollNumber", e."source", e."updatedAt"
           FROM ${T.enr} e
           JOIN ${T.year} y ON y."_id" = e."academicYear"
           LEFT JOIN ${T.cls} c ON c."_id" = e."class"
           LEFT JOIN ${T.sec} s ON s."_id" = e."section"
          WHERE e."student" = $1::uuid
          ORDER BY y."startDate"`,
        [String(studentId)],
    );
    return rows;
}

/** How many students a class or a section holds this year (for delete guards). */
async function countIn({ classId = null, sectionId = null }) {
    const { rows } = await pool.query(
        sectionId
            ? `SELECT count(*)::int AS n FROM ${T.enr} WHERE "section" = $1::uuid`
            : `SELECT count(*)::int AS n FROM ${T.enr} WHERE "class" = $1::uuid`,
        [String(sectionId || classId)],
    );
    return rows[0]?.n || 0;
}

module.exports = {
    EnrollmentError,
    place, unplace, withdraw, setRoll, forgetStudents, refreshSchool, refreshPointers,
    rollsOfSection, inYear, history, countIn,
    POINTER_PICK, T,
};
