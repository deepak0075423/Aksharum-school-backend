'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * The admission fee in instalments (the first enough to confirm, when the
 * round says so), refunds (recorded at the counter; a gateway's refusal kept
 * as a refusal), and a link to pay without signing in.
 */
describe('admission — instalments, refunds and payment links', () => {
    let s; let portal; let round; let fam; let app; let offerId;
    const appRow = async (id) => (await H.q(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [id]))[0];
    const fees = async (id) => (await H.api('GET', `/admission/admin/applications/${id}`, { token: s.adminToken })).body.data.fees.admission;
    const pay = (id, amount, extra = {}) => H.api('POST', `/admission/admin/applications/${id}/payments`, { token: s.adminToken, body: { kind: 'admission_fee', amount, mode: 'cash', ...extra } });

    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Fees');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 10, admissionFee: 2000 });
    });
    after(() => H.finish());

    it('takes an instalment plan only when it adds up', async () => {
        const save = (body) => H.api('PUT', `/admission/admin/rounds/${round._id}`, { token: s.adminToken, body: { ...round, ...body } });
        assert.equal((await save({ instalments: [{ label: 'All', percent: 100 }] })).status, 400, 'one instalment is no plan');
        assert.equal((await save({ instalments: [{ label: 'First', percent: 40 }, { label: 'Second', percent: 50, dueDays: 30 }] })).status, 400, '90% is not the whole fee');
        assert.equal((await save({ instalments: [{ label: 'First', percent: 40 }, { label: 'Second', percent: 30, dueDays: 30 }, { label: 'Third', percent: 30, dueDays: 20 }] })).status, 400, 'each later than the last');
        const ok = await save({ instalments: [{ label: 'On joining', percent: 40 }, { label: 'Before term', percent: 60, dueDays: 30 }], confirmWith: 'first' });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        round = ok.body.data;
        assert.deepEqual(round.instalments.map((x) => [x.percent, x.dueDays]), [[40, 0], [60, 30]]);
    });

    it('splits the fee on the offer, and confirms once the first instalment is paid', async () => {
        fam = await H.registerGuest(s, portal.slug);
        app = await H.submittedApplication(s, fam, round, { answers: { studentName: 'Kabir Malhotra', studentDob: '2021-03-13' } });
        await H.verifyAllDocs(s, app._id);
        const o = await H.api('POST', `/admission/admin/applications/${app._id}/offer`, { token: s.adminToken, body: {} });
        assert.equal(o.status, 201, JSON.stringify(o.body));
        offerId = o.body.data.offer._id;
        await H.api('POST', `/admission/portal/applications/${app._id}/offer/respond`, { token: fam.token, body: { accept: true } });
        let f = await fees(app._id);
        assert.deepEqual(f.schedule.map((x) => [x.label, x.amount, x.status]), [['On joining', 800, 'due'], ['Before term', 1200, 'due']]);
        const early = await H.api('POST', `/admission/admin/applications/${app._id}/confirm`, { token: s.adminToken });
        assert.equal(early.status, 409);
        assert.match(early.body.message, /first instalment of the admission fee \(₹800\) is not paid/);
        assert.equal((await pay(app._id, 800)).status, 201);
        f = await fees(app._id);
        assert.deepEqual(f.schedule.map((x) => x.status), ['paid', 'due']);
        assert.equal(f.due, 1200);
        const c = await H.api('POST', `/admission/admin/applications/${app._id}/confirm`, { token: s.adminToken });
        assert.equal(c.status, 200, JSON.stringify(c.body));
        assert.equal((await appRow(app._id)).admissionFeeStatus, 'due', 'the rest is still owed');
    });

    it('reminds of each later instalment once — and never lapses an offer whose first instalment came in time', async () => {
        const sweep = require('../../services/admission/sweep');
        const selection = require('../../services/admission/selection');
        const settingsSvc = require('../../services/admission/settings');
        await H.q(`UPDATE "admissionoffers" SET "schedule" = jsonb_set("schedule", '{1,dueAt}', to_jsonb((now() + interval '1 day')::text)) WHERE "_id" = $1`, [offerId]);
        const settings = await settingsSvc.getSettings(s.id, { fresh: true });
        await sweep.paymentReminders(s.id, settings);
        await sweep.paymentReminders(s.id, settings);
        await new Promise((r) => setTimeout(r, 400));
        const sent = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionemaillogs" WHERE "school" = $1 AND "event" = 'payment_reminder' AND "application" = $2`, [s.id, app._id]);
        assert.equal(sent[0].n, 1, 'the second instalment, once');
        // A second family on the plan: first instalment paid, the fee date passed — the offer stands.
        const g2 = await H.registerGuest(s, portal.slug);
        const a2 = await H.submittedApplication(s, g2, round, { answers: { studentName: 'Lata Menon', studentDob: '2021-04-14' } });
        await H.verifyAllDocs(s, a2._id);
        await H.api('POST', `/admission/admin/applications/${a2._id}/offer`, { token: s.adminToken, body: {} });
        await H.api('POST', `/admission/portal/applications/${a2._id}/offer/respond`, { token: g2.token, body: { accept: true } });
        await pay(a2._id, 800);
        await H.q(`UPDATE "admissionoffers" SET "feeDueAt" = now() - interval '1 hour' WHERE "application" = $1`, [a2._id]);
        await selection.expireDue();
        assert.notEqual((await appRow(a2._id)).status, 'offer_expired', 'the first instalment kept it');
    });

    it('refunds at the counter — never more than was paid — and a closed application\'s fee reads "refunded"', async () => {
        const [p] = await H.q(`SELECT "_id" FROM "admissionpayments" WHERE "application" = $1 AND "status" = 'paid' LIMIT 1`, [app._id]);
        const refund = (body) => H.api('POST', `/admission/admin/applications/${app._id}/payments/${p._id}/refund`, { token: s.adminToken, body });
        assert.equal((await refund({ amount: 300, mode: 'cash' })).status, 400, 'a reason');
        assert.equal((await refund({ amount: 900, mode: 'cash', reason: 'Too much' })).status, 400, 'more than the payment');
        assert.equal((await refund({ amount: 300, mode: 'cheque', reason: 'Uniform cost adjusted' })).status, 400, 'a cheque needs its number');
        const ok = await refund({ amount: 300, mode: 'cash', reason: 'Uniform cost adjusted' });
        assert.equal(ok.status, 201, JSON.stringify(ok.body));
        let f = await fees(app._id);
        assert.deepEqual([f.paid, f.refunded, f.due], [500, 300, 1500]);
        assert.equal((await H.api('POST', `/admission/admin/applications/${app._id}/payments/${p._id}/void`, { token: s.adminToken, body: { reason: 'Mistake' } })).status, 409, 'refunded money is not voided');
        // A withdrawn applicant given everything back.
        const g3 = await H.registerGuest(s, portal.slug);
        const a3 = await H.submittedApplication(s, g3, round, { answers: { studentName: 'Manav Sethi', studentDob: '2021-05-15' } });
        await H.verifyAllDocs(s, a3._id);
        await H.api('POST', `/admission/admin/applications/${a3._id}/offer`, { token: s.adminToken, body: {} });
        await H.api('POST', `/admission/portal/applications/${a3._id}/offer/respond`, { token: g3.token, body: { accept: true } });
        await pay(a3._id, 800);
        await H.api('POST', `/admission/portal/applications/${a3._id}/withdraw`, { token: g3.token, body: { reason: 'Moving to another city' } });
        const [p3] = await H.q(`SELECT "_id" FROM "admissionpayments" WHERE "application" = $1 AND "status" = 'paid'`, [a3._id]);
        assert.equal((await H.api('POST', `/admission/admin/applications/${a3._id}/payments/${p3._id}/refund`, { token: s.adminToken, body: { amount: 800, mode: 'bank_transfer', reference: 'NEFT123', reason: 'Withdrawn before term' } })).status, 201);
        assert.equal((await appRow(a3._id)).admissionFeeStatus, 'refunded');
        await new Promise((r) => setTimeout(r, 300));
        const mail = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionemaillogs" WHERE "application" = $1 AND "event" = 'payment_refunded'`, [a3._id]);
        assert.equal(mail[0].n, 1, 'the family is told');
    });

    it('records a refund the gateway refuses as refused — the money still counted as paid', async () => {
        await H.q(`UPDATE "schools" SET "paymentGateway" = $2::jsonb WHERE "_id" = $1`, [s.id, JSON.stringify({ enabled: true, provider: 'razorpay', razorpayKeyId: 'rzp_test_invalid', razorpayKeySecret: 'not-a-real-secret', currency: 'INR', modules: { admission: true } })]);
        const pid = H.uuid();
        await H.insert('admissionpayments', { _id: pid, school: s.id, application: app._id, applicant: fam.user._id, kind: 'admission_fee', amount: 1200, mode: 'online', status: 'paid', gateway: 'razorpay', orderId: `order_${H.rand()}`, paymentId: `pay_${H.rand()}`, receiptNumber: `T${H.rand()}`, paidAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
        const before = await fees(app._id);
        const r = await H.api('POST', `/admission/admin/applications/${app._id}/payments/${pid}/refund`, { token: s.adminToken, body: { amount: 100, reason: 'Testing a refusal' } });
        assert.equal(r.status, 502, JSON.stringify(r.body));
        assert.equal(r.body.code, 'REFUND_FAILED');
        const [row] = await H.q(`SELECT "status", "error" FROM "admissionrefunds" WHERE "payment" = $1`, [pid]);
        assert.equal(row.status, 'failed');
        assert.ok(row.error);
        const afterF = await fees(app._id);
        assert.equal(afterF.paid, before.paid, 'nothing counted as given back');
    });

    it('lets a family pay by a signed link — which says little, and only pays', async () => {
        const g4 = await H.registerGuest(s, portal.slug);
        const a4 = await H.submittedApplication(s, g4, round, { answers: { studentName: 'Neha Kulkarni', studentDob: '2021-06-16' } });
        await H.verifyAllDocs(s, a4._id);
        await H.api('POST', `/admission/admin/applications/${a4._id}/offer`, { token: s.adminToken, body: {} });
        const mk = await H.api('POST', `/admission/admin/applications/${a4._id}/pay-link`, { token: s.adminToken, body: { kind: 'admission_fee', send: true } });
        assert.equal(mk.status, 201, JSON.stringify(mk.body));
        const token = mk.body.data.url.split('/pay/')[1];
        const view = await H.api('GET', `/admission/public/portals/${portal.slug}/pay/${token}`);
        assert.equal(view.status, 200, JSON.stringify(view.body));
        assert.deepEqual([view.body.data.studentFirstName, view.body.data.due, view.body.data.nextInstalment?.amount], ['Neha', 2000, 800]);
        assert.ok(!JSON.stringify(view.body).includes('Kulkarni') && !JSON.stringify(view.body).includes('9876'), 'no surname, no phone');
        const tampered = `${token.slice(0, 10)}${token[10] === 'A' ? 'B' : 'A'}${token.slice(11)}`;
        assert.equal((await H.api('GET', `/admission/public/portals/${portal.slug}/pay/${tampered}`)).status, 404);
        const other = await H.makeSchool('Fees-B');
        const otherPortal = await H.openPortal(other);
        assert.equal((await H.api('GET', `/admission/public/portals/${otherPortal.slug}/pay/${token}`)).status, 404, 'not at another school\'s address');
        const old = require('../../services/admission/payLink').make({ _id: a4._id, school: s.id }, 'admission_fee', -1).token;
        assert.equal((await H.api('GET', `/admission/public/portals/${portal.slug}/pay/${old}`)).status, 410);
        await new Promise((r) => setTimeout(r, 300));
        const mail = (await H.q(`SELECT "body" FROM "admissionemaillogs" WHERE "application" = $1 AND "event" = 'payment_link'`, [a4._id]))[0];
        assert.ok(mail && mail.body.includes(`/pay/${token}`), 'the link was emailed');
    });
});
