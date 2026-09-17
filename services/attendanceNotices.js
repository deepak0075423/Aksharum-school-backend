'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Every notice student attendance sends, in one place.
//
//  Who hears what (in-app; parents are also emailed about marks):
//
//   A mark changes (a register, a teacher's or the office's correction)
//     • marked Absent / Late / Half-Day          → student + parents
//     • changed back to Present from one of those → student + parents
//     • a first Present mark                      → nobody (it is the norm)
//   An alert is crossed by that change
//     • absent 3 school days in a row              → student + parents + class & vice class teacher
//     • academic-year attendance falls below 75%   → student + parents + class & vice class teacher
//   A correction request moves
//     • submitted     → reviewing teachers; student + parents told it was sent
//     • info asked    → student + parents
//     • student reply → reviewing teachers
//     • approved / rejected → student + parents
//
//  Every notice about a student is also sent TO that student: parent inboxes
//  work out which child a notification concerns from which children hold a
//  receipt for it (notification.controller tagChildren), and `params.child`
//  opens the parent's attendance page on that child.
// ─────────────────────────────────────────────────────────────────────────────
const pool     = require('../db/pool');
const { notify } = require('./notifyService');
const { parentsOf } = require('./parentChildren');
const { reviewersOf } = require('./attendanceCorrections');
const sa       = require('./studentAttendance');

const STREAK_ALERT   = 3;    // consecutive absent school days
const LOW_ATTENDANCE = 75;   // percent of the academic year
const LOW_MIN_MARKS  = 10;   // a handful of marks is not a trend

const T = (M) => `"${M.tableName}"`;
// Months spelled out: ICU writes September as "Sept" in en-IN.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (d) => { const x = new Date(d); return `${x.getUTCDate()} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`; };
const keyOf  = (d) => new Date(d).toISOString().slice(0, 10);
const label  = (s) => sa.capStatus(s) || 'Not Marked';

async function namesOf(ids) {
    const User = require('../models/User');
    const list = [...new Set(ids.map(String))];
    if (!list.length) return new Map();
    const users = await User.find({ _id: { $in: list } }).select('name email').lean();
    return new Map(users.map((u) => [String(u._id), u]));
}

async function subjectName(subjectId) {
    if (!subjectId) return '';
    const s = await require('../models/Subject').findById(subjectId).select('subjectName').lean();
    return s?.subjectName || '';
}

// ── Marks ────────────────────────────────────────────────────────────────────

/**
 * Tell students and parents about marks that changed, then check the alerts
 * those changes may have crossed. Runs after the response: a mail server that
 * is down must never fail a register.
 *
 * @param {Object} o
 * @param {Array}  o.changed  [{ student, status, was }] — stored forms; `was` null for a new mark
 * @param {String} [o.note]   why it changed (a correction's reason), added to the notice
 */
function marksChanged({ schoolId, sectionId, subjectId = null, date, changed, actor, note = '' }) {
    if (!changed?.length) return;
    setImmediate(async () => {
        try {
            const School = require('../models/School');
            const { sendAttendanceNotification } = require('../utils/sendEmail');

            const studentIds = changed.map((c) => String(c.student));
            const [school, subject, parents] = await Promise.all([
                School.findById(schoolId).select('name').lean(),
                subjectName(subjectId),
                parentsOf(studentIds, schoolId),
            ]);
            const people = await namesOf([...studentIds, ...[...parents.values()].flat()]);
            const inSubject = subject ? ` in ${subject}` : '';
            const dateLabel = fmtDay(`${date}T00:00:00.000Z`);
            const tail = note ? `\n${note}` : '';

            for (const c of changed) {
                const sid  = String(c.student);
                const name = people.get(sid)?.name || 'Student';
                const mine = parents.get(sid) || [];
                const recipients = [sid, ...mine];
                const link = { type: 'attendance.student', params: { child: sid, date } };
                const backToPresent = c.status === 'Present' && c.was && c.was !== 'Present';

                if (c.status !== 'Present') {
                    notify({
                        school: schoolId, sender: actor.userId, senderRole: actor.role || 'teacher',
                        title: `Attendance: ${name} marked ${c.status}${inSubject}`,
                        body: `${name} was marked ${c.status.toLowerCase()}${inSubject} on ${dateLabel}.${c.was ? ` (Previously ${c.was.toLowerCase()}.)` : ''}${tail}`,
                        recipients, link,
                    });
                } else if (backToPresent) {
                    notify({
                        school: schoolId, sender: actor.userId, senderRole: actor.role || 'teacher',
                        title: `Attendance updated: ${name} marked Present${inSubject}`,
                        body: `${name}'s attendance${inSubject} on ${dateLabel} was changed from ${c.was.toLowerCase()} to present.${tail}`,
                        recipients, link,
                    });
                }

                // Parents are emailed about every change in a day-wise school. A
                // subject-wise school takes six or seven registers a day, so a
                // first "present" is not worth an email there.
                if (subject && c.status === 'Present' && !backToPresent) continue;
                for (const pid of mine) {
                    const parent = people.get(pid);
                    if (!parent?.email) continue;
                    await sendAttendanceNotification({
                        to: parent.email, parentName: parent.name, studentName: name,
                        date: new Date(`${date}T00:00:00.000Z`), status: c.status,
                        subjectName: subject, schoolName: school?.name || '', schoolId,
                    }).catch((e) => console.error('Attendance email error:', e.message));
                }
            }

            await checkAlerts({ schoolId, sectionId, date, changed, actor, parents, people });
        } catch (e) { console.error('Attendance notification error:', e.message); }
    });
}

/**
 * The two alerts a change of mark can cross. Each fires on the transition only
 * — the third absent day in a row, the mark that takes the year below 75% — so
 * saving the same register again, or a fourth absence, says nothing new.
 */
async function checkAlerts({ schoolId, sectionId, date, changed, actor, parents, people }) {
    const AcademicYear = require('../models/AcademicYear');
    const Attendance = require('../models/Attendance');
    const AttendanceRecord = require('../models/AttendanceRecord');

    const year = await AcademicYear.findOne({ school: schoolId, status: 'active' }).select('startDate endDate').lean();
    const from = year?.startDate ? new Date(year.startDate) : new Date(Date.now() - 365 * 86400000);
    const to   = year?.endDate ? new Date(`${keyOf(year.endDate)}T23:59:59.999Z`) : new Date();
    const studentIds = [...new Set(changed.map((c) => String(c.student)))];

    const { rows } = await pool.query(
        `SELECT r."student"::text AS "student", r."status", to_char(a."date" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "key"
           FROM ${T(AttendanceRecord)} r
           JOIN ${T(Attendance)} a ON a."_id" = r."attendance"
          WHERE r."student" = ANY($1::uuid[]) AND a."date" >= $2 AND a."date" <= $3`,
        [studentIds, from, to],
    );
    const marksOf = new Map(studentIds.map((id) => [id, []]));
    for (const r of rows) marksOf.get(r.student)?.push(r);

    const teachers = sectionId ? await reviewersOf(sectionId, null) : [];

    for (const c of changed) {
        const sid  = String(c.student);
        const name = people.get(sid)?.name || 'Student';
        const marks = marksOf.get(sid) || [];
        const recipients = [sid, ...(parents.get(sid) || []), ...teachers];
        const link = { type: 'attendance.alert', entityId: sid, params: { child: sid, ...(sectionId ? { section: String(sectionId) } : {}) } };

        // The same marks as they stood before this change: one occurrence of the
        // new mark swapped back for the old one (or dropped, for a new mark).
        const undo = (list) => {
            const out = [...list];
            const i = out.findIndex((m) => m.key === date && m.status === c.status);
            if (i >= 0) { if (c.was) out[i] = { ...out[i], status: c.was }; else out.splice(i, 1); }
            return out;
        };
        const before = undo(marks);

        // ── Absent school days in a row ──
        const streak = (list) => {
            const byDay = new Map();
            for (const m of list) { if (!byDay.has(m.key)) byDay.set(m.key, []); byDay.get(m.key).push(m.status); }
            const keys = [...byDay.keys()].sort().reverse();
            let n = 0;
            for (const k of keys) { if (sa.rollup(byDay.get(k)) === 'Absent') n += 1; else break; }
            return { n, latest: keys[0] };
        };
        const now = streak(marks);
        const was = streak(before);
        if (now.n === STREAK_ALERT && was.n < STREAK_ALERT && now.latest === date) {
            notify({
                school: schoolId, sender: actor.userId, senderRole: actor.role || 'teacher',
                title: `⚠️ ${name} has been absent ${STREAK_ALERT} days in a row`,
                body: `${name} was marked absent on each of the last ${STREAK_ALERT} school days, up to ${fmtDay(`${date}T00:00:00.000Z`)}. Please get in touch with the class teacher if something is wrong.`,
                recipients, link,
            });
        }

        // ── Below the minimum for the year ──
        const after = sa.tally(marks.map((m) => m.status));
        const prior = sa.tally(before.map((m) => m.status));
        const wasOk = prior.total < LOW_MIN_MARKS || prior.percentage == null || prior.percentage >= LOW_ATTENDANCE;
        if (after.total >= LOW_MIN_MARKS && after.percentage < LOW_ATTENDANCE && wasOk) {
            notify({
                school: schoolId, sender: actor.userId, senderRole: actor.role || 'teacher',
                title: `⚠️ ${name}'s attendance is below ${LOW_ATTENDANCE}%`,
                body: `${name}'s attendance for the year is now ${after.percentage}% (${after.attended} of ${after.total} marks attended), below the ${LOW_ATTENDANCE}% minimum.`,
                recipients, link,
            });
        }
    }
}

// ── Correction requests ──────────────────────────────────────────────────────

async function correctionContext(correction) {
    const sid = String(correction.student);
    const [people, subject, parents] = await Promise.all([
        namesOf([sid]),
        subjectName(correction.subject),
        parentsOf([sid], correction.school),
    ]);
    return {
        sid,
        name: people.get(sid)?.name || 'Student',
        where: `${fmtDay(correction.date)}${subject ? ` (${subject})` : ''}`,
        family: [sid, ...(parents.get(sid) || [])],
    };
}

const mineLink = (correction, sid) => ({ type: 'attendance.myCorrection', entityId: correction._id, params: { child: sid } });

/** A student asked for a mark to be changed. */
function correctionSubmitted({ req, correction }) {
    setImmediate(async () => {
        try {
            const ctx = await correctionContext(correction);
            const change = `${label(correction.currentStatus)} → ${label(correction.requestedStatus)}`;
            const reviewers = await reviewersOf(correction.section, correction.subject);
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '📝 New attendance correction request',
                body: `${ctx.name} requested a correction for ${ctx.where} (${change}).\nReason: ${correction.reason}`,
                recipients: reviewers,
                link: { type: 'attendance.corrections', entityId: correction._id },
            });
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole, includeSender: true,
                title: `📝 Attendance correction requested for ${ctx.name}`,
                body: `A correction for ${ctx.where} (${change}) was sent to the class teacher for review.\nReason: ${correction.reason}`,
                recipients: ctx.family,
                link: mineLink(correction, ctx.sid),
            });
        } catch (e) { console.error('Correction notice error:', e.message); }
    });
}

/** A teacher asked the student for more before deciding. */
function correctionInfoRequested({ req, correction, message }) {
    setImmediate(async () => {
        try {
            const ctx = await correctionContext(correction);
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: `📝 More information needed for ${ctx.name}'s attendance correction`,
                body: `${req.user?.name || 'The teacher'} asked about the correction for ${ctx.where}:\n${message}\n\n${ctx.name} can reply from the attendance page.`,
                recipients: ctx.family,
                link: mineLink(correction, ctx.sid),
            });
        } catch (e) { console.error('Correction notice error:', e.message); }
    });
}

/** The student answered. */
function correctionReplied({ req, correction, message, fileCount }) {
    setImmediate(async () => {
        try {
            const ctx = await correctionContext(correction);
            const reviewers = await reviewersOf(correction.section, correction.subject);
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '💬 Reply on an attendance correction',
                body: `${ctx.name} replied about ${ctx.where}${message ? `:\n${message}` : ''}${fileCount ? `\n${fileCount} file(s) attached` : ''}`,
                recipients: reviewers,
                link: { type: 'attendance.corrections', entityId: correction._id },
            });
        } catch (e) { console.error('Correction notice error:', e.message); }
    });
}

/** A teacher decided. */
function correctionReviewed({ req, correction, approved, remarks }) {
    setImmediate(async () => {
        try {
            const ctx = await correctionContext(correction);
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: approved ? `✅ Attendance correction approved for ${ctx.name}` : `❌ Attendance correction rejected for ${ctx.name}`,
                body: approved
                    ? `The correction for ${ctx.where} was approved — the mark is now ${label(correction.requestedStatus).toLowerCase()}.${remarks ? `\nRemarks: ${remarks}` : ''}`
                    : `The correction for ${ctx.where} was rejected; the mark stays ${label(correction.currentStatus).toLowerCase()}.${remarks ? `\nRemarks: ${remarks}` : ''}`,
                recipients: ctx.family,
                link: mineLink(correction, ctx.sid),
            });
        } catch (e) { console.error('Correction notice error:', e.message); }
    });
}

module.exports = {
    marksChanged, correctionSubmitted, correctionInfoRequested, correctionReplied, correctionReviewed,
    STREAK_ALERT, LOW_ATTENDANCE, LOW_MIN_MARKS,
};
