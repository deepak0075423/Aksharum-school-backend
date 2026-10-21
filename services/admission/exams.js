'use strict';
/**
 * Entrance examinations and interviews.
 *
 * Online exams are timed by the SERVER: an attempt's deadline is fixed when it
 * starts, saves after it are refused, and an attempt still open past it is
 * submitted with what it holds (by the sweep, or by the next request that
 * touches it). The browser's clock and anything the page does to discourage
 * cheating are conveniences — none of it is trusted here.
 *
 * Results move draft → submitted (evaluators are done) → approved (an
 * administrator) → published (families see them). What families see is the
 * `published` snapshot taken at publication; corrections after that are
 * recorded with who and why, and reach families when published again.
 */
const pool = require('../../db/pool');
const { patch } = require('../../db/patch');
const { withTransaction, buildInsert } = require('../dbTx');
const AdmissionExam = require('../../models/AdmissionExam');
const AdmissionQuestion = require('../../models/AdmissionQuestion');
const AdmissionCandidate = require('../../models/AdmissionCandidate');
const AdmissionAttempt = require('../../models/AdmissionAttempt');
const AdmissionResult = require('../../models/AdmissionResult');
const AdmissionApplication = require('../../models/AdmissionApplication');
const AdmissionRound = require('../../models/AdmissionRound');
const School = require('../../models/School');
const Class = require('../../models/Class');
const AcademicYear = require('../../models/AcademicYear');
const User = require('../../models/User');
const workflow = require('./workflow');
const settingsSvc = require('./settings');
const counters = require('./counters');
const events = require('./events');
const notify = require('./notify');
const fmt = require('./format');
const { textProblem } = require('../../utils/textRules');
const { refuse, isId, str, num, bool, date, ids, round2 } = require('./util');

const QUESTION_TYPES = ['single', 'multiple', 'true_false', 'numeric', 'short', 'descriptive'];
const GRACE_MS = 15 * 1000;   // a save in flight when the clock runs out still lands
const TA = `"${AdmissionApplication.tableName}"`;

// ── Setting an exam up ───────────────────────────────────────────────────────

function normalizeSubjects(list, mode) {
    const subjects = (Array.isArray(list) ? list : []).slice(0, 20).map((s, i) => {
        const name = str(s?.name, 60);
        if (!name) refuse(`Subject ${i + 1} needs a name`, 400, { field: 'subjects' });
        const bad = textProblem(name, `Subject ${i + 1}`, 'title');
        if (bad) refuse(bad, 400, { field: 'subjects' });
        const key = /^[a-z][a-z0-9_]{0,30}$/.test(String(s?.key || '')) ? s.key : `s${i + 1}`;
        const maxMarks = num(s?.maxMarks, { min: 0.5, max: 1000, d: null });
        if (maxMarks == null) refuse(`${name}: give the maximum marks`, 400, { field: 'subjects' });
        const passMarks = num(s?.passMarks, { min: 0, max: maxMarks, d: 0 });
        // Online: a timed section (minutes) and questions drawn at random for each candidate (draw) — services/admission/examPlan.js.
        const timing = mode === 'online' ? { minutes: num(s?.minutes, { min: 0, max: 300, d: 0, int: true }), draw: num(s?.draw, { min: 0, max: 500, d: 0, int: true }) } : {};
        return { key, name, maxMarks, passMarks, ...timing };
    });
    const keys = new Set();
    for (const s of subjects) { if (keys.has(s.key)) refuse(`Two subjects share the key "${s.key}"`, 400, { field: 'subjects' }); keys.add(s.key); }
    if (mode !== 'online' && !subjects.length) refuse('Add at least one subject (or scoring area) marks are entered against', 400, { field: 'subjects' });
    return subjects;
}

async function normalizeExam(req, input, current = null) {
    const roundId = String(input.round ?? current?.round ?? '');
    if (!isId(roundId)) refuse('Choose the admission round', 400, { field: 'round' });
    const round = await AdmissionRound.findOne({ _id: roundId, school: req.schoolId }).lean();
    if (!round) refuse('Round not found', 404);
    const mode = ['online', 'offline', 'interview'].includes(input.mode ?? current?.mode) ? (input.mode ?? current.mode) : 'offline';
    const roundClasses = new Set((round.classes || []).map((c) => String(c.class)));
    const classes = ids(input.classes ?? current?.classes).filter((c) => roundClasses.has(c));
    if (!classes.length) refuse('Choose at least one class of the round', 400, { field: 'classes' });
    // RTE Act s.13: no entrance test or interview may choose children for an elementary class.
    await require('./compliance').assertExamAllowed(await settingsSvc.getSettings(req.schoolId), classes, mode);
    const name = str(input.name ?? current?.name, 100);
    if (!name) refuse('Give the exam a name', 400, { field: 'name' });
    for (const [label, v, max] of [['Name', name, 100], ['Description', input.description ?? current?.description, 2000], ['Instructions', input.instructions ?? current?.instructions, 5000], ['Things to bring', input.requiredItems ?? current?.requiredItems, 1000]]) {
        const bad = textProblem(str(v, max), label); if (bad) refuse(bad, 400);
    }
    const subjects = normalizeSubjects(input.subjects ?? current?.subjects, mode);
    const startsAt = date(input.startsAt ?? current?.startsAt);
    const endsAt = date(input.endsAt ?? current?.endsAt);
    if (!startsAt) refuse('Set when the exam starts', 400, { field: 'startsAt' });
    if (mode === 'online') {
        if (!endsAt) refuse('Set when the online exam window closes', 400, { field: 'endsAt' });
        if (endsAt <= startsAt) refuse('The window must close after it opens', 400, { field: 'endsAt' });
    } else if (endsAt && endsAt <= startsAt) refuse('The exam must end after it starts', 400, { field: 'endsAt' });
    const durationMinutes = num(input.durationMinutes ?? current?.durationMinutes, { min: 5, max: 600, d: 60, int: true });
    const st = input.settings ?? current?.settings ?? {};
    const evaluators = ids(input.evaluators ?? current?.evaluators);
    if (evaluators.length) {
        const n = await User.countDocuments({ _id: { $in: evaluators }, school: req.schoolId, role: { $in: ['teacher', 'school_admin'] }, isActive: true });
        if (n !== evaluators.length) refuse('Evaluators must be active staff of the school', 400, { field: 'evaluators' });
    }
    const elig = input.eligibility ?? current?.eligibility ?? {};
    // An interview usually follows the written exam; a first exam follows document checks.
    const defaultStatuses = mode === 'interview' ? ['exam_completed', 'evaluated', 'verified', 'eligible'] : ['verified', 'eligible'];
    const statuses = (Array.isArray(elig.statuses) ? elig.statuses : defaultStatuses).filter((s) => workflow.STATUSES[s] && !workflow.STATUSES[s].closed);
    const bands = (Array.isArray(input.gradeBands ?? current?.gradeBands) ? (input.gradeBands ?? current.gradeBands) : []).slice(0, 12)
        .map((b) => ({ min: num(b?.min, { min: 0, max: 100, d: 0 }), grade: str(b?.grade, 10) })).filter((b) => b.grade)
        .sort((a, b) => b.min - a.min);
    const subjectMax = subjects.reduce((s, x) => s + x.maxMarks, 0);
    return {
        school: req.schoolId, round: roundId, name, mode, classes,
        description: str(input.description ?? current?.description, 2000),
        instructions: str(input.instructions ?? current?.instructions, 5000),
        requiredItems: str(input.requiredItems ?? current?.requiredItems, 1000),
        subjects,
        maxMarks: mode === 'online' ? (current?.maxMarks || 0) : subjectMax,
        passMarks: num(input.passMarks ?? current?.passMarks, { min: 0, max: 100000, d: 0 }),
        gradeBands: bands,
        startsAt, endsAt, durationMinutes,
        reportingTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.reportingTime ?? current?.reportingTime ?? '')) ? String(input.reportingTime ?? current.reportingTime) : '',
        venue: {
            name: str(input.venue?.name ?? current?.venue?.name, 120), address: str(input.venue?.address ?? current?.venue?.address, 300),
            room: str(input.venue?.room ?? current?.venue?.room, 60),
        },
        eligibility: { statuses: statuses.length ? statuses : defaultStatuses, requireDocsVerified: bool(elig.requireDocsVerified, false), requireApplicationFeePaid: bool(elig.requireApplicationFeePaid, false) },
        settings: {
            negativeMarking: bool(st.negativeMarking, false), negativeFraction: num(st.negativeFraction, { min: 0, max: 1, d: 0.25 }),
            randomizeQuestions: bool(st.randomizeQuestions, true), randomizeOptions: bool(st.randomizeOptions, true),
            attemptsAllowed: num(st.attemptsAllowed, { min: 1, max: 3, d: 1, int: true }),
            retakePolicy: require('./examPlan').RETAKE.includes(st.retakePolicy) ? st.retakePolicy : 'latest',
            drawCount: num(st.drawCount, { min: 0, max: 500, d: 0, int: true }),
            showScoreOnSubmit: bool(st.showScoreOnSubmit, false),
        },
        admitCard: {
            enabled: bool(input.admitCard?.enabled ?? current?.admitCard?.enabled, mode !== 'online'),
            releaseAt: date(input.admitCard?.releaseAt ?? current?.admitCard?.releaseAt),
            instructions: str(input.admitCard?.instructions ?? current?.admitCard?.instructions, 1500),
        },
        evaluators,
        booking: require('./slots').normalizeBooking(input.booking, mode, current?.booking),
        approvalRequired: bool(input.approvalRequired ?? current?.approvalRequired, true),
        resultPublishAt: date(input.resultPublishAt ?? current?.resultPublishAt),
    };
}

async function createExam(req, input) {
    const data = await normalizeExam(req, input);
    const exam = await AdmissionExam.create({ ...data, status: 'draft', createdBy: req.userId });
    events.recordQuietly(req.schoolId, { by: req, type: 'exam', action: 'created', message: `Exam "${exam.name}" created` });
    return exam;
}

async function updateExam(req, exam, input) {
    if (exam.status === 'cancelled') refuse('A cancelled exam cannot be changed', 409);
    const data = await normalizeExam(req, input, exam);
    if (exam.status !== 'draft') {
        // Once scheduled, the shape families were told about stays put.
        if (data.mode !== exam.mode) refuse('The mode of a scheduled exam cannot change', 409);
        if (String(data.round) !== String(exam.round)) refuse('A scheduled exam cannot move to another round', 409);
    }
    if (exam.mode === 'online') data.maxMarks = await onlineMaxMarks(exam._id);
    await require('./slots').checkEdit(exam, data.booking);
    const row = await patch(AdmissionExam, exam._id, { ...data, updatedBy: req.userId });
    events.recordQuietly(req.schoolId, { by: req, type: 'exam', action: 'updated', message: `Exam "${row.name}" updated` });
    return row;
}

async function onlineMaxMarks(examId) {
    const exam = await AdmissionExam.findById(examId).lean();
    const questions = await AdmissionQuestion.find({ exam: examId, isActive: true }).lean();
    // With questions drawn at random, a paper is worth what is drawn (services/admission/examPlan.js).
    return exam ? require('./examPlan').maxMarks(exam, questions) : 0;
}

/** Problems that stop an exam being scheduled. */
async function readiness(exam) {
    const problems = [];
    if (exam.mode === 'online') {
        const qs = await AdmissionQuestion.find({ exam: exam._id, isActive: true }).lean();
        if (!qs.length) problems.push('Add the questions');
        const bad = qs.filter((q) => questionProblem(q));
        if (bad.length) problems.push(`${bad.length} question(s) have no valid answer key`);
        if (!exam.endsAt || !exam.startsAt) problems.push('Set the exam window');
        problems.push(...require('./examPlan').problems(exam, qs.filter((q) => !questionProblem(q))));
    } else if (!exam.subjects?.length) problems.push('Add the subjects marks are entered against');
    if (exam.startsAt && new Date(exam.startsAt) < new Date(Date.now() - 86400000) && exam.status === 'draft') problems.push('The exam date has passed');
    return problems;
}

async function schedule(req, exam) {
    if (exam.status !== 'draft') refuse('Only a draft exam can be scheduled', 409);
    await require('./compliance').assertExamAllowed(await settingsSvc.getSettings(exam.school), exam.classes, exam.mode);
    const problems = await readiness(exam);
    if (problems.length) refuse(`Not ready: ${problems.join('; ')}`, 409, { errors: problems.map((m) => ({ path: 'exam', message: m })) });
    const maxMarks = exam.mode === 'online' ? await onlineMaxMarks(exam._id) : exam.maxMarks;
    const row = await patch(AdmissionExam, exam._id, { status: 'scheduled', maxMarks }, { where: { status: 'draft' } });
    events.recordQuietly(req.schoolId, { by: req, type: 'exam', action: 'scheduled', message: `Exam "${exam.name}" scheduled for ${fmt.fmtDateTime(exam.startsAt)}` });
    return row;
}

async function cancel(req, exam, reason) {
    if (exam.status === 'cancelled') refuse('Already cancelled', 409);
    if (['approved', 'published'].includes(exam.resultsStatus)) refuse('Results of this exam are approved — it cannot be cancelled now', 409);
    const why = str(reason, 300);
    if (!why) refuse('Say why the exam is cancelled — families are told', 400, { field: 'reason' });
    const row = await patch(AdmissionExam, exam._id, { status: 'cancelled' });
    const { rows } = await pool.query(`SELECT a.* FROM "admissioncandidates" c JOIN ${TA} a ON a."_id" = c."application" WHERE c."exam" = $1 AND c."status" <> 'withdrawn'`, [String(exam._id)]);
    for (const app of rows) {
        events.recordQuietly(app.school, { application: app._id, by: req, type: 'exam', action: 'cancelled', message: `${exam.name} has been cancelled — ${why}`, visibility: 'applicant' });
        notify.toApplicant(app, 'status_update', { remarks: `${exam.name} has been cancelled: ${why}. We will write to you with a new date.` });
    }
    events.recordQuietly(req.schoolId, { by: req, type: 'exam', action: 'cancelled', message: `Exam "${exam.name}" cancelled — ${why}` });
    return row;
}

// ── Questions ────────────────────────────────────────────────────────────────

function questionProblem(q) {
    const optIds = new Set((q.options || []).map((o) => String(o.id)));
    switch (q.type) {
        case 'single':
        case 'multiple': {
            if ((q.options || []).length < 2) return 'Give at least two options';
            const key = Array.isArray(q.correct) ? q.correct.map(String) : [];
            if (!key.length || key.some((k) => !optIds.has(k))) return 'Mark the correct option';
            if (q.type === 'single' && key.length !== 1) return 'A single-answer question has one correct option';
            return null;
        }
        case 'true_false': return Array.isArray(q.correct) && ['true', 'false'].includes(String(q.correct[0])) ? null : 'Mark true or false';
        case 'numeric': return Number.isFinite(Number(q.correct?.value)) ? null : 'Give the correct number';
        case 'short': return Array.isArray(q.correct?.answers) && q.correct.answers.some((a) => String(a).trim()) ? null : 'Give at least one accepted answer';
        case 'descriptive': return null;
        default: return 'Unknown question type';
    }
}

function normalizeQuestion(input, exam) {
    const type = QUESTION_TYPES.includes(input.type) ? input.type : null;
    if (!type) refuse('Choose a question type', 400, { field: 'type' });
    const text = str(input.text, 3000);
    if (!text) refuse('Write the question', 400, { field: 'text' });
    const bad = textProblem(text, 'The question'); if (bad) refuse(bad, 400, { field: 'text' });
    let options = [];
    let correct = null;
    if (type === 'single' || type === 'multiple') {
        options = (Array.isArray(input.options) ? input.options : []).slice(0, 8).map((o, i) => ({ id: String.fromCharCode(97 + i), text: str(o?.text ?? o, 500) })).filter((o) => o.text);
        for (const o of options) { const b = textProblem(o.text, `Option ${o.id.toUpperCase()}`); if (b) refuse(b, 400, { field: 'options' }); }
        // The key arrives as option letters or as indexes; stored as option ids.
        const raw = Array.isArray(input.correct) ? input.correct : [input.correct];
        correct = [...new Set(raw.map((c) => (typeof c === 'number' ? String.fromCharCode(97 + c) : String(c).toLowerCase())).filter((c) => options.some((o) => o.id === c)))];
    } else if (type === 'true_false') {
        options = [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }];
        correct = [String(Array.isArray(input.correct) ? input.correct[0] : input.correct).toLowerCase() === 'true' ? 'true' : 'false'];
    } else if (type === 'numeric') {
        correct = { value: Number(input.correct?.value ?? input.correct), tolerance: num(input.correct?.tolerance, { min: 0, max: 1e9, d: 0 }) };
    } else if (type === 'short') {
        const answers = (Array.isArray(input.correct?.answers) ? input.correct.answers : String(input.correct?.answers ?? input.correct ?? '').split('|')).map((a) => str(a, 120)).filter(Boolean).slice(0, 10);
        correct = { answers };
    }
    const q = {
        type, text, options, correct,
        subjectKey: str(input.subjectKey, 30),
        marks: num(input.marks, { min: 0.5, max: 100, d: 1 }),
        negativeMarks: input.negativeMarks === '' || input.negativeMarks == null ? null : num(input.negativeMarks, { min: 0, max: 100, d: null }),
        explanation: str(input.explanation, 1000),
        tags: (Array.isArray(input.tags) ? input.tags : []).map((t) => str(t, 30)).filter(Boolean).slice(0, 10),
        difficulty: ['easy', 'medium', 'hard'].includes(input.difficulty) ? input.difficulty : '',
    };
    const problem = questionProblem(q);
    if (problem) refuse(problem, 400, { field: 'correct' });
    if (exam && exam.subjects?.length && q.subjectKey && !exam.subjects.some((s) => s.key === q.subjectKey)) refuse('That subject is not part of the exam', 400, { field: 'subjectKey' });
    return q;
}

async function editableForQuestions(exam) {
    if (!exam) return;
    if (exam.status === 'cancelled') refuse('The exam is cancelled', 409);
    const { rows: [r] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionattempts" WHERE "exam" = $1`, [String(exam._id)]);
    if (r.n) refuse('Applicants have started this exam — its questions can no longer change', 409, { code: 'EXAM_STARTED' });
}

async function addQuestion(req, exam, input) {
    await editableForQuestions(exam);
    const q = normalizeQuestion(input, exam);
    const { rows: [o] } = await pool.query(`SELECT COALESCE(MAX("order"), 0) AS n FROM "admissionquestions" WHERE "school" = $1 AND "exam" ${exam ? '= $2' : 'IS NULL'}`, exam ? [String(req.schoolId), String(exam._id)] : [String(req.schoolId)]);
    const row = await AdmissionQuestion.create({ ...q, school: req.schoolId, exam: exam?._id || null, order: Number(o.n) + 1, createdBy: req.userId });
    if (exam) await patch(AdmissionExam, exam._id, { maxMarks: await onlineMaxMarks(exam._id) });
    return row;
}

async function updateQuestion(req, question, exam, input) {
    await editableForQuestions(exam);
    const q = normalizeQuestion({ ...question, ...input }, exam);
    const row = await patch(AdmissionQuestion, question._id, q);
    if (exam) await patch(AdmissionExam, exam._id, { maxMarks: await onlineMaxMarks(exam._id) });
    return row;
}

async function deleteQuestion(req, question, exam) {
    await editableForQuestions(exam);
    await pool.query(`DELETE FROM "admissionquestions" WHERE "_id" = $1 AND "school" = $2`, [String(question._id), String(req.schoolId)]);
    if (exam) await patch(AdmissionExam, exam._id, { maxMarks: await onlineMaxMarks(exam._id) });
    return { ok: true };
}

/** Copy questions from the bank (or another exam of the school) into an exam. */
async function importQuestions(req, exam, questionIds) {
    await editableForQuestions(exam);
    const list = ids(questionIds);
    if (!list.length) refuse('Choose the questions to add');
    const src = await AdmissionQuestion.find({ _id: { $in: list }, school: req.schoolId }).lean();
    if (!src.length) refuse('Those questions were not found', 404);
    const { rows: [o] } = await pool.query(`SELECT COALESCE(MAX("order"), 0) AS n FROM "admissionquestions" WHERE "exam" = $1`, [String(exam._id)]);
    let order = Number(o.n);
    for (const q of src) {
        const { _id, exam: _e, createdAt, updatedAt, ...rest } = q;
        const subjectKey = exam.subjects?.some((s) => s.key === rest.subjectKey) ? rest.subjectKey : '';
        await AdmissionQuestion.create({ ...rest, subjectKey, exam: exam._id, order: ++order, createdBy: req.userId });
    }
    await patch(AdmissionExam, exam._id, { maxMarks: await onlineMaxMarks(exam._id) });
    return { added: src.length };
}

// ── Candidates ───────────────────────────────────────────────────────────────

/** Applications that may be scheduled for this exam and are not yet. */
async function eligible(exam) {
    const statuses = exam.eligibility?.statuses?.length ? exam.eligibility.statuses : ['verified', 'eligible'];
    const params = [String(exam.school), String(exam.round), exam.classes.map(String), statuses, String(exam._id)];
    let extra = '';
    if (exam.eligibility?.requireDocsVerified) extra += ` AND a."docStatus" IN ('verified', 'none')`;
    if (exam.eligibility?.requireApplicationFeePaid) extra += ` AND a."applicationFeeStatus" IN ('paid', 'waived', 'not_required')`;
    const { rows } = await pool.query(
        `SELECT a."_id", a."applicationNumber", a."studentName", a."class", a."status", a."docStatus", a."applicationFeeStatus"
           FROM ${TA} a
          WHERE a."school" = $1 AND a."round" = $2 AND a."class" = ANY($3::uuid[]) AND a."status" = ANY($4::text[])${extra}
            AND NOT EXISTS (SELECT 1 FROM "admissioncandidates" c WHERE c."exam" = $5 AND c."application" = a."_id")
          ORDER BY a."applicationNumber"`, params);
    return rows;
}

/** Schedule applications for the exam: roll numbers, statuses, emails. */
async function assignCandidates(req, exam, applicationIds) {
    if (exam.status !== 'scheduled') refuse('Schedule the exam before adding candidates', 409);
    await require('./compliance').assertExamAllowed(await settingsSvc.getSettings(exam.school), exam.classes, exam.mode);
    const pool_ = await eligible(exam);
    const want = applicationIds === 'all' ? pool_ : pool_.filter((a) => ids(applicationIds).includes(String(a._id)));
    if (!want.length) refuse('No eligible application was chosen — check the exam\'s eligibility', 409);
    const settings = await settingsSvc.getSettings(exam.school);
    const flow = workflow.compile(settings.workflow);
    const target = exam.mode === 'interview' ? 'interview_scheduled' : 'exam_scheduled';
    const school = await School.findById(exam.school).select('name code').lean();
    const round = await AdmissionRound.findById(exam.round).select('academicYear').lean();
    const year = await AcademicYear.findById(round?.academicYear).select('startDate').lean();
    const classes = new Map((await Class.find({ _id: { $in: exam.classes } }).select('className classNumber').lean()).map((c) => [String(c._id), c]));
    const added = [];
    const after = [];
    const apps = require('./applications');
    for (const a of want) {
        await withTransaction(async (q) => {
            const { rows: [app] } = await q(`SELECT * FROM ${TA} WHERE "_id" = $1 FOR UPDATE`, [String(a._id)]);
            if (!app || workflow.isClosed(app.status)) return;
            const roll = await counters.nextNumber(exam.school, 'admitCard', settings.numbering.admitCard, {
                school, classDoc: classes.get(String(app.class)), year: year?.startDate ? new Date(year.startDate).getFullYear() : null,
            }, q);
            const { sql, params } = buildInsert(AdmissionCandidate, {
                school: exam.school, exam: exam._id, application: app._id, applicant: app.applicant, rollNumber: roll,
                room: exam.venue?.room || '', status: 'scheduled', scheduledBy: req.userId,
            });
            const { rows: [cand] } = await q(`${sql.replace(' RETURNING *', '')} ON CONFLICT ("exam", "application") DO NOTHING RETURNING *`, params);
            if (!cand) return;
            if (flow.enabled(workflow.STATUSES[target].stage) && app.status !== target && workflow.canMove(app, target, { flow, system: true }).ok) {
                await apps.move(req, app, target, { system: true, q, after, quiet: true });
            }
            await events.record(exam.school, {
                application: app._id, by: req, type: 'exam', action: 'scheduled', visibility: 'applicant',
                message: exam.booking?.enabled
                    ? `${exam.name}: added${roll ? ` — roll number ${roll}` : ''}. Choose a time on the application page.`
                    : `${exam.name}: scheduled for ${fmt.fmtDateTime(exam.startsAt)}${roll ? ` — roll number ${roll}` : ''}`,
            }, q);
            added.push({ app, cand });
        });
    }
    for (const fn of after) await fn();
    for (const { app, cand } of added) {
        const values = examValues(exam, cand);
        // With times to choose from, the family is asked to choose; the time chosen is confirmed then.
        notify.toApplicant(app, exam.booking?.enabled ? 'slot_choose' : exam.mode === 'interview' ? 'interview_scheduled' : 'exam_scheduled', values);
        if (exam.mode === 'online') notify.toApplicant(app, 'online_exam_instructions', values);
    }
    return { added: added.length };
}

function examValues(exam, cand) {
    return {
        exam_name: exam.name, exam_date: fmt.fmtDate(cand?.slot || exam.startsAt, { weekday: true }), exam_time: fmt.fmtTime(cand?.slot || exam.startsAt),
        exam_mode: exam.mode === 'online' ? 'Online' : exam.mode === 'interview' ? 'Interview' : 'Offline (at the school)',
        exam_venue: exam.mode === 'online' ? 'Online, on the admission portal' : [exam.venue?.name, exam.venue?.room, exam.venue?.address].filter(Boolean).join(', '),
        reporting_time: exam.reportingTime ? fmt.fmtClock(exam.reportingTime) : '', exam_duration: fmt.minutes(exam.durationMinutes), roll_number: cand?.rollNumber || '',
    };
}

async function removeCandidate(req, exam, candidate) {
    const { rows: [att] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionattempts" WHERE "exam" = $1 AND "application" = $2`, [String(exam._id), String(candidate.application)]);
    if (att.n) refuse('This candidate has already started the exam', 409);
    const { rows: [res] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionresults" WHERE "exam" = $1 AND "application" = $2`, [String(exam._id), String(candidate.application)]);
    if (res.n) refuse('Marks have been entered for this candidate', 409);
    await patch(AdmissionCandidate, candidate._id, { status: 'withdrawn' });
    events.recordQuietly(exam.school, { application: candidate.application, by: req, type: 'exam', action: 'unscheduled', message: `Removed from ${exam.name}` });
    return { ok: true };
}

async function setSlot(req, exam, candidate, { slot, slotId, force, panel, room, extraMinutes, extraReason }) {
    // One of the exam's bookable times — held to its room unless forced.
    if (slotId !== undefined && slotId !== null && slotId !== '') {
        const { rows: [app] } = await pool.query(`SELECT * FROM ${TA} WHERE "_id" = $1`, [String(candidate.application)]);
        await require('./slots').choose(req, exam, app, slotId, { office: true, force: force === true });
        slot = undefined;
    }
    const set = {};
    if (slot !== undefined) set.slot = date(slot);
    if (panel !== undefined) set.panel = ids(panel);
    if (room !== undefined) set.room = str(room, 60);
    if (slot !== undefined) set.slotId = '';   // a time set by hand is no longer one of the bookable ones
    if (extraMinutes !== undefined) {
        // Extra time is an accommodation: recorded with its reason (a certificate, a need the school agreed).
        set.extraMinutes = num(extraMinutes, { min: 0, max: 180, d: 0, int: true });
        set.extraReason = str(extraReason, 200);
        if (set.extraMinutes > 0 && !set.extraReason) refuse('Say why the candidate has extra time', 400, { field: 'extraReason' });
        const bad = textProblem(set.extraReason, 'Reason'); if (bad) refuse(bad, 400, { field: 'extraReason' });
        events.recordQuietly(exam.school, { application: candidate.application, by: req, type: 'exam', action: 'extra_time', message: `${exam.name}: ${set.extraMinutes ? `${set.extraMinutes} minutes' extra time — ${set.extraReason}` : 'extra time removed'}` });
    }
    if (!Object.keys(set).length) return (await pool.query(`SELECT * FROM "admissioncandidates" WHERE "_id" = $1`, [String(candidate._id)])).rows[0];
    return patch(AdmissionCandidate, candidate._id, set);
}

/** Present / absent at an offline exam or interview. */
async function attendance(req, exam, candidate, present) {
    if (exam.mode === 'online') refuse('Attendance for an online exam is its attempt', 409);
    if (req && !inScope(await markingScope(req, exam), candidate._id)) refuse('You are not on the panel for this candidate', 403);
    if (['evaluated'].includes(candidate.status)) refuse('Results are in for this candidate', 409);
    const row = await patch(AdmissionCandidate, candidate._id, { status: present ? 'present' : 'absent', attendanceBy: req.userId, attendanceAt: new Date() });
    if (!present) await upsertResult(req, exam, candidate, { absent: true, marks: {} });
    await markSat(req, exam, candidate.application);
    return row;
}

/** The application's exam stage moves on once the candidate has sat (or missed) the exam. */
async function markSat(req, exam, applicationId) {
    const settings = await settingsSvc.getSettings(exam.school);
    const flow = workflow.compile(settings.workflow);
    const target = exam.mode === 'interview' ? 'interview_completed' : 'exam_completed';
    const { rows: [app] } = await pool.query(`SELECT * FROM ${TA} WHERE "_id" = $1`, [String(applicationId)]);
    if (!app || app.status === target) return;
    const from = exam.mode === 'interview' ? 'interview_scheduled' : 'exam_scheduled';
    if (app.status !== from) return;
    // Every exam of this kind the applicant was scheduled for is done.
    const { rows: [left] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM "admissioncandidates" c JOIN "admissionexams" e ON e."_id" = c."exam"
          WHERE c."application" = $1 AND c."status" = 'scheduled' AND e."status" <> 'cancelled' AND ${exam.mode === 'interview' ? `e."mode" = 'interview'` : `e."mode" <> 'interview'`}`,
        [String(applicationId)]);
    if (left.n) return;
    if (!workflow.canMove(app, target, { flow, system: true }).ok) return;
    await require('./applications').move(req, app, target, { system: true, quiet: true }).catch((e) => { if (e.status !== 409) throw e; });
}

// ── The online attempt ───────────────────────────────────────────────────────

/**
 * Start (or resume) the applicant's sitting. Refused before the window
 * opens, after it closes, beyond the attempts allowed, or for an application
 * no longer in the running.
 */
async function startAttempt(req, exam, app, candidate) {
    if (exam.mode !== 'online') refuse('This exam is not taken online', 409);
    if (exam.status !== 'scheduled') refuse('This exam is not open', 409);
    if (!candidate || candidate.status === 'withdrawn') refuse('You are not scheduled for this exam', 403);
    if (workflow.isClosed(app.status)) refuse('This application is closed', 409);
    const now = new Date();
    if (new Date(exam.startsAt) > now) refuse(`The exam opens at ${fmt.fmtDateTime(exam.startsAt)}`, 409, { code: 'NOT_OPEN_YET', opensAt: exam.startsAt });
    const open = await AdmissionAttempt.findOne({ exam: exam._id, application: app._id, status: 'in_progress' }).lean();
    if (open) return finishIfDue(req, exam, open);
    if (new Date(exam.endsAt) <= now) refuse('The exam window has closed', 409, { code: 'CLOSED' });
    const { rows: [done] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionattempts" WHERE "exam" = $1 AND "application" = $2 AND "status" <> 'void'`, [String(exam._id), String(app._id)]);
    const allowed = Number(exam.settings?.attemptsAllowed) || 1;
    if (done.n >= allowed) refuse(allowed === 1 ? 'You have already taken this exam' : `You have used all ${allowed} attempts`, 409, { code: 'NO_ATTEMPTS_LEFT' });

    const questions = await AdmissionQuestion.find({ exam: exam._id, isActive: true }).sort({ order: 1 }).lean();
    if (!questions.length) refuse('This exam has no questions yet — please contact the school', 409);
    // The paper for this sitting: drawn, ordered, sectioned, with the candidate's extra time (services/admission/examPlan.js).
    const plan = require('./examPlan').build(exam, questions, { extraMinutes: candidate.extraMinutes, now });
    try {
        const attempt = await AdmissionAttempt.create({
            school: exam.school, exam: exam._id, application: app._id, applicant: app.applicant, candidate: candidate._id,
            attemptNo: done.n + 1, status: 'in_progress', startedAt: now, deadlineAt: plan.deadlineAt, questionOrder: plan.questionOrder, optionOrder: plan.optionOrder,
            sections: plan.sections, currentSection: 0, extraMinutes: Number(candidate.extraMinutes) || 0, answers: {}, saveSeq: 0,
            clientInfo: { ip: String(req.ip || '').slice(0, 64), ua: String(req.headers?.['user-agent'] || '').slice(0, 200) },
        });
        events.recordQuietly(exam.school, { application: app._id, by: req, type: 'exam', action: 'started', message: `${exam.name} started`, visibility: 'applicant' });
        return attempt.toObject ? attempt.toObject() : attempt;
    } catch (e) {
        if (e.code === 11000) {
            const again = await AdmissionAttempt.findOne({ exam: exam._id, application: app._id, status: 'in_progress' }).lean();
            if (again) return again;
        }
        throw e;
    }
}

/** What the applicant's page is sent: the questions in their order, never the key. */
async function attemptView(exam, attempt) {
    const questions = await AdmissionQuestion.find({ exam: exam._id }).lean();
    const byId = new Map(questions.map((q) => [String(q._id), q]));
    const subjects = new Map((exam.subjects || []).map((s) => [s.key, s.name]));
    const planSvc = require('./examPlan');
    const open = planSvc.openQuestionIds(attempt);
    const sectioned = (attempt.sections || []).length > 0;
    const list = (attempt.questionOrder || []).map((id, i) => {
        const q = byId.get(String(id));
        if (!q) return null;
        // A timed section shows only while it is open; earlier ones are done, later ones not yet.
        if (sectioned && attempt.status === 'in_progress' && !open.has(String(id))) return null;
        const order = attempt.optionOrder?.[String(id)];
        const options = order ? order.map((oid) => (q.options || []).find((o) => o.id === oid)).filter(Boolean) : (q.options || []);
        return { _id: q._id, number: i + 1, type: q.type, text: q.text, marks: q.marks, subject: subjects.get(q.subjectKey) || '', options: options.map((o) => ({ id: o.id, text: o.text })) };
    }).filter(Boolean);
    return {
        _id: attempt._id, status: attempt.status, startedAt: attempt.startedAt, deadlineAt: attempt.deadlineAt, submittedAt: attempt.submittedAt,
        serverNow: new Date(), saveSeq: attempt.saveSeq, answers: attempt.answers || {}, questions: list,
        sections: (attempt.sections || []).map((x, i) => ({
            key: x.key, name: x.name, minutes: x.minutes, questions: x.questions.length, deadlineAt: x.deadlineAt,
            status: i < (Number(attempt.currentSection) || 0) ? 'done' : i === (Number(attempt.currentSection) || 0) ? 'open' : 'later',
        })),
        currentSection: Number(attempt.currentSection) || 0,
        extraMinutes: Number(attempt.extraMinutes) || 0,
        exam: { _id: exam._id, name: exam.name, instructions: exam.instructions, durationMinutes: exam.durationMinutes, negativeMarking: !!exam.settings?.negativeMarking },
        score: attempt.status !== 'in_progress' && exam.settings?.showScoreOnSubmit && !attempt.manualPending ? attempt.autoScore : undefined,
    };
}

/** Tidy answers to the attempt's own questions; anything else is dropped. */
function cleanAnswers(attempt, questions, input) {
    const byId = new Map(questions.map((q) => [String(q._id), q]));
    // Only the questions still open: a closed section's answers stay as they were.
    const allowed = require('./examPlan').openQuestionIds(attempt);
    const out = {};
    for (const [qid, a] of Object.entries(input || {})) {
        if (!allowed.has(qid)) continue;
        const q = byId.get(qid);
        if (!q) continue;
        const at = new Date();
        if (['single', 'multiple', 'true_false'].includes(q.type)) {
            const ids_ = new Set((q.options || []).map((o) => o.id));
            const sel = [...new Set((Array.isArray(a?.selected) ? a.selected : []).map(String).filter((x) => ids_.has(x)))];
            out[qid] = { selected: q.type === 'multiple' ? sel : sel.slice(0, 1), flagged: !!a?.flagged, at };
        } else if (q.type === 'numeric') {
            const v = a?.value === '' || a?.value == null ? null : Number(a.value);
            out[qid] = { value: Number.isFinite(v) ? v : null, flagged: !!a?.flagged, at };
        } else {
            out[qid] = { text: str(a?.text, q.type === 'short' ? 200 : 5000), flagged: !!a?.flagged, at };
        }
    }
    return out;
}

/**
 * Save answers. `seq` is the page's save counter: an older save arriving after
 * a newer one (a retry after a dropped connection) is ignored rather than
 * allowed to overwrite newer answers.
 */
async function saveAnswers(req, exam, attempt, { answers, seq }) {
    attempt = await finishIfDue(req, exam, attempt);
    attempt = await moveSections(attempt);
    if (attempt.status !== 'in_progress') refuse('This exam has been submitted', 409, { code: 'SUBMITTED' });
    if (Date.now() > new Date(attempt.deadlineAt).getTime() + GRACE_MS) refuse('Time is up', 409, { code: 'TIME_UP' });
    const n = Number(seq);
    if (!Number.isInteger(n) || n < 1) refuse('Missing save number');
    if (n <= Number(attempt.saveSeq)) return { saved: false, stale: true, saveSeq: attempt.saveSeq, deadlineAt: attempt.deadlineAt, serverNow: new Date() };
    const questions = await AdmissionQuestion.find({ exam: exam._id }).lean();
    const merged = { ...(attempt.answers || {}), ...cleanAnswers(attempt, questions, answers) };
    const { rows } = await pool.query(
        `UPDATE "admissionattempts" SET "answers" = $2::jsonb, "saveSeq" = $3, "lastSavedAt" = now(), "updatedAt" = now()
          WHERE "_id" = $1 AND "status" = 'in_progress' AND "saveSeq" < $3 RETURNING "saveSeq"`,
        [String(attempt._id), JSON.stringify(merged), n]);
    if (!rows.length) {
        const fresh = await AdmissionAttempt.findById(attempt._id).lean();
        return { saved: false, stale: true, saveSeq: fresh?.saveSeq, status: fresh?.status, deadlineAt: attempt.deadlineAt, serverNow: new Date() };
    }
    return { saved: true, saveSeq: n, deadlineAt: attempt.deadlineAt, serverNow: new Date() };
}

/** Score the objective questions of an attempt. Descriptive ones wait for an evaluator. */
function scoreAttempt(exam, questions, attempt) {
    const byId = new Map(questions.map((q) => [String(q._id), q]));
    let score = 0;
    let pendingManual = 0;
    const perQuestion = {};
    for (const qid of attempt.questionOrder || []) {
        const q = byId.get(String(qid));
        if (!q) continue;
        const a = attempt.answers?.[qid];
        const neg = q.negativeMarks != null ? Number(q.negativeMarks) : (exam.settings?.negativeMarking ? Number(q.marks) * (Number(exam.settings.negativeFraction) || 0) : 0);
        let got = 0;
        let answered = false;
        switch (q.type) {
            case 'single': case 'true_false': case 'multiple': {
                const sel = (a?.selected || []).map(String);
                answered = sel.length > 0;
                const key = (q.correct || []).map(String);
                const right = answered && sel.length === key.length && key.every((k) => sel.includes(k));
                got = right ? q.marks : (answered ? -neg : 0);
                break;
            }
            case 'numeric': {
                answered = a?.value != null;
                const right = answered && Math.abs(Number(a.value) - Number(q.correct?.value)) <= (Number(q.correct?.tolerance) || 0);
                got = right ? q.marks : (answered ? -neg : 0);
                break;
            }
            case 'short': {
                const t = String(a?.text || '').trim().toLowerCase().replace(/\s+/g, ' ');
                answered = !!t;
                const right = answered && (q.correct?.answers || []).some((x) => String(x).trim().toLowerCase().replace(/\s+/g, ' ') === t);
                got = right ? q.marks : (answered ? -neg : 0);
                break;
            }
            case 'descriptive': {
                const m = attempt.manualMarks?.[qid];
                if (m && m.marks != null) got = Number(m.marks);
                else if (String(a?.text || '').trim()) pendingManual += 1;
                perQuestion[qid] = { manual: true, marks: m?.marks ?? null };
                continue;
            }
            default: break;
        }
        perQuestion[qid] = { marks: round2(got), answered };
        score += got;
    }
    return { autoScore: round2(Math.max(0, score)), pendingManual, perQuestion };
}

/** Submit — by the applicant, or by the clock. */
async function submitAttempt(req, exam, attempt, { answers = null, seq = null, auto = false } = {}) {
    if (attempt.status !== 'in_progress') return attempt;
    if (answers && seq && !auto) {
        try { await saveAnswers(req, exam, attempt, { answers, seq }); } catch (e) { if (!['TIME_UP', 'SUBMITTED'].includes(e.code)) throw e; }
    }
    const fresh = await AdmissionAttempt.findById(attempt._id).lean();
    if (fresh.status !== 'in_progress') return fresh;
    const questions = await AdmissionQuestion.find({ exam: exam._id }).lean();
    const scored = scoreAttempt(exam, questions, fresh);
    const row = await patch(AdmissionAttempt, attempt._id, {
        status: auto ? 'auto_submitted' : 'submitted', submittedAt: new Date(), autoScore: scored.autoScore, manualPending: scored.pendingManual,
    }, { where: { status: 'in_progress' } });
    if (!row) return AdmissionAttempt.findById(attempt._id).lean();
    await patch(AdmissionCandidate, row.candidate, { status: 'attempted' }).catch(() => {});
    const candidate = row.candidate ? await AdmissionCandidate.findById(row.candidate).lean() : null;
    // With retakes, the school's rule picks what counts: latest, best or average (services/admission/examPlan.js).
    const counts = await require('./examPlan').counting(exam, row.application);
    await upsertResult(req, exam, candidate || { _id: null, application: row.application }, { autoScore: counts ? counts.autoScore : scored.autoScore, manualScore: counts ? counts.manualScore : undefined, attempt: counts ? null : row });
    events.recordQuietly(exam.school, { application: row.application, by: auto ? null : req, type: 'exam', action: auto ? 'auto_submitted' : 'submitted', message: `${exam.name} ${auto ? 'submitted when the time ran out' : 'submitted'}`, visibility: 'applicant' });
    await markSat(req, exam, row.application).catch((e) => console.error('[admission] exam stage:', e.message));
    return row;
}

/** An attempt past its deadline is submitted with what it holds. */
async function finishIfDue(req, exam, attempt) {
    if (attempt.status === 'in_progress' && Date.now() > new Date(attempt.deadlineAt).getTime() + GRACE_MS) {
        return submitAttempt(req, exam, attempt, { auto: true });
    }
    // Timed sections: every section closed means the sitting is over, whatever the overall clock says.
    if (attempt.status === 'in_progress' && (attempt.sections || []).length) {
        const moved = await moveSections(attempt);
        if ((Number(moved.currentSection) || 0) >= moved.sections.length) return submitAttempt(req, exam, moved, { auto: true });
        return moved;
    }
    return attempt;
}

/** Close sections whose time is up (services/admission/examPlan.js advance), compare-and-set on the section. */
async function moveSections(attempt, { early = false } = {}) {
    if (!(attempt.sections || []).length || attempt.status !== 'in_progress') return attempt;
    const next = require('./examPlan').advance(attempt, { early });
    if (!next) return attempt;
    const { rows: [row] } = await pool.query(
        `UPDATE "admissionattempts" SET "sections" = $3::jsonb, "currentSection" = $4, "updatedAt" = now()
          WHERE "_id" = $1 AND "status" = 'in_progress' AND "currentSection" = $2 RETURNING *`,
        [String(attempt._id), Number(attempt.currentSection) || 0, JSON.stringify(next.sections), next.currentSection]);
    return row || (await AdmissionAttempt.findById(attempt._id).lean());
}

/** The candidate is done with the open section before its time: the next one opens now. */
async function nextSection(req, exam, attempt) {
    attempt = await finishIfDue(req, exam, attempt);
    if (attempt.status !== 'in_progress') return attempt;
    if (!(attempt.sections || []).length) refuse('This exam has no sections', 409);
    const moved = await moveSections(attempt, { early: true });
    if ((Number(moved.currentSection) || 0) >= moved.sections.length) return submitAttempt(req, exam, moved, {});
    return moved;
}

async function recordViolation(attempt, type) {
    const kind = ['tab_hidden', 'window_blur', 'fullscreen_exit', 'copy', 'paste', 'context_menu'].includes(type) ? type : 'other';
    await patch(AdmissionAttempt, attempt._id, {}, { push: { violations: { type: kind, at: new Date() } }, where: { status: 'in_progress' } }).catch(() => {});
}

/** Sweep: every open attempt whose time is up. */
async function autoSubmitDue() {
    const { rows } = await pool.query(`SELECT * FROM "admissionattempts" WHERE "status" = 'in_progress' AND "deadlineAt" < now() - interval '15 seconds' LIMIT 100`);
    let n = 0;
    for (const att of rows) {
        const exam = await AdmissionExam.findById(att.exam).lean();
        if (!exam) continue;
        try { await submitAttempt(null, exam, att, { auto: true }); n += 1; } catch (e) { console.error('[admission] auto-submit:', e.message); }
    }
    return n;
}

// ── Marks, evaluation and results ────────────────────────────────────────────

function gradeFor(exam, pct) {
    if (pct == null) return '';
    const band = (exam.gradeBands || []).find((b) => pct >= b.min);
    return band ? band.grade : '';
}

/** Recompute the working figures of one result row from its marks. */
function compute(exam, row) {
    if (row.absent) return { total: null, percentage: null, grade: 'AB', passed: false };
    let total;
    let passedSubjects = true;
    if (exam.mode === 'online') {
        total = round2((Number(row.autoScore) || 0) + (Number(row.manualScore) || 0));
    } else {
        total = 0;
        for (const s of exam.subjects || []) {
            const m = row.marks?.[s.key];
            if (m == null) continue;
            total += Number(m);
            if (s.passMarks && Number(m) < s.passMarks) passedSubjects = false;
        }
        total = round2(total);
    }
    const max = Number(exam.maxMarks) || 0;
    const percentage = max > 0 ? round2((total / max) * 100) : null;
    const passed = passedSubjects && total >= (Number(exam.passMarks) || 0);
    return { total, percentage, grade: gradeFor(exam, percentage), passed };
}

async function upsertResult(req, exam, candidate, { marks, absent = false, remarks, autoScore, manualScore, attempt } = {}) {
    const applicationId = String(candidate.application);
    const existing = await AdmissionResult.findOne({ exam: exam._id, application: applicationId }).lean();
    if (existing && ['approved', 'published'].includes(existing.status)) refuse('This result is approved — correct it instead', 409, { code: 'RESULT_LOCKED' });
    const base = existing || { marks: {}, absent: false };
    const next = {
        ...base,
        marks: marks !== undefined ? marks : base.marks,
        absent: !!absent,
        autoScore: autoScore !== undefined ? autoScore : base.autoScore,
        manualScore: manualScore !== undefined ? manualScore : attempt ? manualTotal(attempt) : base.manualScore,
    };
    const figures = compute(exam, next);
    const set = {
        marks: next.marks, absent: next.absent, autoScore: next.autoScore, manualScore: next.manualScore, ...figures,
        ...(remarks !== undefined ? { remarks: str(remarks, 500) } : {}), enteredBy: req?.userId || null, enteredAt: new Date(),
        candidate: candidate._id || base.candidate || null, status: 'draft',
    };
    if (existing) return patch(AdmissionResult, existing._id, set);
    return (await AdmissionResult.create({ school: exam.school, exam: exam._id, application: applicationId, ...set })).toObject();
}

const manualTotal = (attempt) => {
    const vals = Object.values(attempt?.manualMarks || {}).map((m) => Number(m?.marks)).filter((n) => Number.isFinite(n));
    return vals.length ? round2(vals.reduce((s, n) => s + n, 0)) : null;
};

/** May this person enter marks for this exam? Administrators, and its evaluators. */
async function canEvaluate(req, exam) {
    if (await require('./access').isAdmin(req)) return true;
    return (exam.evaluators || []).map(String).includes(String(req.userId));
}

/**
 * Whose marks this person may enter: everyone's (an administrator or one of
 * the exam's evaluators), only the candidates whose interview panel they sit
 * on, or nobody's. Returns { all: true } | { candidates: Set<id> } | null.
 */
async function markingScope(req, exam) {
    if (await canEvaluate(req, exam)) return { all: true };
    if (exam.mode !== 'interview') return null;
    const { rows } = await pool.query(
        `SELECT "_id" FROM "admissioncandidates" WHERE "exam" = $1 AND "status" <> 'withdrawn' AND "panel" @> to_jsonb($2::text)`,
        [String(exam._id), String(req.userId)]);
    return rows.length ? { candidates: new Set(rows.map((r) => String(r._id))) } : null;
}
const inScope = (scope, candidateId) => !!scope && (scope.all || scope.candidates.has(String(candidateId)));

/**
 * Enter offline / interview marks for several candidates at once:
 * [{ candidate, marks: { subjectKey: n }, absent, remarks }].
 */
async function enterMarks(req, exam, rows) {
    if (exam.mode === 'online') refuse('Marks for an online exam come from its attempts', 409);
    if (exam.status !== 'scheduled' && exam.status !== 'completed') refuse('This exam is not open for marks', 409);
    const scope = await markingScope(req, exam);
    if (!scope) refuse('You are not an evaluator of this exam', 403);
    if (['approved', 'published'].includes(exam.resultsStatus)) refuse('Results are approved — use corrections', 409, { code: 'RESULT_LOCKED' });
    const list = (Array.isArray(rows) ? rows : []).slice(0, 500);
    let saved = 0;
    const problems = [];
    for (const r of list) {
        if (!isId(String(r?.candidate || ''))) continue;
        if (!inScope(scope, r.candidate)) { problems.push('A candidate you are not on the panel for was skipped'); continue; }
        const cand = await AdmissionCandidate.findOne({ _id: r.candidate, exam: exam._id, school: exam.school }).lean();
        if (!cand || cand.status === 'withdrawn') { problems.push('A candidate was not found'); continue; }
        const marks = {};
        let bad = null;
        for (const s of exam.subjects || []) {
            const raw = r.marks?.[s.key];
            if (raw === '' || raw == null) continue;
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0 || n > s.maxMarks) { bad = `${cand.rollNumber}: ${s.name} must be between 0 and ${s.maxMarks}`; break; }
            marks[s.key] = round2(n);
        }
        if (bad) { problems.push(bad); continue; }
        try {
            await upsertResult(req, exam, cand, { marks, absent: !!r.absent, remarks: r.remarks });
            if (!r.absent && cand.status === 'scheduled') await patch(AdmissionCandidate, cand._id, { status: 'present' });
            if (r.absent) await patch(AdmissionCandidate, cand._id, { status: 'absent' });
            await markSat(req, exam, cand.application);
            saved += 1;
        } catch (e) { problems.push(`${cand.rollNumber}: ${e.message}`); }
    }
    // New or changed marks: the results are being worked on again.
    if (saved && ['none', 'submitted'].includes(exam.resultsStatus)) await patch(AdmissionExam, exam._id, { resultsStatus: 'in_progress' });
    return { saved, problems };
}

/** An evaluator marks the descriptive answers of an attempt. */
async function evaluateAttempt(req, exam, attempt, marksByQuestion) {
    if (!(await canEvaluate(req, exam))) refuse('You are not an evaluator of this exam', 403);
    if (attempt.status === 'in_progress') refuse('The attempt is still in progress', 409);
    const res = await AdmissionResult.findOne({ exam: exam._id, application: attempt.application }).lean();
    if (res && ['approved', 'published'].includes(res.status)) refuse('This result is approved — use corrections', 409, { code: 'RESULT_LOCKED' });
    const questions = await AdmissionQuestion.find({ exam: exam._id, type: 'descriptive' }).lean();
    const byId = new Map(questions.map((q) => [String(q._id), q]));
    const manual = { ...(attempt.manualMarks || {}) };
    for (const [qid, v] of Object.entries(marksByQuestion || {})) {
        const q = byId.get(qid);
        if (!q || !(attempt.questionOrder || []).map(String).includes(qid)) continue;
        const n = Number(v?.marks ?? v);
        if (!Number.isFinite(n) || n < 0 || n > q.marks) refuse(`Marks must be between 0 and ${q.marks}`, 400);
        manual[qid] = { marks: round2(n), by: String(req.userId), at: new Date(), remark: str(v?.remark, 300) };
    }
    const all = await AdmissionQuestion.find({ exam: exam._id }).lean();
    const scored = scoreAttempt(exam, all, { ...attempt, manualMarks: manual });
    const row = await patch(AdmissionAttempt, attempt._id, { manualMarks: manual, manualPending: scored.pendingManual });
    const cand = attempt.candidate ? await AdmissionCandidate.findById(attempt.candidate).lean() : { application: attempt.application };
    const counts = await require('./examPlan').counting(exam, attempt.application);
    await upsertResult(req, exam, cand, counts ? { autoScore: counts.autoScore, manualScore: counts.manualScore } : { attempt: row, autoScore: attempt.autoScore });
    if (['none', 'submitted'].includes(exam.resultsStatus)) await patch(AdmissionExam, exam._id, { resultsStatus: 'in_progress' });
    return row;
}

/** Results of an exam, with each candidate — the office's working view. */
async function resultsBoard(exam, { includeRemarks = true } = {}) {
    const { rows } = await pool.query(
        `SELECT c."_id" AS "candidateId", c."rollNumber", c."status" AS "candidateStatus", c."slot", c."slotId", c."room", c."extraMinutes", c."extraReason",
                a."_id" AS "applicationId", a."applicationNumber", a."studentName", a."class", a."status" AS "applicationStatus",
                r."_id" AS "resultId", r."marks", r."autoScore", r."manualScore", r."total", r."percentage", r."grade", r."passed", r."absent",
                r."status" AS "resultStatus", r."remarks", r."published", r."corrections",
                t."_id" AS "attemptId", t."status" AS "attemptStatus", t."manualPending", t."submittedAt", t."startedAt", jsonb_array_length(COALESCE(t."violations", '[]'::jsonb)) AS "violations"
           FROM "admissioncandidates" c
           JOIN ${TA} a ON a."_id" = c."application"
           LEFT JOIN "admissionresults" r ON r."exam" = c."exam" AND r."application" = c."application"
           LEFT JOIN LATERAL (SELECT * FROM "admissionattempts" x WHERE x."exam" = c."exam" AND x."application" = c."application" ORDER BY x."attemptNo" DESC LIMIT 1) t ON true
          WHERE c."exam" = $1 AND c."status" <> 'withdrawn'
          ORDER BY c."rollNumber"`, [String(exam._id)]);
    // What the exam page noticed (left the page, left full screen, copy/paste): counts to look at — never a mark.
    const ids = rows.map((r) => r.attemptId).filter(Boolean);
    const { rows: sig } = ids.length ? await pool.query(`SELECT "_id", "violations", "extraMinutes" FROM "admissionattempts" WHERE "_id" = ANY($1::uuid[])`, [ids]) : { rows: [] };
    const byAttempt = new Map(sig.map((x) => [String(x._id), x]));
    const planSvc = require('./examPlan');
    return rows.map((r) => {
        const a = byAttempt.get(String(r.attemptId));
        const out = { ...r, signals: a ? planSvc.signals(a) : {} };
        return includeRemarks ? out : { ...out, remarks: undefined };
    });
}

/** Check every candidate is marked: what is still missing. */
async function missingMarks(exam) {
    const board = await resultsBoard(exam);
    const missing = [];
    for (const b of board) {
        if (exam.mode === 'online') {
            if (!b.attemptId && b.candidateStatus !== 'absent') missing.push(`${b.rollNumber}: did not take the exam yet`);
            else if (b.attemptStatus === 'in_progress') missing.push(`${b.rollNumber}: still taking the exam`);
            else if (Number(b.manualPending) > 0) missing.push(`${b.rollNumber}: ${b.manualPending} answer(s) to evaluate`);
        } else if (!b.resultId) missing.push(`${b.rollNumber}: no marks`);
    }
    return { board, missing };
}

/** Online candidates who never started by the time the window closed count as absent. */
async function closeOnlineAbsentees(req, exam) {
    if (exam.mode !== 'online' || new Date(exam.endsAt) > new Date()) return 0;
    const { rows } = await pool.query(
        `SELECT c.* FROM "admissioncandidates" c
          WHERE c."exam" = $1 AND c."status" = 'scheduled'
            AND NOT EXISTS (SELECT 1 FROM "admissionattempts" t WHERE t."exam" = c."exam" AND t."application" = c."application")`, [String(exam._id)]);
    for (const c of rows) {
        await patch(AdmissionCandidate, c._id, { status: 'absent' });
        await upsertResult(req, exam, c, { absent: true });
        await markSat(req, exam, c.application);
    }
    return rows.length;
}

async function submitResults(req, exam) {
    if (!(await canEvaluate(req, exam))) refuse('You are not an evaluator of this exam', 403);
    await closeOnlineAbsentees(req, exam);
    const { missing } = await missingMarks(exam);
    if (missing.length) refuse(`Marks are not complete: ${missing.slice(0, 5).join('; ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}`, 409, { errors: missing.map((m) => ({ path: 'marks', message: m })) });
    await pool.query(`UPDATE "admissionresults" SET "status" = 'submitted', "submittedBy" = $2, "submittedAt" = now(), "updatedAt" = now() WHERE "exam" = $1 AND "status" = 'draft'`, [String(exam._id), String(req.userId)]);
    const row = await patch(AdmissionExam, exam._id, { resultsStatus: 'submitted', status: new Date(exam.endsAt || exam.startsAt) < new Date() ? 'completed' : exam.status });
    events.recordQuietly(exam.school, { by: req, type: 'result', action: 'submitted', message: `${exam.name}: results submitted for approval` });
    return row;
}

async function approveResults(req, exam) {
    if (!(await require('./access').isAdmin(req))) refuse('Approving results needs an admission administrator', 403);
    if (exam.approvalRequired && exam.resultsStatus !== 'submitted') refuse('The evaluators have not submitted the results yet', 409);
    if (!exam.approvalRequired && !['submitted', 'in_progress'].includes(exam.resultsStatus)) refuse('There are no results to approve', 409);
    if (!exam.approvalRequired) {
        const { missing } = await missingMarks(exam);
        if (missing.length) refuse(`Marks are not complete: ${missing.slice(0, 5).join('; ')}`, 409);
    }
    await pool.query(`UPDATE "admissionresults" SET "status" = 'approved', "approvedBy" = $2, "approvedAt" = now(), "updatedAt" = now() WHERE "exam" = $1 AND "status" IN ('draft', 'submitted')`, [String(exam._id), String(req.userId)]);
    const row = await patch(AdmissionExam, exam._id, { resultsStatus: 'approved', resultsApprovedAt: new Date(), resultsApprovedBy: req.userId, status: 'completed' });
    events.recordQuietly(exam.school, { by: req, type: 'result', action: 'approved', message: `${exam.name}: results approved` });
    return row;
}

/** Publish now, or at a set time (the sweep does it then). */
async function publishResults(req, exam, { at = null } = {}) {
    if (!['approved', 'published'].includes(exam.resultsStatus)) refuse('Approve the results before publishing them', 409);
    const when = at ? new Date(at) : null;
    if (when && Number.isNaN(when.getTime())) refuse('Choose a valid date and time');
    if (when && when > new Date(Date.now() + 60000)) {
        const row = await patch(AdmissionExam, exam._id, { resultPublishAt: when });
        events.recordQuietly(exam.school, { by: req, type: 'result', action: 'scheduled', message: `${exam.name}: results will be published on ${fmt.fmtDateTime(when)}` });
        return { scheduled: true, exam: row };
    }
    return publishResultsNow(req, exam);
}

async function publishResultsNow(req, exam) {
    const { rows } = await pool.query(
        `UPDATE "admissionresults" r SET "status" = 'published',
                "published" = jsonb_build_object('total', r."total", 'percentage', r."percentage", 'grade', r."grade", 'passed', r."passed",
                                                 'absent', r."absent", 'marks', r."marks", 'publishedAt', now()),
                "updatedAt" = now()
          WHERE r."exam" = $1 AND (r."status" = 'approved' OR (r."status" = 'published' AND (r."published"->>'outdated')::boolean IS TRUE))
          RETURNING r."application"`, [String(exam._id)]);
    const first = exam.resultsStatus !== 'published';
    const row = await patch(AdmissionExam, exam._id, { resultsStatus: 'published', resultsPublishedAt: exam.resultsPublishedAt || new Date(), resultPublishAt: null });
    if (rows.length) {
        const { rows: apps } = await pool.query(`SELECT * FROM ${TA} WHERE "_id" = ANY($1::uuid[])`, [rows.map((r) => r.application)]);
        for (const app of apps) {
            events.recordQuietly(app.school, { application: app._id, by: req, type: 'result', action: first ? 'published' : 'republished', message: `${exam.name}: result ${first ? 'published' : 'updated'}`, visibility: 'applicant' });
            notify.toApplicant(app, 'result_published', { exam_name: exam.name });
        }
    }
    events.recordQuietly(exam.school, { by: req, type: 'result', action: 'published', message: `${exam.name}: ${rows.length} result(s) published` });
    return { published: rows.length, exam: row };
}

/** Correct an approved or published result — with the reason, kept with the result. */
async function correctResult(req, exam, result, { marks, absent, autoScore, manualScore, reason }) {
    if (!(await require('./access').isAdmin(req))) refuse('Corrections need an admission administrator', 403);
    const why = str(reason, 300);
    if (!why) refuse('Say why the result is being corrected', 400, { field: 'reason' });
    if (!['approved', 'published'].includes(result.status)) refuse('Only an approved result is corrected this way — edit the marks instead', 409);
    const before = { marks: result.marks, total: result.total, percentage: result.percentage, grade: result.grade, passed: result.passed, absent: result.absent };
    const next = { ...result };
    if (marks !== undefined) {
        const clean = {};
        for (const s of exam.subjects || []) {
            const raw = marks?.[s.key];
            if (raw === '' || raw == null) continue;
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0 || n > s.maxMarks) refuse(`${s.name} must be between 0 and ${s.maxMarks}`);
            clean[s.key] = round2(n);
        }
        next.marks = clean;
    }
    if (absent !== undefined) next.absent = !!absent;
    if (autoScore !== undefined && exam.mode === 'online') next.autoScore = num(autoScore, { min: 0, max: exam.maxMarks || 1e6, d: result.autoScore });
    if (manualScore !== undefined && exam.mode === 'online') next.manualScore = num(manualScore, { min: 0, max: exam.maxMarks || 1e6, d: result.manualScore });
    const figures = compute(exam, next);
    const after = { marks: next.marks, ...figures, absent: next.absent };
    const published = result.published ? { ...result.published, outdated: true } : null;
    const row = await patch(AdmissionResult, result._id, {
        marks: next.marks, absent: next.absent, autoScore: next.autoScore, manualScore: next.manualScore, ...figures, published,
    }, { push: { corrections: { at: new Date(), by: String(req.userId), byName: req.user?.name || '', reason: why, before, after } } });
    events.recordQuietly(exam.school, { application: result.application, by: req, type: 'result', action: 'corrected', message: `${exam.name}: result corrected — ${why}`, meta: { before, after } });
    return row;
}

/** Sweep: results whose publication time has come. */
async function publishDue() {
    const { rows } = await pool.query(`SELECT * FROM "admissionexams" WHERE "resultsStatus" = 'approved' AND "resultPublishAt" IS NOT NULL AND "resultPublishAt" <= now() LIMIT 20`);
    let n = 0;
    for (const exam of rows) {
        const claimed = await patch(AdmissionExam, exam._id, { resultPublishAt: null }, { where: { resultsStatus: 'approved' } });
        if (!claimed) continue;
        try { await publishResultsNow(null, exam); n += 1; } catch (e) { console.error('[admission] scheduled results:', e.message); }
    }
    return n;
}

/** What a family sees of their result: the published snapshot, only once published. */
function publishedView(exam, result) {
    if (!result?.published || exam.resultsStatus !== 'published' || !exam.resultsPublishedAt || new Date(exam.resultsPublishedAt) > new Date()) return null;
    const p = result.published;
    return {
        exam: exam.name, mode: exam.mode, maxMarks: exam.maxMarks, passMarks: exam.passMarks,
        total: p.total, percentage: p.percentage, grade: p.grade, passed: p.passed, absent: p.absent,
        subjects: exam.mode === 'online' ? [] : (exam.subjects || []).map((s) => ({ name: s.name, maxMarks: s.maxMarks, marks: p.marks?.[s.key] ?? null })),
        publishedAt: p.publishedAt,
    };
}

module.exports = {
    QUESTION_TYPES, normalizeExam, createExam, updateExam, schedule, cancel, readiness, onlineMaxMarks, nextSection, moveSections,
    normalizeQuestion, questionProblem, addQuestion, updateQuestion, deleteQuestion, importQuestions,
    eligible, assignCandidates, removeCandidate, setSlot, attendance, examValues,
    startAttempt, attemptView, saveAnswers, submitAttempt, finishIfDue, recordViolation, autoSubmitDue, scoreAttempt,
    compute, enterMarks, evaluateAttempt, resultsBoard, missingMarks, submitResults, approveResults, publishResults, publishResultsNow,
    correctResult, publishDue, publishedView, canEvaluate, markingScope, closeOnlineAbsentees,
};
