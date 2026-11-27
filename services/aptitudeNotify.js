'use strict';
/**
 * Who hears about an aptitude exam, and when (Nov 2026).
 *
 * The module sent nothing at all: a student found a new exam only by opening
 * the page, and a teacher found results waiting on them the same way. Now:
 *
 *   published   students it reaches + their parents     "New aptitude exam"
 *   withdrawn   the same people (cancelled / to draft)   "… cancelled" / "… withdrawn"
 *   open now    students it reaches                      "… is open now"        (minute sweep)
 *   closed      whoever signs next — the author if a     "Confirm the scores" /
 *               teacher wrote it, else the class teachers "Approve the results" (minute sweep)
 *   confirmed   the class teachers                       "Results ready for your approval"
 *   sent back   the author                               "Results sent back"
 *   results     students who sat it + their parents      "Results out"  (now, or on the publish date)
 *
 * Request-driven notices go out fire-and-forget after the write. The three
 * clock-driven ones are claimed first (UPDATE … WHERE "<x>NotifiedAt" IS NULL
 * RETURNING), so a restart or a second worker never sends one twice, and only
 * look back a day or two — switching this on never floods anyone with news
 * about exams that closed months ago.
 *
 * In-app + device push only, like every other module (no SMS / WhatsApp).
 */
const pool             = require('../db/pool');
const AptitudeExam     = require('../models/AptitudeExam');
const ExamAttempt      = require('../models/ExamAttempt');
const ClassSection     = require('../models/ClassSection');
const Subject          = require('../models/Subject');
const User             = require('../models/User');
const { notify, withParents } = require('./notifyService');
const { examSectionIds, examWindow, examStage } = require('./aptitudeExam');

const qt = (Model) => `"${Model.tableName}"`;
const EXAMS = qt(AptitudeExam);
const FINISHED = ['submitted', 'auto_submitted'];

const log = (what) => (e) => console.error(`[aptitude-notify] ${what} failed:`, e.message);
const later = (what, fn) => setImmediate(() => Promise.resolve().then(fn).catch(log(what)));
const s_ = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── What a notice says ────────────────────────────────────────────────────────

const clock = (d) => d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
const day = (d) => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

async function subjectName(exam) {
    if (!exam.subject) return 'General Aptitude';
    const s = await Subject.findById(exam.subject).select('subjectName').lean().catch(() => null);
    return s?.subjectName || 'General Aptitude';
}

async function questionCount(exam) {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM "${require('../models/AptitudeQuestion').tableName}" WHERE "exam" = $1`, [exam._id]);
    return rows[0]?.n || 0;
}

/** "Mon, 30 Nov · 10:00 AM – 11:00 AM" */
function when(exam) {
    const { start, end } = examWindow(exam);
    return `${day(start)} · ${clock(start)} – ${clock(end)}`;
}

// ── Who it goes to ────────────────────────────────────────────────────────────

/** Active students whose current section is one of the exam's sections. */
async function studentsOf(exam) {
    const ids = examSectionIds(exam);
    if (!ids.length) return [];
    const { rows } = await pool.query(
        `SELECT sp."user" AS id
           FROM "${require('../models/StudentProfile').tableName}" sp
           JOIN "${User.tableName}" u ON u."_id" = sp."user" AND COALESCE(u."isActive", true)
          WHERE sp."currentSection" = ANY($1::uuid[])`, [ids]);
    return rows.map(r => String(r.id));
}

/** Students who handed a paper in. */
async function sittersOf(exam) {
    const rows = await ExamAttempt.find({ exam: exam._id, status: { $in: FINISHED } }).select('student').lean();
    return [...new Set(rows.map(r => String(r.student)))];
}

/** Class teachers (and vice class teachers) of the exam's sections. */
async function classTeachersOf(exam) {
    const secs = await ClassSection.find({ _id: { $in: examSectionIds(exam) } }).select('classTeacher substituteTeacher').lean();
    return [...new Set(secs.flatMap(s => [s.classTeacher, s.substituteTeacher]).filter(Boolean).map(String))];
}

const senderOf = (req, exam) => ({
    sender: req?.userId || exam.resultApprovedBy || exam.createdBy,
    senderRole: req?.userRole || 'system',
});

/** Students and their parents; each parent's copy filed under their own child. */
async function family(studentIds) {
    return { recipients: await withParents(studentIds), about: studentIds };
}

// ── Request-driven notices ────────────────────────────────────────────────────

/** A draft went out: when it is, what it is. */
function published(exam, req) {
    later('published', async () => {
        const students = await studentsOf(exam);
        if (!students.length) return;
        const [subject, n] = await Promise.all([subjectName(exam), questionCount(exam)]);
        notify({
            school: exam.school, ...senderOf(req, exam), ...(await family(students)),
            title: `New aptitude exam: ${exam.title}`,
            body: `${subject} · ${when(exam)} · ${s_(n, 'question')}, ${s_(exam.totalMarks, 'mark')}, ${exam.duration} min. The paper opens at the start time.`,
            link: { type: 'aptitude.exam', entityId: exam._id },
        });
    });
}

/** Cancelled, or taken back to draft — everyone told it was coming hears it is not. */
function withdrawn(exam, req, kind) {
    later('withdrawn', async () => {
        const students = await studentsOf(exam);
        if (!students.length) return;
        const cancelled = kind === 'cancelled';
        notify({
            school: exam.school, ...senderOf(req, exam), ...(await family(students)),
            title: cancelled ? `Aptitude exam cancelled: ${exam.title}` : `Aptitude exam withdrawn: ${exam.title}`,
            body: cancelled
                ? `The exam set for ${when(exam)} has been cancelled.`
                : `The exam set for ${when(exam)} has been taken back for changes. You will be told when it is scheduled again.`,
            link: { type: 'aptitude.exam', entityId: exam._id },
        });
    });
}

/** The subject teacher confirmed the scores — the class teachers sign next. */
function scoresConfirmed(exam, req) {
    later('scores confirmed', async () => {
        const teachers = (await classTeachersOf(exam)).filter(id => id !== String(req?.userId));
        if (!teachers.length) return;
        notify({
            school: exam.school, ...senderOf(req, exam), recipients: teachers,
            title: `Results ready for your approval: ${exam.title}`,
            body: 'The subject teacher has confirmed the scores. Approve them to publish the results to students and parents.',
            link: { type: 'aptitude.approvals', entityId: exam._id },
        });
    });
}

/** A class teacher sent the results back — the author hears why. */
function resultsRejected(exam, req) {
    later('results rejected', async () => {
        if (!exam.createdBy || String(exam.createdBy) === String(req?.userId)) return;
        notify({
            school: exam.school, ...senderOf(req, exam), recipients: [exam.createdBy],
            title: `Results sent back: ${exam.title}`,
            body: exam.resultRejectionReason ? `Reason: ${exam.resultRejectionReason}` : 'The class teacher did not approve the results.',
            link: { type: 'aptitude.approvals', entityId: exam._id },
        });
    });
}

/**
 * Results out — told once, the moment they are visible. Called on release
 * (out now, or nothing yet if the publish date is ahead) and by the sweep on
 * the publish date. Claimed first, so a double call tells nobody twice.
 */
async function resultsNow(examId, req = null) {
    const { rows } = await pool.query(
        `UPDATE ${EXAMS} SET "resultsNotifiedAt" = now()
          WHERE "_id" = $1 AND "resultsNotifiedAt" IS NULL
            AND "resultApprovalStatus" = 'approved' AND "status" <> 'cancelled'
            AND ("resultPublishDate" IS NULL OR "resultPublishDate" <= now())
          RETURNING "_id"`, [examId]);
    if (!rows.length) return false;
    const exam = await AptitudeExam.findById(examId).lean();
    if (!exam) return false;
    const sat = await sittersOf(exam);
    if (!sat.length) return true;
    notify({
        school: exam.school, ...senderOf(req, exam), ...(await family(sat)),
        includeSender: !req,
        title: `Results out: ${exam.title}`,
        body: `The aptitude exam of ${when(exam).split(' · ')[0]} has been marked. Open it to see the score.`,
        link: { type: 'aptitude.result', entityId: exam._id },
    });
    return true;
}
const resultsIfDue = (examId, req) => later('results', () => resultsNow(examId, req));

// ── The clock ─────────────────────────────────────────────────────────────────

/** Claim one exam's `col`; true when this call is the one that tells. */
async function claim(id, col) {
    const { rows } = await pool.query(
        `UPDATE ${EXAMS} SET "${col}" = now() WHERE "_id" = $1 AND "${col}" IS NULL RETURNING "_id"`, [id]);
    return rows.length > 0;
}

/**
 * Every minute (server.js): exams that opened, exams that closed, results
 * whose publish date came. Each looks back no further than a day or two.
 */
async function sweep(now = new Date()) {
    let sent = 0;
    const { rows: near } = await pool.query(
        `SELECT * FROM ${EXAMS}
          WHERE "status" IN ('published', 'completed')
            AND ("openNotifiedAt" IS NULL OR "closeNotifiedAt" IS NULL)
            AND "examDate" BETWEEN $1::timestamptz - interval '3 days' AND $1::timestamptz + interval '1 day'`, [now]);

    for (const exam of near) {
        const { start, end } = examWindow(exam);
        const stage = examStage(exam, now);

        // Open now: students only — the parents were told when it was published.
        if (!exam.openNotifiedAt && exam.status === 'published' && start <= now && now < end && await claim(exam._id, 'openNotifiedAt')) {
            const students = await studentsOf(exam);
            if (students.length) {
                notify({
                    school: exam.school, sender: exam.createdBy, senderRole: 'system', recipients: students, includeSender: true,
                    title: `Aptitude exam open now: ${exam.title}`,
                    body: `Closes at ${clock(end)} — ${exam.duration} min once you start. Start it before then.`,
                    link: { type: 'aptitude.exam', entityId: exam._id },
                });
                sent += 1;
            }
        }

        // Closed: whoever signs the results next.
        if (!exam.closeNotifiedAt && stage === 'completed' && (end >= new Date(now - 24 * 3600 * 1000) || exam.status === 'completed')
            && exam.resultApprovalStatus !== 'approved' && await claim(exam._id, 'closeNotifiedAt')) {
            const author = exam.createdBy ? await User.findById(exam.createdBy).select('role').lean() : null;
            const teacherWrote = author?.role === 'teacher' && exam.subjectTeacherApprovalStatus !== 'approved';
            const recipients = teacherWrote ? [String(exam.createdBy)] : await classTeachersOf(exam);
            if (recipients.length) {
                notify({
                    school: exam.school, sender: exam.createdBy, senderRole: 'system', recipients, includeSender: true,
                    title: teacherWrote ? `Confirm the scores: ${exam.title}` : `Approve the results: ${exam.title}`,
                    body: teacherWrote
                        ? 'The exam has closed. Confirm the scores so the class teacher can publish the results.'
                        : 'The exam has closed. Approve the results to publish them to students and parents.',
                    link: { type: 'aptitude.approvals', entityId: exam._id },
                });
                sent += 1;
            }
        }
    }

    // Results whose publish date has come (or released while this was down).
    const { rows: due } = await pool.query(
        `SELECT "_id" FROM ${EXAMS}
          WHERE "resultApprovalStatus" = 'approved' AND "resultsNotifiedAt" IS NULL AND "status" <> 'cancelled'
            AND COALESCE("resultPublishDate", "resultApprovedAt") <= now()
            AND COALESCE("resultPublishDate", "resultApprovedAt") >= now() - interval '2 days'`);
    for (const r of due) if (await resultsNow(r._id)) sent += 1;
    return sent;
}

module.exports = { published, withdrawn, scoresConfirmed, resultsRejected, resultsIfDue, resultsNow, sweep };
