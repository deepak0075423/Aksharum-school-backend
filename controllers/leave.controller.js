'use strict';
const LeaveType        = require('../models/LeaveType');
const LeaveApplication = require('../models/LeaveApplication');
const LeaveBalance     = require('../models/LeaveBalance');
const Holiday          = require('../models/Holiday');
const School           = require('../models/School');
const User             = require('../models/User');
const AcademicYear     = require('../models/AcademicYear');
const XLSX             = require('xlsx');
const path             = require('path');
const { notify, schoolAdminIds } = require('../services/notifyService');

const fmtDate = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getActiveAcademicYearLabel(schoolId) {
    const ay = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
    if (!ay) return null;
    if (ay.yearName) return ay.yearName;
    const y = new Date(ay.startDate || ay.createdAt).getFullYear();
    return `${y}-${String(y + 1).slice(-2)}`;
}

// Returns true if the given date (a Saturday) is a working day per leaveSettings
function isSaturdayWorking(date, leaveSettings = {}) {
    const { saturdayWorking = true, saturdayMode = 'all' } = leaveSettings;
    if (!saturdayWorking) return false;
    if (saturdayMode === 'all') return true;
    const nth = Math.ceil(date.getUTCDate() / 7);
    if (saturdayMode === '1_3_5') return nth % 2 === 1;
    if (saturdayMode === '2_4')   return nth % 2 === 0;
    return true;
}

function countWorkingDays(from, to, leaveSettings = {}) {
    const { saturdayHalfDay = false } = leaveSettings;
    let days = 0;
    const cur = new Date(from);
    cur.setUTCHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setUTCHours(0, 0, 0, 0);
    while (cur <= end) {
        const dow = cur.getUTCDay();
        if (dow === 6) {
            if (isSaturdayWorking(cur, leaveSettings)) days += saturdayHalfDay ? 0.5 : 1;
        } else if (dow !== 0) {
            days += 1;
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
}

// Returns the number of working days within [from, to] that are school holidays
// (applicable to 'all' or 'teaching_staff'). Uses a Set to avoid double-counting.
async function countHolidayWorkingDays(from, to, schoolId, leaveSettings) {
    const holidays = await Holiday.find({
        school: schoolId,
        startDate: { $lte: to },
        endDate:   { $gte: from },
        $or: [
            { 'applicability.scope': 'all' },
            { 'applicability.departments': 'teaching_staff' },
        ],
    }).lean();

    const holidaySet = new Set();
    for (const h of holidays) {
        const hStart = new Date(h.startDate); hStart.setUTCHours(0, 0, 0, 0);
        const hEnd   = new Date(h.endDate);   hEnd.setUTCHours(0, 0, 0, 0);
        const rangeStart = hStart < from ? from : hStart;
        const rangeEnd   = hEnd   > to   ? to   : hEnd;
        const cur = new Date(rangeStart);
        while (cur <= rangeEnd) {
            const dow = cur.getUTCDay();
            if (dow === 6) {
                if (isSaturdayWorking(cur, leaveSettings)) holidaySet.add(cur.toISOString().slice(0, 10));
            } else if (dow !== 0) {
                holidaySet.add(cur.toISOString().slice(0, 10));
            }
            cur.setUTCDate(cur.getUTCDate() + 1);
        }
    }
    return holidaySet.size;
}

// Returns an existing pending/approved/modification_requested leave that overlaps [from, to]
// Always returns a complete leaveSettings object — fills in schema defaults for
// any field absent from older rows (lean() reads return raw columns without defaults).
function normalizeLeaveSettings(ls = {}) {
    return {
        saturdayWorking: ls.saturdayWorking !== false,           // default true
        saturdayMode:    ls.saturdayMode    || 'all',            // default 'all'
        saturdayHalfDay: !!ls.saturdayHalfDay,                  // default false
    };
}

async function getOverlappingLeave(teacherId, schoolId, from, to, excludeId = null) {
    const query = {
        teacher: teacherId,
        school:  schoolId,
        status:  { $in: ['pending', 'approved', 'modification_requested'] },
        fromDate: { $lte: to },
        toDate:   { $gte: from },
    };
    if (excludeId) query._id = { $ne: excludeId };
    return LeaveApplication.findOne(query).lean();
}

async function ensureBalance(teacherId, schoolId, leaveTypeId, academicYear) {
    const lt = await LeaveType.findById(leaveTypeId).lean();
    return LeaveBalance.findOneAndUpdate(
        { teacher: teacherId, school: schoolId, leaveType: leaveTypeId, academicYear },
        { $setOnInsert: { totalAllocated: lt?.annualAllocation || 0, carriedForward: 0, used: 0, pending: 0 } },
        { upsert: true, new: true }
    );
}

// ── Admin: Leave Types ────────────────────────────────────────────────────────

exports.adminGetLeaveTypes = async (req, res) => {
    try {
        const types = await LeaveType.find({ school: req.schoolId }).sort({ name: 1 }).lean();
        res.json({ success: true, data: types });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminCreateLeaveType = async (req, res) => {
    try {
        const { name, code, annualAllocation, monthlyAccrual, carryForward, encashable,
                maxEncashableDays, maxConsecutiveDays, requiresDocument, documentRequiredAfterDays, isActive } = req.body;
        if (!name?.trim()) return res.status(400).json({ success: false, message: 'Name is required' });
        if (!code?.trim()) return res.status(400).json({ success: false, message: 'Code is required' });

        const normalizedCode = code.trim().toUpperCase();
        const payload = {
            name:                       name.trim(),
            annualAllocation:           Number(annualAllocation) || 0,
            monthlyAccrual:             monthlyAccrual  || { enabled: false, daysPerMonth: 0 },
            carryForward:               carryForward    || { enabled: false, maxDays: 0 },
            encashable:                 !!encashable,
            maxEncashableDays:          Number(maxEncashableDays) || 0,
            maxConsecutiveDays:         Number(maxConsecutiveDays) || 0,
            requiresDocument:           !!requiresDocument,
            documentRequiredAfterDays:  Number(documentRequiredAfterDays) || 0,
            isActive:                   isActive !== false,
        };

        // Upsert: create new or update existing type with the same code
        const lt = await LeaveType.findOneAndUpdate(
            { school: req.schoolId, code: normalizedCode },
            { $set: payload, $setOnInsert: { school: req.schoolId, code: normalizedCode, createdBy: req.userId } },
            { upsert: true, new: true }
        );
        res.status(201).json({ success: true, data: lt });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.adminUpdateLeaveType = async (req, res) => {
    try {
        const { name, code, annualAllocation, monthlyAccrual, carryForward, encashable,
                maxEncashableDays, maxConsecutiveDays, requiresDocument, documentRequiredAfterDays, isActive } = req.body;
        const update = {};
        if (name                     !== undefined) update.name                     = name.trim();
        if (code                     !== undefined) update.code                     = code.trim().toUpperCase();
        if (annualAllocation         !== undefined) update.annualAllocation         = Number(annualAllocation);
        if (monthlyAccrual           !== undefined) update.monthlyAccrual           = monthlyAccrual;
        if (carryForward             !== undefined) update.carryForward             = carryForward;
        if (encashable               !== undefined) update.encashable               = !!encashable;
        if (maxEncashableDays        !== undefined) update.maxEncashableDays        = Number(maxEncashableDays) || 0;
        if (maxConsecutiveDays       !== undefined) update.maxConsecutiveDays       = Number(maxConsecutiveDays);
        if (requiresDocument         !== undefined) update.requiresDocument         = !!requiresDocument;
        if (documentRequiredAfterDays!== undefined) update.documentRequiredAfterDays= Number(documentRequiredAfterDays);
        if (isActive                 !== undefined) update.isActive                 = !!isActive;

        const lt = await LeaveType.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            update,
            { new: true, runValidators: true }
        ).lean();
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });
        res.json({ success: true, data: lt });
    } catch (e) {
        if (e.code === 11000) return res.status(400).json({ success: false, message: 'Leave type code already exists' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.adminDeleteLeaveType = async (req, res) => {
    try {
        const inUse = await LeaveApplication.exists({ leaveType: req.params.id, school: req.schoolId });
        if (inUse) return res.status(400).json({ success: false, message: 'Cannot delete — leave type is in use' });
        const lt = await LeaveType.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Admin: Leave Settings ─────────────────────────────────────────────────────

exports.adminUpdateLeaveSettings = async (req, res) => {
    try {
        const { saturdayWorking, saturdayMode, saturdayHalfDay } = req.body;
        const update = {};
        if (saturdayWorking !== undefined) update['leaveSettings.saturdayWorking'] = !!saturdayWorking;
        if (saturdayMode    !== undefined) update['leaveSettings.saturdayMode']    = saturdayMode;
        if (saturdayHalfDay !== undefined) update['leaveSettings.saturdayHalfDay'] = !!saturdayHalfDay;
        const school = await School.findByIdAndUpdate(
            req.schoolId, update, { new: true, select: 'leaveSettings' }
        ).lean();
        res.json({ success: true, data: normalizeLeaveSettings(school.leaveSettings) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Admin: Leave Requests ─────────────────────────────────────────────────────

exports.adminGetRequests = async (req, res) => {
    try {
        const { status, teacherId, leaveType, fromDate, toDate, page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        if (status)    filter.status    = status;
        if (teacherId) filter.teacher   = teacherId;
        if (leaveType) filter.leaveType = leaveType;
        if (fromDate || toDate) {
            filter.fromDate = {};
            if (fromDate) filter.fromDate.$gte = new Date(fromDate);
            if (toDate)   filter.fromDate.$lte = new Date(toDate);
        }
        const [apps, total] = await Promise.all([
            LeaveApplication.find(filter)
                .populate('teacher',  'name email employeeId')
                .populate('leaveType','name code')
                .populate('approvedBy','name')
                .sort({ appliedAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            LeaveApplication.countDocuments(filter),
        ]);
        res.json({ success: true, data: apps, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminApplyLeave = async (req, res) => {
    try {
        const { teacherId, leaveTypeId, fromDate, toDate, leaveMode, reason } = req.body;
        if (!teacherId || !leaveTypeId || !fromDate || !toDate || !reason)
            return res.status(400).json({ success: false, message: 'teacherId, leaveTypeId, fromDate, toDate and reason are required' });

        const from = new Date(fromDate);
        const to   = new Date(toDate);
        from.setUTCHours(0, 0, 0, 0);
        to.setUTCHours(0, 0, 0, 0);

        if (isNaN(from.getTime()) || isNaN(to.getTime()))
            return res.status(400).json({ success: false, message: 'Invalid date format' });
        if (to < from)
            return res.status(400).json({ success: false, message: 'toDate must be on or after fromDate' });

        const school       = await School.findById(req.schoolId).select('leaveSettings modules').lean();
        const leaveSettings = normalizeLeaveSettings(school?.leaveSettings);

        let totalDays;
        if (leaveMode === 'half_day') {
            if (from.getTime() !== to.getTime())
                return res.status(400).json({ success: false, message: 'Half-day leave must have the same fromDate and toDate' });
            const dow = from.getUTCDay();
            if (dow === 0)
                return res.status(400).json({ success: false, message: 'Cannot apply half-day leave on a Sunday' });
            if (dow === 6 && !isSaturdayWorking(from, leaveSettings))
                return res.status(400).json({ success: false, message: 'Cannot apply half-day leave on a non-working Saturday' });
            if (school?.modules?.holiday) {
                const hDays = await countHolidayWorkingDays(from, from, req.schoolId, leaveSettings);
                if (hDays > 0)
                    return res.status(400).json({ success: false, message: 'Cannot apply leave on a holiday' });
            }
            totalDays = 0.5;
        } else {
            totalDays = countWorkingDays(from, to, leaveSettings);
            if (school?.modules?.holiday) {
                const hDays = await countHolidayWorkingDays(from, to, req.schoolId, leaveSettings);
                totalDays -= hDays;
            }
            if (totalDays <= 0)
                return res.status(400).json({ success: false, message: 'No working days in the selected date range (all are weekends or holidays)' });
        }

        const overlap = await getOverlappingLeave(teacherId, req.schoolId, from, to);
        if (overlap)
            return res.status(400).json({ success: false, message: 'Teacher already has a leave application (pending or approved) that overlaps with the selected dates' });

        const ay = await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const bal = await ensureBalance(teacherId, req.schoolId, leaveTypeId, ay);
        const remaining = Math.max(0, bal.totalAllocated + bal.carriedForward - bal.used - bal.pending);
        if (totalDays > remaining)
            return res.status(400).json({ success: false, message: `Insufficient balance. Available: ${remaining}` });

        const documentPath = req.file ? req.file.filename : null;

        const app = await LeaveApplication.create({
            teacher: teacherId, school: req.schoolId, leaveType: leaveTypeId,
            fromDate: from, toDate: to, totalDays,
            leaveMode: leaveMode || 'full_day', reason, document: documentPath, appliedAt: new Date(),
        });
        await LeaveBalance.updateOne(
            { teacher: teacherId, school: req.schoolId, leaveType: leaveTypeId, academicYear: ay },
            { $inc: { pending: totalDays } }
        );
        res.status(201).json({ success: true, data: app });
    } catch (e) {
        if (e.code === 11000) return res.status(400).json({ success: false, message: 'Teacher already has a leave application for these dates' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.adminGetTeacherBalance = async (req, res) => {
    try {
        const { teacherId } = req.query;
        if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });
        const ay = await getActiveAcademicYearLabel(req.schoolId);
        const balances = await LeaveBalance.find({ teacher: teacherId, school: req.schoolId, academicYear: ay })
            .populate('leaveType', 'name code')
            .lean();
        const data = balances.map(b => ({
            ...b,
            remaining: Math.max(0, b.totalAllocated + b.carriedForward - b.used - b.pending),
        }));
        res.json({ success: true, data, academicYear: ay });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminApproveRequest = async (req, res) => {
    try {
        const app = await LeaveApplication.findOne({ _id: req.params.id, school: req.schoolId });
        if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });
        if (app.status !== 'pending')
            return res.status(400).json({ success: false, message: 'Only pending requests can be approved' });

        app.status     = 'approved';
        app.approvedBy = req.userId;
        app.approvedAt = new Date();
        app.adminComment = req.body.adminComment || '';
        await app.save();

        const ay = await getActiveAcademicYearLabel(req.schoolId);
        await LeaveBalance.updateOne(
            { teacher: app.teacher, school: req.schoolId, leaveType: app.leaveType, academicYear: ay },
            { $inc: { used: app.totalDays, pending: -app.totalDays } }
        );
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '✅ Leave request approved',
            body: `Your leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} (${app.totalDays} day${app.totalDays === 1 ? '' : 's'}) has been approved.${app.adminComment ? `\nComment: ${app.adminComment}` : ''}`,
            recipients: [app.teacher],
            email: true,
        });
        res.json({ success: true, data: app });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminRejectRequest = async (req, res) => {
    try {
        const { adminComment } = req.body;
        const app = await LeaveApplication.findOne({ _id: req.params.id, school: req.schoolId });
        if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });
        if (!['pending', 'modification_requested'].includes(app.status))
            return res.status(400).json({ success: false, message: 'Cannot reject in current status' });

        const oldStatus = app.status;
        app.status      = 'rejected';
        app.rejectedAt  = new Date();
        app.adminComment = adminComment || '';
        await app.save();

        // If it was pending or modification_requested, the pending count was set on apply — decrement it
        if (['pending', 'modification_requested'].includes(oldStatus)) {
            const ay = await getActiveAcademicYearLabel(req.schoolId);
            await LeaveBalance.updateOne(
                { teacher: app.teacher, school: req.schoolId, leaveType: app.leaveType, academicYear: ay },
                { $inc: { pending: -app.totalDays } }
            );
        }
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '❌ Leave request rejected',
            body: `Your leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} has been rejected.${app.adminComment ? `\nReason: ${app.adminComment}` : ''}`,
            recipients: [app.teacher],
            email: true,
        });
        res.json({ success: true, data: app });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminRequestModification = async (req, res) => {
    try {
        const { adminComment } = req.body;
        const app = await LeaveApplication.findOne({ _id: req.params.id, school: req.schoolId });
        if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });
        if (app.status !== 'pending')
            return res.status(400).json({ success: false, message: 'Only pending requests can be sent back for modification' });

        app.status = 'modification_requested';
        app.modificationRequestedAt = new Date();
        app.adminComment = adminComment || '';
        await app.save();
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '✏️ Leave request needs changes',
            body: `Your leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} needs modification.${app.adminComment ? `\nComment: ${app.adminComment}` : ''}`,
            recipients: [app.teacher],
        });
        res.json({ success: true, data: app });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Admin: Allocations ────────────────────────────────────────────────────────

exports.adminGetAllocations = async (req, res) => {
    try {
        const { academicYear } = req.query;
        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const [balances, leaveTypes] = await Promise.all([
            LeaveBalance.find({ school: req.schoolId, academicYear: ay })
                .populate('teacher',   'name email employeeId')
                .populate('leaveType', 'name code annualAllocation')
                .lean(),
            LeaveType.find({ school: req.schoolId, isActive: true }).lean(),
        ]);
        res.json({ success: true, data: balances, leaveTypes, academicYear: ay });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminAllocate = async (req, res) => {
    try {
        const { teacherIds, excludeIds = [], leaveTypeId, giveFullAllocation, useProration, overrideDays, academicYear } = req.body;
        if (!leaveTypeId) return res.status(400).json({ success: false, message: 'leaveTypeId is required' });
        if (!teacherIds)  return res.status(400).json({ success: false, message: 'teacherIds is required' });

        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const lt = await LeaveType.findOne({ _id: leaveTypeId, school: req.schoolId }).lean();
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });

        // Resolve teacher list
        const isAll = teacherIds === 'all' || (Array.isArray(teacherIds) && teacherIds[0] === 'all');
        let teachers;
        if (isAll) {
            const excludeFilter = excludeIds.length ? { _id: { $nin: excludeIds } } : {};
            teachers = await User.find({ school: req.schoolId, role: 'teacher', isActive: true, ...excludeFilter })
                .select('_id').lean();
        } else {
            const ids = Array.isArray(teacherIds) ? teacherIds : [teacherIds];
            teachers = ids.map(id => ({ _id: id }));
        }
        if (!teachers.length) return res.json({ success: true, allocated: 0, message: 'No teachers matched' });

        // Compute totalAllocated
        let totalAllocated;
        if (overrideDays !== undefined && overrideDays !== null && overrideDays !== '') {
            totalAllocated = Number(overrideDays);
        } else if (lt.monthlyAccrual?.enabled && !giveFullAllocation) {
            // Monthly accrual: start at 0, cron will credit each month
            totalAllocated = 0;
        } else if (useProration && !lt.monthlyAccrual?.enabled) {
            const activeAY = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
            if (activeAY?.startDate && activeAY?.endDate) {
                const now = new Date();
                const end = new Date(activeAY.endDate);
                const remainMs = Math.max(0, end - now);
                const totalMs  = Math.max(1, end - new Date(activeAY.startDate));
                totalAllocated = Math.max(1, Math.ceil(lt.annualAllocation * remainMs / totalMs));
            } else {
                totalAllocated = lt.annualAllocation;
            }
        } else {
            totalAllocated = lt.annualAllocation;
        }

        const ops = teachers.map(t => ({
            updateOne: {
                filter: { teacher: t._id, school: req.schoolId, leaveType: leaveTypeId, academicYear: ay },
                update: { $set: { totalAllocated } },
                upsert: true,
            },
        }));
        await LeaveBalance.bulkWrite(ops);
        res.json({ success: true, allocated: teachers.length, message: `Allocated ${totalAllocated} day(s) to ${teachers.length} teacher(s)` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Monthly Accrual ───────────────────────────────────────────────────────────

async function runMonthlyAccrualForSchool(schoolId) {
    const leaveTypes = await LeaveType.find({ school: schoolId, 'monthlyAccrual.enabled': true, isActive: true }).lean();
    if (!leaveTypes.length) return 0;

    const now       = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let credited = 0;
    for (const lt of leaveTypes) {
        const balances = await LeaveBalance.find({
            school:    schoolId,
            leaveType: lt._id,
            $or: [{ lastAccrualAt: null }, { lastAccrualAt: { $exists: false } }, { lastAccrualAt: { $lt: monthStart } }],
        }).lean();

        const ops = balances
            .filter(b => b.totalAllocated < lt.annualAllocation)
            .map(b => ({
                updateOne: {
                    filter: { _id: b._id },
                    update: { $set: {
                        totalAllocated: Math.min(b.totalAllocated + (lt.monthlyAccrual.daysPerMonth || 0), lt.annualAllocation),
                        lastAccrualAt:  now,
                    }},
                },
            }));

        if (ops.length) { await LeaveBalance.bulkWrite(ops); credited += ops.length; }
    }
    return credited;
}
exports.runMonthlyAccrualForSchool = runMonthlyAccrualForSchool;

exports.adminRunMonthlyAccrual = async (req, res) => {
    try {
        const credited = await runMonthlyAccrualForSchool(req.schoolId);
        res.json({ success: true, credited, message: `Accrual complete — ${credited} balance(s) updated` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminGetAllocationTemplate = async (req, res) => {
    try {
        const teachers = await User.find({ school: req.schoolId, role: 'teacher', isActive: true })
            .select('name email employeeId').lean();
        const leaveTypes = await LeaveType.find({ school: req.schoolId, isActive: true }).lean();
        const rows = [];
        teachers.forEach(t => {
            leaveTypes.forEach(lt => {
                rows.push({
                    teacherEmployeeId: t.employeeId || '',
                    teacherName:       t.name,
                    teacherEmail:      t.email,
                    leaveTypeCode:     lt.code,
                    leaveTypeName:     lt.name,
                    totalAllocated:    lt.annualAllocation,
                });
            });
        });
        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Allocations');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="leave_allocation_template.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminBulkAllocateExcel = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        if (!rows.length) return res.status(400).json({ success: false, message: 'File is empty' });

        const ay = req.body.academicYear || await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const [teachers, leaveTypes] = await Promise.all([
            User.find({ school: req.schoolId, role: 'teacher', isActive: true }).select('name email employeeId').lean(),
            LeaveType.find({ school: req.schoolId, isActive: true }).lean(),
        ]);
        const teacherByEmail = Object.fromEntries(teachers.map(t => [t.email?.toLowerCase(), t]));
        const teacherById    = Object.fromEntries(teachers.map(t => [t.employeeId, t]));
        const ltByCode       = Object.fromEntries(leaveTypes.map(l => [l.code, l]));

        const errors = [];
        const ops    = [];

        rows.forEach((row, i) => {
            const lineNo = i + 2;
            const email  = (row.teacherEmail || '').toString().toLowerCase().trim();
            const empId  = (row.teacherEmployeeId || '').toString().trim();
            const ltCode = (row.leaveTypeCode || '').toString().trim().toUpperCase();
            const alloc  = parseFloat(row.totalAllocated);

            const teacher = teacherByEmail[email] || teacherById[empId];
            if (!teacher) { errors.push(`Row ${lineNo}: teacher not found`); return; }
            const lt = ltByCode[ltCode];
            if (!lt)      { errors.push(`Row ${lineNo}: leave type '${ltCode}' not found`); return; }
            if (isNaN(alloc)) { errors.push(`Row ${lineNo}: invalid totalAllocated`); return; }

            ops.push({
                updateOne: {
                    filter: { teacher: teacher._id, school: req.schoolId, leaveType: lt._id, academicYear: ay },
                    update: { $set: { totalAllocated: alloc } },
                    upsert: true,
                },
            });
        });

        if (ops.length) await LeaveBalance.bulkWrite(ops);
        res.json({ success: true, updated: ops.length, errors: errors.length ? errors : undefined });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminRunCarryForward = async (req, res) => {
    try {
        const { fromYear, toYear } = req.body;
        if (!fromYear || !toYear)
            return res.status(400).json({ success: false, message: 'fromYear and toYear are required (e.g. "2024-25", "2025-26")' });

        const leaveTypes = await LeaveType.find({ school: req.schoolId, 'carryForward.enabled': true }).lean();
        if (!leaveTypes.length) return res.json({ success: true, message: 'No carry-forward leave types', processed: 0 });

        let processed = 0;
        for (const lt of leaveTypes) {
            const balances = await LeaveBalance.find({ school: req.schoolId, leaveType: lt._id, academicYear: fromYear }).lean();
            for (const bal of balances) {
                const remaining = Math.max(0, bal.totalAllocated + bal.carriedForward - bal.used - bal.pending);
                const carryAmt  = Math.min(remaining, lt.carryForward.maxDays || remaining);
                if (carryAmt <= 0) continue;
                await LeaveBalance.findOneAndUpdate(
                    { teacher: bal.teacher, school: req.schoolId, leaveType: lt._id, academicYear: toYear },
                    { $inc: { carriedForward: carryAmt }, $setOnInsert: { totalAllocated: lt.annualAllocation, used: 0, pending: 0 } },
                    { upsert: true }
                );
                processed++;
            }
        }
        res.json({ success: true, processed });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Admin: Reports ────────────────────────────────────────────────────────────

exports.adminGetReports = async (req, res) => {
    try {
        const { academicYear, teacherId, leaveType, status } = req.query;
        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);

        const filter = { school: req.schoolId };
        if (teacherId) filter.teacher   = teacherId;
        if (leaveType) filter.leaveType = leaveType;
        if (status)    filter.status    = status;

        const [apps, balances] = await Promise.all([
            LeaveApplication.find(filter)
                .populate('teacher',   'name email employeeId')
                .populate('leaveType', 'name code')
                .sort({ appliedAt: -1 })
                .lean(),
            LeaveBalance.find({ school: req.schoolId, academicYear: ay, ...(teacherId ? { teacher: teacherId } : {}) })
                .populate('teacher',   'name email employeeId')
                .populate('leaveType', 'name code')
                .lean(),
        ]);

        const summary = balances.map(b => ({
            teacher:        b.teacher,
            leaveType:      b.leaveType,
            academicYear:   b.academicYear,
            totalAllocated: b.totalAllocated,
            carriedForward: b.carriedForward,
            used:           b.used,
            pending:        b.pending,
            remaining:      Math.max(0, b.totalAllocated + b.carriedForward - b.used - b.pending),
        }));

        res.json({ success: true, data: { applications: apps, summary } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminExportRequests = async (req, res) => {
    try {
        const { status, teacherId, leaveType, fromDate, toDate } = req.query;
        const filter = { school: req.schoolId };
        if (status)    filter.status    = status;
        if (teacherId) filter.teacher   = teacherId;
        if (leaveType) filter.leaveType = leaveType;
        if (fromDate || toDate) {
            filter.fromDate = {};
            if (fromDate) filter.fromDate.$gte = new Date(fromDate);
            if (toDate)   filter.fromDate.$lte = new Date(toDate);
        }

        const apps = await LeaveApplication.find(filter)
            .populate('teacher',   'name email employeeId')
            .populate('leaveType', 'name code')
            .populate('approvedBy','name')
            .sort({ appliedAt: -1 })
            .lean();

        const rows = apps.map(a => ({
            employeeId:   a.teacher?.employeeId || '',
            teacher:      a.teacher?.name       || '',
            email:        a.teacher?.email      || '',
            leaveType:    a.leaveType?.name     || '',
            code:         a.leaveType?.code     || '',
            fromDate:     a.fromDate?.toISOString().slice(0, 10) || '',
            toDate:       a.toDate?.toISOString().slice(0, 10)   || '',
            totalDays:    a.totalDays,
            leaveMode:    a.leaveMode?.replace('_', ' '),
            status:       a.status,
            reason:       a.reason || '',
            adminComment: a.adminComment || '',
            approvedBy:   a.approvedBy?.name || '',
            appliedAt:    a.appliedAt?.toISOString().slice(0, 10) || '',
        }));

        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Leave Requests');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="leave_requests.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminExportAllocations = async (req, res) => {
    try {
        const { academicYear } = req.query;
        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const balances = await LeaveBalance.find({ school: req.schoolId, academicYear: ay })
            .populate('teacher',   'name email employeeId')
            .populate('leaveType', 'name code annualAllocation')
            .lean();

        const rows = balances.map(b => ({
            employeeId:     b.teacher?.employeeId  || '',
            teacher:        b.teacher?.name        || '',
            email:          b.teacher?.email       || '',
            leaveType:      b.leaveType?.name      || '',
            code:           b.leaveType?.code      || '',
            academicYear:   b.academicYear,
            totalAllocated: b.totalAllocated,
            carriedForward: b.carriedForward || 0,
            used:           b.used           || 0,
            pending:        b.pending        || 0,
            remaining:      Math.max(0, b.totalAllocated + (b.carriedForward || 0) - (b.used || 0) - (b.pending || 0)),
        }));

        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Leave Allocations');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="leave_allocations.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminExportReports = async (req, res) => {
    try {
        const { academicYear, status } = req.query;
        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);

        const filter = { school: req.schoolId };
        if (status) filter.status = status;

        const apps = await LeaveApplication.find(filter)
            .populate('teacher',   'name email employeeId')
            .populate('leaveType', 'name code')
            .sort({ appliedAt: -1 })
            .lean();

        const rows = apps.map(a => ({
            employeeId:  a.teacher?.employeeId || '',
            teacher:     a.teacher?.name       || '',
            email:       a.teacher?.email      || '',
            leaveType:   a.leaveType?.name     || '',
            code:        a.leaveType?.code     || '',
            fromDate:    a.fromDate?.toISOString().slice(0, 10) || '',
            toDate:      a.toDate?.toISOString().slice(0, 10)   || '',
            totalDays:   a.totalDays,
            leaveMode:   a.leaveMode,
            status:      a.status,
            reason:      a.reason,
            adminComment:a.adminComment || '',
            appliedAt:   a.appliedAt?.toISOString().slice(0, 10) || '',
        }));

        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Leave Report');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="leave_report.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: My Leaves ────────────────────────────────────────────────────────

exports.teacherGetMyLeaves = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const filter = { teacher: req.userId, school: req.schoolId };
        if (status) filter.status = status;

        const [apps, total] = await Promise.all([
            LeaveApplication.find(filter)
                .populate('leaveType', 'name code')
                .populate('approvedBy','name')
                .sort({ appliedAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            LeaveApplication.countDocuments(filter),
        ]);
        res.json({ success: true, data: apps, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherGetLeaveBalance = async (req, res) => {
    try {
        const ay = await getActiveAcademicYearLabel(req.schoolId);
        const [balances, leaveTypes, school] = await Promise.all([
            LeaveBalance.find({ teacher: req.userId, school: req.schoolId, academicYear: ay })
                .populate('leaveType', 'name code annualAllocation requiresDocument documentRequiredAfterDays maxConsecutiveDays')
                .lean(),
            LeaveType.find({ school: req.schoolId, isActive: true }).lean(),
            School.findById(req.schoolId).select('leaveSettings modules').lean(),
        ]);

        // Ensure all active leave types have a balance row (for display)
        const balMap = Object.fromEntries(balances.map(b => [b.leaveType?._id?.toString() || b.leaveType?.toString(), b]));
        const result = leaveTypes.map(lt => {
            const b = balMap[lt._id.toString()];
            if (b) {
                return { ...b, remaining: Math.max(0, b.totalAllocated + b.carriedForward - b.used - b.pending) };
            }
            return {
                leaveType:      lt,
                academicYear:   ay,
                totalAllocated: lt.annualAllocation,
                carriedForward: 0,
                used:           0,
                pending:        0,
                remaining:      lt.annualAllocation,
            };
        });
        // Wrap both in data so the axios interceptor (res => res.data) delivers leaveSettings to the frontend
        res.json({ success: true, data: { items: result, leaveSettings: normalizeLeaveSettings(school?.leaveSettings), academicYear: ay, holidayModuleEnabled: !!school?.modules?.holiday } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherApplyLeave = async (req, res) => {
    try {
        const { leaveTypeId, fromDate, toDate, leaveMode, reason } = req.body;
        if (!leaveTypeId || !fromDate || !toDate || !reason)
            return res.status(400).json({ success: false, message: 'leaveTypeId, fromDate, toDate and reason are required' });

        const lt = await LeaveType.findOne({ _id: leaveTypeId, school: req.schoolId, isActive: true }).lean();
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });

        const from = new Date(fromDate);
        const to   = new Date(toDate);
        from.setUTCHours(0, 0, 0, 0);
        to.setUTCHours(0, 0, 0, 0);

        if (isNaN(from.getTime()) || isNaN(to.getTime()))
            return res.status(400).json({ success: false, message: 'Invalid date format' });
        if (to < from)
            return res.status(400).json({ success: false, message: 'toDate must be on or after fromDate' });

        // Teachers cannot apply for past dates
        const today = new Date(); today.setUTCHours(0, 0, 0, 0);
        if (from < today)
            return res.status(400).json({ success: false, message: 'Cannot apply leave for past dates' });

        const school        = await School.findById(req.schoolId).select('leaveSettings modules').lean();
        const leaveSettings  = normalizeLeaveSettings(school?.leaveSettings);

        let totalDays;
        if (leaveMode === 'half_day') {
            if (from.getTime() !== to.getTime())
                return res.status(400).json({ success: false, message: 'Half-day leave must have the same fromDate and toDate' });
            const dow = from.getUTCDay();
            if (dow === 0)
                return res.status(400).json({ success: false, message: 'Cannot apply half-day leave on a Sunday' });
            if (dow === 6 && !isSaturdayWorking(from, leaveSettings))
                return res.status(400).json({ success: false, message: 'Cannot apply half-day leave on a non-working Saturday' });
            if (school?.modules?.holiday) {
                const hDays = await countHolidayWorkingDays(from, from, req.schoolId, leaveSettings);
                if (hDays > 0)
                    return res.status(400).json({ success: false, message: 'Cannot apply leave on a holiday' });
            }
            totalDays = 0.5;
        } else {
            totalDays = countWorkingDays(from, to, leaveSettings);
            if (school?.modules?.holiday) {
                const hDays = await countHolidayWorkingDays(from, to, req.schoolId, leaveSettings);
                totalDays -= hDays;
            }
            if (totalDays <= 0)
                return res.status(400).json({ success: false, message: 'No working days in the selected date range (all are weekends or holidays)' });
        }

        if (lt.maxConsecutiveDays > 0 && totalDays > lt.maxConsecutiveDays && leaveMode !== 'half_day')
            return res.status(400).json({ success: false, message: `Max consecutive days for this leave type is ${lt.maxConsecutiveDays}` });

        const overlap = await getOverlappingLeave(req.userId, req.schoolId, from, to);
        if (overlap)
            return res.status(400).json({ success: false, message: 'You already have a leave application (pending or approved) that overlaps with the selected dates' });

        const ay = await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const bal = await ensureBalance(req.userId, req.schoolId, leaveTypeId, ay);
        const remaining = Math.max(0, bal.totalAllocated + bal.carriedForward - bal.used - bal.pending);
        if (totalDays > remaining)
            return res.status(400).json({ success: false, message: `Insufficient leave balance. Available: ${remaining} day(s)` });

        // Document check
        let documentPath = null;
        if (req.file) documentPath = req.file.filename;
        if (lt.requiresDocument) {
            const afterDays = lt.documentRequiredAfterDays || 0;
            if ((afterDays === 0 || totalDays > afterDays) && !documentPath)
                return res.status(400).json({ success: false, message: 'Document is required for this leave type' });
        }

        const app = await LeaveApplication.create({
            teacher: req.userId, school: req.schoolId, leaveType: leaveTypeId,
            fromDate: from, toDate: to, totalDays,
            leaveMode: leaveMode || 'full_day', reason, document: documentPath, appliedAt: new Date(),
        });
        await LeaveBalance.updateOne(
            { teacher: req.userId, school: req.schoolId, leaveType: leaveTypeId, academicYear: ay },
            { $inc: { pending: totalDays } }
        );
        schoolAdminIds(req.schoolId).then(admins => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📋 New leave request',
            body: `${req.user?.name || 'A teacher'} applied for ${lt.name} leave from ${fmtDate(from)} to ${fmtDate(to)} (${totalDays} day${totalDays === 1 ? '' : 's'}).\nReason: ${reason}`,
            recipients: admins,
        })).catch(() => {});
        res.status(201).json({ success: true, data: app });
    } catch (e) {
        if (e.code === 11000) return res.status(400).json({ success: false, message: 'You already have a leave application for these dates' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.teacherCancelLeave = async (req, res) => {
    try {
        const app = await LeaveApplication.findOne({ _id: req.params.id, teacher: req.userId, school: req.schoolId });
        if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });
        if (!['pending', 'modification_requested'].includes(app.status))
            return res.status(400).json({ success: false, message: 'Only pending applications can be cancelled' });

        const oldStatus = app.status;
        app.status      = 'cancelled';
        app.cancelledAt = new Date();
        await app.save();

        // pending was set on apply and never cleared for modification_requested, so decrement for both
        if (['pending', 'modification_requested'].includes(oldStatus)) {
            const ay = await getActiveAcademicYearLabel(req.schoolId);
            await LeaveBalance.updateOne(
                { teacher: req.userId, school: req.schoolId, leaveType: app.leaveType, academicYear: ay },
                { $inc: { pending: -app.totalDays } }
            );
        }
        schoolAdminIds(req.schoolId).then(admins => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '🚫 Leave request cancelled',
            body: `${req.user?.name || 'A teacher'} cancelled their leave request for ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)}.`,
            recipients: admins,
        })).catch(() => {});
        res.json({ success: true, data: app });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
