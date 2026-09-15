'use strict';
/**
 * The aptitude exam reads the admin and teacher screens share: one exam as a
 * row (stage, window, audience, questions, roster, class average, results), the
 * filter bar as SQL, the Create Exam form's checks and options, and whether an
 * exam is ready to publish.
 *
 * Counted in Postgres rather than through the ORM — populate runs its $lookup
 * in JavaScript (db/aggregate.js), and scoring a page of exams that way pulls
 * every attempt the school has recorded into the process.
 */
const pool             = require('../db/pool');
const AptitudeExam     = require('../models/AptitudeExam');
const AptitudeQuestion = require('../models/AptitudeQuestion');
const ExamAttempt      = require('../models/ExamAttempt');
const AcademicYear     = require('../models/AcademicYear');
const ClassSection     = require('../models/ClassSection');
const Class            = require('../models/Class');
const Subject          = require('../models/Subject');
const StudentProfile   = require('../models/StudentProfile');
const User             = require('../models/User');
const {
    getActiveYear, examSectionIds, examWindow,
    SERVER_TZ, startSql, endSql, stageSql, sectionsSql, scoredAttemptsSql,
    publishReadiness, answerKeyProblems,
} = require('./aptitudeExam');

const qt = (Model) => `"${Model.tableName}"`;
const T = {
    exams:     qt(AptitudeExam),
    questions: qt(AptitudeQuestion),
    attempts:  qt(ExamAttempt),
    sections:  qt(ClassSection),
    classes:   qt(Class),
    subjects:  qt(Subject),
    profiles:  qt(StudentProfile),
    users:     qt(User),
    years:     qt(AcademicYear),
};

/** A pass mark, as the student's own result page applies it (aptitudeExam.controller getStudentResult). */
const PASS_RATIO = 0.4;

// ── The rows ──────────────────────────────────────────────────────────────────

/**
 * Every exam in the school with its stage, window and sections resolved.
 * `$1` is the school, `$2` the server's zone; filters number from `$3`.
 */
const EXAM_BASE = `
    ex AS (
        SELECT e.*,
               ${stageSql('e', '$2')}    AS stage,
               ${startSql('e', '$2')}    AS start_ts,
               ${endSql('e', '$2')}      AS end_ts,
               ${sectionsSql('e')}       AS secs,
               sub."subjectName"         AS subject_name
          FROM ${T.exams} e
          LEFT JOIN ${T.subjects} sub ON sub."_id" = e."subject"
         WHERE e."school" = $1
    )`;

/**
 * What each listed row carries beyond its own columns.
 *
 * `eligible` is the students who can sit it now UNION those who already did:
 * a class moves up a year and its roster empties, and an exam sat by forty
 * students must not report a roster of zero — or a completion rate over 100%.
 * Twin of the student side's own gate, which reads `StudentProfile.currentSection`.
 */
const ROW_SELECT = `
    SELECT ex."_id", ex."title", ex."status", ex.stage, ex.start_ts, ex.end_ts,
           ex."examDate", ex."startTime", ex."duration", ex."totalQuestions", ex."totalMarks",
           ex."maxViolations", ex."resultApprovalStatus", ex."resultPublishDate",
           ex."resultRejectionReason", ex."subjectTeacherApprovalStatus",
           ex."subject", ex.subject_name, ex."academicYear", ex."createdAt", ex."updatedAt",
           cu."_id" AS creator_id, cu."name" AS creator_name, cu."role" AS creator_role,
           aud.list AS section_list,
           COALESCE(qc.n, 0)     AS question_count,
           COALESCE(qc.marks, 0) AS question_marks,
           COALESCE(att.started, 0)   AS started,
           COALESCE(att.submitted, 0) AS submitted,
           COALESCE(ros.n, 0)         AS eligible
      FROM ex
      LEFT JOIN ${T.users} cu ON cu."_id" = ex."createdBy"
      LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
                     '_id', s."_id", 'sectionName', s."sectionName",
                     'className', c."className", 'classNumber', c."classNumber")
                 ORDER BY c."classNumber", s."sectionName") AS list
            FROM jsonb_array_elements_text(ex.secs) t(id)
            JOIN ${T.sections} s ON s."_id" = t.id::uuid
            LEFT JOIN ${T.classes} c ON c."_id" = s."class"
      ) aud ON true
      LEFT JOIN LATERAL (
          SELECT count(*)::int AS n, COALESCE(sum(q."marks"), 0)::float AS marks
            FROM ${T.questions} q WHERE q."exam" = ex."_id"
      ) qc ON true
      LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE a."status" <> 'not_started')::int                     AS started,
                 count(*) FILTER (WHERE a."status" IN ('submitted', 'auto_submitted'))::int  AS submitted
            FROM ${T.attempts} a WHERE a."exam" = ex."_id"
      ) att ON true
      LEFT JOIN LATERAL (
          SELECT count(*)::int AS n FROM (
              SELECT sp."user" AS u
                FROM ${T.profiles} sp
                JOIN ${T.users} su ON su."_id" = sp."user" AND COALESCE(su."isActive", true)
               WHERE sp."currentSection" IN (SELECT t.id::uuid FROM jsonb_array_elements_text(ex.secs) t(id))
              UNION
              SELECT a."student" FROM ${T.attempts} a WHERE a."exam" = ex."_id"
          ) r
      ) ros ON true`;

/** Class averages (percent of the exam's total marks) for a set of exams. */
async function averagesFor(ids) {
    if (!ids.length) return {};
    const { rows } = await pool.query(
        `WITH scored AS (${scoredAttemptsSql('$1', T)})
         SELECT s."exam", avg(s.score / NULLIF(e."totalMarks", 0) * 100)::float AS avg,
                max(s.score)::float AS high, min(s.score)::float AS low,
                count(*) FILTER (WHERE s.score >= e."totalMarks" * ${PASS_RATIO})::int AS passed
           FROM scored s JOIN ${T.exams} e ON e."_id" = s."exam"
          GROUP BY s."exam"`,
        [ids],
    );
    return Object.fromEntries(rows.map(r => [String(r.exam), r]));
}

/**
 * Who an exam is for, in words.
 *
 * `short` is the table's CLASSES cell ("9 – 10"), `label` the chip ("Classes
 * 9 – 10"), `items` every section for the tooltip and the drawer. A range is
 * only written as a range when every class in it is there; otherwise the
 * numbers are listed.
 */
function audienceOf(list) {
    const secs = Array.isArray(list) ? list : [];
    if (!secs.length) return { short: '—', label: 'No sections', items: [], classes: 0 };

    const items = secs.map(s => `${s.className || 'Class'} – ${s.sectionName}`);
    const classes = [];
    for (const s of secs) {
        let c = classes.find(x => x.name === s.className);
        if (!c) classes.push(c = { name: s.className || '', num: s.classNumber, sections: [] });
        c.sections.push(s.sectionName);
    }

    if (classes.length === 1) {
        const c = classes[0];
        const which = c.sections.length > 3 ? `${c.sections.length} sections` : c.sections.join(', ');
        return { short: `${String(c.name).replace(/^class\s+/i, '')} · ${which}`, label: `${c.name} · ${which}`, items, classes: 1 };
    }

    const nums = classes.map(c => c.num);
    const numeric = nums.every(n => Number.isFinite(n)) && classes.every(c => /\d/.test(c.name));
    if (!numeric) {
        const names = classes.map(c => c.name).join(', ');
        return { short: names, label: names, items, classes: classes.length };
    }
    const sorted = [...nums].sort((a, b) => a - b);
    const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
    const span = contiguous ? `${sorted[0]} – ${sorted[sorted.length - 1]}` : sorted.join(', ');
    return { short: span, label: `Classes ${span}`, items, classes: classes.length };
}

/**
 * Where an exam's results stand. Only a closed exam has any.
 *   awaiting   closed, nobody has released them
 *   scheduled  released, with a publish date still ahead
 *   released   students and parents can see them
 *   withheld   rejected at approval
 */
function resultsOf(r, avg) {
    if (r.stage !== 'completed') return { state: 'none' };
    const base = { average: avg?.avg == null ? null : Math.round(avg.avg) };
    if (r.resultApprovalStatus === 'approved') {
        const when = r.resultPublishDate ? new Date(r.resultPublishDate) : null;
        return when && when > new Date()
            ? { ...base, state: 'scheduled', publishDate: when }
            : { ...base, state: 'released', publishDate: when };
    }
    if (r.resultApprovalStatus === 'rejected') return { ...base, state: 'withheld', reason: r.resultRejectionReason || '' };
    return { ...base, state: 'awaiting' };
}

/**
 * One row, in the shape the page reads.
 *
 * `section`, `class`, `createdBy`, `questionCount` and `attemptCount` are kept
 * at the names the Expo app's admin exam list already reads
 * (Nexora-Hives/app/modules/admin/exams.tsx).
 */
function shapeRow(r, avg) {
    const list = Array.isArray(r.section_list) ? r.section_list : [];
    const first = list[0] || null;
    return {
        _id: r._id,
        title: r.title,
        status: r.status,
        stage: r.stage,
        examDate: r.examDate,
        startTime: r.startTime,
        startsAt: r.start_ts,
        endsAt: r.end_ts,
        duration: r.duration,
        totalQuestions: r.totalQuestions,
        totalMarks: r.totalMarks,
        maxViolations: r.maxViolations,
        subject: r.subject ? { _id: r.subject, subjectName: r.subject_name || '' } : null,
        subjectName: r.subject_name || null,
        sections: list,
        section: first ? { _id: first._id, sectionName: first.sectionName } : null,
        class: first ? { className: first.className } : null,
        audience: audienceOf(list),
        questionCount: r.question_count,
        questionMarks: r.question_marks,
        attemptCount: r.started,
        submitted: r.submitted,
        eligible: r.eligible,
        averageScore: avg?.avg == null ? null : Math.round(avg.avg),
        // Answer keys are checked when the questions are written (checkQuestion),
        // so the list's reading counts and marks only; publishing re-checks all.
        readiness: publishReadiness({
            totalQuestions: r.totalQuestions,
            totalMarks: r.totalMarks,
            questionCount: r.question_count,
            questionMarks: r.question_marks,
            answerKeyProblems: 0,
            endsAt: r.end_ts,
            sectionCount: list.length,
        }),
        results: resultsOf(r, avg),
        resultApprovalStatus: r.resultApprovalStatus,
        subjectTeacherApprovalStatus: r.subjectTeacherApprovalStatus,
        resultPublishDate: r.resultPublishDate,
        academicYear: r.academicYear,
        createdBy: r.creator_id ? { _id: r.creator_id, name: r.creator_name, role: r.creator_role } : null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
    };
}

/** Rows for a WHERE over `ex`, shaped and averaged. */
async function fetchRows({ schoolId, where = 'true', params = [], order, limit, offset = 0 }) {
    const all = [String(schoolId), SERVER_TZ, ...params];
    let sql = `WITH ${EXAM_BASE} ${ROW_SELECT} WHERE ${where} ORDER BY ${order}`;
    if (limit) {
        all.push(limit, offset);
        sql += ` LIMIT $${all.length - 1} OFFSET $${all.length}`;
    }
    const { rows } = await pool.query(sql, all);
    const avgs = await averagesFor(rows.map(r => r._id));
    return rows.map(r => shapeRow(r, avgs[String(r._id)]));
}

/**
 * Nearest first while an exam is still ahead or running, then most recent
 * first once it is over — the order an admin reads a calendar in.
 */
const CALENDAR_ORDER = `
    (ex.stage IN ('completed', 'cancelled') OR ex.end_ts < now()) ASC,
    CASE WHEN NOT (ex.stage IN ('completed', 'cancelled') OR ex.end_ts < now()) THEN ex.start_ts END ASC,
    ex.start_ts DESC, ex."createdAt" DESC`;

const STAGES = ['draft', 'scheduled', 'live', 'completed', 'cancelled'];

/** The filter bar as a WHERE over `ex`. Shared by the list and its total. */
function listWhere(q) {
    const params = [];
    const where  = [];
    const p = (v) => { params.push(v); return `$${params.length + 2}`; };

    // One stage, several ("scheduled,live"), or "upcoming": anything not yet closed.
    const stages = String(q.stage || '').split(',').filter(s => STAGES.includes(s));
    if (q.stage === 'upcoming') where.push(`ex.stage IN ('draft', 'scheduled', 'live') AND ex.end_ts >= now()`);
    else if (stages.length) where.push(`ex.stage = ANY(${p(stages)}::text[])`);

    if (q.subject === '__general') where.push('ex."subject" IS NULL');
    else if (q.subject) where.push(`lower(ex.subject_name) = lower(${p(String(q.subject))})`);

    if (q.classNumber !== undefined && q.classNumber !== '' && Number.isFinite(Number(q.classNumber))) {
        // By class NUMBER, not class id: a class row exists once per academic
        // year, and "Class 9" in the filter means every year's Class 9.
        where.push(`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(ex.secs) t(id)
              JOIN ${T.sections} s ON s."_id" = t.id::uuid
              JOIN ${T.classes} c  ON c."_id" = s."class"
             WHERE c."classNumber" = ${p(Number(q.classNumber))}::float8)`);
    }

    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (day.test(q.from || '')) where.push(`(ex."examDate" AT TIME ZONE 'UTC')::date >= ${p(q.from)}::date`);
    if (day.test(q.to || ''))   where.push(`(ex."examDate" AT TIME ZONE 'UTC')::date <= ${p(q.to)}::date`);

    const search = String(q.search || '').trim();
    if (search) {
        const s = p(`%${search}%`);
        where.push(`(ex."title" ILIKE ${s} OR ex.subject_name ILIKE ${s})`);
    }
    // Already resolved by resolveYear(): an id, or null for every year.
    if (q.yearId) where.push(`ex."academicYear" = ${p(String(q.yearId))}::uuid`);

    return { params, where: where.length ? where.join(' AND ') : 'true' };
}

/**
 * The form's body, checked. Returns `{ fields }` or `{ error }`.
 * `sectionIds` must all be active sections of THIS school in the active year,
 * and — when `allowedSections` is given (a teacher) — sections from that list.
 */
async function readForm(req, { partial = false, allowedSections = null } = {}) {
    const b = { ...(req.body || {}) };
    // The teacher's form (and the mobile app) have always posted one `sectionId`.
    if (b.sectionIds === undefined && b.sectionId !== undefined) b.sectionIds = b.sectionId ? [b.sectionId] : [];
    const fields = {};

    if (!partial || b.title !== undefined) {
        const title = String(b.title || '').trim();
        if (!title) return { error: 'Give the exam a title' };
        if (title.length > 200) return { error: 'Keep the title under 200 characters' };
        fields.title = title;
    }

    if (!partial || b.sectionIds !== undefined) {
        const ids = [...new Set((Array.isArray(b.sectionIds) ? b.sectionIds : []).map(String).filter(Boolean))];
        if (!ids.length) return { error: 'Choose at least one class section' };
        const active = await getActiveYear(req.schoolId);
        if (!active) return { error: 'There is no active academic year' };
        let found;
        try {
            found = await ClassSection.find({ _id: { $in: ids }, school: req.schoolId, academicYear: active._id }).lean();
        } catch { found = []; }
        if (found.length !== ids.length) return { error: 'One of the chosen sections is not in this academic year' };
        // A teacher sets exams only for sections they are class teacher of or teach.
        if (allowedSections && ids.some(id => !allowedSections.includes(id)))
            return { error: 'You can only set exams for sections you teach' };
        fields.sections = ids;
        fields.section = ids[0];
        fields.academicYear = active._id;
    }

    if (!partial || b.subjectId !== undefined) {
        if (b.subjectId) {
            let subject = null;
            try { subject = await Subject.findOne({ _id: b.subjectId, school: req.schoolId }).lean(); } catch { /* bad id */ }
            if (!subject) return { error: 'That subject was not found' };
            fields.subject = subject._id;
        } else {
            fields.subject = null;
        }
    }

    if (!partial || b.examDate !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.examDate || '')) || Number.isNaN(new Date(b.examDate).getTime()))
            return { error: 'Pick the exam date' };
        fields.examDate = new Date(b.examDate);
    }
    if (!partial || b.startTime !== undefined) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(b.startTime || ''));
        if (!m || +m[1] > 23 || +m[2] > 59) return { error: 'Pick the start time' };
        fields.startTime = `${m[1].padStart(2, '0')}:${m[2]}`;
    }

    const num = (key, label, min, max) => {
        if (partial && b[key] === undefined) return null;
        const n = Number(b[key]);
        if (!Number.isFinite(n) || n < min || n > max) return `${label} must be between ${min} and ${max}`;
        fields[key] = n;
        return null;
    };
    const numErr = num('duration', 'Duration (minutes)', 1, 600)
        || num('totalQuestions', 'Total questions', 1, 500)
        || num('totalMarks', 'Total marks', 1, 10000)
        || (b.maxViolations === undefined || b.maxViolations === '' ? null : num('maxViolations', 'Allowed violations', 1, 20));
    if (numErr) return { error: numErr };
    if (fields.duration !== undefined && !Number.isInteger(fields.duration)) return { error: 'Duration is a whole number of minutes' };
    if (fields.totalQuestions !== undefined && !Number.isInteger(fields.totalQuestions)) return { error: 'Total questions is a whole number' };

    return { fields };
}

/** An exam that closes before it is created is not an exam anyone can sit. */
function windowError(exam) {
    const { end } = examWindow(exam);
    return end <= new Date() ? 'That date and time have already passed — pick a later slot' : null;
}


// ── Who may read an exam, and how it was answered ───────────────────────────
// Shared by the teacher's exam endpoints and the analytics.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sections this teacher is class teacher (or substitute) of, any year. */
async function classTeacherSections(req) {
    const ids = await ClassSection.find({
        school: req.schoolId,
        $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
    }).distinct('_id');
    return ids.map(String);
}

/**
 * An exam this person may read, and in what capacity.
 *
 * A teacher reads the exams they wrote and the exams set for a section they are
 * class teacher of. These reads carry answer keys and every student's answers,
 * and used to be open to any teacher in the school who knew an exam's id.
 */
async function readableExam(req, id = req.params.id) {
    if (!UUID.test(String(id || ''))) return null;
    const exam = await AptitudeExam.findOne({ _id: id, school: req.schoolId }).lean();
    if (!exam) return null;
    const isAuthor = String(exam.createdBy) === String(req.userId);
    if (req.examScope === 'school') return { exam, isAuthor, isClassTeacher: false };
    const own = await classTeacherSections(req);
    const isClassTeacher = examSectionIds(exam).some(s => own.includes(s));
    return isAuthor || isClassTeacher ? { exam, isAuthor, isClassTeacher } : null;
}

/**
 * Each question marked against one set of answers — the same all-or-nothing
 * rule as scoreAttempt(), which it must always agree with.
 */
function grade(questions, answers) {
    const ansMap = Object.fromEntries((answers || []).map(a => [String(a.question), a.selectedOptions || []]));
    let score = 0; let correct = 0; let incorrect = 0; let unanswered = 0;
    const items = [...questions].sort((a, b) => (a.order || 0) - (b.order || 0)).map(q => {
        const selected = ansMap[String(q._id)] || [];
        const key = q.correctAnswers || [];
        const isCorrect = selected.length === key.length && key.every(c => selected.includes(c)) && selected.every(x => key.includes(x));
        if (isCorrect) { score += q.marks; }
        if (!selected.length) unanswered += 1;
        else if (isCorrect) correct += 1;
        else incorrect += 1;
        return { ...q, selected, isCorrect, earnedMarks: isCorrect ? q.marks : 0 };
    });
    return { score, correct, incorrect, unanswered, items };
}

const pctOf = (score, total) => (total ? Math.round((score / total) * 100) : 0);
const passMarkOf = (exam) => Math.ceil((Number(exam.totalMarks) || 0) * PASS_RATIO);

/** Results are visible once approved and on or after their publish date. */
const resultsOut = (exam, now = new Date()) =>
    exam.resultApprovalStatus === 'approved' && (!exam.resultPublishDate || new Date(exam.resultPublishDate) <= now);

/** Students who can sit an exam now: an active account whose current section is one of its sections. */
async function rosterOf(exam) {
    const { rows } = await pool.query(
        `SELECT u."_id", u."name", u."email", u."profileImage" AS photo, sp."rollNumber",
                c."className" || ' – ' || s."sectionName" AS "className"
           FROM ${T.profiles} sp
           JOIN ${T.users} u    ON u."_id" = sp."user" AND COALESCE(u."isActive", true)
           LEFT JOIN ${T.sections} s ON s."_id" = sp."currentSection"
           LEFT JOIN ${T.classes} c  ON c."_id" = s."class"
          WHERE sp."currentSection" = ANY($1::uuid[])
          ORDER BY c."classNumber", s."sectionName", sp."rollNumber" NULLS LAST, u."name"`,
        [examSectionIds(exam)],
    );
    return rows;
}


// ── Academic year ────────────────────────────────────────────────────────────

const UUID_RE = UUID;

/**
 * Which academic year a list shows. Nothing asked for — or `current` — means
 * the active year: an exam list is read for the year the school is in, and
 * last year's papers are one pick away, not mixed in. `all` means every year.
 * Returns `{ yearId }` (null = all years) and the active year row.
 */
async function resolveYear(schoolId, raw) {
    const active = await getActiveYear(schoolId);
    const v = String(raw || '').trim();
    if (v === 'all') return { yearId: null, active };
    if (UUID_RE.test(v)) return { yearId: v, active };
    return { yearId: active ? String(active._id) : null, active };
}

/**
 * The academic years a year picker offers — every year of the school, newest
 * first, each with how many exams it holds under `where` (the reader's own
 * scope; `$1` school, `$2` zone, extra params from `$3`).
 */
async function yearOptions(schoolId, { where = 'true', params = [] } = {}) {
    const { rows } = await pool.query(
        `WITH ${EXAM_BASE}
         SELECT y."_id", y."yearName" AS name, y."status", y."startDate",
                (SELECT count(*)::int FROM ex WHERE ex."academicYear" = y."_id" AND ${where}) AS count
           FROM ${T.years} y
          WHERE y."school" = $1
          ORDER BY y."startDate" DESC`,
        [String(schoolId), SERVER_TZ, ...params],
    );
    return rows.map(r => ({ _id: r._id, name: r.name, current: r.status === 'active', count: r.count }));
}

// ── The form's options ───────────────────────────────────────────────────────

/**
 * Classes of the active year with their sections and how many students sit in
 * each — what the Create Exam form's section picker draws. `onlySections`
 * narrows it to a teacher's own.
 */
async function formMeta(schoolId, { onlySections = null } = {}) {
    const active = await getActiveYear(schoolId);
    if (!active) return { academicYear: null, classes: [], subjects: [] };

    const secFilter = { school: schoolId, academicYear: active._id, status: 'active' };
    if (onlySections) secFilter._id = { $in: onlySections.length ? onlySections : ['00000000-0000-0000-0000-000000000000'] };

    const [classes, sections, subjects] = await Promise.all([
        Class.find({ school: schoolId, academicYear: active._id }).lean(),
        ClassSection.find(secFilter).lean(),
        Subject.find({ school: schoolId, academicYear: active._id }).sort('subjectName').lean(),
    ]);

    const { rows: counts } = await pool.query(
        `SELECT sp."currentSection" AS id, count(*)::int AS n
           FROM ${T.profiles} sp JOIN ${T.users} u ON u."_id" = sp."user" AND COALESCE(u."isActive", true)
          WHERE sp."currentSection" = ANY($1::uuid[]) GROUP BY 1`,
        [sections.map(s => s._id)],
    );
    const students = Object.fromEntries(counts.map(c => [String(c.id), c.n]));

    const byName = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
    return {
        academicYear: { _id: active._id, name: active.yearName },
        classes: classes
            .sort((a, b) => (a.classNumber ?? 0) - (b.classNumber ?? 0) || byName(a.className, b.className))
            .map(c => ({
                _id: c._id,
                className: c.className,
                classNumber: c.classNumber,
                sections: sections
                    .filter(s => String(s.class) === String(c._id))
                    .sort((a, b) => byName(a.sectionName, b.sectionName))
                    .map(s => ({ _id: s._id, sectionName: s.sectionName, students: students[String(s._id)] || 0 })),
            }))
            .filter(c => c.sections.length),
        subjects: subjects.map(s => ({ _id: s._id, subjectName: s.subjectName })),
    };
}

// ── Ready to publish? ────────────────────────────────────────────────────────

/** Everything publishReadiness() needs about one exam, read fresh. */
async function publishReadinessFor(exam) {
    const questions = await AptitudeQuestion.find({ exam: exam._id }).lean();
    return publishReadiness({
        totalQuestions: exam.totalQuestions,
        totalMarks: exam.totalMarks,
        questionCount: questions.length,
        questionMarks: questions.reduce((n, q) => n + (Number(q.marks) || 0), 0),
        answerKeyProblems: answerKeyProblems(questions),
        endsAt: examWindow(exam).end,
        sectionCount: examSectionIds(exam).length,
    });
}

module.exports = {
    T, PASS_RATIO, EXAM_BASE, ROW_SELECT, averagesFor, audienceOf, resultsOf, shapeRow, fetchRows,
    CALENDAR_ORDER, STAGES, listWhere, readForm, windowError, formMeta, publishReadinessFor,
    resolveYear, yearOptions,
    classTeacherSections, readableExam, grade, pctOf, passMarkOf, resultsOut, rosterOf, UUID,
};
