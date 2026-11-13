'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/** A School Admin says what the school follows: board → subjects → books → sections. And asks for what is missing. */
describe('video learning — a school\'s set-up and its requests', () => {
    let SA; let lib; let A; let B; let bookA; let bookB;
    const setup = async (s) => (await H.api('GET', '/video/school/setup', { token: s.adminToken })).body.data;
    const class9 = (data) => data.classes.find((c) => c.classNumber === 9);

    before(async () => {
        await H.startServer();
        SA = await H.makeSuperAdmin();
        lib = await H.makeBoard(SA.token);
        bookA = (await H.makeBook(SA.token, lib, { title: 'Book A', publisher: 'Publisher A' })).book;
        bookB = (await H.makeBook(SA.token, lib, { title: 'Book B', publisher: 'Publisher B' })).book;
        A = await H.makeSchool('Cfg-A');
        B = await H.makeSchool('Cfg-B');
    });
    after(() => H.finish());

    it('teachers and students cannot configure; a school without the module cannot use it at all', async () => {
        assert.equal((await H.api('GET', '/video/school/setup', { token: A.hindiToken })).status, 403);
        assert.equal((await H.api('GET', '/video/school/setup', { token: A.tokenOf(A.students['9A'][0]) })).status, 403);
        assert.equal((await H.api('GET', '/video/school/setup', { token: SA.token })).status, 403, 'the Super Admin has no school to configure');
        const off = await H.makeSchool('Off', { videoLibrary: false });
        const r = await H.api('GET', '/video/school/setup', { token: off.adminToken });
        assert.equal(r.status, 403);
        assert.equal(r.body.code, 'MODULE_DISABLED');
    });

    it('the School Admin selects the board, then subjects for a class, then books', async () => {
        const before = await setup(A);
        assert.equal(before.config, null);
        assert.ok(before.boards.some((b) => b._id === lib.board._id));
        // Subjects before a board: refused.
        const early = await H.api('PUT', `/video/school/classes/${A.classes[9]._id}/subjects`, { token: A.adminToken, body: { subjects: [{ lmsSubject: lib.subject._id, schoolSubject: A.subjects.hindi._id }] } });
        assert.equal(early.status, 400);

        H.must(await H.api('PUT', '/video/school/board', { token: A.adminToken, body: { academicYear: A.year._id, board: lib.board._id } }), 200, 'board');
        const withBoard = await setup(A);
        assert.equal(withBoard.config.board, lib.board._id);
        assert.equal(class9(withBoard).availableSubjects.length, 1, 'the board\'s subjects for Class 9 are offered');
        assert.equal(class9(withBoard).ownSubjects.length, 2, 'beside the class\'s own subjects');

        H.must(await H.api('PUT', `/video/school/classes/${A.classes[9]._id}/subjects`, { token: A.adminToken, body: { subjects: [{ lmsSubject: lib.subject._id, schoolSubject: A.subjects.hindi._id }] } }), 200, 'subjects');
        const books = await H.api('GET', `/video/school/classes/${A.classes[9]._id}/books?subject=${lib.subject._id}`, { token: A.adminToken });
        assert.equal(books.body.data.length, 2, 'both books of the subject are offered');
        assert.equal((await H.api('GET', `/video/school/classes/${A.classes[10]._id}/books?subject=${lib.subject._id}`, { token: A.adminToken })).body.data.length, 0, 'none for a class they are not for');

        // A book before its subject is selected (Class 10 has none): refused.
        const ten = (await H.makeBook(SA.token, lib, { title: 'Ten', publisher: 'P', classLevel: 10, chapters: 0 })).book;
        assert.equal((await H.api('PUT', '/video/school/books/assignment', { token: A.adminToken, body: { class: A.classes[10]._id, book: ten._id, sections: 'all' } })).status, 400);
        // A book of another class: refused.
        assert.equal((await H.api('PUT', '/video/school/books/assignment', { token: A.adminToken, body: { class: A.classes[9]._id, book: ten._id, sections: 'all' } })).status, 400);
    });

    it('different sections follow different books: A → Book A, B → Book B, C → Book A', async () => {
        const assign = (book, keys) => H.api('PUT', '/video/school/books/assignment', { token: A.adminToken, body: { class: A.classes[9]._id, book: book._id, sections: keys.map((k) => A.sections[k]._id) } });
        assert.equal((await assign(bookA, ['9A', '9C'])).status, 200);
        assert.equal((await assign(bookB, ['9B'])).status, 200);
        const hindi = class9(await setup(A)).subjects[0];
        const of = (book) => hindi.books.find((b) => b.book === book._id);
        assert.deepEqual(of(bookA).sections.sort(), [A.sections['9A']._id, A.sections['9C']._id].sort());
        assert.deepEqual(of(bookB).sections, [A.sections['9B']._id]);

        // What each student sees follows their section.
        const home = async (student) => (await H.api('GET', '/video/student/home', { token: A.tokenOf(student) })).body.data.books.map((b) => b._id);
        assert.deepEqual(await home(A.students['9A'][0]), [bookA._id]);
        assert.deepEqual(await home(A.students['9B'][0]), [bookB._id]);
        assert.deepEqual(await home(A.students['9C'][0]), [bookA._id]);
        assert.deepEqual(await home(A.students['10A'][0]), [], 'another class sees neither');

        // A section of another class cannot be slipped in.
        assert.equal((await assign(bookA, ['10A'])).status, 400);
    });

    it('a student who changes section gets the new section\'s books; the old assignment stays on record', async () => {
        const kid = A.students['9A'][1];
        const sees = async () => (await H.api('GET', '/video/student/home', { token: A.tokenOf(kid) })).body.data.books.map((b) => b._id);
        assert.deepEqual(await sees(), [bookA._id]);
        // The move the ERP makes: off one roster, on to the other.
        await H.q(`UPDATE "classsections" SET "enrolledStudents" = "enrolledStudents" - $2 WHERE "_id" = $1`, [A.sections['9A']._id, String(kid._id)]);
        await H.q(`UPDATE "classsections" SET "enrolledStudents" = "enrolledStudents" || to_jsonb($2::text) WHERE "_id" = $1`, [A.sections['9B']._id, String(kid._id)]);
        await H.q(`UPDATE "studentprofiles" SET "currentSection" = $1 WHERE "user" = $2`, [A.sections['9B']._id, kid._id]);
        assert.deepEqual(await sees(), [bookB._id], 'access followed the student');

        // Re-assigning: Book A from sections A and C to the whole class. The old rows are ended, not deleted.
        H.must(await H.api('PUT', '/video/school/books/assignment', { token: A.adminToken, body: { class: A.classes[9]._id, book: bookA._id, sections: 'all' } }), 200, 'whole class');
        const rows = await H.q(`SELECT "status", "section", "endedAt", "endedBy" FROM "lmsbookassignments" WHERE "school" = $1 AND "book" = $2 ORDER BY "createdAt"`, [A.id, bookA._id]);
        assert.equal(rows.filter((r) => r.status === 'ended').length, 2, 'history of the two section assignments');
        assert.ok(rows.filter((r) => r.status === 'ended').every((r) => r.endedAt && r.endedBy));
        assert.equal(rows.filter((r) => r.status === 'active' && r.section === null).length, 1);
        const history = await H.api('GET', `/video/school/assignments/history?class=${A.classes[9]._id}`, { token: A.adminToken });
        assert.ok(history.body.total >= 4);
        assert.deepEqual((await sees()).sort(), [bookA._id, bookB._id].sort(), 'the class-wide book reaches 9-B too');
    });

    it('one school\'s admin cannot configure, read or request for another school', async () => {
        // B's admin naming A's class, year and sections: all "not found", and nothing changes.
        assert.equal((await H.api('PUT', '/video/school/board', { token: B.adminToken, body: { academicYear: A.year._id, board: lib.board._id } })).status, 404);
        H.must(await H.api('PUT', '/video/school/board', { token: B.adminToken, body: { academicYear: B.year._id, board: lib.board._id } }), 200, 'B board');
        assert.equal((await H.api('PUT', `/video/school/classes/${A.classes[9]._id}/subjects`, { token: B.adminToken, body: { subjects: [] } })).status, 404);
        assert.equal((await H.api('PUT', '/video/school/books/assignment', { token: B.adminToken, body: { class: A.classes[9]._id, book: bookA._id, sections: 'none' } })).status, 404);
        // B's own class with A's subject and A's section.
        assert.equal((await H.api('PUT', `/video/school/classes/${B.classes[9]._id}/subjects`, { token: B.adminToken, body: { subjects: [{ lmsSubject: lib.subject._id, schoolSubject: A.subjects.hindi._id }] } })).status, 400);
        H.must(await H.api('PUT', `/video/school/classes/${B.classes[9]._id}/subjects`, { token: B.adminToken, body: { subjects: [{ lmsSubject: lib.subject._id, schoolSubject: B.subjects.hindi._id }] } }), 200, 'B subjects');
        assert.equal((await H.api('PUT', '/video/school/books/assignment', { token: B.adminToken, body: { class: B.classes[9]._id, book: bookA._id, sections: [A.sections['9A']._id] } })).status, 400);
        const still = await H.q(`SELECT count(*)::int AS n FROM "lmsbookassignments" WHERE "school" = $1 AND "status" = 'active'`, [A.id]);
        assert.equal(still[0].n, 2, 'A\'s assignments are untouched');
        assert.equal((await setup(B)).classes.every((c) => c.subjects.every((s) => s.books.length === 0)), true, 'and B sees none of them');
        // A school id in the body is never read.
        const sneaky = await H.api('PUT', '/video/school/settings', { token: B.adminToken, body: { school: A.id, reminderAfterDays: 9 } });
        assert.equal(sneaky.status, 200);
        assert.equal((await H.api('GET', '/video/school/settings', { token: A.adminToken })).body.data.reminderAfterDays, 3);
    });

    it('changing the board asks first, then ends what belonged to the old one', async () => {
        const other = await H.makeBoard(SA.token);
        const blocked = await H.api('PUT', '/video/school/board', { token: A.adminToken, body: { academicYear: A.year._id, board: other.board._id } });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.code, 'CONFIRM_BOARD_CHANGE');
        assert.equal(blocked.body.books, 2);
        // Dropping a subject that still has books is refused too.
        const drop = await H.api('PUT', `/video/school/classes/${A.classes[9]._id}/subjects`, { token: A.adminToken, body: { subjects: [] } });
        assert.equal(drop.status, 409);
    });

    let request;
    it('a School Admin requests a missing book; the same ask twice is refused, and one already in the library is pointed out', async () => {
        const body = { type: 'book', board: lib.board._id, classLevel: 9, subject: lib.subject._id, title: 'Book D', publisher: 'Publisher D', edition: '2026', comments: 'We use this in Section C' };
        const r = await H.api('POST', '/video/school/requests', { token: A.adminToken, body });
        request = H.must(r, 201, 'request');
        assert.equal(request.status, 'pending');
        const dup = await H.api('POST', '/video/school/requests', { token: A.adminToken, body: { ...body, title: '  book d ', comments: 'again' } });
        assert.equal(dup.status, 409);
        assert.equal(dup.body.code, 'DUPLICATE_REQUEST');
        const exists = await H.api('POST', '/video/school/requests', { token: A.adminToken, body: { ...body, title: bookB.title, publisher: 'Publisher B' } });
        assert.equal(exists.status, 409);
        assert.equal(exists.body.code, 'ALREADY_AVAILABLE');
        // Another school may ask for the same book — and the Super Admin sees two schools want it.
        H.must(await H.api('POST', '/video/school/requests', { token: B.adminToken, body }), 201, 'B request');
        const all = await H.api('GET', '/video/central/requests?search=Book%20D', { token: SA.token });
        assert.equal(all.body.total, 2);
        assert.ok(all.body.data.every((x) => x.schoolsAsking === 2));
        // With an attachment, which only the school and the Super Admin can open.
        const withFile = await H.api('POST', '/video/school/requests', { token: A.adminToken, form: H.fileForm({ type: 'book', boardName: 'Some Other Board', classLevel: '9', subjectName: 'Sanskrit', title: 'Book E' }, { buffer: H.FILES.png, name: 'cover.png', type: 'image/png' }) });
        const fileReq = H.must(withFile, 201, 'request with file');
        assert.equal(fileReq.hasAttachment, true);
        assert.equal((await H.api('GET', `/video/school/requests/${fileReq._id}/attachment`, { token: A.adminToken })).status, 200);
        assert.equal((await H.api('GET', `/video/school/requests/${fileReq._id}/attachment`, { token: B.adminToken })).status, 404);
        assert.equal((await H.api('GET', `/video/central/requests/${fileReq._id}/attachment`, { token: SA.token })).status, 200);
    });

    it('a School Admin requests a missing chapter of a book', async () => {
        const r = await H.api('POST', '/video/school/requests', { token: A.adminToken, body: { type: 'chapter', book: bookA._id, chapterNumber: 7, chapterName: 'Sandhi', topic: 'Swar sandhi with examples' } });
        const ch = H.must(r, 201, 'chapter request');
        assert.equal(ch.type, 'chapter');
        assert.equal(ch.bookTitle, bookA.title);
        assert.equal((await H.api('POST', '/video/school/requests', { token: A.adminToken, body: { type: 'chapter', book: bookA._id, chapterNumber: 7, chapterName: 'Sandhi', topic: 'Swar sandhi with examples' } })).status, 409);
        assert.equal((await H.api('POST', '/video/school/requests', { token: A.adminToken, body: { type: 'chapter', book: bookA._id } })).status, 400);
        // B cannot read A's request.
        assert.equal((await H.api('GET', `/video/school/requests/${ch._id}`, { token: B.adminToken })).status, 404);
        assert.ok((await H.api('GET', '/video/school/requests', { token: B.adminToken })).body.data.every((x) => x.school === B.id));
    });

    it('the Super Admin moves a request through its statuses and the school is notified at each step — once', async () => {
        const step = (status, extra = {}) => H.api('POST', `/video/central/requests/${request._id}/status`, { token: SA.token, body: { status, ...extra } });
        assert.equal((await step('completed')).status, 409, 'pending cannot jump to completed');
        assert.equal((await step('rejected')).status, 400, 'a rejection needs a reason');
        assert.equal((await step('under_review')).body.data.status, 'under_review');
        assert.equal((await step('approved', { note: 'We will add it' })).body.data.status, 'approved');
        assert.equal((await step('in_progress')).body.data.status, 'in_progress');
        const done = await step('completed', { resolvedBook: bookB._id });
        assert.equal(done.body.data.status, 'completed');
        assert.equal(done.body.data.history.length, 5);
        assert.equal((await step('approved')).status, 409, 'a completed request is closed');
        assert.equal((await H.api('POST', `/video/central/requests/${request._id}/status`, { token: A.adminToken, body: { status: 'approved' } })).status, 403, 'a school cannot approve its own request');

        await new Promise((r) => setTimeout(r, 700));        // notifications are sent after the response
        const got = await H.q(`
            SELECT n."title" FROM "notificationreceipts" r JOIN "notifications" n ON n."_id" = r."notification"
             WHERE r."recipient" = $1 AND n."link"->>'type' = 'video.requests' ORDER BY n."createdAt"`, [A.admin._id]);
        assert.equal(got.length, 4, 'under review, approved, in progress, complete — one each');
        assert.match(got[3].title, /ready/i);
        // The request can be asked again now it is closed (a new edition, say) — the earlier one no longer blocks.
        const filed = await H.q(`SELECT count(*)::int AS n FROM "notifications" WHERE "sender" = $1 AND "link"->>'type' = 'video.requests'`, [A.admin._id]);
        assert.ok(filed[0].n >= 3, 'the Super Admins were told of each request filed');
    });

    it('a pending request can be withdrawn; one being looked at cannot', async () => {
        const mine = (await H.api('GET', '/video/school/requests?status=pending', { token: A.adminToken })).body.data;
        assert.ok(mine.length >= 1);
        assert.equal((await H.api('DELETE', `/video/school/requests/${mine[0]._id}`, { token: A.adminToken })).status, 200);
        assert.equal((await H.api('DELETE', `/video/school/requests/${request._id}`, { token: A.adminToken })).status, 409);
    });
});
