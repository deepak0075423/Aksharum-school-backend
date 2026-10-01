'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Hostel fee payments — the one place money is put against an invoice.
//
//  Two doors lead here and both end in settle():
//    · the counter: a cashier records cash, a cheque, UPI, a card or a transfer
//      against one invoice (hostel.controller payInvoice);
//    · the gateway: the resident — or a parent for their child — pays one or
//      more invoices online, in two steps (openOrder, then confirmOrder once
//      the gateway signature checks out).
//
//  Either way one payment produces ONE receipt number, however many invoices it
//  cleared, and that number comes from a counter that cannot repeat.
//
//  Nothing here trusts an amount from the client: an online order is priced
//  from the invoices in the database, remembered on a HostelPaymentOrder row,
//  and applied from that row — not from the request that confirms it.
// ─────────────────────────────────────────────────────────────────────────────
const HostelFeeInvoice   = require('../models/HostelFeeInvoice');
const HostelPaymentOrder = require('../models/HostelPaymentOrder');
const HostelAllocation   = require('../models/HostelAllocation');
const User               = require('../models/User');
const StudentProfile     = require('../models/StudentProfile');
const TeacherProfile     = require('../models/TeacherProfile');

const pool = require('../db/pool');
const { withTransaction, lock } = require('./dbTx');
const paymentGateway = require('./paymentGateway');
const { getSettings, nextReceiptNumber, nextNumber, postToLedger, logAudit,
        notifyStudentAndParents, notifyHostelStaff } = require('./hostelService');

/** Invoices that still take money. */
const PAYABLE = ['pending', 'partial', 'overdue'];
/** What a cashier may record. 'online' is the gateway's alone. */
const OFFLINE_MODES = ['cash', 'cheque', 'upi', 'card', 'bank_transfer'];
const MODE_LABEL = { cash: 'Cash', cheque: 'Cheque', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer', online: 'Online' };

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const words = (v) => String(v || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const rupees = (n) => `₹${round2(n).toLocaleString('en-IN')}`;

/** What is still owed on an invoice. */
const outstandingOf = (inv) => (inv && !['cancelled', 'refunded'].includes(inv.status)
    ? Math.max(0, round2((inv.netAmount || 0) - (inv.paidAmount || 0))) : 0);

/** "Monthly — Oct 2026 (HF-2610-0031)": what a line on a bill or receipt says. */
const feeLabel = (inv) => `${words(inv.feeType)}${inv.period?.label ? ` — ${inv.period.label}` : ''} (${inv.invoiceNumber})`;

/** A failure the caller should show as it is (a 400, not a 500). */
class PaymentError extends Error {
    constructor(message, status = 400) { super(message); this.name = 'PaymentError'; this.status = status; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The writer
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Put money against invoices under one receipt.
 * @param {object} req      for the school, the actor and the audit trail
 * @param {Array<{invoice: object, amount: number}>} lines  invoice DOCUMENTS (not lean)
 * @returns {Promise<{receiptNumber: string, total: number, paidAt: Date}>}
 */
async function settle(req, { lines, mode, reference = '', note = '', receivedBy = null, paidBy = null, gatewayOrderId = '', gatewayPaymentId = '' }) {
    if (!lines.length) throw new PaymentError('There is nothing to pay');
    const settings = await getSettings(req.schoolId);
    const receiptNumber = await nextReceiptNumber(req.schoolId);
    const paidAt = new Date();
    let total = 0;

    for (const { invoice: inv, amount } of lines) {
        const paid = round2(amount);
        const before = inv.paidAmount || 0;
        inv.payments = [...(inv.payments || []), {
            amount: paid, mode, reference, receiptNumber, paidAt, receivedBy, paidBy, gatewayOrderId, gatewayPaymentId, note,
        }];
        await inv.save();                       // the pre-save hook re-derives paidAmount and status
        total = round2(total + paid);

        await postToLedger({
            schoolId: req.schoolId, studentId: inv.student, academicYearId: inv.academicYear,
            entryType: 'credit', category: 'payment', amount: paid,
            description: `Hostel fee payment — receipt ${receiptNumber}`,
            invoiceId: inv._id, feeHeadName: `Hostel ${String(inv.feeType).replace(/_/g, ' ')}`,
            createdBy: req.userId, settings,
        });
        await logAudit(req, { action: 'payment', entityType: 'HostelFeeInvoice', entityId: inv._id, hostel: inv.hostel,
            description: `Payment of ${paid} against ${inv.invoiceNumber} (${MODE_LABEL[mode] || mode})`,
            before: { paidAmount: before }, after: { paidAmount: inv.paidAmount, receiptNumber, mode } });
    }
    return { receiptNumber, total, paidAt, settings };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Online: open, then confirm
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Open a gateway order for the resident's outstanding invoices — all of them,
 * or the ones named. Priced here, from the database.
 */
async function openOrder(req, { studentId, invoiceIds = [] }) {
    const filter = { school: req.schoolId, student: studentId, status: { $in: PAYABLE } };
    const wanted = (Array.isArray(invoiceIds) ? invoiceIds : []).map(String).filter(Boolean);
    if (wanted.length) filter._id = { $in: wanted };

    const invoices = await HostelFeeInvoice.find(filter).sort('dueDate').lean();
    const lines = invoices
        .map((i) => ({ invoice: String(i._id), invoiceNumber: i.invoiceNumber, amount: outstandingOf(i) }))
        .filter((l) => l.amount > 0);
    if (!lines.length) throw new PaymentError('There is nothing outstanding to pay');
    const amount = round2(lines.reduce((s, l) => s + l.amount, 0));

    const order = await paymentGateway.createOrder(
        req.schoolId, 'hostel', amount,
        `HOSTEL-${String(studentId).slice(-8)}-${Date.now().toString().slice(-8)}`,
    );
    if (order.error) throw new PaymentError(order.error);

    await HostelPaymentOrder.create({
        school: req.schoolId, student: studentId, openedBy: req.userId, openedByRole: req.userRole,
        orderId: order.orderId, amount, lines,
    });
    return { ...order, payable: amount, invoiceIds: lines.map((l) => l.invoice) };
}

/**
 * Put a paid order's money where the order said. The caller holds the
 * per-order lock and has established that the gateway took the payment —
 * by the payer's signed callback, or by asking the gateway (reconcileOrder).
 */
async function applyOrder(req, order, paymentId, { confirmedBy }) {
    const studentId = order.student;
    // Never more than is still owed: an invoice may have been settled at the
    // counter while the checkout was open.
    const lines = []; let unapplied = 0;
    for (const l of order.lines || []) {
        const inv = await HostelFeeInvoice.findOne({ _id: l.invoice, school: req.schoolId });
        const take = Math.min(round2(l.amount), outstandingOf(inv));
        if (take > 0) lines.push({ invoice: inv, amount: take });
        unapplied = round2(unapplied + round2(l.amount) - take);
    }

    const done = lines.length
        ? await settle(req, { lines, mode: 'online', reference: paymentId, paidBy: order.openedBy, gatewayOrderId: order.orderId, gatewayPaymentId: paymentId })
        : { receiptNumber: '', total: 0, paidAt: new Date(), settings: await getSettings(req.schoolId) };

    order.status = 'paid';
    order.paymentId = paymentId;
    order.receiptNumber = done.receiptNumber;
    order.paidAt = done.paidAt;
    order.unapplied = unapplied;
    order.confirmedBy = confirmedBy;
    order.lastCheckedAt = new Date();
    await order.save();

    const resident = await User.findById(studentId).select('name').lean();
    const hostel = lines[0]?.invoice.hostel || null;
    if (done.total > 0) {
        notifyStudentAndParents(req, {
            studentId, settings: done.settings,
            title: 'Hostel fee paid',
            body: `A hostel fee payment of ${rupees(done.total)} was received online. Receipt ${done.receiptNumber}.`,
        });
        notifyHostelStaff(req, { hostelId: hostel, includeSender: !!req.system,
            title: 'Hostel fee paid online',
            body: `${resident?.name || 'A resident'} paid ${rupees(done.total)} online against ${lines.length} invoice${lines.length === 1 ? '' : 's'}. Receipt ${done.receiptNumber}.`
                + (confirmedBy === 'reconcile' ? ' (Found by checking with the gateway — the payer\'s browser never confirmed it.)' : '') });
    }
    if (unapplied > 0) {
        // Money was taken that the books cannot place. Say so loudly.
        await logAudit(req, { action: 'payment', entityType: 'HostelPaymentOrder', entityId: order._id, hostel,
            description: `Online payment ${paymentId}: ${unapplied} could not be applied — the invoice was settled while the checkout was open. Refund or adjust.`,
            meta: { orderId: order.orderId, paymentId, unapplied } });
        notifyHostelStaff(req, { hostelId: hostel, includeSender: !!req.system,
            title: 'Hostel payment needs attention',
            body: `${resident?.name || 'A resident'} paid ${rupees(unapplied)} online that could not be applied — the invoice was already settled. Refund or adjust it. Gateway reference ${paymentId}.` });
    }
    return { receiptNumber: done.receiptNumber, amount: done.total, count: lines.length, unapplied };
}

/**
 * Record a payment the gateway vouches for. Safe to call twice: the second
 * call finds the order already paid and answers with the same receipt.
 */
async function confirmOrder(req, { studentId, orderId, paymentId, signature }) {
    const verified = await paymentGateway.verifySignature(req.schoolId, 'hostel', { orderId, paymentId, signature });
    if (!verified.ok) throw new PaymentError(verified.reason);

    // One confirmation at a time per order — a double submit waits here, then
    // finds the order paid.
    return withTransaction(async (q) => {
        await lock(q, `hostel-pay:${orderId}`);
        const order = await HostelPaymentOrder.findOne({ school: req.schoolId, orderId });
        if (!order || String(order.student) !== String(studentId)) {
            throw new PaymentError('This payment was not opened from this account', 404);
        }
        if (order.status === 'paid') {
            return { receiptNumber: order.receiptNumber, amount: round2(order.amount - (order.unapplied || 0)), unapplied: order.unapplied || 0, alreadyRecorded: true };
        }
        return applyOrder(req, order, paymentId, { confirmedBy: 'payer' });
    });
}

/** An order nobody paid is asked about for this long, then left alone. */
const ORDER_WATCH_MS = 3 * 24 * 36e5;

/**
 * Ask the gateway about a checkout that was opened and never confirmed.
 *
 * The payer's browser is what normally reports a payment. If it closes, loses
 * signal or crashes after the money has moved, nothing arrives — and the
 * invoice stays unpaid although the family has paid. So the gateway is asked:
 * if it captured a payment for the order, that payment is recorded exactly as
 * a confirmed one would be.
 * @returns {{status: 'paid'|'created'|'expired', error?: string, receiptNumber?: string}}
 */
async function reconcileOrder(req, orderId) {
    return withTransaction(async (q) => {
        await lock(q, `hostel-pay:${orderId}`);
        const order = await HostelPaymentOrder.findOne({ school: req.schoolId, orderId });
        if (!order) throw new PaymentError('Payment not found', 404);
        if (order.status !== 'created') return { status: order.status, receiptNumber: order.receiptNumber };

        const g = await paymentGateway.orderPayment(req.schoolId, 'hostel', order.orderId);
        order.lastCheckedAt = new Date();
        if (g.error) { await order.save(); return { status: 'created', error: g.error }; }
        if (!g.paid) {
            if (Date.now() - new Date(order.createdAt) > ORDER_WATCH_MS) order.status = 'expired';
            await order.save();
            return { status: order.status };
        }
        const r = await applyOrder(req, order, g.paymentId, { confirmedBy: 'reconcile' });
        return { status: 'paid', ...r };
    });
}

/**
 * Reconcile the open checkouts of a school (or of one resident). Ones opened in
 * the last two minutes are left alone: the payer is probably still paying, and
 * their own confirmation is on its way.
 */
async function reconcileOpen(req, { studentId = null, limit = 25 } = {}) {
    const q = { school: req.schoolId, status: 'created', createdAt: { $lt: new Date(Date.now() - 2 * 60000) } };
    if (studentId) q.student = studentId;
    const open = await HostelPaymentOrder.find(q).sort('-createdAt').limit(limit).select('orderId').lean();
    let paid = 0; let expired = 0;
    for (const o of open) {
        try {
            const r = await reconcileOrder(req, o.orderId);
            if (r.error) break;                     // the gateway is not answering: stop asking this round
            if (r.status === 'paid') paid += 1;
            if (r.status === 'expired') expired += 1;
        } catch (e) { console.error('[hostel] reconcile failed:', e.message); }
    }
    return { checked: open.length, paid, expired };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Refunds and the security deposit
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Give money back on an invoice.
 *
 * `viaGateway` sends it to the card or account an ONLINE payment came from —
 * one payment has to be able to carry the whole amount. Otherwise it is a
 * record of cash or a transfer handed over by the office. Either way the
 * refund gets a voucher number and a line in the invoice's refund history.
 */
async function refund(req, inv, value, { reference = '', reason = '', viaGateway = false } = {}) {
    const amount = round2(value);
    const refundable = round2((inv.paidAmount || 0) - (inv.refundedAmount || 0));
    if (amount <= 0 || amount > refundable) throw new PaymentError(`At most ${refundable} can be refunded`);

    let gatewayRefundId = ''; let gatewayPaymentId = '';
    if (viaGateway) {
        const back = (inv.refunds || []).filter((r) => r.mode === 'gateway');
        const room = (p) => round2((p.amount || 0) - back.filter((r) => r.gatewayPaymentId === p.gatewayPaymentId).reduce((t, r) => t + (r.amount || 0), 0));
        const online = (inv.payments || []).filter((p) => p.mode === 'online' && p.gatewayPaymentId)
            .map((p) => ({ p, room: room(p) })).sort((a, b) => b.room - a.room);
        if (!online.length) throw new PaymentError('This invoice has no online payment to send a refund back to');
        if (online[0].room < amount) {
            throw new PaymentError(`At most ${online[0].room} can go back to the online payment — refund the rest by cash or transfer`);
        }
        const r = await paymentGateway.refundPayment(req.schoolId, 'hostel', online[0].p.gatewayPaymentId, amount, { invoice: inv.invoiceNumber });
        if (r.error) throw new PaymentError(r.error);
        gatewayRefundId = r.refundId; gatewayPaymentId = online[0].p.gatewayPaymentId;
    }

    const voucherNumber = await nextNumber(HostelFeeInvoice, req.schoolId, 'HRF', false, { fresh: true });
    const at = new Date();
    inv.refunds = [...(inv.refunds || []), {
        amount, mode: viaGateway ? 'gateway' : 'offline', reference: gatewayRefundId || reference, reason, voucherNumber,
        gatewayRefundId, gatewayPaymentId, refundedAt: at, refundedBy: req.userId,
    }];
    inv.refundedAmount = round2((inv.refundedAmount || 0) + amount);
    inv.refundedAt = at;
    inv.refundReference = gatewayRefundId || reference;
    if (inv.refundedAmount >= inv.paidAmount) inv.status = 'refunded';
    await inv.save();

    const settings = await getSettings(req.schoolId);
    await postToLedger({
        schoolId: req.schoolId, studentId: inv.student, academicYearId: inv.academicYear,
        entryType: 'debit', category: 'refund', amount,
        description: `Hostel refund on ${inv.invoiceNumber}${reason ? ` — ${reason}` : ''}`,
        invoiceId: inv._id, createdBy: req.userId, settings,
    });
    await logAudit(req, { action: 'refund', entityType: 'HostelFeeInvoice', entityId: inv._id, hostel: inv.hostel,
        description: `Refunded ${amount} against ${inv.invoiceNumber}${viaGateway ? ' to the online payment' : ''} (${voucherNumber})`,
        after: { refundedAmount: inv.refundedAmount, reference: gatewayRefundId || reference, reason, voucherNumber } });
    notifyStudentAndParents(req, {
        studentId: inv.student, settings,
        title: 'Hostel refund processed',
        body: `A refund of ${rupees(amount)} has been processed against ${inv.invoiceNumber}${viaGateway ? ' — it goes back to the card or account it was paid from, usually within 5–7 working days' : ''}. Voucher ${voucherNumber}.`,
    });
    return { voucherNumber, gatewayRefundId, amount };
}

/** A resident's security deposits: what is held (paid and not given back), and what was billed but never paid. */
async function deposits(schoolId, studentId) {
    const rows = await HostelFeeInvoice.find({ school: schoolId, student: studentId, feeType: 'security_deposit', status: { $nin: ['cancelled', 'refunded'] } });
    const held = rows.map((i) => ({ invoice: i, held: round2((i.paidAmount || 0) - (i.refundedAmount || 0)) })).filter((x) => x.held > 0);
    return { held, unpaid: rows.filter((i) => !(i.paidAmount > 0)), total: round2(held.reduce((t, x) => t + x.held, 0)) };
}

/**
 * The refundable deposit a school takes when a bed is given. One per resident:
 * it carries across a room change, and is not asked for again while one is
 * still billed or held. Staff are asked only where the school charges staff.
 */
async function raiseDeposit(req, { studentId, allocation, kind, settings }) {
    const amount = round2(settings.securityDepositAmount);
    if (!(amount > 0)) return null;
    if (kind === 'teacher' && !settings.chargeTeachers) return null;
    const already = await HostelFeeInvoice.exists({ school: req.schoolId, student: studentId, feeType: 'security_deposit', status: { $nin: ['cancelled', 'refunded'] } });
    if (already) return null;

    const inv = await HostelFeeInvoice.create({
        school: req.schoolId, student: studentId, residentType: kind, hostel: allocation.hostel, allocation: allocation._id,
        academicYear: allocation.academicYear, feeType: 'security_deposit',
        invoiceNumber: await nextNumber(HostelFeeInvoice, req.schoolId, 'HF'),
        amount, isRefundable: true, dueDate: new Date(Date.now() + 7 * 864e5),
        remarks: 'Security deposit — refundable at checkout', generatedBy: req.system ? null : req.userId,
    });
    await postToLedger({
        schoolId: req.schoolId, studentId, academicYearId: allocation.academicYear,
        entryType: 'debit', category: 'fee_charged', amount: inv.netAmount,
        description: `Hostel security deposit — ${inv.invoiceNumber}`,
        invoiceId: inv._id, feeHeadName: 'Hostel security deposit', createdBy: req.userId, settings,
    });
    await logAudit(req, { action: 'create', entityType: 'HostelFeeInvoice', entityId: inv._id, hostel: inv.hostel,
        description: `Raised security deposit ${inv.invoiceNumber} — ${amount}` });
    if (settings.notifyOnFeeDue) {
        notifyStudentAndParents(req, { studentId, settings, title: 'Hostel security deposit',
            body: `A refundable security deposit of ${rupees(amount)} has been raised (${inv.invoiceNumber}). It is returned at checkout.` });
    }
    return inv;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reading: what is owed, what was paid, the receipt
// ─────────────────────────────────────────────────────────────────────────────
/** Every invoice in the school carrying a payment with this receipt number. */
async function invoicesOnReceipt(schoolId, receiptNumber) {
    const { rows } = await pool.query(
        `SELECT "_id" FROM "${HostelFeeInvoice.tableName}" WHERE "school" = $1 AND "payments" @> $2::jsonb`,
        [String(schoolId), JSON.stringify([{ receiptNumber }])]);
    if (!rows.length) return [];
    return HostelFeeInvoice.find({ _id: { $in: rows.map((r) => String(r._id)) }, school: schoolId }).lean();
}

/** One row per receipt across a resident's invoices, newest first. */
function receiptsOf(invoices) {
    const by = new Map();
    for (const inv of invoices) {
        for (const p of inv.payments || []) {
            if (!p.receiptNumber) continue;
            // Old receipts were numbered from a count and could repeat across
            // residents, so a receipt is identified with the resident it is for.
            const row = by.get(p.receiptNumber) || {
                receiptNumber: p.receiptNumber, invoice: String(inv._id), paidAt: p.paidAt, mode: p.mode || 'cash',
                reference: p.gatewayPaymentId || p.reference || '', amount: 0, count: 0, lines: [],
            };
            row.amount = round2(row.amount + (p.amount || 0));
            row.count += 1;
            row.lines.push(feeLabel(inv));
            by.set(p.receiptNumber, row);
        }
    }
    return [...by.values()].sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
}

/** Who a resident is, for a receipt or a bill header. */
async function residentCard(schoolId, userId) {
    const user = await User.findOne({ _id: userId, school: schoolId }).select('name email role profileImage').lean();
    if (!user) return { name: '', kind: 'student', detailLabel: '', detail: '' };
    const kind = user.role === 'teacher' ? 'teacher' : 'student';
    const allocation = await HostelAllocation.findOne({ school: schoolId, student: userId, status: { $in: ['active', 'pending'] } })
        .populate('hostel', 'name').populate('room', 'roomNumber').lean();
    const room = allocation
        ? [allocation.hostel?.name, allocation.room?.roomNumber && (/^room\b/i.test(allocation.room.roomNumber) ? allocation.room.roomNumber : `Room ${allocation.room.roomNumber}`)].filter(Boolean).join(' · ')
        : '';
    if (kind === 'teacher') {
        const tp = await TeacherProfile.findOne({ user: userId }).select('employeeId designation').lean();
        return { name: user.name, kind, detailLabel: 'Staff', detail: [tp?.designation, tp?.employeeId].filter(Boolean).join(' · '), room };
    }
    const sp = await StudentProfile.findOne({ user: userId, school: schoolId }).select('currentClass currentSection admissionNumber')
        .populate('currentClass', 'className classNumber').populate('currentSection', 'sectionName').lean();
    const cls = sp ? [sp.currentClass?.className || (sp.currentClass?.classNumber ? `Class ${sp.currentClass.classNumber}` : ''), sp.currentSection?.sectionName].filter(Boolean).join(' · ') : '';
    return { name: user.name, kind, detailLabel: cls ? 'Class' : '', detail: cls, room };
}

/**
 * A receipt as the renderer wants it: every invoice the payment touched, as
 * one document. `invoiceId` / `students` narrow a (legacy, repeated) number to
 * one resident — a receipt never mixes two people's payments.
 */
async function buildReceipt(schoolId, receiptNumber, { invoiceId = null, students = null } = {}) {
    let invoices = await invoicesOnReceipt(schoolId, receiptNumber);
    if (students) invoices = invoices.filter((i) => students.includes(String(i.student)));
    if (!invoices.length) return null;

    const anchor = (invoiceId && invoices.find((i) => String(i._id) === String(invoiceId))) || invoices[0];
    invoices = invoices.filter((i) => String(i.student) === String(anchor.student));

    const lines = []; let first = null;
    for (const inv of invoices) {
        for (const p of inv.payments || []) {
            if (p.receiptNumber !== receiptNumber) continue;
            first = first || p;
            lines.push({ label: feeLabel(inv), amount: p.amount || 0 });
        }
    }
    const who = await residentCard(schoolId, anchor.student);
    const mode = first?.mode === 'online' ? 'online' : 'offline';
    return {
        owner: String(anchor.student), hostel: anchor.hostel || null,
        receipt: {
            module: 'hostel',
            number: receiptNumber,
            date: first?.paidAt || anchor.updatedAt,
            paidBy: who.name,
            paidByDetailLabel: who.detailLabel || (who.room ? 'Room' : ''),
            paidByDetail: [who.detail, who.room].filter(Boolean).join(' · '),
            title: 'Hostel fee receipt',
            paymentMode: mode,
            offlineModeLabel: `${MODE_LABEL[first?.mode] || 'Cash'} (at the hostel office)`,
            reference: first?.gatewayPaymentId || first?.reference || '',
            lines,
            total: round2(lines.reduce((s, l) => s + Number(l.amount || 0), 0)),
            currencySymbol: '₹',
        },
    };
}

/** A refund, as the same renderer draws it — worded as a voucher, not a receipt. */
async function buildRefundVoucher(schoolId, voucherNumber, { students = null } = {}) {
    const { rows } = await pool.query(
        `SELECT "_id" FROM "${HostelFeeInvoice.tableName}" WHERE "school" = $1 AND "refunds" @> $2::jsonb LIMIT 1`,
        [String(schoolId), JSON.stringify([{ voucherNumber }])]);
    if (!rows.length) return null;
    const inv = await HostelFeeInvoice.findOne({ _id: String(rows[0]._id), school: schoolId }).lean();
    if (!inv || (students && !students.includes(String(inv.student)))) return null;
    const r = (inv.refunds || []).find((x) => x.voucherNumber === voucherNumber);
    const who = await residentCard(schoolId, inv.student);
    return {
        owner: String(inv.student), hostel: inv.hostel || null,
        receipt: {
            module: 'hostel', number: voucherNumber, date: r.refundedAt,
            paidBy: who.name, paidByDetailLabel: who.detailLabel || (who.room ? 'Room' : ''), paidByDetail: [who.detail, who.room].filter(Boolean).join(' · '),
            title: 'Hostel refund voucher',
            paymentMode: r.mode === 'gateway' ? 'online' : 'offline',
            offlineModeLabel: 'Cash / bank transfer (from the hostel office)',
            reference: r.reference || '',
            lines: [{ label: `Refund — ${feeLabel(inv)}${r.reason ? ` · ${r.reason}` : ''}`, amount: r.amount }],
            total: round2(r.amount), currencySymbol: '₹',
            labels: { number: 'Voucher no.', paidBy: 'Refunded to', mode: 'Refunded by', total: 'Total refunded', stamp: 'REFUNDED', doc: 'Refund voucher' },
        },
    };
}

module.exports = {
    PAYABLE, OFFLINE_MODES, MODE_LABEL, PaymentError,
    outstandingOf, feeLabel, round2,
    settle, openOrder, confirmOrder, reconcileOrder, reconcileOpen, refund, deposits, raiseDeposit,
    receiptsOf, buildReceipt, buildRefundVoucher, residentCard,
};
