'use strict';
/**
 * Admin → Aptitude Exams.
 *
 * The landing page reads the school's whole exam calendar: five figures over
 * it, the next few exams, a period's completion and scores, and a filtered,
 * paged list whose rows each carry their audience, question count, roster size
 * and class average. All of that is counted in Postgres — through the ORM's
 * populate, `$lookup` runs in JavaScript (db/aggregate.js) and scoring a page of
 * exams would pull every attempt the school has ever recorded into the process.
 *
 * The row machinery lives in services/aptitudeRead.js (the teacher's board
 * reads the same rows). The teacher's handlers in aptitudeExam.controller.js
 * serve the question editor; admin routes reach them with `req.examScope = 'school'`.
 */
const XLSX             = require('xlsx');
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
    getActiveYear, examSectionIds, examWindow, examStage,
    SERVER_TZ, startSql, endSql, stageSql, sectionsSql, scoredAttemptsSql,
    questionFromRow,
} = require('../services/aptitudeExam');

const {
    T, PASS_RATIO, EXAM_BASE, averagesFor, fetchRows, CALENDAR_ORDER, listWhere,
    readForm, windowError, formMeta, publishReadinessFor, resolveYear, yearOptions,
} = require('../services/aptitudeRead');

const fail = (res, e) => res.status(500).json({ success: false, message: e.message });
const bad  = (res, message, extra = {}) => res.status(400).json({ success: false, message, ...extra });

// ── List ──────────────────────────────────────────────────────────────────────

exports.listExams = async (req, res) => {
    try {
        const page  = Math.max(1, Math.floor(Number(req.query.page) || 1));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 10)));
        // The current academic year unless another (or `all`) is asked for.
        const { yearId } = await resolveYear(req.schoolId, req.query.academicYear);
        const { params, where } = listWhere({ ...req.query, yearId });

        const [data, count] = await Promise.all([
            fetchRows({ schoolId: req.schoolId, where, params, order: CALENDAR_ORDER, limit, offset: (page - 1) * limit }),
            pool.query(`WITH ${EXAM_BASE} SELECT count(*)::int AS n FROM ex WHERE ${where}`,
                [String(req.schoolId), SERVER_TZ, ...params]),
        ]);
        const total = count.rows[0]?.n || 0;
        res.json({ success: true, data, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), academicYear: yearId || 'all' });
    } catch (e) { fail(res, e); }
};

// ── Overview: tiles, what is next, dropdown options ──────────────────────────

/** The year before the active one — the comparison the tiles draw. */
async function previousYear(schoolId, active) {
    if (!active) return null;
    return AcademicYear.findOne({ school: schoolId, endDate: { $lt: active.startDate } })
        .sort({ endDate: -1 }).lean();
}

const pctChange = (now, before) => (before ? Math.round(((now - before) / before) * 100) : null);

exports.getOverview = async (req, res) => {
    try {
        const school = String(req.schoolId);
        const active = await getActiveYear(req.schoolId);
        const prev   = await previousYear(req.schoolId, active);
        const yearIds = [active?._id, prev?._id].filter(Boolean).map(String);

        // Stage counts per academic year. With no active year every exam
        // counts, and there is nothing to compare against.
        const { rows: stageRows } = await pool.query(
            `WITH ${EXAM_BASE}
             SELECT ${active ? 'ex."academicYear"::text' : `'all'`} AS year,
                    count(*)::int                                                   AS total,
                    count(*) FILTER (WHERE ex.stage = 'draft')::int                 AS drafts,
                    count(*) FILTER (WHERE ex.stage = 'draft' AND
                        (SELECT count(*) FROM ${T.questions} q WHERE q."exam" = ex."_id") < ex."totalQuestions")::int AS need_questions,
                    count(*) FILTER (WHERE ex.stage IN ('scheduled', 'live'))::int  AS scheduled,
                    count(*) FILTER (WHERE ex.stage = 'live')::int                  AS live,
                    min(ex.start_ts) FILTER (WHERE ex.stage = 'scheduled')           AS next_start,
                    count(*) FILTER (WHERE ex.stage = 'completed')::int             AS completed,
                    count(*) FILTER (WHERE ex.stage = 'completed'
                        AND COALESCE(ex."resultApprovalStatus", 'pending') = 'pending')::int AS awaiting,
                    count(*) FILTER (WHERE ex.stage = 'cancelled')::int             AS cancelled
               FROM ex
              ${active ? 'WHERE ex."academicYear" = ANY($3::uuid[])' : ''}
              GROUP BY 1`,
            active ? [school, SERVER_TZ, yearIds] : [school, SERVER_TZ],
        );

        // Average score per year, over every finished attempt.
        const { rows: scoreRows } = await pool.query(
            `WITH ids AS (
                 SELECT array_agg("_id") AS exam_ids FROM ${T.exams}
                  WHERE "school" = $1 ${active ? 'AND "academicYear" = ANY($2::uuid[])' : ''}
             ), scored AS (${scoredAttemptsSql('(SELECT exam_ids FROM ids)', T)})
             SELECT ${active ? 'e."academicYear"::text' : `'all'`} AS year,
                    avg(s.score / NULLIF(e."totalMarks", 0) * 100)::float AS avg,
                    count(*)::int AS n
               FROM scored s JOIN ${T.exams} e ON e."_id" = s."exam"
              GROUP BY 1`,
            active ? [school, yearIds] : [school],
        );

        const cur  = active ? String(active._id) : 'all';
        const was  = prev ? String(prev._id) : null;
        const now  = stageRows.find(r => r.year === cur) || {};
        const then = was ? stageRows.find(r => r.year === was) || null : null;
        const sNow  = scoreRows.find(r => r.year === cur);
        const sThen = was ? scoreRows.find(r => r.year === was) : null;

        const tiles = {
            total:     { value: now.total || 0, change: then ? pctChange(now.total || 0, then.total) : null },
            drafts:    { value: now.drafts || 0, needQuestions: now.need_questions || 0 },
            scheduled: { value: now.scheduled || 0, live: now.live || 0, next: now.next_start || null },
            completed: {
                value: now.completed || 0,
                awaiting: now.awaiting || 0,
                change: then ? pctChange(now.completed || 0, then.completed) : null,
            },
            average: {
                value: sNow?.avg == null ? null : Math.round(sNow.avg),
                attempts: sNow?.n || 0,
                // Points, not percent: 60% → 66% is "+6", and "+10%" would say something else.
                change: sNow?.avg != null && sThen?.avg != null ? Math.round(sNow.avg - sThen.avg) : null,
            },
        };

        const upcoming = await fetchRows({
            schoolId: req.schoolId,
            where: `ex.stage IN ('draft', 'scheduled', 'live') AND ex.end_ts >= now()${active ? ' AND ex."academicYear" = $3::uuid' : ''}`,
            params: active ? [String(active._id)] : [],
            order: `(ex.stage = 'live') DESC, ex.start_ts ASC`,
            limit: 3,
        });

        // Dropdown options describe the school, not the current filter.
        const [{ rows: subjects }, { rows: classes }, { rows: general }] = await Promise.all([
            pool.query(
                `SELECT name FROM (
                     SELECT DISTINCT ON (lower(s."subjectName")) s."subjectName" AS name
                       FROM ${T.subjects} s
                      WHERE s."school" = $1 AND s."subjectName" IS NOT NULL AND (
                            ${active ? 's."academicYear" = $2::uuid OR' : ''}
                            EXISTS (SELECT 1 FROM ${T.exams} e WHERE e."subject" = s."_id"))
                      ORDER BY lower(s."subjectName")
                 ) x ORDER BY lower(name)`,
                active ? [school, String(active._id)] : [school],
            ),
            pool.query(
                `SELECT DISTINCT ON (c."classNumber") c."classNumber" AS num, c."className" AS name
                   FROM ${T.classes} c
                  WHERE c."school" = $1 AND c."classNumber" IS NOT NULL
                  ORDER BY c."classNumber", (c."academicYear" = $2::uuid) DESC`,
                [school, active ? String(active._id) : '00000000-0000-0000-0000-000000000000'],
            ),
            pool.query(`SELECT EXISTS (SELECT 1 FROM ${T.exams} WHERE "school" = $1 AND "subject" IS NULL) AS any`, [school]),
        ]);

        res.json({
            success: true,
            data: {
                academicYear: active ? { _id: active._id, name: active.yearName } : null,
                comparedWith: prev ? { _id: prev._id, name: prev.yearName } : null,
                tiles,
                upcoming,
                options: {
                    subjects: [
                        ...(general[0]?.any ? [{ value: '__general', label: 'General Aptitude' }] : []),
                        ...subjects.map(s => ({ value: s.name, label: s.name })),
                    ],
                    classes: classes.map(c => ({ value: String(c.num), label: c.name })),
                    academicYears: await yearOptions(req.schoolId),
                },
            },
        });
    } catch (e) { fail(res, e); }
};

// ── Insights: completion, average, recent exams ──────────────────────────────

const PERIODS = {
    year: 'This academic year',
    '90d': 'Last 90 days',
    '30d': 'Last 30 days',
    all:  'All time',
};

exports.getInsights = async (req, res) => {
    try {
        const period = PERIODS[req.query.period] ? req.query.period : 'year';
        const active = await getActiveYear(req.schoolId);

        const params = [];
        let where = `ex.stage = 'completed'`;
        if (period === 'year' && active) { params.push(String(active._id)); where += ` AND ex."academicYear" = $3::uuid`; }
        if (period === '90d') where += ` AND ex.start_ts >= now() - interval '90 days'`;
        if (period === '30d') where += ` AND ex.start_ts >= now() - interval '30 days'`;

        const closed = await fetchRows({ schoolId: req.schoolId, where, params, order: 'ex.start_ts DESC' });

        const submitted = closed.reduce((n, r) => n + r.submitted, 0);
        const eligible  = closed.reduce((n, r) => n + r.eligible, 0);

        // The average of every attempt, not the average of exam averages — a
        // quiz sat by six students must not weigh as much as one sat by 200.
        let average = null;
        if (closed.length) {
            const { rows } = await pool.query(
                `WITH scored AS (${scoredAttemptsSql('$1', T)})
                 SELECT avg(s.score / NULLIF(e."totalMarks", 0) * 100)::float AS avg
                   FROM scored s JOIN ${T.exams} e ON e."_id" = s."exam"`,
                [closed.map(r => r._id)],
            );
            average = rows[0]?.avg == null ? null : Math.round(rows[0].avg);
        }

        const recent = closed
            .filter(r => r.submitted > 0 && r.averageScore != null)
            .slice(0, 5)
            .reverse()
            .map(r => ({ _id: r._id, title: r.title, average: r.averageScore, submitted: r.submitted, date: r.startsAt }));

        res.json({
            success: true,
            data: {
                period,
                periods: Object.entries(PERIODS).map(([value, label]) => ({ value, label })),
                exams: closed.length,
                completion: { rate: eligible ? Math.round((submitted / eligible) * 100) : null, submitted, eligible },
                average,
                recent,
            },
        });
    } catch (e) { fail(res, e); }
};

// ── One exam ─────────────────────────────────────────────────────────────────

exports.getExam = async (req, res) => {
    try {
        const [row] = await fetchRows({
            schoolId: req.schoolId, where: 'ex."_id" = $3::uuid', params: [req.params.id], order: 'ex."_id"',
        });
        if (!row) return res.status(404).json({ success: false, message: 'Exam not found' });

        const [types, attempts, avgs, approvers] = await Promise.all([
            pool.query(
                `SELECT "questionType" AS type, count(*)::int AS n, COALESCE(sum("marks"), 0)::float AS marks
                   FROM ${T.questions} WHERE "exam" = $1 GROUP BY 1`,
                [row._id],
            ),
            pool.query(
                `SELECT count(*) FILTER (WHERE "status" = 'in_progress')::int    AS in_progress,
                        count(*) FILTER (WHERE "status" = 'submitted')::int      AS submitted,
                        count(*) FILTER (WHERE "status" = 'auto_submitted')::int AS auto_submitted,
                        COALESCE(sum("violationCount"), 0)::int                  AS violations
                   FROM ${T.attempts} WHERE "exam" = $1`,
                [row._id],
            ),
            averagesFor([row._id]),
            AptitudeExam.findById(row._id)
                .populate('subjectTeacherApprovedBy', 'name')
                .populate('resultApprovedBy', 'name')
                .lean(),
        ]);

        const a = avgs[String(row._id)] || {};
        const readiness = await publishReadinessFor(approvers);
        res.json({
            success: true,
            data: {
                ...row,
                readiness,
                questionTypes: types.rows,
                attempts: {
                    ...attempts.rows[0],
                    highest: a.high ?? null,
                    lowest: a.low ?? null,
                    passed: a.passed ?? 0,
                    passMark: Math.ceil(row.totalMarks * PASS_RATIO),
                },
                approval: {
                    subjectTeacher: {
                        status: approvers?.subjectTeacherApprovalStatus || 'pending',
                        by: approvers?.subjectTeacherApprovedBy?.name || null,
                        at: approvers?.subjectTeacherApprovedAt || null,
                    },
                    final: {
                        status: approvers?.resultApprovalStatus || 'pending',
                        by: approvers?.resultApprovedBy?.name || null,
                        at: approvers?.resultApprovedAt || null,
                    },
                },
            },
        });
    } catch (e) { fail(res, e); }
};

// ── The form ─────────────────────────────────────────────────────────────────

/** Sections and subjects of the active year — everything the Create Exam form offers. */
exports.getMeta = async (req, res) => {
    try {
        res.json({ success: true, data: await formMeta(req.schoolId) });
    } catch (e) { fail(res, e); }
};

exports.createExam = async (req, res) => {
    try {
        const { fields, error } = await readForm(req);
        if (error) return bad(res, error);
        const late = windowError(fields);
        if (late) return bad(res, late);

        const exam = await AptitudeExam.create({
            ...fields,
            maxViolations: fields.maxViolations || 3,
            school: req.schoolId,
            createdBy: req.userId,
            status: 'draft',
        });
        res.status(201).json({ success: true, data: exam });
    } catch (e) { fail(res, e); }
};

exports.updateExam = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status !== 'draft')
            return bad(res, 'Only a draft can be edited — move it back to draft first');

        const { fields, error } = await readForm(req, { partial: true });
        if (error) return bad(res, error);
        const late = windowError({ ...exam.toObject?.() ?? exam, ...fields });
        if (late) return bad(res, late);

        Object.assign(exam, fields);
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { fail(res, e); }
};

exports.deleteExam = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        const attempts = await ExamAttempt.countDocuments({ exam: exam._id });
        // Nothing cascades in the database. A draft has no attempts to lose; a
        // cancelled exam nobody sat is equally safe. Anything else is a record.
        if (!(exam.status === 'draft' || (exam.status === 'cancelled' && attempts === 0)))
            return bad(res, 'Only a draft, or a cancelled exam nobody sat, can be deleted');

        await Promise.all([
            AptitudeQuestion.deleteMany({ exam: exam._id }),
            ExamAttempt.deleteMany({ exam: exam._id }),
        ]);
        await AptitudeExam.deleteOne({ _id: exam._id });
        res.json({ success: true });
    } catch (e) { fail(res, e); }
};

/**
 * A copy, as a draft, with every question.
 *
 * Sections from an earlier year are carried to this year's section of the same
 * class number and name — last year's "Class 9 – A" row is not where anyone
 * sits this year. The date moves to tomorrow when the original's has passed.
 */
exports.duplicateExam = async (req, res) => {
    try {
        const src = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!src) return res.status(404).json({ success: false, message: 'Exam not found' });
        const active = await getActiveYear(req.schoolId);
        if (!active) return bad(res, 'There is no active academic year');

        let sections = examSectionIds(src);
        const { rows: mapped } = await pool.query(
            `SELECT DISTINCT ON (old."_id") old."_id" AS old_id, cur."_id" AS new_id
               FROM ${T.sections} old
               JOIN ${T.classes} oc  ON oc."_id" = old."class"
               JOIN ${T.classes} nc  ON nc."school" = oc."school" AND nc."classNumber" = oc."classNumber" AND nc."academicYear" = $2::uuid
               JOIN ${T.sections} cur ON cur."class" = nc."_id" AND lower(cur."sectionName") = lower(old."sectionName")
              WHERE old."_id" = ANY($1::uuid[])`,
            [sections, String(active._id)],
        );
        const carried = sections.map(id => mapped.find(m => String(m.old_id) === id)?.new_id).filter(Boolean).map(String);
        if (carried.length) sections = [...new Set(carried)];

        let examDate = src.examDate;
        if (examWindow(src).end <= new Date()) {
            const t = new Date();
            examDate = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate() + 1));
        }

        const copy = await AptitudeExam.create({
            school: req.schoolId,
            section: sections[0],
            sections,
            academicYear: active._id,
            subject: src.subject || null,
            createdBy: req.userId,
            title: `${src.title} (Copy)`.slice(0, 200),
            examDate,
            startTime: src.startTime,
            duration: src.duration,
            totalQuestions: src.totalQuestions,
            totalMarks: src.totalMarks,
            maxViolations: src.maxViolations || 3,
            status: 'draft',
        });

        const questions = await AptitudeQuestion.find({ exam: src._id }).sort({ order: 1 }).lean();
        if (questions.length) {
            await AptitudeQuestion.insertMany(questions.map((q, i) => ({
                exam: copy._id, school: req.schoolId,
                questionText: q.questionText, questionType: q.questionType,
                options: q.options || [], correctAnswers: q.correctAnswers || [],
                marks: q.marks, order: i + 1,
            })));
        }
        res.status(201).json({ success: true, data: { ...copy.toObject?.() ?? copy, questionCount: questions.length } });
    } catch (e) { fail(res, e); }
};

/** Back to draft, so it can be edited. Only before anyone has opened it. */
exports.unpublishExam = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (examStage(exam) !== 'scheduled') return bad(res, 'Only a scheduled exam that has not opened can go back to draft');
        const attempts = await ExamAttempt.countDocuments({ exam: exam._id });
        if (attempts) return bad(res, 'Students have already started this exam');
        exam.status = 'draft';
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { fail(res, e); }
};

/** Withdraw a scheduled or running exam. Students stop seeing it at once. */
exports.cancelExam = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (!['scheduled', 'live'].includes(examStage(exam))) return bad(res, 'Only a scheduled or live exam can be cancelled');
        exam.status = 'cancelled';
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { fail(res, e); }
};

/**
 * Release or withhold a closed exam's results.
 *
 * The school's own sign-off, standing in for both approval steps — an exam
 * the admin wrote has no subject teacher to approve it first, and one a
 * teacher wrote can be released without waiting on them. Whoever signed is
 * recorded on both steps that were still open.
 */
exports.decideResults = async (req, res) => {
    try {
        const { action, reason, publishDate } = req.body || {};
        if (!['release', 'withhold'].includes(action)) return bad(res, 'Choose release or withhold');

        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (examStage(exam) !== 'completed') return bad(res, 'Results can be released once the exam has closed');

        const now = new Date();
        if (exam.subjectTeacherApprovalStatus !== 'approved') {
            exam.subjectTeacherApprovalStatus = 'approved';
            exam.subjectTeacherApprovedBy = req.userId;
            exam.subjectTeacherApprovedAt = now;
        }
        exam.resultApprovedBy = req.userId;
        exam.resultApprovedAt = now;

        if (action === 'release') {
            let when = null;
            if (publishDate) {
                when = new Date(publishDate);
                if (Number.isNaN(when.getTime())) return bad(res, 'That publish date is not a date');
            }
            exam.resultApprovalStatus = 'approved';
            exam.resultPublishDate = when;
            exam.resultRejectionReason = '';
        } else {
            exam.resultApprovalStatus = 'rejected';
            exam.resultRejectionReason = String(reason || '').trim();
        }
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { fail(res, e); }
};

// ── Question import ──────────────────────────────────────────────────────────

const TEMPLATE_ROWS = [
    { Question: 'If 3x + 5 = 20, what is x?', Type: 'single', 'Option A': '3', 'Option B': '5', 'Option C': '7', 'Option D': '15', Correct: 'B', Marks: 1 },
    { Question: 'Which of these are prime numbers?', Type: 'multiple', 'Option A': '2', 'Option B': '9', 'Option C': '11', 'Option D': '15', Correct: 'A, C', Marks: 2 },
    { Question: 'Every square is a rectangle.', Type: 'true_false', 'Option A': '', 'Option B': '', 'Option C': '', 'Option D': '', Correct: 'True', Marks: 1 },
];

exports.getQuestionTemplate = async (req, res) => {
    try {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(TEMPLATE_ROWS), 'Questions');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
            ['Column', 'What to put there'],
            ['Question', 'The question text. Required.'],
            ['Type', 'single, multiple or true_false. Leave blank to infer it from Correct.'],
            ['Option A – Option F', 'Up to six options. Single and multiple choice need at least two. Leave blank for true_false.'],
            ['Correct', 'Letters of the correct options — "B", or "A, C" for multiple choice. True or False for true_false.'],
            ['Marks', 'Marks for a fully correct answer, 0.5 or more. Defaults to 1.'],
        ]), 'How to fill');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="aptitude_questions_template.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (e) { fail(res, e); }
};

/**
 * Questions from a spreadsheet into a draft.
 *
 * `?preview=1` runs every check and writes nothing — the same code path as the
 * real import, so the preview is what will land. A question already in the
 * exam (same text, ignoring case and spacing), or repeated in the sheet, is
 * skipped and reported rather than added twice.
 */
exports.importQuestions = async (req, res) => {
    try {
        if (!req.file) return bad(res, 'Choose a spreadsheet to import');
        // Teachers import into their own drafts; the admin routes set examScope.
        const exam = await AptitudeExam.findOne({
            _id: req.params.id, school: req.schoolId,
            ...(req.examScope === 'school' ? {} : { createdBy: req.userId }),
        }).lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status !== 'draft') return bad(res, 'Questions can only be added to a draft');

        let rows;
        try {
            const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
            rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        } catch {
            return bad(res, 'That file could not be read as a spreadsheet');
        }
        rows = rows.filter(r => Object.values(r).some(v => String(v).trim() !== ''));
        if (!rows.length) return bad(res, 'The sheet has no rows');
        if (rows.length > 500) return bad(res, 'Import at most 500 questions at a time');

        const existing = await AptitudeQuestion.find({ exam: exam._id }).select('questionText marks order').lean();
        const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
        const seen = new Set(existing.map(q => norm(q.questionText)));

        const valid = [];
        const errors = [];
        // The exam publishes only at exactly its set number of questions, so rows
        // past the room left are refused rather than imported and then in the way.
        const room = Math.max(0, exam.totalQuestions - existing.length);
        rows.forEach((row, i) => {
            const line = i + 2; // the header is row 1
            const { question, error } = questionFromRow(row);
            if (error) { errors.push({ row: line, message: error }); return; }
            const key = norm(question.questionText);
            if (seen.has(key)) { errors.push({ row: line, message: 'Already in this exam — skipped', duplicate: true }); return; }
            if (valid.length >= room) {
                errors.push({ row: line, message: `Over the exam’s ${exam.totalQuestions} questions — skipped`, overflow: true });
                return;
            }
            seen.add(key);
            valid.push({ ...question, row: line });
        });

        const existingMarks = existing.reduce((n, q) => n + (Number(q.marks) || 0), 0);
        const addedMarks = valid.reduce((n, q) => n + q.marks, 0);
        const summary = {
            room,
            total: rows.length,
            valid: valid.length,
            invalid: errors.length,
            errors,
            existing: existing.length,
            required: exam.totalQuestions,
            after: existing.length + valid.length,
            marksAfter: existingMarks + addedMarks,
            totalMarks: exam.totalMarks,
        };

        if (req.query.preview === '1') {
            return res.json({
                success: true,
                data: {
                    ...summary,
                    preview: true,
                    rows: valid.slice(0, 50).map(q => ({
                        row: q.row, questionText: q.questionText, questionType: q.questionType,
                        options: q.options.map(o => o.text), correct: q.correctAnswers, marks: q.marks,
                    })),
                },
            });
        }

        if (!valid.length) return bad(res, 'No rows could be imported', { data: summary });

        let order = existing.reduce((n, q) => Math.max(n, Number(q.order) || 0), 0);
        await AptitudeQuestion.insertMany(valid.map(({ row, ...q }) => ({
            ...q, exam: exam._id, school: req.schoolId, order: ++order,
        })));
        res.json({ success: true, data: { ...summary, imported: valid.length } });
    } catch (e) { fail(res, e); }
};

// Exposed for the verification script.

