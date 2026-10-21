'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * The online exam's layout: timed sections taken in order (a closed section's
 * answers stay closed; finishing early opens the next at once), questions
 * drawn at random for each candidate (only from equal-mark pools, so every
 * paper is worth the same), extra time as a recorded accommodation, the
 * school's rule for which retake counts, and the page's signals kept as
 * evidence — never a mark.
 */
describe('admission — the online exam: sections, draws, extra time, retakes, signals', () => {
    let s; let portal; let round; let exam; const g = []; const app = []; let qs = {};
    const add = (body) => H.api('POST', `/admission/admin/exams/${exam._id}/questions`, { token: s.adminToken, body });
    const start = (i) => H.api('POST', `/admission/portal/applications/${app[i]._id}/exams/${exam._id}/start`, { token: g[i].token });
    const view = (i, att) => H.api('GET', `/admission/portal/applications/${app[i]._id}/attempts/${att}`, { token: g[i].token });
    const save = (i, att, answers, seq) => H.api('PUT', `/admission/portal/applications/${app[i]._id}/attempts/${att}/answers`, { token: g[i].token, body: { answers, seq } });

    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Engine');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 10 });
        for (let i = 0; i < 2; i++) {
            g[i] = await H.registerGuest(s, portal.slug);
            app[i] = await H.submittedApplication(s, g[i], round, { answers: { studentName: ['Ira Menon', 'Om Prakash'][i], studentDob: `2021-0${i + 2}-0${i + 3}` } });
            await H.verifyAllDocs(s, app[i]._id);
        }
        exam = (await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
            round: round._id, name: 'Aptitude', mode: 'online', classes: [s.classes[0]._id],
            startsAt: new Date(Date.now() - 60e3), endsAt: new Date(Date.now() + 4 * 3600e3), durationMinutes: 60,
            subjects: [{ key: 'maths', name: 'Maths', maxMarks: 4, minutes: 10, draw: 2 }, { key: 'english', name: 'English', maxMarks: 2, minutes: 5 }],
            settings: { attemptsAllowed: 2, retakePolicy: 'best', randomizeQuestions: false, randomizeOptions: false },
        } })).body.data;
        assert.ok(exam?._id);
        const sq = (text, subjectKey, marks, right = 'b') => add({ type: 'single', text, options: [{ text: 'one' }, { text: 'two' }], correct: [right], marks, subjectKey });
        qs.m1 = (await sq('Maths one', 'maths', 2)).body.data;
        qs.m2 = (await sq('Maths two', 'maths', 2)).body.data;
        qs.m3 = (await sq('Maths three', 'maths', 3)).body.data;
        qs.e1 = (await sq('English one', 'english', 1)).body.data;
        qs.e2 = (await sq('English two', 'english', 1)).body.data;
    });
    after(() => H.finish());

    it('refuses a drawn pool whose questions carry different marks — every paper must be worth the same', async () => {
        const r = await H.api('POST', `/admission/admin/exams/${exam._id}/schedule`, { token: s.adminToken });
        assert.equal(r.status, 409);
        assert.match(r.body.message, /same marks/);
        assert.equal((await H.api('PUT', `/admission/admin/questions/${qs.m3._id}`, { token: s.adminToken, body: { ...qs.m3, marks: 2 } })).status, 200);
        const ok = await H.api('POST', `/admission/admin/exams/${exam._id}/schedule`, { token: s.adminToken });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.data.maxMarks, 6, 'two maths questions drawn at 2 marks + two english at 1');
        assert.equal((await H.api('POST', `/admission/admin/exams/${exam._id}/candidates`, { token: s.adminToken, body: { applicationIds: 'all' } })).status, 200);
    });

    let att;
    it('draws the paper and opens one timed section at a time', async () => {
        const r = await start(0);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        att = r.body.data;
        const v = (await view(0, att._id)).body.data;
        assert.equal(v.sections.length, 2);
        assert.deepEqual(v.sections.map((x) => x.status), ['open', 'later']);
        assert.equal(v.questions.length, 2, 'only the open section');
        assert.ok(v.questions.every((q) => q.subject === 'Maths'));
        const [row] = await H.q(`SELECT "questionOrder" FROM "admissionattempts" WHERE "_id" = $1`, [att._id]);
        assert.equal(row.questionOrder.length, 4, 'two of three maths drawn, both english');
        assert.ok(Math.abs(new Date(v.deadlineAt) - (Date.now() + 15 * 60e3)) < 60e3, 'the sitting is the sections\' minutes together');
    });

    it('keeps a closed section closed, and opens the next at once when the candidate moves on', async () => {
        let v = (await view(0, att._id)).body.data;
        const [mA, mB] = v.questions;
        const eng = String(qs.e1._id);
        assert.equal((await save(0, att._id, { [mA._id]: { selected: ['b'] }, [mB._id]: { selected: ['b'] }, [eng]: { selected: ['b'] } }, 1)).status, 200);
        let [row] = await H.q(`SELECT "answers" FROM "admissionattempts" WHERE "_id" = $1`, [att._id]);
        assert.ok(row.answers[mA._id] && !row.answers[eng], 'an answer to a section not yet open is not taken');
        const nx = await H.api('POST', `/admission/portal/applications/${app[0]._id}/attempts/${att._id}/next-section`, { token: g[0].token });
        assert.equal(nx.status, 200, JSON.stringify(nx.body));
        v = nx.body.data;
        assert.deepEqual(v.sections.map((x) => x.status), ['done', 'open']);
        assert.ok(v.questions.every((q) => q.subject === 'English'));
        assert.equal((await save(0, att._id, { [mA._id]: { selected: ['a'] }, [eng]: { selected: ['b'] } }, 2)).status, 200);
        [row] = await H.q(`SELECT "answers" FROM "admissionattempts" WHERE "_id" = $1`, [att._id]);
        assert.deepEqual(row.answers[mA._id].selected, ['b'], 'the closed section\'s answer stands');
        assert.deepEqual(row.answers[eng].selected, ['b']);
    });

    it('submits when the last section\'s time runs out', async () => {
        await H.q(`UPDATE "admissionattempts" SET "sections" = jsonb_set("sections", '{1,deadlineAt}', to_jsonb((now() - interval '1 minute')::text)) WHERE "_id" = $1`, [att._id]);
        const v = (await view(0, att._id)).body.data;
        assert.equal(v.status, 'auto_submitted');
        const [res] = await H.q(`SELECT "autoScore" FROM "admissionresults" WHERE "exam" = $1 AND "application" = $2`, [exam._id, app[0]._id]);
        assert.equal(res.autoScore, 5, 'two maths right (4) + one english right (1)');
    });

    it('counts the best of two sittings when the school says so', async () => {
        const r = await start(0);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        // A weak second sitting: submitted straight away.
        const sub = await H.api('POST', `/admission/portal/applications/${app[0]._id}/attempts/${r.body.data._id}/submit`, { token: g[0].token, body: {} });
        assert.equal(sub.status, 200);
        let [res] = await H.q(`SELECT "autoScore" FROM "admissionresults" WHERE "exam" = $1 AND "application" = $2`, [exam._id, app[0]._id]);
        assert.equal(res.autoScore, 5, 'the better sitting stands');
        await H.api('PUT', `/admission/admin/exams/${exam._id}`, { token: s.adminToken, body: { settings: { ...exam.settings, attemptsAllowed: 2, retakePolicy: 'average' } } });
        const fresh = (await H.q(`SELECT * FROM "admissionexams" WHERE "_id" = $1`, [exam._id]))[0];
        const counts = await require('../../services/admission/examPlan').counting(fresh, app[0]._id);
        assert.deepEqual([counts.rule, counts.autoScore], ['average', 2.5]);
    });

    it('gives a candidate extra time only with a reason, and stretches each section to match', async () => {
        const board = (await H.api('GET', `/admission/admin/exams/${exam._id}/results`, { token: s.adminToken })).body.data.board;
        const cand = board.find((b) => b.applicationId === app[1]._id);
        const put = (body) => H.api('PATCH', `/admission/admin/exams/${exam._id}/candidates/${cand.candidateId}`, { token: s.adminToken, body });
        assert.equal((await put({ extraMinutes: 15 })).status, 400, 'a reason');
        assert.equal((await put({ extraMinutes: 15, extraReason: 'Writer for a visually impaired candidate' })).status, 200);
        const r = await start(1);
        const v = (await view(1, r.body.data._id)).body.data;
        assert.equal(v.extraMinutes, 15);
        assert.deepEqual(v.sections.map((x) => x.minutes), [20, 10], 'fifteen minutes shared over the sections in proportion');
        assert.ok(Math.abs(new Date(v.deadlineAt) - (Date.now() + 30 * 60e3)) < 60e3);
        // The page's signals: counted for the evaluator, never a mark.
        for (const t of ['tab_hidden', 'tab_hidden', 'fullscreen_exit']) await H.api('POST', `/admission/portal/applications/${app[1]._id}/attempts/${r.body.data._id}/violation`, { token: g[1].token, body: { type: t } });
        await H.api('POST', `/admission/portal/applications/${app[1]._id}/attempts/${r.body.data._id}/submit`, { token: g[1].token, body: {} });
        const b2 = (await H.api('GET', `/admission/admin/exams/${exam._id}/results`, { token: s.adminToken })).body.data.board.find((b) => b.applicationId === app[1]._id);
        assert.deepEqual(b2.signals, { tab_hidden: 2, fullscreen_exit: 1 });
        assert.equal(b2.autoScore, 0, 'nothing answered, nothing taken off for the signals');
    });
});
