'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * The office's busiest screens with a busy school's data: paging is exact,
 * filters and counts agree, and nothing loads the whole table to answer.
 */
describe('admission — lists and dashboard at scale', () => {
    let s; let portal; let round;
    const N = 1500;
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Scale');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 200, seats2: 200 });
        const versionId = (await H.q(`SELECT "currentVersion" FROM "admissionforms" WHERE "_id" = $1`, [portal.form._id]))[0].currentVersion;
        const guest = await H.registerGuest(s, portal.slug);
        const statuses = ['draft', 'submitted', 'under_review', 'verified', 'exam_completed', 'waitlisted', 'rejected'];
        const values = [];
        const params = [];
        for (let i = 0; i < N; i++) {
            const st = statuses[i % statuses.length];
            const base = params.length;
            params.push(H.uuid(), s.id, round._id, s.year._id, s.classes[i % 2]._id, guest.user._id, portal.form._id, versionId,
                st === 'draft' ? '' : `SC${String(i).padStart(6, '0')}`, st, `Student ${String(i).padStart(4, '0')}`, st === 'draft' ? null : new Date(Date.now() - i * 60000),
                JSON.stringify({ studentName: `Student ${i}` }), `98765${String(i).padStart(5, '0')}`);
            values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, 'submitted', $${base + 11}, $${base + 12}, $${base + 13}::jsonb, $${base + 14}, now(), now(), 'not_required', 'not_required', 'none')`);
            if (values.length === 300 || i === N - 1) {
                await H.q(`INSERT INTO "admissionapplications" ("_id", "school", "round", "academicYear", "class", "applicant", "form", "formVersion", "applicationNumber", "status", "stage", "studentName", "submittedAt", "data", "guardianPhone", "createdAt", "updatedAt", "applicationFeeStatus", "admissionFeeStatus", "docStatus") VALUES ${values.join(', ')}`, params);
                values.length = 0; params.length = 0;
            }
        }
    });
    after(() => H.finish());

    it('pages exactly: no row twice, none missed, the same total every page', async () => {
        const seen = new Set();
        let total = null;
        for (let page = 1; page <= 4; page++) {
            const r = await H.api('GET', `/admission/admin/applications?limit=100&page=${page}&sort=number`, { token: s.adminToken });
            assert.equal(r.status, 200);
            assert.equal(r.body.data.length, 100);
            total = total ?? r.body.total;
            assert.equal(r.body.total, total);
            for (const a of r.body.data) { assert.ok(!seen.has(a._id), 'a row on two pages'); seen.add(a._id); }
            assert.ok(!('data' in r.body.data[0]), 'answers are not sent with the list');
        }
        assert.equal(total, N);
        assert.equal(seen.size, 400);
    });

    it('filters, searches and counts in the database', async () => {
        const all = await H.api('GET', '/admission/admin/applications?limit=5', { token: s.adminToken });
        const facetSum = Object.values(all.body.facets).reduce((a, b) => a + b, 0);
        assert.equal(facetSum, N);
        const verified = await H.api('GET', '/admission/admin/applications?status=verified&limit=5', { token: s.adminToken });
        assert.equal(verified.body.total, all.body.facets.verified);
        const search = await H.api('GET', '/admission/admin/applications?q=Student%200042', { token: s.adminToken });
        assert.equal(search.body.total, 1);
        const cls = await H.api('GET', `/admission/admin/applications?class=${s.classes[1]._id}&limit=5`, { token: s.adminToken });
        assert.equal(cls.body.total, N / 2);
    });

    it('answers the list, the dashboard and an export quickly', async () => {
        const time = async (url) => { const t = Date.now(); const r = await H.api('GET', url, { token: s.adminToken }); assert.equal(r.status, 200); return Date.now() - t; };
        const list = await time('/admission/admin/applications?limit=50&sort=submitted');
        const dash = await time('/admission/admin/analytics');
        const exp = await time('/admission/admin/applications/export?format=csv&answers=0');
        assert.ok(list < 1500, `list took ${list}ms`);
        assert.ok(dash < 3000, `dashboard took ${dash}ms`);
        assert.ok(exp < 5000, `export took ${exp}ms`);
        const a = await H.api('GET', '/admission/admin/analytics', { token: s.adminToken });
        assert.equal(a.body.data.kpis.total, N + 0);
        assert.equal(a.body.data.kpis.drafts, a.body.data.byClass.reduce((x, c) => x + c.total, 0) - a.body.data.byClass.reduce((x, c) => x + c.submitted, 0));
    });
});
