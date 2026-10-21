'use strict';
/**
 * Application and admission fees.
 *
 * Online payment goes through the school's own gateway (services/paymentGateway,
 * the same account fees and hostel use, switched on for "admission" by the
 * school). A payment is 'paid' only after the gateway's signature is verified
 * on the server — or, when the browser never came back, after the gateway
 * itself is asked about the order. Nothing is marked paid on a browser's word.
 *
 * Counter payments (cash, cheque, DD, transfer) are recorded by the office.
 * Waivers come from the school's own waiver categories and reduce what is due;
 * every one is kept on the application with who granted it and why.
 */
const pool = require('../../db/pool');
const { patch } = require('../../db/patch');
const { withTransaction, buildInsert } = require('../dbTx');
const AdmissionPayment = require('../../models/AdmissionPayment');
const AdmissionApplication = require('../../models/AdmissionApplication');
const School = require('../../models/School');
const AcademicYear = require('../../models/AcademicYear');
const gateway = require('../paymentGateway');
const settingsSvc = require('./settings');
const counters = require('./counters');
const events = require('./events');
const notify = require('./notify');
const fmt = require('./format');
const { refuse, str, date, round2, isId } = require('./util');

const KINDS = { application_fee: 'application', admission_fee: 'admission' };
const LABEL = { application_fee: 'application fee', admission_fee: 'admission fee' };
const OFFLINE_MODES = ['cash', 'cheque', 'dd', 'bank_transfer', 'upi', 'card'];

const amountField = (kind) => (kind === 'application_fee' ? 'applicationFeeAmount' : 'admissionFeeAmount');
const statusField = (kind) => (kind === 'application_fee' ? 'applicationFeeStatus' : 'admissionFeeStatus');

/** The fee, what was waived, what was paid (less what was refunded), and what is still due. */
async function balance(app, kind, q = null) {
    const run = q || ((s, p) => pool.query(s, p));
    const fee = round2(app[amountField(kind)]);
    const waived = round2((app.feeWaivers || []).filter((w) => w.kind === kind).reduce((s, w) => s + (Number(w.amount) || 0), 0));
    const { rows: [p] } = await run(
        `SELECT COALESCE(SUM("amount") FILTER (WHERE "status" = 'paid'), 0)::float8 AS paid,
                (SELECT COALESCE(SUM(r."amount"), 0)::float8 FROM "admissionrefunds" r
                  WHERE r."application" = $1 AND r."kind" = $2 AND r."status" IN ('pending', 'processed')) AS refunded
           FROM "${AdmissionPayment.tableName}" WHERE "application" = $1 AND "kind" = $2`,
        [String(app._id), kind]);
    const refunded = round2(p.refunded);
    const paid = round2(p.paid - refunded);
    const due = round2(Math.max(0, fee - waived - paid));
    // Money received beyond the fee — a family that paid online while the
    // office also took cash. It is real money, recorded as received, and the
    // office refunds it; `excess` is what tells them so.
    const excess = round2(Math.max(0, paid - Math.max(0, fee - waived)));
    return { fee, waived, paid, due, excess, refunded };
}

// ── Instalments ──────────────────────────────────────────────────────────────

/**
 * The admission fee's instalments, each with what is still owed on it — the
 * live offer's plan, filled in order by what was paid and waived. null when
 * the fee is paid in one go.
 */
async function scheduleOf(app, b = null, q = null) {
    const run = q || ((s, p) => pool.query(s, p));
    const { rows: [offer] } = await run(
        `SELECT "schedule" FROM "admissionoffers" WHERE "application" = $1 AND "status" IN ('issued', 'accepted', 'confirmed') ORDER BY "issuedAt" DESC LIMIT 1`, [String(app._id)]);
    const plan = Array.isArray(offer?.schedule) && offer.schedule.length > 1 ? offer.schedule : null;
    if (!plan) return null;
    const bal = b || await balance(app, 'admission_fee', q);
    const covered = round2(bal.paid + bal.waived);
    let cum = 0;
    return plan.map((x, i) => {
        const amount = round2(x.amount);
        const start = cum;
        cum = round2(cum + amount);
        const got = round2(Math.max(0, Math.min(amount, covered - start)));
        const owing = round2(amount - got);
        const status = owing <= 0 ? 'paid' : got > 0 ? 'part' : (x.dueAt && new Date(x.dueAt) < new Date() ? 'overdue' : 'due');
        return { index: i, label: x.label, amount, dueAt: x.dueAt, paid: got, owing, status };
    });
}

/** The plan a round sets, made into amounts and dates for an offer's fee. */
function planFor(round, fee, feeDueAt) {
    const parts = Array.isArray(round?.instalments) ? round.instalments : [];
    if (parts.length < 2 || !(fee > 0)) return null;
    let given = 0;
    return parts.map((p, i) => {
        const amount = i === parts.length - 1 ? round2(fee - given) : round2((fee * Number(p.percent)) / 100);
        given = round2(given + amount);
        return { label: p.label, amount, dueAt: new Date(new Date(feeDueAt).getTime() + (Number(p.dueDays) || 0) * 86400000), remindedAt: null };
    });
}

/**
 * The application row, locked for the rest of the transaction: every change to
 * what is owed (a payment, a waiver, its removal) reads the balance and writes
 * under this lock, so two of them at the same moment cannot both see the same
 * amount due.
 */
async function lockApplication(q, app) {
    const { rows: [row] } = await q(`SELECT * FROM "${AdmissionApplication.tableName}" WHERE "_id" = $1 FOR UPDATE`, [String(app._id)]);
    if (!row) refuse('Application not found', 404);
    return row;
}

/** An amount of money typed by a person: a positive number, at most two decimals' worth, or a refusal. */
function moneyIn(v, { max = 10000000, field = 'amount' } = {}) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n) || n <= 0) refuse('Enter the amount', 400, { field });
    if (n > max) refuse(`The amount can be at most ${fmt.money(max)}`, 400, { field });
    return round2(n);
}

/** Closed without a seat — withdrawn, declined, rejected… (an enrolled student may still owe instalments). */
const endedWithoutSeat = (status) => status !== 'enrolled' && require('./workflow').isClosed(status);

/** The status column for a fee, from its balance. Money given back on an application closed without a seat reads "refunded". */
function feeStatus(b, { closed = false } = {}) {
    if (b.fee <= 0) return 'not_required';
    if (b.due > 0) return closed && b.refunded > 0 ? 'refunded' : 'due';
    return b.paid > 0 ? 'paid' : 'waived';
}

async function refreshStatus(app, kind, q = null) {
    const b = await balance(app, kind, q);
    const status = feeStatus(b, { closed: endedWithoutSeat(app.status) });
    if (app[statusField(kind)] !== status) await patch(AdmissionApplication, app._id, { [statusField(kind)]: status }, { q, touch: false });
    return { ...b, status };
}

function payableKind(app, kind) {
    if (!KINDS[kind]) refuse('Choose the application fee or the admission fee');
    // An enrolled student's family may still owe later instalments of the admission fee.
    if (kind === 'admission_fee' && !['offer_issued', 'accepted', 'payment_pending', 'confirmed', 'enrolled'].includes(app.status)) {
        refuse('The admission fee is paid after a seat is offered', 409);
    }
    if (['withdrawn', 'cancelled', 'rejected', 'declined', 'ineligible'].includes(app.status)) refuse('This application is closed', 409);
}

async function receiptNumber(app, q) {
    const settings = await settingsSvc.getSettings(app.school);
    const school = await School.findById(app.school).select('name code').lean();
    const year = await AcademicYear.findById(app.academicYear).select('startDate').lean();
    return counters.nextNumber(app.school, 'receipt', settings.numbering.receipt, { school, year: year?.startDate ? new Date(year.startDate).getFullYear() : null }, q);
}

async function afterPaid(app, payment, req) {
    await refreshStatus(app, payment.kind);
    events.recordQuietly(app.school, {
        application: app._id, by: req, type: 'payment', action: 'paid',
        message: `${fmt.money(payment.amount)} received towards the ${LABEL[payment.kind]} — receipt ${payment.receiptNumber}`, visibility: 'applicant',
        meta: { payment: String(payment._id), mode: payment.mode },
    });
    notify.toApplicant(app, 'payment_receipt', {
        receipt_number: payment.receiptNumber, amount_paid: fmt.money(payment.amount), payment_date: fmt.fmtDate(payment.paidAt), payment_for: LABEL[payment.kind],
    });
}

// ── Online ───────────────────────────────────────────────────────────────────

/** Open a gateway order for what is due — or, on an instalment plan, for the next instalment only. */
async function createOrder(req, app, kind, { part = 'all' } = {}) {
    payableKind(app, kind);
    const full = await balance(app, kind);
    if (full.due <= 0) refuse('Nothing is due', 409, { code: 'NOTHING_DUE' });
    let b = full;
    if (kind === 'admission_fee' && part === 'instalment') {
        const next = (await scheduleOf(app, full) || []).find((x) => x.owing > 0);
        if (next) b = { ...full, due: round2(Math.min(next.owing, full.due)) };
    }
    // An order opened in the last half hour for this same amount is handed back
    // instead of a second one: two tabs, or a retry after a closed window, then
    // pay ONE order — and a gateway order can be paid only once.
    const { rows: [open] } = await pool.query(
        `SELECT * FROM "${AdmissionPayment.tableName}" WHERE "application" = $1 AND "kind" = $2 AND "status" = 'created' AND "mode" = 'online'
           AND "amount" = $3 AND "createdAt" > now() - interval '30 minutes' ORDER BY "createdAt" DESC LIMIT 1`,
        [String(app._id), kind, b.due]);
    if (open) {
        const resolved = await gateway.resolveGateway(app.school, 'admission');
        if (!resolved.ok) refuse(resolved.reason, 409, { code: 'GATEWAY_UNAVAILABLE' });
        return { paymentId: open._id, orderId: open.orderId, amount: Math.round(b.due * 100), currency: resolved.gateway.currency || 'INR', keyId: resolved.gateway.razorpayKeyId, due: b.due, reused: true };
    }
    const order = await gateway.createOrder(app.school, 'admission', b.due, `ADM-${String(app._id).slice(0, 8)}-${Date.now().toString(36)}`);
    if (order.error) refuse(order.error, 409, { code: 'GATEWAY_UNAVAILABLE' });
    const { sql, params } = buildInsert(AdmissionPayment, {
        school: app.school, application: app._id, applicant: app.applicant, kind, amount: b.due, mode: 'online', status: 'created',
        gateway: 'razorpay', orderId: order.orderId, recordedBy: req.userId,
    });
    const { rows: [row] } = await pool.query(sql, params);
    return { paymentId: row._id, orderId: order.orderId, amount: order.amount, currency: order.currency, keyId: order.keyId, due: b.due };
}

/** Confirm a payment the browser reports, by the gateway's signature. Idempotent. */
async function verifyOnline(req, app, { orderId, paymentId, signature }) {
    const { rows: [pay] } = await pool.query(
        `SELECT * FROM "${AdmissionPayment.tableName}" WHERE "orderId" = $1 AND "application" = $2 AND "school" = $3`,
        [String(orderId || ''), String(app._id), String(app.school)]);
    if (!pay) refuse('That payment was not found', 404);
    if (pay.status === 'paid') return pay;
    const check = await gateway.verifySignature(app.school, 'admission', { orderId, paymentId, signature });
    if (!check.ok) {
        await patch(AdmissionPayment, pay._id, { status: 'failed', notes: check.reason.slice(0, 200) }, { where: { status: 'created' } });
        refuse(check.reason, 400, { code: 'PAYMENT_NOT_VERIFIED' });
    }
    return markPaid(req, app, pay, String(paymentId));
}

/** The gateway is asked directly — for a payment whose browser never came back. */
async function reconcile(req, app, paymentRowId) {
    const { rows: [pay] } = await pool.query(`SELECT * FROM "${AdmissionPayment.tableName}" WHERE "_id" = $1 AND "application" = $2`, [String(paymentRowId), String(app._id)]);
    if (!pay || pay.mode !== 'online') refuse('That payment was not found', 404);
    if (pay.status === 'paid') return pay;
    const r = await gateway.orderPayment(app.school, 'admission', pay.orderId);
    if (r.error) refuse(r.error, 409);
    if (!r.paid) refuse('The gateway has no completed payment for this order yet', 409, { code: 'NOT_PAID' });
    return markPaid(req, app, pay, r.paymentId);
}

async function markPaid(req, app, pay, gatewayPaymentId) {
    const paid = await withTransaction(async (q) => {
        const number = await receiptNumber(app, q);
        const row = await patch(AdmissionPayment, pay._id, { status: 'paid', paymentId: gatewayPaymentId, receiptNumber: number, paidAt: new Date() }, { where: { status: ['created', 'failed'] }, q });
        return row;
    }).catch((e) => {
        if (e.code === '23505' || e.code === 11000) refuse('This payment has already been recorded', 409);
        throw e;
    });
    if (!paid) return (await pool.query(`SELECT * FROM "${AdmissionPayment.tableName}" WHERE "_id" = $1`, [pay._id])).rows[0];
    const fresh = (await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [String(app._id)])).rows[0];
    await afterPaid(fresh, paid, req);
    // Captured by the gateway after the fee was already settled (cash at the
    // counter, a second tab): recorded — it is real money — and flagged so the
    // office refunds it.
    const b = await balance(fresh, paid.kind);
    if (b.excess > 0) {
        events.recordQuietly(app.school, {
            application: app._id, by: req, type: 'payment', action: 'excess',
            message: `${fmt.money(b.excess)} more than the ${LABEL[paid.kind]} was received (online payment ${gatewayPaymentId}) — refund it from the payment gateway`,
        });
    }
    return paid;
}

// ── At the office ────────────────────────────────────────────────────────────

async function recordOffline(req, app, input) {
    const kind = input.kind;
    payableKind(app, kind);
    const mode = OFFLINE_MODES.includes(input.mode) ? input.mode : null;
    if (!mode) refuse('Choose how it was paid', 400, { field: 'mode' });
    const amount = moneyIn(input.amount);
    const reference = str(input.reference, 80);
    if (['cheque', 'dd', 'bank_transfer', 'upi', 'card'].includes(mode) && !reference) refuse('Enter the cheque, DD or transaction reference', 400, { field: 'reference' });
    const paidAt = date(input.paidAt) || new Date();
    if (paidAt > new Date(Date.now() + 60000)) refuse('The payment date cannot be in the future', 400, { field: 'paidAt' });
    const row = await withTransaction(async (q) => {
        const locked = await lockApplication(q, app);
        payableKind(locked, kind);
        const b = await balance(locked, kind, q);
        if (amount > b.due + 0.001) refuse(b.due > 0 ? `Only ${fmt.money(b.due)} is due` : 'Nothing is due on this fee', 400, { field: 'amount' });
        const number = await receiptNumber(app, q);
        const { sql, params } = buildInsert(AdmissionPayment, {
            school: app.school, application: app._id, applicant: app.applicant, kind, amount: round2(amount), mode, status: 'paid',
            reference, receiptNumber: number, paidAt, notes: str(input.notes, 300), recordedBy: req.userId,
        });
        return (await q(sql, params)).rows[0];
    });
    const fresh = (await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [String(app._id)])).rows[0];
    await afterPaid(fresh, row, req);
    return row;
}

async function voidPayment(req, app, paymentRowId, reason) {
    const why = str(reason, 300);
    if (!why) refuse('Say why the payment is cancelled', 400, { field: 'reason' });
    if (!isId(String(paymentRowId))) refuse('Payment not found', 404);
    const { rows: [pay] } = await pool.query(`SELECT * FROM "${AdmissionPayment.tableName}" WHERE "_id" = $1 AND "application" = $2 AND "school" = $3`, [String(paymentRowId), String(app._id), String(app.school)]);
    if (!pay) refuse('Payment not found', 404);
    if (pay.status !== 'paid') refuse('Only a paid payment can be cancelled', 409);
    if (pay.mode === 'online') refuse('An online payment is refunded through the payment gateway, not cancelled here', 409);
    const { rows: [rf] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionrefunds" WHERE "payment" = $1 AND "status" IN ('pending', 'processed')`, [pay._id]);
    if (rf.n) refuse('Money has been refunded on this payment — it cannot be cancelled', 409);
    if (app.status === 'enrolled') refuse('The student is enrolled — adjust fees in the Fees module', 409);
    await patch(AdmissionPayment, pay._id, { status: 'void', voidedBy: req.userId, voidReason: why }, { where: { status: 'paid' } });
    await refreshStatus(app, pay.kind);
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'payment', action: 'voided', message: `Receipt ${pay.receiptNumber} (${fmt.money(pay.amount)}) cancelled — ${why}` });
    return { ok: true };
}

/** Grant one of the school's waivers on a fee. */
async function applyWaiver(req, app, { kind, waiverKey, reason }) {
    if (!KINDS[kind]) refuse('Choose which fee the waiver is for');
    const settings = await settingsSvc.getSettings(app.school);
    const w = (settings.fees.waivers || []).find((x) => x.key === waiverKey);
    if (!w) refuse('Choose one of the school\'s waivers', 400, { field: 'waiverKey' });
    if (w.appliesTo !== 'both' && KINDS[kind] !== w.appliesTo) refuse(`${w.name} does not apply to the ${LABEL[kind]}`);
    if (w.requiresApproval && !(await require('./access').isAdmin(req))) refuse(`${w.name} needs an admission administrator`, 403);
    const why = str(reason, 300);
    if (!why) refuse('Say why the waiver is given', 400, { field: 'reason' });
    const { entry, out } = await withTransaction(async (q) => {
        const locked = await lockApplication(q, app);
        if ((locked.feeWaivers || []).some((x) => x.kind === kind && x.key === w.key)) refuse(`${w.name} is already applied`, 409);
        const b = await balance(locked, kind, q);
        const raw = w.type === 'percent' ? (b.fee * w.value) / 100 : w.value;
        const amount = round2(Math.min(raw, b.due));
        if (amount <= 0) refuse('Nothing is left to waive on this fee', 409);
        const e = { kind, key: w.key, name: w.name, amount, reason: why, by: String(req.userId), byName: req.user?.name || '', at: new Date() };
        const row = await patch(AdmissionApplication, app._id, { feeWaivers: [...(locked.feeWaivers || []), e] }, { q });
        return { entry: e, out: await refreshStatus(row, kind, q) };
    });
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'payment', action: 'waiver', message: `${w.name}: ${fmt.money(entry.amount)} waived on the ${LABEL[kind]} — ${why}`, visibility: 'applicant' });
    return { waiver: entry, balance: out };
}

async function removeWaiver(req, app, { kind, waiverKey, reason }) {
    const why = str(reason, 300);
    if (!why) refuse('Say why the waiver is removed', 400, { field: 'reason' });
    await withTransaction(async (q) => {
        const locked = await lockApplication(q, app);
        const left = (locked.feeWaivers || []).filter((x) => !(x.kind === kind && x.key === waiverKey));
        if (left.length === (locked.feeWaivers || []).length) refuse('That waiver is not on this application', 404);
        const row = await patch(AdmissionApplication, app._id, { feeWaivers: left }, { q });
        await refreshStatus(row, kind, q);
    });
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'payment', action: 'waiver_removed', message: `Waiver removed from the ${LABEL[kind]} — ${why}` });
    return { ok: true };
}

// ── Refunds ──────────────────────────────────────────────────────────────────

const REFUND_MODES = ['cash', 'cheque', 'bank_transfer', 'upi'];

/**
 * Give money back on a payment: through the gateway for an online payment (the
 * gateway's answer is recorded as it comes — never assumed), recorded by the
 * office for one taken at the counter. Never more than is left of the payment.
 */
async function refund(req, app, paymentRowId, input = {}) {
    if (!isId(String(paymentRowId || ''))) refuse('Payment not found', 404);
    const why = str(input.reason, 300);
    if (!why) refuse('Say why the money is given back', 400, { field: 'reason' });
    const amount = moneyIn(input.amount);
    const { row, pay } = await withTransaction(async (q) => {
        await lockApplication(q, app);
        const { rows: [p] } = await q(`SELECT * FROM "${AdmissionPayment.tableName}" WHERE "_id" = $1 AND "application" = $2 AND "school" = $3 FOR UPDATE`, [String(paymentRowId), String(app._id), String(app.school)]);
        if (!p) refuse('Payment not found', 404);
        if (p.status !== 'paid') refuse('Only a paid payment can be refunded', 409);
        const { rows: [r] } = await q(`SELECT COALESCE(SUM("amount"), 0)::float8 AS done FROM "admissionrefunds" WHERE "payment" = $1 AND "status" IN ('pending', 'processed')`, [p._id]);
        const left = round2(Number(p.amount) - r.done);
        if (amount > left + 0.001) refuse(left > 0 ? `At most ${fmt.money(left)} of this payment can be refunded` : 'This payment has been refunded in full', 400, { field: 'amount' });
        const online = p.mode === 'online';
        const mode = online ? 'gateway' : (REFUND_MODES.includes(input.mode) ? input.mode : null);
        if (!mode) refuse('Choose how the money was given back', 400, { field: 'mode' });
        const reference = str(input.reference, 80);
        if (!online && mode !== 'cash' && !reference) refuse('Enter the cheque or transaction reference', 400, { field: 'reference' });
        const { sql, params } = buildInsert(require('../../models/AdmissionRefund'), {
            school: app.school, application: app._id, payment: p._id, kind: p.kind, amount, mode, status: online ? 'pending' : 'processed',
            reference, reason: why, requestedBy: req.userId, processedAt: online ? null : new Date(),
        });
        return { row: (await q(sql, params)).rows[0], pay: p };
    });
    let out = row;
    if (pay.mode === 'online') {
        const g = await gateway.refundPayment(app.school, 'admission', pay.paymentId, amount, { application: String(app._id), reason: why.slice(0, 200) });
        out = (await pool.query(
            `UPDATE "admissionrefunds" SET "status" = $2, "gatewayRefundId" = $3, "error" = $4, "processedAt" = CASE WHEN $2 = 'processed' THEN now() ELSE NULL END, "updatedAt" = now() WHERE "_id" = $1 RETURNING *`,
            [row._id, g.error ? 'failed' : (g.status === 'processed' ? 'processed' : 'pending'), g.refundId || '', g.error || ''])).rows[0];
    }
    const fresh = (await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [String(app._id)])).rows[0];
    await refreshStatus(fresh, pay.kind);
    if (out.status === 'failed') {
        events.recordQuietly(app.school, { application: app._id, by: req, type: 'payment', action: 'refund_failed', message: `Refund of ${fmt.money(amount)} on receipt ${pay.receiptNumber} refused by the gateway — ${out.error}` });
        refuse(`The gateway refused the refund: ${out.error}`, 502, { code: 'REFUND_FAILED' });
    }
    events.recordQuietly(app.school, {
        application: app._id, by: req, type: 'payment', action: 'refunded', visibility: 'applicant',
        message: `${fmt.money(amount)} ${out.status === 'pending' ? 'being refunded' : 'refunded'} on receipt ${pay.receiptNumber}${out.status === 'pending' ? ' through the payment gateway' : ''}`,
    });
    notify.toApplicant(fresh, 'payment_refunded', { amount_refunded: fmt.money(amount), receipt_number: pay.receiptNumber, refund_reason: why, payment_for: LABEL[pay.kind] });
    return out;
}

/** Everything about an application's fees, for the applicant and the office. */
async function summary(app) {
    const [a, b] = await Promise.all([balance(app, 'application_fee'), balance(app, 'admission_fee')]);
    const { rows: payments } = await pool.query(
        `SELECT "_id", "kind", "amount", "mode", "status", "receiptNumber", "reference", "paidAt", "createdAt", "voidReason", "orderId"
           FROM "${AdmissionPayment.tableName}" WHERE "application" = $1 AND "status" <> 'created' ORDER BY "createdAt" DESC`, [String(app._id)]);
    const { rows: [open] } = await pool.query(`SELECT "_id", "kind", "orderId", "createdAt" FROM "${AdmissionPayment.tableName}" WHERE "application" = $1 AND "status" = 'created' ORDER BY "createdAt" DESC LIMIT 1`, [String(app._id)]);
    const { rows: refunds } = await pool.query(
        `SELECT r."_id", r."payment", r."kind", r."amount", r."mode", r."status", r."reference", r."reason", r."error", r."createdAt", r."processedAt", p."receiptNumber"
           FROM "admissionrefunds" r LEFT JOIN "${AdmissionPayment.tableName}" p ON p."_id" = r."payment" WHERE r."application" = $1 ORDER BY r."createdAt" DESC`, [String(app._id)]);
    const closed = endedWithoutSeat(app.status);
    return {
        application: { ...a, status: feeStatus(a, { closed }) },
        admission: { ...b, status: feeStatus(b, { closed }), schedule: await scheduleOf(app, b) },
        waivers: app.feeWaivers || [],
        payments,
        refunds,
        openOrder: open || null,
    };
}

/** The gateway as the applicant's page may see it (never a secret). */
async function gatewayInfo(schoolId) {
    const school = await School.findById(schoolId).select('paymentGateway').lean();
    return gateway.publicGateway(school?.paymentGateway, 'admission');
}

module.exports = {
    KINDS, LABEL, OFFLINE_MODES, REFUND_MODES, balance, feeStatus, refreshStatus, createOrder, verifyOnline, reconcile, recordOffline, voidPayment,
    applyWaiver, removeWaiver, summary, gatewayInfo, refund, scheduleOf, planFor,
};
