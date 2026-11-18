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
const { patch }        = require('../db/patch');
const path             = require('path');
const { notify } = require('../services/notifyService');
const { resolvePage } = require('../utils/focusPage');
const compOff          = require('../services/compOffService');
const leavePolicy      = require('../services/leavePolicyService');
const designations     = require('../services/designationService');
// THE balance writer: every status change, balance move and ledger row goes
// through it, as one transaction under one lock (services/leaveBalanceTx).
const { commitTransition, adjustBalances, fileApplication } = require('../services/leaveBalanceTx');
// Cross-module effects. Each one is gated on the target module's own flag, so a
// school without Attendance or Timetable sees leave behave exactly as before.
const leaveIntegrations = require('../services/leaveIntegrations');
const { sheetTextProblem } = require('../middleware/textSafety');
const { textProblem } = require('../utils/textRules');
// Working-day / weekly-off arithmetic is shared with the Comp Off engine so the
// two can never disagree about whether a given Saturday is a working day.
const {
    getActiveAcademicYearLabel, academicYearLabel, normalizeLeaveSettings, remainingOf, rawRemainingOf,
    utcMidnight, localToday, addDays, dayKinds, onlyOffDaysBetween, leaveYearFor, yearWindow,
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

/**
 * Which academic year a request list is showing. A leave belongs to the year
 * its start date falls in — the rule the overview tiles, reports and export
 * already use. No year asked for = the school's active year (so a new active
 * year starts with an empty list, not last year's requests); 'all' = every year.
 * `years` is the picker's list, newest first.
 */
async function leaveYearScope(schoolId, wanted) {
    const rows = await AcademicYear.find({ school: schoolId }).lean();
    const years = rows
        .map((y) => ({ label: academicYearLabel(y), startDate: y.startDate, endDate: y.endDate, status: y.status }))
        .sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
    const active = years.find((y) => y.status === 'active')?.label || null;
    if (wanted === 'all') return { label: 'all', active, years, from: null, to: null };
    const row = years.find((y) => y.label === (wanted || active));
    // A school with no year on record yet sees everything rather than nothing.
    if (!row) return { label: wanted || null, active, years, from: null, to: null };
    return { label: row.label, active, years, from: row.startDate ? new Date(row.startDate) : null, to: row.endDate ? new Date(row.endDate) : null };
}

/** The list's own From/To dates, narrowed to the year in force (their overlap). */
function withYearAndDates(filter, { fromDate, toDate }, scope) {
    const lo = [fromDate && new Date(fromDate), scope?.from].filter((d) => d && !isNaN(d));
    const hi = [toDate && new Date(toDate), scope?.to].filter((d) => d && !isNaN(d));
    if (!lo.length && !hi.length) return filter;
    filter.fromDate = {};
    if (lo.length) filter.fromDate.$gte = new Date(Math.max(...lo));
    if (hi.length) filter.fromDate.$lte = new Date(Math.min(...hi));
    return filter;
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
 * policy turns the sandwich rule on also charges the weekly offs and holidays
 * that fall BETWEEN leave days — a Friday–Monday absence costs four days, not
 * two. Off days at the edges are not "between" anything and stay free, unless
 * they join this leave to another one the employee already has: Friday filed
 * last week and Monday filed now are still one absence across the weekend, and
 * the weekend is charged to the application that closes the gap.
 *
 * Returns { totalDays, sandwichDays, days } or { error }.
 */
async function computeLeaveDays({ schoolId, teacherId = null, from, to, leaveMode, policy, leaveSettings, holidayModule, excludeId = null }) {
    const days = await dayKinds(from, to, schoolId, leaveSettings, holidayModule);
    if (leaveMode === 'half_day') {
        if (from.getTime() !== to.getTime())
            return { error: 'Half-day leave must have the same fromDate and toDate' };
        const d = days[0];
        if (d.kind === 'sunday')     return { error: 'Cannot apply half-day leave on a Sunday' };
        if (d.kind === 'weekly_off') return { error: 'Cannot apply half-day leave on a non-working Saturday' };
        if (d.kind === 'holiday')    return { error: 'Cannot apply leave on a holiday' };
        return { totalDays: 0.5, sandwichDays: 0, days };
    }

    const working = days.reduce((s, d) => s + d.weight, 0);
    if (working <= 0)
        return { error: 'No working days in the selected date range (all are weekends or holidays)' };
    if (!policy?.sandwichRule) return { totalDays: working, sandwichDays: 0, days };

    const first = days.findIndex((d) => d.weight > 0);
    const last  = days.length - 1 - [...days].reverse().findIndex((d) => d.weight > 0);
    let sandwich = 0;
    for (let i = first + 1; i < last; i += 1) if (days[i].weight === 0) sandwich += 1;

    // Bridging to leave the employee already holds, across off days only.
    if (teacherId) {
        const firstDay = new Date(`${days[first].iso}T00:00:00.000Z`);
        const lastDay  = new Date(`${days[last].iso}T00:00:00.000Z`);
        const near = await LeaveApplication.find({
            teacher: teacherId, school: schoolId, status: { $in: ['pending', 'approved'] },
            fromDate: { $lte: addDays(lastDay, 15) }, toDate: { $gte: addDays(firstDay, -15) },
            ...(excludeId ? { _id: { $ne: excludeId } } : {}),
        }).select('fromDate toDate').lean();
        const prev = near.filter((a) => utcMidnight(a.toDate) < firstDay)
            .sort((a, b) => new Date(b.toDate) - new Date(a.toDate))[0];
        const next = near.filter((a) => utcMidnight(a.fromDate) > lastDay)
            .sort((a, b) => new Date(a.fromDate) - new Date(b.fromDate))[0];
        const gap = (a, b) => Math.max(0, Math.round((utcMidnight(b) - utcMidnight(a)) / 86400000) - 1);
        if (prev && await onlyOffDaysBetween(prev.toDate, firstDay, schoolId, leaveSettings, holidayModule)) {
            sandwich += gap(prev.toDate, firstDay);
        }
        if (next && await onlyOffDaysBetween(lastDay, next.fromDate, schoolId, leaveSettings, holidayModule)) {
            sandwich += gap(lastDay, next.fromDate);
        }
    }
    return { totalDays: working + sandwich, sandwichDays: sandwich, sandwiched: sandwich > 0, days };
}

/**
 * The days of an application that actually draw on the balance. Loss-of-pay
 * days are part of the leave but not of the entitlement, so only this portion
 * is ever held, spent or restored.
 */
const paidOf = (app) => Math.max(0, Math.round(((app.totalDays || 0) - (app.lopDays || 0)) * 100) / 100);

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

/**
 * The years whose leave has been closed (adminCloseAcademicYear). A closed year
 * takes no new applications, allocations or carry-ins: its remainder has
 * lapsed and its figures are final.
 */
async function closedYearsOf(schoolId) {
    const s = await School.findById(schoolId).select('leaveClosedYears').lean();
    return new Set((s?.leaveClosedYears || []).map(String));
}

/**
 * The ids in `ids` that are teachers of this school — active ones only unless
 * `includeInactive` (an exit settlement is about someone on their way out).
 * Every handler that writes a balance for a list it was SENT goes through this:
 * an id from another school, a student or a typo must create nothing.
 */
async function staffOfSchool(schoolId, ids, { includeInactive = false } = {}) {
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String))];
    if (!list.length) return [];
    const valid = list.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!valid.length) return [];
    const rows = await User.find({
        _id: { $in: valid }, school: schoolId, role: 'teacher',
        ...(includeInactive ? {} : { isActive: true }),
    }).select('_id').lean();
    return rows.map((r) => String(r._id));
}

/** employeeId / designation / department / joiningDate for a set of users, keyed by user id. */
async function profilesOf(userIds) {
    const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
    if (!ids.length) return new Map();
    const rows = await TeacherProfile.find({ user: { $in: ids } })
        .select('user employeeId designation department joiningDate').lean();
    return new Map(rows.map((p) => [String(p.user), p]));
}

/** An academic year label this school actually has, or null. */
async function realYear(schoolId, label) {
    if (!label) return null;
    return yearWindow(schoolId, String(label));
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
        // `includeInactive` is for the exit settlement — the person leaving may
        // already be switched off. Every other picker lists current staff only.
        const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
        const users = await User.find({ school: req.schoolId, role: 'teacher', ...(includeInactive ? {} : { isActive: true }) })
            .select('name email isActive').sort({ name: 1 }).lean();
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
                    isActive:       u.isActive !== false,
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

/**
 * A leave type's name and description take no symbols (utils/textRules:
 * `words`, `sentence`), the same rule the web form types by. With `existing`,
 * only a value that changes is judged — a type saved before the rule can
 * still be switched on or off without first being renamed.
 */
/**
 * The type already wearing `code` at this school — active or not, because the
 * code is how every report, balance sheet and import names a type. `selfId`
 * is the type being edited. Codes are stored in capitals (the model and both
 * handlers upper-case them), so the comparison is exact.
 */
async function codeTakenBy(schoolId, code, selfId = null) {
    return LeaveType.findOne({ school: schoolId, code, ...(selfId ? { _id: { $ne: selfId } } : {}) })
        .select('name isActive').lean();
}
const codeTaken = (code, t, adding = false) => `Code ${code} is already used by ${t.name}`
    + (t.isActive === false
        ? (adding ? ' (inactive — switch it back on rather than adding it again)' : ' (inactive)')
        : '');

function leaveTypeTextProblem({ name, description }, existing = null) {
    const changed = (v, was) => v !== undefined && String(v ?? '').trim() !== String(was ?? '').trim();
    if (name !== undefined && (!existing || changed(name, existing.name))) {
        const bad = textProblem(String(name).trim(), 'Leave type name', 'words');
        if (bad) return { field: 'name', message: bad };
    }
    if (description !== undefined && (!existing || changed(description, existing.description))) {
        const bad = textProblem(String(description ?? '').trim(), 'Description', 'sentence');
        if (bad) return { field: 'description', message: bad };
    }
    return null;
}

/** Why an annual allocation figure cannot be stored, or null. */
function annualProblem(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 'Annual allocation must be 0 or more days';
    if (n > 366) return 'Annual allocation cannot be more than 366 days';
    if (Math.round(n * 2) !== n * 2) return 'Annual allocation must be in whole or half days';
    return null;
}

/** A refusal that names the form field it is about, so the form can mark that box. */
const fieldError = (res, field, message) => res.status(400).json({ success: false, field, message });

exports.adminCreateLeaveType = async (req, res) => {
    try {
        const { name, code, description, category, annualAllocation, monthlyAccrual, carryForward, encashable,
                maxEncashableDays, maxConsecutiveDays, requiresDocument, documentRequiredAfterDays, isActive, isPaid } = req.body;
        if (!name?.trim()) return fieldError(res, 'name', 'Name is required');
        if (!code?.trim()) return fieldError(res, 'code', 'Code is required');
        const badText = leaveTypeTextProblem({ name, description });
        if (badText) return fieldError(res, badText.field, badText.message);
        const allocProblem = annualProblem(annualAllocation);
        if (allocProblem) return fieldError(res, 'annualAllocation', allocProblem);

        const normalizedCode = code.trim().toUpperCase();
        // A code belongs to one type. This used to be an upsert on the code, so
        // "adding" a type under a code already in use silently rewrote that
        // type's name, allocation and description instead of saying so.
        const taken = await codeTakenBy(req.schoolId, normalizedCode);
        if (taken) return fieldError(res, 'code', codeTaken(normalizedCode, taken, true));
        const resolvedCategory = category === 'compoff' || normalizedCode === 'COMPOFF' ? 'compoff' : 'general';

        // Only one comp off type can be live at a time — the engine resolves
        // "the" comp off type, and two active ones would make that ambiguous.
        if (resolvedCategory === 'compoff' && isActive !== false) {
            const clash = await LeaveType.findOne({
                school: req.schoolId, category: 'compoff', isActive: true,
                code: { $ne: normalizedCode },
            }).lean();
            if (clash) return fieldError(res, 'category', `An active Comp Off leave type already exists (${clash.code}). Deactivate it first.`);
        }

        const payload = {
            name:                       name.trim(),
            description:                (description || '').trim(),
            category:                   resolvedCategory,
            // Comp off is earned, never allocated — force the annual figure to 0
            // so nobody can hand out comp off days through the allocation screen.
            annualAllocation:           resolvedCategory === 'compoff' ? 0 : (Number(annualAllocation) || 0),
            // Unpaid (leave without pay): every day goes to payroll as loss of
            // pay and none is drawn from a balance. Comp off is always paid —
            // it is time already worked.
            isPaid:                     resolvedCategory === 'compoff' ? true : isPaid !== false,
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

        const lt = await LeaveType.create({
            ...payload, school: req.schoolId, code: normalizedCode, createdBy: req.userId,
        });
        res.status(201).json({ success: true, data: lt.toObject ? lt.toObject() : lt });
    } catch (e) {
        // Two saves of the same code racing past the check meet the unique index.
        if (e.code === 11000) return res.status(400).json({ success: false, field: 'code', message: 'That code is already used by another leave type' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.adminUpdateLeaveType = async (req, res) => {
    try {
        const { name, code, description, category, annualAllocation, monthlyAccrual, carryForward, encashable,
                maxEncashableDays, maxConsecutiveDays, requiresDocument, documentRequiredAfterDays, isActive, isPaid } = req.body;

        const existing = await LeaveType.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!existing) return res.status(404).json({ success: false, message: 'Leave type not found' });
        if (name !== undefined && !String(name).trim()) return fieldError(res, 'name', 'Name is required');
        const badText = leaveTypeTextProblem({ name, description }, existing);
        if (badText) return fieldError(res, badText.field, badText.message);
        const allocProblem = annualProblem(annualAllocation);
        if (allocProblem) return fieldError(res, 'annualAllocation', allocProblem);
        const nextCategory = category !== undefined
            ? (category === 'compoff' ? 'compoff' : 'general')
            : (existing.category || 'general');

        // A type that already holds balances or applications cannot change what
        // KIND of leave it is: comp off balances live in FIFO lots that a
        // general type never reads, and a general allocation would become comp
        // off nobody earned. Create a new type instead.
        if (nextCategory !== (existing.category || 'general')) {
            const [apps, bals] = await Promise.all([
                LeaveApplication.exists({ school: req.schoolId, leaveType: existing._id }),
                LeaveBalance.exists({ school: req.schoolId, leaveType: existing._id }),
            ]);
            if (apps || bals) {
                return fieldError(res, 'category',
                    `${existing.name} already has ${apps ? 'applications' : 'allocations'} — its category cannot change. Create a new leave type instead.`);
            }
        }
        // Same reasoning for paid ↔ unpaid once anything was filed against it:
        // the held and spent days of every open application were worked out
        // under the old answer.
        if (isPaid !== undefined && (isPaid !== false) !== (existing.isPaid !== false)) {
            const open = await LeaveApplication.exists({ school: req.schoolId, leaveType: existing._id, status: 'pending' });
            if (open) return fieldError(res, 'isPaid', 'Decide the pending applications of this type before changing whether it is paid');
        }

        if (nextCategory === 'compoff' && isActive !== false) {
            const clash = await LeaveType.findOne({
                school: req.schoolId, category: 'compoff', isActive: true, _id: { $ne: req.params.id },
            }).lean();
            if (clash) return fieldError(res, 'category', `An active Comp Off leave type already exists (${clash.code}). Deactivate it first.`);
        }

        const update = {};
        if (code !== undefined) {
            const nextCode = String(code ?? '').trim().toUpperCase();
            if (!nextCode) return fieldError(res, 'code', 'Code is required');
            if (nextCode !== existing.code) {
                const taken = await codeTakenBy(req.schoolId, nextCode, existing._id);
                if (taken) return fieldError(res, 'code', codeTaken(nextCode, taken));
            }
            update.code = nextCode;
        }
        if (category                 !== undefined) update.category                 = nextCategory;
        if (name                     !== undefined) update.name                     = name.trim();
        if (description              !== undefined) update.description              = (description || '').trim();
        // Comp off days are earned, never allocated — keep the annual figure at 0
        if (annualAllocation !== undefined && annualAllocation !== '') update.annualAllocation = nextCategory === 'compoff' ? 0 : Number(annualAllocation);
        if (isPaid                   !== undefined) update.isPaid                   = nextCategory === 'compoff' ? true : isPaid !== false;
        if (monthlyAccrual           !== undefined) update.monthlyAccrual           = monthlyAccrual;
        if (carryForward             !== undefined) update.carryForward             = carryForward;
        if (encashable               !== undefined) update.encashable               = !!encashable;
        if (maxEncashableDays        !== undefined) update.maxEncashableDays        = Number(maxEncashableDays) || 0;
        if (maxConsecutiveDays       !== undefined) update.maxConsecutiveDays       = Number(maxConsecutiveDays) || 0;
        if (requiresDocument         !== undefined) update.requiresDocument         = !!requiresDocument;
        if (documentRequiredAfterDays!== undefined) update.documentRequiredAfterDays= Number(documentRequiredAfterDays) || 0;
        if (isActive                 !== undefined) update.isActive                 = !!isActive;
        if (!Object.keys(update).length) return res.json({ success: true, data: existing });

        // Only the columns that changed are written (db/patch) — a row toggle
        // must not write a stale copy of the rest of the type back.
        const lt = await patch(LeaveType, existing._id, update);
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });

        // Switching a type off stops new applications, but whatever is already
        // waiting is still somebody's request. Say how many, so the office
        // knows to decide them rather than discover them later.
        let pendingLeft = 0;
        if (update.isActive === false && existing.isActive !== false) {
            pendingLeft = await LeaveApplication.countDocuments({ school: req.schoolId, leaveType: existing._id, status: 'pending' });
        }
        res.json({ success: true, data: lt, ...(pendingLeft ? { pendingLeft } : {}) });
    } catch (e) {
        if (e.code === 11000) return res.status(400).json({ success: false, field: 'code', message: 'That code is already used by another leave type' });
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
        const lt = await LeaveType.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });

        // An allocation without its leave type is dead weight: the days can
        // never be spent, and the allocation screen renders a row with a blank
        // type. Everything hanging off the type goes with it — the balances
        // (the allocation), the ledger rows behind them, and the rule set —
        // in one transaction, so a failure part-way leaves the type whole
        // rather than a type with half its history gone.
        // Applications and comp off requests are the two things that block the
        // delete above, so nothing here can orphan a record with history.
        const { withTransaction } = require('../services/dbTx');
        const T = (M) => `"${M.tableName}"`;
        const args = [String(req.schoolId), String(lt._id)];
        const [balances, ledger, policy] = await withTransaction(async (q) => {
            // Re-checked inside the transaction: an application filed between
            // the check above and this delete would otherwise be orphaned.
            const { rows: late } = await q(
                `SELECT 1 FROM ${T(LeaveApplication)} WHERE "school" = $1::uuid AND "leaveType" = $2::uuid
                 UNION ALL SELECT 1 FROM ${T(CompOffRequest)} WHERE "school" = $1::uuid AND "leaveType" = $2::uuid LIMIT 1`, args);
            if (late.length) throw Object.assign(new Error('Cannot delete — leave type is in use'), { status: 400 });
            const b = await q(`DELETE FROM ${T(LeaveBalance)} WHERE "school" = $1::uuid AND "leaveType" = $2::uuid`, args);
            const l = await q(`DELETE FROM ${T(LeaveLedger)} WHERE "school" = $1::uuid AND "leaveType" = $2::uuid`, args);
            const p = await q(`DELETE FROM ${T(LeavePolicyRow)} WHERE "school" = $1::uuid AND "leaveType" = $2::uuid`, args);
            await q(`DELETE FROM ${T(LeaveType)} WHERE "school" = $1::uuid AND "_id" = $2::uuid`, args);
            return [{ deletedCount: b.rowCount }, { deletedCount: l.rowCount }, { deletedCount: p.rowCount }];
        });
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
    } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
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
        // employeeId lives on TeacherProfile — User never had one, so this
        // popup listed every teacher without their id.
        const [teachers, profiles] = await Promise.all([
            teacherIds.length
                ? User.find({ _id: { $in: teacherIds }, school: req.schoolId }).select('name').lean()
                : [],
            profilesOf(teacherIds),
        ]);
        const teacherById = Object.fromEntries(teachers.map(t => [String(t._id), {
            ...t, employeeId: profiles.get(String(t._id))?.employeeId || null,
        }]));

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
            School.findById(req.schoolId).select('designations leaveSettings').lean(),
        ]);
        res.json({ success: true, data: {
            policies,
            designations: school?.designations || [],
            // How Saturdays count — the Policies tab is where a leave admin
            // (who cannot reach School Settings) changes it.
            leaveSettings: normalizeLeaveSettings(school?.leaveSettings),
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
            // Names the leave type, so following this lands on that row of the
            // types tab rather than on the tab.
            link: { type: 'leave.manage', entityId: req.params.leaveTypeId },
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
 *
 * Their own applications never appear (nobody signs off their own leave), it is
 * scoped to an academic year like every other list in the module, and it pages
 * — it used to stop silently at 100. Each pending row carries the requester's
 * balance for that type and year, which is the one fact a decision needs and
 * the approver could see nowhere.
 */
exports.teacherGetApprovals = async (req, res) => {
    try {
        const { status = 'pending', academicYear, page = 1, limit = 20 } = req.query;
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
                mine.push(String(p.leaveType._id));
            }
        }
        if (!mine.length) return res.json({ success: true, data: { isApprover: false, items: [], total: 0, page: 1, pages: 0 } });

        const filter = { school: req.schoolId, leaveType: { $in: mine }, teacher: { $ne: req.userId } };
        if (status) filter.status = status;
        const scope = await leaveYearScope(req.schoolId, academicYear);
        withYearAndDates(filter, {}, scope);

        const lim = Math.min(100, Math.max(1, +limit || 20));
        const pg  = Math.max(1, +page || 1);
        const [items, total, pendingTotal] = await Promise.all([
            LeaveApplication.find(filter)
                .populate('teacher',   'name email')
                .populate('leaveType', 'name code category isPaid')
                .sort({ appliedAt: -1 })
                .skip((pg - 1) * lim)
                .limit(lim)
                .lean(),
            LeaveApplication.countDocuments(filter),
            LeaveApplication.countDocuments({ ...filter, status: 'pending' }),
        ]);

        await decorateForDecision(req, items, { policies, designation, moduleAdmin });
        res.json({ success: true, data: {
            isApprover: true, items, total, page: pg, pages: Math.ceil(total / lim), pending: pendingTotal,
            academicYear: scope.label, activeAcademicYear: scope.active, academicYears: scope.years,
        } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Everything a decision needs, hung on each row: the requester's employee id,
 * designation and department, whether THIS user may decide it (not their own,
 * and an approver for that type), and — for a pending row — what the requester
 * has left of that type in that year, before and after this request.
 */
async function decorateForDecision(req, rows, pre = {}) {
    if (!rows.length) return rows;
    const [profiles, policies, designation, moduleAdmin] = await Promise.all([
        profilesOf(rows.map((r) => r.teacher?._id || r.teacher)),
        pre.policies || leavePolicy.getAllPolicies(req.schoolId),
        pre.designation !== undefined ? pre.designation : leavePolicy.designationOf(req.userId, req.schoolId),
        pre.moduleAdmin !== undefined ? pre.moduleAdmin : designations.isModuleAdmin(req, 'leave'),
    ]);
    const policyOf = new Map(policies.map((p) => [String(p.leaveType._id), p]));
    const pending = rows.filter((r) => r.status === 'pending');
    const balances = pending.length
        ? await LeaveBalance.find({
            school: req.schoolId,
            teacher: { $in: [...new Set(pending.map((r) => String(r.teacher?._id || r.teacher)))] },
        }).lean()
        : [];
    const balOf = new Map(balances.map((b) => [`${b.teacher}|${b.leaveType}|${b.academicYear}`, b]));
    const active = await getActiveAcademicYearLabel(req.schoolId);

    for (const r of rows) {
        const tid = String(r.teacher?._id || r.teacher);
        const typeId = String(r.leaveType?._id || r.leaveType);
        const pr = profiles.get(tid);
        if (r.teacher && typeof r.teacher === 'object') {
            r.teacher.employeeId  = pr?.employeeId  || '';
            r.teacher.designation = pr?.designation || '';
            r.teacher.department  = pr?.department  || '';
        }
        const pol = policyOf.get(typeId);
        r.canDecide = r.status === 'pending' && tid !== String(req.userId) && !!pol
            && await leavePolicy.canApprove(req.userId, req.userRole, req.schoolId, pol, { designation, moduleAdmin, applicantId: tid });
        // Reversing or shortening approved leave is the office's (the admin
        // screens), and never on one's own leave.
        r.canReverse = r.status === 'approved' && tid !== String(req.userId) && String(req.baseUrl || '').endsWith('/admin');
        if (r.status === 'pending') {
            const b = balOf.get(`${tid}|${typeId}|${r.academicYear || active}`);
            const remaining = remainingOf(b);           // already net of this request's held days
            const paid = paidOf(r);
            r.balance = {
                academicYear: r.academicYear || active,
                allocated: !!b,
                available: Math.round((remaining + paid) * 100) / 100,   // before this request
                after: remaining,                                           // once it is approved
                paidDays: paid,
                lopDays: r.lopDays || 0,
            };
        }
    }
    return rows;
}

// ── Admin: Leave Settings ─────────────────────────────────────────────────────

exports.adminUpdateLeaveSettings = async (req, res) => {
    try {
        const { saturdayWorking, saturdayMode, saturdayHalfDay } = req.body;
        if (saturdayMode !== undefined && !['all', '1_3_5', '2_4'].includes(saturdayMode))
            return res.status(400).json({ success: false, message: "saturdayMode must be 'all', '1_3_5' or '2_4'" });
        const update = {};
        if (saturdayWorking !== undefined) update['leaveSettings.saturdayWorking'] = !!saturdayWorking;
        if (saturdayMode    !== undefined) update['leaveSettings.saturdayMode']    = saturdayMode;
        if (saturdayHalfDay !== undefined) update['leaveSettings.saturdayHalfDay'] = !!saturdayHalfDay;
        // Only this one column is written — a full-row save of the school here
        // would put back a stale copy of everything else on it.
        const current = await School.findById(req.schoolId).select('leaveSettings').lean();
        const next = { ...normalizeLeaveSettings(current?.leaveSettings) };
        for (const [k, v] of Object.entries(update)) next[k.split('.')[1]] = v;
        const school = await patch(School, req.schoolId, { leaveSettings: next });
        const settings = normalizeLeaveSettings(school?.leaveSettings);

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
        // The year the Requests list is showing (the active one by default),
        // so the tiles above it count exactly what it lists.
        const scope  = await leaveYearScope(req.schoolId, req.query.academicYear);
        const ay     = scope.label === 'all' ? scope.active : scope.label;

        // No academic year on record yet (or 'all') — count everything rather
        // than nothing, so a school still setting itself up sees its own data.
        const from = scope.from || new Date(0);
        const to   = scope.to   || new Date('2999-12-31');

        const today  = localToday();
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
                `SELECT la."_id", la."teacher", la."fromDate", la."toDate", la."leaveMode", la."halfDaySession",
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
                // What the tiles counted: a year, 'all', or null (no year on record).
                countedYear: scope.label,
                activeAcademicYear: scope.active,
                window: scope.from
                    ? { startDate: scope.from, endDate: scope.to }
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
                // `teacher` so the "On Leave Today" list can fold a morning and
                // an afternoon half day into the one person the tile counted.
                out: outToday.rows.map((r) => ({
                    _id: String(r._id), teacher: String(r.teacher), name: r.name, employeeId: r.employeeId || '',
                    leaveType: r.typeName, code: r.typeCode, fromDate: r.fromDate, toDate: r.toDate,
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

/**
 * The teachers of one department, as ids — department lives on TeacherProfile,
 * not on the application. The same resolution the Reports tab counts with, so
 * a report's figure and the request list it opens hold the same applications.
 */
const NO_ONE = '00000000-0000-0000-0000-000000000000';
async function narrowToDepartment(filter, schoolId, department) {
    if (!department) return;
    const profiles = await TeacherProfile.find({ school: schoolId, department }).select('user').lean();
    const ids = profiles.map((pr) => String(pr.user));
    // A teacher already asked for must also be in the department; an empty
    // department matches nothing, never everything.
    filter.teacher = filter.teacher
        ? (ids.includes(String(filter.teacher)) ? filter.teacher : NO_ONE)
        : { $in: ids.length ? ids : [NO_ONE] };
}

exports.adminGetRequests = async (req, res) => {
    try {
        const { status, teacherId, leaveType, fromDate, toDate, page = 1, limit = 20, focus,
                q, sort: sortKey, mode, department, academicYear } = req.query;
        const filter = { school: req.schoolId };
        if (status)    filter.status    = status;
        if (teacherId) filter.teacher   = teacherId;
        if (leaveType) filter.leaveType = leaveType;
        await narrowToDepartment(filter, req.schoolId, department);
        if (mode === 'half_day' || mode === 'full_day') filter.leaveMode = mode;
        const scope = await leaveYearScope(req.schoolId, academicYear);
        withYearAndDates(filter, { fromDate, toDate }, scope);

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
                .populate('teacher',  'name email')
                .populate('leaveType','name code category isPaid')
                .populate('approvedBy','name')
                .sort(sort)
                .skip((effectivePage - 1) * +limit)
                .limit(+limit)
                .lean(),
            LeaveApplication.countDocuments(filter),
        ]);

        // employeeId, designation and department live on TeacherProfile; each
        // row also says whether THIS user may decide it (never their own, and
        // only types they approve) and, when pending, the requester's balance.
        await decorateForDecision(req, apps);

        res.json({
            success: true, data: apps, total,
            page: effectivePage, pages: Math.ceil(total / +limit),
            academicYear: scope.label, activeAcademicYear: scope.active, academicYears: scope.years,
            // false tells the caller the record is not in this filtered set, so
            // it can widen the filters instead of showing a page without it.
            ...(focus ? { focusFound } : {}),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * File one application — the employee's own (`onBehalf: false`) or an
 * administrator's on someone's behalf. Both used to be separate copies of the
 * same steps, and they had drifted (the admin path never checked the type was
 * active). One path now:
 *
 *   the year the dates belong to (not "whatever year is active") → the cost of
 *   the dates (weekends, holidays, sandwich rule) → every policy rule → the
 *   balance split into paid and loss-of-pay days → filed and held as ONE
 *   transaction under the employee's lock, with the overlap and the balance
 *   checked again inside it.
 *
 * Returns { status, body } for the caller to send.
 */
async function fileLeave(req, { teacherId, onBehalf }) {
    const { leaveTypeId, fromDate, toDate, leaveMode: modeIn, halfDaySession, reason } = req.body;
    const bad = (message, status = 400) => ({ status, body: { success: false, message } });
    if (!teacherId || !leaveTypeId || !fromDate || !toDate || !String(reason || '').trim())
        return bad(onBehalf
            ? 'teacherId, leaveTypeId, fromDate, toDate and reason are required'
            : 'leaveTypeId, fromDate, toDate and reason are required');
    const leaveMode = modeIn === 'half_day' ? 'half_day' : 'full_day';
    const reasonText = String(reason).trim();
    if (reasonText.length > 500) return bad('Reason must be 500 characters or fewer');
    const reasonBad = textProblem(reasonText, 'Reason', 'sentence');
    if (reasonBad) return bad(reasonBad);

    // Filing "on behalf" waives the notice period. Doing that for yourself
    // would be a way round your own rules — your own leave goes through My Leave.
    if (onBehalf && String(teacherId) === String(req.userId))
        return bad('File your own leave from My Leave — it cannot be filed on your own behalf', 403);

    const from = utcMidnight(fromDate);
    const to   = utcMidnight(toDate);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return bad('Invalid date format');
    if (to < from) return bad('toDate must be on or after fromDate');

    const lt = await LeaveType.findOne({ _id: leaveTypeId, school: req.schoolId }).lean();
    if (!lt) return bad('Leave type not found', 404);
    if (lt.isActive === false) return bad(`${lt.name} is switched off and is not accepting applications`);

    const yr = await leaveYearFor(req.schoolId, from, to);
    if (yr.error) return bad(yr.error);
    if ((await closedYearsOf(req.schoolId)).has(yr.label))
        return bad(`${yr.label} has been closed for leave — no new applications can be filed in it`);

    const [policy, school] = await Promise.all([
        leavePolicy.getPolicy(req.schoolId, lt),
        School.findById(req.schoolId).select('leaveSettings modules').lean(),
    ]);
    const leaveSettings = normalizeLeaveSettings(school?.leaveSettings);
    const holidayModule = !!school?.modules?.holiday;

    const counted = await computeLeaveDays({
        schoolId: req.schoolId, teacherId, from, to, leaveMode, policy, leaveSettings, holidayModule,
    });
    if (counted.error) return bad(counted.error);
    const totalDays = counted.totalDays;

    const overlapMsg = onBehalf
        ? 'Teacher already has a leave application (pending or approved) that overlaps with the selected dates'
        : 'You already have a leave application (pending or approved) that overlaps with the selected dates';
    if (await getOverlappingLeave(teacherId, req.schoolId, from, to)) return bad(overlapMsg);

    const documentPath = req.file ? req.file.filename : null;
    const check = await leavePolicy.validateApplication({
        schoolId: req.schoolId, policy, teacherId, from, to, totalDays, leaveMode,
        hasDocument: !!documentPath, onBehalf,
        ctx: { leaveSettings, holidayModule, year: yr },
    });
    if (!check.ok) return bad(check.message);

    const filed = await fileApplication({
        schoolId: req.schoolId, teacherId, leaveTypeId: lt._id, academicYear: yr.label, from, to,
        data: {
            teacher: teacherId, school: req.schoolId, leaveType: lt._id,
            fromDate: from, toDate: to, totalDays, academicYear: yr.label,
            leaveMode,
            halfDaySession: leaveMode === 'half_day' ? (halfDaySession === 'second' ? 'second' : 'first') : 'first',
            reason: reasonText, document: documentPath, appliedAt: new Date(),
            // Leave takes one sign-off — the two-level policy option was removed.
            approvalsRequired: 1, approvalLevel: 0, approvals: [],
        },
        // Decided again under the lock, from the balance as it is now. Only the
        // paid portion is ever held: loss-of-pay days draw on no entitlement.
        decide: (bal) => {
            if (!bal && lt.isPaid !== false && !policy.allowNegativeBalance && !policy.allowLopBeyondBalance) {
                return {
                    ok: false,
                    message: isCompOffType(lt)
                        ? `${onBehalf ? 'This teacher has' : 'You have'} no ${lt.name} days to spend in ${yr.label}`
                        : onBehalf
                            ? `${lt.name} has not been allocated to this teacher for ${yr.label} — allocate it first`
                            : `${lt.name} has not been allocated to you for ${yr.label} yet`,
                };
            }
            const split = leavePolicy.splitPaidAndLop(policy, lt, totalDays, leavePolicy.spendableFrom(policy, rawRemainingOf(bal)));
            if (!split.ok && !onBehalf) split.message = split.message.replace('Insufficient balance', 'Insufficient leave balance');
            return split;
        },
    });
    if (!filed.ok) return bad(filed.code === 'overlap' ? overlapMsg : filed.message);
    const app = filed.app;

    if (onBehalf) {
        // Filed FOR somebody. They were not in the room when it happened, so
        // this is the only way they learn that days were spent in their name.
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📝 Leave applied on your behalf',
            body: `${req.user?.name || 'An administrator'} filed a ${lt.name} request for you from `
                + `${fmtDate(from)} to ${fmtDate(to)} (${days(totalDays)})`
                + `${filed.lopDays ? `, of which ${days(filed.lopDays)} are loss of pay` : ''}.`
                + `\nReason: ${reasonText}`
                + '\nIt still needs the usual approval. Tell your school office if this is not right.',
            recipients: [teacherId],
            email: true,
            link: { type: 'leave.mine', entityId: app._id },
        });
    }
    // Routed by the type's own policy — admins, named designations, or both —
    // and never to the applicant, who cannot decide it.
    leavePolicy.approverIds(req.schoolId, policy, { exclude: teacherId }).then((recipients) => notify({
        school: req.schoolId, sender: req.userId, senderRole: req.userRole,
        title: onBehalf ? '📋 Leave request filed on behalf' : '📋 New leave request',
        body: onBehalf
            ? `${req.user?.name || 'An administrator'} filed a ${lt.name} request for a teacher, `
                + `${fmtDate(from)} to ${fmtDate(to)} (${days(totalDays)}). It is waiting for a decision.`
            : `${req.user?.name || 'A teacher'} applied for ${lt.name} leave from ${fmtDate(from)} to ${fmtDate(to)} `
                + `(${days(totalDays)}${filed.lopDays ? `, ${days(filed.lopDays)} loss of pay` : ''}).\nReason: ${reasonText}`,
        recipients,
        link: { type: 'leave.approvals', entityId: app._id },
    })).catch(() => {});

    return { status: 201, body: { success: true, data: app.toObject ? app.toObject() : app } };
}

exports.adminApplyLeave = async (req, res) => {
    try {
        // The person must be a current teacher of this school before anything
        // else is looked at.
        const [ok] = await staffOfSchool(req.schoolId, [req.body.teacherId]);
        if (!ok) return res.status(400).json({ success: false, message: 'Pick a current teacher of this school' });
        const r = await fileLeave(req, { teacherId: ok, onBehalf: true });
        res.status(r.status).json(r.body);
    } catch (e) {
        if (e.code === 11000 || e.code === '23505') return res.status(400).json({ success: false, message: 'Teacher already has a leave application for these dates' });
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
 * Live preview for the apply forms — the employee's own and the admin's
 * on-behalf one.
 *
 * Two questions the form cannot answer by itself: how many days this employee
 * has of the chosen type in the year these dates belong to, and what the dates
 * will cost once weekends, school holidays and the type's sandwich rule are
 * applied. Both are answered by the same helpers the real submit uses, so the
 * number shown is the number that will be charged.
 *
 * Date problems come back as `days.error` inside a 200 rather than a 400: this
 * is a preview the form paints while the user is still typing.
 */
async function buildApplyPreview({ schoolId, teacherId, leaveTypeId, fromDate, toDate, leaveMode = 'full_day', onBehalf }) {
        if (!teacherId || !leaveTypeId)
            return { status: 400, body: { success: false, message: 'teacherId and leaveTypeId are required' } };

        const ltDoc = await LeaveType.findOne({ _id: leaveTypeId, school: schoolId }).lean();
        if (!ltDoc) return { status: 404, body: { success: false, message: 'Leave type not found' } };
        const mode = leaveMode === 'half_day' ? 'half_day' : 'full_day';

        const [school, activeAy, policy] = await Promise.all([
            School.findById(schoolId).select('leaveSettings modules leaveClosedYears').lean(),
            getActiveAcademicYearLabel(schoolId),
            leavePolicy.getPolicy(schoolId, ltDoc),
        ]);
        const leaveSettings = normalizeLeaveSettings(school?.leaveSettings);
        const holidayModule = !!school?.modules?.holiday;

        // The year whose balance these dates would draw on. Without dates yet,
        // the active one — that is the balance the form opens on.
        let from = null; let to = null; let yr = null; let dateError = null;
        if (fromDate && toDate) {
            from = utcMidnight(fromDate);
            to   = utcMidnight(toDate);
            if (isNaN(from.getTime()) || isNaN(to.getTime())) dateError = 'Invalid date format';
            else if (to < from) dateError = 'To date must be on or after From date';
            else {
                yr = await leaveYearFor(schoolId, from, to);
                if (yr.error) { dateError = yr.error; yr = null; }
                else if ((school?.leaveClosedYears || []).includes(yr.label)) {
                    dateError = `${yr.label} has been closed for leave`;
                }
            }
        }
        const ay = yr?.label || activeAy;

        // Read-only: an unallocated employee must not get a balance row just for
        // opening the form, so this looks the row up instead of creating it.
        const balRow = ay
            ? await LeaveBalance.findOne({ teacher: teacherId, school: schoolId, leaveType: leaveTypeId, academicYear: ay }).lean()
            : null;
        const remaining = remainingOf(balRow);
        const spendable = leavePolicy.spendableFrom(policy, rawRemainingOf(balRow));
        const balance = {
            allocated:      !!balRow,
            academicYear:   ay,
            totalAllocated: balRow?.totalAllocated || 0,
            carriedForward: balRow?.carriedForward || 0,
            carriedOut:     balRow?.carriedOut || 0,
            used:           balRow?.used    || 0,
            pending:        balRow?.pending || 0,
            expired:        balRow?.expired || 0,
            remaining,
            // What an application may actually draw — larger than `remaining`
            // when the policy permits an overdraft (Infinity → null on the wire).
            spendable:      Number.isFinite(spendable) ? spendable : null,
            unlimited:      !Number.isFinite(spendable),
            unpaid:         ltDoc.isPaid === false,
            lopAllowed:     !!policy.allowLopBeyondBalance,
            // Comp off is earned per approved request, so its annual figure is
            // deliberately 0 and must not be shown as an entitlement.
            annualAllocation: isCompOffType(ltDoc) ? null : (ltDoc.annualAllocation || 0),
        };

        let days = null;
        if (dateError) {
            days = { error: dateError };
        } else if (from && to) {
            const counted = await computeLeaveDays({
                schoolId, teacherId, from, to, leaveMode: mode, policy, leaveSettings, holidayModule,
            });
            const kinds = counted.days || await dayKinds(from, to, schoolId, leaveSettings, holidayModule);
            const calendarDays = kinds.length;
            const weeklyOffDays = kinds.filter((d) => d.kind === 'sunday' || d.kind === 'weekly_off').length;
            const holidayDays = kinds.filter((d) => d.kind === 'holiday').length;
            // Split the preview the same way the submit will, so "3 of these 5
            // days are unpaid" is visible before filing.
            const noRow = !balRow && ltDoc.isPaid !== false && !policy.allowNegativeBalance && !policy.allowLopBeyondBalance;
            const previewSplit = counted.error || noRow ? null : leavePolicy.splitPaidAndLop(
                policy, ltDoc, counted.totalDays, spendable);
            days = {
                error: counted.error
                    || (noRow ? `${ltDoc.name} has not been allocated${onBehalf ? ' to this teacher' : ''} for ${ay} yet` : null)
                    || (previewSplit && !previewSplit.ok ? previewSplit.message : null),
                lopDays:      previewSplit?.ok ? previewSplit.lopDays : 0,
                paidDays:     previewSplit?.ok ? previewSplit.paidDays : 0,
                // What the balance will be charged: working days normally, plus
                // the off days the sandwich rule charges, and 0.5 for a half day.
                totalDays:    counted.totalDays ?? 0,
                calendarDays,
                workingDays:  calendarDays - weeklyOffDays,
                holidayDays,
                weeklyOffDays,
                sandwichDays: counted.sandwichDays || 0,
                sandwiched:   !!counted.sandwiched,
                leaveMode:    mode,
                academicYear: ay,
            };
        }

        // Soft check only — the form still submits, and the real validation runs
        // again on POST. `onBehalf` mirrors the submit: the notice period binds
        // the employee, not the admin filing for them.
        let warning = null;
        if (days && !days.error) {
            const [overlap, check] = await Promise.all([
                getOverlappingLeave(teacherId, schoolId, from, to),
                leavePolicy.validateApplication({
                    schoolId, policy, teacherId, from, to,
                    totalDays: days.totalDays, leaveMode: mode, hasDocument: true, onBehalf,
                    ctx: { leaveSettings, holidayModule, year: yr },
                }),
            ]);
            if (overlap) warning = onBehalf
                ? 'This teacher already has a leave application overlapping these dates'
                : 'You already have a leave application overlapping these dates';
            else if (!check.ok) warning = check.message;
        }

        return { status: 200, body: { success: true, data: {
            leaveType: {
                _id: ltDoc._id, name: ltDoc.name, code: ltDoc.code, category: ltDoc.category || 'general',
                isPaid: ltDoc.isPaid !== false,
            },
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
                sandwichRule:        policy.sandwichRule,
                requiresDocument:    policy.requiresDocument,
                documentRequiredAfterDays: policy.documentRequiredAfterDays,
                // True when THESE dates need a document — the form marks the
                // upload required off this, so it cannot disagree with the POST.
                documentNeeded: !!policy.requiresDocument && !!days && !days.error
                    && (!(policy.documentRequiredAfterDays > 0) || days.totalDays > policy.documentRequiredAfterDays),
            },
            // With loss of pay available an over-balance request is no longer a
            // hard stop — the excess is simply unpaid, and days.error carries
            // the refusal when it genuinely cannot go through.
            sufficient: !days || !!days.error || (days.paidDays ?? days.totalDays) <= spendable,
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

/** Why this user may not decide `app`, or null. Own leave first: nobody decides their own. */
async function decisionRefusal(req, app, policy) {
    if (String(app.teacher) === String(req.userId)) return 'You cannot decide your own leave request';
    if (!policy) return 'Leave type not found';
    const moduleAdmin = await designations.isModuleAdmin(req, 'leave');
    const ok = await leavePolicy.canApprove(req.userId, req.userRole, req.schoolId, policy, {
        moduleAdmin, applicantId: app.teacher,
    });
    return ok ? null : 'You are not an approver for this leave type';
}

exports.adminApproveRequest = async (req, res) => {
    try {
        const app = await LeaveApplication.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });
        if (app.status !== 'pending')
            return res.status(400).json({ success: false, message: 'Only pending requests can be approved' });

        // Who may sign off is a per-leave-type rule, so it is checked here
        // rather than left to the route guard — a designation-based approver
        // reaches this same handler through the teacher router.
        const policy = await leavePolicy.getPolicy(req.schoolId, app.leaveType);
        const refused = await decisionRefusal(req, app, policy);
        if (refused) return res.status(403).json({ success: false, message: refused });

        if ((app.approvals || []).some(a => String(a.by) === String(req.userId)))
            return res.status(400).json({ success: false, message: 'You have already approved this request — a second sign-off must come from someone else' });

        const comment = String(req.body.adminComment || req.body.comment || '').trim();
        const level = (app.approvalLevel || 0) + 1;
        const approval = { level, by: String(req.userId), byName: req.user?.name || '', at: new Date().toISOString(), comment };
        const required = app.approvalsRequired || 1;
        const ay = await yearOf(app, req.schoolId);

        // A first-of-two sign-off records the approval but moves no balance.
        // Compare-and-set on the level, so two approvers signing at the same
        // moment cannot both be "level 1" and lose one of the signatures.
        if (level < required) {
            const moved = await commitTransition({
                schoolId: req.schoolId, appId: app._id, teacherId: app.teacher,
                leaveTypeId: app.leaveType, academicYear: ay,
                expectStatus: ['pending'], expectFields: { approvalLevel: app.approvalLevel || 0 },
                statusPatch: { approvalLevel: level, adminComment: comment || app.adminComment || '' },
                push: { approvals: approval },
            });
            if (!moved.applied)
                return res.status(409).json({ success: false, message: 'Someone else acted on this request a moment ago — refresh and try again' });
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '🕓 Leave — first approval recorded',
                body: `Your leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} cleared level ${level} of ${required}. It is not approved until the final sign-off.`,
                recipients: [app.teacher],
                link: { type: 'leave.mine', entityId: app._id },
            });
            leavePolicy.approverIds(req.schoolId, policy, { exclude: app.teacher }).then(recipients => notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '⏳ Leave still needs a sign-off',
                body: `A leave request for ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)} cleared level `
                    + `${level} of ${required} and is waiting on its final approval.`,
                recipients,
                link: { type: 'leave.approvals', entityId: app._id },
            })).catch(() => {});
            return res.json({ success: true, data: moved.app, pendingLevels: required - level });
        }

        // Status, balance, comp off lots and the ledger row move together, as
        // one transaction that re-checks the status under the lock: of two
        // racing decisions, exactly one lands.
        const approvedAt = new Date();
        const paid = paidOf(app);
        const ltDoc = await LeaveType.findById(app.leaveType).lean();
        const compoff = isCompOffType(ltDoc);
        const moved = await commitTransition({
            schoolId: req.schoolId, appId: app._id, teacherId: app.teacher,
            leaveTypeId: app.leaveType, academicYear: ay,
            expectStatus: ['pending'], expectFields: { approvalLevel: app.approvalLevel || 0 },
            statusPatch: {
                status: 'approved', approvedBy: String(req.userId), approvedAt,
                approvalLevel: level, adminComment: comment || app.adminComment || '',
            },
            push: { approvals: approval },
            inc: { used: paid, pending: -paid },
            // Comp off is spent from its FIFO lots — oldest expiry first — in
            // the same transaction, with the ONE ledger row below. (It used to
            // be a second, separate step that wrote a second USED row.)
            lots: compoff && paid > 0 ? { drain: paid } : null,
            // A wholly unpaid leave moves no entitlement, so it gets no ledger
            // row — the ledger tracks days, and none were spent.
            ledger: paid > 0 ? {
                entryType: 'USED', days: paid, delta: -paid,
                source: compoff ? 'compoff' : 'leave',
                createdBy: req.userId,
                description: `Leave ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)} approved`
                    + (app.lopDays > 0 ? ` (${app.lopDays} day(s) loss of pay)` : ''),
            } : null,
        });
        if (!moved.applied)
            return res.status(409).json({ success: false, message: `Already ${moved.currentStatus || 'processed'} by someone else` });
        if (moved.unbacked > 0) console.warn(`[leave] comp off approval ${app._id}: ${moved.unbacked} day(s) not backed by a lot (legacy balance)`);

        // Downstream effects, each gated on its own module flag and each
        // best-effort — neither may undo an approval that has already committed.
        const done = { ...app, ...moved.app };
        leaveIntegrations.markAttendanceForLeave(done, req.schoolId)
            .catch(e => console.error('[leave→attendance]', e.message));
        leaveIntegrations.requestSubstituteCover(done, req.schoolId)
            .catch(e => console.error('[leave→substitute]', e.message));

        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '✅ Leave request approved',
            body: `Your leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} (${days(app.totalDays)}) has been approved.`
                + (app.lopDays > 0 ? ` ${days(app.lopDays)} of it is loss of pay.` : '')
                + (comment ? `\nComment: ${comment}` : ''),
            recipients: [app.teacher],
            email: true,
            link: { type: 'leave.mine', entityId: app._id },
        });
        res.json({ success: true, data: moved.app });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminRejectRequest = async (req, res) => {
    try {
        const comment = String(req.body.adminComment || req.body.reason || req.body.comment || '').trim();
        const app = await LeaveApplication.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });
        if (app.status !== 'pending')
            return res.status(400).json({ success: false, message: 'Cannot reject in current status' });

        const policy = await leavePolicy.getPolicy(req.schoolId, app.leaveType);
        const refused = await decisionRefusal(req, app, policy);
        if (refused) return res.status(403).json({ success: false, message: refused });
        // The employee is owed a reason: a refusal with no explanation is the
        // one they cannot act on.
        if (!comment) return res.status(400).json({ success: false, message: 'Give a reason for rejecting this request' });

        // Status and the release of the held days move together, and only if
        // the request is STILL pending — a reject that lost the race to an
        // approval used to overwrite it as "rejected" with the days still spent.
        const ay = await yearOf(app, req.schoolId);
        const moved = await commitTransition({
            schoolId: req.schoolId, appId: app._id, teacherId: app.teacher,
            leaveTypeId: app.leaveType, academicYear: ay,
            expectStatus: ['pending'],
            statusPatch: { status: 'rejected', rejectedAt: new Date(), adminComment: comment },
            // A released hold was never consumed, so it writes no ledger row.
            inc: { pending: -paidOf(app) },
        });
        if (!moved.applied)
            return res.status(409).json({ success: false, message: `Already ${moved.currentStatus || 'processed'} by someone else` });

        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '❌ Leave request rejected',
            body: `Your leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} has been rejected.\nReason: ${comment}`,
            recipients: [app.teacher],
            email: true,
            link: { type: 'leave.mine', entityId: app._id },
        });
        res.json({ success: true, data: moved.app });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Undo an approved leave, wholly: the paid days go back into the balance (and,
 * for comp off, into the lots they came from), its attendance rows go, and any
 * substitute cover it raised is retired. One function for the office's
 * "Reverse" and the employee withdrawing leave that has not started.
 */
async function undoApproved(req, app, { status = 'cancelled', comment = '', byEmployee = false }) {
    const ay = await yearOf(app, req.schoolId);
    const paid = paidOf(app);
    const ltDoc = await LeaveType.findById(app.leaveType).lean();
    const compoff = isCompOffType(ltDoc);
    const moved = await commitTransition({
        schoolId: req.schoolId, appId: app._id, teacherId: app.teacher,
        leaveTypeId: app.leaveType, academicYear: ay,
        // Compare-and-set: two reversals of the same leave used to both pass,
        // restoring the days twice.
        expectStatus: ['approved'],
        statusPatch: { status, cancelledAt: new Date(), adminComment: comment || app.adminComment || '' },
        inc: { used: -paid },
        lots: compoff && paid > 0 ? { refill: paid } : null,
        ledger: paid > 0 ? {
            entryType: 'REVERSED', days: paid, delta: paid,
            source: compoff ? 'compoff' : 'leave',
            createdBy: req.userId,
            description: byEmployee
                ? `Withdrawn by the employee before it started: ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)}`
                : `Approval reversed for ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)}${comment ? ` — ${comment}` : ''}`,
        } : null,
    });
    if (!moved.applied) return moved;

    // The leave no longer stands: its register rows go, and re-sweeping its
    // days retires the cover requirements it raised (the substitute engine
    // cancels any auto-raised row whose teacher is no longer away).
    leaveIntegrations.clearAttendanceForLeave(app, req.schoolId)
        .catch(e => console.error('[leave→attendance]', e.message));
    leaveIntegrations.requestSubstituteCover(app, req.schoolId)
        .catch(e => console.error('[leave→substitute]', e.message));
    return { ...moved, paid };
}

exports.adminReverseApproved = async (req, res) => {
    try {
        const comment = String(req.body.adminComment || '').trim();
        const app = await LeaveApplication.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });
        if (app.status !== 'approved')
            return res.status(400).json({ success: false, message: 'Only approved leave can be reversed' });
        if (String(app.teacher) === String(req.userId))
            return res.status(403).json({ success: false, message: 'You cannot reverse your own leave' });

        const moved = await undoApproved(req, app, { comment });
        if (!moved.applied)
            return res.status(409).json({ success: false, message: `Already ${moved.currentStatus || 'processed'} by someone else` });

        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '↩️ Approved leave reversed',
            body: `Your approved leave from ${fmtDate(app.fromDate)} to ${fmtDate(app.toDate)} has been reversed`
                + (moved.paid > 0 ? ` and ${days(moved.paid)} restored to your balance` : '')
                + (app.lopDays > 0 ? ` (the ${days(app.lopDays)} of loss of pay will not be deducted)` : '')
                + `.${comment ? `\nReason: ${comment}` : ''}`,
            recipients: [app.teacher],
            email: true,
            link: { type: 'leave.mine', entityId: app._id },
        });
        res.json({ success: true, data: moved.app, restored: moved.paid });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Cut an approved leave short — it ends on `toDate` instead.
 *
 * The days no longer taken are worked out the way the leave was priced (so a
 * weekend that only the sandwich rule charged goes too), loss-of-pay days are
 * given back first (they were the overrun), and only the paid remainder goes
 * back into the balance. The register rows and cover for the dropped days go.
 *
 * The office may shorten any approved leave; the employee only drops days from
 * today onwards — a day already taken off was taken.
 */
async function shortenApproved(req, res, { byEmployee }) {
    const lastDay = utcMidnight(req.body.toDate || req.body.lastDay || '');
    if (isNaN(lastDay.getTime())) return res.status(400).json({ success: false, message: 'Pick the new last day of the leave' });

    const app = await LeaveApplication.findOne({
        _id: req.params.id, school: req.schoolId, ...(byEmployee ? { teacher: req.userId } : {}),
    }).lean();
    if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });
    if (app.status !== 'approved') return res.status(400).json({ success: false, message: 'Only approved leave can be cut short' });
    if (!byEmployee && String(app.teacher) === String(req.userId))
        return res.status(403).json({ success: false, message: 'You cannot change your own leave from here — use My Leave' });
    if (app.leaveMode === 'half_day') return res.status(400).json({ success: false, message: 'A half day cannot be cut short — withdraw or reverse it instead' });
    const from = utcMidnight(app.fromDate);
    const oldTo = utcMidnight(app.toDate);
    if (lastDay < from || lastDay >= oldTo)
        return res.status(400).json({ success: false, message: `The new last day must be between ${fmtDate(from)} and the day before ${fmtDate(oldTo)}` });
    if (byEmployee && addDays(lastDay, 1) < localToday())
        return res.status(400).json({ success: false, message: 'Days already taken cannot be given back — the new last day must be yesterday or later' });

    const [policy, school] = await Promise.all([
        leavePolicy.getPolicy(req.schoolId, app.leaveType),
        School.findById(req.schoolId).select('leaveSettings modules').lean(),
    ]);
    const counted = await computeLeaveDays({
        schoolId: req.schoolId, teacherId: app.teacher, from, to: lastDay, leaveMode: 'full_day', policy,
        leaveSettings: normalizeLeaveSettings(school?.leaveSettings), holidayModule: !!school?.modules?.holiday,
        excludeId: app._id,
    });
    if (counted.error) return res.status(400).json({ success: false, message: counted.error });
    const newTotal = Math.min(app.totalDays, counted.totalDays);
    const dropped = Math.round((app.totalDays - newTotal) * 100) / 100;
    const newLop = Math.max(0, Math.round(((app.lopDays || 0) - dropped) * 100) / 100);
    const paidBack = Math.round((dropped - ((app.lopDays || 0) - newLop)) * 100) / 100;

    const ay = await yearOf(app, req.schoolId);
    const ltDoc = await LeaveType.findById(app.leaveType).lean();
    const compoff = isCompOffType(ltDoc);
    const note = byEmployee ? `Ended early by the employee on ${fmtDate(lastDay)}` : `Cut short to end on ${fmtDate(lastDay)}`;
    const comment = String(req.body.adminComment || req.body.comment || '').trim();
    const moved = await commitTransition({
        schoolId: req.schoolId, appId: app._id, teacherId: app.teacher,
        leaveTypeId: app.leaveType, academicYear: ay,
        // Priced from this exact version of the leave — if it changed in the
        // meantime the figures above are stale.
        expectStatus: ['approved'], expectFields: { totalDays: app.totalDays, toDate: oldTo },
        statusPatch: {
            toDate: lastDay, totalDays: newTotal, lopDays: newLop,
            adminComment: [app.adminComment, comment ? `${note} — ${comment}` : note].filter(Boolean).join('\n'),
        },
        inc: { used: -paidBack },
        lots: compoff && paidBack > 0 ? { refill: paidBack } : null,
        ledger: paidBack > 0 ? {
            entryType: 'REVERSED', days: paidBack, delta: paidBack,
            source: compoff ? 'compoff' : 'leave', createdBy: req.userId,
            description: `${note}: ${days(paidBack)} given back (${fmtDate(addDays(lastDay, 1))} – ${fmtDate(oldTo)})`,
        } : null,
    });
    if (!moved.applied)
        return res.status(409).json({ success: false, message: 'This leave changed a moment ago — refresh and try again' });

    const droppedRange = { ...app, fromDate: addDays(lastDay, 1), toDate: oldTo };
    leaveIntegrations.clearAttendanceForLeave(droppedRange, req.schoolId)
        .catch(e => console.error('[leave→attendance]', e.message));
    leaveIntegrations.requestSubstituteCover(droppedRange, req.schoolId)
        .catch(e => console.error('[leave→substitute]', e.message));

    if (byEmployee) {
        leavePolicy.approverIds(req.schoolId, policy, { exclude: app.teacher }).then((recipients) => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '⏪ Leave ended early',
            body: `${req.user?.name || 'A teacher'} is back early — their ${ltDoc?.name || 'leave'} now ends on ${fmtDate(lastDay)} `
                + `instead of ${fmtDate(oldTo)}${paidBack > 0 ? `; ${days(paidBack)} returned to their balance` : ''}.`,
            recipients,
            link: { type: 'leave.approvals', entityId: app._id },
        })).catch(() => {});
    } else {
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '✂️ Leave shortened',
            body: `Your leave from ${fmtDate(from)} now ends on ${fmtDate(lastDay)} instead of ${fmtDate(oldTo)}`
                + `${paidBack > 0 ? `; ${days(paidBack)} returned to your balance` : ''}.${comment ? `\nReason: ${comment}` : ''}`,
            recipients: [app.teacher],
            email: true,
            link: { type: 'leave.mine', entityId: app._id },
        });
    }
    return res.json({ success: true, data: moved.app, restored: paidBack, droppedDays: dropped });
}

exports.adminShortenApproved = async (req, res) => {
    try { await shortenApproved(req, res, { byEmployee: false }); }
    catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
exports.teacherEndLeaveEarly = async (req, res) => {
    try { await shortenApproved(req, res, { byEmployee: true }); }
    catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Admin: Allocations ────────────────────────────────────────────────────────

exports.adminGetAllocations = async (req, res) => {
    try {
        const { academicYear } = req.query;
        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const [balances, leaveTypes, policies, years, closed] = await Promise.all([
            LeaveBalance.find({ school: req.schoolId, academicYear: ay })
                .populate('teacher',   'name email')
                .populate('leaveType', 'name code annualAllocation category isPaid')
                .lean(),
            LeaveType.find({ school: req.schoolId, isActive: true }).lean(),
            // Whether a type accrues monthly is a policy rule, so it rides along
            // with each type for the allocation screen.
            leavePolicy.getAllPolicies(req.schoolId, { activeOnly: true }),
            // Served here rather than left to /admin/academic-years, which sits
            // behind the general admin guard — a designation-based leave admin
            // cannot reach that one, and the year pickers all need this list.
            AcademicYear.find({ school: req.schoolId }).lean(),
            closedYearsOf(req.schoolId),
        ]);
        const byType = Object.fromEntries(policies.map(p => [String(p.leaveType._id), p]));
        const withPolicy = leaveTypes.map(lt => ({
            ...lt,
            monthlyAccrual: byType[String(lt._id)]?.monthlyAccrual || lt.monthlyAccrual,
            carryForward:   byType[String(lt._id)]?.carryForward   || lt.carryForward,
            encashable:     byType[String(lt._id)]?.encashable ?? lt.encashable,
        }));
        const academicYears = years
            .map(y => ({
                label: academicYearLabel(y), startDate: y.startDate, endDate: y.endDate, status: y.status,
                leaveClosed: closed.has(academicYearLabel(y)),
            }))
            .filter(y => y.label)
            .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

        // employeeId, designation and department live on TeacherProfile, never on
        // User. `remaining` is the server's one definition (net of lapsed and
        // carried-out days) — the screens used to recompute it without those.
        const profiles = await profilesOf(balances.map((b) => b.teacher?._id));
        balances.forEach((b) => {
            const pr = b.teacher && profiles.get(String(b.teacher._id));
            if (b.teacher) {
                b.teacher.employeeId  = pr?.employeeId  || '';
                b.teacher.designation = pr?.designation || '';
                b.teacher.department  = pr?.department  || '';
            }
            b.remaining = remainingOf(b);
        });

        res.json({
            success: true, data: balances, leaveTypes: withPolicy, academicYear: ay, academicYears,
            yearClosed: closed.has(ay),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Who an allocate / clear request is about. 'all' (minus `excludeIds`) means
 * every active teacher; a list is checked against the school — an id that is
 * not a current teacher here is dropped, never written for.
 */
async function resolveTeachers(req, teacherIds, excludeIds = []) {
    const isAll = teacherIds === 'all' || (Array.isArray(teacherIds) && teacherIds[0] === 'all');
    if (isAll) {
        const skip = new Set((Array.isArray(excludeIds) ? excludeIds : [excludeIds]).filter(Boolean).map(String));
        const rows = await User.find({ school: req.schoolId, role: 'teacher', isActive: true }).select('_id').lean();
        return rows.map((r) => String(r._id)).filter((id) => !skip.has(id));
    }
    return staffOfSchool(req.schoolId, teacherIds);
}

/** The year an allocation-type action is about: a real year of this school, not closed. */
async function writableYear(req, label) {
    const ay = label || await getActiveAcademicYearLabel(req.schoolId);
    if (!ay) return { error: 'No active academic year' };
    if (!(await realYear(req.schoolId, ay))) return { error: `"${ay}" is not an academic year of this school` };
    if ((await closedYearsOf(req.schoolId)).has(ay)) return { error: `${ay} has been closed for leave — its balances are final` };
    return { ay };
}

/**
 * Days for a prorated start: the share of the year left from the later of the
 * year's start and the teacher's joining date (or today, when no joining date
 * is on record), rounded up to a half day.
 */
function proratedDays(annual, yr, joiningDate) {
    const start = utcMidnight(yr.startDate);
    const end   = utcMidnight(yr.endDate);
    const today = localToday();
    let from = joiningDate ? utcMidnight(joiningDate) : (today > start ? today : start);
    if (from < start) from = start;
    if (from > end) return 0;
    const span = Math.max(1, (end - start) / 86400000 + 1);
    const left = (end - from) / 86400000 + 1;
    return Math.min(annual, Math.ceil((annual * left / span) * 2) / 2);
}

exports.adminAllocate = async (req, res) => {
    try {
        const { teacherIds, excludeIds = [], leaveTypeId, giveFullAllocation, useProration, overrideDays, academicYear } = req.body;
        if (!leaveTypeId) return res.status(400).json({ success: false, message: 'leaveTypeId is required' });
        if (!teacherIds)  return res.status(400).json({ success: false, message: 'teacherIds is required' });

        const year = await writableYear(req, academicYear);
        if (year.error) return res.status(400).json({ success: false, message: year.error });
        const ay = year.ay;

        const lt = await LeaveType.findOne({ _id: leaveTypeId, school: req.schoolId }).lean();
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });
        if (lt.isActive === false) return res.status(400).json({ success: false, message: `${lt.name} is switched off — switch it on before allocating it` });
        // Guard the core rule: comp off balance may only ever come from an
        // approved Comp Off request, so it cannot be handed out here.
        if (isCompOffType(lt))
            return res.status(400).json({ success: false, message: 'Comp Off cannot be allocated — its balance is credited only when a Comp Off request is approved' });

        const hasOverride = overrideDays !== undefined && overrideDays !== null && overrideDays !== '';
        if (hasOverride) {
            const n = Number(overrideDays);
            if (!Number.isFinite(n) || n < 0 || n > 366 || Math.round(n * 2) !== n * 2)
                return res.status(400).json({ success: false, message: 'Days must be 0 or more, in whole or half days' });
        }

        const ids = await resolveTeachers(req, teacherIds, excludeIds);
        if (!ids.length) return res.json({ success: true, allocated: 0, message: 'No current teachers matched' });

        const ltPolicy = await leavePolicy.getPolicy(req.schoolId, lt);
        const accrues  = !!ltPolicy?.monthlyAccrual?.enabled;
        const yr = await realYear(req.schoolId, ay);
        const profiles = useProration ? await profilesOf(ids) : new Map();
        if (useProration && !hasOverride && !(yr?.startDate && yr?.endDate))
            return res.status(400).json({ success: false, message: `Cannot prorate — ${ay} has no start and end date` });

        // Precedence, most explicit first. Proration is per teacher: the share
        // of the year from when THEY start (joining date) — it used to prorate
        // everyone from today and tell them it was "because of your start date".
        const figureFor = (id) => {
            if (hasOverride) return { days: Number(overrideDays), prorated: false };
            if (accrues && !giveFullAllocation) return { days: 0, prorated: false };
            if (useProration) return { days: proratedDays(lt.annualAllocation || 0, yr, profiles.get(id)?.joiningDate), prorated: true };
            return { days: lt.annualAllocation || 0, prorated: false };
        };

        const changed = await adjustBalances(ids.map((id) => {
            const f = figureFor(id);
            return {
                schoolId: req.schoolId, teacherId: id, leaveTypeId: lt._id, academicYear: ay,
                // Re-baselining an accruing type restarts its monthly clock, so
                // the sweep credits from the next month boundary rather than
                // paying out every month since the row was first created.
                compute: () => ({ set: { totalAllocated: f.days, ...(accrues ? { lastAccrualAt: new Date() } : {}) } }),
                entryType: 'ADJUSTMENT', source: 'manual', createdBy: req.userId,
                // The ledger records the change, measured: re-allocating 12 over
                // an allocation of 10 is +2.
                describe: (delta) => `Allocated ${f.days} day(s)${f.prorated ? `, prorated from ${lt.annualAllocation}` : ''}`
                    + ` (${delta > 0 ? '+' : ''}${delta})`,
                figure: f,
            };
        }));

        const figures = ids.map((id) => figureFor(id).days);
        const lo = Math.min(...figures);
        const hi = Math.max(...figures);
        const figureText = lo === hi ? `${lo} day(s)` : `${lo}–${hi} day(s)`;
        const suffix = useProration && !hasOverride
            ? ` (prorated from ${lt.annualAllocation} by each teacher's start date)`
            : accrues && !hasOverride && !giveFullAllocation
                ? ` — ${ltPolicy.monthlyAccrual.daysPerMonth} day(s)/month will be credited automatically`
                : '';

        // Their entitlement for the year just changed — told per person, with
        // their own figure. Teachers whose figure did not move are not told.
        const movedIds = new Set(changed.map((c) => String(c.teacherId)));
        for (const id of ids) {
            if (!movedIds.has(id) && !(accrues && !giveFullAllocation)) continue;
            const f = figureFor(id);
            notifyBalanceChange(req, [id], {
                title: `📗 ${lt.name} allocated`,
                body: accrues && !hasOverride && !giveFullAllocation
                    ? `Your ${lt.name} balance for ${ay} starts at 0 and earns ${ltPolicy.monthlyAccrual.daysPerMonth} day(s) each month.`
                    : `You have been allocated ${days(f.days)} of ${lt.name} for ${ay}`
                        + `${f.prorated ? `, prorated from the full ${days(lt.annualAllocation)} for the part of the year from your start date` : ''}.`,
            });
        }

        res.json({
            success: true, allocated: ids.length, changed: changed.length, totalAllocated: lo === hi ? lo : null,
            prorated: !!useProration && !hasOverride, accrues, academicYear: ay,
            message: `Allocated ${figureText} of ${lt.name} to ${ids.length} teacher(s) for ${ay}${suffix}`,
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
 * Only existing rows are touched — clearing must never enrol somebody.
 */
exports.adminClearAllocations = async (req, res) => {
    try {
        const { teacherIds, excludeIds = [], leaveTypeId, academicYear } = req.body;
        if (!leaveTypeId) return res.status(400).json({ success: false, message: 'leaveTypeId is required' });
        if (!teacherIds)  return res.status(400).json({ success: false, message: 'teacherIds is required' });

        const year = await writableYear(req, academicYear);
        if (year.error) return res.status(400).json({ success: false, message: year.error });
        const ay = year.ay;

        const lt = await LeaveType.findOne({ _id: leaveTypeId, school: req.schoolId }).lean();
        if (!lt) return res.status(404).json({ success: false, message: 'Leave type not found' });
        if (isCompOffType(lt))
            return res.status(400).json({ success: false, message: 'Comp Off is not allocated, so it cannot be cleared — withdraw or adjust it from the Comp Off tab' });

        const ids = await resolveTeachers(req, teacherIds, excludeIds);
        if (!ids.length) return res.json({ success: true, cleared: 0, message: 'No current teachers matched' });

        const ltPolicy = await leavePolicy.getPolicy(req.schoolId, lt);
        const accrues = !!ltPolicy?.monthlyAccrual?.enabled;
        let stillPending = 0;
        const changed = await adjustBalances(ids.map((id) => ({
            schoolId: req.schoolId, teacherId: id, leaveTypeId: lt._id, academicYear: ay,
            create: false,
            compute: (row) => {
                if (!row || !((row.totalAllocated || 0) + (row.carriedForward || 0))) return null;
                stillPending += row.pending || 0;
                // A cleared accruing type starts earning again from today rather
                // than immediately paying out every month since it was allocated.
                return { set: { totalAllocated: 0, carriedForward: 0, ...(accrues ? { lastAccrualAt: new Date() } : {}) } };
            },
            entryType: 'ADJUSTMENT', source: 'manual', createdBy: req.userId,
            describe: (delta) => `Allocation cleared — ${Math.abs(delta)} day(s) removed`,
            alwaysLedger: true,
        })));
        if (!changed.length)
            return res.json({ success: true, cleared: 0, message: 'No allocations to clear for the selected teachers' });

        const daysRemoved = Math.round(changed.reduce((n, c) => n + Math.max(0, -c.delta), 0) * 100) / 100;
        // Days were taken away. That is exactly the change somebody must not
        // find out about by having an application refused.
        notifyBalanceChange(req, changed.map((c) => c.teacherId), {
            title: `📕 ${lt.name} allocation cleared`,
            body: `Your ${lt.name} allocation for ${ay} has been cleared. Leave already taken is unaffected, `
                + 'but there is nothing left to apply against until it is allocated again.',
            email: true,
        });

        res.json({
            success: true, cleared: changed.length, daysRemoved, stillPending,
            message: `Cleared ${lt.name} for ${changed.length} teacher(s) — ${daysRemoved} day(s) removed`,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Year-end closure & exit settlement ───────────────────────────────────────

/**
 * What closing a year would do, without doing it.
 *
 * Carry-forward moves days between years but nothing *closed* one, so
 * un-carried days never lapsed and a finished year's balances stayed editable
 * indefinitely. This is the preview the confirm screen shows: what lapses (net
 * of anything already carried forward, which is no longer this year's), who
 * still has an open application, and whether it can be closed at all.
 */
exports.adminGetYearClosePreview = async (req, res) => {
    try {
        const { academicYear } = req.query;
        if (!academicYear) return res.status(400).json({ success: false, message: 'academicYear is required' });
        if (!(await realYear(req.schoolId, academicYear)))
            return res.status(400).json({ success: false, message: `"${academicYear}" is not an academic year of this school` });

        const [balances, openApps, activeAY, closed, types] = await Promise.all([
            LeaveBalance.find({ school: req.schoolId, academicYear }).lean(),
            LeaveApplication.countDocuments({ school: req.schoolId, academicYear, status: 'pending' }),
            getActiveAcademicYearLabel(req.schoolId),
            closedYearsOf(req.schoolId),
            LeaveType.find({ school: req.schoolId }).lean(),
        ]);

        const byType = Object.fromEntries(types.map(t => [String(t._id), t]));
        const teacherIds = [...new Set(balances.map(b => String(b.teacher)))];
        const [teachers, profiles] = await Promise.all([
            teacherIds.length ? User.find({ _id: { $in: teacherIds }, school: req.schoolId }).select('name').lean() : [],
            profilesOf(teacherIds),
        ]);
        const byTeacher = Object.fromEntries(teachers.map(t => [String(t._id), t]));

        const rows = balances
            .map(b => ({
                _id: b._id,
                teacher: {
                    _id: b.teacher, name: byTeacher[String(b.teacher)]?.name || null,
                    employeeId: profiles.get(String(b.teacher))?.employeeId || '',
                },
                leaveType: { _id: b.leaveType, code: byType[String(b.leaveType)]?.code || null, name: byType[String(b.leaveType)]?.name || null },
                carriedOut: b.carriedOut || 0,
                remaining: remainingOf(b),
            }))
            .filter(r => r.remaining > 0)
            .sort((a, b) => (a.teacher.name || '').localeCompare(b.teacher.name || ''));

        const isClosed = closed.has(academicYear);
        res.json({ success: true, data: {
            academicYear,
            isActiveYear: academicYear === activeAY,
            isClosed,
            // Closing the year an employee is still applying against would strand
            // their request, so this has to be cleared first.
            openApplications: openApps,
            canClose: !isClosed && openApps === 0 && academicYear !== activeAY,
            blockedBy: isClosed ? 'closed' : academicYear === activeAY ? 'active' : openApps ? 'pending' : null,
            balanceRows: balances.length,
            carriedOut: Math.round(balances.reduce((n, b) => n + (b.carriedOut || 0), 0) * 100) / 100,
            lapsing: rows,
            daysLapsing: Math.round(rows.reduce((n, r) => n + r.remaining, 0) * 100) / 100,
        }});
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Close an academic year: lapse whatever is left and mark the year closed, so
 * it takes no more applications, allocations or carry-ins.
 *
 * Run carry-forward FIRST — this deliberately does not carry anything. What
 * carry-forward already moved is recorded as carried out of this year, so it
 * is not lapsed here (it used to be lapsed a second time, and the employee told
 * they had lost days they had kept).
 */
exports.adminCloseAcademicYear = async (req, res) => {
    try {
        const { academicYear } = req.body;
        if (!academicYear) return res.status(400).json({ success: false, message: 'academicYear is required' });
        if (!(await realYear(req.schoolId, academicYear)))
            return res.status(400).json({ success: false, message: `"${academicYear}" is not an academic year of this school` });

        const activeAY = await getActiveAcademicYearLabel(req.schoolId);
        if (academicYear === activeAY)
            return res.status(400).json({ success: false, message: 'Cannot close the active academic year — activate the next year first' });
        if ((await closedYearsOf(req.schoolId)).has(academicYear))
            return res.status(400).json({ success: false, message: `${academicYear} is already closed` });

        const openApps = await LeaveApplication.countDocuments({ school: req.schoolId, academicYear, status: 'pending' });
        if (openApps)
            return res.status(400).json({ success: false, message: `${openApps} application(s) are still awaiting a decision for ${academicYear} — settle them first` });

        const [balances, types] = await Promise.all([
            LeaveBalance.find({ school: req.schoolId, academicYear }).select('teacher leaveType').lean(),
            LeaveType.find({ school: req.schoolId }).select('category code').lean(),
        ]);
        const compoffTypes = new Set(types.filter(isCompOffType).map((t) => String(t._id)));
        const lapsed = await adjustBalances(balances.map((b) => ({
            schoolId: req.schoolId, teacherId: b.teacher, leaveTypeId: b.leaveType, academicYear,
            create: false,
            compute: (row) => {
                const left = remainingOf(row);
                return left > 0 ? { inc: { expired: left } } : null;
            },
            entryType: 'EXPIRED', source: 'system', createdBy: req.userId,
            // A lapsed comp off day leaves its lot too, or the expiry sweep
            // would lapse it again.
            drainLots: compoffTypes.has(String(b.leaveType)),
            describe: (delta) => `${academicYear} closed — ${Math.abs(delta)} unused day(s) lapsed`,
        })));

        // Mark it closed — one column, written without touching the rest of the
        // school row.
        const s = await School.findById(req.schoolId).select('leaveClosedYears').lean();
        await patch(School, req.schoolId, { leaveClosedYears: [...new Set([...(s?.leaveClosedYears || []), academicYear])] });

        // Days lapsed. The teacher who lost them is told what and how much; the
        // administrators are told the year is shut.
        const lapsedPer = new Map();
        for (const row of lapsed) {
            const k = String(row.teacherId);
            lapsedPer.set(k, (lapsedPer.get(k) || 0) + Math.abs(row.delta));
        }
        for (const [teacherId, total] of lapsedPer) {
            notifyBalanceChange(req, [teacherId], {
                title: '⌛ Unused leave lapsed',
                body: `${academicYear} has been closed. ${days(Math.round(total * 100) / 100)} of leave you had not used `
                    + 'have lapsed and are no longer available.',
                email: true,
            });
        }
        const daysLapsed = Math.round(lapsed.reduce((n, l) => n + Math.abs(l.delta), 0) * 100) / 100;
        notifyLeaveAdmins(req, {
            title: '📕 Academic year closed for leave',
            body: `${req.user?.name || 'An administrator'} closed ${academicYear}. `
                + (lapsed.length ? `${lapsed.length} balance(s) lapsed, ${daysLapsed} day(s) in total.` : 'Nothing was left to lapse.'),
            link: { type: 'leave.balance' },
        });

        res.json({
            success: true, academicYear, balancesClosed: lapsed.length, daysLapsed,
            message: lapsed.length
                ? `${academicYear} closed — ${lapsed.length} balance(s) lapsed`
                : `${academicYear} closed — nothing was left to lapse`,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Final settlement for someone leaving. Lapses (or only reports) what is left
 * in the year, and says what of it is encashable under each type's policy —
 * the payout itself is a payroll decision.
 */
exports.adminSettleEmployeeLeave = async (req, res) => {
    try {
        const { teacherId, academicYear, action = 'lapse' } = req.body;
        if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });
        if (!['lapse', 'report'].includes(action))
            return res.status(400).json({ success: false, message: "action must be 'lapse' or 'report'" });
        // Someone on their way out may already be switched off, so inactive
        // teachers count — but they must be this school's.
        const [tid] = await staffOfSchool(req.schoolId, [teacherId], { includeInactive: true });
        if (!tid) return res.status(400).json({ success: false, message: 'Pick a teacher of this school' });

        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });
        if (!(await realYear(req.schoolId, ay)))
            return res.status(400).json({ success: false, message: `"${ay}" is not an academic year of this school` });

        const [balances, types, policies, openApps] = await Promise.all([
            LeaveBalance.find({ teacher: tid, school: req.schoolId, academicYear: ay }).lean(),
            LeaveType.find({ school: req.schoolId }).lean(),
            leavePolicy.getAllPolicies(req.schoolId),
            LeaveApplication.countDocuments({ teacher: tid, school: req.schoolId, status: 'pending' }),
        ]);
        const byType = Object.fromEntries(types.map(t => [String(t._id), t]));
        // Encashment is a POLICY rule — the Policies screen is where it is set.
        const policyOf = Object.fromEntries(policies.map(p => [String(p.leaveType?._id || p.leaveType), p]));

        const lines = balances.map(b => {
            const t = byType[String(b.leaveType)];
            const pol = policyOf[String(b.leaveType)];
            const remaining = remainingOf(b);
            const encashable = !!(pol ? pol.encashable : t?.encashable);
            const cap = Number(pol ? pol.maxEncashableDays : t?.maxEncashableDays) || 0;
            return {
                leaveType: { _id: b.leaveType, name: t?.name || null, code: t?.code || null },
                remaining,
                encashable,
                maxEncashableDays: cap,
                // What may actually be paid out: the remainder, up to the cap (0 = no cap).
                encashableDays: encashable ? (cap > 0 ? Math.min(remaining, cap) : remaining) : 0,
            };
        }).filter(l => l.remaining > 0);

        if (action === 'report') {
            return res.json({ success: true, data: { academicYear: ay, settled: false, lines, openApplications: openApps } });
        }
        if (openApps)
            return res.status(400).json({ success: false, message: `${openApps} leave application(s) of this employee are still pending — decide them first` });

        const compoffTypes = new Set(types.filter(isCompOffType).map((t) => String(t._id)));
        const lapsed = await adjustBalances(balances.map((b) => ({
            schoolId: req.schoolId, teacherId: tid, leaveTypeId: b.leaveType, academicYear: ay,
            create: false,
            compute: (row) => {
                const left = remainingOf(row);
                return left > 0 ? { inc: { expired: left } } : null;
            },
            entryType: 'EXPIRED', source: 'system', createdBy: req.userId,
            drainLots: compoffTypes.has(String(b.leaveType)),
            describe: (delta) => `Final settlement on exit — ${Math.abs(delta)} day(s) closed out`,
        })));

        if (lapsed.length) {
            const total = Math.round(lapsed.reduce((n, l) => n + Math.abs(l.delta), 0) * 100) / 100;
            const encashable = lines.filter((l) => l.encashable && l.encashableDays > 0);
            notifyBalanceChange(req, [tid], {
                title: '📄 Leave settled on exit',
                body: `Your leave balances for ${ay} have been finalised — ${days(total)} closed out.`
                    + (encashable.length
                        ? `\n${encashable.map((l) => `${l.leaveType.name}: ${l.encashableDays} day(s) encashable`).join(', ')}. `
                            + 'Encashment itself is settled through payroll.'
                        : ''),
                email: true,
            });
            notifyLeaveAdmins(req, {
                title: '📄 Leave settlement completed',
                body: `${req.user?.name || 'An administrator'} settled leave for an employee leaving — `
                    + `${lapsed.length} balance(s), ${days(total)} closed out for ${ay}.`,
                link: { type: 'leave.balance' },
            });
        }

        res.json({
            success: true,
            data: { academicYear: ay, settled: true, lines },
            message: lapsed.length ? `Settled ${lapsed.length} balance(s)` : 'Nothing left to settle',
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
 *   · a teacher allocated mid-year starts accruing from their allocation date.
 *
 * Balances are capped at the type's annual allocation and scoped to the active
 * academic year. Each credit is decided from the row as it is under its lock
 * and written with its ledger row — accrual used to leave no trace at all.
 */
async function runMonthlyAccrualForSchool(schoolId) {
    // Comp off never accrues on a clock — it is earned per approved request.
    const policies = (await leavePolicy.getAllPolicies(schoolId, { activeOnly: true }))
        .filter(p => p.monthlyAccrual.enabled && !isCompOffType(p.leaveType));
    if (!policies.length) return 0;

    const ay = await getActiveAcademicYearLabel(schoolId);
    if (!ay) return 0;
    if ((await closedYearsOf(schoolId)).has(ay)) return 0;

    const now = new Date();
    let credited = 0;
    // teacherId -> [ "Casual Leave +1", … ] for the monthly message below.
    const earned = new Map();

    for (const policy of policies) {
        const lt        = policy.leaveType;
        const perMonth  = Number(policy.monthlyAccrual.daysPerMonth) || 0;
        const annualCap = Number(lt.annualAllocation) || 0;
        if (perMonth <= 0 || annualCap <= 0) continue;

        const rows = await LeaveBalance.find({ school: schoolId, leaveType: lt._id, academicYear: ay })
            .select('teacher totalAllocated lastAccrualAt createdAt').lean();
        // Only rows that look due are taken into the transaction; the decision
        // itself is made again from the locked row.
        const due = rows.filter((b) => {
            if ((Number(b.totalAllocated) || 0) >= annualCap) return false;
            const anchor = b.lastAccrualAt || b.createdAt;
            return !anchor || monthsBetween(new Date(anchor), now) >= 1;
        });
        if (!due.length) continue;

        const changed = await adjustBalances(due.map((b) => ({
            schoolId, teacherId: b.teacher, leaveTypeId: lt._id, academicYear: ay,
            create: false,
            compute: (row) => {
                if (!row) return null;
                const already = Number(row.totalAllocated) || 0;
                const anchorRaw = row.lastAccrualAt || row.createdAt;
                // No clock to measure from: start one instead of treating the
                // epoch as the anchor, which would credit a full year at once.
                if (!anchorRaw) return { set: { lastAccrualAt: now } };
                const months = monthsBetween(new Date(anchorRaw), now);
                if (months < 1 || already >= annualCap) return null;
                return { set: { totalAllocated: Math.min(already + months * perMonth, annualCap), lastAccrualAt: now } };
            },
            entryType: 'ADJUSTMENT', source: 'system',
            describe: (delta) => `Monthly accrual — +${delta} day(s)`,
        })));
        for (const c of changed) {
            if (!(c.delta > 0)) continue;
            credited += 1;
            const line = `${lt.name} +${c.delta}`;
            earned.set(String(c.teacherId), [...(earned.get(String(c.teacherId)) || []), line]);
        }
    }

    // Days appeared in somebody's balance without anyone asking for them. One
    // message per teacher listing every type that moved, not one per row.
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
        const [teachers, leaveTypes, policies] = await Promise.all([
            User.find({ school: req.schoolId, role: 'teacher', isActive: true }).select('name email').sort({ name: 1 }).lean(),
            LeaveType.find({ school: req.schoolId, isActive: true }).lean(),
            leavePolicy.getAllPolicies(req.schoolId, { activeOnly: true }),
        ]);
        const profiles = await profilesOf(teachers.map((t) => t._id));
        const accruing = new Set(policies.filter((p) => p.monthlyAccrual?.enabled).map((p) => String(p.leaveType._id)));
        const rows = [];
        teachers.forEach(t => {
            // Comp off is never allocated, so it has no row to fill in. An
            // accruing type starts at 0 — the monthly sweep adds the rest.
            leaveTypes.filter((lt) => !isCompOffType(lt)).forEach(lt => {
                rows.push({
                    teacherEmployeeId: profiles.get(String(t._id))?.employeeId || '',
                    teacherName:       t.name,
                    teacherEmail:      t.email,
                    leaveTypeCode:     lt.code,
                    leaveTypeName:     lt.name,
                    totalAllocated:    accruing.has(String(lt._id)) ? 0 : lt.annualAllocation,
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
        const textBad = sheetTextProblem(rows);
        if (textBad) return res.status(400).json({ success: false, message: textBad });

        const year = await writableYear(req, req.body.academicYear);
        if (year.error) return res.status(400).json({ success: false, message: year.error });
        const ay = year.ay;

        const [teachers, leaveTypes, policies] = await Promise.all([
            User.find({ school: req.schoolId, role: 'teacher', isActive: true }).select('name email').lean(),
            LeaveType.find({ school: req.schoolId, isActive: true }).lean(),
            leavePolicy.getAllPolicies(req.schoolId, { activeOnly: true }),
        ]);
        const profiles = await profilesOf(teachers.map((t) => t._id));
        const teacherByEmail = Object.fromEntries(teachers.map(t => [t.email?.toLowerCase(), t]));
        // Employee ids live on TeacherProfile — matching on User's (non-existent)
        // employeeId never found anyone.
        const teacherByEmpId = new Map();
        for (const t of teachers) {
            const emp = String(profiles.get(String(t._id))?.employeeId || '').trim().toUpperCase();
            if (emp) teacherByEmpId.set(emp, t);
        }
        const ltByCode = Object.fromEntries(leaveTypes.map(l => [l.code, l]));
        const accruing = new Set(policies.filter((p) => p.monthlyAccrual?.enabled).map((p) => String(p.leaveType._id)));

        const errors  = [];
        const entries = [];
        const seen    = new Map();     // teacher|type -> first row number

        rows.forEach((row, i) => {
            const lineNo = i + 2;
            const email  = (row.teacherEmail || '').toString().toLowerCase().trim();
            const empId  = (row.teacherEmployeeId || '').toString().trim().toUpperCase();
            const ltCode = (row.leaveTypeCode || '').toString().trim().toUpperCase();
            const raw    = row.totalAllocated;
            const alloc  = raw === '' || raw === null ? NaN : Number(raw);

            const teacher = (email && teacherByEmail[email]) || (empId && teacherByEmpId.get(empId));
            if (!teacher) { errors.push(`Row ${lineNo}: teacher not found${email || empId ? ` (${email || empId})` : ''}`); return; }
            const lt = ltByCode[ltCode];
            if (!lt)      { errors.push(`Row ${lineNo}: leave type '${ltCode}' not found`); return; }
            if (isCompOffType(lt)) { errors.push(`Row ${lineNo}: Comp Off cannot be allocated — it is credited only on approval`); return; }
            if (!Number.isFinite(alloc) || alloc < 0 || alloc > 366 || Math.round(alloc * 2) !== alloc * 2) {
                errors.push(`Row ${lineNo}: totalAllocated must be 0 or more, in whole or half days`); return;
            }
            const key = `${teacher._id}|${lt._id}`;
            if (seen.has(key)) { errors.push(`Row ${lineNo}: ${teacher.name} / ${lt.code} already appears on row ${seen.get(key)} — kept that one`); return; }
            seen.set(key, lineNo);

            const accrues = accruing.has(String(lt._id));
            entries.push({
                schoolId: req.schoolId, teacherId: teacher._id, leaveTypeId: lt._id, academicYear: ay,
                // An accruing type's monthly clock restarts with the new figure,
                // or the next sweep pays every month since the old one on top.
                compute: () => ({ set: { totalAllocated: alloc, ...(accrues ? { lastAccrualAt: new Date() } : {}) } }),
                entryType: 'ADJUSTMENT', source: 'manual', createdBy: req.userId,
                describe: (delta) => `Allocated ${alloc} day(s) by spreadsheet (${delta > 0 ? '+' : ''}${delta})`,
            });
        });

        const changed = await adjustBalances(entries);

        // One message per teacher however many rows of the sheet were theirs.
        notifyBalanceChange(req, [...new Set(changed.map((c) => String(c.teacherId)))], {
            title: '📗 Leave allocation updated',
            body: `Your leave allocation for ${ay} has been updated. Open Leave Balance to see where you stand.`,
        });

        res.json({
            success: true, updated: entries.length, changed: changed.length, academicYear: ay,
            errors: errors.length ? errors : undefined,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Carry each teacher's unused days from one year into the next, under each
 * type's carry-forward rule.
 *
 * Safe to run more than once: what was carried is recorded on the FROM year
 * (`carriedOut`), so it is no longer that year's remainder — a second run
 * carries only what the cap still allows, and closing the year later does not
 * lapse days that already moved. The TO year's row is created at zero when
 * there is none: carrying days in is not an allocation.
 */
exports.adminRunCarryForward = async (req, res) => {
    try {
        const { fromYear, toYear } = req.body;
        if (!fromYear || !toYear)
            return res.status(400).json({ success: false, message: 'fromYear and toYear are required (e.g. "2024-25", "2025-26")' });

        // Both ends must be real academic years of this school, and the balances
        // must move forwards — decided by startDate, not by comparing labels.
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
        // Only into the year that comes straight after — skipping a year would
        // hand days to a year the employee never had them in.
        const between = years.filter((y) => new Date(y.startDate) > new Date(fromAY.startDate) && new Date(y.startDate) < new Date(toAY.startDate));
        if (between.length)
            return res.status(400).json({ success: false, message: `${toYear} is not the year after ${fromYear} — carry into ${academicYearLabel(between.sort((a, b) => new Date(a.startDate) - new Date(b.startDate))[0])} first` });
        const closed = await closedYearsOf(req.schoolId);
        if (closed.has(fromYear)) return res.status(400).json({ success: false, message: `${fromYear} is already closed — its remainder lapsed, there is nothing left to carry` });
        if (closed.has(toYear))   return res.status(400).json({ success: false, message: `${toYear} is closed for leave` });

        // Carry forward is a policy rule, so the types that roll over come from
        // the policies rather than the leave type columns.
        const policies = (await leavePolicy.getAllPolicies(req.schoolId)).filter(p => p.carryForward.enabled);

        let processed = 0;
        let compOffProcessed = 0;
        const perTeacher = new Map();
        for (const policy of policies) {
            const lt = policy.leaveType;

            // Comp off rolls over through its own engine, which moves the lots
            // with their expiry dates; the rule it obeys is this same policy.
            if (isCompOffType(lt)) {
                const co = await compOff.carryForward(req.schoolId, fromYear, toYear, policy.carryForward, req.userId)
                    .catch((e) => { console.error('[compOff] carry forward failed:', e.message); return { processed: 0, carried: [] }; });
                compOffProcessed += co.processed || 0;
                processed += co.processed || 0;
                for (const c of co.carried || []) perTeacher.set(String(c.teacher), (perTeacher.get(String(c.teacher)) || 0) + c.days);
                continue;
            }

            const cap = Number(policy.carryForward.maxDays) || 0;     // 0 = carry everything remaining
            const sources = await LeaveBalance.find({ school: req.schoolId, leaveType: lt._id, academicYear: fromYear })
                .select('teacher').lean();
            for (const src of sources) {
                // Both sides in one transaction: out of the old year, into the new.
                const shared = { amt: 0 };
                const moved = await adjustBalances([
                    {
                        schoolId: req.schoolId, teacherId: src.teacher, leaveTypeId: lt._id, academicYear: fromYear,
                        create: false,
                        compute: (row) => {
                            const remaining = remainingOf(row);
                            const room = cap > 0 ? Math.max(0, cap - (row?.carriedOut || 0)) : remaining;
                            shared.amt = Math.round(Math.min(remaining, room) * 100) / 100;
                            return shared.amt > 0 ? { inc: { carriedOut: shared.amt } } : null;
                        },
                        entryType: 'ADJUSTMENT', source: 'system', createdBy: req.userId,
                        describe: (delta) => `Carried forward ${Math.abs(delta)} day(s) to ${toYear}`,
                    },
                    {
                        schoolId: req.schoolId, teacherId: src.teacher, leaveTypeId: lt._id, academicYear: toYear,
                        compute: () => (shared.amt > 0 ? { inc: { carriedForward: shared.amt } } : null),
                        entryType: 'ADJUSTMENT', source: 'system', createdBy: req.userId,
                        describe: (delta) => `Carried forward ${delta} day(s) from ${fromYear}`,
                    },
                ]);
                const into = moved.find((m) => m.academicYear === toYear);
                if (into && into.delta > 0) {
                    processed++;
                    perTeacher.set(String(src.teacher), (perTeacher.get(String(src.teacher)) || 0) + into.delta);
                }
            }
        }

        if (!processed) return res.json({ success: true, message: 'Nothing to carry forward — every balance was already carried or had nothing left', processed: 0 });

        // Days that survived the year change. Totalled per teacher.
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

        res.json({ success: true, processed, compOffProcessed, message: `Carried ${processed} balance(s) from ${fromYear} into ${toYear}` });
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

        // Days are leave TAKEN: approved applications only. Counting the days of
        // rejected, cancelled and still-pending requests made "days taken" the
        // days anybody ever asked for. Request counts still cover every status.
        const TAKEN = `coalesce(sum(la."totalDays") FILTER (WHERE la."status" = 'approved'), 0)::float`;
        const [byStatus, trend, byType, perTeacher, lastYear, depts] = await Promise.all([
            pool.query(
                `SELECT la."status", count(*)::int AS "n", coalesce(sum(la."totalDays"),0)::float AS "days"
                   FROM ${qt(LeaveApplication)} la ${WHERE}
                  GROUP BY la."status"`, params),
            // One row per month the year actually holds applications in; the
            // months in between are filled in below so the axis has no gaps.
            pool.query(
                `SELECT to_char(la."fromDate" AT TIME ZONE 'UTC', 'YYYY-MM') AS "month",
                        count(*)::int AS "n", ${TAKEN} AS "days"
                   FROM ${qt(LeaveApplication)} la ${WHERE}
                  GROUP BY 1 ORDER BY 1`, params),
            pool.query(
                `SELECT lt."_id", lt."name", lt."code",
                        count(*)::int AS "n", ${TAKEN} AS "days"
                   FROM ${qt(LeaveApplication)} la
                   JOIN ${qt(LeaveType)} lt ON lt."_id" = la."leaveType" ${WHERE}
                  GROUP BY lt."_id", lt."name", lt."code"
                  ORDER BY "n" DESC, lt."name"`, params),
            // The teacher table, as one row per teacher per type. Pivoted in JS
            // because the column set is the school's own list of leave types.
            pool.query(
                `SELECT u."_id" AS "teacher", u."name", tp."employeeId", tp."department",
                        la."leaveType", ${TAKEN} AS "days",
                        count(*)::int AS "n"
                   FROM ${qt(LeaveApplication)} la
                   JOIN ${qt(User)} u ON u."_id" = la."teacher"
                   LEFT JOIN ${qt(TeacherProfile)} tp ON tp."user" = u."_id" ${WHERE}
                  GROUP BY u."_id", u."name", tp."employeeId", tp."department", la."leaveType"`, params),
            // Last year under the SAME filters — comparing a filtered year with
            // an unfiltered one made the delta meaningless.
            prev
                ? pool.query(
                    `SELECT count(*)::int AS "n" FROM ${qt(LeaveApplication)} la
                      WHERE la."school" = $1::uuid AND la."fromDate" >= $2 AND la."fromDate" <= $3${scope}`,
                    [school, new Date(prev.startDate), new Date(prev.endDate), ...params.slice(3)])
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
            // Days taken = approved days. Pending days are reported separately.
            days:         stat('approved').days,
            pendingDays:  stat('pending').days,
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
        const { status, teacherId, leaveType, fromDate, toDate, department, academicYear } = req.query;
        const filter = { school: req.schoolId };
        if (status)    filter.status    = status;
        if (teacherId) filter.teacher   = teacherId;
        if (leaveType) filter.leaveType = leaveType;
        await narrowToDepartment(filter, req.schoolId, department);
        // The same year the list on screen is showing (the active one by default).
        withYearAndDates(filter, { fromDate, toDate }, await leaveYearScope(req.schoolId, academicYear));

        const apps = await LeaveApplication.find(filter)
            .populate('teacher',   'name email')
            .populate('leaveType', 'name code')
            .populate('approvedBy','name')
            .sort({ appliedAt: -1 })
            .limit(REPORT_ROW_CAP)
            .lean();
        // Employee ids live on TeacherProfile — the column was always blank.
        const profiles = await profilesOf(apps.map((a) => a.teacher?._id));

        const rows = apps.map(a => ({
            employeeId:   profiles.get(String(a.teacher?._id))?.employeeId || '',
            teacher:      a.teacher?.name       || '',
            email:        a.teacher?.email      || '',
            leaveType:    a.leaveType?.name     || '',
            code:         a.leaveType?.code     || '',
            fromDate:     a.fromDate?.toISOString().slice(0, 10) || '',
            toDate:       a.toDate?.toISOString().slice(0, 10)   || '',
            totalDays:    a.totalDays,
            lopDays:      a.lopDays || 0,
            academicYear: a.academicYear || '',
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
            .populate('teacher',   'name email')
            .populate('leaveType', 'name code annualAllocation')
            .lean();
        const profiles = await profilesOf(balances.map((b) => b.teacher?._id));

        const rows = balances.map(b => ({
            employeeId:     profiles.get(String(b.teacher?._id))?.employeeId || '',
            teacher:        b.teacher?.name        || '',
            email:          b.teacher?.email       || '',
            leaveType:      b.leaveType?.name      || '',
            code:           b.leaveType?.code      || '',
            academicYear:   b.academicYear,
            totalAllocated: b.totalAllocated,
            carriedForward: b.carriedForward || 0,
            carriedOut:     b.carriedOut     || 0,
            used:           b.used           || 0,
            pending:        b.pending        || 0,
            expired:        b.expired        || 0,
            remaining:      remainingOf(b),
        }));

        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Leave Allocations');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', `attachment; filename="leave_allocations_${String(ay).replace(/[^\w-]/g, '_')}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminExportReports = async (req, res) => {
    try {
        // The same filters the Reports screen counts with — year, department,
        // leave type, status — so the sheet holds the applications the figures
        // on screen were made from.
        const { academicYear, status, fromDate, toDate, department, leaveType } = req.query;
        const ay = academicYear || await getActiveAcademicYearLabel(req.schoolId);

        let filter = { school: req.schoolId };
        if (status)    filter.status    = status;
        if (leaveType) filter.leaveType = leaveType;
        await narrowToDepartment(filter, req.schoolId, department);
        // By the year's label, however it is spelled — the lookup by yearName
        // missed years whose label is derived, and exported all history.
        const win = await yearWindow(req.schoolId, ay);
        filter = withReportWindow(filter, { fromDate, toDate }, win);

        const apps = await LeaveApplication.find(filter)
            .populate('teacher',   'name email')
            .populate('leaveType', 'name code')
            .sort({ appliedAt: -1 })
            .limit(REPORT_ROW_CAP)
            .lean();
        const profiles = await profilesOf(apps.map((a) => a.teacher?._id));

        const rows = apps.map(a => ({
            employeeId:  profiles.get(String(a.teacher?._id))?.employeeId || '',
            teacher:     a.teacher?.name       || '',
            email:       a.teacher?.email      || '',
            department:  profiles.get(String(a.teacher?._id))?.department || '',
            leaveType:   a.leaveType?.name     || '',
            code:        a.leaveType?.code     || '',
            fromDate:    a.fromDate?.toISOString().slice(0, 10) || '',
            toDate:      a.toDate?.toISOString().slice(0, 10)   || '',
            totalDays:   a.totalDays,
            lopDays:     a.lopDays || 0,
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
        const { status, leaveType, mode, fromDate, toDate, page = 1, limit = 20, academicYear } = req.query;
        const filter = { teacher: req.userId, school: req.schoolId };
        if (status)    filter.status    = status;
        if (leaveType) filter.leaveType = leaveType;
        if (mode === 'half_day' || mode === 'full_day') filter.leaveMode = mode;
        // The active academic year unless another (or 'all') is asked for — the
        // year the office has moved the school to is the one the list shows.
        const scope = await leaveYearScope(req.schoolId, academicYear);
        withYearAndDates(filter, { fromDate, toDate }, scope);
        const yearSql = scope.from && scope.to ? ` AND "fromDate" >= $3 AND "fromDate" <= $4` : '';
        const yearArgs = scope.from && scope.to ? [scope.from, scope.to] : [];

        const [apps, total, byStatus] = await Promise.all([
            LeaveApplication.find(filter)
                .populate('leaveType', 'name code category')
                .populate('approvedBy','name')
                .sort({ appliedAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            LeaveApplication.countDocuments(filter),
            // The tiles describe this teacher's year, so they ignore every other
            // filter — a tile that is also the filter must not move when it is
            // pressed.
            pool.query(
                `SELECT "status", count(*)::int AS "n"
                   FROM ${qt(LeaveApplication)}
                  WHERE "teacher" = $1::uuid AND "school" = $2::uuid${yearSql}
                  GROUP BY "status"`,
                [String(req.userId), String(req.schoolId), ...yearArgs],
            ),
        ]);

        const stat = (k) => byStatus.rows.find((r) => r.status === k)?.n || 0;
        res.json({
            success: true, data: apps, total, page: +page, pages: Math.ceil(total / +limit),
            academicYear: scope.label, activeAcademicYear: scope.active, academicYears: scope.years,
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
                .populate('leaveType', 'name code category annualAllocation isPaid')
                .lean(),
            LeaveType.find({ school: req.schoolId, isActive: true }).lean(),
            School.findById(req.schoolId).select('leaveSettings modules').lean(),
        ]);

        // One row per active type. A type with no balance row is shown as NOT
        // ALLOCATED with nothing to spend — it used to be shown holding the full
        // annual figure, and the first application then created exactly that,
        // so every teacher silently "had" every type whether or not the office
        // ever allocated it. An unpaid type needs no allocation at all.
        const balMap = Object.fromEntries(balances.map(b => [b.leaveType?._id?.toString() || b.leaveType?.toString(), b]));
        const result = leaveTypes.map(lt => {
            const b = balMap[lt._id.toString()];
            const unpaid = lt.isPaid === false;
            if (b) return { ...b, leaveType: { ...lt, ...(b.leaveType || {}) }, remaining: remainingOf(b), allocated: true, unpaid };
            return {
                leaveType:      lt,
                academicYear:   ay,
                totalAllocated: 0,
                carriedForward: 0,
                carriedOut:     0,
                used:           0,
                pending:        0,
                expired:        0,
                remaining:      0,
                allocated:      false,
                unpaid,
            };
        });
        // Wrap both in data so the axios interceptor (res => res.data) delivers leaveSettings to the frontend
        res.json({ success: true, data: { items: result, leaveSettings: normalizeLeaveSettings(school?.leaveSettings), academicYear: ay, holidayModuleEnabled: !!school?.modules?.holiday } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherApplyLeave = async (req, res) => {
    try {
        const r = await fileLeave(req, { teacherId: req.userId, onBehalf: false });
        res.status(r.status).json(r.body);
    } catch (e) {
        if (e.code === 11000 || e.code === '23505') return res.status(400).json({ success: false, message: 'You already have a leave application for these dates' });
        res.status(500).json({ success: false, message: e.message });
    }
};

/**
 * Withdraw one's own leave.
 *
 *   pending  → cancelled, and the held days are released;
 *   approved, not started yet → withdrawn: the days go back to the balance,
 *            the attendance rows and substitute cover it raised go too.
 *
 * Leave that has already started is cut short instead (end-early) — the days
 * already taken were taken. Both moves re-check the status under the lock, so
 * a withdrawal racing an approval can no longer leave "cancelled" leave whose
 * days are still spent.
 */
exports.teacherCancelLeave = async (req, res) => {
    try {
        const app = await LeaveApplication.findOne({ _id: req.params.id, teacher: req.userId, school: req.schoolId }).lean();
        if (!app) return res.status(404).json({ success: false, message: 'Leave request not found' });

        const policy = await leavePolicy.getPolicy(req.schoolId, app.leaveType);
        const tellApprovers = (title, body) => (policy
            ? leavePolicy.approverIds(req.schoolId, policy, { exclude: req.userId })
            : leavePolicy.leaveAdminIds(req.schoolId))
            .then((recipients) => notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title, body, recipients, link: { type: 'leave.approvals', entityId: app._id },
            })).catch(() => {});

        if (app.status === 'approved') {
            if (utcMidnight(app.fromDate) <= localToday())
                return res.status(400).json({ success: false, message: 'This leave has already started — use "End early" to come back sooner' });
            const moved = await undoApproved(req, app, { status: 'cancelled', byEmployee: true });
            if (!moved.applied)
                return res.status(409).json({ success: false, message: `Already ${moved.currentStatus || 'changed'} — refresh and try again` });
            tellApprovers('🚫 Approved leave withdrawn',
                `${req.user?.name || 'A teacher'} withdrew their approved leave for ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)}`
                + `${moved.paid > 0 ? `; ${days(moved.paid)} returned to their balance` : ''}.`);
            return res.json({ success: true, data: moved.app, restored: moved.paid });
        }

        if (app.status !== 'pending')
            return res.status(400).json({ success: false, message: 'Only pending or upcoming approved leave can be withdrawn' });

        // Only a pending application reaches here, so the hold set on apply is
        // still standing — release it. A released hold writes no ledger row.
        const ay = await yearOf(app, req.schoolId);
        const moved = await commitTransition({
            schoolId: req.schoolId, appId: app._id, teacherId: req.userId,
            leaveTypeId: app.leaveType, academicYear: ay,
            expectStatus: ['pending'],
            statusPatch: { status: 'cancelled', cancelledAt: new Date() },
            inc: { pending: -paidOf(app) },
        });
        if (!moved.applied)
            return res.status(409).json({ success: false, message: `This request was ${moved.currentStatus || 'changed'} a moment ago — refresh to see it` });

        // Whoever was going to decide it needs to know it is gone.
        tellApprovers('🚫 Leave request cancelled',
            `${req.user?.name || 'A teacher'} cancelled their leave request for ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)}.`);
        res.json({ success: true, data: moved.app });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
