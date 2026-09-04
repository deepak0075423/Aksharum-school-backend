'use strict';
const StudentProfile = require('../models/StudentProfile');
const ClassSection   = require('../models/ClassSection');

/**
 * One month of this student's own attendance, or null when the section marked
 * nothing that month (which is not the same as 0%).
 *
 * Sessions are stored at UTC midnight of the day they belong to — see
 * attendance.controller — so the month window is built in UTC to match.
 */
async function monthAttendance(Attendance, AttendanceRecord, sectionId, studentId, year, month) {
    const start = new Date(Date.UTC(year, month, 1));
    const next  = new Date(Date.UTC(year, month + 1, 1));

    const sessions = await Attendance.find({
        section: sectionId, date: { $gte: start, $lt: next },
    }).select('_id').lean();
    if (!sessions.length) return null;

    const records = await AttendanceRecord.find({
        attendance: { $in: sessions.map(s => s._id) }, student: studentId,
    }).lean();
    if (!records.length) return null;

    // Late still counts as attended — the same rule the section reports use.
    const present = records.filter(r => ['Present', 'Late'].includes(r.status)).length;
    return {
        total: records.length,
        present,
        absent: records.length - present,
        percentage: Math.round((present / records.length) * 100),
    };
}

/**
 * The student's own published formal results, oldest first, plus the subject
 * breakdown of the most recent one.
 *
 * Only FINAL_APPROVED exams past their publish date are readable — the same two
 * conditions studentGetResults enforces, kept together here so the dashboard can
 * never show a mark the results page would still be hiding.
 */
async function performance(FormalExam, FormalResult, schoolId, sectionId, studentId) {
    const exams = await FormalExam.find({
        section: sectionId, school: schoolId, status: 'FINAL_APPROVED',
    }).select('title examType startDate publishDate').lean();
    if (!exams.length) return null;

    const byId    = new Map(exams.map(e => [String(e._id), e]));
    const results = await FormalResult.find({
        student: studentId, exam: { $in: exams.map(e => e._id) },
    }).populate('subjects.subject', 'subjectName').lean();

    const now = new Date();
    const rows = results
        .map(r => ({ r, e: byId.get(String(r.exam)) }))
        .filter(({ e }) => e && (!e.publishDate || now >= new Date(e.publishDate)))
        .sort((a, b) => new Date(a.e.startDate) - new Date(b.e.startDate));
    if (!rows.length) return null;

    const trend = rows.map(({ r, e }) => ({
        examId:     r.exam,
        title:      e.title,
        examType:   e.examType,
        date:       e.startDate,
        percentage: Math.round(r.percentage || 0),
        grade:      r.grade || '',
    }));

    const last = rows[rows.length - 1];
    const subjects = (last.r.subjects || [])
        .filter(sub => !sub.isAbsent && sub.maxMarks > 0)
        .map(sub => ({
            name:          sub.subject?.subjectName || 'Subject',
            marksObtained: sub.marksObtained,
            maxMarks:      sub.maxMarks,
            percentage:    Math.round((sub.marksObtained / sub.maxMarks) * 100),
            grade:         sub.grade || '',
            isPassed:      !!sub.isPassed,
        }))
        .sort((a, b) => b.percentage - a.percentage);

    return {
        trend,
        subjects,
        latest: {
            title:      last.e.title,
            percentage: Math.round(last.r.percentage || 0),
            grade:      last.r.grade || '',
            rank:       last.r.rank || 0,
            resultId:   last.r._id,
        },
    };
}

exports.getDashboard = async (req, res) => {
    try {
        const Attendance       = require('../models/Attendance');
        const AttendanceRecord = require('../models/AttendanceRecord');
        const AptitudeExam     = require('../models/AptitudeExam');
        const FeeLedger        = require('../models/FeeLedger');
        const AcademicYear     = require('../models/AcademicYear');
        const FormalExam       = require('../models/FormalExam');
        const FormalResult     = require('../models/FormalResult');

        const profile = await StudentProfile.findOne({ user: req.userId })
            .populate({ path: 'currentSection', populate: { path: 'class', select: 'className' } })
            .lean();

        const sectionId = profile?.currentSection?._id || null;
        const now       = new Date();

        // This month and last month, so the dashboard can say which way it moved.
        let attendance = null;
        let attendancePrev = null;
        if (sectionId) {
            [attendance, attendancePrev] = await Promise.all([
                monthAttendance(Attendance, AttendanceRecord, sectionId, req.userId, now.getFullYear(), now.getMonth()),
                monthAttendance(Attendance, AttendanceRecord, sectionId, req.userId, now.getFullYear(), now.getMonth() - 1)
                    .catch(() => null),
            ]);
        }

        // Upcoming published aptitude exams
        const upcomingExams = sectionId
            ? await AptitudeExam.find({
                school: req.schoolId, section: sectionId,
                status: 'published', examDate: { $gte: new Date(Date.now() - 86400000) },
              }).select('title examDate startTime duration').sort({ examDate: 1 }).limit(3).lean().catch(() => [])
            : [];

        // Outstanding fee balance
        const ay = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        const lastLedger = ay ? await FeeLedger.findOne({
            school: req.schoolId, student: req.userId, academicYear: ay._id,
        }).sort({ createdAt: -1 }).select('runningBalance').lean().catch(() => null) : null;

        // Marks are a nicety on this screen, never a reason for it to fail.
        const marks = sectionId
            ? await performance(FormalExam, FormalResult, req.schoolId, sectionId, req.userId).catch(() => null)
            : null;

        res.json({ success: true, data: {
            profile,
            attendance,
            attendancePrev,
            upcomingExams,
            feeBalance: lastLedger?.runningBalance ?? 0,
            performance: marks,
        }});
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
exports.getMyClass = async (req, res) => {
    try {
        const User                  = require('../models/User');
        const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
        const ClassMonitor          = require('../models/ClassMonitor');
        const ClassAnnouncement     = require('../models/ClassAnnouncement');

        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        const section = await ClassSection.findById(profile?.currentSection)
            .populate('class', 'className classNumber')
            .populate('classTeacher',      'name email')
            .populate('substituteTeacher', 'name email')
            .populate('academicYear',      'yearName')
            .lean();

        if (!section) return res.json({ success: true, data: { profile, section: null } });

        const [subjectTeachers, monitors, classmates, announcements] = await Promise.all([
            SectionSubjectTeacher.find({ section: section._id })
                .populate('subject', 'subjectName')
                .populate('teacher', 'name')
                .lean().catch(() => []),
            ClassMonitor.find({ section: section._id }).populate('student', 'name').lean().catch(() => []),
            User.find({ _id: { $in: section.enrolledStudents || [] } }).select('name').lean(),
            ClassAnnouncement.find({ section: section._id, status: 'active' })
                .sort({ createdAt: -1 }).limit(10).lean().catch(() => []),
        ]);

        const profiles = await StudentProfile.find({ user: { $in: (classmates || []).map(c => c._id) } })
            .select('user rollNumber').lean();
        const rollById = Object.fromEntries(profiles.map(p => [String(p.user), p.rollNumber]));
        const roster = (classmates || [])
            .map(c => ({ _id: c._id, name: c.name, rollNumber: rollById[String(c._id)] || '', isMe: String(c._id) === String(req.userId) }))
            .sort((a, b) => (a.rollNumber || '').localeCompare(b.rollNumber || '', undefined, { numeric: true }) || a.name.localeCompare(b.name));

        const seen = new Set();
        const subjects = [];
        (subjectTeachers || []).forEach(st => {
            const key = String(st.subject?._id) + String(st.teacher?._id);
            if (st.subject && !seen.has(key)) { seen.add(key); subjects.push({ subject: st.subject?.subjectName, teacher: st.teacher?.name }); }
        });

        res.json({ success: true, data: {
            profile,
            section,
            subjectTeachers: subjects,
            monitors: (monitors || []).map(m => ({ name: m.student?.name })).filter(m => m.name),
            classmates: roster,
            announcements,
        }});
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
