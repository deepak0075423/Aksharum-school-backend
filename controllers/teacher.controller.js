'use strict';
const User           = require('../models/User');
const TeacherProfile = require('../models/TeacherProfile');

exports.getDashboard = async (req, res) => {
    try {
        const ClassSection    = require('../models/ClassSection');
        const AttendanceCorrection = require('../models/AttendanceCorrection');
        const FormalExam      = require('../models/FormalExam');
        const Timetable       = require('../models/Timetable');
        const TimetableEntry  = require('../models/TimetableEntry');
        const LeaveBalance    = require('../models/LeaveBalance');

        const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const today = DAYS[new Date().getDay()];

        const [profile, mySection] = await Promise.all([
            TeacherProfile.findOne({ user: req.userId }).lean(),
            ClassSection.findOne({
                school: req.schoolId,
                $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
            }).populate('class', 'className').lean(),
        ]);

        const [pendingCorrections, pendingValidation, timetableIds, balances] = await Promise.all([
            mySection
                ? AttendanceCorrection.countDocuments({ section: mySection._id, status: 'Pending' }).catch(() => 0)
                : 0,
            mySection
                ? FormalExam.countDocuments({ section: mySection._id, school: req.schoolId, status: { $in: ['SUBMITTED', 'REOPENED'] } }).catch(() => 0)
                : 0,
            TimetableEntry.find({ teacher: req.userId }).distinct('timetable').catch(() => []),
            LeaveBalance.find({ teacher: req.userId, school: req.schoolId })
                .populate('leaveType', 'name').lean().catch(() => []),
        ]);

        // Today's periods across every section timetable this teacher appears in
        let todayPeriods = [];
        if (timetableIds.length && today !== 'Sunday') {
            const entries = await TimetableEntry.find({
                teacher: req.userId, timetable: { $in: timetableIds }, dayOfWeek: today,
            }).populate('subject', 'subjectName').sort({ periodNumber: 1 }).lean();
            const timetables = await Timetable.find({ _id: { $in: timetableIds } })
                .populate({ path: 'section', select: 'sectionName' }).lean();
            const secByTt = Object.fromEntries(timetables.map(t => [String(t._id), t.section]));
            todayPeriods = entries.map(e => ({
                periodNumber: e.periodNumber,
                subject:      e.subject?.subjectName || '',
                section:      secByTt[String(e.timetable)]?.sectionName || '',
            }));
        }

        const leaveRemaining = balances.reduce((s, b) => s + Math.max(0, (b.totalAllocated || 0) + (b.carriedForward || 0) - (b.used || 0) - (b.pending || 0)), 0);

        res.json({ success: true, data: {
            profile,
            mySection: mySection ? {
                _id: mySection._id,
                sectionName: mySection.sectionName,
                className:   mySection.class?.className || '',
                studentCount:(mySection.enrolledStudents || []).length,
            } : null,
            todayPeriods,
            pending: { corrections: pendingCorrections, validation: pendingValidation },
            leaveRemaining,
        }});
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
