'use strict';
/**
 * Employee Directory — end-to-end tests.
 *
 *   node server.js &            (or have it already running)
 *   node scripts/testEmployeeDirectory.js
 *
 * Drives the real HTTP surface against two throwaway schools, so the properties
 * under test are the ones the module is specified on:
 *
 *   • only school_admin and teacher reach it, and only when the school has the
 *     module enabled and the designation grants access
 *   • a request never returns an employee of another school, by list or by id
 *   • a teacher with normal access never receives Aadhaar / PAN / bank /
 *     salary / personal / attendance / leave for someone else — the keys are
 *     absent from the payload, not merely blank
 *   • administrators receive those values MASKED, and unmasking is a separate,
 *     audited call
 *   • search, filters, sorting and pagination run server-side
 *   • an employee always sees their own full permitted record
 */
require('dotenv').config({ quiet: true });
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const connectDB = require('../config/db');

const School         = require('../models/School');
const User           = require('../models/User');
const TeacherProfile = require('../models/TeacherProfile');
const Designation    = require('../models/Designation');
const AcademicYear   = require('../models/AcademicYear');
const Class          = require('../models/Class');
const ClassSection   = require('../models/ClassSection');
const Subject        = require('../models/Subject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const EmployeeResponsibility = require('../models/EmployeeResponsibility');
const EmployeeVerification   = require('../models/EmployeeVerification');
const ActivityLog    = require('../models/ActivityLog');
const designationService = require('../services/designationService');

let passed = 0, failed = 0;
const results = [];
const check = (name, cond, detail = '') => {
    if (cond) { passed += 1; results.push(`  ✅ ${name}`); }
    else { failed += 1; results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t) => results.push(`\n▸ ${t}`);

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
const TAG  = `edtest_${Date.now()}`;
const sid  = (v) => String(v?._id ?? v);
const token = (u) => jwt.sign({ userId: sid(u), role: u.role, schoolId: sid(u.school) }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function call(method, path, { as, body } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token(as)}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const ct = res.headers.get('content-type') || '';
    let json = null, text = '';
    if (ct.includes('json')) { try { json = await res.json(); } catch {} }
    else text = await res.text();
    return { status: res.status, body: json, data: json?.data, message: json?.message, code: json?.code, text, contentType: ct };
}
const GET  = (p, o) => call('GET', p, o);
const POST = (p, o) => call('POST', p, o);
const PUT  = (p, o) => call('PUT', p, o);
const DEL  = (p, o) => call('DELETE', p, o);

const AADHAAR = '123456789012';
const PAN     = 'ABCDE1234F';
const ACCOUNT = '50100234564521';

async function mkUser({ school, role, name, email }) {
    return User.create({
        name, email, role, school: sid(school),
        password: await bcrypt.hash('Passw0rd!', 4),
        phone: '+91 90000 00000', isFirstLogin: false, isActive: true,
    });
}

async function seed() {
    const school = await School.create({
        name: `${TAG} Primary`, code: 'EDT',
        modules: { employeeDirectory: true, timetable: true, attendance: true, leave: true, payroll: true },
    });
    const other = await School.create({
        name: `${TAG} Rival`, code: 'EDR',
        modules: { employeeDirectory: true },
    });

    const admin = await mkUser({ school, role: 'school_admin', name: `${TAG} Admin`, email: `${TAG}.admin@x.test` });
    admin.school = school;

    const teacher = await mkUser({ school, role: 'teacher', name: `${TAG} Asha Teacher`, email: `${TAG}.asha@x.test` });
    teacher.school = school;
    const peer = await mkUser({ school, role: 'teacher', name: `${TAG} Bala Peer`, email: `${TAG}.bala@x.test` });
    peer.school = school;
    const student = await mkUser({ school, role: 'student', name: `${TAG} Student`, email: `${TAG}.stu@x.test` });
    student.school = school;
    const parent = await mkUser({ school, role: 'parent', name: `${TAG} Parent`, email: `${TAG}.par@x.test` });
    parent.school = school;

    const rivalTeacher = await mkUser({ school: other, role: 'teacher', name: `${TAG} Rival Teacher`, email: `${TAG}.rival@x.test` });
    rivalTeacher.school = other;
    const rivalAdmin = await mkUser({ school: other, role: 'school_admin', name: `${TAG} Rival Admin`, email: `${TAG}.radmin@x.test` });
    rivalAdmin.school = other;

    const fullProfile = (user, extra = {}) => TeacherProfile.create({
        user: sid(user), school: sid(user.school),
        employeeId: extra.employeeId || 'EDT0001',
        designation: extra.designation || 'Teacher',
        department: extra.department || 'Mathematics',
        gender: 'Female', dob: new Date('1990-04-01'), bloodGroup: 'B+',
        joiningDate: new Date('2021-06-01'),
        fatherOrHusbandName: 'R Kumar',
        emergencyContactName: 'R Kumar', emergencyContactPhone: '+91 98765 43210',
        currentAddress: '12 Lake Road', currentCity: 'Pune', currentState: 'Maharashtra',
        currentPincode: '411001', currentCountry: 'India',
        permanentAddress: '12 Lake Road', permanentCity: 'Pune', permanentState: 'Maharashtra',
        permanentPincode: '411001', permanentCountry: 'India',
        aadhaarNumber: AADHAAR, panNumber: PAN, uanNumber: '101234567890',
        aadhaarFrontFile: 'af.jpg', aadhaarBackFile: 'ab.jpg', panCardFile: 'pan.jpg',
        qualification: 'M.Sc.', teachingDegree: 'B.Ed.',
        employmentType: 'experienced', totalExperience: '5 years',
        previousSchool: 'Old School', lastDesignation: 'Senior Teacher',
        resignationLetterFile: 'res.pdf',
        bankAccountHolder: 'Asha T', bankAccountNumber: ACCOUNT,
        bankIfsc: 'HDFC0001234', bankBranch: 'Pune Main',
        ...extra,
    });

    await fullProfile(teacher, { employeeId: 'EDT0001', designation: 'Teacher', department: 'Mathematics' });
    await fullProfile(peer,    { employeeId: 'EDT0002', designation: 'Principal', department: 'Administration' });
    await fullProfile(rivalTeacher, { employeeId: 'RIV0001', designation: 'Teacher', department: 'Science' });

    // Academic scaffolding so subject / class assignments are real.
    const year = await AcademicYear.create({
        school: sid(school), yearName: '2026-27',
        startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), status: 'active',
    });
    const cls = await Class.create({ school: sid(school), academicYear: sid(year), classNumber: 8, className: 'Class 8' });
    const sec = await ClassSection.create({
        school: sid(school), class: sid(cls), academicYear: sid(year),
        sectionName: 'A', classTeacher: sid(teacher), maxStudents: 40,
    });
    const subject = await Subject.create({ school: sid(school), subjectName: 'Mathematics', subjectCode: `MTH${Date.now() % 100000}` });
    await SectionSubjectTeacher.create({ section: sid(sec), subject: sid(subject), teacher: sid(teacher) });

    // Designations: 'Teacher' gets normal access, 'Principal' administrative.
    await Designation.create({
        school: sid(school), name: 'Teacher',
        permissions: { ...designationService.defaultPermissionsFor('Teacher'), employeeDirectory: 'user', payroll: 'user' },
    });
    await Designation.create({
        school: sid(school), name: 'Principal',
        permissions: { ...designationService.defaultPermissionsFor('Principal'), employeeDirectory: 'admin', payroll: 'admin' },
    });
    await designationService.invalidate(sid(school));
    await designationService.invalidateUsers([sid(teacher), sid(peer)]);

    return { school, other, admin, teacher, peer, student, parent, rivalTeacher, rivalAdmin, year, cls, sec, subject };
}

async function cleanup(ctx) {
    const ids = [ctx.admin, ctx.teacher, ctx.peer, ctx.student, ctx.parent, ctx.rivalTeacher, ctx.rivalAdmin].map(sid);
    await SectionSubjectTeacher.deleteMany({ teacher: { $in: ids } }).catch(() => {});
    await EmployeeResponsibility.deleteMany({ school: { $in: [sid(ctx.school), sid(ctx.other)] } }).catch(() => {});
    await EmployeeVerification.deleteMany({ school: { $in: [sid(ctx.school), sid(ctx.other)] } }).catch(() => {});
    await ActivityLog.deleteMany({ school: { $in: [sid(ctx.school), sid(ctx.other)] } }).catch(() => {});
    await ClassSection.deleteMany({ school: sid(ctx.school) }).catch(() => {});
    await Class.deleteMany({ school: sid(ctx.school) }).catch(() => {});
    await Subject.deleteMany({ school: sid(ctx.school) }).catch(() => {});
    await AcademicYear.deleteMany({ school: sid(ctx.school) }).catch(() => {});
    await TeacherProfile.deleteMany({ user: { $in: ids } }).catch(() => {});
    await Designation.deleteMany({ school: sid(ctx.school) }).catch(() => {});
    await User.deleteMany({ _id: { $in: ids } }).catch(() => {});
    await School.deleteMany({ _id: { $in: [sid(ctx.school), sid(ctx.other)] } }).catch(() => {});
}

(async () => {
    await connectDB();
    const health = await fetch(`http://localhost:${process.env.PORT || 5000}/health`).catch(() => null);
    if (!health?.ok) { console.error('Server is not running on the expected port — start it first.'); process.exit(1); }

    const ctx = await seed();
    const { admin, teacher, peer, student, parent, rivalTeacher, rivalAdmin } = ctx;

    try {
        // ── 1. Who may enter ────────────────────────────────────────────────
        section('Access control — role gate');
        check('school admin reaches the directory',   (await GET('/employee-directory/employees', { as: admin })).status === 200);
        check('teacher reaches the directory',        (await GET('/employee-directory/employees', { as: teacher })).status === 200);
        const stu = await GET('/employee-directory/employees', { as: student });
        check('student is refused', stu.status === 403, `got ${stu.status}`);
        const par = await GET('/employee-directory/employees', { as: parent });
        check('parent is refused', par.status === 403, `got ${par.status}`);
        const anon = await GET('/employee-directory/employees');
        check('unauthenticated is refused', anon.status === 401, `got ${anon.status}`);
        const anonProfile = await GET(`/employee-directory/employees/${sid(teacher)}`);
        check('unauthenticated profile is refused', anonProfile.status === 401);

        // ── 2. Module + designation gate ────────────────────────────────────
        section('Access control — module and designation gate');
        await School.findByIdAndUpdate(sid(ctx.school), { $set: { 'modules.employeeDirectory': false } });
        await designationService.invalidate(sid(ctx.school));
        const off = await GET('/employee-directory/employees', { as: admin });
        check('module disabled refuses even the school admin', off.status === 403 && off.code === 'MODULE_DISABLED', `${off.status} ${off.code}`);
        await School.findByIdAndUpdate(sid(ctx.school), { $set: { 'modules.employeeDirectory': true } });
        await designationService.invalidate(sid(ctx.school));

        const dash = await GET('/employee-directory/dashboard', { as: teacher });
        check('normal-access teacher cannot open the admin dashboard', dash.status === 403 && dash.code === 'MODULE_ADMIN_REQUIRED', `${dash.status} ${dash.code}`);
        check('module-admin teacher CAN open the dashboard', (await GET('/employee-directory/dashboard', { as: peer })).status === 200);
        check('school admin can open the dashboard', (await GET('/employee-directory/dashboard', { as: admin })).status === 200);

        // ── 3. Tenant isolation ─────────────────────────────────────────────
        section('Multi-tenant isolation');
        const mine = await GET('/employee-directory/employees?limit=100', { as: admin });
        const ids  = (mine.data?.employees || []).map((e) => e._id);
        check('list contains this school\'s employees', ids.includes(sid(teacher)) && ids.includes(sid(peer)));
        check('list excludes the other school\'s employee', !ids.includes(sid(rivalTeacher)));

        const cross = await GET(`/employee-directory/employees/${sid(rivalTeacher)}`, { as: admin });
        check('profile of a foreign employee is 404, not a record', cross.status === 404, `got ${cross.status}`);
        const crossBack = await GET(`/employee-directory/employees/${sid(teacher)}`, { as: rivalAdmin });
        check('foreign admin cannot read our employee', crossBack.status === 404, `got ${crossBack.status}`);
        const crossTt = await GET(`/employee-directory/employees/${sid(rivalTeacher)}/timetable`, { as: admin });
        check('foreign employee timetable is 404', crossTt.status === 404);
        const crossReveal = await POST(`/employee-directory/employees/${sid(rivalTeacher)}/reveal`, { as: admin, body: { field: 'aadhaarNumber' } });
        check('foreign employee reveal is 404', crossReveal.status === 404);
        const nonEmployee = await GET(`/employee-directory/employees/${sid(student)}`, { as: admin });
        check('a student id is not an employee record', nonEmployee.status === 404);

        // ── 4. Field-level restriction for teachers ─────────────────────────
        section('Field-level permissions — teacher viewing a peer');
        const peerView = await GET(`/employee-directory/employees/${sid(peer)}`, { as: teacher });
        check('teacher can open a peer profile', peerView.status === 200, `got ${peerView.status}`);
        const pv = peerView.data || {};
        const asText = JSON.stringify(pv);
        check('peer name / designation / department are present', !!pv.overview?.name && !!pv.overview?.designation && !!pv.overview?.department);
        check('official email + phone are present', !!pv.overview?.officialEmail);
        check('subjects & classes are present', Array.isArray(pv.subjectsClasses?.assignments));
        check('governmentIds block is absent', pv.governmentIds === undefined);
        check('bank block is absent', pv.bank === undefined);
        check('payroll block is absent', pv.payroll === undefined);
        check('personal block is absent', pv.personal === undefined);
        check('contact block is absent', pv.contact === undefined);
        check('documents block is absent', pv.documents === undefined);
        check('raw Aadhaar appears nowhere in the payload', !asText.includes(AADHAAR));
        check('raw PAN appears nowhere in the payload', !asText.includes(PAN));
        check('raw account number appears nowhere in the payload', !asText.includes(ACCOUNT));
        check('no previous-employer history leaks', !asText.includes('Old School'));

        const peerAtt = await GET(`/employee-directory/employees/${sid(peer)}/attendance`, { as: teacher });
        check('peer attendance is refused', peerAtt.status === 403, `got ${peerAtt.status}`);
        const peerLeave = await GET(`/employee-directory/employees/${sid(peer)}/leave`, { as: teacher });
        check('peer leave is refused', peerLeave.status === 403, `got ${peerLeave.status}`);
        const peerReveal = await POST(`/employee-directory/employees/${sid(peer)}/reveal`, { as: teacher, body: { field: 'aadhaarNumber' } });
        check('teacher cannot reveal a peer Aadhaar', peerReveal.status === 403, `got ${peerReveal.status}`);
        const teacherReport = await GET('/employee-directory/reports/directory', { as: teacher });
        check('teacher cannot pull an administrative export', teacherReport.status === 403, `got ${teacherReport.status}`);

        // list view is restricted too
        const teacherList = await GET('/employee-directory/employees?limit=100', { as: teacher });
        const listText = JSON.stringify(teacherList.data?.employees || []);
        check('list rows carry no raw Aadhaar for a teacher', !listText.includes(AADHAAR));
        // Their own row is the exception — an employee always sees their own record.
        check('peer rows carry no profile-completion for a teacher',
            !(teacherList.data?.employees || []).filter((e) => e._id !== sid(teacher)).some((e) => e.profileCompletion !== undefined));
        check('the teacher\'s own row still carries their completion',
            (teacherList.data?.employees || []).find((e) => e._id === sid(teacher))?.profileCompletion !== undefined);

        // The workforce roll-ups are administrative: a teacher looking a
        // colleague up has no use for them and is refused outright.
        for (const [name, path] of [['departments', '/employee-directory/departments'],
                                    ['designations', '/employee-directory/designations'],
                                    ['org structure', '/employee-directory/org-structure']]) {
            const denied = await GET(path, { as: teacher });
            check(`${name} is refused to a normal directory user`,
                denied.status === 403, `${denied.status}`);
            const allowed = await GET(path, { as: admin });
            const txt = JSON.stringify(allowed.data || {});
            check(`${name} is served to an administrator, and leaks nothing sensitive`,
                allowed.status === 200 && !txt.includes(AADHAAR) && !txt.includes(PAN)
                && !txt.includes(ACCOUNT) && !txt.includes('Lake Road') && !txt.includes('HDFC0001234'),
                `${allowed.status}`);
        }
        // /meta is the one every directory user needs, so it stays open — and
        // must still carry nothing sensitive.
        const metaLeak = await GET('/employee-directory/meta', { as: teacher });
        const metaTxt = JSON.stringify(metaLeak.data || {});
        check('meta is served to a teacher and leaks nothing sensitive',
            metaLeak.status === 200 && !metaTxt.includes(AADHAAR) && !metaTxt.includes(PAN)
            && !metaTxt.includes(ACCOUNT) && !metaTxt.includes('Lake Road'));

        // The teacher tier is a lookup, not an HR view: employment facts are
        // not on the row at all.
        const peerRow = (teacherList.data?.employees || []).find((e) => e._id !== sid(teacher));
        check('peer row carries no joining date',      peerRow?.joiningDate === undefined);
        check('peer row carries no staff classification', peerRow?.staffType === undefined);
        check('peer row carries no account status',    peerRow?.employmentStatus === undefined && peerRow?.isActive === undefined);
        check('peer row still carries name / id / designation / department',
            !!peerRow?.name && peerRow?.employeeId !== undefined && peerRow?.designation !== undefined && peerRow?.department !== undefined);
        check('peer row still carries subjects, classes and contact',
            Array.isArray(peerRow?.subjects) && Array.isArray(peerRow?.classes) && !!peerRow?.officialEmail);

        const tMeta = await GET('/employee-directory/meta', { as: teacher });
        check('administrative filters are not offered to a teacher',
            (tMeta.data?.filters?.statuses || []).length === 0
            && (tMeta.data?.filters?.staffTypes || []).length === 0
            && (tMeta.data?.filters?.joiningYears || []).length === 0
            && (tMeta.data?.filters?.managers || []).length === 0);
        const aMeta = await GET('/employee-directory/meta', { as: admin });
        check('administrative filters ARE offered to an admin',
            (aMeta.data?.filters?.statuses || []).length === 3 && (aMeta.data?.filters?.staffTypes || []).length === 2);

        // ── 5. Self access ──────────────────────────────────────────────────
        section('Self access — a teacher reads their own record');
        const selfView = await GET(`/employee-directory/employees/${sid(teacher)}`, { as: teacher });
        const sv = selfView.data || {};
        check('own personal block is present', !!sv.personal?.bloodGroup);
        check('own contact block is present', !!sv.contact?.currentAddress?.line);
        check('own government IDs are present but MASKED', sv.governmentIds?.aadhaarNumber === 'XXXX XXXX 9012', sv.governmentIds?.aadhaarNumber);
        check('own PAN is masked', sv.governmentIds?.panNumber === 'XXXXX1234F', sv.governmentIds?.panNumber);
        check('own bank account is masked', sv.bank?.accountNumber === 'XXXX XXXX 4521', sv.bank?.accountNumber);
        check('own raw Aadhaar is not in the payload', !JSON.stringify(sv).includes(AADHAAR));
        check('own profile completion is present', typeof sv.profileCompletion?.percent === 'number');
        check('own attendance is allowed', (await GET(`/employee-directory/employees/${sid(teacher)}/attendance`, { as: teacher })).status === 200);
        check('own leave is allowed', (await GET(`/employee-directory/employees/${sid(teacher)}/leave`, { as: teacher })).status === 200);

        // ── 6. Admin sees masked, then reveals ──────────────────────────────
        section('Administrator — masked by default, audited reveal');
        const adminView = await GET(`/employee-directory/employees/${sid(teacher)}`, { as: admin });
        const av = adminView.data || {};
        check('admin gets the personal block', !!av.personal?.dob);
        check('admin gets government IDs masked', av.governmentIds?.aadhaarNumber === 'XXXX XXXX 9012');
        check('admin gets bank masked', av.bank?.accountNumber === 'XXXX XXXX 4521');
        check('admin profile response has no raw Aadhaar', !JSON.stringify(av).includes(AADHAAR));
        check('admin profile response has no raw account number', !JSON.stringify(av).includes(ACCOUNT));
        check('admin gets documents', Array.isArray(av.documents) && av.documents.length > 0);

        const logsBefore = await ActivityLog.countDocuments({ school: sid(ctx.school), actionType: 'REVEAL_EMPLOYEE_SENSITIVE_FIELD' });
        const reveal = await POST(`/employee-directory/employees/${sid(teacher)}/reveal`, { as: admin, body: { field: 'aadhaarNumber' } });
        check('admin can reveal Aadhaar', reveal.status === 200 && reveal.data?.value === AADHAAR, `${reveal.status} ${reveal.data?.value}`);
        const revealBank = await POST(`/employee-directory/employees/${sid(teacher)}/reveal`, { as: admin, body: { field: 'bankAccountNumber' } });
        check('admin with payroll admin can reveal the account number', revealBank.status === 200 && revealBank.data?.value === ACCOUNT);
        const revealJunk = await POST(`/employee-directory/employees/${sid(teacher)}/reveal`, { as: admin, body: { field: 'password' } });
        check('an arbitrary field cannot be revealed', revealJunk.status === 400, `got ${revealJunk.status}`);
        const logsAfter = await ActivityLog.countDocuments({ school: sid(ctx.school), actionType: 'REVEAL_EMPLOYEE_SENSITIVE_FIELD' });
        check('every reveal is written to the audit log', logsAfter === logsBefore + 2, `${logsBefore} → ${logsAfter}`);
        const lastLog = (await ActivityLog.find({ school: sid(ctx.school), actionType: 'REVEAL_EMPLOYEE_SENSITIVE_FIELD' }).sort({ createdAt: -1 }).limit(1).lean())[0];
        check('the audit entry records the field but NOT the value',
            lastLog?.newValue?.field && !JSON.stringify(lastLog.newValue).includes(ACCOUNT) && !JSON.stringify(lastLog.newValue).includes(AADHAAR));

        // module-admin teacher without payroll admin
        await Designation.findOneAndUpdate({ school: sid(ctx.school), name: 'Principal' }, {
            $set: { permissions: { ...designationService.defaultPermissionsFor('Principal'), employeeDirectory: 'admin', payroll: 'user' } },
        });
        await designationService.invalidate(sid(ctx.school));
        const noPayroll = await POST(`/employee-directory/employees/${sid(teacher)}/reveal`, { as: peer, body: { field: 'bankAccountNumber' } });
        check('module admin WITHOUT payroll admin cannot reveal the account number', noPayroll.status === 403, `got ${noPayroll.status}`);
        const stillAadhaar = await POST(`/employee-directory/employees/${sid(teacher)}/reveal`, { as: peer, body: { field: 'aadhaarNumber' } });
        check('module admin can still reveal Aadhaar', stillAadhaar.status === 200);
        const noBankBlock = await GET(`/employee-directory/employees/${sid(teacher)}`, { as: peer });
        check('bank block is absent without payroll admin', noBankBlock.data?.bank === undefined);

        // ── 7. Search / filter / sort / paginate ────────────────────────────
        section('Search, filters, sorting, pagination');
        const byName = await GET('/employee-directory/employees?search=asha', { as: admin });
        check('partial, case-insensitive name search works', (byName.data?.employees || []).some((e) => e._id === sid(teacher)) && byName.data.total === 1, `total=${byName.data?.total}`);
        const byEmp = await GET('/employee-directory/employees?search=EDT0002', { as: admin });
        check('employee id search works', (byEmp.data?.employees || [])[0]?._id === sid(peer));
        const byEmail = await GET(`/employee-directory/employees?search=${TAG}.bala`, { as: admin });
        check('email search works', (byEmail.data?.employees || [])[0]?._id === sid(peer));
        const bySubject = await GET('/employee-directory/employees?search=mathematics', { as: admin });
        check('subject search works', (bySubject.data?.employees || []).some((e) => e._id === sid(teacher)));
        const noHit = await GET('/employee-directory/employees?search=zzzznotarealname', { as: admin });
        check('a search with no hits returns an empty page, not an error', noHit.status === 200 && noHit.data.total === 0);

        const depFilter = await GET('/employee-directory/employees?department=Administration', { as: admin });
        check('department filter works', depFilter.data?.total === 1 && depFilter.data.employees[0]._id === sid(peer));
        const twoFilters = await GET('/employee-directory/employees?department=Mathematics&designation=Teacher', { as: admin });
        check('two filters combine', twoFilters.data?.total === 1 && twoFilters.data.employees[0]._id === sid(teacher));
        const staffFilter = await GET('/employee-directory/employees?staffType=teaching', { as: admin });
        check('teaching filter finds the assigned teacher', (staffFilter.data?.employees || []).some((e) => e._id === sid(teacher)));
        const classFilter = await GET(`/employee-directory/employees?classId=${sid(ctx.cls)}`, { as: admin });
        check('class filter works', (classFilter.data?.employees || []).some((e) => e._id === sid(teacher)));
        const yearFilter = await GET('/employee-directory/employees?joiningYear=2021', { as: admin });
        check('joining-year filter works', yearFilter.data?.total >= 1);

        const paged = await GET('/employee-directory/employees?limit=1&page=1', { as: admin });
        check('page size is honoured server-side', (paged.data?.employees || []).length === 1 && paged.data.total === 2, `len=${paged.data?.employees?.length} total=${paged.data?.total}`);
        const page2 = await GET('/employee-directory/employees?limit=1&page=2', { as: admin });
        check('page 2 returns a different employee', page2.data?.employees?.[0]?._id !== paged.data?.employees?.[0]?._id);
        check('pages count is reported', paged.data?.pages === 2);
        const badLimit = await GET('/employee-directory/employees?limit=99999', { as: admin });
        check('an out-of-range page size is clamped instead of dumping the table', badLimit.data?.limit === 100, `limit=${badLimit.data?.limit}`);
        const zeroLimit = await GET('/employee-directory/employees?limit=0', { as: admin });
        check('a zero page size falls back to the default', zeroLimit.data?.limit === 25);

        const ascName  = await GET('/employee-directory/employees?sortBy=name&sortDir=asc',  { as: admin });
        const descName = await GET('/employee-directory/employees?sortBy=name&sortDir=desc', { as: admin });
        check('sorting runs server-side and reverses', ascName.data?.employees?.[0]?._id === descName.data?.employees?.at(-1)?._id);
        const byJoin = await GET('/employee-directory/employees?sortBy=joiningDate', { as: admin });
        check('sort by joining date is accepted', byJoin.status === 200);

        // ── 8. Derived facts ────────────────────────────────────────────────
        section('Derived facts read from existing modules');
        const tView = (await GET(`/employee-directory/employees/${sid(teacher)}`, { as: admin })).data;
        check('class-teacher assignment is read from ClassSection', (tView.overview?.classTeacherOf || []).length === 1, JSON.stringify(tView.overview?.classTeacherOf));
        check('subject assignment is read from SectionSubjectTeacher', (tView.overview?.subjects || []).includes('Mathematics'));
        check('assignment rows carry the role', (tView.subjectsClasses?.assignments || []).some((a) => a.role === 'class_teacher'));
        check('staff type is derived as teaching', tView.overview?.staffType === 'teaching' && tView.overview?.staffTypeSource === 'derived');
        check('education reads the existing qualification', (tView.education?.qualifications || []).some((q) => q.qualification === 'M.Sc.'));
        check('employment status comes from the account flag', tView.overview?.employmentStatus === 'active');
        check('profile completion is a real number', tView.profileCompletion.percent > 0 && tView.profileCompletion.percent <= 100);
        const ttRes = await GET(`/employee-directory/employees/${sid(teacher)}/timetable`, { as: admin });
        check('timetable endpoint answers from the timetable module', ttRes.status === 200 && Array.isArray(ttRes.data?.days));

        // ── 9. Administrative writes + audit ────────────────────────────────
        section('Administrative writes');
        const setDept = await PUT(`/employee-directory/employees/${sid(teacher)}/employment`, {
            as: admin, body: { department: 'Science', staffType: 'teaching', reportingManager: sid(peer) },
        });
        check('admin can set department / staff type / manager', setDept.status === 200, setDept.message);
        const afterSet = (await GET(`/employee-directory/employees/${sid(teacher)}`, { as: admin })).data;
        check('the change is written to the EXISTING employee record', afterSet.overview?.department === 'Science');
        check('reporting manager resolves to a real employee', afterSet.overview?.reportingManager?._id === sid(peer));
        check('staff type is now explicit', afterSet.overview?.staffTypeSource === 'set');
        const placementLog = await ActivityLog.findOne({ school: sid(ctx.school), actionType: 'UPDATE_EMPLOYEE_DIRECTORY_PLACEMENT' }).lean();
        check('the write is audited with the previous value', placementLog?.oldValue?.department === 'Mathematics' && placementLog?.newValue?.department === 'Science');

        const selfManager = await PUT(`/employee-directory/employees/${sid(teacher)}/employment`, { as: admin, body: { reportingManager: sid(teacher) } });
        check('an employee cannot report to themselves', selfManager.status === 400);
        const loop = await PUT(`/employee-directory/employees/${sid(peer)}/employment`, { as: admin, body: { reportingManager: sid(teacher) } });
        check('a reporting loop is refused', loop.status === 400, loop.message);
        const foreignManager = await PUT(`/employee-directory/employees/${sid(teacher)}/employment`, { as: admin, body: { reportingManager: sid(rivalTeacher) } });
        check('a manager from another school is refused', foreignManager.status === 400);
        const teacherWrite = await PUT(`/employee-directory/employees/${sid(peer)}/employment`, { as: teacher, body: { department: 'Hacked' } });
        check('a normal-access teacher cannot write', teacherWrite.status === 403);

        // ── 10. Responsibilities ────────────────────────────────────────────
        section('Responsibilities');
        const mkResp = await POST('/employee-directory/responsibilities', {
            as: admin, body: { employee: sid(teacher), type: 'hod', department: 'Science' },
        });
        check('admin can assign a responsibility', mkResp.status === 201, mkResp.message);
        const respList = await GET('/employee-directory/responsibilities', { as: teacher });
        check('responsibilities are readable by any directory user', respList.status === 200 && respList.data.responsibilities.length === 1);
        const withResp = (await GET(`/employee-directory/employees/${sid(teacher)}`, { as: teacher })).data;
        check('the responsibility shows on the profile', (withResp.responsibilities || []).some((r) => r.label === 'HOD'));
        const foreignResp = await POST('/employee-directory/responsibilities', { as: admin, body: { employee: sid(rivalTeacher), type: 'hod' } });
        check('a responsibility cannot be pinned on a foreign employee', foreignResp.status === 400);
        const teacherResp = await POST('/employee-directory/responsibilities', { as: teacher, body: { employee: sid(peer), type: 'hod' } });
        check('a normal-access teacher cannot assign one', teacherResp.status === 403);
        check('removing a responsibility works', (await DEL(`/employee-directory/responsibilities/${mkResp.data._id}`, { as: admin })).status === 200);

        // ── 11. Verification ────────────────────────────────────────────────
        section('Verification');
        const setVer = await PUT(`/employee-directory/employees/${sid(teacher)}/verification`, {
            as: admin, body: { section: 'government_id', status: 'verified' },
        });
        check('admin can verify a section', setVer.status === 200, setVer.message);
        const verView = (await GET(`/employee-directory/employees/${sid(teacher)}`, { as: admin })).data;
        check('the section reads back as verified', verView.verification.find((v) => v.section === 'government_id')?.status === 'verified');
        check('an untouched section reads as pending', verView.verification.find((v) => v.section === 'bank')?.status === 'pending');
        const badSection = await PUT(`/employee-directory/employees/${sid(teacher)}/verification`, { as: admin, body: { section: 'nonsense', status: 'verified' } });
        check('an unknown verification section is refused', badSection.status === 400);
        const queue = await GET('/employee-directory/verification', { as: admin });
        check('the verification queue lists employees', queue.status === 200 && queue.data.employees.length === 2);

        // ── Evidence gating ────────────────────────────────────────────────
        // The queue has to carry the paperwork a reviewer must open, otherwise
        // the UI cannot tell "reviewed" from "rubber-stamped".
        const row = queue.data.employees.find((e) => e._id === sid(teacher));
        const govt = row.sections.find((x) => x.section === 'government_id');
        check('a document-backed section lists its documents',
            govt.documentBacked === true && govt.documents.length === 3,
            JSON.stringify(govt.documents?.map((d) => d.key)));
        check('each document carries a label and a URL',
            govt.documents.every((d) => d.label && d.url.startsWith('/uploads/staff-docs/')));
        const personal = row.sections.find((x) => x.section === 'personal');
        check('a field-only section reports no documents to open',
            personal.documentBacked === false && personal.documents.length === 0);
        check('a field-only section is not flagged as missing paperwork',
            personal.missingDocuments === false);

        // A teacher whose paperwork was never uploaded: the document-backed
        // sections have nothing to review, so they cannot be signed off.
        const noDocs = await mkUser({ school: ctx.school, role: 'teacher', name: `${TAG} Bare`, email: `${TAG}.bare@x.test` });
        await TeacherProfile.create({ user: sid(noDocs), school: sid(ctx.school), employeeId: 'EDT0003', designation: 'Teacher' });
        const queue2 = await GET('/employee-directory/verification', { as: admin });
        const bare = queue2.data.employees.find((e) => e._id === sid(noDocs));
        const bareGovt = bare.sections.find((x) => x.section === 'government_id');
        check('a document-backed section with no uploads is flagged',
            bareGovt.documentBacked === true && bareGovt.missingDocuments === true
            && bareGovt.documents.length === 0);

        const noEvidence = await PUT(`/employee-directory/employees/${sid(noDocs)}/verification`, {
            as: admin, body: { section: 'government_id', status: 'verified' },
        });
        check('verifying a section with no document on file is refused',
            noEvidence.status === 400 && /no document on file/i.test(noEvidence.message || ''), noEvidence.message);
        const stillPending = await EmployeeVerification.findOne({ employee: sid(noDocs), section: 'government_id' }).lean();
        check('and nothing was recorded', !stillPending || stillPending.status !== 'verified');

        check('a field-only section can still be verified',
            (await PUT(`/employee-directory/employees/${sid(noDocs)}/verification`, {
                as: admin, body: { section: 'personal', status: 'verified' },
            })).status === 200);
        check('a document-backed section WITH uploads can be verified',
            (await PUT(`/employee-directory/employees/${sid(teacher)}/verification`, {
                as: admin, body: { section: 'employment_documents', status: 'verified' },
            })).status === 200);
        check('marking one pending is never blocked',
            (await PUT(`/employee-directory/employees/${sid(noDocs)}/verification`, {
                as: admin, body: { section: 'government_id', status: 'pending' },
            })).status === 200);
        await TeacherProfile.deleteMany({ user: sid(noDocs) });
        await User.findByIdAndDelete(sid(noDocs));
        check('teacher cannot open the verification queue', (await GET('/employee-directory/verification', { as: teacher })).status === 403);

        // ── 12. Structure endpoints ─────────────────────────────────────────
        section('Departments, designations, org structure');
        const deps = await GET('/employee-directory/departments', { as: admin });
        check('departments are derived from the employee records', deps.status === 200 && deps.data.departments.some((d) => d.name === 'Science'));
        const desigs = await GET('/employee-directory/designations', { as: admin });
        check('designations roll up', desigs.data.designations.some((d) => d.name === 'Principal'));
        const org = await GET('/employee-directory/org-structure', { as: admin });
        check('org structure reports a reporting line', org.data.hasReportingLines === true);
        check('org tree nests the report under the manager',
            org.data.tree.some((n) => n._id === sid(peer) && n.children.some((c) => c._id === sid(teacher))), JSON.stringify(org.data.tree.map((n) => [n.name, n.children.length])));
        check('org structure also groups by department', Array.isArray(org.data.byDepartment) && org.data.byDepartment.length > 0);

        // The row carries the manager as a resolved person (for the cards and
        // the reporting panel) AND the raw id (for the tree and the filter).
        const withMgr = (await GET('/employee-directory/employees?limit=100', { as: admin }))
            .data.employees.find((e) => e._id === sid(teacher));
        check('the manager is resolved to a name on the row',
            withMgr?.reportingManager?.name?.includes('Bala'), JSON.stringify(withMgr?.reportingManager));
        check('the manager filter still matches on the id',
            (await GET(`/employee-directory/employees?reportingManager=${sid(peer)}`, { as: admin })).data.total === 1);
        // The profile carries the manager as a person; the reporting-structure
        // panel was dropped from the directory, so it must not come back.
        const panel = (await GET(`/employee-directory/employees/${sid(teacher)}`, { as: admin })).data;
        check('the profile resolves the manager to a person',
            panel.overview?.reportingManager?.name?.includes('Bala'),
            JSON.stringify(panel.overview?.reportingManager));
        check('the profile no longer ships a reporting-structure panel',
            panel.reportingStructure === undefined);

        // ── 13. Reports & exports ───────────────────────────────────────────
        section('Reports and exports');
        const repList = await GET('/employee-directory/reports', { as: admin });
        check('report catalogue is served', repList.data.reports.length >= 10);
        const repJson = await GET('/employee-directory/reports/directory', { as: admin });
        check('directory report returns rows', repJson.data.rows.length === 2);
        const repText = JSON.stringify(repJson.data);
        check('the report carries no Aadhaar', !repText.includes(AADHAAR));
        check('the report carries no account number', !repText.includes(ACCOUNT));
        const csv = await GET('/employee-directory/reports/directory?format=csv', { as: admin });
        check('CSV export is served as a file', csv.status === 200 && csv.contentType.includes('text/csv') && csv.text.includes('Employee ID'));
        check('CSV export carries no Aadhaar', !csv.text.includes(AADHAAR));
        const xlsx = await GET('/employee-directory/reports/directory?format=xlsx', { as: admin });
        check('XLSX export is served', xlsx.status === 200 && xlsx.contentType.includes('spreadsheetml'));
        const unknownReport = await GET('/employee-directory/reports/not-a-report', { as: admin });
        check('an unknown report is 404', unknownReport.status === 404);
        const filteredReport = await GET('/employee-directory/reports/directory?department=Science', { as: admin });
        check('a report honours the directory filters', filteredReport.data.rows.length === 1);

        // ── 14. Meta & dashboard content ────────────────────────────────────
        section('Meta and dashboard');
        const meta = await GET('/employee-directory/meta', { as: admin });
        check('meta reports the viewer level', meta.data.viewer.level === 'admin');
        check('meta lists departments for the filter', meta.data.filters.departments.length > 0);
        check('meta reports campus as unsupported', (meta.data.unsupported || []).includes('campus'));
        const teacherMeta = await GET('/employee-directory/meta', { as: teacher });
        check('a teacher sees their own level as user', teacherMeta.data.viewer.level === 'user');
        check('a teacher is told they cannot reveal', teacherMeta.data.viewer.canReveal === false);

        const d = (await GET('/employee-directory/dashboard', { as: admin })).data;
        check('dashboard counts real employees', d.totals.employees === 2);
        check('dashboard counts active employees', d.totals.active === 2);
        check('dashboard splits teaching / non-teaching', d.totals.teaching + d.totals.nonTeaching === 2);
        check('dashboard counts pending verification', d.totals.pendingVerification === 2);
        check('dashboard reports average completion', d.averageCompletion > 0);

        // ── 15. Inactive employee ───────────────────────────────────────────
        section('Employee status follows the existing account flag');
        await User.findByIdAndUpdate(sid(peer), { $set: { isActive: false } });
        const afterDeactivate = (await GET('/employee-directory/dashboard', { as: admin })).data;
        check('deactivating the account moves the employee to inactive', afterDeactivate.totals.inactive === 1 && afterDeactivate.totals.active === 1,
            `active=${afterDeactivate.totals.active} inactive=${afterDeactivate.totals.inactive}`);
        const inactiveFilter = await GET('/employee-directory/employees?status=inactive', { as: admin });
        check('the inactive filter finds them', inactiveFilter.data.total === 1 && inactiveFilter.data.employees[0]._id === sid(peer));
        await User.findByIdAndUpdate(sid(peer), { $set: { isActive: true } });
    } finally {
        await cleanup(ctx);
    }

    console.log(results.join('\n'));
    console.log(`\n${'─'.repeat(60)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(60)}`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
