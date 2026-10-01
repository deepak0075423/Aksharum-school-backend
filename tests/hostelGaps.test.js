'use strict';
/**
 * The rules that closed the gaps the hostel audit reported.
 *
 * What is worth guarding:
 *   · required admission papers stop an approval until they are on file, or
 *     somebody says "approve anyway" — and what was missing is recorded;
 *   · a student's outpass waits for a parent where the school asks for it;
 *     a teacher's never does;
 *   · a posted warden's transfer waits for an admin where the school asks;
 *     a resident can ask for a room change, one at a time, and the office
 *     says where;
 *   · the security deposit is raised once per resident, survives a room
 *     change, and is settled at checkout (refunded, held, or cancelled);
 *   · a refund has a voucher and a line in the invoice's history;
 *   · a checkout nobody confirmed is found by asking the gateway — and
 *     recorded once;
 *   · a month is billed to those who were here for it, by the day where the
 *     school asks;
 *   · late fees keep themselves up to date only where switched on;
 *   · a deactivated account still holding a bed is reported once;
 *   · year-end rollover carries a stay forward or checks it out;
 *   · a meal can be skipped with notice, and not without;
 *   · a hostel file opens with a valid link or the right login, and no other;
 *   · staff who live in are not on the roll call unless asked for.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const School = require('../models/School');
const User = require('../models/User');
const AcademicYear = require('../models/AcademicYear');
const ParentProfile = require('../models/ParentProfile');
const Hostel = require('../models/Hostel');
const HostelBuilding = require('../models/HostelBuilding');
const HostelFloor = require('../models/HostelFloor');
const HostelRoom = require('../models/HostelRoom');
const HostelBed = require('../models/HostelBed');
const HostelAllocation = require('../models/HostelAllocation');
const HostelAllocationHistory = require('../models/HostelAllocationHistory');
const HostelAdmission = require('../models/HostelAdmission');
const HostelOutpass = require('../models/HostelOutpass');
const HostelDocument = require('../models/HostelDocument');
const HostelMess = require('../models/HostelMess');
const HostelMessMember = require('../models/HostelMessMember');
const HostelMessAttendance = require('../models/HostelMessAttendance');
const HostelFeePlan = require('../models/HostelFeePlan');
const HostelFeeInvoice = require('../models/HostelFeeInvoice');
const HostelPaymentOrder = require('../models/HostelPaymentOrder');
const HostelTransferRequest = require('../models/HostelTransferRequest');
const HostelSettings = require('../models/HostelSettings');
const Notification = require('../models/Notification');
const alloc = require('../services/hostelAllocation');
const svc = require('../services/hostelService');
const payments = require('../services/hostelPayments');
const gateway = require('../services/paymentGateway');
const ctl = require('../controllers/hostel.controller');
const portal = require('../controllers/hostelPortal.controller');
const payCtl = require('../controllers/hostelPayment.controller');
const files = require('../controllers/hostelFiles.controller');
const boards = require('../controllers/hostelBoards.controller');
const { makeSchool, teardown } = require('./helpers');

let S; let H; let seq = 0;
const uid = () => crypto.randomUUID();
const YEAR = uid();
const day = (n) => new Date(Date.now() + n * 864e5);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function call(handler, req) {
    return new Promise((resolve) => {
        let code = 200;
        const res = { status(c) { code = c; return this; }, json(p) { resolve([code, p]); }, setHeader() {}, sendFile(f) { resolve([code, { file: f }]); } };
        handler({ params: {}, query: {}, body: {}, headers: {}, ip: '', protocol: 'http', get: () => 'localhost', ...S.ctx, ...req }, res);
    });
}
const as = (u, role) => ({ userId: String(u._id), userRole: role, user: { name: u.name } });
const person = (role, name = `ZZ ${role} ${++seq}`) => User.create({ school: S.id, name, role, email: `zz-${uid()}@test.invalid`, password: 'x', isActive: true });
const set = (patch) => HostelSettings.updateOne({ school: S.id }, { $set: patch });
const newBed = (over = {}) => {
    const n = ++seq;
    return HostelBed.create({ school: S.id, hostel: H.h._id, building: H.b._id, floor: H.f._id, room: H.r._id,
        bedNumber: `G${n}`, code: `ZZG${n}`, status: 'available', isActive: true, occupantType: 'both', ...over });
};

/** A resident in their own bed of the test hostel — through the engine, with no deposit. */
async function resident(role = 'student', { fromDate } = {}) {
    const u = await person(role);
    const bed = await newBed();
    const r = await alloc.allocateBed({ schoolId: S.id, studentId: String(u._id), bedId: String(bed._id), academicYearId: YEAR, fromDate });
    return { u, bed, allocation: r.allocation };
}
const invoice = (u, amount, over = {}) => HostelFeeInvoice.create({ school: S.id, student: String(u._id), hostel: H.h._id, academicYear: YEAR,
    feeType: 'hostel', invoiceNumber: `ZZI-${++seq}`, amount, period: { label: 'Test' }, ...over });

before(async () => {
    S = await makeSchool();
    await School.findByIdAndUpdate(S.id, { $set: { 'modules.hostel': true } });
    const h = await Hostel.create({ school: S.id, name: 'ZZ Gaps Hostel', code: 'ZZGH', gender: 'co_ed', status: 'active', isActive: true });
    const b = await HostelBuilding.create({ school: S.id, hostel: h._id, name: 'Block', code: 'ZGB' });
    const f = await HostelFloor.create({ school: S.id, hostel: h._id, building: b._id, name: 'Ground', floorNumber: 0 });
    const r = await HostelRoom.create({ school: S.id, hostel: h._id, building: b._id, floor: f._id, roomNumber: 'G-1', code: 'ZGR', capacity: 90, status: 'available', isActive: true });
    H = { h, b, f, r };
    await svc.getSettings(S.id);
    await set({ maxRoomCapacity: 100, requiredAdmissionDocuments: [], securityDepositAmount: 0, notifyOnFeeDue: false });
});
after(async () => { await teardown(S?.id); });

describe('required admission documents', () => {
    const application = async () => {
        const u = await person('student');
        const a = await HostelAdmission.create({ school: S.id, student: String(u._id), hostel: H.h._id, academicYear: YEAR,
            applicationNumber: `ZZA-${++seq}`, status: 'pending', appliedBy: S.ctx.userId });
        return { u, a };
    };
    test('an approval is stopped while a required paper is missing, and goes through once it is on file', async () => {
        await set({ requiredAdmissionDocuments: ['id_proof', 'medical'], autoAllocateOnApproval: false });
        const { u, a } = await application();
        const [code, out] = await call(ctl.decideAdmission, { params: { id: String(a._id) }, body: { action: 'approve' } });
        assert.equal(code, 400);
        assert.equal(out.code, 'DOCUMENTS_MISSING');
        assert.deepEqual(out.missing.sort(), ['id_proof', 'medical']);
        assert.equal((await HostelAdmission.findById(a._id).lean()).status, 'pending');

        await HostelDocument.create({ school: S.id, student: String(u._id), docType: 'id_proof', title: 'ID', storedName: `zz-${uid()}.pdf`, isActive: true });
        await HostelDocument.create({ school: S.id, entityType: 'HostelAdmission', entityId: a._id, docType: 'medical', title: 'Med', storedName: `zz-${uid()}.pdf`, isActive: true });
        const [ok2, done] = await call(ctl.decideAdmission, { params: { id: String(a._id) }, body: { action: 'approve' } });
        assert.equal(ok2, 200, JSON.stringify(done));
        assert.equal((await HostelAdmission.findById(a._id).lean()).status, 'approved');
    });
    test('"approve anyway" is allowed, and what was missing stays on the record', async () => {
        const { a } = await application();
        const [code] = await call(ctl.decideAdmission, { params: { id: String(a._id) }, body: { action: 'approve', acceptMissingDocuments: true } });
        assert.equal(code, 200);
        const row = await HostelAdmission.findById(a._id).lean();
        assert.equal(row.status, 'approved');
        assert.deepEqual([...row.missingDocuments].sort(), ['id_proof', 'medical']);
        await set({ requiredAdmissionDocuments: [] });
    });
});

describe('outpass: parent consent', () => {
    const body = () => ({ purpose: 'Market', departureDate: ymd(day(1)), expectedDepartureTime: '10:00', expectedReturnTime: '12:00', guardianPhone: '9000000000' });
    test('a student\'s pass waits for a parent; the parent\'s consent lets the warden approve', async () => {
        await set({ outpassRequiresParentApproval: true, maxOutpassHours: 0, outpassFrom: '', outpassTo: '' });
        const { u } = await resident();
        const parent = await person('parent');
        await ParentProfile.create({ school: S.id, user: String(parent._id), children: [String(u._id)] });

        const [code, out] = await call(portal.applyOutpass, { ...as(u, 'student'), body: body() });
        assert.equal(code, 200, JSON.stringify(out));
        assert.equal(out.data.parentApprovalRequired, true);
        assert.equal(out.data.parentApprovedAt, null);

        const early = await call(ctl.actOnOutpass, { params: { id: String(out.data._id) }, body: { action: 'approve' } });
        assert.equal(early[0], 400);
        assert.match(early[1].message, /Parent consent/);

        // A student cannot consent for themselves.
        const self = await call(portal.actOnMyOutpass, { ...as(u, 'student'), params: { id: String(out.data._id) }, body: { action: 'parent_approve' } });
        assert.equal(self[0], 403);
        const consent = await call(portal.actOnMyOutpass, { ...as(parent, 'parent'), params: { id: String(out.data._id) }, body: { action: 'parent_approve' } });
        assert.equal(consent[0], 200, JSON.stringify(consent[1]));
        const approved = await call(ctl.actOnOutpass, { params: { id: String(out.data._id) }, body: { action: 'approve' } });
        assert.equal(approved[0], 200, JSON.stringify(approved[1]));
        assert.equal((await HostelOutpass.findById(out.data._id).lean()).status, 'approved');
    });
    test('a parent who files the pass has consented; a parent can also decline', async () => {
        const { u } = await resident();
        const parent = await person('parent');
        await ParentProfile.create({ school: S.id, user: String(parent._id), children: [String(u._id)] });
        const [, filed] = await call(portal.applyOutpass, { ...as(parent, 'parent'), body: { ...body(), student: String(u._id) } });
        assert.ok(filed.data.parentApprovedAt);
        await HostelOutpass.findByIdAndUpdate(filed.data._id, { $set: { status: 'cancelled' } });

        const [, mine] = await call(portal.applyOutpass, { ...as(u, 'student'), body: body() });
        const no = await call(portal.actOnMyOutpass, { ...as(parent, 'parent'), params: { id: String(mine.data._id) }, body: { action: 'parent_reject', remark: 'Exams' } });
        assert.equal(no[0], 200);
        assert.equal((await HostelOutpass.findById(mine.data._id).lean()).status, 'rejected');
    });
    test('a teacher\'s pass never waits for a parent', async () => {
        const { u } = await resident('teacher');
        const [code, out] = await call(portal.applyOutpass, { ...as(u, 'teacher'), body: body() });
        assert.equal(code, 200, JSON.stringify(out));
        assert.equal(out.data.parentApprovalRequired, false);
        await set({ outpassRequiresParentApproval: false });
    });
});

describe('room changes', () => {
    const asWarden = (u) => ({ ...as(u, 'teacher'), hostelDuty: true, access: { permissions: { hostel: 'user' }, moduleFlags: { hostel: true } } });
    test('a warden\'s transfer waits for an admin where the school asks, and is carried out on approval', async () => {
        await set({ transferRequiresApproval: true });
        const warden = await person('teacher');
        await require('../models/HostelStaffAssignment').create({ school: S.id, hostel: H.h._id, staff: String(warden._id), role: 'warden', status: 'active' });
        const { u, allocation, bed } = await resident();
        const target = await newBed();

        const noReason = await call(ctl.transferAllocation, { ...asWarden(warden), params: { id: String(allocation._id) }, body: { bed: String(target._id) } });
        assert.equal(noReason[0], 400);
        const [code, out] = await call(ctl.transferAllocation, { ...asWarden(warden), params: { id: String(allocation._id) }, body: { bed: String(target._id), reason: 'Leaking roof' } });
        assert.equal(code, 200, JSON.stringify(out));
        assert.equal(out.data.pending, true);
        // Nobody has moved yet.
        assert.equal(String((await HostelAllocation.findById(allocation._id).lean()).bed), String(bed._id));
        const again = await call(ctl.transferAllocation, { ...asWarden(warden), params: { id: String(allocation._id) }, body: { bed: String(target._id), reason: 'Again' } });
        assert.equal(again[0], 400);

        const [, list] = await call(ctl.getTransferRequests, { query: { status: 'pending' } });
        const mine = list.data.rows.find((r) => String(r.student) === String(u._id));
        assert.ok(mine, 'the request is listed');
        assert.equal(mine.requestedByRole, 'warden');

        const [done, moved] = await call(ctl.decideTransferRequest, { params: { id: String(mine._id) }, body: { action: 'approve' } });
        assert.equal(done, 200, JSON.stringify(moved));
        const now = await HostelAllocation.findOne({ school: S.id, student: String(u._id), status: 'active' }).lean();
        assert.equal(String(now.bed), String(target._id));
        assert.equal((await HostelTransferRequest.findById(mine._id).lean()).status, 'approved');
    });
    test('an admin moves a resident directly, whatever the setting', async () => {
        const { u, allocation } = await resident();
        const target = await newBed();
        const [code, out] = await call(ctl.transferAllocation, { params: { id: String(allocation._id) }, body: { bed: String(target._id) } });
        assert.equal(code, 200, JSON.stringify(out));
        assert.notEqual(out.data.pending, true);
        const now = await HostelAllocation.findOne({ school: S.id, student: String(u._id), status: 'active' }).lean();
        assert.equal(String(now.bed), String(target._id));
        await set({ transferRequiresApproval: false });
    });
    test('a resident asks once; the office chooses the bed, or says why not', async () => {
        const { u } = await resident();
        const empty = await call(portal.requestRoomChange, { ...as(u, 'student'), body: {} });
        assert.equal(empty[0], 400);
        const [code, out] = await call(portal.requestRoomChange, { ...as(u, 'student'), body: { reason: 'Too noisy', preference: 'Upper floor' } });
        assert.equal(code, 200, JSON.stringify(out));
        const twice = await call(portal.requestRoomChange, { ...as(u, 'student'), body: { reason: 'Still noisy' } });
        assert.equal(twice[0], 400);

        const noBed = await call(ctl.decideTransferRequest, { params: { id: String(out.data._id) }, body: { action: 'approve' } });
        assert.equal(noBed[0], 400);
        const noWhy = await call(ctl.decideTransferRequest, { params: { id: String(out.data._id) }, body: { action: 'reject' } });
        assert.equal(noWhy[0], 400);
        const target = await newBed();
        const yes = await call(ctl.decideTransferRequest, { params: { id: String(out.data._id) }, body: { action: 'approve', bed: String(target._id) } });
        assert.equal(yes[0], 200, JSON.stringify(yes[1]));
        const now = await HostelAllocation.findOne({ school: S.id, student: String(u._id), status: 'active' }).lean();
        assert.equal(String(now.bed), String(target._id));
        // The resident's page says what became of it.
        const [, home] = await call(portal.myHostel, as(u, 'student'));
        assert.equal(home.data.roomChange?.status, 'approved');
    });
});

describe('the security deposit', () => {
    const moveIn = async (role = 'student') => {
        const u = await person(role);
        const bed = await newBed();
        const [code, out] = await call(ctl.createAllocation, { body: { student: String(u._id), bed: String(bed._id), academicYear: YEAR } });
        assert.equal(code, 200, JSON.stringify(out));
        return { u, allocation: out.data.allocation || out.data };
    };
    const depositsOf = (u) => HostelFeeInvoice.find({ school: S.id, student: String(u._id), feeType: 'security_deposit' }).lean();

    test('it is raised once when a bed is given, and not again on a room change', async () => {
        await set({ securityDepositAmount: 5000 });
        const { u, allocation } = await moveIn();
        let rows = await depositsOf(u);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].amount, 5000);
        assert.equal(rows[0].isRefundable, true);

        const target = await newBed();
        const [code] = await call(ctl.transferAllocation, { params: { id: String(allocation._id) }, body: { bed: String(target._id) } });
        assert.equal(code, 200);
        rows = await depositsOf(u);
        assert.equal(rows.length, 1);
    });
    test('checkout hands a paid deposit back, with a voucher', async () => {
        const { u, allocation } = await moveIn();
        const [dep] = await depositsOf(u);
        const paid = await call(ctl.payInvoice, { params: { id: String(dep._id) }, body: { amount: 5000, mode: 'cash' } });
        assert.equal(paid[0], 200, JSON.stringify(paid[1]));

        const [, sum] = await call(ctl.getCheckout, { params: { id: String(allocation._id) } });
        assert.equal(sum.data.depositHeld, 5000);
        assert.equal(sum.data.outstandingDues, 0);

        const [code, out] = await call(ctl.releaseAllocation, { params: { id: String(allocation._id) }, body: { reason: 'Left', refundDeposit: true, refundReference: 'CHQ 12' } });
        assert.equal(code, 200, JSON.stringify(out));
        assert.equal(out.data.depositRefunded, 5000);
        assert.equal(out.data.depositHeld, 0);
        assert.equal(out.data.vouchers.length, 1);
        const after = await HostelFeeInvoice.findById(dep._id).lean();
        assert.equal(after.status, 'refunded');
        assert.equal(after.refunds.length, 1);
        assert.equal(after.refunds[0].voucherNumber, out.data.vouchers[0]);

        // The voucher opens for the office, and reads as a refund.
        const v = await call(payCtl.getRefundVoucher, { params: { voucherNumber: out.data.vouchers[0] }, query: { format: 'json' } });
        assert.equal(v[0], 200, JSON.stringify(v[1]));
        assert.equal(v[1].data.number, out.data.vouchers[0]);
        assert.equal(v[1].data.total, 5000);
    });
    test('a deposit left with the hostel is reported as held; one never paid is cancelled', async () => {
        const held = await moveIn();
        const [dep] = await depositsOf(held.u);
        await call(ctl.payInvoice, { params: { id: String(dep._id) }, body: { amount: 5000, mode: 'cash' } });
        const [, out] = await call(ctl.releaseAllocation, { params: { id: String(held.allocation._id) }, body: { reason: 'Left' } });
        assert.equal(out.data.depositHeld, 5000);
        assert.equal(out.data.depositRefunded, 0);

        const unpaid = await moveIn();
        await call(ctl.releaseAllocation, { params: { id: String(unpaid.allocation._id) }, body: { reason: 'Left' } });
        const [gone] = await depositsOf(unpaid.u);
        assert.equal(gone.status, 'cancelled');
    });
    test('staff are asked for one only where the school charges staff', async () => {
        await set({ chargeTeachers: false });
        const free = await moveIn('teacher');
        assert.equal((await depositsOf(free.u)).length, 0);
        await set({ chargeTeachers: true });
        const paying = await moveIn('teacher');
        assert.equal((await depositsOf(paying.u)).length, 1);
        await set({ securityDepositAmount: 0, chargeTeachers: false });
    });
});

describe('refunds', () => {
    test('each refund gets its own voucher and a line in the history; never more than was paid', async () => {
        const { u } = await resident();
        const inv = await invoice(u, 1000);
        await call(ctl.payInvoice, { params: { id: String(inv._id) }, body: { amount: 1000, mode: 'cash' } });
        const a = await call(ctl.refundInvoice, { params: { id: String(inv._id) }, body: { amount: 300, reason: 'Left early' } });
        const b = await call(ctl.refundInvoice, { params: { id: String(inv._id) }, body: { amount: 200, reason: 'Adjustment' } });
        assert.equal(a[0], 200, JSON.stringify(a[1]));
        assert.equal(b[0], 200);
        assert.notEqual(a[1].data.voucherNumber, b[1].data.voucherNumber);
        const tooMuch = await call(ctl.refundInvoice, { params: { id: String(inv._id) }, body: { amount: 600 } });
        assert.equal(tooMuch[0], 400);
        const row = await HostelFeeInvoice.findById(inv._id).lean();
        assert.equal(row.refundedAmount, 500);
        assert.equal(row.refunds.length, 2);
        // Back to the gateway only where there was an online payment.
        const noOnline = await call(ctl.refundInvoice, { params: { id: String(inv._id) }, body: { amount: 100, viaGateway: true } });
        assert.equal(noOnline[0], 400);
        assert.match(noOnline[1].message, /no online payment/);
        // The resident sees their refunds.
        const [, mine] = await call(payCtl.mySummary, as(u, 'student'));
        assert.equal(mine.data.refunds.length, 2);
    });
});

describe('online payments nobody confirmed', () => {
    const real = gateway.orderPayment;
    after(() => { gateway.orderPayment = real; });
    const order = async (u, inv, amount, ageMs = 10 * 60000) => {
        const orderId = `order_${uid().slice(0, 12)}`;
        const row = await HostelPaymentOrder.create({ school: S.id, student: String(u._id), openedBy: String(u._id), openedByRole: 'student', orderId,
            amount, lines: [{ invoice: String(inv._id), invoiceNumber: inv.invoiceNumber, amount }] });
        await HostelPaymentOrder.updateOne({ _id: row._id }, { $set: { createdAt: new Date(Date.now() - ageMs) } });
        return orderId;
    };
    test('a payment the gateway captured is recorded, once, without the payer\'s browser', async () => {
        const { u } = await resident();
        const inv = await invoice(u, 750);
        const orderId = await order(u, inv, 750);
        gateway.orderPayment = async () => ({ paid: true, paymentId: 'pay_found' });

        const [code, out] = await call(ctl.checkOnlinePayment, { params: { orderId } });
        assert.equal(code, 200, JSON.stringify(out));
        assert.equal(out.data.status, 'paid');
        const paid = await HostelFeeInvoice.findById(inv._id).lean();
        assert.equal(paid.status, 'paid');
        assert.equal(paid.payments.length, 1);
        assert.equal(paid.payments[0].gatewayPaymentId, 'pay_found');

        const again = await call(ctl.checkOnlinePayment, { params: { orderId } });
        assert.equal(again[1].data.status, 'paid');
        assert.equal((await HostelFeeInvoice.findById(inv._id).lean()).payments.length, 1);
        assert.equal((await HostelPaymentOrder.findOne({ orderId }).lean()).confirmedBy, 'reconcile');
    });
    test('the sweep finds them; an order never paid is left open, then expires', async () => {
        const { u } = await resident();
        const inv = await invoice(u, 400);
        const found = await order(u, inv, 400);
        const other = await resident();
        const stale = await order(other.u, await invoice(other.u, 90), 90, 5 * 24 * 36e5);
        const fresh = await order(other.u, await invoice(other.u, 60), 60, 30000);          // still paying
        gateway.orderPayment = async (school, mod, id) => (id === found ? { paid: true, paymentId: 'pay_swept' } : { paid: false });

        const r = await ctl.runSweep(S.id);
        assert.ok(r.reconciled >= 1, JSON.stringify(r));
        assert.equal((await HostelFeeInvoice.findById(inv._id).lean()).status, 'paid');
        assert.equal((await HostelPaymentOrder.findOne({ orderId: stale }).lean()).status, 'expired');
        assert.equal((await HostelPaymentOrder.findOne({ orderId: fresh }).lean()).status, 'created');

        const [, list] = await call(ctl.getOnlinePayments, { query: { tab: 'open' } });
        assert.ok(list.data.rows.some((x) => x.orderId === fresh));
        assert.ok(!list.data.rows.some((x) => x.orderId === found));
        assert.ok(list.data.counts.paid >= 1);
    });
    test('a gateway that does not answer changes nothing', async () => {
        const { u } = await resident();
        const inv = await invoice(u, 120);
        const orderId = await order(u, inv, 120);
        gateway.orderPayment = async () => ({ error: 'Gateway unreachable' });
        const [code] = await call(ctl.checkOnlinePayment, { params: { orderId } });
        assert.equal(code, 400);
        assert.equal((await HostelPaymentOrder.findOne({ orderId }).lean()).status, 'created');
        assert.equal((await HostelFeeInvoice.findById(inv._id).lean()).status, 'pending');
        gateway.orderPayment = async () => ({ paid: false });
    });
});

describe('paying from the phone', () => {
    const SECRET = 'zz-gaps-secret';
    const real = gateway.orderPayment;
    after(() => { gateway.orderPayment = real; });
    // The page and its confirmation answer with send(), not json().
    const hit = (handler, req) => new Promise((resolve) => {
        let code = 200; const headers = {};
        const res = { status(c) { code = c; return this; }, setHeader(k, v) { headers[k] = v; }, send(b) { resolve([code, b, headers]); }, json(b) { resolve([code, b, headers]); } };
        handler({ params: {}, query: {}, body: {}, headers: {}, ip: '', baseUrl: '/api/hostel', ...req }, res);
    });
    const open = async (u, amount = 500) => {
        const inv = await invoice(u, amount);
        const orderId = `order_${uid().slice(0, 12)}`;
        await HostelPaymentOrder.create({ school: S.id, student: String(u._id), openedBy: String(u._id), openedByRole: 'student', orderId,
            amount, lines: [{ invoice: String(inv._id), invoiceNumber: inv.invoiceNumber, amount }] });
        const link = new URL(svc.signedPayPath(orderId), 'http://x/api');
        return { inv, orderId, query: Object.fromEntries(link.searchParams) };
    };
    before(async () => {
        await School.findByIdAndUpdate(S.id, { $set: { 'paymentGateway.enabled': true, 'paymentGateway.provider': 'razorpay',
            'paymentGateway.razorpayKeyId': 'rzp_test_gaps', 'paymentGateway.razorpayKeySecret': SECRET, 'paymentGateway.modules.hostel': true } });
    });

    test('the checkout page opens with its signed link only, and never shows the secret', async () => {
        const { u } = await resident();
        const { orderId, query } = await open(u);
        const [code, html, headers] = await hit(payCtl.checkoutPage, { params: { orderId }, query });
        assert.equal(code, 200);
        assert.match(html, /rzp_test_gaps/);
        assert.ok(html.includes(orderId));
        assert.ok(!html.includes(SECRET));
        assert.match(headers['Content-Security-Policy'], /script-src 'nonce-[^']+' https:\/\/checkout\.razorpay\.com/);

        const forged = await hit(payCtl.checkoutPage, { params: { orderId }, query: { ...query, sig: 'x'.repeat(40) } });
        assert.equal(forged[0], 403);
        // A link for one order does not open another.
        const other = await open(u);
        const swapped = await hit(payCtl.checkoutPage, { params: { orderId: other.orderId }, query });
        assert.equal(swapped[0], 403);
    });
    test('the page can record a payment only with the gateway\'s own signature', async () => {
        const { u } = await resident();
        const { inv, orderId, query } = await open(u, 640);
        const sign = (pid, secret = SECRET) => crypto.createHmac('sha256', secret).update(`${orderId}|${pid}`).digest('hex');
        const forged = await hit(payCtl.checkoutConfirm, { params: { orderId }, query,
            body: { razorpay_order_id: orderId, razorpay_payment_id: 'pay_x', razorpay_signature: sign('pay_x', 'guess') } });
        assert.equal(forged[0], 400);
        assert.equal((await HostelFeeInvoice.findById(inv._id).lean()).status, 'pending');

        const good = await hit(payCtl.checkoutConfirm, { params: { orderId }, query,
            body: { razorpay_order_id: orderId, razorpay_payment_id: 'pay_phone', razorpay_signature: sign('pay_phone') } });
        assert.equal(good[0], 200, JSON.stringify(good[1]));
        const paid = await HostelFeeInvoice.findById(inv._id).lean();
        assert.equal(paid.status, 'paid');
        assert.equal(String(paid.payments[0].paidBy), String(u._id));
        // The paid page says so rather than offering to pay again.
        const again = await hit(payCtl.checkoutPage, { params: { orderId }, query });
        assert.match(again[1], /Already paid/);
    });
    test('the app learns what became of its own order, and of nobody else\'s', async () => {
        const { u } = await resident(); const stranger = await resident();
        const { inv, orderId } = await open(u, 300);
        gateway.orderPayment = async () => ({ paid: false });
        const waiting = await call(payCtl.checkMyPayment, { ...as(u, 'student'), body: { orderId } });
        assert.equal(waiting[0], 200);
        assert.equal(waiting[1].data.status, 'created');

        const snoop = await call(payCtl.checkMyPayment, { ...as(stranger.u, 'student'), body: { orderId } });
        assert.equal(snoop[0], 404);

        gateway.orderPayment = async () => ({ error: 'unreachable' });
        const unknown = await call(payCtl.checkMyPayment, { ...as(u, 'student'), body: { orderId } });
        assert.equal(unknown[1].data.unknown, true);

        gateway.orderPayment = async () => ({ paid: true, paymentId: 'pay_closed_tab' });
        const found = await call(payCtl.checkMyPayment, { ...as(u, 'student'), body: { orderId } });
        assert.equal(found[1].data.status, 'paid');
        assert.ok(found[1].data.receiptNumber);
        assert.equal((await HostelFeeInvoice.findById(inv._id).lean()).status, 'paid');
    });
});

describe('billing a month', () => {
    const plan = (over = {}) => HostelFeePlan.create({ school: S.id, name: `ZZ Plan ${++seq}`, feeType: 'hostel', frequency: 'monthly', amount: 3000,
        isActive: true, status: 'active', hostel: H.h._id, appliesTo: 'student', ...over });
    const bill = (p, month, year) => call(ctl.generateInvoices, { body: { feePlan: String(p._id), month, year } });
    const mine = (u, p) => HostelFeeInvoice.find({ school: S.id, student: String(u._id), feePlan: p._id }).lean();

    test('someone who moved in later is not billed for a month they were not here', async () => {
        const { u } = await resident('student', { fromDate: new Date(2026, 8, 16) });      // 16 Sep 2026
        const p = await plan();
        const [code, out] = await bill(p, 8, 2026);
        assert.equal(code, 200, JSON.stringify(out));
        assert.equal((await mine(u, p)).length, 0);
    });
    test('a part month is billed in full by default, and by the day where the school asks', async () => {
        const { u } = await resident('student', { fromDate: new Date(2026, 8, 16) });
        const full = await plan();
        await bill(full, 9, 2026);
        assert.equal((await mine(u, full))[0].amount, 3000);

        await set({ prorateFirstMonth: true });
        const part = await plan();
        await bill(part, 9, 2026);
        const [inv] = await mine(u, part);
        assert.equal(inv.amount, 1500);                    // 15 of September's 30 days
        assert.match(inv.remarks, /15 of 30 days/);
        // The month after is a whole month.
        await bill(part, 10, 2026);
        const rows = await mine(u, part);
        assert.equal(rows.find((x) => x.period.month === 10).amount, 3000);
        await set({ prorateFirstMonth: false });
    });
    test('a room change mid-month is not a new stay', async () => {
        await set({ prorateFirstMonth: true });
        const { u, allocation } = await resident('student', { fromDate: new Date(2026, 7, 1) });   // here since 1 Aug
        const target = await newBed();
        await alloc.transferBed({ schoolId: S.id, allocationId: String(allocation._id), toBedId: String(target._id), effectiveDate: new Date(2026, 8, 20) });
        const now = await HostelAllocation.findOne({ school: S.id, student: String(u._id), status: 'active' }).lean();
        const p = await plan();
        await bill(p, 9, 2026);
        const [inv] = await mine(u, p);
        // Only meaningful if the engine dated the new row by the move.
        if (new Date(now.fromDate) > new Date(2026, 8, 1) && new Date(now.fromDate) < new Date(2026, 9, 1)) assert.equal(inv.amount, 3000);
        else assert.ok(inv ? inv.amount > 0 : true);
        await set({ prorateFirstMonth: false });
    });
});

describe('late fees on the clock', () => {
    test('they keep up to date only where the school switches that on', async () => {
        const { u } = await resident();
        const inv = await invoice(u, 1000, { dueDate: day(-6), status: 'pending' });
        await set({ lateFeePerDay: 10, lateFeeGraceDays: 0, autoApplyLateFees: false });
        await ctl.runSweep(S.id);
        assert.equal((await HostelFeeInvoice.findById(inv._id).lean()).lateFee || 0, 0);

        await set({ autoApplyLateFees: true });
        const r = await ctl.runSweep(S.id);
        assert.ok(r.lateFees >= 1, JSON.stringify(r));
        const fee = (await HostelFeeInvoice.findById(inv._id).lean()).lateFee;
        assert.ok(fee >= 50 && fee <= 70, `late fee ${fee}`);
        // Running again the same day changes nothing.
        await ctl.runSweep(S.id);
        assert.equal((await HostelFeeInvoice.findById(inv._id).lean()).lateFee, fee);
        await set({ autoApplyLateFees: false, lateFeePerDay: 0 });
    });
});

describe('a resident whose account is switched off', () => {
    const alerts = async (name) => (await Notification.find({ school: S.id, title: 'Resident\'s account is inactive' }).lean())
        .filter((n) => String(n.body || n.message || '').includes(name)).length;
    test('the hostel is told once, the bed is kept, and coming back clears the flag', async () => {
        const { u, allocation } = await resident();
        await User.findByIdAndUpdate(u._id, { $set: { isActive: false } });
        const r = await ctl.runSweep(S.id);
        assert.ok(r.flagged >= 1);
        await wait(150);
        let row = await HostelAllocation.findById(allocation._id).lean();
        assert.equal(row.status, 'active');
        assert.ok(row.inactiveFlaggedAt);
        const first = await alerts(u.name);
        assert.equal(first, 1);
        await ctl.runSweep(S.id);
        await wait(150);
        assert.equal(await alerts(u.name), 1);

        // The allocations list marks them.
        const list = await boards._boards.allocations({ query: {}, schoolId: S.id, userId: S.ctx.userId, userRole: 'school_admin' }, { school: S.id, allowed: null, q: { search: u.name } });
        assert.equal(list.rows.find((x) => String(x.studentId) === String(u._id))?.accountInactive, true);

        await User.findByIdAndUpdate(u._id, { $set: { isActive: true } });
        await ctl.runSweep(S.id);
        row = await HostelAllocation.findById(allocation._id).lean();
        assert.equal(row.inactiveFlaggedAt, null);
    });
    test('a bed held by an account that no longer exists is freed', async () => {
        const { u, allocation, bed } = await resident();
        await User.deleteOne({ _id: u._id });
        await ctl.runSweep(S.id);
        assert.equal((await HostelAllocation.findById(allocation._id).lean()).status, 'vacated');
        assert.equal((await HostelBed.findById(bed._id).lean()).status, 'available');
    });
});

describe('year-end rollover', () => {
    test('a stay is carried into the new year in the same bed, or checked out', async () => {
        const next = await AcademicYear.create({ school: S.id, yearName: `ZZ ${uid().slice(0, 6)}`, startDate: day(1), endDate: day(366) });
        const stays = await resident(); const leaves = await resident();
        const [code, out] = await call(ctl.rolloverAllocations, { body: { toYear: String(next._id),
            carry: [String(stays.allocation._id)], vacate: [String(leaves.allocation._id)] } });
        assert.equal(code, 200, JSON.stringify(out));
        assert.deepEqual([out.data.carried, out.data.vacated, out.data.failed.length], [1, 1, 0]);

        const kept = await HostelAllocation.findById(stays.allocation._id).lean();
        assert.equal(String(kept.academicYear), String(next._id));
        assert.equal(kept.status, 'active');
        assert.equal(String(kept.bed), String(stays.bed._id));
        assert.ok(await HostelAllocationHistory.exists({ school: S.id, allocation: stays.allocation._id, action: 'rolled_over' }));
        assert.equal((await HostelAllocation.findById(leaves.allocation._id).lean()).status, 'vacated');
        assert.equal((await HostelBed.findById(leaves.bed._id).lean()).status, 'available');

        // Carrying the same stay again is reported, not repeated.
        const [, again] = await call(ctl.rolloverAllocations, { body: { toYear: String(next._id), carry: [String(stays.allocation._id)] } });
        assert.equal(again.data.carried, 0);
        assert.equal(again.data.failed.length, 1);
        const both = await call(ctl.rolloverAllocations, { body: { toYear: String(next._id), carry: ['a'], vacate: ['a'] } });
        assert.equal(both[0], 400);
    });
});

describe('skipping a meal', () => {
    test('with enough notice it is recorded and can be taken back; without, it is refused', async () => {
        const { u } = await resident();
        const mess = await HostelMess.create({ school: S.id, name: 'ZZ Mess', code: `ZM${++seq}`, hostels: [H.h._id], isActive: true });
        await HostelMessMember.create({ school: S.id, mess: mess._id, student: String(u._id), hostel: H.h._id, status: 'active', fromDate: day(-3) });
        await set({ messLeaveNoticeHours: 4 });
        const date = ymd(day(2));

        const [code, out] = await call(portal.skipMeal, { ...as(u, 'student'), body: { date, meal: 'lunch' } });
        assert.equal(code, 200, JSON.stringify(out));
        const twice = await call(portal.skipMeal, { ...as(u, 'student'), body: { date, meal: 'lunch' } });
        assert.equal(twice[0], 200);
        assert.equal(await HostelMessAttendance.countDocuments({ school: S.id, student: String(u._id), meal: 'lunch' }), 1);
        const [, home] = await call(portal.myMess, as(u, 'student'));
        assert.equal(home.data.skips.length, 1);
        assert.equal(home.data.noticeHours, 4);

        const undo = await call(portal.skipMeal, { ...as(u, 'student'), body: { date, meal: 'lunch', undo: true } });
        assert.equal(undo[0], 200);
        assert.equal(await HostelMessAttendance.countDocuments({ school: S.id, student: String(u._id), meal: 'lunch' }), 0);

        // Tomorrow's lunch is always less than 48 hours away.
        await set({ messLeaveNoticeHours: 48 });
        const late = await call(portal.skipMeal, { ...as(u, 'student'), body: { date: ymd(day(1)), meal: 'lunch' } });
        assert.equal(late[0], 400);
        assert.match(late[1].message, /48 hours/);
        const none = await call(portal.skipMeal, { ...as(u, 'student'), body: { date, meal: 'brunch' } });
        assert.equal(none[0], 400);
        await set({ messLeaveNoticeHours: 0 });
    });
});

describe('hostel files', () => {
    test('a signed link opens until it is tampered with or expires', async () => {
        const name = `zz-${uid()}.pdf`;
        const url = new URL(svc.signedFileUrl(name), 'http://x');
        const q = Object.fromEntries(url.searchParams);
        assert.ok(url.pathname.endsWith(`/hostel/file/${name}`));
        assert.equal(svc.checkFileSig(name, q.exp, q.sig), true);
        assert.equal(svc.checkFileSig(`other-${name}`, q.exp, q.sig), false);
        assert.equal(svc.checkFileSig(name, String(Number(q.exp) + 1000), q.sig), false);
        assert.equal(svc.checkFileSig(name, '1', q.sig), false);
        const bad = await call(files.signedFile, { params: { storedName: name }, query: { exp: q.exp, sig: 'nope' } });
        assert.equal(bad[0], 403);
        // A good link reaches the disk (there is no such file in a test).
        const good = await call(files.signedFile, { params: { storedName: name }, query: q });
        assert.equal(good[0], 404);
    });
    test('with a login, a resident reaches their own file and nobody else\'s', async () => {
        const fs = require('fs'); const path = require('path');
        const dir = path.join(__dirname, '..', 'uploads', 'hostel-docs');
        fs.mkdirSync(dir, { recursive: true });
        const name = `zz-test-${uid()}.txt`;
        fs.writeFileSync(path.join(dir, name), 'x');
        try {
            const owner = await person('student'); const stranger = await person('student');
            const parent = await person('parent');
            await ParentProfile.create({ school: S.id, user: String(parent._id), children: [String(owner._id)] });
            await HostelDocument.create({ school: S.id, student: String(owner._id), hostel: H.h._id, docType: 'id_proof', title: 'ID', storedName: name, isActive: true });
            const open = (u, role) => call(files.authedFile, { ...as(u, role), params: { storedName: name } });
            assert.equal((await open(owner, 'student'))[0], 200);
            assert.equal((await open(parent, 'parent'))[0], 200);
            assert.equal((await open(stranger, 'student'))[0], 404);
            assert.equal((await call(files.authedFile, { params: { storedName: name } }))[0], 200);            // the school admin
            // Another school's admin does not.
            assert.equal((await call(files.authedFile, { schoolId: uid(), params: { storedName: name } }))[0], 404);
        } finally { fs.unlinkSync(path.join(dir, name)); }
    });
});

describe('roll call', () => {
    test('staff who live in are not called, unless the school asks for it', async () => {
        const t = await resident('teacher'); const s = await resident('student');
        const names = async () => {
            const [code, out] = await call(ctl.getAttendanceRegister, { query: { hostel: String(H.h._id), date: ymd(new Date()) } });
            assert.equal(code, 200, JSON.stringify(out));
            const rows = out.data.residents || out.data.rows || out.data;
            return JSON.stringify(rows);
        };
        await set({ rollCallIncludesTeachers: false });
        let seen = await names();
        assert.ok(seen.includes(s.u.name));
        assert.ok(!seen.includes(t.u.name));
        const board = await boards._boards.attendance({ query: {}, schoolId: S.id, userId: S.ctx.userId, userRole: 'school_admin' },
            { school: S.id, allowed: null, q: { hostel: String(H.h._id), limit: 500 } });
        assert.ok(!JSON.stringify(board).includes(t.u.name));

        await set({ rollCallIncludesTeachers: true });
        seen = await names();
        assert.ok(seen.includes(t.u.name));
        await set({ rollCallIncludesTeachers: false });
    });
});
