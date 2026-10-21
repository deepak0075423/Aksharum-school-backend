'use strict';
/**
 * Test harness for the admission module.
 *
 * Each test file starts its own copy of the API (server.js, a free port) with
 *   ADMISSION_MAIL_DRIVER=log   nothing is emailed; codes are read from the log
 *   NODE_APP_INSTANCE=1         not the primary worker — no background sweeps or
 *                               chat broker; tests drive the sweeps themselves
 * and builds scratch schools in the configured database (DATABASE_URL), which
 * it removes again — rows and uploaded files — when the file finishes.
 * Test addresses use the reserved .test domain, which the admission mailer
 * never hands to a mail server.
 *
 *   npm run test:admission
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
process.env.ADMISSION_MAIL_DRIVER = 'log';
require('../../config/timezone');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../../db/pool');

const ROOT = path.join(__dirname, '..', '..');
const rand = () => crypto.randomBytes(4).toString('hex');

// ── The server ───────────────────────────────────────────────────────────────

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
        srv.on('error', reject);
    });
}

let child = null;
let BASE = '';

/** Start a copy of the API. `env` overrides its settings (e.g. a tight rate limit for one test file). */
async function startServer(env = {}) {
    const port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(port), ADMISSION_MAIL_DRIVER: 'log', NODE_APP_INSTANCE: '1', NODE_ENV: 'test',
            RL_ADMISSION_MAX: '100000', RL_API_MAX: '100000', RL_AUTH_MAX: '100000',
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const until = Date.now() + 60000;
    while (Date.now() < until) {
        // Ready, not merely up: on an empty database the tables are still being made.
        try { const r = await fetch(`${BASE}/health/ready`); if (r.ok) return BASE; } catch { /* not up yet */ }
        if (child.exitCode !== null) throw new Error(`server exited: ${log.slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`server did not start: ${log.slice(-2000)}`);
}

async function stopServer() {
    if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
    }
}

/** fetch the API: { status, body, headers }. `token` signs the request; `form` sends multipart. */
async function api(method, url, { token, body, form, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`${BASE}/api${url}`, { method, headers: h, body: payload });
    const type = res.headers.get('content-type') || '';
    const out = type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: out, headers: res.headers };
}

const tokenFor = (user) => jwt.sign({ userId: String(user._id), role: user.role, schoolId: String(user.school) }, process.env.JWT_SECRET, { expiresIn: '1h' });

// ── Scratch schools ──────────────────────────────────────────────────────────

const created = { schools: [] };
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const uuid = () => crypto.randomUUID();

async function insert(table, row) {
    const cols = Object.keys(row);
    const vals = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' && !(row[c] instanceof Date) ? JSON.stringify(row[c]) : row[c]));
    const rows = await q(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, vals);
    return rows[0];
}

/**
 * A school with admissions on, a year, two classes (Class 1 with two sections,
 * section B holding one seat; Class 2 with one), a school admin and a teacher.
 * Returns ids and session tokens.
 */
async function makeSchool(label = 'A', { modules = {} } = {}) {
    const tag = rand();
    const schoolId = uuid();
    await insert('schools', {
        _id: schoolId, name: `Admission Test ${label} ${tag}`, code: `ADT${tag}`.toUpperCase(), email: `office-${tag}@school.test`,
        isActive: true, board: 'CBSE', admissionNumberFormat: '{INITIALS}{YYYY}{####}', employeeIdFormat: '{INITIALS}{####}',
        modules: { admission: true, fees: true, transport: true, hostel: false, medical: false, ...modules },
        paymentGateway: { enabled: false, provider: 'none', modules: {} }, createdAt: new Date(),
    });
    created.schools.push(schoolId);
    const year = await insert('academicyears', { _id: uuid(), school: schoolId, yearName: '2027-28', startDate: new Date('2027-04-01'), endDate: new Date('2028-03-31'), status: 'active', createdAt: new Date() });
    const c1 = await insert('classes', { _id: uuid(), school: schoolId, academicYear: year._id, classNumber: 1, className: 'Class 1', status: 'active', createdAt: new Date() });
    const c2 = await insert('classes', { _id: uuid(), school: schoolId, academicYear: year._id, classNumber: 2, className: 'Class 2', status: 'active', createdAt: new Date() });
    const secA = await insert('classsections', { _id: uuid(), school: schoolId, class: c1._id, academicYear: year._id, sectionName: 'A', maxStudents: 30, currentCount: 0, enrolledStudents: [], status: 'active', createdAt: new Date() });
    const secB = await insert('classsections', { _id: uuid(), school: schoolId, class: c1._id, academicYear: year._id, sectionName: 'B', maxStudents: 1, currentCount: 0, enrolledStudents: [], status: 'active', createdAt: new Date() });
    const hash = await bcrypt.hash('Passw0rd!', 4);
    const admin = await insert('users', { _id: uuid(), name: 'Office Admin', email: `admin-${tag}@school.test`, password: hash, role: 'school_admin', school: schoolId, isFirstLogin: false, isActive: true, createdAt: new Date() });
    const teacher = await insert('users', { _id: uuid(), name: 'Asha Teacher', email: `teacher-${tag}@school.test`, password: hash, role: 'teacher', school: schoolId, isFirstLogin: false, isActive: true, createdAt: new Date() });
    await insert('teacherprofiles', { _id: uuid(), user: teacher._id, school: schoolId, designation: 'Teacher', createdAt: new Date() }).catch(() => {});
    return {
        id: schoolId, tag, year, classes: [c1, c2], sections: { A: secA, B: secB }, admin, teacher,
        adminToken: tokenFor(admin), teacherToken: tokenFor(teacher),
    };
}

/** Admin bootstrap + portal address + open status + test-friendly settings. Returns { slug, settings, form, docTypes }. */
async function openPortal(s, { slug = `adm-${s.tag}`, settings = {} } = {}) {
    const boot = await api('GET', '/admission/admin/bootstrap', { token: s.adminToken });
    if (boot.status !== 200) throw new Error(`bootstrap: ${JSON.stringify(boot.body)}`);
    const r1 = await api('PUT', '/admission/admin/settings/slug', { token: s.adminToken, body: { slug } });
    if (r1.status !== 200) throw new Error(`slug: ${JSON.stringify(r1.body)}`);
    const r2 = await api('PUT', '/admission/admin/settings', {
        token: s.adminToken,
        body: {
            portal: { status: 'open' },
            security: { otpResendSeconds: 30, otpMaxAttempts: 3 },
            conversion: { sendCredentials: false },
            // These suites exercise entrance exams and merit lists for Class 1
            // and 2, which the RTE guard bars by default; tests/admission/rte.test.js
            // turns the guard on and tests it.
            compliance: { rte: { enabled: false, exemptReason: 'other', exemptNote: 'Test school for entrance exams and merit lists' } },
            ...settings,
        },
    });
    if (r2.status !== 200) throw new Error(`settings: ${JSON.stringify(r2.body)}`);
    return { slug, settings: r2.body.data, form: boot.body.data.forms[0], docTypes: boot.body.data.documentTypes };
}

/** A round open now for both classes, on the school's default form. */
async function makeRound(s, form, { seats1 = 2, seats2 = 10, applicationFee = 0, admissionFee = 0, extra = {} } = {}) {
    const r = await api('POST', '/admission/admin/rounds', {
        token: s.adminToken,
        body: {
            name: 'Main Admissions', academicYear: s.year._id, form: form._id, applicationFee, admissionFee,
            opensAt: new Date(Date.now() - 86400000), closesAt: new Date(Date.now() + 30 * 86400000),
            classes: [{ class: s.classes[0]._id, seats: seats1 }, { class: s.classes[1]._id, seats: seats2 }],
            ...extra,
        },
    });
    if (r.status !== 201) throw new Error(`round: ${JSON.stringify(r.body)}`);
    const o = await api('POST', `/admission/admin/rounds/${r.body.data._id}/status`, { token: s.adminToken, body: { status: 'open' } });
    if (o.status !== 200) throw new Error(`open round: ${JSON.stringify(o.body)}`);
    return o.body.data;
}

/** The last code emailed to an address (log driver keeps the body). */
async function lastCode(schoolId, email, event = 'email_otp') {
    const rows = await q(`SELECT "body" FROM "admissionemaillogs" WHERE "school" = $1 AND "to" = $2 AND "event" = $3 ORDER BY "createdAt" DESC LIMIT 1`, [schoolId, email.toLowerCase(), event]);
    const m = rows[0]?.body?.match(/\b(\d{6})\b/);
    return m ? m[1] : null;
}

/** Register + verify an applicant on a portal; returns { token, user, email }. */
async function registerGuest(s, slug, { name = 'Anita Sharma', email = `parent-${rand()}@family.test`, password = 'Applicant123', phone = '9876543210' } = {}) {
    const r = await api('POST', `/admission/public/portals/${slug}/register`, { body: { name, email, phone, password, consent: true } });
    if (r.status !== 200) throw new Error(`register: ${JSON.stringify(r.body)}`);
    const code = await lastCode(s.id, email);
    const v = await api('POST', `/admission/public/portals/${slug}/register/verify`, { body: { email, code } });
    if (v.status !== 200 || !v.body.token) throw new Error(`verify: ${JSON.stringify(v.body)}`);
    return { token: v.body.token, user: v.body.user, email };
}

/** Answers that satisfy the default form. */
function goodAnswers(overrides = {}) {
    return {
        studentName: 'Riya Sharma', studentDob: '2021-05-02', studentGender: 'Female',
        fatherName: 'Amit Sharma', fatherPhone: '9876543210', motherName: 'Neha Sharma', motherPhone: '9876543211',
        primaryContact: 'Father', addressLine: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', sameAsCurrent: true,
        attendedPreviousSchool: 'No', siblingStudying: 'No', declarationTrue: true, consentData: true,
        ...overrides,
    };
}

// Tiny real files for upload tests.
const FILES = {
    png: Buffer.from('89504E470D0A1A0A0000000D4948445200000001000000010806000000' + '1F15C4890000000D49444154789C6360000002000105' + '7E2E4B0000000049454E44AE426082', 'hex'),
    pdf: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1'),
};

function fileForm(fields, file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append('file', new Blob([file.buffer], { type: file.type || 'application/octet-stream' }), file.name);
    return fd;
}

async function uploadDoc(token, appId, docType, { name = `${docType}.png`, buffer = FILES.png, type = 'image/png' } = {}) {
    return api('POST', `/admission/portal/applications/${appId}/documents`, { token, form: fileForm({ docType }, { buffer, name, type }) });
}

/** Draft → answers → documents → submitted. Returns the application. */
async function submittedApplication(s, guest, round, { classIdx = 0, answers = {} } = {}) {
    const c = await api('POST', '/admission/portal/applications', { token: guest.token, body: { round: round._id, class: s.classes[classIdx]._id } });
    if (c.status !== 201) throw new Error(`create: ${JSON.stringify(c.body)}`);
    const id = c.body.data._id;
    const save = await api('PUT', `/admission/portal/applications/${id}`, { token: guest.token, body: { data: goodAnswers(answers) } });
    if (save.status !== 200) throw new Error(`save: ${JSON.stringify(save.body)}`);
    for (const d of ['photo', 'birth_certificate', 'address_proof']) {
        const u = await uploadDoc(guest.token, id, d);
        if (u.status !== 201) throw new Error(`upload ${d}: ${JSON.stringify(u.body)}`);
    }
    const sub = await api('POST', `/admission/portal/applications/${id}/submit`, { token: guest.token, body: {} });
    if (sub.status !== 200) throw new Error(`submit: ${JSON.stringify(sub.body)}`);
    return sub.body.data;
}

/** Verify every current document of an application as the office. */
async function verifyAllDocs(s, appId) {
    const docs = await q(`SELECT "_id" FROM "admissiondocuments" WHERE "application" = $1 AND "current"`, [appId]);
    for (const d of docs) {
        const r = await api('POST', `/admission/admin/documents/${d._id}/review`, { token: s.adminToken, body: { decision: 'verify' } });
        if (r.status !== 200) throw new Error(`verify doc: ${JSON.stringify(r.body)}`);
    }
}

/**
 * Forget the admission rate-limit buckets (shared Redis): a test that spends
 * them would otherwise leave the next run — or a developer's local server —
 * refused for up to an hour.
 */
async function clearRateLimits() {
    const { getCacheRedis } = require('../../config/cacheRedis');
    const r = getCacheRedis();
    try {
        const keys = await r.keys('rl:adm-*');
        if (keys.length) await r.del(...keys);
    } catch { /* no Redis: nothing was limited */ }
}

// ── Cleaning up ──────────────────────────────────────────────────────────────

/** Remove scratch schools — this run's, or the ids given (a run that was killed never cleaned up). */
async function cleanup(ids = created.schools) {
    for (const id of ids) {
        const files = await q(`SELECT "file" FROM "admissiondocuments" WHERE "school" = $1`, [id]).catch(() => []);
        const studentFiles = await q(`SELECT "photoFile", "birthCertificateFile", "tcFile", "aadhaarFrontFile" FROM "studentprofiles" WHERE "school" = $1`, [id]).catch(() => []);
        const steps = [
            `DELETE FROM "admissionpayments" WHERE "school" = $1`,
            `DELETE FROM "admissionlistentries" WHERE "school" = $1`,
            `DELETE FROM "admissionoffers" WHERE "school" = $1`,
            `DELETE FROM "admissionlists" WHERE "school" = $1`,
            `DELETE FROM "admissionapplications" WHERE "school" = $1`,
            `DELETE FROM "admissionexams" WHERE "school" = $1`,
            `DELETE FROM "admissionquestions" WHERE "school" = $1`,
            `DELETE FROM "admissionrounds" WHERE "school" = $1`,
            `DELETE FROM "admissionforms" WHERE "school" = $1`,
            `DELETE FROM "admissionformversions" WHERE "school" = $1`,
            `DELETE FROM "admissiondocumenttypes" WHERE "school" = $1`,
            `DELETE FROM "admissionevents" WHERE "school" = $1`,
            `DELETE FROM "admissionemaillogs" WHERE "school" = $1`,
            `DELETE FROM "admissionemailtemplates" WHERE "school" = $1`,
            `DELETE FROM "admissionotps" WHERE "school" = $1`,
            `DELETE FROM "admissionapplicants" WHERE "school" = $1`,
            `DELETE FROM "admissionenquiries" WHERE "school" = $1`,
            `DELETE FROM "admissioncounters" WHERE "school" = $1`,
            `DELETE FROM "admissionsettings" WHERE "school" = $1`,
            `DELETE FROM "studentfeeassignments" WHERE "school" = $1`,
            `DELETE FROM "feeledgers" WHERE "school" = $1`,
            `DELETE FROM "feestructures" WHERE "school" = $1`,
            `DELETE FROM "transportrequests" WHERE "school" = $1`,
            `DELETE FROM "notificationreceipts" WHERE "school" = $1`,
            `DELETE FROM "notifications" WHERE "school" = $1`,
            `DELETE FROM "studentprofiles" WHERE "school" = $1`,
            `DELETE FROM "parentprofiles" WHERE "school" = $1`,
            `DELETE FROM "teacherprofiles" WHERE "school" = $1`,
            `DELETE FROM "classsections" WHERE "school" = $1`,
            `DELETE FROM "classes" WHERE "school" = $1`,
            `DELETE FROM "academicyears" WHERE "school" = $1`,
            `DELETE FROM "designations" WHERE "school" = $1`,
            `DELETE FROM "users" WHERE "school" = $1`,
            `DELETE FROM "schools" WHERE "_id" = $1`,
        ];
        for (const sql of steps.slice(0, -1)) await pool.query(sql, [id]).catch((e) => console.error(`[cleanup] ${sql.slice(0, 60)}: ${e.message}`));
        // Whatever else enrolment reached (medical, hostel, notifications…):
        // every table with a "school" column, a few passes so keys between
        // them are satisfied in any order.
        const tables = (await q(`SELECT DISTINCT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'school' AND table_name <> 'schools'`)).map((r) => r.t);
        for (let pass = 0; pass < 3; pass++) {
            for (const t of tables) await pool.query(`DELETE FROM "${t}" WHERE "school"::text = $1`, [id]).catch(() => {});
        }
        await pool.query(steps[steps.length - 1], [id]).catch((e) => console.error(`[cleanup] school: ${e.message}`));
        for (const f of files) fs.promises.unlink(path.join(ROOT, 'uploads', 'admission-docs', f.file)).catch(() => {});
        fs.promises.rm(path.join(ROOT, 'uploads', 'admission-docs', id), { recursive: true, force: true }).catch(() => {});
        for (const sp of studentFiles) for (const v of Object.values(sp)) if (v) fs.promises.unlink(path.join(ROOT, 'uploads', 'student-docs', v)).catch(() => {});
    }
    if (ids === created.schools) created.schools.length = 0;
}

/** Scratch schools left behind by an interrupted run: named and coded by makeSchool, with .test addresses. */
async function leftoverSchools() {
    return (await q(`SELECT "_id" FROM "schools" WHERE "name" LIKE 'Admission Test %' AND "code" LIKE 'ADT%' AND "email" LIKE '%@school.test'`)).map((r) => String(r._id));
}

async function finish() {
    await cleanup();
    await stopServer();
    await clearRateLimits();
    await pool.end();
    try { require('../../config/cacheRedis').getCacheRedis().disconnect(); } catch { /* not connected */ }
}

module.exports = {
    startServer, stopServer, finish, api, q, rand, tokenFor, makeSchool, openPortal, makeRound, registerGuest, lastCode,
    goodAnswers, uploadDoc, fileForm, FILES, submittedApplication, verifyAllDocs, insert, uuid, cleanup, leftoverSchools, clearRateLimits,
    get BASE() { return BASE; },
};
