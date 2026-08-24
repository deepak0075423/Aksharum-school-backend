'use strict';
/**
 * Comp Off HTTP layer.
 *
 * Every rule lives in services/compOffService — this file only marshals
 * requests, enforces ownership, and shapes responses. In particular there is
 * no `LeaveBalance` write anywhere in this file: crediting is reachable only
 * through compOff.approveRequest().
 */
const CompOffRequest = require('../models/CompOffRequest');
const LeaveLedger    = require('../models/LeaveLedger');
const LeaveBalance   = require('../models/LeaveBalance');
const User           = require('../models/User');
const TeacherProfile = require('../models/TeacherProfile');
const XLSX           = require('xlsx');
const compOff        = require('../services/compOffService');
const { getActiveAcademicYearLabel, remainingOf, utcMidnight } = require('../utils/leaveDays');

const ok  = (res, data, status = 200) => res.status(status).json({ success: true, data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

// findDuplicate() normally catches this first with a readable message. The
// partial unique index behind it only fires on a genuine race, and a raw
// Postgres constraint string is no use to the person who double-tapped Apply.
const fail = (res, e) => (e.code === 11000
    ? bad(res, 'A Comp Off request for this work date already exists')
    : bad(res, e.message, e.status || 500));

const fmtDate = d => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// The slice of policy an employee is allowed to see — enough for the apply form
// to explain itself, without exposing approver routing.
const publicPolicy = p => ({
    minWorkingHours: p.minWorkingHours,
    halfDayHours:    p.halfDayHours,
    fullDayHours:    p.fullDayHours,
    eligibleDays:    p.eligibleDays,
    allowWorkingDays: p.allowWorkingDays,
    applyWithinDays:  p.applyWithinDays,
    maxPerMonth: p.maxPerMonth,
    maxPerYear:  p.maxPerYear,
    validityDays: p.validityDays,
    halfDayAllowed: p.halfDayAllowed,
    advanceCompOffAllowed: p.advanceCompOffAllowed,
    autoGenerateFromAttendance: p.autoGenerateFromAttendance,
    approvalsRequired: p.approval.twoLevel ? 2 : 1,
});

async function balanceFor(teacherId, ctx) {
    const ay  = await getActiveAcademicYearLabel(ctx.school._id);
    const bal = await LeaveBalance.findOne({
        teacher: teacherId, school: ctx.school._id, leaveType: ctx.leaveType._id, academicYear: ay,
    }).lean();
    return {
        academicYear:   ay,
        leaveType:      { _id: ctx.leaveType._id, name: ctx.leaveType.name, code: ctx.leaveType.code },
        totalAllocated: bal?.totalAllocated || 0,   // total comp off ever earned this year
        carriedForward: bal?.carriedForward || 0,
        used:           bal?.used    || 0,
        pending:        bal?.pending || 0,
        expired:        bal?.expired || 0,
        remaining:      remainingOf(bal),
    };
}

// ── Employee ──────────────────────────────────────────────────────────────────

/** Everything the employee's Comp Off tab needs in one round-trip. */
exports.myCompOff = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) {
            return ok(res, { enabled: false, reason: ctx.reason, requests: [], drafts: [], balance: null });
        }

        const { status, page = 1, limit = 20 } = req.query;
        const filter = { teacher: req.userId, school: req.schoolId };
        if (status) filter.status = status;
        else filter.status = { $ne: 'draft' };   // drafts ride in their own list

        const [requests, total, drafts, balance] = await Promise.all([
            CompOffRequest.find(filter)
                .populate('holiday', 'name type')
                .populate('approvedBy', 'name')
                .sort({ workDate: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            CompOffRequest.countDocuments(filter),
            CompOffRequest.find({ teacher: req.userId, school: req.schoolId, status: 'draft' })
                .populate('holiday', 'name type')
                .sort({ workDate: -1 })
                .lean(),
            balanceFor(req.userId, ctx),
        ]);

        const isApprover = await compOff.canApprove(req.userId, req.userRole, req.schoolId, ctx.policy);

        ok(res, {
            enabled: true,
            policy: publicPolicy(ctx.policy),
            holidayModule: ctx.holidayModule,
            attendanceModule: ctx.attendanceModule,
            isApprover,
            balance,
            drafts,
            requests,
            total, page: +page, pages: Math.ceil(total / +limit),
        });
    } catch (e) { bad(res, e.message, 500); }
};

/**
 * Classify a work date before the employee commits to it — powers the live
 * hint under the date picker ("Sunday · eligible · 1 day").
 */
exports.previewWorkDate = async (req, res) => {
    try {
        const { date, checkIn, checkOut, workedHours } = req.query;
        if (!date) return bad(res, 'date is required');

        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return ok(res, { enabled: false, reason: ctx.reason });

        const day = utcMidnight(date);
        if (isNaN(day.getTime())) return bad(res, 'Invalid date');

        const classification = await compOff.classifyWorkDate(req.schoolId, day, ctx);
        const hours = workedHours != null && workedHours !== ''
            ? Number(workedHours)
            : compOff.hoursBetween(checkIn, checkOut);
        const days = hours > 0 ? compOff.computeCompOffDays(hours, ctx.policy) : null;

        const check = await compOff.checkEligibility({
            ctx,
            teacherId: req.query.teacherId || req.userId,
            workDate: day,
            compOffDays: days == null ? 1 : days,
            workedHours: hours,
            classification,
        });

        ok(res, {
            enabled: true,
            date: day,
            dayCategory: classification.category,
            dayLabel:    classification.label,
            workedHours: hours || 0,
            compOffDays: days,
            eligible: check.ok,
            message:  check.ok ? '' : check.message,
            holidayModule: ctx.holidayModule,
        });
    } catch (e) { bad(res, e.message, 500); }
};

/** Scenarios 1 & 2 — the employee fills the Comp Off form. */
exports.applyCompOff = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return bad(res, ctx.reason, 403);

        const { workDate, checkIn, checkOut, workedHours, compOffDays, reason } = req.body;
        if (!workDate) return bad(res, 'workDate is required');
        if (!String(reason || '').trim()) return bad(res, 'reason is required');

        const result = await compOff.createRequest({
            ctx,
            teacherId: req.userId,
            workDate,
            checkIn:  checkIn  || '',
            checkOut: checkOut || '',
            workedHours,
            compOffDays,
            reason,
            document: req.file ? req.file.filename : null,
            source: 'manual',
            mode: 'submit',
            actorId: req.userId,
        });
        if (!result.ok) return bad(res, result.message);
        ok(res, result.request, 201);
    } catch (e) { fail(res, e); }
};

/** Scenario 3 — the employee reviews a pre-filled draft and clicks Apply. */
exports.submitDraft = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return bad(res, ctx.reason, 403);

        const request = await CompOffRequest.findOne({
            _id: req.params.id, teacher: req.userId, school: req.schoolId,
        });
        if (!request) return bad(res, 'Comp Off request not found', 404);

        const result = await compOff.submitDraft(request, ctx, {
            reason: req.body.reason,
            compOffDays: req.body.compOffDays,
        });
        if (!result.ok) return bad(res, result.message);
        ok(res, result.request);
    } catch (e) { fail(res, e); }
};

/** Withdraw one's own draft or pending request. Nothing to reverse — never credited. */
exports.cancelOwn = async (req, res) => {
    try {
        const request = await CompOffRequest.findOne({
            _id: req.params.id, teacher: req.userId, school: req.schoolId,
        });
        if (!request) return bad(res, 'Comp Off request not found', 404);
        if (!['draft', 'pending'].includes(request.status)) {
            return bad(res, 'Only draft or pending Comp Off requests can be cancelled');
        }
        request.status      = 'cancelled';
        request.cancelledAt = new Date();
        await request.save();
        ok(res, request);
    } catch (e) { bad(res, e.message, 500); }
};

exports.myLedger = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return ok(res, { enabled: false, reason: ctx.reason, entries: [] });

        const ay = await getActiveAcademicYearLabel(req.schoolId);
        const entries = await LeaveLedger.find({
            teacher: req.userId, school: req.schoolId,
            leaveType: ctx.leaveType._id, academicYear: ay,
        }).sort({ createdAt: -1 }).limit(200).lean();

        ok(res, { enabled: true, academicYear: ay, entries });
    } catch (e) { bad(res, e.message, 500); }
};

// ── Approver (admin, or a designation-based approver on the teacher router) ───

exports.listRequests = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) {
            return ok(res, { enabled: false, reason: ctx.reason, items: [], total: 0, page: 1, pages: 0 });
        }

        const { status, teacherId, dayCategory, source, fromDate, toDate, page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        if (status)      filter.status      = status;
        if (teacherId)   filter.teacher     = teacherId;
        if (dayCategory) filter.dayCategory = dayCategory;
        if (source)      filter.source      = source;
        if (fromDate || toDate) {
            filter.workDate = {};
            if (fromDate) filter.workDate.$gte = utcMidnight(fromDate);
            if (toDate)   filter.workDate.$lte = utcMidnight(toDate);
        }

        const [items, total, isApprover] = await Promise.all([
            CompOffRequest.find(filter)
                .populate('teacher', 'name email')
                .populate('holiday', 'name type')
                .populate('approvedBy', 'name')
                .sort({ appliedAt: -1, workDate: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            CompOffRequest.countDocuments(filter),
            compOff.canApprove(req.userId, req.userRole, req.schoolId, ctx.policy),
        ]);

        ok(res, {
            enabled: true, isApprover, policy: publicPolicy(ctx.policy),
            items, total, page: +page, pages: Math.ceil(total / +limit),
        });
    } catch (e) { bad(res, e.message, 500); }
};

exports.approve = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return bad(res, ctx.reason, 403);

        const request = await CompOffRequest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!request) return bad(res, 'Comp Off request not found', 404);

        const result = await compOff.approveRequest(request, ctx, {
            actorId:   req.userId,
            actorName: req.user?.name,
            actorRole: req.userRole,
            comment:   req.body.adminComment || req.body.comment || '',
        });
        if (!result.ok) return bad(res, result.message, result.message?.includes('not an approver') ? 403 : 400);

        ok(res, {
            request: result.request,
            credited: result.credited,
            pendingLevels: result.pendingLevels || 0,
        });
    } catch (e) { bad(res, e.message, 500); }
};

exports.reject = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return bad(res, ctx.reason, 403);

        const request = await CompOffRequest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!request) return bad(res, 'Comp Off request not found', 404);

        const result = await compOff.rejectRequest(request, ctx, {
            actorId: req.userId, actorRole: req.userRole,
            comment: req.body.adminComment || req.body.comment || '',
        });
        if (!result.ok) return bad(res, result.message, result.message?.includes('not an approver') ? 403 : 400);
        ok(res, result.request);
    } catch (e) { bad(res, e.message, 500); }
};

// ── Admin only ────────────────────────────────────────────────────────────────

/** Admin raises a Comp Off claim on an employee's behalf. */
exports.adminApplyFor = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return bad(res, ctx.reason, 403);

        const { teacherId, workDate, checkIn, checkOut, workedHours, compOffDays, reason } = req.body;
        if (!teacherId) return bad(res, 'teacherId is required');
        if (!workDate)  return bad(res, 'workDate is required');

        const result = await compOff.createRequest({
            ctx,
            teacherId,
            workDate,
            checkIn: checkIn || '', checkOut: checkOut || '',
            workedHours, compOffDays,
            reason: reason || 'Raised by admin',
            document: req.file ? req.file.filename : null,
            source: 'manual',
            mode: 'submit',
            actorId: req.userId,
        });
        if (!result.ok) return bad(res, result.message);
        ok(res, result.request, 201);
    } catch (e) { fail(res, e); }
};

/**
 * Withdraw an already-approved Comp Off and claw the credit back.
 * Blocked when the days have been spent — the leave has to be reversed first,
 * so a balance can never be pulled out from under an approved leave.
 */
exports.adminCancelApproved = async (req, res) => {
    try {
        const request = await CompOffRequest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!request) return bad(res, 'Comp Off request not found', 404);
        if (request.status !== 'approved') return bad(res, 'Only approved Comp Off requests can be withdrawn');

        const comment = req.body.adminComment || req.body.comment || '';
        const result  = await compOff.reverseCredit(request, {
            entryType: req.body.entryType === 'REVERSED' ? 'REVERSED' : 'CANCELLED',
            actorId: req.userId, comment,
        });

        request.status       = 'cancelled';
        request.cancelledAt  = new Date();
        request.adminComment = comment;
        await request.save();

        const { notify } = require('../services/notifyService');
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '↩️ Comp Off withdrawn',
            body: `Your approved Comp Off for ${fmtDate(request.workDate)} was withdrawn and ${result.reversed} day(s) removed from your balance.${comment ? `\nReason: ${comment}` : ''}`,
            recipients: [request.teacher],
            link: { type: 'compoff.mine', entityId: request._id },
        });
        ok(res, { request, reversed: result.reversed });
    } catch (e) { bad(res, e.message, e.status || 500); }
};

/** Manual ADJUSTMENT — an admin correction, positive or negative. */
exports.adminAdjust = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return bad(res, ctx.reason, 403);

        const { teacherId, days, description } = req.body;
        const delta = Number(days);
        if (!teacherId)   return bad(res, 'teacherId is required');
        if (!delta)       return bad(res, 'days must be a non-zero number (negative to deduct)');
        if (!String(description || '').trim()) return bad(res, 'description is required for an adjustment');

        const ay = await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return bad(res, 'No active academic year');

        if (delta < 0) {
            const bal = await LeaveBalance.findOne({
                teacher: teacherId, school: req.schoolId, leaveType: ctx.leaveType._id, academicYear: ay,
            }).lean();
            if (remainingOf(bal) < Math.abs(delta)) {
                return bad(res, `Cannot deduct ${Math.abs(delta)} day(s) — only ${remainingOf(bal)} available`);
            }
        }

        await LeaveBalance.findOneAndUpdate(
            { teacher: teacherId, school: req.schoolId, leaveType: ctx.leaveType._id, academicYear: ay },
            { $inc: { totalAllocated: delta },
              $setOnInsert: { carriedForward: 0, used: 0, pending: 0, expired: 0 } },
            { upsert: true },
        );

        const entry = await compOff.writeLedger({
            schoolId: req.schoolId, teacherId, leaveTypeId: ctx.leaveType._id, academicYear: ay,
            entryType: 'ADJUSTMENT', days: Math.abs(delta), delta,
            // A positive adjustment is spendable, so it needs a lot to draw from;
            // a negative one takes days away and opens no lot.
            remainingDays: delta > 0 ? delta : 0,
            expiresAt: delta > 0 && ctx.policy.validityDays > 0
                ? new Date(Date.now() + ctx.policy.validityDays * 24 * 60 * 60 * 1000)
                : null,
            source: 'compoff', referenceType: 'Manual',
            description: String(description).trim(), createdBy: req.userId,
        });
        ok(res, entry, 201);
    } catch (e) { bad(res, e.message, 500); }
};

exports.getPolicy = async (req, res) => {
    try {
        const [policy, ctx] = await Promise.all([
            compOff.getPolicy(req.schoolId),
            compOff.resolveContext(req.schoolId),
        ]);
        ok(res, {
            policy,
            enabled: ctx.enabled,
            reason:  ctx.reason || '',
            leaveType: ctx.leaveType
                ? { _id: ctx.leaveType._id, name: ctx.leaveType.name, code: ctx.leaveType.code }
                : null,
            designations: ctx.school?.designations || [],
            modules: {
                leave:      !!ctx.modules?.leave,
                holiday:    !!ctx.modules?.holiday,
                attendance: !!ctx.modules?.attendance,
            },
        });
    } catch (e) { bad(res, e.message, 500); }
};

exports.updatePolicy = async (req, res) => {
    try {
        const policy = await compOff.savePolicy(req.schoolId, req.body || {}, req.userId);
        ok(res, policy);
    } catch (e) { bad(res, e.message, 500); }
};

exports.adminLedger = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return ok(res, { enabled: false, reason: ctx.reason, entries: [], total: 0 });

        const { teacherId, entryType, academicYear, page = 1, limit = 50 } = req.query;
        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);
        const filter = { school: req.schoolId, leaveType: ctx.leaveType._id };
        if (ay)        filter.academicYear = ay;
        if (teacherId) filter.teacher      = teacherId;
        if (entryType) filter.entryType    = entryType;

        const [entries, total] = await Promise.all([
            LeaveLedger.find(filter)
                .populate('teacher', 'name email')
                .sort({ createdAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            LeaveLedger.countDocuments(filter),
        ]);
        ok(res, { enabled: true, academicYear: ay, entries, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { bad(res, e.message, 500); }
};

/** Comp Off balance summary across the school, plus headline counters. */
exports.adminBalances = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return ok(res, { enabled: false, reason: ctx.reason, items: [] });

        const ay = req.query.academicYear || await getActiveAcademicYearLabel(req.schoolId);
        const balances = await LeaveBalance.find({
            school: req.schoolId, leaveType: ctx.leaveType._id, academicYear: ay,
        }).populate('teacher', 'name email').lean();

        const items = balances.map(b => ({
            teacher: b.teacher,
            academicYear: b.academicYear,
            earned:    b.totalAllocated || 0,
            carried:   b.carriedForward || 0,
            used:      b.used    || 0,
            pending:   b.pending || 0,
            expired:   b.expired || 0,
            remaining: remainingOf(b),
        }));
        const totals = items.reduce((t, i) => ({
            earned:    t.earned    + i.earned,
            used:      t.used      + i.used,
            pending:   t.pending   + i.pending,
            expired:   t.expired   + i.expired,
            remaining: t.remaining + i.remaining,
        }), { earned: 0, used: 0, pending: 0, expired: 0, remaining: 0 });

        ok(res, { enabled: true, academicYear: ay, items, totals });
    } catch (e) { bad(res, e.message, 500); }
};

exports.adminReports = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return ok(res, { enabled: false, reason: ctx.reason });

        const { fromDate, toDate, teacherId } = req.query;
        const filter = { school: req.schoolId };
        if (teacherId) filter.teacher = teacherId;
        if (fromDate || toDate) {
            filter.workDate = {};
            if (fromDate) filter.workDate.$gte = utcMidnight(fromDate);
            if (toDate)   filter.workDate.$lte = utcMidnight(toDate);
        }

        const requests = await CompOffRequest.find(filter)
            .populate('teacher', 'name email')
            .sort({ workDate: -1 })
            .lean();

        const byStatus = {};
        const byCategory = {};
        let daysEarned = 0;
        for (const r of requests) {
            byStatus[r.status] = (byStatus[r.status] || 0) + 1;
            byCategory[r.dayCategory] = (byCategory[r.dayCategory] || 0) + 1;
            if (r.status === 'approved') daysEarned += Number(r.creditedDays) || 0;
        }
        ok(res, { enabled: true, requests, summary: { byStatus, byCategory, daysEarned, total: requests.length } });
    } catch (e) { bad(res, e.message, 500); }
};

exports.adminExport = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return bad(res, ctx.reason, 403);

        const { status, fromDate, toDate, teacherId } = req.query;
        const filter = { school: req.schoolId };
        if (status)    filter.status  = status;
        if (teacherId) filter.teacher = teacherId;
        if (fromDate || toDate) {
            filter.workDate = {};
            if (fromDate) filter.workDate.$gte = utcMidnight(fromDate);
            if (toDate)   filter.workDate.$lte = utcMidnight(toDate);
        }

        const requests = await CompOffRequest.find(filter)
            .populate('teacher', 'name email')
            .populate('approvedBy', 'name')
            .sort({ workDate: -1 })
            .lean();

        const profiles = await TeacherProfile.find({ school: req.schoolId }).select('user employeeId designation').lean();
        const byUser = Object.fromEntries(profiles.map(p => [String(p.user), p]));

        const rows = requests.map(r => ({
            employeeId:   byUser[String(r.teacher?._id)]?.employeeId || '',
            employee:     r.teacher?.name  || '',
            email:        r.teacher?.email || '',
            designation:  byUser[String(r.teacher?._id)]?.designation || '',
            workDate:     r.workDate ? new Date(r.workDate).toISOString().slice(0, 10) : '',
            dayCategory:  r.dayCategory,
            dayLabel:     r.dayLabel || '',
            source:       r.source,
            checkIn:      r.checkIn  || '',
            checkOut:     r.checkOut || '',
            workedHours:  r.workedHours || 0,
            compOffDays:  r.compOffDays,
            status:       r.status,
            creditedDays: r.creditedDays || 0,
            creditedAt:   r.creditedAt ? new Date(r.creditedAt).toISOString().slice(0, 10) : '',
            expiresAt:    r.expiresAt  ? new Date(r.expiresAt).toISOString().slice(0, 10)  : '',
            approvedBy:   r.approvedBy?.name || '',
            reason:       r.reason || '',
            adminComment: r.adminComment || '',
        }));

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Comp Off');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="comp_off_requests.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (e) { bad(res, e.message, 500); }
};

/** Run the expiry sweep on demand (it also runs on a schedule in server.js). */
exports.adminRunExpiry = async (req, res) => {
    try {
        const [swept, notified] = await Promise.all([
            compOff.runExpirySweep(req.schoolId),
            compOff.runExpiryNotifications(req.schoolId),
        ]);
        ok(res, { ...swept, ...notified, message: `${swept.expired || 0} day(s) expired, ${notified.notified || 0} reminder(s) sent` });
    } catch (e) { bad(res, e.message, 500); }
};

/**
 * Backfill ready-to-apply drafts from attendance already on record — for a
 * school that switches the attendance module (or auto-generation) on after the
 * fact. Same generator as the live hook, so the duplicate guard still holds.
 */
exports.adminGenerateFromAttendance = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return bad(res, ctx.reason, 403);
        if (!ctx.attendanceModule) return bad(res, 'Attendance module is not enabled for your school');

        const { fromDate, toDate, teacherId } = req.body;
        if (!fromDate || !toDate) return bad(res, 'fromDate and toDate are required');

        const TeacherAttendance = require('../models/TeacherAttendance');
        const filter = {
            school: req.schoolId,
            date: { $gte: utcMidnight(fromDate), $lte: utcMidnight(toDate) },
            status: { $in: ['Present', 'Half-Day'] },
        };
        if (teacherId) filter.teacher = teacherId;

        const records = await TeacherAttendance.find(filter).lean();
        let created = 0;
        const skipped = [];
        for (const rec of records) {
            const r = await compOff.generateFromAttendance(rec, { actorId: req.userId });
            if (r.created) created++;
            else skipped.push({ date: rec.date, teacher: rec.teacher, reason: r.reason });
        }
        ok(res, { scanned: records.length, created, skipped: skipped.slice(0, 50) });
    } catch (e) { bad(res, e.message, 500); }
};

/** Staff list for the admin Comp Off pickers — teachers and admins alike. */
exports.adminEmployees = async (req, res) => {
    try {
        const users = await User.find({
            school: req.schoolId, role: { $in: ['teacher', 'school_admin'] }, isActive: true,
        }).select('name email role').sort({ name: 1 }).lean();
        ok(res, users);
    } catch (e) { bad(res, e.message, 500); }
};
