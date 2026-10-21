'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Each school's portal installs on a phone as that school's own app: a
 * manifest with its name, colour, start page and scope, and an icon drawn
 * from its initials and colours — letters and colours only.
 */
describe('admission — the portal as an installable app', () => {
    let s; let portal;
    before(async () => {
        await H.startServer({ FRONTEND_URL: 'https://app.example.test' });
        s = await H.makeSchool('Pwa');
        portal = await H.openPortal(s, { settings: { portal: { status: 'open', theme: { primary: '#0f766e', accent: '#14b8a6' } } } });
    });
    after(() => H.finish());

    it('serves a manifest of the school\'s own: name, colour, start page and scope', async () => {
        const r = await fetch(`${H.BASE}/api/admission/public/portals/${portal.slug}/manifest.webmanifest`);
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type'), /application\/manifest\+json/);
        const m = await r.json();
        assert.match(m.name, /^Admission Test Pwa .* Admissions$/);
        assert.equal(m.start_url, `https://app.example.test/${portal.slug}/dashboard`);
        assert.equal(m.scope, `https://app.example.test/${portal.slug}/`);
        assert.equal(m.id, m.scope, 'one app per school');
        assert.equal(m.theme_color, '#0f766e');
        assert.equal(m.display, 'standalone');
        assert.ok(m.icons.some((i) => i.type === 'image/svg+xml' && i.src.endsWith(`/api/admission/public/portals/${portal.slug}/icon.svg`)));
        assert.ok(m.icons.some((i) => i.sizes === '512x512'));
        assert.ok(m.short_name.length <= 20);
    });

    it('draws the icon from the initials and colours alone', async () => {
        const r = await fetch(`${H.BASE}/api/admission/public/portals/${portal.slug}/icon.svg`);
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
        const svg = await r.text();
        assert.ok(svg.includes('#0f766e') && svg.includes('#14b8a6'));
        assert.match(svg, />AT<\/text>/, 'Admission Test → AT');
        assert.ok(!/<script|on\w+=/i.test(svg));
        assert.equal((await fetch(`${H.BASE}/api/admission/public/portals/no-such-portal/manifest.webmanifest`)).status, 404);
    });
});
