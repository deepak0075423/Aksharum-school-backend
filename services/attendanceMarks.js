'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Writing a section's register for a day.
//
//  Two callers take attendance: a class teacher for their own section, and the
//  school office from the admin attendance screen, which can mark any section
//  and — through "Mark all" — every unmarked student in the school at once.
//  Both go through here so a register means the same thing whoever wrote it.
//
//  Two things this does that the teacher path used to do differently:
//
//   • One statement per register, not two queries per student. The ORM's
//     upsert is a find followed by a save; for a whole school that was
//     thousands of round trips inside one request.
//
//   • Only a mark that CHANGED is announced. Saving a register again — to fix
//     one student — used to re-send the absence notice and the parent email for
//     every student on it. `markedAt`/`markedBy` move only with the status, so
//     they record when the current mark was actually made, which is what the
//     admin table's "Marked at" column and the activity feed read.
// ─────────────────────────────────────────────────────────────────────────────
const crypto           = require('crypto');
const pool             = require('../db/pool');
const Attendance       = require('../models/Attendance');
const AttendanceRecord = require('../models/AttendanceRecord');
const StudentProfile   = require('../models/StudentProfile');
const { notify }       = require('./notifyService');

const T_SESSION = `"${Attendance.tableName}"`;
const T_RECORD  = `"${AttendanceRecord.tableName}"`;

const STATUS = { present: 'Present', absent: 'Absent', late: 'Late' };
/** 'present' → 'Present'; anything unknown → null. */
const capStatus = (s) => STATUS[String(s || '').toLowerCase()] || null;

/**
 * Upsert one section's marks for one date.
 *
 * @param {Object} o
 * @param {String} o.schoolId
 * @param {String} o.sectionId   already checked to belong to the school
 * @param {String} o.date        'YYYY-MM-DD' (the local calendar day)
 * @param {Array}  o.records     [{ studentId, status: 'Present'|'Absent'|'Late' }]
 * @param {Object} o.actor       { userId, role, name }
 * @returns {Promise<{ session, changed: Array<{student,status,was}>, records: Array }>}
 */
async function saveSectionMarks({ schoolId, sectionId, date, records, actor }) {
    const day = new Date(`${date}T00:00:00.000Z`);

    // The session row: created once, first writer recorded as its author.
    const { rows: [session] } = await pool.query(
        `INSERT INTO ${T_SESSION} ("_id", "section", "date", "createdBy", "createdAt")
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT ("section", "date") DO UPDATE SET "section" = EXCLUDED."section"
         RETURNING "_id", "section", "date", "createdBy", "createdAt"`,
        [crypto.randomUUID(), String(sectionId), day, String(actor.userId)],
    );

    // Last write wins for a student listed twice in one request.
    const byStudent = new Map();
    for (const r of records) if (r.studentId && r.status) byStudent.set(String(r.studentId), r.status);
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

    const { rows: saved } = await pool.query(
        `SELECT "_id", "attendance", "student", "status", "remarks", "markedAt", "markedBy"
           FROM ${T_RECORD} WHERE "attendance" = $1 AND "student" = ANY($2::uuid[])`,
        [session._id, students],
    );

    if (changed.length) announce({ schoolId, date, changed, actor });
    return { session, changed, records: saved };
}

/**
 * Tell students and parents about marks that changed. Runs after the response;
 * a mail server that is down must not fail a register.
 */
function announce({ schoolId, date, changed, actor }) {
    setImmediate(async () => {
        try {
            const User   = require('../models/User');
            const School = require('../models/School');
            const { sendAttendanceNotification } = require('../utils/sendEmail');

            const school    = await School.findById(schoolId).select('name').lean();
            const dateLabel = new Date(`${date}T00:00:00.000Z`)
                .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

            const profiles = await StudentProfile.find({ user: { $in: changed.map((c) => String(c.student)) } })
                .populate('user', 'name').lean();
            const profileOf = new Map(profiles.map((p) => [String(p.user?._id || p.user), p]));
            const parentIds = [...new Set(profiles.map((p) => p.parent).filter(Boolean).map(String))];
            const parents   = parentIds.length
                ? await User.find({ _id: { $in: parentIds } }).select('name email').lean()
                : [];
            const parentOf  = new Map(parents.map((u) => [String(u._id), u]));

            for (const c of changed) {
                const sp   = profileOf.get(String(c.student));
                const name = sp?.user?.name || 'Student';
                if (c.status !== 'Present') {
                    notify({
                        school:     schoolId,
                        sender:     actor.userId,
                        senderRole: actor.role || 'teacher',
                        title:      `Attendance: ${name} marked ${c.status}`,
                        body:       `${name} was marked ${c.status.toLowerCase()} on ${dateLabel}.`,
                        recipients: [String(c.student), ...(sp?.parent ? [String(sp.parent)] : [])],
                        // No id: the student's own calendar has no row keyed by a record
                        link:       { type: 'attendance.student' },
                    });
                }
                const parent = sp?.parent && parentOf.get(String(sp.parent));
                if (!parent?.email) continue;
                await sendAttendanceNotification({
                    to: parent.email,
                    parentName: parent.name,
                    studentName: sp.user?.name || '',
                    date: new Date(`${date}T00:00:00.000Z`),
                    status: c.status,
                    schoolName: school?.name || '',
                    schoolId,
                });
            }
        } catch (e) { console.error('Attendance notification error:', e.message); }
    });
}

module.exports = { saveSectionMarks, capStatus };
