'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Paying a hostel bill, and the receipt that follows.
//
//  Three kinds of payer reach this: a student for their own bills, a parent for
//  a child's, and a member of staff who lives in the hostel for their own. All
//  go through the same steps — see what is owed, open an order, confirm it —
//  and all can pull any receipt of theirs afterwards, whether it was paid
//  online or handed over at the hostel office.
//
//  The work is in services/hostelPayments.js; this file only decides WHOSE
//  bills a request may touch.
// ─────────────────────────────────────────────────────────────────────────────
const HostelFeeInvoice   = require('../models/HostelFeeInvoice');
const HostelPaymentOrder = require('../models/HostelPaymentOrder');
const School             = require('../models/School');
const ReceiptTemplate    = require('../models/ReceiptTemplate');

const designations   = require('../services/designationService');
const paymentGateway = require('../services/paymentGateway');
const pay            = require('../services/hostelPayments');
const { renderReceipt, defaultTemplate } = require('../services/receiptRenderer');
const { ok, bad, fail, getSettings, childIdsOfParent, visibleHostelIds, signedPayPath, checkPaySig } = require('../services/hostelService');

const handle = (res, e) => (e?.status ? bad(res, e.message, e.status) : fail(res, e));

/**
 * Whose bills the caller may see or pay. A student or a teacher acts for
 * themselves only; a parent for a child on their own profile — checked here,
 * never taken from the request.
 */
async function resolveSubject(req) {
    const asked = req.query.student || req.body?.student;
    if (req.userRole === 'parent') {
        const children = await childIdsOfParent(req.userId);
        if (!children.length) return { ok: false, status: 404, message: 'No child is linked to this account' };
        const target = asked ? String(asked) : children[0];
        if (!children.includes(target)) return { ok: false, status: 403, message: 'That student is not linked to your account' };
        return { ok: true, userId: target, onBehalf: true, children };
    }
    if (asked && String(asked) !== String(req.userId)) return { ok: false, status: 403, message: 'You can only pay your own hostel bills' };
    return { ok: true, userId: String(req.userId) };
}

const invoiceRow = (i) => ({
    _id: i._id, invoiceNumber: i.invoiceNumber, feeType: i.feeType, period: i.period, label: pay.feeLabel(i),
    amount: i.amount, discount: i.discount, lateFee: i.lateFee, netAmount: i.netAmount, paidAmount: i.paidAmount,
    refundedAmount: i.refundedAmount, outstanding: pay.outstandingOf(i), dueDate: i.dueDate,
    // The stored status only moves when the invoice is saved (or the half-hourly
    // clock gets to it); past its due date and unpaid is overdue, whatever it says.
    status: i.status === 'pending' && i.dueDate && new Date(i.dueDate) < new Date() ? 'overdue' : i.status,
    createdAt: i.createdAt,
});

// ── What is owed ─────────────────────────────────────────────────────────────
exports.mySummary = async (req, res) => {
    try {
        const subject = await resolveSubject(req);
        if (!subject.ok) return bad(res, subject.message, subject.status);

        // A checkout that was opened and never confirmed may have been paid all
        // the same (the browser closed, the signal dropped). Ask the gateway
        // before showing what is owed, so nobody is told to pay twice.
        const stuck = await HostelPaymentOrder.exists({ school: req.schoolId, student: subject.userId, status: 'created', createdAt: { $lt: new Date(Date.now() - 2 * 60000) } });
        if (stuck) await pay.reconcileOpen(req, { studentId: subject.userId, limit: 3 }).catch(() => null);

        const since = new Date(Date.now() - 24 * 36e5);
        const [school, invoices, settings, resident, openOrders] = await Promise.all([
            School.findById(req.schoolId).select('paymentGateway').lean(),
            HostelFeeInvoice.find({ school: req.schoolId, student: subject.userId }).sort('-createdAt').limit(300).lean(),
            getSettings(req.schoolId),
            pay.residentCard(req.schoolId, subject.userId),
            HostelPaymentOrder.countDocuments({ school: req.schoolId, student: subject.userId, status: 'created', createdAt: { $gte: since } }),
        ]);
        const live = invoices.filter((i) => i.status !== 'cancelled');
        const pending = live.filter((i) => pay.PAYABLE.includes(i.status) && pay.outstandingOf(i) > 0);
        const settled = live.filter((i) => !pending.includes(i));

        ok(res, {
            resident,
            pending: pending.map(invoiceRow).sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0)),
            settled: settled.map(invoiceRow),
            billed: pay.round2(live.reduce((s, i) => s + (i.netAmount || 0), 0)),
            paid: pay.round2(live.reduce((s, i) => s + (i.paidAmount || 0), 0)),
            outstanding: pay.round2(pending.reduce((s, i) => s + pay.outstandingOf(i), 0)),
            overdue: pending.filter((i) => i.status === 'overdue' || (i.dueDate && new Date(i.dueDate) < new Date())).length,
            receipts: pay.receiptsOf(live),
            // Money that came back, each with its voucher.
            refunds: live.flatMap((i) => (i.refunds || []).map((r) => ({ voucherNumber: r.voucherNumber, amount: r.amount, refundedAt: r.refundedAt,
                mode: r.mode, reference: r.reference, reason: r.reason, label: pay.feeLabel(i) })))
                .sort((a, b) => new Date(b.refundedAt) - new Date(a.refundedAt)),
            // A checkout opened in the last day and never confirmed: the money
            // may or may not have moved, so it is shown as something to check.
            pendingOrders: openOrders,
            // Whether paying online is offered at all, and with which key.
            gateway: paymentGateway.publicGateway(school?.paymentGateway, 'hostel'),
            offlineModes: pay.OFFLINE_MODES.map((m) => pay.MODE_LABEL[m]),
            // A teacher at a school that does not charge its staff sees why
            // there is nothing to pay, rather than an empty table.
            freeForStaff: resident.kind === 'teacher' && !settings.chargeTeachers,
            payingFor: subject.onBehalf ? subject.userId : null,
        });
    } catch (e) { handle(res, e); }
};

// ── Open an order ────────────────────────────────────────────────────────────
exports.createOrder = async (req, res) => {
    try {
        const subject = await resolveSubject(req);
        if (!subject.ok) return bad(res, subject.message, subject.status);
        const order = await pay.openOrder(req, { studentId: subject.userId, invoiceIds: req.body.invoiceIds });
        // The phone has no browser of its own to run the gateway's checkout in:
        // it opens this page instead (see checkoutPage below).
        ok(res, { ...order, checkoutPath: signedPayPath(order.orderId) });
    } catch (e) {
        if (!e?.status) console.error('[hostel] createOrder:', e);
        handle(res, e?.status ? e : new Error(e?.error?.description || e?.message || 'Could not start the payment'));
    }
};

// ── Confirm it ───────────────────────────────────────────────────────────────
exports.confirmPayment = async (req, res) => {
    try {
        const subject = await resolveSubject(req);
        if (!subject.ok) return bad(res, subject.message, subject.status);
        const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
        ok(res, await pay.confirmOrder(req, { studentId: subject.userId, orderId, paymentId, signature }));
    } catch (e) {
        if (!e?.status) console.error('[hostel] confirmPayment:', e);
        handle(res, e);
    }
};

// ── Checkout for a payer without a browser session (the phone app) ──────────
/**
 * The app opens an order, then opens this page in the system browser. The page
 * runs the gateway's checkout and reports the result to checkoutConfirm; the
 * app, when the browser closes, asks checkMyPayment what became of the order —
 * so a payment is recorded whether or not the page lived to report it.
 *
 * Neither the page nor its confirmation carries a login. What stands in for one
 * is the signed, short-lived link the order was handed out with, and then the
 * gateway's own signature on the payment: the link alone can pay a bill, never
 * mark one paid.
 */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function payPage(res, { title, body, script = '', nonce = '' }) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    // This one page loads the gateway's script and frame; nothing else may.
    res.setHeader('Content-Security-Policy', [
        "default-src 'none'", "style-src 'unsafe-inline'", "img-src https: data:",
        `script-src 'nonce-${nonce}' https://checkout.razorpay.com`,
        'frame-src https://api.razorpay.com https://checkout.razorpay.com',
        "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com https://checkout.razorpay.com",
        "form-action 'none'", "base-uri 'none'",
    ].join('; '));
    return res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f5fb;color:#10143a}
main{max-width:420px;margin:0 auto;padding:40px 22px;text-align:center}h1{font-size:1.25rem;margin:0 0 8px}p{color:#5b6385;line-height:1.5;margin:0 0 18px}
.amt{font-size:2rem;font-weight:700;margin:14px 0}button{font:inherit;font-weight:600;color:#fff;background:#4f46e5;border:0;border-radius:10px;padding:13px 26px}
.ok{color:#15803d}.bad{color:#b42318}</style></head><body><main>${body}</main>${script}</body></html>`);
}

exports.checkoutPage = async (req, res) => {
    try {
        const orderId = String(req.params.orderId || '');
        if (!checkPaySig(orderId, req.query.exp, req.query.sig)) {
            return payPage(res.status(403), { title: 'Link expired', body: '<h1 class="bad">This payment link has expired</h1><p>Go back to the app and start the payment again.</p>' });
        }
        const order = await HostelPaymentOrder.findOne({ orderId }).lean();
        if (!order) return payPage(res.status(404), { title: 'Not found', body: '<h1 class="bad">Payment not found</h1><p>Go back to the app and start the payment again.</p>' });
        if (order.status === 'paid') {
            return payPage(res, { title: 'Paid', body: `<h1 class="ok">Already paid</h1><p>Receipt ${esc(order.receiptNumber)}. You can close this page and return to the app.</p>` });
        }
        const school = await School.findById(order.school).select('name paymentGateway').lean();
        const gw = paymentGateway.publicGateway(school?.paymentGateway, 'hostel');
        if (!gw.enabled || gw.provider !== 'razorpay') {
            return payPage(res.status(400), { title: 'Unavailable', body: '<h1 class="bad">Online payment is not available</h1><p>Please pay at the hostel office.</p>' });
        }
        const nonce = require('crypto').randomBytes(16).toString('base64');
        const confirmUrl = `${req.baseUrl}/pay/${encodeURIComponent(orderId)}/confirm?exp=${encodeURIComponent(req.query.exp)}&sig=${encodeURIComponent(req.query.sig)}`;
        const options = {
            key: gw.keyId, order_id: orderId, amount: Math.round(order.amount * 100), currency: gw.currency || 'INR',
            name: school?.name || 'Hostel fees', description: `${(order.lines || []).length} hostel invoice(s)`,
        };
        return payPage(res, {
            title: 'Pay hostel fees', nonce,
            body: `<h1>Hostel fees</h1><p>${esc(school?.name || '')}</p><div class="amt">${esc(gw.currencySymbol || '₹')}${esc(Number(order.amount).toLocaleString('en-IN'))}</div>
<p id="msg">${esc((order.lines || []).map((l) => l.invoiceNumber).join(', '))}</p><button id="pay" type="button">Pay now</button>`,
            script: `<script nonce="${nonce}" src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script nonce="${nonce}">(function(){var msg=document.getElementById('msg'),btn=document.getElementById('pay');
function say(c,t){msg.className=c;msg.textContent=t;}
var o=${inScript(options)};
o.handler=function(r){btn.style.display='none';say('','Recording your payment…');
fetch(${inScript(confirmUrl)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(r)})
.then(function(x){return x.json();}).then(function(j){
if(j&&j.success){say('ok','Paid'+(j.data&&j.data.receiptNumber?' — receipt '+j.data.receiptNumber:'')+'. You can close this page and return to the app.');}
else{say('bad',(j&&j.message)||'We could not confirm the payment. Return to the app — it will check with the bank.');}})
.catch(function(){say('bad','We could not confirm the payment from here. Return to the app — it will check with the bank.');});};
o.modal={ondismiss:function(){say('','Payment not completed. Tap Pay now to try again, or close this page.');}};
function open(){try{new Razorpay(o).open();}catch(e){say('bad','The payment window could not be opened. Please try again.');}}
btn.addEventListener('click',open);open();})();</script>`,
        });
    } catch (e) { return fail(res, e); }
};

exports.checkoutConfirm = async (req, res) => {
    try {
        const orderId = String(req.params.orderId || '');
        if (!checkPaySig(orderId, req.query.exp, req.query.sig)) return bad(res, 'This payment link has expired', 403);
        const order = await HostelPaymentOrder.findOne({ orderId }).lean();
        if (!order) return bad(res, 'Payment not found', 404);
        const { razorpay_order_id: paidOrder, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
        if (paidOrder !== orderId) return bad(res, 'This payment does not belong to this order');
        // Recorded as the person who opened the order; the gateway's signature is what proves it was paid.
        const as = { schoolId: String(order.school), userId: String(order.openedBy), userRole: order.openedByRole, headers: req.headers, ip: req.ip };
        ok(res, await pay.confirmOrder(as, { studentId: order.student, orderId, paymentId, signature }));
    } catch (e) {
        if (!e?.status) console.error('[hostel] checkoutConfirm:', e);
        handle(res, e);
    }
};

/** "What became of my payment?" — asked by the app when its browser closes. The gateway is asked if nobody has said. */
exports.checkMyPayment = async (req, res) => {
    try {
        const subject = await resolveSubject(req);
        if (!subject.ok) return bad(res, subject.message, subject.status);
        const orderId = String(req.body?.orderId || '');
        const order = await HostelPaymentOrder.findOne({ school: req.schoolId, orderId }).select('student').lean();
        if (!order || String(order.student) !== String(subject.userId)) return bad(res, 'This payment was not opened from this account', 404);
        const r = await pay.reconcileOrder(req, orderId);
        // An unreachable gateway is not a failed payment: say "not known yet".
        ok(res, { status: r.status, receiptNumber: r.receiptNumber || null, unapplied: r.unapplied || 0, unknown: !!r.error });
    } catch (e) { handle(res, e); }
};

// ── The receipt ──────────────────────────────────────────────────────────────
/**
 * One payment as one document — a counter payment as readily as an online one;
 * the only difference is which design the school chose for that mode.
 *
 * A receipt belongs to the resident it was issued to: they see their own, a
 * parent sees a child's, and the people who run the hostel see any in the
 * hostels they run.
 */
/** Whose documents the caller may open: null = any (in `scope`'s hostels, if a warden). */
async function documentAccess(req) {
    if (req.userRole === 'student') return { students: [String(req.userId)], scope: null };
    if (req.userRole === 'parent') return { students: await childIdsOfParent(req.userId), scope: null };
    if (req.userRole === 'teacher') {
        const access = await designations.requestAccess(req);
        if (access.permissions?.hostel !== designations.ADMIN) {
            // A teacher on a posting reprints for their hostels; one who only lives in reads their own.
            const posted = await visibleHostelIds({ ...req, access });
            return posted && posted.length ? { students: null, scope: posted, self: String(req.userId) } : { students: [String(req.userId)], scope: null };
        }
        return { students: null, scope: null };
    }
    if (req.userRole === 'school_admin') return { students: null, scope: null };
    return null;
}

async function renderDocument(req, res, built) {
    const mode = built.receipt.paymentMode;
    const [school, template] = await Promise.all([
        School.findById(req.schoolId).select('name address logo').lean(),
        ReceiptTemplate.findOne({ school: req.schoolId, module: 'hostel', paymentMode: mode }).lean(),
    ]);
    const origin = `${req.protocol}://${req.get('host')}`;
    const schoolForReceipt = school && {
        name: school.name, address: school.address,
        logoUrl: school.logo ? (/^https?:/.test(school.logo) ? school.logo : `${origin}${school.logo}`) : '',
    };
    // The phone has no HTML surface of its own, so it asks for the data and
    // draws the document natively. A browser gets the rendered page.
    if (String(req.query.format || '').toLowerCase() === 'json') return ok(res, { ...built.receipt, school: schoolForReceipt });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderReceipt(built.receipt, template || defaultTemplate('hostel', mode), { school: schoolForReceipt }));
}

const outOfScope = (who, built) => !!(who.scope && built.owner !== who.self && built.hostel && !who.scope.map(String).includes(String(built.hostel)));

exports.getReceipt = async (req, res) => {
    try {
        const receiptNumber = String(req.params.receiptNumber || '').trim();
        if (!receiptNumber) return bad(res, 'Which receipt?');
        const who = await documentAccess(req);
        if (!who) return bad(res, 'Insufficient permissions', 403);
        const built = await pay.buildReceipt(req.schoolId, receiptNumber, { invoiceId: req.query.invoice || null, students: who.students });
        if (!built || outOfScope(who, built)) return bad(res, 'Receipt not found', 404);
        return await renderDocument(req, res, built);
    } catch (e) { return handle(res, e); }
};

/** A refund, as a voucher — the counterpart of a receipt, for money going the other way. */
exports.getRefundVoucher = async (req, res) => {
    try {
        const voucherNumber = String(req.params.voucherNumber || '').trim();
        if (!voucherNumber) return bad(res, 'Which voucher?');
        const who = await documentAccess(req);
        if (!who) return bad(res, 'Insufficient permissions', 403);
        const built = await pay.buildRefundVoucher(req.schoolId, voucherNumber, { students: who.students });
        if (!built || outOfScope(who, built)) return bad(res, 'Voucher not found', 404);
        return await renderDocument(req, res, built);
    } catch (e) { return handle(res, e); }
};
