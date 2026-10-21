'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const crypto = require('crypto');
const H = require('./helpers');

/**
 * Getting email delivered: a mailbox the receiving server refuses goes on the
 * do-not-send list by itself; a provider's signed bounce report does the same;
 * a family registering with such an address is told at once; the office sees
 * and manages its list; and the domain check reads SPF, DMARC, DKIM and MX.
 *
 * Mail goes to a fake SMTP server on this machine — nothing leaves it.
 */
const SECRET = 'whsec_test_delivery_123';
const BAD = 'nobody@bounce-check.org';

function fakeSmtp() {
    const got = { rcpt: [], messages: 0 };
    const server = net.createServer((sock) => {
        let data = false; let buf = '';
        const say = (l) => sock.write(`${l}\r\n`);
        say('220 fake.local ESMTP');
        sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let i;
            while ((i = buf.indexOf('\r\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 2);
                if (data) { if (line === '.') { data = false; got.messages += 1; say('250 2.0.0 queued'); } continue; }
                const cmd = line.toUpperCase();
                if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) { sock.write('250-fake.local\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n'); }
                else if (cmd.startsWith('AUTH')) say('235 2.7.0 Authentication successful');
                else if (cmd.startsWith('MAIL FROM')) say('250 2.1.0 OK');
                else if (cmd.startsWith('RCPT TO')) {
                    const addr = (line.match(/<([^>]+)>/) || [])[1] || '';
                    got.rcpt.push(addr);
                    if (addr === BAD) say(`550 5.1.1 <${addr}>: Recipient address rejected: User unknown in virtual mailbox table`);
                    else say('250 2.1.5 OK');
                } else if (cmd === 'DATA') { data = true; say('354 End data with <CR><LF>.<CR><LF>'); }
                else if (cmd === 'RSET' || cmd === 'NOOP') say('250 2.0.0 OK');
                else if (cmd === 'QUIT') { say('221 2.0.0 Bye'); sock.end(); }
                else say('502 5.5.2 Command not recognised');
            }
        });
        sock.on('error', () => {});
    });
    return { server, got };
}

const sign = (body) => `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
async function post(body, signature) {
    const raw = JSON.stringify(body);
    const res = await fetch(`${H.BASE}/api/admission/webhooks/email-events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature === undefined ? {} : { 'X-Aksharum-Signature': signature === true ? sign(raw) : signature }) }, body: raw });
    return { status: res.status, body: await res.json() };
}

describe('admission — email delivery: bounces, the do-not-send list, the sending domain', () => {
    let smtp; let s; let portal;
    before(async () => {
        smtp = fakeSmtp();
        await new Promise((r) => smtp.server.listen(0, '127.0.0.1', r));
        await H.startServer({
            ADMISSION_MAIL_DRIVER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.server.address().port), SMTP_USER: 'admissions@aksharum.org', SMTP_PASS: 'x',
            ADMISSION_WEBHOOK_SECRET: SECRET,
        });
        s = await H.makeSchool('Delivery');
        portal = await H.openPortal(s);
    });
    after(async () => { await H.finish(); smtp.server.close(); });

    const register = (email) => H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body: { name: 'Lata Iyer', email, phone: '9876500012', password: 'Applicant123', consent: true } });
    const until = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 100)); } };

    it('sends through the mail server — and stops writing to a mailbox it refuses', async () => {
        assert.equal((await register('lata@good-family.org')).status, 200);
        const sent = await until(async () => (await H.q(`SELECT "status" FROM "admissionemaillogs" WHERE "school" = $1 AND "to" = 'lata@good-family.org'`, [s.id]))[0]?.status);
        assert.equal(sent, 'sent', 'accepted by the mail server');
        assert.ok(smtp.got.messages >= 1);
        assert.equal((await register(BAD)).status, 200, 'the family is not told more than usual');
        const failed = await until(async () => (await H.q(`SELECT "status", "error" FROM "admissionemaillogs" WHERE "school" = $1 AND "to" = $2`, [s.id, BAD]))[0]);
        assert.equal(failed.status, 'failed');
        assert.match(failed.error, /550|User unknown/);
        const sup = await until(async () => (await H.q(`SELECT "source", "reason" FROM "admissionemailsuppressions" WHERE "school" = $1 AND "email" = $2`, [s.id, BAD]))[0]);
        assert.equal(sup?.source, 'smtp_reject', 'on the list by itself');
    });

    it('takes a provider\'s bounce report only when it is signed', async () => {
        const events = { events: [
            { email: 'gone@old-isp.org', type: 'bounce', bounceType: 'permanent', reason: '<gone@old-isp.org>: mailbox disabled' },
            { email: 'full@busy-isp.org', type: 'bounce', bounceType: 'transient', reason: 'Mailbox full' },
            { email: 'angry@family.org', type: 'complaint', school: s.id },
            { email: 'not-an-address', type: 'bounce' },
        ] };
        assert.equal((await post(events)).status, 401, 'no signature');
        assert.equal((await post(events, `sha256=${'0'.repeat(64)}`)).status, 401, 'a wrong one');
        const ok = await post(events, true);
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.deepEqual(ok.body.data, { received: 4, suppressed: 2, ignored: 2 }, 'a full mailbox is a passing problem; nonsense is ignored');
        const rows = await H.q(`SELECT "email", "school", "source" FROM "admissionemailsuppressions" WHERE "email" IN ('gone@old-isp.org', 'angry@family.org', 'full@busy-isp.org')`);
        assert.equal(rows.find((r) => r.email === 'gone@old-isp.org').school, null, 'a platform-wide bounce');
        assert.equal(rows.find((r) => r.email === 'angry@family.org').source, 'complaint');
        assert.ok(!rows.some((r) => r.email === 'full@busy-isp.org'));
        await H.q(`DELETE FROM "admissionemailsuppressions" WHERE "email" = 'gone@old-isp.org' AND "school" IS NULL`);
    });

    it('tells a family registering with an address that bounced, instead of leaving them waiting', async () => {
        const r = await register('angry@family.org');
        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'EMAIL_UNDELIVERABLE');
        const log = (await H.q(`SELECT "status", "error" FROM "admissionemaillogs" WHERE "school" = $1 AND "to" = 'angry@family.org'`, [s.id]))[0];
        assert.equal(log.status, 'skipped');
        assert.match(log.error, /do-not-send list — marked a message as spam/);
    });

    it('lets the office see and keep its own list — not clear a platform-wide entry', async () => {
        await H.q(`INSERT INTO "admissionemailsuppressions" ("_id", "school", "email", "source", "reason", "createdAt", "updatedAt") VALUES ($1, NULL, 'lata@good-family.org', 'bounce', 'Mailbox closed', now(), now())`, [H.uuid()]);
        const add = await H.api('POST', '/admission/admin/email-suppressions', { token: s.adminToken, body: { email: 'parent@asked-to-stop.org', reason: 'Asked us on the phone to stop emailing' } });
        assert.equal(add.status, 201);
        assert.equal((await H.api('POST', '/admission/admin/email-suppressions', { token: s.adminToken, body: { email: 'nope' } })).status, 400);
        const list = (await H.api('GET', '/admission/admin/email-suppressions', { token: s.adminToken })).body.data;
        const platform = list.find((x) => x.email === 'lata@good-family.org');
        assert.ok(platform?.platformWide, 'a platform-wide bounce for an address the school has written to');
        assert.equal((await H.api('DELETE', `/admission/admin/email-suppressions/${platform._id}`, { token: s.adminToken })).status, 404);
        const own = list.find((x) => x.email === 'parent@asked-to-stop.org');
        assert.equal((await H.api('DELETE', `/admission/admin/email-suppressions/${own._id}`, { token: s.adminToken })).status, 200);
        assert.equal((await H.api('GET', '/admission/admin/email-suppressions', { token: s.teacherToken })).status, 403);
        await H.q(`DELETE FROM "admissionemailsuppressions" WHERE "email" = 'lata@good-family.org' AND "school" IS NULL`);
    });

    it('reads a sending domain\'s SPF, DMARC, DKIM and MX', async () => {
        const { domainReport } = require('../../controllers/admissionDelivery.controller');
        const zone = (records) => ({ txt: async (n) => records[n] || [], mx: async (n) => (records[`mx:${n}`] || []) });
        const good = await domainReport(zone({
            'school.org': ['v=spf1 include:_spf.google.com ~all', 'google-site-verification=abc'],
            '_dmarc.school.org': ['v=DMARC1; p=quarantine; rua=mailto:dmarc@school.org'],
            'google._domainkey.school.org': ['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'],
            'mx:school.org': [{ exchange: 'aspmx.l.google.com', priority: 1 }],
        }), 'school.org', 'google');
        assert.equal(good.ok, true, JSON.stringify(good.checks));
        const bad = await domainReport(zone({ 'shaky.org': ['v=spf1 include:a.com ~all', 'v=spf1 include:b.com ~all'] }), 'shaky.org', '');
        const by = Object.fromEntries(bad.checks.map((c) => [c.key, c]));
        assert.equal(by.spf.ok, false);
        assert.match(by.spf.detail, /more than one SPF/);
        assert.equal(by.dmarc.ok, false);
        assert.equal(by.dkim.ok, null, 'no selector: not judged');
        assert.equal(by.mx.ok, false);
        assert.equal(bad.ok, false);
        const live = await H.api('GET', '/admission/admin/email-domain-check?selector=google', { token: s.adminToken });
        assert.equal(live.status, 200, JSON.stringify(live.body));
        assert.equal(live.body.data.domain, 'aksharum.org', 'the address mail is sent from');
        assert.equal(live.body.data.checks.length, 4);
    });
});
