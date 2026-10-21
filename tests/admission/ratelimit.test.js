'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Level 4 — the sign-in surface's rate limit, on a server started with a tight
 * one (5 a minute). In production nginx APPENDS the caller's real address to
 * X-Forwarded-For, after whatever the caller wrote there themselves; the limit
 * must follow the address nginx saw, or every request can claim a new one.
 */
describe('admission — level 4: rate limits cannot be dodged', () => {
    let s; let portal;
    before(async () => {
        await H.startServer({ RL_ADMISSION_MAX: '5', RL_ADMISSION_WINDOW: '60' });
        await H.clearRateLimits();
        s = await H.makeSchool('Limit');
        await H.api('GET', '/admission/admin/bootstrap', { token: s.adminToken });
        await H.api('PUT', '/admission/admin/settings/slug', { token: s.adminToken, body: { slug: `lim-${s.tag}` } });
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { portal: { status: 'open' } } });
        portal = { slug: `lim-${s.tag}` };
    });
    after(async () => { await H.clearRateLimits(); await H.finish(); });

    const login = (headers = {}) => H.api('POST', `/admission/public/portals/${portal.slug}/login`, { body: { email: 'nobody@family.test', password: 'Wrong12345' }, headers });

    it('stops a caller after the limit', async () => {
        const codes = [];
        for (let i = 0; i < 8; i++) codes.push((await login({ 'X-Forwarded-For': '203.0.113.7' })).status);
        assert.ok(codes.slice(5).every((c) => c === 429), `statuses: ${codes.join(',')}`);
    });

    it('is not reset by an address the caller writes into X-Forwarded-For themselves', async () => {
        await H.clearRateLimits();
        const codes = [];
        for (let i = 0; i < 8; i++) codes.push((await login({ 'X-Forwarded-For': `198.51.100.${i + 1}, 203.0.113.9` })).status);
        assert.ok(codes.slice(5).every((c) => c === 429), `a made-up first address dodged the limit: ${codes.join(',')}`);
    });
});
