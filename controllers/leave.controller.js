'use strict';
const LeaveType        = require('../models/LeaveType');
const LeaveApplication = require('../models/LeaveApplication');
const LeaveBalance     = require('../models/LeaveBalance');
const School           = require('../models/School');
const User             = require('../models/User');
const AcademicYear     = require('../models/AcademicYear');
const XLSX             = require('xlsx');
const path             = require('path');
const { notify, schoolAdminIds } = require('../services/notifyService');
const compOff          = require('../services/compOffService');
const leavePolicy      = require('../services/leavePolicyService');
// Working-day / weekly-off arithmetic is shared with the Comp Off engine so the
// two can never disagree about whether a given Saturday is a working day.
const {
    getActiveAcademicYearLabel, isSaturdayWorking, countWorkingDays, countCalendarDays,
    countHolidayWorkingDays, normalizeLeaveSettings, remainingOf,
} = require('../utils/leaveDays');

const fmtDate = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

// ── Helpers ───────────────────────────────────────────────────────────────────

const isCompOffType = lt => lt?.category === 'compoff' || String(lt?.code || '').toUpperCase() === 'COMPOFF';

/**
 * How many days an application actually costs.
 *
 * Normally weekends and holidays inside the range are free. A leave type whose
 * policy turns the sandwich rule on charges every calendar day instead, so a
 * Friday–Monday absence costs four days rather than two.
 *
 * Returns { totalDays } or { error }.
 */
async function computeLeaveDays({ schoolId, from, to, leaveMode, policy, leaveSettings, holidayModule }) {
    if (leaveMode === 'half_day') {
        if (from.getTime() !== to.getTime())
            return { error: 'Half-day leave must have the same fromDate and toDate' };
        const dow = from.getUTCDay();
        if (dow === 0)
            return { error: 'Cannot apply half-day leave on a Sunday' };
        if (dow === 6 && !isSaturdayWorking(from, leaveSettings))
            return { error: 'Cannot apply half-day leave on a non-working Saturday' };
        if (holidayModule) {
            const hDays = await countHolidayWorkingDays(from, from, schoolId, leaveSettings);
            if (hDays > 0) return { error: 'Cannot apply leave on a holiday' };
        }
        return { totalDays: 0.5 };
    }

    if (policy?.sandwichRule) {
        const days = countCalendarDays(from, to);
        if (days <= 0) return { error: 'Invalid date range' };
        return { totalDays: days, sandwiched: true };
    }

    let totalDays = countWorkingDays(from, to, leaveSettings);
    if (holidayModule) {
        totalDays -= await countHolidayWorkingDays(from, to, schoolId, leaveSettings);
    }
    if (totalDays <= 0)
        return { error: 'No working days in the selected date range (all are weekends or holidays)' };
    return { totalDays };
}

// Returns an existing pending/approved/modification_requested leave that overlaps [from, to]
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
    // A comp off balance starts empty on purpose — days arrive only through an
    // approved CompOffRequest, never from an annual allocation.
    const seed = isCompOffType(lt) ? 0 : (lt?.annualAllocation || 0);
    return LeaveBalance.findOneAndUpdate(
        { teacher: teacherId, school: schoolId, leaveType: leaveTypeId, academicYear },
        { $setOnInsert: { totalAllocated: seed, carriedForward: 0, used: 0, pending: 0, expired: 0 } },
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
        const { name, code, category, annualAllocation, monthlyAccrual, carryForward, encashable,
                maxEncashableDays, maxConsecutiveDays, requiresDocument, documentRequiredAfterDays, isActive } = req.body;
        if (!name?.trim()) return res.status(400).json({ success: false, message: 'Name is required' });
        if (!code?.trim()) return res.status(400).json({ success: false, message: 'Code is required' });

        const normalizedCode = code.trim().toUpperCase();
        const resolvedCategory = category === 'compoff' || normalizedCode === 'COMPOFF' ? 'compoff' : 'general';

        // Only one comp off type can be live at a time — the engine resolves
        // "the" comp off type, and two active ones would make that ambiguous.
        if (resolvedCategory === 'compoff' && isActive !== false) {
            const clash = await LeaveType.findOne({
                school: req.schoolId, category: 'compoff', isActive: true,
                code: { $ne: normalizedCode },
            }).lean();
            if (clash) return res.status(400).json({ success: false, message: `An active Comp Off leave type already exists (${clash.code}). Deactivate it first.` });
        }

        const payload = {
            name:                       name.trim(),
            category:                   resolvedCategory,
            // Comp off is earned, never allocated — force the annual figure to 0
            // so nobody can hand out comp off days through the allocation screen.
            annualAllocation:           resolvedCategory === 'compoff' ? 0 : (Number(annualAllocation) || 0),
            isActive:                   isActive !== false,
        };

        // Accrual, carry forward, encashment, consecutive-day caps and document
        // rules moved to LeavePolicy. These columns survive only as the seed for
        // a type that has no policy row yet, so they are written just when a
        // caller explicitly sends them — never blanked by their absence.
        if (monthlyAccrual            !== undefined) payload.monthlyAccrual            = monthlyAccrual;
        if (carryForward              !== undefined) payload.carryForward              = carryForward;
        if (encashable                !== undefined) payload.encashable                = !!encashable;
        if (maxEncashableDays         !== undefined) payload.maxEncashableDays         = Number(maxEncashableDays) || 0;
        if (maxConsecutiveDays        !== undefined) payload.maxConsecutiveDays        = Number(maxConsecutiveDays) || 0;
        if (requiresDocument          !== undefined) payload.requiresDocument          = !!requiresDocument;
        if (documentRequiredAfterDays !== undefined) payload.documentRequiredAfterDays = Number(documentRequiredAfterDays) || 0;

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
        const { name, code, category, annualAllocation, monthlyAccrual, carryForward, encashable,
                maxEncashableDays, maxConsecutiveDays, requiresDocument, documentRequiredAfterDays, isActive } = req.body;

        const existing = await LeaveType.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!existing) return res.status(404).json({ success: false, message: 'Leave type not found' });
        const nextCategory = category !== undefined
            ? (category === 'compoff' ? 'compoff' : 'general')
            : (existing.category || 'general');

        if (nextCategory === 'compoff' && isActive !== false) {
            const clash = await LeaveType.findOne({
                school: req.schoolId, category: 'compoff', isActive: true, _id: { $ne: req.params.id },
            }).lean();
            if (clash) return res.status(400).json({ success: false, message: `An active Comp Off leave type already exists (${clash.code}). Deactivate it first.` });
        }

        const update = {};
        if (category                 !== undefined) update.category                 = nextCategory;
        if (name                     !== undefined) update.name                     = name.trim();
        if (code                     !== undefined) update.code                     = code.trim().toUpperCase();
        // Comp off days are earned, never allocated — keep the annual figure at 0
        if (annualAllocation         !== undefined) update.annualAllocation         = nextCategory === 'compoff' ? 0 : Number(annualAllocation);
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
        const CompOffRequest = require('../models/CompOffRequest');
        const [inUse, compOffInUse] = await Promise.all([
            LeaveApplication.exists({ leaveType: req.params.id, school: req.schoolId }),
            CompOffRequest.exists({ leaveType: req.params.id, school: req.schoolId }),
        ]);
        if (inUse || compOffInUse)
            return res.status(400).json({ success: false, message: 'Cannot delete — leave type is in use' });
        const lt = await LeaveType.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Admin: Leave Policies (one configurable policy per leave type) ───────────

exports.adminGetPolicies = async (req, res) => {
    try {
        const [policies, school] = await Promise.all([
            leavePolicy.getAllPolicies(req.schoolId),
            School.findById(req.schoolId).select('designations').lean(),
        ]);
        res.json({ success: true, data: {
            policies,
            designations: school?.designations || [],
            // Source list for the "cannot be combined with" picker
            leaveTypes: policies.map(p => ({
                _id: p.leaveType._id, name: p.leaveType.name,
                code: p.leaveType.code, category: p.leaveType.category || 'general',
            })),
        }});
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminGetPolicy = async (req, res) => {
    try {
        const policy = await leavePolicy.getPolicy(req.schoolId, req.params.leaveTypeId);
        if (!policy) return res.status(404).json({ success: false, message: 'Leave type not found' });
        res.json({ success: true, data: policy });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminUpdatePolicy = async (req, res) => {
    try {
        const result = await leavePolicy.savePolicy(req.schoolId, req.params.leaveTypeId, req.body || {}, req.userId);
        if (!result.ok) return res.status(404).json({ success: false, message: result.message });
        res.json({ success: true, data: result.policy });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: which types am I allowed to apply for, and under what rules ─────

exports.teacherGetPolicies = async (req, res) => {
    try {
        const policies = await leavePolicy.eligibleTypesFor(req.schoolId, req.userId, req.userRole);
        res.json({ success: true, data: policies });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Applications waiting on this user's sign-off. Designation-based approvers are
 * teachers, so they have no admin screen — this is their queue.
 */
exports.teacherGetApprovals = async (req, res) => {
    try {
        const { status = 'pending' } = req.query;
        const policies = await leavePolicy.getAllPolicies(req.schoolId);

        const mine = [];
        for (const p of policies) {
            if (await leavePolicy.canApprove(req.userId, req.userRole, req.schoolId, p)) mine.push(p.leaveType._id);
        }
        if (!mine.length) return res.json({ success: true, data: { isApprover: false, items: [] } });

        const filter = { school: req.schoolId, leaveType: { $in: mine } };
        if (status) filter.status = status;

        const items = await LeaveApplication.find(filter)
            .populate('teacher',   'name email')
            .populate('leaveType', 'name code category')
            .sort({ appliedAt: -1 })
            .limit(100)
            .lean();
        res.json({ success: true, data: { isApprover: true, items } });
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
                .populate('leaveType','name code category')
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

        const ltDoc = await LeaveType.findOne({ _id: leaveTypeId, school: req.schoolId }).lean();
        if (!ltDoc) return res.status(404).json({ success: false, message: 'Leave type not found' });
        const policy = await leavePolicy.getPolicy(req.schoolId, ltDoc);

        const counted = await computeLeaveDays({
            schoolId: req.schoolId, from, to, leaveMode, policy, leaveSettings,
            holidayModule: !!school?.modules?.holiday,
        });
        if (counted.error) return res.status(400).json({ success: false, message: counted.error });
        const totalDays = counted.totalDays;

        const overlap = await getOverlappingLeave(teacherId, req.schoolId, from, to);
        if (overlap)
            return res.status(400).json({ success: false, message: 'Teacher already has a leave application (pending or approved) that overlaps with the selected dates' });

        const documentPath = req.file ? req.file.filename : null;

        // `onBehalf` waives the notice-period and back-dating rules: those bind
        // the employee, and an admin filing for them is usually correcting the
        // record after the fact. Every other rule still applies.
        const check = await leavePolicy.validateApplication({
            schoolId: req.schoolId, policy, teacherId,
            from, to, totalDays, leaveMode, hasDocument: !!documentPath, onBehalf: true,
        });
        if (!check.ok) return res.status(400).json({ success: false, message: check.message });

        const ay = await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const bal = await ensureBalance(teacherId, req.schoolId, leaveTypeId, ay);
        const remaining = remainingOf(bal);
        if (totalDays > leavePolicy.spendableFrom(policy, remaining))
            return res.status(400).json({ success: false, message: `Insufficient balance. Available: ${remaining}` });

        const app = await LeaveApplication.create({
            teacher: teacherId, school: req.schoolId, leaveType: leaveTypeId,
            fromDate: from, toDate: to, totalDays,
            leaveMode: leaveMode || 'full_day', reason, document: documentPath, appliedAt: new Date(),
            approvalsRequired: policy.approval.twoLevel ? 2 : 1,
            approvalLevel: 0, approvals: [],
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
        const data = balances.map(b => ({ ...b, remaining: remainingOf(b) }));
        res.json({ success: true, data, academicYear: ay });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminApproveRequest = async (req, res) => {
    try {
        const app = await LeaveApplication.findOne({ _id: req.params.id, school: req.schoolId });
        if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });
        if (app.status !== 'pending')
            return res.status(400).json({ success: false, message: 'Only pending requests can be approved' });

        // Who may sign off is a per-leave-type rule, so it is checked here
        // rather than left to the route guard — a designation-based approver
        // reaches this same handler through the teacher router.
        const policy = await leavePolicy.getPolicy(req.schoolId, app.leaveType);
        if (!policy) return res.status(404).json({ success: false, message: 'Leave type not found' });
        if (!await leavePolicy.canApprove(req.userId, req.userRole, req.schoolId, policy))
            return res.status(403).json({ success: false, message: 'You are not an approver for this leave type' });

        const already = (app.approvals || []).some(a => String(a.by) === String(req.userId));
        if (already)
            return res.status(400).json({ success: false, message: 'You have already approved this request — a second sign-off must come from someone else' });

        const comment = req.body.adminComment || req.body.comment || '';
        const approvals = [...(app.approvals || []), {
            level: (app.approvalLevel || 0) + 1,
            by: String(req.userId), byName: req.user?.name || '',
            at: new Date().toISOString(), comment,
        }];
        app.approvals     = approvals;
        app.approvalLevel = approvals.length;
        app.adminComment  = comment || app.adminComment;

        // A first-of-two sign-off records the approval but moves no balance.
        const required = app.approvalsRequired || 1;
        if (app.approvalLevel < required) {
            await app.save();
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '🕓 Leave — first approval recorded',
                body: `Your leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} cleared level ${app.approvalLevel} of ${required}. It is not approved until the final sign-off.`,
                recipients: [app.teacher],
            });
            return res.json({ success: true, data: app, pendingLevels: required - app.approvalLevel });
        }

        app.status     = 'approved';
        app.approvedBy = req.userId;
        app.approvedAt = new Date();
        await app.save();

        const ay = await getActiveAcademicYearLabel(req.schoolId);
        await LeaveBalance.updateOne(
            { teacher: app.teacher, school: req.schoolId, leaveType: app.leaveType, academicYear: ay },
            { $inc: { used: app.totalDays, pending: -app.totalDays } }
        );

        // Comp Off leave draws down the FIFO ledger lots (oldest expiry first)
        // and records a USED entry alongside the balance move.
        const ltDoc = await LeaveType.findById(app.leaveType).lean();
        if (isCompOffType(ltDoc)) {
            await compOff.consumeForLeave(app, { actorId: req.userId, academicYear: ay })
                .catch(e => console.error('[compOff] consume failed:', e.message));
        }

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

        const policy = await leavePolicy.getPolicy(req.schoolId, app.leaveType);
        if (policy && !await leavePolicy.canApprove(req.userId, req.userRole, req.schoolId, policy))
            return res.status(403).json({ success: false, message: 'You are not an approver for this leave type' });

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

/**
 * Reverse an already-approved leave: the days go back into the balance and the
 * application is marked cancelled.
 *
 * Comp Off needs this to close the loop the plain leave flow never had — an
 * approved comp off leave has already drawn down its ledger lots, so undoing it
 * must refill them and record a REVERSED entry rather than silently editing a
 * counter.
 */
exports.adminReverseApproved = async (req, res) => {
    try {
        const { adminComment } = req.body;
        const app = await LeaveApplication.findOne({ _id: req.params.id, school: req.schoolId });
        if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });
        if (app.status !== 'approved')
            return res.status(400).json({ success: false, message: 'Only approved leave can be reversed' });

        const ay = await getActiveAcademicYearLabel(req.schoolId);
        await LeaveBalance.updateOne(
            { teacher: app.teacher, school: req.schoolId, leaveType: app.leaveType, academicYear: ay },
            { $inc: { used: -app.totalDays } }
        );

        const ltDoc = await LeaveType.findById(app.leaveType).lean();
        if (isCompOffType(ltDoc)) {
            await compOff.reverseConsumption(app, {
                actorId: req.userId, academicYear: ay, reason: adminComment || '',
            }).catch(e => console.error('[compOff] reversal failed:', e.message));
        }

        app.status       = 'cancelled';
        app.cancelledAt  = new Date();
        app.adminComment = adminComment || '';
        await app.save();

        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '↩️ Approved leave reversed',
            body: `Your approved leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} has been reversed and ${app.totalDays} day(s) restored to your balance.${adminComment ? `\nReason: ${adminComment}` : ''}`,
            recipients: [app.teacher],
            email: true,
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
        // The allocation screen needs to know whether a type accrues monthly —
        // that is a policy rule now, so it rides along with each type.
        const policies = await leavePolicy.getAllPolicies(req.schoolId, { activeOnly: true });
        const byType = Object.fromEntries(policies.map(p => [String(p.leaveType._id), p]));
        const withPolicy = leaveTypes.map(lt => ({
            ...lt,
            monthlyAccrual: byType[String(lt._id)]?.monthlyAccrual || lt.monthlyAccrual,
            carryForward:   byType[String(lt._id)]?.carryForward   || lt.carryForward,
        }));
        res.json({ success: true, data: balances, leaveTypes: withPolicy, academicYear: ay });
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
        // Guard the core rule: comp off balance may only ever come from an
        // approved Comp Off request, so it cannot be handed out here.
        if (isCompOffType(lt))
            return res.status(400).json({ success: false, message: 'Comp Off cannot be allocated — its balance is credited only when a Comp Off request is approved' });

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

        // Compute totalAllocated. Whether this type accrues monthly is a policy
        // rule, so ask the policy rather than the leave type row.
        const ltPolicy = await leavePolicy.getPolicy(req.schoolId, lt);
        const accrues  = !!ltPolicy?.monthlyAccrual?.enabled;

        let totalAllocated;
        if (overrideDays !== undefined && overrideDays !== null && overrideDays !== '') {
            totalAllocated = Number(overrideDays);
        } else if (accrues && !giveFullAllocation) {
            // Monthly accrual: start at 0, cron will credit each month
            totalAllocated = 0;
        } else if (useProration && !accrues) {
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
    // Accrual is a policy rule now, so the set of accruing types comes from the
    // policies rather than the leave type columns.
    // Comp off never accrues on a clock — it is earned per approved request.
    const policies = (await leavePolicy.getAllPolicies(schoolId, { activeOnly: true }))
        .filter(p => p.monthlyAccrual.enabled && !isCompOffType(p.leaveType));
    if (!policies.length) return 0;

    const now       = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let credited = 0;
    for (const policy of policies) {
        const lt = policy.leaveType;
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
                        totalAllocated: Math.min(b.totalAllocated + (policy.monthlyAccrual.daysPerMonth || 0), lt.annualAllocation),
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
            if (isCompOffType(lt)) { errors.push(`Row ${lineNo}: Comp Off cannot be allocated — it is credited only on approval`); return; }
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

        // Carry forward is a policy rule, so the types that roll over come from
        // the policies rather than the leave type columns.
        const policies = (await leavePolicy.getAllPolicies(req.schoolId))
            .filter(p => p.carryForward.enabled);

        let processed = 0;
        let compOffProcessed = 0;
        for (const policy of policies) {
            const lt = policy.leaveType;

            // Comp off rolls over through its own engine so the move is written
            // to the leave ledger, but the rule it obeys is this same policy.
            if (isCompOffType(lt)) {
                const co = await compOff.carryForward(req.schoolId, fromYear, toYear, policy.carryForward)
                    .catch(() => ({ processed: 0 }));
                compOffProcessed += co.processed || 0;
                processed += co.processed || 0;
                continue;
            }

            const balances = await LeaveBalance.find({ school: req.schoolId, leaveType: lt._id, academicYear: fromYear }).lean();
            for (const bal of balances) {
                const remaining = remainingOf(bal);
                const carryAmt  = Math.min(remaining, policy.carryForward.maxDays || remaining);
                if (carryAmt <= 0) continue;
                await LeaveBalance.findOneAndUpdate(
                    { teacher: bal.teacher, school: req.schoolId, leaveType: lt._id, academicYear: toYear },
                    { $inc: { carriedForward: carryAmt }, $setOnInsert: { totalAllocated: lt.annualAllocation, used: 0, pending: 0, expired: 0 } },
                    { upsert: true }
                );
                processed++;
            }
        }

        if (!processed) return res.json({ success: true, message: 'Nothing to carry forward', processed: 0 });
        res.json({ success: true, processed, compOffProcessed });
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
            expired:        b.expired || 0,
            remaining:      remainingOf(b),
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
            expired:        b.expired        || 0,
            remaining:      remainingOf(b),
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
                .populate('leaveType', 'name code category annualAllocation requiresDocument documentRequiredAfterDays maxConsecutiveDays')
                .lean(),
            LeaveType.find({ school: req.schoolId, isActive: true }).lean(),
            School.findById(req.schoolId).select('leaveSettings modules').lean(),
        ]);

        // Ensure all active leave types have a balance row (for display)
        const balMap = Object.fromEntries(balances.map(b => [b.leaveType?._id?.toString() || b.leaveType?.toString(), b]));
        const result = leaveTypes.map(lt => {
            const b = balMap[lt._id.toString()];
            if (b) {
                return { ...b, remaining: remainingOf(b) };
            }
            // No balance row yet. A comp off type shows zero — its days are
            // earned through approved Comp Off requests, not pre-allocated.
            const seed = isCompOffType(lt) ? 0 : lt.annualAllocation;
            return {
                leaveType:      lt,
                academicYear:   ay,
                totalAllocated: seed,
                carriedForward: 0,
                used:           0,
                pending:        0,
                expired:        0,
                remaining:      seed,
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

        const policy = await leavePolicy.getPolicy(req.schoolId, lt);
        const school = await School.findById(req.schoolId).select('leaveSettings modules').lean();
        const leaveSettings = normalizeLeaveSettings(school?.leaveSettings);

        const counted = await computeLeaveDays({
            schoolId: req.schoolId, from, to, leaveMode, policy, leaveSettings,
            holidayModule: !!school?.modules?.holiday,
        });
        if (counted.error) return res.status(400).json({ success: false, message: counted.error });
        const totalDays = counted.totalDays;

        const overlap = await getOverlappingLeave(req.userId, req.schoolId, from, to);
        if (overlap)
            return res.status(400).json({ success: false, message: 'You already have a leave application (pending or approved) that overlaps with the selected dates' });

        const documentPath = req.file ? req.file.filename : null;

        // Every configurable rule for this leave type, in one place
        const check = await leavePolicy.validateApplication({
            schoolId: req.schoolId, policy, teacherId: req.userId,
            from, to, totalDays, leaveMode, hasDocument: !!documentPath,
        });
        if (!check.ok) return res.status(400).json({ success: false, message: check.message });

        const ay = await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const bal = await ensureBalance(req.userId, req.schoolId, leaveTypeId, ay);
        const remaining = remainingOf(bal);
        const spendable = leavePolicy.spendableFrom(policy, remaining);
        if (totalDays > spendable)
            return res.status(400).json({ success: false, message: `Insufficient leave balance. Available: ${remaining} day(s)` });

        const app = await LeaveApplication.create({
            teacher: req.userId, school: req.schoolId, leaveType: leaveTypeId,
            fromDate: from, toDate: to, totalDays,
            leaveMode: leaveMode || 'full_day', reason, document: documentPath, appliedAt: new Date(),
            approvalsRequired: policy.approval.twoLevel ? 2 : 1,
            approvalLevel: 0, approvals: [],
        });
        await LeaveBalance.updateOne(
            { teacher: req.userId, school: req.schoolId, leaveType: leaveTypeId, academicYear: ay },
            { $inc: { pending: totalDays } }
        );
        // Routed by the type's own policy — admins, named designations, or both
        leavePolicy.approverIds(req.schoolId, policy).then(recipients => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📋 New leave request',
            body: `${req.user?.name || 'A teacher'} applied for ${lt.name} leave from ${fmtDate(from)} to ${fmtDate(to)} (${totalDays} day${totalDays === 1 ? '' : 's'}).\nReason: ${reason}`,
            recipients,
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
