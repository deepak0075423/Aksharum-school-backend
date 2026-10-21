'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Asking the school to look again: a re-check of a published result (an
 * upheld one corrects the marks and publishes them again) and an appeal
 * against a decision (an upheld one reopens the application) — inside the
 * school's windows, answered in writing by an administrator, the staff note
 * never shown to the family.
 */
describe('admission — re-checks and appeals', () => {
    let s; let portal; let round; let exam; let key; const g = []; const app = [];
    const appealsOf = (i) => H.api('GET', `/admission/portal/applications/${app[i]._id}/appeals`, { token: g[i].token });
    const file = (i, body) => H.api('POST', `/admission/portal/applications/${app[i]._id}/appeals`, { token: g[i].token, body });

    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Appeals');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 10 });
        for (let i = 0; i < 3; i++) {
            g[i] = await H.registerGuest(s, portal.slug);
            app[i] = await H.submittedApplication(s, g[i], round, { answers: { studentName: ['Kavya Joshi', 'Laksh Arora', 'Mira Pillai'][i], studentDob: `2021-0${i + 4}-0${i + 1}` } });
            await H.verifyAllDocs(s, app[i]._id);
        }
        assert.equal((await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { appeals: { enabled: true, recheckDays: 7, decisionDays: 15, answerDays: 10, maxPerApplication: 2 } } })).status, 200);
        exam = (await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
            round: round._id, name: 'Written Test', mode: 'offline', classes: [s.classes[0]._id], startsAt: new Date(Date.now() + 3600e3),
            subjects: [{ name: 'English', maxMarks: 50 }], passMarks: 20, evaluators: [s.teacher._id], approvalRequired: false,
        } })).body.data;
        key = exam.subjects[0].key;
        await H.api('POST', `/admission/admin/exams/${exam._id}/schedule`, { token: s.adminToken });
        await H.api('POST', `/admission/admin/exams/${exam._id}/candidates`, { token: s.adminToken, body: { applicationIds: [app[0]._id] } });
        const board = (await H.api('GET', `/admission/admin/exams/${exam._id}/results`, { token: s.adminToken })).body.data.board;
        assert.equal((await H.api('PUT', `/admission/admin/exams/${exam._id}/marks`, { token: s.adminToken, body: { rows: [{ candidate: board[0].candidateId, marks: { [key]: 18 } }] } })).body.data.saved, 1);
        await H.api('POST', `/admission/admin/exams/${exam._id}/results/submit`, { token: s.adminToken });
        await H.api('POST', `/admission/admin/exams/${exam._id}/results/approve`, { token: s.adminToken });
        assert.equal((await H.api('POST', `/admission/admin/exams/${exam._id}/results/publish`, { token: s.adminToken, body: {} })).status, 200);
    });
    after(() => H.finish());

    let recheck;
    it('offers a re-check of a published result, once, with a reason', async () => {
        const o = (await appealsOf(0)).body.data.options;
        assert.equal(o.enabled, true);
        assert.deepEqual(o.recheck.map((x) => x.name), ['Written Test']);
        assert.equal(o.decision, null, 'nothing was decided against them');
        assert.equal((await file(0, { kind: 'recheck', examId: exam._id, reason: 'Why?' })).status, 400, 'a sentence, please');
        const r = await file(0, { kind: 'recheck', examId: exam._id, reason: 'My child is sure the second answer was right — please count again.' });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.match(r.body.data.number, /^APL\d{4}\d{4}$/);
        recheck = r.body.data;
        assert.equal((await file(0, { kind: 'recheck', examId: exam._id, reason: 'Asking a second time for the same result.' })).body.code, 'NOT_OPEN');
        await new Promise((x) => setTimeout(x, 300));
        const [m] = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionemaillogs" WHERE "application" = $1 AND "event" = 'appeal_received'`, [app[0]._id]);
        assert.equal(m.n, 1);
    });

    it('lets only an administrator decide — and an upheld re-check corrects and republishes the marks', async () => {
        const list = await H.api('GET', '/admission/admin/appeals?status=waiting', { token: s.adminToken });
        assert.equal(list.body.totals.waiting, 1);
        const d = (await H.api('GET', `/admission/admin/appeals/${recheck._id}`, { token: s.adminToken })).body.data;
        assert.equal(d.result.total, 18);
        const decide = (token, body) => H.api('POST', `/admission/admin/appeals/${recheck._id}/decide`, { token, body });
        assert.equal((await decide(s.teacherToken, { outcome: 'upheld', decision: 'Checked again and corrected.', marks: { [key]: 22 } })).status, 403);
        assert.equal((await decide(s.adminToken, { outcome: 'upheld', decision: 'Checked again and corrected.' })).status, 400, 'upheld needs the corrected marks');
        const ok = await decide(s.adminToken, { outcome: 'upheld', decision: 'The paper was checked again; four marks had not been added.', internalNote: 'Evaluator missed page 3', marks: { [key]: 22 } });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        const fam = (await H.api('GET', `/admission/portal/applications/${app[0]._id}`, { token: g[0].token })).body.data;
        assert.equal(fam.exams[0].result.total, 22, 'the family sees the corrected, republished figure');
        assert.equal(fam.exams[0].result.passed, true);
        const mine = (await appealsOf(0)).body.data.appeals[0];
        assert.equal(mine.status, 'upheld');
        assert.ok(!('internalNote' in mine) && !JSON.stringify((await appealsOf(0)).body).includes('Evaluator missed'), 'the staff note stays with the staff');
        assert.equal((await decide(s.adminToken, { outcome: 'not_upheld', decision: 'Answering a second time.' })).status, 409, 'answered once');
    });

    let decisionAppeal;
    it('appeals a rejection within the window — and an upheld appeal reopens the application', async () => {
        const rej = await H.api('POST', `/admission/admin/applications/${app[1]._id}/transition`, { token: s.adminToken, body: { to: 'rejected', remarks: 'The age is outside the range for the class.' } });
        assert.equal(rej.status, 200, JSON.stringify(rej.body));
        const o = (await appealsOf(1)).body.data.options;
        assert.equal(o.decision?.status, 'rejected');
        const r = await file(1, { kind: 'decision', reason: 'The date of birth was entered wrongly — the birth certificate shows 2020.' });
        assert.equal(r.status, 201);
        decisionAppeal = r.body.data;
        const reopen = await H.api('POST', `/admission/admin/appeals/${decisionAppeal._id}/decide`, { token: s.adminToken, body: { outcome: 'upheld', decision: 'We checked the certificate — the application is reopened.', reopenTo: 'enrolled' } });
        assert.equal(reopen.status, 400, 'not to a status the system owns');
        const ok = await H.api('POST', `/admission/admin/appeals/${decisionAppeal._id}/decide`, { token: s.adminToken, body: { outcome: 'upheld', decision: 'We checked the certificate — the application is reopened.', reopenTo: 'under_review' } });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        const [a] = await H.q(`SELECT "status" FROM "admissionapplications" WHERE "_id" = $1`, [app[1]._id]);
        assert.equal(a.status, 'under_review');
    });

    it('closes the window when the school says, and lets a family withdraw an appeal not yet started', async () => {
        await H.api('POST', `/admission/admin/applications/${app[2]._id}/transition`, { token: s.adminToken, body: { to: 'rejected', remarks: 'Seats are full.' } });
        const r = await file(2, { kind: 'decision', reason: 'We applied before the closing date and would like it looked at again.' });
        assert.equal(r.status, 201);
        assert.equal((await H.api('POST', `/admission/portal/applications/${app[2]._id}/appeals/${r.body.data._id}/withdraw`, { token: g[2].token })).status, 200);
        // Withdrawn, so another may be filed — until the window closes.
        await H.q(`UPDATE "admissionapplications" SET "statusChangedAt" = now() - interval '20 days' WHERE "_id" = $1`, [app[2]._id]);
        assert.equal((await appealsOf(2)).body.data.options.decision, null);
        assert.equal((await file(2, { kind: 'decision', reason: 'Trying again after the window has closed.' })).body.code, 'NOT_OPEN');
        // Started (assigned), it can no longer be withdrawn by the family.
        await H.q(`UPDATE "admissionapplications" SET "statusChangedAt" = now() WHERE "_id" = $1`, [app[2]._id]);
        const again = await file(2, { kind: 'decision', reason: 'Filing once more within the window, as allowed.' });
        assert.equal(again.status, 201);
        assert.equal((await H.api('PATCH', `/admission/admin/appeals/${again.body.data._id}/assign`, { token: s.adminToken, body: { userId: s.teacher._id } })).status, 200);
        assert.equal((await H.api('POST', `/admission/portal/applications/${app[2]._id}/appeals/${again.body.data._id}/withdraw`, { token: g[2].token })).status, 409);
        const no = await H.api('POST', `/admission/admin/appeals/${again.body.data._id}/decide`, { token: s.adminToken, body: { outcome: 'not_upheld', decision: 'The class was full on the closing date; the decision stands.' } });
        assert.equal(no.status, 200);
        const [a] = await H.q(`SELECT "status" FROM "admissionapplications" WHERE "_id" = $1`, [app[2]._id]);
        assert.equal(a.status, 'rejected', 'nothing else changes');
    });

    it('keeps a family to the school\'s number of appeals', async () => {
        // Application 2 has filed twice (one withdrawn does not count): one left of two.
        const o = (await appealsOf(2)).body.data.options;
        assert.equal(o.left, 1);
    });
});
