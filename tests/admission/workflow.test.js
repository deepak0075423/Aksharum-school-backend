'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Level 2/3 — an application's journey through the workflow: the moves that
 * are allowed and the ones that are not, reasons families are told, reopening,
 * approvals for staff moves, what staff can see and do, bulk changes,
 * duplicate warnings, corrections, and the family withdrawing or deleting.
 */
const status = async (id) => (await H.q(`SELECT "status" FROM "admissionapplications" WHERE "_id" = $1`, [id]))[0]?.status;

describe('admission — level 2: the workflow, approvals and staff', () => {
    let s; let portal; let round; const g = {}; const app = {};
    const move = (id, body, token) => H.api('POST', `/admission/admin/applications/${id}/transition`, { token: token || s.adminToken, body });
    const staffMove = (id, body) => H.api('POST', `/admission/staff/applications/${id}/transition`, { token: s.teacherToken, body });
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Flow');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 10, seats2: 10 });
        const people = {
            A: { studentName: 'Ira Sen', studentDob: '2021-01-11', religion: 'Hindu', aadhaarNumber: '234567890123', allergies: 'Peanuts' },
            B: { studentName: 'Om Bose', studentDob: '2021-02-12' },
            C: { studentName: 'Pia Roy', studentDob: '2021-03-13' },
            E: { studentName: 'Tara Das', studentDob: '2021-04-14', fatherPhone: '9800011122' },
            F: { studentName: 'Tara Das', studentDob: '2021-04-14', fatherPhone: '9800011122' },
        };
        for (const [k, answers] of Object.entries(people)) {
            g[k] = await H.registerGuest(s, portal.slug);
            app[k] = await H.submittedApplication(s, g[k], round, { answers });
        }
        g.D = await H.registerGuest(s, portal.slug);
        app.D = (await H.api('POST', '/admission/portal/applications', { token: g.D.token, body: { round: round._id, class: s.classes[1]._id } })).body.data;
    });
    after(() => H.finish());

    it('moves an application only along the workflow, and tells the family why when it is sent back', async () => {
        for (const to of ['draft', 'submitted', 'offer_issued', 'confirmed', 'enrolled']) {
            assert.equal((await move(app.A._id, { to })).status, 409, `${to} is set by its own action`);
        }
        assert.equal((await move(app.A._id, { to: 'verified' })).status, 409, 'documents are not verified yet');
        assert.equal((await move(app.A._id, { to: 'under_review' })).status, 200);
        assert.equal((await move(app.A._id, { to: 'incomplete' })).status, 400, 'a reason is required');
        assert.equal((await move(app.A._id, { to: 'incomplete', remarks: 'Please add the mother\'s mobile number.' })).status, 200);
        assert.equal(await status(app.A._id), 'incomplete');
        const fam = (await H.api('GET', `/admission/portal/applications/${app.A._id}`, { token: g.A.token })).body.data;
        assert.ok(fam.editable, 'an incomplete application can be edited again');
        assert.ok(fam.timeline.some((t) => t.message.includes('mother\'s mobile number')), 'the family sees the reason');
        const again = await H.api('POST', `/admission/portal/applications/${app.A._id}/submit`, { token: g.A.token, body: { data: H.goodAnswers({ studentName: 'Ira Sen', studentDob: '2021-01-11', religion: 'Hindu', aadhaarNumber: '234567890123', allergies: 'Peanuts', motherPhone: '9877766554' }) } });
        assert.equal(again.status, 200, JSON.stringify(again.body));
        assert.equal(await status(app.A._id), 'submitted');
        assert.equal(again.body.data.applicationNumber, app.A.applicationNumber, 'resubmitting keeps the number');
        assert.equal((await move(app.D._id, { to: 'under_review' })).status, 409, 'a draft moves on only when submitted');
    });

    it('closes an application for good unless an administrator reopens it', async () => {
        assert.equal((await move(app.B._id, { to: 'rejected' })).status, 400, 'the family is told why');
        assert.equal((await move(app.B._id, { to: 'rejected', remarks: 'The age limit for Class 1 is not met.' })).status, 200);
        assert.equal((await move(app.B._id, { to: 'under_review' })).status, 409, 'closed');
        assert.equal((await move(app.B._id, { to: 'under_review', reopen: true })).status, 200);
        assert.equal(await status(app.B._id), 'under_review');
        const [row] = await H.q(`SELECT "closedReason" FROM "admissionapplications" WHERE "_id" = $1`, [app.B._id]);
        assert.equal(row.closedReason, '');
    });

    it('refuses a move into a stage the school has switched off', async () => {
        const wf = (await H.api('GET', '/admission/admin/workflow', { token: s.adminToken })).body.data.stages;
        const off = wf.map((x) => (x.key === 'eligibility' ? { ...x, enabled: false } : x));
        assert.equal((await H.api('PUT', '/admission/admin/workflow', { token: s.adminToken, body: { stages: off } })).status, 200);
        assert.equal((await move(app.B._id, { to: 'eligible' })).status, 409);
        await H.api('PUT', '/admission/admin/workflow', { token: s.adminToken, body: { stages: wf } });
        assert.equal((await move(app.B._id, { to: 'eligible' })).status, 200);
    });

    it('sends a staff move into a stage that needs approval to an administrator, who approves or declines it', async () => {
        assert.equal((await H.api('PATCH', `/admission/admin/applications/${app.C._id}/assign`, { token: s.adminToken, body: { userId: s.teacher._id } })).status, 200);
        assert.equal((await staffMove(app.C._id, { to: 'under_review' })).status, 200, 'no approval needed for review');
        const ask = await staffMove(app.C._id, { to: 'selected', note: 'Strong interview.' });
        assert.equal(ask.status, 200);
        assert.equal(ask.body.data.pending, true);
        assert.equal(await status(app.C._id), 'under_review', 'nothing moves before approval');
        const d = (await H.api('GET', `/admission/admin/applications/${app.C._id}`, { token: s.adminToken })).body.data;
        assert.equal(d.workflow.pending.to, 'selected');
        assert.equal((await H.api('POST', `/admission/admin/applications/${app.C._id}/approval`, { token: s.adminToken, body: { approve: false, note: 'Wait for the list.' } })).status, 200);
        assert.equal(await status(app.C._id), 'under_review');
        await staffMove(app.C._id, { to: 'selected' });
        assert.equal((await H.api('POST', `/admission/admin/applications/${app.C._id}/approval`, { token: s.adminToken, body: { approve: true } })).status, 200);
        assert.equal(await status(app.C._id), 'selected');
        assert.equal((await H.api('POST', `/admission/admin/applications/${app.C._id}/approval`, { token: s.adminToken, body: { approve: true } })).status, 409, 'nothing waiting any more');
    });

    it('lets a stage be handled only by the staff assigned to it', async () => {
        const wf = (await H.api('GET', '/admission/admin/workflow', { token: s.adminToken })).body.data.stages;
        const only = wf.map((x) => (x.key === 'eligibility' ? { ...x, assignees: [s.admin._id] } : x));
        await H.api('PUT', '/admission/admin/workflow', { token: s.adminToken, body: { stages: only } });
        await H.api('PATCH', `/admission/admin/applications/${app.E._id}/assign`, { token: s.adminToken, body: { userId: s.teacher._id } });
        await staffMove(app.E._id, { to: 'under_review' });
        assert.equal((await staffMove(app.E._id, { to: 'eligible' })).status, 409, 'the teacher does not handle eligibility');
        await H.api('PUT', '/admission/admin/workflow', { token: s.adminToken, body: { stages: wf } });
    });

    it('shows staff only what their part needs — no sensitive answers, no office notes, nothing unassigned', async () => {
        await H.api('POST', `/admission/admin/applications/${app.A._id}/notes`, { token: s.adminToken, body: { text: 'Office only: the father works at the school.' } });
        await H.api('PATCH', `/admission/admin/applications/${app.A._id}/assign`, { token: s.adminToken, body: { userId: s.teacher._id } });
        const staff = (await H.api('GET', `/admission/staff/applications/${app.A._id}`, { token: s.teacherToken })).body.data;
        for (const k of ['religion', 'aadhaarNumber', 'allergies']) assert.equal(staff.application.data[k], undefined, `${k} hidden from staff`);
        assert.equal(staff.application.data.studentName, 'Ira Sen');
        assert.ok(!staff.timeline.some((t) => t.message.includes('Office only')), 'office notes stay in the office');
        assert.ok(!JSON.stringify(staff.schema).includes('aadhaarNumber'), 'not even the question');
        const office = (await H.api('GET', `/admission/admin/applications/${app.A._id}`, { token: s.adminToken })).body.data;
        assert.equal(office.application.data.aadhaarNumber, 'XXXX XXXX 0123', 'the office sees it masked (privacy.test.js covers revealing it)');
        const shown = await H.api('POST', `/admission/admin/applications/${app.A._id}/reveal`, { token: s.adminToken, body: { field: 'aadhaarNumber' } });
        assert.equal(shown.body.data.value, '234567890123');
        assert.equal((await H.api('GET', `/admission/staff/applications/${app.B._id}`, { token: s.teacherToken })).status, 404, 'not assigned');
        assert.equal((await staffMove(app.B._id, { to: 'documents_pending', remarks: 'x' })).status, 404);
        const duties = (await H.api('GET', '/admission/staff/duties', { token: s.teacherToken })).body.data;
        assert.ok(duties.applications.some((a) => a._id === app.A._id));
        assert.ok(!duties.applications.some((a) => a._id === app.B._id));
    });

    it('lets reviewers check only their own document types — and never a sensitive one', async () => {
        const types = (await H.api('GET', '/admission/admin/document-types', { token: s.adminToken })).body.data;
        const id = (k) => types.find((t) => t.key === k)._id;
        await H.api('PUT', `/admission/admin/document-types/${id('birth_certificate')}`, { token: s.adminToken, body: { reviewers: [s.teacher._id] } });
        await H.api('PUT', `/admission/admin/document-types/${id('aadhaar')}`, { token: s.adminToken, body: { reviewers: [s.teacher._id] } });
        const up = await H.api('POST', `/admission/admin/applications/${app.A._id}/documents`, { token: s.adminToken, form: H.fileForm({ docType: 'aadhaar' }, { buffer: H.FILES.png, name: 'aadhaar.png', type: 'image/png' }) });
        assert.equal(up.status, 201, JSON.stringify(up.body));
        const queue = (await H.api('GET', '/admission/staff/documents', { token: s.teacherToken })).body.data;
        assert.ok(queue.length > 0 && queue.every((d) => d.docKey === 'birth_certificate'), 'only their type, and not the sensitive one');
        assert.equal((await H.api('POST', `/admission/staff/documents/${queue[0]._id}/review`, { token: s.teacherToken, body: { decision: 'verify' } })).status, 200);
        const [address] = await H.q(`SELECT "_id" FROM "admissiondocuments" WHERE "application" = $1 AND "docKey" = 'address_proof' AND "current"`, [app.A._id]);
        assert.equal((await H.api('POST', `/admission/staff/documents/${address._id}/review`, { token: s.teacherToken, body: { decision: 'verify' } })).status, 404);
        assert.equal((await H.api('GET', `/admission/staff/documents/${up.body.data._id}/file`, { token: s.teacherToken })).status, 404, 'sensitive');
        assert.equal((await H.api('POST', `/admission/staff/documents/${up.body.data._id}/review`, { token: s.teacherToken, body: { decision: 'verify' } })).status, 404, 'sensitive');
    });

    it('changes many applications at once, each on its own merits', async () => {
        const r = await H.api('POST', '/admission/admin/applications/bulk', { token: s.adminToken, body: { ids: [app.B._id, app.D._id, H.uuid()], action: 'transition', to: 'documents_pending', remarks: 'Upload the report card.' } });
        assert.equal(r.status, 200);
        assert.equal(r.body.data.done, 1);
        assert.equal(r.body.data.failed.length, 2);
        assert.equal(await status(app.B._id), 'documents_pending');
        const a = await H.api('POST', '/admission/admin/applications/bulk', { token: s.adminToken, body: { ids: [app.B._id, app.E._id], action: 'assign', userId: s.teacher._id } });
        assert.equal(a.body.data.done, 2);
        assert.equal((await H.api('POST', '/admission/admin/applications/bulk', { token: s.adminToken, body: { ids: [app.B._id], action: 'delete' } })).body.data.failed.length, 1, 'only known actions');
    });

    it('flags a possible duplicate and clears the flag once a person has checked it', async () => {
        const [f] = await H.q(`SELECT "flags" FROM "admissionapplications" WHERE "_id" = $1`, [app.F._id]);
        assert.ok((f.flags?.duplicateOf || []).length >= 1, 'the second Tara Das is flagged');
        const listed = (await H.api('GET', '/admission/admin/applications?duplicates=1', { token: s.adminToken })).body.data;
        assert.ok(listed.some((x) => x._id === app.F._id));
        const dups = (await H.api('GET', `/admission/admin/applications/${app.F._id}/duplicates`, { token: s.adminToken })).body.data;
        assert.ok(dups.some((x) => x._id === app.E._id));
        assert.equal((await H.api('POST', `/admission/admin/applications/${app.F._id}/duplicates/clear`, { token: s.adminToken })).status, 200);
        const after = (await H.api('GET', '/admission/admin/applications?duplicates=1', { token: s.adminToken })).body.data;
        assert.ok(!after.some((x) => x._id === app.F._id));
    });

    it('corrects answers only with a reason and within the form\'s rules, and keeps the history', async () => {
        const fix = (data, reason) => H.api('PUT', `/admission/admin/applications/${app.E._id}/answers`, { token: s.adminToken, body: { data, reason } });
        assert.equal((await fix({ city: 'Mumbai' })).status, 400, 'no reason');
        assert.equal((await fix({ pincode: '12' }, 'Typo')).status, 400, 'not a PIN code');
        assert.equal((await fix({ city: 'Pune' }, 'Same')).status, 400, 'nothing changed');
        assert.equal((await fix({ city: 'Mumbai' }, 'The family moved in March.')).status, 200);
        const fam = (await H.api('GET', `/admission/portal/applications/${app.E._id}`, { token: g.E.token })).body.data;
        assert.equal(fam.application.data.city, 'Mumbai');
        const office = (await H.api('GET', `/admission/admin/applications/${app.E._id}`, { token: s.adminToken })).body.data;
        assert.ok(office.timeline.some((t) => /moved in March/.test(t.message) || /moved in March/.test(JSON.stringify(t.meta || {}))), 'the reason is in the history');
    });

    it('lets a family withdraw once, and delete only a draft never submitted', async () => {
        assert.equal((await H.api('DELETE', `/admission/portal/applications/${app.F._id}`, { token: g.F.token })).status, 409, 'submitted — cannot be deleted');
        assert.equal((await H.api('POST', `/admission/portal/applications/${app.F._id}/withdraw`, { token: g.F.token, body: { reason: 'We are moving to another city.' } })).status, 200);
        assert.equal(await status(app.F._id), 'withdrawn');
        assert.equal((await H.api('POST', `/admission/portal/applications/${app.F._id}/withdraw`, { token: g.F.token, body: { reason: 'Again' } })).status, 409);
        assert.equal((await H.api('DELETE', `/admission/portal/applications/${app.D._id}`, { token: g.D.token })).status, 200);
        assert.equal(await status(app.D._id), undefined, 'the draft is gone');
        assert.equal((await H.api('DELETE', `/admission/portal/applications/${app.E._id}`, { token: g.D.token })).status, 404, 'not theirs');
    });
});
