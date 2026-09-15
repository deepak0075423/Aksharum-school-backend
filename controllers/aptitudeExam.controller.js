'use strict';
/**
 * Aptitude exams — the teacher, student and parent sides (the admin screen is
 * aptitudeAdmin.controller.js). The admin routes also reach the question
 * handlers here, with `req.examScope = 'school'`.
 *
 * Every response below keeps the fields it always had — the Expo app reads
 * these endpoints — and adds what the web screens need beside them.
 */
const pool             = require('../db/pool');
const AptitudeExam     = require('../models/AptitudeExam');
const AptitudeQuestion = require('../models/AptitudeQuestion');
const ExamAttempt      = require('../models/ExamAttempt');
const ClassSection     = require('../models/ClassSection');
const StudentProfile   = require('../models/StudentProfile');
const ParentProfile    = require('../models/ParentProfile');

const {
    shuffle, scoreAttempt, examSectionIds, reachesSection,
    checkQuestion, examStage, examWindow,
} = require('../services/aptitudeExam');
const { teacherExamScope, examPermissionError, scopeForForm } = require('../services/examPermissions');
const {
    T, PASS_RATIO, fetchRows, CALENDAR_ORDER, readForm, windowError, formMeta, publishReadinessFor,
    resolveYear, yearOptions,
    classTeacherSections, readableExam, grade, pctOf, passMarkOf, resultsOut, rosterOf,
} = require('../services/aptitudeRead');

// ── Helpers ───────────────────────────────────────────────────────────────────

const fail = (res, e) => res.status(500).json({ success: false, message: e.message });
const bad  = (res, message, extra = {}) => res.status(400).json({ success: false, message, ...extra });
const notFound = (res, message = 'Exam not found') => res.status(404).json({ success: false, message });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINISHED = ['submitted', 'auto_submitted'];

/**
 * The exam a write may touch. A teacher reaches only exams they wrote; the
 * admin routes set `req.examScope = 'school'` (routes/api/admin.js) and reach
 * any exam in the school — the same handlers serve both.
 */
const ownExam = (req, id = req.params.id) => ({
    _id: id,
    school: req.schoolId,
    ...(req.examScope === 'school' ? {} : { createdBy: req.userId }),
});

/** One exam as the teacher's board row, merged over its raw columns. */
async function rowFor(req, id) {
    const [row] = await fetchRows({ schoolId: req.schoolId, where: 'ex."_id" = $3::uuid', params: [id], order: 'ex."_id"' });
    return row || null;
}

// ── Teacher: the board ────────────────────────────────────────────────────────

/**
 * Exams the Create Exam form may target, grouped the way its picker draws them
 * — plus the flat `sections` list older clients read.
 */
exports.getExamMeta = async (req, res) => {
    try {
        // Only the sections this teacher leads or teaches, each with the
        // subjects they may set an exam in — see services/examPermissions.js.
        const meta = scopeForForm(await teacherExamScope(req.schoolId, req.userId));
        const sections = meta.classes.flatMap(c => c.sections.map(s => ({
            _id: s._id, sectionName: s.sectionName, students: s.students, class: { _id: c._id, className: c.className },
        })));
        res.json({ success: true, data: { ...meta, sections } });
    } catch (e) { fail(res, e); }
};

/** The plain list, as it has always been shaped (the mobile app reads it). */
exports.getTeacherExams = async (req, res) => {
    try {
        const own = await classTeacherSections(req);
        const orConds = [{ createdBy: req.userId }];
        if (own.length) orConds.push({ section: { $in: own } }, { sections: { $in: own } });

        const filter = { school: req.schoolId, $or: orConds };
        if (req.query.status) filter.status = req.query.status;

        const exams = await AptitudeExam.find(filter)
            .populate('section',     'sectionName')
            .populate('subject',     'subjectName')
            .populate('academicYear','yearName')
            .sort({ examDate: -1 })
            .lean();

        const examIds = exams.map(e => e._id);
        const qCounts = await AptitudeQuestion.aggregate([
            { $match: { exam: { $in: examIds } } },
            { $group: { _id: '$exam', count: { $sum: 1 } } },
        ]);
        const qMap = Object.fromEntries(qCounts.map(q => [q._id.toString(), q.count]));
        const data = exams.map(e => ({ ...e, stage: examStage(e), questionCount: qMap[e._id.toString()] || 0 }));

        res.json({ success: true, data });
    } catch (e) { fail(res, e); }
};

/** What this teacher still has to do about a closed exam's results, if anything. */
function resultTask(row, { isAuthor, isClassTeacher }) {
    if (row.stage !== 'completed') return null;
    const step1 = row.subjectTeacherApprovalStatus === 'approved';
    const authorIsTeacher = row.createdBy?.role === 'teacher';
    if (isAuthor && authorIsTeacher && !step1) return 'subject';
    if (isClassTeacher && (step1 || !authorIsTeacher) && row.resultApprovalStatus !== 'approved') return 'final';
    return null;
}

/**
 * Everything the teacher's landing page draws, in one read: every exam they
 * wrote or that reaches a section they class-teach, each as the same row the
 * admin list shows, plus the figures over them.
 */
exports.getTeacherBoard = async (req, res) => {
    try {
        const own = await classTeacherSections(req);
        const mine = `(ex."createdBy" = $3::uuid
                     OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(ex.secs) t(id) WHERE t.id = ANY($4::text[])))`;
        const scope = [String(req.userId), own];

        // The current academic year unless another (or `all`) is asked for.
        const { yearId } = await resolveYear(req.schoolId, req.query.year);
        const [rows, years] = await Promise.all([
            fetchRows({
                schoolId: req.schoolId,
                where: yearId ? `${mine} AND ex."academicYear" = $5::uuid` : mine,
                params: yearId ? [...scope, yearId] : scope,
                order: CALENDAR_ORDER,
                limit: 500,
            }),
            yearOptions(req.schoolId, { where: mine, params: scope }),
        ]);

        const exams = rows.map((r) => {
            const isAuthor = String(r.createdBy?._id) === String(req.userId);
            const isClassTeacher = r.sections.some(s => own.includes(String(s._id)));
            return { ...r, isAuthor, isClassTeacher, task: resultTask(r, { isAuthor, isClassTeacher }) };
        });

        const closed = exams.filter(e => e.stage === 'completed' && e.submitted > 0 && e.averageScore != null);
        const sat = closed.reduce((n, e) => n + e.submitted, 0);
        res.json({
            success: true,
            data: {
                exams,
                academicYear: yearId || 'all',
                academicYears: years,
                tiles: {
                    total: exams.length,
                    authored: exams.filter(e => e.isAuthor).length,
                    drafts: exams.filter(e => e.stage === 'draft' && e.isAuthor).length,
                    notReady: exams.filter(e => e.stage === 'draft' && e.isAuthor && !e.readiness.ready).length,
                    scheduled: exams.filter(e => ['scheduled', 'live'].includes(e.stage)).length,
                    live: exams.filter(e => e.stage === 'live').length,
                    tasks: exams.filter(e => e.task).length,
                    // Weighted by who sat each exam, so a quiz of six does not count as much as one of sixty.
                    average: sat ? Math.round(closed.reduce((n, e) => n + e.averageScore * e.submitted, 0) / sat) : null,
                },
            },
        });
    } catch (e) { fail(res, e); }
};

// ── Teacher: exam CRUD ────────────────────────────────────────────────────────

exports.createExam = async (req, res) => {
    try {
        const { fields, error } = await readForm(req);
        if (error) return bad(res, error);
        // Class / vice class teacher: any subject of their class. Subject
        // teacher: only a subject they are assigned to in that section.
        const denied = examPermissionError(await teacherExamScope(req.schoolId, req.userId), fields.sections, fields.subject);
        if (denied) return res.status(403).json({ success: false, message: denied });
        const late = windowError(fields);
        if (late) return bad(res, late);

        const exam = await AptitudeExam.create({
            ...fields, maxViolations: fields.maxViolations || 3,
            school: req.schoolId, createdBy: req.userId, status: 'draft',
        });
        res.status(201).json({ success: true, data: exam });
    } catch (e) { fail(res, e); }
};

/**
 * One exam: its raw columns (as before), the board row over them, and what the
 * reader may do with it — including whether it is ready to publish and, if not,
 * what is missing.
 */
exports.getExamDetail = async (req, res) => {
    try {
        const hit = await readableExam(req);
        if (!hit) return notFound(res);
        const [raw, row, readiness] = await Promise.all([
            AptitudeExam.findById(hit.exam._id)
                .populate('section', 'sectionName').populate('subject', 'subjectName')
                .populate('academicYear', 'yearName').populate('createdBy', 'name role')
                .lean(),
            rowFor(req, hit.exam._id),
            publishReadinessFor(hit.exam),
        ]);
        res.json({
            success: true,
            data: {
                ...raw, ...row,
                academicYear: raw.academicYear,
                createdBy: raw.createdBy,
                readiness,
                isAuthor: hit.isAuthor,
                isClassTeacher: hit.isClassTeacher,
                canManage: hit.isAuthor || req.examScope === 'school',
                passMark: passMarkOf(raw),
                task: row ? resultTask(row, hit) : null,
            },
        });
    } catch (e) { fail(res, e); }
};

exports.updateExam = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne(ownExam(req));
        if (!exam) return notFound(res);
        if (exam.status !== 'draft') return bad(res, 'Only draft exams can be edited');

        const { fields, error } = await readForm(req, { partial: true });
        if (error) return bad(res, error);
        // Checked on what the exam will be after the edit — changing only the
        // subject must not slip past a section the teacher does not teach it in.
        const merged = { ...(exam.toObject?.() ?? exam), ...fields };
        const denied = examPermissionError(
            await teacherExamScope(req.schoolId, req.userId),
            fields.sections || examSectionIds(merged),
            fields.subject !== undefined ? fields.subject : merged.subject,
        );
        if (denied) return res.status(403).json({ success: false, message: denied });
        const late = windowError(merged);
        if (late) return bad(res, late);

        Object.assign(exam, fields);
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { fail(res, e); }
};

exports.deleteExam = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne(ownExam(req));
        if (!exam) return notFound(res);
        if (exam.status !== 'draft') return bad(res, 'Only draft exams can be deleted');
        await Promise.all([
            AptitudeQuestion.deleteMany({ exam: exam._id }),
            ExamAttempt.deleteMany({ exam: exam._id }),
        ]);
        await AptitudeExam.deleteOne({ _id: exam._id });
        res.json({ success: true });
    } catch (e) { fail(res, e); }
};

/**
 * Publish a draft — only when publishReadiness() finds nothing missing. The
 * refusal names every missing piece (`readiness.checks`), not just the first,
 * so the screen can tick off exactly what is left.
 */
exports.publishExam = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne(ownExam(req));
        if (!exam) return notFound(res);
        if (exam.status !== 'draft') return bad(res, 'Only draft exams can be published');

        const readiness = await publishReadinessFor(exam);
        if (!readiness.ready) return bad(res, readiness.message, { readiness });

        exam.status = 'published';
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { fail(res, e); }
};

// ── Questions ────────────────────────────────────────────────────────────────

exports.getQuestions = async (req, res) => {
    try {
        const hit = await readableExam(req);
        if (!hit) return notFound(res);
        const questions = await AptitudeQuestion.find({ exam: hit.exam._id }).sort({ order: 1 }).lean();
        res.json({ success: true, data: questions });
    } catch (e) { fail(res, e); }
};

exports.addQuestion = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne(ownExam(req));
        if (!exam) return notFound(res);
        if (exam.status !== 'draft') return bad(res, 'Cannot add questions to a published exam');

        // The exam is set for a number of questions and publishes only at exactly
        // that number — a question past it is one that would have to come out again.
        const count = await AptitudeQuestion.countDocuments({ exam: exam._id });
        if (count >= exam.totalQuestions) {
            return bad(res, `This exam is set for ${exam.totalQuestions} question${exam.totalQuestions === 1 ? '' : 's'} and has them all — delete one, or raise the total in Edit exam`);
        }

        const { question, error } = checkQuestion(req.body);
        if (error) return bad(res, error);

        const lastQ = await AptitudeQuestion.findOne({ exam: exam._id }).sort({ order: -1 }).lean();
        const q = await AptitudeQuestion.create({ ...question, exam: exam._id, school: req.schoolId, order: (lastQ?.order || 0) + 1 });
        res.status(201).json({ success: true, data: q });
    } catch (e) { fail(res, e); }
};

exports.updateQuestion = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne(ownExam(req));
        if (!exam) return notFound(res);
        if (exam.status !== 'draft') return bad(res, 'Cannot edit questions of a published exam');

        const current = await AptitudeQuestion.findOne({ _id: req.params.qid, exam: exam._id }).lean();
        if (!current) return notFound(res, 'Question not found');

        // The edit is checked as the whole question it leaves behind — changing
        // the type to single choice while two answers stay ticked used to save.
        const pick = (k) => (req.body[k] !== undefined ? req.body[k] : current[k]);
        const { question, error } = checkQuestion({
            questionText: pick('questionText'), questionType: pick('questionType'),
            options: pick('options'), correctAnswers: pick('correctAnswers'), marks: pick('marks'),
        });
        if (error) return bad(res, error);

        const q = await AptitudeQuestion.findOneAndUpdate({ _id: current._id, exam: exam._id }, question, { new: true }).lean();
        if (!q) return notFound(res, 'Question not found');
        res.json({ success: true, data: q });
    } catch (e) { fail(res, e); }
};

exports.deleteQuestion = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne(ownExam(req));
        if (!exam) return notFound(res);
        if (exam.status !== 'draft') return bad(res, 'Cannot delete questions of a published exam');

        const q = await AptitudeQuestion.findOneAndDelete({ _id: req.params.qid, exam: exam._id });
        if (!q) return notFound(res, 'Question not found');
        res.json({ success: true });
    } catch (e) { fail(res, e); }
};

// ── Teacher: submissions & analytics ─────────────────────────────────────────

/**
 * Every attempt, and — new — every student on the roster who has not opened
 * the exam at all. An attempt row only exists once a student starts, so the
 * list used to be silent about exactly the students a teacher needs to chase.
 */
exports.getSubmissions = async (req, res) => {
    try {
        const hit = await readableExam(req);
        if (!hit) return notFound(res);
        const { exam } = hit;

        const [questions, attempts, roster] = await Promise.all([
            AptitudeQuestion.find({ exam: exam._id }).lean(),
            ExamAttempt.find({ exam: exam._id }).populate('student', 'name email profileImage').lean(),
            rosterOf(exam),
        ]);
        const byId = Object.fromEntries(roster.map(s => [String(s._id), s]));

        // Roll number and class live on StudentProfile, not User — the old
        // populate asked User for `rollNumber` and always got nothing.
        const strays = attempts.map(a => String(a.student?._id || a.student)).filter(id => !byId[id]);
        if (strays.length) {
            const { rows } = await pool.query(
                `SELECT sp."user" AS id, sp."rollNumber", c."className" || ' – ' || s."sectionName" AS "className"
                   FROM ${T.profiles} sp
                   LEFT JOIN ${T.sections} s ON s."_id" = sp."currentSection"
                   LEFT JOIN ${T.classes} c  ON c."_id" = s."class"
                  WHERE sp."user" = ANY($1::uuid[])`, [strays]);
            rows.forEach(r => { byId[String(r.id)] = { ...(byId[String(r.id)] || {}), rollNumber: r.rollNumber, className: r.className }; });
        }

        const passMark = passMarkOf(exam);
        const data = attempts.map(a => {
            const sid = String(a.student?._id || a.student);
            const done = FINISHED.includes(a.status);
            const score = done ? scoreAttempt(questions, a.answers) : null;
            return {
                _id:            a._id,
                student:        { ...(a.student || {}), rollNumber: byId[sid]?.rollNumber || '', className: byId[sid]?.className || '' },
                status:         a.status,
                startedAt:      a.startedAt,
                submittedAt:    a.submittedAt,
                violationCount: a.violationCount,
                score,
                percentage:     done ? pctOf(score, exam.totalMarks) : null,
                passed:         done ? score >= passMark : null,
                answered:       (a.answers || []).filter(x => (x.selectedOptions || []).length).length,
                timeTaken:      a.startedAt && a.submittedAt ? new Date(a.submittedAt) - new Date(a.startedAt) : null,
            };
        });

        const started = new Set(attempts.map(a => String(a.student?._id || a.student)));
        const notAttempted = roster.filter(s => !started.has(String(s._id)));

        res.json({
            success: true,
            data,
            totalMarks: exam.totalMarks,
            passMark,
            totalQuestions: questions.length,
            eligible: roster.length + data.filter(d => !roster.some(s => String(s._id) === String(d.student?._id))).length,
            notAttempted,
            stage: examStage(exam),
        });
    } catch (e) { fail(res, e); }
};

exports.getStudentResponse = async (req, res) => {
    try {
        const hit = await readableExam(req);
        if (!hit) return notFound(res);
        const { exam } = hit;
        if (!UUID.test(String(req.params.studentId || ''))) return notFound(res, 'No attempt found');

        const attempt = await ExamAttempt.findOne({ exam: exam._id, student: req.params.studentId })
            .populate('student', 'name email').lean();
        if (!attempt) return notFound(res, 'No attempt found');

        const questions = await AptitudeQuestion.find({ exam: exam._id }).lean();
        const g = grade(questions, attempt.answers || []);
        const profile = await StudentProfile.findOne({ user: req.params.studentId }).select('rollNumber').lean();

        res.json({
            success: true,
            data: {
                attempt,
                questions: g.items,
                score: g.score,
                totalMarks: exam.totalMarks,
                percentage: pctOf(g.score, exam.totalMarks),
                passed: g.score >= passMarkOf(exam),
                passMark: passMarkOf(exam),
                correct: g.correct, incorrect: g.incorrect, unanswered: g.unanswered,
                student: { ...(attempt.student || {}), rollNumber: profile?.rollNumber || '' },
                timeTaken: attempt.startedAt && attempt.submittedAt ? new Date(attempt.submittedAt) - new Date(attempt.startedAt) : null,
            },
        });
    } catch (e) { fail(res, e); }
};

const BANDS = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 101]];

exports.getAnalytics = async (req, res) => {
    try {
        const hit = await readableExam(req);
        if (!hit) return notFound(res);
        const { exam } = hit;

        const [attempts, questions] = await Promise.all([
            ExamAttempt.find({ exam: exam._id }).lean(),
            AptitudeQuestion.find({ exam: exam._id }).sort({ order: 1 }).lean(),
        ]);

        const submitted = attempts.filter(a => FINISHED.includes(a.status));
        const scores    = submitted.map(a => scoreAttempt(questions, a.answers));
        const avg       = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : 0;
        const passMark  = passMarkOf(exam);

        const qStats = questions.map((q, i) => {
            let correct = 0; let unanswered = 0;
            for (const a of submitted) {
                const ans = (a.answers || []).find(x => String(x.question) === String(q._id));
                const sel = ans?.selectedOptions || [];
                const cor = q.correctAnswers || [];
                if (!sel.length) unanswered += 1;
                if (sel.length === cor.length && cor.every(c => sel.includes(c)) && sel.every(s => cor.includes(s))) correct += 1;
            }
            return {
                question: q._id, questionText: q.questionText, attemptedBy: submitted.length, correctCount: correct,
                number: i + 1, questionType: q.questionType, marks: q.marks, unanswered,
                incorrect: submitted.length - correct - unanswered,
                successRate: submitted.length ? Math.round((correct / submitted.length) * 100) : null,
            };
        });

        res.json({
            success: true,
            data: {
                totalStudents: attempts.length,
                submitted: submitted.length,
                notStarted: attempts.filter(a => a.status === 'not_started').length,
                avgScore: Math.round(avg * 100) / 100,
                highest: scores.length ? Math.max(...scores) : 0,
                lowest: scores.length ? Math.min(...scores) : 0,
                passed: scores.filter(s => s >= passMark).length,
                questionStats: qStats,
                // Added for the redesigned page.
                totalMarks: exam.totalMarks,
                passMark,
                averagePct: scores.length ? pctOf(avg, exam.totalMarks) : null,
                distribution: BANDS.map(([lo, hi]) => ({
                    label: hi > 100 ? `${lo}–100%` : `${lo}–${hi - 1}%`,
                    count: scores.filter(s => { const p = exam.totalMarks ? (s / exam.totalMarks) * 100 : 0; return p >= lo && p < hi; }).length,
                })),
            },
        });
    } catch (e) { fail(res, e); }
};

// ── Teacher: two-step result approval ────────────────────────────────────────

exports.getResultApproval = async (req, res) => {
    try {
        const hit = await readableExam(req);
        if (!hit) return notFound(res);
        const [exam, row] = await Promise.all([
            AptitudeExam.findById(hit.exam._id)
                .populate('subjectTeacherApprovedBy', 'name')
                .populate('resultApprovedBy', 'name')
                .populate('createdBy', 'name role')
                .lean(),
            rowFor(req, hit.exam._id),
        ]);
        const stage = examStage(exam);
        const authorIsTeacher = exam.createdBy?.role === 'teacher';
        const step1 = exam.subjectTeacherApprovalStatus === 'approved';
        res.json({
            success: true,
            data: {
                ...exam,
                stage,
                averageScore: row?.averageScore ?? null,
                submitted: row?.submitted ?? 0,
                eligible: row?.eligible ?? 0,
                permissions: {
                    isAuthor: hit.isAuthor,
                    isClassTeacher: hit.isClassTeacher,
                    // An exam the school office wrote has no subject teacher to sign first.
                    needsSubjectStep: authorIsTeacher,
                    canSubjectApprove: hit.isAuthor && authorIsTeacher && stage === 'completed' && !step1,
                    canFinalApprove: hit.isClassTeacher && stage === 'completed' && (step1 || !authorIsTeacher)
                        && exam.resultApprovalStatus !== 'approved',
                },
            },
        });
    } catch (e) { fail(res, e); }
};

exports.subjectApproveResults = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne(ownExam(req));
        if (!exam) return notFound(res);
        // By the clock, not the stored status: `status` only becomes 'completed'
        // when EVERY enrolled student submits, so one absentee used to lock the
        // results of the whole class out of approval for good.
        if (examStage(exam) !== 'completed') return bad(res, 'Exam must be completed first');

        exam.subjectTeacherApprovalStatus = 'approved';
        exam.subjectTeacherApprovedBy     = req.userId;
        exam.subjectTeacherApprovedAt     = new Date();
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { fail(res, e); }
};

/**
 * The class teacher's final say. Only a class teacher (or substitute) of one
 * of the exam's sections may give it — this used to accept any teacher in the
 * school. (An author who is also that section's class teacher may give both
 * steps: in a small school the class teacher often writes the paper.)
 */
exports.approveResults = async (req, res) => {
    try {
        const { action, reason, resultPublishDate } = req.body || {};
        if (!['approve', 'reject'].includes(action)) return bad(res, 'Choose approve or reject');

        const hit = await readableExam(req);
        if (!hit) return notFound(res);
        if (!hit.isClassTeacher) return res.status(403).json({ success: false, message: 'Only the class teacher of this exam’s section can give final approval' });

        const exam = await AptitudeExam.findById(hit.exam._id);
        if (examStage(exam) !== 'completed') return bad(res, 'Exam must be completed first');
        const author = await require('../models/User').findById(exam.createdBy).select('role').lean();
        const authorIsTeacher = author?.role === 'teacher';
        if (authorIsTeacher && exam.subjectTeacherApprovalStatus !== 'approved')
            return bad(res, 'Subject teacher must approve first');
        if (action === 'reject' && !String(reason || '').trim()) return bad(res, 'Give a reason for rejecting');

        const now = new Date();
        if (!authorIsTeacher && exam.subjectTeacherApprovalStatus !== 'approved') {
            exam.subjectTeacherApprovalStatus = 'approved';
            exam.subjectTeacherApprovedBy = req.userId;
            exam.subjectTeacherApprovedAt = now;
        }
        exam.resultApprovedBy = req.userId;
        exam.resultApprovedAt = now;
        if (action === 'approve') {
            exam.resultApprovalStatus = 'approved';
            exam.resultRejectionReason = '';
            exam.resultPublishDate = resultPublishDate ? new Date(resultPublishDate) : null;
        } else {
            exam.resultApprovalStatus  = 'rejected';
            exam.resultRejectionReason = String(reason).trim();
        }
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { fail(res, e); }
};

// ── Student ──────────────────────────────────────────────────────────────────

/** How many questions each exam holds, in one query. */
async function questionCounts(examIds) {
    if (!examIds.length) return {};
    const { rows } = await pool.query(
        `SELECT "exam", count(*)::int AS n FROM ${T.questions} WHERE "exam" = ANY($1::uuid[]) GROUP BY 1`, [examIds]);
    return Object.fromEntries(rows.map(r => [String(r.exam), r.n]));
}

/**
 * A student's exams: everything published to their section, with where each
 * stands for them. Added beside the old fields: `stage`, `opensAt`/`closesAt`,
 * `questionCount`, `resultsReleased` and — once released — their `result`.
 *
 * Reads 'completed' exams too. An exam is flipped to completed the moment the
 * last student submits, and it used to vanish from every student's list at
 * that instant — result and all.
 */
exports.getStudentExams = async (req, res) => {
    try {
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        if (!profile?.currentSection) return res.json({ success: true, data: [] });

        const exams = await AptitudeExam.find({
            school: req.schoolId, status: { $in: ['published', 'completed'] }, ...reachesSection(profile.currentSection),
        })
            .populate('subject',     'subjectName')
            .populate('academicYear','yearName')
            .sort({ examDate: -1 })
            .lean();

        const examIds = exams.map(e => e._id);
        const [attempts, counts] = await Promise.all([
            ExamAttempt.find({ student: req.userId, exam: { $in: examIds } }).select('exam status submittedAt startedAt answers').lean(),
            questionCounts(examIds),
        ]);
        const attemptMap = Object.fromEntries(attempts.map(a => [String(a.exam), a]));

        const released = exams.filter(e => resultsOut(e) && FINISHED.includes(attemptMap[String(e._id)]?.status));
        const qByExam = {};
        if (released.length) {
            (await AptitudeQuestion.find({ exam: { $in: released.map(e => e._id) } }).lean())
                .forEach(q => { (qByExam[String(q.exam)] = qByExam[String(q.exam)] || []).push(q); });
        }

        const now = new Date();
        const data = exams.map(e => {
            const a = attemptMap[String(e._id)];
            const { start, end } = examWindow(e);
            const out = resultsOut(e, now);
            let result = null;
            if (out && a && FINISHED.includes(a.status)) {
                const g = grade(qByExam[String(e._id)] || [], a.answers);
                result = { score: g.score, percentage: pctOf(g.score, e.totalMarks), passed: g.score >= passMarkOf(e), correct: g.correct };
            }
            return {
                ...e,
                attempt: a ? { _id: a._id, exam: a.exam, status: a.status, submittedAt: a.submittedAt, startedAt: a.startedAt } : null,
                canAttempt: e.status === 'published' && now >= start && now <= end,
                stage: examStage(e, now),
                opensAt: start,
                closesAt: end,
                questionCount: counts[String(e._id)] || 0,
                resultsReleased: out,
                resultPublishDate: e.resultPublishDate,
                result,
            };
        });
        res.json({ success: true, data });
    } catch (e) { fail(res, e); }
};

exports.getAttemptExam = async (req, res) => {
    try {
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        if (!profile?.currentSection) return res.status(400).json({ success: false, message: 'Not enrolled in a section' });

        const exam = await AptitudeExam.findOne({
            _id: req.params.id, school: req.schoolId, status: 'published', ...reachesSection(profile.currentSection),
        }).lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        const now = new Date();
        // The same window every list and stage reads. Building it by hand here
        // skipped the zero-pad, so a "9:05" start made an Invalid Date — and
        // both time checks below then passed at any hour.
        const { start: examStart, end: examEnd } = examWindow(exam);

        let attempt = await ExamAttempt.findOne({ exam: exam._id, student: req.userId });

        if (attempt && ['submitted','auto_submitted'].includes(attempt.status))
            return res.status(400).json({ success: false, message: 'Exam already submitted' });

        if (now > examEnd && !attempt)
            return res.status(400).json({ success: false, message: 'Exam time has ended' });

        if (!attempt) {
            if (now < examStart) return res.status(400).json({ success: false, message: 'Exam has not started yet' });

            const questions    = await AptitudeQuestion.find({ exam: exam._id }).lean();
            const shuffledQs   = shuffle(questions);
            const questionOrder = shuffledQs.map(q => q._id);
            const optionOrders  = shuffledQs.map(q => ({
                question: q._id,
                options:  shuffle(q.options || []),
            }));
            const serverEndTime = new Date(Math.min(
                now.getTime() + exam.duration * 60 * 1000,
                examEnd.getTime()
            ));
            attempt = await ExamAttempt.create({
                exam: exam._id, student: req.userId, school: req.schoolId,
                section: profile.currentSection,
                questionOrder, optionOrders, answers: [],
                startedAt: now, serverEndTime, status: 'in_progress',
            });
        }

        const qMap = {};
        const allQuestions = await AptitudeQuestion.find({ exam: exam._id }).lean();
        allQuestions.forEach(q => { qMap[q._id.toString()] = q; });

        const shuffledQuestions = attempt.questionOrder.map(qid => {
            const q       = qMap[qid.toString()];
            if (!q) return null;
            const optOrder = attempt.optionOrders.find(o => o.question.toString() === qid.toString());
            return {
                _id:          q._id,
                questionText: q.questionText,
                questionType: q.questionType,
                marks:        q.marks,
                options:      optOrder ? optOrder.options : q.options,
            };
        }).filter(Boolean);

        res.json({
            success: true,
            data: {
                exam:          {
                    _id: exam._id, title: exam.title, totalMarks: exam.totalMarks, duration: exam.duration, maxViolations: exam.maxViolations,
                    // Added for the redesigned attempt screen.
                    subjectName: (await require('../models/Subject').findById(exam.subject).select('subjectName').lean())?.subjectName || null,
                    closesAt: examEnd,
                },
                questions:     shuffledQuestions,
                savedAnswers:  attempt.answers || [],
                startedAt:     attempt.startedAt,
                serverEndTime: attempt.serverEndTime,
                violationCount:attempt.violationCount,
            },
        });
    } catch (e) { fail(res, e); }
};

exports.saveAnswer = async (req, res) => {
    try {
        const { questionId, selectedOptions } = req.body;
        const attempt = await ExamAttempt.findOne({ exam: req.params.id, student: req.userId, status: 'in_progress' });
        if (!attempt) return res.status(404).json({ success: false, message: 'No active attempt found' });

        if (new Date() > attempt.serverEndTime) {
            attempt.status      = 'auto_submitted';
            attempt.submittedAt = attempt.serverEndTime;
            await attempt.save();
            return res.status(400).json({ success: false, message: 'Time ended — auto submitted' });
        }

        const idx = attempt.answers.findIndex(a => a.question.toString() === questionId);
        if (idx >= 0) {
            attempt.answers[idx].selectedOptions = selectedOptions;
            attempt.answers[idx].savedAt         = new Date();
        } else {
            attempt.answers.push({ question: questionId, selectedOptions, savedAt: new Date() });
        }
        attempt.markModified('answers');
        await attempt.save();
        res.json({ success: true });
    } catch (e) { fail(res, e); }
};

exports.logViolation = async (req, res) => {
    try {
        const attempt = await ExamAttempt.findOne({ exam: req.params.id, student: req.userId, status: 'in_progress' });
        if (!attempt) return res.status(404).json({ success: false, message: 'No active attempt' });

        const exam = await AptitudeExam.findById(req.params.id).lean();
        attempt.violationCount += 1;
        const autoSubmit = attempt.violationCount >= (exam?.maxViolations || 3);
        if (autoSubmit) {
            attempt.status      = 'auto_submitted';
            attempt.submittedAt = new Date();
        }
        await attempt.save();
        res.json({ success: true, violationCount: attempt.violationCount, autoSubmitted: autoSubmit });
    } catch (e) { fail(res, e); }
};

exports.submitExam = async (req, res) => {
    try {
        const attempt = await ExamAttempt.findOne({ exam: req.params.id, student: req.userId, status: 'in_progress' });
        if (!attempt) return res.status(404).json({ success: false, message: 'No active attempt or already submitted' });

        attempt.status      = 'submitted';
        attempt.submittedAt = new Date();
        await attempt.save();

        // Mark exam completed if all enrolled students submitted
        const exam     = await AptitudeExam.findById(req.params.id).lean();
        const sections = await ClassSection.find({ _id: { $in: examSectionIds(exam) } }).lean();
        const total    = sections.reduce((n, sec) => n + (sec.enrolledStudents || []).length, 0);
        const done    = await ExamAttempt.countDocuments({ exam: exam._id, status: { $in: ['submitted','auto_submitted'] } });
        if (total > 0 && done >= total) {
            await AptitudeExam.updateOne({ _id: exam._id }, { status: 'completed' });
        }

        res.json({ success: true, message: 'Exam submitted successfully' });
    } catch (e) { fail(res, e); }
};

exports.getStudentResult = async (req, res) => {
    try {
        if (!UUID.test(String(req.params.id || ''))) return notFound(res);
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId }).populate('subject', 'subjectName').lean();
        if (!exam) return notFound(res);
        if (!resultsOut(exam)) {
            return res.status(403).json({
                success: false,
                message: exam.resultApprovalStatus === 'approved' && exam.resultPublishDate
                    ? `Results will be published on ${new Date(exam.resultPublishDate).toDateString()}`
                    : 'Results not yet published',
            });
        }

        const attempt = await ExamAttempt.findOne({ exam: exam._id, student: req.userId }).lean();
        if (!attempt) return notFound(res, 'No attempt found');

        const questions = await AptitudeQuestion.find({ exam: exam._id }).lean();
        const g = grade(questions, attempt.answers || []);

        res.json({
            success: true,
            data: {
                exam:        { _id: exam._id, title: exam.title, totalMarks: exam.totalMarks, subjectName: exam.subject?.subjectName || null, duration: exam.duration, examDate: exam.examDate, startTime: exam.startTime },
                score:       g.score,
                percentage:  pctOf(g.score, exam.totalMarks),
                passed:      g.score >= passMarkOf(exam),
                submittedAt: attempt.submittedAt,
                questions:   g.items,
                // Added for the redesigned result page.
                passMark:    passMarkOf(exam),
                correct:     g.correct,
                incorrect:   g.incorrect,
                unanswered:  g.unanswered,
                status:      attempt.status,
                violationCount: attempt.violationCount || 0,
                timeTaken:   attempt.startedAt && attempt.submittedAt ? new Date(attempt.submittedAt) - new Date(attempt.startedAt) : null,
            },
        });
    } catch (e) { fail(res, e); }
};

// ── Parent ───────────────────────────────────────────────────────────────────

/**
 * One child's exams, and the list of children to switch between.
 *
 * `data` keeps its old meaning — exams whose results are out, with the child's
 * score — and now honours the publish date, which it used to ignore (a parent
 * saw results the school had scheduled for later). `upcoming` and `pending`
 * sit beside it: what the child has coming, and what they sat that is awaiting
 * results. It used to read only the FIRST child; `?child=` picks another.
 */
exports.getParentExamResults = async (req, res) => {
    try {
        const parent = await ParentProfile.findOne({ user: req.userId }).lean();
        const childIds = [...new Set((parent?.children?.length ? parent.children : [parent?.student]).filter(Boolean).map(String))];
        if (!childIds.length) return res.json({ success: true, data: [], children: [], child: null, upcoming: [], pending: [] });

        const { rows: kids } = await pool.query(
            `SELECT u."_id", u."name", u."profileImage" AS photo, sp."rollNumber", sp."currentSection",
                    c."className" || ' – ' || s."sectionName" AS "className"
               FROM ${T.users} u
               LEFT JOIN ${T.profiles} sp ON sp."user" = u."_id"
               LEFT JOIN ${T.sections} s  ON s."_id" = sp."currentSection"
               LEFT JOIN ${T.classes} c   ON c."_id" = s."class"
              WHERE u."_id" = ANY($1::uuid[])
              ORDER BY u."name"`,
            [childIds],
        );
        const children = kids.map(k => ({ _id: k._id, name: k.name, photo: k.photo || '', rollNumber: k.rollNumber || '', className: k.className || '' }));
        const wanted = String(req.query.child || '');
        const childId = childIds.includes(wanted) ? wanted : String(children[0]?._id || childIds[0]);
        const section = kids.find(k => String(k._id) === childId)?.currentSection;

        const envelope = { children, child: childId };
        if (!section) return res.json({ success: true, data: [], upcoming: [], pending: [], ...envelope });

        const exams = await AptitudeExam.find({
            school: req.schoolId, status: { $in: ['published', 'completed'] }, ...reachesSection(section),
        })
            .populate('subject',      'subjectName')
            .populate('academicYear', 'yearName')
            .sort({ examDate: -1 })
            .lean();

        const examIds = exams.map(e => e._id);
        const [attempts, questions, counts] = await Promise.all([
            ExamAttempt.find({ student: childId, exam: { $in: examIds } }).select('exam answers submittedAt startedAt status violationCount').lean(),
            AptitudeQuestion.find({ exam: { $in: examIds } }).lean(),
            questionCounts(examIds),
        ]);
        const qByExam = {};
        questions.forEach(q => { (qByExam[String(q.exam)] = qByExam[String(q.exam)] || []).push(q); });
        const attemptOf = Object.fromEntries(attempts.map(a => [String(a.exam), a]));

        const now = new Date();
        const data = []; const upcoming = []; const pending = [];
        for (const e of exams) {
            const a = attemptOf[String(e._id)];
            const stage = examStage(e, now);
            const { start, end } = examWindow(e);
            const base = { ...e, stage, opensAt: start, closesAt: end, questionCount: counts[String(e._id)] || 0 };

            if (resultsOut(e, now)) {
                let attempt = null;
                if (a && FINISHED.includes(a.status)) {
                    const g = grade(qByExam[String(e._id)] || [], a.answers);
                    attempt = {
                        _id: a._id, submittedAt: a.submittedAt, status: a.status, score: g.score,
                        percentage: pctOf(g.score, e.totalMarks),
                        passed: g.score >= passMarkOf(e),
                        correct: g.correct, incorrect: g.incorrect, unanswered: g.unanswered,
                        violationCount: a.violationCount || 0,
                    };
                }
                data.push({ ...base, attempt, passMark: passMarkOf(e) });
            } else if (['scheduled', 'live'].includes(stage)) {
                upcoming.push({ ...base, attemptStatus: a?.status || null });
            } else if (stage === 'completed') {
                pending.push({ ...base, attemptStatus: a?.status || null, submittedAt: a?.submittedAt || null, resultPublishDate: e.resultApprovalStatus === 'approved' ? e.resultPublishDate : null });
            }
        }
        upcoming.sort((x, y) => new Date(x.opensAt) - new Date(y.opensAt));
        res.json({ success: true, data, upcoming, pending, ...envelope });
    } catch (e) { fail(res, e); }
};
