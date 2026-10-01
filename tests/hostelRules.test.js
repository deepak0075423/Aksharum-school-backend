'use strict';
/**
 * The hostel's day-to-day rules, as found wanting by the module audit.
 *
 * What is worth guarding:
 *   · document numbers come from a counter: deleting a row, or two requests at
 *     once, never hands out a number twice;
 *   · a leave or pass for ANOTHER day does not block a request for today, and
 *     a request nobody ever used does not block the next one;
 *   · a pass opens the gate on its own day only, and an unused one is closed;
 *   · somebody overdue is announced, once;
 *   · a teacher's leave never waits for a parent;
 *   · moving out ends the mess enrolment and cancels unused requests;
 *   · a bed given from Allocations settles the approved application;
 *   · the waiting list has no gaps and no repeats;
 *   · the warden picked on the hostel form is a posting, and replaces the last;
 *   · "Block" stops the visitor next time, and names are matched whole;
 *   · a closed floor's beds cannot be given out;
 *   · every list screen answers.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const School = require('../models/School');
const User = require('../models/User');
const Hostel = require('../models/Hostel');
const HostelBuilding = require('../models/HostelBuilding');
const HostelFloor = require('../models/HostelFloor');
const HostelRoom = require('../models/HostelRoom');
const HostelBed = require('../models/HostelBed');
const HostelAllocation = require('../models/HostelAllocation');
const HostelAdmission = require('../models/HostelAdmission');
const HostelLeave = require('../models/HostelLeave');
const HostelOutpass = require('../models/HostelOutpass');
const HostelVisitor = require('../models/HostelVisitor');
const HostelMess = require('../models/HostelMess');
const HostelMessMember = require('../models/HostelMessMember');
const HostelStaffAssignment = require('../models/HostelStaffAssignment');
const HostelFeeInvoice = require('../models/HostelFeeInvoice');
const HostelComplaint = require('../models/HostelComplaint');
const Notification = require('../models/Notification');
const alloc = require('../services/hostelAllocation');
const svc = require('../services/hostelService');
const ctl = require('../controllers/hostel.controller');
const boards = require('../controllers/hostelBoards.controller');
const { makeSchool, teardown } = require('./helpers');
const { query } = require('../db/pool');

let S; let H; let seq = 0;
const uid = () => crypto.randomUUID();
const YEAR = uid();
const day = (n) => new Date(Date.now() + n * 864e5);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function call(handler, req) {
    return new Promise((resolve) => {
        let code = 200;
        const res = { status(c) { code = c; return this; }, json(p) { resolve([code, p]); } };
        handler({ params: {}, query: {}, body: {}, headers: {}, ip: '', ...S.ctx, ...req }, res);
    });
}
const person = (role, name = `ZZ ${role} ${++seq}`) => User.create({ school: S.id, name, role, email: `zz-${uid()}@test.invalid`, password: 'x', isActive: true });

/** A resident in their own bed of the test hostel. */
async function resident(role = 'student') {
    const u = await person(role);
    const n = ++seq;
    const bed = await HostelBed.create({ school: S.id, hostel: H.h._id, building: H.b._id, floor: H.f._id, room: H.r._id,
        bedNumber: `X${n}`, code: `ZZX${n}`, status: 'available', isActive: true, occupantType: 'both' });
    const r = await alloc.allocateBed({ schoolId: S.id, studentId: String(u._id), bedId: String(bed._id), academicYearId: YEAR });
    return { u, bed, allocation: r.allocation };
}

before(async () => {
    S = await makeSchool();
    await School.findByIdAndUpdate(S.id, { $set: { 'modules.hostel': true } });
    const h = await Hostel.create({ school: S.id, name: 'ZZ Rules Hostel', code: 'ZZRH', gender: 'co_ed', status: 'active', isActive: true });
    const b = await HostelBuilding.create({ school: S.id, hostel: h._id, name: 'Block', code: 'ZRB' });
    const f = await HostelFloor.create({ school: S.id, hostel: h._id, building: b._id, name: 'Ground', floorNumber: 0 });
    const r = await HostelRoom.create({ school: S.id, hostel: h._id, building: b._id, floor: f._id, roomNumber: 'Z-1', code: 'ZRR', capacity: 90, status: 'available', isActive: true });
    H = { h, b, f, r };
    // One big room holds every test's resident.
    await svc.getSettings(S.id);
    await require('../models/HostelSettings').updateOne({ school: S.id }, { $set: { maxRoomCapacity: 100, minLeaveNoticeDays: 0 } });
});
after(async () => { await teardown(S?.id); });

describe('document numbers', () => {
    test('a deleted row does not bring a number back, and a burst gets distinct numbers', async () => {
        const first = await svc.nextNumber(HostelVisitor, S.id, 'ZT');
        const row = await HostelVisitor.create({ school: S.id, hostel: H.h._id, student: uid(), visitorName: 'x', isTemplate: true, listType: 'authorized' });
        const second = await svc.nextNumber(HostelVisitor, S.id, 'ZT');
        await HostelVisitor.deleteOne({ _id: row._id });
        const third = await svc.nextNumber(HostelVisitor, S.id, 'ZT');
        assert.equal(new Set([first, second, third]).size, 3, [first, second, third].join(', '));
        const burst = await Promise.all(Array.from({ length: 12 }, () => svc.nextNumber(HostelVisitor, S.id, 'ZT')));
        assert.equal(new Set(burst).size, 12, burst.join(', '));
    });
});

describe('leave and outpass', () => {
    const settingsFor = async (over = {}) => ({ ...(await svc.getSettings(S.id)).toObject?.() ?? await svc.getSettings(S.id), ...over });

    test('a leave approved for next month does not block an outpass today', async () => {
        const { u, allocation } = await resident();
        await HostelLeave.create({ school: S.id, student: String(u._id), hostel: H.h._id, allocation: allocation._id, leaveNumber: 'ZL1',
            fromDate: day(30), toDate: day(33), reason: 'r', totalDays: 4, status: 'approved' });
        const settings = await settingsFor({ maxOutpassHours: 0, outpassFrom: '', outpassTo: '' });
        const ok = await ctl._validateOutpass({ schoolId: S.id, studentId: String(u._id), departureDate: ymd(day(1)),
            expectedDepartureTime: '10:00', expectedReturnTime: '12:00', settings });
        assert.ok(ok.allocation);
        // …but a pass ON one of the leave's days is refused.
        await assert.rejects(ctl._validateOutpass({ schoolId: S.id, studentId: String(u._id), departureDate: ymd(day(31)),
            expectedDepartureTime: '10:00', expectedReturnTime: '12:00', settings }), /on leave then/);
    });
    test('a pass that was approved and never used does not block the next request', async () => {
        const { u, allocation } = await resident();
        const old = await HostelOutpass.create({ school: S.id, student: String(u._id), hostel: H.h._id, allocation: allocation._id, outpassNumber: 'ZO1',
            purpose: 'p', departureDate: day(-5), expectedReturnAt: day(-5), status: 'approved', qrToken: 'zz-old-token' });
        const settings = await settingsFor({ maxOutpassHours: 0, outpassFrom: '', outpassTo: '' });
        const ok = await ctl._validateOutpass({ schoolId: S.id, studentId: String(u._id), departureDate: ymd(day(1)),
            expectedDepartureTime: '10:00', expectedReturnTime: '12:00', settings });
        assert.ok(ok.allocation);
        // The gate refuses the old pass, and the sweep closes it and kills its QR.
        const [code, out] = await call(ctl.gateScan, { body: { token: 'zz-old-token', direction: 'out' } });
        assert.equal(code, 400);
        assert.match(out.message, /expired/);
        const r = await ctl.sweepOverdue(S.id);
        assert.ok(r.expired >= 1);
        const closed = await HostelOutpass.findById(old._id).lean();
        assert.equal(closed.status, 'cancelled');
        assert.equal(closed.qrToken, '');
    });
    test('a pass for tomorrow does not open the gate today', async () => {
        const { u, allocation } = await resident();
        await HostelOutpass.create({ school: S.id, student: String(u._id), hostel: H.h._id, allocation: allocation._id, outpassNumber: 'ZO2',
            purpose: 'p', departureDate: day(1), expectedReturnAt: day(2), status: 'approved', qrToken: 'zz-tomorrow' });
        const [code, out] = await call(ctl.gateScan, { body: { token: 'zz-tomorrow', direction: 'out' } });
        assert.equal(code, 400);
        assert.match(out.message, /cannot be used before/);
    });
    test('somebody overdue is announced to the hostel, once', async () => {
        const { u, allocation } = await resident();
        const pass = await HostelOutpass.create({ school: S.id, student: String(u._id), hostel: H.h._id, allocation: allocation._id, outpassNumber: 'ZO3',
            purpose: 'p', departureDate: day(-1), expectedReturnAt: new Date(Date.now() - 6 * 36e5), status: 'active' });
        const count = () => Notification.countDocuments({ school: S.id, title: 'Resident overdue from outpass' });
        const before0 = await count();
        const first = await ctl.sweepOverdue(S.id);
        assert.ok(first.outpasses >= 1);
        assert.equal((await HostelOutpass.findById(pass._id).lean()).status, 'overdue');
        await wait(400);                                        // notifications are sent after the reply
        const after1 = await count();
        assert.ok(after1 > before0, 'the hostel was told');
        await ctl.sweepOverdue(S.id);
        await wait(300);
        assert.equal(await count(), after1, 'and not told again');
    });
    test('a teacher\'s leave never waits for a parent; a student\'s does when the school says so', async () => {
        await require('../models/HostelSettings').updateOne({ school: S.id }, { $set: { leaveRequiresParentApproval: true, minLeaveNoticeDays: 0 } });
        const t = await resident('teacher'); const s = await resident('student');
        const file = (who) => call(ctl.createLeave, { body: { student: String(who.u._id), fromDate: ymd(day(3)), toDate: ymd(day(4)), reason: 'r', status: 'approved' } });
        const [tc, tOut] = await file(t); const [sc, sOut] = await file(s);
        assert.equal(tc, 200, JSON.stringify(tOut)); assert.equal(sc, 200, JSON.stringify(sOut));
        assert.equal(tOut.data.parentApprovalRequired, false);
        assert.equal(sOut.data.parentApprovalRequired, true);
        assert.equal(tOut.data.status, 'pending', 'the form cannot approve its own request');
        const [approve] = await call(ctl.actOnLeave, { params: { id: String(tOut.data._id) }, body: { action: 'approve' } });
        assert.equal(approve, 200);
    });
});

describe('moving out', () => {
    test('ends the mess enrolment and cancels requests not yet used', async () => {
        const { u, allocation } = await resident();
        const sid = String(u._id);
        const mess = await HostelMess.create({ school: S.id, name: 'ZZ M', code: `ZM${++seq}`, isActive: true });
        await HostelMessMember.create({ school: S.id, mess: mess._id, student: sid, hostel: H.h._id, allocation: allocation._id, status: 'active' });
        await HostelLeave.create({ school: S.id, student: sid, hostel: H.h._id, allocation: allocation._id, leaveNumber: 'ZL9', fromDate: day(5), toDate: day(6), reason: 'r', totalDays: 2, status: 'approved' });
        await HostelOutpass.create({ school: S.id, student: sid, hostel: H.h._id, allocation: allocation._id, outpassNumber: 'ZO9', purpose: 'p', departureDate: day(1), status: 'approved', qrToken: 'zz-leaving' });
        const [code, out] = await call(ctl.releaseAllocation, { params: { id: String(allocation._id) }, body: { reason: 'left' } });
        assert.equal(code, 200, JSON.stringify(out));
        assert.deepEqual(out.data.ended, { messEnrolments: 1, leaves: 1, outpasses: 1, visits: 0 });
        assert.equal((await HostelMessMember.findOne({ school: S.id, student: sid }).lean()).status, 'ended');
        assert.equal((await HostelOutpass.findOne({ school: S.id, student: sid }).lean()).qrToken, '');
    });
});

describe('admissions', () => {
    const apply = (who, status, extra = {}) => HostelAdmission.create({ school: S.id, student: String(who._id), hostel: H.h._id, academicYear: YEAR,
        applicationNumber: `ZA${++seq}`, status, ...extra });

    test('a bed given from Allocations settles the approved application', async () => {
        const u = await person('student');
        const a = await apply(u, 'approved');
        const bed = await HostelBed.create({ school: S.id, hostel: H.h._id, building: H.b._id, floor: H.f._id, room: H.r._id, bedNumber: `A${++seq}`, code: `ZZA${seq}`, status: 'available', isActive: true });
        const [code, out] = await call(ctl.createAllocation, { body: { student: String(u._id), bed: String(bed._id), academicYear: YEAR } });
        assert.equal(code, 200, JSON.stringify(out));
        const after1 = await HostelAdmission.findById(a._id).lean();
        assert.equal(after1.status, 'completed');
        assert.equal(String(after1.allocation), String(out.data._id));
    });
    test('the waiting list has no gaps and no repeats', async () => {
        const [a, b, c] = [await apply(await person('student'), 'pending_approval'), await apply(await person('student'), 'pending_approval'), await apply(await person('student'), 'pending_approval')];
        const decide = (row, action) => call(ctl.decideAdmission, { params: { id: String(row._id) }, body: { action } });
        await decide(a, 'waitlist'); await decide(b, 'waitlist');
        await decide(a, 'reject');                              // the head of the queue leaves
        await decide(c, 'waitlist');
        const queue = await HostelAdmission.find({ school: S.id, hostel: H.h._id, status: 'waitlisted' }).sort('waitlistPosition').lean();
        assert.deepEqual(queue.map((x) => x.waitlistPosition), [1, 2]);
        assert.deepEqual(queue.map((x) => String(x._id)), [String(b._id), String(c._id)]);
    });
});

describe('wardens and structure', () => {
    test('the warden picked on the hostel form is a posting, and replaces the last one', async () => {
        const [w1, w2] = [await person('teacher'), await person('teacher')];
        const [c1, made] = await call(ctl.createHostel, { body: { name: 'ZZ Warden Hostel', code: 'ZZWH', gender: 'co_ed', warden: String(w1._id) } });
        assert.equal(c1, 200, JSON.stringify(made));
        const posts = () => HostelStaffAssignment.find({ school: S.id, hostel: made.data._id, role: 'warden' }).lean();
        assert.deepEqual((await posts()).map((p) => [String(p.staff), p.status]), [[String(w1._id), 'active']]);
        const [c2] = await call(ctl.updateHostel, { params: { id: String(made.data._id) }, body: { warden: String(w2._id) } });
        assert.equal(c2, 200);
        const now = Object.fromEntries((await posts()).map((p) => [String(p.staff), p.status]));
        assert.equal(now[String(w1._id)], 'inactive');
        assert.equal(now[String(w2._id)], 'active');
    });
    test('a hostel with residents cannot be closed through its edit form', async () => {
        const [code, out] = await call(ctl.updateHostel, { params: { id: String(H.h._id) }, body: { status: 'inactive' } });
        assert.equal(code, 400);
        assert.match(out.message, /resident/);
    });
    test('a bed on a floor under maintenance cannot be given out', async () => {
        const f2 = await HostelFloor.create({ school: S.id, hostel: H.h._id, building: H.b._id, name: 'First', floorNumber: 1, status: 'maintenance' });
        const r2 = await HostelRoom.create({ school: S.id, hostel: H.h._id, building: H.b._id, floor: f2._id, roomNumber: 'Z-2', code: 'ZRR2', capacity: 2, status: 'available', isActive: true });
        const bed = await HostelBed.create({ school: S.id, hostel: H.h._id, building: H.b._id, floor: f2._id, room: r2._id, bedNumber: '1', code: 'ZZF2', status: 'available', isActive: true });
        const u = await person('student');
        await assert.rejects(alloc.allocateBed({ schoolId: S.id, studentId: String(u._id), bedId: String(bed._id), academicYearId: YEAR }), /maintenance/);
    });
});

describe('visitors', () => {
    test('Block stops the next visit, and a name is matched whole', async () => {
        const { u } = await resident();
        const sid = String(u._id);
        const reg = (name, mobile = '') => call(ctl.createVisitor, { body: { student: sid, visitorName: name, mobile } });
        const [c1, v1] = await reg('Ramesh Kumar', '98765 43210');
        assert.equal(c1, 200, JSON.stringify(v1));
        const [cb] = await call(ctl.actOnVisitor, { params: { id: String(v1.data._id) }, body: { action: 'block' } });
        assert.equal(cb, 200);
        assert.equal((await reg('ramesh  kumar'))[0], 400, 'same name, however it is typed');
        assert.equal((await reg('R. Kumar', '+91 9876543210'))[0], 400, 'same phone under another name');
        assert.equal((await reg('Ram'))[0], 200, 'a different, shorter name is not caught');
    });
});

describe('the clock', () => {
    test('escalates a complaint past its SLA and marks an unpaid invoice overdue', async () => {
        const c = await HostelComplaint.create({ school: S.id, hostel: H.h._id, ticketNumber: 'ZC1', category: 'room', priority: 'medium',
            description: 'd', status: 'open', dueAt: day(-1) });
        const inv = await HostelFeeInvoice.create({ school: S.id, student: uid(), hostel: H.h._id, invoiceNumber: 'ZI1', amount: 100, dueDate: day(5) });
        await query('UPDATE "hostelfeeinvoices" SET "dueDate" = now() - interval \'3 days\' WHERE "_id" = $1', [String(inv._id)]);
        const r = await ctl.runSweep(S.id);
        assert.ok(r.escalated >= 1);
        const after1 = await HostelComplaint.findById(c._id).lean();
        assert.equal(after1.escalationLevel, 1);
        assert.equal(after1.priority, 'high');
        assert.equal((await HostelFeeInvoice.findById(inv._id).lean()).status, 'overdue');
    });
});

describe('every list screen answers', () => {
    test('each board runs for an admin, with a search, a hostel and a date range', async () => {
        for (const [name, fn] of Object.entries(boards._boards)) {
            for (const q of [{}, { search: "a'%_", page: 1, limit: 5 }, { hostel: String(H.h._id), from: '2026-01-01', to: '2026-12-31' }]) {
                await assert.doesNotReject(fn({ query: q, schoolId: S.id, userId: S.ctx.userId, userRole: 'school_admin' }, { school: S.id, allowed: null, q }), `${name} ${JSON.stringify(q)}`);
            }
        }
    });
});
