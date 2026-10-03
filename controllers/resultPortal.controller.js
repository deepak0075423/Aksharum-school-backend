'use strict';
/**
 * Results for teachers, students and parents — the redesigned screens' reads
 * (Oct 2026). The writes they make are the existing endpoints: a teacher saves
 * marks and validates through controllers/formalExam and classTest, which go
 * through services/resultExams' rules.
 *
 *   teacher   GET /teacher/results/board          everything the page lists
 *             GET /teacher/results/sheets/:e/:s   one subject's marks grid
 *             GET /teacher/results/review/:e      the class teacher's marks matrix
 *             GET /teacher/results/exams/:e/result published results of their section
 *             GET /teacher/results/class-tests/:id/sheet   a class test as a grid
 *             GET /teacher/results/test-options   what a class test may be set in
 *             GET /teacher/results/schedule        exams of the sections they teach or look after
 *             GET /teacher/results/report-cards     report cards of the sections they are class teacher of
 *             GET|PUT /teacher/results/exams/:id/re-exam  re-exam marks for the papers of their subjects
 *             PUT /teacher/results/report-cards/notes  remarks and co-scholastic grades
 *   student   GET /student/results/overview
 *             GET /student/results/schedule
 *             GET /student/results/report-card
 *   parent    GET /parent/results/overview?childId=   one of their own children,
 *             GET /parent/results/schedule?childId=   at any school they are a parent at
 *             GET /parent/results/report-card?childId=
 */
const teacher = require('../services/resultTeacher');
const family = require('../services/resultFamily');
const schedule = require('../services/resultSchedule');
const reportCard = require('../services/reportCard');
const marksImport = require('../services/marksImport');
const { renderReportCards } = require('../utils/reportCardPdf');
/** "report-card-kabir-sethi-2026-27.pdf" */
const pdfName = (who, year) => `report-card-${String(who || 'section').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${String(year || '').replace(/[^0-9-]/g, '')}.pdf`;
const { childrenAcrossSchools } = require('../services/parentChildren');
const exams = require('../services/resultExams');
const { RuleError } = exams;
const teacherCtx = (req) => ({ schoolId: req.schoolId, userId: req.userId, userRole: 'teacher' });

const handle = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (e) {
        if (e instanceof RuleError) return res.status(e.status).json({ success: false, message: e.message, ...(e.extra || {}) });
        console.error('[results]', e);
        res.status(500).json({ success: false, message: e.message });
    }
};
const found = (res, data, what = 'Not found') => (data
    ? res.json({ success: true, data })
    : res.status(404).json({ success: false, message: what }));

exports.teacherBoard = handle(async (req, res) => {
    res.json({ success: true, data: await teacher.teacherBoard(req.schoolId, req.userId) });
});
exports.teacherSheet = handle(async (req, res) => {
    found(res, await teacher.sheetFor(req.schoolId, req.userId, req.params.examId, req.params.subjectId), 'That subject is not part of this exam');
});
exports.teacherReview = handle(async (req, res) => {
    found(res, await teacher.reviewFor(req.schoolId, req.userId, req.params.examId), 'Exam not found');
});
exports.teacherResults = handle(async (req, res) => {
    const out = await teacher.resultsFor(req.schoolId, req.userId, req.params.examId);
    if (!out) return res.status(404).json({ success: false, message: 'Exam not found' });
    res.json({ success: true, ...out });
});
exports.teacherTestSheet = handle(async (req, res) => {
    found(res, await teacher.testSheet(req.schoolId, req.userId, req.params.id), 'Test not found');
});
exports.teacherTestOptions = handle(async (req, res) => {
    res.json({ success: true, data: await teacher.testOptions(req.schoolId, req.userId) });
});

exports.teacherSchedule = handle(async (req, res) => {
    // With the teacher's invigilation duties from published exam-day plans.
    const [data, duties] = await Promise.all([
        schedule.teacherSchedule(req.schoolId, req.userId),
        require('../services/resultSeating').teacherDuties(req.schoolId, req.userId).catch(() => []),
    ]);
    res.json({ success: true, data: { ...data, duties } });
});

/**
 * POST …/results/marks-import — a filled-in marks file, read into rows for the
 * marks grid to match and fill (services/marksImport). Office and teachers
 * alike; nothing is saved here.
 */
exports.readMarksFile = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Choose an Excel or CSV file' });
        const { rows, headers } = marksImport.readSheet(req.file.buffer);
        res.json({ success: true, data: { file: req.file.originalname, rows, headers } });
    } catch (e) {
        if (e instanceof marksImport.ImportError) return res.status(400).json({ success: false, message: e.message });
        console.error('[results] marks import:', e);
        res.status(500).json({ success: false, message: 'The file could not be read' });
    }
};

/** Re-exam marks for the papers of the subjects this teacher teaches in the exam's section. */
exports.teacherReExam = handle(async (req, res) => {
    res.json({ success: true, data: await exams.reExamBoard(teacherCtx(req), req.params.id, { teacherId: req.userId }) });
});
exports.teacherSaveReExam = handle(async (req, res) => {
    res.json({ success: true, data: await exams.saveReExam(teacherCtx(req), req.params.id, req.body || {}, { teacherId: req.userId }) });
});

/** The report cards of a section the teacher is class or vice class teacher of (`?term=` for a term's). */
exports.teacherReportCards = handle(async (req, res) => {
    res.json({ success: true, data: await reportCard.sectionCards(req.schoolId, { yearId: req.query.academicYear, sectionId: req.query.sectionId, teacherId: req.userId, term: req.query.term }) });
});
/** Release their section's report cards to its families, or send them to the parents. */
exports.teacherReleaseReportCards = handle(async (req, res) => {
    const b = req.body || {};
    res.json({ success: true, data: await reportCard.release(teacherCtx(req), { academicYear: b.academicYear, sectionId: b.sectionId, term: b.term, released: b.released !== false }) });
});
exports.teacherSendReportCards = handle(async (req, res) => {
    const b = req.body || {};
    res.json({ success: true, data: await reportCard.sendCards(teacherCtx(req), { academicYear: b.academicYear, sectionId: b.sectionId, term: b.term, studentId: b.studentId }) });
});

/** A sheet's history, for the subject's own teacher. */
exports.teacherSheetHistory = handle(async (req, res) => {
    const exam = await exams.load(teacherCtx(req), req.params.examId);
    if (!(await teacher.teaches(req.userId, exam.section, req.params.subjectId))) {
        return res.status(403).json({ success: false, message: 'You do not teach this subject in this section' });
    }
    res.json({ success: true, data: await exams.sheetHistory(teacherCtx(req), req.params.examId, req.params.subjectId) });
});

/** Electives of the sections a teacher is class teacher of. */
exports.teacherElectives = handle(async (req, res) => {
    res.json({ success: true, data: await require('../services/resultElectives').electivesBoard(req.schoolId, { academicYear: req.query.academicYear, sectionId: req.query.sectionId, teacherId: req.userId }) });
});
exports.teacherSaveElective = handle(async (req, res) => {
    res.json({ success: true, data: await require('../services/resultElectives').saveElective(teacherCtx(req), req.body || {}) });
});
exports.teacherReportCardNotes = handle(async (req, res) => {
    res.json({ success: true, data: await reportCard.saveNotes({ schoolId: req.schoolId, userId: req.userId, userRole: 'teacher' }, req.body || {}) });
});

exports.studentReportCard = handle(async (req, res) => {
    res.json({ success: true, data: await reportCard.familyCard(req.schoolId, req.userId, req.query.academicYear, req.query.term) });
});
/** The same card as a PDF, for the phone to share — the school's document, not one the phone draws. */
exports.studentReportCardPdf = handle(async (req, res) => {
    const out = await reportCard.familyCard(req.schoolId, req.userId, req.query.academicYear, req.query.term);
    if (!out.card) return res.status(404).json({ success: false, message: out.withheld ? 'This report card is withheld — please contact the school office' : 'There is no report card for this year yet' });
    renderReportCards(res, { frame: out.frame, cards: [out.card], family: true, filename: pdfName(out.card.student.name, out.year?.yearName) });
});

/* ── The register and admit cards (Oct 2026) ──────────────────────────────── */

const FormalExamModel = require('../models/FormalExam');
const X = () => require('../services/resultExports');
/** A class (or vice class) teacher's own section's exam — else refused. */
async function classTeachersExam(req) {
    const exam = await FormalExamModel.findOne({ _id: req.params.examId, school: req.schoolId }).select('section title').lean();
    if (!exam) throw new RuleError(404, 'Exam not found');
    if (!(await teacher.looksAfter(req.schoolId, req.userId, exam.section))) throw new RuleError(403, 'Only the section\'s class teacher can print this');
    return exam;
}
exports.teacherMarksRegister = handle(async (req, res) => {
    await classTeachersExam(req);
    const { filename, buffer } = await X().marksRegister(req.schoolId, req.params.examId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
});
exports.teacherAdmitCards = handle(async (req, res) => {
    const exam = await classTeachersExam(req);
    const data = await X().admitCardData(req.schoolId, exam._id, { studentIds: req.query.studentId ? [String(req.query.studentId)] : null });
    await X().renderAdmitCards(data, res, `admit-cards ${exam.title}.pdf`);
});
/**
 * A student's own admit card — once the school has shared the exam's
 * timetable with families (and kept it on the portal); never for an exam put
 * away, or one the student is not on the roll of.
 */
async function familyAdmitCard(res, schoolId, studentId, examId) {
    const exam = await FormalExamModel.findOne({ _id: examId, school: schoolId }).select('title showInPortal timetableShared archivedAt').lean();
    if (!exam || exam.archivedAt || exam.showInPortal === false || exam.timetableShared === false) {
        throw new RuleError(404, 'There is no admit card for this exam yet');
    }
    const data = await X().admitCardData(schoolId, exam._id, { studentIds: [String(studentId)] });
    await X().renderAdmitCards(data, res, `admit-card ${data.students[0]?.name || ''} ${exam.title}.pdf`);
}
exports.studentAdmitCard = handle(async (req, res) => {
    await familyAdmitCard(res, req.schoolId, req.userId, req.query.examId);
});
exports.parentAdmitCard = handle(async (req, res) => {
    const picked = await pickChild(req);
    if (!picked.child) return res.status(404).json({ success: false, message: 'Choose your child' });
    await familyAdmitCard(res, picked.child.schoolId, picked.child._id, req.query.examId);
});

/** A family asks for a paper of a published result to be checked again. */
exports.studentRecheck = handle(async (req, res) => {
    const b = req.body || {};
    res.status(201).json({ success: true, data: await require('../services/resultRecheck').request(
        { schoolId: req.schoolId, userId: req.userId, userRole: 'student' }, { studentId: req.userId, examId: b.examId, subjectId: b.subjectId, reason: b.reason }) });
});
exports.parentRecheck = handle(async (req, res) => {
    const picked = await pickChild({ ...req, query: { ...req.query, childId: req.body?.childId || req.query.childId } });
    if (!picked.child) return res.status(404).json({ success: false, message: 'Choose your child' });
    const b = req.body || {};
    res.status(201).json({ success: true, data: await require('../services/resultRecheck').request(
        { schoolId: picked.child.schoolId, userId: req.userId, userRole: 'parent' }, { studentId: picked.child._id, examId: b.examId, subjectId: b.subjectId, reason: b.reason }) });
});

/** A section's report cards as a PDF — every student's, or one (`?studentId=`). */
exports.teacherReportCardsPdf = handle(async (req, res) => {
    const out = await reportCard.sectionCards(req.schoolId, { yearId: req.query.academicYear, sectionId: req.query.sectionId, teacherId: req.userId, term: req.query.term });
    const cards = req.query.studentId ? out.cards.filter((c) => c.student._id === String(req.query.studentId)) : out.cards;
    if (!out.section || !cards.length) return res.status(404).json({ success: false, message: 'No report cards to print here' });
    renderReportCards(res, {
        frame: out.frame, cards,
        filename: pdfName(cards.length === 1 ? cards[0].student.name : `${out.section.className} ${out.section.sectionName}`, out.year?.yearName),
    });
});

exports.studentOverview = handle(async (req, res) => {
    res.json({ success: true, data: await family.overview(req.schoolId, req.userId) });
});

exports.studentSchedule = handle(async (req, res) => {
    // With the student's seats from published exam-day plans.
    const [data, seats] = await Promise.all([
        schedule.studentSchedule(req.schoolId, req.userId),
        require('../services/resultSeating').studentSeats(req.schoolId, req.userId).catch(() => []),
    ]);
    res.json({ success: true, data: { ...data, seats } });
});

/**
 * Which of a parent's children a page is about: `?childId=` when it is one of
 * their own — at this school or any other they are a parent at. Without one,
 * `?focus=` (the exam or class test a notification was about) names the child
 * it concerns; failing that, the first. The child carries its school:
 * everything about them is read there. `children` is every child, for the switch.
 */
async function pickChild(req) {
    const all = await childrenAcrossSchools(req.userId, req.schoolId);
    const wanted = String(req.query.childId || '');
    let child = all.find((c) => c._id === wanted) || null;
    if (!child && all.length > 1 && req.query.focus) {
        const about = await family.studentAbout(String(req.query.focus), all.map((c) => c._id)).catch(() => null);
        child = all.find((c) => c._id === about) || null;
    }
    child = child || all[0] || null;
    // The school is named beside a child whenever it is not simply "this one":
    // children at more than one school, or all of them at another.
    const schools = new Set(all.map((c) => String(c.schoolId)));
    const children = all.map(({ modules, ...c }) => ({ ...c, resultsOn: modules?.result === true }));
    return { child, children, multiSchool: schools.size > 1 || (schools.size === 1 && !schools.has(String(req.schoolId))) };
}
const childHead = ({ child, children, multiSchool }) => ({
    children, multiSchool, child: child?._id || null,
    school: child ? { _id: child.schoolId, name: child.schoolName } : null,
    // A school that does not use Results has no exams or results to show.
    resultsOn: child ? child.modules?.result === true : false,
});

/** One child's results page. */
exports.parentOverview = handle(async (req, res) => {
    const picked = await pickChild(req);
    const head = childHead(picked);
    res.json({ success: true, data: { ...head, ...(picked.child && head.resultsOn ? await family.overview(picked.child.schoolId, picked.child._id) : {}) } });
});

/** One child's report card. */
exports.parentReportCard = handle(async (req, res) => {
    const picked = await pickChild(req);
    const head = childHead(picked);
    res.json({ success: true, data: { ...head, ...(picked.child && head.resultsOn ? await reportCard.familyCard(picked.child.schoolId, picked.child._id, req.query.academicYear, req.query.term) : {}) } });
});

/** One child's report card as a PDF. */
exports.parentReportCardPdf = handle(async (req, res) => {
    const picked = await pickChild(req);
    const head = childHead(picked);
    if (!picked.child || !head.resultsOn) return res.status(404).json({ success: false, message: 'There is no report card for this child' });
    const out = await reportCard.familyCard(picked.child.schoolId, picked.child._id, req.query.academicYear, req.query.term);
    if (!out.card) return res.status(404).json({ success: false, message: out.withheld ? 'This report card is withheld — please contact the school office' : 'There is no report card for this year yet' });
    renderReportCards(res, { frame: out.frame, cards: [out.card], family: true, filename: pdfName(out.card.student.name, out.year?.yearName) });
});

/** GET /api/public/report-card/:code — what a printed card's QR proves. No sign-in. */
exports.verifyReportCard = handle(async (req, res) => {
    res.json({ success: true, data: await reportCard.verify(req.params.code) });
});

/**
 * A report card's QR code as an image, for the card on screen (the PDF draws
 * its own). Only for a code that exists — this is not a QR maker for anyone.
 */
exports.reportCardQr = async (req, res) => {
    try {
        const code = String(req.params.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{6,20}$/.test(code)) return res.status(404).end();
        const ReportCardVerification = require('../models/ReportCardVerification');
        if (!(await ReportCardVerification.findOne({ code }).select('_id').lean())) return res.status(404).end();
        const svg = await require('qrcode').toString(reportCard.verifyUrl(code), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
        res.set('Content-Type', 'image/svg+xml');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(svg);
    } catch (e) {
        console.error('[report card] QR failed:', e.message);
        return res.status(500).end();
    }
};

/** One child's exam schedule. */
exports.parentSchedule = handle(async (req, res) => {
    const picked = await pickChild(req);
    const head = childHead(picked);
    const on = picked.child && head.resultsOn;
    const [data, seats] = on ? await Promise.all([
        schedule.studentSchedule(picked.child.schoolId, picked.child._id),
        require('../services/resultSeating').studentSeats(picked.child.schoolId, picked.child._id).catch(() => []),
    ]) : [{}, []];
    res.json({ success: true, data: { ...head, ...data, ...(on ? { seats } : null) } });
});
