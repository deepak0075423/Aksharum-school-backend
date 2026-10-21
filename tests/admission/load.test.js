'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Level 7 — load: a large school group's season (20,000 applications, 5,000
 * documents waiting) and many people working at once. Opt-in, because seeding
 * takes a while:
 *
 *   ADMISSION_LOAD=1 node --test --test-force-exit tests/admission/load.test.js
 *
 * Timings are printed (LOAD: …) as well as checked against generous limits.
 */
const RUN = process.env.ADMISSION_LOAD === '1';
const N = 20000;
const DOCS = 5000;
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]; };

describe('admission — level 7: a busy season', { skip: !RUN && 'set ADMISSION_LOAD=1 to run' }, () => {
    let s; let portal; let round; let guest; let sampleId;
    const timed = async (url, token = s.adminToken) => { const t = Date.now(); const r = await H.api('GET', url, { token }); return { ms: Date.now() - t, r }; };
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Load');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 2000, seats2: 2000 });
        guest = await H.registerGuest(s, portal.slug);
        const versionId = (await H.q(`SELECT "currentVersion" FROM "admissionforms" WHERE "_id" = $1`, [portal.form._id]))[0].currentVersion;
        const types = (await H.q(`SELECT "_id", "key" FROM "admissiondocumenttypes" WHERE "school" = $1`, [s.id]));
        const statuses = ['draft', 'submitted', 'under_review', 'documents_pending', 'verified', 'exam_scheduled', 'exam_completed', 'selected', 'waitlisted', 'rejected', 'offer_issued', 'confirmed'];
        const t0 = Date.now();
        const appIds = [];
        for (let start = 0; start < N; start += 500) {
            const values = []; const params = [];
            for (let i = start; i < Math.min(N, start + 500); i++) {
                const id = H.uuid(); appIds.push(id);
                const st = statuses[i % statuses.length];
                const b = params.length;
                params.push(id, s.id, round._id, s.year._id, s.classes[i % 2]._id, guest.user._id, portal.form._id, versionId,
                    st === 'draft' ? null : `LD${String(i).padStart(6, '0')}`, st, `Pupil ${String(i).padStart(5, '0')}`, st === 'draft' ? null : new Date(Date.now() - i * 30000),
                    JSON.stringify({ studentName: `Pupil ${i}`, city: i % 3 ? 'Pune' : 'Nashik', addressLine: `${i} Lake Road` }), `9${String(800000000 + i).padStart(9, '0')}`,
                    i % 5 === 0 ? 'Website' : i % 5 === 1 ? 'Newspaper' : '', i % 7 === 0 ? s.teacher._id : null);
                values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, 'submitted', $${b + 11}, $${b + 12}, $${b + 13}::jsonb, $${b + 14}, $${b + 15}, $${b + 16}, now(), now(), 'not_required', 'not_required', 'under_review', now())`);
            }
            await H.q(`INSERT INTO "admissionapplications" ("_id", "school", "round", "academicYear", "class", "applicant", "form", "formVersion", "applicationNumber", "status", "stage", "studentName", "submittedAt", "data", "guardianPhone", "source", "assignedTo", "createdAt", "updatedAt", "applicationFeeStatus", "admissionFeeStatus", "docStatus", "statusChangedAt") VALUES ${values.join(', ')}`, params);
        }
        sampleId = appIds[N - 3];
        for (let start = 0; start < DOCS; start += 500) {
            const values = []; const params = [];
            for (let i = start; i < Math.min(DOCS, start + 500); i++) {
                const t = types[i % types.length];
                const b = params.length;
                params.push(H.uuid(), s.id, appIds[(i * 3) % N + (((i * 3) % N) % 12 === 0 ? 1 : 0)], t._id, t.key, `${s.id}/load-${i}.png`, `scan-${i}.png`);
                values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, 'image/png', 1024, 'uploaded', 1, true, now() - interval '${i % 9} days', now())`);
            }
            await H.q(`INSERT INTO "admissiondocuments" ("_id", "school", "application", "docType", "docKey", "file", "originalName", "mime", "size", "status", "version", "current", "createdAt", "updatedAt") VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`, params);
        }
        await H.q('ANALYZE "admissionapplications"');
        await H.q('ANALYZE "admissiondocuments"');
        console.log(`LOAD: seeded ${N} applications and ${DOCS} documents in ${Date.now() - t0}ms`);
    });
    after(() => H.finish());

    it('lists, searches and filters 20,000 applications quickly', async () => {
        const urls = [
            '/admission/admin/applications?limit=25', '/admission/admin/applications?limit=25&sort=name', '/admission/admin/applications?limit=25&sort=status',
            '/admission/admin/applications?limit=25&page=400', '/admission/admin/applications?q=Pupil%2012345', '/admission/admin/applications?q=9800012345',
            '/admission/admin/applications?status=verified,selected&limit=25', `/admission/admin/applications?class=${s.classes[1]._id}&limit=25`,
            `/admission/admin/applications?assignedTo=${s.teacher._id}&limit=25`, '/admission/admin/applications?view=active&docStatus=under_review&limit=25',
            '/admission/admin/applications?source=Website&limit=25', '/admission/admin/applications?q=LD0199',
        ];
        const times = [];
        for (let k = 0; k < 3; k++) for (const u of urls) { const { ms, r } = await timed(u); assert.equal(r.status, 200, u); times.push(ms); }
        const search = await timed('/admission/admin/applications?q=Pupil%2012345');
        assert.equal(search.r.body.total, 1);
        console.log(`LOAD: list/search/filter over ${times.length} requests — p50 ${pct(times, 50)}ms, p95 ${pct(times, 95)}ms, max ${Math.max(...times)}ms`);
        assert.ok(pct(times, 95) < 800, `p95 ${pct(times, 95)}ms`);
    });

    it('answers the dashboard, one application and the document queue quickly', async () => {
        const dash = []; for (let k = 0; k < 5; k++) dash.push((await timed('/admission/admin/analytics')).ms);
        const detail = []; for (let k = 0; k < 5; k++) detail.push((await timed(`/admission/admin/applications/${sampleId}`)).ms);
        const queue = []; for (let k = 0; k < 5; k++) queue.push((await timed('/admission/admin/documents?page=50')).ms);
        console.log(`LOAD: dashboard p95 ${pct(dash, 95)}ms · application detail p95 ${pct(detail, 95)}ms · document queue p95 ${pct(queue, 95)}ms`);
        assert.ok(pct(dash, 95) < 3000);
        assert.ok(pct(detail, 95) < 1000);
        assert.ok(pct(queue, 95) < 1000);
    });

    it('exports all 20,000 rows, answers included, in seconds', async () => {
        const { ms, r } = await timed('/admission/admin/applications/export?format=xlsx');
        assert.equal(r.status, 200);
        console.log(`LOAD: export of ${N} applications with answers (xlsx, ${(r.body.length / 1024 / 1024).toFixed(1)} MB) in ${ms}ms`);
        assert.ok(ms < 20000);
    });

    it('stays correct and responsive with 60 people working at once', async () => {
        const urls = Array.from({ length: 60 }, (_, i) => [
            `/admission/admin/applications?limit=25&page=${(i % 40) + 1}`, '/admission/admin/analytics', `/admission/admin/applications/${sampleId}`,
            '/admission/admin/documents', `/admission/admin/applications?q=Pupil%20${String(i * 7).padStart(5, '0')}`,
        ][i % 5]);
        const t = Date.now();
        const res = await Promise.all(urls.map((u) => timed(u)));
        const wall = Date.now() - t;
        assert.ok(res.every((x) => x.r.status === 200), `statuses ${[...new Set(res.map((x) => x.r.status))]}`);
        const times = res.map((x) => x.ms);
        console.log(`LOAD: 60 concurrent requests — all 200, p50 ${pct(times, 50)}ms, p95 ${pct(times, 95)}ms, wall ${wall}ms`);
        assert.ok(pct(times, 95) < 6000);
        const totals = new Set(res.filter((x, i) => i % 5 === 0).map((x) => x.r.body.total));
        assert.equal(totals.size, 1, 'every page saw the same total');
    });
});
