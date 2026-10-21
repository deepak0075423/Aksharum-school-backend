'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const logsOf = (schoolId, event) => H.q(`SELECT * FROM "admissionemaillogs" WHERE "school" = $1 AND "event" = $2 ORDER BY "createdAt" DESC`, [schoolId, event]);
const settle = () => new Promise((r) => setTimeout(r, 400));

describe('admission — email templates and delivery', () => {
    let s; let portal; let round; let guest; let app;
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Email');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form);
        guest = await H.registerGuest(s, portal.slug);
        app = await H.submittedApplication(s, guest, round);
    });
    after(() => H.finish());

    it('lists every event with its placeholders, and refuses wording that breaks the rules', async () => {
        const list = await H.api('GET', '/admission/admin/emails', { token: s.adminToken });
        assert.equal(list.status, 200);
        const keys = list.body.data.map((e) => e.event);
        for (const k of ['email_otp', 'password_reset', 'application_submitted', 'document_rejected', 'exam_scheduled', 'result_published', 'first_list_selection', 'second_list_selection', 'waiting_list', 'admission_offer', 'payment_reminder', 'payment_receipt', 'admission_confirmed', 'admission_cancelled']) {
            assert.ok(keys.includes(k), k);
        }
        const unknown = await H.api('PUT', '/admission/admin/emails/application_submitted', { token: s.adminToken, body: { subject: 'Hi {{not_a_thing}}', body: 'x' } });
        assert.equal(unknown.status, 400);
        const badLink = await H.api('PUT', '/admission/admin/emails/application_submitted', { token: s.adminToken, body: { subject: 'Hi', body: '[Click](javascript:alert(1))' } });
        assert.equal(badLink.status, 400);
        const textAsLink = await H.api('PUT', '/admission/admin/emails/application_submitted', { token: s.adminToken, body: { subject: 'Hi', body: '[Click]({{student_name}})' } });
        assert.equal(textAsLink.status, 400, 'a text placeholder cannot be a link');
        const html = await H.api('PUT', '/admission/admin/emails/application_submitted', { token: s.adminToken, body: { subject: 'Hi', body: '<script>alert(1)</script>' } });
        assert.equal(html.status, 400, 'markup is refused before it is stored');
        const noOtp = await H.api('PUT', '/admission/admin/emails/email_otp', { token: s.adminToken, body: { subject: 'Your code', body: 'Here is no code' } });
        assert.equal(noOtp.status, 400, 'the code email must carry the code');
        const off = await H.api('PUT', '/admission/admin/emails/email_otp/enabled', { token: s.adminToken, body: { enabled: false } });
        assert.equal(off.status, 400, 'the code email cannot be switched off');
    });

    it('keeps every version and can restore one', async () => {
        const v1 = await H.api('PUT', '/admission/admin/emails/application_submitted', { token: s.adminToken, body: { subject: 'Received: {{application_number}}', body: 'Dear {{applicant_name}}, we have **{{student_name}}**\'s application.' } });
        assert.equal(v1.status, 200, JSON.stringify(v1.body));
        const v2 = await H.api('PUT', '/admission/admin/emails/application_submitted', { token: s.adminToken, body: { subject: 'Second wording {{application_number}}', body: 'Thanks {{applicant_name}}.' } });
        assert.equal(v2.body.data.version, v1.body.data.version + 1);
        const versions = await H.api('GET', '/admission/admin/emails/application_submitted/versions', { token: s.adminToken });
        assert.ok(versions.body.data.length >= 2);
        const back = await H.api('POST', '/admission/admin/emails/application_submitted/restore', { token: s.adminToken, body: { version: v1.body.data.version } });
        assert.equal(back.status, 200);
        const current = (await H.api('GET', '/admission/admin/emails', { token: s.adminToken })).body.data.find((e) => e.event === 'application_submitted');
        assert.equal(current.subject, 'Received: {{application_number}}');
        const one = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionemailtemplates" WHERE "school" = $1 AND "event" = 'application_submitted' AND "isCurrent"`, [s.id]);
        assert.equal(one[0].n, 1, 'exactly one wording in force');
    });

    it('previews with sample values and sends a test, recorded as such', async () => {
        const p = await H.api('POST', '/admission/admin/emails/application_submitted/preview', { token: s.adminToken, body: {} });
        assert.equal(p.status, 200);
        assert.match(p.body.data.subject, /^Received: APP/);
        assert.ok(p.body.data.html.includes('<strong>Riya Sharma</strong>'));
        const t = await H.api('POST', '/admission/admin/emails/application_submitted/test', { token: s.adminToken, body: { to: 'office@school.test' } });
        assert.equal(t.status, 200);
        assert.equal(t.body.data.status, 'logged', 'the log driver records instead of sending');
        const logged = (await logsOf(s.id, 'application_submitted')).find((l) => l.isTest);
        assert.ok(logged);
        assert.match(logged.subject, /^\[Test\]/);
    });

    it('fills placeholders and keeps an applicant\'s words as text', async () => {
        await H.api('PUT', '/admission/admin/emails/status_update', { token: s.adminToken, body: { subject: 'Update on {{application_number}}', body: 'Note: {{remarks}}', enabled: true } });
        const remarks = 'See **this** and [x](javascript:alert(1)) & {{otp}}';
        const r = await H.api('POST', `/admission/admin/applications/${app._id}/transition`, { token: s.adminToken, body: { to: 'under_review', remarks } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        await settle();
        const log = (await logsOf(s.id, 'status_update'))[0];
        assert.ok(log, 'a status change sends its email');
        assert.equal(log.subject, `Update on ${app.applicationNumber}`);
        const html = log.body.slice(log.body.indexOf('<div'));
        assert.ok(!html.includes('<strong>this</strong>'), 'an applicant\'s ** is not formatting');
        assert.ok(!/href="javascript/i.test(html), 'no script link');
        assert.ok(html.includes('{{otp}}'), 'a placeholder inside a value is not expanded');
        assert.ok(html.includes('&amp;'), 'special characters are escaped');
    });

    it('sends the emails each step promises', async () => {
        await settle();
        assert.ok((await logsOf(s.id, 'email_otp')).length >= 1, 'verification code');
        assert.ok((await logsOf(s.id, 'guest_registration')).length >= 1, 'welcome');
        assert.ok((await logsOf(s.id, 'application_submitted')).some((l) => !l.isTest), 'submission');
        const doc = (await H.q(`SELECT "_id" FROM "admissiondocuments" WHERE "application" = $1 AND "current" LIMIT 1`, [app._id]))[0];
        await H.api('POST', `/admission/admin/documents/${doc._id}/review`, { token: s.adminToken, body: { decision: 'reject', reason: 'Not readable' } });
        await settle();
        const rej = (await logsOf(s.id, 'document_rejected'))[0];
        assert.ok(rej, 'document rejection');
        assert.ok(rej.body.includes('Not readable'));
        const off = await H.api('PUT', '/admission/admin/emails/documents_verified/enabled', { token: s.adminToken, body: { enabled: false } });
        assert.equal(off.status, 200);
    });

    it('records a delivery failure as a failure, and can send it again', async () => {
        const mailer = require('../../services/admission/mailer');
        // The school's own SMTP server, pointed at a closed local port: a real refusal, no network.
        await H.q(`UPDATE "schools" SET "smtp" = $2::jsonb WHERE "_id" = $1`, [s.id, JSON.stringify({ enabled: true, host: '127.0.0.1', port: 9, secure: false, user: 'x', pass: 'y', fromEmail: 'office@school.test' })]);
        require('../../utils/schoolMailer').invalidate(s.id);
        process.env.ADMISSION_MAIL_DRIVER = 'smtp';
        try {
            const r = await mailer.send(s.id, 'application_submitted', { to: 'family@example.com', values: { applicant_name: 'Anita' } });
            assert.equal(r.status, 'failed');
            assert.ok(r.error);
            const reserved = await mailer.send(s.id, 'application_submitted', { to: 'family@nowhere.test', values: {} });
            assert.equal(reserved.status, 'skipped', 'reserved test domains are never handed to a mail server');
            const retry = await H.api('POST', `/admission/admin/email-logs/${r.logId}/retry`, { token: s.adminToken });
            assert.equal(retry.status, 200);
            const logs = await H.api('GET', '/admission/admin/email-logs?status=failed', { token: s.adminToken });
            assert.ok(logs.body.data.some((l) => l._id === r.logId && l.canRetry));
            assert.ok(logs.body.last30.failed >= 1);
        } finally {
            process.env.ADMISSION_MAIL_DRIVER = 'log';
        }
        const otpLog = (await logsOf(s.id, 'email_otp'))[0];
        const noRetry = await H.api('POST', `/admission/admin/email-logs/${otpLog._id}/retry`, { token: s.adminToken });
        assert.equal(noRetry.status, 400, 'code emails are not retried');
        assert.ok(!JSON.stringify(otpLog.context || {}).match(/"otp"/), 'the code is not kept in the log context');
    });
});
