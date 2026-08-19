'use strict';
/**
 * Hostel Management — end-to-end business-rule tests (spec §37).
 *
 *   node scripts/testHostel.js
 *
 * Builds a throwaway school, mounts the real hostel router on an ephemeral
 * port, drives the module over HTTP as each role, then deletes everything it
 * created.
 *
 * The assertions this file exists for are the invariants of §31:
 *   • a bed can never hold two active students
 *   • a student can never hold two active allocations
 *   • gender, capacity and hostel-status rules are enforced
 *   • one school can never see another school's hostel data
 *   • every important operation lands in the audit trail
 *
 * No test framework — the repo has none, and adding one for this would be a
 * bigger change than the tests themselves.
 */
require('dotenv').config();
const express = require('express');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');

const connectDB = require('../config/db');

const School         = require('../models/School');
const User           = require('../models/User');
const AcademicYear   = require('../models/AcademicYear');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');
const ParentProfile  = require('../models/ParentProfile');
const FeeLedger      = require('../models/FeeLedger');

const Hostel                  = require('../models/Hostel');
const HostelBuilding          = require('../models/HostelBuilding');
const HostelFloor             = require('../models/HostelFloor');
const HostelRoom              = require('../models/HostelRoom');
const HostelBed               = require('../models/HostelBed');
const HostelAdmission         = require('../models/HostelAdmission');
const HostelAllocation        = require('../models/HostelAllocation');
const HostelAllocationHistory = require('../models/HostelAllocationHistory');
const HostelAttendance        = require('../models/HostelAttendance');
const HostelLeave             = require('../models/HostelLeave');
const HostelOutpass           = require('../models/HostelOutpass');
const HostelVisitor           = require('../models/HostelVisitor');
const HostelStaffAssignment   = require('../models/HostelStaffAssignment');
const HostelMess              = require('../models/HostelMess');
const HostelMessMember        = require('../models/HostelMessMember');
const HostelMenu              = require('../models/HostelMenu');
const HostelMessAttendance    = require('../models/HostelMessAttendance');
const HostelMessExpense       = require('../models/HostelMessExpense');
const HostelFeePlan           = require('../models/HostelFeePlan');
const HostelFeeInvoice        = require('../models/HostelFeeInvoice');
const HostelComplaint         = require('../models/HostelComplaint');
const HostelMaintenance       = require('../models/HostelMaintenance');
const HostelAsset             = require('../models/HostelAsset');
const HostelMovement          = require('../models/HostelMovement');
const HostelIncident          = require('../models/HostelIncident');
const HostelDiscipline        = require('../models/HostelDiscipline');
const HostelDocument          = require('../models/HostelDocument');
const HostelSettings          = require('../models/HostelSettings');
const HostelAuditLog          = require('../models/HostelAuditLog');
const Notification            = require('../models/Notification');
const NotificationReceipt     = require('../models/NotificationReceipt');

// ── tiny harness ─────────────────────────────────────────────────────────────
let passed = 0; let failed = 0;
const results = [];

function check(name, condition, detail = '') {
    if (condition) { passed += 1; results.push(`  ✅ ${name}`); }
    else { failed += 1; results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { results.push(`\n▸ ${title}`); }

const TAG = `hosteltest_${Date.now()}`;
let BASE = '';

const sid = (v) => String(v?._id ?? v);
const token = (user) => jwt.sign(
    { userId: sid(user), role: user.role, schoolId: sid(user.school) },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
);

async function call(method, path, { as, body } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(as ? { Authorization: `Bearer ${token(as)}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON (CSV export) */ }
    return { status: res.status, body: json, data: json?.data, message: json?.message };
}
/** Multipart POST — for the attachment endpoints. */
async function POST_FILE(path, { as, filename = 'evidence.png', body = {} } = {}) {
    const form = new FormData();
    // A tiny but genuinely valid PNG, so the upload filter accepts it.
    const png = Buffer.from(
        '89504e470d0a1a0a0000000d4948445200000001000000010802000000907724'
      + '3e0000000c4944415408d76360000000020001e221bc330000000049454e44ae426082',
        'hex');
    form.append('file', new Blob([png], { type: 'image/png' }), filename);
    for (const [k, v] of Object.entries(body)) form.append(k, String(v));
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { ...(as ? { Authorization: `Bearer ${token(as)}` } : {}) },
        body: form,
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: json, data: json?.data, message: json?.message };
}

/** Raw fetch, for endpoints that return an image rather than JSON. */
async function GET_RAW(path, { as } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        headers: { ...(as ? { Authorization: `Bearer ${token(as)}` } : {}) },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, contentType: res.headers.get('content-type'), buf };
}

const GET  = (p, o) => call('GET', p, o);
const POST = (p, o) => call('POST', p, o);
const PUT  = (p, o) => call('PUT', p, o);
const DEL  = (p, o) => call('DELETE', p, o);

const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAhead = (n) => new Date(today.getTime() + n * 86400000);
const daysAgo   = (n) => new Date(today.getTime() - n * 86400000);

// ── fixture ──────────────────────────────────────────────────────────────────
async function makeUser(name, role, schoolId) {
    const u = await User.create({
        name,
        email: `${TAG}_${name.toLowerCase().replace(/\s+/g, '')}@example.test`,
        password: await bcrypt.hash('Passw0rd123', 4),
        role, school: schoolId,
        isFirstLogin: false,       // otherwise requirePasswordReset blocks every call
        isActive: true,
    });
    return { ...(u.toObject?.() ?? u), _id: u._id, role, school: schoolId };
}

async function makeStudent(name, gender, schoolId) {
    const u = await makeUser(name, 'student', schoolId);
    await StudentProfile.create({ user: sid(u._id), school: schoolId, gender, bloodGroup: 'O+' });
    return u;
}

async function makeSchool(name, mods = { hostel: true }) {
    const school = await School.create({
        name: `${TAG} ${name}`, board: 'CBSE', modules: mods,
    });
    return school;
}

async function buildFixture() {
    const school = await makeSchool('High School');
    const schoolId = sid(school._id);
    // A second school, used only to prove tenant isolation.
    const other = await makeSchool('Rival School');
    const otherId = sid(other._id);

    const year = await AcademicYear.create({
        school: schoolId, yearName: `${TAG}-yr`, status: 'active',
        startDate: daysAgo(120), endDate: daysAhead(240),
    });

    const admin   = await makeUser(`Admin${TAG}`,   'school_admin', schoolId);
    const warden  = await makeUser(`Warden${TAG}`,  'teacher',      schoolId);
    const teacher = await makeUser(`Teacher${TAG}`, 'teacher',      schoolId);
    await TeacherProfile.create({ user: sid(warden._id),  school: schoolId, designation: 'Teacher', employeeId: `${TAG}-W1` });
    await TeacherProfile.create({ user: sid(teacher._id), school: schoolId, designation: 'Teacher', employeeId: `${TAG}-T1` });

    const boy1 = await makeStudent(`BoyOne${TAG}`,  'Male',   schoolId);
    const boy2 = await makeStudent(`BoyTwo${TAG}`,  'Male',   schoolId);
    const boy3 = await makeStudent(`BoyThree${TAG}`, 'Male',  schoolId);
    const dayScholar = await makeStudent(`DayScholar${TAG}`, 'Male', schoolId);
    const girl = await makeStudent(`GirlOne${TAG}`, 'Female', schoolId);

    const parent = await makeUser(`Parent${TAG}`, 'parent', schoolId);
    await ParentProfile.create({ user: sid(parent._id), school: schoolId, children: [sid(boy1._id)] });

    const otherAdmin = await makeUser(`OtherAdmin${TAG}`, 'school_admin', otherId);

    return { school, schoolId, other, otherId, year, admin, warden, teacher, boy1, boy2, boy3, dayScholar, girl, parent, otherAdmin };
}

async function cleanup(f) {
    for (const s of [f.schoolId, f.otherId]) {
        if (!s) continue;
        for (const M of [
            HostelAuditLog, HostelDocument, HostelDiscipline, HostelIncident, HostelMovement,
            HostelAsset, HostelMaintenance, HostelComplaint, HostelFeeInvoice, HostelFeePlan,
            HostelMessExpense, HostelMessAttendance, HostelMenu, HostelMessMember, HostelMess,
            HostelStaffAssignment, HostelVisitor, HostelOutpass, HostelLeave, HostelAttendance,
            HostelAllocationHistory, HostelAllocation, HostelAdmission, HostelBed, HostelRoom,
            HostelFloor, HostelBuilding, Hostel, HostelSettings, FeeLedger, AcademicYear,
        ]) {
            await M.deleteMany({ school: s });
        }
        const notes = await Notification.find({ school: s }).select('_id').lean();
        if (notes.length) await NotificationReceipt.deleteMany({ notification: { $in: notes.map(sid) } });
        await Notification.deleteMany({ school: s });
        const users = await User.find({ school: s }).select('_id').lean();
        const uids = users.map(sid);
        if (uids.length) {
            await StudentProfile.deleteMany({ user: { $in: uids } });
            await TeacherProfile.deleteMany({ user: { $in: uids } });
            await ParentProfile.deleteMany({ user: { $in: uids } });
        }
        await User.deleteMany({ school: s });
        await School.findByIdAndDelete(s);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
(async () => {
    await connectDB();

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/hostel', require('../routes/api/hostel'));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    BASE = `http://127.0.0.1:${server.address().port}/api/hostel`;

    let f = null;
    try {
        f = await buildFixture();
        const { schoolId, admin, warden, teacher, boy1, boy2, boy3, dayScholar, girl, parent, otherAdmin, year } = f;
        const A = { as: admin };
        const YEAR = sid(year._id);

        // ══ 1. SETUP ════════════════════════════════════════════════════════
        section('Hostel, building, floor, room & bed creation');

        const boysHostel = await POST('/admin/hostels', { ...A, body: {
            name: 'Boys Block A', hostelType: 'boys', gender: 'male', capacity: 10,
            curfewTime: '22:00', facilities: ['wifi'], rules: ['No outside food'],
        } });
        check('Hostel created with an auto code',
            boysHostel.status === 200 && /^HL-/.test(boysHostel.data?.code), boysHostel.message);
        const BOYS = sid(boysHostel.data);

        const girlsHostel = await POST('/admin/hostels', { ...A, body: {
            name: 'Girls Block A', hostelType: 'girls', gender: 'female', capacity: 10,
        } });
        const GIRLS = sid(girlsHostel.data);

        const dupCode = await POST('/admin/hostels', { ...A, body: { name: 'Clash', code: boysHostel.data.code } });
        check('A duplicate hostel code is refused', dupCode.status === 400, dupCode.message);

        const noName = await POST('/admin/hostels', { ...A, body: { hostelType: 'boys' } });
        check('A hostel without a name is refused', noName.status === 400, noName.message);

        const building = await POST('/admin/buildings', { ...A, body: { name: 'Block A', hostel: BOYS, floorCount: 2 } });
        check('Building created', building.status === 200, building.message);
        const BUILDING = sid(building.data);

        const floor = await POST('/admin/floors', { ...A, body: { name: 'Ground', building: BUILDING, floorNumber: 0 } });
        check('Floor created and inherits its hostel',
            floor.status === 200 && sid(floor.data.hostel) === BOYS, floor.message);
        const FLOOR = sid(floor.data);

        const dupFloor = await POST('/admin/floors', { ...A, body: { name: 'Ground again', building: BUILDING, floorNumber: 0 } });
        check('A duplicate floor number in one building is refused', dupFloor.status === 400, dupFloor.message);

        const room = await POST('/admin/rooms', { ...A, body: {
            roomNumber: '101', floor: FLOOR, roomType: 'double', capacity: 2,
        } });
        check('Room created with its beds laid out',
            room.status === 200 && room.data.beds?.length === 2, room.message);
        const ROOM = sid(room.data);
        const BED1 = sid(room.data.beds[0]);
        const BED2 = sid(room.data.beds[1]);

        const dupRoom = await POST('/admin/rooms', { ...A, body: { roomNumber: '101', floor: FLOOR, capacity: 1 } });
        check('A duplicate room number in one hostel is refused', dupRoom.status === 400, dupRoom.message);

        const overBed = await POST('/admin/beds', { ...A, body: { room: ROOM, bedNumber: '3' } });
        check('A bed beyond the room capacity is refused', overBed.status === 400, overBed.message);

        // A girls' room, for the gender test.
        const gBuilding = await POST('/admin/buildings', { ...A, body: { name: 'Block G', hostel: GIRLS } });
        const gFloor = await POST('/admin/floors', { ...A, body: { name: 'Ground', building: sid(gBuilding.data), floorNumber: 0 } });
        const gRoom = await POST('/admin/rooms', { ...A, body: { roomNumber: 'G101', floor: sid(gFloor.data), capacity: 2 } });
        const GBED1 = sid(gRoom.data.beds[0]);

        // ══ 2. ADMISSION ════════════════════════════════════════════════════
        section('Hostel admission workflow');

        const app1 = await POST('/admin/admissions', { ...A, body: {
            student: sid(boy1._id), hostel: BOYS, academicYear: YEAR, preferredRoomType: 'double',
        } });
        check('Application filed and awaits approval',
            app1.status === 200 && app1.data.status === 'pending_approval', app1.message);
        const APP1 = sid(app1.data);

        const dupApp = await POST('/admin/admissions', { ...A, body: {
            student: sid(boy1._id), hostel: BOYS, academicYear: YEAR,
        } });
        check('A second open application for the same student and year is refused',
            dupApp.status === 400, dupApp.message);

        const approve1 = await POST(`/admin/admissions/${APP1}/decision`, { ...A, body: {
            action: 'approve', allocate: true, bed: BED1,
        } });
        check('Approval with an explicit bed allocates it',
            approve1.status === 200 && !!approve1.data.allocation && !approve1.data.allocationError,
            approve1.data?.allocationError || approve1.message);
        const ALLOC1 = sid(approve1.data.allocation);

        // ══ 3. ALLOCATION INVARIANTS (spec §31) ═════════════════════════════
        section('Allocation business rules');

        const bedNow = await HostelBed.findById(BED1).lean();
        check('The bed is now occupied by that student',
            bedNow.status === 'occupied' && sid(bedNow.student) === sid(boy1._id));

        const roomNow = await HostelRoom.findById(ROOM).lean();
        check('The room occupancy counter followed',
            roomNow.occupiedBeds === 1 && roomNow.status === 'partially_occupied',
            `${roomNow.occupiedBeds}/${roomNow.status}`);

        const doubleBook = await POST('/admin/allocations', { ...A, body: {
            student: sid(boy2._id), bed: BED1, academicYear: YEAR,
        } });
        check('🔒 A second student cannot be given an occupied bed',
            doubleBook.status === 400, doubleBook.message);

        const secondAlloc = await POST('/admin/allocations', { ...A, body: {
            student: sid(boy1._id), bed: BED2, academicYear: YEAR,
        } });
        check('🔒 A student cannot hold two active allocations',
            secondAlloc.status === 400, secondAlloc.message);

        const wrongGender = await POST('/admin/allocations', { ...A, body: {
            student: sid(girl._id), bed: BED2, academicYear: YEAR,
        } });
        check('🔒 Gender restriction is enforced', wrongGender.status === 400, wrongGender.message);

        const girlOk = await POST('/admin/allocations', { ...A, body: {
            student: sid(girl._id), bed: GBED1, academicYear: YEAR,
        } });
        check('A girl can be allocated in the girls hostel', girlOk.status === 200, girlOk.message);

        const alloc2 = await POST('/admin/allocations', { ...A, body: {
            student: sid(boy2._id), bed: BED2, academicYear: YEAR,
        } });
        check('The room fills to capacity', alloc2.status === 200, alloc2.message);
        const roomFull = await HostelRoom.findById(ROOM).lean();
        check('A full room reports status full',
            roomFull.occupiedBeds === 2 && roomFull.status === 'full', roomFull.status);

        const autoNoRoom = await POST('/admin/allocations/auto', { ...A, body: {
            student: sid(boy3._id), academicYear: YEAR, hostel: BOYS,
        } });
        check('🔒 Auto-allocation refuses when the hostel is full',
            autoNoRoom.status === 400, autoNoRoom.message);

        // A second room, so auto-allocation has somewhere to put boy3.
        const room2 = await POST('/admin/rooms', { ...A, body: { roomNumber: '102', floor: FLOOR, capacity: 2 } });
        const ROOM2 = sid(room2.data);

        const autoNow = await POST('/admin/allocations/auto', { ...A, body: {
            student: sid(boy3._id), academicYear: YEAR, hostel: BOYS,
        } });
        check('Auto-allocation places a student once a bed frees up', autoNow.status === 200, autoNow.message);
        check('Auto-allocation picked the newly opened room',
            sid(autoNow.data?.room) === ROOM2, sid(autoNow.data?.room));

        // A third room, kept empty so the transfer has an unambiguous target.
        const room3 = await POST('/admin/rooms', { ...A, body: { roomNumber: '103', floor: FLOOR, capacity: 2 } });
        const ROOM3 = sid(room3.data);
        const BED3 = sid(room3.data.beds[0]);

        // ── Inactive hostel refuses new admissions ──────────────────────────
        await Hostel.findByIdAndUpdate(GIRLS, { $set: { status: 'inactive' } });
        const inactiveAlloc = await POST('/admin/allocations', { ...A, body: {
            student: sid(boy3._id), bed: sid(gRoom.data.beds[1]), academicYear: YEAR,
        } });
        check('🔒 An inactive hostel refuses allocations', inactiveAlloc.status === 400, inactiveAlloc.message);
        await Hostel.findByIdAndUpdate(GIRLS, { $set: { status: 'active' } });

        // ── Transfer ────────────────────────────────────────────────────────
        section('Transfer & release');

        const transfer = await POST(`/admin/allocations/${ALLOC1}/transfer`, { ...A, body: {
            bed: BED3, reason: 'Roommate conflict',
        } });
        check('Transfer opens a new allocation', transfer.status === 200, transfer.message);

        const oldAlloc = await HostelAllocation.findById(ALLOC1).lean();
        check('The old allocation is closed as transferred', oldAlloc.status === 'transferred', oldAlloc.status);

        const oldBed = await HostelBed.findById(BED1).lean();
        check('The old bed is free again',
            oldBed.status === 'available' && oldBed.student == null, oldBed.status);

        const newBed = await HostelBed.findById(BED3).lean();
        check('The new bed holds the student',
            newBed.status === 'occupied' && sid(newBed.student) === sid(boy1._id), newBed.status);

        const activeCount = await HostelAllocation.countDocuments({
            school: schoolId, student: sid(boy1._id), status: { $in: ['pending', 'active'] },
        });
        check('🔒 Still exactly one active allocation after a transfer', activeCount === 1, String(activeCount));

        const history = await HostelAllocationHistory.find({ school: schoolId, student: sid(boy1._id) }).lean();
        check('Allocation history records both the allocation and the transfer',
            history.length >= 2 && history.some((h) => h.action === 'transferred'),
            history.map((h) => h.action).join(','));
        check('History snapshots the human-readable placement',
            history.some((h) => (h.toLabel || '').includes('Room')), '');

        const NEW_ALLOC1 = sid(transfer.data);

        // ══ 4. ATTENDANCE ═══════════════════════════════════════════════════
        section('Hostel attendance');

        const register = await GET(`/admin/attendance?hostel=${BOYS}&session=morning&date=${iso(today)}`, A);
        check('The register lists every active resident',
            register.status === 200 && register.data.rows.length === 3,
            `${register.data?.rows?.length} rows`);

        const mark = await POST('/admin/attendance', { ...A, body: {
            hostel: BOYS, session: 'morning', date: iso(today),
            records: [
                { student: sid(boy1._id), status: 'present' },
                { student: sid(boy2._id), status: 'absent' },
                { student: sid(boy3._id), status: 'late' },
            ],
        } });
        check('Roll call marks every student', mark.status === 200 && mark.data.created === 3, JSON.stringify(mark.data));

        const remark = await POST('/admin/attendance', { ...A, body: {
            hostel: BOYS, session: 'morning', date: iso(today),
            records: [{ student: sid(boy1._id), status: 'late' }],
        } });
        check('🔒 Re-submitting updates rather than duplicating',
            remark.status === 200 && remark.data.created === 0 && remark.data.updated === 1,
            JSON.stringify(remark.data));

        const attCount = await HostelAttendance.countDocuments({
            school: schoolId, student: sid(boy1._id), session: 'morning',
        });
        check('🔒 One attendance row per student, date and session', attCount === 1, String(attCount));

        const nonResident = await POST('/admin/attendance', { ...A, body: {
            hostel: BOYS, session: 'morning', date: iso(today),
            records: [{ student: sid(girl._id), status: 'present' }],
        } });
        check('A non-resident is skipped, not marked',
            nonResident.status === 200 && nonResident.data.skipped.length === 1, JSON.stringify(nonResident.data));

        const future = await POST('/admin/attendance', { ...A, body: {
            hostel: BOYS, session: 'morning', date: iso(daysAhead(2)),
            records: [{ student: sid(boy1._id), status: 'present' }],
        } });
        check('Attendance cannot be marked for a future date', future.status === 400, future.message);

        const attRow = await HostelAttendance.findOne({ school: schoolId, student: sid(boy2._id) }).lean();
        const correct = await POST(`/admin/attendance/${sid(attRow._id)}/correct`, { ...A, body: {
            status: 'excused', reason: 'Was at the infirmary',
        } });
        check('A correction keeps the previous value',
            correct.status === 200 && correct.data.previousStatus === 'absent', correct.message);

        // ══ 5. LEAVE & OUTPASS ══════════════════════════════════════════════
        section('Leave & outpass');

        const badDates = await POST('/admin/leaves', { ...A, body: {
            student: sid(boy1._id), fromDate: iso(daysAhead(5)), toDate: iso(daysAhead(2)), reason: 'Backwards',
        } });
        check('🔒 Leave end date cannot precede the start date', badDates.status === 400, badDates.message);

        const leave = await POST('/admin/leaves', { ...A, body: {
            student: sid(boy1._id), leaveType: 'home',
            fromDate: iso(daysAhead(2)), toDate: iso(daysAhead(4)), reason: 'Family function',
        } });
        check('Leave filed with the day count computed',
            leave.status === 200 && leave.data.totalDays === 3, `${leave.data?.totalDays} days`);
        const LEAVE = sid(leave.data);

        const overlap = await POST('/admin/leaves', { ...A, body: {
            student: sid(boy1._id), fromDate: iso(daysAhead(3)), toDate: iso(daysAhead(5)), reason: 'Overlapping',
        } });
        check('🔒 Overlapping leave is refused', overlap.status === 400, overlap.message);

        const earlyApprove = await POST(`/admin/leaves/${LEAVE}/act`, { ...A, body: { action: 'approve' } });
        check('🔒 Approval waits for parent consent when the setting requires it',
            earlyApprove.status === 400, earlyApprove.message);

        const consent = await POST(`/admin/leaves/${LEAVE}/act`, { ...A, body: { action: 'parent_approve' } });
        check('Parent consent recorded', consent.status === 200 && consent.data.status === 'parent_approved', consent.message);

        const approveLeave = await POST(`/admin/leaves/${LEAVE}/act`, { ...A, body: { action: 'approve' } });
        check('Warden approval follows consent', approveLeave.status === 200 && approveLeave.data.status === 'approved', approveLeave.message);

        const depart = await POST(`/admin/leaves/${LEAVE}/act`, { ...A, body: { action: 'depart' } });
        check('Departure marks the student on leave', depart.status === 200 && depart.data.status === 'active', depart.message);
        const presence = await HostelAllocation.findById(NEW_ALLOC1).lean();
        check('Presence follows the leave', presence.presence === 'on_leave', presence.presence);

        const clash = await POST('/admin/outpasses', { ...A, body: {
            student: sid(boy1._id), purpose: 'Shopping', departureDate: iso(today),
        } });
        check('🔒 No outpass while on leave, unless configured otherwise', clash.status === 400, clash.message);

        const back = await POST(`/admin/leaves/${LEAVE}/act`, { ...A, body: { action: 'return' } });
        check('Return closes the leave', back.status === 200 && back.data.status === 'returned', back.message);
        const backIn = await HostelAllocation.findById(NEW_ALLOC1).lean();
        check('Presence returns to "in"', backIn.presence === 'in', backIn.presence);

        const movements = await HostelMovement.countDocuments({ school: schoolId, student: sid(boy1._id) });
        check('Departure and return are both in the movement log', movements === 2, String(movements));

        // ── Outpass with QR gate ────────────────────────────────────────────
        const outpass = await POST('/admin/outpasses', { ...A, body: {
            student: sid(boy2._id), purpose: 'Dentist', outpassType: 'medical',
            departureDate: iso(today), expectedDepartureTime: '10:00', expectedReturnTime: '13:00',
        } });
        check('Outpass requested', outpass.status === 200, outpass.message);
        const OUTPASS = sid(outpass.data);
        check('Return time resolves into a datetime', !!outpass.data.expectedReturnAt);

        const dupOutpass = await POST('/admin/outpasses', { ...A, body: {
            student: sid(boy2._id), purpose: 'Another', departureDate: iso(today), expectedDepartureTime: '10:00',
        } });
        check('🔒 Only one open outpass per student', dupOutpass.status === 400, dupOutpass.message);

        const earlyGate = await POST('/admin/outpasses/gate', { ...A, body: {
            outpass: OUTPASS, direction: 'out',
        } });
        check('🔒 An unapproved pass cannot be used at the gate', earlyGate.status === 400, earlyGate.message);

        const approveOut = await POST(`/admin/outpasses/${OUTPASS}/act`, { ...A, body: { action: 'approve' } });
        check('Approval mints a QR token',
            approveOut.status === 200 && !!approveOut.data.qrToken, approveOut.message);
        const TOKEN = approveOut.data.qrToken;

        const verify = await GET(`/admin/outpasses/verify/${TOKEN}`, A);
        check('The gate can resolve a pass from its token alone',
            verify.status === 200 && verify.data.expectedAction === 'out', verify.message);

        const badToken = await GET('/admin/outpasses/verify/not-a-real-token', A);
        check('An unknown token is refused', badToken.status === 404, badToken.message);

        const gateOut = await POST('/admin/outpasses/gate', { ...A, body: { token: TOKEN, direction: 'out', gate: 'Main' } });
        check('Departure recorded through the gate', gateOut.status === 200 && gateOut.data.outpass.status === 'active', gateOut.message);
        const outPresence = await HostelAllocation.findOne({ school: schoolId, student: sid(boy2._id), status: 'active' }).lean();
        check('Presence flips to "out"', outPresence.presence === 'out', outPresence.presence);

        // Force an overdue return so the late path is exercised.
        await HostelOutpass.findByIdAndUpdate(OUTPASS, { $set: { expectedReturnAt: new Date(Date.now() - 90 * 60000) } });
        await HostelSettings.findOneAndUpdate({ school: schoolId }, { $set: { lateReturnFine: 50, lateReturnGraceMinutes: 15 } });

        const gateIn = await POST('/admin/outpasses/gate', { ...A, body: { token: TOKEN, direction: 'in', gate: 'Main' } });
        check('Return recorded with the late minutes computed',
            gateIn.status === 200 && gateIn.data.lateMinutes > 0, JSON.stringify(gateIn.data?.lateMinutes));
        check('A late return raises a fine when one is configured', !!gateIn.data?.fine, '');

        const fineInvoice = await HostelFeeInvoice.findOne({ school: schoolId, feeType: 'fine' }).lean();
        check('The fine is a real hostel invoice', !!fineInvoice && fineInvoice.netAmount === 50, String(fineInvoice?.netAmount));

        // ══ 6. VISITORS ═════════════════════════════════════════════════════
        section('Visitor management');

        const restricted = await POST('/admin/visitors', { ...A, body: {
            student: sid(boy1._id), visitorName: 'Barred Person', isTemplate: true, listType: 'restricted',
        } });
        check('A restricted visitor list entry is stored', restricted.status === 200, restricted.message);

        const blocked = await POST('/admin/visitors', { ...A, body: {
            student: sid(boy1._id), visitorName: 'Barred Person', purpose: 'Visit',
        } });
        check('🔒 A restricted visitor cannot be registered', blocked.status === 400, blocked.message);

        const authorized = await POST('/admin/visitors', { ...A, body: {
            student: sid(boy1._id), visitorName: 'Uncle Ravi', relationship: 'Uncle',
            isTemplate: true, listType: 'authorized',
        } });
        check('An authorized visitor list entry is stored', authorized.status === 200, authorized.message);

        const autoApproved = await POST('/admin/visitors', { ...A, body: {
            student: sid(boy1._id), visitorName: 'Uncle Ravi', purpose: 'Weekend visit',
        } });
        check('An authorized visitor skips approval',
            autoApproved.status === 200 && autoApproved.data.status === 'approved', autoApproved.data?.status);
        const VISITOR = sid(autoApproved.data);

        const entry = await POST(`/admin/visitors/${VISITOR}/act`, { ...A, body: { action: 'entry' } });
        check('Visitor check-in recorded', entry.status === 200 && entry.data.status === 'checked_in', entry.message);

        const exit = await POST(`/admin/visitors/${VISITOR}/act`, { ...A, body: { action: 'exit' } });
        check('Visitor check-out recorded', exit.status === 200 && exit.data.status === 'checked_out', exit.message);
        check('🔒 Exit time is not before entry time',
            new Date(exit.data.exitTime) >= new Date(exit.data.entryTime));

        const doubleExit = await POST(`/admin/visitors/${VISITOR}/act`, { ...A, body: { action: 'exit' } });
        check('A checked-out visitor cannot be checked out again', doubleExit.status === 400, doubleExit.message);

        // ══ 7. STAFF, MESS & FEES ═══════════════════════════════════════════
        section('Staff, mess & fees');

        const assign = await POST('/admin/staff', { ...A, body: {
            staff: sid(warden._id), hostel: BOYS, role: 'warden', shift: 'general',
        } });
        check('An existing employee is assigned as warden', assign.status === 200, assign.message);
        const hostelRow = await Hostel.findById(BOYS).lean();
        check('The warden is also set on the hostel itself', sid(hostelRow.warden) === sid(warden._id));

        const studentAsStaff = await POST('/admin/staff', { ...A, body: {
            staff: sid(boy1._id), hostel: BOYS, role: 'caretaker',
        } });
        check('🔒 A student cannot be assigned as hostel staff', studentAsStaff.status === 400, studentAsStaff.message);

        const mess = await POST('/admin/mess', { ...A, body: { name: 'Main Mess', hostels: [BOYS], messType: 'both' } });
        check('Mess created', mess.status === 200, mess.message);
        const MESS = sid(mess.data);

        const member = await POST('/admin/mess-members', { ...A, body: {
            student: sid(boy1._id), mess: MESS, foodPreference: 'veg', allergies: ['peanuts'],
        } });
        check('A resident is enrolled in the mess', member.status === 200, member.message);

        const dupMember = await POST('/admin/mess-members', { ...A, body: { student: sid(boy1._id), mess: MESS } });
        check('🔒 A student cannot hold two mess enrolments', dupMember.status === 400, dupMember.message);

        const menu = await POST('/admin/menus', { ...A, body: {
            mess: MESS, meal: 'breakfast', isTemplate: true, dayOfWeek: 1, items: ['Poha', 'Tea'],
        } });
        check('A weekly template menu is stored', menu.status === 200, menu.message);

        const plan = await POST('/admin/fee-plans', { ...A, body: {
            name: 'Monthly hostel', feeType: 'monthly', basis: 'flat', amount: 5000, hostel: BOYS,
        } });
        check('Fee plan created', plan.status === 200, plan.message);
        const PLAN = sid(plan.data);

        const gen = await POST('/admin/invoices/generate', { ...A, body: {
            feePlan: PLAN, hostel: BOYS, month: today.getMonth() + 1, year: today.getFullYear(),
        } });
        check('Invoices generated for every resident',
            gen.status === 200 && gen.data.created === 3, JSON.stringify(gen.data?.created));

        const regen = await POST('/admin/invoices/generate', { ...A, body: {
            feePlan: PLAN, hostel: BOYS, month: today.getMonth() + 1, year: today.getFullYear(),
        } });
        check('🔒 Re-running a period does not double-charge',
            regen.status === 200 && regen.data.created === 0 && regen.data.skipped === 3,
            JSON.stringify(regen.data));

        const invoice = await HostelFeeInvoice.findOne({ school: schoolId, student: sid(boy1._id), feeType: 'monthly' }).lean();
        const overpay = await POST(`/admin/invoices/${sid(invoice._id)}/pay`, { ...A, body: { amount: 99999 } });
        check('🔒 Paying more than the outstanding amount is refused', overpay.status === 400, overpay.message);

        const pay = await POST(`/admin/invoices/${sid(invoice._id)}/pay`, { ...A, body: { amount: 2000, mode: 'cash' } });
        check('A part payment leaves the invoice partial',
            pay.status === 200 && pay.data.invoice.status === 'partial', pay.data?.invoice?.status);
        check('A receipt number is issued', /^HR-/.test(pay.data?.receiptNumber || ''), pay.data?.receiptNumber);

        const ledger = await FeeLedger.find({ school: schoolId, student: sid(boy1._id) }).sort('createdAt').lean();
        check('The charge and the payment both reached the shared fee ledger',
            ledger.some((l) => l.category === 'fee_charged' && l.referenceType === 'HostelFeeInvoice')
            && ledger.some((l) => l.category === 'payment'),
            ledger.map((l) => l.category).join(','));

        const discount = await POST(`/admin/invoices/${sid(invoice._id)}/discount`, { ...A, body: {
            discount: 1000, reason: 'Sibling concession',
        } });
        check('A concession reduces the net amount',
            discount.status === 200 && discount.data.netAmount === 4000, String(discount.data?.netAmount));

        const badDiscount = await POST(`/admin/invoices/${sid(invoice._id)}/discount`, { ...A, body: { discount: 4000 } });
        check('🔒 A concession cannot drop the bill below what was already paid',
            badDiscount.status === 400, `${badDiscount.status} ${badDiscount.message}`);
        const overDiscount = await POST(`/admin/invoices/${sid(invoice._id)}/discount`, { ...A, body: { discount: 9999 } });
        check('🔒 A concession cannot exceed the billed amount', overDiscount.status === 400, overDiscount.message);

        // ══ 8. COMPLAINTS, MAINTENANCE, ASSETS ══════════════════════════════
        section('Complaints, maintenance & assets');

        const complaint = await POST('/admin/complaints', { ...A, body: {
            hostel: BOYS, room: ROOM, student: sid(boy1._id),
            category: 'plumbing', priority: 'high', description: 'Tap leaking',
        } });
        check('Complaint raised with a ticket number and SLA',
            complaint.status === 200 && /^HC-/.test(complaint.data.ticketNumber) && !!complaint.data.dueAt,
            complaint.message);
        const COMPLAINT = sid(complaint.data);

        const assignC = await POST(`/admin/complaints/${COMPLAINT}/act`, { ...A, body: {
            action: 'assign', assignedTo: sid(teacher._id), comment: 'Please look today',
        } });
        check('Assignment moves the ticket forward',
            assignC.status === 200 && assignC.data.status === 'assigned', assignC.message);

        const resolveC = await POST(`/admin/complaints/${COMPLAINT}/act`, { ...A, body: {
            action: 'resolve', resolution: 'Washer replaced',
        } });
        check('Resolution is recorded', resolveC.status === 200 && resolveC.data.status === 'resolved', resolveC.message);

        const reopen = await POST(`/admin/complaints/${COMPLAINT}/act`, { ...A, body: { action: 'reopen' } });
        check('Reopening increments the counter',
            reopen.status === 200 && reopen.data.reopenCount === 1, String(reopen.data?.reopenCount));

        const maint = await POST('/admin/maintenance', { ...A, body: {
            hostel: BOYS, room: ROOM, category: 'plumbing', description: 'Replace the tap',
            maintenanceType: 'preventive', recurEveryDays: 30,
        } });
        check('Work order raised', maint.status === 200, maint.message);
        const MAINT = sid(maint.data);

        const complete = await POST(`/admin/maintenance/${MAINT}/act`, { ...A, body: {
            action: 'complete', cost: 450, resolution: 'Done',
        } });
        check('Completion records the cost',
            complete.status === 200 && complete.data.maintenance.actualCost === 450,
            String(complete.data?.maintenance?.actualCost));
        check('A recurring preventive job schedules its next occurrence',
            !!complete.data?.nextScheduled, '');

        const asset = await POST('/admin/assets', { ...A, body: {
            hostel: BOYS, room: ROOM, name: 'Study table', category: 'table', quantity: 1,
        } });
        check('Asset added to a room', asset.status === 200, asset.message);
        const ASSET = sid(asset.data);

        const issueToNonResident = await POST(`/admin/assets/${ASSET}/act`, { ...A, body: {
            action: 'issue', student: sid(dayScholar._id),
        } });
        check('🔒 An asset can only be issued to a current hostel resident',
            issueToNonResident.status === 400, issueToNonResident.message);

        const issue = await POST(`/admin/assets/${ASSET}/act`, { ...A, body: {
            action: 'issue', student: sid(boy1._id),
        } });
        check('Asset issued to a resident',
            issue.status === 200 && issue.data.asset.status === 'issued', issue.message);

        const reIssue = await POST(`/admin/assets/${ASSET}/act`, { ...A, body: {
            action: 'issue', student: sid(boy2._id),
        } });
        check('🔒 An asset already on issue cannot be issued again', reIssue.status === 400, reIssue.message);

        const damage = await POST(`/admin/assets/${ASSET}/act`, { ...A, body: {
            action: 'damage', damageCharge: 300, note: 'Leg broken',
        } });
        check('A damage charge is billed as a hostel fine', damage.status === 200 && !!damage.data.fine, damage.message);

        // ══ 9. INCIDENTS & DISCIPLINE ═══════════════════════════════════════
        section('Incidents & discipline');

        const incident = await POST('/admin/incidents', { ...A, body: {
            hostel: BOYS, student: sid(boy2._id), incidentType: 'medical_emergency',
            severity: 'high', description: 'Fever at night', medicalCategory: 'doctor_visit',
            treatmentGiven: 'Paracetamol', date: iso(today),
        } });
        check('A medical incident is recorded and parents notified',
            incident.status === 200 && /^HI-/.test(incident.data.incidentNumber), incident.message);
        const incRow = await HostelIncident.findById(sid(incident.data)).lean();
        check('The parent notification is stamped on a medical incident', !!incRow.parentNotifiedAt);

        const d1 = await POST('/admin/discipline', { ...A, body: {
            student: sid(boy2._id), violation: 'Returned after curfew',
            violationType: 'curfew', actionType: 'written_warning', severity: 'minor',
        } });
        check('A first disciplinary action is not a repeat offence',
            d1.status === 200 && d1.data.action.isRepeatOffence === false, d1.message);

        const d2 = await POST('/admin/discipline', { ...A, body: {
            student: sid(boy2._id), violation: 'Curfew again',
            violationType: 'curfew', actionType: 'fine', fineAmount: 200,
        } });
        check('🔒 A second action is flagged as a repeat offence',
            d2.status === 200 && d2.data.action.isRepeatOffence === true && d2.data.action.priorCount === 1,
            JSON.stringify(d2.data?.action?.priorCount));
        check('A disciplinary fine is billed as an invoice',
            !!d2.data?.fine && d2.data.fine.netAmount === 200, String(d2.data?.fine?.netAmount));

        const record = await GET(`/admin/discipline/student/${sid(boy2._id)}`, A);
        check('The student discipline record rolls up correctly',
            record.status === 200 && record.data.total === 2 && record.data.totalFines === 200 && record.data.repeatOffender,
            JSON.stringify(record.data?.total));

        // ══ 10. STUDENT & PARENT PORTAL ═════════════════════════════════════
        section('Student & parent portal');

        const myHostel = await GET('/student/my-hostel', { as: boy1 });
        check('A student sees their own placement',
            myHostel.status === 200 && myHostel.data.resident === true
            && myHostel.data.current?.room?.roomNumber === '103',
            myHostel.data?.current?.room?.roomNumber);
        check('The student sees the warden and the hostel rules',
            !!myHostel.data?.warden && Array.isArray(myHostel.data?.rules?.hostelRules), '');

        const myFees = await GET('/student/fees', { as: boy1 });
        check('A student sees their own hostel fees',
            myFees.status === 200 && myFees.data.invoices.length > 0, myFees.message);

        const stuComplaint = await POST('/student/complaints', { as: boy1, body: {
            category: 'internet', description: 'Wifi keeps dropping',
        } });
        check('A student can raise a complaint', stuComplaint.status === 200, stuComplaint.message);

        const stuOutpass = await POST('/student/outpasses', { as: boy1, body: {
            purpose: 'Stationery', departureDate: iso(today),
            expectedDepartureTime: '10:00', expectedReturnTime: '12:00',
        } });
        check('A student can request an outpass', stuOutpass.status === 200, stuOutpass.message);

        const stuAdmin = await GET('/admin/hostels', { as: boy1 });
        check('🔒 A student cannot reach the administrative surface', stuAdmin.status === 403, String(stuAdmin.status));

        const parentChildren = await GET('/parent/children', { as: parent });
        check('A parent sees only their own children',
            parentChildren.status === 200 && parentChildren.data.length === 1
            && sid(parentChildren.data[0]._id) === sid(boy1._id),
            String(parentChildren.data?.length));

        const parentOwn = await GET(`/parent/my-hostel?student=${sid(boy1._id)}`, { as: parent });
        check('A parent sees their own child\'s hostel record',
            parentOwn.status === 200 && parentOwn.data.resident === true, parentOwn.message);

        const parentOther = await GET(`/parent/my-hostel?student=${sid(boy2._id)}`, { as: parent });
        check('🔒 A parent cannot read another family\'s child',
            parentOther.status === 404, `${parentOther.status} ${parentOther.message}`);

        // ══ 10b. QR PASSES & ATTACHMENTS ════════════════════════════════════
        section('QR passes & attachments');

        // A fresh outpass for boy3, approved, so there is a live pass to render.
        const qrPass = await POST('/admin/outpasses', { ...A, body: {
            student: sid(boy3._id), purpose: 'Library', departureDate: iso(today),
            expectedDepartureTime: '10:00', expectedReturnTime: '12:00',
        } });
        const QR_PASS = sid(qrPass.data);
        const qrApprove = await POST(`/admin/outpasses/${QR_PASS}/act`, { ...A, body: { action: 'approve' } });
        check('Approval returns a rendered pass image',
            qrApprove.status === 200 && String(qrApprove.data?.qrImage || '').startsWith('data:image/png;base64,'),
            String(qrApprove.data?.qrImage || '').slice(0, 30));

        const qrPng = await GET_RAW(`/admin/outpasses/${QR_PASS}/qr.png`, A);
        check('The pass is downloadable as a real PNG',
            qrPng.status === 200
            && qrPng.contentType === 'image/png'
            && qrPng.buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
            `${qrPng.status} ${qrPng.contentType}`);

        const qrToken = qrApprove.data.qrToken;
        const qrVerify = await GET(`/admin/outpasses/verify/${qrToken}`, A);
        check('The gate lookup carries the pass image too',
            qrVerify.status === 200 && String(qrVerify.data?.qrImage || '').startsWith('data:image/png'),
            '');

        // 🔒 The rendered code must actually contain the token — a QR that
        // encodes the wrong thing would scan cleanly and still be useless.
        const qrLib = require('../utils/qrcode');
        const { matrixToDataUri } = require('../utils/pngEncoder');
        check('🔒 The image encodes exactly this pass\'s token',
            qrApprove.data.qrImage === matrixToDataUri(qrLib.encode(qrToken), { scale: 6, quietZone: 4 }));

        const otherToken = crypto.randomBytes(24).toString('hex');
        check('🔒 A different token renders a different image',
            qrApprove.data.qrImage !== matrixToDataUri(qrLib.encode(otherToken), { scale: 6, quietZone: 4 }));

        // The student sees their own pass, with the image.
        const stuPass = await GET(`/student/outpasses/${QR_PASS}/pass`, { as: boy3 });
        check('A student can fetch their own pass with its image',
            stuPass.status === 200 && String(stuPass.data?.qrImage || '').startsWith('data:image/png'),
            stuPass.message);

        const foreignPass = await GET(`/student/outpasses/${QR_PASS}/pass`, { as: boy1 });
        check('🔒 A student cannot fetch someone else\'s pass', foreignPass.status === 404, String(foreignPass.status));

        const stuQrPng = await GET_RAW(`/student/outpasses/${QR_PASS}/qr.png`, { as: boy3 });
        check('A student can download their pass as a PNG',
            stuQrPng.status === 200 && stuQrPng.contentType === 'image/png', String(stuQrPng.status));

        // Cancelling the pass revokes the token, so the image goes with it.
        const noPass = await GET_RAW(`/admin/outpasses/${OUTPASS}/qr.png`, A);
        check('🔒 A returned outpass no longer renders a pass', noPass.status === 400, String(noPass.status));

        // ── Attachments ─────────────────────────────────────────────────────
        const attach = await POST_FILE('/admin/attachments', { as: admin, body: {
            entityType: 'HostelComplaint', entityId: COMPLAINT, docType: 'complaint',
        } });
        check('An attachment uploads and returns its stored filename',
            attach.status === 200 && !!attach.data?.storedName && attach.data.url.startsWith('/uploads/hostel-docs/'),
            attach.message);

        const attachedComplaint = await PUT(`/admin/complaints/${COMPLAINT}`, { ...A, body: {} });
        void attachedComplaint;
        const withAttachment = await POST('/admin/complaints', { ...A, body: {
            hostel: BOYS, category: 'room', description: 'Broken window, photo attached',
            attachments: [attach.data.storedName],
        } });
        check('A complaint can be raised carrying that attachment',
            withAttachment.status === 200 && withAttachment.data.attachments?.length === 1,
            withAttachment.message);

        const readBack = await GET(`/admin/complaints/${sid(withAttachment.data)}`, A);
        check('The complaint reads back with a usable attachment URL',
            readBack.status === 200 && readBack.data.attachmentUrls?.[0]?.startsWith('/uploads/hostel-docs/'),
            JSON.stringify(readBack.data?.attachmentUrls));

        check('The attachment is also registered in the documents register',
            (await HostelDocument.countDocuments({ school: schoolId, entityType: 'HostelComplaint' })) > 0);

        // A resident attaching evidence to their own complaint.
        const stuComplaintForAttach = await POST('/student/complaints', { as: boy3, body: {
            category: 'room', description: 'Tap dripping',
        } });
        const stuAttach = await POST_FILE('/student/attachments', { as: boy3, body: {
            entityType: 'HostelComplaint', entityId: sid(stuComplaintForAttach.data),
        } });
        check('A resident can attach a photo to their own complaint',
            stuAttach.status === 200 && !!stuAttach.data?.storedName, stuAttach.message);

        const stuAttachForeign = await POST_FILE('/student/attachments', { as: boy1, body: {
            entityType: 'HostelComplaint', entityId: sid(stuComplaintForAttach.data),
        } });
        check('🔒 A resident cannot attach to someone else\'s complaint',
            stuAttachForeign.status === 404, `${stuAttachForeign.status} ${stuAttachForeign.message}`);

        const badEntity = await POST_FILE('/student/attachments', { as: boy3, body: {
            entityType: 'User', entityId: sid(boy1._id),
        } });
        check('🔒 Attachments are refused on unsupported record types',
            badEntity.status === 400, badEntity.message);

        // Incidents carry evidence the same way.
        const incAttach = await POST_FILE('/admin/attachments', { as: admin, body: {
            entityType: 'HostelIncident', entityId: sid(incident.data), docType: 'incident',
        } });
        const incWith = await PUT(`/admin/incidents/${sid(incident.data)}`, { ...A, body: {
            attachments: [incAttach.data.storedName],
        } });
        check('An incident can carry attachments',
            incWith.status === 200 && incWith.data.attachments?.length === 1, incWith.message);
        const incRead = await GET(`/admin/incidents/${sid(incident.data)}`, A);
        check('The incident reads back with a usable attachment URL',
            incRead.data?.attachmentUrls?.[0]?.startsWith('/uploads/hostel-docs/'),
            JSON.stringify(incRead.data?.attachmentUrls));

        // ══ 11. TENANT ISOLATION & PERMISSIONS ══════════════════════════════
        section('School isolation & permissions');

        const foreignList = await GET('/admin/hostels', { as: otherAdmin });
        check('🔒 Another school sees none of these hostels',
            foreignList.status === 200 && foreignList.data.data.length === 0,
            String(foreignList.data?.data?.length));

        const foreignRead = await GET(`/admin/hostels/${BOYS}`, { as: otherAdmin });
        check('🔒 Another school cannot read this hostel by id', foreignRead.status === 404, String(foreignRead.status));

        const foreignWrite = await PUT(`/admin/hostels/${BOYS}`, { as: otherAdmin, body: { name: 'Hijacked' } });
        check('🔒 Another school cannot write to this hostel', foreignWrite.status === 404, String(foreignWrite.status));

        const foreignAlloc = await POST('/admin/allocations', { as: otherAdmin, body: {
            student: sid(boy1._id), bed: BED1, academicYear: YEAR,
        } });
        check('🔒 Another school cannot allocate a bed here', foreignAlloc.status === 400, foreignAlloc.message);

        const noAuth = await GET('/admin/hostels');
        check('🔒 An unauthenticated request is refused', noAuth.status === 401, String(noAuth.status));

        // Module flag off ends access for everyone in the school.
        await School.findByIdAndUpdate(schoolId, { $set: { 'modules.hostel': false } });
        await require('../services/designationService').invalidate(schoolId);
        const disabled = await GET('/admin/hostels', A);
        check('🔒 Disabling the module blocks the whole surface',
            disabled.status === 403 && disabled.body?.code === 'MODULE_DISABLED',
            `${disabled.status} ${disabled.body?.code}`);
        const disabledStudent = await GET('/student/my-hostel', { as: boy1 });
        check('🔒 Disabling the module blocks the student portal too',
            disabledStudent.status === 403, String(disabledStudent.status));
        await School.findByIdAndUpdate(schoolId, { $set: { 'modules.hostel': true } });
        await require('../services/designationService').invalidate(schoolId);

        // ══ 12. REPORTS, SETTINGS & AUDIT ═══════════════════════════════════
        section('Reports, settings & audit');

        const settings = await GET('/admin/settings', A);
        check('Settings are created on first read', settings.status === 200 && !!settings.data._id, settings.message);

        const updateSettings = await PUT('/admin/settings', { ...A, body: {
            curfewTime: '23:00', maxRoomCapacity: 4, enforceGenderRestriction: false,
        } });
        check('Settings can be changed', updateSettings.status === 200 && updateSettings.data.curfewTime === '23:00',
            updateSettings.data?.curfewTime);

        // Prove the gender rule really is settings-driven: the same allocation
        // that was refused earlier must now succeed with the setting off, and be
        // refused again once it is restored.
        const girlAlloc = await HostelAllocation.findOne({ school: schoolId, student: sid(girl._id), status: 'active' }).lean();
        await POST(`/admin/allocations/${sid(girlAlloc._id)}/release`, { ...A, body: { reason: 'Test' } });
        const FREE_BOYS_BED = sid(room3.data.beds[1]);

        const genderOff = await POST('/admin/allocations', { ...A, body: {
            student: sid(girl._id), bed: FREE_BOYS_BED, academicYear: YEAR,
        } });
        check('🔒 With the gender rule off, the same allocation now succeeds',
            genderOff.status === 200, genderOff.message);

        await POST(`/admin/allocations/${sid(genderOff.data)}/release`, { ...A, body: { reason: 'Test' } });
        await PUT('/admin/settings', { ...A, body: { enforceGenderRestriction: true } });

        const genderBackOn = await POST('/admin/allocations', { ...A, body: {
            student: sid(girl._id), bed: FREE_BOYS_BED, academicYear: YEAR,
        } });
        check('🔒 Restoring the setting restores the refusal — the rule is not hard-coded',
            genderBackOn.status === 400 && /hostel/.test(genderBackOn.message || ''),
            genderBackOn.message);

        for (const type of ['occupancy', 'allocation', 'attendance', 'leave', 'outpass', 'fees',
                            'complaints', 'maintenance', 'incidents', 'discipline', 'movement',
                            'visitors', 'assets', 'mess', 'expenses', 'warden_activity', 'monthly_summary']) {
            const rep = await GET(`/admin/reports?type=${type}`, A);
            check(`Report "${type}" returns columns and rows`,
                rep.status === 200 && Array.isArray(rep.data?.columns) && Array.isArray(rep.data?.rows),
                rep.message);
        }
        const badReport = await GET('/admin/reports?type=nonsense', A);
        check('An unknown report type is refused', badReport.status === 400, badReport.message);

        const audit = await GET('/admin/audit?limit=200', A);
        const actions = new Set((audit.data?.data || []).map((a) => a.actionType));
        check('The audit trail captured the whole run',
            audit.status === 200 && audit.data.total > 25, `${audit.data?.total} entries`);
        check('🔒 Allocations, transfers, approvals and payments are all audited',
            ['allocate', 'transfer', 'approve', 'payment'].every((a) => actions.has(a)),
            [...actions].join(','));

        const diffed = (audit.data?.data || []).find((a) => a.actionType === 'discount' || a.before);
        check('Audit entries carry a before/after diff', !!diffed, '');

        const dash = await GET('/admin/dashboard', A);
        check('The dashboard reports live figures',
            dash.status === 200 && dash.data.totalHostels === 2 && dash.data.totalBeds > 0,
            `${dash.data?.totalHostels} hostels, ${dash.data?.totalBeds} beds`);
        check('The dashboard carries its charts',
            Array.isArray(dash.data?.charts?.occupancy) && Array.isArray(dash.data?.charts?.attendanceTrend), '');

        const tree = await GET('/admin/occupancy', A);
        check('The occupancy tree drills hostel → building → floor → room → bed',
            tree.status === 200 && tree.data.length === 2
            && tree.data[0].children?.[0]?.children?.[0]?.children?.[0]?.children?.length > 0,
            JSON.stringify(tree.data?.length));

        // ══ 13. DELETION SAFETY (spec §31) ══════════════════════════════════
        section('Deletion safety');

        const delOccupied = await DEL(`/admin/rooms/${ROOM3}`, A);
        check('🔒 A room with occupied beds cannot be deactivated', delOccupied.status === 400, delOccupied.message);

        const delHostel = await DEL(`/admin/hostels/${BOYS}`, A);
        check('🔒 A hostel with residents cannot be deactivated', delHostel.status === 400, delHostel.message);

        const delBed = await DEL(`/admin/beds/${BED3}`, A);
        check('🔒 An occupied bed cannot be removed', delBed.status === 400, delBed.message);

        const release = await POST(`/admin/allocations/${NEW_ALLOC1}/release`, { ...A, body: {
            reason: 'End of year', status: 'vacated',
        } });
        check('Release closes the allocation and reports what is outstanding',
            release.status === 200 && release.data.allocation.status === 'vacated'
            && release.data.outstandingDues > 0,
            JSON.stringify(release.data?.outstandingDues));

        const freedBed = await HostelBed.findById(BED3).lean();
        check('The released bed is available again',
            freedBed.status === 'available' && freedBed.student == null, freedBed.status);

        const keptHistory = await HostelAllocation.findById(NEW_ALLOC1).lean();
        check('🔒 The allocation record survives release', !!keptHistory && keptHistory.status === 'vacated');

        const keptAttendance = await HostelAttendance.countDocuments({ school: schoolId, student: sid(boy1._id) });
        check('🔒 Historical attendance survives the student leaving', keptAttendance > 0, String(keptAttendance));

        // ══ FINAL INVARIANTS ════════════════════════════════════════════════
        section('Final invariants');

        const beds = await HostelBed.find({ school: schoolId }).lean();
        const occupiedBeds = beds.filter((b) => b.status === 'occupied');
        const studentIds = occupiedBeds.map((b) => String(b.student));
        check('🔒 No two occupied beds share a student',
            new Set(studentIds).size === studentIds.length,
            `${studentIds.length} occupied, ${new Set(studentIds).size} distinct`);
        check('🔒 Every occupied bed names a student',
            occupiedBeds.every((b) => !!b.student), '');

        const actives = await HostelAllocation.find({ school: schoolId, status: { $in: ['pending', 'active'] } }).lean();
        const activeStudents = actives.map((a) => String(a.student));
        check('🔒 No student holds two active allocations',
            new Set(activeStudents).size === activeStudents.length,
            `${activeStudents.length} active, ${new Set(activeStudents).size} distinct`);

        const rooms = await HostelRoom.find({ school: schoolId }).lean();
        let counterOk = true;
        for (const r of rooms) {
            const real = beds.filter((b) => String(b.room) === String(r._id) && b.status === 'occupied').length;
            if ((r.occupiedBeds || 0) !== real) counterOk = false;
        }
        check('🔒 Every room occupancy counter matches its beds', counterOk, '');

        let capacityOk = true;
        for (const r of rooms) {
            const real = beds.filter((b) => String(b.room) === String(r._id) && b.status === 'occupied').length;
            if (real > (r.capacity || 0)) capacityOk = false;
        }
        check('🔒 No room exceeds its configured capacity', capacityOk, '');

        const crossSchool = await HostelAllocation.countDocuments({ school: f.otherId });
        check('🔒 Nothing was written into the other school', crossSchool === 0, String(crossSchool));

    } catch (e) {
        failed += 1;
        results.push(`\n  💥 Test run threw: ${e.stack || e.message}`);
    } finally {
        if (f) { try { await cleanup(f); } catch (e) { console.error('cleanup failed:', e.message); } }
        server.close();
    }

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  HOSTEL MANAGEMENT — END-TO-END TESTS');
    console.log('══════════════════════════════════════════════════════════');
    console.log(results.join('\n'));
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('══════════════════════════════════════════════════════════\n');
    process.exit(failed ? 1 : 0);
})();
