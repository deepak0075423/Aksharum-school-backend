'use strict';
const StudentProfile = require('../models/StudentProfile');
const ClassSection   = require('../models/ClassSection');

exports.getDashboard = async (req, res) => {
    try {
        const FeeLedger    = require('../models/FeeLedger');
        const AcademicYear = require('../models/AcademicYear');
        const dash         = require('../services/studentDashboard');

        const profile = await StudentProfile.findOne({ user: req.userId })
            .populate({ path: 'currentSection', populate: { path: 'class', select: 'className' } })
            .lean();

        const sectionId = profile?.currentSection?._id || null;

        // Outstanding fee balance
        const ay = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        const [snapshot, lastLedger] = await Promise.all([
            dash.studentSnapshot({ schoolId: req.schoolId, sectionId, studentId: req.userId }),
            ay ? FeeLedger.findOne({
                school: req.schoolId, student: req.userId, academicYear: ay._id,
            }).sort({ createdAt: -1 }).select('runningBalance').lean().catch(() => null) : null,
        ]);

        res.json({ success: true, data: {
            profile,
            ...snapshot,
            feeBalance: lastLedger?.runningBalance ?? 0,
        }});
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getMyClass = async (req, res) => {
    try {
        const User                  = require('../models/User');
        const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
        const ClassMonitor          = require('../models/ClassMonitor');
        const ClassAnnouncement     = require('../models/ClassAnnouncement');

        const Class = require('../models/Class');
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();

        // A student belongs to a section by either route — the profile's pointer
        // or the section's own roster — and the two are not always in step. The
        // page used to read the pointer alone, so a student placed through the
        // roster was told they had no class at all.
        let sectionId = profile?.currentSection || null;
        if (!sectionId) {
            const bySection = await ClassSection.findOne({ enrolledStudents: req.userId }).select('_id').lean();
            sectionId = bySection?._id || null;
        }

        const section = sectionId
            ? await ClassSection.findById(sectionId)
                .populate('class', 'className classNumber')
                .populate('classTeacher',      'name email')
                .populate('substituteTeacher', 'name email')
                .populate('academicYear',      'yearName')
                .lean()
            : null;

        if (!section) {
            // Admitted to a class but not placed in a section yet is a real
            // state — the class shuffle exists to resolve exactly it — so say
            // which class, rather than "no class".
            const cls = profile?.currentClass
                ? await Class.findById(profile.currentClass).select('className classNumber').lean()
                : null;
            return res.json({ success: true, data: { profile, section: null, pendingClass: cls || null } });
        }

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
