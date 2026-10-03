'use strict';
/**
 * Formal exams — the teacher's, student's and parent's endpoints.
 *
 * The admin screens moved to controllers/resultAdmin.controller.js. What a
 * step is allowed to do lives in services/resultExams.js, which the teacher
 * handlers below share with the office: marks may only be saved while marks
 * entry is open, validating is the class teacher's own section's, and a sheet
 * cannot go forward with a student left blank — rules that used to be
 * enforced by the web form alone, when they were enforced at all.
 */
const FormalExam      = require('../models/FormalExam');
const ExamMarksSheet  = require('../models/ExamMarksSheet');
const FormalResult    = require('../models/FormalResult');
const ClassSection    = require('../models/ClassSection');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const { childrenOf: childrenOfParent } = require('../services/parentChildren');
const User            = require('../models/User');
const Class           = require('../models/Class');
const pool            = require('../db/pool');
const exams           = require('../services/resultExams');
const { typeLabelOf } = require('../services/resultSettings');

const ctxOf = (req) => ({ schoolId: req.schoolId, userId: req.userId, userRole: req.userRole });

/**
 * Give each exam its class's name and its type in words.
 *
 * A teacher's rows carried the section's letter alone, so "Mid Term · A" could
 * be any class's A — and now that the office creates an exam for a whole class
 * at a time, a teacher of 6-A and 7-A sees two rows that read the same.
 */
async function nameClasses(list) {
    const ids = [...new Set(list.map(e => String(e.section?._id || e.section || '')).filter(Boolean))];
    if (!ids.length) return list;
    const { rows } = await pool.query(
        `SELECT s."_id", c."className" FROM "${ClassSection.tableName}" s
           LEFT JOIN "${Class.tableName}" c ON c."_id" = s."class" WHERE s."_id" = ANY($1::uuid[])`, [ids]);
    const classOf = new Map(rows.map(r => [String(r._id), r.className || '']));
    return list.map(e => ({
        ...e,
        className: classOf.get(String(e.section?._id || e.section)) || '',
        examTypeLabel: typeLabelOf(e),
    }));
}

/** Answer a broken rule with its own status; anything else is a 500. */
function refuse(res, e) {
    if (e instanceof exams.RuleError) {
        return res.status(e.status).json({ success: false, message: e.message, ...(e.extra || {}) });
    }
    return res.status(500).json({ success: false, message: e.message });
}

// ── Teacher: Marks Entry ──────────────────────────────────────────────────────

exports.teacherGetMarksEntry = async (req, res) => {
    try {
        const assignments = await SectionSubjectTeacher.find({ teacher: req.userId })
            .populate('section', 'sectionName')
            .populate('subject', 'subjectName name')
            .lean();

        // A row whose section or subject has since been deleted populates to
        // null; it has nothing to enter marks for.
        const live = assignments.filter(a => a.section?._id && a.subject?._id);
        const sectionIds = [...new Set(live.map(a => a.section._id.toString()))];
        const list = await FormalExam.find({
            section: { $in: sectionIds },
            school:  req.schoolId,
            archivedAt: null,
            status:  { $in: ['MARKS_PENDING', 'SUBMITTED', 'CLASS_APPROVED', 'REOPENED'] },
        })
            .populate('section', 'sectionName')
            .lean();

        const data = (await nameClasses(list)).map(e => {
            const onExam = new Set(exams.subjectIdsOf(e));
            // Only the subjects this exam actually covers: a teacher's other
            // subjects in the section have no sheet here to fill in.
            const mySubjects = live
                .filter(a => a.section._id.toString() === e.section?._id?.toString() && onExam.has(a.subject._id.toString()))
                .map(a => a.subject);
            return { ...e, mySubjects };
        }).filter(e => e.mySubjects.length);
        res.json({ success: true, data });
    } catch (e) { refuse(res, e); }
};

exports.teacherGetMarksForm = async (req, res) => {
    try {
        const { examId, subjectId } = req.params;
        const exam = await FormalExam.findOne({ _id: examId, school: req.schoolId }).lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        // Verify teacher is assigned to this subject in this section
        const assignment = await SectionSubjectTeacher.findOne({ section: exam.section, subject: subjectId, teacher: req.userId });
        if (!assignment) return res.status(403).json({ success: false, message: 'Not assigned to this subject' });

        // The subject's own roll (an elective's roster), with roll numbers from
        // the student profile — the account row has none.
        const [all, takers] = await Promise.all([exams.rosterOf(exam.section), exams.takersOf(exam.section, [subjectId])]);
        const roster   = exams.rollFor(all, takers, subjectId);
        const [users, profiles] = await Promise.all([
            User.find({ _id: { $in: roster } }).select('name email').lean(),
            require('../models/StudentProfile').find({ user: { $in: roster } }).select('user rollNumber admissionNumber').lean(),
        ]);
        const profileOf = new Map(profiles.map((p) => [String(p.user), p]));
        const students = users.map((u) => ({ ...u, rollNumber: profileOf.get(String(u._id))?.rollNumber || '', admissionNumber: profileOf.get(String(u._id))?.admissionNumber || '' }));

        const sheet = await ExamMarksSheet.findOne({ exam: examId, subject: subjectId }).lean();
        const subjectConfig = exam.subjects.find(s => s.subject.toString() === subjectId);

        // `editable` says whether a save would be accepted, so a screen need
        // not guess it from the sheet's status — after a reopen the sheet is a
        // draft again, and after validation a draft is still not editable.
        const editable = !exam.archivedAt && exams.MARKS_OPEN.includes(exam.status);
        res.json({ success: true, data: { students, sheet, subjectConfig, examStatus: exam.status, editable } });
    } catch (e) { refuse(res, e); }
};

exports.teacherSaveMarks = async (req, res) => {
    try {
        const { examId, subjectId } = req.params;
        const { entries, submit }   = req.body;

        const ctx  = ctxOf(req);
        const exam = await exams.load(ctx, examId);

        const assignment = await SectionSubjectTeacher.findOne({ section: exam.section, subject: subjectId, teacher: req.userId });
        if (!assignment) return res.status(403).json({ success: false, message: 'Not assigned to this subject' });

        const { sheet } = await exams.saveMarks(ctx, exam, subjectId, entries, { submit: !!submit, version: req.body?.version });
        res.json({ success: true, data: sheet, examStatus: exam.status });
    } catch (e) { refuse(res, e); }
};

// ── Teacher: Class Teacher Validation ────────────────────────────────────────

exports.teacherGetValidation = async (req, res) => {
    try {
        const mySections = await ClassSection.find({
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
            school: req.schoolId,
        }).lean();
        if (!mySections.length) return res.json({ success: true, data: [] });

        // SUBMITTED only. A reopened exam used to sit in this queue too, where
        // it could be validated while its marks were still being corrected.
        const sectionIds = mySections.map(s => s._id);
        const list = await FormalExam.find({
            section: { $in: sectionIds },
            school:  req.schoolId,
            archivedAt: null,
            status:  'SUBMITTED',
        })
            .populate('section', 'sectionName')
            .lean();
        res.json({ success: true, data: await nameClasses(list) });
    } catch (e) { refuse(res, e); }
};

exports.teacherGetValidationDetail = async (req, res) => {
    try {
        const exam = await FormalExam.findOne({ _id: req.params.examId, school: req.schoolId })
            .populate('subjects.subject', 'subjectName name')
            .populate('section', 'sectionName')
            .lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        // Every student's marks in the section are on these sheets: they are
        // the class teacher's to read, not any teacher's with the exam's id.
        const mine = await ClassSection.findOne({
            _id: exam.section?._id || exam.section,
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
        }).select('_id').lean();
        if (!mine) return res.status(403).json({ success: false, message: 'Only the class teacher can review these marks' });

        const sheets = await ExamMarksSheet.find({ exam: exam._id })
            .populate('subject',     'subjectName name')
            .populate('submittedBy', 'name')
            .lean();
        res.json({ success: true, data: { ...exam, sheets } });
    } catch (e) { refuse(res, e); }
};

// The teacher's screen posts its text as `remarks`; these read `notes` /
// `reason`, so a class teacher's reason for rejecting was always stored empty.
// Both names are taken now.
exports.teacherApproveExam = async (req, res) => {
    try {
        const notes = req.body?.notes || req.body?.remarks || '';
        const exam  = await exams.validateExam(ctxOf(req), req.params.examId, { notes });
        res.json({ success: true, data: exam });
    } catch (e) { refuse(res, e); }
};

exports.teacherRejectExam = async (req, res) => {
    try {
        const reason = req.body?.reason || req.body?.remarks || '';
        const exam   = await exams.rejectExam(ctxOf(req), req.params.examId, reason, { admin: false });
        res.json({ success: true, data: exam });
    } catch (e) { refuse(res, e); }
};

// ── Student and parent: Results ───────────────────────────────────────────────
//
// What a family may see is decided once, in services/resultExams
// (FAMILY_FILTER / visibleToFamilies / forFamily): published, not kept off the
// portal, past its result date — and without the rank when the exam hides it.
// The dashboard's performance card applies the same rule.

/**
 * A student's readable results — every exam they have a result in, not only
 * their current section's. Promotion (services/resultPromotion) moves a
 * student into next year's section on the day a final's results come out;
 * reading by section hid that very result from them the same day.
 */
const heldFrom = (exam, studentId) => (Array.isArray(exam?.withheld) ? exam.withheld : []).find((w) => String(w.student) === String(studentId)) || null;

async function familyResults(schoolId, studentId) {
    const now     = new Date();
    const results = await FormalResult.find({ student: studentId, school: schoolId })
        .populate('exam',             'title examType publishDate status showInPortal showRank school withheld')
        .populate('subjects.subject', 'subjectName name')
        .sort({ generatedAt: -1 })
        .lean();
    return results
        .filter(r => exams.visibleToFamilies(r.exam, now))
        .map(r => {
            const { status, showInPortal, showRank, withheld, ...exam } = r.exam;
            // Held back by the school: the family sees that it is, and nothing of it.
            const held = heldFrom(r.exam, studentId);
            if (held) return { _id: r._id, exam, withheld: { reason: held.reason || '' }, subjects: [] };
            return exams.forFamily({ ...r, exam }, r.exam);
        });
}

/** One result, if it belongs to one of `studentIds` and its exam is readable. */
async function familyResult(resultId, studentIds) {
    const result = await FormalResult.findOne({ _id: resultId, student: { $in: studentIds } })
        .populate('exam',             'title examType publishDate status showInPortal showRank school withheld')
        .populate('subjects.subject', 'subjectName name')
        .lean();
    if (!result) return { status: 404, message: 'Result not found' };
    if (!exams.visibleToFamilies(result.exam)) return { status: 403, message: 'Result not yet published' };
    if (heldFrom(result.exam, result.student)) return { status: 403, message: 'This result is withheld — please contact the school office' };
    const { status, showInPortal, showRank, withheld, ...exam } = result.exam;
    return { data: exams.forFamily({ ...result, exam }, result.exam) };
}

/**
 * A parent's children (services/parentChildren — both links, this school's
 * students only, in name order as every child switch shows them) and the one
 * being asked about: `?childId=` when it is one of their own, otherwise the
 * first — the only child this used to read.
 */
async function childrenOf(req) {
    const kids   = (await childrenOfParent(req.userId, req.schoolId)).map(k => String(k._id));
    const wanted = String(req.query?.childId || '');
    return { kids, child: kids.includes(wanted) ? wanted : (kids[0] || null) };
}

exports.studentGetResults = async (req, res) => {
    try {
        res.json({ success: true, data: await familyResults(req.schoolId, req.userId) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.studentGetResultDetail = async (req, res) => {
    try {
        const out = await familyResult(req.params.resultId, [req.userId]);
        if (!out.data) return res.status(out.status).json({ success: false, message: out.message });
        res.json({ success: true, data: out.data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.parentGetResults = async (req, res) => {
    try {
        const { child } = await childrenOf(req);
        if (!child) return res.json({ success: true, data: [] });
        res.json({ success: true, data: await familyResults(req.schoolId, child) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.parentGetResultDetail = async (req, res) => {
    try {
        const { kids } = await childrenOf(req);
        if (!kids.length) return res.status(404).json({ success: false, message: 'No child found' });
        const out = await familyResult(req.params.resultId, kids);
        if (!out.data) return res.status(out.status).json({ success: false, message: out.message });
        res.json({ success: true, data: out.data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
