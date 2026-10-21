'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * The school's cookie policy (School Settings → Privacy & cookies): only the
 * school admin sets it, it is validated data (an ID, never a script), the
 * banner on the portal shows only what is switched on, and every answer is
 * logged against the version it was given for.
 */
describe('cookie policy — set up by the school admin, asked for on the portal', () => {
    let s; let other; let portal; let guest;
    const get = (token = s.adminToken) => H.api('GET', '/admin/cookie-policy', { token });
    const put = (body, token = s.adminToken) => H.api('PUT', '/admin/cookie-policy', { token, body });
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Cookie');
        other = await H.makeSchool('Cookie-B');
        portal = await H.openPortal(s);
        guest = await H.registerGuest(s, portal.slug);
    });
    after(() => H.finish());

    it('is for the school admin only', async () => {
        assert.equal((await get()).status, 200);
        assert.equal((await get(s.teacherToken)).status, 403);
        assert.equal((await get(guest.token)).status, 403);
        assert.equal((await H.api('GET', '/admin/cookie-policy')).status, 401);
    });

    it('starts from honest defaults: essential storage only, listed in full', async () => {
        const d = (await get()).body.data;
        assert.equal(d.policy.saved, false);
        assert.equal(d.banner.hasOptional, false);
        assert.match(d.banner.text, /only essential storage/);
        const names = d.page.items.map((x) => x.name);
        for (const n of ['aks_cookie_consent', 'aks_ft', 'portalSlug']) assert.ok(names.includes(n), n);
        assert.deepEqual(d.banner.tags, { ga4: '', metaPixel: '' });
        assert.match(d.portalUrl, new RegExp(`/${portal.slug}/cookies$`));
    });

    it('takes an analytics ID only with Analytics on — and never markup or a script', async () => {
        const cur = (await get()).body.data.policy;
        const withGa = (cats, ga) => ({ ...cur, categories: { ...cur.categories, ...cats }, integrations: { ga4MeasurementId: ga, metaPixelId: '' } });
        assert.equal((await put(withGa({}, 'G-ABCDE12345'))).status, 400, 'Analytics is off');
        assert.equal((await put(withGa({ analytics: { enabled: true, description: 'Counts visits.' } }, '<script>x</script>'))).status, 400);
        assert.equal((await put(withGa({ analytics: { enabled: true, description: 'Counts visits.' } }, 'UA-1234-1'))).status, 400, 'old Universal Analytics ids are not GA4');
        assert.equal((await put({ ...cur, sections: [{ title: 'Hello', body: '<img src=x onerror=alert(1)>' }] })).status, 400);
        assert.equal((await put({ ...cur, consentDays: 5 })).status, 400);
        assert.equal((await put({ ...cur, items: [{ name: 'track_me', provider: 'Ads Co', category: 'marketing', type: 'cookie', duration: '1 year', purpose: 'Ads.' }] })).status, 400, 'its category is off');
        const ok = await put(withGa({ analytics: { enabled: true, description: 'Counts visits.' } }, 'g-abcde12345'));
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.data.policy.integrations.ga4MeasurementId, 'G-ABCDE12345');
    });

    it('asks visitors again only when what they agree to changes', async () => {
        const v1 = (await get()).body.data.policy;
        const reworded = await put({ ...v1, sections: [{ title: 'About', body: 'New words, same cookies.' }] });
        assert.equal(reworded.body.data.policy.version, v1.version, 'rewording is not a new agreement');
        const tagged = await put({ ...reworded.body.data.policy, categories: { ...reworded.body.data.policy.categories, marketing: { enabled: true, description: 'Ads.' } }, integrations: { ...reworded.body.data.policy.integrations, metaPixelId: '123456789012' } });
        assert.equal(tagged.status, 200, JSON.stringify(tagged.body));
        assert.equal(tagged.body.data.policy.version, v1.version + 1);
    });

    it('shows the portal only the switched-on categories and their tags', async () => {
        const pub = (await H.api('GET', `/admission/public/portals/${portal.slug}`)).body.data.cookies;
        assert.equal(pub.hasOptional, true);
        assert.deepEqual(pub.categories.map((c) => c.key).sort(), ['analytics', 'marketing']);
        assert.equal(pub.tags.ga4, 'G-ABCDE12345');
        assert.equal(pub.tags.metaPixel, '123456789012');
        assert.equal(pub.policy, undefined, 'the banner carries no admin-only data');
        const page = (await H.api('GET', `/admission/public/portals/${portal.slug}/cookie-policy`)).body.data.page;
        assert.ok(page.items.some((x) => x.name === '_ga' && x.category === 'analytics'), 'the tag\'s own cookies are declared');
        assert.ok(page.items.some((x) => x.name === '_fbp'));
    });

    it('logs each answer against its version, and refuses a stale one', async () => {
        const pub = (await H.api('GET', `/admission/public/portals/${portal.slug}`)).body.data.cookies;
        const visitor = `v-${H.rand()}-${H.rand()}-${H.rand()}`;
        const send = (body) => H.api('POST', `/admission/public/portals/${portal.slug}/cookie-consent`, { body: { visitor, ...body } });
        assert.equal((await send({ version: pub.version - 1, action: 'accept_all' })).status, 409);
        assert.equal((await send({ version: pub.version, action: 'sell_my_data' })).status, 400);
        const custom = await send({ version: pub.version, action: 'custom', choices: { analytics: true, marketing: false, preferences: true } });
        assert.equal(custom.status, 201);
        assert.deepEqual(custom.body.data.choices, { preferences: false, analytics: true, marketing: false }, 'a category the school does not use cannot be allowed');
        const rows = await H.q(`SELECT "action", "choices", "ipHash", "version" FROM "cookieconsents" WHERE "school" = $1 AND "visitor" = $2`, [s.id, visitor]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].version, pub.version);
        assert.match(rows[0].ipHash, /^[0-9a-f]{32}$/, 'the address is kept only as a hash');
        const stats = (await H.api('GET', '/admin/cookie-policy/consents?days=30', { token: s.adminToken })).body.data;
        assert.equal(stats.byAction.custom, 1);
        const theirs = (await H.api('GET', '/admin/cookie-policy/consents?days=30', { token: other.adminToken })).body.data;
        assert.equal(theirs.total, 0, 'another school sees none of these answers');
        const csv = await H.api('GET', '/admin/cookie-policy/consents?format=csv', { token: s.adminToken });
        assert.equal(csv.status, 200);
        assert.match(csv.body.toString(), /^When,Choice,/);
    });

    it('shows a signed-in person their own school\'s policy, and everyone else the platform\'s', async () => {
        const mine = (await H.api('GET', '/profile/cookie-policy', { token: s.teacherToken })).body.data.page;
        assert.match(mine.schoolName, /Admission Test Cookie /);
        assert.ok(mine.items.some((x) => x.name === '_ga'));
        const theirs = (await H.api('GET', '/profile/cookie-policy', { token: other.teacherToken })).body.data.page;
        assert.ok(!theirs.items.some((x) => x.name === '_ga'), 'school B never sees school A\'s tags');
        const platform = (await H.api('GET', '/public/cookie-policy')).body.data;
        assert.equal(platform.page.schoolName, '');
        assert.equal(platform.banner.hasOptional, false);
    });

    it('goes back to the defaults on request — every optional category off', async () => {
        const r = await H.api('POST', '/admin/cookie-policy/reset', { token: s.adminToken });
        assert.equal(r.status, 200);
        assert.equal(r.body.data.banner.hasOptional, false);
        assert.deepEqual(r.body.data.banner.tags, { ga4: '', metaPixel: '' });
        const pub = (await H.api('GET', `/admission/public/portals/${portal.slug}`)).body.data.cookies;
        assert.equal(pub.tags.ga4, '');
    });
});
