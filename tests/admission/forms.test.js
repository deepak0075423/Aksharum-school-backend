'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('admission — forms, drafts and submission', () => {
    let s; let portal; let round; let guest;
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Forms');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { applicationFee: 0 });
        guest = await H.registerGuest(s, portal.slug);
    });
    after(() => H.finish());

    it('refuses a form whose conditions point forward, whose keys repeat, or that carries markup', async () => {
        const bad = { sections: [{ key: 'one', title: 'One', fields: [
            { key: 'aa', type: 'text', label: 'A', visibleIf: { rules: [{ field: 'bb', op: 'filled' }] } },
            { key: 'bb', type: 'select', label: 'B', options: [{ value: 'x' }] },
            { key: 'bb', type: 'text', label: 'Dup' },
        ] }] };
        const r = await H.api('PUT', `/admission/admin/forms/${portal.form._id}/draft`, { token: s.adminToken, body: { schema: bad } });
        assert.equal(r.status, 400);
        assert.ok(r.body.errors.length >= 3, JSON.stringify(r.body.errors));
        const html = await H.api('PUT', `/admission/admin/forms/${portal.form._id}/draft`, { token: s.adminToken, body: { schema: { sections: [{ key: 'one', title: '<b>One</b>', fields: [] }] } } });
        assert.equal(html.status, 400);
    });

    it('keeps a draft as typed — partial answers, hidden answers and all', async () => {
        const c = await H.api('POST', '/admission/portal/applications', { token: guest.token, body: { round: round._id, class: s.classes[0]._id } });
        assert.equal(c.status, 201);
        const id = c.body.data._id;
        const save = await H.api('PUT', `/admission/portal/applications/${id}`, { token: guest.token, body: { data: { studentName: 'Riya Sharma', primaryContact: 'Father', guardianName: 'Kept For Later' } } });
        assert.equal(save.status, 200);
        assert.deepEqual(save.body.errors, {});
        const d = await H.api('GET', `/admission/portal/applications/${id}`, { token: guest.token });
        assert.equal(d.body.data.application.data.studentName, 'Riya Sharma');
        assert.equal(d.body.data.application.data.guardianName, 'Kept For Later', 'a hidden answer survives a draft save');
        assert.equal(d.body.data.application.data.nationality, 'Indian', 'defaults are filled in');
        // An invalid answer is reported and does not replace the stored one.
        const bad = await H.api('PUT', `/admission/portal/applications/${id}`, { token: guest.token, body: { data: { pincode: '12' } } });
        assert.ok(bad.body.errors.pincode);
    });

    it('requires what the form requires, conditionally, before submitting', async () => {
        const c = await H.api('POST', '/admission/portal/applications', { token: guest.token, body: { round: round._id, class: s.classes[0]._id } });
        const id = c.body.data._id;
        await H.api('PUT', `/admission/portal/applications/${id}`, { token: guest.token, body: { data: H.goodAnswers({ primaryContact: 'Guardian' }) } });
        const r = await H.api('POST', `/admission/portal/applications/${id}/submit`, { token: guest.token, body: {} });
        assert.equal(r.status, 400);
        const paths = r.body.errors.map((e) => e.path);
        assert.ok(paths.includes('guardianName'), 'a guardian is required once Guardian is the primary contact');
        assert.ok(paths.includes('photoUpload'), 'required documents are required');
        assert.ok(!paths.includes('previousSchoolName'), 'a field hidden by its condition is not required');
    });

    it('drops answers to hidden questions on submission and numbers the application', async () => {
        const app = await H.submittedApplication(s, guest, round, { answers: { primaryContact: 'Father', guardianName: 'Should Go' } });
        assert.match(app.applicationNumber, /^APP\d{4}\d{5}$/);
        assert.equal(app.status, 'submitted');
        const row = (await H.q(`SELECT "data", "studentName", "guardianPhone" FROM "admissionapplications" WHERE "_id" = $1`, [app._id]))[0];
        assert.ok(!('guardianName' in row.data), 'hidden answer removed');
        assert.equal(row.studentName, 'Riya Sharma');
        assert.equal(row.guardianPhone, '9876543210');
        const edit = await H.api('PUT', `/admission/portal/applications/${app._id}`, { token: guest.token, body: { data: { studentName: 'Changed Name' } } });
        assert.equal(edit.status, 409, 'a submitted application is not edited by the applicant');
    });

    it('asks a field only of the classes it is for', async () => {
        const f = await H.api('GET', `/admission/admin/forms/${portal.form._id}`, { token: s.adminToken });
        const schema = JSON.parse(JSON.stringify(f.body.data.current.schema));
        schema.sections[0].fields.push({ key: 'kgPlayschool', type: 'text', label: 'Playschool attended', required: true, classes: [s.classes[1]._id] });
        const test = await H.api('POST', `/admission/admin/forms/${portal.form._id}/test`, { token: s.adminToken, body: { schema, answers: H.goodAnswers(), classId: s.classes[0]._id, uploaded: ['photo', 'birth_certificate', 'address_proof'] } });
        assert.equal(test.status, 200);
        assert.ok(!test.body.data.errors.kgPlayschool, 'not asked of Class 1');
        const test2 = await H.api('POST', `/admission/admin/forms/${portal.form._id}/test`, { token: s.adminToken, body: { schema, answers: H.goodAnswers(), classId: s.classes[1]._id, uploaded: ['photo', 'birth_certificate', 'address_proof'] } });
        assert.ok(test2.body.data.errors.kgPlayschool, 'required of Class 2');
    });

    it('publishes a new version: submitted applications keep theirs, drafts move with answers carried over', async () => {
        const guest = await H.registerGuest(s, portal.slug);   // (the shared applicant has used up the round's limit)
        const draft = (await H.api('POST', '/admission/portal/applications', { token: guest.token, body: { round: round._id, class: s.classes[1]._id } })).body.data;
        await H.api('PUT', `/admission/portal/applications/${draft._id}`, { token: guest.token, body: { data: { studentName: 'Arjun Sharma', religion: 'Hindu' } } });
        const submitted = (await H.q(`SELECT "_id", "formVersionNo" FROM "admissionapplications" WHERE "school" = $1 AND "status" = 'submitted' LIMIT 1`, [s.id]))[0];

        const f = await H.api('GET', `/admission/admin/forms/${portal.form._id}`, { token: s.adminToken });
        const schema = JSON.parse(JSON.stringify(f.body.data.current.schema));
        schema.sections[0].fields = schema.sections[0].fields.filter((x) => x.key !== 'religion');   // removed question
        schema.sections[0].fields.push({ key: 'motherTongue', type: 'text', label: 'Mother tongue', required: true, validation: { kind: 'letters' } });
        assert.equal((await H.api('PUT', `/admission/admin/forms/${portal.form._id}/draft`, { token: s.adminToken, body: { schema } })).status, 200);
        const pub = await H.api('POST', `/admission/admin/forms/${portal.form._id}/publish`, { token: s.adminToken, body: { changeNote: 'Mother tongue added' } });
        assert.equal(pub.status, 200);
        assert.equal(pub.body.data.version, 2);

        const opened = await H.api('GET', `/admission/portal/applications/${draft._id}`, { token: guest.token });
        assert.equal(opened.body.data.application.formVersionNo, 2);
        assert.equal(opened.body.data.migration.to, 2);
        assert.ok(opened.body.data.migration.added.includes('Mother tongue'));
        assert.equal(opened.body.data.application.data.studentName, 'Arjun Sharma', 'answer carried over');
        const kept = (await H.q(`SELECT "retiredData" FROM "admissionapplications" WHERE "_id" = $1`, [draft._id]))[0];
        assert.equal(kept.retiredData.religion, 'Hindu', 'the answer to a removed question is kept aside, not lost');
        const old = (await H.q(`SELECT "formVersionNo" FROM "admissionapplications" WHERE "_id" = $1`, [submitted._id]))[0];
        assert.equal(old.formVersionNo, 1, 'a submitted application stays on its version');
        // The new mandatory question applies to the draft.
        await H.api('PUT', `/admission/portal/applications/${draft._id}`, { token: guest.token, body: { data: H.goodAnswers({ studentName: 'Arjun Sharma' }) } });
        for (const d of ['photo', 'birth_certificate', 'address_proof']) await H.uploadDoc(guest.token, draft._id, d);
        const sub = await H.api('POST', `/admission/portal/applications/${draft._id}/submit`, { token: guest.token, body: {} });
        assert.equal(sub.status, 400);
        assert.ok(sub.body.errors.some((e) => e.path === 'motherTongue'));
    });

    it('checks uploads by content, type and size', async () => {
        const guest = await H.registerGuest(s, portal.slug);
        const app = (await H.api('POST', '/admission/portal/applications', { token: guest.token, body: { round: round._id, class: s.classes[0]._id } })).body.data;
        const fake = await H.uploadDoc(guest.token, app._id, 'birth_certificate', { name: 'cert.pdf', buffer: Buffer.from('<html>not a pdf</html>'), type: 'application/pdf' });
        assert.equal(fake.status, 400, 'a renamed file is refused');
        const wrongType = await H.uploadDoc(guest.token, app._id, 'photo', { name: 'photo.pdf', buffer: H.FILES.pdf, type: 'application/pdf' });
        assert.equal(wrongType.status, 400, 'the photo type takes images only');
        const exe = await H.uploadDoc(guest.token, app._id, 'photo', { name: 'photo.exe', buffer: H.FILES.png, type: 'application/octet-stream' });
        assert.equal(exe.status, 400);
        const notAsked = await H.uploadDoc(guest.token, app._id, 'no_such_type');
        assert.equal(notAsked.status, 400);
        await H.q(`UPDATE "admissiondocumenttypes" SET "maxSizeMB" = 1 WHERE "school" = $1 AND "key" = 'photo'`, [s.id]);
        const big = await H.uploadDoc(guest.token, app._id, 'photo', { name: 'big.png', buffer: Buffer.concat([H.FILES.png, Buffer.alloc(1024 * 1024 + 10)]) });
        assert.equal(big.status, 400, 'over the type\'s size limit');
        const ok = await H.uploadDoc(guest.token, app._id, 'photo');
        assert.equal(ok.status, 201);
        // Re-upload before submission replaces; the file is private.
        const again = await H.uploadDoc(guest.token, app._id, 'photo');
        assert.equal(again.status, 201);
        const cur = await H.q(`SELECT COUNT(*) FILTER (WHERE "current")::int AS cur, COUNT(*)::int AS all FROM "admissiondocuments" WHERE "application" = $1 AND "docKey" = 'photo'`, [app._id]);
        assert.equal(cur[0].cur, 1);
        const file = (await H.q(`SELECT "file" FROM "admissiondocuments" WHERE "application" = $1 AND "current" AND "docKey" = 'photo'`, [app._id]))[0].file;
        const direct = await fetch(`${H.BASE}/uploads/admission-docs/${file}`);
        assert.equal(direct.status, 403, 'the uploads folder is not served');
    });

    it('enforces the application limit and closed rounds', async () => {
        await H.q(`UPDATE "admissionsettings" SET "applications" = jsonb_set("applications", '{maxPerApplicant}', '1') WHERE "school" = $1`, [s.id]);
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { applications: { maxPerApplicant: 1 } } });
        const other = await H.registerGuest(s, portal.slug);
        assert.equal((await H.api('POST', '/admission/portal/applications', { token: other.token, body: { round: round._id, class: s.classes[0]._id } })).status, 201);
        const second = await H.api('POST', '/admission/portal/applications', { token: other.token, body: { round: round._id, class: s.classes[1]._id } });
        assert.equal(second.status, 409);
        assert.equal(second.body.code, 'APPLICATION_LIMIT');
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { applications: { maxPerApplicant: 5 } } });
        await H.api('POST', `/admission/admin/rounds/${round._id}/status`, { token: s.adminToken, body: { status: 'closed' } });
        const closed = await H.api('POST', '/admission/portal/applications', { token: other.token, body: { round: round._id, class: s.classes[1]._id } });
        assert.equal(closed.status, 409);
        await H.api('POST', `/admission/admin/rounds/${round._id}/status`, { token: s.adminToken, body: { status: 'open' } });
    });

    it('requires the application fee first when the school says so', async () => {
        const feeRound = await H.makeRound(s, portal.form, { applicationFee: 500 });
        const g = await H.registerGuest(s, portal.slug);
        const app = (await H.api('POST', '/admission/portal/applications', { token: g.token, body: { round: feeRound._id, class: s.classes[0]._id } })).body.data;
        // (Version 2 of the form, published above, asks for the mother tongue.)
        await H.api('PUT', `/admission/portal/applications/${app._id}`, { token: g.token, body: { data: H.goodAnswers({ motherTongue: 'Marathi' }) } });
        for (const d of ['photo', 'birth_certificate', 'address_proof']) await H.uploadDoc(g.token, app._id, d);
        const sub = await H.api('POST', `/admission/portal/applications/${app._id}/submit`, { token: g.token, body: {} });
        assert.equal(sub.status, 402, JSON.stringify(sub.body));
        assert.equal(sub.body.code, 'FEE_DUE');
        // Paid at the counter, it goes through.
        const pay = await H.api('POST', `/admission/admin/applications/${app._id}/payments`, { token: s.adminToken, body: { kind: 'application_fee', amount: 500, mode: 'cash' } });
        assert.equal(pay.status, 201);
        assert.match(pay.body.data.receiptNumber, /^ADR/);
        assert.equal((await H.api('POST', `/admission/portal/applications/${app._id}/submit`, { token: g.token, body: {} })).status, 200);
        const receipt = await H.api('GET', `/admission/portal/applications/${app._id}/payments/${pay.body.data._id}/receipt`, { token: g.token });
        assert.equal(receipt.status, 200);
        assert.ok(String(receipt.body).includes(pay.body.data.receiptNumber));
    });
});
