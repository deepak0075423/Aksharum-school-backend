'use strict';
/**
 * Comp Off — end-to-end business-rule tests.
 *
 *   node scripts/testCompOff.js
 *
 * Builds a throwaway school, mounts the real admin + teacher routers on an
 * ephemeral port, drives all three module combinations over HTTP as each role,
 * then deletes everything it created.
 *
 *   Scenario 1  Leave ON  · Holiday OFF · Attendance OFF  → fully manual
 *   Scenario 2  Leave ON  · Holiday ON  · Attendance OFF  → policy-classified
 *   Scenario 3  Leave ON  · Holiday ON  · Attendance ON   → auto ready-to-apply
 *
 * The assertion this file exists for: NO comp off balance is credited before
 * approval — checked after every single pre-approval step.
 *
 * No test framework needed — the repo has none, and adding one for this would
 * be a bigger change than the tests themselves.
 */
require('dotenv').config();
const express = require('express');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

const connectDB = require('../config/db');

const School         = require('../models/School');
const User           = require('../models/User');
const AcademicYear   = require('../models/AcademicYear');
const TeacherProfile = require('../models/TeacherProfile');
const Holiday        = require('../models/Holiday');
const LeaveType      = require('../models/LeaveType');
const LeaveBalance   = require('../models/LeaveBalance');
const LeaveApplication = require('../models/LeaveApplication');
const LeaveLedger    = require('../models/LeaveLedger');
const CompOffPolicy  = require('../models/CompOffPolicy');
const CompOffRequest = require('../models/CompOffRequest');
const TeacherAttendance = require('../models/TeacherAttendance');
const TeacherAttendanceRegularization = require('../models/TeacherAttendanceRegularization');
const Notification        = require('../models/Notification');
const NotificationReceipt = require('../models/NotificationReceipt');

// ── tiny harness ─────────────────────────────────────────────────────────────
let passed = 0; let failed = 0;
const results = [];

function check(name, condition, detail = '') {
    if (condition) { passed += 1; results.push(`  ✅ ${name}`); }
    else { failed += 1; results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { results.push(`\n▸ ${title}`); }

const TAG = `cotest_${Date.now()}`;
const ids = { users: [] };
let BASE = '';

const sid = (v) => String(v?._id ?? v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = (user) => jwt.sign(
    { userId: sid(user), role: user.role, schoolId: sid(user.school) },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
);

async function call(method, path, { as, body } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(as ? { Authorization: `Bearer ${token(as)}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON (binary export) */ }
    return { status: res.status, body: json, data: json?.data, message: json?.message };
}
const GET  = (p, o) => call('GET', p, o);
const POST = (p, o) => call('POST', p, o);
const PUT  = (p, o) => call('PUT', p, o);
const DEL  = (p, o) => call('DELETE', p, o);

// ── date helpers ─────────────────────────────────────────────────────────────
const today = new Date(); today.setUTCHours(0, 0, 0, 0);
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo   = (n) => new Date(today.getTime() - n * 86400000);
const daysAhead = (n) => new Date(today.getTime() + n * 86400000);

const used = new Set();
/** Most recent unused past date matching `pred`, walking backwards from `start`. */
function pickPast(pred, start = 1) {
    for (let i = start; i < 60; i += 1) {
        const d = daysAgo(i);
        if (used.has(iso(d))) continue;
        if (pred(d)) { used.add(iso(d)); return d; }
    }
    throw new Error('no matching date found');
}
/** Next unused future date matching `pred`, walking forward from `start`. */
function pickFuture(pred, start = 1) {
    for (let i = start; i < 120; i += 1) {
        const d = daysAhead(i);
        if (used.has(iso(d))) continue;
        if (pred(d)) { used.add(iso(d)); return d; }
    }
    throw new Error('no matching future date found');
}
const isWeekday = (d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
const isSunday  = (d) => d.getUTCDay() === 0;

// ── fixture ──────────────────────────────────────────────────────────────────
async function makeUser(name, role, schoolId) {
    const u = await User.create({
        name,
        email: `${TAG}_${name.toLowerCase().replace(/\s+/g, '')}@example.test`,
        password: await bcrypt.hash('Passw0rd123', 4),
        role,
        school: schoolId,
        isFirstLogin: false,       // otherwise requirePasswordReset blocks every call
        isActive: true,
    });
    ids.users.push(sid(u._id));
    return { ...(u.toObject?.() ?? u), _id: u._id, role, school: schoolId };
}

async function setModules(schoolId, mods) {
    await School.findByIdAndUpdate(schoolId, {
        $set: Object.fromEntries(Object.entries(mods).map(([k, v]) => [`modules.${k}`, v])),
    });
}

async function buildFixture() {
    const school = await School.create({
        name: `${TAG} High School`,
        board: 'CBSE',
        designations: ['Teacher', 'Principal', 'Librarian'],
        modules: { leave: true, holiday: false, attendance: false },
        leaveSettings: { saturdayWorking: false, saturdayMode: 'all', saturdayHalfDay: false },
    });
    const schoolId = sid(school._id);

    await AcademicYear.create({
        school: schoolId, yearName: `${TAG}-yr`, status: 'active',
        startDate: daysAgo(120), endDate: daysAhead(240),
    });

    const admin     = await makeUser(`Admin${TAG}`,     'school_admin', schoolId);
    const admin2    = await makeUser(`AdminTwo${TAG}`,  'school_admin', schoolId);
    const teacher   = await makeUser(`Teacher${TAG}`,   'teacher',      schoolId);
    const principal = await makeUser(`Principal${TAG}`, 'teacher',      schoolId);
    const outsider  = await makeUser(`Outsider${TAG}`,  'teacher',      schoolId);

    await TeacherProfile.create({ user: sid(teacher._id),   school: schoolId, designation: 'Teacher',   employeeId: `${TAG}-T1` });
    await TeacherProfile.create({ user: sid(principal._id), school: schoolId, designation: 'Principal', employeeId: `${TAG}-P1` });
    await TeacherProfile.create({ user: sid(outsider._id),  school: schoolId, designation: 'Librarian', employeeId: `${TAG}-L1` });

    return { school, schoolId, admin, admin2, teacher, principal, outsider };
}

async function cleanup(f) {
    const s = f.schoolId;
    await CompOffRequest.deleteMany({ school: s });
    await CompOffPolicy.deleteMany({ school: s });
    await LeaveLedger.deleteMany({ school: s });
    await LeaveApplication.deleteMany({ school: s });
    await LeaveBalance.deleteMany({ school: s });
    await LeaveType.deleteMany({ school: s });
    await TeacherAttendanceRegularization.deleteMany({ school: s });
    await TeacherAttendance.deleteMany({ school: s });
    await Holiday.deleteMany({ school: s });
    await AcademicYear.deleteMany({ school: s });
    const notes = await Notification.find({ school: s }).select('_id').lean();
    if (notes.length) await NotificationReceipt.deleteMany({ notification: { $in: notes.map(sid) } });
    await Notification.deleteMany({ school: s });
    await TeacherProfile.deleteMany({ school: s });
    await User.deleteMany({ school: s });
    await School.findByIdAndDelete(s);
}

/** Current comp off balance straight from the DB — never from the API under test. */
async function balanceOf(schoolId, teacherId, leaveTypeId) {
    const bal = await LeaveBalance.findOne({
        school: schoolId, teacher: teacherId, leaveType: leaveTypeId,
    }).lean();
    if (!bal) return { earned: 0, used: 0, pending: 0, expired: 0, remaining: 0 };
    return {
        earned:    bal.totalAllocated || 0,
        used:      bal.used    || 0,
        pending:   bal.pending || 0,
        expired:   bal.expired || 0,
        remaining: Math.max(0, (bal.totalAllocated || 0) + (bal.carriedForward || 0)
                             - (bal.used || 0) - (bal.pending || 0) - (bal.expired || 0)),
    };
}

// ── run ──────────────────────────────────────────────────────────────────────
(async () => {
    await connectDB();

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/admin',   require('../routes/api/admin'));
    app.use('/api/teacher', require('../routes/api/teacher'));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    BASE = `http://127.0.0.1:${server.address().port}/api`;

    let f;
    try {
        f = await buildFixture();
        const { schoolId, admin, admin2, teacher, principal, outsider } = f;
        let COMPOFF_ID = null;
        const bal = () => balanceOf(schoolId, sid(teacher._id), COMPOFF_ID);

        // ══ CORE RULE: the two switches that gate the whole feature ══════════
        section('Core rule — Comp Off requires the leave module AND an active COMPOFF leave type');

        await setModules(schoolId, { leave: false });
        const moduleOff = await GET('/teacher/leave/compoff', { as: teacher });
        check('Leave module OFF → Comp Off endpoints are blocked',
            moduleOff.status === 403 && moduleOff.body?.code === 'MODULE_DISABLED',
            `${moduleOff.status} ${moduleOff.message}`);

        await setModules(schoolId, { leave: true });
        const noType = await GET('/teacher/leave/compoff', { as: teacher });
        check('Leave ON but no COMPOFF leave type → feature reports itself unavailable',
            noType.status === 200 && noType.data.enabled === false && /Comp Off leave type/i.test(noType.data.reason),
            noType.data?.reason);

        const mkType = await POST('/admin/leave/types', {
            as: admin,
            body: { name: 'Compensatory Off', code: 'COMPOFF', category: 'compoff', annualAllocation: 25 },
        });
        COMPOFF_ID = sid(mkType.data);
        check('Admin creates a COMPOFF leave type', mkType.status === 201 && mkType.data.category === 'compoff');
        check('A comp off type cannot carry an annual allocation (earned, not allotted)',
            mkType.data.annualAllocation === 0, String(mkType.data.annualAllocation));

        const casual = await POST('/admin/leave/types', {
            as: admin, body: { name: 'Casual Leave', code: 'CL', annualAllocation: 12 },
        });
        const CL_ID = sid(casual.data);

        const dup = await POST('/admin/leave/types', {
            as: admin, body: { name: 'Comp Off 2', code: 'COMPOFF2', category: 'compoff', annualAllocation: 0 },
        });
        check('A second active comp off type is refused', dup.status === 400, dup.message);

        const enabled = await GET('/teacher/leave/compoff', { as: teacher });
        check('With module + type in place, Comp Off is available', enabled.status === 200 && enabled.data.enabled === true);
        check('Fresh comp off balance starts at zero', (await bal()).remaining === 0);

        const allocAttempt = await POST('/admin/leave/allocations', {
            as: admin, body: { teacherIds: 'all', leaveTypeId: COMPOFF_ID, giveFullAllocation: true },
        });
        check('Comp Off cannot be handed out through the allocation screen',
            allocAttempt.status === 400 && /credited only when/i.test(allocAttempt.message), allocAttempt.message);
        check('… and no balance appeared from the attempt', (await bal()).remaining === 0);

        // ══ SCENARIO 1 — Leave ON · Holiday OFF · Attendance OFF ════════════
        section('Scenario 1 — Leave ON · Holiday OFF · Attendance OFF (fully manual)');

        await setModules(schoolId, { leave: true, holiday: false, attendance: false });

        const d1 = pickPast(isWeekday, 2);
        const s1Preview = await GET(`/teacher/leave/compoff/preview?date=${iso(d1)}`, { as: teacher });
        check('Without the holiday module a weekday cannot be classified — admin judges it',
            s1Preview.data.dayCategory === 'unknown', s1Preview.data?.dayCategory);

        const s1Apply = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(d1), reason: 'Worked on the annual day setup' },
        });
        check('Teacher files a manual Comp Off request', s1Apply.status === 201 && s1Apply.data.status === 'pending');
        check('🔒 NO credit on submission', (await bal()).remaining === 0, JSON.stringify(await bal()));
        check('… and creditedDays is explicitly 0 while pending', s1Apply.data.creditedDays === 0);

        const s1Dup = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(d1), reason: 'Same day again' },
        });
        check('Duplicate request for the same work date is refused',
            s1Dup.status === 400 && /already exists/i.test(s1Dup.message), s1Dup.message);

        const s1Reject = await POST(`/admin/leave/compoff/${sid(s1Apply.data)}/reject`, {
            as: admin, body: { adminComment: 'Not authorised in advance' },
        });
        check('Admin rejects the request', s1Reject.status === 200 && s1Reject.data.status === 'rejected');
        check('🔒 Rejection credits NOTHING', (await bal()).remaining === 0, JSON.stringify(await bal()));

        const d1b = pickPast(isWeekday, 2);
        const s1Apply2 = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(d1b), reason: 'Admission-day duty' },
        });
        check('🔒 Still no credit while the second request is pending', (await bal()).remaining === 0);

        const s1Approve = await POST(`/admin/leave/compoff/${sid(s1Apply2.data)}/approve`, {
            as: admin, body: { adminComment: 'Approved' },
        });
        check('Admin approves the request', s1Approve.status === 200 && s1Approve.data.request.status === 'approved');
        const s1Bal = await bal();
        check('✅ Approval credits the Comp Off balance', s1Bal.remaining === 1 && s1Bal.earned === 1, JSON.stringify(s1Bal));

        const s1Ledger = await LeaveLedger.find({ school: schoolId, teacher: sid(teacher._id), entryType: 'EARNED' }).lean();
        check('EARNED ledger entry written on approval',
            s1Ledger.length === 1 && s1Ledger[0].delta === 1 && s1Ledger[0].remainingDays === 1);

        // ══ SCENARIO 2 — Leave ON · Holiday ON · Attendance OFF ═════════════
        section('Scenario 2 — Leave ON · Holiday ON · Attendance OFF (policy-classified)');

        await setModules(schoolId, { leave: true, holiday: true, attendance: false });

        const dHol = pickPast(isWeekday, 3);
        await Holiday.create({
            school: schoolId, name: `${TAG} Founders Day`, type: 'School Specific',
            startDate: dHol, endDate: dHol,
            applicability: { scope: 'all', classes: [], departments: [] },
            createdBy: sid(admin._id),
        });

        const s2Preview = await GET(`/teacher/leave/compoff/preview?date=${iso(dHol)}`, { as: teacher });
        check('System identifies the work date as a Holiday',
            s2Preview.data.dayCategory === 'holiday' && /Founders Day/.test(s2Preview.data.dayLabel),
            `${s2Preview.data?.dayCategory} / ${s2Preview.data?.dayLabel}`);

        const dSun = pickPast(isSunday, 1);
        const sunPreview = await GET(`/teacher/leave/compoff/preview?date=${iso(dSun)}`, { as: teacher });
        check('System identifies a Sunday', sunPreview.data.dayCategory === 'sunday');

        const dWork = pickPast(isWeekday, 4);
        const workPreview = await GET(`/teacher/leave/compoff/preview?date=${iso(dWork)}`, { as: teacher });
        check('System identifies a regular working day', workPreview.data.dayCategory === 'working_day');
        check('Working days are not eligible by default (policy, not hard-coded)',
            workPreview.data.eligible === false && /working day/i.test(workPreview.data.message),
            workPreview.data?.message);

        const workApply = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dWork), reason: 'Ordinary Tuesday' },
        });
        check('Applying for a working day is refused', workApply.status === 400);

        await PUT('/admin/leave/compoff/policy', { as: admin, body: { allowWorkingDays: true } });
        const workPreview2 = await GET(`/teacher/leave/compoff/preview?date=${iso(dWork)}`, { as: teacher });
        check('Flipping the policy flag makes working days eligible — rule is data, not code',
            workPreview2.data.eligible === true, workPreview2.data?.message);
        await PUT('/admin/leave/compoff/policy', { as: admin, body: { allowWorkingDays: false } });

        await PUT('/admin/leave/compoff/policy', { as: admin, body: { eligibleDays: { holiday: false, weeklyOff: true, sunday: true } } });
        const holBlocked = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dHol), reason: 'Worked the whole holiday' },
        });
        check('Policy can switch holidays off entirely',
            holBlocked.status === 400 && /not allowed for holidays/i.test(holBlocked.message), holBlocked.message);
        await PUT('/admin/leave/compoff/policy', { as: admin, body: { eligibleDays: { holiday: true, weeklyOff: true, sunday: true } } });

        const dOld = daysAgo(200);
        const tooOld = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dOld), reason: 'Very old claim' },
        });
        check('The "apply within X days" window is enforced',
            tooOld.status === 400 && /within 30 day/i.test(tooOld.message), tooOld.message);

        const future = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(daysAhead(3)), reason: 'Will work on Sunday' },
        });
        check('Advance Comp Off is refused while the policy disallows it',
            future.status === 400 && /future date/i.test(future.message), future.message);

        await PUT('/admin/leave/compoff/policy', { as: admin, body: { minWorkingHours: 6, halfDayHours: 6, fullDayHours: 9 } });
        const shortDay = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dHol), checkIn: '10:00', checkOut: '13:00', reason: 'Half a morning' },
        });
        check('Below the minimum working hours nothing is earned',
            shortDay.status === 400 && /Minimum 6 working hour/i.test(shortDay.message), shortDay.message);

        const halfDay = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dHol), checkIn: '09:00', checkOut: '16:00', reason: 'Seven hours on the holiday' },
        });
        check('7h against a 6h/9h policy earns a half day',
            halfDay.status === 201 && halfDay.data.compOffDays === 0.5 && halfDay.data.workedHours === 7,
            `${halfDay.data?.compOffDays} days / ${halfDay.data?.workedHours}h`);
        check('🔒 NO credit while the half-day claim is pending', (await bal()).remaining === 1);

        const s2Approve = await POST(`/admin/leave/compoff/${sid(halfDay.data)}/approve`, { as: admin, body: {} });
        check('✅ Approval credits the half day', s2Approve.data.credited === 0.5 && (await bal()).remaining === 1.5,
            JSON.stringify(await bal()));

        await PUT('/admin/leave/compoff/policy', { as: admin, body: { minWorkingHours: 4, halfDayHours: 4, fullDayHours: 8 } });

        const sunApply = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dSun), checkIn: '09:00', checkOut: '18:00', reason: 'Sunday exam duty' },
        });
        check('Sunday work earns a full day at 9h', sunApply.status === 201 && sunApply.data.compOffDays === 1);
        await POST(`/admin/leave/compoff/${sid(sunApply.data)}/approve`, { as: admin, body: {} });
        check('✅ Balance now 2.5 days', (await bal()).remaining === 2.5, JSON.stringify(await bal()));

        // ══ SCENARIO 3 — Leave ON · Holiday ON · Attendance ON ══════════════
        section('Scenario 3 — Leave ON · Holiday ON · Attendance ON (auto ready-to-apply)');

        await setModules(schoolId, { leave: true, holiday: true, attendance: true });

        const dHol3 = pickPast(isWeekday, 3);
        const hol3 = await Holiday.create({
            school: schoolId, name: `${TAG} Sports Day`, type: 'School Specific',
            startDate: dHol3, endDate: dHol3,
            applicability: { scope: 'all', classes: [], departments: [] },
            createdBy: sid(admin._id),
        });

        // Teacher marks attendance for the holiday, admin approves it
        const reg = await POST('/teacher/regularization', {
            as: teacher,
            body: { date: iso(dHol3), checkIn: '08:30', checkOut: '17:30', reason: 'Sports day duty' },
        });
        check('Teacher marks attendance for the holiday', reg.status === 200 || reg.status === 201);
        check('🔒 No draft and no credit before the attendance is approved',
            (await CompOffRequest.countDocuments({ school: schoolId, workDate: dHol3 })) === 0
            && (await bal()).remaining === 2.5);

        const regApprove = await POST('/admin/regularization-requests/review', {
            as: admin, body: { id: sid(reg.data), status: 'approved', remarks: 'Confirmed' },
        });
        check('Admin approves the attendance', regApprove.status === 200);
        await sleep(600);   // the comp off hook runs on setImmediate

        const draftList = await GET('/teacher/leave/compoff', { as: teacher });
        const draft = (draftList.data.drafts || []).find((d) => iso(new Date(d.workDate)) === iso(dHol3));
        check('Approved attendance auto-creates a Comp Off application', !!draft,
            `drafts: ${(draftList.data.drafts || []).length}`);
        check('… as a ready-to-apply DRAFT, not a submitted request', draft?.status === 'draft');
        check('… pre-filled with employee, date, holiday, attendance and hours',
            !!draft && sid(draft.teacher) === sid(teacher._id)
            && sid(draft.holiday?._id ?? draft.holiday) === sid(hol3._id)
            && !!draft.attendance
            && draft.checkIn === '08:30' && draft.checkOut === '17:30'
            && draft.workedHours === 9 && draft.compOffDays === 1
            && draft.dayCategory === 'holiday' && /Sports Day/.test(draft.dayLabel || '')
            && draft.source === 'attendance',
            JSON.stringify({ h: draft?.workedHours, d: draft?.compOffDays, c: draft?.dayCategory, s: draft?.source }));
        check('🔒 NO credit from auto-generation', (await bal()).remaining === 2.5, JSON.stringify(await bal()));

        const regen = await POST('/admin/leave/compoff/generate', {
            as: admin, body: { fromDate: iso(daysAgo(30)), toDate: iso(today) },
        });
        check('Re-running generation creates no duplicate for the same work date',
            regen.data.created === 0
            && (await CompOffRequest.countDocuments({ school: schoolId, workDate: dHol3 })) === 1,
            `created ${regen.data?.created}`);

        const applyDraft = await POST(`/teacher/leave/compoff/${sid(draft)}/apply`, {
            as: teacher, body: { reason: 'Sports day duty — reviewed' },
        });
        check('Teacher reviews and clicks Apply', applyDraft.status === 200 && applyDraft.data.status === 'pending');
        check('🔒 NO credit on submitting the draft', (await bal()).remaining === 2.5, JSON.stringify(await bal()));

        const s3Approve = await POST(`/admin/leave/compoff/${sid(draft)}/approve`, { as: admin, body: {} });
        check('✅ Only the approver\'s sign-off credits the balance',
            s3Approve.data.credited === 1 && (await bal()).remaining === 3.5, JSON.stringify(await bal()));

        // Second auto path: admin regularises attendance directly
        const dHol4 = pickPast(isWeekday, 3);
        await Holiday.create({
            school: schoolId, name: `${TAG} Annual Day`, type: 'School Specific',
            startDate: dHol4, endDate: dHol4,
            applicability: { scope: 'all', classes: [], departments: [] },
            createdBy: sid(admin._id),
        });
        await POST('/admin/regularization/apply', {
            as: admin,
            body: { teacherId: sid(teacher._id), date: iso(dHol4), checkIn: '09:00', checkOut: '18:00', remarks: 'Annual day' },
        });
        await sleep(600);
        const draft2 = await CompOffRequest.findOne({ school: schoolId, workDate: dHol4 }).lean();
        check('Admin-marked attendance on a holiday also produces a draft',
            !!draft2 && draft2.status === 'draft' && draft2.compOffDays === 1);
        check('🔒 Still no credit — balance unchanged at 3.5', (await bal()).remaining === 3.5);

        // A working day with attendance must NOT produce a draft
        const dPlain = pickPast(isWeekday, 4);
        await POST('/admin/regularization/apply', {
            as: admin,
            body: { teacherId: sid(teacher._id), date: iso(dPlain), checkIn: '09:00', checkOut: '18:00', remarks: 'Normal day' },
        });
        await sleep(600);
        check('Attendance on an ordinary working day produces no Comp Off draft',
            (await CompOffRequest.countDocuments({ school: schoolId, workDate: dPlain })) === 0);

        // ══ SPENDING — comp off used as leave ═══════════════════════════════
        section('Balance — spending Comp Off as leave (USED)');

        const spendFrom = daysAhead(7);
        const leaveApply = await POST('/teacher/leave/apply', {
            as: teacher,
            body: { leaveTypeId: COMPOFF_ID, fromDate: iso(spendFrom), toDate: iso(spendFrom), reason: 'Comp off day' },
        });
        check('Teacher applies for Comp Off leave', leaveApply.status === 201, leaveApply.message);
        const spendPending = await bal();
        check('Applying moves 1 day into pending, not used',
            spendPending.pending === 1 && spendPending.used === 0 && spendPending.remaining === 2.5,
            JSON.stringify(spendPending));

        const leaveApprove = await POST(`/admin/leave/requests/${sid(leaveApply.data)}/approve`, { as: admin, body: {} });
        check('Admin approves the Comp Off leave', leaveApprove.status === 200);
        const spentBal = await bal();
        check('Approved leave deducts from the balance',
            spentBal.used === 1 && spentBal.pending === 0 && spentBal.remaining === 2.5, JSON.stringify(spentBal));

        const usedEntry = await LeaveLedger.findOne({ school: schoolId, entryType: 'USED' }).lean();
        check('USED ledger entry written with a negative delta', !!usedEntry && usedEntry.delta === -1);

        const lots = await LeaveLedger.find({ school: schoolId, entryType: 'EARNED' }).sort({ expiresAt: 1 }).lean();
        const drained = lots.reduce((s, l) => s + (l.days - l.remainingDays), 0);
        check('Spending drains the FIFO lots oldest-expiry-first', drained === 1,
            lots.map((l) => `${l.days}/${l.remainingDays}`).join(' '));

        const revLeave = await POST(`/admin/leave/requests/${sid(leaveApply.data)}/reverse`, {
            as: admin, body: { adminComment: 'Attendance found for that day' },
        });
        check('Admin reverses the approved leave', revLeave.status === 200);
        const revBal = await bal();
        check('Reversal restores the balance', revBal.used === 0 && revBal.remaining === 3.5, JSON.stringify(revBal));
        const revEntry = await LeaveLedger.findOne({ school: schoolId, entryType: 'REVERSED' }).lean();
        check('REVERSED ledger entry written with a positive delta', !!revEntry && revEntry.delta === 1);

        // ══ CANCELLED / ADJUSTMENT / EXPIRED ════════════════════════════════
        section('Balance — CANCELLED, ADJUSTMENT and EXPIRED');

        const cancelTarget = await CompOffRequest.findOne({ school: schoolId, status: 'approved' }).sort({ createdAt: 1 }).lean();
        const cancelRes = await POST(`/admin/leave/compoff/${sid(cancelTarget)}/cancel`, {
            as: admin, body: { adminComment: 'Claimed in error' },
        });
        check('Admin withdraws an approved Comp Off credit', cancelRes.status === 200 && cancelRes.data.reversed === 1);
        const cancBal = await bal();
        check('Withdrawal removes the days from the balance', cancBal.remaining === 2.5, JSON.stringify(cancBal));
        const cancEntry = await LeaveLedger.findOne({ school: schoolId, entryType: 'CANCELLED' }).lean();
        check('CANCELLED ledger entry written with a negative delta', !!cancEntry && cancEntry.delta === -1);

        const adj = await POST('/admin/leave/compoff/adjust', {
            as: admin, body: { teacherId: sid(teacher._id), days: 2, description: 'Goodwill correction' },
        });
        check('Admin posts a manual ADJUSTMENT', adj.status === 201 && adj.data.entryType === 'ADJUSTMENT' && adj.data.delta === 2);
        check('Adjustment moves the balance', (await bal()).remaining === 4.5, JSON.stringify(await bal()));

        const overDraw = await POST('/admin/leave/compoff/adjust', {
            as: admin, body: { teacherId: sid(teacher._id), days: -99, description: 'Too much' },
        });
        check('A deduction larger than the balance is refused', overDraw.status === 400, overDraw.message);

        // Age one lot past its validity, then sweep
        const liveLot = await LeaveLedger.findOne({ school: schoolId, entryType: 'EARNED', remainingDays: { $gt: 0 } });
        liveLot.expiresAt = daysAgo(1);
        await liveLot.save();
        await CompOffRequest.updateOne({ ledgerEntry: sid(liveLot._id) }, { $set: { expiresAt: daysAgo(1) } });
        const before = await bal();
        const sweep = await POST('/admin/leave/compoff/expire/run', { as: admin });
        const after = await bal();
        check('Expiry sweep lapses out-of-date Comp Off',
            sweep.status === 200 && after.expired === liveLot.days && after.remaining === before.remaining - liveLot.days,
            `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
        const expEntry = await LeaveLedger.findOne({ school: schoolId, entryType: 'EXPIRED' }).lean();
        check('EXPIRED ledger entry written with a negative delta', !!expEntry && expEntry.delta < 0);
        const expReq = await CompOffRequest.findOne({ school: schoolId, status: 'expired' }).lean();
        check('The originating request is marked expired', !!expReq);

        const allTypes = new Set((await LeaveLedger.find({ school: schoolId }).lean()).map((l) => l.entryType));
        check('All six ledger entry types are supported',
            ['EARNED', 'USED', 'EXPIRED', 'CANCELLED', 'REVERSED', 'ADJUSTMENT'].every((t) => allTypes.has(t)),
            [...allTypes].join(', '));

        // ══ APPROVAL WORKFLOW (RBAC) ════════════════════════════════════════
        section('Approval workflow — configured approvers and two-level sign-off');

        await PUT('/admin/leave/compoff/policy', {
            as: admin,
            body: { approval: { mode: 'designation', approverDesignations: ['Principal'], twoLevel: false } },
        });

        const dRbac = pickPast(isSunday, 8);
        const rbacReq = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dRbac), checkIn: '09:00', checkOut: '18:00', reason: 'Sunday duty' },
        });
        const balBeforeRbac = (await bal()).remaining;

        const adminDenied = await POST(`/admin/leave/compoff/${sid(rbacReq.data)}/approve`, { as: admin, body: {} });
        check('With designation-based approval an admin is not an approver',
            adminDenied.status === 403, `${adminDenied.status} ${adminDenied.message}`);
        check('🔒 The denied approval credited nothing', (await bal()).remaining === balBeforeRbac);

        const outsiderDenied = await POST(`/teacher/leave/compoff/${sid(rbacReq.data)}/approve`, { as: outsider, body: {} });
        check('A teacher with a non-approver designation is refused', outsiderDenied.status === 403);

        const principalOk = await POST(`/teacher/leave/compoff/${sid(rbacReq.data)}/approve`, { as: principal, body: {} });
        check('The configured approver (Principal) can approve', principalOk.status === 200 && principalOk.data.credited === 1);
        check('✅ Their approval credits the balance', (await bal()).remaining === balBeforeRbac + 1);

        await PUT('/admin/leave/compoff/policy', {
            as: admin, body: { approval: { mode: 'both', approverDesignations: ['Principal'], twoLevel: true } },
        });

        const dTwo = pickPast(isSunday, 8);
        const twoReq = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dTwo), checkIn: '09:00', checkOut: '18:00', reason: 'Sunday duty again' },
        });
        check('Two-level policy is snapshotted onto the request', twoReq.data.approvalsRequired === 2);
        const balBeforeTwo = (await bal()).remaining;

        const lvl1 = await POST(`/admin/leave/compoff/${sid(twoReq.data)}/approve`, { as: admin, body: {} });
        check('First sign-off is recorded', lvl1.status === 200 && lvl1.data.request.status === 'pending' && lvl1.data.pendingLevels === 1);
        check('🔒 A first-of-two approval credits NOTHING',
            lvl1.data.credited === 0 && (await bal()).remaining === balBeforeTwo, JSON.stringify(await bal()));

        const sameAgain = await POST(`/admin/leave/compoff/${sid(twoReq.data)}/approve`, { as: admin, body: {} });
        check('The same approver cannot supply both sign-offs', sameAgain.status === 400 && /someone else/i.test(sameAgain.message));

        const lvl2 = await POST(`/admin/leave/compoff/${sid(twoReq.data)}/approve`, { as: admin2, body: {} });
        check('The second approver completes the workflow', lvl2.status === 200 && lvl2.data.request.status === 'approved');
        check('✅ Only the final sign-off credits the balance',
            lvl2.data.credited === 1 && (await bal()).remaining === balBeforeTwo + 1, JSON.stringify(await bal()));

        await PUT('/admin/leave/compoff/policy', {
            as: admin, body: { approval: { mode: 'admin', approverDesignations: [], twoLevel: false } },
        });

        // ══ SPENDING RULES FROM POLICY ══════════════════════════════════════
        section('Policy rules applied when Comp Off is spent');

        // Spending Comp Off is an ordinary leave application, so its rules live
        // in the COMPOFF type's LeavePolicy alongside every other type — not in
        // the Comp Off policy, which only covers earning.
        const isMonday = (d) => d.getUTCDay() === 1;
        const mon = pickFuture(isMonday, 30);
        const wed = new Date(mon.getTime() + 2 * 86400000);

        await PUT(`/admin/leave/policies/${COMPOFF_ID}`, {
            as: admin, body: { maxConsecutiveDays: 1, halfDayAllowed: false },
        });
        const tooLong = await POST('/teacher/leave/apply', {
            as: teacher,
            body: { leaveTypeId: COMPOFF_ID, fromDate: iso(mon), toDate: iso(wed), reason: 'Long break' },
        });
        check('Max consecutive days is enforced from the leave type policy',
            tooLong.status === 400 && /Max consecutive days/i.test(tooLong.message), tooLong.message);

        const halfBlocked = await POST('/teacher/leave/apply', {
            as: teacher,
            body: { leaveTypeId: COMPOFF_ID, fromDate: iso(mon), toDate: iso(mon), leaveMode: 'half_day', reason: 'Half day' },
        });
        check('Half-day is refused when the leave type policy disallows it',
            halfBlocked.status === 400 && /Half-day leave is not allowed/i.test(halfBlocked.message), halfBlocked.message);

        await PUT(`/admin/leave/policies/${COMPOFF_ID}`, {
            as: admin, body: { maxConsecutiveDays: 0, halfDayAllowed: true, allowCombineWithOtherLeaves: false },
        });
        await POST('/admin/leave/allocations', { as: admin, body: { teacherIds: [sid(teacher._id)], leaveTypeId: CL_ID, giveFullAllocation: true } });

        // Mon–Thu, so the adjacent day used for the clubbing check is also a
        // working day (this school has Saturdays off).
        const clDay = pickFuture((d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 4, 60);
        const coDay = new Date(clDay.getTime() + 86400000);
        used.add(iso(coDay));
        await POST('/teacher/leave/apply', {
            as: teacher, body: { leaveTypeId: CL_ID, fromDate: iso(clDay), toDate: iso(clDay), reason: 'Casual' },
        });
        const combined = await POST('/teacher/leave/apply', {
            as: teacher, body: { leaveTypeId: COMPOFF_ID, fromDate: iso(coDay), toDate: iso(coDay), reason: 'Comp off next to casual' },
        });
        check('Combining with another leave type is refused when disallowed',
            combined.status === 400 && /cannot be combined/i.test(combined.message), combined.message);

        await PUT(`/admin/leave/policies/${COMPOFF_ID}`, { as: admin, body: { allowCombineWithOtherLeaves: true } });
        const combinedOk = await POST('/teacher/leave/apply', {
            as: teacher, body: { leaveTypeId: COMPOFF_ID, fromDate: iso(coDay), toDate: iso(coDay), reason: 'Comp off next to casual' },
        });
        check('… and allowed once the policy permits it', combinedOk.status === 201, combinedOk.message);

        // ══ CAPS ════════════════════════════════════════════════════════════
        section('Monthly / yearly caps');

        await PUT('/admin/leave/compoff/policy', { as: admin, body: { maxPerMonth: 0.5 } });
        const dCap = pickPast(isSunday, 8);
        const capped = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dCap), checkIn: '09:00', checkOut: '18:00', reason: 'Sunday duty' },
        });
        check('Monthly Comp Off cap is enforced',
            capped.status === 400 && /Monthly Comp Off limit/i.test(capped.message), capped.message);
        await PUT('/admin/leave/compoff/policy', { as: admin, body: { maxPerMonth: 0 } });

        // ══ EMPLOYEE ELIGIBILITY ════════════════════════════════════════════
        section('Eligible employee types');

        await PUT('/admin/leave/compoff/policy', { as: admin, body: { eligibleDesignations: ['Principal'] } });
        const dElig = pickPast(isSunday, 8);
        const notEligible = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dElig), checkIn: '09:00', checkOut: '18:00', reason: 'Sunday duty' },
        });
        check('A designation outside the eligible list is refused',
            notEligible.status === 400 && /designation is not eligible/i.test(notEligible.message), notEligible.message);
        const eligible = await POST('/teacher/leave/compoff', {
            as: principal, body: { workDate: iso(dElig), checkIn: '09:00', checkOut: '18:00', reason: 'Sunday duty' },
        });
        check('An eligible designation may apply for the same day', eligible.status === 201);
        await PUT('/admin/leave/compoff/policy', { as: admin, body: { eligibleDesignations: [] } });

        // ══ VISIBILITY ══════════════════════════════════════════════════════
        section('Ledger, reports and admin views');

        const myLedger = await GET('/teacher/leave/compoff/ledger', { as: teacher });
        check('Employee can read their own Comp Off ledger',
            myLedger.status === 200 && myLedger.data.entries.length > 0);

        const adminLedger = await GET('/admin/leave/compoff/ledger', { as: admin });
        check('Admin can read the school-wide ledger', adminLedger.status === 200 && adminLedger.data.entries.length > 0);

        const balances = await GET('/admin/leave/compoff/balances', { as: admin });
        check('Admin balance summary reports earned/used/expired/remaining',
            balances.status === 200 && balances.data.totals.earned > 0 && balances.data.totals.expired > 0);

        const reports = await GET('/admin/leave/compoff/reports', { as: admin });
        check('Admin reports group requests by status and day category',
            reports.status === 200 && reports.data.summary.total > 0 && !!reports.data.summary.byCategory.holiday);

        const teacherPolicy = await GET('/admin/leave/compoff/policy', { as: teacher });
        check('A teacher cannot read the admin policy endpoint', teacherPolicy.status === 403);

        const leaveBal = await GET('/teacher/leave/balance', { as: teacher });
        const coRow = (leaveBal.data.items || []).find((i) => sid(i.leaveType) === COMPOFF_ID || sid(i.leaveType?._id) === COMPOFF_ID);
        check('Comp Off shows up in the normal Leave Balance view', !!coRow, JSON.stringify(leaveBal.data.items?.length));

        // ══ DUPLICATE GUARDS AT THE DB LEVEL ════════════════════════════════
        section('Partial unique indexes (application guard + DB backstop)');

        // Earlier sections consumed the recent Sundays, so the next free one is
        // outside the 30-day window. This section is about index behaviour, not
        // the deadline — lift it for the duration.
        await PUT('/admin/leave/compoff/policy', { as: admin, body: { applyWithinDays: 0 } });

        const dIdx = pickPast(isSunday, 8);
        const idxFirst = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dIdx), checkIn: '09:00', checkOut: '18:00', reason: 'Sunday duty' },
        });
        check('A live Comp Off claim exists for the work date', idxFirst.status === 201);

        // The service check fires first and returns a readable message …
        const idxDup = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dIdx), checkIn: '09:00', checkOut: '18:00', reason: 'Again' },
        });
        check('Duplicate live claim refused with a readable message',
            idxDup.status === 400 && /already exists/i.test(idxDup.message), idxDup.message);

        // … and the partial unique index is the backstop underneath it.
        let rawDup = null;
        try {
            await CompOffRequest.create({
                teacher: sid(teacher._id), school: schoolId, leaveType: COMPOFF_ID,
                workDate: dIdx, compOffDays: 1, status: 'pending',
            });
        } catch (e) { rawDup = e; }
        check('DB backstop blocks a duplicate live claim even bypassing the service',
            !!rawDup && rawDup.code === 11000, rawDup ? String(rawDup.code) : 'no error raised');

        // Rejecting must free the date again — the whole point of the predicate
        await POST(`/admin/leave/compoff/${sid(idxFirst.data)}/reject`, { as: admin, body: { adminComment: 'No' } });
        const reclaim = await POST('/teacher/leave/compoff', {
            as: teacher, body: { workDate: iso(dIdx), checkIn: '09:00', checkOut: '18:00', reason: 'Re-claim after rejection' },
        });
        check('A rejected claim frees the work date for a fresh claim', reclaim.status === 201, reclaim.message);
        await PUT('/admin/leave/compoff/policy', { as: admin, body: { applyWithinDays: 30 } });

        // Same predicate logic on the pre-existing leave index. Saturdays are
        // non-working for this school, so the date has to be a weekday or the
        // application is rejected for having no working days at all.
        const lvFrom = iso(pickFuture(isWeekday, 40));
        const lv1 = await POST('/teacher/leave/apply', {
            as: teacher, body: { leaveTypeId: CL_ID, fromDate: lvFrom, toDate: lvFrom, reason: 'Casual' },
        });
        check('Leave application created', lv1.status === 201, lv1.message);
        await POST(`/admin/leave/requests/${sid(lv1.data)}/reject`, { as: admin, body: { adminComment: 'No' } });
        const lv2 = await POST('/teacher/leave/apply', {
            as: teacher, body: { leaveTypeId: CL_ID, fromDate: lvFrom, toDate: lvFrom, reason: 'Casual retry' },
        });
        check('A rejected LEAVE application no longer blocks re-applying for the same dates',
            lv2.status === 201, `${lv2.status} ${lv2.message}`);
        const lv3 = await POST('/teacher/leave/apply', {
            as: teacher, body: { leaveTypeId: CL_ID, fromDate: lvFrom, toDate: lvFrom, reason: 'Duplicate' },
        });
        check('… while a still-active one is refused', lv3.status === 400, lv3.message);

        // ══ REVERSAL WORKS FOR EVERY LEAVE TYPE ═════════════════════════════
        section('Reversing an approved leave (any type)');

        await POST(`/admin/leave/requests/${sid(lv2.data)}/approve`, { as: admin, body: {} });
        const clBalBefore = await balanceOf(schoolId, sid(teacher._id), CL_ID);
        check('Approved casual leave counts as used', clBalBefore.used === 1, JSON.stringify(clBalBefore));

        const clReverse = await POST(`/admin/leave/requests/${sid(lv2.data)}/reverse`, {
            as: admin, body: { adminComment: 'Cancelled by employee' },
        });
        const clBalAfter = await balanceOf(schoolId, sid(teacher._id), CL_ID);
        check('Reversal works for a non-Comp-Off leave type too',
            clReverse.status === 200 && clBalAfter.used === 0 && clBalAfter.remaining === clBalBefore.remaining + 1,
            JSON.stringify(clBalAfter));
        check('A general leave reversal writes no Comp Off ledger entry',
            (await LeaveLedger.countDocuments({ school: schoolId, leaveType: CL_ID })) === 0);
        check('Reversing a non-approved leave is refused',
            (await POST(`/admin/leave/requests/${sid(lv2.data)}/reverse`, { as: admin, body: {} })).status === 400);

        // ══ FINAL INVARIANT ═════════════════════════════════════════════════
        section('Final invariant');

        const everCredited = await CompOffRequest.find({
            school: schoolId, creditedDays: { $gt: 0 },
        }).select('status creditedDays approvedAt').lean();
        check('🔒 Every credited Comp Off went through approval',
            everCredited.length > 0 && everCredited.every((r) => !!r.approvedAt),
            `${everCredited.length} credited`);

        const uncredited = await CompOffRequest.find({
            school: schoolId, status: { $in: ['draft', 'pending', 'rejected', 'cancelled'] },
        }).select('status creditedDays').lean();
        check('🔒 No draft / pending / rejected request carries any credit',
            uncredited.every((r) => (r.creditedDays || 0) === 0),
            uncredited.map((r) => `${r.status}:${r.creditedDays}`).join(' '));

        const earnedSum = (await LeaveLedger.find({ school: schoolId, teacher: sid(teacher._id) }).lean())
            .reduce((s, l) => s + l.delta, 0);
        const finalBal = await bal();
        check('Ledger sum reconciles with the balance',
            Math.abs(earnedSum - (finalBal.earned - finalBal.used - finalBal.expired)) < 0.001,
            `ledger ${earnedSum} vs balance ${finalBal.earned - finalBal.used - finalBal.expired}`);
    } catch (e) {
        failed += 1;
        results.push(`\n  💥 Test run threw: ${e.stack || e.message}`);
    } finally {
        if (f) { try { await cleanup(f); } catch (e) { console.error('cleanup failed:', e.message); } }
        server.close();
    }

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  COMP OFF — END-TO-END TESTS');
    console.log('══════════════════════════════════════════════════════════');
    console.log(results.join('\n'));
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('══════════════════════════════════════════════════════════\n');
    process.exit(failed ? 1 : 0);
})();
