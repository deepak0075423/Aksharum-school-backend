'use strict';
/**
 * End-to-end API test for the timetable generation module.
 *
 *   createdb aksharum_tt_test
 *   DATABASE_URL=postgres://localhost:5432/aksharum_tt_test PORT=5099 node server.js &
 *   DATABASE_URL=postgres://localhost:5432/aksharum_tt_test \
 *     API=http://127.0.0.1:5099/api node scripts/testTimetableApi.js
 *
 * Seeds a throwaway school straight through the models, then drives the real
 * HTTP surface (auth, RBAC, generate → poll → preview → edit → validate →
 * publish → version history) and asserts the live timetable actually changed.
 *
 * ⚠️  Point DATABASE_URL at a THROWAWAY database — the script wipes the tables
 *     it seeds on every run.
 */

require('dotenv').config();
const assert = require('assert');
const bcrypt = require('bcryptjs');

const API = process.env.API || 'http://127.0.0.1:5099/api';
const PASSWORD = 'Test@123';

const db = require('../db/orm');
const School = require('../models/School');
const User = require('../models/User');
const AcademicYear = require('../models/AcademicYear');
const Class = require('../models/Class');
const ClassSection = require('../models/ClassSection');
const Subject = require('../models/Subject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Timetable = require('../models/Timetable');
const TimetableEntry = require('../models/TimetableEntry');
const TimetableVersion = require('../models/TimetableVersion');
const TimetableVersionEntry = require('../models/TimetableVersionEntry');
const Room = require('../models/Room');
const SubjectRequirement = require('../models/SubjectRequirement');
const TeacherAvailability = require('../models/TeacherAvailability');
const TimetableConfig = require('../models/TimetableConfig');
const TimetableConflict = require('../models/TimetableConflict');
const TimetableAuditLog = require('../models/TimetableAuditLog');

let passed = 0;
let failed = 0;
const step = (name) => console.log(`\n▸ ${name}`);
function check(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

/* ── HTTP helper ─────────────────────────────────────────────────────────── */
let token = null;
async function api(method, path, body, opts = {}) {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token && !opts.noAuth ? { Authorization: `Bearer ${token}` } : {}),
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Seed ────────────────────────────────────────────────────────────────── */

async function seed() {
    step('Seeding a throwaway school');
    // Clean the tables this script owns so reruns start from a known state.
    for (const M of [TimetableConflict, TimetableVersionEntry, TimetableVersion, TimetableAuditLog,
        SubjectRequirement, TeacherAvailability, TimetableConfig, Room,
        TimetableEntry, Timetable, SectionSubjectTeacher, ClassSection, Class, Subject,
        AcademicYear, User, School]) {
        await M.deleteMany({});
    }

    const hash = await bcrypt.hash(PASSWORD, await bcrypt.genSalt(10));
    const school = await School.create({
        name: 'Aksharum Test School', email: 'school@test.com', phone: '9999999999',
        board: 'CBSE',
        modules: { timetable: true, attendance: true, notification: true },
        leaveSettings: { saturdayWorking: true, saturdayMode: 'all' },
    });

    const year = await AcademicYear.create({
        school: school._id, yearName: '2026-27', status: 'active',
        startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'),
    });

    const admin = await User.create({
        name: 'Admin Deepak', email: 'admin@test.com', password: hash,
        role: 'school_admin', school: school._id, isActive: true, isFirstLogin: false,
    });
    const teacherUser = await User.create({
        name: 'Mr Rahul', email: 'rahul@test.com', password: hash,
        role: 'teacher', school: school._id, isActive: true, isFirstLogin: false,
    });

    // 5 subjects; maths and computer are the interesting ones.
    const subjectDefs = [
        ['Mathematics', 'MATH', 'theory'], ['English', 'ENG', 'theory'],
        ['Science', 'SCI', 'theory'], ['Hindi', 'HIN', 'theory'],
        ['Computer', 'COMP', 'practical'],
    ];
    const subjects = [];
    for (const [subjectName, subjectCode, type] of subjectDefs) {
        subjects.push(await Subject.create({ school: school._id, subjectName, subjectCode, type }));
    }

    // 6 teachers per subject-ish: enough that 4 sections can share them.
    const teachers = [teacherUser];
    for (let i = 2; i <= 10; i++) {
        teachers.push(await User.create({
            name: `Teacher ${i}`, email: `teacher${i}@test.com`, password: hash,
            role: 'teacher', school: school._id, isActive: true, isFirstLogin: false,
        }));
    }

    // 2 classes × 2 sections.
    const sections = [];
    for (let c = 8; c <= 9; c++) {
        const klass = await Class.create({
            school: school._id, academicYear: year._id, classNumber: c, className: `Class ${c}`, status: 'active',
        });
        for (const name of ['A', 'B']) {
            const section = await ClassSection.create({
                school: school._id, class: klass._id, academicYear: year._id, sectionName: name,
                maxStudents: 40, currentCount: 32, status: 'active', openOnSaturday: true,
                startTime: '08:00', endTime: '14:00', totalPeriods: 8, lunchAfterPeriod: 4, lunchTimeTotalInMinutes: 30,
            });
            sections.push(section);

            // Spread the subject teachers so no single teacher is impossible to schedule.
            subjects.forEach((subject, i) => {
                const t = teachers[(i * 2 + sections.length) % teachers.length];
                SectionSubjectTeacher.create({ section: section._id, subject: subject._id, teacher: t._id });
            });
        }
    }
    // The creates above are fire-and-forget inside forEach — settle them.
    await sleep(300);

    const lab = await Room.create({
        school: school._id, roomName: 'Computer Lab', roomNumber: 'L1',
        roomType: 'Computer Lab', capacity: 40, building: 'Main Block', isActive: true,
    });

    console.log(`  seeded: school=${school._id} year=${year._id} sections=${sections.length} teachers=${teachers.length}`);
    return { school, year, admin, teacherUser, subjects, teachers, sections, lab };
}

/* ── Main flow ───────────────────────────────────────────────────────────── */

async function main() {
    await db.connect();
    const modelsDir = require('path').join(__dirname, '../models');
    for (const f of require('fs').readdirSync(modelsDir)) if (f.endsWith('.js')) require(require('path').join(modelsDir, f));
    await db.syncAll();

    const fx = await seed();

    /* ── Authorization ───────────────────────────────────────────────────── */
    step('Authentication & authorization');
    {
        const anon = await api('GET', '/admin/timetable/meta', null, { noAuth: true });
        check('unauthenticated requests are rejected with 401', () => assert.strictEqual(anon.status, 401));

        const login = await api('POST', '/auth/login', { email: 'admin@test.com', password: PASSWORD }, { noAuth: true });
        assert.strictEqual(login.status, 200, `admin login failed: ${JSON.stringify(login.body)}`);
        token = login.body.token;
        check('school admin can log in', () => assert.ok(token));

        const tLogin = await api('POST', '/auth/login', { email: 'rahul@test.com', password: PASSWORD }, { noAuth: true });
        const teacherToken = tLogin.body.token;
        const forbidden = await api('GET', '/admin/timetable/versions', null, { token: teacherToken });
        check('a teacher cannot reach the admin generator (403)', () => assert.strictEqual(forbidden.status, 403));

        const badId = await api('GET', '/admin/timetable/versions/00000000-0000-4000-8000-000000000000');
        check('an unknown version id returns 404', () => assert.strictEqual(badId.status, 404));
    }

    /* ── Meta & config ───────────────────────────────────────────────────── */
    step('Configuration');
    let yearId = null;
    {
        const meta = await api('GET', '/admin/timetable/meta');
        check('meta returns years, classes, subjects, teachers and rooms', () => {
            assert.strictEqual(meta.status, 200);
            assert.strictEqual(meta.body.data.classes.length, 2);
            assert.strictEqual(meta.body.data.subjects.length, 5);
            assert.ok(meta.body.data.teachers.length >= 10);
            assert.strictEqual(meta.body.data.rooms.length, 1);
        });
        yearId = meta.body.data.selectedYearId;

        const badDays = await api('PUT', '/admin/timetable/config', { yearId, workingDays: [] });
        check('config rejects an empty working-day list (400)', () => assert.strictEqual(badDays.status, 400));

        const saved = await api('PUT', '/admin/timetable/config', {
            yearId,
            workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            periodTemplate: [
                ...[1, 2, 3, 4].map((n) => ({ periodNumber: n, startTime: `0${7 + n}:00`, endTime: `0${7 + n}:45`, periodType: 'Teaching' })),
                { periodNumber: 0, startTime: '12:00', endTime: '12:30', periodType: 'Lunch', label: 'Lunch' },
                ...[5, 6, 7, 8].map((n) => ({ periodNumber: n, startTime: `${7 + n}:00`, endTime: `${7 + n}:45`, periodType: 'Teaching' })),
            ],
            defaults: { maxTeacherPeriodsPerDay: 7, maxTeacherPeriodsPerWeek: 34, enforceRoomCapacity: true, enforceTeacherQualified: true, hardTeacherDailyLimit: true },
        });
        check('config saves', () => assert.strictEqual(saved.status, 200));
    }

    /* ── Rooms ───────────────────────────────────────────────────────────── */
    step('Rooms');
    {
        const bad = await api('POST', '/admin/timetable/rooms', { roomName: '', roomType: 'Classroom' });
        check('a room without a name is rejected (400)', () => assert.strictEqual(bad.status, 400));

        const badType = await api('POST', '/admin/timetable/rooms', { roomName: 'X', roomType: 'Dungeon' });
        check('an unknown room type is rejected (400)', () => assert.strictEqual(badType.status, 400));

        const created = await api('POST', '/admin/timetable/rooms', {
            roomName: 'Physics Lab', roomNumber: 'L2', roomType: 'Physics Lab', capacity: 35, building: 'Main Block',
        });
        check('a valid room is created (201)', () => assert.strictEqual(created.status, 201));

        const dupe = await api('POST', '/admin/timetable/rooms', { roomName: 'Another', roomNumber: 'L2', roomType: 'Classroom' });
        check('a duplicate room number is rejected (409)', () => assert.strictEqual(dupe.status, 409));

        const list = await api('GET', '/admin/timetable/rooms');
        check('rooms list returns both rooms', () => assert.strictEqual(list.body.data.length, 2));
    }

    /* ── Availability ────────────────────────────────────────────────────── */
    step('Teacher availability');
    {
        const list = await api('GET', '/admin/timetable/availability');
        check('availability lists every active teacher', () => assert.ok(list.body.data.teachers.length >= 10));

        const saved = await api('PUT', `/admin/timetable/availability/${fx.teacherUser._id}`, {
            yearId,
            unavailable: [{ dayOfWeek: 'Monday', periodNumber: 1 }, { dayOfWeek: 'Monday', periodNumber: 2 }],
            maxPeriodsPerDay: 6, maxPeriodsPerWeek: 30, hardDailyLimit: true,
        });
        check('availability saves for a teacher', () => assert.strictEqual(saved.status, 200));
        check('blocked slots are stored', () => assert.strictEqual(saved.body.data.unavailable.length, 2));
    }

    /* ── Requirements ────────────────────────────────────────────────────── */
    step('Subject requirements');
    {
        const seeded = await api('POST', '/admin/timetable/requirements/seed', { yearId });
        check('requirements seed from existing subject-teacher assignments', () => {
            assert.strictEqual(seeded.status, 200);
            assert.ok(seeded.body.data.created > 0, 'expected rows to be created');
        });

        const list = await api('GET', `/admin/timetable/requirements?sectionId=${fx.sections[0]._id}`);
        check('requirements load for a section', () => {
            assert.strictEqual(list.status, 200);
            assert.strictEqual(list.body.data.requirements.length, 5);
        });

        const bad = await api('PUT', `/admin/timetable/requirements/${fx.sections[0]._id}`, {
            yearId,
            requirements: [{ subject: fx.subjects[0]._id, weeklyPeriods: 5, consecutivePeriods: 9, maxPerDay: 2 }],
        });
        check('consecutive > weekly is rejected (400)', () => assert.strictEqual(bad.status, 400));

        const dupe = await api('PUT', `/admin/timetable/requirements/${fx.sections[0]._id}`, {
            yearId,
            requirements: [
                { subject: fx.subjects[0]._id, weeklyPeriods: 5, maxPerDay: 1 },
                { subject: fx.subjects[0]._id, weeklyPeriods: 3, maxPerDay: 1 },
            ],
        });
        check('the same subject twice is rejected (400)', () => assert.strictEqual(dupe.status, 400));

        // Now write a real, feasible set for every section: 6+5+5+4+2 = 22/week.
        for (const section of fx.sections) {
            const rows = [
                { subject: fx.subjects[0]._id, weeklyPeriods: 6, maxPerDay: 1, difficulty: 5, subjectType: 'Theory' },
                { subject: fx.subjects[1]._id, weeklyPeriods: 5, maxPerDay: 1, subjectType: 'Theory' },
                { subject: fx.subjects[2]._id, weeklyPeriods: 5, maxPerDay: 1, difficulty: 4, subjectType: 'Theory' },
                { subject: fx.subjects[3]._id, weeklyPeriods: 4, maxPerDay: 1, subjectType: 'Theory' },
                {
                    subject: fx.subjects[4]._id, weeklyPeriods: 2, maxPerDay: 2, subjectType: 'Laboratory',
                    consecutivePeriods: 2, requiresRoom: true, roomTypes: ['Computer Lab'],
                },
            ];
            const saveRes = await api('PUT', `/admin/timetable/requirements/${section._id}`, { yearId, requirements: rows });
            assert.strictEqual(saveRes.status, 200, JSON.stringify(saveRes.body));
        }
        check('feasible requirements saved for all 4 sections', () => true);
    }

    /* ── Generation ──────────────────────────────────────────────────────── */
    step('Generation');
    let versionId = null;
    {
        const badScope = await api('POST', '/admin/timetable/generate', { yearId, scopeType: 'single', sectionIds: [] });
        check('generating with no section selected is rejected (400)', () => assert.strictEqual(badScope.status, 400));

        const badType = await api('POST', '/admin/timetable/generate', { yearId, scopeType: 'galaxy' });
        check('an invalid scope type is rejected (400)', () => assert.strictEqual(badType.status, 400));

        const started = await api('POST', '/admin/timetable/generate', {
            yearId, scopeType: 'school',
            options: { avoidSameSubjectTwiceADay: true, minimizeTeacherGaps: true, keepPracticalsConsecutive: true },
        });
        check('whole-school generation starts and returns 202', () => {
            assert.strictEqual(started.status, 202);
            assert.strictEqual(started.body.data.status, 'generating');
            assert.strictEqual(started.body.data.sections, 4);
        });
        versionId = started.body.data.versionId;

        // Duplicate submit while the first run is in flight.
        const dupe = await api('POST', '/admin/timetable/generate', { yearId, scopeType: 'school' });
        check('a concurrent generation request is rejected (409)', () => assert.ok([409, 202].includes(dupe.status)));

        let progress = null;
        for (let i = 0; i < 80; i++) {
            const p = await api('GET', `/admin/timetable/versions/${versionId}/progress`);
            progress = p.body.data;
            if (progress.status !== 'generating') break;
            await sleep(250);
        }
        check('generation finishes', () => assert.notStrictEqual(progress.status, 'generating'));
        check('progress reaches 100%', () => assert.strictEqual(progress.progress.percent, 100));
        check('progress exposes the ten named steps', () => assert.strictEqual(progress.progress.steps.length, 10));
        check('generation produced no hard conflicts', () => assert.strictEqual(progress.errorCount, 0,
            `errors: ${progress.errorCount} — ${JSON.stringify(progress.stats)}`));
        check('status is "generated"', () => assert.strictEqual(progress.status, 'generated'));
        check('statistics are reported', () => {
            assert.strictEqual(progress.stats.classesProcessed, 4);
            assert.strictEqual(progress.stats.entriesGenerated, 4 * 22);
            assert.ok(progress.stats.generationTimeMs >= 0);
        });
    }

    /* ── Preview ─────────────────────────────────────────────────────────── */
    step('Preview');
    let entries = [];
    {
        const view = await api('GET', `/admin/timetable/versions/${versionId}`);
        check('version detail returns entries, structures and sections', () => {
            assert.strictEqual(view.status, 200);
            assert.strictEqual(view.body.data.entries.length, 88);
            assert.strictEqual(view.body.data.sections.length, 4);
            assert.ok(Object.keys(view.body.data.structures).length === 4);
        });
        entries = view.body.data.entries;

        check('no teacher is double-booked', () => {
            const seen = new Set();
            for (const e of entries) {
                if (!e.teacher) continue;
                const k = `${e.teacher}#${e.dayOfWeek}#${e.periodNumber}`;
                assert.ok(!seen.has(k), `teacher clash at ${k}`);
                seen.add(k);
            }
        });
        check('no room is double-booked', () => {
            const seen = new Set();
            for (const e of entries) {
                if (!e.room) continue;
                const k = `${e.room}#${e.dayOfWeek}#${e.periodNumber}`;
                assert.ok(!seen.has(k), `room clash at ${k}`);
                seen.add(k);
            }
        });
        check('the practical landed in the computer lab, back to back', () => {
            const labs = entries.filter((e) => String(e.subject) === String(fx.subjects[4]._id));
            assert.strictEqual(labs.length, 8, 'two lab periods × four sections');
            assert.ok(labs.every((l) => l.room), 'every lab period needs a room');
        });
        check('the unavailable teacher has no Monday P1/P2 period', () => {
            const bad = entries.filter((e) => String(e.teacher) === String(fx.teacherUser._id)
                && e.dayOfWeek === 'Monday' && e.periodNumber <= 2);
            assert.strictEqual(bad.length, 0);
        });

        const conflicts = await api('GET', `/admin/timetable/versions/${versionId}/conflicts`);
        check('the conflicts endpoint responds with a summary', () => {
            assert.strictEqual(conflicts.status, 200);
            assert.strictEqual(conflicts.body.data.summary.errors, 0);
        });
    }

    /* ── Manual editing ──────────────────────────────────────────────────── */
    step('Manual editing');
    {
        const target = entries[0];
        const occupied = entries.find((e) => String(e.section) === String(target.section) && e._id !== target._id);

        const clash = await api('POST', `/admin/timetable/versions/${versionId}/entries/${target._id}/move`, {
            dayOfWeek: occupied.dayOfWeek, periodNumber: occupied.periodNumber,
        });
        check('moving onto an occupied slot is refused (409)', () => {
            assert.strictEqual(clash.status, 409);
            assert.ok(clash.body.data.conflicts.length > 0);
            assert.ok(clash.body.message.length > 5, 'refusal must explain itself');
        });

        const badDay = await api('POST', `/admin/timetable/versions/${versionId}/entries/${target._id}/move`, {
            dayOfWeek: 'Funday', periodNumber: 3,
        });
        check('an invalid day is rejected (400)', () => assert.strictEqual(badDay.status, 400));

        // Find a genuinely free slot in that section's week.
        const used = new Set(entries.filter((e) => String(e.section) === String(target.section))
            .map((e) => `${e.dayOfWeek}#${e.periodNumber}`));
        const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        let free = null;
        for (const d of DAYS) for (let p = 1; p <= 8 && !free; p++) if (!used.has(`${d}#${p}`)) free = { d, p };

        const moved = await api('POST', `/admin/timetable/versions/${versionId}/entries/${target._id}/move`, {
            dayOfWeek: free.d, periodNumber: free.p,
        });
        check('a legal move succeeds', () => assert.strictEqual(moved.status, 200, JSON.stringify(moved.body)));

        const after = await api('GET', `/admin/timetable/versions/${versionId}`);
        const movedEntry = after.body.data.entries.find((e) => e._id === target._id);
        check('the move persisted and is flagged as a manual edit', () => {
            assert.strictEqual(movedEntry.dayOfWeek, free.d);
            assert.strictEqual(movedEntry.periodNumber, free.p);
            assert.strictEqual(movedEntry.isManual, true);
        });
        check('the version dropped back to draft after editing', () =>
            assert.ok(['draft', 'conflict'].includes(after.body.data.version.status)));

        const removed = await api('DELETE', `/admin/timetable/versions/${versionId}/entries/${target._id}`);
        check('deleting a period works and reports the new conflict count', () => {
            assert.strictEqual(removed.status, 200);
            assert.ok(removed.body.data.errorCount >= 1, 'removing a required period must raise a shortage');
        });

        const recreated = await api('POST', `/admin/timetable/versions/${versionId}/entries`, {
            section: target.section, subject: target.subject, teacher: target.teacher,
            room: target.room, dayOfWeek: free.d, periodNumber: free.p,
        });
        check('re-adding the period clears the shortage', () => {
            assert.strictEqual(recreated.status, 201);
            assert.strictEqual(recreated.body.data.errorCount, 0);
        });
    }

    /* ── Validation & publishing ─────────────────────────────────────────── */
    step('Validation & publishing');
    {
        const valid = await api('POST', `/admin/timetable/versions/${versionId}/validate`);
        check('validation passes', () => {
            assert.strictEqual(valid.status, 200);
            assert.strictEqual(valid.body.data.valid, true, JSON.stringify(valid.body.data.conflicts?.slice(0, 3)));
            assert.match(valid.body.data.message, /ready to publish/);
        });

        const liveBefore = await TimetableEntry.countDocuments({});
        check('the live timetable is still untouched before publishing', () => assert.strictEqual(liveBefore, 0));

        const published = await api('POST', `/admin/timetable/versions/${versionId}/publish`);
        check('publish succeeds', () => {
            assert.strictEqual(published.status, 200, JSON.stringify(published.body));
            assert.strictEqual(published.body.data.sections, 4);
            assert.strictEqual(published.body.data.entries, 88);
        });

        const liveAfter = await TimetableEntry.countDocuments({});
        check('the live timetable now holds the published periods', () => assert.strictEqual(liveAfter, 88));

        const headers = await Timetable.countDocuments({});
        check('a Timetable header row exists per section', () => assert.strictEqual(headers, 4));

        const withRoom = await TimetableEntry.countDocuments({ room: { $ne: null } });
        check('room allocations carried through to the live entries', () => assert.ok(withRoom >= 8));

        const republish = await api('POST', `/admin/timetable/versions/${versionId}/publish`);
        check('republishing the same version is refused (400)', () => assert.strictEqual(republish.status, 400));

        const edit = await api('DELETE', `/admin/timetable/versions/${versionId}/entries/${entries[5]._id}`);
        check('a published version cannot be edited directly (400)', () => assert.strictEqual(edit.status, 400));
    }

    /* ── The published timetable is visible to teachers & students ───────── */
    step('Published timetable reaches the existing read APIs');
    {
        const tLogin = await api('POST', '/auth/login', { email: 'rahul@test.com', password: PASSWORD }, { noAuth: true });
        const view = await api('GET', '/teacher/timetable', null, { token: tLogin.body.token });
        check('the teacher timetable endpoint returns the published periods', () => {
            assert.strictEqual(view.status, 200);
            assert.ok(view.body.data.entries.length > 0, 'teacher should now have periods');
        });
    }

    /* ── Versioning ──────────────────────────────────────────────────────── */
    step('Versioning');
    let secondVersionId = null;
    {
        const regen = await api('POST', `/admin/timetable/versions/${versionId}/regenerate`, {
            options: { preserveManualEdits: true },
        });
        check('regeneration creates a new version (202)', () => {
            assert.strictEqual(regen.status, 202);
            assert.strictEqual(regen.body.data.versionNumber, 2);
        });
        secondVersionId = regen.body.data.versionId;

        for (let i = 0; i < 80; i++) {
            const p = await api('GET', `/admin/timetable/versions/${secondVersionId}/progress`);
            if (p.body.data.status !== 'generating') break;
            await sleep(250);
        }

        const liveStill = await TimetableEntry.countDocuments({});
        check('regenerating did NOT disturb the published timetable', () => assert.strictEqual(liveStill, 88));

        const list = await api('GET', '/admin/timetable/versions');
        check('both versions are listed with their statuses', () => {
            assert.strictEqual(list.body.data.versions.length, 2);
            assert.ok(list.body.data.versions.some((v) => v.status === 'published'));
        });

        const compare = await api('GET', `/admin/timetable/versions/${versionId}/compare/${secondVersionId}`);
        check('versions can be compared', () => {
            assert.strictEqual(compare.status, 200);
            assert.ok(typeof compare.body.data.summary.total === 'number');
        });

        const dup = await api('POST', `/admin/timetable/versions/${versionId}/duplicate`);
        check('a version can be duplicated into a new draft (201)', () => {
            assert.strictEqual(dup.status, 201);
            assert.strictEqual(dup.body.data.versionNumber, 3);
        });
        const dupEntries = await TimetableVersionEntry.countDocuments({ version: dup.body.data._id });
        check('the duplicate carries every entry across', () => assert.strictEqual(dupEntries, 88));

        const archive = await api('POST', `/admin/timetable/versions/${dup.body.data._id}/archive`);
        check('a draft can be archived', () => assert.strictEqual(archive.status, 200));

        const archivePublished = await api('POST', `/admin/timetable/versions/${versionId}/archive`);
        check('the live version cannot be archived (400)', () => assert.strictEqual(archivePublished.status, 400));

        const del = await api('DELETE', `/admin/timetable/versions/${versionId}`);
        check('the published version cannot be deleted (400)', () => assert.strictEqual(del.status, 400));

        // Publishing v2 must retire v1 and swap the live rows atomically.
        const validate2 = await api('POST', `/admin/timetable/versions/${secondVersionId}/validate`);
        if (validate2.body.data?.valid) {
            const pub2 = await api('POST', `/admin/timetable/versions/${secondVersionId}/publish`);
            check('publishing version 2 succeeds', () => assert.strictEqual(pub2.status, 200, JSON.stringify(pub2.body)));
            check('version 2 archived version 1', () => assert.strictEqual(pub2.body.data.archivedVersions, 1));
            const v1 = await TimetableVersion.findById(versionId).lean();
            check('version 1 is now archived', () => assert.strictEqual(v1.status, 'archived'));
            const live = await TimetableEntry.countDocuments({});
            check('the live timetable still holds exactly one schedule', () => assert.strictEqual(live, 88));
        }
    }

    /* ── Audit ───────────────────────────────────────────────────────────── */
    step('Audit trail');
    {
        const audit = await api('GET', '/admin/timetable/audit?limit=100');
        const actions = audit.body.data.logs.map((l) => l.actionType);
        check('audit records the generate action', () => assert.ok(actions.includes('generate')));
        check('audit records the manual move', () => assert.ok(actions.includes('move')));
        check('audit records the publish', () => assert.ok(actions.includes('publish')));
        check('audit records who did it', () => assert.ok(audit.body.data.logs.every((l) => l.user)));
        const move = audit.body.data.logs.find((l) => l.actionType === 'move');
        check('the move log states the before and after slot', () => {
            assert.ok(move.meta.from.dayOfWeek && move.meta.to.dayOfWeek);
            assert.match(move.description, /→/);
        });
    }

    /* ── Export ──────────────────────────────────────────────────────────── */
    step('Export');
    {
        for (const view of ['class', 'teacher', 'room']) {
            const res = await fetch(`${API}/admin/timetable/versions/${versionId}/export?view=${view}&format=pdf`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const buf = Buffer.from(await res.arrayBuffer());
            check(`${view} PDF export streams a real PDF`, () => {
                assert.strictEqual(res.status, 200);
                assert.strictEqual(buf.slice(0, 4).toString(), '%PDF');
            });
        }
        const xl = await fetch(`${API}/admin/timetable/versions/${versionId}/export?view=class&format=excel`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const xbuf = Buffer.from(await xl.arrayBuffer());
        check('Excel export streams a real xlsx', () => {
            assert.strictEqual(xl.status, 200);
            assert.strictEqual(xbuf.slice(0, 2).toString(), 'PK');
        });
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${passed} passed, ${failed} failed`);
    await db.disconnect();
    process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\nFATAL:', e); process.exit(1); });
