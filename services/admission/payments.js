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

/**
 * payableKind, plus what needs a look at the round: the application fee is not
 * taken on a draft that can no longer be submitted (the round closed, the last
 * date passed) — the family used to be able to pay, and then not submit.
 */
async function assertPayable(app, kind) {
    payableKind(app, kind);
    if (kind === 'application_fee' && app.status === 'draft') {
        const { rows: [round] } = await pool.query(`SELECT * FROM "admissionrounds" WHERE "_id" = $1`, [String(app.round)]);
        const closed = require('./applications').roundClosedReason(round, app.class);
        if (closed) refuse(`${closed} — the application fee is not taken on an application that can no longer be submitted`, 409, { code: 'ROUND_CLOSED' });
    }
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
    if (payment.kind === 'admission_fee') await afterAdmissionFee(app, payment, req).catch((e) => console.error('[admission] after the admission fee:', e.message));
}

/**
 * The admission fee came in. An application waiting on it ("Admission fee
 * due") used to stay there with nobody told: now the admission is confirmed
 * by itself where the school asked for that and nothing else stands in the
 * way — and otherwise the office hears that it is ready to confirm.
 */
async function afterAdmissionFee(app, payment, req) {
    const { rows: [fresh] } = await pool.query(`SELECT * FROM "${AdmissionApplication.tableName}" WHERE "_id" = $1`, [String(app._id)]);
    if (!fresh || !['selected', 'accepted', 'payment_pending'].includes(fresh.status)) return;
    const settings = await settingsSvc.getSettings(fresh.school);
    const selection = require('./selection');
    const blockers = await selection.confirmationBlockers(fresh, settings);
    const online = payment.mode === 'online';
    if (blockers.length) {
        // By the family's own doing (online) the office was not there to see it.
        if (online) require('./staffAlerts').aboutApplication(fresh, {
            title: `Admission fee received: ${fresh.studentName || fresh.applicationNumber}`,
            body: `${fmt.money(payment.amount)} paid online (receipt ${payment.receiptNumber}). Still to do before confirming: ${blockers.join('; ')}.`,
        });
        return;
    }
    const stage = require('./workflow').compile(settings.workflow).stage('confirmation');
    if (settings.conversion.autoConfirm && !stage?.requiresApproval) {
        try {
            await selection.confirm(null, fresh);
            events.recordQuietly(fresh.school, { application: fresh._id, type: 'system', action: 'auto_confirmed', message: 'Admission confirmed automatically — the fee is settled and nothing else was waiting' });
            return;
        } catch (e) { console.error('[admission] auto-confirm:', e.message); }
    }
    require('./staffAlerts').aboutApplication(fresh, {
        title: `Ready to confirm: ${fresh.studentName || fresh.applicationNumber}`,
        body: `The admission fee is settled (receipt ${payment.receiptNumber}). ${fresh.applicationNumber} can be confirmed now.`,
    });
}

// ── Online ───────────────────────────────────────────────────────────────────

/** Open a gateway order for what is due — or, on an instalment plan, for the next instalment only. */
async function createOrder(req, app, kind, { part = 'all' } = {}) {
    await assertPayable(app, kind);
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

/** The same, for the family's or the office's "check with the gateway" on the fee's latest open order. */
async function reconcileLatest(req, app, kind) {
    const { rows: [pay] } = await pool.query(
        `SELECT "_id" FROM "${AdmissionPayment.tableName}" WHERE "application" = $1 AND "mode" = 'online' AND "status" = 'created'${kind ? ' AND "kind" = $2' : ''} ORDER BY "createdAt" DESC LIMIT 1`,
        kind ? [String(app._id), kind] : [String(app._id)]);
    if (!pay) refuse('There is no online payment waiting to be confirmed on this application', 409, { code: 'NOTHING_OPEN' });
    return reconcile(req, app, pay._id);
}

/**
 * Sweep: online orders nobody came back from (Nov 2026). The family's bank
 * took the money, the browser was closed before our page heard — and the
 * payment stayed "started" for good: no receipt, the fee still due, nothing
 * to tell the family or the office. Each open order is asked about at the
 * gateway, a few minutes after it was opened and then less and less often for
 * two days; one the gateway never captured is closed after that.
 */
async function reconcileOpen(limit = 40) {
    const { rows } = await pool.query(
        `SELECT p.* FROM "${AdmissionPayment.tableName}" p
          WHERE p."mode" = 'online' AND p."status" = 'created' AND COALESCE(p."orderId", '') <> ''
            AND p."createdAt" < now() - interval '3 minutes'
            AND (p."checkedAt" IS NULL OR p."checkedAt" < now() - make_interval(mins => LEAST(360, 5 * (2 ^ LEAST(COALESCE(p."checks", 0), 7))::int)))
          ORDER BY p."checkedAt" ASC NULLS FIRST LIMIT $1`, [limit]);
    const out = { checked: 0, paid: 0, closed: 0 };
    for (const pay of rows) {
        const claimed = await pool.query(
            `UPDATE "${AdmissionPayment.tableName}" SET "checkedAt" = now(), "checks" = COALESCE("checks", 0) + 1
              WHERE "_id" = $1 AND "status" = 'created' AND "checkedAt" IS NOT DISTINCT FROM $2 RETURNING "_id"`, [pay._id, pay.checkedAt]);
        if (!claimed.rowCount) continue;
        out.checked += 1;
        const r = await gateway.orderPayment(pay.school, 'admission', pay.orderId);
        if (r.error) continue;                       // the gateway is off or unreachable — asked again later
        if (r.paid) {
            const { rows: [app] } = await pool.query(`SELECT * FROM "${AdmissionApplication.tableName}" WHERE "_id" = $1`, [pay.application]);
            if (!app) continue;
            try {
                await markPaid(null, app, pay, r.paymentId);
                events.recordQuietly(app.school, { application: app._id, type: 'payment', action: 'reconciled', message: `Online payment ${r.paymentId} was confirmed with the gateway — the family's browser had not come back` });
                out.paid += 1;
            } catch (e) { console.error('[admission] reconcile:', e.message); }
        } else if (new Date(pay.createdAt).getTime() < Date.now() - 48 * 3600 * 1000) {
            // Two days on and never paid: the order is dead.
            await patch(AdmissionPayment, pay._id, { status: 'cancelled', notes: 'Never paid — closed after two days' }, { where: { status: 'created' }, touch: false });
            out.closed += 1;
        }
    }
    return out;
}

/**
 * Sweep: refunds sent through the gateway and not yet settled. One the gateway
 * has since processed (or refused) is brought up to date; one that never got
 * as far as the gateway — the server stopped between writing the refund and
 * asking for it — is looked for there, and if it is not there it is marked
 * failed, so the money is no longer counted as given back, and the office is told.
 */
async function followRefunds(limit = 40) {
    const { rows } = await pool.query(
        `SELECT r.*, p."paymentId" AS "gatewayPaymentId", p."receiptNumber" FROM "admissionrefunds" r JOIN "${AdmissionPayment.tableName}" p ON p."_id" = r."payment"
          WHERE r."status" = 'pending' AND r."mode" = 'gateway' AND r."createdAt" < now() - interval '2 minutes'
          ORDER BY r."updatedAt" ASC LIMIT $1`, [limit]);
    const out = { checked: 0, processed: 0, failed: 0 };
    for (const r of rows) {
        out.checked += 1;
        let status = null; let refundId = r.gatewayRefundId || ''; let error = '';
        if (refundId) {
            const g = await gateway.refundStatus(r.school, 'admission', refundId);
            if (g.error) { await pool.query(`UPDATE "admissionrefunds" SET "updatedAt" = now() WHERE "_id" = $1`, [r._id]); continue; }
            status = g.status;
        } else {
            const g = await gateway.paymentRefunds(r.school, 'admission', r.gatewayPaymentId);
            if (g.error) { await pool.query(`UPDATE "admissionrefunds" SET "updatedAt" = now() WHERE "_id" = $1`, [r._id]); continue; }
            const found = g.refunds.find((x) => String(x.notes?.refund || '') === String(r._id));
            if (found) { refundId = found.refundId; status = found.status; }
            else { status = 'failed'; error = 'The refund never reached the payment gateway — make it again'; }
        }
        const next = status === 'processed' ? 'processed' : status === 'failed' ? 'failed' : 'pending';
        const { rows: [row] } = await pool.query(
            `UPDATE "admissionrefunds" SET "status" = $2, "gatewayRefundId" = $3, "error" = $4, "processedAt" = CASE WHEN $2 = 'processed' THEN now() ELSE "processedAt" END, "updatedAt" = now()
              WHERE "_id" = $1 AND "status" = 'pending' RETURNING *`, [r._id, next, refundId, error || (next === 'failed' ? 'The gateway did not complete the refund' : '')]);
        if (!row || next === 'pending') continue;
        const { rows: [app] } = await pool.query(`SELECT * FROM "${AdmissionApplication.tableName}" WHERE "_id" = $1`, [r.application]);
        if (!app) continue;
        await refreshStatus(app, r.kind).catch(() => {});
        if (next === 'processed') {
            out.processed += 1;
            events.recordQuietly(app.school, { application: app._id, type: 'payment', action: 'refund_processed', visibility: 'applicant', message: `${fmt.money(r.amount)} refunded on receipt ${r.receiptNumber} — the payment gateway has sent it` });
        } else {
            out.failed += 1;
            events.recordQuietly(app.school, { application: app._id, type: 'payment', action: 'refund_failed', message: `Refund of ${fmt.money(r.amount)} on receipt ${r.receiptNumber} did not go through — ${row.error}` });
            require('./staffAlerts').toAdmins(app.school, {
                title: 'A refund did not go through', body: `${fmt.money(r.amount)} on receipt ${r.receiptNumber} (${app.applicationNumber || 'an application'}): ${row.error}.`,
                link: { type: 'admission.application', entityId: String(app._id) },
            });
        }
    }
    return out;
}

async function markPaid(req, app, pay, gatewayPaymentId) {
    const paid = await withTransaction(async (q) => {
        const number = await receiptNumber(app, q);
        const row = await patch(AdmissionPayment, pay._id, { status: 'paid', paymentId: gatewayPaymentId, receiptNumber: number, paidAt: new Date() }, { where: { status: ['created', 'failed', 'cancelled'] }, q });
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
        // A note in the history was all there was: the office now hears of it, and it is listed under Payments → Refunds owed.
        require('./staffAlerts').toAdmins(app.school, {
            title: 'Money to give back', body: `${fmt.money(b.excess)} more than the ${LABEL[paid.kind]} was received on ${fresh.applicationNumber || 'an application'} (receipt ${paid.receiptNumber}). Refund it from the application's Fees tab.`,
            link: { type: 'admission.application', entityId: String(app._id) },
        });
    }
    return paid;
}

// ── At the office ────────────────────────────────────────────────────────────

async function recordOffline(req, app, input) {
    const kind = input.kind;
    await assertPayable(app, kind);
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
            // A cheque or a draft is money once the bank says so.
            clearance: ['cheque', 'dd'].includes(mode) ? 'pending' : '',
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
    const done = await patch(AdmissionPayment, pay._id, { status: 'void', voidedBy: req.userId, voidReason: why }, { where: { status: 'paid' } });
    if (!done) refuse('The payment changed — refresh and try again', 409);
    await refreshStatus(app, pay.kind);
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'payment', action: 'voided', message: `Receipt ${pay.receiptNumber} (${fmt.money(pay.amount)}) cancelled — ${why}` });
    const unconfirmed = pay.kind === 'admission_fee' ? await unconfirmIfUnpaid(req, app, `Receipt ${pay.receiptNumber} was cancelled — ${why}`) : false;
    return { ok: true, unconfirmed };
}

/**
 * A confirmed admission whose fee is no longer settled — its receipt was
 * cancelled (a bounced cheque) — is not confirmed any more: it goes back to
 * waiting for the fee, the seat still held by its offer until the fee date.
 * It used to stay "Confirmed" with the fee due. An enrolled student is the
 * Fees module's business, and the void is refused there.
 */
async function unconfirmIfUnpaid(req, app, reason) {
    const { rows: [fresh] } = await pool.query(`SELECT * FROM "${AdmissionApplication.tableName}" WHERE "_id" = $1`, [String(app._id)]);
    if (!fresh || fresh.status !== 'confirmed') return false;
    const settings = await settingsSvc.getSettings(fresh.school);
    if (!settings.conversion.requireAdmissionFeePaid) return false;
    const b = await balance(fresh, 'admission_fee');
    if (b.due <= 0) return false;
    const { rows: [r] } = await pool.query(`SELECT "confirmWith" FROM "admissionrounds" WHERE "_id" = $1`, [String(fresh.round)]);
    const plan = r?.confirmWith === 'first' ? await scheduleOf(fresh, b) : null;
    if (plan && plan[0].owing <= 0) return false;      // the first instalment still stands, and that was enough
    const after = [];
    await withTransaction(async (q) => {
        const { rows: [offer] } = await q(`SELECT "_id" FROM "admissionoffers" WHERE "application" = $1 AND "status" = 'confirmed' ORDER BY "issuedAt" DESC LIMIT 1 FOR UPDATE`, [String(fresh._id)]);
        if (offer) await q(`UPDATE "admissionoffers" SET "status" = 'accepted', "updatedAt" = now() WHERE "_id" = $1`, [offer._id]);
        await require('./applications').move(req, fresh, 'payment_pending', { system: true, undo: true, q, after, quiet: true, reason, set: { offerStatus: offer ? 'accepted' : fresh.offerStatus } });
    });
    for (const fn of after) { try { await fn(); } catch (e) { console.error('[admission] after un-confirming:', e.message); } }
    events.recordQuietly(fresh.school, { application: fresh._id, by: req, type: 'payment', action: 'unconfirmed', visibility: 'applicant', message: `The admission is no longer confirmed — ${fmt.money(b.due)} of the admission fee is due again` });
    notify.toApplicant(fresh, 'status_update', { status: 'Admission fee due', remarks: `A payment towards the admission fee could not be kept (${reason}). ${fmt.money(b.due)} is due again — the admission is confirmed once it is paid.` });
    return true;
}

/** The bank has paid a cheque or draft. */
async function clearPayment(req, app, paymentRowId) {
    if (!isId(String(paymentRowId))) refuse('Payment not found', 404);
    const { rows: [row] } = await pool.query(
        `UPDATE "${AdmissionPayment.tableName}" SET "clearance" = 'cleared', "clearedAt" = now(), "clearedBy" = $4, "updatedAt" = now()
          WHERE "_id" = $1 AND "application" = $2 AND "school" = $3 AND "status" = 'paid' AND "clearance" = 'pending' RETURNING *`,
        [String(paymentRowId), String(app._id), String(app.school), String(req.userId)]);
    if (!row) refuse('Only a cheque or draft waiting to clear can be marked cleared', 409);
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'payment', action: 'cleared', message: `${row.mode === 'dd' ? 'Draft' : 'Cheque'} ${row.reference} (receipt ${row.receiptNumber}) cleared` });
    return row;
}

/** Cheques and drafts on this application the bank has not paid yet. */
async function unclearedOn(applicationId, kind = 'admission_fee') {
    const { rows } = await pool.query(
        `SELECT "reference", "mode", "amount", "receiptNumber" FROM "${AdmissionPayment.tableName}" WHERE "application" = $1 AND "kind" = $2 AND "status" = 'paid' AND "clearance" = 'pending'`,
        [String(applicationId), kind]);
    return rows;
}

/**
 * What the school's refund rule gives back on the admission fee today
 * (Settings → Fees → refund rules: so many per cent within so many days of
 * payment). A figure for the office to read in the refund dialog — nothing is
 * refunded by itself. null when the school has set no rule.
 */
async function refundGuide(app) {
    const settings = await settingsSvc.getSettings(app.school);
    const rules = settings.fees.refundRules || [];
    if (!rules.length) return null;
    const { rows: [first] } = await pool.query(
        `SELECT MIN("paidAt") AS at FROM "${AdmissionPayment.tableName}" WHERE "application" = $1 AND "kind" = 'admission_fee' AND "status" = 'paid'`, [String(app._id)]);
    if (!first?.at) return null;
    const days = Math.floor((Date.now() - new Date(first.at).getTime()) / 86400000);
    const rule = rules.find((r) => days <= r.withinDays) || null;
    const b = await balance(app, 'admission_fee');
    const percent = rule ? rule.percent : 0;
    return { days, percent, rule, paid: b.paid, amount: round2((b.paid * percent) / 100), rules };
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
        // `refund` names our row at the gateway, so a refund whose answer was never written down can be found again (followRefunds).
        const g = await gateway.refundPayment(app.school, 'admission', pay.paymentId, amount, { application: String(app._id), refund: String(row._id), reason: why.slice(0, 200) });
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

/**
 * Sweep: an instalment of the admission fee that has passed its date unpaid.
 * The family is told once, and so is the office — the only reminder used to
 * go out before the date, and after it there was silence.
 */
async function instalmentsOverdue(schoolId) {
    const { rows: plans } = await pool.query(
        `SELECT o."_id", o."schedule", o."application" FROM "admissionoffers" o
           JOIN "${AdmissionApplication.tableName}" a ON a."_id" = o."application" AND a."admissionFeeStatus" = 'due' AND a."status" IN ('accepted', 'payment_pending', 'confirmed', 'enrolled')
          WHERE o."school" = $1 AND o."status" IN ('accepted', 'confirmed') AND jsonb_typeof(o."schedule") = 'array' AND jsonb_array_length(o."schedule") > 1
          LIMIT 300`, [String(schoolId)]);
    let n = 0;
    for (const o of plans) {
        const { rows: [app] } = await pool.query(`SELECT * FROM "${AdmissionApplication.tableName}" WHERE "_id" = $1`, [o.application]);
        if (!app) continue;
        for (const part of await scheduleOf(app) || []) {
            if (part.owing <= 0 || !part.dueAt || new Date(part.dueAt).getTime() > Date.now() - 12 * 3600 * 1000) continue;
            const { rowCount } = await pool.query(
                `UPDATE "admissionoffers" SET "schedule" = jsonb_set("schedule", ARRAY[$2::text, 'overdueAt'], to_jsonb(now()::text))
                  WHERE "_id" = $1 AND ("schedule" -> $3::int ->> 'overdueAt') IS NULL`, [o._id, String(part.index), part.index]);
            if (!rowCount) continue;
            notify.toApplicant(app, 'instalment_overdue', { fee_amount: fmt.money(part.owing), payment_deadline: fmt.fmtDate(part.dueAt), admission_deadline: fmt.fmtDate(part.dueAt), offer_deadline: fmt.fmtDate(part.dueAt) });
            events.recordQuietly(app.school, { application: app._id, type: 'payment', action: 'instalment_overdue', message: `${part.label}: ${fmt.money(part.owing)} was due on ${fmt.fmtDate(part.dueAt)} and is unpaid` });
            require('./staffAlerts').aboutApplication(app, {
                title: `Instalment overdue: ${app.studentName || app.applicationNumber}`,
                body: `${part.label} of the admission fee — ${fmt.money(part.owing)} — was due on ${fmt.fmtDate(part.dueAt)} and has not been paid.`,
            });
            n += 1;
        }
    }
    return n;
}

/** Everything about an application's fees, for the applicant and the office. */
async function summary(app) {
    const [a, b] = await Promise.all([balance(app, 'application_fee'), balance(app, 'admission_fee')]);
    const { rows: payments } = await pool.query(
        `SELECT "_id", "kind", "amount", "mode", "status", "receiptNumber", "reference", "paidAt", "createdAt", "voidReason", "orderId", "clearance", "clearedAt"
           FROM "${AdmissionPayment.tableName}" WHERE "application" = $1 AND "status" NOT IN ('created', 'cancelled') ORDER BY "createdAt" DESC`, [String(app._id)]);
    const { rows: [open] } = await pool.query(`SELECT "_id", "kind", "amount", "orderId", "createdAt", "checkedAt" FROM "${AdmissionPayment.tableName}" WHERE "application" = $1 AND "status" = 'created' AND "mode" = 'online' ORDER BY "createdAt" DESC LIMIT 1`, [String(app._id)]);
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
        refundGuide: await refundGuide(app).catch(() => null),
    };
}

/** The gateway as the applicant's page may see it (never a secret). */
async function gatewayInfo(schoolId) {
    const school = await School.findById(schoolId).select('paymentGateway').lean();
    return gateway.publicGateway(school?.paymentGateway, 'admission');
}

module.exports = {
    KINDS, LABEL, OFFLINE_MODES, REFUND_MODES, balance, feeStatus, refreshStatus, payableKind, assertPayable, createOrder, verifyOnline, reconcile, recordOffline, voidPayment,
    applyWaiver, removeWaiver, summary, gatewayInfo, refund, scheduleOf, planFor,
    reconcileLatest, reconcileOpen, followRefunds, clearPayment, unclearedOn, refundGuide, unconfirmIfUnpaid, instalmentsOverdue,
};
