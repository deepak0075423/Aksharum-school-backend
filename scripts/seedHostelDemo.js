'use strict';
/**
 * Demo data for the Hostel module — every admin screen with something real on it.
 *
 *   node scripts/seedHostelDemo.js                   # (re)build "Hostel Demo School"
 *   node scripts/seedHostelDemo.js --school="Name"   # seed another TEST school
 *   node scripts/seedHostelDemo.js --clear           # remove what this script made
 *
 * By default it creates its own school, "Hostel Demo School", with an admin
 * (admin@hosteldemo.test / HostelDemo@123), forty-odd students and a dozen staff,
 * two hostels, and a few weeks of the life of a hostel: admissions, allocations,
 * roll calls, leave, outpasses, visitors, gate movements, messes, fees,
 * complaints, work orders, assets, incidents, discipline, documents and the
 * activity log. Nothing it writes touches any other school.
 *
 * Every person it creates has an @hosteldemo.test address; --clear removes those
 * accounts and every hostel row of the target school. Like the transport seed,
 * it refuses a school whose name does not say test/demo without --force.
 *
 * The records are consistent with each other the way the app keeps them: an
 * occupied bed names its student and allocation, a room's occupiedBeds is its
 * count, a returned leave has a departure and a return, an overdue outpass is
 * active past its expected return — so the screens can be judged on real
 * behaviour, not on numbers that disagree.
 */
require('dotenv').config();
require('../config/timezone');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('../db/orm');

const MODELS = ['School', 'User', 'StudentProfile', 'TeacherProfile', 'AcademicYear', 'Class', 'ClassSection',
    'Hostel', 'HostelBuilding', 'HostelFloor', 'HostelRoom', 'HostelBed', 'HostelAdmission', 'HostelAllocation',
    'HostelAllocationHistory', 'HostelAttendance', 'HostelLeave', 'HostelOutpass', 'HostelVisitor', 'HostelMovement',
    'HostelStaffAssignment', 'HostelMess', 'HostelMessMember', 'HostelMenu', 'HostelMessAttendance', 'HostelMessExpense',
    'HostelFeePlan', 'HostelFeeInvoice', 'HostelComplaint', 'HostelMaintenance', 'HostelAsset', 'HostelIncident',
    'HostelDiscipline', 'HostelDocument', 'HostelSettings', 'HostelAuditLog', 'HostelAnnouncement'];
MODELS.forEach((m) => { try { require(`../models/${m}`); } catch { /* optional (announcements) */ } });
const M = (n) => db.model(n);
const has = (k) => process.argv.includes(`--${k}`);
const arg = (k, d) => { const hit = process.argv.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d; };

const DOMAIN = 'hosteldemo.test';
const HOSTEL_MODELS = ['HostelAttendance', 'HostelAllocationHistory', 'HostelMessAttendance', 'HostelMessExpense',
    'HostelMenu', 'HostelMessMember', 'HostelMess', 'HostelMovement', 'HostelVisitor', 'HostelOutpass', 'HostelLeave',
    'HostelFeeInvoice', 'HostelFeePlan', 'HostelDiscipline', 'HostelIncident', 'HostelAsset', 'HostelMaintenance',
    'HostelComplaint', 'HostelDocument', 'HostelStaffAssignment', 'HostelAdmission', 'HostelAllocation', 'HostelBed',
    'HostelRoom', 'HostelFloor', 'HostelBuilding', 'Hostel', 'HostelAuditLog', 'HostelAnnouncement'];

/* ── time ─────────────────────────────────────────────────────────────────── */
const day = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d; };
const at = (n, hh, mm = 0) => { const d = day(n); d.setHours(hh, mm, 0, 0); return d; };
const pick = (a, i) => a[((i % a.length) + a.length) % a.length];

/* ── people ───────────────────────────────────────────────────────────────── */
const BOYS = ['Rohan Kumar', 'Amit Reddy', 'Varun Lal', 'Dev Tomar', 'Kabir Mehta', 'Ishaan Verma', 'Aarav Sharma',
    'Arjun Singh', 'Vihaan Gupta', 'Aditya Rao', 'Reyansh Patel', 'Sai Krishna', 'Krish Malhotra', 'Aryan Joshi',
    'Dhruv Bansal', 'Kunal Sethi', 'Manav Chopra', 'Nikhil Das', 'Pranav Iyer', 'Rahul Menon', 'Siddharth Bose',
    'Tanish Kapoor', 'Yash Agarwal', 'Zaid Khan'];
const GIRLS = ['Priya Sharma', 'Sneha Nair', 'Meera Khan', 'Riya Jain', 'Neha Singh', 'Diya Nair', 'Meera Iyer',
    'Ananya Das', 'Kavya Pillai', 'Ishita Roy', 'Pooja Mehta', 'Aditi Verma', 'Saanvi Gupta', 'Tara Reddy',
    'Nisha Kapoor', 'Kritika Sen', 'Mitali Joshi', 'Sara Thomas', 'Fatima Sheikh', 'Aisha Khan'];
const STAFF = [
    // name, role in the hostel, gender, shift, start, end
    ['Rahul Verma', 'warden', 'male', 'general', '10:00', '18:00'],
    ['Priya Sharma', 'warden', 'female', 'general', '10:00', '18:00'],
    ['Amit Reddy', 'assistant_warden', 'male', 'evening', '14:00', '22:00'],
    ['Sneha Nair', 'assistant_warden', 'female', 'morning', '06:00', '14:00'],
    ['Varun Lal', 'assistant_warden', 'male', 'morning', '06:00', '14:00'],
    ['Meera Khan', 'assistant_warden', 'female', 'evening', '14:00', '22:00'],
    ['Dev Tomar', 'floor_supervisor', 'male', 'night', '22:00', '06:00'],
    ['Ramesh Kumar', 'caretaker', 'male', 'general', '09:00', '17:00'],
    ['Suresh Nair', 'security', 'male', 'night', '22:00', '06:00'],
    ['Vikram Singh', 'security', 'male', 'morning', '06:00', '14:00'],
    ['Kavita Das', 'housekeeping', 'female', 'morning', '07:00', '15:00'],
    ['Mohan Lal', 'mess_staff', 'male', 'general', '06:00', '14:00'],
    ['Geeta Rao', 'maintenance', 'female', 'general', '09:00', '17:00'],
];

/* ── placeholder files, so a demo document opens and downloads ─────────────── */
const DOC_DIR = path.join(__dirname, '..', 'uploads', 'hostel-docs');
/** A one-page PDF that says what it is. */
function pdfOf(title) {
    const text = String(title).replace(/[()\\]/g, '');
    const stream = `BT /F1 22 Tf 72 760 Td (${text}) Tj ET\nBT /F1 12 Tf 72 730 Td (Hostel Demo School - sample document) Tj ET`;
    const objs = [
        '<</Type/Catalog/Pages 2 0 R>>',
        '<</Type/Pages/Kids[3 0 R]/Count 1>>',
        '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
        `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
        '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    ];
    let out = '%PDF-1.4\n'; const at = [];
    objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}
/** A plain tinted PNG (browsers show it whatever the extension says). */
function pngOf(w = 240, h = 160, rgb = [199, 210, 254]) {
    const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
    const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
    const raw = Buffer.concat(Array.from({ length: h }, () => row));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function placeholder(storedName, mime, title) {
    try {
        fs.mkdirSync(DOC_DIR, { recursive: true });
        const file = path.join(DOC_DIR, storedName);
        if (!fs.existsSync(file)) fs.writeFileSync(file, mime === 'application/pdf' ? pdfOf(title) : pngOf());
    } catch { /* a missing sample file only breaks that one preview */ }
}

async function findSchool() {
    const name = arg('school', null);
    if (name) {
        const s = await M('School').findOne({ name: new RegExp(name, 'i') }).lean();
        if (!s) throw new Error(`No school matching "${name}"`);
        if (!/test|demo|sample/i.test(s.name) && !has('force')) {
            throw new Error(`"${s.name}" does not look like a test school. Re-run with --force if you are sure.`);
        }
        return s;
    }
    let s = await M('School').findOne({ name: 'Hostel Demo School' }).lean();
    if (!s && !has('clear')) {
        s = (await M('School').create({
            name: 'Hostel Demo School', code: 'HDS', email: `office@${DOMAIN}`, city: 'Kolkata', state: 'West Bengal',
            board: 'CBSE', isActive: true,
            modules: { hostel: true, attendance: true, fees: true, leave: true, notification: true, document: true },
        })).toObject();
    }
    return s;
}

async function clear(S) {
    for (const n of HOSTEL_MODELS) {
        try { const r = await M(n).deleteMany({ school: S }); console.log(`  cleared ${n}: ${r?.deletedCount ?? '—'}`); } catch { /* model absent */ }
    }
    const users = await M('User').find({ school: S, email: new RegExp(`@${DOMAIN.replace('.', '\\.')}$`) }).select('_id').lean();
    const ids = users.map((u) => String(u._id));
    if (ids.length) {
        await M('StudentProfile').deleteMany({ user: { $in: ids } });
        await M('TeacherProfile').deleteMany({ user: { $in: ids } });
        await M('User').deleteMany({ _id: { $in: ids } });
    }
    console.log(`  removed ${ids.length} demo account(s)`);
}

async function main() {
    await db.connect();
    const school = await findSchool();
    if (!school) { console.log('Nothing to clear — no Hostel Demo School.'); return; }
    const S = String(school._id);
    console.log(`school: ${school.name} (${S})`);
    await clear(S);
    if (has('clear')) { console.log('done (cleared)'); return; }

    const password = await bcrypt.hash('HostelDemo@123', 10);
    const log = [];                                     // audit rows, written at the end
    const audit = (a) => log.push(a);

    /* ── the year, classes, admin ─────────────────────────────────────────── */
    let year = await M('AcademicYear').findOne({ school: S, status: 'active' }).lean();
    if (!year) {
        year = (await M('AcademicYear').create({
            school: S, yearName: '2026-27', startDate: new Date(2026, 3, 1), endDate: new Date(2027, 2, 31), status: 'active',
        })).toObject();
    }
    const Y = String(year._id);
    const classes = {};
    for (const n of [9, 10, 11, 12]) {
        let c = await M('Class').findOne({ school: S, academicYear: Y, classNumber: n }).lean();
        if (!c) c = (await M('Class').create({ school: S, academicYear: Y, classNumber: n, className: `Class ${n}`, status: 'active' })).toObject();
        let sec = await M('ClassSection').findOne({ school: S, class: c._id, sectionName: 'A' }).lean();
        if (!sec) {
            sec = (await M('ClassSection').create({
                school: S, class: c._id, academicYear: Y, sectionName: 'A', maxStudents: 40, status: 'active',
            })).toObject();
        }
        classes[n] = { cls: c, sec };
    }
    let admin = await M('User').findOne({ school: S, role: 'school_admin' }).lean();
    if (!admin) {
        admin = (await M('User').create({
            school: S, name: 'Admin Deepak', email: `admin@${DOMAIN}`, password, role: 'school_admin', isActive: true, isFirstLogin: false,
        })).toObject();
    }
    const A = String(admin._id);
    const ADMIN_NAME = admin.name;

    /* ── students ─────────────────────────────────────────────────────────── */
    const students = [];
    const mk = async (name, gender, i) => {
        const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${i}@${DOMAIN}`;
        const u = await M('User').create({ school: S, name, email, password, role: 'student', isActive: true, isFirstLogin: false });
        const cn = [9, 10, 11, 12][i % 4];
        await M('StudentProfile').create({
            user: u._id, school: S, gender, admissionNumber: `STU-${String(i + 1).padStart(3, '0')}`,
            rollNumber: String(10 + ((i * 7) % 40)), currentClass: classes[cn].cls._id, currentSection: classes[cn].sec._id,
        });
        students.push({ id: String(u._id), name, gender: gender === 'Male' ? 'male' : 'female', cls: cn, roll: String(10 + ((i * 7) % 40)) });
    };
    let k = 0;
    for (const n of BOYS) await mk(n, 'Male', k++);
    for (const n of GIRLS) await mk(n, 'Female', k++);
    const boys = students.filter((s) => s.gender === 'male');
    const girls = students.filter((s) => s.gender === 'female');

    /* ── staff (existing-employee model: teachers of the school) ───────────── */
    const staff = [];
    for (let i = 0; i < STAFF.length; i++) {
        const [name, role, gender, shift, start, end] = STAFF[i];
        const u = await M('User').create({
            school: S, name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.staff@${DOMAIN}`, password,
            role: 'teacher', isActive: true, isFirstLogin: false, phone: `+91 98${String(76543210 + i * 1111).slice(0, 8)}`,
        });
        await M('TeacherProfile').create({
            user: u._id, school: S, employeeId: `HST${String(i + 1).padStart(3, '0')}`, department: 'Hostel',
            staffType: 'non_teaching', gender, joiningDate: new Date(2024, i % 12, 5 + i),
        });
        staff.push({ id: String(u._id), name, role, gender, shift, start, end, phone: u.phone });
    }
    const wardenB = staff[0]; const wardenG = staff[1];

    /* ── settings ─────────────────────────────────────────────────────────── */
    // Upserted, never deleted: on a real test school (--school) the admin's own
    // settings are theirs, and --clear leaves them alone.
    await M('HostelSettings').findOneAndUpdate({ school: S }, { $set: {
        maxRoomCapacity: 6, entryTime: '06:00', exitTime: '21:00', curfewTime: '22:00',
        visitorFrom: '09:00', visitorTo: '18:00', visitorDays: ['Sat', 'Sun'], maxOutpassHours: 8,
        lateReturnGraceMinutes: 15, overdueAlertAfterMinutes: 30, feeDueDayOfMonth: 5, lateFeePerDay: 20,
        lateFeeGraceDays: 5, complaintSlaHours: 48, attendanceSessions: ['morning', 'night'],
        requiredAdmissionDocuments: ['id_proof', 'medical', 'parent_authorization'],
    } }, { upsert: true, new: true });

    /* ── hostels, buildings, floors, rooms, beds ──────────────────────────── */
    const LAYOUT = [
        { key: 'boys', name: 'Boys Hostel', code: 'BH', type: 'boys', gender: 'male', warden: wardenB, buildings: [
            { name: 'Building 1', code: 'B1', floors: [
                { name: 'Ground Floor', n: 0, rooms: [['101', 'double', 2], ['102', 'triple', 3], ['103', 'double', 2], ['104', 'four_bed', 4]] },
                { name: 'First Floor', n: 1, rooms: [['201', 'triple', 3], ['202', 'double', 2], ['203', 'single', 1]] },
            ] },
            { name: 'Building 2', code: 'B2', floors: [
                { name: 'Ground Floor', n: 0, rooms: [['105', 'double', 2], ['106', 'triple', 3]] },
                { name: 'First Floor', n: 1, rooms: [['204', 'double', 2], ['205', 'single', 1]] },
            ] },
        ] },
        { key: 'girls', name: 'Girls Hostel', code: 'GH', type: 'girls', gender: 'female', warden: wardenG, buildings: [
            { name: 'Block A', code: 'GA', floors: [
                { name: 'Ground Floor', n: 0, rooms: [['101', 'double', 2], ['102', 'triple', 3], ['103', 'double', 2]] },
                { name: 'First Floor', n: 1, rooms: [['201', 'triple', 3], ['202', 'double', 2], ['203', 'dormitory', 6]] },
            ] },
        ] },
    ];
    const H = {};
    const allBeds = [];
    for (const h of LAYOUT) {
        const hostel = await M('Hostel').create({
            school: S, name: h.name, code: h.code, hostelType: h.type, gender: h.gender, city: 'Kolkata',
            contactNumber: '+91 98765 43210', capacity: 60, warden: h.warden.id, status: 'active',
            entryTime: '06:00', exitTime: '21:00', curfewTime: '22:00', facilities: ['wifi', 'laundry', 'study hall'],
            createdBy: A,
        });
        audit({ at: -40, hostel: hostel._id, actionType: 'create', entityType: 'Hostel', entityId: hostel._id,
            description: `Created hostel ${h.name} (${h.code})`, after: { name: h.name, status: 'active' } });
        H[h.key] = { doc: hostel, rooms: [], beds: [] };
        for (const b of h.buildings) {
            const building = await M('HostelBuilding').create({ school: S, hostel: hostel._id, name: b.name, code: b.code, createdBy: A });
            audit({ at: -39, hostel: hostel._id, actionType: 'create', entityType: 'HostelBuilding', entityId: building._id,
                description: `Added building ${b.name} to ${h.name}` });
            for (const f of b.floors) {
                const floor = await M('HostelFloor').create({
                    school: S, hostel: hostel._id, building: building._id, name: f.name, floorNumber: f.n, code: `F${f.n + 1}`, createdBy: A,
                });
                for (const [no, type, cap] of f.rooms) {
                    const room = await M('HostelRoom').create({
                        school: S, hostel: hostel._id, building: building._id, floor: floor._id,
                        roomNumber: `Room ${no}`, code: `R-${no}${h.key === 'girls' ? 'G' : ''}`, roomType: type, capacity: cap,
                        bedCount: cap, facilities: ['fan', 'study table', 'cupboard'], createdBy: A,
                    });
                    audit({ at: -38, hostel: hostel._id, actionType: 'create', entityType: 'HostelRoom', entityId: room._id,
                        description: `Added room Room ${no} with ${cap} bed(s)` });
                    const beds = [];
                    for (let n = 1; n <= cap; n++) {
                        const bed = await M('HostelBed').create({
                            school: S, hostel: hostel._id, building: building._id, floor: floor._id, room: room._id,
                            bedNumber: String(n), code: `B-${no}${h.key === 'girls' ? 'G' : ''}-${n}`,
                            bedType: type === 'dormitory' ? 'bunk_lower' : 'single', status: 'available', createdBy: A,
                        });
                        beds.push(bed.toObject());
                    }
                    const entry = { room: room.toObject(), beds, hostel: hostel.toObject(), building: building.toObject(), floor: floor.toObject() };
                    H[h.key].rooms.push(entry);
                    for (const bd of beds) { const x = { bed: bd, ...entry }; H[h.key].beds.push(x); allBeds.push(x); }
                }
            }
        }
    }

    /* ── staff assignments ────────────────────────────────────────────────── */
    const posts = [];
    for (let i = 0; i < staff.length; i++) {
        const s = staff[i];
        const hk = s.gender === 'female' ? 'girls' : 'boys';
        const firstRoom = H[hk].rooms[0];
        posts[i] = await M('HostelStaffAssignment').create({
            school: S, hostel: H[hk].doc._id, building: firstRoom.building._id,
            floor: s.role === 'floor_supervisor' ? firstRoom.floor._id : null,
            staff: s.id, role: s.role, shift: s.shift, shiftStart: s.start, shiftEnd: s.end,
            fromDate: i < 11 ? new Date(2024, (i * 2) % 12, 5 + i) : day(-12),
            status: i === 12 ? 'inactive' : 'active', isActive: i !== 12, toDate: i === 12 ? day(-3) : null, createdBy: A,
        });
        audit({ at: -35 + i, hostel: H[hk].doc._id, actionType: 'assign', entityType: 'HostelStaffAssignment',
            description: `Assigned ${s.name} as ${s.role.replace(/_/g, ' ')} at ${H[hk].doc.name}`, after: { role: s.role } });
    }

    /* ── allocations (occupied beds), a few beds held back ────────────────── */
    const residents = [];
    const allocate = async (st, spot, i, status = 'active') => {
        const from = day(-(60 - i));
        const allocation = await M('HostelAllocation').create({
            school: S, student: st.id, academicYear: Y, hostel: spot.hostel._id, building: spot.building._id,
            floor: spot.floor._id, room: spot.room._id, bed: spot.bed._id, fromDate: from, status,
            presence: 'in', allocatedBy: A, createdBy: A, allocationMode: i % 3 ? 'manual' : 'auto',
        });
        if (status === 'active') {
            await M('HostelBed').updateOne({ _id: spot.bed._id }, { $set: { status: 'occupied', student: st.id, allocation: allocation._id, allocationDate: from } });
            spot.bed.status = 'occupied';
        } else {
            await M('HostelBed').updateOne({ _id: spot.bed._id }, { $set: { status: 'reserved' } });
            spot.bed.status = 'reserved';
        }
        await M('HostelAllocationHistory').create({
            school: S, student: st.id, allocation: allocation._id, academicYear: Y, action: 'allocated',
            toHostel: spot.hostel._id, toRoom: spot.room._id, toBed: spot.bed._id,
            toLabel: `${spot.hostel.name} · ${spot.room.roomNumber} · Bed ${spot.bed.bedNumber}`, studentName: st.name,
            effectiveDate: from, performedBy: A, performedByName: ADMIN_NAME,
        });
        audit({ at: -(60 - i), hostel: spot.hostel._id, actionType: 'allocate', entityType: 'HostelAllocation', entityId: allocation._id,
            description: `Allocated ${st.name} to ${spot.room.roomNumber} · Bed ${spot.bed.bedNumber}`,
            after: { room: spot.room.roomNumber, bed: spot.bed.bedNumber } });
        const r = { st, spot, allocation: allocation.toObject() };
        if (status === 'active') residents.push(r);
        return r;
    };
    // Boys: the first 20 boys take the first 20 boys' beds; room 205 goes to maintenance.
    const boysBeds = H.boys.beds.filter((x) => x.room.roomNumber !== 'Room 205');
    for (let i = 0; i < 20; i++) await allocate(boys[i], boysBeds[i], i);
    await allocate(boys[20], boysBeds[20], 20, 'pending');
    const girlsBeds = H.girls.beds;
    for (let i = 0; i < 14; i++) await allocate(girls[i], girlsBeds[i], i);
    await allocate(girls[14], girlsBeds[14], 14, 'pending');
    // A room under repair and a held bed.
    const r205 = H.boys.rooms.find((x) => x.room.roomNumber === 'Room 205');
    await M('HostelRoom').updateOne({ _id: r205.room._id }, { $set: { status: 'maintenance' } });
    await M('HostelBed').updateMany({ room: r205.room._id }, { $set: { status: 'maintenance' } });
    await M('HostelBed').updateOne({ _id: girlsBeds[16].bed._id }, { $set: { status: 'reserved', remarks: 'Held for a transfer' } });
    // Room occupancy figures follow the beds.
    for (const hk of ['boys', 'girls']) {
        for (const e of H[hk].rooms) {
            const occ = await M('HostelBed').countDocuments({ room: e.room._id, status: 'occupied' });
            const st = e.room.status === 'maintenance' || e.room.roomNumber === 'Room 205' && hk === 'boys' ? 'maintenance'
                : occ >= e.room.capacity ? 'full' : occ > 0 ? 'partially_occupied' : 'available';
            await M('HostelRoom').updateOne({ _id: e.room._id }, { $set: { occupiedBeds: occ, status: st } });
        }
    }
    // A vacated stay, for the history tab.
    const gone = boys[22];
    const goneSpot = H.boys.beds.find((x) => x.room.roomNumber === 'Room 204' && x.bed.bedNumber === '2');
    const gAlloc = await M('HostelAllocation').create({
        school: S, student: gone.id, academicYear: Y, hostel: goneSpot.hostel._id, building: goneSpot.building._id,
        floor: goneSpot.floor._id, room: goneSpot.room._id, bed: goneSpot.bed._id, fromDate: day(-120), toDate: day(-20),
        vacatedDate: day(-20), status: 'vacated', presence: 'in', allocatedBy: A, vacatedBy: A, createdBy: A,
    });
    await M('HostelAllocationHistory').create({
        school: S, student: gone.id, allocation: gAlloc._id, academicYear: Y, action: 'vacated',
        fromHostel: goneSpot.hostel._id, fromRoom: goneSpot.room._id, fromBed: goneSpot.bed._id,
        fromLabel: `${goneSpot.hostel.name} · ${goneSpot.room.roomNumber} · Bed 2`, studentName: gone.name,
        reason: 'Moved to day scholar', effectiveDate: day(-20), performedBy: A, performedByName: ADMIN_NAME,
    });

    // Presence: a few out on outpasses, a few away on leave.
    const byName = Object.fromEntries(residents.map((r) => [r.st.name, r]));
    const setPresence = (n, p) => M('HostelAllocation').updateOne({ _id: byName[n].allocation._id }, { $set: { presence: p } });
    for (const n of ['Aarav Sharma', 'Kunal Sethi', 'Ananya Das']) await setPresence(n, 'out');
    for (const n of ['Varun Lal', 'Kavya Pillai']) await setPresence(n, 'on_leave');

    /* ── admissions ───────────────────────────────────────────────────────── */
    const admissionPlan = [
        ...residents.slice(0, 8).map((r) => ['completed', r]),
        ['pending_approval', { st: boys[21] }], ['pending_approval', { st: girls[15] }], ['applied', { st: girls[16] }],
        ['rejected', { st: boys[23] }], ['waitlisted', { st: girls[17] }], ['waitlisted', { st: girls[18] }],
    ];
    for (let i = 0; i < admissionPlan.length; i++) {
        const [status, r] = admissionPlan[i];
        const girl = girls.some((g) => g.id === r.st.id);
        const hostel = H[girl ? 'girls' : 'boys'].doc;
        const appliedAt = at(-(50 - i * 3), 11, 20);
        await M('HostelAdmission').create({
            school: S, applicationNumber: `HA-2609-${String(i + 1).padStart(4, '0')}`, student: r.st.id, academicYear: Y,
            hostel: hostel._id, preferredRoomType: pick(['double', 'single', 'triple', 'double'], i),
            status, appliedAt, appliedBy: A, reviewedBy: ['applied', 'pending_approval'].includes(status) ? null : A,
            reviewedAt: ['applied', 'pending_approval'].includes(status) ? null : at(-(48 - i * 3), 15),
            waitlistPosition: status === 'waitlisted' ? (i % 2) + 1 : 0, allocation: r.allocation?._id || null,
            guardianName: 'Parent', guardianPhone: '+91 90000 00000', reason: 'Distance from home',
            decisionRemark: status === 'rejected' ? 'Incomplete medical form' : '', createdBy: A,
        });
    }

    /* ── attendance: today's morning roll, last night's roll ──────────────── */
    const today = day(0); const yesterday = day(-1);
    const onLeave = new Set(['Varun Lal', 'Kavya Pillai']);
    const outNow = new Set(['Aarav Sharma', 'Kunal Sethi', 'Ananya Das']);
    for (let i = 0; i < residents.length; i++) {
        const r = residents[i];
        const status = onLeave.has(r.st.name) ? 'on_leave' : outNow.has(r.st.name) ? 'excused'
            : i % 17 === 5 ? 'absent' : i % 13 === 7 ? 'late' : 'present';
        await M('HostelAttendance').create({
            school: S, hostel: r.spot.hostel._id, student: r.st.id, allocation: r.allocation._id,
            building: r.spot.building._id, floor: r.spot.floor._id, room: r.spot.room._id,
            date: today, session: 'morning', status, markedBy: A, markedAt: at(0, 7, 5),
        });
        await M('HostelAttendance').create({
            school: S, hostel: r.spot.hostel._id, student: r.st.id, allocation: r.allocation._id,
            building: r.spot.building._id, floor: r.spot.floor._id, room: r.spot.room._id,
            date: yesterday, session: 'night', status: onLeave.has(r.st.name) ? 'on_leave' : i % 11 === 3 ? 'absent' : 'present',
            markedBy: A, markedAt: at(-1, 21, 40),
            ...(i === 4 ? { previousStatus: 'absent', correctedBy: A, correctedAt: at(0, 8), correctionReason: 'Was at the library', approvalStatus: 'pending' } : {}),
        });
    }

    /* ── leave ────────────────────────────────────────────────────────────── */
    const LEAVES = [
        ['Rohan Kumar', 'home', -2, 3, 'pending'], ['Priya Sharma', 'weekend', -4, 1, 'approved'],
        ['Amit Reddy', 'medical', -6, 2, 'returned'], ['Sneha Nair', 'home', -10, 4, 'rejected'],
        ['Varun Lal', 'emergency', -3, 3, 'active'], ['Meera Khan', 'home', -15, 2, 'returned'],
        ['Dev Tomar', 'weekend', -18, 1, 'returned'], ['Kavya Pillai', 'home', -1, 5, 'active'],
        ['Riya Jain', 'weekend', 2, 1, 'pending'], ['Neha Singh', 'medical', 3, 2, 'pending'],
        ['Kabir Mehta', 'holiday', -25, 4, 'returned'], ['Diya Nair', 'home', 5, 3, 'approved'],
    ];
    const leaveIds = {};
    for (let i = 0; i < LEAVES.length; i++) {
        const [n, type, start, len, status] = LEAVES[i];
        const r = byName[n];
        const from = day(start); const to = day(start + len - 1);
        const l = await M('HostelLeave').create({
            school: S, hostel: r.spot.hostel._id, student: r.st.id, allocation: r.allocation._id, academicYear: Y,
            leaveNumber: `HLV-2609-${String(i + 1).padStart(4, '0')}`, leaveType: type, fromDate: from, toDate: to, totalDays: len,
            reason: pick(['Family function', 'Weekend at home', 'Doctor visit', 'Festival', 'Sibling wedding'], i),
            destination: 'Home', guardianName: 'Parent', guardianPhone: '+91 90000 00000', status,
            parentApprovalRequired: false,
            wardenApprovedBy: ['approved', 'active', 'returned'].includes(status) ? A : null,
            wardenApprovedAt: ['approved', 'active', 'returned'].includes(status) ? at(start - 1, 16) : null,
            departedAt: ['active', 'returned'].includes(status) ? at(start, 9) : null,
            returnedAt: status === 'returned' ? at(start + len, 18) : null,
            rejectedBy: status === 'rejected' ? A : null, rejectionReason: status === 'rejected' ? 'Exams week' : '',
            appliedBy: A, createdBy: A, createdAt: at(start - 3, 10),
        });
        leaveIds[n] = l._id;
    }

    /* ── outpasses ────────────────────────────────────────────────────────── */
    const OUTPASSES = [
        ['Rohan Kumar', 'day', 0, 'pending'], ['Priya Sharma', 'night', -1, 'approved'], ['Amit Reddy', 'medical', -2, 'returned'],
        ['Sneha Nair', 'day', -3, 'rejected'], ['Aarav Sharma', 'day', 0, 'active'], ['Meera Khan', 'academic', -4, 'returned'],
        ['Dev Tomar', 'emergency', -5, 'returned'], ['Kunal Sethi', 'market', 0, 'overdue'], ['Ananya Das', 'day', 0, 'active'],
        ['Riya Jain', 'day', 1, 'approved'], ['Kabir Mehta', 'market', -6, 'returned'], ['Neha Singh', 'medical', -7, 'returned'],
        ['Ishaan Verma', 'day', 0, 'pending'], ['Diya Nair', 'academic', 0, 'pending'], ['Arjun Singh', 'day', -8, 'returned'],
        ['Vihaan Gupta', 'night', -9, 'returned'], ['Tara Reddy', 'day', 1, 'approved'], ['Aditya Rao', 'market', 1, 'pending'],
    ];
    const opIds = {};
    for (let i = 0; i < OUTPASSES.length; i++) {
        const [n, type, d, status] = OUTPASSES[i];
        const r = byName[n];
        const dep = at(d, 10 + (i % 6), 15); const ret = at(d, 17 + (i % 3), 0);
        const o = await M('HostelOutpass').create({
            school: S, hostel: r.spot.hostel._id, student: r.st.id, allocation: r.allocation._id,
            outpassNumber: `OP-26${String(9).padStart(2, '0')}${String(20 + i).padStart(2, '0')}-${String(i + 1).padStart(4, '0')}`,
            outpassType: type, purpose: pick(['Personal work', 'Doctor visit', 'Competition', 'Shopping', 'Coaching class'], i),
            destination: 'City', departureDate: day(d), expectedDepartureTime: `${String(10 + (i % 6)).padStart(2, '0')}:15`,
            expectedReturnTime: `${String(17 + (i % 3)).padStart(2, '0')}:00`,
            expectedReturnAt: status === 'overdue' ? at(0, 8, 0) : ret,
            actualDepartureAt: ['active', 'returned', 'overdue'].includes(status) ? dep : null,
            actualReturnAt: status === 'returned' ? new Date(ret.getTime() + (i % 4 === 0 ? 40 : -25) * 60e3) : null,
            lateReturnMinutes: status === 'returned' && i % 4 === 0 ? 25 : 0,
            status, approvedBy: ['approved', 'active', 'returned', 'overdue'].includes(status) ? A : null,
            approvedAt: ['approved', 'active', 'returned', 'overdue'].includes(status) ? at(d - 1, 18) : null,
            qrToken: ['approved', 'active', 'overdue'].includes(status) ? crypto.randomBytes(24).toString('hex') : '',
            rejectionReason: status === 'rejected' ? 'Not a visiting day' : '', requestedBy: A, createdBy: A, createdAt: at(d - 1, 12),
        });
        opIds[n] = o._id;
    }

    /* ── visitors ─────────────────────────────────────────────────────────── */
    const VISITORS = [
        ['Rajesh Kumar', 'Parent', 'Rohan Kumar', 0, 'checked_out'], ['Sunita Sharma', 'Guardian', 'Priya Sharma', 0, 'checked_out'],
        ['Sunil Patel', 'Relative', 'Sneha Nair', 0, 'checked_in'], ['Meena Iyer', 'Official', null, -1, 'checked_out'],
        ['Vikram Singh', 'Delivery', null, -1, 'checked_out'], ['Anjali Desai', 'Parent', 'Varun Lal', -2, 'checked_out'],
        ['Mohammed Khan', 'Contractor', null, -2, 'checked_out'], ['Lakshmi Nair', 'Parent', 'Diya Nair', 0, 'checked_in'],
        ['Rakesh Jain', 'Parent', 'Riya Jain', 0, 'pending'], ['Farah Khan', 'Guardian', 'Meera Khan', 1, 'approved'],
        ['Gopal Reddy', 'Parent', 'Amit Reddy', -3, 'checked_out'], ['Suman Tomar', 'Parent', 'Dev Tomar', -3, 'checked_out'],
        ['Harish Mehta', 'Relative', 'Kabir Mehta', -4, 'rejected'], ['Rekha Singh', 'Parent', 'Neha Singh', 0, 'checked_in'],
        ['Sanjay Verma', 'Guardian', 'Ishaan Verma', 1, 'pending'], ['Asha Das', 'Parent', 'Ananya Das', -5, 'checked_out'],
        ['Kiran Rao', 'Official', null, -5, 'checked_out'], ['Deepa Pillai', 'Parent', 'Kavya Pillai', -6, 'checked_out'],
        ['Naveen Gupta', 'Relative', 'Vihaan Gupta', -7, 'checked_out'], ['Pooja Roy', 'Parent', 'Ishita Roy', -8, 'checked_out'],
        ['Arvind Joshi', 'Parent', 'Aryan Joshi', -9, 'checked_out'], ['Nitin Bansal', 'Guardian', 'Dhruv Bansal', -10, 'checked_out'],
        ['Ramesh Sen', 'Delivery', null, -10, 'checked_out'], ['Uma Menon', 'Parent', 'Rahul Menon', -11, 'checked_out'],
        ['Kamal Bose', 'Parent', 'Siddharth Bose', 2, 'approved'], ['Ritu Kapoor', 'Relative', 'Nisha Kapoor', -12, 'checked_out'],
    ];
    for (let i = 0; i < VISITORS.length; i++) {
        const [vn, rel, sn, d, status] = VISITORS[i];
        const r = (sn && byName[sn]) || residents[i % residents.length];
        const inAt = at(d, 9 + (i % 7), 10 + (i % 4) * 10);
        const v = await M('HostelVisitor').create({
            school: S, hostel: r.spot.hostel._id, student: r.st.id, passNumber: `GP${String(i + 1).padStart(3, '0')}`,
            visitorName: vn, mobile: `+91 9${String(8765432100 + i * 1234567).slice(0, 9)}`, relationship: rel,
            purpose: pick(['Personal meet', 'Fee discussion', 'Inspection', 'Parcel delivery', 'Maintenance work'], i),
            scheduledAt: inAt, entryTime: ['checked_in', 'checked_out'].includes(status) ? inAt : null,
            exitTime: status === 'checked_out' ? new Date(inAt.getTime() + (45 + (i % 5) * 20) * 60e3) : null,
            status, approvedBy: ['approved', 'checked_in', 'checked_out'].includes(status) ? A : null,
            rejectionReason: status === 'rejected' ? 'Not on the visitor list' : '',
            qrToken: ['approved', 'checked_in'].includes(status) ? crypto.randomBytes(24).toString('hex') : '',
            createdBy: A, createdAt: new Date(inAt.getTime() - 3600e3),
        });
        if (['checked_in', 'checked_out'].includes(status)) {
            await M('HostelMovement').create({ school: S, hostel: r.spot.hostel._id, visitor: v._id, personName: vn,
                direction: 'in', movementType: 'visitor', reference: v._id, referenceType: 'HostelVisitor', at: inAt, gate: 'Main Gate', recordedBy: A });
        }
    }
    // Two standing list entries.
    await M('HostelVisitor').create({ school: S, hostel: byName['Rohan Kumar'].spot.hostel._id, student: byName['Rohan Kumar'].st.id,
        visitorName: 'Rajesh Kumar', relationship: 'Parent', listType: 'authorized', isTemplate: true, status: 'approved', createdBy: A });
    await M('HostelVisitor').create({ school: S, hostel: byName['Kabir Mehta'].spot.hostel._id, student: byName['Kabir Mehta'].st.id,
        visitorName: 'Harish Mehta', relationship: 'Relative', listType: 'restricted', isTemplate: true, status: 'blocked', createdBy: A });

    /* ── gate movements over the last week ────────────────────────────────── */
    const GATES = ['Main Gate', 'East Gate', 'West Gate'];
    for (let i = 0; i < 40; i++) {
        const r = residents[(i * 5) % residents.length];
        const d = -(i % 7);
        const out = await M('HostelMovement').create({ school: S, hostel: r.spot.hostel._id, student: r.st.id,
            direction: 'out', movementType: 'gate', at: at(d, 8 + (i % 9), (i * 7) % 60), gate: pick(GATES, i), recordedBy: A });
        if (!(outNow.has(r.st.name) && d === 0)) {
            await M('HostelMovement').create({ school: S, hostel: r.spot.hostel._id, student: r.st.id,
                direction: 'in', movementType: 'gate', at: new Date(out.at.getTime() + (2 + (i % 4)) * 3600e3),
                gate: pick(GATES, i + 1), isLate: i % 9 === 0, lateMinutes: i % 9 === 0 ? 20 : 0, recordedBy: A });
        }
    }
    for (const n of ['Varun Lal', 'Kavya Pillai']) {
        const r = byName[n];
        await M('HostelMovement').create({ school: S, hostel: r.spot.hostel._id, student: r.st.id, direction: 'out',
            movementType: 'leave', reference: leaveIds[n], referenceType: 'HostelLeave', at: at(n === 'Varun Lal' ? -3 : -1, 9), gate: 'Main Gate', recordedBy: A });
    }
    for (const n of ['Aarav Sharma', 'Kunal Sethi', 'Ananya Das']) {
        const r = byName[n];
        await M('HostelMovement').create({ school: S, hostel: r.spot.hostel._id, student: r.st.id, direction: 'out',
            movementType: 'outpass', reference: opIds[n], referenceType: 'HostelOutpass', at: at(0, 10, 20), gate: 'Main Gate', recordedBy: A });
    }

    /* ── messes, members, menus, meals, expenses ──────────────────────────── */
    const MESSES = [
        ['Main Mess', 'MM', ['boys'], 'both', 140, staff[11]],
        ['Girls Mess', 'GM', ['girls'], 'veg', 120, staff[3]],
        ['Staff Mess', 'SM', ['boys', 'girls'], 'both', 40, staff[7]],
    ];
    const messes = [];
    for (const [name, code, hk, type, cap, inCharge] of MESSES) {
        const m = await M('HostelMess').create({
            school: S, hostels: hk.map((x) => H[x].doc._id), name, code, messType: type, capacity: cap,
            location: `${H[hk[0]].doc.name} ground floor`, inCharge: inCharge.id, vendorName: 'Annapurna Caterers',
            contractFrom: new Date(2026, 3, 1), contractTo: new Date(2027, 2, 31), contractAmount: 600000, createdBy: A,
        });
        messes.push(m.toObject());
    }
    for (let i = 0; i < residents.length; i++) {
        const r = residents[i];
        const mess = r.spot.hostel.name === 'Girls Hostel' ? messes[1] : messes[0];
        await M('HostelMessMember').create({
            school: S, mess: mess._id, student: r.st.id, hostel: r.spot.hostel._id, allocation: r.allocation._id,
            foodPreference: pick(['veg', 'non_veg', 'veg', 'eggetarian'], i), mealPlan: 'full',
            allergies: i % 9 === 0 ? ['peanuts'] : [], createdBy: A,
        });
        for (const meal of ['breakfast', 'lunch']) {
            await M('HostelMessAttendance').create({ school: S, mess: mess._id, student: r.st.id, hostel: r.spot.hostel._id,
                date: today, meal, status: onLeave.has(r.st.name) ? 'skipped' : 'taken', markedBy: A });
        }
    }
    const MENU = {
        breakfast: ['Poha, boiled egg, tea', 'Idli, sambar, coffee', 'Aloo paratha, curd', 'Upma, banana', 'Bread omelette', 'Puri sabzi', 'Dosa, chutney'],
        lunch: ['Rice, dal, paneer', 'Rajma chawal, salad', 'Veg biryani, raita', 'Chole, rice, roti', 'Fish curry, rice', 'Kadhi, rice', 'Chicken curry, roti'],
        dinner: ['Roti, mixed veg, dal', 'Egg curry, rice', 'Roti, aloo gobi', 'Pulao, dal fry', 'Roti, paneer butter masala', 'Khichdi, papad', 'Roti, chana masala'],
    };
    for (const m of messes.slice(0, 2)) {
        for (let dow = 0; dow < 7; dow++) {
            for (const meal of ['breakfast', 'lunch', 'dinner']) {
                await M('HostelMenu').create({ school: S, mess: m._id, isTemplate: true, dayOfWeek: dow, meal,
                    items: MENU[meal][dow].split(', '), estimatedCost: meal === 'breakfast' ? 40 : 70, createdBy: A });
            }
        }
    }
    const EXP = [['groceries', 42000], ['vegetables', 18500], ['dairy', 12400], ['gas', 6800], ['vendor_bill', 24860], ['salary', 20000]];
    for (const [mi, m] of messes.entries()) {
        for (let j = 0; j < EXP.length; j++) {
            const [cat, amt] = EXP[j];
            const scale = [1, 0.8, 0.35][mi];
            await M('HostelMessExpense').create({ school: S, mess: m._id, date: day(-(j * 3 + 1)), category: cat,
                amount: Math.round(amt * scale / 10) * 10, vendorName: 'Annapurna Caterers', recordedBy: A });
            await M('HostelMessExpense').create({ school: S, mess: m._id, date: new Date(day(0).getFullYear(), day(0).getMonth() - 1, 3 + j * 4), category: cat,
                amount: Math.round(amt * scale * (mi === 2 ? 0.9 : 1.08) / 10) * 10, vendorName: 'Annapurna Caterers', recordedBy: A });
        }
    }

    /* ── fees ─────────────────────────────────────────────────────────────── */
    const planHostel = await M('HostelFeePlan').create({ school: S, name: 'Hostel Fee', feeType: 'monthly', basis: 'room_type',
        amount: 5000, roomTypeRates: [{ roomType: 'single', amount: 6000 }, { roomType: 'double', amount: 5000 }, { roomType: 'triple', amount: 4500 },
            { roomType: 'four_bed', amount: 4200 }, { roomType: 'dormitory', amount: 3500 }], frequency: 'monthly', dueDayOfMonth: 5, createdBy: A });
    const planMess = await M('HostelFeePlan').create({ school: S, name: 'Mess Charges', feeType: 'mess', basis: 'flat', amount: 3000,
        frequency: 'monthly', dueDayOfMonth: 5, createdBy: A });
    await M('HostelFeePlan').create({ school: S, name: 'Security Deposit', feeType: 'security_deposit', basis: 'flat', amount: 10000,
        frequency: 'one_time', isRefundable: true, createdBy: A });
    const RATES = { single: 6000, double: 5000, triple: 4500, four_bed: 4200, dormitory: 3500 };
    let inv = 0;
    const cur = day(0); const months = [new Date(cur.getFullYear(), cur.getMonth() - 1, 1), new Date(cur.getFullYear(), cur.getMonth(), 1)];
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (let i = 0; i < residents.length; i++) {
        const r = residents[i];
        for (const [mi, mdate] of months.entries()) {
            for (const [plan, amount, feeType] of [[planHostel, RATES[r.spot.room.roomType] || 5000, 'monthly'], [planMess, 3000, 'mess']]) {
                inv += 1;
                const due = new Date(mdate.getFullYear(), mdate.getMonth(), 5);
                const paidAll = mi === 0 || i % 5 !== 1;
                const partial = mi === 1 && i % 7 === 3;
                const payments = paidAll && !partial ? [{ amount, mode: pick(['upi', 'cash', 'online'], i), receiptNumber: `HR-${inv}`, paidAt: new Date(due.getTime() - (i % 4) * 864e5), receivedBy: A }]
                    : partial ? [{ amount: Math.round(amount / 2), mode: 'upi', receiptNumber: `HR-${inv}`, paidAt: new Date(due.getTime() + 864e5), receivedBy: A }] : [];
                await M('HostelFeeInvoice').create({
                    school: S, invoiceNumber: `HF-${String(inv).padStart(4, '0')}`, student: r.st.id, hostel: r.spot.hostel._id,
                    allocation: r.allocation._id, academicYear: Y, feePlan: plan._id, feeType,
                    period: { month: mdate.getMonth() + 1, year: mdate.getFullYear(), label: `${MON[mdate.getMonth()]} ${mdate.getFullYear()}` },
                    amount, dueDate: due, payments, generatedBy: A, createdAt: new Date(mdate.getFullYear(), mdate.getMonth(), 1, 9),
                });
            }
        }
    }
    // A refunded security deposit for the student who left.
    const refund = await M('HostelFeeInvoice').create({ school: S, invoiceNumber: `HF-${String(++inv).padStart(4, '0')}`, student: gone.id,
        hostel: H.boys.doc._id, academicYear: Y, feeType: 'security_deposit', amount: 10000, dueDate: day(-110),
        payments: [{ amount: 10000, mode: 'bank_transfer', receiptNumber: `HR-${inv}`, paidAt: day(-112), receivedBy: A }],
        isRefundable: true, generatedBy: A, createdAt: day(-115) });
    await M('HostelFeeInvoice').updateOne({ _id: refund._id }, { $set: { refundedAmount: 10000, refundedAt: day(-19), refundReference: 'NEFT-88213', status: 'refunded' } });

    /* ── complaints ───────────────────────────────────────────────────────── */
    const CPL = [
        ['AC not working', 'maintenance', 'high', 'open'], ['Food quality issue', 'mess', 'medium', 'in_progress'],
        ['Room cleaning delay', 'cleaning', 'low', 'resolved'], ['Water supply issue', 'facilities', 'high', 'open'],
        ['Gate pass delay', 'security', 'medium', 'in_progress'], ['Wi-Fi not working', 'internet', 'low', 'resolved'],
        ['Furniture damaged', 'facilities', 'medium', 'reopened'], ['Unhygienic bathroom', 'cleaning', 'high', 'rejected'],
        ['Fan making noise', 'maintenance', 'low', 'closed'], ['Cold food at dinner', 'mess', 'medium', 'closed'],
        ['Noise after lights out', 'security', 'medium', 'resolved'], ['Leaking tap', 'maintenance', 'medium', 'closed'],
        ['Dustbins not cleared', 'cleaning', 'low', 'closed'], ['Mosquito menace', 'facilities', 'medium', 'assigned'],
        ['Late breakfast', 'mess', 'low', 'resolved'], ['Broken window latch', 'room', 'medium', 'in_progress'],
        ['Hot water unavailable', 'facilities', 'high', 'open'], ['Laundry delay', 'facilities', 'low', 'closed'],
        ['Rude staff behaviour', 'staff', 'high', 'resolved'], ['Power cut in block', 'maintenance', 'urgent', 'closed'],
        ['Menu repetition', 'mess', 'low', 'closed'], ['Lost & found request', 'other', 'low', 'closed'],
        ['Study room lights', 'maintenance', 'medium', 'resolved'], ['Door lock jammed', 'room', 'high', 'in_progress'],
        ['Water cooler dirty', 'cleaning', 'medium', 'assigned'], ['Parcel not delivered', 'security', 'low', 'open'],
    ];
    const ASSIGNEES = [staff[7], staff[3], staff[4], staff[2], staff[8]];
    for (let i = 0; i < CPL.length; i++) {
        const [subject, category, priority, status] = CPL[i];
        const r = residents[(i * 3) % residents.length];
        const created = at(-(i % 12) - 1, 9 + (i % 9), (i * 13) % 60);
        const due = new Date(created.getTime() + 48 * 3600e3);
        const done = ['resolved', 'closed'].includes(status);
        await M('HostelComplaint').create({
            school: S, hostel: r.spot.hostel._id, room: r.spot.room._id, student: r.st.id,
            ticketNumber: `C${String(i + 1).padStart(4, '0')}`, category, priority, subject,
            description: `${subject} reported in ${r.spot.room.roomNumber}.`,
            assignedTo: status === 'open' ? null : ASSIGNEES[i % ASSIGNEES.length].id, assignedAt: status === 'open' ? null : created,
            status, dueAt: due, resolution: done ? 'Fixed and verified with the student' : '',
            resolutionDate: done ? new Date(created.getTime() + (20 + (i % 30)) * 3600e3) : null, resolvedBy: done ? A : null,
            reopenCount: status === 'reopened' ? 1 : 0, raisedBy: r.st.id, raisedByRole: 'student', createdAt: created,
        });
    }

    /* ── maintenance work orders ──────────────────────────────────────────── */
    const WO = [
        ['AC not cooling', 'ac', 'corrective', 'high', 'open'], ['Water leakage in washroom', 'plumbing', 'corrective', 'medium', 'in_progress'],
        ['Room painting', 'room', 'scheduled', 'low', 'assigned'], ['Mess exhaust fan repair', 'electrical', 'corrective', 'high', 'open'],
        ['Garden water line issue', 'plumbing', 'corrective', 'medium', 'completed'], ['Bed frame repair', 'furniture', 'corrective', 'low', 'completed'],
        ['Common area cleaning', 'cleaning', 'scheduled', 'low', 'assigned'], ['Sensor light installation', 'electrical', 'preventive', 'medium', 'in_progress'],
        ['Fire extinguisher refill', 'other', 'preventive', 'high', 'open'], ['Water tank cleaning', 'plumbing', 'preventive', 'medium', 'completed'],
        ['Ceiling fan wobble', 'fan', 'corrective', 'low', 'completed'], ['Router replacement', 'internet', 'corrective', 'medium', 'completed'],
        ['Bathroom tiles', 'bathroom', 'corrective', 'medium', 'on_hold'], ['Door hinge fix', 'furniture', 'corrective', 'low', 'completed'],
        ['Geyser servicing', 'electrical', 'preventive', 'medium', 'completed'], ['Pest control', 'cleaning', 'preventive', 'medium', 'completed'],
        ['Window glass replacement', 'room', 'corrective', 'high', 'in_progress'], ['Study lamp wiring', 'electrical', 'corrective', 'low', 'completed'],
        ['Drain unclogging', 'plumbing', 'corrective', 'high', 'completed'], ['Almirah lock', 'furniture', 'corrective', 'low', 'completed'],
    ];
    for (let i = 0; i < 42; i++) {
        const [title, category, type, priority, status0] = WO[i % WO.length];
        const status = i >= WO.length ? pick(['completed', 'completed', 'open', 'in_progress', 'assigned', 'completed', 'cancelled'], i) : status0;
        const e = pick([...H.boys.rooms, ...H.girls.rooms], i * 2);
        const created = at(-((i * 2) % 45) - 1, 10, (i * 11) % 60);
        const sched = type !== 'corrective' ? day(((i % 3) - 1) * 6 + 2) : new Date(created.getTime() + (2 + (i % 5)) * 864e5);
        await M('HostelMaintenance').create({
            school: S, hostel: e.hostel._id, building: e.building._id, floor: e.floor._id, room: e.room._id,
            requestNumber: `WO${String(i + 1).padStart(4, '0')}`, category, maintenanceType: type, priority,
            title, description: `${title} — ${e.room.roomNumber}, ${e.hostel.name}.`,
            technicianName: status === 'open' ? '' : pick(['Ramesh K.', 'Sneha N.', 'Amit R.', 'Vikram S.', 'Dev T.', 'Priya S.', 'Meera K.'], i),
            technician: status === 'open' ? null : pick(staff, i).id, scheduledDate: sched,
            startedAt: ['in_progress', 'completed', 'on_hold'].includes(status) ? new Date(created.getTime() + 864e5) : null,
            completedAt: status === 'completed' ? new Date(created.getTime() + 3 * 864e5) : null,
            estimatedCost: 500 + (i % 7) * 350, actualCost: status === 'completed' ? 450 + (i % 7) * 300 : 0,
            recurEveryDays: type === 'preventive' ? 90 : 0, status, raisedBy: A, createdAt: created,
        });
    }

    /* ── assets ───────────────────────────────────────────────────────────── */
    const ASSETS = [
        ['Bunk Bed', 'bed', 'Wooden double decker'], ['Split AC', 'ac', '1.5 Ton - LG'], ['Water Heater', 'electronics', 'Geyser 25 Ltr'],
        ['Study Table', 'table', 'Single student table'], ['Ceiling Fan', 'fan', 'Havells 1200mm'], ['Mattress', 'mattress', 'Foam mattress'],
        ['Fire Extinguisher', 'fire_safety', 'ABC Type - 5kg'], ['Washing Machine', 'electronics', 'Semi-automatic'],
        ['Chair', 'chair', 'Plastic moulded'], ['Cupboard', 'cupboard', 'Steel almirah'], ['Refrigerator', 'kitchen', 'Double door 260L'],
        ['Water Purifier', 'kitchen', 'RO + UV'],
    ];
    const ASTATUS = ['in_room', 'in_room', 'in_room', 'issued', 'under_repair', 'in_room', 'in_room', 'damaged', 'in_room', 'returned', 'in_room', 'disposed'];
    for (let i = 0; i < 48; i++) {
        const [name, category, desc] = ASSETS[i % ASSETS.length];
        const status = pick(ASTATUS, i + Math.floor(i / 12));
        const e = pick([...H.boys.rooms, ...H.girls.rooms], i);
        const issued = status === 'issued' ? residents[i % residents.length] : null;
        const a = await M('HostelAsset').create({
            school: S, hostel: e.hostel._id, building: e.building._id, floor: e.floor._id,
            room: status === 'returned' ? null : e.room._id, name, assetCode: `AST-${String(i + 1).padStart(4, '0')}`, category,
            condition: status === 'damaged' ? 'damaged' : status === 'disposed' ? 'scrapped' : pick(['good', 'good', 'new', 'fair'], i),
            issuedTo: issued ? issued.st.id : null, issuedAt: issued ? day(-10) : null, status, remarks: desc,
            damageNote: status === 'damaged' ? 'Motor burnt out' : '', createdBy: A, createdAt: day(-(i % 50) - 1),
        });
        if (i % 4 === 0) {
            await M('HostelMaintenance').create({ school: S, hostel: e.hostel._id, room: e.room._id, asset: a._id,
                requestNumber: `WO-A${String(i + 1).padStart(3, '0')}`, category: 'other', maintenanceType: 'preventive', priority: 'low',
                title: `${name} check`, description: `Routine check of ${name}`, status: 'completed',
                completedAt: day(-(i % 40) - 2), createdAt: day(-(i % 40) - 3),
                resolution: pick(['Routine check', 'Servicing', 'Repair in progress', 'Cleaned'], i), raisedBy: A });
        }
    }

    /* ── incidents ────────────────────────────────────────────────────────── */
    const INC = [
        ['medical_emergency', 'medium', 'resolved', 'Fever and cold', 'first_aid', 'Student reported high fever at night.'],
        ['fighting', 'low', 'resolved', 'Room conflict', '', 'Dispute between roommates over the study table.'],
        ['medical_emergency', 'medium', 'investigating', 'Stomach pain', 'doctor_visit', 'Taken to clinic for checkup.'],
        ['emergency', 'high', 'resolved', 'Slip and fall', '', 'Minor injury while using the stairs after mopping.'],
        ['medical_emergency', 'high', 'resolved', 'Allergy reaction', 'hospital_visit', 'Treated at hospital, stable.'],
        ['other', 'medium', 'action_taken', 'Mess food quality', '', 'Complaint of food contamination at dinner.', 'Dining Hall'],
        ['emergency', 'low', 'resolved', 'Fire alarm triggered', '', 'False alarm during maintenance; building evacuated for 10 minutes.'],
        ['medical_emergency', 'low', 'resolved', 'Headache and dizziness', 'first_aid', 'Rest advised, monitored overnight.'],
        ['theft', 'medium', 'investigating', 'Missing phone', '', 'Phone missing from the study table.'],
        ['property_damage', 'medium', 'resolved', 'Broken window', '', 'Window glass broken by a cricket ball in the courtyard.'],
        ['medical_emergency', 'low', 'closed', 'Minor cut', 'first_aid', 'Cut finger in the pantry; dressed.'],
        ['rule_violation', 'low', 'closed', 'Late entry', '', 'Returned 40 minutes after curfew.'],
        ['medical_emergency', 'medium', 'action_taken', 'Viral fever', 'doctor_visit', 'Seen by the visiting doctor; rest for three days.'],
        ['security', 'high', 'investigating', 'Unknown person at gate', '', 'Stopped by security without a visitor pass.', 'Main Gate'],
        ['medical_emergency', 'medium', 'resolved', 'Sprained ankle', 'doctor_visit', 'Twisted ankle at the football ground.'],
        ['misconduct', 'high', 'investigating', 'Ragging complaint', '', 'First-year student reported ragging by seniors.'],
        ['medical_emergency', 'low', 'resolved', 'Food poisoning', 'medication', 'Vomiting after dinner; medication given.'],
        ['other', 'low', 'closed', 'Power trip', '', 'Power trip in the east wing; restored in 20 minutes.', 'East Wing'],
    ];
    const CARE = { first_aid: 'First aid given', doctor_visit: 'Seen by the visiting doctor', hospital_visit: 'Treated at the city hospital', medication: 'Medication given' };
    const incidentIds = [];
    for (let i = 0; i < INC.length; i++) {
        const [type, sev, status, title, med, detail, spot] = INC[i];
        const r = residents[(i * 7 + 2) % residents.length];
        const date = at(-(i * 3 % 50) - 1, 7 + (i % 12), (i * 17) % 60);
        const x = await M('HostelIncident').create({
            school: S, hostel: r.spot.hostel._id, room: spot ? null : r.spot.room._id, incidentNumber: `HI-${String(i + 1).padStart(4, '0')}`,
            student: ['security', 'other'].includes(type) && spot ? null : r.st.id, incidentType: type, severity: sev, date,
            time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
            location: spot || r.spot.room.roomNumber, title, description: detail,
            reportedBy: A, reportedByName: ADMIN_NAME, medicalCategory: med, treatmentGiven: CARE[med] || '',
            hospitalName: med === 'hospital_visit' ? 'City Care Hospital' : '',
            actionTaken: status === 'action_taken' ? 'Warden spoke to those involved; follow-up booked.' : '',
            status, resolvedAt: ['resolved', 'closed'].includes(status) ? new Date(date.getTime() + 864e5) : null, createdAt: date,
        });
        incidentIds.push(x._id);
    }

    /* ── discipline ───────────────────────────────────────────────────────── */
    const DIS = [
        ['Late return after curfew on multiple occasions', 'curfew', 'written_warning', 'moderate', 'served'],
        ['Mess food wastage (2nd instance)', 'mess_rule', 'fine', 'minor', 'served'],
        ['Involved in room conflict with roommate', 'misbehaviour', 'principal_escalation', 'major', 'acknowledged'],
        ['Disrespectful behavior towards warden', 'misbehaviour', 'written_warning', 'moderate', 'served'],
        ['Damage to hostel property (window glass)', 'property_damage', 'fine', 'major', 'issued'],
        ['Use of mobile after lights out', 'other', 'verbal_warning', 'minor', 'served'],
        ['Repeated night out without permission', 'unauthorized_absence', 'parent_notification', 'major', 'issued'],
        ['Unhygienic room condition', 'other', 'fine', 'moderate', 'served'],
        ['Visitor rule breach', 'visitor_rule', 'verbal_warning', 'minor', 'served'],
        ['Late return after curfew', 'curfew', 'verbal_warning', 'minor', 'served'],
        ['Skipping roll call', 'unauthorized_absence', 'written_warning', 'moderate', 'acknowledged'],
        ['Noise after lights out', 'misbehaviour', 'verbal_warning', 'minor', 'served'],
        ['Mess queue jumping', 'mess_rule', 'verbal_warning', 'minor', 'served'],
        ['Tampering with fire extinguisher', 'property_damage', 'fine', 'major', 'served'],
        ['Ragging complaint', 'ragging', 'suspension', 'major', 'acknowledged'],
        ['Late return after curfew (3rd instance)', 'curfew', 'warden_action', 'moderate', 'issued'],
        ['Smoking in premises', 'substance', 'principal_escalation', 'major', 'served'],
        ['Unauthorised cooking appliance', 'other', 'written_warning', 'minor', 'served'],
    ];
    const prior = {};
    for (let i = 0; i < DIS.length; i++) {
        const [violation, vtype, action, sev, status] = DIS[i];
        const r = residents[[0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 9, 10, 1, 12, 13, 0, 14, 15][i]];
        const count = prior[r.st.id] || 0;
        prior[r.st.id] = count + 1;
        await M('HostelDiscipline').create({
            school: S, hostel: r.spot.hostel._id, student: r.st.id, actionNumber: `HD-${String(i + 1).padStart(4, '0')}`,
            violation, violationType: vtype, actionType: action, severity: sev, date: at(-Math.round((DIS.length - i) * 2.7) - 1, 10 + (i % 9), (i * 23) % 60),
            fineAmount: action === 'fine' ? 500 : 0, priorCount: count, isRepeatOffence: count > 0, status,
            parentNotified: true, issuedBy: A, issuedByName: ADMIN_NAME, incident: i === 2 ? incidentIds[1] : null,
        });
    }

    /* ── documents ────────────────────────────────────────────────────────── */
    const DOCS = [
        ['Admission Undertaking.pdf', 'undertaking', 'application/pdf', 460800, 'verified', 320],
        ['Parent Consent Form.pdf', 'parent_authorization', 'application/pdf', 327680, 'pending', 300],
        ['Aadhaar Card.jpg', 'id_proof', 'image/jpeg', 286720, 'verified', null],
        ['Medical Certificate.pdf', 'medical', 'application/pdf', 522240, 'pending', 18],
        ['Hostel Agreement.pdf', 'agreement', 'application/pdf', 655360, 'verified', 330],
        ['Vaccination Record.pdf', 'medical', 'application/pdf', 419840, 'rejected', -12],
        ['Bonafide Certificate.pdf', 'academic', 'application/pdf', 307200, 'verified', null],
        ['Photograph.jpg', 'photo', 'image/jpeg', 122880, 'verified', null],
    ];
    for (let i = 0; i < 42; i++) {
        const [title, type, mime, size, v0, exp] = DOCS[i % DOCS.length];
        const r = residents[i % residents.length];
        const isHostelDoc = i % 7 === 6; const isStaffDoc = i % 9 === 8;
        const verification = i < 8 ? v0 : pick(['verified', 'verified', 'pending', 'verified', 'rejected', 'verified'], i);
        const expiry = exp === null ? null : day(exp + (i % 5) * 7);
        const post = isStaffDoc ? posts[i % posts.length] : null;
        const docTitle = isHostelDoc ? 'Fire Safety Certificate.pdf' : isStaffDoc ? 'Police Verification.pdf' : title;
        const stored = `demo-${i}-${docTitle.replace(/\s+/g, '-').toLowerCase()}`;
        placeholder(stored, isHostelDoc || isStaffDoc ? 'application/pdf' : mime, docTitle.replace(/\.\w+$/, ''));
        await M('HostelDocument').create({
            school: S, hostel: post ? post.hostel : r.spot.hostel._id, student: isHostelDoc || isStaffDoc ? null : r.st.id,
            entityType: isStaffDoc ? 'HostelStaffAssignment' : isHostelDoc ? 'Hostel' : 'HostelAdmission',
            entityId: post ? post._id : isHostelDoc ? r.spot.hostel._id : null,
            docType: isHostelDoc ? pick(['agreement', 'other'], i) : isStaffDoc ? 'id_proof' : type, title: docTitle,
            originalName: docTitle, storedName: stored,
            mimeType: isHostelDoc || isStaffDoc ? 'application/pdf' : mime, fileSize: size + i * 1024, verificationStatus: verification,
            verifiedBy: verification === 'pending' ? null : A, verifiedAt: verification === 'pending' ? null : day(-(i % 20)),
            expiryDate: expiry, uploadedBy: pick([A, wardenB.id, wardenG.id], i), uploaderRole: 'school_admin', createdAt: day(-(i % 40) - 1),
        });
    }

    /* ── announcements ────────────────────────────────────────────────────── */
    // [title, message, category, audience, status, days from today, hour, hostel key]
    const ANN = [
        ['Mess Menu Update', 'Next week’s mess menu has been updated with two new breakfast options and a Sunday special.', 'mess', 'residents', 'published', -2, 10, 'boys'],
        ['Water Supply Maintenance', 'Water supply will be interrupted on Thursday from 10 AM to 2 PM for tank cleaning. Please store water in advance.', 'maintenance', 'residents', 'published', -3, 16, 'boys'],
        ['Room Allotment Reminder', 'All newly admitted students must complete their room allotment formalities at the warden’s office.', 'general', 'new_residents', 'scheduled', 1, 9, null],
        ['Health Check-up Camp', 'A general health check-up camp will be held in the common hall on Saturday from 9 AM.', 'medical', 'residents', 'published', -5, 14, null],
        ['Discipline Notice', 'Strict action will be taken for late night noise after lights out. Repeat offences go to the principal.', 'discipline', 'residents', 'published', -8, 11, 'boys'],
        ['Festival Holiday', 'Hostel will remain closed from 2nd Oct to 5th Oct. Leave requests must be in by Monday.', 'leave', 'residents', 'published', -10, 18, null],
        ['ID Card Submission', 'All residents must submit a copy of their school ID card at the office by Friday.', 'documents', 'residents', 'draft', null, 12, null],
        ['Emergency Contact Update', 'Please update your emergency contact number with the hostel office before the term exams.', 'safety', 'parents', 'published', -12, 10, null],
        ['Laundry Timings Changed', 'Laundry will now be collected on Tuesdays and Fridays at 8 AM.', 'general', 'residents', 'published', -14, 9, 'girls'],
        ['Fee Reminder — October', 'October hostel fees are due by the 10th. A late fee applies after the grace period.', 'fees', 'residents_and_parents', 'scheduled', 3, 10, null],
        ['Fire Drill', 'A fire drill will be held on Wednesday evening. Follow the wardens to the assembly point.', 'safety', 'residents', 'published', -16, 17, null],
        ['Wi-Fi Upgrade', 'Wi-Fi in both hostels is being upgraded this weekend; expect short outages.', 'maintenance', 'residents', 'published', -18, 13, null],
        ['Parent Visit Day', 'Parents may visit on Sunday between 10 AM and 5 PM. Bring the visitor pass.', 'events', 'parents', 'published', -20, 11, null],
        ['Warden Meeting', 'All wardens and assistant wardens to meet in the office at 4 PM on Monday.', 'general', 'staff', 'published', -21, 15, null],
        ['Mess Feedback Survey', 'Tell us what you think of the mess food — the survey closes on Friday.', 'mess', 'residents', 'published', -24, 12, 'girls'],
        ['Study Hours', 'Compulsory study hours from 7 PM to 9 PM start next week.', 'general', 'residents', 'published', -27, 19, null],
        ['Dengue Precautions', 'Keep windows closed at dusk and report fever to the warden at once.', 'medical', 'residents_and_parents', 'published', -30, 10, null],
        ['Library Books Due', 'Books borrowed from the hostel reading room are due back by the 25th.', 'other', 'residents', 'published', -33, 9, 'boys'],
        ['Room Inspection', 'Room inspection this Friday. Keep rooms clean and cupboards unlocked.', 'discipline', 'residents', 'published', -36, 8, 'girls'],
        ['Sports Day Practice', 'Practice for the inter-hostel sports day starts at 6 AM on the ground.', 'events', 'residents', 'published', -40, 6, null],
        ['Diwali Celebration', 'The hostel Diwali evening is on the 30th — rangoli entries by the 28th.', 'events', 'residents', 'scheduled', 6, 18, null],
        ['Gate Timings', 'The main gate now closes at 9 PM on weekdays.', 'safety', 'residents_and_parents', 'published', -44, 20, null],
        ['Exam Week Quiet Hours', 'Quiet hours from 9 PM during exam week; the common room closes early.', 'general', 'residents', 'scheduled', 10, 8, null],
        ['Water Cooler Service', 'Draft — cooler servicing dates to be confirmed with the vendor.', 'maintenance', 'staff', 'draft', null, 11, 'boys'],
    ];
    const residentsIn = (key) => residents.filter((r) => !key || String(r.spot.hostel._id) === String(H[key].doc._id)).length;
    const reach = { residents: (k) => residentsIn(k), new_residents: (k) => Math.max(1, Math.round(residentsIn(k) / 5)),
        parents: (k) => residentsIn(k), residents_and_parents: (k) => residentsIn(k) * 2, staff: () => staff.length };
    for (let i = 0; i < ANN.length; i++) {
        const [title, message, category, audience, status, days, hour, key] = ANN[i];
        const when = days === null ? null : at(days, hour, (i * 13) % 60);
        const created = status === 'scheduled' ? at(-(i % 4) - 1, 9) : status === 'draft' ? at(-(i % 3) - 1, 12) : when;
        await M('HostelAnnouncement').create({
            school: S, hostel: key ? H[key].doc._id : null, hostels: key ? [H[key].doc._id] : [],
            title, message, category, audience, status, urgent: category === 'safety' && i % 2 === 0, sendEmail: i % 3 === 0,
            scheduledAt: status === 'scheduled' ? when : null, publishedAt: status === 'published' ? when : null,
            recipients: status === 'published' ? reach[audience](key) : 0,
            createdBy: A, createdByName: ADMIN_NAME, publishedBy: status === 'published' ? A : null, publishedByName: status === 'published' ? ADMIN_NAME : '',
            createdAt: created,
        });
    }

    /* ── the activity log ─────────────────────────────────────────────────── */
    const IPS = ['192.168.1.10', '192.168.1.11', '192.168.1.12', '192.168.1.13', '192.168.1.14', '192.168.1.15'];
    const extra = [
        ['update', 'HostelLeave', 'Approved leave request', { status: 'pending' }, { status: 'approved' }],
        ['create', 'HostelComplaint', 'Created new complaint', null, null],
        ['update', 'HostelComplaint', 'Changed complaint status to resolved', { status: 'open' }, { status: 'resolved' }],
        ['create', 'HostelMaintenance', 'Created maintenance work order', null, { priority: 'medium' }],
        ['create', 'HostelFeeInvoice', 'Posted late fee for student', { lateFee: 0 }, { lateFee: 500 }],
        ['update', 'HostelAnnouncement', 'Updated announcement', null, null],
        ['transfer', 'HostelAllocation', 'Updated student room allocation', { room: 'R201' }, { room: 'R105' }],
        ['delete', 'HostelRoom', 'Deleted room', null, null],
    ];
    // Each entry names a real record of its kind, so the log can say which one.
    const records = {};
    for (const type of ['HostelLeave', 'HostelComplaint', 'HostelMaintenance', 'HostelFeeInvoice', 'HostelAnnouncement', 'HostelAllocation']) {
        records[type] = await M(type).find({ school: S }).select('_id hostel').lean();
    }
    for (let i = 0; i < 30; i++) {
        const [actionType, entityType, description, before, after] = extra[i % extra.length];
        const rec = records[entityType]?.length ? pick(records[entityType], i * 7) : null;
        audit({ at: -(i % 25), hour: 9 + (i % 9), hostel: rec?.hostel || pick([H.boys.doc._id, H.girls.doc._id], i),
            entityId: rec?._id || null, actionType, entityType, description, before, after });
    }
    for (const [i, a] of log.entries()) {
        const when = at(a.at, a.hour || 10 + (i % 8), (i * 7) % 60);
        await M('HostelAuditLog').create({
            school: S, hostel: a.hostel || null, user: A, userName: ADMIN_NAME, role: 'school_admin',
            actionType: a.actionType, entityType: a.entityType, entityId: a.entityId || null, description: a.description,
            before: a.before || null, after: a.after || null, ip: pick(IPS, i), userAgent: 'seed', createdAt: when, updatedAt: when,
        });
    }

    console.log(`\nseeded: ${students.length} students, ${staff.length} staff, ${residents.length} residents, ${allBeds.length} beds`);
    console.log(`log in as admin@${DOMAIN} / HostelDemo@123`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
