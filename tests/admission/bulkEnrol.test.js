'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Enrolling a class at once: sections suggested so they fill evenly, each row
 * through the same enrolment as one at a time (a row that cannot be enrolled
 * says why; the rest go on; sending it again enrols nobody twice) — and the
 * offers forecast, which says nothing until the school's own history is
 * enough to go on.
 */
describe('admission — bulk enrolment and the offers forecast', () => {
    let s; let portal; let round; const g = []; const app = [];
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Bulk');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 10, admissionFee: 0 });
        const names = [['Asha Verma', 'Female'], ['Bilal Khan', 'Male'], ['Chitra Iyer', 'Female']];
        for (let i = 0; i < names.length; i++) {
            g[i] = await H.registerGuest(s, portal.slug);
            app[i] = await H.submittedApplication(s, g[i], round, { answers: { studentName: names[i][0], studentGender: names[i][1], studentDob: `2021-0${i + 1}-1${i}` } });
            await H.verifyAllDocs(s, app[i]._id);
            assert.equal((await H.api('POST', `/admission/admin/applications/${app[i]._id}/offer`, { token: s.adminToken, body: {} })).status, 201);
            assert.equal((await H.api('POST', `/admission/admin/applications/${app[i]._id}/offer/respond`, { token: s.adminToken, body: { accept: true, note: 'At the counter' } })).status, 200);
            const c = await H.api('POST', `/admission/admin/applications/${app[i]._id}/confirm`, { token: s.adminToken });
            assert.equal(c.status, 200, JSON.stringify(c.body));
        }
    });
    after(() => H.finish());

    let plan;
    it('lays out the class with sections that fill evenly — never past a section\'s room', async () => {
        const r = await H.api('GET', `/admission/admin/enrolment/plan?round=${round._id}&class=${s.classes[0]._id}`, { token: s.adminToken });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        plan = r.body.data;
        assert.equal(plan.rows.length, 3);
        const name = (id) => plan.sections.find((x) => String(x._id) === String(id))?.sectionName;
        // Section A holds 30, section B one: B takes exactly one.
        const counts = plan.rows.reduce((m, x) => ({ ...m, [name(x.section)]: (m[name(x.section)] || 0) + 1 }), {});
        assert.deepEqual(counts, { A: 2, B: 1 });
        assert.equal(plan.rows[0].parent.name, 'Amit Sharma', 'the parent from the form');
        assert.equal(plan.rows[0].studentEmail, '', 'the form did not ask for the student\'s email');
    });

    it('enrols each row as on its own — a row missing its email says so, the rest go on', async () => {
        const rows = plan.rows.map((x, i) => ({
            applicationId: x.applicationId, section: x.section, studentEmail: i === 2 ? '' : `kid${i}-${H.rand()}@kids.test`,
            parent: { mode: 'new', relation: 'Father', name: x.parent.name, email: `parent${i}-${H.rand()}@family.test`, phone: '98111000' + String(10 + i) },
        }));
        const r = await H.api('POST', '/admission/admin/enrolment/bulk', { token: s.adminToken, body: { rows } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual([r.body.data.enrolled, r.body.data.failed], [2, 1]);
        const bad = r.body.data.results.find((x) => !x.ok);
        assert.match(bad.message, /sign-in email/);
        const again = await H.api('POST', '/admission/admin/enrolment/bulk', { token: s.adminToken, body: { rows: rows.slice(0, 2) } });
        assert.deepEqual([again.body.data.enrolled, again.body.data.failed], [0, 0], 'enrolled once, however often it is sent');
        assert.ok(again.body.data.results.every((x) => x.ok && x.replay));
        const [n] = await H.q(`SELECT COUNT(*)::int AS n FROM "studentprofiles" WHERE "school" = $1`, [s.id]);
        assert.equal(n.n, 2);
        assert.equal((await H.api('POST', '/admission/admin/enrolment/bulk', { token: s.adminToken, body: { rows: Array.from({ length: 51 }, () => rows[0]) } })).status, 400, 'at most fifty at a time');
    });

    it('forecasts nothing without enough history — and from the school\'s own offers once there is', async () => {
        let f = (await H.api('GET', `/admission/admin/forecast?round=${round._id}`, { token: s.adminToken })).body.data;
        let c1 = f.classes.find((x) => String(x.class) === String(s.classes[0]._id));
        assert.deepEqual([c1.basis, c1.expected, c1.moreOffers], ['not_enough', null, 0], 'no made-up rate');
        // History: 3 confirmed (above), 7 accepted then lost, 10 declined — on earlier offers to the same families.
        const add = (i, status, responded) => H.insert('admissionoffers', {
            _id: H.uuid(), school: s.id, application: app[i % 3]._id, round: round._id, class: s.classes[0]._id, status,
            issuedAt: new Date(Date.now() - 86400e3), respondedAt: responded ? new Date() : null, offerNumber: `H${H.rand()}`, createdAt: new Date(), updatedAt: new Date(),
        });
        for (let i = 0; i < 7; i++) await add(i, 'withdrawn', true);
        for (let i = 0; i < 10; i++) await add(i, 'declined', true);
        f = (await H.api('GET', `/admission/admin/forecast?round=${round._id}`, { token: s.adminToken })).body.data;
        c1 = f.classes.find((x) => String(x.class) === String(s.classes[0]._id));
        assert.deepEqual([c1.basis, c1.acceptRate, c1.confirmRate], ['class', 0.5, 0.3]);
        assert.equal(c1.confirmed, 3);
        assert.equal(c1.expected, 3);
        assert.equal(c1.gap, 7);
        assert.equal(c1.moreOffers, 47, 'seven seats at 0.5 × 0.3 an offer');
    });
});
