'use strict';
/**
 * Admin → Results & Assessments.
 *
 * Nothing is decided here. What an exam may do next is services/resultExams
 * (one set of rules, shared with the teacher's endpoints); what a screen shows
 * is services/resultBoard (SQL read models). These handlers translate a
 * request into one call and a RuleError into its status.
 *
 * Paths and response shapes the phone app already uses are kept: the list
 * still answers `{ data: [...], total, page, pages }` with `section`,
 * `academicYear` and `class` nested, approve / reject / reopen keep their
 * routes, and marks-review keeps `{ exam, sheets }`.
 */
const exams = require('../services/resultExams');
const board = require('../services/resultBoard');
const resultSettings = require('../services/resultSettings');
const reportCard = require('../services/reportCard');
const ClassSection = require('../models/ClassSection');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');

const ctxOf = (req) => ({ schoolId: req.schoolId, userId: req.userId, userRole: req.userRole });

/**
 * Run a handler; a broken rule answers with its own status and message. A
 * request with no school (the platform's own account) has no Results to work
 * on: it is told so, instead of a 500 from a query that needed one.
 */
const handle = (fn) => async (req, res) => {
    if (!req.schoolId) return res.status(400).json({ success: false, message: 'Open a school first — Results belong to a school' });
    try {
        await fn(req, res);
    } catch (e) {
        if (e instanceof exams.RuleError || e instanceof resultSettings.SettingsError) {
            return res.status(e.status).json({ success: false, message: e.message, ...(e.extra || {}) });
        }
        console.error('[results]', e);
        res.status(500).json({ success: false, message: e.message });
    }
};

const notFound = (res) => res.status(404).json({ success: false, message: 'Exam not found' });

/* ── Reads ────────────────────────────────────────────────────────────────── */

exports.getOverview = handle(async (req, res) => {
    res.json({ success: true, data: await board.overview(req.schoolId) });
});

exports.getExams = handle(async (req, res) => {
    res.json({ success: true, ...(await board.list(req.schoolId, req.query)) });
});

exports.getExamDetail = handle(async (req, res) => {
    const data = await board.detail(req.schoolId, req.params.id);
    if (!data) return notFound(res);
    res.json({ success: true, data });
});

/** Kept for the phone app: the same exam, under the two keys it reads. */
exports.getMarksReview = handle(async (req, res) => {
    const exam = await board.detail(req.schoolId, req.params.id);
    if (!exam) return notFound(res);
    res.json({ success: true, data: { exam, sheets: exam.sheets } });
});

exports.getResult = handle(async (req, res) => {
    const out = await board.results(req.schoolId, req.params.id);
    if (!out) return notFound(res);
    res.json({ success: true, ...out });
});

exports.getMarks = handle(async (req, res) => {
    const data = await board.marksSheet(req.schoolId, req.params.id, req.params.subjectId);
    if (!data) return res.status(404).json({ success: false, message: 'That subject is not part of this exam' });
    res.json({ success: true, data });
});

exports.getFormMeta = handle(async (req, res) => {
    res.json({ success: true, data: await board.formMeta(req.schoolId) });
});

exports.getFormSubjects = handle(async (req, res) => {
    const ids = String(req.query.sections || '').split(',').map((s) => s.trim()).filter(Boolean);
    res.json({ success: true, data: await board.subjectsFor(req.schoolId, ids) });
});

/**
 * One section's subject teachers — what the older create form reads.
 * It answered for any section id from any school; it now answers only for the
 * caller's own.
 */
exports.getSectionSubjects = handle(async (req, res) => {
    const section = await ClassSection.findOne({ _id: req.params.sectionId, school: req.schoolId }).select('_id').lean();
    if (!section) return res.status(404).json({ success: false, message: 'Section not found' });
    const teachers = await SectionSubjectTeacher.find({ section: section._id })
        .populate('subject', 'subjectName subjectCode')
        .populate('teacher', 'name')
        .lean();
    res.json({ success: true, data: teachers });
});

exports.getAnalytics = handle(async (req, res) => {
    res.json({ success: true, data: await board.analytics(req.schoolId, req.query) });
});

/** The school's Results settings: grading scale, exam types, report cards, reminders. */
exports.getSettings = handle(async (req, res) => {
    res.json({ success: true, data: await resultSettings.get(req.schoolId) });
});
exports.updateSettings = handle(async (req, res) => {
    res.json({ success: true, data: await resultSettings.update(ctxOf(req), req.body || {}) });
});

/** Every section's exam papers, day by day — the office's exam schedule. */
exports.getSchedule = handle(async (req, res) => {
    res.json({ success: true, data: await require('../services/resultSchedule').officeSchedule(req.schoolId) });
});

/** A section's report cards, for printing and for the remarks (`?term=` for a term's). */
exports.getReportCards = handle(async (req, res) => {
    res.json({ success: true, data: await reportCard.sectionCards(req.schoolId, { yearId: req.query.academicYear, sectionId: req.query.sectionId, term: req.query.term }) });
});
/** A section's report cards as one PDF — every student's, or one (`?studentId=`). */
exports.getReportCardsPdf = handle(async (req, res) => {
    const { renderReportCards } = require('../utils/reportCardPdf');
    const out = await reportCard.sectionCards(req.schoolId, { yearId: req.query.academicYear, sectionId: req.query.sectionId, term: req.query.term });
    const cards = req.query.studentId ? out.cards.filter((c) => c.student._id === String(req.query.studentId)) : out.cards;
    if (!out.section || !cards.length) return res.status(404).json({ success: false, message: 'No report cards to print here' });
    const who = cards.length === 1 ? cards[0].student.name : `${out.section.className} ${out.section.sectionName}`;
    renderReportCards(res, {
        frame: out.frame, cards,
        filename: `report-card-${String(who).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${String(out.year?.yearName || '').replace(/[^0-9-]/g, '')}.pdf`,
    });
});
/** Release a section's report cards to its families (or take the release back). */
exports.releaseReportCards = handle(async (req, res) => {
    const b = req.body || {};
    res.json({ success: true, data: await reportCard.release(ctxOf(req), { academicYear: b.academicYear, sectionId: b.sectionId, term: b.term, released: b.released !== false }) });
});
/** Send a section's released report cards to the parents — the PDF by email, and a notice. */
exports.sendReportCards = handle(async (req, res) => {
    const b = req.body || {};
    res.json({ success: true, data: await reportCard.sendCards(ctxOf(req), { academicYear: b.academicYear, sectionId: b.sectionId, term: b.term, studentId: b.studentId }) });
});

/** The office's merit list: a class ranked across all its sections, for one exam or the year. */
exports.getMeritList = handle(async (req, res) => {
    res.json({ success: true, data: await board.meritList(req.schoolId, req.query) });
});

/** Electives: who takes each optional subject in a section. */
exports.getElectives = handle(async (req, res) => {
    res.json({ success: true, data: await require('../services/resultElectives').electivesBoard(req.schoolId, { academicYear: req.query.academicYear, sectionId: req.query.sectionId }) });
});
exports.saveElective = handle(async (req, res) => {
    res.json({ success: true, data: await require('../services/resultElectives').saveElective(ctxOf(req), req.body || {}) });
});

/** Families' requests for a paper to be checked again, and the office's answer. */
exports.getRechecks = handle(async (req, res) => {
    res.json({ success: true, ...(await require('../services/resultRecheck').officeList(req.schoolId, { status: req.query.status })) });
});
exports.resolveRecheck = handle(async (req, res) => {
    res.json({ success: true, data: await require('../services/resultRecheck').resolve(ctxOf(req), req.params.id, req.body || {}) });
});

/** The Results trail: what has no exam left to carry it (a draft deleted, electives set…). */
exports.getActivity = handle(async (req, res) => {
    const ResultAuditLog = require('../models/ResultAuditLog');
    const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 100));
    // Older pages: everything before the last row the screen has.
    const where = { school: req.schoolId };
    const before = req.query.before ? new Date(req.query.before) : null;
    if (before && !Number.isNaN(before.getTime())) where.createdAt = { $lt: before };
    const rows = await ResultAuditLog.find(where).sort({ createdAt: -1 }).limit(limit + 1).lean();
    const more = rows.length > limit;
    rows.length = Math.min(rows.length, limit);
    const users = await require('../models/User').find({ _id: { $in: [...new Set(rows.map((r) => r.user).filter(Boolean).map(String))] } }).select('name').lean();
    const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
    res.json({
        success: true,
        data: rows.map((r) => ({ _id: r._id, at: r.createdAt, by: nameOf.get(String(r.user)) || '', role: r.role, action: r.actionType, entity: r.entityType, description: r.description })),
        more,
    });
});

/** The head of school's signature, or the school seal, for report cards. */
exports.uploadReportSignature = handle(async (req, res) => {
    const kind = req.body?.kind === 'schoolSeal' ? 'schoolSeal' : 'principalSignature';
    if (!req.file) return res.status(400).json({ success: false, message: 'Choose a PNG or JPG image' });
    const ResultSettings = require('../models/ResultSettings');
    const { patch } = require('../db/patch');
    const row = await ResultSettings.findOne({ school: req.schoolId }).select('_id').lean()
        || (await resultSettings.get(req.schoolId), await ResultSettings.findOne({ school: req.schoolId }).select('_id').lean());
    await patch(ResultSettings, row._id, { [kind]: `/uploads/images/${req.file.filename}`, updatedBy: req.userId });
    res.json({ success: true, data: await resultSettings.get(req.schoolId) });
});

/** The office writes any student's remarks and co-scholastic grades. */
exports.saveReportCardNotes = handle(async (req, res) => {
    res.json({ success: true, data: await reportCard.saveNotes({ ...ctxOf(req), userRole: 'office' }, req.body || {}) });
});

/** The year's overall result — the exams marked "Include in overall result". */
exports.getOverall = handle(async (req, res) => {
    res.json({ success: true, data: await board.overall(req.schoolId, req.query) });
});

/* ── Creating and editing ─────────────────────────────────────────────────── */

exports.createExam = handle(async (req, res) => {
    const made = await exams.createExams(ctxOf(req), req.body || {});
    // `data` is one exam, as it always was; `exams` is all of them when the
    // form named several sections.
    res.status(201).json({ success: true, data: made[0], exams: made, created: made.length });
});

exports.updateExam = handle(async (req, res) => {
    res.json({ success: true, data: await exams.updateExam(ctxOf(req), req.params.id, req.body || {}) });
});

/**
 * The result date of an exam that is already published — while its results
 * have not yet reached families. `date` empty releases them now.
 */
exports.setResultDate = handle(async (req, res) => {
    const out = await exams.setResultDate(ctxOf(req), req.params.id, req.body?.date ?? req.body?.publishDate ?? null);
    res.json({ success: true, data: { _id: out.exam._id, publishDate: out.exam.publishDate || null, released: out.released }, promotion: out.promotion });
});

/** Re-exams on published results: who may sit them, and their marks. */
exports.getReExam = handle(async (req, res) => {
    res.json({ success: true, data: await exams.reExamBoard(ctxOf(req), req.params.id) });
});
exports.saveReExam = handle(async (req, res) => {
    res.json({ success: true, data: await exams.saveReExam(ctxOf(req), req.params.id, req.body || {}) });
});

/** Portal visibility, the overall result and the rank — changeable at any step. */
exports.setOptions = handle(async (req, res) => {
    const exam = await exams.setOptions(ctxOf(req), req.params.id, req.body || {});
    res.json({ success: true, data: { _id: exam._id, options: exams.optionsOf(exam), promotion: exam.promotionResult || null } });
});

exports.deleteExam = handle(async (req, res) => {
    await exams.deleteExam(ctxOf(req), req.params.id);
    res.json({ success: true });
});

/* ── Steps ────────────────────────────────────────────────────────────────── */

exports.openMarksEntry = handle(async (req, res) => {
    res.json({ success: true, data: await exams.openMarksEntry(ctxOf(req), req.params.id) });
});

exports.backToDraft = handle(async (req, res) => {
    res.json({ success: true, data: await exams.backToDraft(ctxOf(req), req.params.id) });
});

exports.saveMarks = handle(async (req, res) => {
    const ctx = ctxOf(req);
    const exam = await exams.load(ctx, req.params.id);
    const { sheet } = await exams.saveMarks(ctx, exam, req.params.subjectId, req.body?.entries, {
        submit: req.body?.submit === true, admin: true, version: req.body?.version,
    });
    res.json({ success: true, data: sheet, examStatus: exam.status });
});

/** One sheet's history: every save, and every mark changed — who, when, from what to what. */
exports.getSheetHistory = handle(async (req, res) => {
    res.json({ success: true, data: await exams.sheetHistory(ctxOf(req), req.params.id, req.params.subjectId) });
});

/** Send one subject's marks back to its teacher, the rest staying as they are. */
exports.returnSubject = handle(async (req, res) => {
    res.json({ success: true, data: await exams.returnSubject(ctxOf(req), req.params.id, req.body?.subjectId, req.body?.reason) });
});

/** Correct one paper of a published result in place. */
exports.correctMark = handle(async (req, res) => {
    res.json({ success: true, data: await exams.correctPublishedMark(ctxOf(req), req.params.id, req.body || {}) });
});

/** Hold results back from families, or release them. */
exports.setWithheld = handle(async (req, res) => {
    const b = req.body || {};
    const out = await exams.setWithheld(ctxOf(req), req.params.id, { students: b.students, withhold: b.withhold !== false, reason: b.reason });
    res.json({ success: true, data: { changed: out.changed } });
});
/** Who in the exam has an unpaid fee balance — to withhold their results, if the school does. */
exports.getFeeDues = handle(async (req, res) => {
    const exam = await exams.load(ctxOf(req), req.params.id);
    const FormalResult = require('../models/FormalResult');
    const students = (await FormalResult.find({ exam: exam._id }).distinct('student')).map(String);
    const dues = await exams.feeDuesOf(req.schoolId, exam.academicYear, students);
    res.json({ success: true, data: [...dues.entries()].map(([student, due]) => ({ student, due })) });
});

/** The exam's marks register, as an Excel workbook. */
exports.getMarksRegister = handle(async (req, res) => {
    await exams.load(ctxOf(req), req.params.id);
    const { filename, buffer } = await require('../services/resultExports').marksRegister(req.schoolId, req.params.id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
});
/** Admit cards for the exam's students (or one: `?studentId=`), as a PDF. */
exports.getAdmitCards = handle(async (req, res) => {
    const exam = await exams.load(ctxOf(req), req.params.id);
    const X = require('../services/resultExports');
    const data = await X.admitCardData(req.schoolId, exam._id, { studentIds: req.query.studentId ? [String(req.query.studentId)] : null });
    await X.renderAdmitCards(data, res, `admit-cards ${exam.title}.pdf`);
});

/* The exam day's plan: seats and invigilators (services/resultSeating). */
exports.getExamDay = handle(async (req, res) => {
    res.json({ success: true, data: await require('../services/resultSeating').dayBoard(req.schoolId, req.query.date) });
});
exports.planExamDay = handle(async (req, res) => {
    res.json({ success: true, data: await require('../services/resultSeating').generate(ctxOf(req), req.body || {}) });
});
exports.publishExamDay = handle(async (req, res) => {
    res.json({ success: true, data: await require('../services/resultSeating').publish(ctxOf(req), req.body || {}) });
});
exports.removeExamDay = handle(async (req, res) => {
    res.json({ success: true, data: await require('../services/resultSeating').remove(ctxOf(req), { date: req.query.date }) });
});

/** A final exam's promotion decided by hand for one student. */
exports.setPromotionDecision = handle(async (req, res) => {
    const b = req.body || {};
    const out = await exams.setPromotionOverride(ctxOf(req), req.params.id, { student: b.student, decision: b.decision, reason: b.reason });
    res.json({ success: true, data: { moved: out.moved } });
});

exports.validateExam = handle(async (req, res) => {
    res.json({ success: true, data: await exams.validateExam(ctxOf(req), req.params.id, { notes: req.body?.notes, admin: true }) });
});

exports.approveExam = handle(async (req, res) => {
    const { exam, results, promotion } = await exams.publishExam(ctxOf(req), req.params.id, req.body?.notes);
    res.json({ success: true, data: exam, results, promotion });
});

exports.rejectExam = handle(async (req, res) => {
    res.json({ success: true, data: await exams.rejectExam(ctxOf(req), req.params.id, req.body?.reason, { admin: true }) });
});

exports.reopenExam = handle(async (req, res) => {
    res.json({ success: true, data: await exams.reopenExam(ctxOf(req), req.params.id, { reason: req.body?.reason, notes: req.body?.notes, subjects: req.body?.subjects }) });
});

exports.archiveExam = handle(async (req, res) => {
    res.json({ success: true, data: await exams.archiveExam(ctxOf(req), req.params.id) });
});

exports.restoreExam = handle(async (req, res) => {
    res.json({ success: true, data: await exams.restoreExam(ctxOf(req), req.params.id) });
});

/** One action over the ticked rows; what was refused comes back named. */
exports.bulk = handle(async (req, res) => {
    const out = await exams.bulk(ctxOf(req), req.body?.action, req.body?.ids);
    res.json({ success: true, data: out });
});
