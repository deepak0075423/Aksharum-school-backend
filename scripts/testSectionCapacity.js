'use strict';
/**
 * Section capacity & shuffle guards — end-to-end.
 *
 *   node server.js &
 *   node scripts/testSectionCapacity.js
 *
 * Two rules:
 *   • A section never holds more students than its capacity — enforced when a
 *     student is assigned by hand, created with a section, moved into one, and
 *     when a spreadsheet is imported.
 *   • A shuffle is refused unless every student of the class fits in the seats
 *     across its sections, and the dialog is told the same numbers the shuffle
 *     itself will use.
 */
require('dotenv').config({ quiet: true });
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const connectDB = require('../config/db');

const School = require('../models/School');
const User = require('../models/User');
const AcademicYear = require('../models/AcademicYear');
const Class = require('../models/Class');
const ClassSection = require('../models/ClassSection');
const StudentProfile = require('../models/StudentProfile');
const ParentProfile = require('../models/ParentProfile');

let passed = 0, failed = 0;
const results = [];
const check = (n, c, d = '') => { if (c) { passed++; results.push(`  ✅ ${n}`); } else { failed++; results.push(`  ❌ ${n}${d ? ` — ${d}` : ''}`); } };
const section = (t) => results.push(`\n▸ ${t}`);

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
const TAG = `sctest_${Date.now()}`;
const sid = (v) => String(v?._id ?? v);
const token = (u) => jwt.sign({ userId: sid(u), role: u.role, schoolId: sid(u.school) }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function call(method, path, { as, body } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token(as)}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, data: json?.data, message: json?.message };
}
const GET = (p, o) => call('GET', p, o);
const POST = (p, o) => call('POST', p, o);

const mkStudent = async (school, i) => {
    const u = await User.create({
        name: `${TAG} Student ${i}`, email: `${TAG}.s${i}@x.test`, role: 'student',
        school: sid(school), password: await bcrypt.hash('x', 4), isFirstLogin: false, isActive: true,
    });
    return u;
};

(async () => {
    await connectDB();
    if (!(await fetch(`http://localhost:${process.env.PORT || 5000}/health`).catch(() => null))?.ok) {
        console.error('Server is not running.'); process.exit(1);
    }

    const school = await School.create({ name: `${TAG} School`, code: 'SCT' });
    const admin = await User.create({
        name: `${TAG} Admin`, email: `${TAG}.admin@x.test`, role: 'school_admin',
        school: sid(school), password: await bcrypt.hash('x', 4), isFirstLogin: false, isActive: true,
    });
    admin.school = school;

    const year = await AcademicYear.create({
        school: sid(school), yearName: '2026-27',
        startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), status: 'active',
    });
    const cls = await Class.create({ school: sid(school), academicYear: sid(year), classNumber: 5, className: 'Class 5' });
    // Deliberately tight: 2 seats + 2 seats.
    const secA = await ClassSection.create({ school: sid(school), class: sid(cls), academicYear: sid(year), sectionName: 'A', maxStudents: 2 });
    const secB = await ClassSection.create({ school: sid(school), class: sid(cls), academicYear: sid(year), sectionName: 'B', maxStudents: 2 });

    const students = [];
    for (let i = 1; i <= 5; i++) students.push(await mkStudent(school, i));

    try {
        section('A section stops taking students at its capacity');
        const a1 = await POST(`/admin/sections/${sid(secA)}/assign-student`, { as: admin, body: { studentId: sid(students[0]) } });
        check('first student is admitted', a1.status === 200, `${a1.status} ${a1.message}`);
        const a2 = await POST(`/admin/sections/${sid(secA)}/assign-student`, { as: admin, body: { studentId: sid(students[1]) } });
        check('second student fills the section', a2.status === 200, a2.message);
        const a3 = await POST(`/admin/sections/${sid(secA)}/assign-student`, { as: admin, body: { studentId: sid(students[2]) } });
        check('third student is refused', a3.status === 400, `${a3.status}`);
        check('the refusal names the section and the seats',
            /Section A is full/.test(a3.message || '') && /2 of 2 seats/.test(a3.message || ''), a3.message);

        const roster = await ClassSection.findById(sid(secA)).lean();
        check('the roster really stopped at capacity', (roster.enrolledStudents || []).length === 2,
            `${(roster.enrolledStudents || []).length}`);

        // Re-saving someone already in this section must not read as "full":
        // the capacity check leaves them out of the count.
        const again = await POST(`/admin/sections/${sid(secA)}/assign-student`, { as: admin, body: { studentId: sid(students[0]) } });
        check('re-saving a student already in the full section still succeeds',
            again.status === 200, `${again.status} ${again.message}`);
        const unchanged = await ClassSection.findById(sid(secA)).lean();
        check('and does not duplicate them on the roster',
            (unchanged.enrolledStudents || []).length === 2, `${(unchanged.enrolledStudents || []).length}`);

        // Moving them into a DIFFERENT full section is refused.
        await ClassSection.findByIdAndUpdate(sid(secB), {
            $set: { enrolledStudents: [sid(students[3]), sid(students[4])], currentCount: 2 },
        });
        const moveIn = await POST(`/admin/sections/${sid(secB)}/assign-student`, { as: admin, body: { studentId: sid(students[0]) } });
        check('moving a student into a different full section is refused', moveIn.status === 400, `${moveIn.status}`);
        await ClassSection.findByIdAndUpdate(sid(secB), { $set: { enrolledStudents: [], currentCount: 0 } });

        section('A section with no capacity set is unlimited, as before');
        const secC = await ClassSection.create({ school: sid(school), class: sid(cls), academicYear: sid(year), sectionName: 'C', maxStudents: 0 });
        const free = await POST(`/admin/sections/${sid(secC)}/assign-student`, { as: admin, body: { studentId: sid(students[2]) } });
        check('a student is admitted to an uncapped section', free.status === 200, free.message);
        await ClassSection.findByIdAndDelete(sid(secC));
        await StudentProfile.deleteMany({ user: sid(students[2]) });

        section('Shuffle is refused when the class does not fit in its seats');
        // 5 students, 4 seats.
        for (let i = 0; i < 5; i++) {
            await StudentProfile.findOneAndUpdate(
                { user: sid(students[i]) },
                { $set: { school: sid(school), currentClass: sid(cls), currentSection: null, admissionNumber: `${TAG}${i}` } },
                { upsert: true },
            );
        }
        await ClassSection.findByIdAndUpdate(sid(secA), { $set: { enrolledStudents: [], currentCount: 0 } });
        await ClassSection.findByIdAndUpdate(sid(secB), { $set: { enrolledStudents: [], currentCount: 0 } });

        const pv = await GET(`/admin/classes/${sid(cls)}/shuffle-preview`, { as: admin });
        check('preview answers', pv.status === 200, pv.message);
        check('preview counts the students', pv.data?.students === 5, `${pv.data?.students}`);
        check('preview counts the seats across sections', pv.data?.capacity === 4, `${pv.data?.capacity}`);
        check('preview reports the shortfall', pv.data?.shortfall === 1, `${pv.data?.shortfall}`);
        check('preview says it cannot shuffle', pv.data?.canShuffle === false);
        check('preview explains why, with both numbers',
            /5 students do not fit in 4 seats/.test(pv.data?.reason || ''), pv.data?.reason);
        check('preview lists each section with its capacity',
            (pv.data?.sections || []).length === 2 && pv.data.sections.every(s => s.maxStudents === 2));

        const blockedShuffle = await POST(`/admin/classes/${sid(cls)}/shuffle-sections`, { as: admin });
        check('the shuffle itself is refused, not just the dialog', blockedShuffle.status === 400, `${blockedShuffle.status}`);
        check('and nothing was moved',
            (await ClassSection.findById(sid(secA)).lean()).enrolledStudents.length === 0);

        section('Raising capacity makes the same class shuffle');
        await ClassSection.findByIdAndUpdate(sid(secA), { $set: { maxStudents: 3 } });
        const pv2 = await GET(`/admin/classes/${sid(cls)}/shuffle-preview`, { as: admin });
        check('preview now says it can shuffle', pv2.data?.canShuffle === true, pv2.data?.reason);
        check('and the seats add up', pv2.data?.capacity === 5 && pv2.data?.shortfall === 0);

        const done = await POST(`/admin/classes/${sid(cls)}/shuffle-sections`, { as: admin });
        check('the shuffle runs', done.status === 200, done.message);
        const [ra, rb] = await Promise.all([
            ClassSection.findById(sid(secA)).lean(), ClassSection.findById(sid(secB)).lean(),
        ]);
        check('every student was placed', ra.enrolledStudents.length + rb.enrolledStudents.length === 5,
            `${ra.enrolledStudents.length}+${rb.enrolledStudents.length}`);
        check('no section exceeded its capacity',
            ra.enrolledStudents.length <= 3 && rb.enrolledStudents.length <= 2,
            `A=${ra.enrolledStudents.length} B=${rb.enrolledStudents.length}`);

        section('Bulk import refuses rows once the section is full');
        await ClassSection.findByIdAndUpdate(sid(secA), { $set: { enrolledStudents: [], currentCount: 0, maxStudents: 1 } });
        await ClassSection.findByIdAndUpdate(sid(secB), { $set: { enrolledStudents: [], currentCount: 0 } });
        await StudentProfile.deleteMany({ user: { $in: students.map(sid) } });
        await User.deleteMany({ _id: { $in: students.map(sid) } });

        const rows = [1, 2].map((i) => ({
            'Full Name': `${TAG} Bulk ${i}`, 'Email Address': `${TAG}.b${i}@x.test`, 'Phone Number': '9876543210',
            'Admission Number': '', 'Roll Number': '', 'Date of Birth': '15/08/2012', Gender: 'Male',
            'Blood Group': 'B+', Category: 'General', Class: 'Class 5', Section: 'A',
            Address: '1 Road', City: 'Pune', State: 'Maharashtra', Pincode: '411001',
            'Parent Full Name': `${TAG} Parent ${i}`, 'Parent Email': `${TAG}.bp${i}@x.test`, 'Parent Phone Number': '9876543200',
        }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Students');
        const fd = new FormData();
        fd.append('excelFile', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 's.xlsx');
        const imp = await fetch(`${BASE}/admin/students/bulk`, {
            method: 'POST', headers: { Authorization: `Bearer ${token(admin)}` }, body: fd,
        });
        const text = await imp.text();
        const doneLine = text.split('\n').filter(l => l.startsWith('data:') && l.includes('"done"')).pop();
        const summary = doneLine ? JSON.parse(doneLine.slice(5)) : {};
        check('the first row is imported', summary.created === 1, JSON.stringify(summary));
        check('the row past capacity is rejected', (summary.errors || []).length === 1);
        check('the rejection names the full section',
            /Section "A" of Class 5 is full/.test(summary.errors?.[0]?.reason || ''), summary.errors?.[0]?.reason);
        const finalA = await ClassSection.findById(sid(secA)).lean();
        check('the section never went over capacity', (finalA.enrolledStudents || []).length === 1,
            `${(finalA.enrolledStudents || []).length}`);
    } finally {
        const bulkEmails = [1, 2].flatMap(i => [`${TAG}.b${i}@x.test`, `${TAG}.bp${i}@x.test`]);
        const bulkUsers = await User.find({ email: { $in: bulkEmails } }).select('_id').lean();
        const ids = [...students.map(sid), ...bulkUsers.map(u => String(u._id)), sid(admin)];
        await StudentProfile.deleteMany({ user: { $in: ids } }).catch(() => {});
        await ParentProfile.deleteMany({ user: { $in: ids } }).catch(() => {});
        await ClassSection.deleteMany({ school: sid(school) }).catch(() => {});
        await Class.deleteMany({ school: sid(school) }).catch(() => {});
        await AcademicYear.deleteMany({ school: sid(school) }).catch(() => {});
        await User.deleteMany({ _id: { $in: ids } }).catch(() => {});
        await School.findByIdAndDelete(sid(school)).catch(() => {});
    }

    console.log(results.join('\n'));
    console.log(`\n${'─'.repeat(60)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(60)}`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
