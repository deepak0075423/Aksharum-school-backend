'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * What an Indian application asks the same way everywhere: the state from the
 * list, a PIN that finds its place, the national student IDs (PEN, APAAR) and
 * the previous school's UDISE+ code — checked on the server, and carried into
 * the student record at enrolment.
 */
describe('admission — states, PIN codes and school IDs', () => {
    let s; let portal; let round;
    const PIN = '999990';   // no such PIN in India Post's list; the test's own directory row

    before(async () => {
        await H.q(`DELETE FROM "pincodes" WHERE "pincode" = $1`, [PIN]).catch(() => {});
        await H.startServer();
        await H.q(`INSERT INTO "pincodes" ("_id", "pincode", "officeName", "officeType", "district", "state", "createdAt", "updatedAt")
                   VALUES (gen_random_uuid(), $1, 'TEST NAGAR SO', 'SO', 'TEST DISTRICT', 'UTTAR PRADESH', now(), now())`, [PIN]);
        s = await H.makeSchool('IndForms');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 5 });
    });
    after(async () => {
        await H.q(`DELETE FROM "pincodes" WHERE "pincode" = $1`, [PIN]).catch(() => {});
        await H.finish();
    });

    it('takes the state only from the list, and PEN, APAAR and UDISE+ only as their digits', async () => {
        const g = await H.registerGuest(s, portal.slug);
        const c = await H.api('POST', '/admission/portal/applications', { token: g.token, body: { round: round._id, class: s.classes[0]._id } });
        const save = await H.api('PUT', `/admission/portal/applications/${c.body.data._id}`, {
            token: g.token,
            body: { data: H.goodAnswers({ state: 'Maha', penNumber: '12345', apaarId: '12345678901', attendedPreviousSchool: 'Yes', previousSchoolName: 'Green Valley School', previousUdise: '0945' }) },
        });
        assert.equal(save.status, 200);
        assert.deepEqual(Object.keys(save.body.errors).sort(), ['apaarId', 'penNumber', 'previousUdise', 'state'], JSON.stringify(save.body.errors));
        assert.match(save.body.errors.penNumber, /11-digit PEN/);
        assert.match(save.body.errors.apaarId, /12-digit APAAR/);
    });

    it('looks a PIN up — the directory first — and says when nobody knows it', async () => {
        const r = await H.api('GET', `/admission/public/pincodes/${PIN}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual([r.body.data.state, r.body.data.district, r.body.data.areas[0], r.body.data.source], ['Uttar Pradesh', 'Test District', 'Test Nagar', 'directory']);
        assert.equal((await H.api('GET', '/admission/public/pincodes/12345')).status, 400);
        assert.equal((await H.api('GET', '/admission/public/pincodes/012345')).status, 400, 'no PIN starts with 0');
    });

    it('guesses a state offline only where the PIN\'s digits settle it', () => {
        const { stateFromPincode } = require('../../utils/indiaStates');
        assert.equal(stateFromPincode('793001'), 'Meghalaya', 'circle 79 is the whole north-east, not only Arunachal');
        assert.equal(stateFromPincode('403001'), 'Goa');
        assert.equal(stateFromPincode('248001'), 'Uttarakhand');
        assert.equal(stateFromPincode('834001'), 'Jharkhand');
        assert.equal(stateFromPincode('737101'), 'Sikkim');
        assert.equal(stateFromPincode('160017'), '', 'Chandigarh and Mohali share 160 — no guess');
        assert.equal(stateFromPincode('411001'), 'Maharashtra');
    });

    it('carries PEN, APAAR and the previous school\'s codes into the student record', async () => {
        const g = await H.registerGuest(s, portal.slug);
        const draft = await H.api('POST', '/admission/portal/applications', { token: g.token, body: { round: round._id, class: s.classes[0]._id } });
        const id = draft.body.data._id;
        const answers = H.goodAnswers({
            studentName: 'Ojas Pathak', studentDob: '2021-02-11', penNumber: '12345678901', apaarId: '123456789012', state: 'Uttar Pradesh',
            attendedPreviousSchool: 'Yes', previousSchoolName: 'Green Valley School', previousUdise: '09450100101', tcNumber: 'TC-2026-17', tcDate: '2026-04-30',
        });
        assert.deepEqual((await H.api('PUT', `/admission/portal/applications/${id}`, { token: g.token, body: { data: answers } })).body.errors, {});
        // A child coming from another school brings the last report card too.
        for (const d of ['photo', 'birth_certificate', 'address_proof', 'report_card']) assert.equal((await H.uploadDoc(g.token, id, d)).status, 201);
        const sub = await H.api('POST', `/admission/portal/applications/${id}/submit`, { token: g.token, body: {} });
        assert.equal(sub.status, 200, JSON.stringify(sub.body));
        const a = sub.body.data;
        await H.verifyAllDocs(s, a._id);
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/offer`, { token: s.adminToken, body: {} })).status, 201);
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/offer/respond`, { token: s.adminToken, body: { accept: true, note: 'At the counter' } })).status, 200);
        const c = await H.api('POST', `/admission/admin/applications/${a._id}/confirm`, { token: s.adminToken });
        assert.equal(c.status, 200, JSON.stringify(c.body));
        const conv = await H.api('POST', `/admission/admin/applications/${a._id}/convert`, {
            token: s.adminToken,
            body: { studentEmail: `kid-${H.rand()}@kids.test`, parent: { mode: 'new', relation: 'Father', name: 'Raghav Pathak', email: `dad-${H.rand()}@family.test`, phone: '9811100033' } },
        });
        assert.equal(conv.status, 200, JSON.stringify(conv.body));
        const [p] = await H.q(`SELECT sp."penNumber", sp."apaarId", sp."previousSchoolUdise", sp."tcNumber", sp."tcDate", sp."state", sp."isTransferStudent"
                                 FROM "studentprofiles" sp JOIN "users" u ON u."_id" = sp."user" WHERE u."name" = 'Ojas Pathak' AND sp."school" = $1`, [s.id]);
        assert.deepEqual([p.penNumber, p.apaarId, p.previousSchoolUdise, p.tcNumber, p.state, p.isTransferStudent], ['12345678901', '123456789012', '09450100101', 'TC-2026-17', 'Uttar Pradesh', true]);
        assert.equal(new Date(p.tcDate).toISOString().slice(0, 10), '2026-04-30');
    });
});
