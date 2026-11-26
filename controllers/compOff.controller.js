'use strict';
/**
 * Comp Off HTTP layer.
 *
 * Every rule lives in services/compOffService — this file only marshals
 * requests, enforces ownership, and shapes responses. In particular there is
 * no `LeaveBalance` write anywhere in this file: crediting is reachable only
 * through compOff.approveRequest().
 */
const pool           = require('../db/pool');
const CompOffRequest = require('../models/CompOffRequest');
const LeaveLedger    = require('../models/LeaveLedger');
const LeaveBalance   = require('../models/LeaveBalance');
const User           = require('../models/User');
const TeacherProfile = require('../models/TeacherProfile');
const XLSX           = require('xlsx');
const compOff        = require('../services/compOffService');
const designations   = require('../services/designationService');
const { getActiveAcademicYearLabel, remainingOf, utcMidnight } = require('../utils/leaveDays');
const { resolvePage } = require('../utils/focusPage');
const { patch } = require('../db/patch');

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

        const { status, page = 1 } = req.query;
        // An employee's own history is a few dozen rows a year; the tab filters
        // and pages it on screen, so it asks for all of it (capped).
        const limit = Math.min(500, Math.max(1, +req.query.limit || 20));
        const filter = { teacher: req.userId, school: req.schoolId };
        if (status) filter.status = status;
        else filter.status = { $ne: 'draft' };   // drafts ride in their own list

        const [requests, total, drafts, balance] = await Promise.all([
            // The employee named on every row (the drawer said "Unknown
            // employee" — the row carried only the id, Nov 26 2026).
            CompOffRequest.find(filter)
                .populate('teacher', 'name email')
                .populate('holiday', 'name type')
                .populate('approvedBy', 'name')
                .sort({ workDate: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            CompOffRequest.countDocuments(filter),
            CompOffRequest.find({ teacher: req.userId, school: req.schoolId, status: 'draft' })
                .populate('teacher', 'name email')
                .populate('holiday', 'name type')
                .sort({ workDate: -1 })
                .lean(),
            balanceFor(req.userId, ctx),
        ]);

        // Whoever the policy names for the second sign-off decides too, so
        // they get the approvals tab even if they approve nothing else.
        const isApprover = await compOff.canApprove(
            req.userId, req.userRole, req.schoolId, ctx.policy,
            await designations.isModuleAdmin(req, 'leave'),
        ) || await compOff.isSecondApprover(req.userId, req.schoolId, ctx.policy);
        // Their own record's number and post, as the office's rows carry them.
        const me = await TeacherProfile.findOne({ user: req.userId, school: req.schoolId })
            .select('employeeId designation department').lean();
        for (const r of [...requests, ...drafts]) {
            if (r.teacher && typeof r.teacher === 'object') {
                r.teacher.employeeId  = me?.employeeId  || '';
                r.teacher.designation = me?.designation || '';
                r.teacher.department  = me?.department  || '';
            }
        }

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

        // Only an administrator asks about someone else. A teacher passing
        // another teacher's id used to learn whether that colleague had a claim
        // on the date.
        const onAdminRoute = req.baseUrl.endsWith('/admin');
        const teacherId = onAdminRoute && req.query.teacherId ? req.query.teacherId : req.userId;

        const classification = await compOff.classifyWorkDate(req.schoolId, day, ctx);
        let hours = workedHours != null && workedHours !== '' && onAdminRoute
            ? Number(workedHours)
            : compOff.hoursBetween(checkIn, checkOut);
        // No times typed: what the attendance register recorded that day — the
        // figure the submit will use ("Auto Calculate").
        let recorded = null;
        if (!(hours > 0)) {
            recorded = await compOff.recordedHours(teacherId, req.schoolId, day);
            if (recorded) hours = recorded.hours;
        }
        const days = hours > 0 ? compOff.computeCompOffDays(hours, ctx.policy) : null;

        const check = await compOff.checkEligibility({
            ctx,
            teacherId,
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
            // Where the hours came from, so the form can say "from your
            // attendance" — and when there are none, that times are needed.
            hoursSource: recorded ? 'attendance' : (hours > 0 ? 'typed' : null),
            checkIn: recorded?.checkIn || null,
            checkOut: recorded?.checkOut || null,
            eligible: check.ok && (onAdminRoute || hours > 0),
            message:  !check.ok ? check.message
                : (!onAdminRoute && !(hours > 0) ? 'Enter the times you worked — there is no attendance record for this date' : ''),
            holidayModule: ctx.holidayModule,
        });
    } catch (e) { bad(res, e.message, 500); }
};

/** Scenarios 1 & 2 — the employee fills the Comp Off form. */
exports.applyCompOff = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return bad(res, ctx.reason, 403);

        const { workDate, checkIn, checkOut, reason } = req.body;
        if (!workDate) return bad(res, 'workDate is required');
        if (!String(reason || '').trim()) return bad(res, 'reason is required');

        const result = await compOff.createRequest({
            ctx,
            teacherId: req.userId,
            workDate,
            checkIn:  checkIn  || '',
            checkOut: checkOut || '',
            // The employee states WHEN they worked; the policy decides what it
            // earns. Days or hours sent in the body are ignored.
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

        const result = await compOff.submitDraft(request, ctx, { reason: req.body.reason });
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
        const saved = await patch(CompOffRequest, request._id,
            { status: 'cancelled', cancelledAt: new Date() }, { where: { status: ['draft', 'pending'] } });
        if (!saved) return bad(res, 'This request was decided a moment ago — refresh to see it', 409);
        if (request.status === 'pending') {
            const ctx = await compOff.resolveContext(req.schoolId);
            if (ctx.policy) {
                compOff.approverIds(req.schoolId, ctx.policy, { exclude: req.userId }).then((recipients) => require('../services/notifyService').notify({
                    school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                    title: '🚫 Comp Off request withdrawn',
                    body: `${req.user?.name || 'A teacher'} withdrew their Comp Off request for ${fmtDate(request.workDate)}.`,
                    recipients, link: { type: 'compoff.approvals', entityId: request._id },
                })).catch(() => {});
            }
        }
        ok(res, saved);
    } catch (e) { bad(res, e.message, 500); }
};

exports.myLedger = async (req, res) => {
    try {
        const ctx = await compOff.resolveContext(req.schoolId);
        if (!ctx.enabled) return ok(res, { enabled: false, reason: ctx.reason, entries: [] });

        const ay = await getActiveAcademicYearLabel(req.schoolId);
        // Named, as the office's ledger is — the drawer said "Unknown
        // employee" when the entry carried only the id (Nov 26 2026).
        const entries = await LeaveLedger.find({
            teacher: req.userId, school: req.schoolId,
            leaveType: ctx.leaveType._id, academicYear: ay,
        }).populate('teacher', 'name email').sort({ createdAt: -1 }).limit(200).lean();
        const me = await TeacherProfile.findOne({ user: req.userId, school: req.schoolId })
            .select('employeeId designation department').lean();
        for (const e of entries) {
            if (e.teacher && typeof e.teacher === 'object') {
                e.teacher.employeeId  = me?.employeeId  || '';
                e.teacher.designation = me?.designation || '';
                e.teacher.department  = me?.department  || '';
            }
        }

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

        // The teacher router serves designation approvers. Anyone else asking it
        // used to receive every claim in the school — names, hours, reasons.
        const moduleAdmin = await designations.isModuleAdmin(req, 'leave');
        const isApprover = await compOff.canApprove(req.userId, req.userRole, req.schoolId, ctx.policy, moduleAdmin);
        // Named for the second sign-off only: sees the claims past their first.
        const secondOnly = !isApprover && await compOff.isSecondApprover(req.userId, req.schoolId, ctx.policy);
        const onAdminRoute = req.baseUrl.endsWith('/admin');
        if (!onAdminRoute && !isApprover && !secondOnly) return bad(res, 'You are not an approver for Comp Off requests', 403);

        const { status, teacherId, dayCategory, source, fromDate, toDate, page = 1, limit = 20, focus } = req.query;
        const filter = { school: req.schoolId };
        // An approver's queue never holds their own claims.
        if (!onAdminRoute) filter.teacher = { $ne: req.userId };
        if (secondOnly) filter.approvalLevel = { $gte: 1 };
        if (status)      filter.status      = status;
        if (teacherId && String(teacherId) !== String(req.userId)) filter.teacher = teacherId;
        else if (teacherId && onAdminRoute) filter.teacher = teacherId;
        if (dayCategory) filter.dayCategory = dayCategory;
        if (source)      filter.source      = source;
        if (fromDate || toDate) {
            filter.workDate = {};
            if (fromDate) filter.workDate.$gte = utcMidnight(fromDate);
            if (toDate)   filter.workDate.$lte = utcMidnight(toDate);
        }

        const sort = { appliedAt: -1, workDate: -1 };
        // Arriving from a notification: open on the page holding that request
        // rather than page 1, where it usually is not.
        const { page: effectivePage, focusFound } =
            await resolvePage(CompOffRequest, filter, sort, +limit, focus, page);

        const [items, total] = await Promise.all([
            CompOffRequest.find(filter)
                .populate('teacher', 'name email')
                .populate('holiday', 'name type')
                .populate('approvedBy', 'name')
                .sort(sort)
                .skip((effectivePage - 1) * +limit)
                .limit(+limit)
                .lean(),
            CompOffRequest.countDocuments(filter),
        ]);

        // The screen's designation line, and the counts behind its tiles.
        //
        // The counts deliberately ignore every filter: they describe the
        // school, and a tile that is also the filter must not move when it is
        // pressed. Counted in Postgres rather than by paging the table.
        const school = String(req.schoolId);
        const monthStart = new Date();
        monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
        const prevStart = new Date(monthStart);
        prevStart.setUTCMonth(prevStart.getUTCMonth() - 1);

        const teacherIds = [...new Set(items.map((r) => r.teacher?._id && String(r.teacher._id)).filter(Boolean))];
        const [byStatus, months, profiles] = await Promise.all([
            pool.query(
                `SELECT "status", count(*)::int AS "n"
                   FROM "${CompOffRequest.tableName}"
                  WHERE "school" = $1::uuid
                  GROUP BY "status"`, [school]),
            pool.query(
                `SELECT count(*) FILTER (WHERE "appliedAt" >= $2)::int                     AS "this",
                        count(*) FILTER (WHERE "appliedAt" >= $3 AND "appliedAt" < $2)::int AS "prev"
                   FROM "${CompOffRequest.tableName}"
                  WHERE "school" = $1::uuid`, [school, monthStart, prevStart]),
            teacherIds.length
                ? TeacherProfile.find({ user: { $in: teacherIds } })
                    .select('user employeeId designation department').lean()
                : Promise.resolve([]),
        ]);

        // designation lives on TeacherProfile, never on User — the populate
        // above can only ever supply the name and the email.
        const byUser = new Map(profiles.map((pr) => [String(pr.user), pr]));
        items.forEach((r) => {
            const pr = r.teacher && byUser.get(String(r.teacher._id));
            if (r.teacher) {
                r.teacher.employeeId  = pr?.employeeId  || '';
                r.teacher.designation = pr?.designation || '';
                r.teacher.department  = pr?.department  || '';
            }
        });
        // Whether THIS user may decide each row — never their own claim, and
        // the second sign-off only by whoever the policy names for it.
        const moduleAdminFlag = moduleAdmin;
        await Promise.all(items.map(async (r) => {
            if (!['pending', 'draft'].includes(r.status) || String(r.teacher?._id || r.teacher) === String(req.userId)) {
                r.canDecide = false; return;
            }
            r.canDecide = compOff.secondRule(ctx.policy) && (Number(r.approvalsRequired) || 1) >= 2
                ? (await compOff.mayDecide(r, ctx.policy, { actorId: req.userId, actorRole: req.userRole, moduleAdmin: moduleAdminFlag })).ok
                : isApprover;
        }));

        const stat = (k) => byStatus.rows.find((x) => x.status === k)?.n || 0;
        const thisMonth = months.rows[0]?.this || 0;
        const prevMonth = months.rows[0]?.prev || 0;

        ok(res, {
            enabled: true, isApprover: isApprover || secondOnly, policy: publicPolicy(ctx.policy),
            items, total, page: effectivePage, pages: Math.ceil(total / +limit),
            counts: {
                total:     byStatus.rows.reduce((n, x) => n + x.n, 0),
                draft:     stat('draft'),
                pending:   stat('pending'),
                approved:  stat('approved'),
                rejected:  stat('rejected'),
                cancelled: stat('cancelled'),
                expired:   stat('expired'),
                // Null rather than 0 when last month had nothing: "+100%" off a
                // base of zero is not a fact about this month.
                monthDeltaPct: prevMonth
                    ? Math.round(((thisMonth - prevMonth) / prevMonth) * 100)
                    : null,
            },
            ...(focus ? { focusFound } : {}),
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
            // A designation granting admin on the leave module makes a teacher
            // an administrator of comp off too — it lives inside leave.
            moduleAdmin: await designations.isModuleAdmin(req, 'leave'),
            comment:   req.body.adminComment || req.body.comment || '',
        });
        if (!result.ok) return bad(res, result.message, result.forbidden ? 403 : 409);

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
            moduleAdmin: await designations.isModuleAdmin(req, 'leave'),
            comment: req.body.adminComment || req.body.comment || '',
        });
        if (!result.ok) return bad(res, result.message, result.forbidden ? 403 : 400);
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
        if (String(teacherId) === String(req.userId)) return bad(res, 'Claim your own Comp Off from My Leave', 403);
        const staff = await User.findOne({ _id: teacherId, school: req.schoolId, role: 'teacher', isActive: true }).select('_id').lean();
        if (!staff) return bad(res, 'Pick a current teacher of this school');

        const result = await compOff.createRequest({
            ctx,
            byAdmin: true,
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

        if (String(request.teacher) === String(req.userId)) return bad(res, 'You cannot withdraw your own Comp Off', 403);

        const comment = String(req.body.adminComment || req.body.comment || '').trim();
        const result  = await compOff.reverseCredit(request, {
            entryType: req.body.entryType === 'REVERSED' ? 'REVERSED' : 'CANCELLED',
            actorId: req.userId, comment,
        });

        await patch(CompOffRequest, request._id,
            { status: 'cancelled', cancelledAt: new Date(), adminComment: comment }, { where: { status: 'approved' } });

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
        if (!delta || !Number.isFinite(delta) || Math.round(delta * 2) !== delta * 2 || Math.abs(delta) > 30)
            return bad(res, 'days must be a non-zero number of whole or half days (negative to deduct)');
        if (!String(description || '').trim()) return bad(res, 'description is required for an adjustment');
        if (String(teacherId) === String(req.userId)) return bad(res, 'You cannot adjust your own Comp Off', 403);
        // A balance is only ever written for a teacher of this school.
        const staff = await User.findOne({ _id: teacherId, school: req.schoolId, role: 'teacher' }).select('_id').lean();
        if (!staff) return bad(res, 'Pick a teacher of this school');

        const ay = await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return bad(res, 'No active academic year');

        const entry = await compOff.adjust({
            ctx, schoolId: req.schoolId, teacherId, academicYear: ay, delta,
            description: String(description).trim(), actorId: req.userId,
        });
        ok(res, entry, 201);
    } catch (e) { bad(res, e.message, e.status || 500); }
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

/**
 * Staff list for the admin Comp Off pickers. Teachers only: comp off is spent
 * as leave, and leave is filed for teachers — a school admin credited comp off
 * could never use it.
 */
exports.adminEmployees = async (req, res) => {
    try {
        const users = await User.find({
            school: req.schoolId, role: 'teacher', isActive: true,
        }).select('name email role').sort({ name: 1 }).lean();
        if (!users.length) return ok(res, []);

        // employeeId, designation, department, joining date and employment type
        // all live on TeacherProfile, never on User. The raise-comp-off dialog
        // shows them beside the picker so an admin can see they have the right
        // person before crediting days in their name.
        const profiles = await TeacherProfile.find({ user: { $in: users.map((u) => String(u._id)) } })
            .select('user employeeId designation department joiningDate employmentType').lean();
        const byUser = new Map(profiles.map((p) => [String(p.user), p]));

        ok(res, users.map((u) => {
            const p = byUser.get(String(u._id));
            return {
                ...u,
                employeeId:     p?.employeeId     || '',
                designation:    p?.designation    || '',
                department:     p?.department     || '',
                joiningDate:    p?.joiningDate    || null,
                employmentType: p?.employmentType || '',
            };
        }));
    } catch (e) { bad(res, e.message, 500); }
};
