'use strict';
/**
 * Who gets through the hostel's management guard (middleware/hostelDesk).
 *
 * What is worth guarding:
 *   · a teacher posted to a hostel — its warden, or on its staff — reaches the
 *     day-to-day routes without the hostel-admin designation;
 *   · the same teacher is refused setup, fees, the mess, reports, settings and
 *     the activity log — by route and by list screen;
 *   · a teacher with no posting is refused everything, as before;
 *   · once through, a warden's reach stops at their own hostel: another
 *     hostel's records are refused, and "any suitable hostel" is not offered.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const School = require('../models/School');
const User = require('../models/User');
const Hostel = require('../models/Hostel');
const HostelBuilding = require('../models/HostelBuilding');
const HostelFloor = require('../models/HostelFloor');
const HostelRoom = require('../models/HostelRoom');
const HostelBed = require('../models/HostelBed');
const HostelMaintenance = require('../models/HostelMaintenance');
const HostelStaffAssignment = require('../models/HostelStaffAssignment');
const { hostelDesk, onHostelDuty, DUTY_ROUTES } = require('../middleware/hostelDesk');
const hostelCtl = require('../controllers/hostel.controller');
const { makeSchool, teardown } = require('./helpers');

let S; let A; let B; let warden; let staff; let plain;
const uid = () => crypto.randomUUID();

/** Run the guard for `METHOD path`; resolves 'next' or the status it refused with. */
function guard(user, role, route, params = {}) {
    const [method, path] = route.split(' ');
    return new Promise((resolve) => {
        const req = { schoolId: S.id, userId: String(user._id), userRole: role, method, route: { path }, params };
        const res = { status(c) { this.code = c; return this; }, json(p) { resolve({ code: this.code, body: p, req }); } };
        hostelDesk(req, res, (err) => resolve(err ? { code: 500, err } : { code: 'next', req }));
    });
}
function call(handler, req) {
    return new Promise((resolve) => {
        let code = 200;
        const res = { status(c) { code = c; return this; }, json(p) { resolve([code, p]); } };
        handler({ params: {}, query: {}, body: {}, headers: {}, ip: '', ...req }, res);
    });
}
/** The request a posted teacher's handlers see, once the guard has let them in. */
const asWarden = (u) => ({ schoolId: S.id, userId: String(u._id), userRole: 'teacher', access: { permissions: { hostel: 'user' }, moduleFlags: { hostel: true } } });
const teacher = (name) => User.create({ school: S.id, name, role: 'teacher', email: `zz-t-${uid()}@test.invalid`, password: 'x', isActive: true });

async function hostel(letter, wardenId) {
    const h = await Hostel.create({ school: S.id, name: `ZZ Desk ${letter}`, code: `ZD${letter}`, gender: 'co_ed', status: 'active', isActive: true, warden: wardenId || null });
    const b = await HostelBuilding.create({ school: S.id, hostel: h._id, name: `Block ${letter}`, code: `DB${letter}` });
    const f = await HostelFloor.create({ school: S.id, hostel: h._id, building: b._id, name: 'Ground', floorNumber: 0 });
    const r = await HostelRoom.create({ school: S.id, hostel: h._id, building: b._id, floor: f._id, roomNumber: `${letter}-1`, code: `DR${letter}`, capacity: 2, status: 'available', isActive: true });
    const bed = await HostelBed.create({ school: S.id, hostel: h._id, building: b._id, floor: f._id, room: r._id, bedNumber: '1', code: `DBD${letter}`, status: 'available', isActive: true });
    return { h, r, bed };
}

before(async () => {
    S = await makeSchool();
    await School.findByIdAndUpdate(S.id, { $set: { 'modules.hostel': true } });
    [warden, staff, plain] = await Promise.all([teacher('ZZ Warden'), teacher('ZZ Caretaker'), teacher('ZZ Plain Teacher')]);
    A = await hostel('A', String(warden._id));
    B = await hostel('B', null);
    await HostelStaffAssignment.create({ school: S.id, hostel: A.h._id, staff: String(staff._id), role: 'caretaker', status: 'active' });
});
after(async () => { await teardown(S?.id); });

describe('the guard', () => {
    test('the school admin gets every route', async () => {
        for (const r of ['GET /admin/overview', 'PUT /admin/settings', 'POST /admin/hostels', 'POST /admin/invoices']) {
            assert.equal((await guard(S.admin, 'school_admin', r)).code, 'next', r);
        }
    });
    test('a warden and a member of the hostel\'s staff reach the day-to-day routes', async () => {
        for (const u of [warden, staff]) {
            for (const r of ['GET /admin/overview', 'POST /admin/attendance', 'POST /admin/leaves/:id/act', 'POST /admin/outpasses/gate', 'POST /admin/allocations']) {
                const out = await guard(u, 'teacher', r);
                assert.equal(out.code, 'next', `${u.name}: ${r}`);
                assert.equal(out.req.hostelDuty, true);
            }
        }
        assert.equal(await onHostelDuty(S.id, String(warden._id)), true);
        assert.equal(await onHostelDuty(S.id, String(plain._id)), false);
    });
    test('they are refused setup, money, the mess, reports, settings and the log', async () => {
        for (const r of ['POST /admin/hostels', 'PUT /admin/hostels/:id', 'POST /admin/buildings', 'POST /admin/staff', 'PUT /admin/settings',
            'POST /admin/fee-plans', 'POST /admin/invoices', 'POST /admin/invoices/:id/pay', 'POST /admin/invoices/:id/refund',
            'POST /admin/mess', 'POST /admin/menus', 'GET /admin/reports', 'GET /admin/audit', 'POST /admin/outpasses/sweep']) {
            assert.equal((await guard(warden, 'teacher', r)).code, 403, r);
            assert.equal(DUTY_ROUTES.has(r), false, r);
        }
    });
    test('the list screens follow the same split', async () => {
        for (const screen of ['attendance', 'leave', 'outpass', 'rooms', 'complaints', 'announcements']) {
            assert.equal((await guard(warden, 'teacher', 'GET /admin/board/:screen', { screen })).code, 'next', screen);
        }
        for (const screen of ['fees', 'fee-collections', 'fee-plans', 'mess', 'staff', 'reports', 'audit', 'hostels', 'structure']) {
            assert.equal((await guard(warden, 'teacher', 'GET /admin/board/:screen', { screen })).code, 403, screen);
        }
    });
    test('a teacher with no posting is refused everything', async () => {
        for (const r of ['GET /admin/overview', 'POST /admin/attendance', 'GET /admin/meta']) {
            assert.equal((await guard(plain, 'teacher', r)).code, 403, r);
        }
    });
    test('a student never reaches a management route', async () => {
        const s = await User.create({ school: S.id, name: 'ZZ S', role: 'student', email: `zz-s-${uid()}@test.invalid`, password: 'x', isActive: true });
        assert.equal((await guard(s, 'student', 'GET /admin/overview')).code, 403);
    });
});

describe('a warden\'s reach stops at their own hostel', () => {
    test('the dropdowns hold their own hostel only', async () => {
        const [code, out] = await call(hostelCtl.getMeta, asWarden(warden));
        assert.equal(code, 200);
        assert.deepEqual(out.data.hostels.map((h) => h.name), ['ZZ Desk A']);
        assert.ok(out.data.rooms.every((r) => String(r.hostel) === String(A.h._id)));
        assert.equal(out.data.rooms.length, 1);
    });
    test('another hostel\'s bed and room are refused', async () => {
        const mine = await call(hostelCtl.setBedState, { ...asWarden(warden), params: { id: String(A.bed._id) }, body: { status: 'maintenance' } });
        assert.equal(mine[0], 200, JSON.stringify(mine[1]));
        const theirs = await call(hostelCtl.setBedState, { ...asWarden(warden), params: { id: String(B.bed._id) }, body: { status: 'maintenance' } });
        assert.equal(theirs[0], 403);
        const room = await call(hostelCtl.updateRoom, { ...asWarden(warden), params: { id: String(B.r._id) }, body: { description: 'x' } });
        assert.equal(room[0], 403);
    });
    test('"any suitable hostel" is not a warden\'s to choose', async () => {
        const [code, out] = await call(hostelCtl.autoAllocate, { ...asWarden(warden), body: { student: uid(), academicYear: uid() } });
        assert.equal(code, 400);
        assert.match(out.message, /Choose the hostel/);
        const [other] = await call(hostelCtl.autoAllocate, { ...asWarden(warden), body: { student: uid(), academicYear: uid(), hostel: String(B.h._id) } });
        assert.equal(other, 403);
    });
    test('another hostel\'s work order cannot be cancelled', async () => {
        const m = await HostelMaintenance.create({ school: S.id, hostel: B.h._id, title: 't', description: 'd', requestNumber: 'ZZ-M1' });
        const [code] = await call(hostelCtl.deleteMaintenance, { ...asWarden(warden), params: { id: String(m._id) } });
        assert.equal(code, 403);
    });
});
