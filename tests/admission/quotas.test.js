'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Quotas: seats set aside within a class. A sibling quota claimed from the
 * form and verified by the office, at half the fee; the RTE 25% filled from
 * the state's allotment, free; general seats that never eat into either;
 * unfilled quota seats released; and the RTE reimbursement register.
 */
describe('admission — quotas, RTE allotments and the reimbursement register', () => {
    let s; let portal; let round; const sib = []; let general;
    const appRow = async (id) => (await H.q(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [id]))[0];
    const pools = async () => Object.fromEntries((await H.api('GET', `/admission/admin/rounds/${round._id}/pools?class=${s.classes[0]._id}`, { token: s.adminToken })).body.data.map((p) => [p.quota || 'general', p]));
    const setRound = (classes) => H.api('PUT', `/admission/admin/rounds/${round._id}`, { token: s.adminToken, body: { ...round, classes } });

    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Quota');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 10, seats2: 10, admissionFee: 2000 });
    });
    after(() => H.finish());

    it('sets quotas aside within a class — never more seats than the class has', async () => {
        const c1 = { class: s.classes[0]._id, seats: 10 };
        const too = await setRound([{ ...c1, quotas: [{ name: 'Sibling', kind: 'sibling', seats: 6 }, { name: 'RTE', kind: 'rte', seats: 6 }] }, { class: s.classes[1]._id, seats: 10 }]);
        assert.equal(too.status, 400);
        assert.match(too.body.message, /12 seats, more than the class's 10/);
        const badClaim = await setRound([{ ...c1, quotas: [{ name: 'Sibling', kind: 'sibling', seats: 2, claim: { field: 'noSuchQuestion', op: 'eq', value: 'Yes' } }] }, { class: s.classes[1]._id, seats: 10 }]);
        assert.equal(badClaim.status, 400, 'a claim must read a real question');
        const ok = await setRound([{ ...c1, quotas: [
            { key: 'sibling', name: 'Sibling', kind: 'sibling', seats: 2, feeRule: { type: 'percent', percent: 50 }, claim: { field: 'siblingStudying', op: 'eq', value: 'Yes' } },
            { key: 'rte', name: 'RTE 25%', kind: 'rte', seats: 3, claim: { field: 'siblingStudying', op: 'eq', value: 'Yes' } },
        ] }, { class: s.classes[1]._id, seats: 10 }]);
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        round = ok.body.data;
        const q = round.classes[0].quotas;
        assert.equal(q.find((x) => x.key === 'rte').claim, null, 'RTE seats are never claimed from the form');
        assert.equal(q.find((x) => x.key === 'rte').feeRule.type, 'free');
        const p = await pools();
        assert.equal(p.general.capacity, 5, '10 less 2 less 3');
        assert.equal(p.sibling.capacity, 2);
        assert.equal(p.rte.capacity, 3);
    });

    it('puts an application in the quota its answers claim — and the office verifies or rejects it', async () => {
        const names = ['Aditya Bose', 'Bina Kaur', 'Charu Sen'];
        for (let i = 0; i < 3; i++) {
            const g = await H.registerGuest(s, portal.slug);
            const a = await H.submittedApplication(s, g, round, { answers: { studentName: names[i], studentDob: `2021-0${i + 1}-15`, siblingStudying: 'Yes', siblingName: 'Rohan Bose' } });
            await H.verifyAllDocs(s, a._id);
            sib.push({ ...a, guest: g });
        }
        const g4 = await H.registerGuest(s, portal.slug);
        general = await H.submittedApplication(s, g4, round, { answers: { studentName: 'Dev Arora', studentDob: '2021-04-04' } });
        await H.verifyAllDocs(s, general._id);
        const claimed = await appRow(sib[0]._id);
        assert.equal(claimed.quota, 'sibling');
        assert.equal(claimed.quotaStatus, 'claimed');
        assert.equal((await appRow(general._id)).quota, '');
        const fam = (await H.api('GET', `/admission/portal/applications/${sib[0]._id}`, { token: sib[0].guest.token })).body.data.application.quota;
        assert.deepEqual([fam.name, fam.status], ['Sibling', 'claimed']);
        const set = (id, body) => H.api('PATCH', `/admission/admin/applications/${id}/quota`, { token: s.adminToken, body });
        assert.equal((await set(sib[2]._id, { quota: 'sibling', status: 'rejected' })).status, 400, 'say why');
        assert.equal((await set(sib[2]._id, { quota: 'sibling', status: 'rejected', note: 'The sibling left the school last year' })).status, 200);
        assert.equal((await set(sib[0]._id, { quota: 'rte', status: 'verified' })).status, 409, 'RTE seats come from the state');
        for (const a of sib.slice(0, 2)) assert.equal((await set(a._id, { quota: 'sibling', status: 'verified' })).status, 200);
        assert.equal((await H.api('PATCH', `/admission/admin/applications/${sib[0]._id}/quota`, { token: s.teacherToken, body: { quota: 'sibling' } })).status, 403, 'administrators only');
    });

    it('fills a quota from its own list, at its own fee — and the general list never takes its seats', async () => {
        const mk = (body) => H.api('POST', '/admission/admin/lists', { token: s.adminToken, body: { round: round._id, class: s.classes[0]._id, ...body } });
        const ql = await mk({ quota: 'sibling', seats: 0, waitlistSize: 0 });
        assert.equal(ql.status, 201, JSON.stringify(ql.body));
        assert.equal(ql.body.data.built.selected, 2, 'the two verified sibling claims — not the rejected one');
        const id = ql.body.data.list._id;
        for (const step of ['submit', 'approve', 'publish']) assert.equal((await H.api('POST', `/admission/admin/lists/${id}/${step}`, { token: s.adminToken, body: {} })).status, 200);
        const offers = await H.q(`SELECT "quota", "feeAmount" FROM "admissionoffers" WHERE "round" = $1 AND "list" = $2`, [round._id, id]);
        assert.deepEqual(offers.map((o) => [o.quota, Number(o.feeAmount)]), [['sibling', 1000], ['sibling', 1000]], 'half the fee, from the sibling seats');
        const p = await pools();
        assert.equal(p.sibling.available, 0);
        assert.equal(p.general.available, 5, 'the general seats untouched');
        const gl = await mk({ seats: 0, waitlistSize: 0 });
        assert.equal(gl.body.data.built.selected, 2, 'the general list offers to everyone still waiting — Charu (claim rejected) and Dev');
        assert.equal((await H.api('POST', `/admission/admin/applications/${general._id}/offer`, { token: s.adminToken, body: { quota: 'sibling' } })).status, 409, 'no quota seat without a verified claim');
    });

    it('takes the state\'s RTE allotment — once, however often it is loaded — and offers each a free seat', async () => {
        const rows = [
            { externalRef: 'MH-RTE-2027-0001', studentName: 'Esha Pawar', studentDob: '2021-02-02', studentGender: 'Female', parentName: 'Gita Pawar', parentPhone: '9822000001', relation: 'Mother', category: 'EWS' },
            { externalRef: 'MH-RTE-2027-0002', studentName: 'Farhan Shaikh', studentDob: '2021-03-03', parentName: 'Imran Shaikh', parentPhone: '9822000002', parentEmail: `imran-${H.rand()}@family.test`, relation: 'Father', category: 'DG' },
            { externalRef: 'MH-RTE-2027-0003', studentName: 'Gauri Jadhav', studentDob: '2021-04-04', parentName: 'Sunil Jadhav', parentPhone: '9822000003' },
            { externalRef: 'MH-RTE-2027-0004', studentName: 'Hemant Patil', studentDob: '2021-05-05', parentName: 'Rekha Patil', parentPhone: '9822000004' },
        ];
        const imp = (body) => H.api('POST', `/admission/admin/rounds/${round._id}/rte-allotments`, { token: s.adminToken, body: { class: s.classes[0]._id, quota: 'rte', ...body } });
        assert.equal((await imp({ quota: 'sibling', rows })).status, 400, 'only into an RTE quota');
        assert.equal((await imp({ rows: [{ ...rows[0], parentPhone: '12345' }] })).status, 400);
        const r = await imp({ rows });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.deepEqual(r.body.data, { imported: 4, skipped: 0, accounts: 4 });
        assert.equal((await imp({ rows })).body.data.skipped, 4, 'loading it again adds nothing');
        const allotted = await H.q(`SELECT * FROM "admissionapplications" WHERE "round" = $1 AND "quotaStatus" = 'allotted' ORDER BY "externalRef"`, [round._id]);
        assert.equal(allotted.length, 4);
        assert.ok(allotted.every((a) => a.status === 'selected' && a.quota === 'rte' && a.applicationNumber));
        const noEmail = (await H.q(`SELECT "email", "isActive" FROM "users" WHERE "_id" = $1`, [allotted[0].applicant]))[0];
        assert.match(noEmail.email, /@invalid\.example$/);
        assert.equal(noEmail.isActive, false, 'no address: a closed placeholder');
        for (const a of allotted.slice(0, 3)) {
            const o = await H.api('POST', `/admission/admin/applications/${a._id}/offer`, { token: s.adminToken, body: {} });
            assert.equal(o.status, 201, JSON.stringify(o.body));
        }
        const fees = await H.q(`SELECT o."quota", o."feeAmount", a."admissionFeeStatus" FROM "admissionoffers" o JOIN "admissionapplications" a ON a."_id" = o."application" WHERE o."round" = $1 AND o."quota" = 'rte'`, [round._id]);
        assert.ok(fees.length === 3 && fees.every((f) => Number(f.feeAmount) === 0 && f.admissionFeeStatus === 'not_required'), 'free seats');
        const fourth = await H.api('POST', `/admission/admin/applications/${allotted[3]._id}/offer`, { token: s.adminToken, body: {} });
        assert.equal(fourth.status, 409);
        assert.equal(fourth.body.code, 'NO_SEAT', 'three RTE seats, three offers');
    });

    it('releases unfilled quota seats to the general seats', async () => {
        await H.api('POST', `/admission/admin/applications/${sib[0]._id}/offer/withdraw`, { token: s.adminToken, body: { reason: 'Family moved abroad' } });
        const before = await pools();
        assert.equal(before.sibling.available, 1);
        const rel = (n) => H.api('POST', `/admission/admin/rounds/${round._id}/quotas/release`, { token: s.adminToken, body: { class: s.classes[0]._id, quota: 'sibling', seats: n } });
        assert.equal((await rel(2)).status, 409, 'only one is unfilled');
        assert.equal((await rel(1)).status, 200);
        const p = await pools();
        assert.equal(p.sibling.capacity, 1);
        assert.equal(p.general.capacity, before.general.capacity + 1);
    });

    it('keeps a register of what the state owes for each RTE child', async () => {
        const [a] = await H.q(`SELECT * FROM "admissionapplications" WHERE "round" = $1 AND "quota" = 'rte' AND "status" = 'offer_issued' ORDER BY "externalRef" LIMIT 1`, [round._id]);
        await H.api('POST', `/admission/admin/applications/${a._id}/offer/respond`, { token: s.adminToken, body: { accept: true, note: 'Mother came to the office' } });
        // The family brought the papers; the office uploads them on its behalf.
        for (const d of ['photo', 'birth_certificate', 'address_proof']) {
            const up = await H.api('POST', `/admission/admin/applications/${a._id}/documents`, { token: s.adminToken, form: H.fileForm({ docType: d }, { buffer: H.FILES.png, name: `${d}.png`, type: 'image/png' }) });
            assert.equal(up.status, 201, JSON.stringify(up.body));
        }
        await H.verifyAllDocs(s, a._id);
        const c = await H.api('POST', `/admission/admin/applications/${a._id}/confirm`, { token: s.adminToken });
        assert.equal(c.status, 200, JSON.stringify(c.body));
        const conv = await H.api('POST', `/admission/admin/applications/${a._id}/convert`, { token: s.adminToken, body: { studentEmail: `rte-${H.rand()}@kids.test`, parent: { mode: 'new', relation: 'Mother', name: 'Gita Pawar', email: `gita-${H.rand()}@family.test`, phone: '9822000001' } } });
        assert.equal(conv.status, 200, JSON.stringify(conv.body));
        const reg = (await H.api('GET', `/admission/admin/rte/register?year=${s.year._id}`, { token: s.adminToken })).body.data;
        assert.equal(reg.rows.length, 1);
        assert.equal(reg.rows[0].status, 'pending');
        const u = await H.api('PATCH', `/admission/admin/rte/register/${reg.rows[0]._id}`, { token: s.adminToken, body: { perChildAmount: 17000, claimedAmount: 17000, status: 'claimed', reference: 'CLAIM/2027/11' } });
        assert.equal(u.status, 200, JSON.stringify(u.body));
        const again = (await H.api('GET', `/admission/admin/rte/register?year=${s.year._id}`, { token: s.adminToken })).body.data;
        assert.equal(again.rows.length, 1, 'one line per child, however often it is opened');
        assert.equal(again.totals.claimed, 17000);
        assert.equal(again.totals.outstanding, 17000);
        const csv = await H.api('GET', `/admission/admin/rte/register?year=${s.year._id}&format=csv`, { token: s.adminToken });
        assert.match(csv.body.toString(), /CLAIM\/2027\/11/);
    });
});
