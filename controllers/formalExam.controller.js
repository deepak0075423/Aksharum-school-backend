'use strict';
const FormalExam      = require('../models/FormalExam');
const ExamMarksSheet  = require('../models/ExamMarksSheet');
const FormalResult    = require('../models/FormalResult');
const ClassSection    = require('../models/ClassSection');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const AcademicYear    = require('../models/AcademicYear');
const StudentProfile  = require('../models/StudentProfile');
const ParentProfile   = require('../models/ParentProfile');
const User            = require('../models/User');
const { notify, withParents } = require('../services/notifyService');

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcGrade(pct) {
    if (pct >= 90) return 'A+';
    if (pct >= 80) return 'A';
    if (pct >= 70) return 'B+';
    if (pct >= 60) return 'B';
    if (pct >= 50) return 'C';
    if (pct >= 40) return 'D';
    return 'F';
}

async function generateResults(exam) {
    const section  = await ClassSection.findById(exam.section).lean();
    const students = section?.enrolledStudents || [];
    if (!students.length) return;

    const sheets = await ExamMarksSheet.find({ exam: exam._id }).lean();
    const ay     = exam.academicYear;

    const ops = students.map(studentId => {
        const subjectResults = exam.subjects.map(sub => {
            const sheet   = sheets.find(s => s.subject.toString() === sub.subject.toString());
            const entry   = sheet?.entries?.find(e => e.student.toString() === studentId.toString());
            const marks   = entry?.isAbsent ? 0 : (entry?.marksObtained ?? 0);
            const pct     = sub.maxMarks > 0 ? (marks / sub.maxMarks) * 100 : 0;
            return {
                subject:       sub.subject,
                marksObtained: marks,
                maxMarks:      sub.maxMarks,
                passingMarks:  sub.passingMarks,
                grade:         calcGrade(pct),
                isPassed:      marks >= sub.passingMarks && !entry?.isAbsent,
                isAbsent:      !!entry?.isAbsent,
                remarks:       entry?.remarks || '',
            };
        });
        const totalMarks    = subjectResults.reduce((s, r) => s + r.marksObtained, 0);
        const totalMaxMarks = subjectResults.reduce((s, r) => s + r.maxMarks, 0);
        const percentage    = totalMaxMarks > 0 ? (totalMarks / totalMaxMarks) * 100 : 0;
        const isPassed      = subjectResults.every(r => r.isPassed);

        return {
            updateOne: {
                filter: { exam: exam._id, student: studentId },
                update: {
                    $set: {
                        school: exam.school, section: exam.section, academicYear: ay,
                        subjects: subjectResults, totalMarks, totalMaxMarks,
                        percentage: Math.round(percentage * 100) / 100,
                        grade:  calcGrade(percentage), isPassed, generatedAt: new Date(),
                    },
                },
                upsert: true,
            },
        };
    });

    await FormalResult.bulkWrite(ops);

    // Rank by totalMarks descending
    const results = await FormalResult.find({ exam: exam._id }).sort({ totalMarks: -1 }).lean();
    const rankOps = results.map((r, i) => ({
        updateOne: { filter: { _id: r._id }, update: { $set: { rank: i + 1 } } },
    }));
    if (rankOps.length) await FormalResult.bulkWrite(rankOps);

    await FormalExam.updateOne({ _id: exam._id }, { resultsGenerated: true });
}

// ── Admin: Exams ──────────────────────────────────────────────────────────────

exports.adminGetExams = async (req, res) => {
    try {
        const { status, sectionId, academicYearId, page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        if (status)       filter.status       = status;
        if (sectionId)    filter.section      = sectionId;
        if (academicYearId) filter.academicYear = academicYearId;

        const [exams, total] = await Promise.all([
            FormalExam.find(filter)
                .populate('section',     'sectionName')
                .populate('academicYear','yearName label')
                .populate('createdBy',   'name')
                .sort({ createdAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            FormalExam.countDocuments(filter),
        ]);
        res.json({ success: true, data: exams, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminCreateExam = async (req, res) => {
    try {
        const { sectionId, title, examType, subjects, startDate, endDate, publishDate } = req.body;
        if (!sectionId || !title || !examType || !startDate || !endDate)
            return res.status(400).json({ success: false, message: 'sectionId, title, examType, startDate, endDate are required' });

        const ay = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const exam = await FormalExam.create({
            school: req.schoolId, academicYear: ay._id, section: sectionId,
            title: title.trim(), examType,
            subjects: subjects || [],
            startDate: new Date(startDate), endDate: new Date(endDate),
            publishDate: publishDate ? new Date(publishDate) : null,
            status: 'DRAFT', createdBy: req.userId,
            auditLog: [{ action: 'CREATED', by: req.userId }],
        });
        res.status(201).json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminGetExamDetail = async (req, res) => {
    try {
        const exam = await FormalExam.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('section',      'sectionName')
            .populate('academicYear', 'yearName label')
            .populate('createdBy',    'name')
            .populate('classApprovedBy', 'name')
            .populate('finalApprovedBy', 'name')
            .populate('subjects.subject', 'name code')
            .lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        const sheets = await ExamMarksSheet.find({ exam: exam._id })
            .populate('subject',     'subjectName name')
            .populate('submittedBy', 'name')
            .lean();
        res.json({ success: true, data: { ...exam, sheets } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminUpdateExam = async (req, res) => {
    try {
        const exam = await FormalExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (['FINAL_APPROVED'].includes(exam.status))
            return res.status(400).json({ success: false, message: 'Cannot edit a finally approved exam' });

        const { title, examType, subjects, startDate, endDate, publishDate, status } = req.body;
        if (title)       exam.title     = title.trim();
        if (examType)    exam.examType  = examType;
        if (subjects)    exam.subjects  = subjects;
        if (startDate)   exam.startDate = new Date(startDate);
        if (endDate)     exam.endDate   = new Date(endDate);
        if (publishDate !== undefined) exam.publishDate = publishDate ? new Date(publishDate) : null;
        if (status && ['DRAFT','MARKS_PENDING'].includes(status)) exam.status = status;
        exam.auditLog.push({ action: 'UPDATED', by: req.userId });
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminDeleteExam = async (req, res) => {
    try {
        const exam = await FormalExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (!['DRAFT'].includes(exam.status))
            return res.status(400).json({ success: false, message: 'Only draft exams can be deleted' });

        await Promise.all([
            FormalExam.deleteOne({ _id: exam._id }),
            ExamMarksSheet.deleteMany({ exam: exam._id }),
            FormalResult.deleteMany({ exam: exam._id }),
        ]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminGetMarksReview = async (req, res) => {
    try {
        const exam = await FormalExam.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('subjects.subject', 'subjectName name')
            .lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        const sheets = await ExamMarksSheet.find({ exam: exam._id })
            .populate('subject',     'subjectName name')
            .populate('submittedBy', 'name')
            .lean();

        res.json({ success: true, data: { exam, sheets } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminApproveExam = async (req, res) => {
    try {
        const exam = await FormalExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status !== 'CLASS_APPROVED')
            return res.status(400).json({ success: false, message: 'Exam must be class-approved before final approval' });

        exam.status         = 'FINAL_APPROVED';
        exam.finalApprovedBy = req.userId;
        exam.finalApprovedAt = new Date();
        exam.auditLog.push({ action: 'FINAL_APPROVED', by: req.userId, notes: req.body.notes || '' });
        await exam.save();

        // Generate student results, then tell students + parents they're out
        generateResults(exam)
            .then(async () => {
                const section = await ClassSection.findById(exam.section).select('enrolledStudents').lean();
                const targets = await withParents((section?.enrolledStudents || []).map(String));
                notify({
                    school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                    title: `📊 Results published: ${exam.title}`,
                    body: `Results for "${exam.title}" have been published. Check the Results section for your scorecard.`,
                    recipients: targets,
                });
            })
            .catch(e => console.error('[formalExam] generateResults error:', e.message));

        res.json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminRejectExam = async (req, res) => {
    try {
        const { reason } = req.body;
        const exam = await FormalExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (!['SUBMITTED','CLASS_APPROVED'].includes(exam.status))
            return res.status(400).json({ success: false, message: 'Cannot reject in current status' });

        exam.status          = 'REJECTED';
        exam.rejectionReason = reason || '';
        exam.auditLog.push({ action: 'REJECTED', by: req.userId, notes: reason || '' });
        await exam.save();
        ClassSection.findById(exam.section).select('classTeacher').lean().then(sec => {
            if (!sec?.classTeacher) return;
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: `❌ Exam rejected: ${exam.title}`,
                body: `The marks for "${exam.title}" were rejected by the admin.${reason ? `\nReason: ${reason}` : ''}`,
                recipients: [sec.classTeacher],
            });
        }).catch(() => {});
        res.json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminReopenExam = async (req, res) => {
    try {
        const exam = await FormalExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status !== 'REJECTED') return res.status(400).json({ success: false, message: 'Only rejected exams can be reopened' });

        exam.status = 'REOPENED';
        exam.auditLog.push({ action: 'REOPENED', by: req.userId, notes: req.body.notes || '' });
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminEditMarks = async (req, res) => {
    try {
        const { entries } = req.body; // [{student, marksObtained, isAbsent, remarks}]
        const exam = await FormalExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status === 'FINAL_APPROVED')
            return res.status(400).json({ success: false, message: 'Cannot edit marks of a finally approved exam' });

        const sheet = await ExamMarksSheet.findOneAndUpdate(
            { exam: exam._id, subject: req.params.subjectId },
            {
                $set:  { entries: entries || [], updatedAt: new Date() },
                $push: { auditLog: { action: 'ADMIN_EDIT', by: req.userId, at: new Date() } },
            },
            { upsert: true, new: true }
        ).lean();
        res.json({ success: true, data: sheet });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminGetResult = async (req, res) => {
    try {
        const exam = await FormalExam.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        const results = await FormalResult.find({ exam: exam._id })
            .populate('student', 'name rollNumber email')
            .populate('subjects.subject', 'subjectName name')
            .sort({ rank: 1 })
            .lean();
        res.json({ success: true, data: results, exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminGetSectionSubjects = async (req, res) => {
    try {
        const teachers = await SectionSubjectTeacher.find({ section: req.params.sectionId })
            .populate('subject',  'subjectName subjectCode name code')
            .populate('teacher',  'name')
            .lean();
        res.json({ success: true, data: teachers });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: Marks Entry ──────────────────────────────────────────────────────

exports.teacherGetMarksEntry = async (req, res) => {
    try {
        const assignments = await SectionSubjectTeacher.find({ teacher: req.userId })
            .populate('section', 'sectionName')
            .populate('subject', 'subjectName name')
            .lean();

        const sectionIds = [...new Set(assignments.map(a => a.section._id.toString()))];
        const exams = await FormalExam.find({
            section: { $in: sectionIds },
            school:  req.schoolId,
            status:  { $in: ['MARKS_PENDING', 'SUBMITTED', 'CLASS_APPROVED', 'REOPENED'] },
        })
            .populate('section', 'sectionName')
            .lean();

        const data = exams.map(e => {
            const mySubjects = assignments
                .filter(a => a.section._id.toString() === e.section._id.toString())
                .map(a => a.subject);
            return { ...e, mySubjects };
        });
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherGetMarksForm = async (req, res) => {
    try {
        const { examId, subjectId } = req.params;
        const exam = await FormalExam.findOne({ _id: examId, school: req.schoolId }).lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        // Verify teacher is assigned to this subject in this section
        const assignment = await SectionSubjectTeacher.findOne({ section: exam.section, subject: subjectId, teacher: req.userId });
        if (!assignment) return res.status(403).json({ success: false, message: 'Not assigned to this subject' });

        const section  = await ClassSection.findById(exam.section).lean();
        const students = await User.find({ _id: { $in: section?.enrolledStudents || [] } })
            .select('name rollNumber email').lean();

        const sheet = await ExamMarksSheet.findOne({ exam: examId, subject: subjectId }).lean();
        const subjectConfig = exam.subjects.find(s => s.subject.toString() === subjectId);

        res.json({ success: true, data: { students, sheet, subjectConfig } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherSaveMarks = async (req, res) => {
    try {
        const { examId, subjectId } = req.params;
        const { entries, submit }   = req.body;

        const exam = await FormalExam.findOne({ _id: examId, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status === 'FINAL_APPROVED') return res.status(400).json({ success: false, message: 'Results are final' });

        const assignment = await SectionSubjectTeacher.findOne({ section: exam.section, subject: subjectId, teacher: req.userId });
        if (!assignment) return res.status(403).json({ success: false, message: 'Not assigned to this subject' });

        const newStatus  = submit ? 'SUBMITTED' : 'DRAFT';
        const updateData = {
            $set: { entries: entries || [], status: newStatus, section: exam.section, updatedAt: new Date() },
            $push: { auditLog: { action: submit ? 'SUBMITTED' : 'SAVED', by: req.userId, at: new Date() } },
        };
        if (submit) {
            updateData.$set.submittedBy = req.userId;
            updateData.$set.submittedAt = new Date();
        }

        const sheet = await ExamMarksSheet.findOneAndUpdate(
            { exam: examId, subject: subjectId },
            updateData,
            { upsert: true, new: true }
        ).lean();

        // Update exam status to SUBMITTED if all sheets are submitted
        if (submit) {
            const allSheets = await ExamMarksSheet.find({ exam: examId });
            const submitted = allSheets.filter(s => s.status === 'SUBMITTED').length;
            if (submitted >= exam.subjects.length) {
                exam.status = 'SUBMITTED';
                exam.auditLog.push({ action: 'ALL_MARKS_SUBMITTED', by: req.userId });
                await exam.save();
            }
        }

        res.json({ success: true, data: sheet });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: Class Teacher Validation ────────────────────────────────────────

exports.teacherGetValidation = async (req, res) => {
    try {
        const mySections = await ClassSection.find({
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
            school: req.schoolId,
        }).lean();
        if (!mySections.length) return res.json({ success: true, data: [] });

        const sectionIds = mySections.map(s => s._id);
        const exams = await FormalExam.find({
            section: { $in: sectionIds },
            school:  req.schoolId,
            status:  { $in: ['SUBMITTED', 'REOPENED'] },
        })
            .populate('section', 'sectionName')
            .lean();
        res.json({ success: true, data: exams });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherGetValidationDetail = async (req, res) => {
    try {
        const exam = await FormalExam.findOne({ _id: req.params.examId, school: req.schoolId })
            .populate('subjects.subject', 'subjectName name')
            .populate('section', 'sectionName')
            .lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        const sheets = await ExamMarksSheet.find({ exam: exam._id })
            .populate('subject',     'subjectName name')
            .populate('submittedBy', 'name')
            .lean();
        res.json({ success: true, data: { ...exam, sheets } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherApproveExam = async (req, res) => {
    try {
        const exam = await FormalExam.findOne({ _id: req.params.examId, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (!['SUBMITTED','REOPENED'].includes(exam.status))
            return res.status(400).json({ success: false, message: 'Exam cannot be approved in current status' });

        // Verify class teacher
        const section = await ClassSection.findOne({
            _id: exam.section,
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
        });
        if (!section) return res.status(403).json({ success: false, message: 'Only class teacher can approve' });

        exam.status          = 'CLASS_APPROVED';
        exam.classApprovedBy = req.userId;
        exam.classApprovedAt = new Date();
        exam.auditLog.push({ action: 'CLASS_APPROVED', by: req.userId, notes: req.body.notes || '' });
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherRejectExam = async (req, res) => {
    try {
        const { reason } = req.body;
        const exam = await FormalExam.findOne({ _id: req.params.examId, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (!['SUBMITTED','REOPENED'].includes(exam.status))
            return res.status(400).json({ success: false, message: 'Cannot reject in current status' });

        const section = await ClassSection.findOne({
            _id: exam.section,
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
        });
        if (!section) return res.status(403).json({ success: false, message: 'Only class teacher can reject' });

        exam.status          = 'REJECTED';
        exam.rejectionReason = reason || '';
        exam.auditLog.push({ action: 'CLASS_REJECTED', by: req.userId, notes: reason || '' });
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Student: Results ──────────────────────────────────────────────────────────

exports.studentGetResults = async (req, res) => {
    try {
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        if (!profile?.currentSection) return res.json({ success: true, data: [] });

        const exams = await FormalExam.find({
            section: profile.currentSection,
            school:  req.schoolId,
            status:  'FINAL_APPROVED',
        }).lean();

        const examIds = exams.map(e => e._id);
        const results = await FormalResult.find({ student: req.userId, exam: { $in: examIds } })
            .populate('exam',             'title examType publishDate')
            .populate('subjects.subject', 'subjectName name')
            .lean();

        // Hide results before publish date
        const now     = new Date();
        const visible = results.filter(r => !r.exam?.publishDate || now >= new Date(r.exam.publishDate));
        res.json({ success: true, data: visible });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.studentGetResultDetail = async (req, res) => {
    try {
        const result = await FormalResult.findOne({ _id: req.params.resultId, student: req.userId })
            .populate('exam',             'title examType publishDate')
            .populate('subjects.subject', 'subjectName name')
            .lean();
        if (!result) return res.status(404).json({ success: false, message: 'Result not found' });

        const exam = result.exam;
        if (exam?.publishDate && new Date() < new Date(exam.publishDate))
            return res.status(403).json({ success: false, message: 'Result not yet published' });

        res.json({ success: true, data: result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Parent: view child's formal results ───────────────────────────────────────
exports.parentGetResults = async (req, res) => {
    try {
        const parent  = await ParentProfile.findOne({ user: req.userId }).lean();
        const childId = parent?.children?.[0] || parent?.student;
        if (!childId) return res.json({ success: true, data: [] });

        const profile = await StudentProfile.findOne({ user: childId }).lean();
        if (!profile?.currentSection) return res.json({ success: true, data: [] });

        const exams = await FormalExam.find({
            section: profile.currentSection, school: req.schoolId, status: 'FINAL_APPROVED',
        }).lean();

        const examIds = exams.map(e => e._id);
        const results = await FormalResult.find({ student: childId, exam: { $in: examIds } })
            .populate('exam',             'title examType publishDate')
            .populate('subjects.subject', 'subjectName name')
            .lean();

        const now     = new Date();
        const visible = results.filter(r => !r.exam?.publishDate || now >= new Date(r.exam.publishDate));
        res.json({ success: true, data: visible });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.parentGetResultDetail = async (req, res) => {
    try {
        const parent  = await ParentProfile.findOne({ user: req.userId }).lean();
        const childId = parent?.children?.[0] || parent?.student;
        if (!childId) return res.status(404).json({ success: false, message: 'No child found' });

        const result = await FormalResult.findOne({ _id: req.params.resultId, student: childId })
            .populate('exam',             'title examType publishDate')
            .populate('subjects.subject', 'subjectName name')
            .lean();
        if (!result) return res.status(404).json({ success: false, message: 'Result not found' });

        const exam = result.exam;
        if (exam?.publishDate && new Date() < new Date(exam.publishDate))
            return res.status(403).json({ success: false, message: 'Result not yet published' });

        res.json({ success: true, data: result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
