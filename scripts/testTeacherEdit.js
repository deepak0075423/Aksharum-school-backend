'use strict';
/**
 * Teacher record editing — end-to-end.
 *
 *   node server.js &
 *   node scripts/testTeacherEdit.js
 *
 * Two surfaces, two rules:
 *
 *   • PUT /admin/teachers/:id — an administrator edits the WHOLE record with
 *     the same form that created it. The edit is partial: paperwork already on
 *     file counts as supplied, so correcting a phone number never demands a
 *     re-upload, and an omitted upload never wipes what is stored.
 *   • PUT /profile/employee — an employee corrects the facts they own about
 *     themselves. Everything that decides what they can do or what they are
 *     paid is refused, silently dropped rather than trusted.
 */
require('dotenv').config({ quiet: true });
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const connectDB = require('../config/db');
const School = require('../models/School');
const User = require('../models/User');
const TeacherProfile = require('../models/TeacherProfile');

let passed = 0, failed = 0;
const results = [];
const check = (n, c, d = '') => { if (c) { passed++; results.push(`  ✅ ${n}`); } else { failed++; results.push(`  ❌ ${n}${d ? ` — ${d}` : ''}`); } };
const section = (t) => results.push(`\n▸ ${t}`);

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
const TAG = `tetest_${Date.now()}`;
const sid = (v) => String(v?._id ?? v);
const token = (u) => jwt.sign({ userId: sid(u), role: u.role, schoolId: sid(u.school) }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function json(method, path, { as, body } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token(as)}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, data: j?.data, message: j?.message };
}
async function form(method, path, fields, { as } = {}) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v == null ? '' : String(v));
    const res = await fetch(`${BASE}${path}`, {
        method, headers: { Authorization: `Bearer ${token(as)}` }, body: fd,
    });
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, data: j?.data, message: j?.message };
}

// A complete, valid teacher payload — the shape the wizard posts.
const FULL = {
    name: 'Anita Sharma', email: '', phone: '9876543210',
    dob: '1990-04-12', gender: 'Female', bloodGroup: 'B+',
    fatherOrHusbandName: 'Ramesh Sharma',
    emergencyContactName: 'Ramesh Sharma', emergencyContactPhone: '9820011223',
    currentAddress: '12 Lake Road', currentCity: 'Pune', currentState: 'Maharashtra',
    currentPincode: '411001', currentCountry: 'India', sameAsCurrent: 'true',
    aadhaarNumber: '123456789012', panNumber: 'ABCDE1234F',
    qualification: 'M.Sc.', teachingDegree: 'B.Ed.',
    employmentType: 'fresher',
    bankAccountHolder: 'Anita Sharma', bankAccountNumber: '50100234564521',
    bankIfsc: 'HDFC0001234', bankBranch: 'Pune Main',
    joiningDate: '2021-06-01', designation: 'Teacher',
};

(async () => {
    await connectDB();
    if (!(await fetch(`http://localhost:${process.env.PORT || 5000}/health`).catch(() => null))?.ok) {
        console.error('Server is not running.'); process.exit(1);
    }

    const school = await School.create({ name: `${TAG} School`, code: 'TET', modules: { employeeDirectory: true } });
    const admin = await User.create({
        name: `${TAG} Admin`, email: `${TAG}.admin@x.test`, role: 'school_admin',
        school: sid(school), password: await bcrypt.hash('x', 4), isFirstLogin: false, isActive: true,
    });
    admin.school = school;
    let teacher = null;

    try {
        section('An administrator edits the whole record with the creation form');
        // Created directly so the test does not depend on multipart uploads.
        teacher = await User.create({
            name: 'Anita Sharma', email: `${TAG}.anita@x.test`, role: 'teacher', phone: '9876543210',
            school: sid(school), password: await bcrypt.hash('x', 4), isFirstLogin: false, isActive: true,
        });
        teacher.school = school;
        await TeacherProfile.create({
            user: sid(teacher), school: sid(school), employeeId: 'TET0001',
            designation: 'Teacher', department: 'Mathematics',
            gender: 'Female', dob: new Date('1990-04-12'), bloodGroup: 'B+',
            fatherOrHusbandName: 'Ramesh Sharma',
            emergencyContactName: 'Ramesh Sharma', emergencyContactPhone: '9820011223',
            currentAddress: '12 Lake Road', currentCity: 'Pune', currentState: 'Maharashtra',
            currentPincode: '411001', currentCountry: 'India',
            permanentAddress: '12 Lake Road', permanentCity: 'Pune', permanentState: 'Maharashtra',
            permanentPincode: '411001', permanentCountry: 'India',
            aadhaarNumber: '123456789012', panNumber: 'ABCDE1234F',
            aadhaarFrontFile: 'af.jpg', aadhaarBackFile: 'ab.jpg', panCardFile: 'pan.jpg',
            qualification: 'M.Sc.', teachingDegree: 'B.Ed.', employmentType: 'fresher',
            bankAccountHolder: 'Anita Sharma', bankAccountNumber: '50100234564521',
            bankIfsc: 'HDFC0001234', bankBranch: 'Pune Main', joiningDate: new Date('2021-06-01'),
        });

        const detail = await json('GET', `/admin/teachers/${sid(teacher)}`, { as: admin });
        check('the edit form can read the record back', detail.status === 200 && detail.data?.profile?.employeeId === 'TET0001');

        // The wizard reposts everything; only the phone actually changed.
        const edit = await form('PUT', `/admin/teachers/${sid(teacher)}`,
            { ...FULL, email: `${TAG}.anita@x.test`, phone: '9000011111', department: 'Science' }, { as: admin });
        check('an edit with no new uploads is accepted', edit.status === 200, `${edit.status} ${edit.message}`);

        const after = await TeacherProfile.findOne({ user: sid(teacher) }).lean();
        const userAfter = await User.findById(sid(teacher)).lean();
        check('the account field is updated', userAfter.phone === '9000011111', userAfter.phone);
        check('a profile field is updated', after.department === 'Science', after.department);
        check('documents already on file are NOT wiped by an edit',
            after.aadhaarFrontFile === 'af.jpg' && after.aadhaarBackFile === 'ab.jpg' && after.panCardFile === 'pan.jpg',
            JSON.stringify([after.aadhaarFrontFile, after.aadhaarBackFile, after.panCardFile]));
        check('every other field survives', after.bankIfsc === 'HDFC0001234' && after.qualification === 'M.Sc.');
        check('the employee ID is preserved when not retyped', after.employeeId === 'TET0001', after.employeeId);

        section('Editing a teacher does not trip over their own email');
        // The wizard asks /users/check-email before letting the admin past the
        // contact step. On an edit the teacher's OWN address is of course
        // registered — the form must not read that as a clash.
        const own = await json('GET', `/admin/users/check-email?email=${encodeURIComponent(`${TAG}.anita@x.test`)}`, { as: admin });
        check('the check reports the teacher\'s own address as taken', own.status === 200,
            `${own.status}`);
        const keepEmail = await form('PUT', `/admin/teachers/${sid(teacher)}`,
            { ...FULL, email: `${TAG}.anita@x.test`, phone: '9000022222' }, { as: admin });
        check('saving an edit that keeps the same email is accepted',
            keepEmail.status === 200, `${keepEmail.status} ${keepEmail.message}`);
        // That request omitted `department` entirely — a partial edit must leave
        // an unsent field alone rather than blanking it.
        const kept = await TeacherProfile.findOne({ user: sid(teacher) }).lean();
        check('a field the request omitted is left alone', kept.department === 'Science', kept.department);

        const taken = await User.create({
            name: 'Taken', email: `${TAG}.taken@x.test`, role: 'teacher', school: sid(school),
            password: await bcrypt.hash('x', 4), isFirstLogin: false, isActive: true,
        });
        const clash = await form('PUT', `/admin/teachers/${sid(teacher)}`,
            { ...FULL, email: `${TAG}.taken@x.test` }, { as: admin });
        check('changing to a colleague\'s address is still refused',
            clash.status === 400 && /already registered/i.test(clash.message || ''), clash.message);
        await User.findByIdAndDelete(sid(taken));

        section('The edit is still validated');
        const bad = await form('PUT', `/admin/teachers/${sid(teacher)}`,
            { ...FULL, email: `${TAG}.anita@x.test`, panNumber: 'NOTAPAN' }, { as: admin });
        check('an invalid PAN is refused', bad.status === 400 && /PAN/i.test(bad.message || ''), bad.message);

        const other = await User.create({
            name: 'Other', email: `${TAG}.other@x.test`, role: 'teacher', school: sid(school),
            password: await bcrypt.hash('x', 4), isFirstLogin: false, isActive: true,
        });
        await TeacherProfile.create({ user: sid(other), school: sid(school), employeeId: 'TET0002' });
        const dupId = await form('PUT', `/admin/teachers/${sid(teacher)}`,
            { ...FULL, email: `${TAG}.anita@x.test`, employeeId: 'TET0002' }, { as: admin });
        check('a duplicate employee ID is refused', dupId.status === 400 && /already in use/i.test(dupId.message || ''), dupId.message);

        const foreign = await School.create({ name: `${TAG} Other`, code: 'TEO' });
        const foreignTeacher = await User.create({
            name: 'Foreign', email: `${TAG}.foreign@x.test`, role: 'teacher', school: sid(foreign),
            password: await bcrypt.hash('x', 4), isFirstLogin: false, isActive: true,
        });
        const cross = await form('PUT', `/admin/teachers/${sid(foreignTeacher)}`,
            { ...FULL, email: `${TAG}.foreign@x.test` }, { as: admin });
        check('a teacher of another school cannot be edited', cross.status === 404, `${cross.status}`);
        await User.findByIdAndDelete(sid(foreignTeacher));
        await School.findByIdAndDelete(sid(foreign));

        section('An employee corrects their own record');
        const mine = await json('GET', '/profile/employee', { as: teacher });
        check('the editable set is served', mine.status === 200 && Array.isArray(mine.data?.fields));
        check('it offers the fields an employee owns',
            mine.data.fields.includes('emergencyContactPhone') && mine.data.fields.includes('qualification'));
        check('it does NOT offer designation, employee ID or bank fields',
            !mine.data.fields.includes('designation') && !mine.data.fields.includes('employeeId')
            && !mine.data.fields.some((f) => f.startsWith('bank')));

        const selfEdit = await json('PUT', '/profile/employee', {
            as: teacher,
            body: { bloodGroup: 'O+', alternatePhone: '9820044556', qualification: 'M.Phil.', currentCity: 'Mumbai' },
        });
        check('the employee can save their own corrections', selfEdit.status === 200, selfEdit.message);
        const selfAfter = await TeacherProfile.findOne({ user: sid(teacher) }).lean();
        check('the corrections are stored',
            selfAfter.bloodGroup === 'O+' && selfAfter.alternatePhone === '9820044556'
            && selfAfter.qualification === 'M.Phil.' && selfAfter.currentCity === 'Mumbai');

        section('The employee cannot promote themselves or rewrite payroll facts');
        const escalate = await json('PUT', '/profile/employee', {
            as: teacher,
            body: {
                designation: 'Principal', department: 'Administration', employeeId: 'HACK1',
                joiningDate: '2000-01-01', bankAccountNumber: '99999999', aadhaarNumber: '999999999999',
                staffType: 'non_teaching', reportingManager: sid(admin), bloodGroup: 'A+',
            },
        });
        check('the request succeeds for the one legitimate field', escalate.status === 200, escalate.message);
        const guarded = await TeacherProfile.findOne({ user: sid(teacher) }).lean();
        check('designation is unchanged', guarded.designation === 'Teacher', guarded.designation);
        check('department is unchanged', guarded.department === 'Science', guarded.department);
        check('employee ID is unchanged', guarded.employeeId === 'TET0001', guarded.employeeId);
        check('joining date is unchanged', new Date(guarded.joiningDate).getFullYear() === 2021);
        check('bank account is unchanged', guarded.bankAccountNumber === '50100234564521');
        check('Aadhaar is unchanged', guarded.aadhaarNumber === '123456789012');
        check('staff type is unchanged', !guarded.staffType);
        check('reporting manager is unchanged', !guarded.reportingManager);
        check('the legitimate field WAS written', guarded.bloodGroup === 'A+', guarded.bloodGroup);

        section('Self-service edits are still validated');
        for (const [label, body, rx] of [
            ['a bad phone', { alternatePhone: 'nope' }, /not valid/i],
            ['a bad PIN code', { currentPincode: '12' }, /6 digits/i],
            ['a state that does not exist', { currentState: 'Atlantis' }, /valid Indian state/i],
            ['an invalid gender', { gender: 'Robot' }, /Male, Female or Other/i],
        ]) {
            const r = await json('PUT', '/profile/employee', { as: teacher, body });
            check(`${label} is refused`, r.status === 400 && rx.test(r.message || ''), `${r.status} ${r.message}`);
        }
        const nothing = await json('PUT', '/profile/employee', { as: teacher, body: { notAField: 'x' } });
        check('a body with no editable field is refused', nothing.status === 400);
    } finally {
        const ids = [sid(admin), teacher && sid(teacher)].filter(Boolean);
        const extra = await User.find({ email: { $regex: TAG } }).select('_id').lean();
        const all = [...new Set([...ids, ...extra.map((u) => String(u._id))])];
        await TeacherProfile.deleteMany({ user: { $in: all } }).catch(() => {});
        await User.deleteMany({ _id: { $in: all } }).catch(() => {});
        await School.deleteMany({ name: { $regex: TAG } }).catch(() => {});
    }

    console.log(results.join('\n'));
    console.log(`\n${'─'.repeat(60)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(60)}`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
