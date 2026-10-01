'use strict';
/**
 * Staff as hostel residents, and paying a hostel bill.
 *
 * What is worth guarding:
 *   · a bed is given only to the kind of resident it is kept for — and "who a
 *     person is" comes from their account, never from the request;
 *   · beds, plans and settings older than these fields (NULL) behave as they
 *     always did: students only, nobody bills a teacher;
 *   · a fee plan bills the residents it was written for, and a teacher only
 *     when the school charges its staff;
 *   · every payment gets its own receipt number;
 *   · an online payment is recorded only with a valid gateway signature, once,
 *     against the invoices its order was opened for, and only by its payer;
 *   · a receipt is shown to the resident it belongs to, not to another.
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
const HostelFeePlan = require('../models/HostelFeePlan');
const HostelFeeInvoice = require('../models/HostelFeeInvoice');
const HostelPaymentOrder = require('../models/HostelPaymentOrder');
const HostelSettings = require('../models/HostelSettings');
const ParentProfile = require('../models/ParentProfile');
const alloc = require('../services/hostelAllocation');
const pay = require('../services/hostelPayments');
const resident = require('../services/hostelResident');
const hostelCtl = require('../controllers/hostel.controller');
const payCtl = require('../controllers/hostelPayment.controller');
const { getSettings } = require('../services/hostelService');
const { query } = require('../db/pool');
const { makeSchool, teardown } = require('./helpers');

let S; let H; let student; let other; let teacher;
const uid = () => crypto.randomUUID();
const YEAR = uid();
const SECRET = 'zz-test-secret';

function call(handler, req) {
    return new Promise((resolve) => {
        let code = 200;
        const res = { status(c) { code = c; return this; }, json(p) { resolve([code, p]); }, setHeader() {}, send(p) { resolve([code, p]); } };
        handler({ params: {}, query: {}, body: {}, headers: {}, ip: '', protocol: 'http', get: () => 'localhost', ...req }, res);
    });
}
const as = (u, role) => ({ schoolId: S.id, userId: String(u._id), userRole: role });
const person = (name, role) => User.create({ school: S.id, name, role, email: `zz-${role}-${uid()}@test.invalid`, password: 'x', isActive: true });
const sign = (orderId, paymentId, secret = SECRET) => crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
const invoice = (who, amount, extra = {}) => HostelFeeInvoice.create({
    school: S.id, student: String(who._id), hostel: H.h._id, academicYear: YEAR, invoiceNumber: `ZZ-${uid().slice(0, 8)}`,
    feeType: 'monthly', amount, ...extra });

before(async () => {
    S = await makeSchool();
    const h = await Hostel.create({ school: S.id, name: 'ZZ Residents Hostel', code: 'ZZR', gender: 'co_ed', status: 'active', isActive: true });
    const b = await HostelBuilding.create({ school: S.id, hostel: h._id, name: 'Block R', code: 'BR' });
    const f = await HostelFloor.create({ school: S.id, hostel: h._id, building: b._id, name: 'Ground', floorNumber: 0 });
    const r = await HostelRoom.create({ school: S.id, hostel: h._id, building: b._id, floor: f._id, roomNumber: 'R-1', code: 'RR1', capacity: 4, status: 'available', isActive: true });
    const bed = (n, occupantType) => HostelBed.create({ school: S.id, hostel: h._id, building: b._id, floor: f._id, room: r._id,
        bedNumber: String(n), code: `ZZB${n}`, status: 'available', isActive: true, occupantType });
    H = { h, r, students: await bed(1, 'student'), teachers: await bed(2, 'teacher'), both: await bed(3, 'both'), old: await bed(4, 'student') };
    // A bed from before the field existed: the column is NULL, not 'student'.
    await query('UPDATE "hostelbeds" SET "occupantType" = NULL WHERE "_id" = $1', [String(H.old._id)]);
    [student, other, teacher] = await Promise.all([person('ZZ Student', 'student'), person('ZZ Other', 'student'), person('ZZ Teacher', 'teacher')]);
    await School.findByIdAndUpdate(S.id, { $set: {
        'paymentGateway.enabled': true, 'paymentGateway.provider': 'razorpay', 'paymentGateway.razorpayKeyId': 'rzp_test_zz',
        'paymentGateway.razorpayKeySecret': SECRET, 'paymentGateway.modules.hostel': true } });
});
after(async () => { await teardown(S?.id); });

describe('a bed is for students, for teachers, or for both', () => {
    const give = (who, bed) => alloc.allocateBed({ schoolId: S.id, studentId: String(who._id), bedId: String(bed._id), academicYearId: YEAR });

    test('a NULL occupant type reads as students-only', async () => {
        const row = await HostelBed.findById(H.old._id).lean();
        assert.equal(resident.occupantOf(row), 'student');
        assert.equal(resident.bedFits(row, 'teacher'), false);
        assert.equal(resident.bedFits(row, 'student'), true);
    });
    test('a teacher is refused a students\' bed, and a student a teachers\' bed', async () => {
        await assert.rejects(give(teacher, H.students), /kept for students/);
        await assert.rejects(give(teacher, H.old), /kept for students/);
        await assert.rejects(give(student, H.teachers), /kept for teachers/);
    });
    test('each gets a bed of their own kind, and the allocation records which they are', async () => {
        const t = await give(teacher, H.teachers);
        assert.equal(t.allocation.residentType, 'teacher');
        const s = await give(student, H.both);
        assert.equal(s.allocation.residentType, 'student');
        await assert.rejects(give(teacher, H.both), /already occupied/);
    });
    test('the best free bed for a teacher is never a students\' bed', async () => {
        const spare = await person('ZZ Teacher Two', 'teacher');
        // Only student beds are free now (1 and 4).
        assert.equal(await alloc.findBestBed({ schoolId: S.id, studentId: String(spare._id) }), null);
        const forStudent = await alloc.findBestBed({ schoolId: S.id, studentId: String(other._id) });
        assert.ok(['1', '4'].includes(forStudent.bedNumber));
    });
    test('a bed cannot be re-labelled out from under its occupant', async () => {
        const [code, out] = await call(hostelCtl.updateBed, { ...S.ctx, params: { id: String(H.teachers._id) }, body: { occupantType: 'student' } });
        assert.equal(code, 400, JSON.stringify(out));
        const [ok] = await call(hostelCtl.updateBed, { ...S.ctx, params: { id: String(H.teachers._id) }, body: { occupantType: 'both' } });
        assert.equal(ok, 200);
    });
});

describe('fee plans bill who they are written for', () => {
    const run = (plan, month) => call(hostelCtl.generateInvoices, { ...S.ctx, body: { feePlan: String(plan._id), year: 2031, month } });
    const billed = (who, plan) => HostelFeeInvoice.countDocuments({ school: S.id, student: String(who._id), feePlan: String(plan._id) });

    test('the hostel is free for teachers until the school says otherwise', async () => {
        const s = await getSettings(S.id);
        assert.equal(!!s.chargeTeachers, false);
        const plan = await HostelFeePlan.create({ school: S.id, name: 'ZZ Everyone', feeType: 'monthly', amount: 1000, appliesTo: 'both', hostel: H.h._id });
        const [code, out] = await run(plan, 1);
        assert.equal(code, 200, JSON.stringify(out));
        assert.equal(await billed(student, plan), 1);
        assert.equal(await billed(teacher, plan), 0);
        assert.match((out.data.skippedRows[0] || {}).reason || '', /free for teachers/);

        await HostelSettings.updateOne({ school: S.id }, { $set: { chargeTeachers: true } });
        await run(plan, 2);
        assert.equal(await billed(teacher, plan), 1);
        const inv = await HostelFeeInvoice.findOne({ school: S.id, student: String(teacher._id), feePlan: String(plan._id) }).lean();
        assert.equal(inv.residentType, 'teacher');
    });
    test('a plan from before the field existed (NULL) bills students only', async () => {
        const plan = await HostelFeePlan.create({ school: S.id, name: 'ZZ Old Plan', feeType: 'laundry', amount: 500, hostel: H.h._id });
        await query('UPDATE "hostelfeeplans" SET "appliesTo" = NULL WHERE "_id" = $1', [String(plan._id)]);
        await run(plan, 3);
        assert.equal(await billed(student, plan), 1);
        assert.equal(await billed(teacher, plan), 0);       // even though the school now charges teachers
    });
    test('a mess plan bills the residents who are enrolled in a mess, and nobody else', async () => {
        const HostelMess = require('../models/HostelMess');
        const HostelMessMember = require('../models/HostelMessMember');
        const mess = await HostelMess.create({ school: S.id, name: 'ZZ Mess', code: 'ZZM', isActive: true });
        const plan = await HostelFeePlan.create({ school: S.id, name: 'ZZ Mess Fee', feeType: 'mess', amount: 900, appliesTo: 'both', hostel: H.h._id });
        const [, first] = await run(plan, 5);
        assert.equal(await billed(student, plan), 0);
        assert.ok(first.data.skippedRows.some((r) => /Not enrolled in a mess/.test(r.reason)));
        const alloc0 = await HostelAllocation.findOne({ school: S.id, student: String(student._id), status: 'active' }).lean();
        await HostelMessMember.create({ school: S.id, mess: mess._id, student: String(student._id), hostel: alloc0.hostel, allocation: alloc0._id, status: 'active' });
        await run(plan, 5);
        assert.equal(await billed(student, plan), 1);
        assert.equal(await billed(teacher, plan), 0);
    });
    test('a teachers\' plan leaves students alone', async () => {
        const plan = await HostelFeePlan.create({ school: S.id, name: 'ZZ Staff Rent', feeType: 'monthly', amount: 2000, appliesTo: 'teacher', hostel: H.h._id });
        await run(plan, 4);
        assert.equal(await billed(teacher, plan), 1);
        assert.equal(await billed(student, plan), 0);
    });
});

describe('counter payments and receipts', () => {
    test('every payment gets its own receipt number', async () => {
        const [a, b] = [await invoice(student, 300), await invoice(other, 400)];
        const numbers = [];
        for (const [inv, amount] of [[a, 100], [b, 400], [a, 200]]) {
            const [code, out] = await call(hostelCtl.payInvoice, { ...S.ctx, params: { id: String(inv._id) }, body: { amount, mode: 'cash' } });
            assert.equal(code, 200, JSON.stringify(out));
            numbers.push(out.data.receiptNumber);
        }
        assert.equal(new Set(numbers).size, 3, numbers.join(', '));
        assert.equal((await HostelFeeInvoice.findById(a._id).lean()).status, 'paid');
    });
    test('the counter cannot record an "online" payment, and a cheque needs its number', async () => {
        const inv = await invoice(student, 250);
        const pay1 = (body) => call(hostelCtl.payInvoice, { ...S.ctx, params: { id: String(inv._id) }, body });
        assert.equal((await pay1({ amount: 250, mode: 'online', reference: 'pay_x' }))[0], 400);
        assert.equal((await pay1({ amount: 250, mode: 'cheque' }))[0], 400);
        assert.equal((await pay1({ amount: 999, mode: 'cash' }))[0], 400);          // more than is owed
        assert.equal((await pay1({ amount: 250, mode: 'cheque', reference: '004512' }))[0], 200);
    });
    test('a receipt is its owner\'s to read, not another resident\'s', async () => {
        const inv = await invoice(student, 120);
        const [, out] = await call(hostelCtl.payInvoice, { ...S.ctx, params: { id: String(inv._id) }, body: { amount: 120, mode: 'upi', reference: 'upi-1' } });
        const n = out.data.receiptNumber;
        const mine = await call(payCtl.getReceipt, { ...as(student, 'student'), params: { receiptNumber: n }, query: { format: 'json' } });
        assert.equal(mine[0], 200);
        assert.equal(mine[1].data.total, 120);
        assert.equal(mine[1].data.paymentMode, 'offline');
        const theirs = await call(payCtl.getReceipt, { ...as(other, 'student'), params: { receiptNumber: n }, query: { format: 'json' } });
        assert.equal(theirs[0], 404);
        const desk = await call(payCtl.getReceipt, { ...S.ctx, params: { receiptNumber: n }, query: {} });
        assert.equal(desk[0], 200);
        assert.match(String(desk[1]), /Hostel fee receipt/);
    });
});

describe('paying online', () => {
    const order = async (who, lines) => {
        const orderId = `order_${uid().slice(0, 12)}`;
        await HostelPaymentOrder.create({ school: S.id, student: String(who._id), openedBy: String(who._id), openedByRole: 'student', orderId,
            amount: lines.reduce((s, l) => s + l.amount, 0), lines: lines.map((l) => ({ invoice: String(l.invoice._id), invoiceNumber: l.invoice.invoiceNumber, amount: l.amount })) });
        return orderId;
    };
    const confirm = (who, role, orderId, paymentId, signature) => call(payCtl.confirmPayment, { ...as(who, role),
        body: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } });

    test('a forged signature records nothing', async () => {
        const inv = await invoice(student, 700);
        const orderId = await order(student, [{ invoice: inv, amount: 700 }]);
        const [code] = await confirm(student, 'student', orderId, 'pay_forged', sign(orderId, 'pay_forged', 'not-the-secret'));
        assert.equal(code, 400);
        assert.equal((await HostelFeeInvoice.findById(inv._id).lean()).paidAmount, 0);
    });
    test('one payment clears every invoice on its order under one receipt, once', async () => {
        const [a, b] = [await invoice(student, 700), await invoice(student, 300, { feeType: 'mess' })];
        const orderId = await order(student, [{ invoice: a, amount: 700 }, { invoice: b, amount: 300 }]);
        const sig = sign(orderId, 'pay_ok');
        const [code, out] = await confirm(student, 'student', orderId, 'pay_ok', sig);
        assert.equal(code, 200, JSON.stringify(out));
        assert.equal(out.data.amount, 1000);
        const [ra, rb] = [await HostelFeeInvoice.findById(a._id).lean(), await HostelFeeInvoice.findById(b._id).lean()];
        assert.equal(ra.status, 'paid'); assert.equal(rb.status, 'paid');
        assert.equal(ra.payments[0].receiptNumber, out.data.receiptNumber);
        assert.equal(rb.payments[0].receiptNumber, out.data.receiptNumber);
        assert.equal(ra.payments[0].mode, 'online');
        assert.equal(ra.payments[0].gatewayPaymentId, 'pay_ok');

        // The browser retries, or the user double-clicks: nothing is paid twice.
        const [again, second] = await confirm(student, 'student', orderId, 'pay_ok', sig);
        assert.equal(again, 200);
        assert.equal(second.data.alreadyRecorded, true);
        assert.equal(second.data.receiptNumber, out.data.receiptNumber);
        assert.equal((await HostelFeeInvoice.findById(a._id).lean()).payments.length, 1);

        const built = await pay.buildReceipt(S.id, out.data.receiptNumber, { students: [String(student._id)] });
        assert.equal(built.receipt.total, 1000);
        assert.equal(built.receipt.lines.length, 2);
        assert.equal(built.receipt.paymentMode, 'online');
    });
    test('an order cannot be confirmed from another account', async () => {
        const inv = await invoice(student, 150);
        const orderId = await order(student, [{ invoice: inv, amount: 150 }]);
        const [code] = await confirm(other, 'student', orderId, 'pay_other', sign(orderId, 'pay_other'));
        assert.equal(code, 404);
        assert.equal((await HostelFeeInvoice.findById(inv._id).lean()).paidAmount, 0);
    });
    test('money for an invoice settled at the counter meanwhile is flagged, not lost or double-counted', async () => {
        const inv = await invoice(student, 500);
        const orderId = await order(student, [{ invoice: inv, amount: 500 }]);
        await call(hostelCtl.payInvoice, { ...S.ctx, params: { id: String(inv._id) }, body: { amount: 500, mode: 'cash' } });
        const [code, out] = await confirm(student, 'student', orderId, 'pay_late', sign(orderId, 'pay_late'));
        assert.equal(code, 200, JSON.stringify(out));
        assert.equal(out.data.unapplied, 500);
        assert.equal((await HostelFeeInvoice.findById(inv._id).lean()).paidAmount, 500);
        assert.equal((await HostelPaymentOrder.findOne({ school: S.id, orderId }).lean()).unapplied, 500);
    });
    test('a teacher sees and pays their own bills; nobody reads another\'s', async () => {
        const mine = await call(payCtl.mySummary, as(teacher, 'teacher'));
        assert.equal(mine[0], 200);
        assert.equal(mine[1].data.resident.kind, 'teacher');
        assert.ok(mine[1].data.pending.length >= 1);
        assert.equal(mine[1].data.gateway.enabled, true);
        const snoop = await call(payCtl.mySummary, { ...as(other, 'student'), query: { student: String(student._id) } });
        assert.equal(snoop[0], 403);
    });
    test('a parent pays for their own child, and for no one else\'s', async () => {
        const parent = await person('ZZ Parent', 'parent');
        await ParentProfile.create({ school: S.id, user: String(parent._id), children: [String(student._id)] });
        const own = await call(payCtl.mySummary, { ...as(parent, 'parent'), query: { student: String(student._id) } });
        assert.equal(own[0], 200, JSON.stringify(own[1]));
        assert.equal(own[1].data.payingFor, String(student._id));
        const notMine = await call(payCtl.mySummary, { ...as(parent, 'parent'), query: { student: String(other._id) } });
        assert.equal(notMine[0], 403);

        // The parent's confirmation is recorded against the child, with the parent as payer.
        const inv = await invoice(student, 640);
        const orderId = `order_${uid().slice(0, 12)}`;
        await HostelPaymentOrder.create({ school: S.id, student: String(student._id), openedBy: String(parent._id), openedByRole: 'parent', orderId,
            amount: 640, lines: [{ invoice: String(inv._id), invoiceNumber: inv.invoiceNumber, amount: 640 }] });
        const [code, out] = await call(payCtl.confirmPayment, { ...as(parent, 'parent'),
            body: { student: String(student._id), razorpay_order_id: orderId, razorpay_payment_id: 'pay_parent', razorpay_signature: sign(orderId, 'pay_parent') } });
        assert.equal(code, 200, JSON.stringify(out));
        const paid = await HostelFeeInvoice.findById(inv._id).lean();
        assert.equal(paid.status, 'paid');
        assert.equal(String(paid.payments[0].paidBy), String(parent._id));
        const receipt = await call(payCtl.getReceipt, { ...as(parent, 'parent'), params: { receiptNumber: out.data.receiptNumber }, query: { format: 'json' } });
        assert.equal(receipt[0], 200);
    });
});
