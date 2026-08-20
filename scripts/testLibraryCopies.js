'use strict';
/**
 * Library — physical copies, end-to-end.
 *
 *   node scripts/testLibraryCopies.js
 *
 * Builds a throwaway school with the library module on, mounts the real
 * /api/library router on an ephemeral port, and drives the copy lifecycle as a
 * librarian: add a batch, edit, change status, issue, delete, bulk import.
 *
 * The assertion this file exists for: LibraryBook.totalCopies /
 * availableCopies stay in step with the LibraryBookCopy rows through every one
 * of those operations — the denormalised counts are what the whole module
 * reads to decide whether a title can be issued at all.
 *
 * No test framework needed — the repo has none.
 */
require('dotenv').config();
const express = require('express');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

const connectDB = require('../config/db');

const School          = require('../models/School');
const User            = require('../models/User');
const TeacherProfile  = require('../models/TeacherProfile');
const LibraryBook     = require('../models/LibraryBook');
const LibraryBookCopy = require('../models/LibraryBookCopy');
const LibraryPolicy   = require('../models/LibraryPolicy');
const LibraryIssuance = require('../models/LibraryIssuance');
const LibraryReservation = require('../models/LibraryReservation');
const LibraryFine     = require('../models/LibraryFine');
const LibraryAuditLog = require('../models/LibraryAuditLog');
const XLSX            = require('xlsx');
const Redis           = require('ioredis');
const Notification        = require('../models/Notification');
const NotificationReceipt = require('../models/NotificationReceipt');

// ── tiny harness ─────────────────────────────────────────────────────────────
let passed = 0; let failed = 0;
const results = [];

function check(name, condition, detail = '') {
    if (condition) { passed += 1; results.push(`  ✅ ${name}`); }
    else { failed += 1; results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { results.push(`\n▸ ${title}`); }

const TAG = `libtest_${Date.now()}`;
let BASE = '';

const sid = (v) => String(v?._id ?? v);
const token = (user) => jwt.sign(
    { userId: sid(user), role: user.role, schoolId: sid(user.school) },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
);

async function call(method, path, { as, body } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(as ? { Authorization: `Bearer ${token(as)}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: json, data: json?.data, message: json?.message };
}
const GET   = (p, o) => call('GET', p, o);
const POST  = (p, o) => call('POST', p, o);
const PUT   = (p, o) => call('PUT', p, o);
const PATCH = (p, o) => call('PATCH', p, o);
const DEL   = (p, o) => call('DELETE', p, o);

// ── WebSocket delivery capture ───────────────────────────────────────────────
//
// notify() persists the notification and publishes it on the Redis channels the
// WebSocket Gateway forwards to a user's sockets. Subscribing to the same
// channels here is the honest way to assert "this reached the user live" —
// checking the database row only proves it was stored.
const wsEvents = [];       // { userId, event, data }
const wsCounts = [];       // { userId, count }
let wsSub = null;

async function startWsCapture() {
    if (!process.env.REDIS_URL) return false;
    wsSub = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
    await wsSub.connect();
    await wsSub.subscribe('chat.deliver', 'notification.count');
    wsSub.on('message', (channel, raw) => {
        try {
            const msg = JSON.parse(raw);
            if (channel === 'notification.count') wsCounts.push(msg);
            else if (msg.target === 'user') {
                wsEvents.push({ userId: String(msg.targetId || '').replace(/^user:/, ''), event: msg.event, data: msg.data });
            }
        } catch { /* not ours */ }
    });
    return true;
}

/** notify() is fire-and-forget on setImmediate, so give the publish a moment. */
const settle = (ms = 350) => new Promise(r => setTimeout(r, ms));

/** Live pushes to one user, newest last. */
const pushesTo = (userId, titleMatch) => wsEvents.filter(e =>
    e.userId === String(userId) && e.event === 'notification:new'
    && (!titleMatch || titleMatch.test(e.data?.title || '')));

// ── fixture ──────────────────────────────────────────────────────────────────
async function makeUser(name, role, schoolId) {
    return User.create({
        name,
        email: `${TAG}_${name.toLowerCase().replace(/\s+/g, '')}@example.test`,
        password: await bcrypt.hash('Passw0rd123', 4),
        role,
        school: schoolId,
        isFirstLogin: false,
        isActive: true,
    });
}

async function buildFixture() {
    const school = await School.create({
        name: `${TAG} High School`,
        board: 'CBSE',
        designations: ['Teacher', 'Librarian'],
        modules: { library: true },
    });
    const schoolId = sid(school._id);
    await require('../services/designationService').invalidate(schoolId);

    const admin    = await makeUser('Lib Admin', 'school_admin', schoolId);
    const student  = await makeUser('Lib Student', 'student', schoolId);
    const student2 = await makeUser('Lib Student Two', 'student', schoolId);
    const teacher  = await makeUser('Lib Teacher', 'teacher', schoolId);
    const parent   = await makeUser('Lib Parent', 'parent', schoolId);
    const inactive = await makeUser('Lib Dropout', 'student', schoolId);
    await User.findByIdAndUpdate(sid(inactive._id), { isActive: false });

    return { school, schoolId, admin, student, student2, teacher, parent, inactive };
}

async function cleanup(f) {
    const s = f.schoolId;
    await LibraryAuditLog.deleteMany({ school: s });
    await LibraryFine.deleteMany({ school: s });
    await LibraryIssuance.deleteMany({ school: s });
    await LibraryReservation.deleteMany({ school: s });
    await LibraryBookCopy.deleteMany({ school: s });
    await LibraryBook.deleteMany({ school: s });
    await LibraryPolicy.deleteMany({ school: s });
    const notes = await Notification.find({ school: s }).select('_id').lean();
    if (notes.length) await NotificationReceipt.deleteMany({ notification: { $in: notes.map(sid) } });
    await Notification.deleteMany({ school: s });
    await TeacherProfile.deleteMany({ school: s });
    await User.deleteMany({ school: s });
    await School.findByIdAndDelete(s);
}

/** Counts straight from the DB — never from the API under test. */
async function counts(bookId) {
    const book   = await LibraryBook.findById(bookId).lean();
    const rows   = await LibraryBookCopy.find({ book: bookId }).lean();
    return {
        total:      book?.totalCopies ?? -1,
        available:  book?.availableCopies ?? -1,
        rows:       rows.length,
        rowsAvail:  rows.filter(r => r.status === 'available').length,
    };
}
const inStep = (c) => c.total === c.rows && c.available === c.rowsAvail;

// ── run ──────────────────────────────────────────────────────────────────────
(async () => {
    await connectDB();

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/library', require('../routes/api/library'));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    BASE = `http://127.0.0.1:${server.address().port}/api`;

    let f;
    try {
        f = await buildFixture();
        const { schoolId, admin, student, student2, teacher, parent, inactive } = f;

        section('A new book starts with nothing on the shelf');
        const created = await POST('/library/books', { as: admin, body: { title: `${TAG} Physics`, authors: ['R. Feynman'], isbn: '978-0-465-02414-2' } });
        check('Book created', created.status === 201 && !!created.data?._id, `status ${created.status}`);
        const bookId = sid(created.data);
        let c = await counts(bookId);
        check('Fresh book has 0 copies', c.total === 0 && c.available === 0 && c.rows === 0, JSON.stringify(c));

        section('Copies can be added in a batch');
        const added = await POST(`/library/books/${bookId}/copies`, { as: admin, body: { count: 5, condition: 'new', rackLocation: 'A-01' } });
        check('Batch add accepted', added.status === 201, `status ${added.status} ${added.message || ''}`);
        check('Returns 5 copies', Array.isArray(added.data) && added.data.length === 5, `got ${added.data?.length}`);
        const codes = (added.data || []).map(x => x.uniqueCode);
        check('Every code is unique', new Set(codes).size === 5, codes.join(','));
        check('Codes follow LIB-COPY-xxxxxx', codes.every(x => /^LIB-COPY-\d{6}$/.test(x)), codes[0]);
        check('Rack location carried onto each copy', (added.data || []).every(x => x.rackLocation === 'A-01'));
        c = await counts(bookId);
        check('Counts in step after batch add', inStep(c) && c.total === 5, JSON.stringify(c));

        section('Concurrent adds never collide on a code');
        const [p1, p2, p3] = await Promise.all([
            POST(`/library/books/${bookId}/copies`, { as: admin, body: { count: 3 } }),
            POST(`/library/books/${bookId}/copies`, { as: admin, body: { count: 3 } }),
            POST(`/library/books/${bookId}/copies`, { as: admin, body: { count: 3 } }),
        ]);
        check('All three parallel adds succeeded', [p1, p2, p3].every(r => r.status === 201),
            [p1, p2, p3].map(r => r.status).join(','));
        const allRows = await LibraryBookCopy.find({ book: bookId }).lean();
        check('All 14 copy codes still distinct', new Set(allRows.map(r => r.uniqueCode)).size === allRows.length,
            `${allRows.length} rows, ${new Set(allRows.map(r => r.uniqueCode)).size} codes`);
        c = await counts(bookId);
        check('Counts in step after concurrent adds', inStep(c) && c.total === 14, JSON.stringify(c));

        section('The batch size is bounded');
        const tooMany = await POST(`/library/books/${bookId}/copies`, { as: admin, body: { count: 101 } });
        check('Rejects count above 100', tooMany.status === 400, `status ${tooMany.status}`);
        const zero = await POST(`/library/books/${bookId}/copies`, { as: admin, body: { count: 0 } });
        check('Rejects count of 0', zero.status === 400, `status ${zero.status}`);
        const junk = await POST(`/library/books/${bookId}/copies`, { as: admin, body: { count: 'ten' } });
        check('Rejects a non-numeric count', junk.status === 400, `status ${junk.status}`);
        const implicit = await POST(`/library/books/${bookId}/copies`, { as: admin, body: {} });
        check('Defaults to a single copy when count is omitted', implicit.status === 201 && implicit.data?.length === 1,
            `status ${implicit.status} len ${implicit.data?.length}`);

        section('Copy detail is editable');
        const target = (await LibraryBookCopy.find({ book: bookId }).lean())[0];
        const edited = await PUT(`/library/books/${bookId}/copies/${sid(target)}`, { as: admin, body: { condition: 'fair', rackLocation: 'B-07' } });
        check('Edit accepted', edited.status === 200 && edited.data?.condition === 'fair' && edited.data?.rackLocation === 'B-07',
            JSON.stringify(edited.data));

        section('Status changes keep availableCopies honest');
        const before = await counts(bookId);
        const lost = await PATCH(`/library/books/${bookId}/copies/${sid(target)}/status`, { as: admin, body: { status: 'lost' } });
        check('Marked lost', lost.status === 200, `status ${lost.status} ${lost.message || ''}`);
        c = await counts(bookId);
        check('availableCopies dropped by 1', c.available === before.available - 1, `${before.available} → ${c.available}`);
        check('totalCopies unchanged by a status change', c.total === before.total, `${before.total} → ${c.total}`);
        check('Counts still in step', inStep(c), JSON.stringify(c));

        const back = await PATCH(`/library/books/${bookId}/copies/${sid(target)}/status`, { as: admin, body: { status: 'available' } });
        check('Marked available again', back.status === 200, `status ${back.status}`);
        c = await counts(bookId);
        check('availableCopies restored', c.available === before.available && inStep(c), JSON.stringify(c));

        const bogus = await PATCH(`/library/books/${bookId}/copies/${sid(target)}/status`, { as: admin, body: { status: 'on_fire' } });
        check('Rejects an unknown status', bogus.status === 400, `status ${bogus.status}`);
        const manualIssue = await PATCH(`/library/books/${bookId}/copies/${sid(target)}/status`, { as: admin, body: { status: 'issued' } });
        check('Refuses to set "issued" by hand', manualIssue.status === 400, `status ${manualIssue.status}`);

        section('An issued copy is protected');
        const issued = await POST('/library/issue', { as: admin, body: { bookId, copyId: sid(target), userId: sid(student._id), userRole: 'student' } });
        check('Copy issued through circulation', issued.status === 201 || issued.status === 200,
            `status ${issued.status} ${issued.message || ''}`);
        c = await counts(bookId);
        check('Issue decremented availableCopies', inStep(c) && c.available === before.available - 1, JSON.stringify(c));

        const statusOnIssued = await PATCH(`/library/books/${bookId}/copies/${sid(target)}/status`, { as: admin, body: { status: 'available' } });
        check('Status of an issued copy cannot be edited', statusOnIssued.status === 400, `status ${statusOnIssued.status}`);
        const delIssued = await DEL(`/library/books/${bookId}/copies/${sid(target)}`, { as: admin });
        check('An issued copy cannot be removed', delIssued.status === 400, `status ${delIssued.status}`);

        section('A mis-added copy can be removed');
        const spare = (await LibraryBookCopy.find({ book: bookId, status: 'available' }).lean())[0];
        const beforeDel = await counts(bookId);
        const removed = await DEL(`/library/books/${bookId}/copies/${sid(spare)}`, { as: admin });
        check('Available copy removed', removed.status === 200, `status ${removed.status} ${removed.message || ''}`);
        c = await counts(bookId);
        check('Both counts dropped by 1', c.total === beforeDel.total - 1 && c.available === beforeDel.available - 1,
            `${JSON.stringify(beforeDel)} → ${JSON.stringify(c)}`);
        check('Counts still in step after removal', inStep(c), JSON.stringify(c));

        const damaged = (await LibraryBookCopy.find({ book: bookId, status: 'available' }).lean())[0];
        await PATCH(`/library/books/${bookId}/copies/${sid(damaged)}/status`, { as: admin, body: { status: 'damaged' } });
        const beforeDel2 = await counts(bookId);
        await DEL(`/library/books/${bookId}/copies/${sid(damaged)}`, { as: admin });
        c = await counts(bookId);
        check('Removing a non-available copy leaves availableCopies alone',
            c.total === beforeDel2.total - 1 && c.available === beforeDel2.available, `${JSON.stringify(beforeDel2)} → ${JSON.stringify(c)}`);
        check('Counts still in step after removing a damaged copy', inStep(c), JSON.stringify(c));

        section('The book detail endpoint carries the copies');
        const detail = await GET(`/library/books/${bookId}`, { as: admin });
        const liveRows = await LibraryBookCopy.find({ book: bookId }).lean();
        check('Detail returns every copy', detail.status === 200 && detail.data?.copies?.length === liveRows.length,
            `api ${detail.data?.copies?.length} vs db ${liveRows.length}`);
        const returnedCodes = (detail.data?.copies || []).map(x => x.uniqueCode);
        check('Copies come back in code order',
            returnedCodes.join() === [...returnedCodes].sort().join(), returnedCodes.join(','));

        section('Cross-school access is refused');
        const otherSchool = await School.create({ name: `${TAG} Other`, board: 'CBSE', modules: { library: true } });
        await require('../services/designationService').invalidate(sid(otherSchool._id));
        const intruder = await makeUser('Other Admin', 'school_admin', sid(otherSchool._id));
        const stolen = await POST(`/library/books/${bookId}/copies`, { as: intruder, body: { count: 1 } });
        check('Another school cannot add copies to this book', stolen.status === 404, `status ${stolen.status}`);
        await User.findByIdAndDelete(sid(intruder._id));
        await School.findByIdAndDelete(sid(otherSchool._id));

        section('Bulk import can land issuable books');
        const rows = [
            { title: `${TAG} Bulk One`, isbn: '9780007458424', authors: 'A One', copies: 4, rackLocation: 'C-01' },
            { title: `${TAG} Bulk Two`, isbn: '9780141036144', authors: 'A Two', copies: 0 },
        ];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Books');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'books.xlsx');
        const upRes = await fetch(`${BASE}/library/books/bulk-upload`, {
            method: 'POST', headers: { Authorization: `Bearer ${token(admin)}` }, body: fd,
        });
        const upBody = await upRes.json().catch(() => null);
        check('Bulk upload accepted', upRes.status === 200, `status ${upRes.status} ${upBody?.message || ''}`);
        check('Both rows imported', upBody?.imported === 2, `imported ${upBody?.imported}`);
        check('Copies created from the copies column', upBody?.copiesCreated === 4, `copiesCreated ${upBody?.copiesCreated}`);
        const bulkOne = await LibraryBook.findOne({ school: schoolId, isbn: '9780007458424' }).lean();
        const bulkTwo = await LibraryBook.findOne({ school: schoolId, isbn: '9780141036144' }).lean();
        const c1 = await counts(sid(bulkOne));
        check('Imported book is immediately issuable', inStep(c1) && c1.total === 4 && c1.available === 4, JSON.stringify(c1));
        check('Rack from the sheet reached the copies',
            (await LibraryBookCopy.find({ book: sid(bulkOne) }).lean()).every(r => r.rackLocation === 'C-01'));
        const c2 = await counts(sid(bulkTwo));
        check('A row with no copies column still imports as a bare catalogue entry',
            c2.total === 0 && c2.rows === 0, JSON.stringify(c2));

        // ══ VALIDATION & PERMISSION ═══════════════════════════════════════════

        section('(b) The same book cannot be catalogued twice');
        const dupTitle = `${TAG} Duplicates`;
        const first = await POST('/library/books', { as: admin, body: { title: dupTitle, isbn: '978-0-13-235088-4', edition: '1st' } });
        check('First entry accepted', first.status === 201, `status ${first.status}`);
        const firstId = sid(first.data);

        const sameIsbn = await POST('/library/books', { as: admin, body: { title: 'A Completely Different Title', isbn: '9780132350884' } });
        check('Same ISBN written differently is refused', sameIsbn.status === 409, `status ${sameIsbn.status}`);
        check('Refusal names the existing book', sameIsbn.body?.data?.existingBookId === firstId, JSON.stringify(sameIsbn.body?.data));
        check('Refusal carries a code the UI can branch on', sameIsbn.body?.code === 'DUPLICATE_BOOK', sameIsbn.body?.code);

        const sameTitle = await POST('/library/books', { as: admin, body: { title: `  ${dupTitle.toUpperCase()}  `, edition: '1st' } });
        check('Same title + edition (no ISBN) is refused', sameTitle.status === 409, `status ${sameTitle.status}`);

        const otherEdition = await POST('/library/books', { as: admin, body: { title: dupTitle, edition: '2nd' } });
        check('A different edition of the same title is allowed', otherEdition.status === 201, `status ${otherEdition.status}`);

        const differentIsbn = await POST('/library/books', { as: admin, body: { title: dupTitle, isbn: '9780262033848', edition: '1st' } });
        check('Same title with a genuinely different ISBN is allowed', differentIsbn.status === 201, `status ${differentIsbn.status}`);

        const renameOnto = await PUT(`/library/books/${sid(otherEdition.data)}`, { as: admin, body: { edition: '1st' } });
        check('Editing a book onto an existing entry is refused', renameOnto.status === 409, `status ${renameOnto.status}`);
        const renameSelf = await PUT(`/library/books/${firstId}`, { as: admin, body: { publisher: 'Addison-Wesley' } });
        check('A book can still be edited against itself', renameSelf.status === 200, `status ${renameSelf.status}`);

        section('ISBNs are checked for shape');
        for (const bad of ['12345', 'not-an-isbn', '97801322350884444']) {
            const r = await POST('/library/books', { as: admin, body: { title: `${TAG} bad ${bad}`, isbn: bad } });
            check(`Rejects ISBN "${bad}"`, r.status === 400, `status ${r.status}`);
        }
        const isbn10 = await POST('/library/books', { as: admin, body: { title: `${TAG} Ten Digit`, isbn: '0-306-40615-2' } });
        check('Accepts a 10-digit ISBN', isbn10.status === 201, `status ${isbn10.status}`);
        const noTitle = await POST('/library/books', { as: admin, body: { isbn: '9780306406157' } });
        check('Rejects a book with no title', noTitle.status === 400, `status ${noTitle.status}`);

        section('Bulk import skips what already exists');
        const dupRows = [
            { title: `${TAG} Bulk One`, isbn: '9780007458424', copies: 2 },       // already imported earlier
            { title: `${TAG} Bulk Three`, isbn: '9781400079988', copies: 1 },     // new
            { title: `${TAG} Bulk Three`, isbn: '9781400079988', copies: 1 },     // repeated in-sheet
            { title: `${TAG} Bulk Bad`, isbn: 'nonsense', copies: 1 },            // invalid ISBN
        ];
        const wb2 = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb2, XLSX.utils.json_to_sheet(dupRows), 'Books');
        const fd2 = new FormData();
        fd2.append('file', new Blob([XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' })]), 'books.xlsx');
        const up2 = await (await fetch(`${BASE}/library/books/bulk-upload`, {
            method: 'POST', headers: { Authorization: `Bearer ${token(admin)}` }, body: fd2,
        })).json();
        check('Only the genuinely new row imported', up2?.imported === 1, `imported ${up2?.imported}`);
        check('Three rows reported as skipped', up2?.skipped?.length === 3, JSON.stringify(up2?.skipped));
        check('Skip reasons explain each one',
            ['already in the catalogue', 'repeated in this file', 'invalid ISBN'].every(r => up2.skipped.some(x => x.reason === r)),
            JSON.stringify(up2?.skipped));

        section('(a) One person cannot hold two copies of the same book');
        const loanBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Loanable`, isbn: '9780451524935' } });
        const loanId = sid(loanBook.data);
        await POST(`/library/books/${loanId}/copies`, { as: admin, body: { count: 4 } });
        const freeCopies = () => LibraryBookCopy.find({ book: loanId, status: 'available' }).lean();

        let avail = await freeCopies();
        const firstLoan = await POST('/library/issue', { as: admin, body: { bookId: loanId, copyId: sid(avail[0]), userId: sid(student._id) } });
        check('First copy issued', firstLoan.status === 201, `status ${firstLoan.status} ${firstLoan.message || ''}`);

        avail = await freeCopies();
        const secondLoan = await POST('/library/issue', { as: admin, body: { bookId: loanId, copyId: sid(avail[0]), userId: sid(student._id) } });
        check('🔒 Second copy of the SAME book to the SAME person is refused', secondLoan.status === 400, `status ${secondLoan.status}`);
        check('Refusal explains why', /already has a copy/i.test(secondLoan.message || ''), secondLoan.message);

        const otherPerson = await POST('/library/issue', { as: admin, body: { bookId: loanId, copyId: sid(avail[0]), userId: sid(student2._id) } });
        check('Another person can still take a copy', otherPerson.status === 201, `status ${otherPerson.status} ${otherPerson.message || ''}`);

        const heldByStudent = await LibraryIssuance.countDocuments({ book: loanId, issuedTo: sid(student._id), status: 'issued' });
        check('Exactly one copy sits against that person', heldByStudent === 1, `${heldByStudent}`);

        section('… unless the school deliberately allows it');
        await PUT('/library/policy', { as: admin, body: { allowMultipleCopiesPerUser: true } });
        avail = await freeCopies();
        const allowed = await POST('/library/issue', { as: admin, body: { bookId: loanId, copyId: sid(avail[0]), userId: sid(student._id) } });
        check('Policy flag lets the second copy through', allowed.status === 201, `status ${allowed.status} ${allowed.message || ''}`);
        await PUT('/library/policy', { as: admin, body: { allowMultipleCopiesPerUser: false } });

        section('Who may borrow at all');
        const catalogue = await POST('/library/books', { as: admin, body: { title: `${TAG} Borrow Rules`, isbn: '9780393609394' } });
        const ruleBook = sid(catalogue.data);
        await POST(`/library/books/${ruleBook}/copies`, { as: admin, body: { count: 6 } });
        const ruleCopies = async () => (await LibraryBookCopy.find({ book: ruleBook, status: 'available' }).lean());

        let rc = await ruleCopies();
        const toParent = await POST('/library/issue', { as: admin, body: { bookId: ruleBook, copyId: sid(rc[0]), userId: sid(parent._id) } });
        check('A parent account cannot be issued a book', toParent.status === 400, `status ${toParent.status}`);
        const toInactive = await POST('/library/issue', { as: admin, body: { bookId: ruleBook, copyId: sid(rc[0]), userId: sid(inactive._id) } });
        check('An inactive account cannot be issued a book', toInactive.status === 400, `status ${toInactive.status}`);
        const toNobody = await POST('/library/issue', { as: admin, body: { bookId: ruleBook, copyId: sid(rc[0]), userId: sid(admin._id).replace(/.$/, '0') } });
        check('An unknown borrower is refused', [400, 404].includes(toNobody.status), `status ${toNobody.status}`);
        const toTeacher = await POST('/library/issue', { as: admin, body: { bookId: ruleBook, copyId: sid(rc[0]), userId: sid(teacher._id) } });
        check('A teacher can borrow', toTeacher.status === 201, `status ${toTeacher.status} ${toTeacher.message || ''}`);

        section('Due dates are sane');
        rc = await ruleCopies();
        const pastDue = await POST('/library/issue', { as: admin, body: { bookId: ruleBook, copyId: sid(rc[0]), userId: sid(student2._id), dueDate: '2020-01-01' } });
        check('A due date in the past is refused', pastDue.status === 400, `status ${pastDue.status}`);
        const junkDue = await POST('/library/issue', { as: admin, body: { bookId: ruleBook, copyId: sid(rc[0]), userId: sid(student2._id), dueDate: 'whenever' } });
        check('An unparseable due date is refused', junkDue.status === 400, `status ${junkDue.status}`);
        const farDue = await POST('/library/issue', { as: admin, body: { bookId: ruleBook, copyId: sid(rc[0]), userId: sid(student2._id), dueDate: '2099-01-01' } });
        check('A due date years out is refused', farDue.status === 400, `status ${farDue.status}`);

        section('The borrowing limit counts overdue loans too');
        await PUT('/library/policy', { as: admin, body: { maxBooksPerUser: 2, blockIssueOnOverdue: false } });
        const limitStudent = await makeUser('Limit Tester', 'student', schoolId);
        const limitBooks = [];
        for (let i = 0; i < 3; i++) {
            const b = await POST('/library/books', { as: admin, body: { title: `${TAG} Limit ${i}` } });
            await POST(`/library/books/${sid(b.data)}/copies`, { as: admin, body: { count: 1 } });
            limitBooks.push(sid(b.data));
        }
        const takeLimit = async (i) => {
            const copy = (await LibraryBookCopy.find({ book: limitBooks[i], status: 'available' }).lean())[0];
            return POST('/library/issue', { as: admin, body: { bookId: limitBooks[i], copyId: sid(copy), userId: sid(limitStudent._id) } });
        };
        check('First book within limit', (await takeLimit(0)).status === 201);
        check('Second book within limit', (await takeLimit(1)).status === 201);
        const third = await takeLimit(2);
        check('Third book over the limit is refused', third.status === 400, `status ${third.status}`);
        check('Refusal states the limit', /maximum 2/.test(third.message || ''), third.message);

        // Backdate one loan so it counts as overdue rather than merely issued.
        const toAge = await LibraryIssuance.findOne({ issuedTo: sid(limitStudent._id) }).lean();
        await LibraryIssuance.updateOne({ _id: sid(toAge) }, { status: 'overdue', dueDate: new Date(Date.now() - 5 * 86400000) });
        const thirdAgain = await takeLimit(2);
        check('An overdue loan still occupies a slot', thirdAgain.status === 400, `status ${thirdAgain.status}`);

        section('An overdue borrower is blocked when the policy says so');
        await PUT('/library/policy', { as: admin, body: { blockIssueOnOverdue: true, maxBooksPerUser: 10 } });
        const blocked = await takeLimit(2);
        check('Overdue book blocks any further borrowing', blocked.status === 400, `status ${blocked.status}`);
        check('Refusal says it is about the overdue book', /overdue/i.test(blocked.message || ''), blocked.message);

        section('An overdue loan can still be returned');
        const overdueLoan = await LibraryIssuance.findOne({ _id: sid(toAge) }).lean();
        const returned = await POST('/library/return', { as: admin, body: { issuanceId: sid(overdueLoan) } });
        check('Return of an overdue loan accepted', returned.status === 200, `status ${returned.status} ${returned.message || ''}`);
        check('A late fine was raised', !!returned.data?.fine, JSON.stringify(returned.data?.fine));

        section('Unpaid fines block borrowing and reserving');
        await PUT('/library/policy', { as: admin, body: { blockIssueOnPendingFine: true, blockIssueOnOverdue: false } });
        const fined = await takeLimit(2);
        check('A member owing a fine cannot borrow', fined.status === 400, `status ${fined.status}`);
        check('Refusal states the amount owed', /unpaid library fines/i.test(fined.message || ''), fined.message);

        const finedReserve = await POST(`/library/student/books/${loanId}/reserve`, { as: limitStudent });
        check('A member owing a fine cannot reserve', finedReserve.status === 400, `status ${finedReserve.status}`);

        const theFine = await LibraryFine.findOne({ user: sid(limitStudent._id), status: 'pending' }).lean();
        const waiveNoReason = await POST(`/library/fines/${sid(theFine)}/waive`, { as: admin, body: {} });
        check('A fine cannot be waived without a reason', waiveNoReason.status === 400, `status ${waiveNoReason.status}`);
        const waived = await POST(`/library/fines/${sid(theFine)}/waive`, { as: admin, body: { reason: 'Book returned damaged by flood' } });
        check('A fine can be waived with a reason', waived.status === 200, `status ${waived.status}`);
        const afterWaiver = await takeLimit(2);
        check('Clearing the fine unblocks borrowing', afterWaiver.status === 201, `status ${afterWaiver.status} ${afterWaiver.message || ''}`);

        section('Reservations respect the queue');
        await PUT('/library/policy', { as: admin, body: { blockIssueOnPendingFine: false } });
        const queueBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Popular` } });
        const qBookId = sid(queueBook.data);
        await POST(`/library/books/${qBookId}/copies`, { as: admin, body: { count: 1 } });
        const qCopy = (await LibraryBookCopy.find({ book: qBookId }).lean())[0];

        // Take the only copy out so reservations queue behind it.
        await POST('/library/issue', { as: admin, body: { bookId: qBookId, copyId: sid(qCopy), userId: sid(student._id) } });

        const r1 = await POST(`/library/student/books/${qBookId}/reserve`, { as: student2 });
        check('First person joins the queue', r1.status === 201, `status ${r1.status} ${r1.message || ''}`);
        const rDup = await POST(`/library/student/books/${qBookId}/reserve`, { as: student2 });
        check('The same person cannot queue twice', rDup.status === 400, `status ${rDup.status}`);
        const rHolder = await POST(`/library/student/books/${qBookId}/reserve`, { as: student });
        check('The person holding the book cannot reserve another copy', rHolder.status === 400, `status ${rHolder.status}`);
        check('Refusal explains they already have it', /already have this book/i.test(rHolder.message || ''), rHolder.message);

        const r3 = await POST(`/library/student/books/${qBookId}/reserve`, { as: limitStudent });
        check('A third person joins behind', r3.status === 201, `status ${r3.status}`);
        const queue = await LibraryReservation.find({ book: qBookId, status: 'pending' }).sort({ queuePosition: 1 }).lean();
        check('Queue is numbered 1..n with no gaps',
            queue.map(q => q.queuePosition).join(',') === queue.map((_, i) => i + 1).join(','),
            queue.map(q => q.queuePosition).join(','));

        const returnQ = await LibraryIssuance.findOne({ book: qBookId, status: 'issued' }).lean();
        await POST('/library/return', { as: admin, body: { issuanceId: sid(returnQ) } });
        const promoted = await LibraryReservation.findOne({ book: qBookId, status: 'ready' }).lean();
        check('Returning promotes the front of the queue', String(promoted?.reservedBy) === sid(student2._id), String(promoted?.reservedBy));

        const jumpQueue = await POST('/library/issue', { as: admin, body: { bookId: qBookId, copyId: sid(qCopy), userId: sid(teacher._id) } });
        check('🔒 A walk-in cannot take a copy being held for someone else', jumpQueue.status === 400, `status ${jumpQueue.status}`);
        check('Refusal names the person waiting', /being held for/i.test(jumpQueue.message || ''), jumpQueue.message);

        const collect = await POST('/library/issue', { as: admin, body: { bookId: qBookId, copyId: sid(qCopy), userId: sid(student2._id) } });
        check('The person who reserved it can collect', collect.status === 201, `status ${collect.status} ${collect.message || ''}`);
        const afterCollect = await LibraryReservation.findOne({ _id: sid(r1.data) }).lean();
        check('Their reservation is marked collected, not left to expire', afterCollect?.status === 'collected', afterCollect?.status);
        const requeued = await LibraryReservation.find({ book: qBookId, status: 'pending' }).lean();
        check('Queue renumbered after the collection', requeued.every((q, i) => q.queuePosition === i + 1),
            requeued.map(q => q.queuePosition).join(','));

        section('A hold reserves a copy, not the whole shelf');
        // The guard used to refuse any walk-in while a hold existed, so a title
        // with copies to spare could not be issued to anyone else.
        const plentyBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Plenty` } });
        const plentyId = sid(plentyBook.data);
        // Three copies: one to the walk-in, one to a spare borrower, one left —
        // which is exactly the copy the hold is entitled to.
        await POST(`/library/books/${plentyId}/copies`, { as: admin, body: { count: 3 } });
        await PUT('/library/policy', { as: admin, body: { maxBooksPerUser: 20, blockIssueOnPendingFine: false, blockIssueOnOverdue: false } });

        const holder = await makeUser('Queue Holder', 'student', schoolId);
        const walker = await makeUser('Walk Up', 'student', schoolId);
        const held = await POST(`/library/student/books/${plentyId}/reserve`, { as: holder });
        check('A hold is placed while copies are free', held.status === 201 && held.data?.status === 'ready',
            `${held.status} / ${held.data?.status}`);

        let free = await LibraryBookCopy.find({ book: plentyId, status: 'available' }).lean();
        const walkIssue = await POST('/library/issue', { as: admin, body: { bookId: plentyId, copyId: sid(free[0]), userId: sid(walker._id) } });
        check('🔒 A walk-in is served while spare copies remain', walkIssue.status === 201,
            `status ${walkIssue.status} ${walkIssue.message || ''}`);

        // Take it down to exactly one free copy, which the hold is entitled to.
        free = await LibraryBookCopy.find({ book: plentyId, status: 'available' }).lean();
        const spare1 = await makeUser('Spare One', 'student', schoolId);
        const spare2 = await makeUser('Spare Two', 'student', schoolId);
        await POST('/library/issue', { as: admin, body: { bookId: plentyId, copyId: sid(free[0]), userId: sid(spare1._id) } });
        free = await LibraryBookCopy.find({ book: plentyId, status: 'available' }).lean();
        check('One copy left on the shelf', free.length === 1, `${free.length} free`);

        const lastCopy = await POST('/library/issue', { as: admin, body: { bookId: plentyId, copyId: sid(free[0]), userId: sid(spare2._id) } });
        check('🔒 The last copy is protected for the person holding it', lastCopy.status === 400, `status ${lastCopy.status}`);
        check('… and the refusal says who it is for', /being held for/i.test(lastCopy.message || ''), lastCopy.message);

        const collected = await POST('/library/issue', { as: admin, body: { bookId: plentyId, copyId: sid(free[0]), userId: sid(holder._id) } });
        check('… while the person who reserved it can collect', collected.status === 201,
            `status ${collected.status} ${collected.message || ''}`);
        const closedHold = await LibraryReservation.findById(sid(held.data)).lean();
        check('… and their hold closes as collected', closedHold?.status === 'collected', closedHold?.status);

        section('Reservations carry the copy to hand over');
        const handBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Hand Over` } });
        const handId = sid(handBook.data);
        await POST(`/library/books/${handId}/copies`, { as: admin, body: { count: 2 } });
        const waiter1 = await makeUser('Waiter One', 'student', schoolId);
        const waiter2 = await makeUser('Waiter Two', 'student', schoolId);
        await POST(`/library/student/books/${handId}/reserve`, { as: waiter1 });
        await POST(`/library/student/books/${handId}/reserve`, { as: waiter2 });

        const resList = await GET('/library/reservations?status=ready', { as: admin });
        const mine = (resList.data || []).filter(r => sid(r.book) === handId || r.book?._id === handId);
        check('Each ready row names a copy to give out', mine.length >= 2 && mine.every(r => !!r.availableCopy),
            JSON.stringify(mine.map(r => r.availableCopy?.uniqueCode)));
        check('… and two people are offered two different copies',
            new Set(mine.map(r => r.availableCopy?.uniqueCode)).size === mine.length,
            mine.map(r => r.availableCopy?.uniqueCode).join(','));

        const handOver = await POST('/library/issue', { as: admin, body: {
            bookId: handId, copyId: sid(mine[0].availableCopy), userId: sid(mine[0].reservedBy),
        } });
        check('🔒 The copy offered on the reservation row can be issued', handOver.status === 201,
            `status ${handOver.status} ${handOver.message || ''}`);

        section('Renewal rules');
        const renewIss = await LibraryIssuance.findOne({ book: qBookId, status: 'issued' }).lean();
        const renewBlocked = await POST(`/library/issuances/${sid(renewIss)}/renew`, { as: admin });
        check('Cannot renew while someone is queued', renewBlocked.status === 400, `status ${renewBlocked.status}`);
        for (const q of await LibraryReservation.find({ book: qBookId, status: { $in: ['pending', 'ready'] } }).lean()) {
            await DEL(`/library/reservations/${sid(q)}`, { as: admin });
        }
        const renewOk = await POST(`/library/issuances/${sid(renewIss)}/renew`, { as: admin });
        check('Renews once the queue is clear', renewOk.status === 200, `status ${renewOk.status} ${renewOk.message || ''}`);
        const renewAgain = await POST(`/library/issuances/${sid(renewIss)}/renew`, { as: admin });
        check('Cannot renew past the policy maximum', renewAgain.status === 400, `status ${renewAgain.status}`);

        await LibraryIssuance.updateOne({ _id: sid(renewIss) }, { dueDate: new Date(Date.now() - 86400000) });
        const renewLate = await POST(`/library/issuances/${sid(renewIss)}/renew`, { as: admin });
        check('An overdue loan cannot be renewed', renewLate.status === 400, `status ${renewLate.status}`);

        section('A book in use cannot be deleted');
        const delLoaned = await DEL(`/library/books/${qBookId}`, { as: admin });
        check('Refuses while a copy is on loan', delLoaned.status === 400, `status ${delLoaned.status}`);
        const openIss = await LibraryIssuance.findOne({ book: qBookId, status: { $in: ['issued', 'overdue'] } }).lean();
        await POST('/library/return', { as: admin, body: { issuanceId: sid(openIss) } });
        await POST(`/library/student/books/${qBookId}/reserve`, { as: limitStudent });
        const delReserved = await DEL(`/library/books/${qBookId}`, { as: admin });
        check('Refuses while someone is queued for it', delReserved.status === 400, `status ${delReserved.status}`);

        section('Reservations cannot be marked ready out of turn');
        const holdBook = await POST('/library/books', { as: admin, body: { title: `${TAG} No Copies Yet` } });
        const holdId = sid(holdBook.data);
        const reserveEmpty = await POST(`/library/student/books/${holdId}/reserve`, { as: student });
        check('Cannot reserve a book with no copies at all', reserveEmpty.status === 400, `status ${reserveEmpty.status}`);

        await POST(`/library/books/${holdId}/copies`, { as: admin, body: { count: 1 } });
        const hCopy = (await LibraryBookCopy.find({ book: holdId }).lean())[0];
        await POST('/library/issue', { as: admin, body: { bookId: holdId, copyId: sid(hCopy), userId: sid(student._id) } });
        const q1 = await POST(`/library/student/books/${holdId}/reserve`, { as: student2 });
        const q2 = await POST(`/library/student/books/${holdId}/reserve`, { as: limitStudent });
        const readyNoCopy = await POST(`/library/reservations/${sid(q1.data)}/mark-ready`, { as: admin });
        check('Cannot mark ready while every copy is out', readyNoCopy.status === 400, `status ${readyNoCopy.status}`);

        const backIss = await LibraryIssuance.findOne({ book: holdId, status: 'issued' }).lean();
        await POST('/library/return', { as: admin, body: { issuanceId: sid(backIss) } });
        const readySkip = await POST(`/library/reservations/${sid(q2.data)}/mark-ready`, { as: admin });
        check('Cannot mark ready for someone further down the queue', [400, 404].includes(readySkip.status), `status ${readySkip.status}`);

        section('Reservation limits');
        const maxRes = await PUT('/library/policy', { as: admin, body: { maxReservationsPerUser: 1 } });
        check('Policy accepted', maxRes.status === 200, `status ${maxRes.status}`);
        const overRes = await POST(`/library/student/books/${loanId}/reserve`, { as: limitStudent });
        check('Refused past the reservation limit', overRes.status === 400, `status ${overRes.status}`);
        check('Refusal states the limit', /maximum 1 reservation/i.test(overRes.message || ''), overRes.message);
        await PUT('/library/policy', { as: admin, body: { maxReservationsPerUser: 3 } });

        section('Policy values are validated');
        const badPolicies = [
            [{ maxBooksPerUser: 'abc' }, 'non-numeric max books'],
            [{ maxBooksPerUser: -1 }, 'negative max books'],
            [{ maxBooksPerUser: 0 }, 'zero max books'],
            [{ issueDurationDays: 0 }, 'zero issue duration'],
            [{ issueDurationDays: 9999 }, 'absurd issue duration'],
            [{ finePerDay: -5 }, 'negative fine'],
            [{ gracePeriodDays: 1.5 }, 'fractional grace period'],
            [{ maxRenewals: -1 }, 'negative renewals'],
            [{ reservationExpiryDays: 0 }, 'zero reservation expiry'],
        ];
        for (const [body, label] of badPolicies) {
            const r = await PUT('/library/policy', { as: admin, body });
            check(`Rejects ${label}`, r.status === 400, `status ${r.status}`);
        }
        const policyNow = await GET('/library/policy', { as: admin });
        check('A rejected update changed nothing', Number.isInteger(policyNow.data?.maxBooksPerUser) && policyNow.data.maxBooksPerUser > 0,
            String(policyNow.data?.maxBooksPerUser));

        section('Permissions');
        const asStudent = await GET('/library/books', { as: student });
        check('A student cannot reach the librarian book list', asStudent.status === 403, `status ${asStudent.status}`);
        const studentIssue = await POST('/library/issue', { as: student, body: { bookId: loanId, copyId: sid(qCopy), userId: sid(student._id) } });
        check('A student cannot issue books to themselves', studentIssue.status === 403, `status ${studentIssue.status}`);
        const studentAddCopy = await POST(`/library/books/${loanId}/copies`, { as: student, body: { count: 5 } });
        check('A student cannot add copies', studentAddCopy.status === 403, `status ${studentAddCopy.status}`);
        const studentPolicy = await PUT('/library/policy', { as: student, body: { finePerDay: 0 } });
        check('A student cannot rewrite the policy', studentPolicy.status === 403, `status ${studentPolicy.status}`);
        const teacherPolicy = await PUT('/library/policy', { as: teacher, body: { finePerDay: 0 } });
        check('A plain teacher cannot rewrite the policy', teacherPolicy.status === 403, `status ${teacherPolicy.status}`);
        const teacherAudit = await GET('/library/audit-log', { as: teacher });
        check('A plain teacher cannot read the audit log', teacherAudit.status === 403, `status ${teacherAudit.status}`);
        const noToken = await GET('/library/books');
        check('An unauthenticated request is refused', [401, 403].includes(noToken.status), `status ${noToken.status}`);

        const othersReservation = await LibraryReservation.findOne({ reservedBy: sid(limitStudent._id), status: { $in: ['pending', 'ready'] } }).lean();
        if (othersReservation) {
            const steal = await DEL(`/library/student/reservations/${sid(othersReservation)}`, { as: student2 });
            check("A student cannot cancel someone else's reservation", steal.status === 404, `status ${steal.status}`);
        } else {
            check("A student cannot cancel someone else's reservation", true, 'no reservation to test against');
        }

        section('Paging is bounded');
        const huge = await GET('/library/books?limit=100000', { as: admin });
        check('An enormous limit is clamped', (huge.data?.length ?? 0) <= 100, `${huge.data?.length} rows`);
        const negPage = await GET('/library/books?page=-3&limit=abc', { as: admin });
        check('Nonsense paging still returns page 1', negPage.body?.page === 1, String(negPage.body?.page));

        // ══ TIME-DRIVEN STATE & FINE TYPES ════════════════════════════════════

        section('Loans actually become overdue');
        await PUT('/library/policy', { as: admin, body: { maxBooksPerUser: 10, blockIssueOnOverdue: false, blockIssueOnPendingFine: false, finePerDay: 2, gracePeriodDays: 0 } });
        const odBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Overdue Watch` } });
        const odId = sid(odBook.data);
        await POST(`/library/books/${odId}/copies`, { as: admin, body: { count: 3 } });
        const odStudent = await makeUser('Overdue Watcher', 'student', schoolId);
        let odCopies = await LibraryBookCopy.find({ book: odId, status: 'available' }).lean();
        await POST('/library/issue', { as: admin, body: { bookId: odId, copyId: sid(odCopies[0]), userId: sid(odStudent._id) } });

        const odIss = await LibraryIssuance.findOne({ book: odId, issuedTo: sid(odStudent._id) }).lean();
        await LibraryIssuance.updateOne({ _id: sid(odIss) }, { dueDate: new Date(Date.now() - 4 * 86400000) });

        const beforeSweep = await LibraryIssuance.findOne({ _id: sid(odIss) }).lean();
        check('Still flagged issued before anyone looks', beforeSweep.status === 'issued', beforeSweep.status);

        const issList = await GET('/library/issuances?status=overdue', { as: admin });
        check('🔒 The overdue list is no longer permanently empty', (issList.data || []).some(i => sid(i) === sid(odIss)),
            `${(issList.data || []).length} rows`);
        const afterSweep = await LibraryIssuance.findOne({ _id: sid(odIss) }).lean();
        check('The loan was flagged overdue', afterSweep.status === 'overdue', afterSweep.status);

        const dash = await GET('/library/dashboard', { as: admin });
        check('The dashboard overdue tile counts it', (dash.data?.overdue ?? 0) >= 1, String(dash.data?.overdue));

        section('An overdue loan is still findable at the return desk');
        const rtCopies = await LibraryBookCopy.find({ book: odId, status: 'available' }).lean();
        await POST('/library/issue', { as: admin, body: { bookId: odId, copyId: sid(rtCopies[0]), userId: sid(student2._id) } });
        const rtIss = await LibraryIssuance.findOne({ book: odId, issuedTo: sid(student2._id), status: { $in: ['issued', 'overdue'] } }).lean();
        await LibraryIssuance.updateOne({ _id: sid(rtIss) }, { dueDate: new Date(Date.now() - 9 * 86400000) });
        await GET('/library/dashboard', { as: admin });   // trips the sweep
        const desk = await GET(`/library/return?userId=${sid(student2._id)}`, { as: admin });
        check('🔒 The overdue loan appears in the return search', (desk.data?.issuances || []).some(i => sid(i) === sid(rtIss)),
            `${(desk.data?.issuances || []).length} rows`);
        const deskReturn = await POST('/library/return', { as: admin, body: { issuanceId: sid(rtIss) } });
        check('… and can be returned from there', deskReturn.status === 200, `status ${deskReturn.status}`);

        section('Uncollected holds actually expire');
        const holdBook2 = await POST('/library/books', { as: admin, body: { title: `${TAG} Hold Lapse` } });
        const hb = sid(holdBook2.data);
        await POST(`/library/books/${hb}/copies`, { as: admin, body: { count: 1 } });
        const hbCopy = (await LibraryBookCopy.find({ book: hb }).lean())[0];
        const noShow  = await makeUser('No Show', 'student', schoolId);
        const nextUp  = await makeUser('Next In Line', 'student', schoolId);

        await POST('/library/issue', { as: admin, body: { bookId: hb, copyId: sid(hbCopy), userId: sid(odStudent._id) } });
        const hold1 = await POST(`/library/student/books/${hb}/reserve`, { as: noShow });
        const hold2 = await POST(`/library/student/books/${hb}/reserve`, { as: nextUp });
        check('Two people queued', hold1.status === 201 && hold2.status === 201, `${hold1.status}/${hold2.status}`);

        const hbIss = await LibraryIssuance.findOne({ book: hb, status: { $in: ['issued', 'overdue'] } }).lean();
        await POST('/library/return', { as: admin, body: { issuanceId: sid(hbIss) } });
        const readyNow = await LibraryReservation.findOne({ _id: sid(hold1.data) }).lean();
        check('Front of the queue was called', readyNow.status === 'ready', readyNow.status);
        check('… with a real collection deadline', !!readyNow.expiresAt && !Number.isNaN(new Date(readyNow.expiresAt).getTime()),
            String(readyNow.expiresAt));

        // Walk the deadline into the past — the no-show never came.
        await LibraryReservation.updateOne({ _id: sid(hold1.data) }, { expiresAt: new Date(Date.now() - 86400000) });

        const walkIn = await makeUser('Walk In', 'student', schoolId);
        const blockedByGhost = await GET('/library/reservations', { as: admin });
        check('Reservation list ran the sweep', blockedByGhost.status === 200);
        const lapsed = await LibraryReservation.findOne({ _id: sid(hold1.data) }).lean();
        check('🔒 The uncollected hold expired', lapsed.status === 'expired', lapsed.status);
        const calledUp = await LibraryReservation.findOne({ _id: sid(hold2.data) }).lean();
        check('The next person was called up', calledUp.status === 'ready', calledUp.status);

        // And the copy is no longer frozen behind a hold nobody honoured.
        await LibraryReservation.updateOne({ _id: sid(hold2.data) }, { expiresAt: new Date(Date.now() - 86400000) });
        const freed = await POST('/library/issue', { as: admin, body: { bookId: hb, copyId: sid(hbCopy), userId: sid(walkIn._id) } });
        check('🔒 A copy is not frozen forever by holds nobody collected', freed.status === 201,
            `status ${freed.status} ${freed.message || ''}`);

        section('The "fines apply to teachers" switch actually does something');
        await PUT('/library/policy', { as: admin, body: { teacherFinesEnabled: false, finePerDay: 5, gracePeriodDays: 0 } });
        const tfBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Teacher Fines` } });
        const tf = sid(tfBook.data);
        await POST(`/library/books/${tf}/copies`, { as: admin, body: { count: 2 } });

        const lateLoan = async (who) => {
            const copy = (await LibraryBookCopy.find({ book: tf, status: 'available' }).lean())[0];
            await POST('/library/issue', { as: admin, body: { bookId: tf, copyId: sid(copy), userId: sid(who._id) } });
            const iss = await LibraryIssuance.findOne({ book: tf, issuedTo: sid(who._id), status: { $in: ['issued', 'overdue'] } }).lean();
            await LibraryIssuance.updateOne({ _id: sid(iss) }, { dueDate: new Date(Date.now() - 6 * 86400000) });
            return POST('/library/return', { as: admin, body: { issuanceId: sid(iss) } });
        };

        const teacherReturn = await lateLoan(teacher);
        check('🔒 A teacher is exempt when the switch is off', !teacherReturn.data?.fine,
            JSON.stringify(teacherReturn.data?.fine));
        const studentReturn = await lateLoan(walkIn);
        check('A student is still fined', (studentReturn.data?.fine?.amount || 0) > 0,
            JSON.stringify(studentReturn.data?.fine));

        await PUT('/library/policy', { as: admin, body: { teacherFinesEnabled: true } });
        const teacherReturn2 = await lateLoan(teacher);
        check('Turning the switch on fines the teacher', (teacherReturn2.data?.fine?.amount || 0) > 0,
            JSON.stringify(teacherReturn2.data?.fine));

        section('Lost and damaged books are charged for');
        await PUT('/library/policy', { as: admin, body: { finePerDay: 5, lostBookFineDays: 30, damagedBookFineDays: 10, gracePeriodDays: 0 } });
        const dmgBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Fragile` } });
        const dmg = sid(dmgBook.data);
        // One per scenario, plus the copy the refused-condition case leaves out on loan.
        await POST(`/library/books/${dmg}/copies`, { as: admin, body: { count: 6 } });

        const loanOut = async (who) => {
            const copy = (await LibraryBookCopy.find({ book: dmg, status: 'available' }).lean())[0];
            if (!copy) throw new Error('fixture exhausted: no available copy left to loan out');
            await POST('/library/issue', { as: admin, body: { bookId: dmg, copyId: sid(copy), userId: sid(who._id) } });
            const iss = await LibraryIssuance.findOne({ book: dmg, issuedTo: sid(who._id), status: { $in: ['issued', 'overdue'] } }).lean();
            return { iss: sid(iss), copyId: sid(copy) };
        };

        const badCondition = await POST('/library/return', { as: admin, body: { issuanceId: sid((await loanOut(walkIn)).iss), condition: 'chewed' } });
        check('An unknown return condition is refused', badCondition.status === 400, `status ${badCondition.status}`);

        const beforeLost = await LibraryBook.findById(dmg).lean();
        const lostLoan = await loanOut(odStudent);
        const lostRet = await POST('/library/return', { as: admin, body: { issuanceId: lostLoan.iss, condition: 'lost' } });
        check('Lost return accepted', lostRet.status === 200, `status ${lostRet.status} ${lostRet.message || ''}`);
        check('🔒 A lost book raises a fine of 30 × the daily rate', lostRet.data?.fine?.amount === 150,
            String(lostRet.data?.fine?.amount));
        check('… typed as a loss, not a late return', lostRet.data?.fine?.fineType === 'lost', lostRet.data?.fine?.fineType);
        const lostCopy = await LibraryBookCopy.findById(lostLoan.copyId).lean();
        check('The copy is marked lost, not put back on the shelf', lostCopy.status === 'lost', lostCopy.status);
        const lostIss = await LibraryIssuance.findById(lostLoan.iss).lean();
        check('The issuance closes as lost', lostIss.status === 'lost', lostIss.status);
        const afterLost = await LibraryBook.findById(dmg).lean();
        check('availableCopies did not gain a book that no longer exists',
            afterLost.availableCopies === beforeLost.availableCopies - 1,
            `${beforeLost.availableCopies} → ${afterLost.availableCopies}`);

        const dmgLoan = await loanOut(nextUp);
        await LibraryIssuance.updateOne({ _id: dmgLoan.iss }, { dueDate: new Date(Date.now() - 3 * 86400000) });
        const dmgRet = await POST('/library/return', { as: admin, body: { issuanceId: dmgLoan.iss, condition: 'damaged' } });
        check('Damaged return accepted', dmgRet.status === 200, `status ${dmgRet.status}`);
        // calcFine rounds a part-day up, so derive the late half from what the
        // server actually counted rather than assuming a whole number of days.
        const expectedDmg = 10 * 5 + (dmgRet.data?.fine?.daysOverdue || 0) * 5;
        check('🔒 Damage is charged on top of the late fine', dmgRet.data?.fine?.amount === expectedDmg,
            `₹${dmgRet.data?.fine?.amount} (expected ₹${expectedDmg})`);
        check('… and the damage half is the larger part', (dmgRet.data?.fine?.amount || 0) > (dmgRet.data?.fine?.daysOverdue || 0) * 5,
            String(dmgRet.data?.fine?.amount));
        check('… typed as damage', dmgRet.data?.fine?.fineType === 'damaged', dmgRet.data?.fine?.fineType);
        const dmgCopy = await LibraryBookCopy.findById(dmgLoan.copyId).lean();
        check('The damaged copy stays off the shelf', dmgCopy.status === 'damaged', dmgCopy.status);

        const goodLoan = await loanOut(walkIn);
        const goodRet = await POST('/library/return', { as: admin, body: { issuanceId: goodLoan.iss } });
        check('An on-time good return still costs nothing', !goodRet.data?.fine, JSON.stringify(goodRet.data?.fine));
        const goodCopy = await LibraryBookCopy.findById(goodLoan.copyId).lean();
        check('… and the copy goes back on the shelf', goodCopy.status === 'available', goodCopy.status);

        // ══ MEMBER LOOKUP, SCANNING, REPORTS ══════════════════════════════════

        section('The counter can find a person by name');
        const found = await GET(`/library/members?q=${encodeURIComponent('Lib Student')}`, { as: admin });
        check('Search by name returns the member', found.status === 200 && (found.data || []).some(m => sid(m) === sid(student._id)),
            `${(found.data || []).length} hits`);
        const row = (found.data || []).find(m => sid(m) === sid(student._id));
        check('… carrying the loan count the librarian needs', Number.isInteger(row?.booksOut), JSON.stringify(row));
        check('… and what they owe', typeof row?.finesDue === 'number', String(row?.finesDue));

        const noParents = await GET(`/library/members?q=${encodeURIComponent('Lib Parent')}`, { as: admin });
        check('Non-borrowing roles are not offered', !(noParents.data || []).some(m => m.role === 'parent'),
            JSON.stringify((noParents.data || []).map(m => m.role)));
        const tooShort = await GET('/library/members?q=a', { as: admin });
        check('A one-character query is not run', (tooShort.data || []).length === 0);
        const memberByStudent = await GET('/library/members?q=Lib', { as: student });
        check('A student cannot search the member list', memberByStudent.status === 403, `status ${memberByStudent.status}`);

        section('Copy codes scan');
        const scanBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Scannable` } });
        const scanId = sid(scanBook.data);
        await POST(`/library/books/${scanId}/copies`, { as: admin, body: { count: 1, rackLocation: 'S-01' } });
        const scanCopy = (await LibraryBookCopy.find({ book: scanId }).lean())[0];

        const scanFree = await GET(`/library/scan?code=${scanCopy.uniqueCode}`, { as: admin });
        check('A shelf copy scans as ready to issue', scanFree.data?.action === 'issue', scanFree.data?.action);
        check('… and names the book', scanFree.data?.book?.title === `${TAG} Scannable`, scanFree.data?.book?.title);

        await POST('/library/issue', { as: admin, body: { bookId: scanId, copyId: sid(scanCopy), userId: sid(student2._id) } });
        const scanOut = await GET(`/library/scan?code=${scanCopy.uniqueCode}`, { as: admin });
        check('An issued copy scans as ready to return', scanOut.data?.action === 'return', scanOut.data?.action);
        check('… and names who has it', scanOut.data?.issuance?.issuedTo?.name === 'Lib Student Two',
            scanOut.data?.issuance?.issuedTo?.name);
        const scanMissing = await GET('/library/scan?code=LIB-COPY-999999', { as: admin });
        check('An unknown code is refused clearly', scanMissing.status === 404, `status ${scanMissing.status}`);

        section('Labels print');
        const barcodeRes = await fetch(`${BASE}/library/books/${scanId}/copies/${sid(scanCopy)}/barcode`, {
            headers: { Authorization: `Bearer ${token(admin)}` },
        });
        const svg = await barcodeRes.text();
        check('A copy renders a barcode', barcodeRes.status === 200 && svg.startsWith('<svg'), `status ${barcodeRes.status}`);
        check('… as real bars, not an empty frame', (svg.match(/<rect /g) || []).length > 20,
            `${(svg.match(/<rect /g) || []).length} bars`);

        const sheetRes = await fetch(`${BASE}/library/books/${scanId}/labels`, {
            headers: { Authorization: `Bearer ${token(admin)}` },
        });
        const sheet = await sheetRes.text();
        check('A label sheet prints for the whole book', sheetRes.status === 200 && sheet.includes(scanCopy.uniqueCode),
            `status ${sheetRes.status}`);

        section('The accession register records where a book came from');
        const accBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Purchased` } });
        const accId = sid(accBook.data);
        await POST(`/library/books/${accId}/copies`, { as: admin, body: {
            count: 2, vendor: 'Higginbothams', billNumber: 'INV-4471', cost: 425, acquisitionDate: '2026-04-11',
        } });
        const accCopies = await LibraryBookCopy.find({ book: accId }).lean();
        check('Vendor, bill and cost land on each copy',
            accCopies.every(c => c.vendor === 'Higginbothams' && c.billNumber === 'INV-4471' && Number(c.cost) === 425),
            JSON.stringify(accCopies.map(c => ({ v: c.vendor, b: c.billNumber, c: c.cost }))));

        const register = await GET('/library/reports/accession', { as: admin });
        check('The register lists them', register.status === 200 && register.data.some(r => r['Bill no'] === 'INV-4471'));
        check('… and totals what the collection cost', (register.body?.value || 0) >= 850, String(register.body?.value));

        const badCost = await PUT(`/library/books/${accId}/copies/${sid(accCopies[0])}`, { as: admin, body: { cost: -5 } });
        check('A negative cost is refused', badCost.status === 400, `status ${badCost.status}`);

        section('Reports answer the questions a librarian is asked');
        const reportIndex = await GET('/library/reports', { as: admin });
        check('The server lists its own reports', (reportIndex.data || []).length === 7, `${(reportIndex.data || []).length}`);

        const overdueReport = await GET('/library/reports/overdue', { as: admin });
        check('Overdue register runs', overdueReport.status === 200 && Array.isArray(overdueReport.data));
        check('… and every row is genuinely late', (overdueReport.data || []).every(r => r['Days late'] >= 0));

        const popular = await GET('/library/reports/popular', { as: admin });
        check('Most borrowed runs', popular.status === 200 && Array.isArray(popular.data));
        check('… sorted by loan count', (popular.data || []).every((r, i, a) => i === 0 || a[i - 1].Loans >= r.Loans));

        const dead = await GET('/library/reports/dead-stock', { as: admin });
        check('Dead stock runs', dead.status === 200 && Array.isArray(dead.data));
        check('… and includes a book nobody has borrowed',
            (dead.data || []).some(r => r['Loans ever'] === 0), `${(dead.data || []).length} rows`);

        const history = await GET(`/library/reports/member?userId=${sid(student._id)}`, { as: admin });
        check('Member history runs', history.status === 200 && Array.isArray(history.data));
        check('… with a summary of what they owe', typeof history.body?.summary?.finesPending === 'number',
            JSON.stringify(history.body?.summary));
        const noMember = await GET('/library/reports/member', { as: admin });
        check('Member history needs a member', noMember.status === 400, `status ${noMember.status}`);

        const stock = await GET('/library/reports/stock-take', { as: admin });
        check('Stock take runs', stock.status === 200 && Array.isArray(stock.data));
        check('… and marks issued copies as not on the shelf',
            (stock.data || []).filter(r => r.Status === 'issued').every(r => r['Expected on shelf'] === 'no'));

        const ledger = await GET('/library/reports/fines', { as: admin });
        check('Fine ledger runs', ledger.status === 200 && Array.isArray(ledger.data));
        check('… and totals by state', typeof ledger.body?.summary?.pending === 'number', JSON.stringify(ledger.body?.summary));

        const xlsxRes = await fetch(`${BASE}/library/reports/accession?format=xlsx`, {
            headers: { Authorization: `Bearer ${token(admin)}` },
        });
        const xbuf = Buffer.from(await xlsxRes.arrayBuffer());
        check('Any report exports as a spreadsheet', xlsxRes.status === 200 && xbuf.slice(0, 2).toString() === 'PK',
            `status ${xlsxRes.status}, ${xbuf.length} bytes`);
        const reportsByStudent = await GET('/library/reports/accession', { as: student });
        check('A student cannot read reports', reportsByStudent.status === 403, `status ${reportsByStudent.status}`);

        section('Members can renew their own loan');
        const selfBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Self Renew` } });
        const selfId = sid(selfBook.data);
        await POST(`/library/books/${selfId}/copies`, { as: admin, body: { count: 1 } });
        const selfCopy = (await LibraryBookCopy.find({ book: selfId }).lean())[0];
        await PUT('/library/policy', { as: admin, body: { maxRenewals: 2, maxBooksPerUser: 10, blockIssueOnPendingFine: false, blockIssueOnOverdue: false } });
        await POST('/library/issue', { as: admin, body: { bookId: selfId, copyId: sid(selfCopy), userId: sid(student._id) } });
        const selfIss = await LibraryIssuance.findOne({ book: selfId, status: 'issued' }).lean();

        const beforeDue = new Date(selfIss.dueDate).getTime();
        const selfRenew = await POST(`/library/student/issuances/${sid(selfIss)}/renew`, { as: student });
        check('🔒 A student can extend their own loan', selfRenew.status === 200, `status ${selfRenew.status} ${selfRenew.message || ''}`);
        check('… and the due date actually moved', new Date(selfRenew.data.dueDate).getTime() > beforeDue);

        const stealRenew = await POST(`/library/student/issuances/${sid(selfIss)}/renew`, { as: student2 });
        check("A student cannot renew somebody else's loan", stealRenew.status === 404, `status ${stealRenew.status}`);

        section('Teachers can join a queue, not just leave one');
        const tRes = await POST(`/library/teacher/books/${selfId}/reserve`, { as: teacher });
        check('🔒 A teacher can reserve a book', tRes.status === 201, `status ${tRes.status} ${tRes.message || ''}`);
        check('… and is told where they stand', Number.isInteger(tRes.data?.queuePosition), String(tRes.data?.queuePosition));
        const tCancel = await DEL(`/library/teacher/reservations/${sid(tRes.data)}`, { as: teacher });
        check('… and can still cancel it', tCancel.status === 200, `status ${tCancel.status}`);

        section('The queue numbers itself, even under a race');
        const raceBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Contested` } });
        const raceId = sid(raceBook.data);
        await POST(`/library/books/${raceId}/copies`, { as: admin, body: { count: 1 } });
        const raceCopy = (await LibraryBookCopy.find({ book: raceId }).lean())[0];
        await POST('/library/issue', { as: admin, body: { bookId: raceId, copyId: sid(raceCopy), userId: sid(student._id) } });

        const racers = [];
        for (let i = 0; i < 4; i++) racers.push(await makeUser(`Racer ${i}`, 'student', schoolId));
        const placed = await Promise.all(racers.map(r => POST(`/library/student/books/${raceId}/reserve`, { as: r })));
        check('All four reservations were accepted', placed.every(p => p.status === 201), placed.map(p => p.status).join(','));
        const finalQueue = await LibraryReservation.find({ book: raceId, status: 'pending' }).sort({ queuePosition: 1 }).lean();
        check('🔒 Positions are 1..n with no duplicates',
            finalQueue.map(q => q.queuePosition).join(',') === finalQueue.map((_, i) => i + 1).join(','),
            finalQueue.map(q => q.queuePosition).join(','));

        section('Stock check can charge for a copy found missing');
        await PUT('/library/policy', { as: admin, body: { finePerDay: 5, lostBookFineDays: 30 } });
        const missBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Missing At Count` } });
        const missId = sid(missBook.data);
        await POST(`/library/books/${missId}/copies`, { as: admin, body: { count: 2 } });
        let missCopies = await LibraryBookCopy.find({ book: missId, status: 'available' }).lean();

        const noBorrower = await PATCH(`/library/books/${missId}/copies/${sid(missCopies[0])}/status`,
            { as: admin, body: { status: 'lost', chargeLastBorrower: true } });
        check('Refuses to charge when nobody ever borrowed it', noBorrower.status === 400, `status ${noBorrower.status}`);

        await POST('/library/issue', { as: admin, body: { bookId: missId, copyId: sid(missCopies[1]), userId: sid(student2._id) } });
        const backIss2 = await LibraryIssuance.findOne({ bookCopy: sid(missCopies[1]), status: 'issued' }).lean();
        await POST('/library/return', { as: admin, body: { issuanceId: sid(backIss2) } });

        const charged = await PATCH(`/library/books/${missId}/copies/${sid(missCopies[1])}/status`,
            { as: admin, body: { status: 'lost', chargeLastBorrower: true } });
        check('🔒 A copy lost at stock check charges its last borrower', charged.body?.fine?.amount === 150,
            String(charged.body?.fine?.amount));
        check('… typed as a loss', charged.body?.fine?.fineType === 'lost', charged.body?.fine?.fineType);
        const writtenOff = await LibraryBookCopy.findById(sid(missCopies[1])).lean();
        check('… and stamped as written off', !!writtenOff.writtenOffAt, String(writtenOff.writtenOffAt));

        const quiet = await PATCH(`/library/books/${missId}/copies/${sid(missCopies[0])}/status`,
            { as: admin, body: { status: 'damaged' } });
        check('Writing off without charging raises no fine', quiet.status === 200 && !quiet.body?.fine);

        section('The copy list is paged, not dumped');
        const bigBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Class Set` } });
        const bigId = sid(bigBook.data);
        await POST(`/library/books/${bigId}/copies`, { as: admin, body: { count: 40 } });
        const firstPage = await GET(`/library/books/${bigId}`, { as: admin });
        check('A 40-copy book returns one page, not forty rows', (firstPage.data?.copies || []).length === 25,
            `${(firstPage.data?.copies || []).length} rows`);
        check('… and says how many pages there are', firstPage.body?.pages === 2, String(firstPage.body?.pages));
        check('… with a status breakdown for the whole book', firstPage.data?.breakdown?.available === 40,
            JSON.stringify(firstPage.data?.breakdown));
        const secondPage = await GET(`/library/books/${bigId}?page=2`, { as: admin });
        check('Page two is reachable', (secondPage.data?.copies || []).length === 15, `${(secondPage.data?.copies || []).length} rows`);
        const filtered = await GET(`/library/books/${bigId}?status=lost`, { as: admin });
        check('The copy list filters by status', (filtered.data?.copies || []).length === 0);

        section('Due-date reminders go out before the due date');
        const remBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Due Soon` } });
        const remId = sid(remBook.data);
        await POST(`/library/books/${remId}/copies`, { as: admin, body: { count: 1 } });
        const remCopy = (await LibraryBookCopy.find({ book: remId }).lean())[0];
        await POST('/library/issue', { as: admin, body: { bookId: remId, copyId: sid(remCopy), userId: sid(student._id) } });
        const remIss = await LibraryIssuance.findOne({ book: remId, status: 'issued' }).lean();
        await LibraryIssuance.updateOne({ _id: sid(remIss) }, { dueDate: new Date(Date.now() + 36 * 3600000) });

        const libraryRules = require('../services/libraryRules');
        const sent = await libraryRules.sendDueSoonReminders(schoolId);
        check('🔒 A book due in 36 hours triggers a reminder', sent >= 1, `${sent} sent`);
        const stamped = await LibraryIssuance.findById(sid(remIss)).lean();
        check('… stamped with the date it warned about', !!stamped.dueSoonNotifiedFor, String(stamped.dueSoonNotifiedFor));
        const again = await libraryRules.sendDueSoonReminders(schoolId);
        check('… and never sent twice for the same due date', again === 0, `${again} sent on the second pass`);

        await POST(`/library/student/issuances/${sid(remIss)}/renew`, { as: student });
        const afterRenew = await LibraryIssuance.findById(sid(remIss)).lean();
        check('A renewal re-arms the reminder for the new date', afterRenew.dueSoonNotifiedFor === null,
            String(afterRenew.dueSoonNotifiedFor));

        // ══ NOTIFICATIONS OVER THE WEBSOCKET GATEWAY ══════════════════════════

        section('Library events reach the member live');
        const wsUp = await startWsCapture();
        check('Subscribed to the gateway channels', wsUp === true, 'REDIS_URL not set — cannot verify live delivery');

        await PUT('/library/policy', { as: admin, body: {
            maxBooksPerUser: 20, maxRenewals: 3, finePerDay: 5, gracePeriodDays: 0,
            blockIssueOnPendingFine: false, blockIssueOnOverdue: false,
        } });
        const notifyBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Notified` } });
        const nbId = sid(notifyBook.data);
        await POST(`/library/books/${nbId}/copies`, { as: admin, body: { count: 2 } });
        const reader = await makeUser('Notified Reader', 'student', schoolId);
        let nbCopies = await LibraryBookCopy.find({ book: nbId, status: 'available' }).lean();

        wsEvents.length = 0; wsCounts.length = 0;
        await POST('/library/issue', { as: admin, body: { bookId: nbId, copyId: sid(nbCopies[0]), userId: sid(reader._id) } });
        await settle();
        check('🔒 Issuing pushes a live notification', pushesTo(reader._id, /issued to you/i).length === 1,
            `${pushesTo(reader._id).length} push(es)`);
        check('… and refreshes their unread badge', wsCounts.some(c => c.userId === sid(reader._id)),
            JSON.stringify(wsCounts.slice(0, 3)));
        check('… carrying the body, not just an id',
            /Due date/i.test(pushesTo(reader._id, /issued to you/i)[0]?.data?.body || ''),
            pushesTo(reader._id, /issued to you/i)[0]?.data?.body);

        const nbIss = await LibraryIssuance.findOne({ book: nbId, issuedTo: sid(reader._id), status: 'issued' }).lean();

        wsEvents.length = 0;
        const renewPush = await POST(`/library/student/issuances/${sid(nbIss)}/renew`, { as: reader });
        await settle();
        check('Renewing confirms the new due date live', renewPush.status === 200 && pushesTo(reader._id, /renewed/i).length === 1,
            `${pushesTo(reader._id).length} push(es)`);

        wsEvents.length = 0;
        await LibraryIssuance.updateOne({ _id: sid(nbIss) }, { status: 'issued', dueDate: new Date(Date.now() - 3 * 86400000) });
        const flipped = await libraryRules.sweepOverdue(schoolId);
        await settle();
        check('🔒 Going overdue tells the borrower', flipped >= 1 && pushesTo(reader._id, /overdue/i).length === 1,
            `${flipped} flipped, ${pushesTo(reader._id, /overdue/i).length} push(es)`);
        check('… naming the fine rate so it is actionable',
            /₹5 a day/.test(pushesTo(reader._id, /overdue/i)[0]?.data?.body || ''),
            pushesTo(reader._id, /overdue/i)[0]?.data?.body);

        wsEvents.length = 0;
        await libraryRules.sweepOverdue(schoolId);
        await settle();
        check('… and never says it twice', pushesTo(reader._id, /overdue/i).length === 0,
            `${pushesTo(reader._id, /overdue/i).length} repeat push(es)`);

        wsEvents.length = 0;
        const overdueReturn = await POST('/library/return', { as: admin, body: { issuanceId: sid(nbIss) } });
        await settle();
        check('Returning late pushes the fine notice', overdueReturn.status === 200 && pushesTo(reader._id, /return recorded/i).length === 1,
            `${pushesTo(reader._id).length} push(es)`);

        const lateFine = await LibraryFine.findOne({ user: sid(reader._id), status: 'pending' }).lean();
        wsEvents.length = 0;
        await POST(`/library/fines/${sid(lateFine)}/collect`, { as: admin });
        await settle();
        check('Paying a fine is confirmed live', pushesTo(reader._id, /fine paid/i).length === 1,
            `${pushesTo(reader._id).length} push(es)`);

        section('Queue events reach the people waiting');
        const qBook2 = await POST('/library/books', { as: admin, body: { title: `${TAG} Queued Notify` } });
        const qb = sid(qBook2.data);
        await POST(`/library/books/${qb}/copies`, { as: admin, body: { count: 1 } });
        const qCopy2 = (await LibraryBookCopy.find({ book: qb }).lean())[0];
        const inLine1 = await makeUser('First In Line', 'student', schoolId);
        const inLine2 = await makeUser('Second In Line', 'student', schoolId);
        await POST('/library/issue', { as: admin, body: { bookId: qb, copyId: sid(qCopy2), userId: sid(reader._id) } });

        wsEvents.length = 0;
        const joined = await POST(`/library/student/books/${qb}/reserve`, { as: inLine1 });
        await settle();
        check('Placing a reservation confirms the queue position', pushesTo(inLine1._id, /reservation placed/i).length === 1,
            `${pushesTo(inLine1._id).length} push(es)`);
        check('… stating where they stand',
            /number 1 in the queue/i.test(pushesTo(inLine1._id, /reservation placed/i)[0]?.data?.body || ''),
            pushesTo(inLine1._id, /reservation placed/i)[0]?.data?.body);

        await POST(`/library/student/books/${qb}/reserve`, { as: inLine2 });
        const qIss = await LibraryIssuance.findOne({ book: qb, status: { $in: ['issued', 'overdue'] } }).lean();

        wsEvents.length = 0;
        await POST('/library/return', { as: admin, body: { issuanceId: sid(qIss) } });
        await settle();
        check('🔒 The next in line is told their book is ready', pushesTo(inLine1._id, /reserved book available/i).length === 1,
            `${pushesTo(inLine1._id).length} push(es)`);

        // Let the hold lapse — the member must hear that they lost it.
        await LibraryReservation.updateOne({ _id: sid(joined.data) }, { expiresAt: new Date(Date.now() - 86400000) });
        wsEvents.length = 0;
        await GET('/library/reservations', { as: admin });
        await settle();
        check('🔒 Losing an uncollected hold is announced', pushesTo(inLine1._id, /no longer held/i).length === 1,
            `${pushesTo(inLine1._id).length} push(es)`);
        check('… and the copy passes to the next person', pushesTo(inLine2._id, /reserved book available/i).length === 1,
            `${pushesTo(inLine2._id).length} push(es)`);

        wsEvents.length = 0;
        const secondRes = await LibraryReservation.findOne({ book: qb, reservedBy: sid(inLine2._id) }).lean();
        await DEL(`/library/reservations/${sid(secondRes)}`, { as: admin, body: { reason: 'Copy withdrawn for rebinding' } });
        await settle();
        check('🔒 A librarian cancelling a reservation tells the member', pushesTo(inLine2._id, /reservation cancelled/i).length === 1,
            `${pushesTo(inLine2._id).length} push(es)`);
        check('… including the reason given',
            /rebinding/i.test(pushesTo(inLine2._id, /reservation cancelled/i)[0]?.data?.body || ''),
            pushesTo(inLine2._id, /reservation cancelled/i)[0]?.data?.body);

        section('Due-soon reminders go out live');
        const soonBook = await POST('/library/books', { as: admin, body: { title: `${TAG} Nearly Due` } });
        const sb = sid(soonBook.data);
        await POST(`/library/books/${sb}/copies`, { as: admin, body: { count: 1 } });
        const sbCopy = (await LibraryBookCopy.find({ book: sb }).lean())[0];
        await POST('/library/issue', { as: admin, body: { bookId: sb, copyId: sid(sbCopy), userId: sid(reader._id) } });
        const sbIss = await LibraryIssuance.findOne({ book: sb, status: 'issued' }).lean();
        await LibraryIssuance.updateOne({ _id: sid(sbIss) }, { dueDate: new Date(Date.now() + 30 * 3600000) });

        wsEvents.length = 0;
        await libraryRules.sendDueSoonReminders(schoolId);
        await settle();
        check('A book due tomorrow nudges the borrower', pushesTo(reader._id, /due soon/i).length === 1,
            `${pushesTo(reader._id).length} push(es)`);

        section('Notifications are stored, not only pushed');
        const stored = await Notification.find({ school: schoolId }).lean();
        check('Every push has a persisted notification', stored.length >= 8, `${stored.length} stored`);
        const receipts = await NotificationReceipt.find({ recipient: sid(reader._id) }).lean();
        check('… with a receipt per recipient, so the bell survives a reload',
            receipts.length >= 5, `${receipts.length} receipts`);

        section('Catalogue import and export round-trip');
        const cat = await fetch(`${BASE}/library/books/export`, { headers: { Authorization: `Bearer ${token(admin)}` } });
        const catBuf = Buffer.from(await cat.arrayBuffer());
        check('The catalogue exports as a spreadsheet', cat.status === 200 && catBuf.slice(0, 2).toString() === 'PK',
            `status ${cat.status}, ${catBuf.length} bytes`);
        const catRows = XLSX.utils.sheet_to_json(XLSX.read(catBuf, { type: 'buffer' }).Sheets.library_catalogue);
        check('… with a row per book', catRows.length >= 5, `${catRows.length} rows`);
        check('… using the same column names as the import template',
            ['title', 'isbn', 'authors', 'copies'].every(c => c in (catRows[0] || {})),
            Object.keys(catRows[0] || {}).join(','));

        const filteredCat = await fetch(`${BASE}/library/books/export?q=${encodeURIComponent(`${TAG} Physics`)}`,
            { headers: { Authorization: `Bearer ${token(admin)}` } });
        const fRows = XLSX.utils.sheet_to_json(
            XLSX.read(Buffer.from(await filteredCat.arrayBuffer()), { type: 'buffer' }).Sheets.library_catalogue);
        check('🔒 The export honours the filter on screen', fRows.length === 1 && /Physics/.test(fRows[0].title),
            `${fRows.length} rows`);

        // An exported sheet fed back in is the commonest real import, and every
        // row already exists — so it should import nothing and say why.
        const reimport = new FormData();
        reimport.append('file', new Blob([catBuf]), 'catalogue.xlsx');
        const reimported = await (await fetch(`${BASE}/library/books/bulk-upload`, {
            method: 'POST', headers: { Authorization: `Bearer ${token(admin)}` }, body: reimport,
        })).json();
        check('🔒 Re-importing an export creates no duplicates', reimported?.imported === 0, `imported ${reimported?.imported}`);
        check('… and reports every row as already present',
            (reimported?.skipped || []).length === catRows.length, `${(reimported?.skipped || []).length} skipped`);

        section('Circulation filters by who borrowed');
        const roleFiltered = await GET('/library/issuances?role=teacher', { as: admin });
        check('Filtering by role returns only that role',
            (roleFiltered.data || []).length > 0 && (roleFiltered.data || []).every(i => i.issuedToRole === 'teacher'),
            [...new Set((roleFiltered.data || []).map(i => i.issuedToRole))].join(','));
        const studentsOnly = await GET('/library/issuances?role=student', { as: admin });
        check('… and the student filter excludes staff',
            (studentsOnly.data || []).every(i => i.issuedToRole === 'student'),
            [...new Set((studentsOnly.data || []).map(i => i.issuedToRole))].join(','));

        const classes = await GET('/library/classes', { as: admin });
        check('The class list is reachable by a librarian', classes.status === 200 && Array.isArray(classes.data));
        const classByStudent = await GET(`/library/issuances?classId=${sid(admin._id)}`, { as: admin });
        check('An unknown class returns nothing rather than everything',
            (classByStudent.data || []).length === 0, `${(classByStudent.data || []).length} rows`);

        const legacy = await LibraryIssuance.findOne({ school: schoolId }).lean();
        await LibraryIssuance.updateOne({ _id: sid(legacy) }, { issuedToRole: '' });
        const filled = await libraryRules.backfillIssuedToRole(schoolId);
        check('Loans written before the role was recorded are backfilled', filled >= 1, `${filled} filled`);
        const healed = await LibraryIssuance.findById(sid(legacy)).lean();
        check('… from the user record itself', !!healed.issuedToRole, healed.issuedToRole);
        check('… and a second pass has nothing left to do',
            (await libraryRules.backfillIssuedToRole(schoolId)) === 0);

        section('Circulation exports what is on screen');
        const circExport = await fetch(`${BASE}/library/issuances?status=returned&format=xlsx`,
            { headers: { Authorization: `Bearer ${token(admin)}` } });
        const circBuf = Buffer.from(await circExport.arrayBuffer());
        check('The issue register exports', circExport.status === 200 && circBuf.slice(0, 2).toString() === 'PK',
            `status ${circExport.status}`);
        const circRows = XLSX.utils.sheet_to_json(XLSX.read(circBuf, { type: 'buffer' }).Sheets.library_circulation);
        check('… only the filtered rows', circRows.length > 0 && circRows.every(r => r.Status === 'returned'),
            [...new Set(circRows.map(r => r.Status))].join(','));
        check('… naming the member and the copy',
            ['Book', 'Copy', 'Member', 'Due', 'Status'].every(c => c in (circRows[0] || {})),
            Object.keys(circRows[0] || {}).join(','));
        const circByStudent = await GET('/library/issuances?format=xlsx', { as: student });
        check('A student cannot export the register', circByStudent.status === 403, `status ${circByStudent.status}`);

        section('The fines page answers "what is outstanding"');
        const fineList = await GET('/library/fines', { as: admin });
        check('Fines come back with totals for the whole filtered set',
            !!fineList.body?.summary?.total, JSON.stringify(fineList.body?.summary));

        const sum = fineList.body.summary;
        check('… split by state', ['pending', 'paid', 'waived'].every(k => typeof sum[k]?.amount === 'number'),
            JSON.stringify(sum));
        check('… and the total is the sum of the parts',
            sum.total.amount === sum.pending.amount + sum.paid.amount + sum.waived.amount,
            `${sum.total.amount} vs ${sum.pending.amount}+${sum.paid.amount}+${sum.waived.amount}`);
        check('… counting rows too', sum.total.count === sum.pending.count + sum.paid.count + sum.waived.count,
            `${sum.total.count}`);

        // The totals describe everything matching the filter, not the 20 rows
        // on screen — that is the whole point of showing them.
        const onePage = await GET('/library/fines?limit=1', { as: admin });
        check('🔒 Totals cover the filter, not just the visible page',
            (onePage.data || []).length === 1 && onePage.body.summary.total.count === sum.total.count,
            `${onePage.body?.summary?.total?.count} vs ${sum.total.count}`);

        const paidOnly = await GET('/library/fines?status=paid', { as: admin });
        check('Filtering by state narrows the totals with the list',
            paidOnly.body.summary.pending.amount === 0 && paidOnly.body.summary.waived.amount === 0,
            JSON.stringify(paidOnly.body?.summary));
        check('… and every row matches', (paidOnly.data || []).every(f => f.status === 'paid'));

        const lostOnly = await GET('/library/fines?fineType=lost', { as: admin });
        check('Filtering by charge type works',
            (lostOnly.data || []).every(f => f.fineType === 'lost'),
            [...new Set((lostOnly.data || []).map(f => f.fineType))].join(','));

        const byRole = await GET('/library/fines?role=teacher', { as: admin });
        check('Filtering by role works', byRole.status === 200 && Array.isArray(byRole.data));

        const future = await GET(`/library/fines?from=${new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)}`, { as: admin });
        check('A window with nothing in it reports zero, not everything',
            (future.data || []).length === 0 && future.body.summary.total.amount === 0,
            JSON.stringify(future.body?.summary));

        const wideWindow = await GET(`/library/fines?from=2020-01-01&to=${new Date().toISOString().slice(0, 10)}`, { as: admin });
        check('A window covering today includes today\'s fines',
            wideWindow.body.summary.total.count === sum.total.count,
            `${wideWindow.body?.summary?.total?.count} vs ${sum.total.count}`);

        const fineSheet = await fetch(`${BASE}/library/fines?format=xlsx`, { headers: { Authorization: `Bearer ${token(admin)}` } });
        const fineBuf = Buffer.from(await fineSheet.arrayBuffer());
        const fineRows = XLSX.utils.sheet_to_json(XLSX.read(fineBuf, { type: 'buffer' }).Sheets.library_fines);
        check('The fines register exports as a workbook', fineSheet.status === 200 && fineRows.length > 0,
            `${fineRows.length} rows`);
        check('… naming who owes what and why',
            ['Member', 'Type', 'Amount', 'Status', 'Waiver reason'].every(c => c in (fineRows[0] || {})),
            Object.keys(fineRows[0] || {}).join(','));
        const finesByStudent = await GET('/library/fines', { as: student });
        check('A student cannot read the fines register', finesByStudent.status === 403, `status ${finesByStudent.status}`);

        section('Both registers filter to one named member');
        // The desk question is almost always about a person, so the member
        // filter has to narrow the list, the totals, and the export alike.
        const subject = sid(student._id);

        const theirLoans = await GET(`/library/issuances?userId=${subject}`, { as: admin });
        check('Circulation narrows to that member',
            (theirLoans.data || []).length > 0 && (theirLoans.data || []).every(i => sid(i.issuedTo) === subject),
            `${(theirLoans.data || []).length} rows`);
        const everyLoan = await GET('/library/issuances', { as: admin });
        check('… and that is fewer than everything',
            (theirLoans.body?.total ?? 0) < (everyLoan.body?.total ?? 0),
            `${theirLoans.body?.total} of ${everyLoan.body?.total}`);

        const theirFines = await GET(`/library/fines?userId=${subject}`, { as: admin });
        check('Fines narrow to that member',
            (theirFines.data || []).every(f => sid(f.user) === subject),
            `${(theirFines.data || []).length} rows`);
        check('🔒 … and the totals follow the member, not the whole school',
            theirFines.body?.summary?.total?.count === (theirFines.body?.total ?? 0),
            `${theirFines.body?.summary?.total?.count} vs ${theirFines.body?.total}`);

        // A named member is more specific than their class, so it wins — the UI
        // disables the broader controls to say so.
        const memberBeatsClass = await GET(`/library/issuances?userId=${subject}&classId=${sid(admin._id)}`, { as: admin });
        check('A named member overrides a class filter rather than cancelling out',
            (memberBeatsClass.data || []).length === (theirLoans.data || []).length,
            `${(memberBeatsClass.data || []).length} vs ${(theirLoans.data || []).length}`);

        const memberSheet = await fetch(`${BASE}/library/issuances?userId=${subject}&format=xlsx`,
            { headers: { Authorization: `Bearer ${token(admin)}` } });
        const memberRows = XLSX.utils.sheet_to_json(
            XLSX.read(Buffer.from(await memberSheet.arrayBuffer()), { type: 'buffer' }).Sheets.library_circulation);
        check('The export carries the member filter too',
            memberRows.length > 0 && new Set(memberRows.map(r => r.Member)).size === 1,
            [...new Set(memberRows.map(r => r.Member))].join(','));

        const unknownMember = await GET(`/library/issuances?userId=${sid(admin._id)}`, { as: admin });
        check('A member with nothing out returns an empty list, not everything',
            (unknownMember.data || []).length === 0, `${(unknownMember.data || []).length} rows`);

        section('Exports are actually spreadsheets, and unset filters are absent');
        // Both export buttons shipped broken for the same class of reason, so
        // these pin the two traps rather than just "the endpoint works".

        // Trap 1: an unset filter serialised as the string "undefined" and the
        // catalogue was searched for a book by that name — an empty sheet.
        const ghostFilter = await fetch(`${BASE}/library/books/export?q=undefined`,
            { headers: { Authorization: `Bearer ${token(admin)}` } });
        const ghostRows = XLSX.utils.sheet_to_json(
            XLSX.read(Buffer.from(await ghostFilter.arrayBuffer()), { type: 'buffer' }).Sheets.library_catalogue);
        check('🔒 A literal "undefined" filter matches nothing — the client must omit it',
            ghostRows.length === 0, `${ghostRows.length} rows`);

        const unfiltered = await fetch(`${BASE}/library/books/export`,
            { headers: { Authorization: `Bearer ${token(admin)}` } });
        const wholeCatalogue = XLSX.utils.sheet_to_json(
            XLSX.read(Buffer.from(await unfiltered.arrayBuffer()), { type: 'buffer' }).Sheets.library_catalogue);
        check('… while no filter at all exports the whole catalogue', wholeCatalogue.length >= 5, `${wholeCatalogue.length} rows`);

        // Trap 2: the issuance endpoint serves the screen's JSON by default, so
        // an export missing format=xlsx saved JSON under an .xlsx name.
        const asJson = await fetch(`${BASE}/library/issuances`, { headers: { Authorization: `Bearer ${token(admin)}` } });
        check('🔒 Without format=xlsx the register returns JSON, not a file',
            (asJson.headers.get('content-type') || '').includes('application/json'),
            asJson.headers.get('content-type'));

        const asSheet = await fetch(`${BASE}/library/issuances?format=xlsx`, { headers: { Authorization: `Bearer ${token(admin)}` } });
        const sheetType = asSheet.headers.get('content-type') || '';
        check('… and with it, a real spreadsheet content type',
            sheetType.includes('spreadsheetml.sheet'), sheetType);
        check('… served as an attachment',
            /attachment; filename=/.test(asSheet.headers.get('content-disposition') || ''),
            asSheet.headers.get('content-disposition'));

        // Every download the module offers must open as a workbook.
        for (const [label, url] of [
            ['catalogue',      '/library/books/export'],
            ['import template', '/library/books/bulk-upload/template'],
            ['circulation',    '/library/issuances?format=xlsx'],
            ['accession',      '/library/reports/accession?format=xlsx'],
        ]) {
            const r = await fetch(`${BASE}${url}`, { headers: { Authorization: `Bearer ${token(admin)}` } });
            const buf = Buffer.from(await r.arrayBuffer());
            let opens = false;
            try { opens = XLSX.read(buf, { type: 'buffer' }).SheetNames.length > 0; } catch { opens = false; }
            check(`The ${label} download opens as a workbook`, r.status === 200 && opens,
                `status ${r.status}, ${buf.length} bytes`);
        }

        section('Every copy action is on the audit trail');
        const auditTypes = (await LibraryAuditLog.find({ school: schoolId }).lean()).map(a => a.actionType);
        // One row per batch now, not one per copy — the count is the number of
        // add-copies calls the run made, not the number of copies created.
        check('COPY_ADDED logged once per batch', auditTypes.filter(t => t === 'COPY_ADDED').length >= 8,
            `${auditTypes.filter(t => t === 'COPY_ADDED').length}`);
        const batchRow = (await LibraryAuditLog.find({ school: schoolId, actionType: 'COPY_ADDED' }).lean())
            .find(a => (a.newValue?.count || 0) > 1);
        check('… and the batch row records the code range', !!batchRow?.newValue?.codes, JSON.stringify(batchRow?.newValue));
        check('COPY_UPDATED logged', auditTypes.includes('COPY_UPDATED'));
        check('COPY_STATUS_CHANGED logged', auditTypes.includes('COPY_STATUS_CHANGED'));
        check('COPY_DELETED logged', auditTypes.includes('COPY_DELETED'));

        section('Audit retention and cursor paging');
        const logPage = await GET('/library/audit-log?limit=5', { as: admin });
        check('The audit log pages by cursor', (logPage.data || []).length === 5 && !!logPage.body?.nextCursor,
            `${(logPage.data || []).length} rows, cursor ${logPage.body?.nextCursor}`);
        const logNext = await GET(`/library/audit-log?limit=5&before=${encodeURIComponent(logPage.body.nextCursor)}`, { as: admin });
        check('… and the next page is strictly older',
            (logNext.data || []).every(r => new Date(r.timestamp) <= new Date(logPage.body.nextCursor)));
        const pruned = await libraryRules.pruneAuditLog(schoolId, 400);
        check('Retention leaves recent rows alone', pruned === 0, `${pruned} pruned`);
        const prunedAll = await libraryRules.pruneAuditLog(schoolId, 0);
        check('… and prunes when the window closes', prunedAll > 0, `${prunedAll} pruned`);

    } catch (e) {
        failed += 1;
        results.push(`\n  💥 Test run threw: ${e.stack || e.message}`);
    } finally {
        if (wsSub) { try { await wsSub.quit(); } catch { /* already closed */ } }
        if (f) { try { await cleanup(f); } catch (e) { console.error('cleanup failed:', e.message); } }
        server.close();
    }

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  LIBRARY COPIES — END-TO-END TESTS');
    console.log('══════════════════════════════════════════════════════════');
    console.log(results.join('\n'));
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('══════════════════════════════════════════════════════════\n');
    process.exit(failed ? 1 : 0);
})();
