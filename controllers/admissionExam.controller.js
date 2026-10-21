'use strict';
/**
 * Entrance exams and interviews: setting them up (administrators), and
 * marking them (administrators and the exam's assigned evaluators — the
 * service checks which, per exam).
 */
const pool = require('../db/pool');
const { patch } = require('../db/patch');
const AdmissionExam = require('../models/AdmissionExam');
const AdmissionQuestion = require('../models/AdmissionQuestion');
const AdmissionCandidate = require('../models/AdmissionCandidate');
const AdmissionAttempt = require('../models/AdmissionAttempt');
const AdmissionResult = require('../models/AdmissionResult');
const access = require('../services/admission/access');
const exams = require('../services/admission/exams');
const documents = require('../services/admission/documents');
const settingsSvc = require('../services/admission/settings');
const exportsSvc = require('../services/admission/exports');
const pdf = require('../services/admission/pdf');
const { handler, refuse, isId, ids } = require('../services/admission/util');

const TAG = 'admission exams';

const examOf = (req, id) => access.schoolRow(AdmissionExam, req, id, 'Exam');

/** An evaluator may open only the exams they are assigned to. */
async function examForMarker(req, id) {
    const exam = await examOf(req, id);
    if (!(await exams.canEvaluate(req, exam))) refuse('You are not an evaluator of this exam', 403);
    return exam;
}

/** Evaluators — and, for an interview, its panel members for their own candidates. */
async function examForPanel(req, id) {
    const exam = await examOf(req, id);
    const scope = await exams.markingScope(req, exam);
    if (!scope) refuse('You are not an evaluator of this exam', 403);
    return { exam, scope };
}

exports.list = handler(async (req, res) => {
    const params = [String(req.schoolId)];
    let extra = '';
    if (req.query.round && isId(String(req.query.round))) { params.push(String(req.query.round)); extra = ` AND e."round" = $2`; }
    const { rows } = await pool.query(
        `SELECT e.*, r."name" AS "roundName",
                (SELECT COUNT(*) FROM "admissioncandidates" c WHERE c."exam" = e."_id" AND c."status" <> 'withdrawn')::int AS candidates,
                (SELECT COUNT(*) FROM "admissionquestions" q WHERE q."exam" = e."_id" AND q."isActive")::int AS questions
           FROM "admissionexams" e JOIN "admissionrounds" r ON r."_id" = e."round"
          WHERE e."school" = $1${extra} ORDER BY e."startsAt" DESC NULLS LAST`, params);
    res.json({ success: true, data: rows });
}, TAG);

exports.create = handler(async (req, res) => res.status(201).json({ success: true, data: await exams.createExam(req, req.body || {}) }), TAG);

exports.detail = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    const [questions, readiness, counts] = await Promise.all([
        AdmissionQuestion.find({ exam: exam._id }).sort({ order: 1 }).lean(),
        exams.readiness(exam),
        pool.query(`SELECT "status", COUNT(*)::int AS n FROM "admissioncandidates" WHERE "exam" = $1 GROUP BY 1`, [String(exam._id)]).then((r) => Object.fromEntries(r.rows.map((x) => [x.status, x.n]))),
    ]);
    const { rows: [att] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionattempts" WHERE "exam" = $1`, [String(exam._id)]);
    res.json({ success: true, data: { exam, questions, readiness, candidates: counts, attempts: att.n, questionsLocked: att.n > 0 } });
}, TAG);

exports.update = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    res.json({ success: true, data: await exams.updateExam(req, exam, req.body || {}) });
}, TAG);

exports.schedule = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    res.json({ success: true, data: await exams.schedule(req, exam) });
}, TAG);

exports.cancel = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    res.json({ success: true, data: await exams.cancel(req, exam, req.body?.reason) });
}, TAG);

exports.remove = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    if (exam.status !== 'draft') refuse('Only a draft exam can be deleted — cancel it instead', 409);
    const { rows: [n] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissioncandidates" WHERE "exam" = $1`, [String(exam._id)]);
    if (n.n) refuse('Candidates are scheduled for this exam — cancel it instead', 409);
    await pool.query(`DELETE FROM "admissionexams" WHERE "_id" = $1 AND "school" = $2`, [String(exam._id), String(req.schoolId)]);
    res.json({ success: true });
}, TAG);

// ── Questions ────────────────────────────────────────────────────────────────

exports.addQuestion = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    if (exam.mode !== 'online') refuse('Only an online exam has questions', 409);
    res.status(201).json({ success: true, data: await exams.addQuestion(req, exam, req.body || {}) });
}, TAG);

async function questionOf(req, id) {
    const q = await access.schoolRow(AdmissionQuestion, req, id, 'Question');
    const exam = q.exam ? await AdmissionExam.findById(q.exam).lean() : null;
    return { q, exam };
}

exports.updateQuestion = handler(async (req, res) => {
    const { q, exam } = await questionOf(req, req.params.questionId);
    res.json({ success: true, data: await exams.updateQuestion(req, q, exam, req.body || {}) });
}, TAG);

exports.deleteQuestion = handler(async (req, res) => {
    const { q, exam } = await questionOf(req, req.params.questionId);
    res.json({ success: true, data: await exams.deleteQuestion(req, q, exam) });
}, TAG);

exports.orderQuestions = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    const { rows: [att] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionattempts" WHERE "exam" = $1`, [String(exam._id)]);
    if (att.n) refuse('Applicants have started this exam — its questions can no longer change', 409);
    const list = ids(req.body?.ids);
    for (let i = 0; i < list.length; i++) await pool.query(`UPDATE "admissionquestions" SET "order" = $3 WHERE "_id" = $1 AND "exam" = $2`, [list[i], String(exam._id), i + 1]);
    res.json({ success: true });
}, TAG);

exports.importQuestions = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    res.json({ success: true, data: await exams.importQuestions(req, exam, req.body?.ids) });
}, TAG);

exports.bank = handler(async (req, res) => {
    const params = [String(req.schoolId)];
    const where = ['q."school" = $1', 'q."exam" IS NULL', 'q."isActive"'];
    if (req.query.q) { params.push(`%${String(req.query.q).toLowerCase()}%`); where.push(`lower(q."text") LIKE $${params.length}`); }
    if (req.query.tag) { params.push(JSON.stringify([String(req.query.tag)])); where.push(`q."tags" @> $${params.length}::jsonb`); }
    if (req.query.type) { params.push(String(req.query.type)); where.push(`q."type" = $${params.length}`); }
    const { rows } = await pool.query(`SELECT * FROM "admissionquestions" q WHERE ${where.join(' AND ')} ORDER BY q."order" DESC LIMIT 300`, params);
    res.json({ success: true, data: rows });
}, TAG);

exports.addToBank = handler(async (req, res) => res.status(201).json({ success: true, data: await exams.addQuestion(req, null, req.body || {}) }), TAG);

// ── Candidates ───────────────────────────────────────────────────────────────

exports.eligible = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    res.json({ success: true, data: await exams.eligible(exam) });
}, TAG);

exports.assign = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    const which = req.body?.applicationIds === 'all' ? 'all' : req.body?.applicationIds;
    res.json({ success: true, data: await exams.assignCandidates(req, exam, which) });
}, TAG);

async function candidateOf(exam, id) {
    if (!isId(String(id || ''))) refuse('Candidate not found', 404);
    const c = await AdmissionCandidate.findOne({ _id: id, exam: exam._id, school: exam.school }).lean();
    if (!c) refuse('Candidate not found', 404);
    return c;
}

exports.removeCandidate = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    res.json({ success: true, data: await exams.removeCandidate(req, exam, await candidateOf(exam, req.params.candidateId)) });
}, TAG);

exports.updateCandidate = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    const cand = await candidateOf(exam, req.params.candidateId);
    if (req.body?.panel !== undefined && ids(req.body.panel).length) {
        const n = await require('../models/User').countDocuments({ _id: { $in: ids(req.body.panel) }, school: req.schoolId, role: { $in: ['teacher', 'school_admin'] } });
        if (n !== ids(req.body.panel).length) refuse('Panel members must be staff of the school');
    }
    res.json({ success: true, data: await exams.setSlot(req, exam, cand, req.body || {}) });
}, TAG);

exports.attendance = handler(async (req, res) => {
    const { exam } = await examForPanel(req, req.params.id);
    res.json({ success: true, data: await exams.attendance(req, exam, await candidateOf(exam, req.params.candidateId), req.body?.present === true) });
}, TAG);

exports.admitCard = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    const cand = await candidateOf(exam, req.params.candidateId);
    const app = await access.schoolApplication(req, cand.application);
    const school = (await pool.query(`SELECT "name", "logo" FROM "schools" WHERE "_id" = $1`, [String(req.schoolId)])).rows[0];
    const { rows: [cls] } = await pool.query(`SELECT "className" FROM "classes" WHERE "_id" = $1`, [String(app.class)]);
    const settings = await settingsSvc.getSettings(req.schoolId);
    const photo = (await documents.currentDocs(app._id)).find((d) => d.docKey === 'photo');
    await pdf.admitCard(res, {
        school, theme: settings.portal.theme?.primary, app, exam, candidate: cand, className: cls?.className || '',
        photo: photo && /\.(jpe?g|png)$/i.test(photo.file) ? await require('../services/admission/fileStore').readBuffer(photo.file) : null,
        venueText: [exam.venue?.name, exam.venue?.room, exam.venue?.address].filter(Boolean).join(', '),
    });
}, TAG);

// ── Marks, evaluation, results ───────────────────────────────────────────────

exports.results = handler(async (req, res) => {
    const { exam, scope } = await examForPanel(req, req.params.id);
    const isAdmin = await access.isAdmin(req);
    const { board, missing } = await exams.missingMarks(exam);
    const mine = scope.all ? board : board.filter((b) => scope.candidates.has(String(b.candidateId)));
    res.json({
        success: true,
        data: {
            exam, board: isAdmin ? mine : mine.map((b) => ({ ...b, published: undefined, corrections: undefined })),
            missing: scope.all ? missing : [], isAdmin, panelOnly: !scope.all,
        },
    });
}, TAG);

exports.enterMarks = handler(async (req, res) => {
    const { exam } = await examForPanel(req, req.params.id);
    res.json({ success: true, data: await exams.enterMarks(req, exam, req.body?.rows) });
}, TAG);

exports.attempt = handler(async (req, res) => {
    if (!isId(String(req.params.attemptId || ''))) refuse('Attempt not found', 404);
    const att = await AdmissionAttempt.findOne({ _id: req.params.attemptId, school: req.schoolId }).lean();
    if (!att) refuse('Attempt not found', 404);
    const exam = await examForMarker(req, att.exam);
    const questions = await AdmissionQuestion.find({ exam: exam._id }).lean();
    const byId = new Map(questions.map((q) => [String(q._id), q]));
    const scored = exams.scoreAttempt(exam, questions, att);
    const { rows: [app] } = await pool.query(`SELECT "applicationNumber", "studentName" FROM "admissionapplications" WHERE "_id" = $1`, [String(att.application)]);
    res.json({
        success: true,
        data: {
            attempt: { _id: att._id, status: att.status, startedAt: att.startedAt, submittedAt: att.submittedAt, autoScore: att.autoScore, manualPending: att.manualPending, violations: att.violations || [] },
            application: app,
            questions: (att.questionOrder || []).map((qid, i) => {
                const q = byId.get(String(qid));
                if (!q) return null;
                return { _id: q._id, number: i + 1, type: q.type, text: q.text, marks: q.marks, options: q.options, correct: q.correct, answer: att.answers?.[qid] || null, result: scored.perQuestion[qid] || null, manual: att.manualMarks?.[qid] || null };
            }).filter(Boolean),
        },
    });
}, TAG);

exports.evaluate = handler(async (req, res) => {
    if (!isId(String(req.params.attemptId || ''))) refuse('Attempt not found', 404);
    const att = await AdmissionAttempt.findOne({ _id: req.params.attemptId, school: req.schoolId }).lean();
    if (!att) refuse('Attempt not found', 404);
    const exam = await examForMarker(req, att.exam);
    const row = await exams.evaluateAttempt(req, exam, att, req.body?.marks);
    res.json({ success: true, data: { manualPending: row.manualPending } });
}, TAG);

exports.submitResults = handler(async (req, res) => {
    const exam = await examForMarker(req, req.params.id);
    res.json({ success: true, data: await exams.submitResults(req, exam) });
}, TAG);

exports.approveResults = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    res.json({ success: true, data: await exams.approveResults(req, exam) });
}, TAG);

exports.publishResults = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    res.json({ success: true, data: await exams.publishResults(req, exam, { at: req.body?.at || null }) });
}, TAG);

exports.correctResult = handler(async (req, res) => {
    const result = await access.schoolRow(AdmissionResult, req, req.params.resultId, 'Result');
    const exam = await examOf(req, result.exam);
    res.json({ success: true, data: await exams.correctResult(req, exam, result, req.body || {}) });
}, TAG);

exports.exportResults = handler(async (req, res) => {
    const exam = await examOf(req, req.params.id);
    const board = await exams.resultsBoard(exam);
    const subjects = exam.subjects || [];
    const header = ['Roll no.', 'Application', 'Student', 'Attendance', ...subjects.map((s) => `${s.name} (/${s.maxMarks})`), ...(exam.mode === 'online' ? ['Objective', 'Descriptive'] : []), 'Total', 'Percentage', 'Grade', 'Result', 'Status'];
    const body = board.map((b) => [
        b.rollNumber, b.applicationNumber, b.studentName, b.absent ? 'Absent' : b.candidateStatus,
        ...subjects.map((s) => b.marks?.[s.key] ?? ''), ...(exam.mode === 'online' ? [b.autoScore ?? '', b.manualScore ?? ''] : []),
        b.total ?? '', b.percentage ?? '', b.grade || '', b.passed == null ? '' : b.passed ? 'Qualified' : 'Not qualified', b.resultStatus || 'not entered',
    ]);
    exportsSvc.send(res, { filename: `results-${exam.name.replace(/[^\w-]+/g, '_')}`, sheet: 'Results', header, body, format: req.query.format === 'csv' ? 'csv' : 'xlsx' });
}, TAG);
