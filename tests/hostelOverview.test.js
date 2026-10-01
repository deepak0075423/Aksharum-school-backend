'use strict';
/**
 * The Hostel dashboard (GET /hostel/admin/overview).
 *
 * What is worth guarding is that its numbers mean what the cards say:
 *   · the four bed states add up to "Total Beds", and a bed the allocation
 *     engine would refuse is never counted as available;
 *   · attendance counts students, not roll-call records;
 *   · billed follows the billing period and collected the payment date;
 *   · a warden sees their own hostels and nothing else.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const Hostel = require('../models/Hostel');
const HostelBuilding = require('../models/HostelBuilding');
const HostelFloor = require('../models/HostelFloor');
const HostelRoom = require('../models/HostelRoom');
const HostelBed = require('../models/HostelBed');
const HostelAllocation = require('../models/HostelAllocation');
const HostelAttendance = require('../models/HostelAttendance');
const HostelFeeInvoice = require('../models/HostelFeeInvoice');
const HostelIncident = require('../models/HostelIncident');
const HostelAuditLog = require('../models/HostelAuditLog');
const User = require('../models/User');
const ha = require('../controllers/hostelAdmin.controller');
const { feeWindow } = require('../services/hostelOverview');
const { dayRange } = require('../services/hostelService');
const { makeSchool, teardown } = require('./helpers');
const { query } = require('../db/pool');

let S;
const H = {};          // hostels by letter
const uid = () => crypto.randomUUID();

/** A month offset from this one, as { year, month (1-12) } and a date inside it. */
function monthAgo(n) {
    const d = new Date();
    const m = new Date(d.getFullYear(), d.getMonth() - n, 10, 12);
    return { year: m.getFullYear(), month: m.getMonth() + 1, at: m };
}

/** One hostel with one building, one floor and the given rooms and beds. */
async function hostel(letter, { status = 'active', isActive = true, rooms = [] } = {}) {
    const h = await Hostel.create({ school: S.id, name: `ZZ Hostel ${letter}`, code: `ZZ${letter}`, status, isActive });
    const b = await HostelBuilding.create({ school: S.id, hostel: h._id, name: `Block ${letter}`, code: `B${letter}` });
    const f = await HostelFloor.create({ school: S.id, hostel: h._id, building: b._id, name: 'Ground', floorNumber: 0 });
    const out = { h, b, f, rooms: [] };
    for (const [i, r] of rooms.entries()) {
        const room = await HostelRoom.create({
            school: S.id, hostel: h._id, building: b._id, floor: f._id,
            roomNumber: `${letter}-10${i}`, code: `R${letter}${i}`, capacity: r.beds.length,
            status: r.status || 'available', isActive: r.isActive ?? true,
        });
        const beds = [];
        for (const [j, bed] of r.beds.entries()) {
            const [state, active = true] = Array.isArray(bed) ? bed : [bed];
            beds.push(await HostelBed.create({
                school: S.id, hostel: h._id, building: b._id, floor: f._id, room: room._id,
                bedNumber: String(j + 1), code: `BD${letter}${i}${j}`, status: state, isActive: active,
            }));
        }
        out.rooms.push({ room, beds });
    }
    return out;
}

/** Call the handler as `who` and hand back what it would have sent. */
function overview(query = {}, who = S.ctx) {
    return new Promise((resolve, reject) => {
        const req = { ...who, query, params: {}, body: {}, headers: {}, socket: {} };
        const res = {
            status() { return this; },
            json(payload) { return payload.success ? resolve(payload.data) : reject(new Error(payload.message)); },
        };
        ha.overview(req, res);
    });
}

let warden;

before(async () => {
    S = await makeSchool();
    // A: a working hostel whose rooms cover every way a bed can be out of use.
    H.A = await hostel('A', { rooms: [
        { beds: ['occupied', 'available', 'reserved', 'inactive', ['available', false]] },
        { status: 'maintenance', beds: ['available', 'maintenance'] },
        { status: 'inactive', beds: ['available'] },
    ] });
    // B: a second, ordinary hostel.
    H.B = await hostel('B', { rooms: [{ beds: ['available', 'occupied'] }] });
    // C: still being built — its bed exists, but nobody can be given it.
    H.C = await hostel('C', { status: 'under_construction', rooms: [{ beds: ['available'] }] });
    // D: closed down — not on the dashboard at all.
    H.D = await hostel('D', { isActive: false, rooms: [{ beds: ['available'] }] });

    const year = uid();
    const alloc = (h, presence, status = 'active') => HostelAllocation.create({
        school: S.id, student: uid(), academicYear: year, hostel: h.h._id, building: h.b._id,
        floor: h.f._id, room: h.rooms[0].room._id, bed: h.rooms[0].beds[0]._id, status, presence,
    });
    const [a1, a2, a3] = await Promise.all([alloc(H.A, 'in'), alloc(H.A, 'out'), alloc(H.A, 'on_leave'), alloc(H.B, 'in')]);
    await alloc(H.A, 'in', 'vacated');

    // Today: a1 present in the morning and absent at night → absent.
    // a2 late at night but typed in BEFORE the morning roll → still late,
    // because the night roll call is the later one in the day.
    // a3 present once. Yesterday: a1 present.
    const today = dayRange().start;
    const yesterday = dayRange(new Date(Date.now() - 86400000)).start;
    const mark = (a, date, session, status, markedAt = new Date()) => HostelAttendance.create({
        school: S.id, hostel: a.hostel, student: a.student, allocation: a._id, date, session, status, markedAt,
    });
    await mark(a1, today, 'morning', 'present');
    await mark(a1, today, 'night', 'absent');
    await mark(a2, today, 'night', 'late', new Date(Date.now() - 3600000));
    await mark(a2, today, 'morning', 'present', new Date());
    await mark(a3, today, 'morning', 'present');
    await mark(a1, yesterday, 'morning', 'present');

    // Fees. Every invoice is raised TODAY, which is what a bulk run does.
    const cur = monthAgo(0); const prev = monthAgo(1); const prev2 = monthAgo(2);
    const invoice = (h, extra) => HostelFeeInvoice.create({ school: S.id, student: uid(), hostel: h.h._id, ...extra });
    await invoice(H.A, { period: { year: cur.year, month: cur.month }, amount: 1000, payments: [{ amount: 600, paidAt: new Date() }] });
    // Billed two months back, paid last month.
    await invoice(H.A, { period: { year: prev2.year, month: prev2.month }, amount: 500, payments: [{ amount: 500, paidAt: prev.at }] });
    // No billing period: follows its due date.
    await invoice(H.B, { feeType: 'annual', amount: 300, dueDate: prev.at });
    // Cancelled: counts for nothing, even though it was paid.
    await invoice(H.A, { period: { year: cur.year, month: cur.month }, amount: 9999, status: 'cancelled', payments: [{ amount: 9999, paidAt: new Date() }] });

    // A payment somebody edited by hand into nonsense must not break the page.
    // Written straight to the table: the model would never let it through.
    const odd = await invoice(H.B, { period: { year: cur.year, month: cur.month }, amount: 50 });
    await query(`UPDATE "${HostelFeeInvoice.tableName}" SET "payments" = $1::jsonb WHERE "_id" = $2`,
        [JSON.stringify([{ amount: 'lots', paidAt: 'last tuesday' }]), String(odd._id)]);

    // Five incidents, newest last; one in B.
    for (let i = 0; i < 5; i++) {
        await HostelIncident.create({
            school: S.id, hostel: (i === 4 ? H.B : H.A).h._id, description: `ZZ incident ${i}`,
            incidentType: 'other', severity: 'low', date: new Date(Date.now() - (5 - i) * 86400000),
        });
    }
    await HostelAuditLog.create({ school: S.id, hostel: H.A.h._id, actionType: 'create', entityType: 'Hostel', description: 'ZZ made A' });
    await HostelAuditLog.create({ school: S.id, hostel: H.B.h._id, actionType: 'create', entityType: 'Hostel', description: 'ZZ made B' });

    // A warden of A only.
    warden = await User.create({
        school: S.id, name: 'ZZ Warden', role: 'teacher', email: `zz-warden-${Date.now()}@test.invalid`, password: 'x', isActive: true,
    });
    await Hostel.updateOne({ _id: H.A.h._id }, { $set: { warden: warden._id } });
});
after(async () => { await teardown(S?.id); });

describe('beds', () => {
    test('the four states add up to Total Beds', async () => {
        const d = await overview();
        const b = d.beds;
        assert.equal(b.occupied + b.available + b.reserved + b.maintenance, b.total);
        assert.equal(d.structure.beds, b.total);
    });

    test('a bed the engine would refuse is never "available"', async () => {
        const { beds } = await overview();
        // A: 1 occupied, 1 reserved, 1 truly free; its maintenance room's two
        // beds are both maintenance; the inactive room's bed and the bed taken
        // out of service are out. B: 1 free, 1 occupied. C: its one bed is out.
        assert.equal(beds.occupied, 2);
        assert.equal(beds.available, 2);
        assert.equal(beds.reserved, 1);
        assert.equal(beds.maintenance, 2);
        assert.equal(beds.out, 3);
        assert.equal(beds.total, 7);
    });

    test('a closed hostel and a deleted bed are not counted at all', async () => {
        const d = await overview();
        assert.equal(d.structure.hostels, 3, 'A, B and C — not D');
        assert.equal(d.beds.byHostel[String(H.D.h._id)], undefined);
        assert.equal(d.beds.byHostel[String(H.A.h._id)].total, 5);
    });
});

describe('residents and attendance', () => {
    test('residents are counted by where they are', async () => {
        const { residence: r } = await overview();
        assert.deepEqual([r.inside, r.outside, r.onLeave, r.total], [2, 1, 1, 4], 'the vacated one is gone');
        assert.equal(r.byHostel[String(H.A.h._id)].total, 3);
    });

    test('attendance counts students, by their latest roll call of the day', async () => {
        const { attendance: a } = await overview();
        assert.equal(a.marked, 3, 'three students, five records');
        assert.equal(a.absent, 1, 'present in the morning, absent at night');
        assert.equal(a.late, 1, 'night beats morning even when it was typed in first');
        assert.equal(a.present, 1);
        assert.equal(a.expected, 4, 'taken against everyone holding a bed');
    });

    test('yesterday is its own day', async () => {
        const { attendance: a } = await overview({ day: 'yesterday' });
        assert.equal(a.day, 'yesterday');
        assert.deepEqual([a.present, a.marked], [1, 1]);
    });
});

describe('fees', () => {
    test('billed follows the billing period, collected the payment date', async () => {
        const { fees } = await overview({ range: '6m' });
        const at = (n) => fees.months[fees.months.length - 1 - n];
        assert.equal(fees.months.length, 6);
        // This month: A's 1000 + B's 50 (billed; its "payment" is unreadable).
        // Last month: B's annual 300, by due date. Two back: A's 500, raised
        // today but billed for that month. The cancelled 9999 is nowhere.
        assert.deepEqual([at(0).billed, at(1).billed, at(2).billed], [1050, 300, 500]);
        assert.deepEqual([at(0).collected, at(1).collected, at(2).collected], [600, 500, 0]);
        assert.equal(fees.billed, 1850);
        assert.equal(fees.collected, 1100);
    });

    test('the totals are the sum of the months shown', async () => {
        const { fees } = await overview({ range: '12m' });
        assert.equal(fees.months.length, 12);
        assert.equal(fees.billed, fees.months.reduce((s, m) => s + m.billed, 0));
        assert.equal(fees.collected, 1100);
    });
});

describe('recent lists and scope', () => {
    test('incidents come newest first, four of them', async () => {
        const { incidents } = await overview();
        assert.equal(incidents.length, 4);
        const dates = incidents.map((i) => new Date(i.date).getTime());
        assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
        assert.equal(incidents[0].hostel, 'ZZ Hostel B');
    });

    test('a warden sees only their own hostel', async () => {
        const who = { schoolId: S.id, userId: String(warden._id), userRole: 'teacher' };
        const d = await overview({}, who);
        assert.deepEqual(d.hostels.map((h) => h.name), ['ZZ Hostel A']);
        assert.equal(d.beds.total, 5);
        assert.equal(d.residence.total, 3);
        assert.equal(d.attendance.marked, 3);
        assert.ok(d.incidents.every((i) => i.hostel === 'ZZ Hostel A'));
        assert.ok(d.activity.every((a) => a.text !== 'ZZ made B'));
        assert.equal(d.fees.months.reduce((s, m) => s + m.billed, 0), 1500, 'A billed 1000 + 500; B is not theirs');
    });
});

describe('the fee window', () => {
    const year = { startDate: new Date(2026, 3, 1), endDate: new Date(2027, 2, 31) };
    const keys = (w) => w.months.map((m) => `${m.getFullYear()}-${m.getMonth() + 1}`);

    test('six months up to now, inside the year', () => {
        assert.deepEqual(keys(feeWindow('6m', year, new Date(2026, 8, 15))),
            ['2026-4', '2026-5', '2026-6', '2026-7', '2026-8', '2026-9']);
    });
    test('a finished year ends on its last month', () => {
        assert.deepEqual(keys(feeWindow('6m', year, new Date(2027, 7, 1))).slice(-1), ['2027-3']);
    });
    test('a year not begun shows its first months', () => {
        assert.deepEqual(keys(feeWindow('6m', year, new Date(2026, 0, 5)))[0], '2026-4');
    });
    test('the academic year runs from its first month, twelve at most', () => {
        const w = feeWindow('year', { startDate: new Date(2028, 0, 2), endDate: new Date(2029, 0, 1) });
        assert.equal(w.months.length, 12);
        assert.deepEqual(keys(w)[0], '2028-1');
    });
});
