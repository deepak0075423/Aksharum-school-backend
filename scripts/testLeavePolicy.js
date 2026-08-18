'use strict';
/**
 * Per-leave-type Leave Policy — end-to-end business-rule tests.
 *
 *   node scripts/testLeavePolicy.js
 *
 * Every leave type carries its own configurable rule set. This drives each rule
 * over HTTP against a throwaway school: prove the default behaviour, flip the
 * rule, prove the behaviour changed, and confirm the rule is per-type rather
 * than global.
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
const LeavePolicy    = require('../models/LeavePolicy');
const LeaveBalance   = require('../models/LeaveBalance');
const LeaveApplication = require('../models/LeaveApplication');
const LeaveLedger    = require('../models/LeaveLedger');
const CompOffPolicy  = require('../models/CompOffPolicy');
const CompOffRequest = require('../models/CompOffRequest');
const Notification        = require('../models/Notification');
const NotificationReceipt = require('../models/NotificationReceipt');

let passed = 0; let failed = 0;
const results = [];
function check(name, condition, detail = '') {
    if (condition) { passed += 1; results.push(`  ✅ ${name}`); }
    else { failed += 1; results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { results.push(`\n▸ ${title}`); }

const TAG = `lptest_${Date.now()}`;
let BASE = '';
const sid = (v) => String(v?._id ?? v);
const token = (user) => jwt.sign(
    { userId: sid(user), role: user.role, schoolId: sid(user.school) },
    process.env.JWT_SECRET, { expiresIn: '1h' },
);

async function call(method, path, { as, body } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token(as)}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* binary */ }
    return { status: res.status, body: json, data: json?.data, message: json?.message };
}
const GET  = (p, o) => call('GET', p, o);
const POST = (p, o) => call('POST', p, o);
const PUT  = (p, o) => call('PUT', p, o);

const today = new Date(); today.setUTCHours(0, 0, 0, 0);
const iso = (d) => d.toISOString().slice(0, 10);
const daysAhead = (n) => new Date(today.getTime() + n * 86400000);
const daysAgo   = (n) => new Date(today.getTime() - n * 86400000);

const used = new Set();
// Back-dating tests need a working day in the past for the same reason the
// forward tests do: a Saturday or Sunday is rejected for having no working days
// before the back-dating rule is evaluated, which made these assertions fail on
// any Sunday, Monday or Tuesday.
function pickPast(pred, start = 1, limit = 200) {
    for (let i = start; i < limit; i += 1) {
        const d = daysAgo(i);
        if (pred(d)) return d;
    }
    throw new Error('no matching past date');
}
function pickFuture(pred, start = 1) {
    for (let i = start; i < 200; i += 1) {
        const d = daysAhead(i);
        if (used.has(iso(d))) continue;
        if (pred(d)) { used.add(iso(d)); return d; }
    }
    throw new Error('no matching future date');
}
const isWeekday = (d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
const isMonThu  = (d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 4;

async function makeUser(name, role, schoolId) {
    const u = await User.create({
        name, email: `${TAG}_${name.toLowerCase()}@example.test`,
        password: await bcrypt.hash('Passw0rd123', 4),
        role, school: schoolId, isFirstLogin: false, isActive: true,
    });
    return { ...(u.toObject?.() ?? u), _id: u._id, role, school: schoolId };
}

async function buildFixture() {
    const school = await School.create({
        name: `${TAG} High School`,
        designations: ['Teacher', 'Principal', 'Lab Assistant'],
        modules: { leave: true, holiday: true, attendance: false },
        leaveSettings: { saturdayWorking: false, saturdayMode: 'all', saturdayHalfDay: false },
    });
    const schoolId = sid(school._id);
    await AcademicYear.create({
        school: schoolId, yearName: `${TAG}-yr`, status: 'active',
        startDate: daysAgo(200), endDate: daysAhead(300),
    });

    const admin     = await makeUser(`Admin${TAG}`,     'school_admin', schoolId);
    const admin2    = await makeUser(`AdminTwo${TAG}`,  'school_admin', schoolId);
    const alice     = await makeUser(`Alice${TAG}`,     'teacher',      schoolId);
    const bob       = await makeUser(`Bob${TAG}`,       'teacher',      schoolId);
    const principal = await makeUser(`Principal${TAG}`, 'teacher',      schoolId);

    // Alice: long-serving female Teacher.  Bob: new male Lab Assistant.
    await TeacherProfile.create({ user: sid(alice._id),     school: schoolId, designation: 'Teacher',       gender: 'Female', joiningDate: daysAgo(900) });
    await TeacherProfile.create({ user: sid(bob._id),       school: schoolId, designation: 'Lab Assistant', gender: 'Male',   joiningDate: daysAgo(10) });
    await TeacherProfile.create({ user: sid(principal._id), school: schoolId, designation: 'Principal',     gender: 'Female', joiningDate: daysAgo(1200) });

    return { schoolId, admin, admin2, alice, bob, principal };
}

async function cleanup(schoolId) {
    await CompOffRequest.deleteMany({ school: schoolId });
    await CompOffPolicy.deleteMany({ school: schoolId });
    await LeaveLedger.deleteMany({ school: schoolId });
    await LeaveApplication.deleteMany({ school: schoolId });
    await LeaveBalance.deleteMany({ school: schoolId });
    await LeavePolicy.deleteMany({ school: schoolId });
    await LeaveType.deleteMany({ school: schoolId });
    await Holiday.deleteMany({ school: schoolId });
    await AcademicYear.deleteMany({ school: schoolId });
    const notes = await Notification.find({ school: schoolId }).select('_id').lean();
    if (notes.length) await NotificationReceipt.deleteMany({ notification: { $in: notes.map(sid) } });
    await Notification.deleteMany({ school: schoolId });
    await TeacherProfile.deleteMany({ school: schoolId });
    await User.deleteMany({ school: schoolId });
    await School.findByIdAndDelete(schoolId);
}

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

    let schoolId;
    try {
        const f = await buildFixture();
        ({ schoolId } = f);
        const { admin, admin2, alice, bob, principal } = f;

        const mkType = async (name, code, alloc = 20) => {
            const r = await POST('/admin/leave/types', { as: admin, body: { name, code, annualAllocation: alloc } });
            const id = sid(r.data);
            await POST('/admin/leave/allocations', {
                as: admin, body: { teacherIds: 'all', leaveTypeId: id, giveFullAllocation: true },
            });
            return id;
        };
        const setPolicy = (id, body) => PUT(`/admin/leave/policies/${id}`, { as: admin, body });
        const applyAs = (who, id, from, to, extra = {}) => POST('/teacher/leave/apply', {
            as: who, body: { leaveTypeId: id, fromDate: iso(from), toDate: iso(to), reason: 'test', ...extra },
        });

        const CL = await mkType('Casual Leave', 'CL');
        const SL = await mkType('Sick Leave', 'SL');
        const ML = await mkType('Maternity Leave', 'ML', 90);

        // ══ DEFAULTS ════════════════════════════════════════════════════════
        section('Every leave type gets a policy, seeded from its own defaults');

        const all = await GET('/admin/leave/policies', { as: admin });
        check('Admin can list a policy for every leave type',
            all.status === 200 && all.data.policies.length === 3, `${all.data?.policies?.length}`);
        check('An unedited type reports itself as unsaved (running on defaults)',
            all.data.policies.every((p) => p.saved === false));
        check('Policy carries its leave type and the designation list for pickers',
            !!all.data.policies[0].leaveType?.name && Array.isArray(all.data.designations));

        const d1 = pickFuture(isWeekday, 5);
        const baseline = await applyAs(alice, CL, d1, d1);
        check('With default policy an ordinary application succeeds', baseline.status === 201, baseline.message);

        // ══ ELIGIBILITY ═════════════════════════════════════════════════════
        section('Who may apply — designation, role, gender, length of service');

        await setPolicy(ML, { gender: 'Female' });
        const d2 = pickFuture(isWeekday, 5);
        const bobML = await applyAs(bob, ML, d2, d2);
        check('Gender-restricted type refuses the wrong gender',
            bobML.status === 400 && /restricted to female/i.test(bobML.message), bobML.message);
        const aliceML = await applyAs(alice, ML, d2, d2);
        check('… and allows the right one', aliceML.status === 201, aliceML.message);

        await setPolicy(SL, { eligibleDesignations: ['Teacher'] });
        const d3 = pickFuture(isWeekday, 5);
        const bobSL = await applyAs(bob, SL, d3, d3);
        check('Designation restriction refuses a non-matching designation',
            bobSL.status === 400 && /designation/i.test(bobSL.message), bobSL.message);
        const dBobCl = pickFuture(isWeekday, 5);
        const bobCl = await applyAs(bob, CL, dBobCl, dBobCl);
        check('Rules are per leave type, not global — CL still open to Bob', bobCl.status === 201, bobCl.message);

        await setPolicy(CL, { minServiceDays: 180 });
        const dSvc = pickFuture(isWeekday, 5);
        const bobProbation = await applyAs(bob, CL, dSvc, dSvc);
        check('Minimum service (probation) blocks a new joiner',
            bobProbation.status === 400 && /180 day\(s\) of service/i.test(bobProbation.message), bobProbation.message);
        const aliceService = await applyAs(alice, CL, dSvc, dSvc);
        check('… and passes a long-serving employee', aliceService.status === 201, aliceService.message);
        await setPolicy(CL, { minServiceDays: 0 });

        // ══ SHAPE OF THE APPLICATION ════════════════════════════════════════
        section('Shape — consecutive days, minimum length, notice, back-dating');

        await setPolicy(CL, { maxConsecutiveDays: 2 });
        const mon = pickFuture((d) => d.getUTCDay() === 1, 20);
        used.add(iso(new Date(mon.getTime() + 86400000)));
        used.add(iso(new Date(mon.getTime() + 2 * 86400000)));
        const tooLong = await applyAs(alice, CL, mon, new Date(mon.getTime() + 2 * 86400000));
        check('Max consecutive days is enforced',
            tooLong.status === 400 && /Max consecutive days/i.test(tooLong.message), tooLong.message);

        await setPolicy(CL, { maxConsecutiveDays: 0, minDaysPerApplication: 2 });
        const dMin = pickFuture(isWeekday, 20);
        const tooShort = await applyAs(alice, CL, dMin, dMin);
        check('Minimum days per application is enforced',
            tooShort.status === 400 && /at least 2 day\(s\)/i.test(tooShort.message), tooShort.message);
        await setPolicy(CL, { minDaysPerApplication: 0 });

        await setPolicy(SL, { eligibleDesignations: [], advanceNoticeDays: 7 });
        const dSoon = pickFuture(isWeekday, 2);
        const tooSoon = await applyAs(alice, SL, dSoon, dSoon);
        check('Advance notice period is enforced',
            tooSoon.status === 400 && /7 day\(s\) advance notice/i.test(tooSoon.message), tooSoon.message);
        const dLater = pickFuture(isWeekday, 20);
        check('… and satisfied by a later date', (await applyAs(alice, SL, dLater, dLater)).status === 201);
        await setPolicy(SL, { advanceNoticeDays: 0 });

        // Inside the 5-day window opened below, and a working day.
        const past = pickPast(isWeekday, 1, 5);
        const backdated = await applyAs(alice, SL, past, past);
        check('Back-dated applications are refused by default',
            backdated.status === 400 && /past dates/i.test(backdated.message), backdated.message);

        await setPolicy(SL, { allowBackdated: true, backdatedWithinDays: 5 });
        const backOk = await applyAs(alice, SL, past, past);
        check('… allowed once the policy opens the window', backOk.status === 201, backOk.message);
        const tooOld = pickPast(isWeekday, 40);
        const backTooOld = await applyAs(alice, SL, tooOld, tooOld);
        check('… but only inside that window',
            backTooOld.status === 400 && /within 5 day\(s\)/i.test(backTooOld.message), backTooOld.message);
        await setPolicy(SL, { allowBackdated: false });

        // ══ HALF DAY & SANDWICH RULE ════════════════════════════════════════
        section('Day counting — half day and the sandwich rule');

        await setPolicy(CL, { halfDayAllowed: false });
        const dHalf = pickFuture(isWeekday, 20);
        const halfNo = await applyAs(alice, CL, dHalf, dHalf, { leaveMode: 'half_day' });
        check('Half-day can be switched off per type',
            halfNo.status === 400 && /Half-day leave is not allowed/i.test(halfNo.message), halfNo.message);
        await setPolicy(CL, { halfDayAllowed: true });
        const halfYes = await applyAs(alice, CL, dHalf, dHalf, { leaveMode: 'half_day' });
        check('… and back on again', halfYes.status === 201 && halfYes.data.totalDays === 0.5, halfYes.message);

        // Friday → Monday: two working days normally, four under the sandwich rule
        const fri = pickFuture((d) => d.getUTCDay() === 5, 20);
        const nextMon = new Date(fri.getTime() + 3 * 86400000);
        [1, 2, 3].forEach((n) => used.add(iso(new Date(fri.getTime() + n * 86400000))));

        const noSandwich = await applyAs(alice, SL, fri, nextMon);
        check('Without the sandwich rule the weekend is free',
            noSandwich.status === 201 && noSandwich.data.totalDays === 2, `${noSandwich.data?.totalDays}`);
        await POST(`/admin/leave/requests/${sid(noSandwich.data)}/reject`, { as: admin, body: {} });

        await setPolicy(SL, { sandwichRule: true });
        const sandwiched = await applyAs(alice, SL, fri, nextMon);
        check('With the sandwich rule the weekend is charged',
            sandwiched.status === 201 && sandwiched.data.totalDays === 4, `${sandwiched.data?.totalDays}`);
        await POST(`/admin/leave/requests/${sid(sandwiched.data)}/reject`, { as: admin, body: {} });
        await setPolicy(SL, { sandwichRule: false });

        // ══ DOCUMENT ════════════════════════════════════════════════════════
        section('Supporting document');

        await setPolicy(SL, { requiresDocument: true, documentRequiredAfterDays: 2 });
        const dDoc = pickFuture((d) => d.getUTCDay() === 1, 20);
        [1, 2].forEach((n) => used.add(iso(new Date(dDoc.getTime() + n * 86400000))));
        const needsDoc = await applyAs(alice, SL, dDoc, new Date(dDoc.getTime() + 2 * 86400000));
        check('Document is demanded past the configured threshold',
            needsDoc.status === 400 && /document is required/i.test(needsDoc.message), needsDoc.message);
        const shortNoDoc = await applyAs(alice, SL, dDoc, dDoc);
        check('… and not demanded below it', shortNoDoc.status === 201, shortNoDoc.message);
        await setPolicy(SL, { requiresDocument: false });

        // ══ FREQUENCY CAPS ══════════════════════════════════════════════════
        section('Frequency caps');

        await setPolicy(CL, { maxApplicationsPerMonth: 1 });
        const capMon = pickFuture((d) => d.getUTCDay() === 2, 90);
        const capMon2 = pickFuture((d) => d.getUTCDay() === 3 && d.getUTCMonth() === capMon.getUTCMonth(), 90);
        const first = await applyAs(alice, CL, capMon, capMon);
        check('First application of the month is accepted', first.status === 201, first.message);
        const second = await applyAs(alice, CL, capMon2, capMon2);
        check('Monthly application cap is enforced',
            second.status === 400 && /per month/i.test(second.message), second.message);
        await setPolicy(CL, { maxApplicationsPerMonth: 0, maxDaysPerMonth: 1 });
        const dayCap = pickFuture((d) => d.getUTCDay() === 4 && d.getUTCMonth() === capMon.getUTCMonth(), 90);
        const overDays = await applyAs(alice, CL, dayCap, dayCap);
        check('Monthly day cap counts days already applied for',
            overDays.status === 400 && /day\(s\) of this type are allowed per month/i.test(overDays.message), overDays.message);
        await setPolicy(CL, { maxDaysPerMonth: 0 });

        // ══ NEGATIVE BALANCE ════════════════════════════════════════════════
        section('Negative balance (leave without pay)');

        const LOP = await mkType('Special Leave', 'SPL', 1);
        const lopMon = pickFuture((d) => d.getUTCDay() === 1, 120);
        [1, 2].forEach((n) => used.add(iso(new Date(lopMon.getTime() + n * 86400000))));
        const over = await applyAs(alice, LOP, lopMon, new Date(lopMon.getTime() + 2 * 86400000));
        check('Over-drawing the balance is refused by default',
            over.status === 400 && /Insufficient/i.test(over.message), over.message);

        await setPolicy(LOP, { allowNegativeBalance: true, maxNegativeDays: 5 });
        const overOk = await applyAs(alice, LOP, lopMon, new Date(lopMon.getTime() + 2 * 86400000));
        check('… allowed once the policy permits an overdraft', overOk.status === 201, overOk.message);

        // ══ ENTITLEMENT MECHANICS ═══════════════════════════════════════════
        section('Entitlement mechanics — accrual, carry forward, encashment');

        const ACC = await mkType('Earned Leave', 'EL', 12);

        // Allocation asks the policy, not the leave type, whether this accrues
        await setPolicy(ACC, { monthlyAccrual: { enabled: true, daysPerMonth: 1 } });
        await POST('/admin/leave/allocations', {
            as: admin, body: { teacherIds: [sid(alice._id)], leaveTypeId: ACC, giveFullAllocation: false },
        });
        const accBal = await LeaveBalance.findOne({ teacher: sid(alice._id), leaveType: ACC, school: schoolId }).lean();
        check('An accruing type allocates 0 up front',
            accBal.totalAllocated === 0, `${accBal?.totalAllocated}`);

        const accrual = await POST('/admin/leave/accrual/run', { as: admin });
        const afterAccrual = await LeaveBalance.findOne({ teacher: sid(alice._id), leaveType: ACC, school: schoolId }).lean();
        check('Monthly accrual credits the policy\'s days per month',
            accrual.status === 200 && afterAccrual.totalAllocated === 1,
            `${afterAccrual?.totalAllocated}`);

        // Turning accrual off through the policy stops the cron picking it up
        await setPolicy(ACC, { monthlyAccrual: { enabled: false } });
        await LeaveBalance.updateOne({ _id: afterAccrual._id }, { $set: { lastAccrualAt: null } });
        await POST('/admin/leave/accrual/run', { as: admin });
        const noAccrual = await LeaveBalance.findOne({ _id: afterAccrual._id }).lean();
        check('Switching accrual off in the policy stops it',
            noAccrual.totalAllocated === 1, `${noAccrual?.totalAllocated}`);

        // Carry forward is driven by the policy too
        await LeaveBalance.updateOne({ _id: afterAccrual._id }, { $set: { totalAllocated: 10, used: 4 } });
        const cfOff = await POST('/admin/leave/allocations/carry-forward', {
            as: admin, body: { fromYear: `${TAG}-yr`, toYear: `${TAG}-next` },
        });
        check('Nothing carries forward while the policy says not to',
            cfOff.data?.processed === 0 || cfOff.body?.processed === 0,
            JSON.stringify(cfOff.body));

        await setPolicy(ACC, { carryForward: { enabled: true, maxDays: 3 } });
        await POST('/admin/leave/allocations/carry-forward', {
            as: admin, body: { fromYear: `${TAG}-yr`, toYear: `${TAG}-next` },
        });
        const carried = await LeaveBalance.findOne({
            teacher: sid(alice._id), leaveType: ACC, school: schoolId, academicYear: `${TAG}-next`,
        }).lean();
        check('Carry forward runs from the policy and honours its cap',
            carried?.carriedForward === 3, `${carried?.carriedForward}`);

        await setPolicy(ACC, { encashable: true, maxEncashableDays: 5 });
        const encashed = await GET(`/admin/leave/policies/${ACC}`, { as: admin });
        check('Encashment settings persist on the policy',
            encashed.data.encashable === true && encashed.data.maxEncashableDays === 5);

        // ══ APPROVAL WORKFLOW ═══════════════════════════════════════════════
        section('Approval workflow — configured approvers and two-level sign-off');

        await setPolicy(SL, { approval: { mode: 'designation', approverDesignations: ['Principal'], twoLevel: false } });
        const dAppr = pickFuture(isWeekday, 20);
        const apprReq = await applyAs(alice, SL, dAppr, dAppr);
        check('Application filed against a designation-approved type', apprReq.status === 201, apprReq.message);

        const adminDenied = await POST(`/admin/leave/requests/${sid(apprReq.data)}/approve`, { as: admin, body: {} });
        check('An admin is not an approver when the policy names a designation',
            adminDenied.status === 403, `${adminDenied.status} ${adminDenied.message}`);

        const queue = await GET('/teacher/leave/approvals', { as: principal });
        check('The configured approver sees the request in their own queue',
            queue.status === 200 && queue.data.isApprover === true
            && queue.data.items.some((i) => sid(i) === sid(apprReq.data)),
            `${queue.data?.items?.length} item(s)`);
        const bobQueue = await GET('/teacher/leave/approvals', { as: bob });
        check('A non-approver gets an empty queue', bobQueue.data.isApprover === false);

        const principalOk = await POST(`/teacher/leave/approvals/${sid(apprReq.data)}/approve`, { as: principal, body: {} });
        check('The configured approver can approve', principalOk.status === 200, principalOk.message);
        check('Approval marks the application approved',
            (await LeaveApplication.findById(sid(apprReq.data)).lean()).status === 'approved');

        await setPolicy(CL, { approval: { mode: 'both', approverDesignations: ['Principal'], twoLevel: true } });
        const dTwo = pickFuture(isWeekday, 20);
        const twoReq = await applyAs(alice, CL, dTwo, dTwo);
        check('Two-level policy is snapshotted onto the application',
            twoReq.data.approvalsRequired === 2, `${twoReq.data?.approvalsRequired}`);

        const balBefore = await LeaveBalance.findOne({ teacher: sid(alice._id), leaveType: CL, school: schoolId }).lean();
        const lvl1 = await POST(`/admin/leave/requests/${sid(twoReq.data)}/approve`, { as: admin, body: {} });
        check('First sign-off is recorded but does not approve',
            lvl1.status === 200 && lvl1.data.status === 'pending' && lvl1.body.pendingLevels === 1,
            `${lvl1.data?.status}`);
        const balMid = await LeaveBalance.findOne({ teacher: sid(alice._id), leaveType: CL, school: schoolId }).lean();
        check('🔒 A first-of-two approval moves no balance',
            balMid.used === balBefore.used && balMid.pending === balBefore.pending,
            `used ${balBefore.used}→${balMid.used}`);

        const sameAgain = await POST(`/admin/leave/requests/${sid(twoReq.data)}/approve`, { as: admin, body: {} });
        check('The same approver cannot supply both sign-offs',
            sameAgain.status === 400 && /someone else/i.test(sameAgain.message), sameAgain.message);

        const lvl2 = await POST(`/admin/leave/requests/${sid(twoReq.data)}/approve`, { as: admin2, body: {} });
        check('A second approver completes the workflow',
            lvl2.status === 200 && lvl2.data.status === 'approved', lvl2.message);
        const balAfter = await LeaveBalance.findOne({ teacher: sid(alice._id), leaveType: CL, school: schoolId }).lean();
        check('✅ Only the final sign-off moves the balance',
            balAfter.used === balBefore.used + twoReq.data.totalDays, `used ${balBefore.used}→${balAfter.used}`);

        await setPolicy(CL, { approval: { mode: 'admin', approverDesignations: [], twoLevel: false } });

        // ══ SUSPENDING A TYPE ═══════════════════════════════════════════════
        section('Suspending a leave type through its policy');

        await setPolicy(ML, { isActive: false });
        const dSusp = pickFuture(isWeekday, 20);
        const suspended = await applyAs(alice, ML, dSusp, dSusp);
        check('A policy switched off stops new applications',
            suspended.status === 400 && /not accepting applications/i.test(suspended.message), suspended.message);
        await setPolicy(ML, { isActive: true });

        // ══ TEACHER VISIBILITY ══════════════════════════════════════════════
        section('What the employee sees');

        const mine = await GET('/teacher/leave/policies', { as: bob });
        const bobML2 = mine.data.find((p) => sid(p.leaveType._id) === ML);
        const bobCL2 = mine.data.find((p) => sid(p.leaveType._id) === CL);
        check('Employee sees each type with its rules', mine.status === 200 && mine.data.length >= 3);
        check('… flagged ineligible with a reason where it applies',
            bobML2?.eligible === false && /female/i.test(bobML2.ineligibleReason || ''), bobML2?.ineligibleReason);
        check('… and eligible where it applies', bobCL2?.eligible === true, bobCL2?.ineligibleReason);

        // ══ PERSISTENCE ═════════════════════════════════════════════════════
        section('Saving is partial-safe');

        await setPolicy(CL, { maxConsecutiveDays: 7, advanceNoticeDays: 3 });
        await setPolicy(CL, { advanceNoticeDays: 1 });   // patch touching one field only
        const after = await GET(`/admin/leave/policies/${CL}`, { as: admin });
        check('A partial save leaves unrelated rules intact',
            after.data.maxConsecutiveDays === 7 && after.data.advanceNoticeDays === 1,
            `max ${after.data?.maxConsecutiveDays}, notice ${after.data?.advanceNoticeDays}`);
        check('Saved policies report themselves as saved', after.data.saved === true);

        const teacherWrite = await PUT(`/admin/leave/policies/${CL}`, { as: alice, body: { maxConsecutiveDays: 99 } });
        check('A teacher cannot edit a policy', teacherWrite.status === 403);
    } catch (e) {
        failed += 1;
        results.push(`\n  💥 Test run threw: ${e.stack || e.message}`);
    } finally {
        if (schoolId) { try { await cleanup(schoolId); } catch (e) { console.error('cleanup failed:', e.message); } }
        server.close();
    }

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  LEAVE POLICY (per leave type) — END-TO-END TESTS');
    console.log('══════════════════════════════════════════════════════════');
    console.log(results.join('\n'));
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('══════════════════════════════════════════════════════════\n');
    process.exit(failed ? 1 : 0);
})();
