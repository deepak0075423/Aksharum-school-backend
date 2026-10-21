'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const H = require('./helpers');

/**
 * Level 2/5 — money: counter payments, receipts, cancellations, waivers,
 * online payments checked by the gateway's signature, and what happens when
 * several of these arrive at the same moment.
 */
const SECRET = 'test_secret_for_signatures';
const sign = (orderId, paymentId) => crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');

describe('admission — level 2: fees, receipts and waivers', () => {
    let s; let portal; let round; const g = []; const app = [];
    const pay = (id, body) => H.api('POST', `/admission/admin/applications/${id}/payments`, { token: s.adminToken, body });
    const fee = async (id) => (await H.api('GET', `/admission/admin/applications/${id}`, { token: s.adminToken })).body.data.fees;
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Money');
        portal = await H.openPortal(s, { settings: {
            applications: { applicationFeeTiming: 'after_submit' },
            fees: { waivers: [
                { key: 'sibling', name: 'Sibling concession', type: 'percent', value: 50, appliesTo: 'application', requiresApproval: false },
                { key: 'staffward', name: 'Staff ward', type: 'amount', value: 200, appliesTo: 'both', requiresApproval: true },
                { key: 'merit', name: 'Merit award', type: 'amount', value: 100, appliesTo: 'application', requiresApproval: false },
            ] },
        } });
        round = await H.makeRound(s, portal.form, { applicationFee: 500, admissionFee: 15000 });
        for (let i = 0; i < 5; i++) {
            g[i] = await H.registerGuest(s, portal.slug);
            app[i] = await H.submittedApplication(s, g[i], round, { answers: { studentName: ['Anu Mehra', 'Biju Nair', 'Charu Lal', 'Dev Anand', 'Ela Bhatt'][i], studentDob: `2021-0${i + 1}-15` } });
        }
    });
    after(() => H.finish());

    it('takes counter payments with what each mode needs — never more than is due, nothing, or a future date', async () => {
        const id = app[0]._id;
        assert.equal((await pay(id, { kind: 'application_fee', amount: 200, mode: 'cheque' })).status, 400, 'a cheque needs its number');
        assert.equal((await pay(id, { kind: 'application_fee', amount: 600, mode: 'cash' })).status, 400, 'more than is due');
        for (const amount of [0, -50, 'abc']) assert.equal((await pay(id, { kind: 'application_fee', amount, mode: 'cash' })).status, 400, `amount ${amount}`);
        assert.equal((await pay(id, { kind: 'application_fee', amount: 100, mode: 'cash', paidAt: new Date(Date.now() + 86400000) })).status, 400, 'future date');
        assert.equal((await pay(id, { kind: 'admission_fee', amount: 100, mode: 'cash' })).status, 409, 'admission fee only after an offer');
        const one = await pay(id, { kind: 'application_fee', amount: 200, mode: 'cash' });
        assert.equal(one.status, 201, JSON.stringify(one.body));
        assert.equal((await fee(id)).application.due, 300);
        const two = await pay(id, { kind: 'application_fee', amount: 300, mode: 'upi', reference: 'UPI12345' });
        assert.equal(two.status, 201);
        const f = await fee(id);
        assert.deepEqual([f.application.paid, f.application.due, f.application.status], [500, 0, 'paid']);
        assert.notEqual(one.body.data.receiptNumber, two.body.data.receiptNumber);
        assert.match(two.body.data.receiptNumber, /^ADR\d{4}\d{5}$/);
    });

    it('cancels a counter receipt with a reason — the money is due again, the receipt says cancelled', async () => {
        const id = app[1]._id;
        const p = (await pay(id, { kind: 'application_fee', amount: 500, mode: 'cash' })).body.data;
        const voidIt = (reason) => H.api('POST', `/admission/admin/applications/${id}/payments/${p._id}/void`, { token: s.adminToken, body: { reason } });
        assert.equal((await voidIt('')).status, 400);
        assert.equal((await voidIt('Entered against the wrong child.')).status, 200);
        assert.equal((await voidIt('Again')).status, 409);
        assert.equal((await fee(id)).application.due, 500);
        const r = await H.api('GET', `/admission/admin/applications/${id}/payments/${p._id}/receipt`, { token: s.adminToken });
        assert.match(r.headers.get('content-type'), /text\/html/);
        assert.ok(r.body.toString().includes('CANCELLED'));
    });

    it('shows a family their own receipts — and nobody else\'s', async () => {
        const [p] = await H.q(`SELECT "_id", "receiptNumber" FROM "admissionpayments" WHERE "application" = $1 AND "status" = 'paid' LIMIT 1`, [app[0]._id]);
        const mine = await H.api('GET', `/admission/portal/applications/${app[0]._id}/payments/${p._id}/receipt`, { token: g[0].token });
        assert.equal(mine.status, 200);
        assert.ok(mine.body.toString().includes(p.receiptNumber));
        const json = await H.api('GET', `/admission/portal/applications/${app[0]._id}/payments/${p._id}/receipt?format=json`, { token: g[0].token });
        assert.equal(json.body.data.number, p.receiptNumber);
        assert.equal((await H.api('GET', `/admission/portal/applications/${app[0]._id}/payments/${p._id}/receipt`, { token: g[2].token })).status, 404);
        assert.equal((await H.api('GET', `/admission/portal/applications/${app[2]._id}/payments/${p._id}/receipt`, { token: g[2].token })).status, 404, 'a payment of another application');
    });

    it('grants only the school\'s waivers, each with a reason, on the fee it applies to', async () => {
        const id = app[2]._id;
        const waive = (body) => H.api('POST', `/admission/admin/applications/${id}/waivers`, { token: s.adminToken, body });
        assert.equal((await waive({ kind: 'application_fee', waiverKey: 'sibling' })).status, 400, 'a reason is required');
        assert.equal((await waive({ kind: 'application_fee', waiverKey: 'made_up', reason: 'x' })).status, 400);
        assert.equal((await waive({ kind: 'admission_fee', waiverKey: 'sibling', reason: 'Elder sister in Class 4' })).status, 400, 'sibling is for the application fee');
        const ok = await waive({ kind: 'application_fee', waiverKey: 'sibling', reason: 'Elder sister in Class 4' });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.data.waiver.amount, 250);
        assert.equal((await waive({ kind: 'application_fee', waiverKey: 'sibling', reason: 'again' })).status, 409);
        assert.equal((await fee(id)).application.due, 250);
        const rm = await H.api('POST', `/admission/admin/applications/${id}/waivers/remove`, { token: s.adminToken, body: { kind: 'application_fee', waiverKey: 'sibling', reason: 'Sister has left the school.' } });
        assert.equal(rm.status, 200);
        assert.equal((await fee(id)).application.due, 500);
    });

    it('never takes more than is due when two counter payments arrive at once', async () => {
        const id = app[3]._id;
        const results = await Promise.all(Array.from({ length: 5 }, () => pay(id, { kind: 'application_fee', amount: 500, mode: 'cash' })));
        assert.equal(results.filter((r) => r.status === 201).length, 1, `statuses: ${results.map((r) => r.status).join(',')}`);
        const [t] = await H.q(`SELECT COALESCE(SUM("amount"), 0)::float8 AS paid FROM "admissionpayments" WHERE "application" = $1 AND "status" = 'paid'`, [id]);
        assert.equal(t.paid, 500);
    });

    it('keeps every waiver granted at the same moment — none silently lost, never more than the fee', async () => {
        const id = app[4]._id;
        const res = await Promise.all(['sibling', 'merit'].map((k) => H.api('POST', `/admission/admin/applications/${id}/waivers`, { token: s.adminToken, body: { kind: 'application_fee', waiverKey: k, reason: 'Granted at the counter' } })));
        const granted = res.filter((r) => r.status === 200).length;
        const [row] = await H.q(`SELECT "feeWaivers" FROM "admissionapplications" WHERE "_id" = $1`, [id]);
        assert.equal(row.feeWaivers.length, granted, `granted ${granted}, kept ${row.feeWaivers.length}`);
        const total = row.feeWaivers.reduce((sum, w) => sum + Number(w.amount), 0);
        assert.ok(total <= 500);
    });

    it('online: no gateway means no order; a forged confirmation is refused; a signed one is recorded once', async () => {
        const id = app[1]._id;
        const order = await H.api('POST', `/admission/portal/applications/${id}/pay`, { token: g[1].token, body: { kind: 'application_fee' } });
        assert.equal(order.status, 409);
        assert.equal(order.body.code, 'GATEWAY_UNAVAILABLE');
        await H.q(`UPDATE "schools" SET "paymentGateway" = $2::jsonb WHERE "_id" = $1`, [s.id, JSON.stringify({ enabled: true, provider: 'razorpay', razorpayKeyId: 'rzp_test_key', razorpayKeySecret: SECRET, currency: 'INR', modules: { admission: true } })]);
        const orderId = `order_${H.rand()}`;
        await H.insert('admissionpayments', { _id: H.uuid(), school: s.id, application: id, applicant: g[1].user._id, kind: 'application_fee', amount: 500, mode: 'online', status: 'created', gateway: 'razorpay', orderId, createdAt: new Date(), updatedAt: new Date() });
        const again = await H.api('POST', `/admission/portal/applications/${id}/pay`, { token: g[1].token, body: { kind: 'application_fee' } });
        assert.equal(again.status, 200, JSON.stringify(again.body));
        assert.equal(again.body.data.orderId, orderId, 'a second tab gets the same open order, not a new one');
        assert.equal(again.body.data.keyId, 'rzp_test_key');
        assert.ok(!JSON.stringify(again.body).includes(SECRET), 'never the secret');
        const verify = (body) => H.api('POST', `/admission/portal/applications/${id}/pay/verify`, { token: g[1].token, body });
        const forged = await verify({ razorpay_order_id: orderId, razorpay_payment_id: 'pay_fake1', razorpay_signature: 'f'.repeat(64) });
        assert.equal(forged.status, 400);
        assert.equal((await fee(id)).application.status, 'due', 'nothing is marked paid on a browser\'s word');
        const real = await verify({ razorpay_order_id: orderId, razorpay_payment_id: 'pay_real1', razorpay_signature: sign(orderId, 'pay_real1') });
        assert.equal(real.status, 200, JSON.stringify(real.body));
        assert.equal(real.body.data.status, 'paid');
        const replay = await verify({ razorpay_order_id: orderId, razorpay_payment_id: 'pay_real1', razorpay_signature: sign(orderId, 'pay_real1') });
        assert.equal(replay.body.data.receiptNumber, real.body.data.receiptNumber, 'the same confirmation twice records one payment');
        assert.equal((await fee(id)).application.status, 'paid');
        const second = `order_${H.rand()}`;
        await H.insert('admissionpayments', { _id: H.uuid(), school: s.id, application: id, applicant: g[1].user._id, kind: 'application_fee', amount: 500, mode: 'online', status: 'created', gateway: 'razorpay', orderId: second, createdAt: new Date(), updatedAt: new Date() });
        const reused = await verify({ razorpay_order_id: second, razorpay_payment_id: 'pay_real1', razorpay_signature: sign(second, 'pay_real1') });
        assert.equal(reused.status, 409, 'one gateway payment pays one order');
        const [p] = await H.q(`SELECT "_id" FROM "admissionpayments" WHERE "orderId" = $1`, [orderId]);
        assert.equal((await H.api('POST', `/admission/admin/applications/${id}/payments/${p._id}/void`, { token: s.adminToken, body: { reason: 'x' } })).status, 409, 'an online payment is refunded at the gateway, not cancelled here');
        // Paid twice — cash at the counter, then an old tab's online payment
        // comes through: both are real money, recorded, and the excess flagged.
        const cashApp = app[2]._id;
        await H.api('POST', `/admission/admin/applications/${cashApp}/waivers/remove`, { token: s.adminToken, body: { kind: 'application_fee', waiverKey: 'sibling', reason: 'tidy' } });
        const oldOrder = `order_${H.rand()}`;
        await H.insert('admissionpayments', { _id: H.uuid(), school: s.id, application: cashApp, applicant: g[2].user._id, kind: 'application_fee', amount: 500, mode: 'online', status: 'created', gateway: 'razorpay', orderId: oldOrder, createdAt: new Date(), updatedAt: new Date() });
        assert.equal((await pay(cashApp, { kind: 'application_fee', amount: 500, mode: 'cash' })).status, 201);
        const late = await H.api('POST', `/admission/portal/applications/${cashApp}/pay/verify`, { token: g[2].token, body: { razorpay_order_id: oldOrder, razorpay_payment_id: 'pay_late1', razorpay_signature: sign(oldOrder, 'pay_late1') } });
        assert.equal(late.status, 200);
        const f = await fee(cashApp);
        assert.deepEqual([f.application.paid, f.application.due, f.application.excess], [1000, 0, 500]);
        const office = (await H.api('GET', `/admission/admin/applications/${cashApp}`, { token: s.adminToken })).body.data;
        assert.ok(office.timeline.some((t) => t.action === 'excess' && /refund/.test(t.message)), 'the office is told to refund');
    });

    it('totals the payments list from the payments themselves', async () => {
        const list = (await H.api('GET', '/admission/admin/payments?status=paid', { token: s.adminToken })).body;
        const [t] = await H.q(`SELECT COUNT(*)::int AS n, COALESCE(SUM("amount"), 0)::float8 AS amount FROM "admissionpayments" WHERE "school" = $1 AND "status" = 'paid'`, [s.id]);
        assert.deepEqual([list.total, list.amount], [t.n, t.amount]);
    });
});
