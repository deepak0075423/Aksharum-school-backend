'use strict';
/**
 * Test harness for Video Learning.
 *
 * Built on the admission harness (tests/admission/helpers): each test file
 * starts its own copy of the API on a free port with NODE_APP_INSTANCE=1 — no
 * background sweeps; the tests drive the module's clock themselves — and
 * builds scratch schools in the configured database, which it removes again
 * (rows and files) when the file finishes. Library rows the tests create are
 * tagged (board and subject codes start ZZT) and removed the same way.
 *
 *   npm run test:video
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const A = require('../admission/helpers');
const pool = require('../../db/pool');

const { api, q, insert, uuid, tokenFor, rand } = A;
const ROOT = path.join(__dirname, '..', '..');

const made = { schools: [], users: [], boards: [], subjects: [], videos: [] };

const startServer = (env = {}) => A.startServer({
    VIDEO_EMBED_LOOKUP: 'off', RL_VL_BEAT_MAX: '100000', RL_VL_PLAY_MAX: '100000', RL_VL_WRITE_MAX: '100000', ...env,
});

/** A Super Admin of this run only — the real one is never signed in as. */
async function makeSuperAdmin() {
    const hash = await bcrypt.hash('Passw0rd!', 4);
    const u = await insert('users', { _id: uuid(), name: 'Library Admin', email: `super-${rand()}@school.test`, password: hash, role: 'super_admin', school: null, isFirstLogin: false, isActive: true, createdAt: new Date() });
    made.users.push(u._id);
    return { user: u, token: tokenFor(u) };
}

/**
 * A school with Video Learning on: one year, Class 9 with sections A, B and C
 * (and Class 10 with A), Hindi and Maths as Class 9's subjects, a teacher of
 * Hindi in 9-A and 9-B, another of Maths in 9-A, and two students a section.
 */
async function makeSchool(label = 'A', { videoLibrary = true } = {}) {
    const tag = rand();
    const id = uuid();
    await insert('schools', {
        _id: id, name: `Video Test ${label} ${tag}`, code: `VLT${tag}`.toUpperCase(), email: `office-${tag}@school.test`, isActive: true, board: 'State Board',
        admissionNumberFormat: '{INITIALS}{YYYY}{####}', employeeIdFormat: '{INITIALS}{####}',
        modules: { videoLibrary, notification: true }, paymentGateway: { enabled: false, provider: 'none', modules: {} }, createdAt: new Date(),
    });
    made.schools.push(id);
    const year = await insert('academicyears', { _id: uuid(), school: id, yearName: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), status: 'active', createdAt: new Date() });
    const c9 = await insert('classes', { _id: uuid(), school: id, academicYear: year._id, classNumber: 9, className: 'Class 9', status: 'active', createdAt: new Date() });
    const c10 = await insert('classes', { _id: uuid(), school: id, academicYear: year._id, classNumber: 10, className: 'Class 10', status: 'active', createdAt: new Date() });
    const hash = await bcrypt.hash('Passw0rd!', 4);
    const person = async (role, name) => {
        const u = await insert('users', { _id: uuid(), name, email: `${role}-${rand()}@school.test`, password: hash, role, school: id, isFirstLogin: false, isActive: true, createdAt: new Date() });
        return u;
    };
    const admin = await person('school_admin', 'Office Admin');
    const hindiTeacher = await person('teacher', 'Hema Hindi');
    const mathsTeacher = await person('teacher', 'Manoj Maths');
    for (const t of [hindiTeacher, mathsTeacher]) await insert('teacherprofiles', { _id: uuid(), user: t._id, school: id, designation: 'Teacher', createdAt: new Date() }).catch(() => {});

    const sections = {};
    const students = {};
    for (const [cls, names] of [[c9, ['A', 'B', 'C']], [c10, ['A']]]) {
        for (const name of names) {
            const key = `${cls.classNumber}${name}`;
            const kids = [await person('student', `Student ${key} One`), await person('student', `Student ${key} Two`)];
            const sec = await insert('classsections', {
                _id: uuid(), school: id, class: cls._id, academicYear: year._id, sectionName: name, maxStudents: 40, currentCount: kids.length,
                enrolledStudents: kids.map((k) => String(k._id)), status: 'active', createdAt: new Date(),
            });
            let roll = 1;
            for (const k of kids) await insert('studentprofiles', { _id: uuid(), user: k._id, school: id, currentClass: cls._id, currentSection: sec._id, rollNumber: String(roll++), createdAt: new Date() });
            sections[key] = sec; students[key] = kids;
        }
    }
    const subject = async (name, code) => insert('subjects', { _id: uuid(), school: id, academicYear: year._id, subjectName: name, subjectCode: code, type: 'theory', teachers: [], createdAt: new Date() });
    const hindi = await subject('Hindi', 'HIN');
    const maths = await subject('Mathematics', 'MAT');
    for (const s of [hindi, maths]) await insert('classsubjects', { _id: uuid(), class: c9._id, subject: s._id, createdAt: new Date() });
    const teach = (section, subj, teacher) => insert('sectionsubjectteachers', { _id: uuid(), section: section._id, subject: subj._id, teacher: teacher._id, createdAt: new Date() });
    await teach(sections['9A'], hindi, hindiTeacher);
    await teach(sections['9B'], hindi, hindiTeacher);
    await teach(sections['9A'], maths, mathsTeacher);

    return {
        id, tag, year, classes: { 9: c9, 10: c10 }, sections, students, subjects: { hindi, maths },
        admin, hindiTeacher, mathsTeacher,
        adminToken: tokenFor(admin), hindiToken: tokenFor(hindiTeacher), mathsToken: tokenFor(mathsTeacher),
        tokenOf: (u) => tokenFor(u),
    };
}

const must = (r, status, label) => {
    if (r.status !== status) throw new Error(`${label}: expected ${status}, got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body.data;
};

/** A board (Classes 9 and 10), Hindi mapped to it, and nothing else. Codes are tagged for clean-up. */
async function makeBoard(superToken, { levels = [9, 10] } = {}) {
    const tag = rand().toUpperCase();
    const board = must(await api('POST', '/video/central/boards', { token: superToken, body: { name: `Test Board ${tag}`, code: `ZZT${tag}`, classLevels: levels } }), 201, 'board');
    made.boards.push(board._id);
    const subject = must(await api('POST', '/video/central/subjects', {
        token: superToken, body: { name: `Hindi ${tag}`, code: `ZZT${tag}H`, language: 'Hindi', mappings: [{ board: board._id, classLevels: levels }] },
    }), 201, 'subject');
    made.subjects.push(subject._id);
    return { board, subject, tag };
}

async function makeBook(superToken, lib, { title = 'Book A', publisher = 'Publisher A', classLevel = 9, chapters = 2 } = {}) {
    const book = must(await api('POST', '/video/central/books', { token: superToken, body: { title: `${title} ${lib.tag}`, board: lib.board._id, classLevel, subject: lib.subject._id, publisher, edition: '1st' } }), 201, 'book');
    const out = [];
    for (let n = 1; n <= chapters; n++) {
        out.push(must(await api('POST', `/video/central/books/${book._id}/chapters`, { token: superToken, body: { title: `Chapter ${n}`, chapterNumber: n } }), 201, 'chapter'));
    }
    return { book, chapters: out };
}

/**
 * A small file that really is an MP4 as far as its structure goes: a file-type
 * box, a movie header saying how long it runs, and padding. Not playable —
 * enough for the upload checks and the length reader.
 */
function mp4(durationSec = 120, sizeBytes = 64 * 1024) {
    const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isommp42')]);
    const mvhd = Buffer.alloc(108);
    mvhd.writeUInt32BE(108, 0); mvhd.write('mvhd', 4, 'latin1');
    mvhd.writeUInt32BE(1000, 20); mvhd.writeUInt32BE(Math.round(durationSec * 1000), 24);
    const moov = Buffer.concat([Buffer.from([0, 0, 0, 116]), Buffer.from('moov'), mvhd]);
    const pad = Math.max(8, sizeBytes - ftyp.length - moov.length);
    const mdat = Buffer.alloc(pad, 7);
    mdat.writeUInt32BE(pad, 0); mdat.write('mdat', 4, 'latin1');
    return Buffer.concat([ftyp, mdat, moov]);       // the movie header last, as many cameras write it
}

/** Send raw bytes (a chunk) to the API. */
async function putBytes(url, token, buffer) {
    const res = await fetch(`${A.BASE}/api${url}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: buffer });
    return { status: res.status, body: await res.json() };
}

/** Run the module's background jobs here, in the test process (the test server runs none). */
const runJobs = async () => { const jobs = require('../../services/lms/jobs'); for (let i = 0; i < 5; i++) if (!await jobs.tick()) break; };
const sweep = () => require('../../services/lms/sweep');

/** Create a video, upload a file for it in chunks, process it. Returns the ready video. */
async function uploadedVideo(superToken, { title = 'Lesson', durationSec = 120, file = null } = {}) {
    const v = must(await api('POST', '/video/central/videos', { token: superToken, body: { title: `${title} ${rand()}` } }), 201, 'video');
    made.videos.push(v._id);
    const bytes = file || mp4(durationSec);
    const up = must(await api('POST', `/video/central/videos/${v._id}/uploads`, { token: superToken, body: { filename: 'lesson.mp4', mimeType: 'video/mp4', sizeBytes: bytes.length } }), 201, 'upload');
    for (let i = 0; i < up.totalChunks; i++) {
        const r = await putBytes(`/video/central/uploads/${up.uploadId}/chunks/${i}`, superToken, bytes.subarray(i * up.chunkSize, (i + 1) * up.chunkSize));
        if (r.status !== 200) throw new Error(`chunk ${i}: ${JSON.stringify(r.body)}`);
    }
    must(await api('POST', `/video/central/uploads/${up.uploadId}/complete`, { token: superToken, body: {} }), 200, 'complete');
    await runJobs();
    for (let i = 0; i < 40; i++) {
        const now = must(await api('GET', `/video/central/videos/${v._id}`, { token: superToken }), 200, 'video');
        if (now.processingStatus === 'ready' || now.processingStatus === 'failed') return now;
        await new Promise((r) => setTimeout(r, 150));
        await runJobs();
    }
    throw new Error('the video was never processed');
}

/** A linked (YouTube) video — ready at once, no file. */
async function linkedVideo(superToken, { title = 'Linked lesson', durationSec = 300 } = {}) {
    const ytId = crypto.randomBytes(8).toString('base64url').slice(0, 11).padEnd(11, 'x');
    const v = must(await api('POST', '/video/central/videos', { token: superToken, body: { provider: 'youtube', url: `https://youtu.be/${ytId}`, title: `${title} ${rand()}`, durationSec, protection: 'standard' } }), 201, 'linked video');
    made.videos.push(v._id);
    return v;
}

const mapTo = async (superToken, chapter, videos) => must(await api('POST', `/video/central/chapters/${chapter._id}/videos`, { token: superToken, body: { videos: videos.map((v) => v._id) } }), 200, 'map');

/** The school follows the board, selects Hindi for Class 9 and assigns `book` to `sections` ('all' or section keys). */
async function follow(s, lib, book, sections = 'all') {
    must(await api('PUT', '/video/school/board', { token: s.adminToken, body: { academicYear: s.year._id, board: lib.board._id } }), 200, 'board choice');
    must(await api('PUT', `/video/school/classes/${s.classes[9]._id}/subjects`, { token: s.adminToken, body: { subjects: [{ lmsSubject: lib.subject._id, schoolSubject: s.subjects.hindi._id }] } }), 200, 'subjects');
    return must(await api('PUT', '/video/school/books/assignment', {
        token: s.adminToken, body: { class: s.classes[9]._id, book: book._id, sections: sections === 'all' ? 'all' : sections.map((k) => s.sections[k]._id) },
    }), 200, 'assignment');
}

/** Pretend `seconds` have passed since the session's last heartbeat. */
const age = (sessionId, seconds) => q(`UPDATE "lmswatchsessions" SET "lastBeatAt" = now() - ($2 || ' seconds')::interval WHERE "_id" = $1`, [sessionId, String(seconds)]);

/** Play a session forward in real-time-sized steps of `step` seconds from `from` to `to`. Returns the last answer. */
async function watch(token, sessionId, { from = 0, to, step = 15, seq = 1 }) {
    let n = seq; let last;
    last = await api('POST', `/video/student/sessions/${sessionId}/heartbeat`, { token, body: { seq: n++, positionSec: from, state: 'playing' } });
    for (let pos = from + step; pos <= to + 0.001; pos += step) {
        await age(sessionId, step);
        last = await api('POST', `/video/student/sessions/${sessionId}/heartbeat`, { token, body: { seq: n++, positionSec: Math.min(pos, to), state: 'playing' } });
        if (last.status !== 200) throw new Error(`heartbeat: ${JSON.stringify(last.body)}`);
    }
    return { last: last.body.data, seq: n };
}

async function cleanup() {
    const users = [...made.users];
    for (const sid of made.schools) users.push(...(await q('SELECT "_id" FROM "users" WHERE "school" = $1', [sid])).map((r) => String(r._id)));
    // What the runs told people: nothing of a scratch school stays in a real inbox.
    if (users.length) {
        const sent = (await q('SELECT "_id" FROM "notifications" WHERE "sender" = ANY($1::uuid[])', [users])).map((r) => r._id);
        if (sent.length) { await q('DELETE FROM "notificationreceipts" WHERE "notification" = ANY($1::uuid[])', [sent]); await q('DELETE FROM "notifications" WHERE "_id" = ANY($1::uuid[])', [sent]); }
        await q('DELETE FROM "notificationreceipts" WHERE "recipient" = ANY($1::uuid[])', [users]);
    }
    const run = (sql, p) => pool.query(sql, p).catch((e) => console.error(`[cleanup] ${sql.slice(0, 70)}: ${e.message}`));
    for (const sid of made.schools) {
        for (const r of await q('SELECT "attachmentFile" FROM "lmsrequests" WHERE "school" = $1 AND "attachmentFile" <> \'\'', [sid]).catch(() => [])) {
            fs.promises.unlink(path.join(ROOT, 'uploads', 'lms-requests', path.basename(r.attachmentFile))).catch(() => {});
        }
        for (const t of ['lmswatchsessions', 'lmsprogresses', 'lmsreleases', 'lmsbookassignments', 'lmsschoolsubjects', 'lmsschoolconfigs', 'lmsrequests', 'lmsaudits', 'lmsnotices', 'lmssettings']) {
            await run(`DELETE FROM "${t}" WHERE "school" = $1`, [sid]);
        }
        const secs = (await q('SELECT "_id" FROM "classsections" WHERE "school" = $1', [sid])).map((r) => r._id);
        if (secs.length) await run('DELETE FROM "sectionsubjectteachers" WHERE "section" = ANY($1::uuid[])', [secs]);
        const cls = (await q('SELECT "_id" FROM "classes" WHERE "school" = $1', [sid])).map((r) => r._id);
        if (cls.length) await run('DELETE FROM "classsubjects" WHERE "class" = ANY($1::uuid[])', [cls]);
        await run('DELETE FROM "subjects" WHERE "school" = $1', [sid]);
    }
    await A.cleanup([...made.schools]);
    // The library rows of this run: books (their chapters and mappings go with them), then videos, subjects, boards.
    if (made.boards.length) {
        await run('DELETE FROM "lmsrequests" WHERE "board" = ANY($1::uuid[])', [made.boards]);
        await run(`DELETE FROM "lmsnotices" WHERE "key" IN (SELECT 'book:new:' || "_id"::text FROM "lmsbooks" WHERE "board" = ANY($1::uuid[]))`, [made.boards]);
        await run('DELETE FROM "lmsbooks" WHERE "board" = ANY($1::uuid[])', [made.boards]);
        await run('DELETE FROM "lmssubjectmaps" WHERE "board" = ANY($1::uuid[])', [made.boards]);
    }
    for (const v of made.videos) {
        await run('DELETE FROM "lmsvideos" WHERE "_id" = $1', [v]);
        await fs.promises.rm(path.join(ROOT, 'uploads', 'lms-videos', String(v)), { recursive: true, force: true }).catch(() => {});
    }
    if (made.subjects.length) await run('DELETE FROM "lmssubjects" WHERE "_id" = ANY($1::uuid[])', [made.subjects]);
    if (made.boards.length) await run('DELETE FROM "lmsboards" WHERE "_id" = ANY($1::uuid[])', [made.boards]);
    if (made.users.length) {
        await run('DELETE FROM "lmsaudits" WHERE "actor" = ANY($1::uuid[])', [made.users]);
        await run('DELETE FROM "users" WHERE "_id" = ANY($1::uuid[])', [made.users]);
    }
    for (const k of Object.keys(made)) made[k].length = 0;
}

/** Library rows a killed run left behind (tagged ZZT), and scratch schools named by makeSchool. */
async function leftovers() {
    const boards = (await q(`SELECT "_id" FROM "lmsboards" WHERE "code" LIKE 'ZZT%'`)).map((r) => String(r._id));
    const subjects = (await q(`SELECT "_id" FROM "lmssubjects" WHERE "code" LIKE 'ZZT%'`)).map((r) => String(r._id));
    const schools = (await q(`SELECT "_id" FROM "schools" WHERE "name" LIKE 'Video Test %' AND "code" LIKE 'VLT%' AND "email" LIKE '%@school.test'`)).map((r) => String(r._id));
    return { boards, subjects, schools };
}

async function finish() {
    await cleanup();
    await A.finish();
}

module.exports = {
    ...A, startServer, finish, cleanup, leftovers, made, must,
    makeSuperAdmin, makeSchool, makeBoard, makeBook, mp4, putBytes, runJobs, sweep, uploadedVideo, linkedVideo, mapTo, follow, age, watch,
    get BASE() { return A.BASE; },
};
