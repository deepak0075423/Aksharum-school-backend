'use strict';
const pool             = require('../db/pool');
const LeaveType        = require('../models/LeaveType');
const LeaveApplication = require('../models/LeaveApplication');
const LeaveBalance     = require('../models/LeaveBalance');
const School           = require('../models/School');
const User             = require('../models/User');
const TeacherProfile   = require('../models/TeacherProfile');
const AcademicYear     = require('../models/AcademicYear');
const XLSX             = require('xlsx');
const path             = require('path');
const { notify } = require('../services/notifyService');
const { resolvePage } = require('../utils/focusPage');
const compOff          = require('../services/compOffService');
const leavePolicy      = require('../services/leavePolicyService');
const designations     = require('../services/designationService');
// Status change + balance move + ledger row, as one transaction under one lock.
const { commitTransition, recordAdjustments } = require('../services/leaveBalanceTx');
// Cross-module effects. Each one is gated on the target module's own flag, so a
// school without Attendance or Timetable sees leave behave exactly as before.
const leaveIntegrations = require('../services/leaveIntegrations');
// Working-day / weekly-off arithmetic is shared with the Comp Off engine so the
// two can never disagree about whether a given Saturday is a working day.
const {
    getActiveAcademicYearLabel, academicYearLabel, isSaturdayWorking, countWorkingDays,
    countCalendarDays, countHolidayWorkingDays, normalizeLeaveSettings, remainingOf,
} = require('../utils/leaveDays');

const fmtDate = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

// ── Helpers ───────────────────────────────────────────────────────────────────

// Reports and exports used to run unbounded — every application the school had
// ever filed, populated, with no limit. These keep them to a window.
const REPORT_ROW_CAP = 5000;

/**
 * Restrict a report filter to a date window. Defaults to the academic year the
 * report is about, so the common case reads one year rather than all history.
 */
function withReportWindow(filter, { fromDate, toDate }, academicYearRange) {
    const from = fromDate ? new Date(fromDate) : academicYearRange?.startDate;
    const to   = toDate   ? new Date(toDate)   : academicYearRange?.endDate;
    if (!from && !to) return filter;
    const range = {};
    if (from && !isNaN(new Date(from))) range.$gte = new Date(from);
    if (to   && !isNaN(new Date(to)))   range.$lte = new Date(to);
    return Object.keys(range).length ? { ...filter, fromDate: range } : filter;
}

const isCompOffType = lt => lt?.category === 'compoff' || String(lt?.code || '').toUpperCase() === 'COMPOFF';

// ── Notification audiences ───────────────────────────────────────────────────
//
// Two audiences, and getting them right is the whole point:
//
//   the person whose leave or balance moved  — always told, by name;
//   the administrators of the leave module   — school admins PLUS every teacher
//                                              whose designation grants ADMIN on
//                                              leave, because that designation
//                                              puts them on these very screens.
//
// Everything here is fire-and-forget. notify() never throws and never blocks
// the response, and a failure to resolve an audience returns an empty list —
// an admin action must not fail because a notification could not be addressed.

/** Tell the leave administrators something about the module itself. */
function notifyLeaveAdmins(req, { title, body, link, exclude = [] }) {
    leavePolicy.leaveAdminIds(req.schoolId)
        .then((ids) => {
            const skip = new Set([String(req.userId), ...exclude.filter(Boolean).map(String)]);
            const recipients = ids.filter((id) => !skip.has(String(id)));
            if (!recipients.length) return;
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title, body, recipients,
                link: link || { type: 'leave.manage' },
            });
        })
        .catch(() => {});
}

/**
 * Tell the people whose balances an admin action just moved.
 *
 * Batched into one notification per recipient rather than one per balance row:
 * an allocation run touches every teacher in the school, and five leave types
 * would otherwise be five separate buzzes each. `notify` drops the sender, so
 * an admin allocating to themselves is not told about their own click.
 */
function notifyBalanceChange(req, teacherIds, { title, body, email = false }) {
    const ids = [...new Set((teacherIds || []).map((t) => String(t?._id ?? t)).filter(Boolean))];
    if (!ids.length) return;
    notify({
        school: req.schoolId, sender: req.userId, senderRole: req.userRole,
        title, body, recipients: ids, email,
        link: { type: 'leave.balance' },
    });
}

/** "3 days" / "1 day" — the unit that appears in nearly every message below. */
const days = (n) => `${n} day${Number(n) === 1 ? '' : 's'}`;



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

/**
 * The days of an application that actually draw on the balance. Loss-of-pay
 * days are part of the leave but not of the entitlement, so only this portion
 * is ever held, spent or restored.
 */
const paidOf = (app) => Math.max(0, (app.totalDays || 0) - (app.lopDays || 0));

/**
 * The academic year an application's days belong to.
 *
 * Always the year stamped when it was filed. Applications created before that
 * column existed carry none, so they fall back to the active year — exactly
 * what every handler used to do unconditionally.
 */
async function yearOf(app, schoolId) {
    return app.academicYear || await getActiveAcademicYearLabel(schoolId);
}

// Returns an existing pending/approved leave that overlaps [from, to]
async function getOverlappingLeave(teacherId, schoolId, from, to, excludeId = null) {
    const query = {
        teacher: teacherId,
        school:  schoolId,
        status:  { $in: ['pending', 'approved'] },
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

// ── Admin: the people leave is administered for ──────────────────────────────

/**
 * The staff list the leave admin screens pick from.
 *
 * It exists because /admin/teachers is school-admin-only: a teacher whose
 * designation grants ADMIN on the leave module reaches every leave screen and
 * would find every teacher dropdown on them empty — apply-on-behalf,
 * allocation, clearing, the request filter. This is the same list, behind the
 * leave module's own guard, so the module's admin surface is self-contained.
 */
exports.adminGetEmployees = async (req, res) => {
    try {
        const users = await User.find({ school: req.schoolId, role: 'teacher', isActive: true })
            .select('name email').sort({ name: 1 }).lean();
        if (!users.length) return res.json({ success: true, data: [] });

        // employeeId, designation and department live on TeacherProfile, and a
        // picker that shows a name and an email alone cannot tell two Priya
        // Sharmas apart.
        const profiles = await TeacherProfile.find({ user: { $in: users.map((u) => String(u._id)) } })
            .select('user employeeId designation department joiningDate employmentType').lean();
        const byUser = new Map(profiles.map((p) => [String(p.user), p]));

        res.json({
            success: true,
            data: users.map((u) => {
                const p = byUser.get(String(u._id));
                return {
                    _id: String(u._id),
                    name: u.name,
                    email: u.email,
                    employeeId:  p?.employeeId  || '',
                    designation: p?.designation || '',
                    department:  p?.department  || '',
                    // Shown beside the picker when an admin files on someone's
                    // behalf, so they can see they have the right person.
                    joiningDate:    p?.joiningDate    || null,
                    employmentType: p?.employmentType || '',
                };
            }),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Admin: Leave Types ────────────────────────────────────────────────────────

exports.adminGetLeaveTypes = async (req, res) => {
    try {
        // Accrual, carry forward and encashment live in LeavePolicy — the
        // matching LeaveType columns are only the seed for a type that has no
        // policy row yet, and savePolicy never writes back to them. Serving the
        // raw columns is what made the allocation screen believe a type set to
        // accrue monthly was a plain up-front allocation, so it is merged here
        // and every reader of this endpoint sees the effective rules.
        const policies = await leavePolicy.getAllPolicies(req.schoolId);
        const types = policies.map(p => ({
            ...p.leaveType,
            monthlyAccrual:    p.monthlyAccrual,
            carryForward:      p.carryForward,
            encashable:        p.encashable,
            maxEncashableDays: p.maxEncashableDays,
            // Date rules ride along so the apply form can bound its calendar
            // the moment a type is picked, without waiting on a preview call.
            allowBackdated:      p.allowBackdated,
            backdatedWithinDays: p.backdatedWithinDays,
            advanceNoticeDays:   p.advanceNoticeDays,
            maxConsecutiveDays:  p.maxConsecutiveDays,
        }));
        res.json({ success: true, data: types });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminCreateLeaveType = async (req, res) => {
    try {
        const { name, code, description, category, annualAllocation, monthlyAccrual, carryForward, encashable,
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
            description:                (description || '').trim(),
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
        const { name, code, description, category, annualAllocation, monthlyAccrual, carryForward, encashable,
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
        if (description              !== undefined) update.description              = (description || '').trim();
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
        const LeaveLedger    = require('../models/LeaveLedger');
        const LeavePolicyRow = require('../models/LeavePolicy');
        const [inUse, compOffInUse] = await Promise.all([
            LeaveApplication.exists({ leaveType: req.params.id, school: req.schoolId }),
            CompOffRequest.exists({ leaveType: req.params.id, school: req.schoolId }),
        ]);
        if (inUse || compOffInUse)
            return res.status(400).json({ success: false, message: 'Cannot delete — leave type is in use' });
        const lt = await LeaveType.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });

        // An allocation without its leave type is dead weight: the days can
        // never be spent, and the allocation screen renders a row with a blank
        // type. Everything hanging off the type goes with it — the balances
        // (the allocation), the ledger rows behind them, and the rule set.
        // Applications and comp off requests are the two things that block the
        // delete above, so nothing here can orphan a record with history.
        const [balances, ledger, policy] = await Promise.all([
            LeaveBalance.deleteMany({ school: req.schoolId, leaveType: req.params.id }),
            LeaveLedger.deleteMany({ school: req.schoolId, leaveType: req.params.id }),
            LeavePolicyRow.deleteMany({ school: req.schoolId, leaveType: req.params.id }),
        ]);
        // Destructive and silent otherwise: every allocation of this type went
        // with it. The other administrators find out here rather than from a
        // teacher asking where their days went.
        notifyLeaveAdmins(req, {
            title: '🗑️ Leave type deleted',
            body: `${req.user?.name || 'An administrator'} deleted the "${lt.name}" (${lt.code}) leave type. `
                + `${balances.deletedCount || 0} allocation(s) and its rule set went with it.`,
        });

        res.json({
            success: true,
            deleted: {
                allocations:   balances.deletedCount || 0,
                ledgerEntries: ledger.deletedCount   || 0,
                policies:      policy.deletedCount   || 0,
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * What a delete would take with it. The confirm popup needs to name every
 * teacher who still holds days of this type — deleting it silently wipes those
 * allocations, so the admin sees them first and can back out.
 *
 * Also reports the two things that block a delete outright (applications and
 * comp off requests) so the popup can say why rather than only refusing.
 */
exports.adminGetLeaveTypeImpact = async (req, res) => {
    try {
        const CompOffRequest = require('../models/CompOffRequest');
        const LeaveLedger    = require('../models/LeaveLedger');
        const LeavePolicyRow = require('../models/LeavePolicy');

        const lt = await LeaveType.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });

        const [rawBalances, applications, compOffRequests, ledgerEntries, policyRow, activeAY] = await Promise.all([
            // Deliberately unpopulated: populate() replaces a dangling teacher
            // ref with null, and the raw id is what the distinct-teacher count
            // needs. Names are attached below in one extra query.
            LeaveBalance.find({ school: req.schoolId, leaveType: req.params.id }).lean(),
            LeaveApplication.countDocuments({ school: req.schoolId, leaveType: req.params.id }),
            CompOffRequest.countDocuments({ school: req.schoolId, leaveType: req.params.id }),
            LeaveLedger.countDocuments({ school: req.schoolId, leaveType: req.params.id }),
            LeavePolicyRow.findOne({ school: req.schoolId, leaveType: req.params.id }).lean(),
            getActiveAcademicYearLabel(req.schoolId),
        ]);

        const teacherIds = [...new Set(rawBalances.map(b => String(b.teacher)).filter(Boolean))];
        const teachers = teacherIds.length
            ? await User.find({ _id: { $in: teacherIds }, school: req.schoolId }).select('name employeeId').lean()
            : [];
        const teacherById = Object.fromEntries(teachers.map(t => [String(t._id), t]));

        // Every academic year, not just the active one — the delete removes the
        // lot, so the popup must not under-report by showing only this year.
        const allocations = rawBalances
            .map(b => ({
                _id:            b._id,
                teacher:        {
                    _id:        b.teacher,
                    // A row whose employee has since been removed still holds
                    // days, so it is listed rather than hidden.
                    name:       teacherById[String(b.teacher)]?.name || null,
                    employeeId: teacherById[String(b.teacher)]?.employeeId || null,
                },
                academicYear:   b.academicYear,
                totalAllocated: b.totalAllocated || 0,
                carriedForward: b.carriedForward || 0,
                used:           b.used    || 0,
                pending:        b.pending || 0,
                expired:        b.expired || 0,
                remaining:      remainingOf(b),
            }))
            .sort((a, b) =>
                (a.teacher?.name || '').localeCompare(b.teacher?.name || '')
                || String(b.academicYear).localeCompare(String(a.academicYear)));

        const totals = allocations.reduce((acc, a) => ({
            allocated: acc.allocated + a.totalAllocated + a.carriedForward,
            used:      acc.used      + a.used,
            pending:   acc.pending   + a.pending,
            remaining: acc.remaining + a.remaining,
        }), { allocated: 0, used: 0, pending: 0, remaining: 0 });

        res.json({ success: true, data: {
            leaveType: { _id: lt._id, name: lt.name, code: lt.code, category: lt.category || 'general' },
            academicYear: activeAY,
            canDelete: !applications && !compOffRequests,
            blockers: { applications, compOffRequests },
            allocations,
            teacherCount: teacherIds.length,
            totals,
            ledgerEntries,
            hasPolicy: !!policyRow,
        }});
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
        // A rejected rule is a bad request, not a missing leave type.
        if (!result.ok) return res.status(result.notFound ? 404 : 400).json({ success: false, message: result.message });

        // A policy decides who may apply, who signs off and what it costs. The
        // people who run the module have to know the rules moved under them.
        const name = result.policy?.leaveType?.name || 'a leave type';
        notifyLeaveAdmins(req, {
            title: '⚙️ Leave policy updated',
            body: `${req.user?.name || 'An administrator'} changed the rules for ${name} — eligibility, `
                + 'limits and approval routing all follow this policy.',
            link: { type: 'leave.manage' },
        });

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
        const [policies, designation, moduleAdmin] = await Promise.all([
            leavePolicy.getAllPolicies(req.schoolId),
            // Resolved once and reused — canApprove would otherwise reload the
            // same profile for every leave type in the school.
            leavePolicy.designationOf(req.userId, req.schoolId),
            designations.isModuleAdmin(req, 'leave'),
        ]);

        const mine = [];
        for (const p of policies) {
            if (await leavePolicy.canApprove(req.userId, req.userRole, req.schoolId, p, { designation, moduleAdmin })) {
                mine.push(p.leaveType._id);
            }
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
        const settings = normalizeLeaveSettings(school.leaveSettings);

        // Saturday decides how many days a request costs, so this quietly
        // re-prices every leave taken from here on.
        notifyLeaveAdmins(req, {
            title: '⚙️ Leave settings changed',
            body: `${req.user?.name || 'An administrator'} changed how Saturdays count towards leave — `
                + (settings.saturdayWorking
                    ? `they are working days${settings.saturdayHalfDay ? ', counted as half a day' : ''}.`
                    : 'they no longer count towards a leave request.'),
        });

        res.json({ success: true, data: settings });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Admin: Leave Requests ─────────────────────────────────────────────────────

// ── Admin: landing overview ───────────────────────────────────────────────────

/** A model's table, quoted for interpolation into raw SQL. */
const qt = (Model) => `"${Model.tableName}"`;

/**
 * Today at UTC midnight of the *local* calendar day.
 *
 * Leave dates are written as `new Date(dateStr).setUTCHours(0,0,0,0)` off a
 * local date string, so a plain `new Date()` compared against them is wrong for
 * the hours where the two calendars disagree — 00:00–05:30 IST, when it is
 * still yesterday in UTC and every one of today's absences would be missed.
 */
function localDayUTC(d = new Date()) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return new Date(`${key}T00:00:00.000Z`);
}

/**
 * Everything the leave landing page states as a figure, in one call.
 *
 * The tiles above the queue, the who-is-out-today list beside it and the
 * per-type split are all counted in Postgres rather than by paging the whole
 * application table into JavaScript: a school with three years of leave history
 * has tens of thousands of rows, and the landing page reads five numbers off
 * them.
 *
 * Everything is scoped to the active academic year — which is what the tiles
 * say they are ("This Academic Year"), and the window the admin is actually
 * working in. `onLeaveToday` and `upcoming` are deliberately *not*: a leave
 * that straddles a year boundary is still someone being out of school today.
 */
exports.adminGetLeaveOverview = async (req, res) => {
    try {
        const school = String(req.schoolId);
        const ay     = await getActiveAcademicYearLabel(req.schoolId);
        const ayRow  = ay ? await AcademicYear.findOne({ school: req.schoolId, yearName: ay }).lean() : null;

        // No academic year on record yet — count everything rather than nothing,
        // so a school still setting itself up sees its own data.
        const from = ayRow?.startDate ? new Date(ayRow.startDate) : new Date(0);
        const to   = ayRow?.endDate   ? new Date(ayRow.endDate)   : new Date('2999-12-31');

        const today  = localDayUTC();
        const weekTo = new Date(today);
        weekTo.setUTCDate(weekTo.getUTCDate() + 7);

        const [byStatus, byType, outToday, soon, oldest, staff, allocated] = await Promise.all([
            // The tiles: one row per status, with the days behind each count —
            // "3 pending" and "31 days pending" are different sizes of problem.
            pool.query(
                `SELECT "status",
                        count(*)::int                          AS "requests",
                        coalesce(sum("totalDays"), 0)::float    AS "days",
                        coalesce(sum("lopDays"),   0)::float    AS "lop"
                   FROM ${qt(LeaveApplication)}
                  WHERE "school" = $1 AND "fromDate" >= $2 AND "fromDate" <= $3
                  GROUP BY "status"`,
                [school, from, to],
            ),
            // The split behind the year's leave, for the rail. Cancelled and
            // rejected days were never taken, so they are left out.
            pool.query(
                `SELECT lt."_id", lt."name", lt."code", lt."category",
                        count(*)::int                             AS "requests",
                        coalesce(sum(la."totalDays"), 0)::float    AS "days"
                   FROM ${qt(LeaveApplication)} la
                   JOIN ${qt(LeaveType)} lt ON lt."_id" = la."leaveType"
                  WHERE la."school" = $1 AND la."fromDate" >= $2 AND la."fromDate" <= $3
                    AND la."status" IN ('approved', 'pending')
                  GROUP BY lt."_id", lt."name", lt."code", lt."category"
                  ORDER BY "days" DESC, lt."name"`,
                [school, from, to],
            ),
            // Who is out right now. Half days say which half, because a morning
            // absence and an afternoon one need different cover.
            pool.query(
                `SELECT la."_id", la."teacher", la."toDate", la."leaveMode", la."halfDaySession",
                        u."name", tp."employeeId",
                        lt."name" AS "typeName", lt."code" AS "typeCode"
                   FROM ${qt(LeaveApplication)} la
                   JOIN ${qt(User)} u  ON u."_id"  = la."teacher"
                   JOIN ${qt(LeaveType)} lt ON lt."_id" = la."leaveType"
                   LEFT JOIN ${qt(TeacherProfile)} tp ON tp."user" = u."_id"
                  WHERE la."school" = $1 AND la."status" = 'approved'
                    AND la."fromDate" <= $2 AND la."toDate" >= $2
                  ORDER BY u."name"`,
                [school, today],
            ),
            // Approved leave that has not started yet, inside the next week.
            pool.query(
                `SELECT la."_id", la."fromDate", la."toDate", la."totalDays",
                        u."name", lt."code" AS "typeCode"
                   FROM ${qt(LeaveApplication)} la
                   JOIN ${qt(User)} u  ON u."_id"  = la."teacher"
                   JOIN ${qt(LeaveType)} lt ON lt."_id" = la."leaveType"
                  WHERE la."school" = $1 AND la."status" = 'approved'
                    AND la."fromDate" > $2 AND la."fromDate" <= $3
                  ORDER BY la."fromDate"
                  LIMIT 8`,
                [school, today, weekTo],
            ),
            // How long the queue's oldest request has been sitting. Not windowed
            // to the year: a request stranded since last year is the one worth
            // saying out loud.
            pool.query(
                `SELECT min("appliedAt") AS "since", count(*)::int AS "n"
                   FROM ${qt(LeaveApplication)}
                  WHERE "school" = $1 AND "status" = 'pending'`,
                [school],
            ),
            pool.query(
                `SELECT count(*)::int AS "n"
                   FROM ${qt(User)}
                  WHERE "school" = $1 AND "role" = 'teacher' AND "isActive" = true`,
                [school],
            ),
            // Staff who hold at least one balance row this year. The gap between
            // this and the headcount is what the Allocations tab exists to fix.
            pool.query(
                `SELECT count(DISTINCT "teacher")::int AS "n"
                   FROM ${qt(LeaveBalance)}
                  WHERE "school" = $1 AND "academicYear" = $2`,
                [school, ay || ''],
            ),
        ]);

        const stat = (s) => byStatus.rows.find((r) => r.status === s) || { requests: 0, days: 0, lop: 0 };
        const counts = {
            total:     byStatus.rows.reduce((n, r) => n + r.requests, 0),
            pending:   stat('pending').requests,
            approved:  stat('approved').requests,
            rejected:  stat('rejected').requests,
            cancelled: stat('cancelled').requests,
        };

        const since = oldest.rows[0]?.since;
        const staffCount = staff.rows[0]?.n || 0;

        res.json({
            success: true,
            data: {
                academicYear: ay || null,
                window: ayRow?.startDate
                    ? { startDate: ayRow.startDate, endDate: ayRow.endDate }
                    : null,
                counts,
                days: {
                    pending:  stat('pending').days,
                    approved: stat('approved').days,
                    lop:      stat('approved').lop,
                },
                // Distinct people, not applications — a morning half day and an
                // afternoon one is one teacher out of school, not two.
                onLeaveToday: new Set(outToday.rows.map((r) => String(r.teacher))).size,
                out: outToday.rows.map((r) => ({
                    _id: String(r._id), name: r.name, employeeId: r.employeeId || '',
                    leaveType: r.typeName, code: r.typeCode, toDate: r.toDate,
                    leaveMode: r.leaveMode, halfDaySession: r.halfDaySession,
                })),
                upcoming: soon.rows.map((r) => ({
                    _id: String(r._id), name: r.name, code: r.typeCode,
                    fromDate: r.fromDate, toDate: r.toDate, totalDays: r.totalDays,
                })),
                byType: byType.rows.map((r) => ({
                    _id: String(r._id), name: r.name, code: r.code,
                    category: r.category, requests: r.requests, days: r.days,
                })),
                // Days the oldest untouched request has waited, so the queue tile
                // can say "waiting 6 days" rather than only how many there are.
                oldestPendingDays: since
                    ? Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86400000))
                    : null,
                staff:       staffCount,
                allocated:   allocated.rows[0]?.n || 0,
                unallocated: Math.max(0, staffCount - (allocated.rows[0]?.n || 0)),
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// The orders the queue can be read in. Keyed on columns of the application
// itself — sorting by teacher name would need a join the ORM cannot express,
// and a sort the list silently ignored would be worse than not offering it.
const REQUEST_SORTS = {
    recent:  { fromDate:  -1 },
    oldest:  { fromDate:   1 },
    applied: { appliedAt: -1 },
    longest: { totalDays: -1 },
};

exports.adminGetRequests = async (req, res) => {
    try {
        const { status, teacherId, leaveType, fromDate, toDate, page = 1, limit = 20, focus,
                q, sort: sortKey, mode } = req.query;
        const filter = { school: req.schoolId };
        if (status)    filter.status    = status;
        if (teacherId) filter.teacher   = teacherId;
        if (leaveType) filter.leaveType = leaveType;
        if (mode === 'half_day' || mode === 'full_day') filter.leaveMode = mode;
        if (fromDate || toDate) {
            filter.fromDate = {};
            if (fromDate) filter.fromDate.$gte = new Date(fromDate);
            if (toDate)   filter.fromDate.$lte = new Date(toDate);
        }

        // One search box over four columns across three tables: the teacher's
        // name and employee id, the leave type's name and code, and the reason.
        //
        // The matching ids are resolved first and fed in as an $in rather than
        // joined, because the ORM's $lookup runs in JavaScript and would pull
        // every user and every application into memory to answer it.
        //
        // Wrapped in $and, not assigned to filter.$or: focusPage() sets $or on
        // its own copy of this filter to count the rows ahead of the focused
        // record, and would otherwise overwrite the search — placing the record
        // on a page number worked out from an unsearched list.
        if (q && String(q).trim()) {
            const rx = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const like = { $regex: rx, $options: 'i' };
            const [users, profiles, types] = await Promise.all([
                User.find({ school: req.schoolId, role: 'teacher', name: like }).select('_id').lean(),
                TeacherProfile.find({ school: req.schoolId, employeeId: like }).select('user').lean(),
                LeaveType.find({ school: req.schoolId, $or: [{ name: like }, { code: like }] }).select('_id').lean(),
            ]);
            const teacherIds = [...new Set([
                ...users.map((u) => String(u._id)),
                ...profiles.map((pr) => String(pr.user)),
            ])];
            const any = [{ reason: like }];
            if (teacherIds.length) any.push({ teacher:   { $in: teacherIds } });
            if (types.length)      any.push({ leaveType: { $in: types.map((t) => String(t._id)) } });
            filter.$and = [{ $or: any }];
        }

        // fromDate is indexed alongside (school, status); appliedAt is not, so
        // sorting on it made every page of the queue sort in memory. Newest
        // leave first reads the same to a user, and is the default.
        const sort = REQUEST_SORTS[sortKey] || REQUEST_SORTS.recent;

        // Arriving from a notification: open on the page holding that request
        // rather than page 1, where it usually is not.
        const { page: effectivePage, focusFound } =
            await resolvePage(LeaveApplication, filter, sort, +limit, focus, page);

        const [apps, total] = await Promise.all([
            LeaveApplication.find(filter)
                .populate('teacher',  'name email employeeId')
                .populate('leaveType','name code category')
                .populate('approvedBy','name')
                .sort(sort)
                .skip((effectivePage - 1) * +limit)
                .limit(+limit)
                .lean(),
            LeaveApplication.countDocuments(filter),
        ]);

        // employeeId, designation and department live on TeacherProfile, never
        // on User — the populate above asked User for an employeeId it does not
        // have, so the id line under every teacher's name rendered empty. One
        // query for the page's teachers, rather than a populate per row.
        const teacherIds = [...new Set(apps.map((a) => a.teacher?._id && String(a.teacher._id)).filter(Boolean))];
        const profiles = teacherIds.length
            ? await TeacherProfile.find({ user: { $in: teacherIds } })
                .select('user employeeId designation department').lean()
            : [];
        const byUser = new Map(profiles.map((pr) => [String(pr.user), pr]));
        apps.forEach((a) => {
            const pr = a.teacher && byUser.get(String(a.teacher._id));
            if (a.teacher) {
                a.teacher.employeeId  = pr?.employeeId  || '';
                a.teacher.designation = pr?.designation || '';
                a.teacher.department  = pr?.department  || '';
            }
        });

        res.json({
            success: true, data: apps, total,
            page: effectivePage, pages: Math.ceil(total / +limit),
            // false tells the caller the record is not in this filtered set, so
            // it can widen the filters instead of showing a page without it.
            ...(focus ? { focusFound } : {}),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminApplyLeave = async (req, res) => {
    try {
        const { teacherId, leaveTypeId, fromDate, toDate, leaveMode, halfDaySession, reason } = req.body;
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
        // Days past the balance are refused exactly as before, unless the type
        // is unpaid or the policy allows the overrun as loss of pay.
        const split = leavePolicy.splitPaidAndLop(
            policy, ltDoc, totalDays, leavePolicy.spendableFrom(policy, remaining));
        if (!split.ok) return res.status(400).json({ success: false, message: split.message });

        const app = await LeaveApplication.create({
            teacher: teacherId, school: req.schoolId, leaveType: leaveTypeId,
            fromDate: from, toDate: to, totalDays, academicYear: ay, lopDays: split.lopDays,
            leaveMode: leaveMode || 'full_day',
            halfDaySession: leaveMode === 'half_day' ? (halfDaySession === 'second' ? 'second' : 'first') : 'first',
            reason, document: documentPath, appliedAt: new Date(),
            // Leave takes one sign-off — the two-level policy option was removed.
            approvalsRequired: 1,
            approvalLevel: 0, approvals: [],
        });
        // Only the paid portion is held. LOP days draw on no entitlement, so
        // holding them would understate the balance for no reason.
        if (split.paidDays > 0) {
            await LeaveBalance.updateOne(
                { teacher: teacherId, school: req.schoolId, leaveType: leaveTypeId, academicYear: ay },
                { $inc: { pending: split.paidDays } }
            );
        }

        // Filed FOR somebody. They were not in the room when it happened, so
        // this is the only way they learn that days were spent in their name.
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📝 Leave applied on your behalf',
            body: `${req.user?.name || 'An administrator'} filed a ${ltDoc.name} request for you from `
                + `${fmtDate(from)} to ${fmtDate(to)} (${days(totalDays)})`
                + `${split.lopDays ? `, of which ${days(split.lopDays)} are loss of pay` : ''}.`
                + `\nReason: ${reason}`
                + '\nIt still needs the usual approval. Tell your school office if this is not right.',
            recipients: [teacherId],
            email: true,
            link: { type: 'leave.mine', entityId: app._id },
        });
        // And the other approvers, so a request filed by one admin does not sit
        // invisible to the rest of the queue.
        leavePolicy.approverIds(req.schoolId, policy).then((recipients) => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📋 Leave request filed on behalf',
            body: `${req.user?.name || 'An administrator'} filed a ${ltDoc.name} request for a teacher, `
                + `${fmtDate(from)} to ${fmtDate(to)} (${days(totalDays)}). It is waiting for a decision.`,
            recipients,
            link: { type: 'leave.approvals', entityId: app._id },
        })).catch(() => {});

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

/**
 * Live preview for the "apply on behalf of a teacher" form.
 *
 * Two questions the admin cannot answer by looking at the form: how many days
 * this teacher still has of the chosen type, and how many days the chosen date
 * range will actually cost once weekends, school holidays and the type's own
 * sandwich rule are applied. Both are answered here, by the same helpers the
 * real submit uses, so the number shown is the number that will be charged.
 *
 * Everything is optional except teacherId + leaveTypeId. Date problems come
 * back as `days.error` inside a 200 rather than a 400: this is a preview the
 * form paints while the user is still typing, not a failed submission.
 */
async function buildApplyPreview({ schoolId, teacherId, leaveTypeId, fromDate, toDate, leaveMode = 'full_day', onBehalf }) {
        if (!teacherId || !leaveTypeId)
            return { status: 400, body: { success: false, message: 'teacherId and leaveTypeId are required' } };

        const ltDoc = await LeaveType.findOne({ _id: leaveTypeId, school: schoolId }).lean();
        if (!ltDoc) return { status: 404, body: { success: false, message: 'Leave type not found' } };

        const [school, ay, policy] = await Promise.all([
            School.findById(schoolId).select('leaveSettings modules').lean(),
            getActiveAcademicYearLabel(schoolId),
            leavePolicy.getPolicy(schoolId, ltDoc),
        ]);
        const leaveSettings = normalizeLeaveSettings(school?.leaveSettings);
        const holidayModule = !!school?.modules?.holiday;

        // Read-only: an unallocated teacher must not get a balance row just for
        // opening the form, so this looks the row up instead of upserting it.
        const balRow = ay
            ? await LeaveBalance.findOne({ teacher: teacherId, school: schoolId, leaveType: leaveTypeId, academicYear: ay }).lean()
            : null;
        const remaining = remainingOf(balRow);
        const balance = {
            allocated:      !!balRow,
            academicYear:   ay,
            totalAllocated: balRow?.totalAllocated || 0,
            carriedForward: balRow?.carriedForward || 0,
            used:           balRow?.used    || 0,
            pending:        balRow?.pending || 0,
            expired:        balRow?.expired || 0,
            remaining,
            // What an application may actually draw — larger than `remaining`
            // when the policy permits an overdraft.
            spendable:      leavePolicy.spendableFrom(policy, remaining),
            // Comp off is earned per approved request, so its annual figure is
            // deliberately 0 and must not be shown as an entitlement.
            annualAllocation: isCompOffType(ltDoc) ? null : (ltDoc.annualAllocation || 0),
        };

        let days = null;
        if (fromDate && toDate) {
            const from = new Date(fromDate);
            const to   = new Date(toDate);
            from.setUTCHours(0, 0, 0, 0);
            to.setUTCHours(0, 0, 0, 0);

            if (isNaN(from.getTime()) || isNaN(to.getTime())) {
                days = { error: 'Invalid date format' };
            } else if (to < from) {
                days = { error: 'To date must be on or after From date' };
            } else {
                const counted = await computeLeaveDays({
                    schoolId: schoolId, from, to, leaveMode, policy, leaveSettings, holidayModule,
                });
                const calendarDays = countCalendarDays(from, to);
                const workingDays  = countWorkingDays(from, to, leaveSettings);
                const holidayDays  = holidayModule
                    ? await countHolidayWorkingDays(from, to, schoolId, leaveSettings)
                    : 0;
                // Split the preview the same way the submit will, so "3 of
                // these 5 days are unpaid" is visible before filing.
                const previewSplit = counted.error ? null : leavePolicy.splitPaidAndLop(
                    policy, ltDoc, counted.totalDays, leavePolicy.spendableFrom(policy, remaining));
                days = {
                    error:        counted.error || (previewSplit && !previewSplit.ok ? previewSplit.message : null),
                    lopDays:      previewSplit?.ok ? previewSplit.lopDays : 0,
                    paidDays:     previewSplit?.ok ? previewSplit.paidDays : 0,
                    // What the balance will be charged. Equals workingDays minus
                    // holidays normally, calendarDays under the sandwich rule,
                    // and 0.5 for a half day.
                    totalDays:    counted.totalDays ?? 0,
                    calendarDays,
                    workingDays,
                    holidayDays,
                    weeklyOffDays: Math.max(0, calendarDays - workingDays),
                    sandwiched:   !!counted.sandwiched,
                    leaveMode:    leaveMode === 'half_day' ? 'half_day' : 'full_day',
                };
            }
        }

        // Soft check only — the form still submits, and the real validation runs
        // again on POST. `onBehalf` mirrors adminApplyLeave: notice-period and
        // back-dating rules bind the employee, not the admin filing for them.
        let warning = null;
        if (days && !days.error) {
            const [overlap, check] = await Promise.all([
                getOverlappingLeave(teacherId, schoolId, new Date(fromDate), new Date(toDate)),
                leavePolicy.validateApplication({
                    schoolId: schoolId, policy, teacherId,
                    from: new Date(fromDate), to: new Date(toDate),
                    totalDays: days.totalDays, leaveMode, hasDocument: true, onBehalf,
                }),
            ]);
            if (overlap) warning = 'This teacher already has a leave application overlapping these dates';
            else if (!check.ok) warning = check.message;
        }

        return { status: 200, body: { success: true, data: {
            leaveType: { _id: ltDoc._id, name: ltDoc.name, code: ltDoc.code, category: ltDoc.category || 'general' },
            balance,
            days,
            warning,
            // What the calendar may offer. Back-dating binds everyone; the notice
            // period is the employee's obligation, so it is waived for onBehalf.
            dateRules: {
                allowBackdated:      policy.allowBackdated,
                backdatedWithinDays: policy.backdatedWithinDays,
                advanceNoticeDays:   onBehalf ? 0 : policy.advanceNoticeDays,
                minDaysPerApplication: policy.minDaysPerApplication,
                maxConsecutiveDays:  policy.maxConsecutiveDays,
                halfDayAllowed:      policy.halfDayAllowed,
                requiresDocument:    policy.requiresDocument,
                documentRequiredAfterDays: policy.documentRequiredAfterDays,
            },
            // With loss of pay available an over-balance request is no longer a
            // hard stop — the excess is simply unpaid, and days.error carries
            // the refusal when it genuinely cannot go through.
            sufficient: !days || !!days.error || (days.paidDays ?? days.totalDays) <= balance.spendable,
        }}};
}

/** Preview for an admin filing on someone else's behalf. */
exports.adminApplyPreview = async (req, res) => {
    try {
        const { teacherId, leaveTypeId, fromDate, toDate, leaveMode } = req.query;
        const r = await buildApplyPreview({
            schoolId: req.schoolId, teacherId, leaveTypeId, fromDate, toDate, leaveMode, onBehalf: true,
        });
        res.status(r.status).json(r.body);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/** The same preview for the employee's own application. */
exports.teacherApplyPreview = async (req, res) => {
    try {
        const { leaveTypeId, fromDate, toDate, leaveMode } = req.query;
        const r = await buildApplyPreview({
            schoolId: req.schoolId, teacherId: req.userId, leaveTypeId, fromDate, toDate, leaveMode, onBehalf: false,
        });
        res.status(r.status).json(r.body);
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
        const moduleAdmin = await designations.isModuleAdmin(req, 'leave');
        if (!await leavePolicy.canApprove(req.userId, req.userRole, req.schoolId, policy, { moduleAdmin }))
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
                link: { type: 'leave.mine', entityId: app._id },
            });
            // A second sign-off has to come from somebody else, so somebody
            // else has to be told it is waiting. notify() drops the sender, so
            // the approver who just signed is not asked to sign again.
            leavePolicy.approverIds(req.schoolId, policy).then(recipients => notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '⏳ Leave still needs a sign-off',
                body: `A leave request for ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)} cleared level `
                    + `${app.approvalLevel} of ${required} and is waiting on its final approval.`,
                recipients,
                link: { type: 'leave.approvals', entityId: app._id },
            })).catch(() => {});
            return res.json({ success: true, data: app, pendingLevels: required - app.approvalLevel });
        }

        // The year the application was filed against, not whichever is active
        // now — a rollover between applying and approving used to release the
        // held days into a row that did not exist.
        const ay = await yearOf(app, req.schoolId);

        // Status and balance move together. Previously the save landed first and
        // a crash before the balance write left leave approved but not deducted.
        const approvedAt = new Date();
        const paid = paidOf(app);
        const moved = await commitTransition({
            schoolId: req.schoolId, appId: app._id, teacherId: app.teacher,
            leaveTypeId: app.leaveType, academicYear: ay,
            // Lost-race guard: this handler read the application before taking
            // the lock, so the status is confirmed again inside it.
            expectStatus: ['pending'],
            statusPatch: { status: 'approved', approvedBy: String(req.userId), approvedAt },
            inc: { used: paid, pending: -paid },
            // A wholly unpaid leave moves no entitlement, so it gets no ledger
            // row — the ledger tracks days, and none were spent.
            ledger: paid > 0 ? {
                entryType: 'USED', days: paid, delta: -paid,
                createdBy: req.userId,
                description: `Leave ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)} approved`
                    + (app.lopDays > 0 ? ` (${app.lopDays} day(s) loss of pay)` : ''),
            } : null,
        });
        if (!moved.applied)
            return res.status(400).json({ success: false, message: `Already ${moved.currentStatus || 'processed'} by someone else` });
        app.status     = 'approved';
        app.approvedBy = req.userId;
        app.approvedAt = approvedAt;

        // Comp Off leave draws down the FIFO ledger lots (oldest expiry first)
        // and records a USED entry alongside the balance move.
        const ltDoc = await LeaveType.findById(app.leaveType).lean();
        if (isCompOffType(ltDoc)) {
            await compOff.consumeForLeave(app, { actorId: req.userId, academicYear: ay })
                .catch(e => console.error('[compOff] consume failed:', e.message));
        }

        // Downstream effects, each gated on its own module flag and each
        // best-effort — neither may undo an approval that has already committed.
        leaveIntegrations.markAttendanceForLeave(app, req.schoolId)
            .catch(e => console.error('[leave→attendance]', e.message));
        leaveIntegrations.requestSubstituteCover(app, req.schoolId)
            .catch(e => console.error('[leave→substitute]', e.message));

        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '✅ Leave request approved',
            body: `Your leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} (${app.totalDays} day${app.totalDays === 1 ? '' : 's'}) has been approved.${app.adminComment ? `\nComment: ${app.adminComment}` : ''}`,
            recipients: [app.teacher],
            email: true,
            link: { type: 'leave.mine', entityId: app._id },
        });
        res.json({ success: true, data: app });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminRejectRequest = async (req, res) => {
    try {
        const { adminComment } = req.body;
        const app = await LeaveApplication.findOne({ _id: req.params.id, school: req.schoolId });
        if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });
        if (app.status !== 'pending')
            return res.status(400).json({ success: false, message: 'Cannot reject in current status' });

        const policy = await leavePolicy.getPolicy(req.schoolId, app.leaveType);
        const moduleAdmin = await designations.isModuleAdmin(req, 'leave');
        if (policy && !await leavePolicy.canApprove(req.userId, req.userRole, req.schoolId, policy, { moduleAdmin }))
            return res.status(403).json({ success: false, message: 'You are not an approver for this leave type' });

        app.status      = 'rejected';
        app.rejectedAt  = new Date();
        app.adminComment = adminComment || '';
        await app.save();

        // Only a pending application reaches here, so its days are still held by
        // the pending count set on apply — release them. No ledger row: a hold
        // that is released was never consumed, and SUM(delta) must stay a true
        // position.
        const ay = await yearOf(app, req.schoolId);
        await commitTransition({
            schoolId: req.schoolId, appId: app._id, teacherId: app.teacher,
            leaveTypeId: app.leaveType, academicYear: ay,
            inc: { pending: -paidOf(app) },
        });
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '❌ Leave request rejected',
            body: `Your leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} has been rejected.${app.adminComment ? `\nReason: ${app.adminComment}` : ''}`,
            recipients: [app.teacher],
            email: true,
            link: { type: 'leave.mine', entityId: app._id },
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

        const ay = await yearOf(app, req.schoolId);
        const reversed = await commitTransition({
            schoolId: req.schoolId, appId: app._id, teacherId: app.teacher,
            leaveTypeId: app.leaveType, academicYear: ay,
            expectStatus: ['approved'],
            inc: { used: -paidOf(app) },
            ledger: paidOf(app) > 0 ? {
                entryType: 'REVERSED', days: paidOf(app), delta: paidOf(app),
                createdBy: req.userId,
                description: `Approval reversed for ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)}`,
            } : null,
        });
        if (!reversed.applied)
            return res.status(400).json({ success: false, message: `Already ${reversed.currentStatus || 'processed'} by someone else` });

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

        // The leave no longer stands, so the register rows it created go too.
        leaveIntegrations.clearAttendanceForLeave(app, req.schoolId)
            .catch(e => console.error('[leave→attendance]', e.message));

        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '↩️ Approved leave reversed',
            body: `Your approved leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} has been reversed and ${app.totalDays} day(s) restored to your balance.${adminComment ? `\nReason: ${adminComment}` : ''}`,
            recipients: [app.teacher],
            email: true,
            link: { type: 'leave.mine', entityId: app._id },
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
        // Served here rather than left to /admin/academic-years, which sits behind
        // the general admin guard — a designation-based leave admin cannot reach
        // that one, and the carry-forward and proration UI both need this list.
        const years = await AcademicYear.find({ school: req.schoolId }).lean();
        const academicYears = years
            .map(y => ({ label: academicYearLabel(y), startDate: y.startDate, endDate: y.endDate, status: y.status }))
            .filter(y => y.label)
            .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

        // employeeId, designation and department live on TeacherProfile, never on
        // User — the populate above asks User for an employeeId it does not
        // have. One query for the teachers on this page rather than a populate
        // per balance row.
        const teacherIds = [...new Set(balances.map((b) => b.teacher?._id && String(b.teacher._id)).filter(Boolean))];
        const profiles = teacherIds.length
            ? await TeacherProfile.find({ user: { $in: teacherIds } })
                .select('user employeeId designation department').lean()
            : [];
        const byUser = new Map(profiles.map((pr) => [String(pr.user), pr]));
        balances.forEach((b) => {
            const pr = b.teacher && byUser.get(String(b.teacher._id));
            if (b.teacher) {
                b.teacher.employeeId  = pr?.employeeId  || '';
                b.teacher.designation = pr?.designation || '';
                b.teacher.department  = pr?.department  || '';
            }
        });

        res.json({ success: true, data: balances, leaveTypes: withPolicy, academicYear: ay, academicYears });
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

        // Precedence, most explicit first. Proration is deliberately NOT gated on
        // `accrues`: an accruing type that is being handed its days up front can
        // still be prorated for a mid-year start, and silently ignoring the
        // admin's choice here is what used to hand out the full annual figure.
        let totalAllocated;
        let prorated = false;
        if (overrideDays !== undefined && overrideDays !== null && overrideDays !== '') {
            totalAllocated = Number(overrideDays);
        } else if (accrues && !giveFullAllocation) {
            // Monthly accrual: start at 0, the accrual sweep credits each month
            totalAllocated = 0;
        } else if (useProration) {
            const activeAY = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
            if (activeAY?.startDate && activeAY?.endDate) {
                const now = new Date();
                const end = new Date(activeAY.endDate);
                const remainMs = Math.max(0, end - now);
                const totalMs  = Math.max(1, end - new Date(activeAY.startDate));
                totalAllocated = Math.max(1, Math.ceil(lt.annualAllocation * remainMs / totalMs));
                prorated = true;
            } else {
                // Nothing to prorate against — say so rather than quietly hand
                // out the full year, which is indistinguishable from a bug.
                return res.status(400).json({ success: false, message: 'Cannot prorate — the active academic year has no start and end date' });
            }
        } else {
            totalAllocated = lt.annualAllocation;
        }

        const set = { totalAllocated };
        // Re-baselining an accruing type restarts its monthly clock from today,
        // so the sweep credits from the next month boundary rather than
        // immediately paying out every month since the row was first created.
        if (accrues) set.lastAccrualAt = new Date();

        const ops = teachers.map(t => ({
            updateOne: {
                filter: { teacher: t._id, school: req.schoolId, leaveType: leaveTypeId, academicYear: ay },
                update: { $set: set },
                upsert: true,
            },
        }));
        await LeaveBalance.bulkWrite(ops);

        // The allocation is a balance change like any other, so it goes on the
        // ledger too — previously only comp off left any trace.
        await recordAdjustments(teachers.map(t => ({
            school: req.schoolId, teacher: t._id, leaveType: leaveTypeId, academicYear: ay,
            entryType: 'ADJUSTMENT', days: totalAllocated, delta: totalAllocated,
            balanceAfter: totalAllocated, createdBy: req.userId, source: 'manual',
            description: prorated
                ? `Allocated ${totalAllocated} day(s), prorated from ${lt.annualAllocation}`
                : `Allocated ${totalAllocated} day(s)`,
        })));

        const suffix = prorated
            ? ` (prorated from ${lt.annualAllocation})`
            : accrues && totalAllocated === 0
                ? ` — ${ltPolicy.monthlyAccrual.daysPerMonth} day(s)/month will be credited automatically`
                : '';

        // Their entitlement for the year just changed. An allocation nobody is
        // told about is a balance people discover only when they try to spend it.
        notifyBalanceChange(req, teachers.map((t) => t._id), {
            title: `📗 ${lt.name} allocated`,
            body: accrues && totalAllocated === 0
                ? `Your ${lt.name} balance for ${ay} starts at 0 and earns `
                    + `${ltPolicy.monthlyAccrual.daysPerMonth} day(s) each month.`
                : `You have been allocated ${days(totalAllocated)} of ${lt.name} for ${ay}`
                    + `${prorated ? `, prorated from the full ${days(lt.annualAllocation)} because of your start date` : ''}.`,
        });

        res.json({
            success: true, allocated: teachers.length, totalAllocated, prorated, accrues,
            message: `Allocated ${totalAllocated} day(s) to ${teachers.length} teacher(s)${suffix}`,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Zeroes an allocation without erasing the teacher's history.
 *
 * `totalAllocated` and `carriedForward` go to 0; `used` and `pending` are left
 * alone, so leave already taken still reconciles against the ledger and an
 * approved application never points at a balance that forgot it was spent.
 *
 * Only existing rows are touched — clearing must never enrol somebody, so there
 * is no upsert here.
 */
exports.adminClearAllocations = async (req, res) => {
    try {
        const { teacherIds, excludeIds = [], leaveTypeId, academicYear } = req.body;
        if (!leaveTypeId) return res.status(400).json({ success: false, message: 'leaveTypeId is required' });
        if (!teacherIds)  return res.status(400).json({ success: false, message: 'teacherIds is required' });

        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const lt = await LeaveType.findOne({ _id: leaveTypeId, school: req.schoolId }).lean();
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });

        // Same resolution as adminAllocate, so "all except these two" means the
        // same set on both screens.
        const isAll = teacherIds === 'all' || (Array.isArray(teacherIds) && teacherIds[0] === 'all');
        let ids;
        if (isAll) {
            const excludeFilter = excludeIds.length ? { _id: { $nin: excludeIds } } : {};
            const teachers = await User.find({ school: req.schoolId, role: 'teacher', isActive: true, ...excludeFilter })
                .select('_id').lean();
            ids = teachers.map(t => t._id);
        } else {
            ids = Array.isArray(teacherIds) ? teacherIds : [teacherIds];
        }
        if (!ids.length) return res.json({ success: true, cleared: 0, message: 'No teachers matched' });

        const filter = { school: req.schoolId, leaveType: leaveTypeId, academicYear: ay, teacher: { $in: ids } };
        const affected = await LeaveBalance.find(filter).lean();
        if (!affected.length)
            return res.json({ success: true, cleared: 0, message: 'No allocations to clear for the selected teachers' });

        const set = { totalAllocated: 0, carriedForward: 0 };
        // A cleared accruing type starts earning again from today rather than
        // immediately paying out every month since it was first allocated.
        const ltPolicy = await leavePolicy.getPolicy(req.schoolId, lt);
        if (ltPolicy?.monthlyAccrual?.enabled) set.lastAccrualAt = new Date();

        await LeaveBalance.updateMany(filter, { $set: set });

        await recordAdjustments(affected.map(b => {
            const removed = (b.totalAllocated || 0) + (b.carriedForward || 0);
            return {
                school: req.schoolId, teacher: b.teacher, leaveType: leaveTypeId, academicYear: ay,
                entryType: 'ADJUSTMENT', days: removed, delta: -removed,
                balanceAfter: 0, createdBy: req.userId, source: 'manual',
                description: `Allocation cleared — ${removed} day(s) removed`,
            };
        }));

        const daysRemoved = affected.reduce((n, b) => n + (b.totalAllocated || 0) + (b.carriedForward || 0), 0);
        const stillPending = affected.reduce((n, b) => n + (b.pending || 0), 0);

        // Days were taken away. That is exactly the change somebody must not
        // find out about by having an application refused.
        notifyBalanceChange(req, affected.map((b) => b.teacher), {
            title: `📕 ${lt.name} allocation cleared`,
            body: `Your ${lt.name} allocation for ${ay} has been cleared. Leave already taken is unaffected, `
                + 'but there is nothing left to apply against until it is allocated again.',
            email: true,
        });

        res.json({
            success: true,
            cleared: affected.length,
            daysRemoved,
            stillPending,
            message: `Cleared ${lt.name} for ${affected.length} teacher(s) — ${daysRemoved} day(s) removed`,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Year-end closure & exit settlement ───────────────────────────────────────

/**
 * What closing a year would do, without doing it.
 *
 * Carry-forward moved days between years but nothing ever *closed* one, so
 * un-carried days never lapsed and a finished year's balances stayed editable
 * indefinitely. This is the preview the confirm screen shows.
 */
exports.adminGetYearClosePreview = async (req, res) => {
    try {
        const { academicYear } = req.query;
        if (!academicYear) return res.status(400).json({ success: false, message: 'academicYear is required' });

        const [balances, openApps, activeAY] = await Promise.all([
            LeaveBalance.find({ school: req.schoolId, academicYear }).lean(),
            LeaveApplication.countDocuments({
                school: req.schoolId, academicYear,
                status: 'pending',
            }),
            getActiveAcademicYearLabel(req.schoolId),
        ]);

        const types = await LeaveType.find({ school: req.schoolId }).lean();
        const byType = Object.fromEntries(types.map(t => [String(t._id), t]));
        const teacherIds = [...new Set(balances.map(b => String(b.teacher)))];
        const teachers = teacherIds.length
            ? await User.find({ _id: { $in: teacherIds }, school: req.schoolId }).select('name employeeId').lean()
            : [];
        const byTeacher = Object.fromEntries(teachers.map(t => [String(t._id), t]));

        const rows = balances
            .map(b => ({
                _id: b._id,
                teacher: { _id: b.teacher, name: byTeacher[String(b.teacher)]?.name || null },
                leaveType: { _id: b.leaveType, code: byType[String(b.leaveType)]?.code || null },
                remaining: remainingOf(b),
            }))
            .filter(r => r.remaining > 0);

        res.json({ success: true, data: {
            academicYear,
            isActiveYear: academicYear === activeAY,
            // Closing the year an employee is still applying against would strand
            // their request, so this has to be cleared first.
            openApplications: openApps,
            canClose: openApps === 0 && academicYear !== activeAY,
            balanceRows: balances.length,
            lapsing: rows,
            daysLapsing: Math.round(rows.reduce((n, r) => n + r.remaining, 0) * 100) / 100,
        }});
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Close an academic year: lapse whatever is left and stop the year accruing.
 *
 * Run carry-forward FIRST — this deliberately does not carry anything, because
 * a close that silently moved days would make the two operations impossible to
 * reason about. Whatever is still standing here is what the school intends to
 * expire.
 */
exports.adminCloseAcademicYear = async (req, res) => {
    try {
        const { academicYear } = req.body;
        if (!academicYear) return res.status(400).json({ success: false, message: 'academicYear is required' });

        const activeAY = await getActiveAcademicYearLabel(req.schoolId);
        if (academicYear === activeAY)
            return res.status(400).json({ success: false, message: 'Cannot close the active academic year — activate the next year first' });

        const openApps = await LeaveApplication.countDocuments({
            school: req.schoolId, academicYear,
            status: 'pending',
        });
        if (openApps)
            return res.status(400).json({ success: false, message: `${openApps} application(s) are still awaiting a decision for ${academicYear} — settle them first` });

        const balances = await LeaveBalance.find({ school: req.schoolId, academicYear }).lean();
        const ops = [];
        const ledger = [];
        for (const b of balances) {
            const left = remainingOf(b);
            if (left <= 0) continue;
            // `expired` is the existing lapse counter — remainingOf already
            // subtracts it, so the row lands at zero without rewriting history.
            ops.push({ updateOne: { filter: { _id: b._id }, update: { $inc: { expired: left } } } });
            ledger.push({
                school: req.schoolId, teacher: b.teacher, leaveType: b.leaveType, academicYear,
                entryType: 'EXPIRED', days: left, delta: -left, balanceAfter: 0,
                createdBy: req.userId, source: 'system',
                description: `${academicYear} closed — ${left} unused day(s) lapsed`,
            });
        }
        if (ops.length) await LeaveBalance.bulkWrite(ops);
        await recordAdjustments(ledger);

        // Days lapsed. The teacher who lost them is told what and how much; the
        // administrators are told the year is shut, because it is the one leave
        // action that cannot be undone from any screen.
        const lapsedPer = new Map();
        for (const row of ledger) {
            const k = String(row.teacher);
            lapsedPer.set(k, (lapsedPer.get(k) || 0) + row.days);
        }
        for (const [teacherId, total] of lapsedPer) {
            notifyBalanceChange(req, [teacherId], {
                title: '⌛ Unused leave lapsed',
                body: `${academicYear} has been closed. ${days(Math.round(total * 100) / 100)} of leave you had not used `
                    + 'have lapsed and are no longer available.',
                email: true,
            });
        }
        notifyLeaveAdmins(req, {
            title: '📕 Academic year closed for leave',
            body: `${req.user?.name || 'An administrator'} closed ${academicYear}. `
                + (ops.length
                    ? `${ops.length} balance(s) lapsed, ${Math.round(ledger.reduce((n, l) => n + l.days, 0) * 100) / 100} day(s) in total.`
                    : 'Nothing was left to lapse.'),
            link: { type: 'leave.balance' },
        });

        res.json({
            success: true,
            academicYear,
            balancesClosed: ops.length,
            daysLapsed: Math.round(ledger.reduce((n, l) => n + l.days, 0) * 100) / 100,
            message: ops.length
                ? `${academicYear} closed — ${ops.length} balance(s) lapsed`
                : `${academicYear} closed — nothing was left to lapse`,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Final settlement for someone leaving. Stops accrual, lapses or reports the
 * remainder, and leaves the row closed rather than quietly still accruing.
 */
exports.adminSettleEmployeeLeave = async (req, res) => {
    try {
        const { teacherId, academicYear, action = 'lapse' } = req.body;
        if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });
        if (!['lapse', 'report'].includes(action))
            return res.status(400).json({ success: false, message: "action must be 'lapse' or 'report'" });

        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const [balances, types] = await Promise.all([
            LeaveBalance.find({ teacher: teacherId, school: req.schoolId, academicYear: ay }).lean(),
            LeaveType.find({ school: req.schoolId }).lean(),
        ]);
        const byType = Object.fromEntries(types.map(t => [String(t._id), t]));

        const lines = balances.map(b => {
            const t = byType[String(b.leaveType)];
            return {
                leaveType: { _id: b.leaveType, name: t?.name || null, code: t?.code || null },
                remaining: remainingOf(b),
                // Encashable is a policy figure; the payout itself is a payroll
                // decision, so this reports rather than pays.
                encashable: !!t?.encashable,
                maxEncashableDays: t?.maxEncashableDays || 0,
            };
        }).filter(l => l.remaining > 0);

        if (action === 'report') {
            return res.json({ success: true, data: { academicYear: ay, settled: false, lines } });
        }

        const ops = [];
        const ledger = [];
        for (const b of balances) {
            const left = remainingOf(b);
            if (left <= 0) continue;
            ops.push({ updateOne: { filter: { _id: b._id }, update: { $inc: { expired: left } } } });
            ledger.push({
                school: req.schoolId, teacher: teacherId, leaveType: b.leaveType, academicYear: ay,
                entryType: 'EXPIRED', days: left, delta: -left, balanceAfter: 0,
                createdBy: req.userId, source: 'system',
                description: 'Final settlement on exit',
            });
        }
        if (ops.length) await LeaveBalance.bulkWrite(ops);
        await recordAdjustments(ledger);

        if (ops.length) {
            const lapsed = Math.round(ledger.reduce((n, l) => n + l.days, 0) * 100) / 100;
            const encashable = lines.filter((l) => l.encashable);
            notifyBalanceChange(req, [teacherId], {
                title: '📄 Leave settled on exit',
                body: `Your leave balances for ${ay} have been finalised — ${days(lapsed)} closed out.`
                    + (encashable.length
                        ? `\n${encashable.map((l) => `${l.leaveType.name}: ${l.remaining} day(s) encashable`).join(', ')}. `
                            + 'Encashment itself is settled through payroll.'
                        : ''),
                email: true,
            });
            notifyLeaveAdmins(req, {
                title: '📄 Leave settlement completed',
                body: `${req.user?.name || 'An administrator'} settled leave for an employee leaving — `
                    + `${ops.length} balance(s), ${days(lapsed)} closed out for ${ay}.`,
                link: { type: 'leave.balance' },
            });
        }

        res.json({
            success: true,
            data: { academicYear: ay, settled: true, lines },
            message: ops.length ? `Settled ${ops.length} balance(s)` : 'Nothing left to settle',
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Monthly Accrual ───────────────────────────────────────────────────────────

// Whole calendar months from `a` to `b`. Local time, matching the scheduler's
// clock in server.js.
const monthsBetween = (a, b) =>
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());

/**
 * Credits every accruing balance the months it is owed.
 *
 * The admin allocates a monthly-accrual type once — the row is created at 0 (or
 * at a prorated opening figure) — and from then on this is the only thing that
 * touches it. Each row carries its own clock (`lastAccrualAt`), so:
 *
 *   · a month the server was down is caught up on the next run rather than lost;
 *   · running twice in the same month credits nothing the second time;
 *   · a teacher allocated mid-year starts accruing from their allocation date,
 *     not from the start of the academic year.
 *
 * Balances are capped at the type's annual allocation and scoped to the active
 * academic year — a closed year's rows are history and must not keep growing.
 */
async function runMonthlyAccrualForSchool(schoolId) {
    // Accrual is a policy rule now, so the set of accruing types comes from the
    // policies rather than the leave type columns.
    // Comp off never accrues on a clock — it is earned per approved request.
    const policies = (await leavePolicy.getAllPolicies(schoolId, { activeOnly: true }))
        .filter(p => p.monthlyAccrual.enabled && !isCompOffType(p.leaveType));
    if (!policies.length) return 0;

    const ay = await getActiveAcademicYearLabel(schoolId);
    if (!ay) return 0;

    const now = new Date();
    let credited = 0;
    // teacherId -> [ "Casual Leave +1", … ] for the monthly message below.
    const earned = new Map();

    for (const policy of policies) {
        const lt        = policy.leaveType;
        const perMonth  = Number(policy.monthlyAccrual.daysPerMonth) || 0;
        const annualCap = Number(lt.annualAllocation) || 0;
        if (perMonth <= 0 || annualCap <= 0) continue;

        const balances = await LeaveBalance.find({
            school: schoolId, leaveType: lt._id, academicYear: ay,
        }).lean();

        const ops = [];
        for (const b of balances) {
            const already = Number(b.totalAllocated) || 0;
            if (already >= annualCap) continue;

            const anchorRaw = b.lastAccrualAt || b.createdAt;
            if (!anchorRaw) {
                // No clock to measure from. Start one instead of treating the
                // epoch as the anchor, which would credit a full year at once.
                ops.push({ updateOne: { filter: { _id: b._id }, update: { $set: { lastAccrualAt: now } } } });
                continue;
            }

            const months = monthsBetween(new Date(anchorRaw), now);
            if (months < 1) continue;

            const next  = Math.min(already + months * perMonth, annualCap);
            const gained = Math.round((next - already) * 100) / 100;
            ops.push({ updateOne: {
                filter: { _id: b._id },
                update: { $set: {
                    totalAllocated: next,
                    lastAccrualAt:  now,
                }},
            }});
            credited += 1;
            if (gained > 0) {
                const line = `${lt.name} +${gained}`;
                earned.set(String(b.teacher), [...(earned.get(String(b.teacher)) || []), line]);
            }
        }

        if (ops.length) await LeaveBalance.bulkWrite(ops);
    }

    // Days appeared in somebody's balance without anyone asking for them, which
    // is the kind of change people only notice much later. One message per
    // teacher listing every type that moved, not one per balance row.
    //
    // System-originated: notify() drops a senderless message and always filters
    // the sender out of the recipients, so the teacher is deliberately both
    // ends of their own accrual notice — the same shape comp off expiry uses.
    for (const [teacherId, lines] of earned) {
        notify({
            school: schoolId, sender: teacherId, senderRole: 'system',
            title: '📈 Monthly leave credited',
            body: `This month's leave has been added to your balance: ${lines.join(', ')}.`,
            recipients: [teacherId],
            includeSender: true,
            link: { type: 'leave.balance' },
        });
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

        const errors  = [];
        const ops     = [];
        const touched = new Set();

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
            touched.add(String(teacher._id));
        });

        if (ops.length) await LeaveBalance.bulkWrite(ops);

        // One message per teacher however many rows of the sheet were theirs —
        // a spreadsheet with five leave types each would otherwise be five.
        notifyBalanceChange(req, [...touched], {
            title: '📗 Leave allocation updated',
            body: `Your leave allocation for ${ay} has been updated. Open Leave Balance to see where you stand.`,
        });

        res.json({ success: true, updated: ops.length, errors: errors.length ? errors : undefined });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminRunCarryForward = async (req, res) => {
    try {
        const { fromYear, toYear } = req.body;
        if (!fromYear || !toYear)
            return res.status(400).json({ success: false, message: 'fromYear and toYear are required (e.g. "2024-25", "2025-26")' });

        // Both ends must be real academic years of this school, and the balances
        // must move forwards. Ordering is decided by startDate rather than by
        // comparing the labels as text — a label is free-form, and "2025-26" only
        // happens to sort correctly.
        const years = await AcademicYear.find({ school: req.schoolId }).lean();
        const byLabel = new Map(years.map(y => [academicYearLabel(y), y]));
        const fromAY = byLabel.get(fromYear);
        const toAY   = byLabel.get(toYear);
        if (!fromAY) return res.status(400).json({ success: false, message: `"${fromYear}" is not an academic year of this school` });
        if (!toAY)   return res.status(400).json({ success: false, message: `"${toYear}" is not an academic year of this school` });
        if (fromYear === toYear)
            return res.status(400).json({ success: false, message: 'From year and To year must be different' });
        if (new Date(fromAY.startDate) >= new Date(toAY.startDate))
            return res.status(400).json({ success: false, message: `From year must be earlier than To year — ${fromYear} does not start before ${toYear}` });

        // Carry forward is a policy rule, so the types that roll over come from
        // the policies rather than the leave type columns.
        const policies = (await leavePolicy.getAllPolicies(req.schoolId))
            .filter(p => p.carryForward.enabled);

        let processed = 0;
        let compOffProcessed = 0;
        const carried = [];
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
                carried.push({
                    school: req.schoolId, teacher: bal.teacher, leaveType: lt._id, academicYear: toYear,
                    entryType: 'ADJUSTMENT', days: carryAmt, delta: carryAmt,
                    balanceAfter: carryAmt, createdBy: req.userId, source: 'system',
                    description: `Carried forward ${carryAmt} day(s) from ${fromYear}`,
                });
                processed++;
            }
        }

        await recordAdjustments(carried);

        if (!processed) return res.json({ success: true, message: 'Nothing to carry forward', processed: 0 });

        // Days that survived the year change. Totalled per teacher, because one
        // teacher usually carries several types across and wants one answer.
        const perTeacher = new Map();
        for (const row of carried) {
            const k = String(row.teacher);
            perTeacher.set(k, (perTeacher.get(k) || 0) + row.days);
        }
        for (const [teacherId, total] of perTeacher) {
            notifyBalanceChange(req, [teacherId], {
                title: '🔄 Leave carried forward',
                body: `${days(Math.round(total * 100) / 100)} of unused leave have been carried from ${fromYear} into ${toYear}.`,
            });
        }
        notifyLeaveAdmins(req, {
            title: '🔄 Carry forward complete',
            body: `${processed} balance(s) carried from ${fromYear} to ${toYear}`
                + `${compOffProcessed ? `, ${compOffProcessed} of them Comp Off` : ''}.`,
            link: { type: 'leave.balance' },
        });

        res.json({ success: true, processed, compOffProcessed });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Admin: Reports ────────────────────────────────────────────────────────────

exports.adminGetReports = async (req, res) => {
    try {
        const school = String(req.schoolId);
        const { academicYear, department, leaveType, status } = req.query;
        const ay    = academicYear || await getActiveAcademicYearLabel(req.schoolId);
        const years = await AcademicYear.find({ school: req.schoolId }).lean();
        const ayRow = years.find((y) => academicYearLabel(y) === ay);

        // Without a year on record, report on everything rather than nothing —
        // a school still setting itself up should still see its own figures.
        const from = ayRow?.startDate ? new Date(ayRow.startDate) : new Date(0);
        const to   = ayRow?.endDate   ? new Date(ayRow.endDate)   : new Date('2999-12-31');

        // The year before this one, for the headline's delta. Picked by date
        // rather than by name: "2025-26" sorts before "2026-27" only by luck.
        const prev = years
            .filter((y) => y.endDate && new Date(y.endDate) <= from)
            .sort((a, b) => new Date(b.endDate) - new Date(a.endDate))[0];

        // Optional narrowing. Department lives on TeacherProfile, so it becomes
        // a teacher-id list before it can touch the application table.
        const params = [school, from, to];
        let scope = '';
        if (department) {
            const profiles = await TeacherProfile.find({ school: req.schoolId, department })
                .select('user').lean();
            const ids = profiles.map((pr) => String(pr.user));
            // An empty list must match nothing, not everything.
            params.push(ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
            scope += ` AND la."teacher" = ANY($${params.length}::uuid[])`;
        }
        if (leaveType) { params.push(leaveType); scope += ` AND la."leaveType" = $${params.length}::uuid`; }
        if (status)    { params.push(status);    scope += ` AND la."status" = $${params.length}`; }

        const WHERE = `WHERE la."school" = $1::uuid AND la."fromDate" >= $2 AND la."fromDate" <= $3${scope}`;

        const [byStatus, trend, byType, perTeacher, lastYear, depts] = await Promise.all([
            pool.query(
                `SELECT la."status", count(*)::int AS "n", coalesce(sum(la."totalDays"),0)::float AS "days"
                   FROM ${qt(LeaveApplication)} la ${WHERE}
                  GROUP BY la."status"`, params),
            // One row per month the year actually holds applications in; the
            // months in between are filled in below so the axis has no gaps.
            pool.query(
                `SELECT to_char(la."fromDate" AT TIME ZONE 'UTC', 'YYYY-MM') AS "month",
                        count(*)::int AS "n", coalesce(sum(la."totalDays"),0)::float AS "days"
                   FROM ${qt(LeaveApplication)} la ${WHERE}
                  GROUP BY 1 ORDER BY 1`, params),
            pool.query(
                `SELECT lt."_id", lt."name", lt."code",
                        count(*)::int AS "n", coalesce(sum(la."totalDays"),0)::float AS "days"
                   FROM ${qt(LeaveApplication)} la
                   JOIN ${qt(LeaveType)} lt ON lt."_id" = la."leaveType" ${WHERE}
                  GROUP BY lt."_id", lt."name", lt."code"
                  ORDER BY "n" DESC, lt."name"`, params),
            // The teacher table, as one row per teacher per type. Pivoted in JS
            // because the column set is the school's own list of leave types.
            pool.query(
                `SELECT u."_id" AS "teacher", u."name", tp."employeeId", tp."department",
                        la."leaveType", coalesce(sum(la."totalDays"),0)::float AS "days",
                        count(*)::int AS "n"
                   FROM ${qt(LeaveApplication)} la
                   JOIN ${qt(User)} u ON u."_id" = la."teacher"
                   LEFT JOIN ${qt(TeacherProfile)} tp ON tp."user" = u."_id" ${WHERE}
                  GROUP BY u."_id", u."name", tp."employeeId", tp."department", la."leaveType"`, params),
            prev
                ? pool.query(
                    `SELECT count(*)::int AS "n" FROM ${qt(LeaveApplication)} la
                      WHERE la."school" = $1::uuid AND la."fromDate" >= $2 AND la."fromDate" <= $3`,
                    [school, new Date(prev.startDate), new Date(prev.endDate)])
                : Promise.resolve({ rows: [{ n: null }] }),
            pool.query(
                `SELECT DISTINCT tp."department" FROM ${qt(TeacherProfile)} tp
                  WHERE tp."school" = $1::uuid AND tp."department" IS NOT NULL AND tp."department" <> ''
                  ORDER BY 1`, [school]),
        ]);

        const stat = (k) => byStatus.rows.find((r) => r.status === k) || { n: 0, days: 0 };
        const totals = {
            applications: byStatus.rows.reduce((n, r) => n + r.n, 0),
            approved:     stat('approved').n,
            pending:      stat('pending').n,
            rejected:     stat('rejected').n,
            cancelled:    stat('cancelled').n,
            days:         byStatus.rows.reduce((n, r) => n + r.days, 0),
        };

        // Every month in the window, including the empty ones — a bar chart with
        // months missing reads as a shorter year, not as a quieter one.
        const seen = new Map(trend.rows.map((r) => [r.month, r]));
        const series = [];
        const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
        const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
        // Guard the loop: a school with no academic year row has `from` at the
        // epoch, and walking 1970→2999 a month at a time is 12,000 iterations.
        while (cur <= last && series.length < 24) {
            const key = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`;
            const hit = seen.get(key);
            series.push({
                month: key,
                label: cur.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }),
                count: hit?.n || 0,
                days:  hit?.days || 0,
            });
            cur.setUTCMonth(cur.getUTCMonth() + 1);
        }

        const teachers = new Map();
        perTeacher.rows.forEach((r) => {
            const id = String(r.teacher);
            if (!teachers.has(id)) {
                teachers.set(id, {
                    _id: id, name: r.name, employeeId: r.employeeId || '',
                    department: r.department || '', perType: {}, days: 0, applications: 0,
                });
            }
            const t = teachers.get(id);
            t.perType[String(r.leaveType)] = r.days;
            t.days += r.days;
            t.applications += r.n;
        });

        const prevCount = lastYear.rows[0]?.n;
        res.json({
            success: true,
            data: {
                academicYear: ay || null,
                window: ayRow?.startDate ? { startDate: ayRow.startDate, endDate: ayRow.endDate } : null,
                totals,
                lastYear: prev
                    ? {
                        label: academicYearLabel(prev),
                        applications: prevCount,
                        // Null rather than 0 when last year had nothing: "+100%"
                        // off a base of zero is not a fact about this year.
                        deltaPct: prevCount ? Math.round(((totals.applications - prevCount) / prevCount) * 100) : null,
                    }
                    : null,
                trend: series,
                byType: byType.rows.map((r) => ({
                    _id: String(r._id), name: r.name, code: r.code, count: r.n, days: r.days,
                })),
                teachers: [...teachers.values()].sort((a, b) => a.name.localeCompare(b.name)),
                departments: depts.rows.map((r) => r.department),
                academicYears: years
                    .map((y) => ({ label: academicYearLabel(y), startDate: y.startDate, status: y.status }))
                    .filter((y) => y.label)
                    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate)),
            },
        });
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
        } else {
            // No range asked for: the active academic year, not all history.
            const ayRow = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
            if (ayRow?.startDate) filter.fromDate = { $gte: new Date(ayRow.startDate), $lte: new Date(ayRow.endDate) };
        }

        const apps = await LeaveApplication.find(filter)
            .populate('teacher',   'name email employeeId')
            .populate('leaveType', 'name code')
            .populate('approvedBy','name')
            .sort({ appliedAt: -1 })
            .limit(REPORT_ROW_CAP)
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
        const { academicYear, status, fromDate, toDate } = req.query;
        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);

        let filter = { school: req.schoolId };
        if (status) filter.status = status;
        const ayRow = await AcademicYear.findOne({ school: req.schoolId, yearName: ay }).lean();
        filter = withReportWindow(filter, { fromDate, toDate }, ayRow);

        const apps = await LeaveApplication.find(filter)
            .populate('teacher',   'name email employeeId')
            .populate('leaveType', 'name code')
            .sort({ appliedAt: -1 })
            .limit(REPORT_ROW_CAP)
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
        const { status, leaveType, mode, fromDate, toDate, page = 1, limit = 20 } = req.query;
        const filter = { teacher: req.userId, school: req.schoolId };
        if (status)    filter.status    = status;
        if (leaveType) filter.leaveType = leaveType;
        if (mode === 'half_day' || mode === 'full_day') filter.leaveMode = mode;
        if (fromDate || toDate) {
            filter.fromDate = {};
            if (fromDate) filter.fromDate.$gte = new Date(fromDate);
            if (toDate)   filter.fromDate.$lte = new Date(toDate);
        }

        const [apps, total, byStatus] = await Promise.all([
            LeaveApplication.find(filter)
                .populate('leaveType', 'name code category')
                .populate('approvedBy','name')
                .sort({ appliedAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            LeaveApplication.countDocuments(filter),
            // The tiles describe this teacher's whole history, so they ignore
            // every filter — a tile that is also the filter must not move when
            // it is pressed.
            pool.query(
                `SELECT "status", count(*)::int AS "n"
                   FROM ${qt(LeaveApplication)}
                  WHERE "teacher" = $1::uuid AND "school" = $2::uuid
                  GROUP BY "status"`,
                [String(req.userId), String(req.schoolId)],
            ),
        ]);

        const stat = (k) => byStatus.rows.find((r) => r.status === k)?.n || 0;
        res.json({
            success: true, data: apps, total, page: +page, pages: Math.ceil(total / +limit),
            counts: {
                total:     byStatus.rows.reduce((n, r) => n + r.n, 0),
                pending:   stat('pending'),
                approved:  stat('approved'),
                rejected:  stat('rejected'),
                cancelled: stat('cancelled'),
            },
        });
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
        const { leaveTypeId, fromDate, toDate, leaveMode, halfDaySession, reason } = req.body;
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
        // Same rule as the admin path: refused as before, unless the type is
        // unpaid or the policy allows the overrun as loss of pay.
        const split = leavePolicy.splitPaidAndLop(policy, lt, totalDays, spendable);
        if (!split.ok)
            return res.status(400).json({ success: false, message: split.message.replace('Insufficient balance', 'Insufficient leave balance') });

        const app = await LeaveApplication.create({
            teacher: req.userId, school: req.schoolId, leaveType: leaveTypeId,
            fromDate: from, toDate: to, totalDays, academicYear: ay, lopDays: split.lopDays,
            leaveMode: leaveMode || 'full_day',
            halfDaySession: leaveMode === 'half_day' ? (halfDaySession === 'second' ? 'second' : 'first') : 'first',
            reason, document: documentPath, appliedAt: new Date(),
            // Leave takes one sign-off — the two-level policy option was removed.
            approvalsRequired: 1,
            approvalLevel: 0, approvals: [],
        });
        // Only the paid portion is held — LOP days draw on no entitlement.
        if (split.paidDays > 0) {
            await LeaveBalance.updateOne(
                { teacher: req.userId, school: req.schoolId, leaveType: leaveTypeId, academicYear: ay },
                { $inc: { pending: split.paidDays } }
            );
        }
        // Routed by the type's own policy — admins, named designations, or both
        leavePolicy.approverIds(req.schoolId, policy).then(recipients => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📋 New leave request',
            body: `${req.user?.name || 'A teacher'} applied for ${lt.name} leave from ${fmtDate(from)} to ${fmtDate(to)} (${totalDays} day${totalDays === 1 ? '' : 's'}).\nReason: ${reason}`,
            recipients,
            link: { type: 'leave.approvals', entityId: app._id },
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
        if (app.status !== 'pending')
            return res.status(400).json({ success: false, message: 'Only pending applications can be cancelled' });

        app.status      = 'cancelled';
        app.cancelledAt = new Date();
        await app.save();

        // Only a pending application reaches here, so the hold set on apply is
        // always still standing — release it. A released hold writes no ledger row.
        const ay = await yearOf(app, req.schoolId);
        await commitTransition({
            schoolId: req.schoolId, appId: app._id, teacherId: req.userId,
            leaveTypeId: app.leaveType, academicYear: ay,
            inc: { pending: -paidOf(app) },
        });
        // Whoever was going to decide it needs to know it is gone — not just the
        // school admins, which left a designation approver or a module admin
        // chasing a request that no longer exists.
        leavePolicy.getPolicy(req.schoolId, app.leaveType)
            .then((policy) => (policy
                ? leavePolicy.approverIds(req.schoolId, policy)
                : leavePolicy.leaveAdminIds(req.schoolId)))
            .then(recipients => notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '🚫 Leave request cancelled',
                body: `${req.user?.name || 'A teacher'} cancelled their leave request for ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)}.`,
                recipients,
                link: { type: 'leave.approvals', entityId: app._id },
            })).catch(() => {});
        res.json({ success: true, data: app });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
