'use strict';
const ParentProfile  = require('../models/ParentProfile');
const StudentProfile = require('../models/StudentProfile');
const ClassSection   = require('../models/ClassSection');

exports.getDashboard = async (req, res) => {
    try {
        const User             = require('../models/User');
        const Attendance       = require('../models/Attendance');
        const AttendanceRecord = require('../models/AttendanceRecord');
        const FeeLedger        = require('../models/FeeLedger');
        const AcademicYear     = require('../models/AcademicYear');
        const dashboardSvc     = require('../services/studentDashboard');

        const parent = await ParentProfile.findOne({ user: req.userId }).lean();
        const childIds = parent?.children?.length ? parent.children : (parent?.student ? [parent.student] : []);

        const ay = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        const now   = new Date();
        const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));

        if (!childIds.length) return res.json({ success: true, data: { parent, children: [], child: null } });

        // One query per collection for all children, instead of ~5 round trips per child.
        const [users, profiles] = await Promise.all([
            User.find({ _id: { $in: childIds } }).select('name').lean(),
            StudentProfile.find({ user: { $in: childIds } })
                .populate({ path: 'currentSection', select: 'sectionName class', populate: { path: 'class', select: 'className' } })
                .lean(),
        ]);
        const userById    = new Map(users.map((u) => [String(u._id), u]));
        const profileByKid = new Map(profiles.map((p) => [String(p.user), p]));

        const sectionIds = profiles.map((p) => p.currentSection?._id).filter(Boolean);
        let recordsBySection = new Map();
        if (sectionIds.length) {
            const sessions = await Attendance.find({ section: { $in: sectionIds }, date: { $gte: start } }).select('_id section').lean();
            if (sessions.length) {
                const sessionIds = sessions.map((s) => s._id);
                const sessionToSection = new Map(sessions.map((s) => [String(s._id), String(s.section)]));
                const records = await AttendanceRecord.find({
                    attendance: { $in: sessionIds }, student: { $in: childIds },
                }).lean();
                recordsBySection = new Map();
                for (const r of records) {
                    const sectionId = sessionToSection.get(String(r.attendance));
                    const key = `${sectionId}:${String(r.student)}`;
                    if (!recordsBySection.has(key)) recordsBySection.set(key, []);
                    recordsBySection.get(key).push(r);
                }
            }
        }

        // Latest ledger entry per child: fetch every row for the year (sorted
        // newest-first) in one query, keep the first occurrence per student.
        let latestLedgerByKid = new Map();
        if (ay) {
            const ledgerRows = await FeeLedger.find({ school: req.schoolId, student: { $in: childIds }, academicYear: ay._id })
                .sort({ createdAt: -1 }).select('student runningBalance').lean();
            for (const row of ledgerRows) {
                const key = String(row.student);
                if (!latestLedgerByKid.has(key)) latestLedgerByKid.set(key, row);
            }
        }

        const children = [];
        for (const childId of childIds) {
            const user = userById.get(String(childId));
            if (!user) continue;
            const sp = profileByKid.get(String(childId)) || null;

            let attendance = null;
            if (sp?.currentSection) {
                const records = recordsBySection.get(`${String(sp.currentSection._id)}:${String(childId)}`) || [];
                const present = records.filter((r) => ['Present', 'Late'].includes(r.status)).length;
                attendance = records.length ? Math.round((present / records.length) * 100) : null;
            }

            const lastLedger = latestLedgerByKid.get(String(childId)) || null;

            children.push({
                _id:        childId,
                name:       user.name,
                className:  sp?.currentSection?.class?.className || '',
                sectionName:sp?.currentSection?.sectionName || '',
                rollNumber: sp?.rollNumber || '',
                attendancePercentage: attendance,
                feeBalance: lastLedger?.runningBalance ?? 0,
            });
        }

        // ── The one child the dashboard is showing ────────────────────────
        // `children` still carries the summary row for every child (the picker
        // needs them all); this is the detail block for the selected one.
        // ?childId= must belong to THIS parent — it is a caller-supplied id, so
        // it is matched against the list above rather than trusted.
        const wanted  = String(req.query.childId || '');
        const chosen  = children.find((c) => String(c._id) === wanted) || children[0] || null;
        let child = null;
        if (chosen) {
            const sp = profileByKid.get(String(chosen._id)) || null;
            const snapshot = await dashboardSvc.studentSnapshot({
                schoolId:  req.schoolId,
                sectionId: sp?.currentSection?._id || null,
                studentId: chosen._id,
            }).catch(() => ({}));
            child = { ...chosen, ...snapshot };
        }

        res.json({ success: true, data: { parent, children, child } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
exports.getChildClass = async (req, res) => {
    try {
        const User           = require('../models/User');
        const TeacherProfile = require('../models/TeacherProfile');
        const ClassSubject   = require('../models/ClassSubject');

        const parent   = await ParentProfile.findOne({ user: req.userId }).lean();
        const childIds = parent?.children?.length ? parent.children : (parent?.student ? [parent.student] : []);
        let student = childIds.length
            ? await StudentProfile.findOne({ user: { $in: childIds } }).lean()
            : null;
        if (!student) student = await StudentProfile.findOne({ parent: req.userId }).lean();

        const section = student?.currentSection
            ? await ClassSection.findById(student.currentSection).populate('class classTeacher').lean()
            : null;

        const childUser = student ? await User.findById(student.user).select('name').lean() : null;

        let classTeacher = null;
        if (section?.classTeacher) {
            const tp = await TeacherProfile.findOne({ user: section.classTeacher._id }).select('designation').lean();
            classTeacher = {
                name:        section.classTeacher.name,
                phone:       section.classTeacher.phone || '',
                designation: tp?.designation || 'Teacher',
            };
        }

        let subjects = [];
        if (section?.class?._id) {
            const rows = await ClassSubject.find({ class: section.class._id }).populate('subject', 'subjectName').lean();
            subjects = rows.filter((r) => r.subject).map((r) => ({ _id: r.subject._id, name: r.subject.subjectName }));
        }

        // nested student/section kept for the mobile app; flat keys for the web page
        res.json({ success: true, data: {
            student, section,
            studentName: childUser?.name || '',
            className:   section?.class?.className || '',
            sectionName: section?.sectionName || '',
            rollNumber:  student?.rollNumber || '',
            admissionNo: student?.admissionNumber || '',
            classTeacher,
            subjects,
        }});
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
