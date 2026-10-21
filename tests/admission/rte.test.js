'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const H = require('./helpers');

/**
 * The RTE Act's bar on screening (s.13, s.2(o)): for an elementary class no
 * entrance test, interview or merit list may choose between children — only a
 * random draw, made once, that anyone can recompute.
 */
const RTE_ON = { compliance: { rte: { enabled: true, classNumbers: [1, 2, 3, 4, 5, 6, 7, 8], prePrimary: false } } };

describe('admission — the RTE rule: no screening for elementary classes, a lottery instead', () => {
    let s; let portal; let round; let class11; let apps = []; let lotteryId;
    const people = ['Aarav Rao', 'Bela Sen', 'Chirag Das', 'Diya Paul', 'Eshan Roy', 'Fatima Khan'];
    const exam = (classes, mode = 'offline') => H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
        round: round._id, name: 'Readiness Test', mode, classes, startsAt: new Date(Date.now() + 86400e3),
        endsAt: mode === 'online' ? new Date(Date.now() + 2 * 86400e3) : undefined, subjects: [{ name: 'Talk', maxMarks: 10 }],
    } });
    const list = (body) => H.api('POST', '/admission/admin/lists', { token: s.adminToken, body: { round: round._id, class: s.classes[0]._id, ...body } });
    const detail = async (id) => (await H.api('GET', `/admission/admin/lists/${id}`, { token: s.adminToken })).body.data;

    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Rte');
        portal = await H.openPortal(s, { settings: RTE_ON });
        class11 = await H.insert('classes', { _id: H.uuid(), school: s.id, academicYear: s.year._id, classNumber: 11, className: 'Class 11', status: 'active', createdAt: new Date() });
        round = await H.makeRound(s, portal.form, { seats1: 2, seats2: 10, extra: {} });
        // Class 11 joins the round too.
        const r = await H.api('PUT', `/admission/admin/rounds/${round._id}`, { token: s.adminToken, body: { ...round, classes: [...round.classes.map((c) => ({ class: c.class, seats: c.seats })), { class: class11._id, seats: 5 }] } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        round = r.body.data;
        for (let i = 0; i < people.length; i++) {
            const g = await H.registerGuest(s, portal.slug);
            const sibling = i % 2 === 0 ? { siblingStudying: 'Yes', siblingName: 'Rohan Rao' } : {};
            const a = await H.submittedApplication(s, g, round, { answers: { studentName: people[i], studentDob: `2021-0${(i % 9) + 1}-1${i}`, ...sibling } });
            await H.verifyAllDocs(s, a._id);
            apps.push({ ...a, guest: g });
        }
    });
    after(() => H.finish());

    it('refuses an entrance test or an interview for Class 1 — and allows one for Class 11', async () => {
        const t = await exam([s.classes[0]._id]);
        assert.equal(t.status, 409);
        assert.equal(t.body.code, 'SCREENING_NOT_ALLOWED');
        assert.match(t.body.message, /Class 1.*RTE Act/);
        assert.equal((await exam([s.classes[0]._id], 'interview')).body.code, 'SCREENING_NOT_ALLOWED');
        assert.equal((await exam([s.classes[0]._id, class11._id])).status, 409, 'one barred class is enough');
        assert.equal((await exam([class11._id])).status, 201, 'Class 11 may hold an entrance test');
    });

    it('refuses a merit list for Class 1 — a lottery it may have, its secret kept until the draw', async () => {
        const merit = await list({ method: 'merit', seats: 2 });
        assert.equal(merit.status, 409);
        assert.equal(merit.body.code, 'SCREENING_NOT_ALLOWED');
        const r = await list({ method: 'lottery', seats: 2, waitlistSize: 2 });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        lotteryId = r.body.data.list._id;
        assert.equal(r.body.data.built.pool, 6);
        assert.match(r.body.data.list.lotteryCommitment, /^[0-9a-f]{64}$/);
        assert.equal(r.body.data.list.lotteryNonce, undefined, 'the secret never leaves before the draw');
        const d = await detail(lotteryId);
        assert.equal(d.list.lotteryNonce, undefined);
        assert.equal(d.screening.banned, true);
        assert.ok(d.lines.every((l) => l.rank === null), 'no order before the draw');
        const all = (await H.api('GET', '/admission/admin/lists', { token: s.adminToken })).body.data;
        assert.ok(all.every((x) => x.lotteryNonce === undefined));
        assert.equal((await H.api('POST', `/admission/admin/lists/${lotteryId}/submit`, { token: s.adminToken })).body.code, 'NOT_DRAWN');
    });

    it('draws once — two draws at the same moment make one — and the draw checks out', async () => {
        const go = (phrase) => H.api('POST', `/admission/admin/lists/${lotteryId}/draw`, { token: s.adminToken, body: { phrase, witnesses: ['Meena Iyer', 'Ravi Kumar'] } });
        assert.equal((await go('ab')).status, 400, 'a phrase of a few characters at least');
        assert.equal((await go('<b>hi</b> there')).status, 400);
        const [one, two] = await Promise.all([go('Seventeen blue kites 4721'), go('Something else 9')]);
        const statuses = [one.status, two.status].sort();
        assert.deepEqual(statuses, [200, 409], `${JSON.stringify(one.body)} ${JSON.stringify(two.body)}`);
        const won = one.status === 200 ? one : two;
        assert.equal(won.body.data.selected, 2);
        assert.equal(won.body.data.waitlisted, 2);
        const d = await detail(lotteryId);
        assert.deepEqual(d.lines.map((l) => l.rank), [1, 2, 3, 4, 5, 6]);
        assert.equal(d.list.draw.nonce.length, 32, 'revealed with the draw');
        assert.equal(require('../../services/admission/lottery').commitmentOf(d.list.draw.nonce), d.list.lotteryCommitment);
        const v = await H.api('GET', `/admission/admin/lists/${lotteryId}/verify`, { token: s.adminToken });
        assert.equal(v.body.data.ok, true, JSON.stringify(v.body));
        assert.equal((await go('Again please')).body.code, 'ALREADY_DRAWN');
        assert.equal((await H.api('POST', `/admission/admin/lists/${lotteryId}/rebuild`, { token: s.adminToken })).status, 409);
        assert.equal((await H.api('PUT', `/admission/admin/lists/${lotteryId}`, { token: s.adminToken, body: { seats: 3 } })).status, 409);
        assert.equal((await H.api('DELETE', `/admission/admin/lists/${lotteryId}`, { token: s.adminToken })).status, 409, 'a drawn list cannot vanish');
    });

    it('notices a draw number changed behind its back', async () => {
        const d = await detail(lotteryId);
        const first = d.lines[0];
        await H.q(`UPDATE "admissionlistentries" SET "rank" = 99 WHERE "_id" = $1`, [first._id]);
        const v = (await H.api('GET', `/admission/admin/lists/${lotteryId}/verify`, { token: s.adminToken })).body.data;
        assert.equal(v.ok, false);
        assert.match(v.problems.join(' '), /differ/);
        await H.q(`UPDATE "admissionlistentries" SET "rank" = 1 WHERE "_id" = $1`, [first._id]);
    });

    it('lets the office take a line out of the draw (with a reason) — never pick who is selected', async () => {
        const d = await detail(lotteryId);
        const chosen = d.lines.find((l) => l.decision === 'selected');
        const pick = await H.api('PATCH', `/admission/admin/lists/${lotteryId}/entries/${d.lines[5]._id}`, { token: s.adminToken, body: { decision: 'selected', reason: 'Favourite' } });
        assert.equal(pick.status, 400);
        assert.equal(pick.body.code, 'LOTTERY_ORDER');
        const out = await H.api('PATCH', `/admission/admin/lists/${lotteryId}/entries/${chosen._id}`, { token: s.adminToken, body: { decision: 'excluded', reason: 'Applied twice — the other application stays in the draw' } });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        const after = await detail(lotteryId);
        const sel = after.lines.filter((l) => l.decision === 'selected').map((l) => l.rank);
        assert.equal(sel.length, 2, 'the seat goes down the draw order');
        assert.ok(!sel.includes(chosen.rank));
        assert.deepEqual(after.lines.map((l) => l.rank), [1, 2, 3, 4, 5, 6], 'the draw order itself never changes');
        await H.api('PATCH', `/admission/admin/lists/${lotteryId}/entries/${chosen._id}`, { token: s.adminToken, body: { decision: 'restore', reason: 'Checked again: not a duplicate' } });
        assert.equal((await detail(lotteryId)).lines.filter((l) => l.decision === 'selected').length, 2);
    });

    it('publishes the draw for anyone to check — numbers only, no names — and the family sees theirs', async () => {
        for (const step of ['submit', 'approve']) assert.equal((await H.api('POST', `/admission/admin/lists/${lotteryId}/${step}`, { token: s.adminToken })).status, 200);
        const p = await H.api('POST', `/admission/admin/lists/${lotteryId}/publish`, { token: s.adminToken, body: {} });
        assert.equal(p.status, 200, JSON.stringify(p.body));
        assert.equal(p.body.data.offered, 2);
        const pub = await H.api('GET', `/admission/public/portals/${portal.slug}/lotteries/${lotteryId}`);
        assert.equal(pub.status, 200);
        assert.equal(pub.body.data.entries.length, 6);
        assert.ok(!JSON.stringify(pub.body).includes('Aarav'), 'no names on the public record');
        const file = path.join(os.tmpdir(), `draw-${H.rand()}.json`);
        fs.writeFileSync(file, JSON.stringify(pub.body));
        const out = await new Promise((resolve) => execFile(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'verifyLottery.js'), file], (err, stdout) => resolve({ code: err ? err.code : 0, stdout })));
        fs.unlinkSync(file);
        assert.equal(out.code, 0, out.stdout);
        assert.match(out.stdout, /VERIFIED/);
        const mine = (await H.api('GET', `/admission/portal/applications/${apps[0]._id}/lists`, { token: apps[0].guest.token })).body.data[0];
        assert.equal(mine.method, 'lottery');
        assert.equal(typeof mine.mine.rank, 'number', 'their draw number');
        assert.match(mine.drawUrl, new RegExp(`/${portal.slug}/lottery/${lotteryId}$`));
        assert.equal((await H.api('GET', `/admission/public/portals/${portal.slug}/lotteries/${H.uuid()}`)).status, 404);
    });

    it('allows an offer by hand for Class 1 only while every applicant still waiting can have a seat', async () => {
        const seatsTo = async (n) => {
            const cur = (await H.api('GET', '/admission/admin/rounds', { token: s.adminToken })).body.data.find((x) => x._id === round._id);
            const r = await H.api('PUT', `/admission/admin/rounds/${round._id}`, { token: s.adminToken, body: { ...cur, classes: cur.classes.map((c) => ({ ...c, seats: String(c.class) === String(s.classes[0]._id) ? n : c.seats })) } });
            assert.equal(r.status, 200, JSON.stringify(r.body));
        };
        // Two seats went to the draw's offers; four applicants wait. One more seat is not enough for all four.
        await seatsTo(3);
        const [free] = await H.q(`SELECT a."_id" FROM "admissionapplications" a WHERE a."round" = $1 AND a."class" = $2 AND a."status" IN ('waitlisted', 'verified')
            AND NOT EXISTS (SELECT 1 FROM "admissionoffers" o WHERE o."application" = a."_id" AND o."status" IN ('issued', 'accepted', 'confirmed')) LIMIT 1`, [round._id, s.classes[0]._id]);
        const r = await H.api('POST', `/admission/admin/applications/${free._id}/offer`, { token: s.adminToken, body: {} });
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal(r.body.code, 'SCREENING_NOT_ALLOWED');
        assert.match(r.body.message, /4 applications waiting for 1 free seat/);
        // Room for every one of them: an offer by hand chooses nobody over anybody.
        await seatsTo(10);
        const ok = await H.api('POST', `/admission/admin/applications/${free._id}/offer`, { token: s.adminToken, body: {} });
        assert.equal(ok.status, 201, JSON.stringify(ok.body));
    });

    it('orders a points lottery by points first, then by lot', async () => {
        // Four new applicants for Class 2 (also elementary): two with a sibling at the school.
        for (const [i, name] of ['Hari Joshi', 'Isha Bhat', 'Jai Mehra', 'Kiran Gill'].entries()) {
            const g = await H.registerGuest(s, portal.slug);
            const sibling = i < 2 ? { siblingStudying: 'Yes', siblingName: 'Rohan Rao' } : {};
            const a = await H.submittedApplication(s, g, round, { classIdx: 1, answers: { studentName: name, studentDob: `2020-0${i + 2}-0${i + 2}`, ...sibling } });
            await H.verifyAllDocs(s, a._id);
        }
        const two = (body) => H.api('POST', '/admission/admin/lists', { token: s.adminToken, body: { round: round._id, class: s.classes[1]._id, ...body } });
        const bad = await two({ method: 'points_lottery', seats: 1, criteria: { points: [{ field: 'noSuchQuestion', op: 'eq', value: 'Yes', points: 5 }] } });
        assert.equal(bad.status, 400);
        const r = await two({ method: 'points_lottery', seats: 1, waitlistSize: 3, criteria: { points: [{ label: 'Sibling at the school', field: 'siblingStudying', op: 'eq', value: 'Yes', points: 10 }] } });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        const id = r.body.data.list._id;
        assert.equal((await H.api('POST', `/admission/admin/lists/${id}/draw`, { token: s.adminToken, body: { phrase: 'Points round 2027' } })).status, 200);
        const d = await detail(id);
        assert.deepEqual(d.lines.map((l) => l.score), [10, 10, 0, 0], 'siblings draw first, whatever the lot');
        assert.equal(d.lines[0].decision, 'selected');
        assert.equal((await H.api('GET', `/admission/admin/lists/${id}/verify`, { token: s.adminToken })).body.data.ok, true);
        // Cancelled, it stays on record beside the next list of the class.
        assert.equal((await H.api('POST', `/admission/admin/lists/${id}/cancel`, { token: s.adminToken, body: {} })).status, 400, 'a reason is needed');
        assert.equal((await H.api('POST', `/admission/admin/lists/${id}/cancel`, { token: s.adminToken, body: { reason: 'Seats were miscounted' } })).status, 200);
        const next = await two({ method: 'lottery', seats: 1 });
        const nd = await detail(next.body.data.list._id);
        assert.ok(nd.cancelledDraws.some((c) => c.cancelReason === 'Seats were miscounted' && c.drawn));
    });

    it('can be switched off only with a reason — and then Class 1 may hold a test', async () => {
        const noReason = await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { compliance: { rte: { enabled: false } } } });
        assert.equal(noReason.status, 400);
        const ok = await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { compliance: { rte: { enabled: false, exemptReason: 'minority', exemptNote: 'Recognised minority institution — order on file' } } } });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal((await exam([s.classes[0]._id])).status, 201);
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: RTE_ON });
    });

    it('covers pre-primary classes by name when the school says its state does', async () => {
        const nursery = await H.insert('classes', { _id: H.uuid(), school: s.id, academicYear: s.year._id, classNumber: 13, className: 'Nursery', status: 'active', createdAt: new Date() });
        const compliance = require('../../services/admission/compliance');
        const off = compliance.screeningRule({ compliance: { rte: { enabled: true, classNumbers: [1], prePrimary: false } } }, nursery);
        const on = compliance.screeningRule({ compliance: { rte: { enabled: true, classNumbers: [1], prePrimary: true } } }, nursery);
        assert.equal(off.banned, false);
        assert.equal(on.banned, true);
        assert.equal(compliance.screeningRule({ compliance: { rte: { enabled: true, classNumbers: [1], prePrimary: true } } }, { className: 'UKG B', classNumber: 0 }).banned, true);
    });
});
