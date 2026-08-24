'use strict';
const ClassSection        = require('../models/ClassSection');
const Attendance          = require('../models/Attendance');
const ClassAnnouncement   = require('../models/ClassAnnouncement');
const ClassMonitor        = require('../models/ClassMonitor');
const StudentProfile      = require('../models/StudentProfile');
const AttendanceRecord    = require('../models/AttendanceRecord');

const ok  = (res, d, s=200) => res.status(s).json({ success: true, data: d });
const err = (res, e, s=500) => res.status(s).json({ success: false, message: e.message||e });

exports.getMySection = async (req, res) => {
    try {
        const section = await ClassSection.findOne({ classTeacher: req.userId, school: req.schoolId })
            .populate('class').lean();
        const announcements = await ClassAnnouncement.find({ section: section?._id }).sort({ createdAt: -1 }).lean();
        const monitors = await ClassMonitor.find({ section: section?._id }).populate('student','name').lean();
        ok(res, { section, announcements, monitors });
    } catch (e) { err(res, e); }
};
exports.createAnnouncement = async (req, res) => {
    try {
        if (!req.body.title?.trim() && !req.body.message?.trim() && !req.body.content?.trim())
            return err(res, 'Announcement text is required', 400);
        const mySection = await ClassSection.findOne({ classTeacher: req.userId, school: req.schoolId }).lean();
        const ann = await ClassAnnouncement.create({
            section: mySection?._id, createdBy: req.userId, school: req.schoolId, ...req.body,
        });
        ok(res, ann, 201);
    } catch (e) { err(res, e); }
};
exports.deleteAnnouncement = async (req, res) => {
    try {
        // Announcements have no school field — authorize via the teacher's own section
        const mySection = await ClassSection.findOne({ classTeacher: req.userId, school: req.schoolId }).lean();
        await ClassAnnouncement.findOneAndDelete({ _id: req.params.id, section: mySection?._id });
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
exports.assignMonitor = async (req, res) => {
    try {
        const mySection = await ClassSection.findOne({ classTeacher: req.userId, school: req.schoolId }).lean();
        const mon = await ClassMonitor.create({
            section: mySection?._id, assignedBy: req.userId, school: req.schoolId, ...req.body,
        });
        ok(res, mon, 201);
    } catch (e) { err(res, e); }
};
exports.removeMonitor = async (req, res) => {
    try {
        const mySection = await ClassSection.findOne({ classTeacher: req.userId, school: req.schoolId }).lean();
        await ClassMonitor.findOneAndDelete({ _id: req.params.id, section: mySection?._id });
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
// Attendance statuses are stored capitalized ('Present'|'Absent'|'Late') but the
// frontend works in lowercase — normalize at this boundary in both directions.
const CAP_STATUS = { present: 'Present', absent: 'Absent', late: 'Late' };
const capStatus  = (s) => CAP_STATUS[String(s || '').toLowerCase()] || 'Absent';

const teacherSection = (req) => ClassSection.findOne({
    school: req.schoolId,
    $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
}).lean();

exports.getAttendance = async (req, res) => {
    try {
        const { date } = req.query;
        const mySection = await teacherSection(req);
        // No section → no students. Guard against find({ currentSection: undefined })
        // which would match all rows and leak the whole school.
        if (!mySection) return ok(res, { students: [], records: [] });

        const students = await StudentProfile.find({ currentSection: mySection._id })
            .populate('user','name').lean();

        let records = [];
        if (date) {
            const attendanceDate = new Date(date + 'T00:00:00.000Z');
            const session = await Attendance.findOne({ section: mySection._id, date: attendanceDate }).lean();
            if (session) {
                const recs = await AttendanceRecord.find({ attendance: session._id }).lean();
                records = recs.map(r => ({ ...r, status: String(r.status || '').toLowerCase() }));
            }
        }
        ok(res, { students, records });
    } catch (e) { err(res, e); }
};

exports.markAttendance = async (req, res) => {
    try {
        const { date, records } = req.body;
        if (!date || !Array.isArray(records)) return err(res, 'date and records are required', 400);

        const mySection = await teacherSection(req);
        if (!mySection) return err(res, 'No section assigned to you', 403);

        // Normalize to UTC midnight so the unique (section,date) index behaves
        const attendanceDate = new Date(date + 'T00:00:00.000Z');
        const session = await Attendance.findOneAndUpdate(
            { section: mySection._id, date: attendanceDate },
            { $setOnInsert: { section: mySection._id, date: attendanceDate, createdBy: req.userId } },
            { upsert: true, new: true }
        );

        const saved = await Promise.all(records.map(r =>
            AttendanceRecord.findOneAndUpdate(
                { attendance: session._id, student: r.studentId },
                { $set: { status: capStatus(r.status) } },
                { upsert: true, new: true }
            )
        ));

        // Notify parents by email + in-app (non-blocking)
        setImmediate(async () => {
            try {
                const User = require('../models/User');
                const School = require('../models/School');
                const { sendAttendanceNotification } = require('../utils/sendEmail');
                const { notify } = require('../services/notifyService');
                const school = await School.findById(req.schoolId).select('name').lean();
                const dateLabel = new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
                // Batch-fetch every student profile + parent up front (one query
                // per collection instead of two per student in the loop below).
                const allProfiles = await StudentProfile.find({ user: { $in: records.map(x => x.studentId) } })
                    .populate('user', 'name').lean();
                const profileByStudent = new Map(allProfiles.map(p => [String(p.user?._id || p.user), p]));
                const parentIds = [...new Set(allProfiles.map(p => p.parent).filter(Boolean).map(String))];
                const parentUsers = parentIds.length
                    ? await User.find({ _id: { $in: parentIds } }).select('name email').lean()
                    : [];
                const parentById = new Map(parentUsers.map(u => [String(u._id), u]));
                for (const r of records) {
                    const status = capStatus(r.status);
                    const sp = profileByStudent.get(String(r.studentId));
                    // In-app: tell absent/late students (and their parents) right away
                    if (status !== 'Present') {
                        const targets = [r.studentId];
                        if (sp?.parent) targets.push(sp.parent);
                        notify({
                            school:     req.schoolId,
                            sender:     req.userId,
                            senderRole: req.userRole || 'teacher',
                            title:      `Attendance: ${sp?.user?.name || 'Student'} marked ${status}`,
                            body:       `${sp?.user?.name || 'The student'} was marked ${status.toLowerCase()} on ${dateLabel}.`,
                            recipients: targets,
                            // No id: the student's own calendar has no row keyed by a record
                            link:       { type: 'attendance.student' },
                        });
                    }
                    if (!sp?.parent) continue;
                    const parentUser = parentById.get(String(sp.parent));
                    if (!parentUser?.email) continue;
                    await sendAttendanceNotification({
                        to: parentUser.email,
                        parentName: parentUser.name,
                        studentName: sp.user?.name || '',
                        date: new Date(date),
                        status,
                        schoolName: school?.name || '',
                        schoolId: req.schoolId,
                    });
                }
            } catch (e) { console.error('Attendance notification error:', e.message); }
        });

        ok(res, saved);
    } catch (e) { err(res, e); }
};

// ── Teacher: all sections I'm attached to (class teacher / substitute / subject) ──
exports.getMySections = async (req, res) => {
    try {
        const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
        const [ownSections, subjectLinks] = await Promise.all([
            ClassSection.find({
                school: req.schoolId,
                $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
            }).populate('class', 'className').lean(),
            SectionSubjectTeacher.find({ teacher: req.userId })
                .populate({ path: 'section', populate: { path: 'class', select: 'className' } })
                .populate('subject', 'subjectName')
                .lean(),
        ]);

        const map = {};
        ownSections.forEach(sec => {
            map[sec._id.toString()] = {
                _id: sec._id,
                sectionName: sec.sectionName,
                className: sec.class?.className || '',
                studentCount: (sec.enrolledStudents || []).length,
                roles: [String(sec.classTeacher) === String(req.userId) ? 'Class Teacher' : 'Substitute Teacher'],
                subjects: [],
            };
        });
        subjectLinks.forEach(link => {
            const sec = link.section;
            if (!sec?._id) return;
            const id = sec._id.toString();
            if (!map[id]) {
                map[id] = {
                    _id: sec._id,
                    sectionName: sec.sectionName,
                    className: sec.class?.className || '',
                    studentCount: (sec.enrolledStudents || []).length,
                    roles: [],
                    subjects: [],
                };
            }
            if (link.subject?.subjectName && !map[id].subjects.includes(link.subject.subjectName)) {
                map[id].subjects.push(link.subject.subjectName);
            }
            if (!map[id].roles.includes('Subject Teacher')) map[id].roles.push('Subject Teacher');
        });

        ok(res, Object.values(map));
    } catch (e) { err(res, e); }
};

// ── Teacher: detail of one of my sections (with access check) ────────────────
exports.getTeacherSectionDetail = async (req, res) => {
    try {
        const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
        const section = await ClassSection.findOne({ _id: req.params.sectionId, school: req.schoolId })
            .populate('class', 'className')
            .populate('classTeacher', 'name email')
            .populate('substituteTeacher', 'name email')
            .populate('enrolledStudents', 'name email')
            .lean();
        if (!section) return err(res, 'Section not found', 404);

        const isOwn = [section.classTeacher?._id, section.substituteTeacher?._id]
            .some(id => String(id) === String(req.userId));
        const subjectLink = await SectionSubjectTeacher.findOne({ section: section._id, teacher: req.userId }).lean();
        if (!isOwn && !subjectLink) return err(res, 'You are not assigned to this section', 403);

        // Roll numbers for the roster
        const enrolled = section.enrolledStudents || [];
        if (enrolled.length) {
            const profiles = await StudentProfile.find(
                { user: { $in: enrolled.map(s => s._id) } }, 'user rollNumber gender'
            ).lean();
            const pMap = {};
            profiles.forEach(p => { pMap[p.user.toString()] = p; });
            section.enrolledStudents = enrolled.map(s => ({
                ...s,
                rollNumber: pMap[s._id.toString()]?.rollNumber || '',
                gender:     pMap[s._id.toString()]?.gender || '',
            }));
        }

        const subjectTeachers = await SectionSubjectTeacher.find({ section: section._id })
            .populate('subject', 'subjectName').populate('teacher', 'name').lean();
        const announcements = await ClassAnnouncement.find({ section: section._id })
            .sort({ createdAt: -1 }).limit(10).lean();

        ok(res, { section, subjectTeachers, announcements });
    } catch (e) { err(res, e); }
};
