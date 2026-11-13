'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

/** The Super Admin's central library: Board → Class → Subject → Book → Chapter → Videos. */
describe('video learning — the central library', () => {
    let SA; let lib; let S;
    before(async () => {
        await H.startServer();
        SA = await H.makeSuperAdmin();
        S = await H.makeSchool('Lib');
    });
    after(() => H.finish());

    it('only a Super Admin reaches the library — not a school admin, a teacher or a student', async () => {
        for (const token of [S.adminToken, S.hindiToken, S.tokenOf(S.students['9A'][0])]) {
            assert.equal((await H.api('GET', '/video/central/books', { token })).status, 403);
            assert.equal((await H.api('POST', '/video/central/boards', { token, body: { name: 'Sneaky', code: 'ZZTSNEAK', classLevels: [9] } })).status, 403);
            assert.equal((await H.api('GET', '/video/central/providers', { token })).status, 403);
        }
        assert.equal((await H.api('GET', '/video/central/books')).status, 401);
    });

    it('a Super Admin creates a board with its classes; a second board with the same code is refused', async () => {
        lib = await H.makeBoard(SA.token, { levels: [9, 10] });
        assert.deepEqual(lib.board.classLevels, [9, 10]);
        assert.equal(lib.board.isActive, true);
        const again = await H.api('POST', '/video/central/boards', { token: SA.token, body: { name: 'Copy', code: lib.board.code, classLevels: [9] } });
        assert.equal(again.status, 409);
        const bad = await H.api('POST', '/video/central/boards', { token: SA.token, body: { name: 'Bad', code: 'ZZTBAD1', classLevels: [99] } });
        assert.equal(bad.status, 400, 'a class that is not one of the platform\'s classes');
        const off = await H.api('POST', `/video/central/boards/${lib.board._id}/active`, { token: SA.token, body: { active: false } });
        assert.equal(off.body.data.isActive, false);
        await H.api('POST', `/video/central/boards/${lib.board._id}/active`, { token: SA.token, body: { active: true } });
        const list = await H.api('GET', `/video/central/boards?search=${lib.board.code}`, { token: SA.token });
        assert.equal(list.body.data.length, 1);
        assert.equal(list.body.data[0].subjectCount, 1);
    });

    it('a Super Admin creates a subject and maps it to boards and classes — one subject, reused', async () => {
        const second = await H.makeBoard(SA.token, { levels: [9] });
        const mapped = await H.api('PUT', `/video/central/subjects/${lib.subject._id}/mappings`, {
            token: SA.token, body: { mappings: [{ board: lib.board._id, classLevels: [9, 10] }, { board: second.board._id, classLevels: [9] }] },
        });
        assert.equal(mapped.status, 200);
        assert.equal(mapped.body.data.mappings.length, 2, 'the same subject serves two boards');
        const dup = await H.api('POST', '/video/central/subjects', { token: SA.token, body: { name: 'Hindi again', code: lib.subject.code } });
        assert.equal(dup.status, 409);
        const wrongClass = await H.api('PUT', `/video/central/subjects/${lib.subject._id}/mappings`, { token: SA.token, body: { mappings: [{ board: second.board._id, classLevels: [10] }] } });
        assert.equal(wrongClass.status, 400, 'the board does not have that class');
        const detail = await H.api('GET', `/video/central/boards/${lib.board._id}`, { token: SA.token });
        assert.equal(detail.body.data.classes.find((c) => c.classLevel === 9).subjects.length, 1);
    });

    let bookA; let bookB; let chapters;
    it('a Super Admin creates several books for one subject; an exact duplicate is refused', async () => {
        const a = await H.makeBook(SA.token, lib, { title: 'Book A', publisher: 'Publisher A' });
        const b = await H.makeBook(SA.token, lib, { title: 'Book B', publisher: 'Publisher B' });
        const c = await H.makeBook(SA.token, lib, { title: 'Book C', publisher: 'Publisher C', chapters: 0 });
        bookA = a.book; bookB = b.book; chapters = a.chapters;
        const list = await H.api('GET', `/video/central/books?board=${lib.board._id}&classLevel=9&subject=${lib.subject._id}`, { token: SA.token });
        assert.equal(list.body.total, 3);
        assert.equal(list.body.pages, 1);
        const dup = await H.api('POST', '/video/central/books', { token: SA.token, body: { title: bookA.title, board: lib.board._id, classLevel: 9, subject: lib.subject._id, publisher: 'Publisher A', edition: '1st' } });
        assert.equal(dup.status, 409);
        const unmapped = await H.api('POST', '/video/central/books', { token: SA.token, body: { title: 'Stray', board: lib.board._id, classLevel: 9, subject: S.subjects.hindi._id } });
        assert.ok([400, 404].includes(unmapped.status), 'a school\'s own subject is not a library subject');
        const badIsbn = await H.api('PUT', `/video/central/books/${c.book._id}`, { token: SA.token, body: { isbn: '12345' } });
        assert.equal(badIsbn.status, 400);
    });

    it('a Super Admin creates chapters, reorders them, and a chapter may have no videos', async () => {
        const dupNumber = await H.api('POST', `/video/central/books/${bookA._id}/chapters`, { token: SA.token, body: { title: 'Another first', chapterNumber: 1 } });
        assert.equal(dupNumber.status, 409);
        const third = H.must(await H.api('POST', `/video/central/books/${bookA._id}/chapters`, { token: SA.token, body: { title: 'Chapter 3', chapterNumber: 3, estimatedMinutes: 40 } }), 201, 'chapter 3');
        const order = [third._id, chapters[0]._id, chapters[1]._id];
        assert.equal((await H.api('PUT', `/video/central/books/${bookA._id}/chapters/order`, { token: SA.token, body: { order } })).status, 200);
        const book = (await H.api('GET', `/video/central/books/${bookA._id}`, { token: SA.token })).body.data;
        assert.deepEqual(book.chapters.map((c) => c._id), order);
        assert.ok(book.chapters.every((c) => c.videos.length === 0), 'chapters exist before any video is mapped');
        const partial = await H.api('PUT', `/video/central/books/${bookA._id}/chapters/order`, { token: SA.token, body: { order: order.slice(0, 2) } });
        assert.equal(partial.status, 400);
        await H.api('PUT', `/video/central/books/${bookA._id}/chapters/order`, { token: SA.token, body: { order: [chapters[0]._id, chapters[1]._id, third._id] } });
    });

    let video;
    it('a Super Admin uploads a video in parts; it is checked, processed in the background and only then ready', async () => {
        const created = H.must(await H.api('POST', '/video/central/videos', { token: SA.token, body: { title: 'Introduction to Hindi Grammar', tags: ['grammar', 'basics'] } }), 201, 'video');
        H.made.videos.push(created._id);
        assert.equal(created.processingStatus, 'draft');
        assert.equal(created.storageKey, undefined, 'storage keys never leave the server');

        // Not a video, too big, wrong type: refused before a byte is stored.
        const bad = (body) => H.api('POST', `/video/central/videos/${created._id}/uploads`, { token: SA.token, body });
        assert.equal((await bad({ filename: 'virus.exe', mimeType: 'video/mp4', sizeBytes: 1000 })).status, 400);
        assert.equal((await bad({ filename: 'a.mp4', mimeType: 'text/html', sizeBytes: 1000 })).status, 400);
        assert.equal((await bad({ filename: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 9e12 })).status, 400);
        assert.equal((await bad({ filename: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 0 })).status, 400);

        // A draft cannot be mapped.
        const early = await H.api('POST', `/video/central/chapters/${chapters[0]._id}/videos`, { token: SA.token, body: { videos: [created._id] } });
        assert.equal(early.status, 400);
        assert.equal(early.body.code, 'VIDEO_NOT_READY');

        const file = H.mp4(600, 11 * 1024 * 1024);          // three parts
        const up = H.must(await bad({ filename: 'grammar.mp4', mimeType: 'video/mp4', sizeBytes: file.length }), 201, 'upload');
        assert.equal(up.mode, 'chunked');
        assert.equal(up.totalChunks, 3);
        const part = (i) => file.subarray(i * up.chunkSize, (i + 1) * up.chunkSize);
        const url = (i) => `/video/central/uploads/${up.uploadId}/chunks/${i}`;

        assert.equal((await H.putBytes(url(0), S.adminToken, part(0))).status, 403, 'only the Super Admin uploads');
        assert.equal((await H.putBytes(url(0), SA.token, part(0))).status, 200);
        assert.equal((await H.putBytes(url(2), SA.token, part(2))).status, 200);
        assert.equal((await H.putBytes(url(1), SA.token, part(1).subarray(0, 100))).status, 400, 'a short part is refused');

        // Completing with a part missing fails clearly, and the upload can carry on.
        const early2 = await H.api('POST', `/video/central/uploads/${up.uploadId}/complete`, { token: SA.token, body: {} });
        assert.equal(early2.status, 409);
        assert.deepEqual(early2.body.missing, [1]);
        const st = (await H.api('GET', `/video/central/uploads/${up.uploadId}`, { token: SA.token })).body.data;
        assert.deepEqual(st.receivedChunks, [0, 2], 'a resumed upload knows which parts arrived');

        assert.equal((await H.putBytes(url(1), SA.token, part(1))).status, 200);
        assert.equal((await H.putBytes(url(1), SA.token, part(1))).status, 200, 'sending a part twice is harmless');
        const done = H.must(await H.api('POST', `/video/central/uploads/${up.uploadId}/complete`, { token: SA.token, body: {} }), 200, 'complete');
        assert.equal(done.processingStatus, 'queued');

        await H.runJobs();
        video = (await H.api('GET', `/video/central/videos/${created._id}`, { token: SA.token })).body.data;
        assert.equal(video.processingStatus, 'ready');
        assert.equal(video.durationSec, 600, 'the length was read from the file');
        assert.equal(video.sizeBytes, file.length);

        // The file is on disk, private: the static server refuses the folder.
        const [row] = await H.q('SELECT "storageKey" FROM "lmsvideos" WHERE "_id" = $1', [video._id]);
        assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'uploads', 'lms-videos', row.storageKey)));
        const direct = await fetch(`${H.BASE}/uploads/lms-videos/${row.storageKey}`);
        assert.equal(direct.status, 403, 'the stored file has no public address');
    });

    it('a file that is not a video fails processing and can never be mapped', async () => {
        const fake = Buffer.concat([Buffer.from('<html><body>not a video</body></html>'), Buffer.alloc(2000, 32)]);
        const v = await H.uploadedVideo(SA.token, { title: 'Fake', file: fake });
        assert.equal(v.processingStatus, 'failed');
        assert.match(v.processingError, /not an MP4/);
        const map = await H.api('POST', `/video/central/chapters/${chapters[0]._id}/videos`, { token: SA.token, body: { videos: [v._id] } });
        assert.equal(map.status, 400);
    });

    it('one video is mapped to several chapters of several books — one file, no copies', async () => {
        const other = (await H.api('GET', `/video/central/books/${bookB._id}`, { token: SA.token })).body.data;
        await H.mapTo(SA.token, chapters[0], [video]);
        await H.mapTo(SA.token, other.chapters[1], [video]);
        await H.mapTo(SA.token, chapters[0], [video]);        // again: nothing changes
        const detail = (await H.api('GET', `/video/central/videos/${video._id}`, { token: SA.token })).body.data;
        assert.equal(detail.mappings.length, 2);
        assert.deepEqual(detail.mappings.map((m) => m.bookTitle).sort(), [bookA.title, bookB.title].sort());
        const [{ n }] = await H.q('SELECT count(*)::int AS n FROM "lmsvideos" WHERE "title" = $1', [video.title]);
        assert.equal(n, 1, 'still one asset');
        const book = (await H.api('GET', `/video/central/books/${bookA._id}`, { token: SA.token })).body.data;
        assert.equal(book.videoCount, 1);
        assert.equal(book.chapters[0].videos[0].video, video._id);
        // A deactivated video cannot be newly mapped.
        await H.api('POST', `/video/central/videos/${video._id}/active`, { token: SA.token, body: { active: false } });
        assert.equal((await H.api('POST', `/video/central/chapters/${chapters[1]._id}/videos`, { token: SA.token, body: { videos: [video._id] } })).status, 400);
        await H.api('POST', `/video/central/videos/${video._id}/active`, { token: SA.token, body: { active: true } });
    });

    it('a linked video is registered once; YouTube is refused for protected content', async () => {
        const strict = await H.api('POST', '/video/central/videos', { token: SA.token, body: { provider: 'youtube', url: 'https://youtu.be/AAAAAAAAAAA', title: 'Protected', durationSec: 100, protection: 'strict' } });
        assert.equal(strict.status, 400);
        assert.equal(strict.body.code, 'YOUTUBE_NOT_STRICT');
        const noLength = await H.api('POST', '/video/central/videos', { token: SA.token, body: { provider: 'youtube', url: 'https://youtu.be/AAAAAAAAAAA', title: 'No length', protection: 'standard' } });
        assert.equal(noLength.status, 400, 'tracking needs the length');
        const v = await H.linkedVideo(SA.token);
        assert.equal(v.processingStatus, 'ready');
        const again = await H.api('POST', '/video/central/videos', { token: SA.token, body: { provider: 'youtube', url: `https://www.youtube.com/watch?v=${v.providerAssetId}`, title: 'Again', durationSec: 10, protection: 'standard' } });
        assert.equal(again.status, 409, 'the same video is not added twice');
        assert.equal((await H.api('POST', `/video/central/videos/${v._id}/uploads`, { token: SA.token, body: { filename: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 10 } })).status, 400);
        const notAVideo = await H.api('POST', '/video/central/videos', { token: SA.token, body: { provider: 'vimeo', url: 'https://example.com/', title: 'x', durationSec: 10 } });
        assert.equal(notAVideo.status, 400);
    });

    it('a new edition copies the chapters and shares the videos', async () => {
        const ed = H.must(await H.api('POST', `/video/central/books/${bookA._id}/editions`, { token: SA.token, body: { edition: '2nd', publicationYear: 2026 } }), 201, 'edition');
        assert.equal(ed.status, 'inactive', 'a new edition starts switched off');
        assert.equal(ed.chapters.length, 3);
        assert.equal(ed.chapters[0].videos[0].video, video._id, 'the same asset, mapped again');
        assert.equal(ed.editions.length, 2);
        assert.equal((await H.api('POST', `/video/central/books/${bookA._id}/editions`, { token: SA.token, body: { edition: '1st' } })).status, 400);
    });

    it('content in use is never deleted: a video with mappings, a book a school follows', async () => {
        assert.equal((await H.api('DELETE', `/video/central/videos/${video._id}`, { token: SA.token })).status, 409);
        await H.follow(S, lib, bookA, 'all');
        const del = await H.api('DELETE', `/video/central/books/${bookA._id}`, { token: SA.token });
        assert.equal(del.status, 409);
        assert.equal(del.body.code, 'IN_USE');
        const detail = (await H.api('GET', `/video/central/books/${bookA._id}`, { token: SA.token })).body.data;
        assert.equal(detail.schools.length, 1, 'the Super Admin sees which schools use a book');
        assert.equal((await H.api('PUT', `/video/central/books/${bookA._id}`, { token: SA.token, body: { classLevel: 10 } })).status, 409, 'a book schools follow cannot change class');
        // Archiving is allowed, and the school keeps what it has.
        assert.equal((await H.api('POST', `/video/central/books/${bookA._id}/status`, { token: SA.token, body: { status: 'archived' } })).body.data.status, 'archived');
        const setup = (await H.api('GET', '/video/school/setup', { token: S.adminToken })).body.data;
        assert.equal(setup.classes.find((c) => c.classNumber === 9).subjects[0].books[0].bookStatus, 'archived');
        assert.equal((await H.api('DELETE', `/video/central/boards/${lib.board._id}`, { token: SA.token })).status, 409);
        assert.equal((await H.api('DELETE', `/video/central/subjects/${lib.subject._id}`, { token: SA.token })).status, 409);
        // An unused book goes, with its chapters.
        const spare = await H.makeBook(SA.token, lib, { title: 'Spare', publisher: 'Nobody', chapters: 1 });
        assert.equal((await H.api('DELETE', `/video/central/books/${spare.book._id}`, { token: SA.token })).status, 200);
        const [{ n }] = await H.q('SELECT count(*)::int AS n FROM "lmschapters" WHERE "book" = $1', [spare.book._id]);
        assert.equal(n, 0);
    });

    it('provider credentials are stored sealed and never come back; an unconfigured provider says so', async () => {
        const save = await H.api('PUT', '/video/central/providers/vimeo', { token: SA.token, body: { enabled: true, secrets: { accessToken: 'vimeo-secret-token-123' } } });
        assert.equal(save.status, 200);
        const list = await H.api('GET', '/video/central/providers', { token: SA.token });
        assert.ok(!JSON.stringify(list.body).includes('vimeo-secret-token-123'), 'a secret is never returned');
        const vimeo = list.body.data.providers.find((p) => p.provider === 'vimeo');
        assert.equal(vimeo.secretFields[0].isSet, true);
        const [row] = await H.q(`SELECT "secrets" FROM "lmsproviders" WHERE "provider" = 'vimeo'`);
        assert.ok(!JSON.stringify(row.secrets).includes('vimeo-secret-token-123'), 'and it is not stored in the clear');
        const [log] = await H.q(`SELECT "meta" FROM "lmsaudits" WHERE "action" = 'provider.saved' AND "actor" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [SA.user._id]);
        assert.ok(!JSON.stringify(log.meta).includes('vimeo-secret-token-123'), 'nor written to the audit log');
        await H.api('PUT', '/video/central/providers/vimeo', { token: SA.token, body: { clearSecrets: ['accessToken'] } });

        // S3 with nothing set: cannot be made the upload target, and says what is missing.
        const s3 = list.body.data.providers.find((p) => p.provider === 's3');
        if (!s3.configured) {
            const make = await H.api('PUT', '/video/central/providers/s3', { token: SA.token, body: { enabled: true, isDefault: true } });
            assert.equal(make.status, 400);
            assert.match(make.body.message, /missing/i);
            const check = await H.api('POST', '/video/central/providers/s3/check', { token: SA.token, body: {} });
            assert.equal(check.body.data.ok, false);
            await H.api('PUT', '/video/central/providers/s3', { token: SA.token, body: { enabled: false } });
        }
        const check = await H.api('POST', '/video/central/providers/local/check', { token: SA.token, body: {} });
        assert.equal(check.body.data.ok, true);
        const after = (await H.api('GET', '/video/central/providers', { token: SA.token })).body.data.providers;
        assert.equal(after.filter((p) => p.isDefault).length, 1, 'checking a provider never leaves uploads with nowhere to go');
        const bad = await H.api('PUT', '/video/central/settings', { token: SA.token, body: { completionThresholdPercent: 5 } });
        assert.equal(bad.status, 400);
    });

    it('the cached overview shows a change at once, not after its cache runs out', async () => {
        const before = (await H.api('GET', '/video/central/overview', { token: SA.token })).body.data.totals.boards;
        const again = (await H.api('GET', '/video/central/overview', { token: SA.token })).body.data.totals.boards;
        assert.equal(again, before, 'served from the cache');
        await H.makeBoard(SA.token);
        const after = (await H.api('GET', '/video/central/overview', { token: SA.token })).body.data.totals.boards;
        assert.equal(after, before + 1);
    });

    it('everything the Super Admin did is in the audit history', async () => {
        const log = await H.api('GET', `/video/central/audit?search=${encodeURIComponent(bookA.title.split(' ').pop())}`, { token: SA.token });
        assert.equal(log.status, 200);
        const actions = (await H.q(`SELECT DISTINCT "action" FROM "lmsaudits" WHERE "actor" = $1`, [SA.user._id])).map((r) => r.action);
        for (const a of ['board.created', 'subject.created', 'book.created', 'chapter.created', 'video.created', 'video.uploaded', 'mapping.added', 'book.archived']) assert.ok(actions.includes(a), `${a} is recorded`);
    });
});
