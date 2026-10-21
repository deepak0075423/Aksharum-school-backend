'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Level 2 — from offer to student, along every path the old suite did not
 * take: withdrawing an accepted offer that was never paid, the preview's
 * blockers, accounts created switched off and activated later, the
 * applicant's own account becoming the student's, a full section, and health
 * answers reaching the Medical Room.
 */
const status = async (id) => (await H.q(`SELECT "status" FROM "admissionapplications" WHERE "_id" = $1`, [id]))[0].status;

describe('admission — level 2: confirmation and enrolment, every path', () => {
    let s; let portal; let round; let n = 0;
    const names = ['Zoya Ali', 'Arnav Iyer', 'Bhavna Rao', 'Chetan Das', 'Divya Nair', 'Ekansh Jain', 'Farah Shaikh', 'Gauri Menon', 'Harsh Vora', 'Ira Bose'];
    const offered = async (answers = {}, classIdx = 0) => {
        const g = await H.registerGuest(s, portal.slug);
        const a = await H.submittedApplication(s, g, round, { classIdx, answers: { studentName: names[n], studentDob: `2021-0${(n % 9) + 1}-2${n % 9}`, ...answers } });
        n += 1;
        await H.verifyAllDocs(s, a._id);
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/offer`, { token: s.adminToken, body: {} })).status, 201);
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/offer/respond`, { token: s.adminToken, body: { accept: true, note: 'Accepted at the counter' } })).status, 200);
        return { g, a };
    };
    const confirmed = async (answers, classIdx) => {
        const { g, a } = await offered(answers, classIdx);
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/payments`, { token: s.adminToken, body: { kind: 'admission_fee', amount: 1000, mode: 'cash' } })).status, 201);
        const c = await H.api('POST', `/admission/admin/applications/${a._id}/confirm`, { token: s.adminToken });
        assert.equal(c.status, 200, JSON.stringify(c.body));
        return { g, a };
    };
    const parent = () => ({ mode: 'new', relation: 'Mother', name: 'Geeta Varma', email: `mum-${H.rand()}@family.test`, phone: '9811100022' });

    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Enrol', { modules: { medical: true } });
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 10, seats2: 10, admissionFee: 1000 });
    });
    after(() => H.finish());

    it('withdraws an offer the family accepted but has not paid for — and the seat goes back', async () => {
        const { a } = await offered();
        assert.equal(await status(a._id), 'payment_pending');
        const seats = async () => (await H.api('GET', `/admission/admin/rounds/${round._id}/seats`, { token: s.adminToken })).body.data.find((c) => c.class === s.classes[0]._id).taken;
        const held = await seats();
        const w = await H.api('POST', `/admission/admin/applications/${a._id}/offer/withdraw`, { token: s.adminToken, body: { reason: 'The family did not pay within the time given.' } });
        assert.equal(w.status, 200, JSON.stringify(w.body));
        assert.equal(await status(a._id), 'offer_expired');
        assert.equal(await seats(), held - 1, 'the seat is free again');
        const again = await H.api('POST', `/admission/admin/applications/${a._id}/offer`, { token: s.adminToken, body: {} });
        assert.equal(again.status, 201, 'and can be offered again');
    });

    it('shows what enrolment will do — and waits for the admission to be confirmed', async () => {
        const { a } = await offered();
        const pre = (await H.api('GET', `/admission/admin/applications/${a._id}/conversion`, { token: s.adminToken })).body.data;
        assert.equal(pre.ready, false);
        assert.ok(pre.blockers.some((b) => /confirm/i.test(b)));
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/convert`, { token: s.adminToken, body: { studentEmail: `x-${H.rand()}@kids.test`, parent: parent() } })).status, 409);
    });

    it('creates the accounts switched off when the school activates them later — then switches them on', async () => {
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { conversion: { activation: 'manual', sendCredentials: false } } });
        const { g, a } = await confirmed();
        const studentEmail = `kid-${H.rand()}@kids.test`;
        const p = parent();
        const r = await H.api('POST', `/admission/admin/applications/${a._id}/convert`, { token: s.adminToken, body: { studentEmail, parent: p } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const active = async (email) => (await H.q(`SELECT "isActive" FROM "users" WHERE "email" = $1 AND "school" = $2`, [email, s.id]))[0]?.isActive;
        assert.equal(await active(studentEmail), false);
        assert.equal(await active(p.email), false);
        const note = async () => (await H.api('GET', `/admission/portal/applications/${a._id}`, { token: g.token })).body.data.application.signInNote;
        assert.match(await note(), /switch the accounts on/, 'nothing sent yet — the family is not told it was');
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/activate`, { token: s.adminToken })).status, 200);
        assert.equal(await active(studentEmail), true);
        assert.equal(await active(p.email), true);
        assert.equal(await note(), 'Sign-in details for the student and parent accounts have been emailed.', 'activation sent both');
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/activate`, { token: s.adminToken })).status, 409, 'already active');
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { conversion: { activation: 'immediate', sendCredentials: false } } });
    });

    it('keeps a parent who signs in at another school switched off here until activation', async () => {
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { conversion: { activation: 'manual', sendCredentials: false } } });
        const elsewhere = await H.makeSchool('Enrol-B');
        const email = `shared-${H.rand()}@family.test`;
        await H.insert('users', { _id: H.uuid(), name: 'Kavya Joshi', email, password: 'x', role: 'parent', school: elsewhere.id, isFirstLogin: false, isActive: true, createdAt: new Date() });
        const { a } = await confirmed();
        const r = await H.api('POST', `/admission/admin/applications/${a._id}/convert`, { token: s.adminToken, body: { studentEmail: `kid-${H.rand()}@kids.test`, parent: { mode: 'new', relation: 'Mother', name: 'Kavya Joshi', email, phone: '9811100023' } } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.data.conversion.parentMode, 'linked_sign_in');
        const here = async () => (await H.q(`SELECT "isActive" FROM "users" WHERE "email" = $1 AND "school" = $2`, [email, s.id]))[0].isActive;
        assert.equal(await here(), false, 'no parent portal at this school before activation');
        const there = (await H.q(`SELECT "isActive" FROM "users" WHERE "email" = $1 AND "school" = $2`, [email, elsewhere.id]))[0].isActive;
        assert.equal(there, true, 'the other school is untouched');
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/activate`, { token: s.adminToken })).status, 200);
        assert.equal(await here(), true);
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { conversion: { activation: 'immediate', sendCredentials: false } } });
    });

    it('turns the applicant\'s own account into the student\'s when that address holds nothing else', async () => {
        const { g, a } = await confirmed();
        const pre = (await H.api('GET', `/admission/admin/applications/${a._id}/conversion`, { token: s.adminToken })).body.data;
        assert.equal(pre.student.canUseApplicantAccount, true);
        const r = await H.api('POST', `/admission/admin/applications/${a._id}/convert`, { token: s.adminToken, body: { studentAccount: 'applicant', parent: parent() } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const rows = await H.q(`SELECT "role" FROM "users" WHERE "email" = $1`, [g.email]);
        assert.deepEqual(rows.map((x) => x.role), ['student'], 'one account, now a student');
        assert.equal((await H.api('GET', '/admission/portal/me', { token: g.token })).status, 403, 'no longer an applicant');
    });

    it('records the confirmation once, and tells the family only what was really sent', async () => {
        const { g, a } = await confirmed();
        const view = async () => (await H.api('GET', `/admission/portal/applications/${a._id}`, { token: g.token })).body.data;
        const confirmedLines = (await view()).timeline.filter((e) => /Admission confirmed/.test(e.message));
        assert.equal(confirmedLines.length, 1, JSON.stringify(confirmedLines));
        const r = await H.api('POST', `/admission/admin/applications/${a._id}/convert`, { token: s.adminToken, body: { studentEmail: `kid-${H.rand()}@kids.test`, parent: parent() } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const app = (await view()).application;
        assert.equal(app.status, 'enrolled');
        assert.equal(app.signInNote, 'The school will give you the student and parent sign-in details.', 'credential emails are off for this school');
        const mail = (await H.q(`SELECT "body" FROM "admissionemaillogs" WHERE "school" = $1 AND "event" = 'enrollment_complete' AND "to" = $2`, [s.id, g.email]))[0];
        assert.ok(mail, 'the family is emailed the admission number');
        assert.match(mail.body, /The school will give you the student and parent sign-in details\./);
        assert.doesNotMatch(mail.body, /have been (sent|emailed)/);
    });

    it('refuses a full section, and places the student where there is room', async () => {
        const one = await confirmed();
        const two = await confirmed();
        const body = () => ({ section: s.sections.B._id, studentEmail: `kid-${H.rand()}@kids.test`, parent: parent() });
        assert.equal((await H.api('POST', `/admission/admin/applications/${one.a._id}/convert`, { token: s.adminToken, body: body() })).status, 200);
        const full = await H.api('POST', `/admission/admin/applications/${two.a._id}/convert`, { token: s.adminToken, body: body() });
        assert.equal(full.status, 409, 'section B holds one');
        assert.equal(await status(two.a._id), 'confirmed', 'nothing changed');
        const [kids] = await H.q(`SELECT COUNT(*)::int AS n FROM "users" WHERE "school" = $1 AND "role" = 'student'`, [s.id]);
        const ok = await H.api('POST', `/admission/admin/applications/${two.a._id}/convert`, { token: s.adminToken, body: { ...body(), section: s.sections.A._id } });
        assert.equal(ok.status, 200);
        const [after] = await H.q(`SELECT COUNT(*)::int AS n FROM "users" WHERE "school" = $1 AND "role" = 'student'`, [s.id]);
        assert.equal(after.n, kids.n + 1, 'the refused attempt left no student behind');
    });

    it('passes the health answers to the Medical Room when the school runs it', async () => {
        const { a } = await confirmed({ allergies: 'Peanuts (severe)', conditions: 'Asthma' });
        const r = await H.api('POST', `/admission/admin/applications/${a._id}/convert`, { token: s.adminToken, body: { studentEmail: `kid-${H.rand()}@kids.test`, parent: parent() } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const steps = r.body.data.conversion.steps;
        assert.equal(steps.medical?.ok, true, JSON.stringify(steps));
        assert.ok(steps.medical.allergies >= 1 && steps.medical.conditions >= 1, JSON.stringify(steps.medical));
        const [al] = await H.q(`SELECT COUNT(*)::int AS n FROM "medicalallergies" WHERE "student" = $1`, [r.body.data.studentUser]);
        assert.ok(al.n >= 1);
    });
});
