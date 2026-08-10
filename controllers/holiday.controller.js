'use strict';
const Holiday      = require('../models/Holiday');
const AcademicYear = require('../models/AcademicYear');
const XLSX         = require('xlsx');

const VALID_TYPES = ['public', 'school_specific', 'optional', 'exam_break'];

// ── In-app notification after holiday creation ────────────────────────────────
async function sendHolidayNotification(holiday, schoolId, creatorId) {
    try {
        const Notification        = require('../models/Notification');
        const NotificationReceipt = require('../models/NotificationReceipt');
        const User                = require('../models/User');

        const scope = holiday.applicability?.scope || 'all';
        let recipients = [];

        if (scope === 'all') {
            recipients = await User.find(
                { school: schoolId, role: { $in: ['teacher', 'student', 'parent'] }, isActive: true },
                '_id'
            ).lean();
        } else if (scope === 'specific_classes') {
            const classIds = (holiday.applicability?.classes || []).map(c => c._id || c);
            if (!classIds.length) return;
            const ClassSection   = require('../models/ClassSection');
            const StudentProfile = require('../models/StudentProfile');
            const secs       = await ClassSection.find({ class: { $in: classIds }, school: schoolId }, 'enrolledStudents').lean();
            const studentIds = [...new Set(secs.flatMap(s => s.enrolledStudents.map(id => id.toString())))];
            const profiles   = await StudentProfile.find({ user: { $in: studentIds }, parent: { $ne: null } }, 'parent').lean();
            const parentIds  = [...new Set(profiles.map(p => p.parent.toString()))];
            const allIds     = [...new Set([...studentIds, ...parentIds])];
            if (!allIds.length) return;
            recipients = await User.find({ _id: { $in: allIds }, isActive: true }, '_id').lean();
        } else if (scope === 'specific_departments') {
            const depts = holiday.applicability?.departments || [];
            const roles = [];
            if (depts.includes('teaching_staff')) roles.push('teacher');
            if (depts.includes('admin_staff'))    roles.push('school_admin');
            if (!roles.length) return;
            recipients = await User.find({ school: schoolId, role: { $in: roles }, isActive: true }, '_id').lean();
        }

        if (!recipients.length) return;

        const fmt  = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        const sStr = fmt(holiday.startDate);
        const eStr = fmt(holiday.endDate || holiday.startDate);
        const dateStr   = sStr === eStr ? sStr : `${sStr} – ${eStr}`;
        const typeLabel = holiday.type.replace(/_/g, ' ');

        const { notify } = require('../services/notifyService');
        notify({
            school:     schoolId,
            sender:     creatorId,
            senderRole: 'school_admin',
            title:      `🎉 Holiday: ${holiday.name}`,
            body:       `A ${typeLabel} holiday "${holiday.name}" has been scheduled on ${dateStr}.${holiday.description ? ' ' + holiday.description : ''}`,
            recipients,
            includeSender: true,
        });
    } catch (e) {
        console.error('[holiday-notif]', e.message);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseDate(val) {
    if (!val) return null;
    if (val instanceof Date) return isNaN(val) ? null : val;
    const d = new Date(val);
    return isNaN(d) ? null : d;
}

// ── Admin: list ───────────────────────────────────────────────────────────────
exports.adminGetHolidays = async (req, res) => {
    try {
        const { type, academicYear } = req.query;
        const filter = { school: req.schoolId };
        if (type)         filter.type         = type;
        if (academicYear) filter.academicYear = academicYear;

        const holidays = await Holiday.find(filter)
            .populate('createdBy', 'name')
            .populate('academicYear', 'yearName year label')
            .sort({ startDate: 1 })
            .lean();
        res.json({ success: true, data: holidays });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: create ─────────────────────────────────────────────────────────────
exports.adminCreateHoliday = async (req, res) => {
    try {
        const { name, startDate, endDate, type, description, isRecurring, academicYear, applicability } = req.body;

        if (!name?.trim())               return res.status(400).json({ success: false, message: 'Holiday name is required' });
        if (!startDate)                  return res.status(400).json({ success: false, message: 'Start date is required' });
        if (!endDate)                    return res.status(400).json({ success: false, message: 'End date is required' });
        if (!VALID_TYPES.includes(type)) return res.status(400).json({ success: false, message: `Type must be one of: ${VALID_TYPES.join(', ')}` });

        const start = new Date(startDate);
        const end   = new Date(endDate);
        if (end < start) return res.status(400).json({ success: false, message: 'End date must be on or after start date' });

        const holiday = await Holiday.create({
            school:       req.schoolId,
            name:         name.trim(),
            startDate:    start,
            endDate:      end,
            type,
            description:  description?.trim() || '',
            isRecurring:  !!isRecurring,
            academicYear: academicYear || null,
            createdBy:    req.userId,
            applicability: {
                scope:       applicability?.scope || 'all',
                classes:     applicability?.classes || [],
                departments: applicability?.departments || [],
            },
        });

        // Fire-and-forget in-app notifications
        sendHolidayNotification(holiday, req.schoolId, req.userId);

        res.status(201).json({ success: true, data: holiday });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: update ─────────────────────────────────────────────────────────────
exports.adminUpdateHoliday = async (req, res) => {
    try {
        const { name, startDate, endDate, type, description, isRecurring, academicYear, applicability } = req.body;
        const update = { updatedBy: req.userId };

        if (name         !== undefined) update.name         = name.trim();
        if (startDate    !== undefined) update.startDate    = new Date(startDate);
        if (endDate      !== undefined) update.endDate      = new Date(endDate);
        if (description  !== undefined) update.description  = description.trim();
        if (isRecurring  !== undefined) update.isRecurring  = !!isRecurring;
        if (academicYear !== undefined) update.academicYear = academicYear || null;
        if (applicability !== undefined) {
            update.applicability = {
                scope:       applicability.scope || 'all',
                classes:     applicability.classes || [],
                departments: applicability.departments || [],
            };
        }
        if (type !== undefined) {
            if (!VALID_TYPES.includes(type))
                return res.status(400).json({ success: false, message: `Type must be one of: ${VALID_TYPES.join(', ')}` });
            update.type = type;
        }

        const holiday = await Holiday.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            update,
            { new: true }
        ).lean();
        if (!holiday) return res.status(404).json({ success: false, message: 'Holiday not found' });
        res.json({ success: true, data: holiday });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: delete ─────────────────────────────────────────────────────────────
exports.adminDeleteHoliday = async (req, res) => {
    try {
        const holiday = await Holiday.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!holiday) return res.status(404).json({ success: false, message: 'Holiday not found' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: import XLSX/CSV ────────────────────────────────────────────────────
exports.adminImportHolidays = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

        if (!rows.length) return res.status(400).json({ success: false, message: 'File is empty' });

        const docs   = [];
        const errors = [];

        rows.forEach((row, i) => {
            const lineNo      = i + 2;
            const name        = (row.name || row.Name || '').toString().trim();
            const rawStart    = row.startDate || row.start_date || row.StartDate || row.date || row.Date;
            const rawEnd      = row.endDate   || row.end_date   || row.EndDate   || rawStart;
            const rawType     = (row.type || row.Type || 'public').toString().toLowerCase().trim();
            const description = (row.description || row.Description || '').toString().trim();

            if (!name)       { errors.push(`Row ${lineNo}: name is required`); return; }
            const startDate = parseDate(rawStart);
            if (!startDate) { errors.push(`Row ${lineNo}: invalid or missing startDate`); return; }
            const endDate = parseDate(rawEnd) || startDate;
            const type    = VALID_TYPES.includes(rawType) ? rawType : 'public';

            docs.push({ school: req.schoolId, name, startDate, endDate, type, description, createdBy: req.userId });
        });

        if (!docs.length)
            return res.status(400).json({ success: false, message: 'No valid rows to import', errors });

        await Holiday.insertMany(docs, { ordered: false });
        res.json({ success: true, imported: docs.length, errors: errors.length ? errors : undefined });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: export XLSX ────────────────────────────────────────────────────────
exports.adminExportHolidays = async (req, res) => {
    try {
        const holidays = await Holiday.find({ school: req.schoolId }).sort({ startDate: 1 }).lean();
        const rows = holidays.map(h => ({
            name:        h.name,
            startDate:   h.startDate?.toISOString().slice(0, 10) || '',
            endDate:     h.endDate?.toISOString().slice(0, 10)   || '',
            type:        h.type,
            description: h.description || '',
        }));
        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Holidays');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="holidays.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: download import template ──────────────────────────────────────────
exports.adminGetImportTemplate = async (req, res) => {
    try {
        const sample = [
            { name: 'Diwali',     startDate: '2024-11-01', endDate: '2024-11-03', type: 'public',          description: 'Festival of lights' },
            { name: 'Annual Day', startDate: '2024-12-15', endDate: '2024-12-15', type: 'school_specific', description: 'Annual school celebration' },
            { name: 'Exam Break', startDate: '2024-10-20', endDate: '2024-10-22', type: 'exam_break',      description: 'Mid-term exam break' },
        ];
        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(sample);
        XLSX.utils.book_append_sheet(wb, ws, 'Template');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="holiday_import_template.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: audit log ──────────────────────────────────────────────────────────
exports.adminGetAuditLog = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const [holidays, total] = await Promise.all([
            Holiday.find({ school: req.schoolId })
                .populate('createdBy', 'name email')
                .populate('updatedBy', 'name email')
                .sort({ createdAt: -1 })
                .skip((page - 1) * +limit)
                .limit(+limit)
                .lean(),
            Holiday.countDocuments({ school: req.schoolId }),
        ]);
        res.json({ success: true, data: holidays, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Read-only view for teacher / student / parent ─────────────────────────────
// Filters by applicability so each role only sees relevant holidays.
async function getApplicableHolidays(req, res) {
    try {
        const ClassSection   = require('../models/ClassSection');
        const StudentProfile = require('../models/StudentProfile');

        const filter = { school: req.schoolId };
        const activeYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        if (activeYear) filter.academicYear = { $in: [activeYear._id, null] };

        const allHolidays = await Holiday.find(filter).sort({ startDate: 1 }).lean();

        const role = req.userRole;

        // Collect ALL class IDs the student/parent is associated with.
        // Uses both enrolledStudents (maintained by section assignment) and
        // currentSection FK so we handle every possible data state.
        const userClassIds = new Set();

        const collectClassIds = async (userId) => {
            const profile = await StudentProfile.findOne({ user: userId }, 'currentSection').lean();
            const orConds = [{ enrolledStudents: userId }];
            if (profile?.currentSection) orConds.push({ _id: profile.currentSection });
            const sects = await ClassSection.find({ $or: orConds }, 'class').lean();
            sects.forEach(s => { if (s.class) userClassIds.add(s.class.toString()); });
        };

        if (role === 'student') {
            await collectClassIds(req.userId);
        } else if (role === 'parent') {
            const profile = await StudentProfile.findOne({ parent: req.userId }, 'user').lean();
            if (profile?.user) await collectClassIds(profile.user);
        }
        // Teachers never see class-specific holidays — those are student/parent only

        const visible = allHolidays.filter(h => {
            const scope = h.applicability?.scope || 'all';

            if (scope === 'all') return true;

            if (scope === 'specific_departments') {
                const depts = h.applicability?.departments || [];
                if (role === 'teacher'      && depts.includes('teaching_staff')) return true;
                if (role === 'school_admin' && depts.includes('admin_staff'))    return true;
                return false;
            }

            if (scope === 'specific_classes') {
                if (userClassIds.size === 0) return false;
                const classIds = (h.applicability?.classes || []).map(c => c.toString());
                return classIds.some(id => userClassIds.has(id));
            }

            return true;
        });

        res.json({ success: true, data: visible });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
}

exports.adminGetMyHolidays = getApplicableHolidays;
exports.teacherGetHolidays = getApplicableHolidays;
exports.studentGetHolidays = getApplicableHolidays;
exports.parentGetHolidays  = getApplicableHolidays;

// ── Teacher: class-specific holidays for their assigned classes ───────────────
// Separate endpoint — shows class-specific holidays for classes the teacher is
// associated with (class teacher, substitute teacher, or subject teacher).
exports.teacherGetClassHolidays = async (req, res) => {
    try {
        const ClassSection          = require('../models/ClassSection');
        const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');

        const filter = { school: req.schoolId };
        const activeYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        if (activeYear) filter.academicYear = { $in: [activeYear._id, null] };

        const teacherClassIds = new Set();

        // 1. Class teacher or vice class teacher (substituteTeacher) of a section
        const directSections = await ClassSection.find(
            { $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }] },
            'class'
        ).lean();
        directSections.forEach(s => { if (s.class) teacherClassIds.add(s.class.toString()); });

        // 2. Subject teacher assigned to a section
        const subjectAssignments = await SectionSubjectTeacher.find(
            { teacher: req.userId },
            'section'
        ).lean();
        if (subjectAssignments.length) {
            const secIds = subjectAssignments.map(a => a.section);
            const subjectSections = await ClassSection.find({ _id: { $in: secIds } }, 'class').lean();
            subjectSections.forEach(s => { if (s.class) teacherClassIds.add(s.class.toString()); });
        }

        if (teacherClassIds.size === 0) {
            return res.json({ success: true, data: [] });
        }

        const classHolidays = await Holiday.find({
            ...filter,
            'applicability.scope': 'specific_classes',
            'applicability.classes': { $in: [...teacherClassIds] },
        })
            .populate('applicability.classes', 'className')
            .sort({ startDate: 1 })
            .lean();

        res.json({ success: true, data: classHolidays });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Super admin: cross-school audit ──────────────────────────────────────────
exports.superAdminAuditLog = async (req, res) => {
    try {
        const { schoolId, page = 1, limit = 30 } = req.query;
        const filter = schoolId ? { school: schoolId } : {};
        const [holidays, total] = await Promise.all([
            Holiday.find(filter)
                .populate('school',    'name')
                .populate('createdBy', 'name email')
                .sort({ createdAt: -1 })
                .skip((page - 1) * +limit)
                .limit(+limit)
                .lean(),
            Holiday.countDocuments(filter),
        ]);
        res.json({ success: true, data: holidays, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.superAdminExportAuditCSV = async (req, res) => {
    try {
        const { schoolId } = req.query;
        const filter = schoolId ? { school: schoolId } : {};
        const holidays = await Holiday.find(filter)
            .populate('school',    'name')
            .populate('createdBy', 'name')
            .sort({ createdAt: -1 })
            .lean();
        const rows = holidays.map(h => ({
            school:      h.school?.name    || '',
            name:        h.name,
            startDate:   h.startDate?.toISOString().slice(0, 10) || '',
            endDate:     h.endDate?.toISOString().slice(0, 10)   || '',
            type:        h.type,
            description: h.description || '',
            createdBy:   h.createdBy?.name  || '',
            createdAt:   h.createdAt?.toISOString()              || '',
        }));
        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Holidays');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="holidays_audit.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
