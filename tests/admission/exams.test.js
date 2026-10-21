'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('admission — entrance exams and results', () => {
    let s; let portal; let round; let guest; let app; let other; let otherApp; let exam; let qs;
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Exams');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form);
        guest = await H.registerGuest(s, portal.slug);
        app = await H.submittedApplication(s, guest, round);
        await H.verifyAllDocs(s, app._id);
        other = await H.registerGuest(s, portal.slug);
        otherApp = await H.submittedApplication(s, other, round);   // documents NOT verified: not eligible
    });
    after(() => H.finish());

    it('verifying every document moves the application to Verified', async () => {
        const row = (await H.q(`SELECT "status", "docStatus" FROM "admissionapplications" WHERE "_id" = $1`, [app._id]))[0];
        assert.equal(row.status, 'verified');
        assert.equal(row.docStatus, 'verified');
    });

    it('builds an online exam that cannot be scheduled without valid questions', async () => {
        const r = await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
            round: round._id, name: 'Entrance Test', mode: 'online', classes: [s.classes[0]._id],
            startsAt: new Date(Date.now() + 3600 * 1000), endsAt: new Date(Date.now() + 7200 * 1000), durationMinutes: 30,
            settings: { negativeMarking: true, negativeFraction: 0.5, randomizeQuestions: true, randomizeOptions: true, attemptsAllowed: 1 },
            eligibility: { statuses: ['verified', 'eligible'] }, evaluators: [s.teacher._id],
        } });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        exam = r.body.data;
        const early = await H.api('POST', `/admission/admin/exams/${exam._id}/schedule`, { token: s.adminToken });
        assert.equal(early.status, 409, 'no questions yet');
        const bad = await H.api('POST', `/admission/admin/exams/${exam._id}/questions`, { token: s.adminToken, body: { type: 'single', text: 'Pick', options: [{ text: 'A' }, { text: 'B' }], correct: ['z'] } });
        assert.equal(bad.status, 400, 'a key that matches no option is refused');
        const add = (body) => H.api('POST', `/admission/admin/exams/${exam._id}/questions`, { token: s.adminToken, body });
        qs = {
            single: (await add({ type: 'single', text: '2 + 2 =', options: [{ text: '3' }, { text: '4' }, { text: '5' }], correct: ['b'], marks: 2 })).body.data,
            multiple: (await add({ type: 'multiple', text: 'Even numbers', options: [{ text: '2' }, { text: '3' }, { text: '4' }], correct: ['a', 'c'], marks: 2 })).body.data,
            numeric: (await add({ type: 'numeric', text: '10 / 4', correct: { value: 2.5, tolerance: 0.01 }, marks: 2 })).body.data,
            essay: (await add({ type: 'descriptive', text: 'Describe your school', marks: 4 })).body.data,
        };
        const sch = await H.api('POST', `/admission/admin/exams/${exam._id}/schedule`, { token: s.adminToken });
        assert.equal(sch.status, 200, JSON.stringify(sch.body));
        assert.equal(sch.body.data.maxMarks, 10);
    });

    it('schedules only eligible applications, and moves them to Exam Scheduled', async () => {
        const el = await H.api('GET', `/admission/admin/exams/${exam._id}/eligible`, { token: s.adminToken });
        const ids = el.body.data.map((a) => a._id);
        assert.ok(ids.includes(app._id));
        assert.ok(!ids.includes(otherApp._id), 'an unverified application is not eligible');
        const r = await H.api('POST', `/admission/admin/exams/${exam._id}/candidates`, { token: s.adminToken, body: { applicationIds: 'all' } });
        assert.equal(r.body.data.added, 1);
        const row = (await H.q(`SELECT "status" FROM "admissionapplications" WHERE "_id" = $1`, [app._id]))[0];
        assert.equal(row.status, 'exam_scheduled');
        const cand = (await H.q(`SELECT "rollNumber" FROM "admissioncandidates" WHERE "application" = $1`, [app._id]))[0];
        assert.match(cand.rollNumber, /^R\d{2}\d{4}$/);
    });

    it('opens only inside the window, resumes rather than duplicates, and never sends the answer key', async () => {
        const early = await H.api('POST', `/admission/portal/applications/${app._id}/exams/${exam._id}/start`, { token: guest.token });
        assert.equal(early.status, 409);
        assert.equal(early.body.code, 'NOT_OPEN_YET');
        await H.q(`UPDATE "admissionexams" SET "startsAt" = now() - interval '5 minutes' WHERE "_id" = $1`, [exam._id]);
        const [a, b] = await Promise.all([
            H.api('POST', `/admission/portal/applications/${app._id}/exams/${exam._id}/start`, { token: guest.token }),
            H.api('POST', `/admission/portal/applications/${app._id}/exams/${exam._id}/start`, { token: guest.token }),
        ]);
        assert.equal(a.status, 200, JSON.stringify(a.body));
        assert.equal(b.status, 200, JSON.stringify(b.body));
        assert.equal(a.body.data._id, b.body.data._id, 'two starts at once open one sitting');
        const n = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionattempts" WHERE "application" = $1`, [app._id]);
        assert.equal(n[0].n, 1);
        assert.ok(!JSON.stringify(a.body.data).includes('"correct"'), 'no answer key in the page');
        assert.equal(a.body.data.questions.length, 4);
        const deadline = new Date(a.body.data.deadlineAt).getTime();
        assert.ok(deadline - Date.now() <= 30 * 60 * 1000 + 5000, 'deadline is the duration, set by the server');
    });

    it('keeps the newest answers when saves arrive out of order', async () => {
        const att = (await H.q(`SELECT "_id" FROM "admissionattempts" WHERE "application" = $1`, [app._id]))[0];
        const url = `/admission/portal/applications/${app._id}/attempts/${att._id}/answers`;
        const s2 = await H.api('PUT', url, { token: guest.token, body: { seq: 2, answers: { [qs.single._id]: { selected: ['b'] } } } });
        assert.equal(s2.body.data.saved, true);
        const s1 = await H.api('PUT', url, { token: guest.token, body: { seq: 1, answers: { [qs.single._id]: { selected: ['a'] } } } });
        assert.equal(s1.body.data.stale, true, 'an older save is ignored');
        const view = await H.api('GET', `/admission/portal/applications/${app._id}/attempts/${att._id}`, { token: guest.token });
        assert.deepEqual(view.body.data.answers[qs.single._id].selected, ['b']);
        // Answers to questions that are not in the attempt, or options that do not exist, are dropped.
        await H.api('PUT', url, { token: guest.token, body: { seq: 3, answers: { [qs.multiple._id]: { selected: ['a', 'c', 'zz'] }, 'not-a-question': { selected: ['a'] } } } });
        const v2 = await H.api('GET', `/admission/portal/applications/${app._id}/attempts/${att._id}`, { token: guest.token });
        assert.deepEqual(v2.body.data.answers[qs.multiple._id].selected.sort(), ['a', 'c']);
        assert.ok(!('not-a-question' in v2.body.data.answers));
    });

    it('scores objective answers (with negative marking) and holds results until published', async () => {
        const att = (await H.q(`SELECT "_id" FROM "admissionattempts" WHERE "application" = $1`, [app._id]))[0];
        const sub = await H.api('POST', `/admission/portal/applications/${app._id}/attempts/${att._id}/submit`, { token: guest.token, body: {
            seq: 4, answers: { [qs.numeric._id]: { value: 3 }, [qs.essay._id]: { text: 'A school with a big library.' } },
        } });
        assert.equal(sub.status, 200);
        // single right (+2), multiple right (+2), numeric wrong (-1 with half negative marking) = 3
        const row = (await H.q(`SELECT "autoScore", "manualPending", "status" FROM "admissionattempts" WHERE "_id" = $1`, [att._id]))[0];
        assert.equal(row.status, 'submitted');
        assert.equal(row.autoScore, 3);
        assert.equal(row.manualPending, 1);
        const again = await H.api('POST', `/admission/portal/applications/${app._id}/attempts/${att._id}/submit`, { token: guest.token, body: {} });
        assert.equal(again.status, 200, 'submitting twice is harmless');
        const results = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionresults" WHERE "application" = $1`, [app._id]);
        assert.equal(results[0].n, 1);
        const late = await H.api('PUT', `/admission/portal/applications/${app._id}/attempts/${att._id}/answers`, { token: guest.token, body: { seq: 9, answers: {} } });
        assert.equal(late.status, 409, 'no saves after submitting');
        const detail = await H.api('GET', `/admission/portal/applications/${app._id}`, { token: guest.token });
        assert.equal(detail.body.data.exams[0].result, null, 'nothing shown before publication');
        assert.equal((await H.api('GET', `/admission/portal/applications/${app._id}/exams/${exam._id}/scorecard.pdf`, { token: guest.token })).status, 404);
        const st = (await H.q(`SELECT "status" FROM "admissionapplications" WHERE "_id" = $1`, [app._id]))[0];
        assert.equal(st.status, 'exam_completed');
    });

    it('lets only the exam\'s evaluators mark descriptive answers, within the question\'s marks', async () => {
        const att = (await H.q(`SELECT "_id" FROM "admissionattempts" WHERE "application" = $1`, [app._id]))[0];
        const other = await H.insert('users', { _id: H.uuid(), name: 'Other Teacher', email: `t2-${H.rand()}@school.test`, password: 'x', role: 'teacher', school: s.id, isFirstLogin: false, isActive: true, createdAt: new Date() });
        const outsider = H.tokenFor(other);
        assert.equal((await H.api('PUT', `/admission/admin/attempts/${att._id}/evaluate`, { token: outsider, body: { marks: { [qs.essay._id]: 4 } } })).status, 403);
        assert.equal((await H.api('PUT', `/admission/admin/attempts/${att._id}/evaluate`, { token: s.teacherToken, body: { marks: { [qs.essay._id]: 9 } } })).status, 400);
        const ok = await H.api('PUT', `/admission/admin/attempts/${att._id}/evaluate`, { token: s.teacherToken, body: { marks: { [qs.essay._id]: 3.5 } } });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.data.manualPending, 0);
        const res = (await H.q(`SELECT "total", "percentage" FROM "admissionresults" WHERE "application" = $1`, [app._id]))[0];
        assert.equal(res.total, 6.5);
        assert.equal(res.percentage, 65);
    });

    it('moves results through submit → approve → publish, and only then shows them', async () => {
        const sub = await H.api('POST', `/admission/admin/exams/${exam._id}/results/submit`, { token: s.teacherToken });
        assert.equal(sub.status, 200, JSON.stringify(sub.body));
        assert.equal((await H.api('POST', `/admission/admin/exams/${exam._id}/results/approve`, { token: s.teacherToken })).status, 403, 'an evaluator does not approve');
        assert.equal((await H.api('POST', `/admission/admin/exams/${exam._id}/results/publish`, { token: s.adminToken, body: {} })).status, 409, 'not before approval');
        assert.equal((await H.api('POST', `/admission/admin/exams/${exam._id}/results/approve`, { token: s.adminToken })).status, 200);
        // Booked for later: still private.
        const later = await H.api('POST', `/admission/admin/exams/${exam._id}/results/publish`, { token: s.adminToken, body: { at: new Date(Date.now() + 3600 * 1000) } });
        assert.equal(later.body.data.scheduled, true);
        let d = await H.api('GET', `/admission/portal/applications/${app._id}`, { token: guest.token });
        assert.equal(d.body.data.exams[0].result, null);
        // Its time comes (the sweep runs it).
        await H.q(`UPDATE "admissionexams" SET "resultPublishAt" = now() - interval '1 minute' WHERE "_id" = $1`, [exam._id]);
        const exams = require('../../services/admission/exams');
        assert.equal(await exams.publishDue(), 1);
        d = await H.api('GET', `/admission/portal/applications/${app._id}`, { token: guest.token });
        assert.equal(d.body.data.exams[0].result.total, 6.5);
        assert.equal(d.body.data.exams[0].result.passed, true);
        const pdf = await H.api('GET', `/admission/portal/applications/${app._id}/exams/${exam._id}/scorecard.pdf`, { token: guest.token });
        assert.equal(pdf.status, 200);
        assert.equal(pdf.body.slice(0, 5).toString(), '%PDF-');
    });

    it('records corrections with a reason, and families see them only when published again', async () => {
        const res = (await H.q(`SELECT "_id" FROM "admissionresults" WHERE "application" = $1`, [app._id]))[0];
        const noReason = await H.api('POST', `/admission/admin/results/${res._id}/correct`, { token: s.adminToken, body: { manualScore: 4 } });
        assert.equal(noReason.status, 400);
        const c = await H.api('POST', `/admission/admin/results/${res._id}/correct`, { token: s.adminToken, body: { manualScore: 4, reason: 'Re-checked the essay' } });
        assert.equal(c.status, 200);
        let d = await H.api('GET', `/admission/portal/applications/${app._id}`, { token: guest.token });
        assert.equal(d.body.data.exams[0].result.total, 6.5, 'the published figure stands until published again');
        await H.api('POST', `/admission/admin/exams/${exam._id}/results/publish`, { token: s.adminToken, body: {} });
        d = await H.api('GET', `/admission/portal/applications/${app._id}`, { token: guest.token });
        assert.equal(d.body.data.exams[0].result.total, 7);
        const hist = (await H.q(`SELECT "corrections" FROM "admissionresults" WHERE "_id" = $1`, [res._id]))[0].corrections;
        assert.equal(hist.length, 1);
        assert.equal(hist[0].reason, 'Re-checked the essay');
    });

    it('takes offline marks from evaluators only, within the maximum, absences included', async () => {
        await H.verifyAllDocs(s, otherApp._id);
        const r = await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
            round: round._id, name: 'Written Test', mode: 'offline', classes: [s.classes[0]._id], startsAt: new Date(Date.now() + 3600 * 1000),
            subjects: [{ name: 'English', maxMarks: 50, passMarks: 15 }, { name: 'Maths', maxMarks: 50, passMarks: 15 }], passMarks: 40,
            evaluators: [s.teacher._id], venue: { name: 'Main Hall' }, reportingTime: '09:30',
            // A second exam of the round: open to those who have sat the first as well.
            eligibility: { statuses: ['verified', 'eligible', 'exam_completed'] },
        } });
        const off = r.body.data;
        await H.api('POST', `/admission/admin/exams/${off._id}/schedule`, { token: s.adminToken });
        await H.api('POST', `/admission/admin/exams/${off._id}/candidates`, { token: s.adminToken, body: { applicationIds: 'all' } });
        const board = await H.api('GET', `/admission/admin/exams/${off._id}/results`, { token: s.teacherToken });
        assert.equal(board.status, 200);
        const cands = board.body.data.board;
        assert.equal(cands.length, 2);
        const [c1, c2] = cands;
        const keyOf = (name) => off.subjects.find((x) => x.name === name).key;
        const tooHigh = await H.api('PUT', `/admission/admin/exams/${off._id}/marks`, { token: s.teacherToken, body: { rows: [{ candidate: c1.candidateId, marks: { [keyOf('English')]: 60 } }] } });
        assert.equal(tooHigh.body.data.saved, 0);
        assert.ok(tooHigh.body.data.problems.length);
        const ok = await H.api('PUT', `/admission/admin/exams/${off._id}/marks`, { token: s.teacherToken, body: { rows: [
            { candidate: c1.candidateId, marks: { [keyOf('English')]: 40, [keyOf('Maths')]: 10 } },
            { candidate: c2.candidateId, absent: true },
        ] } });
        assert.equal(ok.body.data.saved, 2);
        const results = await H.q(`SELECT r."passed", r."absent", r."total", c."_id" AS cid FROM "admissionresults" r JOIN "admissioncandidates" c ON c."exam" = r."exam" AND c."application" = r."application" WHERE r."exam" = $1`, [off._id]);
        const r1 = results.find((x) => x.cid === c1.candidateId);
        assert.equal(r1.total, 50);
        assert.equal(r1.passed, false, 'failing one subject\'s pass mark fails the exam');
        assert.ok(results.find((x) => x.cid === c2.candidateId).absent);
        const card = await H.api('GET', `/admission/portal/applications/${app._id}/exams/${off._id}/admit-card.pdf`, { token: guest.token });
        assert.equal(card.status, 200);
        assert.equal(card.body.slice(0, 5).toString(), '%PDF-');
    });

    it('submits an attempt whose time ran out', async () => {
        const g = await H.registerGuest(s, portal.slug);
        const a2 = await H.submittedApplication(s, g, round);
        await H.verifyAllDocs(s, a2._id);
        const quiz = (await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
            round: round._id, name: 'Quick Quiz', mode: 'online', classes: [s.classes[0]._id],
            startsAt: new Date(Date.now() - 60000), endsAt: new Date(Date.now() + 3600 * 1000), durationMinutes: 10,
        } })).body.data;
        const q1 = (await H.api('POST', `/admission/admin/exams/${quiz._id}/questions`, { token: s.adminToken, body: { type: 'single', text: '1 + 1 =', options: [{ text: '1' }, { text: '2' }], correct: ['b'], marks: 2 } })).body.data;
        assert.equal((await H.api('POST', `/admission/admin/exams/${quiz._id}/schedule`, { token: s.adminToken })).status, 200);
        const add = await H.api('POST', `/admission/admin/exams/${quiz._id}/candidates`, { token: s.adminToken, body: { applicationIds: [a2._id] } });
        assert.equal(add.body.data?.added, 1, JSON.stringify(add.body));
        const exam = quiz; const qs = { single: q1 };
        const st = await H.api('POST', `/admission/portal/applications/${a2._id}/exams/${exam._id}/start`, { token: g.token });
        assert.equal(st.status, 200, JSON.stringify(st.body));
        await H.api('PUT', `/admission/portal/applications/${a2._id}/attempts/${st.body.data._id}/answers`, { token: g.token, body: { seq: 1, answers: { [qs.single._id]: { selected: ['b'] } } } });
        await H.q(`UPDATE "admissionattempts" SET "deadlineAt" = now() - interval '1 minute' WHERE "_id" = $1`, [st.body.data._id]);
        const exams = require('../../services/admission/exams');
        assert.ok(await exams.autoSubmitDue() >= 1);
        const row = (await H.q(`SELECT "status", "autoScore" FROM "admissionattempts" WHERE "_id" = $1`, [st.body.data._id]))[0];
        assert.equal(row.status, 'auto_submitted');
        assert.equal(row.autoScore, 2, 'what was saved before the time ran out counts');
    });
});
