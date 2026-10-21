'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Enquiries as the office works them: written down at the counter, owned,
 * followed up on a date (the owner is reminded once), every contact logged,
 * linked to the account when the person registers — and each source of
 * families set against what the school spent on it.
 */
describe('admission — enquiries and sources', () => {
    let s; let portal; let walkIn;
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Crm');
        portal = await H.openPortal(s, { settings: { portal: { status: 'open', enquiries: true } } });
    });
    after(() => H.finish());

    it('writes down a walk-in, owned by whoever took it', async () => {
        assert.equal((await H.api('POST', '/admission/admin/enquiries', { token: s.adminToken, body: { name: 'Sunita Rao' } })).status, 400, 'an email or a mobile');
        const r = await H.api('POST', '/admission/admin/enquiries', { token: s.adminToken, body: { name: 'Sunita Rao', phone: '9812345670', email: 'sunita.rao@family.test', class: s.classes[0]._id, message: 'Asked about the bus to Sector 21', source: 'walk_in' } });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        walkIn = r.body.data;
        assert.equal(walkIn.assignedTo, s.admin._id);
        assert.equal(walkIn.status, 'contacted');
        assert.equal(walkIn.interactions.length, 1);
    });

    it('follows up on a date — the owner is reminded once — and logs each contact', async () => {
        const pub = await H.api('POST', `/admission/public/portals/${portal.slug}/enquiries`, { body: { name: 'Imran Qureshi', email: 'imran@family.test', message: 'Do you have seats in Class 1?', source: 'newspaper' } });
        assert.equal(pub.status, 200, JSON.stringify(pub.body));
        const list = (await H.api('GET', '/admission/admin/enquiries?assignedTo=none', { token: s.adminToken })).body;
        const e = list.data.find((x) => x.name === 'Imran Qureshi');
        assert.equal(e.source, 'newspaper');
        assert.equal((await H.api('PATCH', `/admission/admin/enquiries/${e._id}`, { token: s.adminToken, body: { assignedTo: s.teacher._id, priority: 'hot' } })).status, 200);
        const call = await H.api('POST', `/admission/admin/enquiries/${e._id}/interactions`, { token: s.adminToken, body: { kind: 'call', outcome: 'no_answer', nextFollowUpAt: new Date(Date.now() - 60e3) } });
        assert.equal(call.status, 201, JSON.stringify(call.body));
        assert.equal(call.body.data.status, 'contacted');
        const due = (await H.api('GET', '/admission/admin/enquiries?due=overdue', { token: s.adminToken })).body;
        assert.equal(due.due.overdue, 1);
        assert.deepEqual(due.data.map((x) => x.name), ['Imran Qureshi']);
        const crm = require('../../services/admission/crm');
        assert.equal(await crm.followUpReminders(s.id), 1);
        assert.equal(await crm.followUpReminders(s.id), 0, 'once');
        await new Promise((r) => setTimeout(r, 400));
        const [n] = await H.q(`SELECT COUNT(*)::int AS n FROM "notifications" WHERE "school" = $1 AND "title" LIKE 'Follow up the enquiry%'`, [s.id]);
        assert.equal(n.n, 1);
        assert.equal((await H.api('POST', `/admission/admin/enquiries/${e._id}/interactions`, { token: s.adminToken, body: { kind: 'telepathy', text: 'x' } })).status, 400);
    });

    it('links the enquiry when the person registers with the same email', async () => {
        await H.registerGuest(s, portal.slug, { name: 'Sunita Rao', email: 'sunita.rao@family.test' });
        await new Promise((r) => setTimeout(r, 300));
        const [e] = await H.q(`SELECT "status", "applicant" FROM "admissionenquiries" WHERE "_id" = $1`, [walkIn._id]);
        assert.equal(e.status, 'registered');
        assert.ok(e.applicant);
    });

    it('sets each source\'s spend against what it brought: cost per application and per admission', async () => {
        assert.equal((await H.api('PUT', '/admission/admin/sources', { token: s.adminToken, body: { source: 'News Paper!', amount: 100 } })).status, 400);
        assert.equal((await H.api('PUT', '/admission/admin/sources', { token: s.adminToken, body: { source: 'newspaper', label: 'Times of India ad', amount: 5000 } })).status, 200);
        assert.equal((await H.api('PUT', '/admission/admin/sources', { token: s.adminToken, body: { source: 'newspaper', label: 'Times of India ad', amount: 6000 } })).status, 200, 'updated, not doubled');
        // A family that registered from the newspaper link applies: the application carries the source.
        const round = await H.makeRound(s, portal.form, { seats1: 5 });
        const g = await H.registerGuest(s, portal.slug);
        await H.q(`UPDATE "admissionapplicants" SET "source" = 'newspaper' WHERE "user" = $1`, [g.user._id]);
        await H.submittedApplication(s, g, round, { answers: { studentName: 'Nisha Iyer', studentDob: '2021-08-08' } });
        const rep = (await H.api('GET', '/admission/admin/sources', { token: s.adminToken })).body.data;
        const news = rep.rows.find((x) => x.source === 'newspaper');
        assert.deepEqual([news.enquiries, news.applications, news.spend, news.costPerApplication], [1, 1, 6000, 6000]);
        assert.equal(news.costPerAdmission, null, 'no admission yet — no made-up figure');
        const [{ n }] = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionsourcespends" WHERE "school" = $1`, [s.id]);
        assert.equal(n, 1);
    });
});
