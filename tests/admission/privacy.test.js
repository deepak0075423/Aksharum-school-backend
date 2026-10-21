'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

/**
 * Data protection (DPDP Act 2023 / Rules 2025): Aadhaar masked and revealed
 * only on purpose (logged), the family's own requests answered in time,
 * consent withdrawn, data erased — never an admitted student's, never one on
 * legal hold — retention applied on its own, and a changed privacy notice
 * agreed to before anything else changes.
 */
const AADHAAR = '234567890123';
const appRow = async (id) => (await H.q(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [id]))[0];

describe('admission — data protection: masking, requests, erasure, retention, consent', () => {
    let s; let portal; let round; let fam; let app; let other;
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Privacy');
        portal = await H.openPortal(s, { settings: { privacy: { requestDays: 200, officer: { name: 'Neha Gupta', email: 'privacy@school.test', phone: '9810011223' } } } });
        round = await H.makeRound(s, portal.form, { seats1: 5 });
        fam = await H.registerGuest(s, portal.slug);
        app = await H.submittedApplication(s, fam, round, { answers: { studentName: 'Tara Bose', aadhaarNumber: AADHAAR } });
        const g2 = await H.registerGuest(s, portal.slug);
        other = await H.submittedApplication(s, g2, round, { answers: { studentName: 'Uday Kapoor', studentDob: '2021-02-02' } });
        other.guest = g2;
    });
    after(() => H.finish());

    it('keeps the settings in bounds and shows families who to ask', async () => {
        const st = (await H.api('GET', '/admission/admin/bootstrap', { token: s.adminToken })).body.data.settings.privacy;
        assert.equal(st.requestDays, 90, 'at most the 90 days the DPDP Rules allow');
        const pub = (await H.api('GET', `/admission/public/portals/${portal.slug}`)).body.data.portal;
        assert.equal(pub.privacyContact.email, 'privacy@school.test');
        assert.equal((await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { privacy: { officer: { name: '<b>x</b>' } } } })).status, 400);
    });

    it('shows the office an Aadhaar number masked — everywhere — until an administrator reveals it, and logs that', async () => {
        const d = (await H.api('GET', `/admission/admin/applications/${app._id}`, { token: s.adminToken })).body.data;
        assert.equal(d.application.data.aadhaarNumber, 'XXXX XXXX 0123');
        assert.deepEqual(d.application.maskedFields, ['aadhaarNumber']);
        const row = d.answers.flatMap((sec) => sec.fields).find((f) => f.key === 'aadhaarNumber');
        assert.equal(row.value, 'XXXX XXXX 0123');
        assert.ok(!JSON.stringify(d).includes(AADHAAR), 'nowhere in the payload');
        const csv = await H.api('GET', '/admission/admin/applications/export?format=csv', { token: s.adminToken });
        assert.ok(!csv.body.toString().includes(AADHAAR), 'not in an export either');
        assert.ok(csv.body.toString().includes('XXXX XXXX 0123'));
        const r = await H.api('POST', `/admission/admin/applications/${app._id}/reveal`, { token: s.adminToken, body: { field: 'aadhaarNumber' } });
        assert.equal(r.status, 200);
        assert.equal(r.body.data.value, AADHAAR);
        assert.equal((await H.api('POST', `/admission/admin/applications/${app._id}/reveal`, { token: s.adminToken, body: { field: 'studentName' } })).status, 400, 'only Aadhaar is masked');
        assert.equal((await H.api('POST', `/admission/admin/applications/${app._id}/reveal`, { token: s.teacherToken, body: { field: 'aadhaarNumber' } })).status, 403);
        await new Promise((res) => setTimeout(res, 200));
        const log = (await H.api('GET', '/admission/admin/privacy/access-log', { token: s.adminToken })).body.data.rows;
        assert.ok(log.some((l) => l.action === 'reveal' && l.field === 'aadhaarNumber' && l.applicationNumber === app.applicationNumber));
        assert.ok(log.some((l) => l.action === 'export'));
    });

    it('does not let a masked number sent back with a correction overwrite the real one', async () => {
        const c = await H.api('PUT', `/admission/admin/applications/${app._id}/answers`, { token: s.adminToken, body: { data: { aadhaarNumber: 'XXXX XXXX 0123', city: 'Nagpur' }, reason: 'Family moved' } });
        assert.equal(c.status, 200, JSON.stringify(c.body));
        const row = await appRow(app._id);
        assert.equal(row.data.aadhaarNumber, AADHAAR);
        assert.equal(row.data.city, 'Nagpur');
    });

    it('gives a family everything held about it — and nothing about anyone else', async () => {
        const r = await H.api('GET', '/admission/portal/privacy/export', { token: fam.token });
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-disposition'), /attachment/);
        const data = r.body;
        assert.equal(data.applications.length, 1);
        assert.equal(data.applications[0].applicationNumber, app.applicationNumber);
        assert.ok(JSON.stringify(data).includes(AADHAAR), 'their own number, in full');
        assert.ok(!JSON.stringify(data).includes('Uday Kapoor'));
        assert.equal(data.consent.privacyNoticeVersion, 1);
    });

    it('takes a family\'s requests, and the office answers each in time', async () => {
        const mk = (body, token = fam.token) => H.api('POST', '/admission/portal/privacy/requests', { token, body });
        assert.equal((await mk({ kind: 'correction', details: 'x' })).status, 400, 'say what needs correcting');
        assert.equal((await mk({ kind: 'nonsense' })).status, 400);
        assert.equal((await mk({ kind: 'access', application: other._id })).status, 404, 'not another family\'s application');
        const c = await mk({ kind: 'correction', details: 'The date of birth should be 2021-03-04, not as written.', application: app._id });
        assert.equal(c.status, 201, JSON.stringify(c.body));
        assert.match(c.body.data.number, /^DPR\d{8}$/);
        const due = new Date(c.body.data.dueAt).getTime() - Date.now();
        assert.ok(due > 89 * 86400e3 && due < 91 * 86400e3, 'due within the school\'s 90 days');
        const list = (await H.api('GET', '/admission/admin/privacy/requests?status=waiting', { token: s.adminToken })).body.data;
        assert.equal(list.counts.waiting, 1);
        const id = list.rows[0]._id;
        assert.equal((await H.api('PATCH', `/admission/admin/privacy/requests/${id}`, { token: s.adminToken, body: { status: 'done' } })).status, 400, 'an answer is needed to close it');
        const done = await H.api('PATCH', `/admission/admin/privacy/requests/${id}`, { token: s.adminToken, body: { status: 'done', response: 'Corrected to 4 March 2021.', internalNote: 'Checked the birth certificate' } });
        assert.equal(done.status, 200);
        const mine = (await H.api('GET', '/admission/portal/privacy', { token: fam.token })).body.data;
        assert.equal(mine.requests[0].response, 'Corrected to 4 March 2021.');
        assert.equal(mine.requests[0].internalNote, undefined, 'the office\'s note stays in the office');
        await new Promise((res) => setTimeout(res, 400));
        const mails = await H.q(`SELECT "event" FROM "admissionemaillogs" WHERE "school" = $1 AND "to" = $2 AND "event" LIKE 'data_request%'`, [s.id, fam.email]);
        assert.deepEqual(mails.map((m) => m.event).sort(), ['data_request_closed', 'data_request_received']);
        const theirs = (await H.api('GET', '/admission/portal/privacy', { token: other.guest.token })).body.data.requests;
        assert.equal(theirs.length, 0);
    });

    it('stops at once when consent is withdrawn — the open application is withdrawn', async () => {
        const g = await H.registerGuest(s, portal.slug);
        const a = await H.submittedApplication(s, g, round, { answers: { studentName: 'Vidya Rao', studentDob: '2021-06-06' } });
        const r = await H.api('POST', '/admission/portal/privacy/requests', { token: g.token, body: { kind: 'withdraw_consent' } });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal((await appRow(a._id)).status, 'withdrawn');
        const root = require('../../services/admission/documents').ROOT;
        const files = (await H.q(`SELECT "file" FROM "admissiondocuments" WHERE "application" = $1`, [a._id])).map((d) => path.join(root, d.file));
        assert.ok(files.length && files.every((f) => fs.existsSync(f)), 'the uploads are on disk to begin with');
        const er = await H.api('POST', `/admission/admin/privacy/requests/${r.body.data._id}/erase`, { token: s.adminToken });
        assert.equal(er.status, 200, JSON.stringify(er.body));
        assert.equal(er.body.data.erased, 1);
        await new Promise((res) => setTimeout(res, 200));
        assert.ok(files.every((f) => !fs.existsSync(f)), 'and gone from the disk after');
        const row = await appRow(a._id);
        assert.ok(row.erasedAt);
        assert.equal(row.studentName, 'Erased applicant');
        assert.deepEqual(row.data, {});
        const docs = await H.q(`SELECT COUNT(*)::int AS n FROM "admissiondocuments" WHERE "application" = $1`, [a._id]);
        assert.equal(docs[0].n, 0);
        const user = (await H.q(`SELECT "email", "isActive" FROM "users" WHERE "_id" = $1`, [g.user._id]))[0];
        assert.match(user.email, /^erased\+/);
        assert.equal(user.isActive, false, 'nothing left: the sign-in is closed');
        const ev = await H.q(`SELECT "message" FROM "admissionevents" WHERE "application" = $1`, [a._id]);
        assert.ok(!ev.some((e) => /Vidya/.test(e.message)), 'no name left in the history');
    });

    it('never erases an admitted student, nor an application on legal hold', async () => {
        const g = await H.registerGuest(s, portal.slug);
        const a = await H.submittedApplication(s, g, round, { answers: { studentName: 'Wasim Ali', studentDob: '2021-07-07' } });
        await H.api('POST', `/admission/admin/applications/${a._id}/transition`, { token: s.adminToken, body: { to: 'rejected', remarks: 'Not eligible for the class' } });
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/legal-hold`, { token: s.adminToken, body: { on: true } })).status, 400, 'a reason is needed');
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/legal-hold`, { token: s.adminToken, body: { on: true, reason: 'Parent has gone to court over the decision' } })).status, 200);
        const r = await H.api('POST', '/admission/portal/privacy/requests', { token: g.token, body: { kind: 'erasure', details: 'Please delete everything' } });
        const er = await H.api('POST', `/admission/admin/privacy/requests/${r.body.data._id}/erase`, { token: s.adminToken });
        assert.equal(er.body.data.erased, 0);
        assert.match(er.body.data.kept[0].why, /legal hold/);
        assert.equal((await appRow(a._id)).erasedAt, null);
        const privacy = require('../../services/admission/privacy');
        await assert.rejects(privacy.eraseApplication({ ...(await appRow(a._id)), status: 'enrolled', legalHold: null }), /student record/);
    });

    it('applies retention on its own: old unsuccessful applications erased, old drafts gone — holds kept', async () => {
        const g = await H.registerGuest(s, portal.slug);
        const old = await H.submittedApplication(s, g, round, { answers: { studentName: 'Xena Paul', studentDob: '2021-08-08' } });
        await H.api('POST', `/admission/admin/applications/${old._id}/transition`, { token: s.adminToken, body: { to: 'rejected', remarks: 'Seats full' } });
        await H.q(`UPDATE "admissionapplications" SET "statusChangedAt" = now() - interval '13 months' WHERE "_id" = $1`, [old._id]);
        const d = (await H.api('POST', '/admission/portal/applications', { token: g.token, body: { round: round._id, class: s.classes[1]._id } })).body.data;
        await H.q(`UPDATE "admissionapplications" SET "lastActivityAt" = now() - interval '200 days', "updatedAt" = now() - interval '200 days' WHERE "_id" = $1`, [d._id]);
        await H.q(`UPDATE "admissionapplications" SET "statusChangedAt" = now() - interval '13 months' WHERE "school" = $1 AND "status" = 'rejected' AND "studentName" = 'Wasim Ali'`, [s.id]);
        const pre = (await H.api('GET', '/admission/admin/privacy/retention', { token: s.adminToken })).body.data;
        assert.equal(pre.unsuccessful, 1, 'the one on hold is not counted');
        assert.equal(pre.drafts, 1);
        assert.equal(pre.onHold, 1);
        const run = await H.api('POST', '/admission/admin/privacy/retention/run', { token: s.adminToken });
        assert.equal(run.status, 200, JSON.stringify(run.body));
        assert.equal(run.body.data.erased, 1);
        assert.equal(run.body.data.drafts, 1);
        assert.ok((await appRow(old._id)).erasedAt);
        assert.equal(await appRow(d._id), undefined, 'the abandoned draft is gone');
        const held = await H.q(`SELECT "erasedAt" FROM "admissionapplications" WHERE "school" = $1 AND "studentName" = 'Wasim Ali'`, [s.id]);
        assert.equal(held[0].erasedAt, null);
        const again = await H.api('POST', '/admission/admin/privacy/retention/run', { token: s.adminToken });
        assert.equal(again.body.data.erased, 0, 'nothing twice');
    });

    it('asks for a changed privacy notice to be agreed to before anything else changes', async () => {
        const cur = (await H.api('GET', '/admission/admin/bootstrap', { token: s.adminToken })).body.data.settings.portal;
        const r = await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { portal: { ...cur, privacyNotice: `${cur.privacyNotice}\n\nWe now also keep your phone number for exam reminders.` } } });
        assert.equal(r.body.data.portal.privacyVersion, 2);
        const save = await H.api('PUT', `/admission/portal/applications/${other._id}`, { token: other.guest.token, body: { data: { city: 'Pune' } } });
        assert.equal(save.status, 409);
        assert.equal(save.body.code, 'CONSENT_REQUIRED');
        assert.equal((await H.api('GET', `/admission/portal/applications/${other._id}`, { token: other.guest.token })).status, 200, 'reading still works');
        assert.equal((await H.api('POST', '/admission/portal/consent', { token: other.guest.token, body: { version: 1 } })).status, 409);
        assert.equal((await H.api('POST', '/admission/portal/consent', { token: other.guest.token, body: { version: 2 } })).status, 200);
        const after = await H.api('POST', `/admission/portal/applications/${other._id}/withdraw`, { token: other.guest.token, body: { reason: 'Moving city' } });
        assert.equal(after.status, 200, JSON.stringify(after.body));
    });
});
