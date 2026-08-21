'use strict';
/**
 * Per-leave-type policy engine.
 * ─────────────────────────────
 * Every leave type gets its own configurable rule set (LeavePolicy). This
 * module is the only place those rules are read or enforced, so the web admin,
 * the mobile admin, the teacher apply form and the approval routes all agree.
 *
 * It governs *applying for* leave of any type, Comp Off included.
 * compOffService governs how comp off days are *earned* — the two never
 * overlap, so there is exactly one place to change any given rule.
 *
 * Nothing is hard-coded: a type with no saved policy falls back to defaults
 * seeded from its own LeaveType row, which is why switching this on changes
 * no existing school's behaviour until someone edits a policy.
 */
const LeavePolicy      = require('../models/LeavePolicy');
const LeaveType        = require('../models/LeaveType');
const LeaveApplication = require('../models/LeaveApplication');
const TeacherProfile   = require('../models/TeacherProfile');
const User             = require('../models/User');
const { schoolAdminIds } = require('./notifyService');
const { utcMidnight }    = require('../utils/leaveDays');

const DAY_MS = 24 * 60 * 60 * 1000;
const sid = (v) => String(v?._id ?? v);

// ── Defaults ──────────────────────────────────────────────────────────────────

// `leaveType` seeds the three rules that used to live on the LeaveType row, so
// a school that never opens the policy screen keeps its current behaviour.
function defaults(leaveType = {}) {
    return {
        eligibleDesignations: [],
        eligibleRoles:        ['teacher', 'school_admin'],
        gender:               'any',
        minServiceDays:       0,

        minDaysPerApplication: 0,
        maxConsecutiveDays:    Number(leaveType.maxConsecutiveDays) || 0,
        advanceNoticeDays:     0,
        allowBackdated:        false,
        backdatedWithinDays:   0,

        maxApplicationsPerMonth: 0,
        maxApplicationsPerYear:  0,
        maxDaysPerMonth:         0,

        halfDayAllowed: true,
        sandwichRule:   false,

        requiresDocument:          !!leaveType.requiresDocument,
        documentRequiredAfterDays: Number(leaveType.documentRequiredAfterDays) || 0,

        allowNegativeBalance: false,
        maxNegativeDays:      0,

        allowLopBeyondBalance:    false,
        maxLopDaysPerApplication: 0,

        monthlyAccrual: {
            enabled:      !!leaveType.monthlyAccrual?.enabled,
            daysPerMonth: Number(leaveType.monthlyAccrual?.daysPerMonth) || 0,
        },
        carryForward: {
            enabled: !!leaveType.carryForward?.enabled,
            maxDays: Number(leaveType.carryForward?.maxDays) || 0,
        },
        encashable:        !!leaveType.encashable,
        maxEncashableDays: Number(leaveType.maxEncashableDays) || 0,

        allowCombineWithOtherLeaves: true,
        blockedLeaveTypes: [],

        // twoLevel stays for the column's sake; leave approval is single sign-off.
        approval: { mode: 'admin', approverDesignations: [], twoLevel: false },
        isActive: true,
    };
}

function merge(row, leaveType) {
    const base = defaults(leaveType);
    const p = { ...base, ...(row || {}) };
    p.approval       = { ...base.approval,       ...(row?.approval       || {}) };
    p.monthlyAccrual = { ...base.monthlyAccrual, ...(row?.monthlyAccrual || {}) };
    p.carryForward   = { ...base.carryForward,   ...(row?.carryForward   || {}) };
    // lean() reads return raw columns; a null array column must not shadow []
    p.eligibleDesignations = row?.eligibleDesignations || base.eligibleDesignations;
    p.eligibleRoles        = row?.eligibleRoles        || base.eligibleRoles;
    p.blockedLeaveTypes    = row?.blockedLeaveTypes    || base.blockedLeaveTypes;
    return p;
}

/** Effective policy for one leave type. `leaveType` may be an id or a document. */
async function getPolicy(schoolId, leaveType) {
    const lt = leaveType && typeof leaveType === 'object'
        ? leaveType
        : await LeaveType.findOne({ _id: leaveType, school: schoolId }).lean();
    if (!lt) return null;
    const row = await LeavePolicy.findOne({ school: schoolId, leaveType: sid(lt._id) }).lean();
    return { ...merge(row, lt), leaveType: lt, saved: !!row };
}

/** Effective policies for every leave type in the school, keyed by type id. */
async function getAllPolicies(schoolId, { activeOnly = false } = {}) {
    const filter = { school: schoolId };
    if (activeOnly) filter.isActive = true;
    const [types, rows] = await Promise.all([
        LeaveType.find(filter).sort({ name: 1 }).lean(),
        LeavePolicy.find({ school: schoolId }).lean(),
    ]);
    const byType = Object.fromEntries(rows.map((r) => [sid(r.leaveType), r]));
    return types.map((lt) => ({ ...merge(byType[sid(lt._id)], lt), leaveType: lt, saved: !!byType[sid(lt._id)] }));
}

/**
 * Write a policy. The full effective policy is stored, not just the patch, so
 * a partial save can never silently reset an unrelated rule to a schema default.
 */
async function savePolicy(schoolId, leaveTypeId, patch = {}, userId = null) {
    const current = await getPolicy(schoolId, leaveTypeId);
    if (!current) return { ok: false, notFound: true, message: 'Leave type not found' };

    const num  = (v, fallback) => (v === '' || v == null || isNaN(Number(v)) ? fallback : Math.max(0, Number(v)));
    const bool = (v, fallback) => (v === undefined ? fallback : !!v);
    const list = (v, fallback) => (Array.isArray(v) ? v.map(String).filter(Boolean) : fallback);

    const next = {
        eligibleDesignations: list(patch.eligibleDesignations, current.eligibleDesignations),
        eligibleRoles:        list(patch.eligibleRoles,        current.eligibleRoles),
        gender:               ['any', 'Male', 'Female'].includes(patch.gender) ? patch.gender : current.gender,
        minServiceDays:       num(patch.minServiceDays, current.minServiceDays),

        minDaysPerApplication: num(patch.minDaysPerApplication, current.minDaysPerApplication),
        maxConsecutiveDays:    num(patch.maxConsecutiveDays,    current.maxConsecutiveDays),
        advanceNoticeDays:     num(patch.advanceNoticeDays,     current.advanceNoticeDays),
        allowBackdated:        bool(patch.allowBackdated,       current.allowBackdated),
        backdatedWithinDays:   num(patch.backdatedWithinDays,   current.backdatedWithinDays),

        maxApplicationsPerMonth: num(patch.maxApplicationsPerMonth, current.maxApplicationsPerMonth),
        maxApplicationsPerYear:  num(patch.maxApplicationsPerYear,  current.maxApplicationsPerYear),
        maxDaysPerMonth:         num(patch.maxDaysPerMonth,         current.maxDaysPerMonth),

        halfDayAllowed: bool(patch.halfDayAllowed, current.halfDayAllowed),
        sandwichRule:   bool(patch.sandwichRule,   current.sandwichRule),

        requiresDocument:          bool(patch.requiresDocument,          current.requiresDocument),
        documentRequiredAfterDays: num(patch.documentRequiredAfterDays,  current.documentRequiredAfterDays),

        allowNegativeBalance: bool(patch.allowNegativeBalance, current.allowNegativeBalance),
        maxNegativeDays:      num(patch.maxNegativeDays,       current.maxNegativeDays),

        allowLopBeyondBalance:    bool(patch.allowLopBeyondBalance,    current.allowLopBeyondBalance),
        maxLopDaysPerApplication: num(patch.maxLopDaysPerApplication,  current.maxLopDaysPerApplication),

        monthlyAccrual: {
            enabled:      bool(patch.monthlyAccrual?.enabled,      current.monthlyAccrual.enabled),
            daysPerMonth: num(patch.monthlyAccrual?.daysPerMonth,  current.monthlyAccrual.daysPerMonth),
        },
        carryForward: {
            enabled: bool(patch.carryForward?.enabled, current.carryForward.enabled),
            maxDays: num(patch.carryForward?.maxDays,  current.carryForward.maxDays),
        },
        encashable:        bool(patch.encashable,        current.encashable),
        maxEncashableDays: num(patch.maxEncashableDays,  current.maxEncashableDays),

        allowCombineWithOtherLeaves: bool(patch.allowCombineWithOtherLeaves, current.allowCombineWithOtherLeaves),
        blockedLeaveTypes:           list(patch.blockedLeaveTypes, current.blockedLeaveTypes),

        approval: {
            mode: ['admin', 'designation', 'both'].includes(patch.approval?.mode)
                ? patch.approval.mode : current.approval.mode,
            approverDesignations: list(patch.approval?.approverDesignations, current.approval.approverDesignations),
            // Leave is single sign-off. The two-level option was removed, so the
            // column is pinned rather than read from the request — an old client
            // still sending twoLevel cannot switch it back on. Comp Off keeps its
            // own two-level approval; this only governs leave.
            twoLevel: false,
        },
        isActive: bool(patch.isActive, current.isActive),
    };

    // A minimum longer than the maximum can never be satisfied — clamp rather
    // than store a rule that rejects every application.
    if (next.maxConsecutiveDays > 0 && next.minDaysPerApplication > next.maxConsecutiveDays) {
        next.minDaysPerApplication = next.maxConsecutiveDays;
    }

    // Accrual switched on but crediting 0 days a month is a rule that does
    // nothing, and from the admin's side it is indistinguishable from a broken
    // accrual engine. Refuse it rather than store a silent no-op.
    if (next.monthlyAccrual.enabled && next.monthlyAccrual.daysPerMonth <= 0) {
        return { ok: false, message: 'Monthly accrual needs a days-per-month figure greater than 0' };
    }

    await LeavePolicy.findOneAndUpdate(
        { school: schoolId, leaveType: sid(leaveTypeId) },
        { $set: { ...next, updatedBy: userId }, $setOnInsert: { school: schoolId, leaveType: sid(leaveTypeId) } },
        { upsert: true, new: true },
    );
    return { ok: true, policy: await getPolicy(schoolId, leaveTypeId) };
}

// ── Enforcement ───────────────────────────────────────────────────────────────

/**
 * Every rule that governs filing an application. Returns { ok } or
 * { ok: false, message }.
 *
 * @param {Boolean} onBehalf true when an admin files for someone else — the
 *        notice-period and backdating rules are the employee's obligation, not
 *        the admin's, so they are skipped.
 */
async function validateApplication({
    schoolId, policy, teacherId, from, to, totalDays, leaveMode,
    hasDocument = false, excludeId = null, onBehalf = false,
}) {
    if (!policy.isActive) {
        return { ok: false, message: `${policy.leaveType?.name || 'This leave type'} is not accepting applications` };
    }

    const today = utcMidnight(new Date());

    // ── Who ────────────────────────────────────────────────────────────────
    const [user, profile] = await Promise.all([
        User.findOne({ _id: teacherId, school: schoolId }).select('role name').lean(),
        TeacherProfile.findOne({ user: teacherId, school: schoolId }).select('designation gender joiningDate').lean(),
    ]);
    if (!user) return { ok: false, message: 'Employee not found' };

    if (policy.eligibleRoles.length && !policy.eligibleRoles.includes(user.role)) {
        return { ok: false, message: 'This leave type is not available to your employee type' };
    }
    if (policy.eligibleDesignations.length && !policy.eligibleDesignations.includes(profile?.designation || '')) {
        return { ok: false, message: 'This leave type is not available for your designation' };
    }
    if (policy.gender !== 'any' && (profile?.gender || '') !== policy.gender) {
        return { ok: false, message: `This leave type is restricted to ${policy.gender.toLowerCase()} employees` };
    }
    if (policy.minServiceDays > 0) {
        if (!profile?.joiningDate) {
            return { ok: false, message: 'A joining date is required before this leave type can be applied for' };
        }
        const served = Math.floor((today - utcMidnight(profile.joiningDate)) / DAY_MS);
        if (served < policy.minServiceDays) {
            return { ok: false, message: `Requires ${policy.minServiceDays} day(s) of service — you have completed ${Math.max(0, served)}` };
        }
    }

    // ── When ───────────────────────────────────────────────────────────────
    // A range that ends before it starts is nonsense whoever files it.
    if (to < from) {
        return { ok: false, message: 'To date must be on or after From date' };
    }

    // Back-dating binds everyone. It is a statement about which dates the
    // school will accept leave for at all, so an admin filing on someone's
    // behalf is bound by it too — unlike the notice period below, which is an
    // obligation on the employee and is waived for `onBehalf`.
    if (from < today) {
        if (!policy.allowBackdated) {
            return { ok: false, message: 'Cannot apply for past dates' };
        }
        if (policy.backdatedWithinDays > 0) {
            const age = Math.floor((today - from) / DAY_MS);
            if (age > policy.backdatedWithinDays) {
                return { ok: false, message: `Back-dated applications are allowed only within ${policy.backdatedWithinDays} day(s)` };
            }
        }
    } else if (!onBehalf && policy.advanceNoticeDays > 0) {
        const notice = Math.floor((from - today) / DAY_MS);
        if (notice < policy.advanceNoticeDays) {
            return { ok: false, message: `This leave type needs ${policy.advanceNoticeDays} day(s) advance notice` };
        }
    }

    // ── Shape ──────────────────────────────────────────────────────────────
    if (leaveMode === 'half_day' && !policy.halfDayAllowed) {
        return { ok: false, message: 'Half-day leave is not allowed for this leave type' };
    }
    if (leaveMode !== 'half_day') {
        if (policy.maxConsecutiveDays > 0 && totalDays > policy.maxConsecutiveDays) {
            return { ok: false, message: `Max consecutive days for this leave type is ${policy.maxConsecutiveDays}` };
        }
        if (policy.minDaysPerApplication > 0 && totalDays < policy.minDaysPerApplication) {
            return { ok: false, message: `This leave type must be applied for at least ${policy.minDaysPerApplication} day(s) at a time` };
        }
    }

    // ── Document ───────────────────────────────────────────────────────────
    if (policy.requiresDocument) {
        const after = policy.documentRequiredAfterDays || 0;
        if ((after === 0 || totalDays > after) && !hasDocument) {
            return {
                ok: false,
                message: after === 0
                    ? 'A supporting document is required for this leave type'
                    : `A supporting document is required when this leave exceeds ${after} day(s)`,
            };
        }
    }

    // ── Frequency caps ─────────────────────────────────────────────────────
    const countable = ['pending', 'approved', 'modification_requested'];
    if (policy.maxApplicationsPerMonth > 0 || policy.maxDaysPerMonth > 0) {
        const mStart = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
        const mEnd   = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0, 23, 59, 59));
        const q = {
            teacher: teacherId, school: schoolId, leaveType: sid(policy.leaveType._id),
            status: { $in: countable }, fromDate: { $gte: mStart, $lte: mEnd },
        };
        if (excludeId) q._id = { $ne: excludeId };
        const rows = await LeaveApplication.find(q).select('totalDays').lean();

        if (policy.maxApplicationsPerMonth > 0 && rows.length + 1 > policy.maxApplicationsPerMonth) {
            return { ok: false, message: `Only ${policy.maxApplicationsPerMonth} application(s) of this type are allowed per month` };
        }
        if (policy.maxDaysPerMonth > 0) {
            const already = rows.reduce((s, r) => s + (Number(r.totalDays) || 0), 0);
            if (already + totalDays > policy.maxDaysPerMonth) {
                return { ok: false, message: `Only ${policy.maxDaysPerMonth} day(s) of this type are allowed per month; ${already} already applied for` };
            }
        }
    }
    if (policy.maxApplicationsPerYear > 0) {
        const yStart = new Date(Date.UTC(from.getUTCFullYear(), 0, 1));
        const yEnd   = new Date(Date.UTC(from.getUTCFullYear(), 11, 31, 23, 59, 59));
        const q = {
            teacher: teacherId, school: schoolId, leaveType: sid(policy.leaveType._id),
            status: { $in: countable }, fromDate: { $gte: yStart, $lte: yEnd },
        };
        if (excludeId) q._id = { $ne: excludeId };
        const n = await LeaveApplication.countDocuments(q);
        if (n + 1 > policy.maxApplicationsPerYear) {
            return { ok: false, message: `Only ${policy.maxApplicationsPerYear} application(s) of this type are allowed per year` };
        }
    }

    // ── Clubbing with other leave types ────────────────────────────────────
    const restricted = !policy.allowCombineWithOtherLeaves || policy.blockedLeaveTypes.length;
    if (restricted) {
        // Overlaps are already refused for every type; what is left to catch is
        // a different leave butting straight up against this one.
        const q = {
            teacher: teacherId, school: schoolId,
            leaveType: { $ne: sid(policy.leaveType._id) },
            status: { $in: countable },
            fromDate: { $lte: new Date(to.getTime() + DAY_MS) },
            toDate:   { $gte: new Date(from.getTime() - DAY_MS) },
        };
        if (excludeId) q._id = { $ne: excludeId };
        const neighbours = await LeaveApplication.find(q).select('leaveType').lean();

        if (neighbours.length) {
            if (!policy.allowCombineWithOtherLeaves) {
                return { ok: false, message: 'This leave type cannot be combined with another leave type' };
            }
            const blocked = new Set(policy.blockedLeaveTypes.map(String));
            if (neighbours.some((n) => blocked.has(sid(n.leaveType)))) {
                const names = await LeaveType.find({ _id: { $in: policy.blockedLeaveTypes } }).select('name').lean();
                return { ok: false, message: `This leave type cannot be combined with ${names.map((x) => x.name).join(', ')}` };
            }
        }
    }

    return { ok: true };
}

/** How much balance an application may draw, allowing for a configured overdraft. */
function spendableFrom(policy, remaining) {
    return policy.allowNegativeBalance
        ? remaining + (policy.maxNegativeDays || Infinity)
        : remaining;
}

/**
 * Split an application into paid days and loss-of-pay days.
 *
 * Three ways days become unpaid:
 *   · the leave type itself is unpaid — every day is LOP;
 *   · the request runs past what the balance can cover, and the policy permits
 *     the overrun as LOP rather than refusing it;
 *   · neither, in which case nothing is LOP and the caller enforces the balance
 *     exactly as it always did.
 *
 * Returns { paidDays, lopDays, ok, message }. `ok:false` means the application
 * must still be refused — the shortfall is not coverable as LOP.
 */
function splitPaidAndLop(policy, leaveType, totalDays, spendable) {
    if (leaveType && leaveType.isPaid === false) {
        return { paidDays: 0, lopDays: totalDays, ok: true };
    }
    const shortfall = Math.max(0, totalDays - Math.max(0, spendable));
    if (shortfall === 0) return { paidDays: totalDays, lopDays: 0, ok: true };

    if (!policy.allowLopBeyondBalance) {
        return { paidDays: 0, lopDays: 0, ok: false, message: `Insufficient balance. Available: ${spendable}` };
    }
    const cap = policy.maxLopDaysPerApplication || 0;
    if (cap > 0 && shortfall > cap) {
        return {
            paidDays: 0, lopDays: 0, ok: false,
            message: `Only ${cap} day(s) may be taken as loss of pay on one application — this needs ${shortfall}`,
        };
    }
    return { paidDays: totalDays - shortfall, lopDays: shortfall, ok: true };
}

// ── Approver RBAC (mirrors compOffService, driven by this policy) ─────────────

/**
 * @param designation optional pre-resolved designation. Callers that ask about
 *        many leave types in a row should pass it — without it this reloads the
 *        same profile once per type, which is how the approver queue managed
 *        ten identical lookups on every open.
 */
async function canApprove(userId, userRole, schoolId, policy, designation) {
    const mode = policy.approval.mode;
    const isAdmin = userRole === 'school_admin';
    if (mode === 'admin') return isAdmin;
    if (mode === 'both' && isAdmin) return true;

    const designations = policy.approval.approverDesignations || [];
    if (!designations.length) return isAdmin;   // misconfigured → admins keep the keys
    const mine = designation !== undefined
        ? designation
        : (await TeacherProfile.findOne({ user: userId, school: schoolId }).select('designation').lean())?.designation;
    return designations.includes(mine || '');
}

/** The designation canApprove needs, resolved once. */
async function designationOf(userId, schoolId) {
    const profile = await TeacherProfile.findOne({ user: userId, school: schoolId }).select('designation').lean();
    return profile?.designation || '';
}

/** Everyone who should be told a new application needs their attention. */
async function approverIds(schoolId, policy) {
    const ids = new Set();
    const mode = policy.approval.mode;
    if (mode === 'admin' || mode === 'both') {
        (await schoolAdminIds(schoolId)).forEach((id) => ids.add(String(id)));
    }
    const designations = policy.approval.approverDesignations || [];
    if ((mode === 'designation' || mode === 'both') && designations.length) {
        const profiles = await TeacherProfile.find({ school: schoolId, designation: { $in: designations } })
            .select('user').lean();
        profiles.forEach((p) => ids.add(String(p.user)));
    }
    if (!ids.size) (await schoolAdminIds(schoolId)).forEach((id) => ids.add(String(id)));
    return [...ids];
}

/** Leave types this employee is actually allowed to apply for. */
async function eligibleTypesFor(schoolId, userId, userRole) {
    const policies = await getAllPolicies(schoolId, { activeOnly: true });
    const profile = await TeacherProfile.findOne({ user: userId, school: schoolId })
        .select('designation gender joiningDate').lean();
    const today = utcMidnight(new Date());

    return policies.map((p) => {
        const reasons = [];
        if (!p.isActive) reasons.push('Not accepting applications');
        if (p.eligibleRoles.length && !p.eligibleRoles.includes(userRole)) reasons.push('Not available to your employee type');
        if (p.eligibleDesignations.length && !p.eligibleDesignations.includes(profile?.designation || '')) reasons.push('Not available for your designation');
        if (p.gender !== 'any' && (profile?.gender || '') !== p.gender) reasons.push(`Restricted to ${p.gender.toLowerCase()} employees`);
        if (p.minServiceDays > 0) {
            const served = profile?.joiningDate
                ? Math.floor((today - utcMidnight(profile.joiningDate)) / DAY_MS)
                : -1;
            if (served < p.minServiceDays) reasons.push(`Requires ${p.minServiceDays} day(s) of service`);
        }
        return { ...p, eligible: reasons.length === 0, ineligibleReason: reasons[0] || '' };
    });
}

module.exports = {
    defaults,
    merge,
    getPolicy,
    getAllPolicies,
    savePolicy,
    validateApplication,
    spendableFrom,
    splitPaidAndLop,
    canApprove,
    designationOf,
    approverIds,
    eligibleTypesFor,
};
