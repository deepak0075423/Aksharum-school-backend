'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Times families book themselves: an interview time from those the office
 * published — room counted under a lock, changes held to the school's rules —
 * and campus visits, with their own room, cancellations and reminders.
 */
const HOUR = 3600e3;
const at = (h) => new Date(Date.now() + h * HOUR);

describe('admission — interview times and campus visits families book', () => {
    let s; let portal; let round; let exam; const g = []; const app = [];
    const slotsOf = (i) => H.api('GET', `/admission/portal/applications/${app[i]._id}/exams/${exam._id}/slots`, { token: g[i].token });
    const choose = (i, slotId) => H.api('POST', `/admission/portal/applications/${app[i]._id}/exams/${exam._id}/slot`, { token: g[i].token, body: { slotId } });
    const candidate = async (i) => (await H.q(`SELECT * FROM "admissioncandidates" WHERE "exam" = $1 AND "application" = $2`, [exam._id, app[i]._id]))[0];

    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Booking');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 10 });
        const names = ['Aadi Kapoor', 'Bela Sinha', 'Chirag Patil', 'Dia Rawat', 'Eshan Gill'];
        for (let i = 0; i < 5; i++) {
            g[i] = await H.registerGuest(s, portal.slug);
            app[i] = await H.submittedApplication(s, g[i], round, { answers: { studentName: names[i], studentDob: `2021-0${i + 1}-1${i}` } });
            await H.verifyAllDocs(s, app[i]._id);
        }
        exam = (await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: {
            round: round._id, name: 'Parent Interaction', mode: 'interview', classes: [s.classes[0]._id], startsAt: at(48),
            subjects: [{ name: 'Interaction', maxMarks: 10 }],
            booking: {
                enabled: true, changeUntilHours: 24, maxChanges: 1,
                slots: [
                    { id: 'aaaaaa01', startsAt: at(72), capacity: 1, room: 'Room 1' },
                    { id: 'bbbbbb02', startsAt: at(96), capacity: 2, room: 'Room 2' },
                    { id: 'cccccc03', startsAt: at(2), capacity: 5 },
                    { id: 'dddddd04', startsAt: at(120), capacity: 3 },
                    { id: 'eeeeee05', startsAt: at(144), capacity: 1 },
                ],
            },
        } })).body.data;
        assert.ok(exam?._id, 'exam created');
        assert.equal((await H.api('POST', `/admission/admin/exams/${exam._id}/schedule`, { token: s.adminToken })).status, 200);
        assert.equal((await H.api('POST', `/admission/admin/exams/${exam._id}/candidates`, { token: s.adminToken, body: { applicationIds: 'all' } })).status, 200);
    });
    after(() => H.finish());

    it('asks each family to choose, and shows only times far enough ahead', async () => {
        await new Promise((r) => setTimeout(r, 400));
        const asked = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionemaillogs" WHERE "school" = $1 AND "event" = 'slot_choose'`, [s.id]);
        assert.equal(asked[0].n, 5);
        const v = (await slotsOf(0)).body.data;
        assert.equal(v.canChoose, true);
        assert.deepEqual(v.slots.map((x) => x.id), ['aaaaaa01', 'bbbbbb02', 'dddddd04', 'eeeeee05'], 'not the one two hours away');
        assert.equal((await H.api('POST', '/admission/admin/exams', { token: s.adminToken, body: { round: round._id, name: 'Online test', mode: 'online', classes: [s.classes[0]._id], startsAt: at(48), endsAt: at(50), booking: { enabled: true, slots: [{ startsAt: at(49) }] } } })).status, 400, 'an online exam has a window, not times');
    });

    it('books a time, keeps it to its room, and refuses one too close', async () => {
        const r = await choose(0, 'aaaaaa01');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const c0 = await candidate(0);
        assert.deepEqual([c0.slotId, c0.room, new Date(c0.slot).getTime() === new Date(exam.booking.slots.find((x) => x.id === 'aaaaaa01').startsAt).getTime()], ['aaaaaa01', 'Room 1', true]);
        assert.equal((await choose(1, 'aaaaaa01')).body.code, 'SLOT_FULL');
        assert.equal((await choose(1, 'cccccc03')).body.code, 'TOO_LATE');
        assert.equal((await choose(1, 'nope')).status, 404);
        await new Promise((r) => setTimeout(r, 300));
        const mail = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionemaillogs" WHERE "application" = $1 AND "event" = 'slot_booked'`, [app[0]._id]);
        assert.equal(mail[0].n, 1);
    });

    it('never gives the last place twice, however close together two families ask', async () => {
        const [a, b] = await Promise.all([choose(1, 'eeeeee05'), choose(2, 'eeeeee05')]);
        assert.deepEqual([a.status, b.status].sort(), [200, 409]);
        const [n] = await H.q(`SELECT COUNT(*)::int AS n FROM "admissioncandidates" WHERE "exam" = $1 AND "slotId" = 'eeeeee05'`, [exam._id]);
        assert.equal(n.n, 1);
    });

    it('lets a family move its time as often as the school allows', async () => {
        const i = (await candidate(1)).slotId ? 2 : 1;   // whoever lost the race
        assert.equal((await choose(i, 'bbbbbb02')).status, 200, 'first choice');
        assert.equal((await choose(i, 'dddddd04')).status, 200, 'one change');
        const c = await candidate(i);
        assert.deepEqual([c.slotId, c.slotChanges], ['dddddd04', 1]);
        assert.equal((await choose(i, 'bbbbbb02')).body.code, 'NO_CHANGES_LEFT');
        assert.equal((await slotsOf(i)).body.data.canChoose, false);
    });

    it('will not let the office drop or shrink a booked time — but lets it place someone past a full one on purpose', async () => {
        const cur = (await H.api('GET', `/admission/admin/exams/${exam._id}`, { token: s.adminToken })).body.data;
        const e = cur.exam || cur;
        const without = e.booking.slots.filter((x) => x.id !== 'aaaaaa01');
        const drop = await H.api('PUT', `/admission/admin/exams/${exam._id}`, { token: s.adminToken, body: { booking: { ...e.booking, slots: without } } });
        assert.equal(drop.status, 409);
        assert.equal(drop.body.code, 'SLOT_BOOKED');
        const ok = await H.api('PUT', `/admission/admin/exams/${exam._id}`, { token: s.adminToken, body: { booking: { ...e.booking, slots: [...e.booking.slots, { startsAt: at(168), capacity: 4, room: 'Hall' }] } } });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        const office = (await H.api('GET', `/admission/admin/exams/${exam._id}/slots`, { token: s.adminToken })).body.data;
        assert.equal(office.slots.length, 6);
        assert.equal(office.slots.find((x) => x.id === 'aaaaaa01').taken, 1);
        const [c3] = await H.q(`SELECT "_id" FROM "admissioncandidates" WHERE "exam" = $1 AND "application" = $2`, [exam._id, app[3]._id]);
        const put = (body) => H.api('PATCH', `/admission/admin/exams/${exam._id}/candidates/${c3._id}`, { token: s.adminToken, body });
        assert.equal((await put({ slotId: 'aaaaaa01' })).body.code, 'SLOT_FULL');
        assert.equal((await put({ slotId: 'aaaaaa01', force: true })).status, 200);
        assert.equal((await candidate(3)).slotId, 'aaaaaa01');
    });

    it('gives the family a calendar file for its time', async () => {
        const r = await fetch(`${H.BASE}/api/admission/portal/applications/${app[0]._id}/exams/${exam._id}/calendar.ics`, { headers: { Authorization: `Bearer ${g[0].token}` } });
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type'), /text\/calendar/);
        const text = await r.text();
        const start = new Date(exam.booking.slots.find((x) => x.id === 'aaaaaa01').startsAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        assert.ok(text.includes(`DTSTART:${start}`), text);
        assert.ok(text.includes('SUMMARY:Parent Interaction'));
        const other = await fetch(`${H.BASE}/api/admission/portal/applications/${app[0]._id}/exams/${exam._id}/calendar.ics`, { headers: { Authorization: `Bearer ${g[1].token}` } });
        assert.equal(other.status, 404, 'not another family\'s');
    });

    describe('campus visits', () => {
        let v1; let vSoon; let vOne;
        const open = (body) => H.api('POST', '/admission/admin/visits', { token: s.adminToken, body });
        const book = (i, slotId, body = { people: 1 }) => H.api('POST', `/admission/portal/visits/${slotId}/book`, { token: g[i].token, body });

        before(async () => {
            assert.equal((await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { visits: { enabled: true, maxPeople: 3, cancelUntilHours: 2, reminderHours: 48 } } })).status, 200);
        });

        it('opens times only ahead, and shows anyone what is left — never who booked', async () => {
            assert.equal((await open({ starts: [at(-1)] })).status, 400, 'not in the past');
            assert.equal((await open({ starts: [] })).status, 400);
            const r = await open({ starts: [at(50), at(1), at(80)], capacity: 4, title: 'Campus tour', location: 'Main gate' });
            assert.equal(r.status, 201, JSON.stringify(r.body));
            [v1, vSoon] = [r.body.data.find((x) => +new Date(x.startsAt) > Date.now() + 49 * HOUR && +new Date(x.startsAt) < Date.now() + 51 * HOUR), r.body.data.find((x) => +new Date(x.startsAt) < Date.now() + 2 * HOUR)];
            vOne = (await open({ starts: [at(30)], capacity: 1 })).body.data[0];
            const pub = await H.api('GET', `/admission/public/portals/${portal.slug}/visits`);
            assert.equal(pub.status, 200);
            assert.equal(pub.body.data.slots.length, 4);
            assert.deepEqual(pub.body.data.mine, []);
        });

        it('books places up to what is left, once per family', async () => {
            assert.equal((await book(0, v1._id, { people: 4 })).status, 400, 'more than the school allows per booking');
            assert.equal((await book(0, v1._id, { people: 3 })).status, 201);
            assert.equal((await book(0, v1._id, { people: 1 })).body.code, 'ALREADY_BOOKED');
            const full = await book(1, v1._id, { people: 2 });
            assert.equal(full.body.code, 'VISIT_FULL');
            assert.match(full.body.message, /Only 1 place left/);
            assert.equal((await book(1, v1._id, { people: 1 })).status, 201);
            const mine = (await H.api('GET', '/admission/portal/visits', { token: g[0].token })).body.data.mine;
            assert.equal(mine.length, 1);
            assert.equal(mine[0].canCancel, true);
            await new Promise((r) => setTimeout(r, 300));
            const mail = await H.q(`SELECT COUNT(*)::int AS n FROM "admissionemaillogs" WHERE "school" = $1 AND "event" = 'visit_booked'`, [s.id]);
            assert.equal(mail[0].n, 2);
        });

        it('gives the last place to one family only', async () => {
            const [a, b] = await Promise.all([book(2, vOne._id), book(3, vOne._id)]);
            assert.deepEqual([a.status, b.status].sort(), [201, 409]);
        });

        it('lets a family cancel — not at the last minute — and the office not shrink below what is booked', async () => {
            const soon = await book(4, vSoon._id);
            assert.equal(soon.status, 201);
            assert.equal((await H.api('POST', `/admission/portal/visit-bookings/${soon.body.data._id}/cancel`, { token: g[4].token })).body.code, 'TOO_LATE');
            const mine = (await H.api('GET', '/admission/portal/visits', { token: g[1].token })).body.data.mine[0];
            assert.equal((await H.api('POST', `/admission/portal/visit-bookings/${mine._id}/cancel`, { token: g[0].token })).status, 404, 'not someone else\'s');
            assert.equal((await H.api('POST', `/admission/portal/visit-bookings/${mine._id}/cancel`, { token: g[1].token })).status, 200);
            assert.equal((await H.api('PATCH', `/admission/admin/visits/${v1._id}`, { token: s.adminToken, body: { capacity: 2 } })).status, 409, '3 are booked');
            assert.equal((await H.api('PATCH', `/admission/admin/visits/${v1._id}`, { token: s.adminToken, body: { capacity: 3 } })).status, 200);
        });

        it('reminds each family once, gives a calendar file, and records who came', async () => {
            await H.q(`UPDATE "admissionvisitbookings" SET "createdAt" = now() - interval '2 hours' WHERE "school" = $1`, [s.id]);
            const settings = await require('../../services/admission/settings').getSettings(s.id, { fresh: true });
            const visits = require('../../services/admission/visits');
            const first = await visits.reminders(s.id, settings);
            assert.ok(first >= 2, `reminded ${first}`);
            assert.equal(await visits.reminders(s.id, settings), 0, 'once');
            const mine = (await H.api('GET', '/admission/portal/visits', { token: g[0].token })).body.data.mine[0];
            const cal = await fetch(`${H.BASE}/api/admission/portal/visit-bookings/${mine._id}/calendar.ics`, { headers: { Authorization: `Bearer ${g[0].token}` } });
            assert.equal(cal.status, 200);
            assert.match(await cal.text(), /SUMMARY:Campus tour/);
            const list = (await H.api('GET', `/admission/admin/visits/${v1._id}/bookings`, { token: s.adminToken })).body.data.bookings;
            const mark = await H.api('PATCH', `/admission/admin/visit-bookings/${list[0]._id}`, { token: s.adminToken, body: { status: 'attended' } });
            assert.equal(mark.status, 200);
        });

        it('cancels a time for everyone booked on it, telling each why', async () => {
            const r = await H.api('POST', `/admission/admin/visits/${v1._id}/cancel`, { token: s.adminToken, body: { reason: 'The school is closed for elections' } });
            assert.equal(r.status, 200);
            assert.equal(r.body.data.cancelled, 0, 'the one who came is not cancelled; the other already cancelled');
            const r2 = await H.api('POST', `/admission/admin/visits/${vOne._id}/cancel`, { token: s.adminToken, body: { reason: 'Heavy rain warning' } });
            assert.equal(r2.body.data.cancelled, 1);
            await new Promise((x) => setTimeout(x, 300));
            const mail = await H.q(`SELECT "body" FROM "admissionemaillogs" WHERE "school" = $1 AND "event" = 'visit_cancelled'`, [s.id]);
            assert.equal(mail.length, 1);
            assert.match(mail[0].body, /Heavy rain warning/);
        });
    });
});
