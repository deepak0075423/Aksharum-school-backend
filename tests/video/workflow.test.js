'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/** The whole story once, start to finish, across the four roles — and the notices that go with it. */
describe('video learning — the complete workflow across roles', () => {
    let SA; let lib; let S; let other; let bookA; let bookB; let chA; let chB; let grammar;
    const inbox = (user, like = '%') => H.q(`
        SELECT n."title", n."link" FROM "notificationreceipts" r JOIN "notifications" n ON n."_id" = r."notification"
         WHERE r."recipient" = $1 AND n."title" LIKE $2 ORDER BY n."createdAt"`, [user._id, like]);
    const settle = () => new Promise((r) => setTimeout(r, 800));

    before(async () => {
        await H.startServer();
        SA = await H.makeSuperAdmin();
        S = await H.makeSchool('Flow');
        other = await H.makeSchool('Flow-Other');
    });
    after(() => H.finish());

    it('Super Admin: board → class → subject → two books → chapters → one video mapped to both', async () => {
        lib = await H.makeBoard(SA.token);
        const a = await H.makeBook(SA.token, lib, { title: 'Book A', publisher: 'Publisher A', chapters: 2 });
        const b = await H.makeBook(SA.token, lib, { title: 'Book B', publisher: 'Publisher B', chapters: 2 });
        bookA = a.book; bookB = b.book; chA = a.chapters; chB = b.chapters;
        grammar = await H.uploadedVideo(SA.token, { title: 'Introduction to Hindi Grammar', durationSec: 120 });
        const story = await H.linkedVideo(SA.token, { title: 'A story read aloud', durationSec: 90 });
        await H.mapTo(SA.token, chA[0], [grammar, story]);      // Book A, Chapter 1
        await H.mapTo(SA.token, chB[1], [grammar]);             // Book B, Chapter 2 — the same file
        const overview = (await H.api('GET', '/video/central/overview?fresh=1', { token: SA.token })).body.data;
        assert.ok(overview.totals.books >= 2 && overview.totals.videosReady >= 2);
        const meta = (await H.api('GET', '/video/central/meta', { token: SA.token })).body.data;
        assert.equal(meta.classLevels.length, 16, 'the platform\'s own class list — no second class master');
        assert.equal(meta.providers.filter((p) => p.isDefault).length, 1);
    });

    it('School Admin: follows the board, selects Hindi, gives Section A Book A and Section B Book B', async () => {
        await H.follow(S, lib, bookA, ['9A', '9C']);
        H.must(await H.api('PUT', '/video/school/books/assignment', { token: S.adminToken, body: { class: S.classes[9]._id, book: bookB._id, sections: [S.sections['9B']._id] } }), 200, 'Book B');
        const log = (await H.api('GET', '/video/school/audit', { token: S.adminToken })).body.data.map((r) => r.action);
        for (const a of ['school.board_set', 'school.subjects_set', 'school.book_assigned']) assert.ok(log.includes(a));
    });

    it('a book added to the library later is announced to the schools on its board — once, and only to them', async () => {
        const c = await H.makeBook(SA.token, lib, { title: 'Book C', publisher: 'Publisher C', chapters: 0 });
        await H.api('POST', `/video/central/books/${c.book._id}/status`, { token: SA.token, body: { status: 'inactive' } });
        await H.api('POST', `/video/central/books/${c.book._id}/status`, { token: SA.token, body: { status: 'active' } });
        await settle();
        const got = await inbox(S.admin, 'New book in the video library');
        assert.equal(got.length, 1, 'told once, though the book went live twice');
        assert.equal(got[0].link.type, 'video.setup');
        assert.equal((await inbox(other.admin, 'New book%')).length, 0, 'a school that does not follow the board is not told');
    });

    it('Teacher: releases Chapter 1 of Book A to 9-A now, and the book to 9-B for tomorrow', async () => {
        const now = await H.api('POST', '/video/teacher/releases', { token: S.hindiToken, body: { book: bookA._id, level: 'chapter', chapter: chA[0]._id, section: S.sections['9A']._id } });
        H.must(now, 201, 'chapter release');
        const later = await H.api('POST', '/video/teacher/releases', { token: S.hindiToken, body: { book: bookB._id, level: 'book', section: S.sections['9B']._id, releaseAt: new Date(Date.now() + 86400000).toISOString() } });
        H.must(later, 201, 'scheduled release');
        // The teacher's book page shows what is out, per section.
        const page = (await H.api('GET', `/video/teacher/books/${bookA._id}?section=${S.sections['9A']._id}`, { token: S.hindiToken })).body.data;
        assert.equal(page.chapters[0].release.shownStatus, 'active');
        assert.ok(page.chapters[0].videos.every((v) => v.releasedVia === 'chapter'));
        assert.equal(page.chapters[1].release, null);
        // Book B is not this teacher's in 9-A.
        assert.equal((await H.api('GET', `/video/teacher/books/${bookB._id}?section=${S.sections['9A']._id}`, { token: S.hindiToken })).status, 403);
        await settle();
        assert.equal((await inbox(S.students['9A'][0], 'New chapter released%')).length, 1);
        assert.equal((await inbox(S.students['9B'][0])).length, 0, 'nothing yet for the scheduled one');
    });

    let session; let cvGrammar;
    it('Student: sees only their book, the released chapter and its videos; watches; is tracked', async () => {
        const token = S.tokenOf(S.students['9A'][0]);
        const home = (await H.api('GET', '/video/student/home', { token })).body.data;
        assert.deepEqual(home.books.map((b) => b._id), [bookA._id]);
        assert.equal(home.subjects.length, 1);
        assert.deepEqual([home.totals.books, home.totals.releasedChapters, home.totals.videos, home.totals.notStarted], [1, 1, 2, 2]);
        const book = (await H.api('GET', `/video/student/books/${bookA._id}`, { token })).body.data;
        assert.deepEqual(book.chapters.map((c) => [c.chapterNumber, c.status, c.videoCount]), [[1, 'available', 2], [2, 'locked', 0]]);
        assert.equal((await H.api('GET', `/video/student/books/${bookB._id}`, { token })).status, 404, 'Section B\'s book does not exist for a Section A student');
        const chapter = (await H.api('GET', `/video/student/chapters/${chA[0]._id}`, { token })).body.data;
        assert.equal(chapter.videos.length, 2);
        cvGrammar = chapter.videos.find((v) => v.title.startsWith('Introduction')).chapterVideo;
        const youtube = chapter.videos.find((v) => v.title.startsWith('A story')).chapterVideo;

        const one = H.must(await H.api('GET', `/video/student/videos/${cvGrammar}`, { token }), 200, 'one video');
        assert.equal(one.chapter.bookTitle, bookA.title);
        assert.equal(one.status, 'not_started');
        assert.equal((await H.api('GET', `/video/student/videos/${cvGrammar}`, { token: S.tokenOf(S.students['9C'][0]) })).status, 403, 'not released to 9-C');
        const open = H.must(await H.api('POST', `/video/student/watch/${cvGrammar}/authorize`, { token, body: {} }), 200, 'authorize');
        session = open.sessionId;
        await H.watch(token, session, { from: 0, to: 60 });
        const linked = H.must(await H.api('POST', `/video/student/watch/${youtube}/authorize`, { token, body: {} }), 200, 'linked video');
        assert.equal(linked.playback.type, 'youtube');
        assert.ok(linked.playback.videoId && !linked.playback.path, 'a linked video plays in its provider\'s player');
        const after = (await H.api('GET', '/video/student/home', { token })).body.data.totals;
        assert.deepEqual([after.inProgress, after.notStarted], [1, 1]);

        // The same file in Book B is a different thing to watch — and not this student's.
        const detail = (await H.api('GET', `/video/central/videos/${grammar._id}`, { token: SA.token })).body.data;
        const inB = detail.mappings.find((m) => m.book === bookB._id)._id;
        assert.equal((await H.api('POST', `/video/student/watch/${inB}/authorize`, { token, body: {} })).status, 403);
    });

    it('a student who moves section loses the old section\'s content, gains the new one\'s, and keeps their record', async () => {
        const kid = S.students['9A'][0];
        const token = S.tokenOf(kid);
        await H.q(`UPDATE "classsections" SET "enrolledStudents" = "enrolledStudents" - $2 WHERE "_id" = $1`, [S.sections['9A']._id, String(kid._id)]);
        await H.q(`UPDATE "classsections" SET "enrolledStudents" = "enrolledStudents" || to_jsonb($2::text) WHERE "_id" = $1`, [S.sections['9B']._id, String(kid._id)]);
        assert.equal((await H.api('POST', `/video/student/watch/${cvGrammar}/authorize`, { token, body: {} })).status, 403, 'Section A\'s release no longer reaches them');
        const beat = await H.api('POST', `/video/student/sessions/${session}/heartbeat`, { token, body: { seq: 50, positionSec: 62, state: 'playing' } });
        assert.equal(beat.body.data.closed, true, 'the open session ended with the move');
        const home = (await H.api('GET', '/video/student/home', { token })).body.data;
        assert.deepEqual(home.books.map((b) => b._id), [bookB._id]);
        const hist = (await H.api('GET', '/video/student/history', { token })).body.data;
        assert.equal(hist.length, 1);
        assert.equal(hist[0].watchedSeconds, 60, 'what they watched in Section A is still theirs');
        // Back again for the rest of the story.
        await H.q(`UPDATE "classsections" SET "enrolledStudents" = "enrolledStudents" - $2 WHERE "_id" = $1`, [S.sections['9B']._id, String(kid._id)]);
        await H.q(`UPDATE "classsections" SET "enrolledStudents" = "enrolledStudents" || to_jsonb($2::text) WHERE "_id" = $1`, [S.sections['9A']._id, String(kid._id)]);
        const back = H.must(await H.api('POST', `/video/student/watch/${cvGrammar}/authorize`, { token, body: {} }), 200, 'back');
        assert.equal(back.progress.resumePositionSec, 60);
    });

    it('students who have not started are reminded after the school\'s number of days — once', async () => {
        H.must(await H.api('PUT', '/video/school/settings', { token: S.adminToken, body: { reminderAfterDays: 2 } }), 200, 'settings');
        assert.equal((await H.sweep().hour()).reminded, 0, 'released today: too soon');
        await H.q(`UPDATE "lmsreleases" SET "releaseAt" = now() - interval '3 days' WHERE "school" = $1 AND "status" = 'active'`, [S.id]);
        const first = await H.sweep().hour();
        assert.equal(first.reminded, 1, 'the one student of 9-A who has not started');
        assert.equal((await H.sweep().hour()).reminded, 0, 'never twice for the same release');
        await settle();
        assert.equal((await inbox(S.students['9A'][1], 'You have videos waiting')).length, 1);
        assert.equal((await inbox(S.students['9A'][0], 'You have videos waiting')).length, 0, 'the one who started is left alone');
    });

    it('Teacher: the dashboard and the student report reflect what happened', async () => {
        const dash = (await H.api('GET', '/video/teacher/analytics?fresh=1', { token: S.hindiToken })).body.data;
        assert.deepEqual([dash.assignedStudents, dash.students.started, dash.students.notStarted, dash.content.releasedVideos], [4, 1, 1, 2]);
        assert.deepEqual(dash.options.sections.map((s) => s.name).sort(), ['Class 9 A', 'Class 9 B']);
        const byBook = (await H.api('GET', `/video/teacher/analytics?fresh=1&book=${bookB._id}`, { token: S.hindiToken })).body.data;
        assert.equal(byBook.content.releasedVideos, 0, 'Book B is only scheduled');
        const report = (await H.api('GET', `/video/teacher/analytics/students/${S.students['9A'][0]._id}`, { token: S.hindiToken })).body.data;
        assert.equal(report.totals.assignedBooks, 1);
        assert.equal(report.totals.watchSeconds, 60);
        assert.equal(report.videos.find((v) => v.status === 'in_progress').watchedPercent, 50);
    });

    it('the retired routes of the old video module answer 410 with a plain message, to every role', async () => {
        for (const [method, url, token] of [['GET', '/video/admin/videos', SA.token], ['GET', '/video/student/dashboard', S.tokenOf(S.students['9A'][0])],
            ['POST', '/video/student/progress', S.tokenOf(S.students['9A'][0])], ['GET', '/video/teacher/catalog', S.hindiToken], ['GET', '/video/school/browse', S.adminToken]]) {
            const r = await H.api(method, url, { token, body: method === 'POST' ? {} : undefined });
            assert.equal(r.status, 410, url);
            assert.equal(r.body.code, 'VIDEO_MODULE_UPDATED');
        }
    });

    it('nothing a browser is ever sent names a storage key, a bucket path or a credential', async () => {
        const student = S.tokenOf(S.students['9A'][0]);
        const answers = [
            await H.api('GET', '/video/student/home', { token: student }), await H.api('GET', `/video/student/chapters/${chA[0]._id}`, { token: student }),
            await H.api('POST', `/video/student/watch/${cvGrammar}/authorize`, { token: student, body: {} }),
            await H.api('GET', `/video/teacher/books/${bookA._id}`, { token: S.hindiToken }), await H.api('GET', '/video/teacher/releases', { token: S.hindiToken }),
            await H.api('GET', '/video/school/setup', { token: S.adminToken }),
            await H.api('GET', '/video/central/videos', { token: SA.token }), await H.api('GET', `/video/central/videos/${grammar._id}`, { token: SA.token }),
            await H.api('GET', '/video/central/providers', { token: SA.token }),
        ];
        for (const r of answers) {
            assert.equal(r.status, 200);
            assert.ok(!/storageKey|playbackKey|"secrets"|source-\d+\.mp4|lms-videos/.test(JSON.stringify(r.body)), 'no storage detail in an API answer');
        }
    });
});
