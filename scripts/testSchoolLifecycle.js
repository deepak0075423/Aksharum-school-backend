'use strict';
/**
 * School lifecycle — end-to-end tests for the rules that guard a school row.
 *
 *   node server.js &
 *   node scripts/testSchoolLifecycle.js
 *
 * Two properties are under test:
 *
 *   • A school that still has accounts cannot be deleted. The check is served
 *     to the confirm dialog AND re-applied on the delete itself, so a school
 *     that gains a user between the two is still refused.
 *   • Deactivating a school locks everyone in it out — new logins are refused
 *     with a role-appropriate message, and tokens already issued stop working.
 *     A Super Admin has no school and is never affected.
 */
require('dotenv').config({ quiet: true });
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const connectDB = require('../config/db');
const School = require('../models/School');
const User   = require('../models/User');

let passed = 0, failed = 0;
const results = [];
const check = (name, cond, detail = '') => {
    if (cond) { passed += 1; results.push(`  ✅ ${name}`); }
    else { failed += 1; results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t) => results.push(`\n▸ ${t}`);

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
const TAG  = `sltest_${Date.now()}`;
const sid  = (v) => String(v?._id ?? v);
const token = (u) => jwt.sign({ userId: sid(u), role: u.role, schoolId: sid(u.school) }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function call(method, path, { as, body } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token(as)}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const ct = res.headers.get('content-type') || '';
    let json = null;
    if (ct.includes('json')) { try { json = await res.json(); } catch {} }
    return { status: res.status, body: json, data: json?.data, message: json?.message, code: json?.code, contentType: ct, res };
}
const GET = (p, o) => call('GET', p, o);
const DEL = (p, o) => call('DELETE', p, o);
const POST = (p, o) => call('POST', p, o);

const PASSWORD = 'Passw0rd!42';
const mkUser = async ({ school, role, name, email }) => {
    const u = await User.create({
        name, email, role, school: school ? sid(school) : null,
        password: await bcrypt.hash(PASSWORD, 4), isFirstLogin: false, isActive: true,
    });
    u.school = school || null;
    return u;
};
const login = (email) => POST('/auth/login', { body: { email, password: PASSWORD } });

(async () => {
    await connectDB();
    const health = await fetch(`http://localhost:${process.env.PORT || 5000}/health`).catch(() => null);
    if (!health?.ok) { console.error('Server is not running — start it first.'); process.exit(1); }

    const superAdmin = await mkUser({ school: null, role: 'super_admin', name: `${TAG} Super`, email: `${TAG}.super@x.test` });
    const populated  = await School.create({ name: `${TAG} Populated`, code: 'SLP', isActive: true });
    const empty      = await School.create({ name: `${TAG} Empty`,     code: 'SLE', isActive: true });

    const admin   = await mkUser({ school: populated, role: 'school_admin', name: `${TAG} Admin`,   email: `${TAG}.admin@x.test` });
    const teacher = await mkUser({ school: populated, role: 'teacher',      name: `${TAG} Teacher`, email: `${TAG}.teach@x.test` });
    const student = await mkUser({ school: populated, role: 'student',      name: `${TAG} Student`, email: `${TAG}.stud@x.test` });

    try {
        // ── Delete guard ────────────────────────────────────────────────────
        section('Deleting a school is refused while it still has accounts');

        const chk = await GET(`/super-admin/schools/${sid(populated)}/delete-check`, { as: superAdmin });
        check('delete-check answers', chk.status === 200, chk.message);
        check('it reports the school is NOT deletable', chk.data?.canDelete === false);
        check('it counts every account', chk.data?.userCount === 3, `got ${chk.data?.userCount}`);
        check('it breaks the count down by role',
            (chk.data?.byRole || []).some((r) => r.role === 'teacher' && r.count === 1)
            && (chk.data?.byRole || []).some((r) => r.role === 'student' && r.count === 1));
        check('it lists the blocking accounts by name and email',
            (chk.data?.users || []).some((u) => u.email === `${TAG}.teach@x.test` && u.roleLabel === 'Teacher'));

        const blocked = await DEL(`/super-admin/schools/${sid(populated)}`, { as: superAdmin });
        check('the delete itself is refused, not just the dialog',
            blocked.status === 409 && blocked.code === 'SCHOOL_HAS_USERS', `${blocked.status} ${blocked.code}`);
        check('the refusal says how many accounts block it', /3 accounts/.test(blocked.message || ''), blocked.message);
        check('the school still exists after a refused delete', !!(await School.findById(sid(populated)).lean()));

        const xlsx = await GET(`/super-admin/schools/${sid(populated)}/users/export`, { as: superAdmin });
        check('the blocking accounts export as a spreadsheet',
            xlsx.status === 200 && xlsx.contentType.includes('spreadsheetml'), xlsx.contentType);
        const buf = Buffer.from(await xlsx.res.arrayBuffer());
        check('the spreadsheet has content', buf.length > 1000, `${buf.length} bytes`);

        section('A school with no accounts deletes normally');
        const emptyChk = await GET(`/super-admin/schools/${sid(empty)}/delete-check`, { as: superAdmin });
        check('an empty school reports as deletable', emptyChk.data?.canDelete === true && emptyChk.data?.userCount === 0);
        const gone = await DEL(`/super-admin/schools/${sid(empty)}`, { as: superAdmin });
        check('and is deleted', gone.status === 200, gone.message);
        check('the row is really gone', !(await School.findById(sid(empty)).lean()));

        section('Only a Super Admin may run these checks');
        check('a school admin cannot read delete-check',
            (await GET(`/super-admin/schools/${sid(populated)}/delete-check`, { as: admin })).status === 403);
        check('a school admin cannot export the user list',
            (await GET(`/super-admin/schools/${sid(populated)}/users/export`, { as: admin })).status === 403);

        // ── Inactive school lockout ─────────────────────────────────────────
        section('An active school signs in normally');
        check('teacher can log in',      (await login(`${TAG}.teach@x.test`)).status === 200);
        check('school admin can log in', (await login(`${TAG}.admin@x.test`)).status === 200);
        const liveToken = await GET('/teacher/dashboard', { as: teacher });
        check('an issued token works', liveToken.status !== 401 && liveToken.status !== 403, `got ${liveToken.status}`);

        section('Deactivating the school locks everyone in it out');
        await School.findByIdAndUpdate(sid(populated), { $set: { isActive: false } });
        // Mirror what the controller does after the toggle.
        await require('../utils/authCache').invalidateMany([sid(admin), sid(teacher), sid(student)]);

        const tLogin = await login(`${TAG}.teach@x.test`);
        check('teacher login is refused', tLogin.status === 403 && tLogin.code === 'SCHOOL_INACTIVE', `${tLogin.status} ${tLogin.code}`);
        check('teacher is told to contact their school administrator',
            /contact your school administrator/i.test(tLogin.message || ''), tLogin.message);

        const sLogin = await login(`${TAG}.stud@x.test`);
        check('student login is refused', sLogin.status === 403 && sLogin.code === 'SCHOOL_INACTIVE');
        check('student is told to contact their school administrator',
            /contact your school administrator/i.test(sLogin.message || ''), sLogin.message);

        const aLogin = await login(`${TAG}.admin@x.test`);
        check('school admin login is refused', aLogin.status === 403 && aLogin.code === 'SCHOOL_INACTIVE');
        check('school admin is told to contact SUPPORT, not themselves',
            /contact support/i.test(aLogin.message || '') && !/school administrator/i.test(aLogin.message || ''), aLogin.message);
        check('the message names the school', (aLogin.message || '').includes(`${TAG} Populated`), aLogin.message);

        check('a wrong password on an inactive school still says Invalid credentials',
            (await POST('/auth/login', { body: { email: `${TAG}.teach@x.test`, password: 'nope' } })).status === 401);

        section('Tokens issued before the deactivation stop working');
        const stale = await GET('/teacher/dashboard', { as: teacher });
        check('an existing session is cut off', stale.status === 403 && stale.code === 'SCHOOL_INACTIVE', `${stale.status} ${stale.code}`);
        const staleAdmin = await GET('/admin/dashboard', { as: admin });
        check('the school admin session is cut off too', staleAdmin.status === 403 && staleAdmin.code === 'SCHOOL_INACTIVE');

        section('The Super Admin is never caught by a school lockout');
        check('super admin still logs in', (await login(`${TAG}.super@x.test`)).status === 200);
        check('super admin still reaches their own area',
            (await GET('/super-admin/schools', { as: superAdmin })).status === 200);

        section('Reactivating the school restores access');
        await School.findByIdAndUpdate(sid(populated), { $set: { isActive: true } });
        await require('../utils/authCache').invalidateMany([sid(admin), sid(teacher), sid(student)]);
        check('teacher can log in again', (await login(`${TAG}.teach@x.test`)).status === 200);
        check('and their token works again',
            ![401, 403].includes((await GET('/teacher/dashboard', { as: teacher })).status));

        section('The Super Admin no longer owns designation access');
        for (const [label, path] of [
            ['read the matrix',  `/super-admin/schools/${sid(populated)}/designations`],
            ['create one',       `/super-admin/schools/${sid(populated)}/designations/new`],
        ]) {
            const r = await GET(path, { as: superAdmin });
            check(`the per-school designation route to ${label} is gone`, r.status === 404, `got ${r.status}`);
        }
        check('a school admin still owns their own designation matrix',
            (await GET('/admin/designations/matrix', { as: admin })).status === 200);
    } finally {
        await User.deleteMany({ _id: { $in: [superAdmin, admin, teacher, student].map(sid) } }).catch(() => {});
        await School.deleteMany({ _id: { $in: [sid(populated), sid(empty)] } }).catch(() => {});
    }

    console.log(results.join('\n'));
    console.log(`\n${'─'.repeat(60)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(60)}`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
