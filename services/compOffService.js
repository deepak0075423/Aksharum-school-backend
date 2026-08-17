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
 *   2. Balance is credited ONLY from `creditApproved()`, which is reachable
 *      from exactly one place: `approveRequest()` once the final sign-off
 *      lands. Creating, drafting, submitting or half-approving a claim never
 *      touches LeaveBalance.
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
const { notify, schoolAdminIds } = require('./notifyService');
const {
    normalizeLeaveSettings, isSaturdayWorking, staffHolidaysInRange,
    getActiveAcademicYearLabel, remainingOf, utcMidnight,
} = require('../utils/leaveDays');

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
    approval: { mode: 'admin', approverDesignations: [], twoLevel: false },
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
        clean.approval = {
            mode,
            approverDesignations: list(patch.approval.approverDesignations) || [],
            twoLevel: !!patch.approval.twoLevel,
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
    const today = utcMidnight(new Date());

    if (isNaN(day.getTime())) return { ok: false, message: 'Invalid work date' };

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

/** May this user sign off comp off requests for this school? */
async function canApprove(userId, userRole, schoolId, policy) {
    const mode = policy.approval.mode;
    const isAdmin = userRole === 'school_admin';
    if (mode === 'admin')       return isAdmin;
    if (mode === 'both'  && isAdmin) return true;

    const designations = policy.approval.approverDesignations || [];
    if (!designations.length) return isAdmin;   // misconfigured → admins keep the keys
    const profile = await TeacherProfile.findOne({ user: userId, school: schoolId }).select('designation').lean();
    return designations.includes(profile?.designation || '');
}

/** Everyone who should see "a new comp off request needs your attention". */
async function approverIds(schoolId, policy) {
    const ids = new Set();
    const mode = policy.approval.mode;
    if (mode === 'admin' || mode === 'both') {
        (await schoolAdminIds(schoolId)).forEach(id => ids.add(String(id)));
    }
    const designations = policy.approval.approverDesignations || [];
    if ((mode === 'designation' || mode === 'both') && designations.length) {
        const profiles = await TeacherProfile.find({
            school: schoolId, designation: { $in: designations },
        }).select('user').lean();
        profiles.forEach(p => ids.add(String(p.user)));
    }
    if (!ids.size) (await schoolAdminIds(schoolId)).forEach(id => ids.add(String(id)));
    return [...ids];
}

// ── Ledger + balance ──────────────────────────────────────────────────────────

const DELTA_SIGN = {
    EARNED: +1, REVERSED: +1,
    USED: -1, EXPIRED: -1, CANCELLED: -1,
};

async function currentBalance(teacherId, schoolId, leaveTypeId, academicYear) {
    const bal = await LeaveBalance.findOne({
        teacher: teacherId, school: schoolId, leaveType: leaveTypeId, academicYear,
    }).lean();
    return remainingOf(bal);
}

/**
 * Append one ledger row. `delta` is derived from entryType except for
 * ADJUSTMENT, where the caller supplies the sign.
 */
async function writeLedger({ schoolId, teacherId, leaveTypeId, academicYear, entryType, days,
                             delta, expiresAt = null, remainingDays = null, source = 'compoff',
                             referenceType = 'Manual', referenceId = null, description = '', createdBy = null }) {
    const magnitude = Math.abs(Number(days) || 0);
    const signed = entryType === 'ADJUSTMENT'
        ? Number(delta) || 0
        : magnitude * (DELTA_SIGN[entryType] || 0);

    const balanceAfter = await currentBalance(teacherId, schoolId, leaveTypeId, academicYear);

    return LeaveLedger.create({
        school: schoolId, teacher: teacherId, leaveType: leaveTypeId, academicYear,
        entryType, days: magnitude, delta: signed, balanceAfter,
        expiresAt,
        remainingDays: remainingDays == null ? (entryType === 'EARNED' ? magnitude : 0) : remainingDays,
        source, referenceType, referenceId, description, createdBy,
    });
}

/**
 * Credit an approved comp off request. THE ONLY place comp off days enter a
 * balance — and it refuses to run for anything that is not `approved`.
 * Idempotent: a second call on an already-credited request is a no-op.
 */
async function creditApproved(request, ctx, actorId = null) {
    if (request.status !== 'approved') {
        throw new Error('Refusing to credit a Comp Off request that is not approved');
    }
    if (request.creditedAt) return { credited: 0, alreadyCredited: true };

    const days = Number(request.compOffDays) || 0;
    if (!(days > 0)) return { credited: 0 };

    const ay = request.academicYear || await getActiveAcademicYearLabel(request.school);
    if (!ay) throw new Error('No active academic year — cannot credit Comp Off');

    const expiresAt = ctx.policy.validityDays > 0
        ? new Date(Date.now() + ctx.policy.validityDays * DAY_MS)
        : null;

    // Balance first, then the ledger row — writeLedger snapshots the resulting
    // position into balanceAfter.
    await LeaveBalance.findOneAndUpdate(
        { teacher: request.teacher, school: request.school, leaveType: request.leaveType, academicYear: ay },
        { $inc: { totalAllocated: days },
          $setOnInsert: { carriedForward: 0, used: 0, pending: 0, expired: 0 } },
        { upsert: true, new: true },
    );

    const entry = await writeLedger({
        schoolId: request.school, teacherId: request.teacher, leaveTypeId: request.leaveType,
        academicYear: ay, entryType: 'EARNED', days, expiresAt, remainingDays: days,
        source: 'compoff', referenceType: 'CompOffRequest', referenceId: request._id,
        description: `Comp Off earned for ${fmtDate(request.workDate)}${request.dayLabel ? ` (${request.dayLabel})` : ''}`,
        createdBy: actorId,
    });

    request.creditedDays = days;
    request.creditedAt   = new Date();
    request.academicYear = ay;
    request.expiresAt    = expiresAt;
    request.ledgerEntry  = entry._id;
    await request.save();

    return { credited: days, expiresAt, ledgerEntry: entry._id };
}

/**
 * Claw a credit back (admin cancels an approved comp off, or it is reversed).
 * Refuses when the days have already been spent — those must be reversed on the
 * leave side first, so the ledger can never go negative behind the user's back.
 */
async function reverseCredit(request, { entryType = 'CANCELLED', actorId = null, comment = '' } = {}) {
    if (!request.creditedAt || !(request.creditedDays > 0)) return { reversed: 0 };

    const ay = request.academicYear;
    const lot = request.ledgerEntry ? await LeaveLedger.findById(request.ledgerEntry) : null;
    const stillUnused = lot ? Number(lot.remainingDays) || 0 : Number(request.creditedDays) || 0;

    if (stillUnused < request.creditedDays) {
        const spent = round2(request.creditedDays - stillUnused);
        throw Object.assign(
            new Error(`${spent} day(s) of this Comp Off have already been used — reverse the leave first`),
            { status: 400 },
        );
    }
    if (!(stillUnused > 0)) return { reversed: 0 };

    await LeaveBalance.updateOne(
        { teacher: request.teacher, school: request.school, leaveType: request.leaveType, academicYear: ay },
        { $inc: { totalAllocated: -stillUnused } },
    );
    if (lot) { lot.remainingDays = 0; await lot.save(); }

    await writeLedger({
        schoolId: request.school, teacherId: request.teacher, leaveTypeId: request.leaveType,
        academicYear: ay, entryType, days: stillUnused,
        source: 'compoff', referenceType: 'CompOffRequest', referenceId: request._id,
        description: `Comp Off for ${fmtDate(request.workDate)} withdrawn${comment ? ` — ${comment}` : ''}`,
        createdBy: actorId,
    });

    request.creditedDays = 0;
    request.ledgerEntry  = null;
    await request.save();
    return { reversed: stillUnused };
}

/**
 * Spend comp off days against an approved leave, oldest-expiry lot first, so
 * the days closest to lapsing leave the account before the fresh ones.
 * LeaveBalance.used is moved by the leave controller — this records the trail
 * and drains the FIFO lots.
 */
async function consumeForLeave(leaveApp, { actorId = null, academicYear } = {}) {
    const days = Number(leaveApp.totalDays) || 0;
    if (!(days > 0)) return { consumed: 0 };

    const ay = academicYear || await getActiveAcademicYearLabel(leaveApp.school);
    const lots = await LeaveLedger.find({
        teacher: leaveApp.teacher, school: leaveApp.school, leaveType: leaveApp.leaveType,
        academicYear: ay, entryType: 'EARNED', remainingDays: { $gt: 0 },
    }).sort({ expiresAt: 1, createdAt: 1 });

    let left = days;
    for (const lot of lots) {
        if (left <= 0) break;
        const take = Math.min(Number(lot.remainingDays) || 0, left);
        if (take <= 0) continue;
        lot.remainingDays = round2(lot.remainingDays - take);
        await lot.save();
        left = round2(left - take);
    }

    await writeLedger({
        schoolId: leaveApp.school, teacherId: leaveApp.teacher, leaveTypeId: leaveApp.leaveType,
        academicYear: ay, entryType: 'USED', days,
        source: 'compoff', referenceType: 'LeaveApplication', referenceId: leaveApp._id,
        description: `Comp Off leave ${fmtDate(leaveApp.fromDate)} – ${fmtDate(leaveApp.toDate)}`,
        createdBy: actorId,
    });

    // `left > 0` means the lots did not cover the leave — only reachable when a
    // balance was seeded outside the ledger (legacy rows). Recorded, not fatal.
    return { consumed: round2(days - left), unbacked: left };
}

/** Undo a consumption — puts the days back into the newest drained lots. */
async function reverseConsumption(leaveApp, { actorId = null, academicYear, reason = '' } = {}) {
    const days = Number(leaveApp.totalDays) || 0;
    if (!(days > 0)) return { restored: 0 };

    const ay = academicYear || await getActiveAcademicYearLabel(leaveApp.school);
    const now = new Date();
    // Refill the lots that are still valid, latest-expiry first: an expired lot
    // must not spring back to life just because a leave was reversed.
    const lots = await LeaveLedger.find({
        teacher: leaveApp.teacher, school: leaveApp.school, leaveType: leaveApp.leaveType,
        academicYear: ay, entryType: 'EARNED',
    }).sort({ expiresAt: -1, createdAt: -1 });

    let left = days;
    for (const lot of lots) {
        if (left <= 0) break;
        if (lot.expiresAt && new Date(lot.expiresAt) < now) continue;
        const capacity = round2((Number(lot.days) || 0) - (Number(lot.remainingDays) || 0));
        const give = Math.min(capacity, left);
        if (give <= 0) continue;
        lot.remainingDays = round2((Number(lot.remainingDays) || 0) + give);
        await lot.save();
        left = round2(left - give);
    }

    await writeLedger({
        schoolId: leaveApp.school, teacherId: leaveApp.teacher, leaveTypeId: leaveApp.leaveType,
        academicYear: ay, entryType: 'REVERSED', days,
        source: 'compoff', referenceType: 'LeaveApplication', referenceId: leaveApp._id,
        description: `Comp Off leave reversed${reason ? ` — ${reason}` : ''}`,
        createdBy: actorId,
    });
    return { restored: round2(days - left) };
}

// ── Submission / approval ─────────────────────────────────────────────────────

/**
 * Create a comp off claim.
 * @param {String} mode 'submit' → status 'pending' (awaiting approval)
 *                      'draft'  → status 'draft'   (ready-to-apply, scenario 3)
 * Neither touches the balance.
 */
async function createRequest({ ctx, teacherId, workDate, checkIn = '', checkOut = '', workedHours,
                               compOffDays, reason = '', document = null, source = 'manual',
                               attendanceId = null, mode = 'submit', actorId = null }) {
    const day = utcMidnight(workDate);
    const classification = await classifyWorkDate(ctx.school._id, day, ctx);

    let hours = workedHours;
    if (hours == null || hours === '') hours = checkIn && checkOut ? hoursBetween(checkIn, checkOut) : 0;
    hours = round2(Number(hours) || 0);

    let days = compOffDays == null || compOffDays === ''
        ? computeCompOffDays(hours, ctx.policy)
        : Number(compOffDays);

    // Scenario 1 runs without attendance data: no hours recorded means the
    // school is judging the claim by hand, so a full day is the sensible
    // starting figure and the policy's hour rules simply have nothing to test.
    if (!hours && (compOffDays == null || compOffDays === '')) days = 1;

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
        attendance: attendanceId,
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

/** Move a ready-to-apply draft to pending — the employee's "Apply" click. */
async function submitDraft(request, ctx, { reason, compOffDays } = {}) {
    if (request.status !== 'draft') {
        return { ok: false, message: 'Only ready-to-apply Comp Off requests can be submitted' };
    }
    const days = compOffDays == null || compOffDays === ''
        ? Number(request.compOffDays)
        : Number(compOffDays);

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

    request.compOffDays = days;
    request.compOffMode = days <= 0.5 ? 'half_day' : 'full_day';
    if (reason != null) request.reason = String(reason).trim();
    request.status    = 'pending';
    request.appliedAt = new Date();
    request.approvalsRequired = ctx.policy.approval.twoLevel ? 2 : 1;
    request.policySnapshot = snapshotPolicy(ctx.policy);
    await request.save();

    await notifyNewRequest(request, ctx);
    return { ok: true, request };
}

/**
 * Record one sign-off. Credit happens only when the last required level lands —
 * a first-of-two approval leaves the balance untouched.
 */
async function approveRequest(request, ctx, { actorId, actorName, actorRole, comment = '' }) {
    if (request.status !== 'pending') {
        return { ok: false, message: 'Only pending Comp Off requests can be approved' };
    }
    const allowed = await canApprove(actorId, actorRole, request.school, ctx.policy);
    if (!allowed) return { ok: false, message: 'You are not an approver for Comp Off requests' };

    const already = (request.approvals || []).some(a => String(a.by) === String(actorId));
    if (already) return { ok: false, message: 'You have already approved this request — a second sign-off must come from someone else' };

    const approvals = [...(request.approvals || []), {
        level: (request.approvalLevel || 0) + 1,
        by: String(actorId), byName: actorName || '', at: new Date().toISOString(), comment,
    }];
    request.approvals     = approvals;
    request.approvalLevel = approvals.length;
    request.adminComment  = comment || request.adminComment;

    const required = request.approvalsRequired || 1;
    if (request.approvalLevel < required) {
        await request.save();
        notify({
            school: request.school, sender: actorId, senderRole: actorRole,
            title: '🕓 Comp Off — first approval recorded',
            body: `Your Comp Off request for ${fmtDate(request.workDate)} cleared level ${request.approvalLevel} of ${required}. No balance is credited until the final approval.`,
            recipients: [request.teacher],
        });
        return { ok: true, request, credited: 0, pendingLevels: required - request.approvalLevel };
    }

    request.status     = 'approved';
    request.approvedBy = actorId;
    request.approvedAt = new Date();
    await request.save();

    // Final sign-off — and only now does anything reach the balance.
    const credit = await creditApproved(request, ctx, actorId);

    notify({
        school: request.school, sender: actorId, senderRole: actorRole,
        title: '✅ Comp Off approved',
        body: `Your Comp Off for ${fmtDate(request.workDate)}${request.dayLabel ? ` (${request.dayLabel})` : ''} has been approved. `
            + `${credit.credited} day(s) credited to your Comp Off balance`
            + `${credit.expiresAt ? `, valid until ${fmtDate(credit.expiresAt)}` : ''}.`
            + `${comment ? `\nComment: ${comment}` : ''}`,
        recipients: [request.teacher],
        email: true,
    });
    return { ok: true, request, credited: credit.credited };
}

async function rejectRequest(request, ctx, { actorId, actorRole, comment = '' }) {
    if (!['pending', 'draft'].includes(request.status)) {
        return { ok: false, message: 'Only pending Comp Off requests can be rejected' };
    }
    const allowed = await canApprove(actorId, actorRole, request.school, ctx.policy);
    if (!allowed) return { ok: false, message: 'You are not an approver for Comp Off requests' };

    request.status       = 'rejected';
    request.rejectedAt   = new Date();
    request.adminComment = comment || '';
    request.creditedDays = 0;     // explicit: rejection credits nothing
    await request.save();

    notify({
        school: request.school, sender: actorId, senderRole: actorRole,
        title: '❌ Comp Off rejected',
        body: `Your Comp Off request for ${fmtDate(request.workDate)} was rejected. No balance has been credited.${comment ? `\nReason: ${comment}` : ''}`,
        recipients: [request.teacher],
        email: true,
    });
    return { ok: true, request };
}

async function notifyNewRequest(request, ctx) {
    try {
        const [recipients, teacher] = await Promise.all([
            approverIds(request.school, ctx.policy),
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
        });
        return { created: true, request: result.request };
    } catch (e) {
        console.error('[compOff] auto-generation skipped:', e.message);
        return { created: false, reason: e.message };
    }
}

// ── Expiry ────────────────────────────────────────────────────────────────────

/**
 * Lapse comp off that outlived its validity window. Writes EXPIRED for the
 * unused remainder of each stale lot and parks the days in LeaveBalance.expired
 * so allocated/used history stays readable.
 */
async function runExpirySweep(schoolId) {
    const ctx = await resolveContext(schoolId);
    if (!ctx.enabled) return { expired: 0 };

    const now = new Date();
    const lots = await LeaveLedger.find({
        school: schoolId, leaveType: ctx.leaveType._id, entryType: 'EARNED',
        remainingDays: { $gt: 0 }, expiresAt: { $ne: null, $lte: now },
    });

    let expiredDays = 0;
    const perTeacher = new Map();

    for (const lot of lots) {
        const days = Number(lot.remainingDays) || 0;
        if (!(days > 0)) continue;

        await LeaveBalance.updateOne(
            { teacher: lot.teacher, school: schoolId, leaveType: lot.leaveType, academicYear: lot.academicYear },
            { $inc: { expired: days } },
        );
        lot.remainingDays = 0;
        await lot.save();

        await writeLedger({
            schoolId, teacherId: lot.teacher, leaveTypeId: lot.leaveType,
            academicYear: lot.academicYear, entryType: 'EXPIRED', days,
            source: 'compoff', referenceType: 'LeaveLedger', referenceId: lot._id,
            description: `Comp Off lapsed — validity ended ${fmtDate(lot.expiresAt)}`,
        });

        expiredDays += days;
        perTeacher.set(String(lot.teacher), (perTeacher.get(String(lot.teacher)) || 0) + days);
    }

    // Mark the originating requests so the employee's history reads correctly
    if (expiredDays > 0) {
        const stale = await CompOffRequest.find({
            school: schoolId, status: 'approved',
            expiresAt: { $ne: null, $lte: now },
        });
        for (const r of stale) {
            const lot = r.ledgerEntry ? await LeaveLedger.findById(r.ledgerEntry).lean() : null;
            if (lot && (Number(lot.remainingDays) || 0) > 0) continue;   // partly/fully spent in time
            r.status    = 'expired';
            r.expiredAt = now;
            await r.save();
        }
    }

    for (const [teacherId, days] of perTeacher) {
        // System-originated: notify() drops a senderless message and always
        // filters the sender out of the recipients, so the employee is both
        // ends of their own expiry notice.
        notify({
            school: schoolId, sender: teacherId, senderRole: 'system',
            title: '⌛ Comp Off expired',
            body: `${round2(days)} day(s) of your Comp Off balance lapsed today without being used.`,
            recipients: [teacherId],
            includeSender: true,
        });
    }

    return { expired: round2(expiredDays), lots: lots.length };
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
        });
        r.expiryNotifiedAt = now;
        await r.save();
        notified++;
    }
    return { notified };
}

/**
 * Comp off carry-forward. The rule comes from the COMPOFF type's LeavePolicy —
 * the same place every other leave type's carry forward is configured — and is
 * passed in by the caller. This function exists only so the roll-over lands in
 * the leave ledger as an ADJUSTMENT rather than a bare balance edit.
 */
async function carryForward(schoolId, fromYear, toYear, rule) {
    const ctx = await resolveContext(schoolId);
    if (!ctx.enabled || !rule?.enabled) return { processed: 0 };

    const balances = await LeaveBalance.find({
        school: schoolId, leaveType: ctx.leaveType._id, academicYear: fromYear,
    }).lean();

    let processed = 0;
    for (const bal of balances) {
        const rem  = remainingOf(bal);
        const cap  = rule.maxDays || rem;
        const days = Math.min(rem, cap);
        if (days <= 0) continue;

        await LeaveBalance.findOneAndUpdate(
            { teacher: bal.teacher, school: schoolId, leaveType: ctx.leaveType._id, academicYear: toYear },
            { $inc: { carriedForward: days },
              $setOnInsert: { totalAllocated: 0, used: 0, pending: 0, expired: 0 } },
            { upsert: true },
        );
        await writeLedger({
            schoolId, teacherId: bal.teacher, leaveTypeId: ctx.leaveType._id,
            academicYear: toYear, entryType: 'ADJUSTMENT', days, delta: days,
            source: 'compoff', referenceType: 'System',
            description: `Comp Off carried forward from ${fromYear}`,
        });
        processed++;
    }
    return { processed };
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
    createRequest,
    submitDraft,
    approveRequest,
    rejectRequest,
    creditApproved,
    reverseCredit,
    consumeForLeave,
    reverseConsumption,
    generateFromAttendance,
    runExpirySweep,
    runExpiryNotifications,
    carryForward,
    writeLedger,
};
