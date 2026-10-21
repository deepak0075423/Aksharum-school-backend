'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const status = async (id) => (await H.q(`SELECT "status" FROM "admissionapplications" WHERE "_id" = $1`, [id]))[0].status;

describe('admission — selection, offers, confirmation and enrolment', () => {
    let s; let portal; let round; let exam; const apps = []; const guests = []; let list;
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Select');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 2, seats2: 10, admissionFee: 1000 });
        await H.insert('feestructures', { _id: H.uuid(), school: s.id, academicYear: s.year._id, name: 'Class 1 Fees', level: 'class', class: s.classes[0]._id, items: [], totalAmount: 12000, isActive: true, createdAt: new Date(), updatedAt: new Date() });
        for (let i = 0; i < 4; i++) {
            const g = await H.registerGuest(s, portal.slug);
            const a = await H.submittedApplication(s, g, round, { answers: { studentName: ['Aarav Rao', 'Bela Das', 'Chirag Jain', 'Diya Paul'][i], needsTransport: i === 0, transportAddress: i === 0 ? '4 Lake Road' : undefined } });
            await H.verifyAllDocs(s, a._id);
            guests.push(g); apps.push(a);
        }
        exam = (await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
            round: round._id, name: 'Written Test', mode: 'offline', classes: [s.classes[0]._id], startsAt: new Date(Date.now() + 3600 * 1000),
            subjects: [{ name: 'Aptitude', maxMarks: 100 }],
        } })).body.data;
        await H.api('POST', `/admission/admin/exams/${exam._id}/schedule`, { token: s.adminToken });
        await H.api('POST', `/admission/admin/exams/${exam._id}/candidates`, { token: s.adminToken, body: { applicationIds: 'all' } });
        const board = (await H.api('GET', `/admission/admin/exams/${exam._id}/results`, { token: s.adminToken })).body.data.board;
        const key = exam.subjects[0].key;
        const marks = { [apps[0]._id]: 90, [apps[1]._id]: 80, [apps[2]._id]: 70, [apps[3]._id]: 60 };
        await H.api('PUT', `/admission/admin/exams/${exam._id}/marks`, { token: s.adminToken, body: { rows: board.map((b) => ({ candidate: b.candidateId, marks: { [key]: marks[b.applicationId] } })) } });
        assert.equal((await H.api('POST', `/admission/admin/exams/${exam._id}/results/submit`, { token: s.adminToken })).status, 200);
        assert.equal((await H.api('POST', `/admission/admin/exams/${exam._id}/results/approve`, { token: s.adminToken })).status, 200);
    });
    after(() => H.finish());

    it('ranks by the written criteria into a draft list: selected up to the seats, then the waiting list', async () => {
        const r = await H.api('POST', '/admission/admin/lists', { token: s.adminToken, body: {
            round: round._id, class: s.classes[0]._id, waitlistSize: 2, criteria: { weights: [{ source: `exam:${exam._id}`, weight: 1 }] },
        } });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        list = r.body.data.list;
        assert.equal(list.name, 'First List');
        const d = await H.api('GET', `/admission/admin/lists/${list._id}`, { token: s.adminToken });
        const lines = d.body.data.lines;
        assert.deepEqual(lines.map((l) => l.applicationId), apps.map((a) => a._id), 'ordered by score');
        assert.deepEqual(lines.map((l) => l.decision), ['selected', 'selected', 'waitlisted', 'waitlisted']);
        assert.deepEqual(lines.map((l) => l.waitPosition), [null, null, 1, 2]);
        // A change by hand needs a reason, and is kept on the line.
        const no = await H.api('PATCH', `/admission/admin/lists/${list._id}/entries/${lines[3]._id}`, { token: s.adminToken, body: { decision: 'not_selected' } });
        assert.equal(no.status, 400);
        // Nothing reaches families before approval and publication.
        assert.equal(await status(apps[0]._id), 'exam_completed');
        assert.equal((await H.api('POST', `/admission/admin/lists/${list._id}/publish`, { token: s.adminToken, body: {} })).status, 409);
        const view = await H.api('GET', `/admission/portal/applications/${apps[0]._id}/lists`, { token: guests[0].token });
        assert.equal(view.body.data.length, 0, 'a draft list is invisible to families');
    });

    it('publishes after approval: offers to the selected, positions to the waiting list', async () => {
        assert.equal((await H.api('POST', `/admission/admin/lists/${list._id}/submit`, { token: s.adminToken })).status, 200);
        assert.equal((await H.api('POST', `/admission/admin/lists/${list._id}/approve`, { token: s.adminToken })).status, 200);
        const p = await H.api('POST', `/admission/admin/lists/${list._id}/publish`, { token: s.adminToken, body: {} });
        assert.equal(p.status, 200, JSON.stringify(p.body));
        assert.equal(p.body.data.offered, 2);
        assert.equal(p.body.data.waitlisted, 2);
        assert.equal(await status(apps[0]._id), 'offer_issued');
        assert.equal(await status(apps[2]._id), 'waitlisted');
        const seats = (await H.api('GET', `/admission/admin/rounds/${round._id}/seats`, { token: s.adminToken })).body.data.find((x) => x.class === s.classes[0]._id);
        assert.equal(seats.available, 0);
        const view = await H.api('GET', `/admission/portal/applications/${apps[2]._id}/lists`, { token: guests[2].token });
        assert.equal(view.body.data[0].mine.decision, 'waitlisted');
        assert.equal(view.body.data[0].mine.waitPosition, 1);
        assert.ok(view.body.data[0].lines.every((l) => l.name === null), 'names are not published unless the school chose to');
        const again = await H.api('POST', `/admission/admin/lists/${list._id}/publish`, { token: s.adminToken, body: {} });
        assert.equal(again.status, 409, 'a list is published once');
        const mails = await H.q(`SELECT "event", COUNT(*)::int AS n FROM "admissionemaillogs" WHERE "school" = $1 AND "event" IN ('first_list_selection', 'waiting_list') GROUP BY 1`, [s.id]);
        await new Promise((r) => setTimeout(r, 300));
        const mails2 = await H.q(`SELECT "event", COUNT(*)::int AS n FROM "admissionemaillogs" WHERE "school" = $1 AND "event" IN ('first_list_selection', 'waiting_list') GROUP BY 1`, [s.id]);
        const counts = Object.fromEntries((mails2.length ? mails2 : mails).map((m) => [m.event, m.n]));
        assert.equal(counts.first_list_selection, 2);
        assert.equal(counts.waiting_list, 2);
    });

    it('refuses an offer when the class has no seat left', async () => {
        const r = await H.api('POST', `/admission/admin/applications/${apps[3]._id}/offer`, { token: s.adminToken, body: {} });
        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'NO_SEAT');
    });

    it('moves the waiting list up when an offer is declined, and again when one lapses', async () => {
        const acc = await H.api('POST', `/admission/portal/applications/${apps[0]._id}/offer/respond`, { token: guests[0].token, body: { accept: true } });
        assert.equal(acc.status, 200);
        assert.equal(await status(apps[0]._id), 'payment_pending', 'an admission fee is due');
        const noWhy = await H.api('POST', `/admission/portal/applications/${apps[1]._id}/offer/respond`, { token: guests[1].token, body: { accept: false } });
        assert.equal(noWhy.status, 400);
        const dec = await H.api('POST', `/admission/portal/applications/${apps[1]._id}/offer/respond`, { token: guests[1].token, body: { accept: false, note: 'Moving cities' } });
        assert.equal(dec.status, 200);
        assert.equal(await status(apps[1]._id), 'declined');
        assert.equal(await status(apps[2]._id), 'offer_issued', 'the first on the waiting list was offered the seat');
        // Nobody answers the third offer in time.
        await H.q(`UPDATE "admissionoffers" SET "respondBy" = now() - interval '1 hour' WHERE "application" = $1`, [apps[2]._id]);
        const late = await H.api('POST', `/admission/portal/applications/${apps[2]._id}/offer/respond`, { token: guests[2].token, body: { accept: true } });
        assert.equal(late.status, 409);
        const selection = require('../../services/admission/selection');
        assert.ok(await selection.expireDue() >= 1);
        assert.equal(await status(apps[2]._id), 'offer_expired');
        assert.equal(await status(apps[3]._id), 'offer_issued', 'the lapsed seat went to the next in line');
    });

    it('takes payment, refuses confirmation until ready, then confirms', async () => {
        const blocked = await H.api('POST', `/admission/admin/applications/${apps[3]._id}/confirm`, { token: s.adminToken });
        assert.equal(blocked.status, 409, 'not accepted yet');
        const early = await H.api('POST', `/admission/admin/applications/${apps[0]._id}/confirm`, { token: s.adminToken });
        assert.equal(early.status, 409, 'admission fee not paid');
        assert.ok(early.body.errors.some((e) => /fee/i.test(e.message)));
        const online = await H.api('POST', `/admission/portal/applications/${apps[0]._id}/pay`, { token: guests[0].token, body: { kind: 'admission_fee' } });
        assert.equal(online.status, 409);
        assert.equal(online.body.code, 'GATEWAY_UNAVAILABLE', 'no gateway configured — nothing pretends to take money');
        const over = await H.api('POST', `/admission/admin/applications/${apps[0]._id}/payments`, { token: s.adminToken, body: { kind: 'admission_fee', amount: 5000, mode: 'cash' } });
        assert.equal(over.status, 400, 'more than is due');
        const cheque = await H.api('POST', `/admission/admin/applications/${apps[0]._id}/payments`, { token: s.adminToken, body: { kind: 'admission_fee', amount: 1000, mode: 'cheque' } });
        assert.equal(cheque.status, 400, 'a cheque needs its number');
        const paid = await H.api('POST', `/admission/admin/applications/${apps[0]._id}/payments`, { token: s.adminToken, body: { kind: 'admission_fee', amount: 1000, mode: 'cheque', reference: '000123' } });
        assert.equal(paid.status, 201);
        const ok = await H.api('POST', `/admission/admin/applications/${apps[0]._id}/confirm`, { token: s.adminToken });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(await status(apps[0]._id), 'confirmed');
    });

    it('enrols: student, parent, section, fees and transport in one go — and only once', async () => {
        const pre = await H.api('GET', `/admission/admin/applications/${apps[0]._id}/conversion`, { token: s.adminToken });
        assert.equal(pre.status, 200);
        assert.equal(pre.body.data.ready, true, JSON.stringify(pre.body.data.blockers));
        const studentEmail = `aarav-${H.rand()}@kids.test`;
        const parentEmail = `rao-${H.rand()}@family.test`;
        const body = { section: s.sections.A._id, studentEmail, parent: { mode: 'new', relation: 'Father', name: 'Amit Sharma', email: parentEmail, phone: '9876543210' } };
        const [one, two] = await Promise.all([
            H.api('POST', `/admission/admin/applications/${apps[0]._id}/convert`, { token: s.adminToken, body }),
            H.api('POST', `/admission/admin/applications/${apps[0]._id}/convert`, { token: s.adminToken, body }),
        ]);
        assert.equal(one.status, 200, JSON.stringify(one.body));
        assert.equal(two.status, 200, JSON.stringify(two.body));
        assert.equal([one.body.data.replay, two.body.data.replay].filter(Boolean).length, 1, 'the second request replays the first');
        const students = await H.q(`SELECT "_id" FROM "users" WHERE "email" = $1 AND "role" = 'student'`, [studentEmail]);
        assert.equal(students.length, 1, 'one student, however many clicks');
        const sp = (await H.q(`SELECT * FROM "studentprofiles" WHERE "user" = $1`, [students[0]._id]))[0];
        assert.equal(sp.currentSection, s.sections.A._id);
        assert.match(sp.admissionNumber, /^AT/);
        const parent = (await H.q(`SELECT u."_id", pp."children" FROM "users" u JOIN "parentprofiles" pp ON pp."user" = u."_id" WHERE u."email" = $1 AND u."role" = 'parent'`, [parentEmail]))[0];
        assert.ok(parent.children.includes(students[0]._id));
        const sec = (await H.q(`SELECT "enrolledStudents", "currentCount" FROM "classsections" WHERE "_id" = $1`, [s.sections.A._id]))[0];
        assert.ok(sec.enrolledStudents.includes(students[0]._id));
        assert.equal(sec.currentCount, 1);
        const fee = await H.q(`SELECT "feeStructure" FROM "studentfeeassignments" WHERE "student" = $1`, [students[0]._id]);
        assert.equal(fee.length, 1, 'placed on the class fee structure');
        const tr = await H.q(`SELECT "requestType", "status" FROM "transportrequests" WHERE "student" = $1`, [students[0]._id]);
        assert.equal(tr[0]?.requestType, 'new_transport', 'the transport need was passed on');
        assert.equal(await status(apps[0]._id), 'enrolled');
        const app = (await H.q(`SELECT "studentUser", "admissionNumber", "conversion" FROM "admissionapplications" WHERE "_id" = $1`, [apps[0]._id]))[0];
        assert.equal(app.studentUser, students[0]._id);
        assert.equal(app.conversion.status, 'completed');
        // The applicant's history stays.
        const history = await H.api('GET', `/admission/portal/applications/${apps[0]._id}`, { token: guests[0].token });
        assert.equal(history.status, 200);
        assert.equal(history.body.data.application.admissionNumber, app.admissionNumber);
    });

    it('links an existing parent instead of making another, and refuses an address already in use', async () => {
        // A sibling application in Class 2, offered, accepted, paid and confirmed by the office.
        const g = await H.registerGuest(s, portal.slug);
        const a = await H.submittedApplication(s, g, round, { classIdx: 1, answers: { studentName: 'Esha Rao' } });
        await H.verifyAllDocs(s, a._id);
        await H.api('POST', `/admission/admin/applications/${a._id}/offer`, { token: s.adminToken, body: {} });
        await H.api('POST', `/admission/admin/applications/${a._id}/offer/respond`, { token: s.adminToken, body: { accept: true, note: 'Accepted on the phone' } });
        await H.api('POST', `/admission/admin/applications/${a._id}/payments`, { token: s.adminToken, body: { kind: 'admission_fee', amount: 1000, mode: 'cash' } });
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/confirm`, { token: s.adminToken })).status, 200);
        const parentRow = (await H.q(`SELECT u."_id" FROM "users" u WHERE u."school" = $1 AND u."role" = 'parent' LIMIT 1`, [s.id]))[0];
        const taken = await H.q(`SELECT "email" FROM "users" WHERE "school" = $1 AND "role" = 'student' LIMIT 1`, [s.id]);
        const dup = await H.api('POST', `/admission/admin/applications/${a._id}/convert`, { token: s.adminToken, body: { studentEmail: taken[0].email, parent: { mode: 'existing', userId: parentRow._id } } });
        assert.equal(dup.status, 400, 'a student\'s address cannot be reused');
        const ok = await H.api('POST', `/admission/admin/applications/${a._id}/convert`, { token: s.adminToken, body: { studentEmail: `esha-${H.rand()}@kids.test`, parent: { mode: 'existing', userId: parentRow._id } } });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        const parents = await H.q(`SELECT COUNT(*)::int AS n FROM "users" WHERE "school" = $1 AND "role" = 'parent'`, [s.id]);
        assert.equal(parents[0].n, 1, 'no second parent account');
        const kids = (await H.q(`SELECT "children" FROM "parentprofiles" WHERE "user" = $1`, [parentRow._id]))[0].children;
        assert.equal(kids.length, 2, 'both children on one parent');
    });

    it('rolls a failed conversion back completely', async () => {
        const prep = async (name) => {
            const g = await H.registerGuest(s, portal.slug);
            const a = await H.submittedApplication(s, g, round, { classIdx: 1, answers: { studentName: name } });
            await H.verifyAllDocs(s, a._id);
            await H.api('POST', `/admission/admin/applications/${a._id}/offer`, { token: s.adminToken, body: {} });
            await H.api('POST', `/admission/admin/applications/${a._id}/offer/respond`, { token: s.adminToken, body: { accept: true, note: 'By phone' } });
            await H.api('POST', `/admission/admin/applications/${a._id}/payments`, { token: s.adminToken, body: { kind: 'admission_fee', amount: 1000, mode: 'cash' } });
            await H.api('POST', `/admission/admin/applications/${a._id}/confirm`, { token: s.adminToken });
            return a;
        };
        const [x, y] = [await prep('Farah Khan'), await prep('Gautam Roy')];
        // Two conversions race for one student address: the loser must leave nothing behind.
        const shared = `twin-${H.rand()}@kids.test`;
        const px = `px-${H.rand()}@family.test`; const py = `py-${H.rand()}@family.test`;
        const [rx, ry] = await Promise.all([
            H.api('POST', `/admission/admin/applications/${x._id}/convert`, { token: s.adminToken, body: { studentEmail: shared, parent: { mode: 'new', relation: 'Mother', name: 'Mother One', email: px } } }),
            H.api('POST', `/admission/admin/applications/${y._id}/convert`, { token: s.adminToken, body: { studentEmail: shared, parent: { mode: 'new', relation: 'Mother', name: 'Mother Two', email: py } } }),
        ]);
        const statuses = [rx.status, ry.status].sort();
        assert.ok(statuses[0] === 200 && [400, 409].includes(statuses[1]), `one wins: ${rx.status} ${ry.status} ${JSON.stringify(ry.body)}`);
        const loser = rx.status === 200 ? y : x;
        const loserParent = rx.status === 200 ? py : px;
        assert.equal(await status(loser._id), 'confirmed', 'the loser is still confirmed, not half-enrolled');
        assert.equal((await H.q(`SELECT COUNT(*)::int AS n FROM "users" WHERE "email" = $1`, [loserParent]))[0].n, 0, 'its parent account was rolled back');
        assert.equal((await H.q(`SELECT COUNT(*)::int AS n FROM "users" WHERE "email" = $1 AND "role" = 'student'`, [shared]))[0].n, 1);
        const conv = (await H.q(`SELECT "conversion", "studentUser" FROM "admissionapplications" WHERE "_id" = $1`, [loser._id]))[0];
        assert.equal(conv.studentUser, null);
        assert.equal(conv.conversion, null);
    });

    it('undoes every write when a step inside the conversion fails', async () => {
        const fs = require('fs');
        const path = require('path');
        const g = await H.registerGuest(s, portal.slug);
        const a = await H.submittedApplication(s, g, round, { classIdx: 1, answers: { studentName: 'Hari Om' } });
        await H.verifyAllDocs(s, a._id);
        await H.api('POST', `/admission/admin/applications/${a._id}/offer`, { token: s.adminToken, body: {} });
        await H.api('POST', `/admission/admin/applications/${a._id}/offer/respond`, { token: s.adminToken, body: { accept: true, note: 'By phone' } });
        await H.api('POST', `/admission/admin/applications/${a._id}/payments`, { token: s.adminToken, body: { kind: 'admission_fee', amount: 1000, mode: 'cash' } });
        assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/confirm`, { token: s.adminToken })).status, 200);
        const docsDir = path.join(__dirname, '..', '..', 'uploads', 'student-docs');
        const filesBefore = fs.existsSync(docsDir) ? fs.readdirSync(docsDir).length : 0;
        // Fail the very last write of the transaction — after the student, the parent,
        // the records and the roster have all been inserted.
        const apps = require('../../services/admission/applications');
        const conversion = require('../../services/admission/conversion');
        const realMove = apps.move;
        apps.move = async (req, app, to, opts) => {
            if (to === 'enrolled') throw new Error('Simulated failure after the inserts');
            return realMove(req, app, to, opts);
        };
        const studentEmail = `rollback-${H.rand()}@kids.test`;
        const parentEmail = `rollback-parent-${H.rand()}@family.test`;
        const row = (await H.q(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [a._id]))[0];
        const req = { schoolId: s.id, userId: s.admin._id, userRole: 'school_admin', user: { _id: s.admin._id, name: 'Office Admin' } };
        try {
            await assert.rejects(conversion.convert(req, row, { studentEmail, parent: { mode: 'new', relation: 'Father', name: 'Rollback Parent', email: parentEmail } }), /Simulated failure/);
        } finally {
            apps.move = realMove;
        }
        await new Promise((r) => setTimeout(r, 200));
        assert.equal((await H.q(`SELECT COUNT(*)::int AS n FROM "users" WHERE "email" = ANY($1::text[])`, [[studentEmail, parentEmail]]))[0].n, 0, 'no account survives');
        assert.equal((await H.q(`SELECT COUNT(*)::int AS n FROM "studentprofiles" sp JOIN "users" u ON u."_id" = sp."user" WHERE u."email" = $1`, [studentEmail]))[0].n, 0);
        assert.equal(await status(a._id), 'confirmed');
        const app = (await H.q(`SELECT "conversion", "studentUser", "admissionNumber" FROM "admissionapplications" WHERE "_id" = $1`, [a._id]))[0];
        assert.equal(app.studentUser, null);
        assert.equal(app.admissionNumber, '');
        const filesAfter = fs.existsSync(docsDir) ? fs.readdirSync(docsDir).length : 0;
        assert.equal(filesAfter, filesBefore, 'documents copied for it were removed');
        // And it still converts properly afterwards.
        const ok = await H.api('POST', `/admission/admin/applications/${a._id}/convert`, { token: s.adminToken, body: { studentEmail, parent: { mode: 'new', relation: 'Father', name: 'Rollback Parent', email: parentEmail } } });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.data.conversion.documents.length >= 1, true, 'verified documents copied into the student record');
    });

    it('gives the last seat to exactly one of two offers made at the same moment', async () => {
        await H.api('PUT', `/admission/admin/rounds/${round._id}`, { token: s.adminToken, body: { classes: [{ class: s.classes[0]._id, seats: 2 }, { class: s.classes[1]._id, seats: 5 }] } });
        const seats = (await H.api('GET', `/admission/admin/rounds/${round._id}/seats`, { token: s.adminToken })).body.data.find((x) => x.class === s.classes[1]._id);
        // Fill Class 2 up to one free seat with throwaway applications.
        const need = Math.max(0, seats.available - 1);
        for (let i = 0; i < need; i++) {
            const g = await H.registerGuest(s, portal.slug);
            const a = await H.submittedApplication(s, g, round, { classIdx: 1, answers: { studentName: 'Filler Child' } });
            await H.verifyAllDocs(s, a._id);
            assert.equal((await H.api('POST', `/admission/admin/applications/${a._id}/offer`, { token: s.adminToken, body: {} })).status, 201);
        }
        const contenders = [];
        for (let i = 0; i < 2; i++) {
            const g = await H.registerGuest(s, portal.slug);
            const a = await H.submittedApplication(s, g, round, { classIdx: 1, answers: { studentName: 'Close Call' } });
            await H.verifyAllDocs(s, a._id);
            contenders.push(a);
        }
        const [r1, r2] = await Promise.all(contenders.map((a) => H.api('POST', `/admission/admin/applications/${a._id}/offer`, { token: s.adminToken, body: {} })));
        assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
        const after = (await H.api('GET', `/admission/admin/rounds/${round._id}/seats`, { token: s.adminToken })).body.data.find((x) => x.class === s.classes[1]._id);
        assert.equal(after.available, 0);
        assert.equal(after.taken, after.capacity);
    });
});
