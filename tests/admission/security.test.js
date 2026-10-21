'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const H = require('./helpers');

/**
 * Level 4 — security: an applicant kept out of the ERP, tokens that are
 * forged, expired or claim another role, private files, hostile uploads,
 * markup and unsafe links, verification codes kept from the office, fields an
 * applicant has no say over, and what a family may see of results and lists.
 */
describe('admission — level 4: security', () => {
    let s; let other; let portal; let round; let g1; let g2; let g3; let sub; let sub3; let draft;
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Sec');
        other = await H.makeSchool('Sec-B');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 1 });
        g1 = await H.registerGuest(s, portal.slug);
        sub = await H.submittedApplication(s, g1, round, { answers: { studentName: 'Neel Ahuja', studentDob: '2021-06-01' } });
        g3 = await H.registerGuest(s, portal.slug);
        sub3 = await H.submittedApplication(s, g3, round, { answers: { studentName: 'Ojas Malhotra', studentDob: '2021-07-02' } });
        g2 = await H.registerGuest(s, portal.slug);
        draft = (await H.api('POST', '/admission/portal/applications', { token: g2.token, body: { round: round._id, class: s.classes[1]._id } })).body.data;
    });
    after(() => H.finish());

    it('keeps an applicant session out of the rest of the ERP', async () => {
        for (const url of ['/admin/dashboard', '/admin/modules', '/student/dashboard', '/parent/dashboard', '/teacher/dashboard', '/notifications/inbox', '/notifications/unread-count', '/chat/chats', '/auth/file-token', '/profile']) {
            const r = await H.api('GET', url, { token: g1.token });
            assert.equal(r.status, 403, `${url} answered ${r.status}`);
        }
        const me = await H.api('GET', '/auth/me', { token: g1.token });
        assert.equal(me.status, 200);
        assert.equal(me.body.user?.role ?? me.body.data?.role ?? me.body.data?.user?.role, 'guest');
    });

    it('refuses forged and expired tokens, and takes the role from the account — never from the token', async () => {
        const claims = { userId: String(g1.user._id), role: 'school_admin', schoolId: s.id };
        const forged = jwt.sign(claims, 'not-the-secret');
        assert.equal((await H.api('GET', '/admission/admin/bootstrap', { token: forged })).status, 401);
        const expired = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: -10 });
        assert.equal((await H.api('GET', '/admission/portal/me', { token: expired })).status, 401);
        const claimsAdmin = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '5m' });
        assert.equal((await H.api('GET', '/admission/admin/bootstrap', { token: claimsAdmin })).status, 403, 'a guest claiming school_admin is still a guest');
        const student = await H.insert('users', { _id: H.uuid(), name: 'Real Student', email: `stu-${H.rand()}@school.test`, password: 'x', role: 'student', school: s.id, isFirstLogin: false, isActive: true, createdAt: new Date() });
        assert.equal((await H.api('GET', '/admission/portal/me', { token: H.tokenFor(student) })).status, 403, 'a student is not an applicant');
    });

    it('serves documents only through the checked route — never as a public file — and safely', async () => {
        const [d] = await H.q(`SELECT "_id", "file" FROM "admissiondocuments" WHERE "application" = $1 AND "current" LIMIT 1`, [sub._id]);
        const direct = await fetch(`${H.BASE}/uploads/admission-docs/${d.file}`);
        assert.ok([403, 404].includes(direct.status), `the static path answered ${direct.status}`);
        const r = await H.api('GET', `/admission/portal/applications/${sub._id}/documents/${d._id}/file`, { token: g1.token });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
        assert.match(r.headers.get('content-security-policy') || '', /sandbox/);
        assert.match(r.headers.get('cache-control') || '', /no-store/);
        assert.equal((await H.api('GET', `/admission/portal/applications/${sub._id}/documents/${d._id}/file`, { token: g2.token })).status, 404, 'another family');
    });

    it('checks an upload by what it is — not by its name or the type the browser claims', async () => {
        const up = (name, buffer, type, docType = 'photo') => H.uploadDoc(g2.token, draft._id, docType, { name, buffer, type });
        assert.equal((await up('photo.png', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png')).status, 400, 'HTML named .png');
        assert.equal((await up('photo.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/png')).status, 400, 'SVG named .png');
        assert.equal((await up('photo.png', Buffer.alloc(0), 'image/png')).status, 400, 'empty');
        assert.equal((await up('scan.pdf.exe', H.FILES.pdf, 'application/pdf', 'birth_certificate')).status, 400, 'not an accepted extension');
        const big = Buffer.concat([H.FILES.png, Buffer.alloc(3 * 1024 * 1024)]);
        assert.ok([400, 413].includes((await up('photo.png', big, 'image/png')).status), 'over the photo\'s 2 MB');
        const lied = await up('../../../etc/passwd.png', H.FILES.png, 'text/html');
        assert.equal(lied.status, 201, JSON.stringify(lied.body));
        const [row] = await H.q(`SELECT "file", "mime", "originalName" FROM "admissiondocuments" WHERE "_id" = $1`, [lied.body.data._id]);
        assert.equal(row.mime, 'image/png', 'the type comes from the content');
        assert.ok(!row.file.includes('..') && row.file.startsWith(`${s.id}/`), `stored as ${row.file}`);
        const file = await H.api('GET', `/admission/portal/applications/${draft._id}/documents/${lied.body.data._id}/file`, { token: g2.token });
        assert.equal(file.headers.get('content-type'), 'image/png');
        assert.ok(!/\.\.|\//.test((file.headers.get('content-disposition') || '').replace(/^[^"]*"|"$/g, '')), file.headers.get('content-disposition'));
    });

    it('refuses markup in answers and unsafe links in an email\'s wording', async () => {
        const save = await H.api('PUT', `/admission/portal/applications/${draft._id}`, { token: g2.token, body: { data: { studentName: '<script>alert(1)</script>' } } });
        assert.equal(save.status, 400);
        const tpl = (body) => H.api('PUT', '/admission/admin/emails/status_update', { token: s.adminToken, body: { subject: 'Update on {{student_name}}', body } });
        assert.equal((await tpl('Click [here](javascript:alert(1)) now.')).status, 400, 'javascript: link');
        assert.equal((await tpl('Hello <b>there</b>')).status, 400, 'HTML');
        const preview = await H.api('POST', '/admission/admin/emails/status_update/preview', { token: s.adminToken, body: { subject: 'x', body: 'See [the site](https://example.com) and [[Open|{{application_link}}]]' } });
        assert.equal(preview.status, 200);
        assert.ok(!/javascript:/i.test(preview.body.data.html));
    });

    it('never keeps a verification or reset code where the office can read it', async () => {
        const email = `code-${H.rand()}@family.test`;
        await H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body: { name: 'Code Check', email, phone: '9876501234', password: 'Applicant123', consent: true } });
        const code = await H.lastCode(s.id, email);
        assert.match(code, /^\d{6}$/);
        const [otp] = await H.q(`SELECT * FROM "admissionotps" WHERE "email" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [email]);
        assert.ok(!JSON.stringify(otp).includes(code), 'the code itself is not stored');
        assert.match(otp.codeHash, /^[0-9a-f]{64}$/);
        const logs = (await H.api('GET', `/admission/admin/email-logs?q=${encodeURIComponent(email)}`, { token: s.adminToken })).body.data;
        assert.ok(logs.length >= 1);
        assert.ok(logs.every((l) => !JSON.stringify(l).includes(code)), `the office can read the code: ${JSON.stringify(logs.map((l) => l.subject))}`);
        const [ctx] = await H.q(`SELECT "context", "subject" FROM "admissionemaillogs" WHERE "to" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [email]);
        assert.ok(!JSON.stringify(ctx.context).includes(code) && !ctx.subject.includes(code));
        await H.api('POST', `/admission/public/portals/${portal.slug}/forgot-password`, { body: { email: g1.email } });
        const reset = await H.lastCode(s.id, g1.email, 'password_reset');
        const resetLogs = (await H.api('GET', `/admission/admin/email-logs?q=${encodeURIComponent(g1.email)}`, { token: s.adminToken })).body.data;
        assert.ok(reset && resetLogs.every((l) => !JSON.stringify(l).includes(reset)), 'nor a password reset code');
    });

    it('ignores what an applicant has no say over', async () => {
        const save = await H.api('PUT', `/admission/portal/applications/${draft._id}`, { token: g2.token, body: { data: { studentName: 'Kiran Rao' }, status: 'enrolled', applicationNumber: 'HACK-1', school: other.id, applicationFeeStatus: 'paid' } });
        assert.equal(save.status, 200);
        const [row] = await H.q(`SELECT "status", "applicationNumber", "school" FROM "admissionapplications" WHERE "_id" = $1`, [draft._id]);
        assert.deepEqual([row.status, row.applicationNumber || null, String(row.school)], ['draft', null, s.id]);
        const made = await H.api('POST', '/admission/portal/applications', { token: g2.token, body: { round: round._id, class: s.classes[0]._id, status: 'confirmed', applicant: String(other.admin._id) } });
        assert.equal(made.status, 201, JSON.stringify(made.body));
        const [mine] = await H.q(`SELECT "status", "applicant" FROM "admissionapplications" WHERE "_id" = $1`, [made.body.data._id]);
        assert.deepEqual([mine.status, String(mine.applicant)], ['draft', String(g2.user._id)]);
        await H.api('PUT', `/admission/admin/rounds/${round._id}`, { token: s.adminToken, body: { school: other.id, name: 'Main Admissions' } });
        const [r] = await H.q(`SELECT "school" FROM "admissionrounds" WHERE "_id" = $1`, [round._id]);
        assert.equal(String(r.school), s.id);
    });

    it('shows a family published results only — never marks in progress, never the evaluators\' remarks', async () => {
        await H.verifyAllDocs(s, sub._id);
        await H.verifyAllDocs(s, sub3._id);
        const exam = (await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: { round: round._id, name: 'Secret Test', mode: 'offline', classes: [s.classes[0]._id], startsAt: new Date(Date.now() + 3600e3), subjects: [{ name: 'Maths', maxMarks: 100 }] } })).body.data;
        await H.api('POST', `/admission/admin/exams/${exam._id}/schedule`, { token: s.adminToken });
        await H.api('POST', `/admission/admin/exams/${exam._id}/candidates`, { token: s.adminToken, body: { applicationIds: 'all' } });
        const board = (await H.api('GET', `/admission/admin/exams/${exam._id}/results`, { token: s.adminToken })).body.data.board;
        const key = exam.subjects[0].key;
        await H.api('PUT', `/admission/admin/exams/${exam._id}/marks`, { token: s.adminToken, body: { rows: board.map((b) => ({ candidate: b.candidateId, marks: { [key]: b.applicationId === sub._id ? 91 : 77 }, remarks: 'INTERNAL-REMARK-XYZ' })) } });
        const during = JSON.stringify((await H.api('GET', `/admission/portal/applications/${sub._id}`, { token: g1.token })).body);
        assert.ok(!during.includes('INTERNAL-REMARK-XYZ') && !during.includes('"total":91'), 'nothing before publication');
        for (const step of ['submit', 'approve']) assert.equal((await H.api('POST', `/admission/admin/exams/${exam._id}/results/${step}`, { token: s.adminToken })).status, 200);
        await H.api('POST', `/admission/admin/exams/${exam._id}/results/publish`, { token: s.adminToken, body: {} });
        const published = JSON.stringify((await H.api('GET', `/admission/portal/applications/${sub._id}`, { token: g1.token })).body);
        assert.ok(published.includes('91'), 'the published mark is shown');
        assert.ok(!published.includes('INTERNAL-REMARK-XYZ'), 'remarks never reach the family');
    });

    it('hides other children\'s names on a published list unless the school shows them', async () => {
        const exams = (await H.api('GET', '/admission/admin/exams', { token: s.adminToken })).body.data;
        const exam = exams.find((e) => e.name === 'Secret Test');
        const list = (await H.api('POST', '/admission/admin/lists', { token: s.adminToken, body: { round: round._id, class: s.classes[0]._id, seats: 1, waitlistSize: 1, criteria: { weights: [{ source: `exam:${exam._id}`, weight: 1 }] } } })).body.data.list;
        for (const step of ['submit', 'approve']) await H.api('POST', `/admission/admin/lists/${list._id}/${step}`, { token: s.adminToken });
        assert.equal((await H.api('POST', `/admission/admin/lists/${list._id}/publish`, { token: s.adminToken, body: {} })).status, 200);
        const seen = JSON.stringify((await H.api('GET', `/admission/portal/applications/${sub._id}/lists`, { token: g1.token })).body);
        assert.ok(!seen.includes('Ojas Malhotra'), 'another family\'s child is not named');
        assert.ok(seen.includes(sub3.applicationNumber) || seen.includes('waitlisted'), 'the line is there, unnamed');
    });

    it('lets a family answer an offer only when the school allows it', async () => {
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { selection: { allowApplicantResponse: false } } });
        const r = await H.api('POST', `/admission/portal/applications/${sub._id}/offer/respond`, { token: g1.token, body: { accept: true } });
        assert.equal(r.status, 403, JSON.stringify(r.body));
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { selection: { allowApplicantResponse: true } } });
        assert.equal((await H.api('POST', `/admission/portal/applications/${sub._id}/offer/respond`, { token: g1.token, body: { accept: true } })).status, 200);
    });
});
