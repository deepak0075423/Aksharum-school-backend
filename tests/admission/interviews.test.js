'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Level 2 — interviews (slots, panels, a panel member marking only their own
 * candidates), admit cards, and an online exam that may be taken twice.
 */
describe('admission — level 2: interviews, admit cards and retakes', () => {
    let s; let other; let portal; let round; let interview; let board; let key; const g = []; const app = [];
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Panel');
        other = await H.makeSchool('Panel-B');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 5 });
        for (let i = 0; i < 3; i++) {
            g[i] = await H.registerGuest(s, portal.slug);
            app[i] = await H.submittedApplication(s, g[i], round, { answers: { studentName: ['Vir Shah', 'Wafa Khan', 'Yash Goel'][i], studentDob: `2021-1${i}-05` } });
            await H.verifyAllDocs(s, app[i]._id);
        }
        interview = (await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
            round: round._id, name: 'Family Interview', mode: 'interview', classes: [s.classes[0]._id], startsAt: new Date(Date.now() + 86400e3),
            subjects: [{ name: 'Communication', maxMarks: 20 }],
        } })).body.data;
        key = interview.subjects[0].key;
        assert.equal((await H.api('POST', `/admission/admin/exams/${interview._id}/schedule`, { token: s.adminToken })).status, 200);
        assert.equal((await H.api('POST', `/admission/admin/exams/${interview._id}/candidates`, { token: s.adminToken, body: { applicationIds: 'all' } })).status, 200);
        board = (await H.api('GET', `/admission/admin/exams/${interview._id}/results`, { token: s.adminToken })).body.data.board;
    });
    after(() => H.finish());

    const cand = (i) => board.find((b) => b.applicationId === app[i]._id);

    it('gives a candidate a slot, a room and a panel — of the school\'s own staff', async () => {
        const set = (i, body) => H.api('PATCH', `/admission/admin/exams/${interview._id}/candidates/${cand(i).candidateId}`, { token: s.adminToken, body });
        assert.equal((await set(1, { panel: [other.admin._id] })).status, 400, 'another school\'s staff');
        const slot = new Date(Date.now() + 86400e3 + 3600e3);
        const r = await set(0, { panel: [s.teacher._id], slot, room: 'Room 4' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.data.room, 'Room 4');
        const fam = (await H.api('GET', `/admission/portal/applications/${app[0]._id}`, { token: g[0].token })).body.data;
        assert.ok(JSON.stringify(fam.exams).includes('Room 4') || JSON.stringify(fam.exams).includes(slot.toISOString().slice(0, 13)), 'the family sees their slot');
    });

    it('lets a panel member mark only the candidates they sit with — not submit the results', async () => {
        const seen = await H.api('GET', `/admission/admin/exams/${interview._id}/results`, { token: s.teacherToken });
        assert.equal(seen.status, 200);
        assert.equal(seen.body.data.panelOnly, true);
        assert.deepEqual(seen.body.data.board.map((b) => b.applicationId), [app[0]._id], 'only their own candidate');
        const marks = await H.api('PUT', `/admission/admin/exams/${interview._id}/marks`, { token: s.teacherToken, body: { rows: [
            { candidate: cand(0).candidateId, marks: { [key]: 15 } },
            { candidate: cand(1).candidateId, marks: { [key]: 19 } },
        ] } });
        assert.equal(marks.status, 200);
        assert.equal(marks.body.data.saved, 1);
        assert.equal(marks.body.data.problems.length, 1, 'the other candidate was skipped');
        const [r1] = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionresults" WHERE "exam" = $1 AND "application" = $2`, [interview._id, app[1]._id]);
        assert.equal(r1.n, 0, 'nothing written for a candidate they do not sit with');
        assert.equal((await H.api('POST', `/admission/admin/exams/${interview._id}/candidates/${cand(1).candidateId}/attendance`, { token: s.teacherToken, body: { present: false } })).status, 403);
        assert.equal((await H.api('POST', `/admission/admin/exams/${interview._id}/results/submit`, { token: s.teacherToken })).status, 403, 'submitting is for the exam\'s evaluators');
        const duties = (await H.api('GET', '/admission/staff/duties', { token: s.teacherToken })).body.data;
        assert.ok(duties.exams.some((e) => e._id === interview._id), 'the interview is on their duties');
    });

    it('prints an admit card for each candidate', async () => {
        const pdf = await H.api('GET', `/admission/admin/exams/${interview._id}/candidates/${cand(2).candidateId}/admit-card.pdf`, { token: s.adminToken });
        assert.equal(pdf.status, 200);
        assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
        const fam = await H.api('GET', `/admission/portal/applications/${app[2]._id}/exams/${interview._id}/admit-card.pdf`, { token: g[2].token });
        assert.equal(fam.status, 200);
        assert.equal((await H.api('GET', `/admission/portal/applications/${app[2]._id}/exams/${interview._id}/admit-card.pdf`, { token: g[1].token })).status, 404, 'not another family\'s');
    });

    it('makes no offer on a result nobody has approved — by default', async () => {
        const g9 = await H.registerGuest(s, portal.slug);
        const a9 = await H.submittedApplication(s, g9, round, { classIdx: 1, answers: { studentName: 'Neel Sood', studentDob: '2020-12-12' } });
        await H.verifyAllDocs(s, a9._id);
        const ex = (await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
            round: round._id, name: 'Class 2 Test', mode: 'offline', classes: [s.classes[1]._id], startsAt: new Date(Date.now() + 3600e3), subjects: [{ name: 'Maths', maxMarks: 50 }],
        } })).body.data;
        await H.api('POST', `/admission/admin/exams/${ex._id}/schedule`, { token: s.adminToken });
        await H.api('POST', `/admission/admin/exams/${ex._id}/candidates`, { token: s.adminToken, body: { applicationIds: [a9._id] } });
        const b = (await H.api('GET', `/admission/admin/exams/${ex._id}/results`, { token: s.adminToken })).body.data.board;
        await H.api('PUT', `/admission/admin/exams/${ex._id}/marks`, { token: s.adminToken, body: { rows: [{ candidate: b[0].candidateId, marks: { [ex.subjects[0].key]: 41 } }] } });
        const early = await H.api('POST', `/admission/admin/applications/${a9._id}/offer`, { token: s.adminToken, body: {} });
        assert.equal(early.status, 409, JSON.stringify(early.body));
        assert.equal(early.body.code, 'NOT_READY');
        assert.match(early.body.message, /not been approved/);
        for (const step of ['submit', 'approve']) assert.equal((await H.api('POST', `/admission/admin/exams/${ex._id}/results/${step}`, { token: s.adminToken })).status, 200);
        const ok = await H.api('POST', `/admission/admin/applications/${a9._id}/offer`, { token: s.adminToken, body: {} });
        assert.equal(ok.status, 201, JSON.stringify(ok.body));
    });

    it('lets an online exam be taken as often as allowed — the latest sitting counts', async () => {
        const online = (await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
            round: round._id, name: 'Retake Quiz', mode: 'online', classes: [s.classes[0]._id], subjects: [],
            startsAt: new Date(Date.now() - 60e3), endsAt: new Date(Date.now() + 86400e3), durationMinutes: 10,
            settings: { attemptsAllowed: 2 }, eligibility: { statuses: ['interview_scheduled', 'verified', 'eligible'] },
        } })).body.data;
        assert.equal((await H.api('POST', `/admission/admin/exams/${online._id}/questions`, { token: s.adminToken, body: { type: 'single', text: 'What is two plus two', options: ['3', '4'], correct: [1], marks: 2 } })).status, 201);
        assert.equal((await H.api('POST', `/admission/admin/exams/${online._id}/schedule`, { token: s.adminToken })).status, 200);
        assert.equal((await H.api('POST', `/admission/admin/exams/${online._id}/candidates`, { token: s.adminToken, body: { applicationIds: [app[0]._id] } })).status, 200);
        const sit = async (choice) => {
            const a = (await H.api('POST', `/admission/portal/applications/${app[0]._id}/exams/${online._id}/start`, { token: g[0].token })).body.data;
            const qid = String(a.questions[0]._id);
            const done = await H.api('POST', `/admission/portal/applications/${app[0]._id}/attempts/${a._id}/submit`, { token: g[0].token, body: { seq: 1, answers: { [qid]: { selected: [choice] } } } });
            assert.equal(done.status, 200, JSON.stringify(done.body));
            const res = (await H.api('GET', `/admission/admin/exams/${online._id}/results`, { token: s.adminToken })).body.data.board.find((b) => b.applicationId === app[0]._id);
            return res.total;
        };
        assert.equal(await sit('b'), 2, 'first sitting right');
        assert.equal(await sit('a'), 0, 'second sitting wrong — the latest counts');
        const third = await H.api('POST', `/admission/portal/applications/${app[0]._id}/exams/${online._id}/start`, { token: g[0].token });
        assert.equal(third.status, 409);
        assert.equal(third.body.code, 'NO_ATTEMPTS_LEFT');
    });
});
