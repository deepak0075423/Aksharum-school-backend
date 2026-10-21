'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Level 2 — the office's own setup: settings and their bounds, the portal
 * address, number formats, rounds, document types, forms, enquiries,
 * applicant accounts, the dashboard's figures, exports and the activity log.
 */
describe('admission — level 2: the office sets admissions up', () => {
    let s; let other; let portal; let round;
    const put = (body) => H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body });
    before(async () => {
        await H.startServer();
        await H.clearRateLimits();
        s = await H.makeSchool('Office');
        other = await H.makeSchool('Office-B');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form);
    });
    after(() => H.finish());

    it('keeps every settings number inside the platform\'s bounds and drops what it does not know', async () => {
        const r = await put({
            security: { otpExpiryMinutes: 1, otpResendSeconds: 5, otpMaxAttempts: 100, otpMaxSendsPerHour: 0 },
            applications: { maxPerApplicant: 0, smuggled: true },
            selection: { offerValidityDays: 900, tieBreakers: ['score_desc', 'shoe_size'] },
            email: { reminders: { examHoursBefore: -5, paymentDaysBefore: 400 } },
            bogus: { anything: 1 },
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const d = r.body.data;
        assert.deepEqual([d.security.otpExpiryMinutes, d.security.otpResendSeconds, d.security.otpMaxAttempts, d.security.otpMaxSendsPerHour], [5, 30, 10, 3]);
        assert.equal(d.applications.maxPerApplicant, 1);
        assert.equal(d.applications.smuggled, undefined);
        assert.equal(d.bogus, undefined);
        assert.equal(d.selection.offerValidityDays, 60);
        assert.deepEqual(d.selection.tieBreakers, ['score_desc']);
        assert.deepEqual(d.email.reminders, { examHoursBefore: 0, paymentDaysBefore: 30 });
        assert.equal((await put({ bogus: {} })).status, 400, 'nothing known to save');
        await put({ applications: { maxPerApplicant: 3 }, security: { otpResendSeconds: 30, otpMaxAttempts: 3 } });
    });

    it('refuses markup, unsafe links and bad addresses in the portal\'s wording; versions the privacy notice', async () => {
        assert.equal((await put({ portal: { title: '<script>alert(1)</script>' } })).status, 400);
        assert.equal((await put({ portal: { header: { links: [{ label: 'Site', url: 'javascript:alert(1)' }] } } })).status, 400);
        assert.equal((await put({ portal: { contact: { email: 'not-an-email' } } })).status, 400);
        const before = (await H.api('GET', '/admission/admin/bootstrap', { token: s.adminToken })).body.data.settings.portal;
        const r = await put({ portal: { theme: { primary: 'red' }, privacyNotice: 'We keep your data safe. Version two.' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.data.portal.theme.primary, before.theme.primary, 'a colour that is not #rrggbb is not stored');
        assert.equal(r.body.data.portal.privacyVersion, before.privacyVersion + 1);
        assert.equal(r.body.data.portal.status, 'open', 'other portal settings kept');
    });

    it('keeps portal addresses unique, lowercase and clear of the app\'s own words', async () => {
        const check = async (slug, token = s.adminToken) => (await H.api('GET', `/admission/admin/settings/slug-check?slug=${encodeURIComponent(slug)}`, { token })).body.data;
        const save = (slug, token = s.adminToken) => H.api('PUT', '/admission/admin/settings/slug', { token, body: { slug } });
        assert.equal((await check('admin')).ok, false);
        for (const bad of ['admin', 'login', '-abc', 'ab', 'a'.repeat(41), 'my--school', 'my_school', 'école']) {
            assert.equal((await save(bad)).status, 400, bad);
        }
        await H.api('GET', '/admission/admin/bootstrap', { token: other.adminToken });
        assert.equal((await check(portal.slug, other.adminToken)).ok, false, 'another school sees it taken');
        assert.equal((await save(portal.slug.toUpperCase(), other.adminToken)).status, 400, 'case does not make a new address');
        const moved = await save('New-Address-Test');
        assert.equal(moved.status, 200);
        assert.equal(moved.body.data.slug, 'new-address-test');
        assert.equal((await H.api('GET', '/admission/public/portals/new-address-test')).status, 200);
        assert.equal((await H.api('GET', `/admission/public/portals/${portal.slug}`)).status, 404, 'the old address is gone');
        assert.equal((await save(portal.slug)).status, 200);
    });

    it('checks number formats, and previews them', async () => {
        const prev = async (t) => (await H.api('GET', `/admission/admin/settings/number-preview?template=${encodeURIComponent(t)}`, { token: s.adminToken })).body.data;
        const ok = await prev('APP{YYYY}{####}');
        assert.equal(ok.problem, null);
        assert.match(ok.preview, /^APP\d{4}0001$/);
        assert.ok((await prev('APP{####}{SEQ}')).problem, 'two running numbers');
        assert.ok((await prev('APP{FOO}{####}')).problem, 'unknown token');
        assert.ok((await prev('APP-{YYYY}')).problem, 'no running number');
        assert.equal((await put({ numbering: { application: 'APP{FOO}{###}' } })).status, 400);
    });

    it('validates rounds: the school\'s own year and classes, sensible dates, each class once, a form to open', async () => {
        const c1 = s.classes[0]._id;
        const post = (body) => H.api('POST', '/admission/admin/rounds', { token: s.adminToken, body });
        assert.equal((await post({})).status, 400);
        assert.equal((await post({ name: 'Late Round', academicYear: other.year._id })).status, 400, 'another school\'s year');
        assert.equal((await post({ name: 'Late Round', academicYear: s.year._id, opensAt: new Date(Date.now() + 86400000), closesAt: new Date() })).status, 400, 'closes before it opens');
        assert.equal((await post({ name: 'Late Round', academicYear: s.year._id, classes: [{ class: other.classes[0]._id }] })).status, 400, 'another school\'s class');
        assert.equal((await post({ name: 'Late Round', academicYear: s.year._id, classes: [{ class: c1 }, { class: c1 }] })).status, 400, 'a class twice');
        const r = await post({ name: 'Late Round', academicYear: s.year._id });
        assert.equal(r.status, 201);
        assert.equal(r.body.data.status, 'draft');
        const open = () => H.api('POST', `/admission/admin/rounds/${r.body.data._id}/status`, { token: s.adminToken, body: { status: 'open' } });
        assert.equal((await open()).status, 409, 'no classes yet');
        await H.api('PUT', `/admission/admin/rounds/${r.body.data._id}`, { token: s.adminToken, body: { classes: [{ class: c1, seats: 5 }], form: null } });
        assert.equal((await open()).status, 409, 'no published form for the class');
        await H.api('PUT', `/admission/admin/rounds/${r.body.data._id}`, { token: s.adminToken, body: { form: portal.form._id } });
        assert.equal((await open()).status, 200);
        assert.equal((await H.api('DELETE', `/admission/admin/rounds/${r.body.data._id}`, { token: s.adminToken })).status, 200, 'a round with nothing in it can go');
    });

    it('protects a round that has applications: its classes and year stay, it cannot be deleted, archived it takes none', async () => {
        const g = await H.registerGuest(s, portal.slug);
        await H.submittedApplication(s, g, round);
        const year2 = await H.insert('academicyears', { _id: H.uuid(), school: s.id, yearName: '2028-29', startDate: new Date('2028-04-01'), endDate: new Date('2029-03-31'), status: 'upcoming', createdAt: new Date() });
        const upd = (body) => H.api('PUT', `/admission/admin/rounds/${round._id}`, { token: s.adminToken, body });
        assert.equal((await upd({ classes: [{ class: s.classes[1]._id, seats: 10 }] })).status, 409, 'class 1 has an application');
        assert.equal((await upd({ academicYear: year2._id })).status, 409);
        assert.equal((await H.api('DELETE', `/admission/admin/rounds/${round._id}`, { token: s.adminToken })).status, 409);
        assert.equal((await H.api('POST', `/admission/admin/rounds/${round._id}/status`, { token: s.adminToken, body: { status: 'archived' } })).status, 200);
        const g2 = await H.registerGuest(s, portal.slug);
        const c = await H.api('POST', '/admission/portal/applications', { token: g2.token, body: { round: round._id, class: s.classes[0]._id } });
        assert.equal(c.status, 409, 'an archived round takes no applications');
        await H.api('POST', `/admission/admin/rounds/${round._id}/status`, { token: s.adminToken, body: { status: 'open' } });
    });

    it('manages document types: keys, formats, reviewers, and switching off what is in use instead of deleting it', async () => {
        const post = (body) => H.api('POST', '/admission/admin/document-types', { token: s.adminToken, body });
        const made = await post({ name: 'Caste certificate', accept: ['pdf'] });
        assert.equal(made.status, 201);
        assert.equal(made.body.data.key, 'caste_certificate');
        assert.equal((await post({ name: 'Caste certificate', accept: ['pdf'] })).status, 409, 'same key');
        assert.equal((await post({ name: 'No formats', accept: [] })).status, 400);
        assert.equal((await post({ name: 'Foreign reviewer', accept: ['pdf'], reviewers: [other.admin._id] })).status, 400);
        assert.equal((await post({ name: 'Bad target', accept: ['pdf'], mapsTo: 'salary' })).status, 400);
        const del = await H.api('DELETE', `/admission/admin/document-types/${made.body.data._id}`, { token: s.adminToken });
        assert.equal(del.body.data.deleted, true);
        const photo = portal.docTypes.find((t) => t.key === 'photo');
        const kept = await H.api('DELETE', `/admission/admin/document-types/${photo._id}`, { token: s.adminToken });
        assert.equal(kept.body.data.archived, true, 'in use: switched off, not deleted');
        await H.api('PUT', `/admission/admin/document-types/${photo._id}`, { token: s.adminToken, body: { isActive: true } });
        const ids = portal.docTypes.map((t) => t._id).reverse();
        assert.equal((await H.api('PUT', '/admission/admin/document-types/order', { token: s.adminToken, body: { ids } })).status, 200);
        const list = (await H.api('GET', '/admission/admin/document-types', { token: s.adminToken })).body.data;
        assert.deepEqual(list.filter((t) => ids.includes(t._id)).map((t) => t._id), ids);
    });

    it('builds forms from the standard one, a blank one or a copy; refuses a broken one; guards deleting', async () => {
        const blank = await H.api('POST', '/admission/admin/forms', { token: s.adminToken, body: { name: 'Blank form' } });
        assert.equal(blank.status, 201);
        const copy = await H.api('POST', '/admission/admin/forms', { token: s.adminToken, body: { name: 'Copy form', from: portal.form._id } });
        assert.equal(copy.status, 201);
        const full = (await H.api('GET', `/admission/admin/forms/${copy.body.data._id}`, { token: s.adminToken })).body.data;
        const original = (await H.api('GET', `/admission/admin/forms/${portal.form._id}`, { token: s.adminToken })).body.data;
        assert.equal(full.draft.schema.sections.length, original.current.schema.sections.length);
        const broken = { sections: [{ key: 'a', title: 'A', fields: [{ key: 'x1', type: 'text', label: 'One' }, { key: 'x1', type: 'text', label: 'Two' }] }] };
        const bad = await H.api('PUT', `/admission/admin/forms/${blank.body.data._id}/draft`, { token: s.adminToken, body: { schema: broken } });
        assert.equal(bad.status, 400);
        assert.ok(Array.isArray(bad.body.errors) && bad.body.errors.length >= 1, 'every problem is listed');
        const pub = await H.api('POST', `/admission/admin/forms/${copy.body.data._id}/publish`, { token: s.adminToken, body: { changeNote: 'First version' } });
        assert.equal(pub.status, 200);
        assert.equal(pub.body.data.version, 1);
        assert.equal((await H.api('POST', `/admission/admin/forms/${copy.body.data._id}/publish`, { token: s.adminToken, body: {} })).status, 409, 'nothing new to publish');
        assert.equal((await H.api('DELETE', `/admission/admin/forms/${portal.form._id}`, { token: s.adminToken })).status, 409, 'applications were made on it');
        assert.equal((await H.api('DELETE', `/admission/admin/forms/${blank.body.data._id}`, { token: s.adminToken })).status, 200);
    });

    it('takes enquiries from the portal, checked, and the office follows them up', async () => {
        await H.clearRateLimits();
        const send = (body) => H.api('POST', `/admission/public/portals/${portal.slug}/enquiries`, { body });
        const ok = await send({ name: 'Ravi Kumar', email: 'ravi@family.test', phone: '9811122233', class: s.classes[1]._id, message: 'Is there a school bus from Baner?' });
        assert.ok([200, 201].includes(ok.status), JSON.stringify(ok.body));
        assert.equal((await send({ name: 'Ravi Kumar', phone: '12345' })).status, 400);
        assert.equal((await send({ name: 'Ravi Kumar', email: 'ravi@family.test', message: '<img src=x onerror=alert(1)>' })).status, 400);
        assert.equal((await send({ name: 'R4vi', email: 'ravi@family.test' })).status, 400, 'a name is letters');
        const list = (await H.api('GET', '/admission/admin/enquiries', { token: s.adminToken })).body;
        const e = list.data.find((x) => x.email === 'ravi@family.test');
        assert.ok(e && e.status === 'new' && list.counts.new >= 1);
        const upd = await H.api('PATCH', `/admission/admin/enquiries/${e._id}`, { token: s.adminToken, body: { status: 'contacted', note: 'Called back, sent the bus routes.' } });
        assert.equal(upd.body.data.status, 'contacted');
        assert.equal(upd.body.data.notes.length, 1);
        assert.equal((await H.api('PATCH', `/admission/admin/enquiries/${e._id}`, { token: s.adminToken, body: { status: 'lost' } })).status, 400);
        await H.clearRateLimits();
    });

    it('switches an applicant account off — at once — and on again', async () => {
        const g = await H.registerGuest(s, portal.slug);
        assert.equal((await H.api('GET', '/admission/portal/me', { token: g.token })).status, 200);
        assert.equal((await H.api('PATCH', `/admission/admin/applicants/${g.user._id}`, { token: s.adminToken, body: { isActive: false } })).status, 200);
        assert.ok([401, 403].includes((await H.api('GET', '/admission/portal/me', { token: g.token })).status), 'an existing session stops working');
        assert.equal((await H.api('PATCH', `/admission/admin/applicants/${g.user._id}`, { token: s.adminToken, body: { isActive: true } })).status, 200);
        assert.equal((await H.api('GET', '/admission/portal/me', { token: g.token })).status, 200);
        assert.equal((await H.api('PATCH', `/admission/admin/applicants/${other.admin._id}`, { token: s.adminToken, body: { isActive: false } })).status, 404, 'only applicants of this school');
    });

    it('counts the dashboard from the data itself', async () => {
        const g = await H.registerGuest(s, portal.slug);
        await H.api('POST', '/admission/portal/applications', { token: g.token, body: { round: round._id, class: s.classes[1]._id } });
        const k = (await H.api('GET', '/admission/admin/analytics', { token: s.adminToken })).body.data;
        const [c] = await H.q(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE "status" = 'draft')::int AS drafts, COUNT(*) FILTER (WHERE "submittedAt" IS NOT NULL)::int AS submitted FROM "admissionapplications" WHERE "school" = $1`, [s.id]);
        const [gu] = await H.q(`SELECT COUNT(*)::int AS n FROM "users" WHERE "school" = $1 AND "role" = 'guest'`, [s.id]);
        const [en] = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionenquiries" WHERE "school" = $1`, [s.id]);
        assert.deepEqual([k.kpis.total, k.kpis.drafts, k.kpis.submitted, k.kpis.guests, k.kpis.enquiries], [c.total, c.drafts, c.submitted, gu.n, en.n]);
        const funnel = Object.fromEntries(k.funnel.map((f) => [f.key, f.n]));
        assert.equal(funnel.started, c.total);
        assert.equal(funnel.submitted, c.submitted);
        const byClass = (await H.api('GET', `/admission/admin/analytics?class=${s.classes[1]._id}`, { token: s.adminToken })).body.data.kpis;
        assert.equal(byClass.total, (await H.q(`SELECT COUNT(*)::int AS n FROM "admissionapplications" WHERE "school" = $1 AND "class" = $2`, [s.id, s.classes[1]._id]))[0].n, 'filters apply');
    });

    it('exports what the list shows — as CSV, Excel and PDF — with formula cells defused', async () => {
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { applications: { maxPerApplicant: 3 } } });
        const round2 = await H.makeRound(s, portal.form, { extra: { name: 'Export Round' } });
        const g = await H.registerGuest(s, portal.slug);
        await H.submittedApplication(s, g, round2, { classIdx: 1, answers: { studentName: 'Esha Kapoor', studentDob: '2020-03-03', addressLine: '=HYPERLINK("http://evil.test","open me")' } });
        const csv = await H.api('GET', `/admission/admin/applications/export?format=csv&round=${round2._id}`, { token: s.adminToken });
        assert.equal(csv.status, 200);
        assert.match(csv.headers.get('content-type'), /text\/csv/);
        const text = csv.body.toString('utf8');
        assert.ok(text.includes('Esha Kapoor'));
        assert.ok(text.includes("'=HYPERLINK"), 'the formula is turned into text');
        assert.ok(!/(^|,)"?=HYPERLINK/m.test(text), 'no cell starts with =');
        const xlsx = await H.api('GET', `/admission/admin/applications/export?format=xlsx&round=${round2._id}`, { token: s.adminToken });
        assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
        assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK', 'a real .xlsx (zip)');
        const pdf = await H.api('GET', `/admission/admin/applications/export?format=pdf&round=${round2._id}`, { token: s.adminToken });
        assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
    });

    it('records who changed what in the activity log, searchable', async () => {
        const log = (await H.api('GET', '/admission/admin/audit?type=config', { token: s.adminToken })).body;
        assert.ok(log.total > 0);
        assert.ok(log.data.every((e) => e.type === 'config'));
        assert.ok(log.data.some((e) => e.actorName === 'Office Admin' && /Round "Late Round" created/.test(e.message)));
        const found = (await H.api('GET', '/admission/admin/audit?q=late%20round', { token: s.adminToken })).body.data;
        assert.ok(found.length >= 1);
    });
});
