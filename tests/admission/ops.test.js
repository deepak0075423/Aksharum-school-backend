'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const H = require('./helpers');

/**
 * Running the module: the "not a robot" check on public forms (against a
 * stand-in for the provider), virus scanning of uploads (against a stand-in
 * clamd speaking INSTREAM), exports prepared in the background, and the
 * health card that says when each job last worked.
 */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function fakeClamd() {
    const server = net.createServer((sock) => {
        let buf = Buffer.alloc(0);
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            const text = buf.toString('latin1');
            if (text.startsWith('zPING\0')) { sock.end('PONG\0'); return; }
            if (!text.startsWith('zINSTREAM\0')) return;
            // Frames: 4-byte length, bytes … until a zero length.
            let at = 'zINSTREAM\0'.length; let body = Buffer.alloc(0);
            while (buf.length >= at + 4) {
                const n = buf.readUInt32BE(at);
                if (n === 0) { sock.end(body.toString('latin1').includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0'); return; }
                if (buf.length < at + 4 + n) return;
                body = Buffer.concat([body, buf.subarray(at + 4, at + 4 + n)]);
                at += 4 + n;
            }
        });
        sock.on('error', () => {});
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function fakeVerifier() {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const p = new URLSearchParams(body);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: p.get('secret') === 'captcha-secret' && p.get('response') === 'good-token' }));
        });
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

describe('admission — robot check, virus scanning, background exports, health', () => {
    let s; let portal; let clamd; let verifier;
    before(async () => {
        clamd = await fakeClamd();
        verifier = await fakeVerifier();
        await H.startServer({
            CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SITE_KEY: 'site-key-1', CAPTCHA_SECRET: 'captcha-secret', CAPTCHA_VERIFY_URL: `http://127.0.0.1:${verifier.address().port}/verify`,
            CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clamd.address().port),
        });
        s = await H.makeSchool('Ops');
        portal = await H.openPortal(s);
    });
    after(async () => {
        clamd.close(); verifier.close();
        // The job runs this test recorded are the platform's table: take them back out.
        await H.q(`DELETE FROM "admissionjobruns" WHERE "host" = $1`, [require('../../services/admission/jobRuns').HOST]).catch(() => {});
        await H.finish();
    });

    const register = (body) => H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body: { name: 'Ravi Kumar', email: `ravi-${H.rand()}@family.test`, phone: '9876543210', password: 'Applicant123', consent: true, ...body } });

    it('asks for the robot check on public forms — and never hands out the secret', async () => {
        const p = (await H.api('GET', `/admission/public/portals/${portal.slug}`)).body.data;
        assert.deepEqual(p.portal.captcha, { provider: 'turnstile', siteKey: 'site-key-1' });
        assert.ok(!JSON.stringify(p).includes('captcha-secret'));
        assert.equal((await register({})).body.code, 'CAPTCHA_REQUIRED');
        assert.equal((await register({ captchaToken: 'bad-token' })).body.code, 'CAPTCHA_FAILED');
        assert.equal((await register({ captchaToken: 'good-token' })).status, 200);
        assert.equal((await H.api('POST', `/admission/public/portals/${portal.slug}/enquiries`, { body: { name: 'Ravi Kumar', email: 'ravi@family.test', message: 'Is there a bus from Sector 5?' } })).body.code, 'CAPTCHA_REQUIRED');
    });

    it('refuses rather than skips the check when the provider cannot be reached', async () => {
        const port = verifier.address().port;
        verifier.close();
        await new Promise((r) => setTimeout(r, 100));
        const r = await register({ captchaToken: 'good-token' });
        assert.equal(r.status, 503);
        assert.equal(r.body.code, 'CAPTCHA_UNAVAILABLE');
        verifier = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end('{"success":true}'); }); });
        await new Promise((ok) => verifier.listen(port, '127.0.0.1', ok));
    });

    it('lets a school switch the check off for its own portal', async () => {
        assert.equal((await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { security: { captcha: false } } })).status, 200);
        await new Promise((r) => setTimeout(r, 15500));   // the portal reads settings through a 15-second cache
        assert.equal((await H.api('GET', `/admission/public/portals/${portal.slug}`)).body.data.portal.captcha, null);
        assert.equal((await register({})).status, 200);
    });

    let app; let g;
    it('refuses an infected upload and records each file\'s scan', async () => {
        const round = await H.makeRound(s, portal.form, { seats1: 5 });
        g = await H.registerGuest(s, portal.slug);
        const c = await H.api('POST', '/admission/portal/applications', { token: g.token, body: { round: round._id, class: s.classes[0]._id } });
        app = c.body.data;
        const pdf = (extra) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(extra, 'latin1'), Buffer.from('\n%%EOF\n')]);
        const bad = await H.uploadDoc(g.token, app._id, 'birth_certificate', { name: 'bc.pdf', buffer: pdf(EICAR), type: 'application/pdf' });
        assert.equal(bad.status, 422);
        assert.equal(bad.body.code, 'FILE_INFECTED');
        const [n] = await H.q(`SELECT COUNT(*)::int AS n FROM "admissiondocuments" WHERE "application" = $1`, [app._id]);
        assert.equal(n.n, 0, 'nothing kept');
        const good = await H.uploadDoc(g.token, app._id, 'birth_certificate', { name: 'bc.pdf', buffer: pdf('a clean certificate'), type: 'application/pdf' });
        assert.equal(good.status, 201, JSON.stringify(good.body));
        const [d] = await H.q(`SELECT "scanStatus", "scannedAt" FROM "admissiondocuments" WHERE "application" = $1 AND "current"`, [app._id]);
        assert.equal(d.scanStatus, 'clean');
        assert.ok(d.scannedAt);
    });

    it('keeps an upload as "not scanned" when the scanner is down (and scanning is not required)', async () => {
        const port = clamd.address().port;
        await new Promise((r) => clamd.close(r));
        const u = await H.uploadDoc(g.token, app._id, 'photo');
        assert.equal(u.status, 201);
        const [d] = await H.q(`SELECT "scanStatus" FROM "admissiondocuments" WHERE "application" = $1 AND "docKey" = 'photo' AND "current"`, [app._id]);
        assert.equal(d.scanStatus, 'unavailable', 'never called clean');
        const health = (await H.api('GET', '/admission/admin/health', { token: s.adminToken })).body.data;
        assert.deepEqual([health.scanning.on, health.scanning.reachable], [true, false]);
        clamd = await fakeClamd();
        void port;
    });

    it('prepares an export in the background, lets the office download it for a day, and logs each download', async () => {
        const q = await H.api('POST', '/admission/admin/exports', { token: s.adminToken, body: { kind: 'applications', format: 'xlsx', params: { view: 'all', answers: '0' } } });
        assert.equal(q.status, 202, JSON.stringify(q.body));
        let x;
        for (let i = 0; i < 40; i++) {
            x = (await H.api('GET', '/admission/admin/exports', { token: s.adminToken })).body.data.find((e) => e._id === q.body.data._id);
            if (x.status === 'ready' || x.status === 'failed') break;
            await new Promise((r) => setTimeout(r, 250));
        }
        assert.equal(x.status, 'ready', x.error);
        const file = await fetch(`${H.BASE}/api/admission/admin/exports/${x._id}/file`, { headers: { Authorization: `Bearer ${s.adminToken}` } });
        assert.equal(file.status, 200);
        const buf = Buffer.from(await file.arrayBuffer());
        assert.equal(buf.subarray(0, 2).toString(), 'PK', 'an xlsx');
        const [log] = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionaccesslogs" WHERE "school" = $1 AND "action" = 'export'`, [s.id]);
        assert.ok(log.n >= 1);
        assert.equal((await fetch(`${H.BASE}/api/admission/admin/exports/${x._id}/file`, { headers: { Authorization: `Bearer ${s.teacherToken}` } })).status, 403, 'not for a teacher without the module');
        await H.q(`UPDATE "admissionexports" SET "expiresAt" = now() - interval '1 minute' WHERE "_id" = $1`, [x._id]);
        assert.equal((await fetch(`${H.BASE}/api/admission/admin/exports/${x._id}/file`, { headers: { Authorization: `Bearer ${s.adminToken}` } })).status, 410);
        const swept = await require('../../services/admission/exportJobs').sweep();
        assert.ok(swept.expired >= 1);
    });

    it('says when each background job last worked — and calls one late that has not', async () => {
        const runs = require('../../services/admission/jobRuns');
        await runs.record('exports.worker', async () => ({ prepared: 0 }));
        await runs.record('sweep.reminders', async () => { throw new Error('SMTP refused the connection'); });
        const h = (await H.api('GET', '/admission/admin/health', { token: s.adminToken })).body.data;
        const job = (k) => h.jobs.find((j) => j.job === k);
        assert.equal(job('exports.worker').late, false);
        assert.equal(job('sweep.reminders').failedRecently, true);
        assert.ok(job('sweep.reminders').lastFailAt);
        assert.ok(!JSON.stringify(h).includes('SMTP refused'), 'the error text stays in the server log');
        assert.equal(h.captcha.on, true);
        assert.equal(typeof h.email.sent, 'number');
    });
});
