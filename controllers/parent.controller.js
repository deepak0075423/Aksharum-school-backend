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
/**
 * Every child's class, one entry each.
 *
 * A parent can have more than one child and their classes differ, so this
 * answers per child rather than picking one. It used to run
 * `StudentProfile.findOne({ user: { $in: childIds } })` — the first row the
 * database happened to return — so a second child's class was invisible and
 * nothing on the page said a second child existed.
 *
 * The flat keys and the top-level `student`/`section` describe the first child
 * and stay for the mobile screens, which were written against them.
 */
exports.getChildClass = async (req, res) => {
    try {
        const User           = require('../models/User');
        const TeacherProfile = require('../models/TeacherProfile');
        const { classViewFor } = require('../services/classView');

        // Two sources of truth for the link, and they drift: the parent's own
        // children list and the student profile's `parent` pointer. Take both.
        const parent = await ParentProfile.findOne({ user: req.userId }).lean();
        const listed = parent?.children?.length ? parent.children : (parent?.student ? [parent.student] : []);
        const owned  = await StudentProfile.find({ parent: req.userId, school: req.schoolId })
            .select('user').lean();
        const childIds = [...new Set([...listed, ...owned.map((p) => p.user)]
            .filter(Boolean).map(String))];

        // Scoped to this school's students, so a stale id on the parent record
        // cannot reach into another school.
        const childUsers = childIds.length
            ? await User.find({ _id: { $in: childIds }, role: 'student', school: req.schoolId })
                .select('name profileImage').lean()
            : [];
        childUsers.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

        const children = [];
        for (const kid of childUsers) {
            const view = await classViewFor({ studentId: kid._id, schoolId: req.schoolId });
            const sec  = view.section;
            children.push({
                _id:          kid._id,
                name:         kid.name,
                profileImage: kid.profileImage || '',
                className:    sec?.class?.className || view.pendingClass?.className || '',
                sectionName:  sec?.sectionName || '',
                rollNumber:   view.profile?.rollNumber || '',
                admissionNo:  view.profile?.admissionNumber || '',
                ...view,
            });
        }

        const first = children[0] || null;

        // The class teacher's designation is only read off the flat legacy
        // shape, so it is looked up for the first child alone.
        let classTeacher = null;
        if (first?.section?.classTeacher) {
            const tp = await TeacherProfile.findOne({ user: first.section.classTeacher._id })
                .select('designation').lean();
            classTeacher = {
                name:        first.section.classTeacher.name,
                phone:       first.section.classTeacher.phone || '',
                designation: tp?.designation || 'Teacher',
            };
        }

        res.json({ success: true, data: {
            children,
            // First child, flat — the shape the mobile screens read.
            student:       first?.profile || null,
            section:       first?.section || null,
            announcements: first?.announcements || [],
            studentName:   first?.name || '',
            className:     first?.className || '',
            sectionName:   first?.sectionName || '',
            rollNumber:    first?.rollNumber || '',
            admissionNo:   first?.admissionNo || '',
            classTeacher,
            subjects:      first?.subjects || [],
        }});
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
