'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * What a student is credited with is decided by the server, from its own
 * clock — not by what the player claims. The tests stand in for a player:
 * they send heartbeats and move the session's "last heard from" time back to
 * let seconds pass without waiting for them.
 */
describe('video learning — watching and the record of it', () => {
    let SA; let lib; let S; let book; let ch; let cv; let video;
    const student = (key = '9A', i = 0) => S.students[key][i];
    const tok = (key, i) => S.tokenOf(student(key, i));
    const authorize = (token, id = cv.one) => H.api('POST', `/video/student/watch/${id}/authorize`, { token, body: {} });
    const beat = (token, sid, body) => H.api('POST', `/video/student/sessions/${sid}/heartbeat`, { token, body });
    const progress = async (kid, id = cv.one) => (await H.q(`SELECT * FROM "lmsprogresses" WHERE "student" = $1 AND "chapterVideo" = $2`, [kid._id, id]))[0];

    before(async () => {
        await H.startServer();
        SA = await H.makeSuperAdmin();
        lib = await H.makeBoard(SA.token);
        const made = await H.makeBook(SA.token, lib, { title: 'Book A', publisher: 'Publisher A', chapters: 2 });
        book = made.book; ch = made.chapters;
        video = await H.uploadedVideo(SA.token, { title: 'Ten minutes', durationSec: 600 });
        const short = await H.uploadedVideo(SA.token, { title: 'Short', durationSec: 60 });
        await H.mapTo(SA.token, ch[0], [video, short]);
        S = await H.makeSchool('Trk');
        await H.follow(S, lib, book, 'all');
        const detail = (await H.api('GET', `/video/central/books/${book._id}`, { token: SA.token })).body.data;
        cv = { one: detail.chapters[0].videos[0]._id, two: detail.chapters[0].videos[1]._id };
        for (const key of ['9A', '9B']) H.must(await H.api('POST', '/video/teacher/releases', { token: S.hindiToken, body: { book: book._id, level: 'book', section: S.sections[key]._id } }), 201, 'release');
    });
    after(() => H.finish());

    let session;
    it('playback is authorised with a short-lived signed address bound to a session — and nothing that reveals storage', async () => {
        const r = await authorize(tok());
        const a = H.must(r, 200, 'authorize');
        session = a.sessionId;
        assert.equal(a.video.durationSec, 600);
        assert.equal(a.progress.resumePositionSec, 0);
        assert.equal(a.policy.completionThresholdPercent, 90);
        assert.match(a.playback.path, /^\/video\/stream\/[\w-]+\.[\w-]+$/);
        const text = JSON.stringify(a);
        assert.ok(!/storageKey|lms-videos|source-|uploads\//.test(text), 'no storage path in the answer');
        // The address works, with ranges, and is not cacheable.
        const res = await fetch(`${H.BASE}/api${a.playback.path}`, { headers: { Range: 'bytes=0-15' } });
        assert.equal(res.status, 206);
        assert.equal(res.headers.get('content-range').startsWith('bytes 0-15/'), true);
        assert.match(res.headers.get('cache-control'), /no-store/);
        assert.equal(Buffer.from(await res.arrayBuffer()).toString('latin1', 4, 8), 'ftyp');
        // A made-up or altered token gets nothing.
        assert.equal((await fetch(`${H.BASE}/api/video/stream/abc.def`)).status, 403);
        assert.equal((await fetch(`${H.BASE}/api${a.playback.path}x`)).status, 403);
        // A second sitting closes the first: one account, one screen.
        const again = H.must(await authorize(tok()), 200, 'again');
        assert.equal((await fetch(`${H.BASE}/api${a.playback.path}`, { headers: { Range: 'bytes=0-15' } })).status, 403, 'the first address is dead');
        session = again.sessionId;
        const [p] = [await progress(student())];
        assert.equal(p.sessionsCount, 2);
        assert.equal(p.section, S.sections['9A']._id, 'the record carries school, year, class, section, subject, book and chapter');
        assert.ok(p.school && p.academicYear && p.class && p.schoolSubject && p.lmsSubject && p.book && p.chapter && p.video);
    });

    it('progress is recorded from real playing time: position, watch time, percentage, first and last watched', async () => {
        const w = await H.watch(tok(), session, { from: 0, to: 60 });
        assert.equal(w.last.accepted, true);
        assert.equal(w.last.furthestSec, 60);
        assert.equal(w.last.watchedSeconds, 60);
        assert.equal(w.last.watchedPercent, 10);
        assert.equal(w.last.completed, false);
        const p = await progress(student());
        assert.equal(p.status, 'in_progress');
        assert.ok(p.firstWatchedAt && p.lastWatchedAt);
        const [s] = await H.q('SELECT "creditedSec", "lastSeq", "lastState" FROM "lmswatchsessions" WHERE "_id" = $1', [session]);
        assert.equal(s.creditedSec, 60, 'the session keeps its own total, apart from the roll-up');
        const beats = await H.q('SELECT count(*)::int AS n FROM "lmsheartbeats" WHERE "session" = $1', [session]);
        assert.equal(beats[0].n, 5, 'and every heartbeat is kept as it arrived');
    });

    it('a heartbeat sent twice counts once', async () => {
        await H.age(session, 15);
        const first = (await beat(tok(), session, { seq: 6, positionSec: 75, state: 'playing' })).body.data;
        assert.equal(first.watchedSeconds, 75);
        // The same heartbeat again (a retry), and an older one arriving late.
        await H.age(session, 15);
        const retry = (await beat(tok(), session, { seq: 6, positionSec: 75, state: 'playing' })).body.data;
        assert.equal(retry.duplicate, true);
        assert.equal(retry.watchedSeconds, 75);
        const late = (await beat(tok(), session, { seq: 3, positionSec: 90, state: 'playing' })).body.data;
        assert.equal(late.duplicate, true);
        // Twenty copies in a burst.
        await Promise.all(Array.from({ length: 20 }, () => beat(tok(), session, { seq: 6, positionSec: 75, state: 'playing' })));
        const p = await progress(student());
        assert.equal(p.watchedSeconds, 75);
        assert.equal(p.furthestSec, 75);
        const [{ n }] = await H.q('SELECT count(*)::int AS n FROM "lmsheartbeats" WHERE "session" = $1 AND "seq" = 6', [session]);
        assert.equal(n, 1);
        // The clock moved while the duplicates arrived; the next real heartbeat still counts properly.
        await H.q(`UPDATE "lmswatchsessions" SET "lastBeatAt" = now() - interval '15 seconds' WHERE "_id" = $1`, [session]);
        const next = (await beat(tok(), session, { seq: 7, positionSec: 90, state: 'playing' })).body.data;
        assert.equal(next.watchedSeconds, 90);
    });

    it('seeking forward does not count: the jump is refused and the student is sent back', async () => {
        await H.age(session, 15);
        const jump = (await beat(tok(), session, { seq: 8, positionSec: 590, state: 'playing' })).body.data;
        assert.equal(jump.accepted, false);
        assert.equal(jump.reason, 'seek_ahead');
        assert.equal(jump.furthestSec, 90, 'the furthest point did not move');
        assert.equal(jump.resumePositionSec, 90, 'and that is where the player is told to return');
        assert.equal(jump.completed, false);
        // Claiming "ended" at the very end is no better.
        const ended = (await beat(tok(), session, { seq: 9, positionSec: 600, state: 'ended' })).body.data;
        assert.equal(ended.accepted, false);
        assert.equal(ended.completed, false);
        const p = await progress(student());
        assert.equal(p.status, 'in_progress');
        assert.equal(p.watchedPercent, 15);
        assert.equal(p.seekViolations, 2);
        assert.equal(p.watchedSeconds, 90);
        // Carrying on from where they really were is fine: the player goes back and plays on.
        await beat(tok(), session, { seq: 10, positionSec: 90, state: 'playing' });
        await H.age(session, 15);
        const on = (await beat(tok(), session, { seq: 11, positionSec: 105, state: 'playing' })).body.data;
        assert.equal(on.accepted, true);
        assert.equal(on.furthestSec, 105);
    });

    it('paused time, a faster speed and a burst of reports earn nothing', async () => {
        // Pause for ten minutes.
        await H.age(session, 5);
        const paused = (await beat(tok(), session, { seq: 12, positionSec: 110, state: 'paused' })).body.data;
        assert.equal(paused.watchedSeconds, 110);
        await H.age(session, 600);
        const stillPaused = (await beat(tok(), session, { seq: 13, positionSec: 110, state: 'paused' })).body.data;
        assert.equal(stillPaused.watchedSeconds, 110, 'ten paused minutes are not watch time');
        // "Resuming" far ahead after the pause: a seek, not play.
        await H.age(session, 600);
        const skipped = (await beat(tok(), session, { seq: 14, positionSec: 400, state: 'playing' })).body.data;
        assert.equal(skipped.accepted, false);
        assert.equal(skipped.furthestSec, 110);
        // Resume properly, then play at "double speed": 30 seconds of video in 15 of clock.
        await beat(tok(), session, { seq: 15, positionSec: 110, state: 'playing' });
        await H.age(session, 15);
        const fast = (await beat(tok(), session, { seq: 16, positionSec: 140, state: 'playing' })).body.data;
        assert.equal(fast.accepted, false, 'more video than time');
        assert.equal(fast.furthestSec, 110);
        // A script sending many reports back to back, each a little further on.
        await beat(tok(), session, { seq: 17, positionSec: 110, state: 'playing' });
        let last;
        for (let i = 1; i <= 30; i++) last = (await beat(tok(), session, { seq: 17 + i, positionSec: 110 + i * 2, state: 'playing' })).body.data;
        assert.ok(last.furthestSec < 116, `thirty rapid reports moved the record ${last.furthestSec - 110}s — no more than the moment they took`);
        const p = await progress(student());
        assert.ok(p.watchedSeconds < 116);
    });

    it('watched portions can be replayed; that counts as watch time but not as progress', async () => {
        const before = await progress(student());
        const s = H.must(await authorize(tok()), 200, 'reopen').sessionId;
        // Back to the start, by choice.
        await beat(tok(), s, { seq: 1, positionSec: 0, state: 'playing' });
        await H.age(s, 15);
        const replay = (await beat(tok(), s, { seq: 2, positionSec: 15, state: 'playing' })).body.data;
        assert.equal(replay.accepted, true);
        assert.equal(replay.furthestSec, Math.round(before.furthestSec * 100) / 100, 'furthest point unchanged');
        assert.equal(replay.watchedSeconds, Math.round(before.watchedSeconds) + 15);
        // Forward again, but only as far as they had been.
        const hop = (await beat(tok(), s, { seq: 3, positionSec: 100, state: 'playing' })).body.data;
        assert.equal(hop.accepted, true, 'moving within what was watched is allowed');
        session = s;
    });

    it('a student resumes where they left off — after signing out, a refresh, or a lost connection', async () => {
        const at = (await progress(student())).furthestSec;
        // Move to the furthest point and play 30 seconds more, then vanish without a word.
        await beat(tok(), session, { seq: 4, positionSec: at, state: 'playing' });
        await H.age(session, 15); await beat(tok(), session, { seq: 5, positionSec: at + 15, state: 'playing' });
        await H.age(session, 15); await beat(tok(), session, { seq: 6, positionSec: at + 30, state: 'playing' });
        // Hours later the sweep closes the silent session…
        await H.age(session, 4000);
        assert.ok((await H.sweep().minute()).idleClosed >= 1);
        const dead = (await beat(tok(), session, { seq: 7, positionSec: at + 45, state: 'playing' })).body.data;
        assert.equal(dead.closed, true);
        assert.equal(dead.reason, 'session_idle');
        // …and a new one picks up at the same second.
        const fresh = H.must(await authorize(tok()), 200, 'resume');
        assert.equal(fresh.progress.resumePositionSec, Math.round((at + 30) * 100) / 100);
        assert.equal(fresh.progress.furthestSec, Math.round((at + 30) * 100) / 100);
        session = fresh.sessionId;
        const home = (await H.api('GET', '/video/student/home', { token: tok() })).body.data;
        assert.equal(home.continueWatching.length, 1);
        assert.ok(Math.abs(home.continueWatching[0].resumePositionSec - fresh.progress.resumePositionSec) < 0.01);
        const chapter = (await H.api('GET', `/video/student/chapters/${ch[0]._id}`, { token: tok() })).body.data;
        assert.equal(chapter.videos[0].canResume, true);
        assert.equal(chapter.videos[0].status, 'in_progress');
        assert.equal(chapter.videos[1].status, 'not_started');
    });

    it('a network gap is bridged up to a limit, never invented', async () => {
        const at = (await progress(student())).furthestSec;
        await beat(tok(), session, { seq: 1, positionSec: at, state: 'playing' });
        // Fifty seconds with no report (buffered video kept playing): counted.
        await H.age(session, 50);
        const bridged = (await beat(tok(), session, { seq: 2, positionSec: at + 50, state: 'playing' })).body.data;
        assert.equal(bridged.accepted, true);
        assert.equal(bridged.furthestSec, Math.round((at + 50) * 100) / 100);
        // Ten minutes with no report, then a claim of ten minutes watched: beyond what is believed.
        await H.age(session, 600);
        const claimed = (await beat(tok(), session, { seq: 3, positionSec: Math.min(599, at + 400), state: 'playing' })).body.data;
        assert.equal(claimed.accepted, false);
        assert.equal(claimed.furthestSec, Math.round((at + 50) * 100) / 100);
    });

    it('a video is completed at the threshold of real watching — and the teacher is told once', async () => {
        const kid = student('9A', 1);
        const token = S.tokenOf(kid);
        const a = H.must(await authorize(token), 200, 'authorize');
        const almost = await H.watch(token, a.sessionId, { from: 0, to: 525 });      // 87.5%
        assert.equal(almost.last.completed, false);
        const done = await H.watch(token, a.sessionId, { from: 525, to: 540, seq: almost.seq });   // 90%
        assert.equal(done.last.completed, true);
        assert.equal(done.last.justCompleted, true);
        const more = await H.watch(token, a.sessionId, { from: 540, to: 600, seq: done.seq });
        assert.equal(more.last.watchedPercent, 100);
        assert.equal(more.last.justCompleted, false, 'completed once');
        const p = await progress(kid);
        assert.equal(p.status, 'completed');
        assert.ok(p.completedAt);
        assert.equal(p.watchedSeconds, 600);

        // The chapter has a second, short video: finish it and the chapter is complete.
        const b = H.must(await authorize(token, cv.two), 200, 'second video');
        await H.watch(token, b.sessionId, { from: 0, to: 60 });
        await new Promise((r) => setTimeout(r, 900));
        const told = await H.q(`
            SELECT n."title" FROM "notificationreceipts" r JOIN "notifications" n ON n."_id" = r."notification"
             WHERE r."recipient" = $1 ORDER BY n."createdAt"`, [S.hindiTeacher._id]);
        assert.deepEqual(told.map((t) => t.title.replace(/^.* completed/, 'completed')), ['completed a video', 'completed a video', 'completed a chapter']);
        const bookView = (await H.api('GET', `/video/student/books/${book._id}`, { token })).body.data;
        assert.equal(bookView.chapters[0].status, 'completed');
        assert.equal(bookView.chapters[0].percent, 100);
        assert.equal(bookView.totals.percent, 100);
        const home = (await H.api('GET', '/video/student/home', { token })).body.data.totals;
        assert.deepEqual([home.videos, home.completed, home.inProgress, home.notStarted, home.percent], [2, 2, 0, 0, 100]);
    });

    it('opening the same account in two places at once leaves exactly one sitting open', async () => {
        const token = tok('9B', 1);
        const both = await Promise.all([authorize(token), authorize(token), authorize(token)]);
        assert.ok(both.every((r) => r.status === 200));
        const open = await H.q(`SELECT count(*)::int AS n FROM "lmswatchsessions" WHERE "student" = $1 AND "status" = 'open'`, [student('9B', 1)._id]);
        assert.equal(open[0].n, 1);
        const p = await progress(student('9B', 1));
        assert.equal(p.sessionsCount, 3, 'each opening is still counted as a sitting');
        await H.q(`UPDATE "lmswatchsessions" SET "status" = 'closed' WHERE "student" = $1`, [student('9B', 1)._id]);
    });

    it('a student cannot use another student\'s session, or play without one', async () => {
        const mine = H.must(await authorize(tok('9B', 0)), 200, 'authorize');
        const other = tok('9B', 1);
        assert.equal((await beat(other, mine.sessionId, { seq: 1, positionSec: 10, state: 'playing' })).status, 404);
        assert.equal((await H.api('POST', `/video/student/sessions/${mine.sessionId}/end`, { token: other, body: {} })).status, 404);
        assert.equal((await H.api('POST', `/video/student/sessions/${mine.sessionId}/renew`, { token: other, body: {} })).status, 404);
        assert.equal((await beat(S.hindiToken, mine.sessionId, { seq: 1, positionSec: 10, state: 'playing' })).status, 403, 'heartbeats are a student\'s');
        assert.equal((await beat(tok('9B', 0), mine.sessionId, { seq: 'x', positionSec: 10, state: 'playing' })).status, 400);
        assert.equal((await beat(tok('9B', 0), mine.sessionId, { seq: 1, positionSec: -4, state: 'playing' })).status, 400);
        assert.equal((await beat(tok('9B', 0), mine.sessionId, { seq: 1, positionSec: 4, state: 'rewinding' })).status, 400);
        // Renewing gives a fresh address for the same session; ending it kills both.
        const renewed = H.must(await H.api('POST', `/video/student/sessions/${mine.sessionId}/renew`, { token: tok('9B', 0), body: {} }), 200, 'renew');
        assert.equal((await fetch(`${H.BASE}/api${renewed.playback.path}`, { headers: { Range: 'bytes=0-9' } })).status, 206);
        await H.api('POST', `/video/student/sessions/${mine.sessionId}/end`, { token: tok('9B', 0), body: {} });
        assert.equal((await fetch(`${H.BASE}/api${renewed.playback.path}`, { headers: { Range: 'bytes=0-9' } })).status, 403);
        assert.equal((await fetch(`${H.BASE}/api${mine.playback.path}`, { headers: { Range: 'bytes=0-9' } })).status, 403);
    });

    it('a teacher sees their own students\' progress — and only theirs', async () => {
        const dash = (await H.api('GET', '/video/teacher/analytics?fresh=1', { token: S.hindiToken })).body.data;
        assert.equal(dash.assignedStudents, 4, '9-A and 9-B');
        assert.equal(dash.students.studentsWithContent, 4);
        assert.equal(dash.students.completed, 1);
        assert.equal(dash.students.inProgress, 1);
        assert.equal(dash.students.notStarted, 2);
        assert.equal(dash.content.releasedVideos, 2);
        assert.equal(dash.chapters.length, 1);
        assert.equal(dash.chapters[0].completed, 2, 'two (student, video) pairs done in Chapter 1');
        assert.equal(dash.books[0].title, book.title);
        // Filtered to one section.
        const a = (await H.api('GET', `/video/teacher/analytics?fresh=1&section=${S.sections['9B']._id}`, { token: S.hindiToken })).body.data;
        assert.equal(a.assignedStudents, 2);
        assert.equal(a.students.notStarted, 2);
        const list = await H.api('GET', '/video/teacher/analytics/students?limit=2&page=1', { token: S.hindiToken });
        assert.equal(list.body.total, 4);
        assert.equal(list.body.pages, 2);
        assert.equal(list.body.data.length, 2, 'paged — never the whole school at once');
        const done = await H.api('GET', '/video/teacher/analytics/students?status=completed', { token: S.hindiToken });
        assert.deepEqual(done.body.data.map((r) => r._id), [student('9A', 1)._id]);

        const report = (await H.api('GET', `/video/teacher/analytics/students/${student('9A', 0)._id}`, { token: S.hindiToken })).body.data;
        assert.equal(report.totals.videos, 2);
        assert.equal(report.totals.watched, 1);
        assert.equal(report.totals.notWatched, 1);
        assert.equal(report.totals.status, 'in_progress');
        assert.ok(report.sessions.length >= 3, 'the viewing history: each sitting');
        assert.ok(report.totals.watchSeconds > 100);

        // The Maths teacher teaches 9-A too — but not Hindi: no figures, no student report content.
        const maths = (await H.api('GET', '/video/teacher/analytics?fresh=1', { token: S.mathsToken })).body.data;
        assert.equal(maths.content.releasedVideos, 0);
        const mathsReport = (await H.api('GET', `/video/teacher/analytics/students/${student('9A', 0)._id}`, { token: S.mathsToken })).body.data;
        assert.equal(mathsReport.videos.length, 0);
        assert.equal(mathsReport.sessions.length, 0);
        // A student of a section the teacher does not teach at all, and of another school.
        assert.equal((await H.api('GET', `/video/teacher/analytics/students/${student('9C', 0)._id}`, { token: S.hindiToken })).status, 403);
        const X = await H.makeSchool('Trk-X');
        assert.equal((await H.api('GET', `/video/teacher/analytics/students/${student('9A', 0)._id}`, { token: X.hindiToken })).status, 403);
        assert.equal((await H.api('GET', '/video/teacher/analytics?fresh=1', { token: X.hindiToken })).body.data.content.releasedVideos, 0);
        assert.equal((await H.api('GET', '/video/teacher/analytics', { token: tok() })).status, 403);
    });

    it('reports export to Excel and PDF, within the teacher\'s own students', async () => {
        const xlsx = await H.api('GET', '/video/teacher/analytics/export?format=xlsx', { token: S.hindiToken });
        assert.equal(xlsx.status, 200);
        assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
        const rows = require('xlsx').utils.sheet_to_json(require('xlsx').read(xlsx.body).Sheets['Class progress'], { header: 1 });
        assert.equal(rows.length, 5, 'a heading and the four students');
        assert.ok(rows.slice(1).every((r) => ['A', 'B'].includes(r[3])));
        const pdf = await H.api('GET', '/video/teacher/analytics/export?format=pdf', { token: S.hindiToken });
        assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
        const one = await H.api('GET', `/video/teacher/analytics/students/${student('9A', 1)._id}/export?format=xlsx`, { token: S.hindiToken });
        assert.equal(one.body.subarray(0, 2).toString(), 'PK');
        assert.equal((await H.api('GET', `/video/teacher/analytics/students/${student('9C', 0)._id}/export?format=pdf`, { token: S.hindiToken })).status, 403);
        assert.equal((await H.api('GET', '/video/teacher/analytics/export?format=csv', { token: S.hindiToken })).status, 400);
        const mathsRows = require('xlsx').utils.sheet_to_json(require('xlsx').read((await H.api('GET', '/video/teacher/analytics/export?format=xlsx', { token: S.mathsToken })).body).Sheets['Class progress'], { header: 1 });
        assert.equal(mathsRows.length, 1, 'only the heading for a teacher with nothing released');
    });

    it('historical records stay intact when a release is taken down, and the school sees its figures', async () => {
        const before = await H.q(`SELECT "student", "furthestSec", "watchedSeconds", "status" FROM "lmsprogresses" WHERE "school" = $1 ORDER BY "student", "chapterVideo"`, [S.id]);
        const sessionsBefore = (await H.q(`SELECT count(*)::int AS n FROM "lmswatchsessions" WHERE "school" = $1`, [S.id]))[0].n;
        const live = (await H.api('GET', '/video/teacher/releases?tab=active', { token: S.hindiToken })).body.data;
        for (const r of live) await H.api('POST', `/video/teacher/releases/${r._id}/unpublish`, { token: S.hindiToken, body: {} });
        const after = await H.q(`SELECT "student", "furthestSec", "watchedSeconds", "status" FROM "lmsprogresses" WHERE "school" = $1 ORDER BY "student", "chapterVideo"`, [S.id]);
        assert.deepEqual(after, before, 'not a second of anyone\'s record changed');
        assert.equal((await H.q(`SELECT count(*)::int AS n FROM "lmswatchsessions" WHERE "school" = $1`, [S.id]))[0].n, sessionsBefore);
        assert.equal((await authorize(tok('9A', 1))).status, 403);
        const hist = (await H.api('GET', '/video/student/history', { token: tok('9A', 1) })).body.data;
        assert.equal(hist.length, 2, 'the student still sees what they watched');
        assert.ok(hist.every((h) => h.status === 'completed' && h.stillAvailable === false));
        // The foreign keys agree: watched content cannot be deleted from the library.
        assert.equal((await H.api('DELETE', `/video/central/chapters/${ch[0]._id}`, { token: SA.token })).status, 409);
        assert.equal((await H.api('DELETE', `/video/central/books/${book._id}`, { token: SA.token })).status, 409);
        const un = await H.api('DELETE', `/video/central/mappings/${cv.one}`, { token: SA.token });
        assert.equal(un.body.data.deactivated, true, 'a watched mapping is switched off, not removed');
        assert.equal((await progress(student('9A', 1))).status, 'completed');

        for (const r of live) await H.api('POST', `/video/teacher/releases/${r._id}/publish`, { token: S.hindiToken, body: {} });
        const school = (await H.api('GET', '/video/school/analytics?fresh=1', { token: S.adminToken })).body.data;
        assert.equal(school.setup.booksFollowed, 1);
        assert.equal(school.sections.length, 2);
        assert.equal(school.content.releasedVideos, 1, 'the switched-off mapping is no longer counted as released');
        const central = (await H.api('GET', '/video/central/overview?fresh=1', { token: SA.token })).body.data;
        assert.ok(central.totals.videosCompleted >= 2);
        assert.ok(central.topBooks.some((b) => b._id === book._id));
        assert.equal((await H.api('GET', '/video/school/analytics', { token: S.hindiToken })).status, 403);
    });
});
