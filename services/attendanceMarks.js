'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Writing a section's register for a day.
//
//  Two callers take attendance: a teacher for a register they hold, and the
//  school office from the admin attendance screen, which can mark any section
//  and — through "Mark all" — every unmarked student in the school at once.
//  Both go through here so a register means the same thing whoever wrote it.
//
//  A register is one section on one day — and, when the school takes
//  attendance subject-wise, one subject (services/studentAttendance.js).
//
//  Two things this does that the teacher path used to do differently:
//
//   • One statement per register, not two queries per student. The ORM's
//     upsert is a find followed by a save; for a whole school that was
//     thousands of round trips inside one request.
//
//   • Only a mark that CHANGED is announced (services/attendanceNotices.js).
//     Saving a register again — to fix one student — used to re-send the
//     absence notice and the parent email for every student on it. `markedAt`/`markedBy` move only with the status, so
//     they record when the current mark was actually made, which is what the
//     admin table's "Marked at" column and the activity feed read.
// ─────────────────────────────────────────────────────────────────────────────
const crypto           = require('crypto');
const pool             = require('../db/pool');
const Attendance       = require('../models/Attendance');
const AttendanceRecord = require('../models/AttendanceRecord');
const { capStatus }    = require('./studentAttendance');
const { marksChanged } = require('./attendanceNotices');

const T_SESSION = `"${Attendance.tableName}"`;
const T_RECORD  = `"${AttendanceRecord.tableName}"`;

/**
 * Upsert one register's marks.
 *
 * @param {Object} o
 * @param {String} o.schoolId
 * @param {String} o.sectionId   already checked to belong to the school
 * @param {String} [o.subjectId] the subject of a subject-wise register; null for a day register
 * @param {String} o.date        'YYYY-MM-DD' (the local calendar day)
 * @param {Array}  o.records     [{ studentId, status: 'Present'|'Absent'|'Late'|'Half-Day', remarks? }]
 *                               `remarks` undefined leaves a saved remark alone.
 * @param {Object} o.actor       { userId, role, name }
 * @param {String} [o.note]      why the marks changed (a correction's reason) — added to the notices
 * @returns {Promise<{ session, changed: Array<{student,status,was}>, records: Array }>}
 */
async function saveSectionMarks({ schoolId, sectionId, subjectId = null, date, records, actor, note = '' }) {
    const day = new Date(`${date}T00:00:00.000Z`);

    // The session row: created once, first writer recorded as its author. The
    // conflict target is the expression index from db/migrate.js.
    const { rows: [session] } = await pool.query(
        `INSERT INTO ${T_SESSION} ("_id", "section", "date", "subject", "createdBy", "createdAt")
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT ("section", "date", (COALESCE("subject"::text, ''))) DO UPDATE SET "section" = EXCLUDED."section"
         RETURNING "_id", "section", "date", "subject", "createdBy", "createdAt"`,
        [crypto.randomUUID(), String(sectionId), day, subjectId ? String(subjectId) : null, String(actor.userId)],
    );

    // Last write wins for a student listed twice in one request.
    const byStudent = new Map();
    const remarkOf  = new Map();
    for (const r of records) {
        const status = capStatus(r.status);
        if (!r.studentId || !status) continue;
        byStudent.set(String(r.studentId), status);
        if (r.remarks !== undefined && r.remarks !== null) {
            remarkOf.set(String(r.studentId), String(r.remarks).trim().slice(0, 300));
        }
    }
    const students = [...byStudent.keys()];
    if (!students.length) return { session, changed: [], records: [] };

    // `prior` and the insert read the same snapshot, so `was` is the mark as it
    // stood before this statement. The WHERE on the conflict branch leaves an
    // unchanged mark — and its markedAt — alone, and keeps it out of RETURNING.
    const { rows: changed } = await pool.query(
        `WITH input AS (
            SELECT * FROM unnest($2::uuid[], $3::text[], $4::uuid[]) AS i("student", "status", "id")
         ),
         prior AS (
            SELECT r."student", r."status" FROM ${T_RECORD} r
             WHERE r."attendance" = $1 AND r."student" = ANY($2::uuid[])
         ),
         up AS (
            INSERT INTO ${T_RECORD} ("_id", "attendance", "student", "status", "remarks", "markedAt", "markedBy")
            SELECT i."id", $1, i."student", i."status", '', now(), $5 FROM input i
            ON CONFLICT ("attendance", "student") DO UPDATE
               SET "status" = EXCLUDED."status", "markedAt" = EXCLUDED."markedAt", "markedBy" = EXCLUDED."markedBy"
             WHERE ${T_RECORD}."status" IS DISTINCT FROM EXCLUDED."status"
            RETURNING "student", "status"
         )
         SELECT up."student", up."status", prior."status" AS "was"
           FROM up LEFT JOIN prior ON prior."student" = up."student"`,
        [
            session._id,
            students,
            students.map((s) => byStudent.get(s)),
            students.map(() => crypto.randomUUID()),
            String(actor.userId),
        ],
    );

    // A remark is not a mark: changing one moves neither markedAt nor anything
    // anyone is told about.
    if (remarkOf.size) {
        const ids = [...remarkOf.keys()];
        await pool.query(
            `UPDATE ${T_RECORD} r SET "remarks" = i."remarks"
               FROM unnest($2::uuid[], $3::text[]) AS i("student", "remarks")
              WHERE r."attendance" = $1 AND r."student" = i."student"
                AND r."remarks" IS DISTINCT FROM i."remarks"`,
            [session._id, ids, ids.map((id) => remarkOf.get(id))],
        );
    }

    const { rows: saved } = await pool.query(
        `SELECT "_id", "attendance", "student", "status", "remarks", "markedAt", "markedBy"
           FROM ${T_RECORD} WHERE "attendance" = $1 AND "student" = ANY($2::uuid[])`,
        [session._id, students],
    );

    // Who is told what — marks, and the alerts they cross — is attendanceNotices.
    if (changed.length) marksChanged({ schoolId, sectionId, subjectId: session.subject, date, changed, actor, note });
    return { session, changed, records: saved };
}

module.exports = { saveSectionMarks, capStatus };
