'use strict';
/**
 * The redesigned hostel list screens (GET /hostel/admin/board/:screen), the
 * announcement lifecycle, the reports and the settings guard.
 *
 * What is worth guarding:
 *   · every record sits under exactly one tab, so a screen's tabs add up to
 *     its total (incidents by kind, discipline by kind, documents by holder);
 *   · a repeat offender is a student with more than one action;
 *   · "expiring soon" is valid-but-lapsing, never already expired;
 *   · a warden sees their own hostels only, school-wide notices included;
 *   · an announcement is sent once, however many callers race to send it;
 *   · the occupancy report counts beds the way the Dashboard does, and a
 *     hostel outside the caller's scope matches nothing rather than everything;
 *   · only the module's admins change settings, and only to sane values.
 *   · a resident's own leave and outpass are filed against them, so they see
 *     them and the one-open-outpass rule counts them; attachments are only
 *     files the resident uploaded.
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
const HostelIncident = require('../models/HostelIncident');
const HostelDiscipline = require('../models/HostelDiscipline');
const HostelDocument = require('../models/HostelDocument');
const HostelComplaint = require('../models/HostelComplaint');
const HostelAnnouncement = require('../models/HostelAnnouncement');
const HostelAuditLog = require('../models/HostelAuditLog');
const boards = require('../controllers/hostelBoards.controller');
const reports = require('../controllers/hostelReports.controller');
const hostelCtl = require('../controllers/hostel.controller');
const portal = require('../controllers/hostelPortal.controller');
const User = require('../models/User');
const announcements = require('../services/hostelAnnouncements');
const { bedCounts } = require('../services/hostelOverview');
const { makeSchool, teardown } = require('./helpers');

let S;
const H = {};
const uid = () => crypto.randomUUID();
const day = (n) => new Date(Date.now() + n * 864e5);

/** A board, as the admin (allowed = null) or as a warden of some hostels. */
const board = (screen, q = {}, allowed = null) => boards._boards[screen]({ query: q }, { school: S.id, allowed, q });

async function hostel(letter, beds) {
    const h = await Hostel.create({ school: S.id, name: `ZZ Hostel ${letter}`, code: `ZZ${letter}`, status: 'active', isActive: true });
    const b = await HostelBuilding.create({ school: S.id, hostel: h._id, name: `Block ${letter}`, code: `B${letter}` });
    const f = await HostelFloor.create({ school: S.id, hostel: h._id, building: b._id, name: 'Ground', floorNumber: 0 });
    const r = await HostelRoom.create({ school: S.id, hostel: h._id, building: b._id, floor: f._id, roomNumber: `${letter}-101`,
        code: `R${letter}`, capacity: beds.length, status: 'available', isActive: true });
    const made = [];
    for (const [i, status] of beds.entries()) {
        made.push(await HostelBed.create({ school: S.id, hostel: h._id, building: b._id, floor: f._id, room: r._id,
            bedNumber: String(i + 1), code: `BD${letter}${i}`, status, isActive: true }));
    }
    return { h, b, f, r, beds: made };
}

/** Call an express handler and hand back [status, payload]. */
function call(handler, req) {
    return new Promise((resolve) => {
        let code = 200;
        const res = { status(c) { code = c; return this; }, json(p) { resolve([code, p]); } };
        handler({ params: {}, query: {}, body: {}, headers: {}, ip: '', ...req }, res);
    });
}

before(async () => {
    S = await makeSchool();
    H.A = await hostel('A', ['occupied', 'occupied', 'available', 'reserved']);
    H.B = await hostel('B', ['occupied', 'available']);
    const A = String(H.A.h._id); const B = String(H.B.h._id);

    // Residents: two in A, one in B — the audience of a residents' notice.
    for (const [h, bed] of [[H.A, 0], [H.A, 1], [H.B, 0]]) {
        await HostelAllocation.create({ school: S.id, student: uid(), academicYear: uid(), hostel: h.h._id, building: h.b._id,
            floor: h.f._id, room: h.r._id, bed: h.beds[bed]._id, status: 'active', presence: 'in' });
    }

    // Incidents: one of each kind, and the two ways a record becomes an emergency.
    const inc = (hostelId, extra) => HostelIncident.create({ school: S.id, hostel: hostelId, description: 'x', date: day(-1), ...extra });
    await inc(A, { incidentType: 'theft', severity: 'medium', status: 'investigating' });
    await inc(A, { incidentType: 'medical_emergency', severity: 'low', status: 'resolved' });
    await inc(A, { incidentType: 'medical_emergency', severity: 'medium', medicalCategory: 'ambulance', status: 'action_taken' });
    await inc(A, { incidentType: 'security', severity: 'critical', status: 'reported' });
    await inc(B, { incidentType: 'emergency', severity: 'low', status: 'closed' });

    // Discipline: student X twice (a repeat offender), Y once.
    const X = uid(); const Y = uid();
    const act = (student, actionType, status = 'issued') => HostelDiscipline.create({ school: S.id, hostel: A, student, violation: 'v', actionType, status, date: day(-2) });
    await act(X, 'verbal_warning', 'served'); await act(X, 'fine'); await act(Y, 'principal_escalation', 'acknowledged');

    // Documents: a student's, the hostel's, a staff member's; expiry states.
    const doc = (extra) => HostelDocument.create({ school: S.id, hostel: A, title: 't', storedName: `zz-${uid()}`, ...extra });
    await doc({ student: uid(), expiryDate: day(10) });                              // expiring
    await doc({ student: uid(), expiryDate: day(-3), verificationStatus: 'verified' }); // expired, not expiring
    await doc({ entityType: 'Hostel', entityId: A, expiryDate: day(200) });           // valid
    await doc({ entityType: 'HostelStaffAssignment', entityId: uid() });              // no expiry
    await doc({ student: uid(), hostel: B });                                         // another hostel

    // Announcements: school-wide, A's, B's.
    const ann = (extra) => HostelAnnouncement.create({ school: S.id, title: 'n', message: 'm', createdBy: S.ctx.userId, ...extra });
    await ann({ hostels: [] });
    await ann({ hostel: A, hostels: [A] });
    await ann({ hostel: B, hostels: [B], status: 'scheduled', scheduledAt: day(1) });

    // An audit entry about a complaint, for the name lookup.
    const c = await HostelComplaint.create({ school: S.id, hostel: A, ticketNumber: 'ZZ-7', category: 'room', description: 'd', raisedBy: S.ctx.userId });
    await HostelAuditLog.create({ school: S.id, hostel: A, user: S.ctx.userId, actionType: 'create', entityType: 'HostelComplaint', entityId: c._id, description: 'made' });
});

after(async () => { await teardown(S?.id); });

describe('incidents', () => {
    test('every record is one kind, and the tabs add up', async () => {
        const r = await board('incidents');
        assert.equal(r.tabs.all, 5);
        assert.equal(r.tabs.incidents + r.tabs.medical + r.tabs.emergency, r.tabs.all);
        // theft → incident; plain medical → medical; ambulance, critical and "emergency" → emergency.
        assert.deepEqual([r.tabs.incidents, r.tabs.medical, r.tabs.emergency], [1, 1, 3]);
    });
    test('in progress is investigating plus action taken; resolved includes closed', async () => {
        const { tiles } = await board('incidents');
        assert.equal(tiles.progress, 2);
        assert.equal(tiles.resolved, 2);
    });
    test('a warden of A does not see B', async () => {
        const r = await board('incidents', {}, [String(H.A.h._id)]);
        assert.equal(r.tabs.all, 4);
    });
});

describe('discipline', () => {
    test('warnings, fines and escalations add up to all actions', async () => {
        const { tabs } = await board('discipline');
        assert.equal(tabs.warnings + tabs.fines + tabs.escalations, tabs.all);
        assert.deepEqual([tabs.warnings, tabs.fines, tabs.escalations], [1, 1, 1]);
    });
    test('a repeat offender is a student with more than one action', async () => {
        const r = await board('discipline');
        assert.equal(r.tabs.repeat, 1);
        assert.equal(r.tiles.offenders, 1);
        assert.equal(r.tiles.students, 2);
        const list = await board('discipline-offenders');
        assert.equal(list.total, 1);
        assert.equal(list.rows[0].actions, 2);
        assert.equal(list.rows[0].open, 1);         // the fine is still only issued
    });
});

describe('documents', () => {
    test('student, hostel and staff documents add up to all', async () => {
        const { tabs } = await board('documents');
        assert.equal(tabs.student + tabs.hostel + tabs.staff, tabs.all);
        assert.deepEqual([tabs.all, tabs.student, tabs.hostel, tabs.staff], [5, 3, 1, 1]);
    });
    test('expiring soon is lapsing within 30 days, never already expired', async () => {
        const { tabs, tiles } = await board('documents');
        assert.equal(tabs.expiring, 1);
        assert.equal(tiles.expired, 1);
    });
    test('a warden sees their own hostel only', async () => {
        const { tabs } = await board('documents', {}, [String(H.A.h._id)]);
        assert.equal(tabs.all, 4);
    });
});

describe('announcements', () => {
    test('a warden sees notices wholly inside their hostels — not school-wide ones', async () => {
        assert.equal((await board('announcements')).tabs.all, 3);
        const mine = await board('announcements', {}, [String(H.A.h._id)]);
        assert.equal(mine.tabs.all, 1);
    });
    test('the audience is counted from live allocations', async () => {
        assert.equal((await announcements.recipientsFor({ school: S.id, hostels: [], audience: 'residents' })).length, 3);
        assert.equal((await announcements.recipientsFor({ school: S.id, hostels: [String(H.B.h._id)], audience: 'residents' })).length, 1);
    });
    test('two senders racing: exactly one sends it', async () => {
        const a = await HostelAnnouncement.create({ school: S.id, title: 'race', message: 'm', hostels: [], createdBy: S.ctx.userId });
        const req = { ...S.ctx, user: { name: 'ZZ' }, headers: {} };
        const results = await Promise.allSettled([announcements.publish(a._id, req), announcements.publish(a._id, req)]);
        assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
        assert.equal(results.find((x) => x.status === 'rejected').reason.status, 409);
        const row = await HostelAnnouncement.findById(a._id).lean();
        assert.equal(row.status, 'published');
        assert.equal(row.recipients, 3);
    });
    test('a sent notice cannot be edited or deleted', async () => {
        const a = await HostelAnnouncement.findOne({ school: S.id, title: 'race' }).lean();
        const ctl = require('../controllers/hostelAnnouncements.controller');
        const [edit] = await call(ctl.updateAnnouncement, { ...S.ctx, params: { id: a._id }, body: { title: 'changed' } });
        const [del] = await call(ctl.deleteAnnouncement, { ...S.ctx, params: { id: a._id } });
        assert.equal(edit, 409);
        assert.equal(del, 409);
    });
});

describe('reports', () => {
    test('occupancy counts beds as the Dashboard does', async () => {
        const r = await reports.report({}, { school: S.id, allowed: null, q: { report: 'occupancy' } });
        const beds = await bedCounts(S.id, [String(H.A.h._id), String(H.B.h._id)]);
        const donut = Object.fromEntries(r.charts[0].items.map((i) => [i.key, i.value]));
        assert.equal(donut.occupied, beds.occupied);
        assert.equal(donut.available, beds.available);
        assert.equal(r.tiles.capacity, beds.total);
        assert.equal(r.tiles.occupied + r.tiles.vacant, r.tiles.capacity);
    });
    test('a hostel outside the caller\'s scope matches nothing', async () => {
        const r = await reports.report({}, { school: S.id, allowed: [String(H.A.h._id)], q: { report: 'incidents', hostel: String(H.B.h._id) } });
        assert.equal(r.total, 0);
    });
});

describe('activity log', () => {
    test('an entry names its record', async () => {
        const r = await board('audit');
        const row = r.rows.find((x) => x.entityType === 'HostelComplaint');
        assert.equal(row.entityName, 'Complaint #ZZ-7');
    });
});

describe('settings', () => {
    test('a warden cannot change the school\'s hostel settings', async () => {
        const [code] = await call(hostelCtl.updateSettings, { schoolId: S.id, userId: uid(), userRole: 'teacher', access: {}, body: { curfewTime: '21:00' } });
        assert.equal(code, 403);
    });
    test('values outside their range are refused', async () => {
        for (const body of [{ curfewTime: '25:00' }, { feeDueDayOfMonth: 31 }, { visitorDays: ['Funday'] }, { attendanceSessions: [] }]) {
            const [code] = await call(hostelCtl.updateSettings, { ...S.ctx, body });
            assert.equal(code, 400, JSON.stringify(body));
        }
        const [ok] = await call(hostelCtl.updateSettings, { ...S.ctx, body: { curfewTime: '21:30' } });
        assert.equal(ok, 200);
    });
});

describe('resident requests', () => {
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let me;
    before(async () => {
        const u = await User.create({ school: S.id, name: 'ZZ Resident', role: 'student', email: `zz-res-${Date.now()}@test.invalid`, password: 'x', isActive: true });
        me = { schoolId: S.id, userId: String(u._id), userRole: 'student' };
        await HostelAllocation.create({ school: S.id, student: me.userId, academicYear: uid(), hostel: H.B.h._id, building: H.B.b._id,
            floor: H.B.f._id, room: H.B.r._id, bed: H.B.beds[1]._id, status: 'active', presence: 'in' });
        await HostelDocument.create({ school: S.id, hostel: H.B.h._id, student: me.userId, title: 't', storedName: 'zz-mine.pdf', uploadedBy: me.userId });
    });

    test('an outpass is filed against the student, and a second open one is refused', async () => {
        const body = { outpassType: 'day', purpose: 'p', departureDate: ymd(day(1)), expectedDepartureTime: '10:00', expectedReturnTime: '12:00',
            guardianName: 'g', guardianPhone: '9876543210', guardianRelation: 'Father', attachments: ['zz-mine.pdf', 'someone-elses.pdf'] };
        const [code, out] = await call(portal.applyOutpass, { ...me, body });
        assert.equal(code, 200, JSON.stringify(out));
        const row = out.data ?? out;
        assert.equal(String(row.student), me.userId);
        assert.equal(row.guardianRelation, 'Father');
        assert.deepEqual(row.attachments, ['zz-mine.pdf']);
        const [, mine] = await call(portal.myOutpasses, me);
        assert.equal((mine.data ?? mine).length, 1);
        const [again] = await call(portal.applyOutpass, { ...me, body });
        assert.equal(again, 400);
    });

    test('a leave is filed against the student', async () => {
        const [code, out] = await call(portal.applyLeave, { ...me, body: { leaveType: 'home', fromDate: ymd(day(5)), toDate: ymd(day(6)), reason: 'r', guardianRelation: 'Mother' } });
        assert.equal(code, 200, JSON.stringify(out));
        const row = out.data ?? out;
        assert.equal(String(row.student), me.userId);
        assert.equal(row.guardianRelation, 'Mother');
    });
});
