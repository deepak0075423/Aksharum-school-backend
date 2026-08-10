'use strict';
const ClassTest       = require('../models/ClassTest');
const ClassSection    = require('../models/ClassSection');
const AcademicYear    = require('../models/AcademicYear');
const StudentProfile  = require('../models/StudentProfile');
const ParentProfile   = require('../models/ParentProfile');
const User            = require('../models/User');

function calcGrade(pct) {
    if (pct >= 90) return 'A+';
    if (pct >= 80) return 'A';
    if (pct >= 70) return 'B+';
    if (pct >= 60) return 'B';
    if (pct >= 50) return 'C';
    if (pct >= 40) return 'D';
    return 'F';
}

function computeStats(marks, maxMarks, passingMarks) {
    const scored = marks.filter(m => !m.isAbsent && m.marksObtained !== null).map(m => m.marksObtained);
    if (!scored.length) return { average: null, highest: null, lowest: null, passPercent: null };
    const passed  = scored.filter(s => s >= passingMarks).length;
    return {
        average:     Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100,
        highest:     Math.max(...scored),
        lowest:      Math.min(...scored),
        passPercent: Math.round((passed / scored.length) * 100),
    };
}

// ── Teacher: Class Tests ──────────────────────────────────────────────────────

exports.teacherGetClassTests = async (req, res) => {
    try {
        const { status } = req.query;
        const filter = { school: req.schoolId, createdBy: req.userId };
        if (status) filter.status = status;

        const tests = await ClassTest.find(filter)
            .populate('section', 'sectionName')
            .populate('subject', 'subjectName name')
            .sort({ testDate: -1 })
            .lean();
        res.json({ success: true, data: tests });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherCreateClassTest = async (req, res) => {
    try {
        const { sectionId, subjectId, title, testDate, maxMarks, passingMarks, topic, description } = req.body;
        if (!sectionId || !subjectId || !title || !testDate || !maxMarks || passingMarks === undefined)
            return res.status(400).json({ success: false, message: 'sectionId, subjectId, title, testDate, maxMarks, passingMarks are required' });

        const ay = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const test = await ClassTest.create({
            school: req.schoolId, section: sectionId, subject: subjectId,
            academicYear: ay._id, title: title.trim(), testDate: new Date(testDate),
            maxMarks: +maxMarks, passingMarks: +passingMarks,
            topic: topic || '', description: description || '',
            createdBy: req.userId,
            auditLog: [{ action: 'CREATED', by: req.userId }],
        });
        res.status(201).json({ success: true, data: test });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherGetTestMarks = async (req, res) => {
    try {
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId })
            .populate('section', 'sectionName enrolledStudents')
            .populate('subject', 'subjectName name')
            .lean();
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });

        const students = await User.find({ _id: { $in: test.section?.enrolledStudents || [] } })
            .select('name rollNumber email').lean();

        const marksMap = Object.fromEntries((test.marks || []).map(m => [m.student.toString(), m]));
        const entries  = students.map(s => ({
            ...s, ...(marksMap[s._id.toString()] || { marksObtained: null, isAbsent: false, remarks: '', grade: '' }),
        }));

        res.json({ success: true, data: { test, entries } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherSaveTestMarks = async (req, res) => {
    try {
        const { marks, submit } = req.body;
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        if (test.status === 'FINAL_APPROVED') return res.status(400).json({ success: false, message: 'Test is already approved' });

        const processed = (marks || []).map(m => ({
            student:        m.student,
            marksObtained:  m.isAbsent ? null : Number(m.marksObtained),
            isAbsent:       !!m.isAbsent,
            remarks:        m.remarks || '',
            grade:          m.isAbsent ? '' : calcGrade(test.maxMarks > 0 ? (Number(m.marksObtained) / test.maxMarks) * 100 : 0),
        }));

        test.marks     = processed;
        test.classStats = computeStats(processed, test.maxMarks, test.passingMarks);
        if (submit) {
            test.status = 'SUBMITTED';
            test.auditLog.push({ action: 'SUBMITTED', by: req.userId });
        } else {
            test.auditLog.push({ action: 'SAVED', by: req.userId });
        }
        await test.save();
        res.json({ success: true, data: test });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherReopenTest = async (req, res) => {
    try {
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        if (test.status !== 'REJECTED') return res.status(400).json({ success: false, message: 'Only rejected tests can be reopened' });

        test.status = 'REOPENED';
        test.auditLog.push({ action: 'REOPENED', by: req.userId });
        await test.save();
        res.json({ success: true, data: test });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: Class Test Validation (class teacher) ───────────────────────────

exports.teacherGetClassTestValidation = async (req, res) => {
    try {
        const mySections = await ClassSection.find({
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
            school: req.schoolId,
        }).lean();
        if (!mySections.length) return res.json({ success: true, data: [] });

        const sectionIds = mySections.map(s => s._id);
        const tests = await ClassTest.find({
            section: { $in: sectionIds },
            school:  req.schoolId,
            status:  { $in: ['SUBMITTED', 'REOPENED'] },
        })
            .populate('subject',  'subjectName name')
            .populate('section',  'sectionName')
            .populate('createdBy','name')
            .sort({ testDate: -1 })
            .lean();
        res.json({ success: true, data: tests });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherGetClassTestValidationDetail = async (req, res) => {
    try {
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('subject',   'subjectName name')
            .populate('section',   'sectionName')
            .populate('createdBy', 'name')
            .lean();
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });

        const students = await User.find({ _id: { $in: test.marks.map(m => m.student) } })
            .select('name rollNumber').lean();
        const studentMap = Object.fromEntries(students.map(s => [s._id.toString(), s]));
        const marks = test.marks.map(m => ({ ...m, studentInfo: studentMap[m.student.toString()] }));

        res.json({ success: true, data: { ...test, marks } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherApproveClassTest = async (req, res) => {
    try {
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        if (!['SUBMITTED','REOPENED'].includes(test.status))
            return res.status(400).json({ success: false, message: 'Cannot approve in current status' });

        const section = await ClassSection.findOne({
            _id: test.section,
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
        });
        if (!section) return res.status(403).json({ success: false, message: 'Only class teacher can approve' });

        test.status     = 'FINAL_APPROVED';
        test.approvedBy = req.userId;
        test.approvedAt = new Date();
        test.auditLog.push({ action: 'APPROVED', by: req.userId, notes: req.body.notes || '' });
        await test.save();
        res.json({ success: true, data: test });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherRejectClassTest = async (req, res) => {
    try {
        const { reason } = req.body;
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        if (!['SUBMITTED','REOPENED'].includes(test.status))
            return res.status(400).json({ success: false, message: 'Cannot reject in current status' });

        const section = await ClassSection.findOne({
            _id: test.section,
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
        });
        if (!section) return res.status(403).json({ success: false, message: 'Only class teacher can reject' });

        test.status          = 'REJECTED';
        test.rejectionReason = reason || '';
        test.auditLog.push({ action: 'REJECTED', by: req.userId, notes: reason || '' });
        await test.save();
        res.json({ success: true, data: test });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Student: Class Test Results ───────────────────────────────────────────────

exports.studentGetClassTests = async (req, res) => {
    try {
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        if (!profile?.currentSection) return res.json({ success: true, data: [] });

        const tests = await ClassTest.find({
            section: profile.currentSection,
            school:  req.schoolId,
            status:  'FINAL_APPROVED',
        })
            .populate('subject', 'subjectName name')
            .sort({ testDate: -1 })
            .lean();

        const data = tests.map(t => {
            const myEntry = t.marks.find(m => m.student.toString() === req.userId.toString());
            return {
                _id:          t._id,
                title:        t.title,
                subject:      t.subject,
                testDate:     t.testDate,
                maxMarks:     t.maxMarks,
                passingMarks: t.passingMarks,
                myEntry:      myEntry ? {
                    marksObtained: myEntry.marksObtained,
                    isAbsent:      myEntry.isAbsent,
                    grade:         myEntry.grade,
                    remarks:       myEntry.remarks,
                } : null,
                classStats: t.classStats,
            };
        });
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Parent: view child's class tests ─────────────────────────────────────────
exports.parentGetClassTests = async (req, res) => {
    try {
        const parent  = await ParentProfile.findOne({ user: req.userId }).lean();
        const childId = parent?.children?.[0] || parent?.student;
        if (!childId) return res.json({ success: true, data: [] });

        const profile = await StudentProfile.findOne({ user: childId }).lean();
        if (!profile?.currentSection) return res.json({ success: true, data: [] });

        const tests = await ClassTest.find({
            section: profile.currentSection, school: req.schoolId, status: 'FINAL_APPROVED',
        })
            .populate('subject', 'subjectName name')
            .sort({ testDate: -1 })
            .lean();

        const data = tests.map(t => {
            const entry = t.marks.find(m => m.student.toString() === childId.toString());
            return {
                _id:          t._id,
                title:        t.title,
                subject:      t.subject,
                testDate:     t.testDate,
                maxMarks:     t.maxMarks,
                passingMarks: t.passingMarks,
                myEntry:      entry ? {
                    marksObtained: entry.marksObtained,
                    isAbsent:      entry.isAbsent,
                    grade:         entry.grade,
                    remarks:       entry.remarks,
                } : null,
                classStats: t.classStats,
            };
        });
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
