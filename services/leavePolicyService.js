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
// Named `designationSvc`, not `designations`: two functions below use that
// word for the policy's own approverDesignations list.
const designationSvc     = require('./designationService');
const {
    utcMidnight, localToday, addDays, dayKinds, onlyOffDaysBetween,
} = require('../utils/leaveDays');

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

        // Retired (Nov 26 2026): every application is at least a day anyway.
        minDaysPerApplication: 0,
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

    // "Cannot be combined with" may only name other leave types of this school.
    // A foreign id never matched anything; the type's own id made it refuse
    // to sit next to itself.
    if (next.blockedLeaveTypes.length) {
        const own = await LeaveType.find({ school: schoolId, _id: { $in: next.blockedLeaveTypes } }).select('_id').lean();
        const ok = new Set(own.map((t) => sid(t._id)));
        next.blockedLeaveTypes = next.blockedLeaveTypes.filter((id) => ok.has(id) && id !== sid(leaveTypeId));
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
 *        notice period is the employee's obligation, not the admin's, so it is
 *        skipped. Back-dating binds everyone.
 * @param {Object}  ctx      { leaveSettings, holidayModule, year: {startDate,endDate} }
 *        — what a "working day" is (for "do these two leaves touch?") and the
 *        academic year the leave belongs to (for the per-year cap).
 */
async function validateApplication({
    schoolId, policy, teacherId, from, to, totalDays, leaveMode,
    hasDocument = false, excludeId = null, onBehalf = false, ctx = {},
}) {
    if (!policy.isActive) {
        return { ok: false, message: `${policy.leaveType?.name || 'This leave type'} is not accepting applications` };
    }

    const today = localToday();
    const leaveSettings = ctx.leaveSettings || {};
    const holidayModule = !!ctx.holidayModule;

    // ── Who ────────────────────────────────────────────────────────────────
    const [user, profile] = await Promise.all([
        User.findOne({ _id: teacherId, school: schoolId }).select('role name isActive').lean(),
        TeacherProfile.findOne({ user: teacherId, school: schoolId }).select('designation gender joiningDate').lean(),
    ]);
    if (!user) return { ok: false, message: 'Employee not found' };
    if (user.isActive === false) return { ok: false, message: 'This employee is no longer active' };

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
    if (to < from) {
        return { ok: false, message: 'To date must be on or after From date' };
    }

    // Back-dating binds everyone: it is a statement about which dates the
    // school accepts leave for at all.
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
    // No minimum-days check: the rule was retired (Nov 26 2026), and a value
    // saved before then must not go on refusing applications unseen.

    const countable = ['pending', 'approved'];
    const typeId = sid(policy.leaveType._id);

    // Every live application of this employee near these dates — the
    // consecutive-day run and the clubbing rules both read from it.
    const near = await LeaveApplication.find({
        teacher: teacherId, school: schoolId, status: { $in: countable },
        fromDate: { $lte: addDays(to, 60) }, toDate: { $gte: addDays(from, -60) },
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    }).select('leaveType fromDate toDate totalDays').lean();
    const touches = (a, b) => onlyOffDaysBetween(a, b, schoolId, leaveSettings, holidayModule);

    // The longest stretch is one absence, however many applications it was
    // filed as: Mon–Wed and Thu–Fri of the same type is a five-day leave.
    // Chained through weekends and holidays, as an absence would be.
    if (policy.maxConsecutiveDays > 0) {
        const same = near.filter((a) => sid(a.leaveType) === typeId);
        let run = Number(totalDays) || 0;
        let lo = from;
        let hi = to;
        const used = new Set();
        for (let guard = 0; guard < 40; guard += 1) {
            let grew = false;
            for (const a of same) {
                if (used.has(sid(a._id))) continue;
                const before = utcMidnight(a.toDate) < lo && await touches(a.toDate, lo);
                const after  = utcMidnight(a.fromDate) > hi && await touches(hi, a.fromDate);
                if (!before && !after) continue;
                used.add(sid(a._id));
                run += Number(a.totalDays) || 0;
                if (before) lo = utcMidnight(a.fromDate);
                if (after)  hi = utcMidnight(a.toDate);
                grew = true;
            }
            if (!grew) break;
        }
        if (run > policy.maxConsecutiveDays) {
            return {
                ok: false,
                message: used.size
                    ? `Max consecutive days for this leave type is ${policy.maxConsecutiveDays} — together with your leave next to these dates this would be ${run}`
                    : `Max consecutive days for this leave type is ${policy.maxConsecutiveDays}`,
            };
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
    // A leave that runs across a month end counts in each month it touches,
    // with its days split by the working days it holds in each.
    if (policy.maxApplicationsPerMonth > 0 || policy.maxDaysPerMonth > 0) {
        const daysIn = async (a0, a1, total, m0, m1) => {
            if (utcMidnight(a0) >= m0 && utcMidnight(a1) <= m1) return Number(total) || 0;
            const all = await dayKinds(a0, a1, schoolId, leaveSettings, holidayModule);
            const inMonth = all.filter((d) => { const t = new Date(`${d.iso}T00:00:00.000Z`); return t >= m0 && t <= m1; });
            const w = all.reduce((s, d) => s + d.weight, 0);
            const wm = inMonth.reduce((s, d) => s + d.weight, 0);
            return w > 0 ? Math.round(((Number(total) || 0) * wm / w) * 100) / 100 : 0;
        };
        const mine = near.filter((a) => sid(a.leaveType) === typeId);
        const firstMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
        for (let m0 = firstMonth; m0 <= to; m0 = new Date(Date.UTC(m0.getUTCFullYear(), m0.getUTCMonth() + 1, 1))) {
            const m1 = new Date(Date.UTC(m0.getUTCFullYear(), m0.getUTCMonth() + 1, 0));
            const label = m0.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
            const inMonth = mine.filter((a) => utcMidnight(a.fromDate) <= m1 && utcMidnight(a.toDate) >= m0);
            if (policy.maxApplicationsPerMonth > 0 && inMonth.length + 1 > policy.maxApplicationsPerMonth) {
                return { ok: false, message: `Only ${policy.maxApplicationsPerMonth} application(s) of this type are allowed per month (${label})` };
            }
            if (policy.maxDaysPerMonth > 0) {
                let already = 0;
                for (const a of inMonth) already += await daysIn(a.fromDate, a.toDate, a.totalDays, m0, m1);
                const mineNow = await daysIn(from, to, totalDays, m0, m1);
                if (already + mineNow > policy.maxDaysPerMonth) {
                    return { ok: false, message: `Only ${policy.maxDaysPerMonth} day(s) of this type are allowed per month; ${Math.round(already * 100) / 100} already applied for in ${label}` };
                }
            }
        }
    }
    // Per year means per ACADEMIC year — the year balances are kept in. A school
    // with no year on record falls back to the calendar year.
    if (policy.maxApplicationsPerYear > 0) {
        const yStart = ctx.year?.startDate ? utcMidnight(ctx.year.startDate) : new Date(Date.UTC(from.getUTCFullYear(), 0, 1));
        const yEnd   = ctx.year?.endDate   ? utcMidnight(ctx.year.endDate)   : new Date(Date.UTC(from.getUTCFullYear(), 11, 31));
        const q = {
            teacher: teacherId, school: schoolId, leaveType: typeId,
            status: { $in: countable }, fromDate: { $gte: yStart, $lte: yEnd },
        };
        if (excludeId) q._id = { $ne: excludeId };
        const n = await LeaveApplication.countDocuments(q);
        if (n + 1 > policy.maxApplicationsPerYear) {
            return { ok: false, message: `Only ${policy.maxApplicationsPerYear} application(s) of this type are allowed per year` };
        }
    }

    // ── Clubbing with other leave types ────────────────────────────────────
    // Both sides' rules apply — a type that refuses to sit next to Earned
    // Leave refuses it whichever of the two was filed second — and "next to"
    // looks across a weekend or holiday, which is how the two would actually
    // be taken.
    const others = near.filter((a) => sid(a.leaveType) !== typeId);
    const neighbours = [];
    for (const a of others) {
        const before = utcMidnight(a.toDate) < from && await touches(a.toDate, from);
        const after  = utcMidnight(a.fromDate) > to && await touches(to, a.fromDate);
        if (before || after) neighbours.push(a);
    }
    if (neighbours.length) {
        const mineBlocks = new Set((policy.blockedLeaveTypes || []).map(String));
        for (const n of neighbours) {
            const theirs = await getPolicy(schoolId, n.leaveType);
            const theirName = theirs?.leaveType?.name || 'another leave type';
            if (!policy.allowCombineWithOtherLeaves || mineBlocks.has(sid(n.leaveType))) {
                return { ok: false, message: `${policy.leaveType?.name || 'This leave type'} cannot be combined with ${theirName}` };
            }
            if (theirs && (!theirs.allowCombineWithOtherLeaves || (theirs.blockedLeaveTypes || []).map(String).includes(typeId))) {
                return { ok: false, message: `${theirName} cannot be combined with ${policy.leaveType?.name || 'this leave type'}` };
            }
        }
    }

    return { ok: true };
}

/**
 * How much balance an application may draw, allowing for a configured overdraft.
 *
 * `rawRemaining` is the balance BEFORE flooring at zero (utils/leaveDays
 * rawRemainingOf), so an overdraft already taken counts against the cap: with
 * a 2-day overdraft and nothing allocated, the first 2-day application uses it
 * all and the next one finds nothing — instead of every application getting a
 * fresh 2 days.
 */
function spendableFrom(policy, rawRemaining) {
    const r = Number(rawRemaining) || 0;
    if (!policy.allowNegativeBalance) return Math.max(0, r);
    if (!(policy.maxNegativeDays > 0)) return Infinity;      // 0 = no limit
    return Math.max(0, r + policy.maxNegativeDays);
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
 * May this user sign off leave of this type?
 *
 * @param opts.designation optional pre-resolved designation. Callers that ask
 *        about many leave types in a row should pass it — without it this
 *        reloads the same profile once per type, which is how the approver
 *        queue managed ten identical lookups on every open.
 * @param opts.moduleAdmin true when the caller holds ADMINISTRATIVE access to
 *        the leave module. "Admin" in an approval mode means an administrator
 *        of leave, not the school_admin role: a designation granting admin on
 *        the leave module puts a teacher on the module's admin screens, and
 *        without this they would be refused by every action on them.
 * @param opts.applicantId the employee the application belongs to. Nobody signs
 *        off their own leave — a principal who approves leave by designation,
 *        or a teacher who administers the module, is an applicant like any
 *        other when it is theirs.
 */
async function canApprove(userId, userRole, schoolId, policy, opts = {}) {
    const { designation, moduleAdmin = false, applicantId = null } = typeof opts === 'string'
        ? { designation: opts }          // legacy positional form
        : opts;
    if (applicantId && String(applicantId) === String(userId)) return false;
    const mode = policy.approval.mode;
    const isAdmin = userRole === 'school_admin' || moduleAdmin === true;
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

/**
 * Everyone who should be told a new application needs their attention.
 *
 * Mirrors canApprove exactly — whoever the policy lets sign off is who gets
 * told there is something to sign off, or the queue fills for people who never
 * hear about it. That is why "admin" resolves through leaveAdminIds rather than
 * schoolAdminIds: a designation granting ADMIN on the leave module makes that
 * teacher an administrator of leave, and canApprove has treated them as one
 * since the module-admin fix.
 */
async function approverIds(schoolId, policy, { exclude = null } = {}) {
    const ids = new Set();
    const mode = policy.approval.mode;
    if (mode === 'admin' || mode === 'both') {
        (await leaveAdminIds(schoolId)).forEach((id) => ids.add(String(id)));
    }
    const designations = policy.approval.approverDesignations || [];
    if ((mode === 'designation' || mode === 'both') && designations.length) {
        const profiles = await TeacherProfile.find({ school: schoolId, designation: { $in: designations } })
            .select('user').lean();
        // Only people who can still sign in — a designation held by someone who
        // has left would otherwise collect the requests nobody else sees.
        const active = profiles.length
            ? await User.find({ _id: { $in: profiles.map((p) => String(p.user)) }, school: schoolId, isActive: true }).select('_id').lean()
            : [];
        active.forEach((u) => ids.add(String(u._id)));
    }
    // The applicant never decides their own request, so is never asked to.
    if (exclude) ids.delete(String(exclude));
    // Misconfigured — nobody named, or a designation nobody holds. The
    // administrators keep the keys, the same fallback canApprove applies.
    if (!ids.size) (await leaveAdminIds(schoolId)).forEach((id) => { if (String(id) !== String(exclude)) ids.add(String(id)); });
    return [...ids];
}

/**
 * Everyone who administers leave for this school: its school admins, plus the
 * teachers whose designation grants ADMIN on the leave module.
 *
 * The audience for the module's administrative notices. Falls back to the
 * school admins alone if the lookup fails, so a Redis or designation problem
 * degrades to the old behaviour rather than to silence.
 */
async function leaveAdminIds(schoolId) {
    const ids = await designationSvc.moduleAdminIds(schoolId, 'leave');
    return ids.length ? ids : (await schoolAdminIds(schoolId)).map(String);
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
    leaveAdminIds,
    designationOf,
    approverIds,
    eligibleTypesFor,
};
