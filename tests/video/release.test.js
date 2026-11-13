'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/** A teacher releases a book, a chapter or one video — to the sections where they teach its subject, and nowhere else. */
describe('video learning — teacher releases', () => {
    let SA; let lib; let S; let B; let book; let ch; let v1; let v2; let v3; let cv;
    const T = () => S.hindiToken;
    const kid = (key, i = 0) => S.tokenOf(S.students[key][i]);
    const release = (token, body) => H.api('POST', '/video/teacher/releases', { token, body });
    const bookOf = async (token, id = book._id) => (await H.api('GET', `/video/student/books/${id}`, { token }));
    const authorize = (token, id) => H.api('POST', `/video/student/watch/${id}/authorize`, { token, body: {} });

    before(async () => {
        await H.startServer();
        SA = await H.makeSuperAdmin();
        lib = await H.makeBoard(SA.token);
        const made = await H.makeBook(SA.token, lib, { title: 'Book A', publisher: 'Publisher A', chapters: 3 });
        book = made.book; ch = made.chapters;
        v1 = await H.uploadedVideo(SA.token, { title: 'One', durationSec: 100 });
        v2 = await H.uploadedVideo(SA.token, { title: 'Two', durationSec: 100 });
        v3 = await H.uploadedVideo(SA.token, { title: 'Three', durationSec: 100 });
        await H.mapTo(SA.token, ch[0], [v1, v2]);
        await H.mapTo(SA.token, ch[1], [v3]);
        S = await H.makeSchool('Rel');
        B = await H.makeSchool('Rel-B');
        await H.follow(S, lib, book, 'all');
        const detail = (await H.api('GET', `/video/central/books/${book._id}`, { token: SA.token })).body.data;
        cv = { one: detail.chapters[0].videos[0]._id, two: detail.chapters[0].videos[1]._id, three: detail.chapters[1].videos[0]._id };
    });
    after(() => H.finish());

    it('a teacher sees only the books of the sections and subjects they teach — never the library', async () => {
        const ws = (await H.api('GET', '/video/teacher/workspace', { token: T() })).body.data;
        assert.equal(ws.books.length, 1);
        assert.deepEqual(ws.books[0].sections.map((s) => s.sectionName).sort(), ['A', 'B'], 'Hindi in 9-A and 9-B, not 9-C');
        const maths = (await H.api('GET', '/video/teacher/workspace', { token: S.mathsToken })).body.data;
        assert.equal(maths.books.length, 0, 'the Maths teacher has no Hindi book');
        assert.equal((await H.api('GET', `/video/teacher/books/${book._id}`, { token: S.mathsToken })).status, 403);
        assert.equal((await H.api('GET', '/video/central/videos', { token: T() })).status, 403);
        assert.equal((await H.api('GET', `/video/central/books/${book._id}`, { token: T() })).status, 403);
        const mine = (await H.api('GET', `/video/teacher/books/${book._id}`, { token: T() })).body.data;
        assert.equal(mine.chapters.length, 3);
        assert.equal(mine.chapters[0].videos.length, 2);
        assert.equal(JSON.stringify(mine).includes('storageKey'), false);
    });

    it('before anything is released a student sees the book with every chapter locked, and cannot play', async () => {
        const b = (await bookOf(kid('9A'))).body.data;
        assert.equal(b.chapters.length, 3);
        assert.ok(b.chapters.every((c) => c.status === 'locked' && c.videoCount === 0));
        assert.equal((await H.api('GET', `/video/student/chapters/${ch[0]._id}`, { token: kid('9A') })).status, 403);
        const play = await authorize(kid('9A'), cv.one);
        assert.equal(play.status, 403);
        assert.equal(play.body.code, 'NOT_RELEASED');
    });

    let videoRelease;
    it('releasing ONE video opens that video only — not the rest of its chapter', async () => {
        const r = await release(T(), { book: book._id, level: 'video', chapterVideo: cv.one, section: S.sections['9A']._id });
        videoRelease = H.must(r, 201, 'video release').releases[0];
        const chapter = (await H.api('GET', `/video/student/chapters/${ch[0]._id}`, { token: kid('9A') })).body.data;
        assert.deepEqual(chapter.videos.map((v) => v.chapterVideo), [cv.one], 'only the released video is listed');
        assert.equal((await authorize(kid('9A'), cv.one)).status, 200);
        assert.equal((await authorize(kid('9A'), cv.two)).status, 403, 'the other video of the same chapter stays closed');
        assert.equal((await authorize(kid('9A'), cv.three)).status, 403);
        // Section B was not released to.
        assert.equal((await authorize(kid('9B'), cv.one)).status, 403);
        const b = (await bookOf(kid('9A'))).body.data;
        assert.deepEqual(b.chapters.map((c) => c.status), ['available', 'locked', 'locked']);
        assert.equal(b.chapters[0].videoCount, 1);
        // The same release twice is refused.
        assert.equal((await release(T(), { book: book._id, level: 'video', chapterVideo: cv.one, section: S.sections['9A']._id })).status, 409);
    });

    it('releasing a chapter opens every video in it', async () => {
        H.must(await release(T(), { book: book._id, level: 'chapter', chapter: ch[0]._id, section: S.sections['9B']._id }), 201, 'chapter release');
        const chapter = (await H.api('GET', `/video/student/chapters/${ch[0]._id}`, { token: kid('9B') })).body.data;
        assert.deepEqual(chapter.videos.map((v) => v.chapterVideo).sort(), [cv.one, cv.two].sort());
        assert.equal((await authorize(kid('9B'), cv.two)).status, 200);
        assert.equal((await authorize(kid('9B'), cv.three)).status, 403, 'another chapter stays closed');
        assert.equal((await H.api('GET', `/video/student/chapters/${ch[1]._id}`, { token: kid('9B') })).status, 403);
    });

    it('releasing the whole book opens every chapter and video — including one mapped later', async () => {
        const ids = H.must(await release(T(), { book: book._id, level: 'book', sections: [S.sections['9A']._id] }), 201, 'book release').releases;
        assert.equal(ids.length, 1);
        const b = (await bookOf(kid('9A'))).body.data;
        assert.deepEqual(b.chapters.map((c) => c.status), ['available', 'available', 'locked'], 'a chapter with no videos has nothing to open');
        assert.equal(b.totals.videos, 3);
        assert.equal((await authorize(kid('9A'), cv.three)).status, 200);
        // The Super Admin adds the missing video to Chapter 3 later: it is covered at once.
        const late = await H.uploadedVideo(SA.token, { title: 'Late', durationSec: 60 });
        await H.mapTo(SA.token, ch[2], [late]);
        const after = (await bookOf(kid('9A'))).body.data;
        assert.equal(after.chapters[2].status, 'available');
        assert.equal(after.totals.videos, 4);
    });

    it('a teacher cannot release outside their sections, subjects or school — whatever ids they send', async () => {
        // 9-C: Hindi is not theirs there.
        const c = await release(T(), { book: book._id, level: 'book', section: S.sections['9C']._id });
        assert.equal(c.status, 403);
        assert.equal(c.body.code, 'OUT_OF_SCOPE');
        // The Maths teacher of 9-A, with the Hindi book.
        assert.equal((await release(S.mathsToken, { book: book._id, level: 'book', section: S.sections['9A']._id })).status, 403);
        // Another school's teacher, with this school's section and book.
        assert.equal((await release(B.hindiToken, { book: book._id, level: 'book', section: S.sections['9A']._id })).status, 403);
        // A chapter or video of a different book.
        const other = await H.makeBook(SA.token, lib, { title: 'Book B', publisher: 'Publisher B', chapters: 1 });
        assert.equal((await release(T(), { book: book._id, level: 'chapter', chapter: other.chapters[0]._id, section: S.sections['9B']._id })).status, 404);
        // Students of another section named as the audience.
        const wrongKids = await release(T(), { book: book._id, level: 'chapter', chapter: ch[1]._id, section: S.sections['9B']._id, audience: 'selected', students: [S.students['9C'][0]._id] });
        assert.equal(wrongKids.status, 400);
        assert.equal(wrongKids.body.code, 'NOT_IN_SECTION');
        // Students cannot release at all; nor can the school admin through the teacher's door.
        assert.equal((await release(kid('9A'), { book: book._id, level: 'book', section: S.sections['9A']._id })).status, 403);
        assert.equal((await release(S.adminToken, { book: book._id, level: 'book', section: S.sections['9A']._id })).status, 403);
        const [{ n }] = await H.q(`SELECT count(*)::int AS n FROM "lmsreleases" WHERE "section" = $1`, [S.sections['9C']._id]);
        assert.equal(n, 0, 'nothing was created');
        // Another school's students see none of it.
        assert.equal((await authorize(B.tokenOf(B.students['9A'][0]), cv.one)).status, 403);
        assert.deepEqual((await H.api('GET', '/video/student/home', { token: B.tokenOf(B.students['9A'][0]) })).body.data.books, []);
    });

    it('a release to selected students reaches them alone', async () => {
        const chosen = S.students['9B'][0];
        H.must(await release(T(), { book: book._id, level: 'chapter', chapter: ch[1]._id, section: S.sections['9B']._id, audience: 'selected', students: [chosen._id] }), 201, 'selected');
        assert.equal((await authorize(S.tokenOf(chosen), cv.three)).status, 200);
        assert.equal((await authorize(kid('9B', 1), cv.three)).status, 403);
        const roster = await H.api('GET', `/video/teacher/sections/${S.sections['9B']._id}/students`, { token: T() });
        assert.equal(roster.body.data.length, 2);
        assert.equal((await H.api('GET', `/video/teacher/sections/${S.sections['9C']._id}/students`, { token: T() })).status, 400);
    });

    let scheduled;
    it('a scheduled release is closed until its time, can be edited, then opens and tells the students once', async () => {
        const kidC = S.students['10A'][0];      // unrelated; proves nothing leaks
        const when = new Date(Date.now() + 3600 * 1000);
        // Section B has the chapter-1 release; schedule the whole book for it.
        const r = await release(T(), { book: book._id, level: 'book', section: S.sections['9B']._id, releaseAt: when.toISOString() });
        scheduled = H.must(r, 201, 'scheduled').releases[0];
        const row = (await H.api('GET', `/video/teacher/releases/${scheduled}`, { token: T() })).body.data;
        assert.equal(row.shownStatus, 'scheduled');
        assert.equal((await authorize(kid('9B', 1), cv.three)).status, 403, 'not yet');
        const bad = await H.api('PUT', `/video/teacher/releases/${scheduled}`, { token: T(), body: { expiresAt: new Date(Date.now() + 600 * 1000).toISOString() } });
        assert.equal(bad.status, 400, 'an expiry before the release date');
        const edited = await H.api('PUT', `/video/teacher/releases/${scheduled}`, { token: T(), body: { releaseAt: new Date(Date.now() + 1800 * 1000).toISOString(), note: 'Before the unit test' } });
        assert.equal(edited.status, 200);
        assert.equal(edited.body.data.note, 'Before the unit test');
        assert.equal((await H.api('PUT', `/video/teacher/releases/${scheduled}`, { token: S.mathsToken, body: { note: 'x' } })).status, 404, 'another teacher cannot edit it');

        const tabs = (await H.api('GET', '/video/teacher/releases?tab=scheduled', { token: T() })).body;
        assert.equal(tabs.counts.scheduled, 1);
        assert.equal(tabs.data[0]._id, scheduled);

        // Its time comes.
        await H.q(`UPDATE "lmsreleases" SET "releaseAt" = now() - interval '1 minute' WHERE "_id" = $1`, [scheduled]);
        assert.equal((await authorize(kid('9B', 1), cv.three)).status, 200, 'open on time, sweep or no sweep');
        const first = await H.sweep().minute();
        assert.equal(first.opened, 1);
        const second = await H.sweep().minute();
        assert.equal(second.opened, 0);
        await new Promise((res) => setTimeout(res, 700));
        const told = await H.q(`
            SELECT count(*)::int AS n FROM "notificationreceipts" r JOIN "notifications" n ON n."_id" = r."notification"
             WHERE r."recipient" = $1 AND n."title" LIKE 'Book now available%'`, [S.students['9B'][1]._id]);
        assert.equal(told[0].n, 1, 'told once');
        const other = await H.q(`SELECT count(*)::int AS n FROM "notificationreceipts" WHERE "recipient" = $1`, [kidC._id]);
        assert.equal(other[0].n, 0, 'and nobody outside the section');
    });

    it('students are told when a teacher releases something to them — with a link to it', async () => {
        const got = await H.q(`
            SELECT n."title", n."link" FROM "notificationreceipts" r JOIN "notifications" n ON n."_id" = r."notification"
             WHERE r."recipient" = $1 ORDER BY n."createdAt"`, [S.students['9A'][0]._id]);
        assert.deepEqual(got.map((g) => g.link.type), ['video.watch', 'video.book']);
        assert.equal(got[0].link.entityId, cv.one);
        assert.match(got[0].title, /New video released/);
        const hindiTeacherInbox = await H.q(`SELECT count(*)::int AS n FROM "notificationreceipts" WHERE "recipient" = $1`, [S.hindiTeacher._id]);
        assert.equal(hindiTeacherInbox[0].n, 0, 'the teacher is not notified of their own release');
    });

    it('revoking access blocks playback at once — an open session included — and keeps what was watched', async () => {
        const student = S.students['9A'][0];
        const token = S.tokenOf(student);
        const open = (await authorize(token, cv.one)).body.data;
        const w = await H.watch(token, open.sessionId, { from: 0, to: 45 });
        assert.equal(w.last.furthestSec, 45);
        const stream = await fetch(`${H.BASE}/api${open.playback.path}`, { headers: { Range: 'bytes=0-99' } });
        assert.equal(stream.status, 206);

        // 9-A holds the video release and the book release; take both away.
        const live = (await H.api('GET', `/video/teacher/releases?tab=active&section=${S.sections['9A']._id}`, { token: T() })).body.data;
        assert.equal(live.length, 2);
        for (const r of live) {
            const out = await H.api('POST', `/video/teacher/releases/${r._id}/revoke`, { token: T(), body: { reason: 'Released by mistake' } });
            assert.equal(out.body.data.status, 'revoked');
        }
        assert.equal((await authorize(token, cv.one)).status, 403, 'no new playback');
        const beat = await H.api('POST', `/video/student/sessions/${open.sessionId}/heartbeat`, { token, body: { seq: 99, positionSec: 60, state: 'playing' } });
        assert.equal(beat.body.data.accepted, false);
        assert.equal(beat.body.data.closed, true);
        const dead = await fetch(`${H.BASE}/api${open.playback.path}`, { headers: { Range: 'bytes=0-99' } });
        assert.equal(dead.status, 403, 'the signed address died with the session');
        assert.equal((await H.api('POST', `/video/student/sessions/${open.sessionId}/renew`, { token, body: {} })).status, 403);

        const [p] = await H.q(`SELECT "furthestSec", "watchedSeconds", "status" FROM "lmsprogresses" WHERE "student" = $1 AND "chapterVideo" = $2`, [student._id, cv.one]);
        assert.equal(p.furthestSec, 45, 'the watch record is untouched');
        assert.equal(p.watchedSeconds, 45);
        const hist = (await H.api('GET', '/video/student/history', { token })).body.data;
        assert.equal(hist.length, 1);
        assert.equal(hist[0].stillAvailable, false);
        assert.equal((await bookOf(token)).body.data.chapters.every((c) => c.status === 'locked'), true);
        assert.equal((await H.api('POST', `/video/teacher/releases/${live[0]._id}/revoke`, { token: T(), body: {} })).status, 409, 'already revoked');
    });

    it('unpublish and publish again; re-release of an ended release; the audit trail of each', async () => {
        const chapterRelease = (await H.api('GET', `/video/teacher/releases?tab=active&section=${S.sections['9B']._id}&level=chapter`, { token: T() })).body.data.find((r) => r.audience === 'all');
        const down = await H.api('POST', `/video/teacher/releases/${chapterRelease._id}/unpublish`, { token: T(), body: {} });
        assert.equal(down.body.data.status, 'unpublished');
        // 9-B still has the whole-book release, so access continues through that one.
        assert.equal((await authorize(kid('9B', 1), cv.one)).status, 200);
        await H.api('POST', `/video/teacher/releases/${scheduled}/unpublish`, { token: T(), body: {} });
        assert.equal((await authorize(kid('9B', 1), cv.one)).status, 403);
        const up = await H.api('POST', `/video/teacher/releases/${chapterRelease._id}/publish`, { token: T(), body: {} });
        assert.equal(up.body.data.status, 'active');
        assert.equal((await authorize(kid('9B', 1), cv.one)).status, 200);
        assert.equal((await H.api('PUT', `/video/teacher/releases/${scheduled}`, { token: T(), body: { note: 'x' } })).status, 409, 'an unpublished release is not edited');

        // Re-release what was revoked in 9-A, with an expiry.
        const history = (await H.api('GET', `/video/teacher/releases?tab=history&section=${S.sections['9A']._id}`, { token: T() })).body;
        assert.equal(history.counts.history >= 2, true);
        const old = history.data.find((r) => r.level === 'book');
        const again = await H.api('POST', `/video/teacher/releases/${old._id}/rerelease`, { token: T(), body: { expiresAt: new Date(Date.now() + 86400000).toISOString() } });
        assert.equal(again.status, 201);
        assert.equal(again.body.data.reReleaseOf, old._id);
        assert.equal((await authorize(kid('9A'), cv.one)).status, 200);
        const resumed = (await authorize(kid('9A'), cv.one)).body.data;
        assert.equal(resumed.progress.furthestSec, 45, 'and the student carries on from where they were');

        // Expiry: past it, access ends and the sweep marks it.
        await H.q(`UPDATE "lmsreleases" SET "expiresAt" = now() - interval '1 minute' WHERE "_id" = $1`, [again.body.data._id]);
        assert.equal((await authorize(kid('9A'), cv.one)).status, 403);
        assert.equal((await H.sweep().minute()).expired, 1);
        assert.equal((await H.api('GET', `/video/teacher/releases/${again.body.data._id}`, { token: T() })).body.data.status, 'expired');

        const trail = (await H.api('GET', `/video/teacher/releases/${chapterRelease._id}`, { token: T() })).body.data.history.map((h) => h.action);
        assert.deepEqual(trail, ['release.published', 'release.unpublished', 'release.published']);
        const revoked = (await H.api('GET', `/video/teacher/releases/${old._id}`, { token: T() })).body.data;
        assert.equal(revoked.revokeReason, 'Released by mistake');
        assert.ok(revoked.history.some((h) => h.action === 'release.revoked'));
    });

    it('ending the book\'s assignment closes its releases to students; a teacher taken off the section loses the controls', async () => {
        assert.equal((await authorize(kid('9B', 1), cv.one)).status, 200);
        // The school stops following the book in 9-B (keeps it for A and C).
        H.must(await H.api('PUT', '/video/school/books/assignment', { token: S.adminToken, body: { class: S.classes[9]._id, book: book._id, sections: [S.sections['9A']._id, S.sections['9C']._id] } }), 200, 'narrow');
        assert.equal((await authorize(kid('9B', 1), cv.one)).status, 403, 'a section that no longer follows the book cannot watch it');
        assert.deepEqual((await H.api('GET', '/video/student/home', { token: kid('9B', 1) })).body.data.books, []);
        const ws = (await H.api('GET', '/video/teacher/workspace', { token: T() })).body.data;
        assert.deepEqual(ws.books[0].sections.map((s) => s.sectionName), ['A']);

        // The Hindi teacher is replaced in 9-A.
        await H.q(`DELETE FROM "sectionsubjectteachers" WHERE "section" = $1 AND "teacher" = $2`, [S.sections['9A']._id, S.hindiTeacher._id]);
        assert.equal((await release(T(), { book: book._id, level: 'chapter', chapter: ch[0]._id, section: S.sections['9A']._id })).status, 403);
        const theirs = (await H.api('GET', '/video/teacher/releases?tab=history', { token: T() })).body.data;
        assert.ok(theirs.length > 0, 'their past releases stay visible to them');
        const old = theirs.find((r) => String(r.section) === String(S.sections['9A']._id));
        const out = await H.api('POST', `/video/teacher/releases/${old._id}/rerelease`, { token: T(), body: {} });
        assert.equal(out.status, 403);
        assert.equal(out.body.code, 'OUT_OF_SCOPE');
    });
});
