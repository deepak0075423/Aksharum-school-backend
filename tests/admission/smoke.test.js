'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Level 1 — every admission route, read from the router itself so a new one
 * is never missed, called by every kind of caller with ids that do not exist,
 * ids that are not ids, and empty bodies. Each must answer with the right
 * refusal — and none may answer 500.
 */
const ROUTES = require('../../routes/api/admission.js').stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).filter((m) => m !== '_all').map((m) => ({ method: m.toUpperCase(), path: l.route.path })));

// Marking routes: administrators and an exam's evaluators (not only module admins).
const MARKING = new Set([
    'GET /admin/exams/:id/results', 'PUT /admin/exams/:id/marks', 'POST /admin/exams/:id/candidates/:candidateId/attendance',
    'POST /admin/exams/:id/results/submit', 'GET /admin/attempts/:attemptId', 'PUT /admin/attempts/:attemptId/evaluate',
]);

const fill = (path, slug, id, event) => `/admission${path}`
    .replace(':slug', slug)
    .replace(':event', event)
    .replace(/:[a-zA-Z]+/g, id);

describe('admission — level 1: every route answers every caller properly', () => {
    let s; let portal; let guest; const problems = [];
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Smoke');
        portal = await H.openPortal(s);
        await H.makeRound(s, portal.form);
        guest = await H.registerGuest(s, portal.slug);
    });
    after(() => H.finish());

    const call = async (who, token, r, id, event = 'status_update') => {
        const url = fill(r.path, portal.slug, id, event);
        const res = await H.api(r.method, url, { token, body: ['POST', 'PUT', 'PATCH'].includes(r.method) ? {} : undefined });
        if (res.status >= 500) problems.push(`${who} ${r.method} ${url} → ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
        return res.status;
    };

    it(`finds every route (${ROUTES.length})`, () => {
        assert.ok(ROUTES.length >= 160, `only ${ROUTES.length} routes found`);
    });

    it('refuses every non-public route without a session', async () => {
        for (const r of ROUTES) {
            const st = await call('anon', null, r, H.uuid());
            if (r.path.startsWith('/public/')) continue;
            // A webhook has no session: its signature is its guard (delivery.test.js), and
            // with no secret set it does not exist.
            if (r.path.startsWith('/webhooks/')) { if (![401, 404].includes(st)) problems.push(`anon ${r.method} ${r.path} → ${st}, expected 401 or 404`); continue; }
            // DigiLocker's return has no session either: its one-time state is its guard
            // (digilocker.test.js) — a call without one is sent to the front page, nothing more.
            if (r.path === '/digilocker/callback') { if (st >= 400) problems.push(`anon ${r.method} ${r.path} → ${st}`); continue; }
            if (st !== 401) problems.push(`anon ${r.method} ${r.path} → ${st}, expected 401`);
        }
    });

    it('keeps an applicant to the portal: every office and staff route refuses them', async () => {
        for (const r of ROUTES.filter((x) => x.path.startsWith('/admin/') || x.path.startsWith('/staff/'))) {
            const st = await call('guest', guest.token, r, H.uuid());
            if (st !== 403) problems.push(`guest ${r.method} ${r.path} → ${st}, expected 403`);
        }
    });

    it('keeps the office out of the applicant API', async () => {
        for (const r of ROUTES.filter((x) => x.path.startsWith('/portal/'))) {
            const st = await call('admin', s.adminToken, r, H.uuid());
            if (st !== 403) problems.push(`admin ${r.method} ${r.path} → ${st}, expected 403`);
        }
    });

    it('keeps a teacher without admission admin out of the office API (marking routes say not found)', async () => {
        for (const r of ROUTES.filter((x) => x.path.startsWith('/admin/'))) {
            const st = await call('teacher', s.teacherToken, r, H.uuid());
            const key = `${r.method} ${r.path}`;
            if (MARKING.has(key) ? ![403, 404].includes(st) : st !== 403) problems.push(`teacher ${key} → ${st}`);
        }
    });

    it('answers unknown ids, ids that are not ids and empty bodies without a server error', async () => {
        for (const r of ROUTES) {
            if (r.path.startsWith('/public/') || r.path.startsWith('/webhooks/') || r.path === '/digilocker/callback') {
                await call('anon', null, r, H.uuid());
                continue;
            }
            const token = r.path.startsWith('/portal/') ? guest.token : r.path.startsWith('/staff/') ? s.teacherToken : s.adminToken;
            for (const id of [H.uuid(), 'x1', "1' OR '1'='1"]) await call('caller', token, r, encodeURIComponent(id), id === 'x1' ? 'nope' : 'status_update');
        }
    });

    it('treats a body that is not JSON as a bad request', async () => {
        const res = await fetch(`${H.BASE}/api/admission/admin/rounds`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.adminToken}` }, body: '{"name": ' });
        assert.ok(res.status >= 400 && res.status < 500, `answered ${res.status}`);
    });

    it('found no server errors and no wrong refusals', () => {
        assert.deepEqual(problems, [], `\n${problems.slice(0, 40).join('\n')}${problems.length > 40 ? `\n…and ${problems.length - 40} more` : ''}`);
    });
});
