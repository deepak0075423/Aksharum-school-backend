'use strict';
/**
 * Designation-Based Module Access Control — end-to-end tests.
 *
 *   node scripts/testDesignationPermissions.js
 *
 * Drives the whole hierarchy over HTTP against a throwaway school:
 *
 *     School module enablement  →  Designation permission  →  User access
 *
 * The properties under test are the ones the feature is specified on: only
 * school-enabled modules are configurable, teachers inherit their designation's
 * levels, admin vs normal access differ, disabling a module at the school level
 * revokes it everywhere regardless of designation, and re-enabling it restores
 * exactly what was configured.
 */
require('dotenv').config();
const express = require('express');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const XLSX    = require('xlsx');

const connectDB = require('../config/db');

const School         = require('../models/School');
const User           = require('../models/User');
const TeacherProfile = require('../models/TeacherProfile');
const Designation    = require('../models/Designation');

let passed = 0; let failed = 0;
const results = [];
function check(name, condition, detail = '') {
    if (condition) { passed += 1; results.push(`  ✅ ${name}`); }
    else { failed += 1; results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { results.push(`\n▸ ${title}`); }

const TAG = `dptest_${Date.now()}`;
let BASE = '';
const sid = (v) => String(v?._id ?? v);
const token = (user) => jwt.sign(
    { userId: sid(user), role: user.role, schoolId: sid(user.school) },
    process.env.JWT_SECRET, { expiresIn: '1h' },
);

async function call(method, path, { as, body } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token(as)}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* binary */ }
    return { status: res.status, body: json, data: json?.data, message: json?.message, code: json?.code };
}
const GET  = (p, o) => call('GET', p, o);

// The export answers a spreadsheet, not JSON.
async function GETFILE(path, { as } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        headers: { ...(as ? { Authorization: `Bearer ${token(as)}` } : {}) },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
        status: res.status,
        type: res.headers.get('content-type') || '',
        disposition: res.headers.get('content-disposition') || '',
        buf,
    };
}
const POST = (p, o) => call('POST', p, o);
const PUT  = (p, o) => call('PUT', p, o);
const DEL  = (p, o) => call('DELETE', p, o);

async function makeUser(name, role, schoolId) {
    const u = await User.create({
        name, email: `${TAG}_${name.toLowerCase()}@example.test`,
        password: await bcrypt.hash('Passw0rd123', 4),
        role, school: schoolId, isFirstLogin: false, isActive: true,
    });
    return { ...(u.toObject?.() ?? u), _id: u._id, role, school: schoolId };
}

// The school starts with library + fees + feedback + leave on, payroll off.
const START_MODULES = {
    library: true, fees: true, feedback: true, leave: true, attendance: true,
    payroll: false, transport: false, inventory: false, chat: true,
};

async function buildFixture() {
    const school = await School.create({
        name: `${TAG} High School`,
        designations: ['Teacher', 'Librarian', 'Principal', 'Lab Assistant'],
        modules: { ...START_MODULES },
    });
    const schoolId = sid(school._id);

    const superAdmin = await User.create({
        name: `Super${TAG}`, email: `${TAG}_super@example.test`,
        password: await bcrypt.hash('Passw0rd123', 4),
        role: 'super_admin', school: null, isFirstLogin: false, isActive: true,
    });
    const admin     = await makeUser(`Admin${TAG}`,     'school_admin', schoolId);
    const alice     = await makeUser(`Alice${TAG}`,     'teacher',      schoolId);   // plain Teacher
    const lib       = await makeUser(`Libby${TAG}`,     'teacher',      schoolId);   // Librarian
    const principal = await makeUser(`Prince${TAG}`,    'teacher',      schoolId);   // Principal
    const lab       = await makeUser(`Lab${TAG}`,       'teacher',      schoolId);   // Lab Assistant

    await TeacherProfile.create({ user: sid(alice),     school: schoolId, designation: 'Teacher' });
    await TeacherProfile.create({ user: sid(lib),       school: schoolId, designation: 'Librarian' });
    await TeacherProfile.create({ user: sid(principal), school: schoolId, designation: 'Principal' });
    await TeacherProfile.create({ user: sid(lab),       school: schoolId, designation: 'Lab Assistant' });

    return {
        schoolId, admin, alice, lib, principal, lab,
        superAdmin: { ...(superAdmin.toObject?.() ?? superAdmin), _id: superAdmin._id, role: 'super_admin', school: null },
    };
}

async function cleanup(schoolId, superAdminId) {
    await Designation.deleteMany({ school: schoolId });
    await TeacherProfile.deleteMany({ school: schoolId });
    await User.deleteMany({ school: schoolId });
    if (superAdminId) await User.findByIdAndDelete(superAdminId);
    await School.findByIdAndDelete(schoolId);
}

(async () => {
    await connectDB();
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/admin',       require('../routes/api/admin'));
    app.use('/api/teacher',     require('../routes/api/teacher'));
    app.use('/api/super-admin', require('../routes/api/superAdmin'));
    app.use('/api/library',     require('../routes/api/library'));
    app.use('/api/fees',        require('../routes/api/fees'));
    app.use('/api/feedback',    require('../routes/api/feedback'));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    BASE = `http://127.0.0.1:${server.address().port}/api`;

    let schoolId; let superAdminId;
    try {
        const f = await buildFixture();
        ({ schoolId } = f);
        const { admin, alice, lib, principal, lab, superAdmin } = f;
        superAdminId = sid(superAdmin);

        const matrix   = () => GET('/admin/designations/matrix', { as: admin });
        const byName   = (m, name) => m.data.designations.find((d) => d.name === name);
        const setPerms = (id, permissions) => PUT(`/admin/designations/${id}`, { as: admin, body: { permissions } });
        const setSchoolModules = (modules) => PUT('/super-admin/permissions', {
            as: superAdmin, body: { schoolId, modules },
        });

        // ══ SEEDING ══════════════════════════════════════════════════════════
        section('The matrix seeds itself from the school\'s existing designations');

        const m0 = await matrix();
        check('Matrix loads for the school admin', m0.status === 200, m0.message);
        check('… one row per existing designation',
            m0.data.designations.length === 4, `${m0.data?.designations?.length} rows`);
        check('… every module is described once', m0.data.modules.length === 16, `${m0.data?.modules?.length}`);
        check('… only school-enabled modules are offered for configuration',
            m0.data.enabledModules.includes('library') && m0.data.enabledModules.includes('fees')
            && !m0.data.enabledModules.includes('payroll'),
            m0.data?.enabledModules?.join(','));
        check('… the three levels are advertised',
            JSON.stringify(m0.data.levels) === JSON.stringify(['none', 'user', 'admin']));

        section('Seeding preserves the privileges those designation names already carried');

        check('Librarian arrives with admin access to Library',
            byName(m0, 'Librarian').permissions.library === 'admin');
        check('Principal arrives with admin access to Feedback',
            byName(m0, 'Principal').permissions.feedback === 'admin');
        check('A plain Teacher arrives with normal access, not admin',
            byName(m0, 'Teacher').permissions.library === 'user'
            && byName(m0, 'Teacher').permissions.feedback === 'user');
        check('Teacher counts are reported per designation',
            byName(m0, 'Teacher').teacherCount === 1 && byName(m0, 'Lab Assistant').teacherCount === 1);

        // ══ INHERITANCE ══════════════════════════════════════════════════════
        section('A teacher inherits the permissions configured for their designation');

        const teacherRow = byName(m0, 'Teacher');
        const labRow     = byName(m0, 'Lab Assistant');

        let mods = await GET('/teacher/modules', { as: alice });
        check('Teacher sees the modules their designation allows',
            mods.data.library === true && mods.data.fees === true, JSON.stringify(mods.data?.permissions));
        check('… with the level spelled out per module',
            mods.data.permissions.library === 'user' && mods.data.permissions.feedback === 'user');
        check('… a module the school has not enabled is off regardless',
            mods.data.payroll === false && mods.data.permissions.payroll === 'none');

        await setPerms(labRow._id, { library: 'none', fees: 'none' });
        mods = await GET('/teacher/modules', { as: lab });
        check('Setting a module to No Access hides it from that designation',
            mods.data.library === false && mods.data.fees === false);
        check('… while the school-level flag still reads enabled',
            mods.data.schoolModules.library === true && mods.data.schoolModules.fees === true);
        check('… and other designations are unaffected',
            (await GET('/teacher/modules', { as: alice })).data.library === true);

        section('No Access is enforced on the API, not just hidden in the nav');

        const labBrowse = await GET('/library/teacher/search?q=x', { as: lab });
        check('A No Access teacher is refused by the module API',
            labBrowse.status === 403 && labBrowse.code === 'MODULE_ACCESS_DENIED',
            `${labBrowse.status} ${labBrowse.code}`);
        const aliceBrowse = await GET('/library/teacher/search?q=x', { as: alice });
        check('A normal-access teacher still reaches it', aliceBrowse.status === 200, aliceBrowse.message);

        // ══ ADMIN vs NORMAL ══════════════════════════════════════════════════
        section('Admin access and normal access are different privileges');

        const libDash = await GET('/library/dashboard', { as: lib });
        check('An admin-access teacher reaches the module\'s admin surface',
            libDash.status === 200, `${libDash.status} ${libDash.message}`);
        const aliceDash = await GET('/library/dashboard', { as: alice });
        check('A normal-access teacher is refused it',
            aliceDash.status === 403 && aliceDash.code === 'MODULE_ADMIN_REQUIRED',
            `${aliceDash.status} ${aliceDash.code}`);
        check('The admin flag is reported to the client',
            (await GET('/teacher/modules', { as: lib })).data.moduleAdmin.library === true
            && (await GET('/teacher/modules', { as: alice })).data.moduleAdmin.library === false);
        check('… and the legacy isLibrarian flag still tracks it',
            (await GET('/teacher/modules', { as: lib })).data.isLibrarian === true
            && (await GET('/teacher/modules', { as: alice })).data.isLibrarian === false);

        section('Promoting a designation to Admin promotes every teacher holding it');

        await setPerms(teacherRow._id, { fees: 'admin' });
        const aliceFees = await GET('/fees/admin/dashboard', { as: alice });
        check('A teacher whose designation gained fees-admin reaches the fees admin API',
            aliceFees.status === 200, `${aliceFees.status} ${aliceFees.message}`);
        const labFees = await GET('/fees/admin/dashboard', { as: lab });
        check('A teacher on another designation still cannot',
            labFees.status === 403, `${labFees.status} ${labFees.code}`);

        await setPerms(teacherRow._id, { fees: 'user' });
        const aliceFees2 = await GET('/fees/admin/dashboard', { as: alice });
        check('Demoting the designation back to normal revokes it again',
            aliceFees2.status === 403 && aliceFees2.code === 'MODULE_ADMIN_REQUIRED',
            `${aliceFees2.status} ${aliceFees2.code}`);

        section('Admin access cannot be granted on a module that has no admin surface');

        await setPerms(teacherRow._id, { chat: 'admin' });
        const m1 = await matrix();
        check('… chat is downgraded to normal access on save',
            byName(m1, 'Teacher').permissions.chat === 'user',
            byName(m1, 'Teacher').permissions.chat);

        // ══ SCHOOL-LEVEL REVOCATION ══════════════════════════════════════════
        section('Disabling a module at the school level revokes it for everyone');

        const before = await matrix();
        const libAdminBefore = byName(before, 'Librarian').permissions.library;

        await setSchoolModules({ ...START_MODULES, library: false });

        const libMods = await GET('/teacher/modules', { as: lib });
        check('The admin-access designation loses the module',
            libMods.data.library === false && libMods.data.permissions.library === 'none');
        check('… and its administrative flag with it',
            libMods.data.moduleAdmin.library === false && libMods.data.isLibrarian === false);
        check('A normal-access designation loses it too',
            (await GET('/teacher/modules', { as: alice })).data.library === false);
        const libDash2 = await GET('/library/dashboard', { as: lib });
        check('The module API refuses even the admin-access teacher',
            libDash2.status === 403 && libDash2.code === 'MODULE_DISABLED',
            `${libDash2.status} ${libDash2.code}`);
        const adminLibDash = await GET('/library/dashboard', { as: admin });
        check('… and refuses the school admin as well',
            adminLibDash.status === 403 && adminLibDash.code === 'MODULE_DISABLED',
            `${adminLibDash.status} ${adminLibDash.code}`);

        section('The configured level survives the revocation and is reapplied on re-enable');

        const during = await matrix();
        check('The disabled module drops out of the configurable list',
            !during.data.enabledModules.includes('library'));
        check('… but the designation keeps the level that was configured',
            byName(during, 'Librarian').permissions.library === libAdminBefore,
            byName(during, 'Librarian').permissions.library);
        check('… while its effective level reads none',
            byName(during, 'Librarian').effectivePermissions.library === 'none');

        await setSchoolModules({ ...START_MODULES, library: true });

        const after = await matrix();
        check('Re-enabling the module restores the stored level',
            byName(after, 'Librarian').permissions.library === 'admin'
            && byName(after, 'Librarian').effectivePermissions.library === 'admin');
        check('… and the teacher gets their admin surface back',
            (await GET('/library/dashboard', { as: lib })).status === 200);
        check('… and the No Access designation stays denied',
            (await GET('/teacher/modules', { as: lab })).data.library === false);

        section('A designation can never out-rank the school flag');

        await setPerms(labRow._id, { payroll: 'admin' });   // payroll is off school-wide
        const labMods = await GET('/teacher/modules', { as: lab });
        check('Admin on a school-disabled module resolves to no access',
            labMods.data.permissions.payroll === 'none' && labMods.data.payroll === false);
        const m2 = await matrix();
        check('… though it is still stored, ready for the module being enabled',
            byName(m2, 'Lab Assistant').permissions.payroll === 'admin');

        // ══ CRUD ═════════════════════════════════════════════════════════════
        section('Managing designations');

        const created = await POST('/admin/designations', {
            as: admin, body: { name: 'Sports Coordinator', permissions: { attendance: 'admin', fees: 'none' } },
        });
        check('A designation can be created with its permissions', created.status === 201, created.message);
        const coachId = sid(created.data);

        const dupe = await POST('/admin/designations', { as: admin, body: { name: 'sports coordinator' } });
        check('Duplicate names are refused case-insensitively', dupe.status === 400, dupe.message);

        const names = await GET('/admin/designations', { as: admin });
        check('The dropdown source still answers a plain string list',
            Array.isArray(names.data) && names.data.includes('Sports Coordinator')
            && typeof names.data[0] === 'string');

        // Reassign Alice through the endpoint the Teachers screen uses, then rename.
        const reassign = await PUT(`/admin/users/${sid(alice)}`, {
            as: admin, body: { name: alice.name, designation: 'Sports Coordinator' },
        });
        check('A teacher can be moved onto another designation', reassign.status === 200, reassign.message);
        const coachMods = await GET('/teacher/modules', { as: alice });
        check('Reassigning a teacher switches which permissions they inherit',
            coachMods.data.permissions.attendance === 'admin' && coachMods.data.fees === false,
            JSON.stringify(coachMods.data?.permissions));

        const renamed = await PUT(`/admin/designations/${coachId}`, { as: admin, body: { name: 'Sports Head' } });
        check('Renaming carries the teachers holding it across',
            renamed.status === 200 && renamed.data.teachersRenamed === 1, JSON.stringify(renamed.data));
        const afterRename = await GET('/teacher/modules', { as: alice });
        check('… so their permissions are unchanged by the rename',
            afterRename.data.permissions.attendance === 'admin' && afterRename.data.fees === false);

        section('Deleting a designation teachers still hold is refused, and says who');

        const delInUse = await DEL(`/admin/designations/${coachId}`, { as: admin });
        check('A designation still held by a teacher cannot be deleted',
            delInUse.status === 400 && delInUse.body?.code === 'DESIGNATION_IN_USE',
            `${delInUse.status} ${delInUse.body?.code}`);
        check('… the message names the designation and the count',
            /Sports Head/.test(delInUse.message || '') && /1 teacher/.test(delInUse.message || ''),
            delInUse.message);
        check('… the blocking teachers come back with the error',
            delInUse.body?.teacherCount === 1 && delInUse.body?.teachers?.length === 1,
            JSON.stringify(delInUse.body?.teachers));
        const blocker = delInUse.body?.teachers?.[0] || {};
        check('… each with the details needed to go and reassign them',
            blocker._id === sid(alice) && blocker.email === alice.email && blocker.name === alice.name
            && 'employeeId' in blocker && 'department' in blocker && 'joiningDate' in blocker
            && blocker.isActive === true,
            JSON.stringify(blocker));

        const listed = await GET(`/admin/designations/${coachId}/teachers`, { as: admin });
        check('The same list is available on its own endpoint',
            listed.status === 200 && listed.data.teacherCount === 1
            && listed.data.designation === 'Sports Head'
            && listed.data.teachers[0].email === alice.email,
            JSON.stringify(listed.data));

        section('The blocking teachers download as a spreadsheet');

        const xls = await GETFILE(`/admin/designations/${coachId}/teachers/export`, { as: admin });
        check('Export answers an .xlsx', xls.status === 200 && /spreadsheetml/.test(xls.type), `${xls.status} ${xls.type}`);
        check('… as a download named after the designation',
            /attachment/.test(xls.disposition) && /sports-head-teachers\.xlsx/.test(xls.disposition), xls.disposition);
        check('… that is a real workbook', xls.buf.length > 0 && xls.buf.slice(0, 2).toString() === 'PK',
            `${xls.buf.length} bytes`);

        const sheet = XLSX.read(xls.buf, { type: 'buffer' });
        const grid = XLSX.utils.sheet_to_json(sheet.Sheets[sheet.SheetNames[0]], { header: 1 });
        check('… with the columns an admin needs',
            ['Employee ID', 'Teacher Name', 'Email', 'Phone', 'Designation', 'Department',
             'Gender', 'Joining Date', 'Subjects', 'Classes', 'Status']
                .every((h) => grid[0].includes(h)),
            JSON.stringify(grid[0]));
        check('… and one row per blocking teacher',
            grid.length === 2 && grid[1].includes(alice.email) && grid[1].includes('Sports Head'),
            JSON.stringify(grid[1]));

        const teacherExport = await GETFILE(`/admin/designations/${coachId}/teachers/export`, { as: alice });
        check('A teacher cannot export the list', teacherExport.status === 403, `${teacherExport.status}`);

        section('Once nobody holds it, the delete goes through');

        await PUT(`/admin/users/${sid(alice)}`, { as: admin, body: { name: alice.name, designation: 'Teacher' } });
        const emptyList = await GET(`/admin/designations/${coachId}/teachers`, { as: admin });
        check('The designation now lists no teachers', emptyList.data.teacherCount === 0);
        const delFree = await DEL(`/admin/designations/${coachId}`, { as: admin });
        check('An unused designation can be deleted', delFree.status === 200, delFree.message);

        section('Deactivating a designation withdraws all of its access');

        await PUT(`/admin/designations/${labRow._id}`, { as: admin, body: { isActive: false } });
        const labOff = await GET('/teacher/modules', { as: lab });
        check('An inactive designation grants nothing',
            Object.values(labOff.data.permissions).every((v) => v === 'none'),
            JSON.stringify(labOff.data?.permissions));
        await PUT(`/admin/designations/${labRow._id}`, { as: admin, body: { isActive: true } });

        section('Bulk matrix save');

        const bulk = await PUT('/admin/designations/matrix', {
            as: admin,
            body: { designations: [{ _id: teacherRow._id, permissions: { attendance: 'admin', leave: 'none' } }] },
        });
        check('The whole grid saves in one request', bulk.status === 200 && bulk.data.saved === 1, bulk.message);
        const m3 = await matrix();
        check('… and the saved levels read back',
            byName(m3, 'Teacher').permissions.attendance === 'admin'
            && byName(m3, 'Teacher').permissions.leave === 'none');
        check('… without disturbing levels the request did not mention',
            byName(m3, 'Teacher').permissions.fees === 'user',
            byName(m3, 'Teacher').permissions.fees);

        // ══ SCOPES ═══════════════════════════════════════════════════════════
        section('Who may configure this');

        const teacherPeek = await GET('/admin/designations/matrix', { as: alice });
        check('A teacher cannot read the matrix', teacherPeek.status === 403, `${teacherPeek.status}`);
        const teacherWrite = await PUT(`/admin/designations/${teacherRow._id}`, {
            as: alice, body: { permissions: { fees: 'admin' } },
        });
        check('A teacher cannot grant themselves permissions', teacherWrite.status === 403, `${teacherWrite.status}`);

        const saMatrix = await GET(`/super-admin/schools/${schoolId}/designations`, { as: superAdmin });
        check('The super admin can read any school\'s matrix', saMatrix.status === 200, saMatrix.message);
        const saWrite = await PUT(`/super-admin/schools/${schoolId}/designations/${teacherRow._id}`, {
            as: superAdmin, body: { permissions: { transport: 'admin' } },
        });
        check('… and configure it', saWrite.status === 200, saWrite.message);
        const m4 = await matrix();
        check('… with the school admin seeing the same result',
            byName(m4, 'Teacher').permissions.transport === 'admin');

        const otherSchool = await School.create({ name: `${TAG} Other`, modules: {} });
        const crossSchool = await PUT(`/super-admin/schools/${sid(otherSchool)}/designations/${teacherRow._id}`, {
            as: superAdmin, body: { permissions: { fees: 'admin' } },
        });
        check('A designation cannot be edited through another school\'s scope',
            crossSchool.status === 404, `${crossSchool.status}`);
        await School.findByIdAndDelete(sid(otherSchool));

        section('Roles that are not designation-driven are unchanged');

        const adminMods = await GET('/admin/modules', { as: admin });
        check('The school admin is administrative on every enabled module',
            adminMods.data.permissions.fees === 'admin' && adminMods.data.moduleAdmin.library === true);
        check('… and still bound by the school\'s own flags',
            adminMods.data.permissions.payroll === 'none' && adminMods.data.payroll === false);
    } catch (e) {
        failed += 1;
        results.push(`\n  💥 Test run threw: ${e.stack || e.message}`);
    } finally {
        if (schoolId) { try { await cleanup(schoolId, superAdminId); } catch (e) { console.error('cleanup failed:', e.message); } }
        server.close();
    }

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  DESIGNATION-BASED MODULE ACCESS — END-TO-END TESTS');
    console.log('══════════════════════════════════════════════════════════');
    console.log(results.join('\n'));
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('══════════════════════════════════════════════════════════\n');
    process.exit(failed ? 1 : 0);
})();
