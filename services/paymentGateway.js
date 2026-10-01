'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  The school's payment gateway, shared by every module that takes money.
//
//  It used to live on FeeSettings, which made sense while fees were the only
//  thing being paid for. Library fines and hostel fees are payable too, so the credentials
//  sit on the School alongside SMTP — one account, configured once — and
//  `modules` decides which modules are allowed to charge through it.
//
//  Everything here refuses rather than guesses: a module that is not switched
//  on gets a clear "not available", never a half-configured checkout.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const School = require('../models/School');

/** Modules that may be granted use of the gateway. */
const GATEWAY_MODULES = ['fees', 'library', 'hostel'];
/** How each module's payments are named in a message a payer may read. */
const MODULE_WORDS = { fees: 'fees', library: 'library fines', hostel: 'hostel fees' };

/**
 * Resolves the gateway for one module.
 * @returns {{ok: true, gateway: object}} when it is configured and permitted,
 *          {{ok: false, reason: string}} otherwise — the reason is safe to show.
 */
async function resolveGateway(schoolId, moduleKey) {
    if (!GATEWAY_MODULES.includes(moduleKey)) return { ok: false, reason: 'Unknown module' };

    const school = await School.findById(schoolId).select('paymentGateway modules').lean();
    const gw = school?.paymentGateway;

    if (!gw?.enabled) return { ok: false, reason: 'Online payment is not switched on for this school' };
    if (!gw.modules?.[moduleKey])
        return { ok: false, reason: `Online payment is not switched on for ${MODULE_WORDS[moduleKey]}` };

    if (gw.provider === 'razorpay') {
        if (!gw.razorpayKeyId || !gw.razorpayKeySecret)
            return { ok: false, reason: 'The payment gateway is missing its credentials' };
    } else if (gw.provider === 'stripe') {
        if (!gw.stripePublishableKey || !gw.stripeSecretKey)
            return { ok: false, reason: 'The payment gateway is missing its credentials' };
    } else {
        return { ok: false, reason: 'Online payment is not available — no gateway is configured' };
    }

    return { ok: true, gateway: gw };
}

/** What a client may see: never the secret. */
function publicGateway(gw, moduleKey) {
    if (!gw?.enabled || !gw.modules?.[moduleKey]) return { enabled: false, provider: 'none' };
    const configured = gw.provider === 'razorpay' ? !!gw.razorpayKeyId
                     : gw.provider === 'stripe'   ? !!gw.stripePublishableKey
                     : false;
    return {
        enabled: configured,
        provider: configured ? gw.provider : 'none',
        keyId: gw.provider === 'razorpay' ? gw.razorpayKeyId : (gw.stripePublishableKey || ''),
        currency: gw.currency || 'INR',
        currencySymbol: gw.currencySymbol || '₹',
    };
}

/**
 * Opens a Razorpay order for `amount` (in rupees). The receipt reference is
 * short by necessity — Razorpay caps it at 40 characters.
 */
async function createOrder(schoolId, moduleKey, amount, reference) {
    const resolved = await resolveGateway(schoolId, moduleKey);
    if (!resolved.ok) return { error: resolved.reason };

    const rupees = Number(amount);
    if (!Number.isFinite(rupees) || rupees <= 0) return { error: 'Enter an amount greater than zero' };

    const { gateway } = resolved;
    if (gateway.provider !== 'razorpay')
        return { error: 'This module checks out through Razorpay; the school has a different gateway configured' };

    const Razorpay = require('razorpay');
    const rzp = new Razorpay({ key_id: gateway.razorpayKeyId, key_secret: gateway.razorpayKeySecret });

    const order = await rzp.orders.create({
        amount: Math.round(rupees * 100),           // paise
        currency: gateway.currency || 'INR',
        receipt: String(reference || `${moduleKey}-${Date.now()}`).slice(0, 40),
    });

    return {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: gateway.razorpayKeyId,
    };
}

/**
 * Confirms a Razorpay callback really came from Razorpay.
 *
 * The signature is an HMAC of `orderId|paymentId` keyed with the account
 * secret, so a client cannot forge one without it. Compared in constant time —
 * a plain `!==` leaks how much of the signature matched.
 */
async function verifySignature(schoolId, moduleKey, { orderId, paymentId, signature }) {
    const resolved = await resolveGateway(schoolId, moduleKey);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    if (resolved.gateway.provider !== 'razorpay')
        return { ok: false, reason: 'This payment did not come from the configured gateway' };
    if (!orderId || !paymentId || !signature) return { ok: false, reason: 'The payment response was incomplete' };

    const expected = crypto
        .createHmac('sha256', resolved.gateway.razorpayKeySecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    const matches = a.length === b.length && crypto.timingSafeEqual(a, b);

    return matches
        ? { ok: true, gateway: resolved.gateway }
        : { ok: false, reason: 'We could not verify this payment. Nothing has been charged twice — please contact the school office.' };
}

/** A Razorpay client for one module of one school, or the reason there is none. */
async function client(schoolId, moduleKey) {
    const resolved = await resolveGateway(schoolId, moduleKey);
    if (!resolved.ok) return { error: resolved.reason };
    if (resolved.gateway.provider !== 'razorpay') return { error: 'This module checks out through Razorpay; the school has a different gateway configured' };
    const Razorpay = require('razorpay');
    return { rzp: new Razorpay({ key_id: resolved.gateway.razorpayKeyId, key_secret: resolved.gateway.razorpayKeySecret }) };
}

/**
 * What the gateway knows about an order: the payment that was captured for it,
 * if any. This is how a payment is found when the payer's browser never came
 * back to say so — the gateway is asked, rather than waiting to be told.
 * @returns {{paid: boolean, paymentId?: string, amount?: number} | {error: string}}
 */
async function orderPayment(schoolId, moduleKey, orderId) {
    const c = await client(schoolId, moduleKey);
    if (c.error) return { error: c.error };
    try {
        const list = await c.rzp.orders.fetchPayments(orderId);
        const captured = (list?.items || []).find((p) => p.status === 'captured');
        return captured ? { paid: true, paymentId: captured.id, amount: captured.amount / 100 } : { paid: false };
    } catch (e) {
        return { error: e?.error?.description || e?.message || 'The gateway could not be reached' };
    }
}

/**
 * Send money back to the card or account a payment came from.
 * @returns {{refundId: string, status: string} | {error: string}}
 */
async function refundPayment(schoolId, moduleKey, paymentId, amount, notes = {}) {
    const c = await client(schoolId, moduleKey);
    if (c.error) return { error: c.error };
    const rupees = Number(amount);
    if (!paymentId || !Number.isFinite(rupees) || rupees <= 0) return { error: 'A payment and an amount greater than zero are required' };
    try {
        const r = await c.rzp.payments.refund(paymentId, { amount: Math.round(rupees * 100), notes });
        return { refundId: r.id, status: r.status };
    } catch (e) {
        return { error: e?.error?.description || e?.message || 'The gateway refused the refund' };
    }
}

module.exports = { GATEWAY_MODULES, resolveGateway, publicGateway, createOrder, verifySignature, orderPayment, refundPayment };
