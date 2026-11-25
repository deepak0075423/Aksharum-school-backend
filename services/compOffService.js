'use strict';
/**
 * Compensatory Off engine.
 * ────────────────────────
 * Everything that decides *whether* comp off may be earned, *how much*, *when
 * it lapses* and *who signs it off* lives here. Controllers only marshal HTTP.
 *
 * Two hard invariants this module exists to protect:
 *
 *   1. Comp off works only when the leave module is enabled AND the school has
 *      an active leave type with category 'compoff'. `resolveContext()` is the
 *      single gate — every entry point goes through it.
 *
 *   2. Balance is credited ONLY by `approveRequest()` once the final sign-off
 *      lands, in the same transaction that marks the request approved.
 *      Creating, drafting, submitting or half-approving a claim never touches
 *      LeaveBalance.
 *
 * Comp off deliberately owns no balance table of its own — it credits the
 * school's existing LeaveBalance row for the COMPOFF leave type, and spending
 * it is an ordinary LeaveApplication against that same type.
 */
const CompOffPolicy    = require('../models/CompOffPolicy');
const CompOffRequest   = require('../models/CompOffRequest');
const LeaveLedger      = require('../models/LeaveLedger');
const LeaveType        = require('../models/LeaveType');
const LeaveBalance     = require('../models/LeaveBalance');
const LeaveApplication = require('../models/LeaveApplication');
const TeacherProfile   = require('../models/TeacherProfile');
const School           = require('../models/School');
const User             = require('../models/User');
const { notify } = require('./notifyService');
// Comp off lives inside the leave module, so it borrows that module's idea of
// who administers it. No cycle: leavePolicyService does not require this file.
const leavePolicy = require('./leavePolicyService');
const {
    normalizeLeaveSettings, isSaturdayWorking, staffHolidaysInRange,
    getActiveAcademicYearLabel, remainingOf, utcMidnight, localToday,
} = require('../utils/leaveDays');
const tx = require('./leaveBalanceTx');
const { patch } = require('../db/patch');

const fmtDate = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const DAY_MS  = 24 * 60 * 60 * 1000;
const round2  = n => Math.round(n * 100) / 100;

// ── Policy ────────────────────────────────────────────────────────────────────

// Mirrors the CompOffPolicy schema defaults. A school that never opened the
// policy screen still gets a complete, working rule set — and `lean()` reads
// return raw columns without defaults, so merging here covers both cases.
const POLICY_DEFAULTS = {
    eligibleDesignations: [],
    eligibleRoles:        ['teacher', 'school_admin'],
    minWorkingHours: 4,
    halfDayHours:    4,
    fullDayHours:    8,
    eligibleDays:    { holiday: true, weeklyOff: true, sunday: true },
    allowWorkingDays:   false,
    applyWithinDays:    30,
    maxPerMonth:        0,
    maxPerYear:         0,
    validityDays:       90,
    halfDayAllowed:              true,
    advanceCompOffAllowed:       false,
    approval: { mode: 'admin', approverDesignations: [], twoLevel: false, secondApprover: { kind: 'any', values: [] } },
    autoGenerateFromAttendance: true,
    expiryNotification: { enabled: true, daysBefore: 7 },
    isActive: true,
};

function mergePolicy(row) {
    const p = { ...POLICY_DEFAULTS, ...(row || {}) };
    p.eligibleDays       = { ...POLICY_DEFAULTS.eligibleDays,       ...(row?.eligibleDays       || {}) };
    p.approval           = { ...POLICY_DEFAULTS.approval,           ...(row?.approval           || {}) };
    p.expiryNotification = { ...POLICY_DEFAULTS.expiryNotification, ...(row?.expiryNotification || {}) };
    // Guard the one combination that would silently deny everything
    if (!(p.fullDayHours > 0)) p.fullDayHours = POLICY_DEFAULTS.fullDayHours;
    if (!(p.halfDayHours > 0)) p.halfDayHours = POLICY_DEFAULTS.halfDayHours;
    return p;
}

async function getPolicy(schoolId) {
    const row = await CompOffPolicy.findOne({ school: schoolId }).lean();
    return mergePolicy(row);
}

async function savePolicy(schoolId, patch, userId) {
    const clean = {};
    const num  = v => (v === '' || v == null || isNaN(Number(v)) ? undefined : Number(v));
    const list = v => (Array.isArray(v) ? v.map(String).filter(Boolean) : undefined);

    if (list(patch.eligibleDesignations)) clean.eligibleDesignations = list(patch.eligibleDesignations);
    if (list(patch.eligibleRoles))        clean.eligibleRoles        = list(patch.eligibleRoles);
    for (const k of ['minWorkingHours', 'halfDayHours', 'fullDayHours', 'applyWithinDays',
                     'maxPerMonth', 'maxPerYear', 'validityDays']) {
        const v = num(patch[k]);
        if (v !== undefined) clean[k] = Math.max(0, v);
    }
    if (patch.eligibleDays) {
        clean.eligibleDays = {
            holiday:   !!patch.eligibleDays.holiday,
            weeklyOff: !!patch.eligibleDays.weeklyOff,
            sunday:    !!patch.eligibleDays.sunday,
        };
    }
    for (const k of ['allowWorkingDays', 'halfDayAllowed', 'advanceCompOffAllowed',
                     'autoGenerateFromAttendance', 'isActive']) {
        if (patch[k] !== undefined) clean[k] = !!patch[k];
    }
    if (patch.approval) {
        const mode = ['admin', 'designation', 'both'].includes(patch.approval.mode)
            ? patch.approval.mode : 'admin';
        const second = patch.approval.secondApprover || {};
        const kind = ['designation', 'department', 'teacher'].includes(second.kind) ? second.kind : 'any';
        const values = kind === 'any' ? [] : (list(second.values) || []).map(String).filter(Boolean);
        clean.approval = {
            mode,
            approverDesignations: list(patch.approval.approverDesignations) || [],
            twoLevel: !!patch.approval.twoLevel,
            // A rule naming nobody would block every second sign-off: it is
            // stored as 'any' instead.
            secondApprover: { kind: values.length ? kind : 'any', values },
        };
    }
    if (patch.expiryNotification) {
        clean.expiryNotification = {
            enabled:    !!patch.expiryNotification.enabled,
            daysBefore: Math.max(0, num(patch.expiryNotification.daysBefore) || 0),
        };
    }

    // A half day that costs more than a full day is unreachable — clamp rather
    // than let the school save a rule that can never fire.
    if (clean.halfDayHours != null && clean.fullDayHours != null && clean.halfDayHours > clean.fullDayHours) {
        clean.halfDayHours = clean.fullDayHours;
    }

    const saved = await CompOffPolicy.findOneAndUpdate(
        { school: schoolId },
        { $set: { ...clean, updatedBy: userId }, $setOnInsert: { school: schoolId } },
        { upsert: true, new: true },
    );
    return mergePolicy(saved.toObject ? saved.toObject() : saved);
}

// ── Context gate ──────────────────────────────────────────────────────────────

/**
 * The single "is comp off available here?" check.
 * @returns {Object} { enabled, reason?, leaveType, policy, school, leaveSettings,
 *                     holidayModule, attendanceModule }
 */
async function resolveContext(schoolId) {
    const school = await School.findById(schoolId).select('modules leaveSettings designations').lean();
    const modules = school?.modules || {};

    if (!modules.leave) {
        return { enabled: false, reason: 'Leave module is not enabled for your school', school, modules };
    }

    // 'compoff' category is the contract; the COMPOFF code is honoured too so a
    // school that created the type before this field existed still works.
    const types = await LeaveType.find({ school: schoolId, isActive: true }).lean();
    const leaveType = types.find(t => t.category === 'compoff')
                   || types.find(t => String(t.code).toUpperCase() === 'COMPOFF');
    if (!leaveType) {
        return {
            enabled: false,
            reason: 'No active Comp Off leave type. Create a leave type with category "Comp Off" first.',
            school, modules,
        };
    }

    const policy = await getPolicy(schoolId);
    if (!policy.isActive) {
        return { enabled: false, reason: 'Comp Off is switched off in the Comp Off policy', school, modules, policy, leaveType };
    }

    return {
        enabled: true,
        leaveType,
        policy,
        school,
        modules,
        leaveSettings:    normalizeLeaveSettings(school?.leaveSettings),
        holidayModule:    !!modules.holiday,
        attendanceModule: !!modules.attendance,
    };
}

// ── Work-date classification ──────────────────────────────────────────────────

/**
 * What kind of day is this for the school?
 *
 * Scenario 1 (holiday module OFF) cannot answer this — it returns 'unknown',
 * which the eligibility check treats as "admin decides", never as an automatic
 * denial. Scenarios 2 and 3 (holiday module ON) get a real classification and
 * the policy's eligibleDays rules bite.
 */
async function classifyWorkDate(schoolId, date, ctx) {
    const day = utcMidnight(date);
    const dow = day.getUTCDay();

    if (ctx.holidayModule) {
        const holidays = await staffHolidaysInRange(day, day, schoolId);
        const hit = holidays.find(h => utcMidnight(h.startDate) <= day && utcMidnight(h.endDate) >= day);
        if (hit) {
            return { category: 'holiday', label: hit.name, holiday: hit._id };
        }
    }
    if (dow === 0) return { category: 'sunday', label: 'Sunday', holiday: null };
    if (dow === 6 && !isSaturdayWorking(day, ctx.leaveSettings)) {
        return { category: 'weekly_off', label: 'Weekly Off (Saturday)', holiday: null };
    }
    // Without the holiday module a plain weekday cannot be told apart from an
    // unrecorded school holiday — say so instead of guessing.
    if (!ctx.holidayModule && dow !== 0) {
        return { category: 'unknown', label: '', holiday: null };
    }
    return { category: 'working_day', label: 'Working Day', holiday: null };
}

// 'HH:mm' → decimal hours worked. Handles a shift that crosses midnight.
function hoursBetween(checkIn, checkOut) {
    const parse = t => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
        if (!m) return null;
        const h = +m[1], min = +m[2];
        if (h > 23 || min > 59) return null;
        return h * 60 + min;
    };
    const a = parse(checkIn), b = parse(checkOut);
    if (a == null || b == null) return 0;
    const mins = b >= a ? b - a : (24 * 60 - a) + b;
    return round2(mins / 60);
}

/** Hours → comp off days, purely from policy thresholds. */
function computeCompOffDays(workedHours, policy) {
    const h = Number(workedHours) || 0;
    if (h < policy.minWorkingHours) return 0;
    if (h >= policy.fullDayHours)   return 1;
    if (policy.halfDayAllowed && h >= policy.halfDayHours) return 0.5;
    // Cleared the minimum but fell short of a full day, and half days are
    // switched off — the school has chosen that such a day earns nothing.
    return 0;
}

// ── Eligibility ───────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = ['draft', 'pending', 'approved'];

/** A live claim already covering this work date, if any. */
async function findDuplicate(teacherId, schoolId, workDate, excludeId = null) {
    const day = utcMidnight(workDate);
    const q = {
        teacher: teacherId,
        school:  schoolId,
        workDate: day,
        status: { $in: ACTIVE_STATUSES },
    };
    if (excludeId) q._id = { $ne: excludeId };
    return CompOffRequest.findOne(q).lean();
}

async function earnedInWindow(teacherId, schoolId, from, to) {
    const rows = await CompOffRequest.find({
        teacher: teacherId, school: schoolId,
        status: { $in: ['pending', 'approved'] },
        workDate: { $gte: from, $lte: to },
    }).select('compOffDays').lean();
    return rows.reduce((s, r) => s + (Number(r.compOffDays) || 0), 0);
}

/**
 * Every policy rule that governs *earning* comp off for one work date.
 * Returns { ok: true, ... } or { ok: false, message }.
 */
async function checkEligibility({ ctx, teacherId, workDate, compOffDays, workedHours, classification, excludeId = null }) {
    const { policy } = ctx;
    const day   = utcMidnight(workDate);
    const today = localToday();

    if (isNaN(day.getTime())) return { ok: false, message: 'Invalid work date' };
    if (compOffDays != null && compOffDays > 1) {
        return { ok: false, message: 'One work date earns at most one day of Comp Off' };
    }

    // Who — role + designation
    const user = await User.findOne({ _id: teacherId, school: ctx.school._id }).select('role name isActive').lean();
    if (!user || !user.isActive) return { ok: false, message: 'Employee not found' };
    if (policy.eligibleRoles.length && !policy.eligibleRoles.includes(user.role)) {
        return { ok: false, message: 'Your employee type is not eligible for Comp Off' };
    }
    if (policy.eligibleDesignations.length) {
        const profile = await TeacherProfile.findOne({ user: teacherId, school: ctx.school._id }).select('designation').lean();
        if (!policy.eligibleDesignations.includes(profile?.designation || '')) {
            return { ok: false, message: 'Your designation is not eligible for Comp Off' };
        }
    }

    // When — advance claims and the application deadline
    if (day > today && !policy.advanceCompOffAllowed) {
        return { ok: false, message: 'Comp Off cannot be claimed for a future date' };
    }
    if (policy.applyWithinDays > 0 && day <= today) {
        const ageDays = Math.floor((today - day) / DAY_MS);
        if (ageDays > policy.applyWithinDays) {
            return { ok: false, message: `Comp Off must be applied within ${policy.applyWithinDays} day(s) of working. This date is ${ageDays} day(s) old.` };
        }
    }

    // What kind of day — only meaningful once the holiday module can classify it
    const cat = classification.category;
    if (cat === 'holiday'     && !policy.eligibleDays.holiday)   return { ok: false, message: 'Comp Off is not allowed for holidays under the current policy' };
    if (cat === 'weekly_off'  && !policy.eligibleDays.weeklyOff) return { ok: false, message: 'Comp Off is not allowed for weekly offs under the current policy' };
    if (cat === 'sunday'      && !policy.eligibleDays.sunday)    return { ok: false, message: 'Comp Off is not allowed for Sundays under the current policy' };
    if (cat === 'working_day' && !policy.allowWorkingDays)       return { ok: false, message: 'Comp Off is not allowed for regular working days under the current policy' };

    // Hours
    if (workedHours != null && workedHours > 0 && workedHours < policy.minWorkingHours) {
        return { ok: false, message: `Minimum ${policy.minWorkingHours} working hour(s) required for Comp Off — ${workedHours} recorded` };
    }
    if (!(compOffDays > 0)) {
        return { ok: false, message: 'The hours worked do not qualify for any Comp Off under the current policy' };
    }
    if (compOffDays === 0.5 && !policy.halfDayAllowed) {
        return { ok: false, message: 'Half-day Comp Off is not allowed under the current policy' };
    }

    // No two live claims for the same day
    const dup = await findDuplicate(teacherId, ctx.school._id, day, excludeId);
    if (dup) {
        return { ok: false, message: `A Comp Off request for ${fmtDate(day)} already exists (${dup.status})`, duplicate: dup };
    }

    // Caps
    if (policy.maxPerMonth > 0) {
        const mStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
        const mEnd   = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0));
        const already = await earnedInWindow(teacherId, ctx.school._id, mStart, mEnd);
        if (already + compOffDays > policy.maxPerMonth) {
            return { ok: false, message: `Monthly Comp Off limit reached (${policy.maxPerMonth} day(s)); ${already} already claimed this month` };
        }
    }
    if (policy.maxPerYear > 0) {
        const yStart = new Date(Date.UTC(day.getUTCFullYear() - 1, 0, 1));
        const yEnd   = new Date(Date.UTC(day.getUTCFullYear() + 1, 11, 31));
        const rows = await CompOffRequest.find({
            teacher: teacherId, school: ctx.school._id,
            status: { $in: ['pending', 'approved'] },
            workDate: { $gte: yStart, $lte: yEnd },
        }).select('compOffDays academicYear').lean();
        const ay = await getActiveAcademicYearLabel(ctx.school._id);
        const already = rows.filter(r => !ay || !r.academicYear || r.academicYear === ay)
                            .reduce((s, r) => s + (Number(r.compOffDays) || 0), 0);
        if (already + compOffDays > policy.maxPerYear) {
            return { ok: false, message: `Yearly Comp Off limit reached (${policy.maxPerYear} day(s)); ${already} already claimed this year` };
        }
    }

    return { ok: true, user };
}

// A frozen copy of the rules a request was judged under, so a later policy edit
// never rewrites the terms of a claim already in flight.
function snapshotPolicy(policy) {
    return {
        minWorkingHours: policy.minWorkingHours,
        halfDayHours:    policy.halfDayHours,
        fullDayHours:    policy.fullDayHours,
        eligibleDays:    { ...policy.eligibleDays },
        allowWorkingDays: policy.allowWorkingDays,
        applyWithinDays:  policy.applyWithinDays,
        validityDays:     policy.validityDays,
        halfDayAllowed:   policy.halfDayAllowed,
        approval:         { ...policy.approval },
        capturedAt:       new Date().toISOString(),
    };
}

// ── Approver RBAC ─────────────────────────────────────────────────────────────

/**
 * May this user sign off comp off requests for this school?
 *
 * `moduleAdmin` is true when the caller holds ADMINISTRATIVE access to the leave
 * module (comp off lives inside it). "Admin" in an approval mode means an
 * administrator of leave, not the school_admin role.
 *
 * `applicantId`, when given, is the claimant — nobody signs off their own claim.
 */
async function canApprove(userId, userRole, schoolId, policy, moduleAdmin = false, applicantId = null) {
    if (applicantId && String(applicantId) === String(userId)) return false;
    const mode = policy.approval.mode;
    const isAdmin = userRole === 'school_admin' || moduleAdmin === true;
    if (mode === 'admin')       return isAdmin;
    if (mode === 'both'  && isAdmin) return true;

    const designations = policy.approval.approverDesignations || [];
    if (!designations.length) return isAdmin;   // misconfigured → admins keep the keys
    const profile = await TeacherProfile.findOne({ user: userId, school: schoolId }).select('designation').lean();
    return designations.includes(profile?.designation || '');
}

// ── The second sign-off (Nov 26 2026) ───────────────────────────────────────
// With two sign-offs on, the policy may name who gives the second: holders of
// a designation, a department, or named teachers. They give ONLY the second
// (spending it on the first would leave nobody to give the second), and only
// they may give it — unless nobody active matches any more, when school
// admins may, so a request can never be stranded.

/** The rule in force, or null when the second sign-off is anyone's. */
function secondRule(policy) {
    const a = policy?.approval || {};
    const r = a.secondApprover || {};
    const values = Array.isArray(r.values) ? r.values.map(String).filter(Boolean) : [];
    if (!a.twoLevel || !['designation', 'department', 'teacher'].includes(r.kind) || !values.length) return null;
    return { kind: r.kind, values };
}

/** Whether this user is one the rule names. */
async function isSecondApprover(userId, schoolId, policy) {
    const rule = secondRule(policy);
    if (!rule) return false;
    if (rule.kind === 'teacher') return rule.values.includes(String(userId));
    const p = await TeacherProfile.findOne({ user: userId, school: schoolId }).select('designation department').lean();
    return rule.values.includes(String((rule.kind === 'designation' ? p?.designation : p?.department) || ''));
}

/** Everyone (still active) the rule names, less `exclude`. */
async function secondApproverIds(schoolId, policy, { exclude = null } = {}) {
    const rule = secondRule(policy);
    if (!rule) return [];
    let ids = rule.values;
    if (rule.kind !== 'teacher') {
        const profiles = await TeacherProfile.find({ school: schoolId, [rule.kind]: { $in: rule.values } }).select('user').lean();
        ids = profiles.map((p) => String(p.user));
    }
    const active = ids.length
        ? await User.find({ _id: { $in: ids }, school: schoolId, isActive: true }).select('_id').lean()
        : [];
    return active.map((u) => String(u._id)).filter((id) => id !== String(exclude || ''));
}

/** "the Vice Principal designation", "the Science department", "Priya Sharma". */
async function describeSecond(schoolId, policy) {
    const rule = secondRule(policy);
    if (!rule) return 'another approver';
    if (rule.kind === 'teacher') {
        const users = await User.find({ _id: { $in: rule.values }, school: schoolId }).select('name').lean();
        return users.map((u) => u.name).join(', ') || 'the named teacher';
    }
    return `the ${rule.values.join(' / ')} ${rule.kind === 'designation' ? 'designation' : 'department'}`;
}

/**
 * May this user give the NEXT sign-off on this request? { ok, message }.
 * `level` is the sign-off they would give (1 = first).
 */
async function mayDecide(request, policy, { actorId, actorRole, moduleAdmin = false, level = null }) {
    if (String(request.teacher?._id || request.teacher) === String(actorId)) {
        return { ok: false, message: 'You cannot decide your own Comp Off request' };
    }
    const required = Number(request.approvalsRequired) || 1;
    const next = level || (Array.isArray(request.approvals) ? request.approvals.length : Number(request.approvalLevel) || 0) + 1;
    const rule = required >= 2 ? secondRule(policy) : null;
    if (rule) {
        const second = await isSecondApprover(actorId, request.school, policy);
        if (next >= required) {
            if (second) return { ok: true };
            const left = await secondApproverIds(request.school, policy, { exclude: request.teacher?._id || request.teacher });
            if (!left.length && actorRole === 'school_admin') return { ok: true };
            return { ok: false, message: `The second sign-off on this request is for ${await describeSecond(request.school, policy)}` };
        }
        if (second) {
            return { ok: false, message: 'You give the second sign-off — this request needs its first approval from another approver first' };
        }
    }
    const allowed = await canApprove(actorId, actorRole, request.school, policy, moduleAdmin, request.teacher?._id || request.teacher);
    return allowed ? { ok: true } : { ok: false, message: 'You are not an approver for Comp Off requests' };
}

/**
 * Everyone who should see "a new comp off request needs your attention" —
 * the same people canApprove lets decide, minus the claimant.
 */
async function approverIds(schoolId, policy, { exclude = null } = {}) {
    const ids = new Set();
    const mode = policy.approval.mode;
    const admins = () => leavePolicy.leaveAdminIds(schoolId);
    if (mode === 'admin' || mode === 'both') {
        (await admins()).forEach(id => ids.add(String(id)));
    }
    const designations = policy.approval.approverDesignations || [];
    if ((mode === 'designation' || mode === 'both') && designations.length) {
        const profiles = await TeacherProfile.find({
            school: schoolId, designation: { $in: designations },
        }).select('user').lean();
        const active = profiles.length
            ? await User.find({ _id: { $in: profiles.map((p) => String(p.user)) }, school: schoolId, isActive: true }).select('_id').lean()
            : [];
        active.forEach(u => ids.add(String(u._id)));
    }
    if (exclude) ids.delete(String(exclude));
    if (!ids.size) (await admins()).forEach(id => { if (String(id) !== String(exclude)) ids.add(String(id)); });
    return [...ids];
}

// ── Ledger + balance ──────────────────────────────────────────────────────────
//
// Every balance and lot movement goes through services/leaveBalanceTx — one
// transaction per move, under the balance's lock, with its ledger row. The
// ORM's read-modify-write `$inc` used to lose concurrent updates here.

const keyOf = (r) => ({ schoolId: r.school, teacherId: r.teacher, leaveTypeId: r.leaveType, academicYear: r.academicYear });

/**
 * Withdraw an approved credit (an admin cancels an approved comp off).
 *
 * Refused when the days have been spent — the leave has to be reversed first —
 * and when they are HELD by a comp off leave still awaiting a decision: taking
 * them away under a pending application would let that leave be approved
 * against days that no longer exist.
 */
async function reverseCredit(request, { entryType = 'CANCELLED', actorId = null, comment = '' } = {}) {
    if (!request.creditedAt || !(request.creditedDays > 0)) return { reversed: 0 };
    const k = keyOf(request);
    return tx.withTransaction(async (q) => {
        await tx.lock(q, tx.balanceKey(k.schoolId, k.teacherId, k.leaveTypeId, k.academicYear));
        const lot = request.ledgerEntry
            ? (await q(`SELECT * FROM "${LeaveLedger.tableName}" WHERE "_id" = $1::uuid FOR UPDATE`, [String(request.ledgerEntry)])).rows[0]
            : null;
        const stillUnused = lot ? Number(lot.remainingDays) || 0 : Number(request.creditedDays) || 0;
        if (stillUnused < request.creditedDays) {
            const spent = round2(request.creditedDays - stillUnused);
            throw Object.assign(new Error(`${spent} day(s) of this Comp Off have already been used — reverse the leave first`), { status: 400 });
        }
        if (!(stillUnused > 0)) return { reversed: 0 };
        const bal = await tx.balanceRow(q, k);
        if (remainingOf(bal) < stillUnused) {
            throw Object.assign(new Error(
                `${round2(stillUnused - remainingOf(bal))} day(s) of this Comp Off are held by a pending Comp Off leave — decide that leave first`,
            ), { status: 400 });
        }
        const after = await tx.writeBalance(q, k, { inc: { totalAllocated: -stillUnused } });
        if (lot) await q(`UPDATE "${LeaveLedger.tableName}" SET "remainingDays" = 0 WHERE "_id" = $1::uuid`, [String(lot._id)]);
        await tx.writeLedger(q, k, {
            entryType, days: stillUnused, delta: -stillUnused,
            source: 'compoff', referenceType: 'CompOffRequest', referenceId: request._id,
            description: `Comp Off for ${fmtDate(request.workDate)} withdrawn${comment ? ` — ${comment}` : ''}`,
            createdBy: actorId,
        }, after);
        await patch(CompOffRequest, request._id, { creditedDays: 0, ledgerEntry: null }, { q });
        return { reversed: stillUnused };
    });
}

/**
 * A manual correction of one employee's comp off balance. A positive one opens
 * a lot (spendable, and lapsing with the policy's validity like any credit); a
 * negative one is taken from the lots, oldest expiry first — it used to leave
 * the lots full, and the expiry sweep then lapsed the same days a second time.
 */
async function adjust({ ctx, schoolId, teacherId, academicYear, delta, description, actorId }) {
    const k = { schoolId, teacherId, leaveTypeId: ctx.leaveType._id, academicYear };
    return tx.withTransaction(async (q) => {
        await tx.lock(q, tx.balanceKey(k.schoolId, k.teacherId, k.leaveTypeId, k.academicYear));
        const bal = await tx.balanceRow(q, k);
        if (delta < 0 && remainingOf(bal) < Math.abs(delta)) {
            throw Object.assign(new Error(`Cannot deduct ${Math.abs(delta)} day(s) — only ${remainingOf(bal)} available`), { status: 400 });
        }
        const after = await tx.writeBalance(q, k, { inc: { totalAllocated: delta } });
        if (delta < 0) await tx.drainLots(q, k, Math.abs(delta));
        return tx.writeLedger(q, k, {
            entryType: 'ADJUSTMENT', days: Math.abs(delta), delta,
            remainingDays: delta > 0 ? delta : 0,
            expiresAt: delta > 0 && ctx.policy.validityDays > 0
                ? new Date(Date.now() + ctx.policy.validityDays * DAY_MS) : null,
            source: 'compoff', referenceType: 'Manual',
            description, createdBy: actorId,
        }, after);
    });
}

/**
 * Hours worked on `day` as the attendance register recorded them — what "Auto
 * Calculate" on the apply form means. null when there is no usable record.
 */
async function recordedHours(teacherId, schoolId, day) {
    try {
        const TeacherAttendance = require('../models/TeacherAttendance');
        const d = utcMidnight(day);
        const rec = await TeacherAttendance.findOne({
            teacher: teacherId, school: schoolId,
            date: { $gte: d, $lte: new Date(d.getTime() + DAY_MS - 1) },
        }).select('checkIn checkOut status').lean();
        if (!rec?.checkIn || !rec?.checkOut) return null;
        const hours = hoursBetween(rec.checkIn, rec.checkOut);
        return hours > 0 ? { hours, checkIn: rec.checkIn, checkOut: rec.checkOut, attendanceId: rec._id } : null;
    } catch { return null; }
}

// ── Submission / approval ─────────────────────────────────────────────────────

/**
 * Create a comp off claim.
 * @param {String}  mode     'submit' → status 'pending' (awaiting approval)
 *                           'draft'  → status 'draft'   (ready-to-apply, scenario 3)
 * @param {Boolean} byAdmin  only an administrator raising a claim by hand may
 *                           name the days (0.5 or 1). For everyone else the
 *                           figure is the POLICY's, from the hours worked —
 *                           the employee's own request body used to set it, so
 *                           one Sunday could be claimed as five days.
 * Neither touches the balance.
 */
async function createRequest({ ctx, teacherId, workDate, checkIn = '', checkOut = '', workedHours,
                               compOffDays, reason = '', document = null, source = 'manual',
                               attendanceId = null, mode = 'submit', actorId = null, byAdmin = false }) {
    const day = utcMidnight(workDate);
    if (isNaN(day.getTime())) return { ok: false, message: 'Invalid work date' };
    const classification = await classifyWorkDate(ctx.school._id, day, ctx);

    // Hours: typed times, or — when none were typed — what the attendance
    // register recorded for that day ("Auto Calculate").
    let hours = byAdmin && workedHours != null && workedHours !== '' ? Number(workedHours) : null;
    if (hours == null && checkIn && checkOut) hours = hoursBetween(checkIn, checkOut);
    let attendance = attendanceId;
    if (hours == null || !(hours > 0)) {
        const rec = await recordedHours(teacherId, ctx.school._id, day);
        if (rec) {
            hours = rec.hours; checkIn = rec.checkIn; checkOut = rec.checkOut;
            attendance = attendance || rec.attendanceId;
        }
    }
    hours = round2(Number(hours) || 0);

    const named = byAdmin && compOffDays != null && compOffDays !== '';
    if (named && ![0.5, 1].includes(Number(compOffDays))) {
        return { ok: false, message: 'Comp Off for one work date is either a half day (0.5) or a full day (1)' };
    }
    let days;
    if (named) days = Number(compOffDays);
    else if (hours > 0) days = computeCompOffDays(hours, ctx.policy);
    else if (byAdmin) days = 1;        // an administrator judging a claim by hand, with nothing recorded
    else {
        return {
            ok: false,
            message: 'Enter the times you worked that day — there is no attendance record to work them out from',
        };
    }

    const check = await checkEligibility({
        ctx, teacherId, workDate: day, compOffDays: days,
        workedHours: hours, classification,
    });
    if (!check.ok) return { ok: false, message: check.message, duplicate: check.duplicate };

    const ay = await getActiveAcademicYearLabel(ctx.school._id);
    if (!ay) return { ok: false, message: 'No active academic year' };

    const request = await CompOffRequest.create({
        teacher: teacherId,
        school:  ctx.school._id,
        leaveType: ctx.leaveType._id,
        workDate: day,
        source,
        attendance,
        holiday:    classification.holiday,
        dayCategory: classification.category,
        dayLabel:    classification.label,
        checkIn, checkOut,
        workedHours: hours,
        compOffDays: days,
        compOffMode: days <= 0.5 ? 'half_day' : 'full_day',
        reason: String(reason || '').trim(),
        document,
        status: mode === 'draft' ? 'draft' : 'pending',
        approvalsRequired: ctx.policy.approval.twoLevel ? 2 : 1,
        approvalLevel: 0,
        approvals: [],
        appliedAt: mode === 'draft' ? null : new Date(),
        academicYear: ay,
        creditedDays: 0,          // nothing is credited before approval
        policySnapshot: snapshotPolicy(ctx.policy),
        createdBy: actorId || teacherId,
    });

    if (mode !== 'draft') await notifyNewRequest(request, ctx);
    return { ok: true, request };
}

/**
 * Move a ready-to-apply draft to pending — the employee's "Apply" click. The
 * days are the ones the draft was generated with from the attendance record;
 * the employee adds a reason, not a figure.
 */
async function submitDraft(request, ctx, { reason } = {}) {
    if (request.status !== 'draft') {
        return { ok: false, message: 'Only ready-to-apply Comp Off requests can be submitted' };
    }
    const days = Number(request.compOffDays);
    const classification = {
        category: request.dayCategory,
        label:    request.dayLabel,
        holiday:  request.holiday,
    };
    const check = await checkEligibility({
        ctx, teacherId: request.teacher, workDate: request.workDate,
        compOffDays: days, workedHours: request.workedHours,
        classification, excludeId: request._id,
    });
    if (!check.ok) return { ok: false, message: check.message };

    // Only if it is still a draft — a double-tapped Apply submits once.
    const saved = await patch(CompOffRequest, request._id, {
        reason: reason != null ? String(reason).trim() : request.reason,
        status: 'pending',
        appliedAt: new Date(),
        approvalsRequired: ctx.policy.approval.twoLevel ? 2 : 1,
        policySnapshot: snapshotPolicy(ctx.policy),
    }, { where: { status: 'draft' } });
    if (!saved) return { ok: false, message: 'This request was already submitted' };

    await notifyNewRequest(saved, ctx);
    return { ok: true, request: saved };
}

/**
 * Record one sign-off. Credit happens only when the last required level lands —
 * a first-of-two approval leaves the balance untouched.
 *
 * The whole decision is one transaction on the request's row: its status and
 * level are re-read under the lock, the approval is appended, and on the final
 * sign-off the balance, the EARNED lot and the request's credited fields are
 * written with it. Two approvers pressing at once used to both credit.
 */
async function approveRequest(request, ctx, { actorId, actorName, actorRole, moduleAdmin = false, comment = '' }) {
    if (request.status !== 'pending') {
        return { ok: false, message: 'Only pending Comp Off requests can be approved' };
    }
    if (String(request.teacher) === String(actorId)) {
        return { ok: false, forbidden: true, message: 'You cannot decide your own Comp Off request' };
    }
    // Who may give THIS sign-off — the second may be reserved (secondRule).
    const may = await mayDecide(request, ctx.policy, { actorId, actorRole, moduleAdmin });
    if (!may.ok) return { ok: false, forbidden: true, message: may.message };

    const out = await tx.withTransaction(async (q) => {
        await tx.lock(q, `compoff:request:${request._id}`);
        const { rows } = await q(`SELECT * FROM "${CompOffRequest.tableName}" WHERE "_id" = $1::uuid FOR UPDATE`, [String(request._id)]);
        const cur = rows[0];
        if (!cur || cur.status !== 'pending') return { ok: false, message: `This request was ${cur?.status || 'removed'} a moment ago` };
        const approvals = Array.isArray(cur.approvals) ? cur.approvals : [];
        if (approvals.some(a => String(a.by) === String(actorId))) {
            return { ok: false, message: 'You have already approved this request — a second sign-off must come from someone else' };
        }
        const level = approvals.length + 1;
        const entry = { level, by: String(actorId), byName: actorName || '', at: new Date().toISOString(), comment };
        const required = Number(cur.approvalsRequired) || 1;

        if (level < required) {
            const saved = await patch(CompOffRequest, request._id,
                { approvalLevel: level, adminComment: comment || cur.adminComment || '' },
                { q, push: { approvals: entry } });
            return { ok: true, request: saved, credited: 0, pendingLevels: required - level, required };
        }

        // Final sign-off — and only now does anything reach the balance.
        const days = Number(cur.compOffDays) || 0;
        const ay = cur.academicYear || await getActiveAcademicYearLabel(request.school);
        if (!ay) throw new Error('No active academic year — cannot credit Comp Off');
        const expiresAt = ctx.policy.validityDays > 0 ? new Date(Date.now() + ctx.policy.validityDays * DAY_MS) : null;
        let lot = null;
        if (days > 0) {
            const k = { schoolId: request.school, teacherId: request.teacher, leaveTypeId: request.leaveType, academicYear: ay };
            await tx.lock(q, tx.balanceKey(k.schoolId, k.teacherId, k.leaveTypeId, k.academicYear));
            const after = await tx.writeBalance(q, k, { inc: { totalAllocated: days } });
            lot = await tx.writeLedger(q, k, {
                entryType: 'EARNED', days, delta: days, remainingDays: days, expiresAt,
                source: 'compoff', referenceType: 'CompOffRequest', referenceId: request._id,
                description: `Comp Off earned for ${fmtDate(cur.workDate)}${cur.dayLabel ? ` (${cur.dayLabel})` : ''}`,
                createdBy: actorId,
            }, after);
        }
        const saved = await patch(CompOffRequest, request._id, {
            status: 'approved', approvedBy: String(actorId), approvedAt: new Date(),
            approvalLevel: level, adminComment: comment || cur.adminComment || '',
            creditedDays: days, creditedAt: new Date(), academicYear: ay, expiresAt: days > 0 ? expiresAt : null,
            ledgerEntry: lot ? lot._id : null,
        }, { q, push: { approvals: entry } });
        return { ok: true, request: saved, credited: days, expiresAt, final: true };
    });
    if (!out.ok) return out;

    if (!out.final) {
        notify({
            school: request.school, sender: actorId, senderRole: actorRole,
            title: '🕓 Comp Off — first approval recorded',
            body: `Your Comp Off request for ${fmtDate(request.workDate)} cleared level ${out.request.approvalLevel} of ${out.required}. No balance is credited until the final approval.`,
            recipients: [request.teacher],
            link: { type: 'compoff.mine', entityId: request._id },
        });
        // The second sign-off goes to whoever the policy names for it.
        secondApproverIds(request.school, ctx.policy, { exclude: request.teacher })
            .then((named) => (named.length ? named : approverIds(request.school, ctx.policy, { exclude: request.teacher })))
            .then((recipients) => notify({
            school: request.school, sender: actorId, senderRole: actorRole,
            title: '⏳ Comp Off still needs a sign-off',
            body: `A Comp Off request for ${fmtDate(request.workDate)} cleared level ${out.request.approvalLevel} of ${out.required} and is waiting on its final approval.`,
            recipients,
            link: { type: 'compoff.approvals', entityId: request._id },
        })).catch(() => {});
        return out;
    }

    notify({
        school: request.school, sender: actorId, senderRole: actorRole,
        title: '✅ Comp Off approved',
        body: `Your Comp Off for ${fmtDate(request.workDate)}${request.dayLabel ? ` (${request.dayLabel})` : ''} has been approved. `
            + `${out.credited} day(s) credited to your Comp Off balance`
            + `${out.expiresAt ? `, valid until ${fmtDate(out.expiresAt)}` : ''}.`
            + `${comment ? `\nComment: ${comment}` : ''}`,
        recipients: [request.teacher],
        email: true,
        link: { type: 'compoff.mine', entityId: request._id },
    });
    return out;
}

async function rejectRequest(request, ctx, { actorId, actorRole, moduleAdmin = false, comment = '' }) {
    if (!['pending', 'draft'].includes(request.status)) {
        return { ok: false, message: 'Only pending Comp Off requests can be rejected' };
    }
    if (String(request.teacher) === String(actorId)) {
        return { ok: false, forbidden: true, message: 'You cannot decide your own Comp Off request' };
    }
    // Any approver may turn a request down; so may whoever the policy names
    // for the second sign-off, once it is their turn.
    const allowed = await canApprove(actorId, actorRole, request.school, ctx.policy, moduleAdmin, request.teacher)
        || (await mayDecide(request, ctx.policy, { actorId, actorRole, moduleAdmin })).ok;
    if (!allowed) return { ok: false, forbidden: true, message: 'You are not an approver for Comp Off requests' };
    const why = String(comment || '').trim();
    if (!why) return { ok: false, message: 'Give a reason for rejecting this request' };

    // Only if it is still undecided: a reject that lost the race to an approval
    // used to overwrite it as "rejected" with the days already credited.
    const saved = await patch(CompOffRequest, request._id, {
        status: 'rejected', rejectedAt: new Date(), adminComment: why,
    }, { where: { status: ['pending', 'draft'] } });
    if (!saved) return { ok: false, message: 'This request was decided a moment ago — refresh to see it' };

    notify({
        school: request.school, sender: actorId, senderRole: actorRole,
        title: '❌ Comp Off rejected',
        body: `Your Comp Off request for ${fmtDate(request.workDate)} was rejected. No balance has been credited.\nReason: ${why}`,
        recipients: [request.teacher],
        email: true,
        link: { type: 'compoff.mine', entityId: request._id },
    });
    return { ok: true, request: saved };
}

async function notifyNewRequest(request, ctx) {
    try {
        const [recipients, teacher] = await Promise.all([
            approverIds(request.school, ctx.policy, { exclude: request.teacher }),
            User.findById(request.teacher).select('name').lean(),
        ]);
        notify({
            school: request.school, sender: request.teacher, senderRole: 'teacher',
            title: '🗓️ New Comp Off request',
            body: `${teacher?.name || 'An employee'} applied for ${request.compOffDays} day(s) Comp Off for work on ${fmtDate(request.workDate)}`
                + `${request.dayLabel ? ` (${request.dayLabel})` : ''}`
                + `${request.workedHours ? ` — ${request.workedHours} hour(s) worked` : ''}.`
                + `${request.reason ? `\nReason: ${request.reason}` : ''}`,
            recipients,
            link: { type: 'compoff.approvals', entityId: request._id },
        });
    } catch { /* notification failures never block the request */ }
}

// ── Scenario 3: attendance → ready-to-apply draft ─────────────────────────────

/**
 * Build a pre-filled, ready-to-apply Comp Off draft from an approved attendance
 * record on an eligible day. Called after attendance is settled (self clock-out,
 * an approved regularization, or an admin regularization).
 *
 * Silent and idempotent by design — it runs inside attendance flows and must
 * never fail them. Creates a DRAFT: the employee still has to review and click
 * Apply, and approval is still what credits the balance.
 */
async function generateFromAttendance(attendanceRecord, { actorId = null } = {}) {
    try {
        const rec = attendanceRecord;
        if (!rec?.teacher || !rec?.school || !rec?.date) return { created: false, reason: 'incomplete record' };
        if (!['Present', 'Half-Day'].includes(rec.status)) return { created: false, reason: 'not a worked day' };

        const ctx = await resolveContext(rec.school);
        if (!ctx.enabled) return { created: false, reason: ctx.reason };
        if (!ctx.attendanceModule) return { created: false, reason: 'attendance module disabled' };
        if (!ctx.policy.autoGenerateFromAttendance) return { created: false, reason: 'auto-generation disabled by policy' };

        const day = utcMidnight(rec.date);

        // Already handled — either from this same attendance row or another
        // claim for the day. This is the duplicate guard scenario 3 needs.
        const existing = await CompOffRequest.findOne({
            teacher: rec.teacher, school: rec.school,
            $or: [{ workDate: day }, { attendance: rec._id }],
        }).lean();
        if (existing) return { created: false, reason: `already exists (${existing.status})`, request: existing };

        const classification = await classifyWorkDate(rec.school, day, ctx);
        // Regular working days are just attendance — no draft unless the school
        // has explicitly opted in.
        if (classification.category === 'working_day' && !ctx.policy.allowWorkingDays) {
            return { created: false, reason: 'not an eligible day' };
        }
        if (classification.category === 'unknown') return { created: false, reason: 'day could not be classified' };

        const hours = hoursBetween(rec.checkIn, rec.checkOut);
        const days  = computeCompOffDays(hours, ctx.policy);
        if (!(days > 0)) return { created: false, reason: 'worked hours below policy minimum' };

        const check = await checkEligibility({
            ctx, teacherId: rec.teacher, workDate: day,
            compOffDays: days, workedHours: hours, classification,
        });
        if (!check.ok) return { created: false, reason: check.message };

        const result = await createRequest({
            ctx,
            teacherId: rec.teacher,
            workDate: day,
            checkIn: rec.checkIn || '', checkOut: rec.checkOut || '',
            workedHours: hours,
            compOffDays: days,
            reason: `Worked on ${classification.label || 'a non-working day'}`,
            source: 'attendance',
            attendanceId: rec._id,
            mode: 'draft',              // ready-to-apply, NOT submitted, NOT credited
            actorId,
        });
        if (!result.ok) return { created: false, reason: result.message };

        notify({
            school: rec.school, sender: actorId || rec.teacher, senderRole: 'system',
            title: '🗓️ Comp Off ready to apply',
            body: `Your attendance on ${fmtDate(day)}${classification.label ? ` (${classification.label})` : ''} qualifies for `
                + `${days} day(s) Comp Off. Open Leave → Comp Off to review and apply.`,
            recipients: [rec.teacher],
            includeSender: true,
            link: { type: 'compoff.mine', entityId: result.request?._id },
        });
        return { created: true, request: result.request };
    } catch (e) {
        console.error('[compOff] auto-generation skipped:', e.message);
        return { created: false, reason: e.message };
    }
}

// ── Expiry ────────────────────────────────────────────────────────────────────

/**
 * Lapse comp off that outlived its validity window.
 *
 * Per employee and year, in one transaction under the balance's lock: walk the
 * lots oldest-expiry first — the order a leave spends them in — and keep back
 * as many days as that employee's PENDING comp off leave is holding, because
 * those are exactly the days the pending leave will spend when it is approved.
 * Only the rest of an expired lot lapses. (Lapsing them anyway used to let the
 * same days be both expired and then spent.)
 *
 * A request is marked 'expired' only when days of ITS lot actually lapsed — a
 * claim that was fully spent before its date stays 'approved'.
 */
async function runExpirySweep(schoolId) {
    const ctx = await resolveContext(schoolId);
    if (!ctx.enabled) return { expired: 0 };

    const now = new Date();
    const due = await LeaveLedger.find({
        school: schoolId, leaveType: ctx.leaveType._id, entryType: { $in: ['EARNED', 'ADJUSTMENT'] },
        remainingDays: { $gt: 0 }, expiresAt: { $ne: null, $lte: now },
    }).select('teacher academicYear').lean();
    const groups = new Map();
    for (const l of due) groups.set(`${l.teacher}|${l.academicYear}`, { teacher: l.teacher, academicYear: l.academicYear });

    let expiredDays = 0;
    let lotsLapsed = 0;
    const perTeacher = new Map();
    const lapsedLots = new Set();

    for (const g of groups.values()) {
        const k = { schoolId, teacherId: g.teacher, leaveTypeId: ctx.leaveType._id, academicYear: g.academicYear };
        const lapsed = await tx.withTransaction(async (q) => {
            await tx.lock(q, tx.balanceKey(k.schoolId, k.teacherId, k.leaveTypeId, k.academicYear));
            const bal = await tx.balanceRow(q, k);
            let protect = Number(bal?.pending) || 0;
            const { rows: lots } = await q(
                `SELECT "_id", "remainingDays", "expiresAt" FROM "${LeaveLedger.tableName}"
                  WHERE "school" = $1::uuid AND "teacher" = $2::uuid AND "leaveType" = $3::uuid AND "academicYear" = $4
                    AND "entryType" IN ('EARNED', 'ADJUSTMENT') AND COALESCE("delta", 0) > 0 AND COALESCE("remainingDays", 0) > 0
                  ORDER BY "expiresAt" ASC NULLS LAST, "createdAt" ASC FOR UPDATE`,
                [String(k.schoolId), String(k.teacherId), String(k.leaveTypeId), String(k.academicYear)]);
            let total = 0;
            for (const lot of lots) {
                const left = Number(lot.remainingDays) || 0;
                const held = Math.min(left, protect);
                protect = round2(protect - held);
                if (!lot.expiresAt || new Date(lot.expiresAt) > now) continue;
                const lapse = round2(left - held);
                if (lapse <= 0) continue;
                await q(`UPDATE "${LeaveLedger.tableName}" SET "remainingDays" = $2 WHERE "_id" = $1::uuid`, [String(lot._id), round2(left - lapse)]);
                const after = await tx.writeBalance(q, k, { inc: { expired: lapse } });
                await tx.writeLedger(q, k, {
                    entryType: 'EXPIRED', days: lapse, delta: -lapse,
                    source: 'compoff', referenceType: 'LeaveLedger', referenceId: lot._id,
                    description: `Comp Off lapsed — validity ended ${fmtDate(lot.expiresAt)}`,
                }, after);
                lapsedLots.add(String(lot._id));
                lotsLapsed += 1;
                total = round2(total + lapse);
            }
            return total;
        });
        if (lapsed > 0) {
            expiredDays = round2(expiredDays + lapsed);
            perTeacher.set(String(g.teacher), round2((perTeacher.get(String(g.teacher)) || 0) + lapsed));
        }
    }

    // Mark the originating requests whose own lot lapsed, so the employee's
    // history reads correctly — and only those.
    if (lapsedLots.size) {
        const stale = await CompOffRequest.find({
            school: schoolId, status: 'approved', ledgerEntry: { $in: [...lapsedLots] },
        }).select('_id').lean();
        for (const r of stale) {
            await patch(CompOffRequest, r._id, { status: 'expired', expiredAt: now }, { where: { status: 'approved' } });
        }
    }

    for (const [teacherId, d] of perTeacher) {
        // System-originated: notify() drops a senderless message and always
        // filters the sender out of the recipients, so the employee is both
        // ends of their own expiry notice.
        notify({
            school: schoolId, sender: teacherId, senderRole: 'system',
            title: '⌛ Comp Off expired',
            body: `${round2(d)} day(s) of your Comp Off balance lapsed today without being used.`,
            recipients: [teacherId],
            includeSender: true,
            link: { type: 'compoff.mine' },
        });
    }

    return { expired: round2(expiredDays), lots: lotsLapsed };
}

/** "Your comp off lapses in N days" nudge, per policy.expiryNotification. */
async function runExpiryNotifications(schoolId) {
    const ctx = await resolveContext(schoolId);
    if (!ctx.enabled) return { notified: 0 };
    const { enabled, daysBefore } = ctx.policy.expiryNotification;
    if (!enabled || !(daysBefore > 0)) return { notified: 0 };

    const now      = new Date();
    const deadline = new Date(now.getTime() + daysBefore * DAY_MS);

    const due = await CompOffRequest.find({
        school: schoolId, status: 'approved',
        expiresAt: { $ne: null, $gt: now, $lte: deadline },
        expiryNotifiedAt: null,
    });

    let notified = 0;
    for (const r of due) {
        const lot = r.ledgerEntry ? await LeaveLedger.findById(r.ledgerEntry).lean() : null;
        const left = lot ? Number(lot.remainingDays) || 0 : Number(r.creditedDays) || 0;
        if (!(left > 0)) continue;

        notify({
            school: schoolId, sender: r.teacher, senderRole: 'system',
            title: '⏳ Comp Off expiring soon',
            body: `${left} day(s) of Comp Off earned for ${fmtDate(r.workDate)} expire on ${fmtDate(r.expiresAt)}. Apply for leave before then or the days will lapse.`,
            recipients: [r.teacher],
            includeSender: true,
            link: { type: 'compoff.mine', entityId: r._id },
        });
        await patch(CompOffRequest, r._id, { expiryNotifiedAt: now });
        notified++;
    }
    return { notified };
}

/**
 * Comp off carry-forward. The rule comes from the COMPOFF type's LeavePolicy —
 * the same place every other leave type's carry forward is configured — and is
 * passed in by the caller.
 *
 * Comp off is carried LOT BY LOT, oldest expiry first: each lot's unspent days
 * leave the old year's lot and open a lot in the new year with the SAME expiry
 * date. A carried day therefore still lapses when it was always going to, and
 * can still be spent (a bare carried-in figure used to be neither spendable
 * from a lot nor ever lapse). Recorded as carried out of the old year, so a
 * second run carries nothing twice. Days held by a pending comp off leave in
 * the old year stay behind with it.
 */
async function carryForward(schoolId, fromYear, toYear, rule, actorId = null) {
    const ctx = await resolveContext(schoolId);
    if (!ctx.enabled || !rule?.enabled) return { processed: 0, carried: [] };

    const balances = await LeaveBalance.find({
        school: schoolId, leaveType: ctx.leaveType._id, academicYear: fromYear,
    }).select('teacher').lean();
    const cap = Number(rule.maxDays) || 0;

    let processed = 0;
    const carried = [];
    for (const b of balances) {
        const src = { schoolId, teacherId: b.teacher, leaveTypeId: ctx.leaveType._id, academicYear: fromYear };
        const dst = { ...src, academicYear: toYear };
        const moved = await tx.withTransaction(async (q) => {
            await tx.lock(q, tx.balanceKey(src.schoolId, src.teacherId, src.leaveTypeId, fromYear));
            await tx.lock(q, tx.balanceKey(dst.schoolId, dst.teacherId, dst.leaveTypeId, toYear));
            const bal = await tx.balanceRow(q, src);
            const remaining = remainingOf(bal);
            const room = cap > 0 ? Math.max(0, cap - (Number(bal?.carriedOut) || 0)) : remaining;
            let amt = round2(Math.min(remaining, room));
            if (!(amt > 0)) return 0;

            // Lots in spending order; the first `pending` days stay behind for
            // the leave that is holding them.
            let skip = Number(bal?.pending) || 0;
            const { rows: lots } = await q(
                `SELECT * FROM "${LeaveLedger.tableName}"
                  WHERE "school" = $1::uuid AND "teacher" = $2::uuid AND "leaveType" = $3::uuid AND "academicYear" = $4
                    AND "entryType" IN ('EARNED', 'ADJUSTMENT') AND COALESCE("delta", 0) > 0 AND COALESCE("remainingDays", 0) > 0
                    AND ("expiresAt" IS NULL OR "expiresAt" > now())
                  ORDER BY "expiresAt" ASC NULLS LAST, "createdAt" ASC FOR UPDATE`,
                [String(src.schoolId), String(src.teacherId), String(src.leaveTypeId), fromYear]);
            let total = 0;
            for (const lot of lots) {
                if (amt <= 0) break;
                let avail = Number(lot.remainingDays) || 0;
                const kept = Math.min(avail, skip);
                skip = round2(skip - kept);
                avail = round2(avail - kept);
                const take = Math.min(avail, amt);
                if (take <= 0) continue;
                await q(`UPDATE "${LeaveLedger.tableName}" SET "remainingDays" = $2 WHERE "_id" = $1::uuid`,
                    [String(lot._id), round2(Number(lot.remainingDays) - take)]);
                const after = await tx.writeBalance(q, dst, { inc: { carriedForward: take } });
                await tx.writeLedger(q, dst, {
                    entryType: 'ADJUSTMENT', days: take, delta: take, remainingDays: take,
                    expiresAt: lot.expiresAt || null,
                    source: 'compoff', referenceType: 'LeaveLedger', referenceId: lot._id, createdBy: actorId,
                    description: `Comp Off carried forward from ${fromYear}`,
                }, after);
                amt = round2(amt - take);
                total = round2(total + take);
            }
            if (total > 0) {
                const after = await tx.writeBalance(q, src, { inc: { carriedOut: total } });
                await tx.writeLedger(q, src, {
                    entryType: 'ADJUSTMENT', days: total, delta: -total, remainingDays: 0,
                    source: 'compoff', referenceType: 'System', createdBy: actorId,
                    description: `Comp Off carried forward to ${toYear}`,
                }, after);
            }
            return total;
        });
        if (moved > 0) {
            processed++;
            carried.push({ teacher: b.teacher, days: moved });
        }
    }
    return { processed, carried };
}

module.exports = {
    POLICY_DEFAULTS,
    mergePolicy,
    getPolicy,
    savePolicy,
    resolveContext,
    classifyWorkDate,
    hoursBetween,
    computeCompOffDays,
    checkEligibility,
    findDuplicate,
    canApprove,
    approverIds,
    secondRule,
    isSecondApprover,
    secondApproverIds,
    mayDecide,
    createRequest,
    submitDraft,
    approveRequest,
    rejectRequest,
    reverseCredit,
    adjust,
    recordedHours,
    generateFromAttendance,
    runExpirySweep,
    runExpiryNotifications,
    carryForward,
};
