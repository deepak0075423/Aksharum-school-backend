'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const H = require('./helpers');

/**
 * DigiLocker, against a stand-in for its OAuth and file API: the family
 * connects (state + PKCE), comes back through the callback, sees the issued
 * documents and fetches one into the application — through the upload's own
 * checks, marked with its issuer, verified at once only where the school says.
 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

function fakeDigilocker(seen) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const url = new URL(req.url, 'http://x');
            const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
            if (req.method === 'POST' && url.pathname === '/1/token') {
                const p = new URLSearchParams(body);
                seen.verifier = p.get('code_verifier');
                if (p.get('client_secret') !== 'dl-secret' || p.get('code') !== 'good-code' || !p.get('code_verifier')) return json({ error: 'invalid_grant' }, 400);
                return json({ access_token: 'AT-secret-1', token_type: 'Bearer', name: 'Kiran Rao', dob: '13032021', gender: 'M', digilockerid: 'dl-123' });
            }
            if (req.headers.authorization !== 'Bearer AT-secret-1') return json({ error: 'unauthorized' }, 401);
            if (url.pathname === '/2/files/issued') {
                return json({ items: [{ name: 'Birth Certificate', type: 'file', size: PDF.length, date: '01-01-2021', mime: ['application/pdf'], uri: 'in.gov.mcd-BTCER-123', doctype: 'BTCER', issuer: 'Municipal Corporation of Delhi' }] });
            }
            if (url.pathname === `/1/file/${encodeURIComponent('in.gov.mcd-BTCER-123')}`) { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(PDF); }
            return json({ error: 'not found' }, 404);
        });
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

describe('admission — documents from DigiLocker', () => {
    let s; let portal; let round; let g; let app; let fake; const seen = {};
    before(async () => {
        fake = await fakeDigilocker(seen);
        await H.startServer({
            DIGILOCKER_CLIENT_ID: 'dl-client', DIGILOCKER_CLIENT_SECRET: 'dl-secret', DIGILOCKER_REDIRECT_URI: 'http://127.0.0.1/api/admission/digilocker/callback',
            DIGILOCKER_BASE_URL: `http://127.0.0.1:${fake.address().port}`, FRONTEND_URL: 'http://front.test',
        });
        s = await H.makeSchool('Digi');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 5 });
        g = await H.registerGuest(s, portal.slug);
        const c = await H.api('POST', '/admission/portal/applications', { token: g.token, body: { round: round._id, class: s.classes[0]._id } });
        app = c.body.data;
        await H.api('PUT', `/admission/portal/applications/${app._id}`, { token: g.token, body: { data: H.goodAnswers({ studentName: 'Kiran Rao', studentDob: '2021-03-13' }) } });
    });
    after(async () => { fake.close(); await H.finish(); });

    const callback = (q) => fetch(`${H.BASE}/api/admission/digilocker/callback?${new URLSearchParams(q)}`, { redirect: 'manual' });
    let state;

    it('starts a connection with a state and a PKCE challenge', async () => {
        assert.equal((await H.api('GET', `/admission/portal/applications/${app._id}/digilocker`, { token: g.token })).body.data.available, true);
        const r = await H.api('POST', `/admission/portal/applications/${app._id}/digilocker/start`, { token: g.token });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const u = new URL(r.body.data.url);
        assert.equal(u.pathname, '/1/authorize');
        assert.equal(u.searchParams.get('client_id'), 'dl-client');
        assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
        state = u.searchParams.get('state');
        assert.ok(state.length >= 30);
        const [row] = await H.q(`SELECT "codeVerifier" FROM "admissiondigilockersessions" WHERE "state" = $1`, [state]);
        assert.equal(crypto.createHash('sha256').update(row.codeVerifier).digest('base64url'), u.searchParams.get('code_challenge'));
    });

    it('comes back through the callback — a forged state goes nowhere — and keeps the token encrypted', async () => {
        const forged = await callback({ code: 'good-code', state: 'not-a-state' });
        assert.equal(forged.status, 303);
        assert.equal(forged.headers.get('location'), 'http://front.test/');
        const r = await callback({ code: 'good-code', state });
        assert.equal(r.status, 303);
        assert.equal(r.headers.get('location'), `http://front.test/${portal.slug}/applications/${app._id}?digilocker=connected`);
        assert.ok(seen.verifier, 'the verifier was sent with the code');
        const [row] = await H.q(`SELECT "status", "token", "account", "codeVerifier" FROM "admissiondigilockersessions" WHERE "state" = $1`, [state]);
        assert.equal(row.status, 'connected');
        assert.ok(row.token && !row.token.includes('AT-secret-1'), 'the token is not kept as it came');
        assert.equal(row.codeVerifier, '', 'the verifier is used once');
        assert.equal(row.account.dob, '2021-03-13');
        assert.equal((await callback({ code: 'good-code', state })).headers.get('location').endsWith('?digilocker=failed'), true, 'a state works once');
    });

    it('lists the issued documents and fetches one through the upload\'s own checks, marked with its issuer', async () => {
        const v = (await H.api('GET', `/admission/portal/applications/${app._id}/digilocker`, { token: g.token })).body.data;
        assert.equal(v.status, 'connected');
        assert.equal(v.account.dobMatchesStudent, true);
        assert.deepEqual(v.files.map((f) => f.issuer), ['Municipal Corporation of Delhi']);
        assert.equal((await H.api('POST', `/admission/portal/applications/${app._id}/digilocker/import`, { token: g.token, body: { uri: 'in.gov.other-1', docKey: 'birth_certificate' } })).status, 404);
        const imp = await H.api('POST', `/admission/portal/applications/${app._id}/digilocker/import`, { token: g.token, body: { uri: 'in.gov.mcd-BTCER-123', docKey: 'birth_certificate' } });
        assert.equal(imp.status, 201, JSON.stringify(imp.body));
        assert.equal(imp.body.data.verified, false, 'not verified unless the school says so');
        const [d] = await H.q(`SELECT "origin", "originMeta", "status", "mime" FROM "admissiondocuments" WHERE "_id" = $1`, [imp.body.data._id]);
        assert.deepEqual([d.origin, d.originMeta.issuer, d.status, d.mime], ['digilocker', 'Municipal Corporation of Delhi', 'uploaded', 'application/pdf']);
    });

    it('verifies at once only where the school wrote that rule down', async () => {
        assert.equal((await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { digilocker: { autoVerify: true } } })).status, 200);
        await new Promise((r) => setTimeout(r, 15500));   // the 15-second settings cache
        const imp = await H.api('POST', `/admission/portal/applications/${app._id}/digilocker/import`, { token: g.token, body: { uri: 'in.gov.mcd-BTCER-123', docKey: 'birth_certificate' } });
        assert.equal(imp.status, 201, JSON.stringify(imp.body));
        assert.equal(imp.body.data.verified, true);
        const [d] = await H.q(`SELECT "status", "reviewNote" FROM "admissiondocuments" WHERE "_id" = $1`, [imp.body.data._id]);
        assert.equal(d.status, 'verified');
        assert.match(d.reviewNote, /Municipal Corporation of Delhi/);
    });

    it('records a refused connection as refused', async () => {
        const r = await H.api('POST', `/admission/portal/applications/${app._id}/digilocker/start`, { token: g.token });
        const st = new URL(r.body.data.url).searchParams.get('state');
        const back = await callback({ state: st, error: 'access_denied' });
        assert.ok(back.headers.get('location').endsWith('?digilocker=failed'));
        const v = (await H.api('GET', `/admission/portal/applications/${app._id}/digilocker`, { token: g.token })).body.data;
        assert.equal(v.status, 'failed');
        assert.deepEqual(v.files, []);
    });
});
