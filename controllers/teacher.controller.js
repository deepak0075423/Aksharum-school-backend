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
                .populate({ path: 'section', select: 'sectionName class',
                            populate: { path: 'class', select: 'className' } }).lean();
            const secByTt = Object.fromEntries(timetables.map(t => [String(t._id), t.section]));
            // When each period starts is on the timetable, not on the entry —
            // without it "Period 3" is a number nobody can plan around.
            const timesByTt = Object.fromEntries(timetables.map(t => [
                String(t._id),
                Object.fromEntries((t.periodsStructure || []).map(ps => [ps.periodNumber, ps])),
            ]));
            todayPeriods = entries.map(e => {
                const sec  = secByTt[String(e.timetable)];
                const slot = timesByTt[String(e.timetable)]?.[e.periodNumber] || {};
                return {
                    periodNumber: e.periodNumber,
                    subject:      e.subject?.subjectName || '',
                    section:      sec?.sectionName || '',
                    className:    sec?.class?.className || '',
                    startTime:    slot.startTime || '',
                    endTime:      slot.endTime   || '',
                };
            });
        }

        // Periods this teacher is covering for an absent colleague today. Their
        // own timetable does not show these, so without it the day looks lighter
        // than it is.
        let substitutions = [];
        try {
            const SubstituteAssignment = require('../models/SubstituteAssignment');
            const dayStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
            const dayEnd   = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
            const rows = await SubstituteAssignment.find({
                substituteTeacher: req.userId, school: req.schoolId,
                date: { $gte: dayStart, $lt: dayEnd }, status: 'assigned',
            }).populate('subject', 'subjectName')
              .populate({ path: 'section', select: 'sectionName class',
                          populate: { path: 'class', select: 'className' } })
              .sort({ periodNumber: 1 }).lean();
            substitutions = rows.map(r => ({
                periodNumber: r.periodNumber,
                subject:      r.subject?.subjectName || '',
                section:      r.section?.sectionName || '',
                className:    r.section?.class?.className || '',
            }));
        } catch { substitutions = []; }

        // ── Average result per class this teacher takes ───────────────────
        // Scope matches studentAnalytics' resolveScope: sections where they are
        // the class teacher or vice, plus every section they teach a subject in.
        // The figure is the section's average in its most recent PUBLISHED exam,
        // so it can never show a mark the results screens are still withholding.
        let classPerformance = [];
        try {
            const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
            const FormalResult          = require('../models/FormalResult');

            const [taught, owned] = await Promise.all([
                SectionSubjectTeacher.find({ teacher: req.userId }).distinct('section'),
                ClassSection.find({
                    school: req.schoolId,
                    $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
                }).select('_id').lean(),
            ]);
            const sectionIds = [...new Set([
                ...taught.map(String), ...owned.map((s) => String(s._id)),
            ])];

            if (sectionIds.length) {
                const [sections, exams] = await Promise.all([
                    ClassSection.find({ _id: { $in: sectionIds } })
                        .select('sectionName class').populate('class', 'className').lean(),
                    FormalExam.find({
                        section: { $in: sectionIds }, school: req.schoolId, status: 'FINAL_APPROVED',
                    }).select('section title startDate publishDate').lean(),
                ]);

                // The newest exam per section that is actually readable today.
                const now = new Date();
                const latestBySection = new Map();
                for (const e of exams) {
                    if (e.publishDate && now < new Date(e.publishDate)) continue;
                    const key  = String(e.section);
                    const seen = latestBySection.get(key);
                    if (!seen || new Date(e.startDate) > new Date(seen.startDate)) latestBySection.set(key, e);
                }

                const examIds = [...latestBySection.values()].map((e) => e._id);
                const results = examIds.length
                    ? await FormalResult.find({ exam: { $in: examIds } }).select('exam percentage').lean()
                    : [];

                const byExam = new Map();
                for (const r of results) {
                    const k = String(r.exam);
                    if (!byExam.has(k)) byExam.set(k, []);
                    byExam.get(k).push(r.percentage || 0);
                }

                const secById = new Map(sections.map((sec) => [String(sec._id), sec]));
                for (const [sectionId, exam] of latestBySection) {
                    const marks = byExam.get(String(exam._id)) || [];
                    if (!marks.length) continue;              // nothing published for anyone yet
                    const sec = secById.get(sectionId);
                    classPerformance.push({
                        sectionId,
                        className:   sec?.class?.className || '',
                        sectionName: sec?.sectionName || '',
                        examTitle:   exam.title || '',
                        students:    marks.length,
                        percentage:  Math.round(marks.reduce((a, b) => a + b, 0) / marks.length),
                    });
                }
                classPerformance.sort((a, b) =>
                    (a.className || '').localeCompare(b.className || '', undefined, { numeric: true })
                    || (a.sectionName || '').localeCompare(b.sectionName || ''));
            }
        } catch { classPerformance = []; }

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
            substitutions,
            classPerformance,
            pending: { corrections: pendingCorrections, validation: pendingValidation },
            leaveRemaining,
        }});
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
