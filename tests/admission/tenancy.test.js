'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * School A's people try to reach School B's records by changing ids in URLs
 * and bodies. Every attempt must look exactly like "not found" (or be
 * refused) — and change nothing.
 */
describe('admission — one school never reaches another', () => {
    let A; let B; let pa; let pb; let appB; let guestA; let guestB; let examB; let docB; let listB;
    before(async () => {
        await H.startServer();
        A = await H.makeSchool('Iso-A');
        B = await H.makeSchool('Iso-B');
        pa = await H.openPortal(A);
        pb = await H.openPortal(B);
        const roundA = await H.makeRound(A, pa.form);
        const roundB = await H.makeRound(B, pb.form);
        guestA = await H.registerGuest(A, pa.slug);
        guestB = await H.registerGuest(B, pb.slug);
        await H.submittedApplication(A, guestA, roundA);
        appB = await H.submittedApplication(B, guestB, roundB);
        docB = (await H.q(`SELECT "_id" FROM "admissiondocuments" WHERE "application" = $1 LIMIT 1`, [appB._id]))[0]._id;
        const e = await H.api('POST', '/admission/admin/exams', { token: B.adminToken, body: { round: roundB._id, name: 'B Test', mode: 'offline', classes: [B.classes[0]._id], subjects: [{ name: 'Maths', maxMarks: 50 }], startsAt: new Date(Date.now() + 86400000) } });
        examB = e.body.data;
        const l = await H.api('POST', '/admission/admin/lists', { token: B.adminToken, body: { round: roundB._id, class: B.classes[0]._id, criteria: { filters: { statuses: ['submitted'] } } } });
        listB = l.body.data.list;
    });
    after(() => H.finish());

    const notFound = (r, label) => assert.ok([403, 404].includes(r.status), `${label}: answered ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

    it('an administrator of A cannot read or change B\'s applications, documents or payments', async () => {
        const t = A.adminToken;
        notFound(await H.api('GET', `/admission/admin/applications/${appB._id}`, { token: t }), 'detail');
        notFound(await H.api('POST', `/admission/admin/applications/${appB._id}/transition`, { token: t, body: { to: 'under_review' } }), 'transition');
        notFound(await H.api('POST', `/admission/admin/applications/${appB._id}/notes`, { token: t, body: { text: 'peek' } }), 'note');
        notFound(await H.api('PUT', `/admission/admin/applications/${appB._id}/answers`, { token: t, body: { data: { studentName: 'Hacked' }, reason: 'x' } }), 'correct');
        notFound(await H.api('POST', `/admission/admin/applications/${appB._id}/payments`, { token: t, body: { kind: 'application_fee', amount: 1, mode: 'cash' } }), 'payment');
        notFound(await H.api('GET', `/admission/admin/documents/${docB}/file`, { token: t }), 'document file');
        notFound(await H.api('POST', `/admission/admin/documents/${docB}/review`, { token: t, body: { decision: 'verify' } }), 'document review');
        notFound(await H.api('POST', `/admission/admin/applications/${appB._id}/convert`, { token: t, body: {} }), 'convert');
        const list = await H.api('GET', '/admission/admin/applications', { token: t });
        assert.ok(list.body.data.every((a) => a._id !== appB._id), 'B never appears in A\'s list');
        const bulk = await H.api('POST', '/admission/admin/applications/bulk', { token: t, body: { ids: [appB._id], action: 'transition', to: 'under_review' } });
        assert.equal(bulk.body.data.done, 0);
        const still = (await H.q(`SELECT "status", "studentName" FROM "admissionapplications" WHERE "_id" = $1`, [appB._id]))[0];
        assert.equal(still.status, 'submitted');
        assert.equal(still.studentName, 'Riya Sharma');
    });

    it('an administrator of A cannot reach B\'s exams, results, lists, forms, rounds or templates', async () => {
        const t = A.adminToken;
        notFound(await H.api('GET', `/admission/admin/exams/${examB._id}`, { token: t }), 'exam');
        notFound(await H.api('PUT', `/admission/admin/exams/${examB._id}`, { token: t, body: { name: 'Hacked' } }), 'exam update');
        notFound(await H.api('GET', `/admission/admin/exams/${examB._id}/results`, { token: t }), 'results');
        notFound(await H.api('POST', `/admission/admin/exams/${examB._id}/results/publish`, { token: t, body: {} }), 'publish');
        notFound(await H.api('GET', `/admission/admin/lists/${listB._id}`, { token: t }), 'list');
        notFound(await H.api('POST', `/admission/admin/lists/${listB._id}/approve`, { token: t }), 'list approve');
        notFound(await H.api('GET', `/admission/admin/forms/${pb.form._id}`, { token: t }), 'form');
        notFound(await H.api('PUT', `/admission/admin/forms/${pb.form._id}/draft`, { token: t, body: { schema: { sections: [] } } }), 'form draft');
        const rounds = await H.api('GET', '/admission/admin/rounds', { token: t });
        assert.ok(rounds.body.data.every((r) => String(r.school) === String(A.id)));
        notFound(await H.api('PUT', `/admission/admin/rounds/${rounds.body.data[0]._id}x`, { token: t, body: {} }), 'bad id');
        // Templates are per school: A's edit does not touch B's wording.
        await H.api('PUT', '/admission/admin/emails/application_submitted', { token: t, body: { subject: 'A only {{application_number}}', body: 'Hello from A' } });
        const bEmails = await H.api('GET', '/admission/admin/emails', { token: B.adminToken });
        const bSub = bEmails.body.data.find((e) => e.event === 'application_submitted');
        assert.ok(!bSub.subject.startsWith('A only'));
        // A school id in a body is never trusted: a round "for" B is created in A.
        const r = await H.api('POST', '/admission/admin/rounds', { token: t, body: { name: 'Sneaky', school: B.id, academicYear: B.year._id, classes: [] } });
        assert.equal(r.status, 400, 'B\'s academic year is not A\'s');
    });

    it('settings, the portal address and analytics stay with each school', async () => {
        const taken = await H.api('PUT', '/admission/admin/settings/slug', { token: A.adminToken, body: { slug: pb.slug } });
        assert.equal(taken.status, 400);
        await H.api('PUT', '/admission/admin/settings', { token: A.adminToken, body: { portal: { title: 'School A Admissions' } } });
        const bPortal = await H.api('GET', `/admission/public/portals/${pb.slug}`);
        assert.notEqual(bPortal.body.data.portal.title, 'School A Admissions');
        const an = await H.api('GET', '/admission/admin/analytics', { token: A.adminToken });
        assert.equal(an.body.data.kpis.total, 1, 'A counts only its own application');
    });

    it('an applicant of A cannot reach B\'s portal API or another family\'s application', async () => {
        notFound(await H.api('GET', `/admission/portal/applications/${appB._id}`, { token: guestA.token }), 'portal detail');
        notFound(await H.api('GET', `/admission/portal/applications/${appB._id}/documents/${docB}/file`, { token: guestA.token }), 'portal file');
        notFound(await H.api('PUT', `/admission/portal/applications/${appB._id}`, { token: guestA.token, body: { data: {} } }), 'portal save');
        // The same school, another family.
        const neighbour = await H.registerGuest(B, pb.slug);
        notFound(await H.api('GET', `/admission/portal/applications/${appB._id}`, { token: neighbour.token }), 'neighbour detail');
        notFound(await H.api('POST', `/admission/portal/applications/${appB._id}/withdraw`, { token: neighbour.token, body: {} }), 'neighbour withdraw');
        const theirs = await H.api('GET', '/admission/portal/applications', { token: neighbour.token });
        assert.equal(theirs.body.data.length, 0);
        // A's applicant session does not open B's portal sign-in either.
        const login = await H.api('POST', `/admission/public/portals/${pb.slug}/login`, { body: { email: guestA.email, password: 'Applicant123' } });
        assert.equal(login.status, 403);
        assert.equal(login.body.code, 'NO_APPLICANT_ACCOUNT');
    });

    it('a teacher of A cannot evaluate B\'s exam', async () => {
        notFound(await H.api('GET', `/admission/admin/exams/${examB._id}/results`, { token: A.teacherToken }), 'teacher results');
        notFound(await H.api('PUT', `/admission/admin/exams/${examB._id}/marks`, { token: A.teacherToken, body: { rows: [] } }), 'teacher marks');
    });
});
