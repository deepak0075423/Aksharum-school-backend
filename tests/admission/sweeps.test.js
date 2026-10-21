'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Level 6 — what happens because time passed: lists and results published at
 * the time set, offers lapsing (and the waiting list moving up), reminders for
 * exams and fees, admit cards becoming available, and the daily note about
 * applications waiting too long in a stage. Each must happen once — however
 * many servers run the sweep, however often.
 *
 * Times are moved by editing the rows ("the deadline was yesterday") rather
 * than by waiting. A development server sweeping the same database may get
 * there first; the assertions are about the outcome, which must be the same.
 */
const sweep = require('../../services/admission/sweep');
const selection = require('../../services/admission/selection');
const exams = require('../../services/admission/exams');
const settingsSvc = require('../../services/admission/settings');

const until = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v || Date.now() > end) return v;
        await new Promise((r) => setTimeout(r, 100));
    }
};
const mails = async (schoolId, event, to) => (await H.q(`SELECT COUNT(*)::int AS n FROM "admissionemaillogs" WHERE "school" = $1 AND "event" = $2 ${to ? 'AND "to" = $3' : ''}`, to ? [schoolId, event, to] : [schoolId, event]))[0].n;
const status = async (id) => (await H.q(`SELECT "status" FROM "admissionapplications" WHERE "_id" = $1`, [id]))[0].status;

describe('admission — level 6: things that happen on time, once', () => {
    let s; let portal; let round; let exam; const g = []; const app = [];
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Clock');
        portal = await H.openPortal(s, { settings: { email: { reminders: { examHoursBefore: 24, paymentDaysBefore: 3 } } } });
        round = await H.makeRound(s, portal.form, { seats1: 1, admissionFee: 9000 });
        for (let i = 0; i < 3; i++) {
            g[i] = await H.registerGuest(s, portal.slug);
            app[i] = await H.submittedApplication(s, g[i], round, { answers: { studentName: ['Ravi Tej', 'Sana Mir', 'Tanu Jha'][i], studentDob: `2021-0${i + 2}-10` } });
            await H.verifyAllDocs(s, app[i]._id);
        }
        exam = (await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
            round: round._id, name: 'Timed Test', mode: 'offline', classes: [s.classes[0]._id], startsAt: new Date(Date.now() + 6 * 3600e3),
            subjects: [{ name: 'Reasoning', maxMarks: 100 }], admitCard: { enabled: true, releaseAt: new Date(Date.now() + 3600e3) },
        } })).body.data;
        await H.api('POST', `/admission/admin/exams/${exam._id}/schedule`, { token: s.adminToken });
        await H.api('POST', `/admission/admin/exams/${exam._id}/candidates`, { token: s.adminToken, body: { applicationIds: 'all' } });
    });
    after(() => H.finish());

    it('releases admit cards at their time — not before — and tells each family once', async () => {
        const settings = await settingsSvc.getSettings(s.id, { fresh: true });
        await sweep.admitCards(s.id, settings);
        assert.equal(await mails(s.id, 'admit_card_available'), 0, 'not yet released');
        const early = await H.api('GET', `/admission/portal/applications/${app[0]._id}/exams/${exam._id}/admit-card.pdf`, { token: g[0].token });
        assert.equal(early.status, 409, 'the card cannot be downloaded before its time');
        await H.q(`UPDATE "admissionexams" SET "admitCard" = jsonb_set("admitCard", '{releaseAt}', to_jsonb((now() - interval '1 minute')::text)) WHERE "_id" = $1`, [exam._id]);
        await sweep.admitCards(s.id, settings);
        await sweep.admitCards(s.id, settings);
        assert.equal(await until(async () => (await mails(s.id, 'admit_card_available')) === 3), true, 'one email per candidate');
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(await mails(s.id, 'admit_card_available'), 3, 'and never a second');
        const card = await H.api('GET', `/admission/portal/applications/${app[0]._id}/exams/${exam._id}/admit-card.pdf`, { token: g[0].token });
        assert.equal(card.status, 200);
        assert.equal(card.body.subarray(0, 4).toString(), '%PDF');
    });

    it('reminds families of an exam once, inside the window the school set', async () => {
        const settings = await settingsSvc.getSettings(s.id, { fresh: true });
        await sweep.examReminders(s.id, settings);
        await sweep.examReminders(s.id, settings);
        assert.equal(await until(async () => (await mails(s.id, 'exam_reminder')) === 3), true, 'the exam is 6 hours away: inside 24');
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(await mails(s.id, 'exam_reminder'), 3, 'once each');
    });

    it('publishes results at the time set — once', async () => {
        const board = (await H.api('GET', `/admission/admin/exams/${exam._id}/results`, { token: s.adminToken })).body.data.board;
        const key = exam.subjects[0].key;
        const marks = { [app[0]._id]: 90, [app[1]._id]: 80, [app[2]._id]: 70 };
        await H.api('PUT', `/admission/admin/exams/${exam._id}/marks`, { token: s.adminToken, body: { rows: board.map((b) => ({ candidate: b.candidateId, marks: { [key]: marks[b.applicationId] } })) } });
        for (const step of ['submit', 'approve']) assert.equal((await H.api('POST', `/admission/admin/exams/${exam._id}/results/${step}`, { token: s.adminToken })).status, 200);
        const at = new Date(Date.now() + 3600e3).toISOString();
        const sched = await H.api('POST', `/admission/admin/exams/${exam._id}/results/publish`, { token: s.adminToken, body: { at } });
        assert.equal(sched.body.data.scheduled, true);
        await exams.publishDue();
        assert.notEqual((await H.q(`SELECT "resultsStatus" FROM "admissionexams" WHERE "_id" = $1`, [exam._id]))[0].resultsStatus, 'published', 'not before its time');
        await H.q(`UPDATE "admissionexams" SET "resultPublishAt" = now() - interval '1 minute' WHERE "_id" = $1`, [exam._id]);
        await Promise.all([exams.publishDue(), exams.publishDue()]);
        assert.equal((await H.q(`SELECT "resultsStatus" FROM "admissionexams" WHERE "_id" = $1`, [exam._id]))[0].resultsStatus, 'published');
        assert.equal(await until(async () => (await mails(s.id, 'result_published')) === 3), true);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(await mails(s.id, 'result_published'), 3, 'each family told once, though two sweeps ran');
    });

    it('publishes a list at the time set — once, under the seat lock', async () => {
        const list = (await H.api('POST', '/admission/admin/lists', { token: s.adminToken, body: { round: round._id, class: s.classes[0]._id, seats: 1, waitlistSize: 2, criteria: { weights: [{ source: `exam:${exam._id}`, weight: 1 }] } } })).body.data.list;
        for (const step of ['submit', 'approve']) await H.api('POST', `/admission/admin/lists/${list._id}/${step}`, { token: s.adminToken });
        const r = await H.api('POST', `/admission/admin/lists/${list._id}/publish`, { token: s.adminToken, body: { at: new Date(Date.now() + 3600e3) } });
        assert.equal(r.body.data.scheduled, true);
        await selection.publishDue();
        assert.equal((await H.q(`SELECT "status" FROM "admissionlists" WHERE "_id" = $1`, [list._id]))[0].status, 'approved');
        await H.q(`UPDATE "admissionlists" SET "publishAt" = now() - interval '1 minute' WHERE "_id" = $1`, [list._id]);
        await Promise.all([selection.publishDue(), selection.publishDue()]);
        assert.equal((await H.q(`SELECT "status" FROM "admissionlists" WHERE "_id" = $1`, [list._id]))[0].status, 'published');
        const offers = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionoffers" WHERE "round" = $1 AND "status" = 'issued'`, [round._id]);
        assert.equal(offers[0].n, 1, 'one seat, one offer — though two sweeps ran');
        assert.equal(await status(app[0]._id), 'offer_issued');
        assert.equal(await status(app[1]._id), 'waitlisted');
    });

    it('reminds a family of the admission fee before it is due — once', async () => {
        await H.api('POST', `/admission/portal/applications/${app[0]._id}/offer/respond`, { token: g[0].token, body: { accept: true } });
        assert.equal(await status(app[0]._id), 'payment_pending');
        await H.q(`UPDATE "admissionoffers" SET "feeDueAt" = now() + interval '2 days' WHERE "application" = $1`, [app[0]._id]);
        const settings = await settingsSvc.getSettings(s.id, { fresh: true });
        await sweep.paymentReminders(s.id, settings);
        await sweep.paymentReminders(s.id, settings);
        assert.equal(await until(async () => (await mails(s.id, 'payment_reminder')) === 1), true);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(await mails(s.id, 'payment_reminder'), 1);
    });

    it('lapses an unpaid offer after its date and offers the seat to the next on the waiting list', async () => {
        await H.q(`UPDATE "admissionoffers" SET "feeDueAt" = now() - interval '1 hour' WHERE "application" = $1`, [app[0]._id]);
        await Promise.all([selection.expireDue(), selection.expireDue()]);
        await until(async () => (await status(app[1]._id)) === 'offer_issued');
        assert.equal(await status(app[0]._id), 'offer_expired');
        assert.equal(await status(app[1]._id), 'offer_issued', 'the first on the waiting list gets the seat');
        assert.equal(await status(app[2]._id), 'waitlisted', 'only one seat');
        const live = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionoffers" WHERE "round" = $1 AND "status" IN ('issued', 'accepted', 'confirmed')`, [round._id]);
        assert.equal(live[0].n, 1, 'never more live offers than seats');
    });

    it('tells the people handling a stage, once a day, about applications waiting too long', async () => {
        const wf = (await H.api('GET', '/admission/admin/workflow', { token: s.adminToken })).body.data.stages;
        await H.api('PUT', '/admission/admin/workflow', { token: s.adminToken, body: { stages: wf.map((x) => (x.key === 'exam' ? { ...x, deadlineDays: 1, assignees: [s.teacher._id] } : x)) } });
        const g4 = await H.registerGuest(s, portal.slug);
        const a4 = await H.submittedApplication(s, g4, round, { answers: { studentName: 'Uma Pai', studentDob: '2021-08-08' } });
        assert.equal((await H.api('POST', `/admission/admin/applications/${a4._id}/transition`, { token: s.adminToken, body: { to: 'exam_completed' } })).status, 200);
        await H.q(`UPDATE "admissionapplications" SET "statusChangedAt" = now() - interval '3 days' WHERE "_id" = $1`, [a4._id]);
        const settings = await settingsSvc.getSettings(s.id, { fresh: true });
        const before = (await H.q(`SELECT COUNT(*)::int AS n FROM "notifications" WHERE "school" = $1 AND "title" LIKE '%waiting in%'`, [s.id]))[0].n;
        await sweep.stageDigests(s.id, settings);
        await sweep.stageDigests(s.id, settings);
        const n = await until(async () => (await H.q(`SELECT COUNT(*)::int AS n FROM "notifications" WHERE "school" = $1 AND "title" LIKE '%waiting in%'`, [s.id]))[0].n > before && (await H.q(`SELECT COUNT(*)::int AS n FROM "notifications" WHERE "school" = $1 AND "title" LIKE '%waiting in%'`, [s.id]))[0].n);
        assert.ok(n, 'a digest was sent');
        await new Promise((r) => setTimeout(r, 300));
        const after = (await H.q(`SELECT COUNT(*)::int AS n FROM "notifications" WHERE "school" = $1 AND "title" LIKE '%waiting in%'`, [s.id]))[0].n;
        assert.equal(after - before, 1, 'one a day per stage');
    });
});
