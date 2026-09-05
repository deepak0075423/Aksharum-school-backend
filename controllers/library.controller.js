'use strict';
const LibraryBook        = require('../models/LibraryBook');
const LibraryBookCopy    = require('../models/LibraryBookCopy');
const LibraryIssuance    = require('../models/LibraryIssuance');
const LibraryReservation = require('../models/LibraryReservation');
const LibraryFine        = require('../models/LibraryFine');
const LibraryPolicy      = require('../models/LibraryPolicy');
const LibraryAuditLog    = require('../models/LibraryAuditLog');
const XLSX               = require('xlsx');
const User               = require('../models/User');
const StudentProfile     = require('../models/StudentProfile');
const pool               = require('../db/pool');
const { getCacheRedis }  = require('../config/cacheRedis');
const School             = require('../models/School');
const { barcodeSvg, labelSheetHtml } = require('../services/barcode');
const { wantsXlsx, sendXlsx, day }   = require('../services/libraryExport');
const Class                          = require('../models/Class');
const ClassSection                   = require('../models/ClassSection');
const TeacherProfile     = require('../models/TeacherProfile');
const { notify }         = require('../services/notifyService');
const {
    MAX_COPIES_PER_ADD, COPY_STATUSES, ACTIVE_ISSUANCE, MAX_LOAN_DAYS,
    fmtLibDate, getOrCreatePolicy, audit, reserveCopyCodes, bumpBookCounts,
    normIsbn, normText, isValidIsbn, findDuplicateBook, duplicateResponse,
    checkBorrowerEligibility, buildCopy, calcFine, reindexQueue,
    sweepOverdue, expireStaleHolds, promoteQueue, fineApplies, renewIssuance,
    BORROWER_ROLES, commitIssue, commitReturn, borrowerAudience, nextFineReceiptNumber,
    outstandingOf, fineStatusFor, ACTIVE_RESERVATION, notifyLibraryStaff,
    attachFineSummary,
} = require('../services/libraryRules');

// How a book can come back over the counter.
const RETURN_CONDITIONS = ['good', 'damaged', 'lost'];

/** Who hears about money owed by this user — the student and their parents. */
async function audienceForUser(schoolId, userId) {
    const user = await User.findOne({ _id: userId, school: schoolId }).select('role').lean();
    return borrowerAudience({ issuedTo: userId, issuedToRole: user?.role || '' });
}
// Statuses that take a copy out of the collection rather than off the shelf.
const WRITE_OFF_STATUSES = ['lost', 'damaged'];
// Mirrors the LibraryFine enum.
const FINE_TYPES = ['late_return', 'lost', 'damaged'];
// A factory, not a constant: spreading a shared object copies only the top
// level, leaving every caller pointing at the same nested totals.
const emptyFineSummary = () => ({
    pending: { amount: 0, count: 0 },
    paid:    { amount: 0, count: 0 },
    waived:  { amount: 0, count: 0 },
    total:   { amount: 0, count: 0 },
});
// Dashboard tiles are counts of slow-moving things; a minute stale is fine.
const DASH_TTL = 60;

/** Page/limit from a query string, clamped so `?limit=999999` cannot be used to pull the table. */
function paging(query, defaultLimit = 20) {
    const page  = Math.max(1, Math.floor(Number(query.page)  || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || defaultLimit)));
    return { page, limit, skip: (page - 1) * limit };
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

exports.getDashboard = async (req, res) => {
    try {
        await Promise.all([
            sweepOverdue(req.schoolId),
            expireStaleHolds(req.schoolId, null, { actor: req.userId, actorRole: req.userRole }),
        ]);

        // The tiles were six countDocuments round trips on every load, for
        // numbers that barely move. One grouped query, cached briefly per
        // school — the recent-activity list below stays live.
        const redis = getCacheRedis();
        // v2: the reservation tile changed meaning (queued → queued + held) and
        // the fine total became outstanding rather than as-charged, so cached
        // v1 payloads would keep serving the old numbers for a minute.
        const key   = `lib:dash:v2:${req.schoolId}`;
        let tiles = null;
        if (redis) {
            try {
                const raw = await redis.get(key);
                if (raw) tiles = JSON.parse(raw);
            } catch { /* fall through to the database */ }
        }

        if (!tiles) {
            const { rows } = await pool.query(
                `SELECT
                   (SELECT count(*) FROM "${LibraryBook.tableName}"        WHERE "school" = $1)                                  AS "totalBooks",
                   (SELECT count(*) FROM "${LibraryBookCopy.tableName}"    WHERE "school" = $1)                                  AS "totalCopies",
                   (SELECT count(*) FROM "${LibraryBookCopy.tableName}"    WHERE "school" = $1 AND "status" = 'issued')          AS "issuedCopies",
                   (SELECT count(*) FROM "${LibraryIssuance.tableName}"    WHERE "school" = $1 AND "status" = 'overdue')         AS "overdue",
                   (SELECT count(*) FROM "${LibraryReservation.tableName}" WHERE "school" = $1 AND "status" = ANY($2::text[]))    AS "reservations",
                   (SELECT count(*) FROM "${LibraryFine.tableName}"        WHERE "school" = $1 AND "status" = 'pending')         AS "pendingFines",
                   (SELECT COALESCE(sum("amount" - COALESCE("waivedAmount", 0) - COALESCE("paidAmount", 0)), 0)
                      FROM "${LibraryFine.tableName}" WHERE "school" = $1 AND "status" = 'pending')                              AS "pendingFineTotal"`,
                [String(req.schoolId), ACTIVE_RESERVATION],
            );
            tiles = Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
            if (redis) {
                try { await redis.set(key, JSON.stringify(tiles), 'EX', DASH_TTL); } catch { /* best effort */ }
            }
        }

        const recent = await LibraryIssuance.find({ school: req.schoolId })
            .populate('book',    'title')
            .populate('issuedTo','name')
            .sort({ issueDate: -1 })
            .limit(10)
            .lean();

        res.json({ success: true, data: { ...tiles, recent } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Books ─────────────────────────────────────────────────────────────────────

exports.getBooks = async (req, res) => {
    try {
        const { q, category } = req.query;
        const { page, limit, skip } = paging(req.query);
        const filter = { school: req.schoolId };
        if (category) filter.category = category;
        if (q) filter.$or = [{ title: { $regex: q, $options: 'i' } }, { isbn: { $regex: q, $options: 'i' } }];

        const [books, total] = await Promise.all([
            LibraryBook.find(filter).sort({ title: 1 }).skip(skip).limit(limit).lean(),
            LibraryBook.countDocuments(filter),
        ]);
        res.json({ success: true, data: books, total, page, pages: Math.ceil(total / limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createBook = async (req, res) => {
    try {
        const { title, isbn, authors, publisher, category, edition, language, description } = req.body;
        if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required' });
        if (title.trim().length > 300) return res.status(400).json({ success: false, message: 'Title is too long (max 300 characters)' });
        if (isbn && !isValidIsbn(isbn))
            return res.status(400).json({ success: false, message: 'ISBN must be 10 or 13 digits (hyphens and spaces are fine)' });

        const dup = await findDuplicateBook(req.schoolId, { title, isbn, edition });
        if (dup) return duplicateResponse(res, dup);

        const book = await LibraryBook.create({
            school: req.schoolId, title: title.trim(), isbn: isbn || '',
            authors: authors || [], publisher: publisher || '', category: category || '',
            edition: edition || '', language: language || 'English', description: description || '',
            createdBy: req.userId,
        });
        audit(req.schoolId, req.userId, req.userRole, 'BOOK_CREATED', 'Book', book._id, null, book.toObject());
        res.status(201).json({ success: true, data: book });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getBookDetail = async (req, res) => {
    try {
        const book = await LibraryBook.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!book) return res.status(404).json({ success: false, message: 'Book not found' });

        // A class-set textbook can have hundreds of copies. Ship a page of them
        // plus a status breakdown, so the screen can show where the stock is
        // without sending every row to render one table.
        const { page, limit, skip } = paging(req.query, 25);
        const filter = { book: book._id, school: req.schoolId };
        if (COPY_STATUSES.includes(req.query.status)) filter.status = req.query.status;
        if (req.query.code) filter.uniqueCode = { $regex: String(req.query.code).trim(), $options: 'i' };

        const [copies, copyTotal, breakdownRows] = await Promise.all([
            LibraryBookCopy.find(filter).sort({ uniqueCode: 1 }).skip(skip).limit(limit).lean(),
            LibraryBookCopy.countDocuments(filter),
            pool.query(
                `SELECT "status", count(*)::int AS n FROM "${LibraryBookCopy.tableName}"
                  WHERE "book" = $1 AND "school" = $2 GROUP BY "status"`,
                [String(book._id), String(req.schoolId)],
            ),
        ]);
        const breakdown = Object.fromEntries(COPY_STATUSES.map(st => [st, 0]));
        for (const r of breakdownRows.rows) breakdown[r.status] = r.n;

        res.json({
            success: true,
            data: { ...book, copies, breakdown },
            total: copyTotal, page, pages: Math.ceil(copyTotal / limit),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updateBook = async (req, res) => {
    try {
        const old  = await LibraryBook.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!old)  return res.status(404).json({ success: false, message: 'Book not found' });
        const { title, isbn, authors, publisher, category, edition, language, description } = req.body;
        if (title !== undefined && !title?.trim())
            return res.status(400).json({ success: false, message: 'Title is required' });
        if (isbn && !isValidIsbn(isbn))
            return res.status(400).json({ success: false, message: 'ISBN must be 10 or 13 digits (hyphens and spaces are fine)' });

        // Renaming a book onto an entry that already exists is the same mistake
        // as adding it twice, so it is caught the same way.
        const dup = await findDuplicateBook(req.schoolId, {
            title:   title   !== undefined ? title   : old.title,
            isbn:    isbn    !== undefined ? isbn    : old.isbn,
            edition: edition !== undefined ? edition : old.edition,
        }, old._id);
        if (dup) return duplicateResponse(res, dup);

        const update = {};
        if (title       !== undefined) update.title       = title.trim();
        if (isbn        !== undefined) update.isbn        = isbn;
        if (authors     !== undefined) update.authors     = authors;
        if (publisher   !== undefined) update.publisher   = publisher;
        if (category    !== undefined) update.category    = category;
        if (edition     !== undefined) update.edition     = edition;
        if (language    !== undefined) update.language    = language;
        if (description !== undefined) update.description = description;

        const book = await LibraryBook.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, update, { new: true }).lean();
        if (!book) return res.status(404).json({ success: false, message: 'Book not found' });
        audit(req.schoolId, req.userId, req.userRole, 'BOOK_UPDATED', 'Book', book._id, old, book);
        res.json({ success: true, data: book });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.deleteBook = async (req, res) => {
    try {
        const book = await LibraryBook.findOne({ _id: req.params.id, school: req.schoolId });
        if (!book) return res.status(404).json({ success: false, message: 'Book not found' });
        const hasIssuance = await LibraryIssuance.exists({ book: book._id, status: { $in: ACTIVE_ISSUANCE } });
        if (hasIssuance) return res.status(400).json({ success: false, message: 'Cannot delete — copies of this book are still out on loan' });

        const hasReservation = await LibraryReservation.exists({ book: book._id, status: { $in: ['pending', 'ready'] } });
        if (hasReservation) return res.status(400).json({ success: false, message: 'Cannot delete — people are queued for this book. Cancel the reservations first' });

        const outCopy = await LibraryBookCopy.exists({ book: book._id, status: 'issued' });
        if (outCopy) return res.status(400).json({ success: false, message: 'Cannot delete — a copy is still marked as issued' });

        await Promise.all([
            LibraryBook.deleteOne({ _id: book._id }),
            LibraryBookCopy.deleteMany({ book: book._id }),
        ]);
        audit(req.schoolId, req.userId, req.userRole, 'BOOK_DELETED', 'Book', book._id, book.toObject(), null);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// The catalogue as a spreadsheet, honouring whatever the librarian has filtered
// the list down to — so "export what I am looking at" does what it says. The
// column names match the import template, so an export can be edited and fed
// straight back in.
exports.exportBooks = async (req, res) => {
    try {
        const { q, category } = req.query;
        const filter = { school: req.schoolId };
        if (category) filter.category = category;
        if (q) filter.$or = [{ title: { $regex: q, $options: 'i' } }, { isbn: { $regex: q, $options: 'i' } }];

        const books = await LibraryBook.find(filter).sort({ title: 1 }).limit(10000).lean();
        const rows = books.map(b => ({
            title:       b.title,
            isbn:        b.isbn || '',
            authors:     (b.authors || []).join(', '),
            publisher:   b.publisher || '',
            category:    b.category || '',
            edition:     b.edition || '',
            language:    b.language || '',
            description: b.description || '',
            copies:      b.totalCopies ?? 0,
            available:   b.availableCopies ?? 0,
        }));
        sendXlsx(res, 'library_catalogue', rows);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// Classes and sections, for the circulation filters. The admin endpoints that
// serve these are school_admin-only, which locks out a Librarian-designated
// teacher — the same wall the member lookup ran into.
exports.getClassList = async (req, res) => {
    try {
        const [classes, sections] = await Promise.all([
            Class.find({ school: req.schoolId }).select('className classNumber').sort({ classNumber: 1 }).lean(),
            ClassSection.find({ school: req.schoolId }).select('sectionName class').sort({ sectionName: 1 }).lean(),
        ]);
        const byClass = sections.reduce((m, s) => { (m[String(s.class)] ||= []).push({ _id: s._id, name: s.sectionName }); return m; }, {});
        res.json({
            success: true,
            data: classes.map(c => ({
                _id: c._id,
                name: c.className || `Class ${c.classNumber}`,
                sections: byClass[String(c._id)] || [],
            })),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getBulkUpload = async (req, res) => {
    res.json({ success: true, message: 'POST to /books/bulk-upload with an Excel file' });
};

exports.getBulkUploadTemplate = async (req, res) => {
    try {
        const sample = [
            { title: 'Sample Book', isbn: '978-0-123456-78-9', authors: 'Author Name', publisher: 'Publisher', category: 'Science', edition: '1st', language: 'English', description: '', copies: 3, rackLocation: 'A-01' },
        ];
        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(sample);
        XLSX.utils.book_append_sheet(wb, ws, 'Books');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="library_books_template.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.bulkUpload = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        if (!rows.length) return res.status(400).json({ success: false, message: 'File is empty' });

        // `copies` / `rackLocation` are optional; without them the import lands a
        // catalogue entry with nothing to issue, which is rarely what is wanted.
        const entries = rows.map(r => ({
            doc: {
                school:      req.schoolId,
                title:       (r.title || '').toString().trim(),
                isbn:        (r.isbn || '').toString().trim(),
                authors:     r.authors ? (r.authors + '').split(',').map(a => a.trim()) : [],
                publisher:   (r.publisher || '').toString().trim(),
                category:    (r.category || '').toString().trim(),
                edition:     (r.edition || '').toString().trim(),
                language:    (r.language || 'English').toString().trim(),
                description: (r.description || '').toString().trim(),
                createdBy:   req.userId,
            },
            copies:       Math.min(Math.max(Math.floor(Number(r.copies) || 0), 0), MAX_COPIES_PER_ADD),
            rackLocation: (r.rackLocation || '').toString().trim(),
        })).filter(e => e.doc.title);

        // A re-uploaded sheet is the commonest way a catalogue gets duplicated,
        // so skip rows that already exist (or repeat inside the sheet) and tell
        // the librarian exactly which ones were left out.
        const skipped = [];
        const accepted = [];
        const seen = new Set();
        for (const e of entries) {
            const key = normIsbn(e.doc.isbn) || `${normText(e.doc.title)}|${normText(e.doc.edition)}`;
            if (seen.has(key)) { skipped.push({ title: e.doc.title, reason: 'repeated in this file' }); continue; }
            if (e.doc.isbn && !isValidIsbn(e.doc.isbn)) { skipped.push({ title: e.doc.title, reason: 'invalid ISBN' }); continue; }
            const dup = await findDuplicateBook(req.schoolId, e.doc);
            if (dup) { skipped.push({ title: e.doc.title, reason: 'already in the catalogue' }); continue; }
            seen.add(key);
            accepted.push(e);
        }

        const created = await LibraryBook.insertMany(accepted.map(e => e.doc), { ordered: false });

        let copiesCreated = 0;
        for (let i = 0; i < created.length; i++) {
            const { copies, rackLocation } = accepted[i];
            if (!copies) continue;
            const codes = await reserveCopyCodes(req.schoolId, copies);
            await LibraryBookCopy.insertMany(
                codes.map(code => buildCopy(req.schoolId, created[i]._id, code, req.userId, { rackLocation }))
            );
            await bumpBookCounts(created[i]._id, { total: copies, available: copies });
            audit(req.schoolId, req.userId, req.userRole, 'COPY_ADDED', 'Book', created[i]._id, null,
                { count: copies, codes: `${codes[0]} … ${codes[codes.length - 1]}`, source: 'bulk import' });
            copiesCreated += copies;
        }

        res.json({ success: true, imported: created.length, copiesCreated, skipped });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Copies ────────────────────────────────────────────────────────────────────

// Accepts `count` because a library receives a title in batches — 20 copies of
// a textbook is one action, not twenty. Always responds with an array.
exports.addCopy = async (req, res) => {
    try {
        const book = await LibraryBook.findOne({ _id: req.params.id, school: req.schoolId });
        if (!book) return res.status(404).json({ success: false, message: 'Book not found' });

        const { condition, rackLocation, acquisitionDate, vendor, billNumber, cost } = req.body;
        const count = Math.floor(Number(req.body.count ?? 1));
        if (!Number.isFinite(count) || count < 1 || count > MAX_COPIES_PER_ADD)
            return res.status(400).json({ success: false, message: `Number of copies must be between 1 and ${MAX_COPIES_PER_ADD}` });

        const codes  = await reserveCopyCodes(req.schoolId, count);
        const copies = await LibraryBookCopy.insertMany(
            codes.map(code => buildCopy(req.schoolId, book._id, code, req.userId, { condition, rackLocation, acquisitionDate, vendor, billNumber, cost }))
        );

        await bumpBookCounts(book._id, { total: count, available: count });

        // One row for the batch, not one per copy — a 500-copy intake used to
        // write 500 audit rows that said the same thing.
        audit(req.schoolId, req.userId, req.userRole, 'COPY_ADDED', 'Book', book._id, null, {
            count: copies.length,
            codes: codes.length > 1 ? `${codes[0]} … ${codes[codes.length - 1]}` : codes[0],
            condition: condition || 'new', rackLocation: rackLocation || '',
            vendor: vendor || '', billNumber: billNumber || '', cost: cost || 0,
        });
        res.status(201).json({ success: true, data: copies, count: copies.length });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.editCopy = async (req, res) => {
    try {
        const old  = await LibraryBookCopy.findOne({ _id: req.params.copyId, book: req.params.id, school: req.schoolId }).lean();
        if (!old)  return res.status(404).json({ success: false, message: 'Copy not found' });

        const { condition, rackLocation, vendor, billNumber, cost, acquisitionDate } = req.body;
        const update = {};
        if (condition    !== undefined) update.condition    = condition;
        if (rackLocation !== undefined) update.rackLocation = rackLocation;
        if (vendor       !== undefined) update.vendor       = vendor;
        if (billNumber   !== undefined) update.billNumber   = billNumber;
        if (acquisitionDate !== undefined) update.acquisitionDate = acquisitionDate ? new Date(acquisitionDate) : null;
        if (cost !== undefined) {
            const n = Number(cost);
            if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, message: 'Cost must be a positive amount' });
            update.cost = n;
        }

        const copy = await LibraryBookCopy.findByIdAndUpdate(req.params.copyId, update, { new: true }).lean();
        audit(req.schoolId, req.userId, req.userRole, 'COPY_UPDATED', 'BookCopy', copy._id, old, copy);
        res.json({ success: true, data: copy });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.markCopyStatus = async (req, res) => {
    try {
        const { status } = req.body;
        if (!COPY_STATUSES.includes(status))
            return res.status(400).json({ success: false, message: `status must be one of: ${COPY_STATUSES.join(', ')}` });

        const copy = await LibraryBookCopy.findOne({ _id: req.params.copyId, book: req.params.id, school: req.schoolId });
        if (!copy) return res.status(404).json({ success: false, message: 'Copy not found' });

        // 'issued' is owned by the circulation flow — letting it be set or
        // cleared by hand would desync the copy from its issuance record.
        if (status === 'issued')
            return res.status(400).json({ success: false, message: 'Issue the copy through Circulation instead of setting this status' });
        if (copy.status === 'issued')
            return res.status(400).json({ success: false, message: 'Copy is currently issued — record the return first' });

        const oldStatus = copy.status;
        copy.status = status;
        await copy.save();

        // Sync available count
        if (oldStatus === 'available' && status !== 'available') {
            await bumpBookCounts(copy.book, { available: -1 });
        } else if (oldStatus !== 'available' && status === 'available') {
            await bumpBookCounts(copy.book, { available: 1 });
        }

        // Marking a copy lost or damaged outside a return is what happens during
        // a stock check — the moment losses are actually discovered. Charging
        // the last borrower is offered, never automatic, because the copy may
        // have sat on the shelf for a term before anyone noticed.
        let fine = null;
        if (WRITE_OFF_STATUSES.includes(status)) {
            await LibraryBookCopy.updateOne({ _id: copy._id }, { writtenOffAt: new Date() });
            if (req.body.chargeLastBorrower) {
                const last = await LibraryIssuance.findOne({ bookCopy: copy._id, school: req.schoolId })
                    .sort({ issueDate: -1 }).lean();
                if (!last) return res.status(400).json({ success: false, message: 'Nobody has ever borrowed this copy — there is no one to charge' });

                const policy = await getOrCreatePolicy(req.schoolId);
                const days   = status === 'lost' ? (policy.lostBookFineDays ?? 30) : (policy.damagedBookFineDays ?? 10);

                let amount = days * (policy.finePerDay || 0);
                if (req.body.fineAmount !== undefined && req.body.fineAmount !== '' && req.body.fineAmount !== null) {
                    const manual = Number(req.body.fineAmount);
                    if (!Number.isFinite(manual) || manual < 0)
                        return res.status(400).json({ success: false, message: 'Enter a charge of zero or more' });
                    amount = Math.round(manual * 100) / 100;
                }

                if (amount > 0) {
                    fine = await LibraryFine.create({
                        school: req.schoolId, issuance: last._id, user: last.issuedTo,
                        fineType: status, amount, daysOverdue: 0,
                    });
                    audit(req.schoolId, req.userId, req.userRole, 'FINE_GENERATED', 'Fine', fine._id, null,
                        { reason: `copy marked ${status} at stock check`, copy: copy._id, amount });
                    const bookDoc = await LibraryBook.findById(copy.book).select('title').lean().catch(() => null);
                    notify({
                        school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                        title: status === 'lost' ? '📕 Lost book charge' : '📙 Damaged book charge',
                        body: `A charge of ₹${amount} has been raised for "${bookDoc?.title || 'a library book'}" (copy ${copy.uniqueCode}).`,
                        recipients: await audienceForUser(req.schoolId, last.issuedTo),
                        link: { type: 'library.myfines' },
                    });
                    notifyLibraryStaff({
                        schoolId: req.schoolId, sender: req.userId, senderRole: req.userRole,
                        title: status === 'lost' ? '📕 Lost book charge raised' : '📙 Damaged book charge raised',
                        body: `Copy ${copy.uniqueCode} of "${bookDoc?.title || 'a library book'}" was marked ${status}`
                            + ` and a ₹${amount} charge was raised against its last borrower.`,
                        link: { type: 'library.manage.fines' },
                    });
                }
            }
        } else if (oldStatus === 'lost' || oldStatus === 'damaged') {
            // Recovered — it is back in the collection.
            await LibraryBookCopy.updateOne({ _id: copy._id }, { writtenOffAt: null });
        }

        audit(req.schoolId, req.userId, req.userRole, 'COPY_STATUS_CHANGED', 'BookCopy', copy._id, { status: oldStatus }, { status });
        res.json({ success: true, data: { ...copy.toObject?.() ?? copy, status }, fine });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.deleteCopy = async (req, res) => {
    try {
        const copy = await LibraryBookCopy.findOne({ _id: req.params.copyId, book: req.params.id, school: req.schoolId }).lean();
        if (!copy) return res.status(404).json({ success: false, message: 'Copy not found' });
        if (copy.status === 'issued')
            return res.status(400).json({ success: false, message: 'Cannot remove — copy is currently issued' });

        const active = await LibraryIssuance.exists({ bookCopy: copy._id, status: { $in: ['issued', 'overdue'] } });
        if (active) return res.status(400).json({ success: false, message: 'Cannot remove — copy has an open issuance' });

        await LibraryBookCopy.deleteOne({ _id: copy._id });

        // Only an 'available' copy was ever counted in availableCopies.
        await bumpBookCounts(copy.book, { total: -1, available: copy.status === 'available' ? -1 : 0 });

        audit(req.schoolId, req.userId, req.userRole, 'COPY_DELETED', 'BookCopy', copy._id, copy, null);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Labels & scanning ─────────────────────────────────────────────────────────

// One copy's barcode, for a detail screen or a single reprint.
exports.copyBarcode = async (req, res) => {
    try {
        const copy = await LibraryBookCopy.findOne({ _id: req.params.copyId, book: req.params.id, school: req.schoolId })
            .select('uniqueCode').lean();
        if (!copy) return res.status(404).json({ success: false, message: 'Copy not found' });
        const { svg } = barcodeSvg(copy.uniqueCode);
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(svg);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// A printable sheet for a whole book, or for one intake batch. Returns HTML the
// librarian prints from the browser — no label-printer driver in the middle.
exports.copyLabels = async (req, res) => {
    try {
        const book = await LibraryBook.findOne({ _id: req.params.id, school: req.schoolId }).select('title').lean();
        if (!book) return res.status(404).json({ success: false, message: 'Book not found' });

        const filter = { book: book._id, school: req.schoolId };
        if (COPY_STATUSES.includes(req.query.status)) filter.status = req.query.status;
        if (req.query.codes) {
            const wanted = String(req.query.codes).split(',').map(c => c.trim()).filter(Boolean);
            if (wanted.length) filter.uniqueCode = { $in: wanted };
        }

        const copies = await LibraryBookCopy.find(filter).sort({ uniqueCode: 1 }).limit(500).lean();
        if (!copies.length) return res.status(400).json({ success: false, message: 'No copies match — nothing to print' });

        const school = await School.findById(req.schoolId).select('name').lean().catch(() => null);
        const html = labelSheetHtml(
            copies.map(c => ({ code: c.uniqueCode, title: book.title, rack: c.rackLocation })),
            { schoolName: school?.name || '' },
        );
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// What the counter scanner talks to: one copy code in, everything the desk
// needs to act on it out — the book, the copy, and whoever currently has it.
exports.scanCopy = async (req, res) => {
    try {
        const code = String(req.query.code || '').trim();
        if (!code) return res.status(400).json({ success: false, message: 'Scan or type a copy code' });

        await sweepOverdue(req.schoolId);
        const copy = await LibraryBookCopy.findOne({ school: req.schoolId, uniqueCode: code }).lean();
        if (!copy) return res.status(404).json({ success: false, message: `No copy with code ${code}` });

        const [book, issuance] = await Promise.all([
            LibraryBook.findById(copy.book).select('title authors isbn availableCopies totalCopies').lean(),
            LibraryIssuance.findOne({ bookCopy: copy._id, status: { $in: ACTIVE_ISSUANCE } })
                .populate('issuedTo', 'name email role').lean(),
        ]);

        res.json({
            success: true,
            data: {
                copy, book,
                issuance: issuance || null,
                // The desk's next move, decided here so both clients agree.
                action: issuance ? 'return' : (copy.status === 'available' ? 'issue' : 'blocked'),
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Member lookup ─────────────────────────────────────────────────────────────

// The issue counter needs to find a person by name or admission number. That
// lookup used to exist only under /api/admin behind requireRole('school_admin'),
// which refuses the very Librarian-designated teacher meant to run this desk —
// so the forms had nowhere to go but a raw UUID field. This is the same search,
// scoped to what a librarian legitimately needs to see.
exports.searchMembers = async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ success: true, data: [] });

        const roleFilter = BORROWER_ROLES.includes(req.query.role) ? [req.query.role] : BORROWER_ROLES;
        const users = await User.find({
            school: req.schoolId,
            role: { $in: roleFilter },
            isActive: { $ne: false },
            $or: [
                { name:  { $regex: q, $options: 'i' } },
                { email: { $regex: q, $options: 'i' } },
            ],
        }).select('name email role').sort({ name: 1 }).limit(20).lean();

        // Admission / employee numbers live on the profiles, so a librarian
        // typing "2024/118" is searched there too and merged in.
        const [studentsByNo, staffByNo] = await Promise.all([
            roleFilter.includes('student')
                ? StudentProfile.find({ school: req.schoolId, admissionNumber: { $regex: q, $options: 'i' } })
                    .select('user admissionNumber').limit(20).lean()
                : [],
            roleFilter.includes('teacher')
                ? TeacherProfile.find({ school: req.schoolId, employeeId: { $regex: q, $options: 'i' } })
                    .select('user employeeId').limit(20).lean()
                : [],
        ]);

        const extraIds = [...studentsByNo, ...staffByNo].map(p => String(p.user))
            .filter(id => !users.some(u => String(u._id) === id));
        if (extraIds.length) {
            const extra = await User.find({ _id: { $in: extraIds }, school: req.schoolId, isActive: { $ne: false } })
                .select('name email role').lean();
            users.push(...extra);
        }
        if (!users.length) return res.json({ success: true, data: [] });

        const ids = users.map(u => u._id);
        const [profiles, staff, loans, fines] = await Promise.all([
            StudentProfile.find({ user: { $in: ids } }).select('user admissionNumber currentClass currentSection')
                .populate('currentClass', 'className classNumber').populate('currentSection', 'sectionName').lean(),
            TeacherProfile.find({ user: { $in: ids } }).select('user employeeId designation').lean(),
            LibraryIssuance.find({ school: req.schoolId, issuedTo: { $in: ids }, status: { $in: ACTIVE_ISSUANCE } }).select('issuedTo dueDate').lean(),
            LibraryFine.find({ school: req.schoolId, user: { $in: ids }, status: 'pending' }).select('user amount').lean(),
        ]);

        const byUser = (rows, key = 'user') => rows.reduce((m, r) => { (m[String(r[key])] ||= []).push(r); return m; }, {});
        const pMap = byUser(profiles), tMap = byUser(staff), lMap = byUser(loans, 'issuedTo'), fMap = byUser(fines);
        const now = new Date();

        // Loan count and fine total ride along so the librarian sees a refusal
        // coming before they fill in the rest of the form.
        const data = users.map(u => {
            const p = pMap[String(u._id)]?.[0];
            const t = tMap[String(u._id)]?.[0];
            const held = lMap[String(u._id)] || [];
            const owed = (fMap[String(u._id)] || []).reduce((sum, f) => sum + (f.amount || 0), 0);
            return {
                _id: u._id, name: u.name, role: u.role, email: u.email,
                identifier: p?.admissionNumber || t?.employeeId || '',
                detail: p
                    ? [p.currentClass?.className || (p.currentClass?.classNumber ? `Class ${p.currentClass.classNumber}` : ''),
                       p.currentSection?.sectionName].filter(Boolean).join(' · ')
                    : (t?.designation || ''),
                booksOut: held.length,
                overdue:  held.filter(i => new Date(i.dueDate) < now).length,
                finesDue: owed,
            };
        }).sort((a, b) => a.name.localeCompare(b.name));

        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Circulation ───────────────────────────────────────────────────────────────

exports.getIssueForm = async (req, res) => {
    try {
        const { bookId } = req.query;
        if (!bookId) return res.json({ success: true, data: null });
        const book  = await LibraryBook.findOne({ _id: bookId, school: req.schoolId }).lean();
        const copies = await LibraryBookCopy.find({ book: bookId, status: 'available' }).lean();
        const policy = await getOrCreatePolicy(req.schoolId);
        res.json({ success: true, data: { book, copies, policy } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.issueBook = async (req, res) => {
    try {
        const { bookId, copyId, userId, userRole, dueDate, notes } = req.body;
        if (!bookId || !copyId || !userId)
            return res.status(400).json({ success: false, message: 'bookId, copyId, userId are required' });

        const policy = await getOrCreatePolicy(req.schoolId);

        const book = await LibraryBook.findOne({ _id: bookId, school: req.schoolId }).select('title').lean();
        if (!book) return res.status(404).json({ success: false, message: 'Book not found' });

        // Everything about who may borrow what lives in one place.
        const eligible = await checkBorrowerEligibility({ schoolId: req.schoolId, userId, bookId, policy });
        if (!eligible.ok) return res.status(eligible.status).json({ success: false, message: eligible.message });

        // A hold reserves *a* copy, not *the* copy. Blocking a walk-in whenever
        // any hold exists was wrong: a title with twelve copies on the shelf and
        // one person queued can serve both. What the queue actually promises is
        // that a held copy stays held — so a walk-in is refused only once the
        // free copies are all spoken for.
        await expireStaleHolds(req.schoolId, bookId, { actor: req.userId, actorRole: req.userRole });

        const holds = await LibraryReservation.find({ school: req.schoolId, book: bookId, status: 'ready' })
            .sort({ queuePosition: 1, reservedAt: 1 }).lean();
        const ownHold    = holds.find(h => String(h.reservedBy) === String(userId));
        const otherHolds = holds.filter(h => String(h.reservedBy) !== String(userId));

        if (!ownHold && otherHolds.length) {
            // The copy being claimed right now is one of the free ones, so it
            // counts against what is left for the people already called up.
            const freeCopies = await LibraryBookCopy.countDocuments({
                school: req.schoolId, book: bookId, status: 'available' });
            if (freeCopies <= otherHolds.length) {
                const holder = await User.findById(otherHolds[0].reservedBy).select('name').lean();
                return res.status(400).json({
                    success: false,
                    message: `The last available ${freeCopies === 1 ? 'copy is' : 'copies are'} being held for ${holder?.name || 'another member'}`
                        + `${otherHolds.length > 1 ? ` and ${otherHolds.length - 1} other(s)` : ''}, who reserved ahead. Cancel the hold to reassign it.`,
                });
            }
        }
        const claim = ownHold || null;

        const computedDue = dueDate
            ? new Date(dueDate)
            : new Date(Date.now() + (policy.issueDurationDays || 14) * 86400000);
        if (Number.isNaN(computedDue.getTime()))
            return res.status(400).json({ success: false, message: 'Due date is not a valid date' });
        if (computedDue <= new Date())
            return res.status(400).json({ success: false, message: 'Due date must be in the future' });
        if (computedDue > new Date(Date.now() + MAX_LOAN_DAYS * 86400000))
            return res.status(400).json({ success: false, message: `Due date cannot be more than ${MAX_LOAN_DAYS} days out` });

        // Copy claim, issuance and the availability count move together or not
        // at all; the advisory lock inside serialises two counters working the
        // same title. A null result means another counter took the copy first.
        const issuanceId = await commitIssue({
            schoolId: req.schoolId, bookId, copyId,
            userId, userRole: eligible.user.role, issuedBy: req.userId,
            dueDate: computedDue, notes,
        });
        if (!issuanceId) return res.status(400).json({ success: false, message: 'That copy is no longer available' });
        const issuance = await LibraryIssuance.findById(issuanceId).lean();

        // Their own reservation is now fulfilled — leaving it 'ready' would
        // expire it and hold up everyone behind them in the queue.
        if (claim) {
            await LibraryReservation.updateOne({ _id: claim._id }, { status: 'collected' });
            audit(req.schoolId, req.userId, req.userRole, 'RESERVATION_COLLECTED', 'Reservation', claim._id, { status: 'ready' }, { status: 'collected' });
            await reindexQueue(req.schoolId, bookId);
        }

        audit(req.schoolId, req.userId, req.userRole, 'BOOK_ISSUED', 'Issuance', issuance._id, null, { book: bookId, user: userId });
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📚 Book issued to you',
            body: `"${book.title}" has been issued to you. Due date: ${fmtLibDate(computedDue)}.`,
            recipients: [userId],
            link: { type: 'library.mybooks' },
        });
        notifyLibraryStaff({
            schoolId: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📚 Book issued',
            body: `"${book.title}" was issued to ${eligible.user.name || 'a member'}, due ${fmtLibDate(computedDue)}.`,
            link: { type: 'library.manage.circulation' },
        });
        res.status(201).json({ success: true, data: issuance });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getReturnForm = async (req, res) => {
    try {
        // Must include 'overdue': sweepOverdue flips loans off 'issued' as soon as
        // they pass their due date, and an overdue book is precisely the one most
        // likely to be walked up to the return desk.
        await sweepOverdue(req.schoolId);

        const { userId, copyCode } = req.query;
        const filter = { school: req.schoolId, status: { $in: ACTIVE_ISSUANCE } };
        if (userId) filter.issuedTo = userId;
        if (copyCode) {
            const copy = await LibraryBookCopy.findOne({ school: req.schoolId, uniqueCode: copyCode }).lean();
            if (copy) filter.bookCopy = copy._id;
        }
        const issuances = await LibraryIssuance.find(filter)
            .populate('book',    'title isbn')
            .populate('bookCopy','uniqueCode')
            .populate('issuedTo','name email')
            .lean();
        const policy = await getOrCreatePolicy(req.schoolId);
        res.json({ success: true, data: { issuances, policy } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.returnBook = async (req, res) => {
    try {
        const { issuanceId, notes, condition = 'good' } = req.body;
        if (!issuanceId) return res.status(400).json({ success: false, message: 'issuanceId is required' });
        if (!RETURN_CONDITIONS.includes(condition))
            return res.status(400).json({ success: false, message: `condition must be one of: ${RETURN_CONDITIONS.join(', ')}` });

        const issuance = await LibraryIssuance.findOne({ _id: issuanceId, school: req.schoolId, status: { $in: ACTIVE_ISSUANCE } }).lean();
        if (!issuance) return res.status(404).json({ success: false, message: 'Issuance not found or already returned' });

        const policy   = await getOrCreatePolicy(req.schoolId);

        // The teacher exemption covers lateness only — a lost or damaged book is
        // compensation for school property, charged to everyone alike.
        const lateFine = (await fineApplies(req.schoolId, issuance, policy))
            ? await calcFine(issuance, policy)
            : 0;
        const penaltyDays = condition === 'lost'    ? (policy.lostBookFineDays ?? 30)
                          : condition === 'damaged' ? (policy.damagedBookFineDays ?? 10)
                          : 0;

        // The policy multiple is a default, not a rule. A librarian who knows
        // the book cost ₹450 should be able to charge ₹450 — the multiple was
        // only ever a stand-in for a price nobody had recorded.
        let penalty = penaltyDays * (policy.finePerDay || 0);
        if (condition !== 'good' && req.body.fineAmount !== undefined
            && req.body.fineAmount !== '' && req.body.fineAmount !== null) {
            const manual = Number(req.body.fineAmount);
            if (!Number.isFinite(manual) || manual < 0)
                return res.status(400).json({ success: false, message: 'Enter a charge of zero or more' });
            penalty = Math.round(manual * 100) / 100;
        }

        const fineAmt  = lateFine + penalty;
        const fineType = condition === 'good' ? 'late_return' : condition;

        const priorStatus = issuance.status;
        // Only a book actually back on the shelf becomes available again. A lost
        // or damaged copy stays off the shelf, so availableCopies must not move
        // — it was already excluded while the copy was out on loan.
        const copyStatus = condition === 'good' ? 'available' : condition;
        const daysOverdue = Math.max(0, Math.ceil((Date.now() - new Date(issuance.dueDate)) / 86400000));

        const settled = await commitReturn({
            schoolId: req.schoolId, issuance, condition, copyStatus,
            fineAmount: fineAmt, fineType, daysOverdue, notes,
        });
        if (!settled) return res.status(409).json({ success: false, message: 'This loan was already closed by someone else' });

        const fine = settled.fineId ? await LibraryFine.findById(settled.fineId).lean() : null;

        audit(req.schoolId, req.userId, req.userRole, 'BOOK_RETURNED', 'Issuance', issuance._id, { status: priorStatus }, { status: issuance.status, condition, fine: fine?._id });

        // Only a shelf-ready copy can be promised to the next person in the queue.
        // promoteQueue sends the "ready for pickup" notice itself.
        const [nextReservation] = condition === 'good'
            ? await promoteQueue(req.schoolId, issuance.book, policy, { actor: req.userId, actorRole: req.userRole })
            : [];

        const bookDoc = await LibraryBook.findById(issuance.book).select('title').lean().catch(() => null);
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📚 Book return recorded',
            body: `${condition === 'good' ? 'Return' : `A ${condition} copy`} of "${bookDoc?.title || 'a book'}" has been recorded.${fine ? ` A fine of ₹${fine.amount} was applied.` : ''}`,
            // A fine is the parents' business too; a clean return is not.
            recipients: fine ? await borrowerAudience(issuance) : [issuance.issuedTo],
            link: { type: fine ? 'library.myfines' : 'library.mybooks' },
        });
        const borrower = await User.findById(issuance.issuedTo).select('name').lean().catch(() => null);
        notifyLibraryStaff({
            schoolId: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: condition === 'lost'    ? '📕 Book recorded as lost'
                 : condition === 'damaged' ? '📙 Book returned damaged'
                 : '📚 Book returned',
            body: `"${bookDoc?.title || 'A book'}" from ${borrower?.name || 'a member'} was recorded as ${condition}.`
                + (fine ? ` A ₹${fine.amount} ${fine.fineType.replace(/_/g, ' ')} charge was raised.` : ''),
            link: { type: fine ? 'library.manage.fines' : 'library.manage.circulation' },
        });

        res.json({ success: true, data: { issuance, fine } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getIssuances = async (req, res) => {
    try {
        await sweepOverdue(req.schoolId);

        const { status, userId, role, classId, sectionId } = req.query;
        const { page, limit, skip } = paging(req.query);
        const filter = { school: req.schoolId };
        if (status) filter.status   = status;
        if (userId) filter.issuedTo = userId;
        if (BORROWER_ROLES.includes(role)) filter.issuedToRole = role;

        // Class and section live on the student profile, not on the loan, so
        // narrow to those students first. A class is a bounded set, so the
        // resulting id list stays small.
        //
        // Skipped entirely when one member is named: class and section are ways
        // of finding people, and naming one is more specific than describing a
        // group they might belong to. Without this an unrelated class filter
        // would empty the result instead of being superseded.
        if (!userId && (classId || sectionId)) {
            const profileFilter = { school: req.schoolId };
            if (classId)   profileFilter.currentClass   = classId;
            if (sectionId) profileFilter.currentSection = sectionId;
            const students = await StudentProfile.find(profileFilter).select('user').lean();
            const ids = students.map(p => String(p.user));
            if (!ids.length) {
                return wantsXlsx(req)
                    ? sendXlsx(res, 'library_circulation', [])
                    : res.json({ success: true, data: [], total: 0, page, pages: 0 });
            }
            filter.issuedTo = { $in: ids };
        }

        const query = () => LibraryIssuance.find(filter)
            .populate('book',    'title isbn')
            .populate('bookCopy','uniqueCode')
            .populate('issuedTo','name email')
            .populate('issuedBy','name')
            .sort({ issueDate: -1 });

        // The export is the same list without the page window — what the
        // librarian filtered down to, not just the rows currently on screen.
        if (wantsXlsx(req)) {
            const all = await attachFineSummary(await query().limit(5000).lean());
            const now = new Date();
            return sendXlsx(res, 'library_circulation', all.map(i => ({
                Book: i.book?.title || '',
                ISBN: i.book?.isbn || '',
                Copy: i.bookCopy?.uniqueCode || '',
                Member: i.issuedTo?.name || '',
                Role: i.issuedToRole || '',
                Issued: day(i.issueDate),
                Due: day(i.dueDate),
                Returned: day(i.returnDate),
                Status: i.status,
                'Days late': ACTIVE_ISSUANCE.includes(i.status) && new Date(i.dueDate) < now
                    ? Math.ceil((now - new Date(i.dueDate)) / 86400000) : 0,
                Renewals: i.renewalCount ?? 0,
                'Issued by': i.issuedBy?.name || '',
                // A closed-as-lost loan is a money record as much as a stock
                // one; the register has to carry both or it does not reconcile.
                'Fine charged':     i.fineSummary?.charged ?? 0,
                'Fine waived':      i.fineSummary?.waived ?? 0,
                'Fine paid':        i.fineSummary?.paid ?? 0,
                'Fine outstanding': i.fineSummary?.outstanding ?? 0,
                'Payment status':   i.fineSummary ? i.fineSummary.status : '',
                'Receipt':          (i.fineSummary?.receipts || []).join(', '),
            })));
        }

        const [issuances, total] = await Promise.all([
            query().skip(skip).limit(limit).lean(),
            LibraryIssuance.countDocuments(filter),
        ]);
        res.json({
            success: true, data: await attachFineSummary(issuances),
            total, page, pages: Math.ceil(total / limit),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.renewBook = async (req, res) => {
    try {
        await sweepOverdue(req.schoolId);
        const result = await renewIssuance(req.schoolId, req.params.id, { actor: req.userId, actorRole: req.userRole });
        if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

        audit(req.schoolId, req.userId, req.userRole, 'BOOK_RENEWED', 'Issuance', result.issuance._id, null,
            { newDueDate: result.issuance.dueDate, renewalCount: result.issuance.renewalCount });
        res.json({ success: true, data: result.issuance });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Reservations ──────────────────────────────────────────────────────────────

exports.getReservations = async (req, res) => {
    try {
        await expireStaleHolds(req.schoolId, null, { actor: req.userId, actorRole: req.userRole });

        const { status } = req.query;
        const { page, limit, skip } = paging(req.query);
        const filter = { school: req.schoolId };
        if (status) filter.status = status;

        const [reservations, total] = await Promise.all([
            LibraryReservation.find(filter)
                .populate('book',      'title isbn')
                .populate('reservedBy','name email')
                .sort({ queuePosition: 1, reservedAt: 1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            LibraryReservation.countDocuments(filter),
        ]);

        // The reservations screen is where a held book is actually handed over,
        // so each row carries the copy it would be given — otherwise the
        // librarian has to go and find one on the Circulation tab.
        const bookIds = [...new Set(reservations.map(r => String(r.book?._id || r.book)))];
        const freeCopies = bookIds.length
            ? await LibraryBookCopy.find({ school: req.schoolId, book: { $in: bookIds }, status: 'available' })
                .select('book uniqueCode rackLocation').sort({ uniqueCode: 1 }).lean()
            : [];
        const byBook = freeCopies.reduce((m, c) => { (m[String(c.book)] ||= []).push(c); return m; }, {});

        // Copies are offered to the queue in order, so the second person called
        // for the same title is offered the second copy, not the first.
        const taken = {};
        const data = reservations.map((r) => {
            const key  = String(r.book?._id || r.book);
            const pool = byBook[key] || [];
            let copy = null;
            if (r.status === 'ready' || r.status === 'pending') {
                const idx = taken[key] || 0;
                copy = pool[idx] || null;
                if (copy) taken[key] = idx + 1;
            }
            return { ...r, availableCopy: copy, freeCopies: pool.length };
        });

        res.json({ success: true, data, total, page, pages: Math.ceil(total / limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.markReservationReady = async (req, res) => {
    try {
        const policy = await getOrCreatePolicy(req.schoolId);

        const pending = await LibraryReservation.findOne({ _id: req.params.id, school: req.schoolId, status: 'pending' }).lean();
        if (!pending) return res.status(404).json({ success: false, message: 'Pending reservation not found' });

        // Telling someone their book is ready when no copy is free sets them up
        // for a wasted trip and an expiry they did not earn. Copies already
        // being held for other people are spoken for and do not count.
        const [freeCopies, heldFor] = await Promise.all([
            LibraryBookCopy.countDocuments({ book: pending.book, school: req.schoolId, status: 'available' }),
            LibraryReservation.countDocuments({ book: pending.book, school: req.schoolId, status: 'ready' }),
        ]);
        if (freeCopies <= heldFor)
            return res.status(400).json({ success: false, message: 'No copy is available to hold for this reservation yet' });

        // Anyone already called, or waiting further up, is served first.
        const ahead = await LibraryReservation.countDocuments({
            school: req.schoolId, book: pending.book, status: 'pending',
            queuePosition: { $lt: pending.queuePosition } });
        if (ahead || heldFor)
            return res.status(400).json({ success: false, message: 'Someone ahead in the queue is still waiting for this book' });

        const res_ = await LibraryReservation.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId, status: 'pending' },
            {
                status: 'ready', readyAt: new Date(),
                expiresAt: new Date(Date.now() + (policy.reservationExpiryDays || 2) * 86400000),
            },
            { new: true }
        ).lean();
        if (!res_) return res.status(404).json({ success: false, message: 'Pending reservation not found' });
        audit(req.schoolId, req.userId, req.userRole, 'RESERVATION_READY', 'Reservation', res_._id, null, null);
        LibraryBook.findById(res_.book).select('title').lean().then(book => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '🔖 Reserved book available',
            body: `"${book?.title || 'A book'}" you reserved is ready for pickup. Collect it before ${fmtLibDate(res_.expiresAt)}.`,
            recipients: [res_.reservedBy],
            link: { type: 'library.reservations' },
        })).catch(() => {});
        notifyLibraryStaff({
            schoolId: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '🔖 Reservation ready for collection',
            body: `A reserved copy is now being held for collection until ${fmtLibDate(res_.expiresAt)}.`,
            link: { type: 'library.manage.reservations' },
        });
        res.json({ success: true, data: res_ });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.cancelReservation = async (req, res) => {
    try {
        const reservation = await LibraryReservation.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId, status: { $in: ['pending','ready'] } },
            { status: 'cancelled' },
            { new: true }
        ).lean();
        if (!reservation) return res.status(404).json({ success: false, message: 'Reservation not found' });
        await reindexQueue(req.schoolId, reservation.book);
        audit(req.schoolId, req.userId, req.userRole, 'RESERVATION_CANCELLED', 'Reservation', reservation._id, null, { reason: req.body?.reason || '' });

        // Cancelled by the library, not by the member — they need to hear it
        // from us rather than discover their place in the queue is gone.
        const cancelledBook = await LibraryBook.findById(reservation.book).select('title').lean().catch(() => null);
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '🚫 Reservation cancelled',
            body: `Your reservation for "${cancelledBook?.title || 'a book'}" has been cancelled by the library.`
                + (req.body?.reason ? `\nReason: ${String(req.body.reason).trim()}` : ''),
            recipients: [reservation.reservedBy],
            link: { type: 'library.reservations' },
        });
        notifyLibraryStaff({
            schoolId: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '🚫 Reservation cancelled',
            body: `A reservation for "${cancelledBook?.title || 'a book'}" was cancelled by the library.`
                + (req.body?.reason ? `\nReason: ${String(req.body.reason).trim()}` : ''),
            link: { type: 'library.manage.reservations' },
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Fines ─────────────────────────────────────────────────────────────────────

exports.getFines = async (req, res) => {
    try {
        const { status, userId, fineType, role, classId, sectionId, from, to } = req.query;
        const { page, limit, skip } = paging(req.query);
        const filter = { school: req.schoolId };
        if (status)   filter.status = status;
        if (userId)   filter.user   = userId;
        if (FINE_TYPES.includes(fineType)) filter.fineType = fineType;

        // How the money came in. `paymentMode` defaults to 'cash' on every row,
        // including ones nobody has paid — so filtering on it alone would sweep
        // up every outstanding fine. Only rows where money actually moved count.
        if (['cash', 'online'].includes(req.query.paymentMode)) {
            filter.paymentMode = req.query.paymentMode;
            filter.paidAmount  = { $gt: 0 };
        }

        // A money report is usually asked for over a period — "what did we take
        // this term" — so the window is on when the fine was raised.
        const raised = {};
        if (from && !Number.isNaN(Date.parse(from))) raised.$gte = new Date(from);
        if (to   && !Number.isNaN(Date.parse(to)))   raised.$lte = new Date(`${to}T23:59:59.999Z`);
        if (Object.keys(raised).length) filter.createdAt = raised;

        // Role, class and section describe people, not fines, so narrow to the
        // matching users first — the same shape as the circulation filters, and
        // likewise superseded when one member is named.
        if (!userId && (BORROWER_ROLES.includes(role) || classId || sectionId)) {
            let ids = null;
            if (classId || sectionId) {
                const pf = { school: req.schoolId };
                if (classId)   pf.currentClass   = classId;
                if (sectionId) pf.currentSection = sectionId;
                ids = (await StudentProfile.find(pf).select('user').lean()).map(p => String(p.user));
            } else {
                ids = (await User.find({ school: req.schoolId, role }).select('_id').lean()).map(u => String(u._id));
            }
            if (!ids.length) {
                return wantsXlsx(req)
                    ? sendXlsx(res, 'library_fines', [])
                    : res.json({ success: true, data: [], total: 0, page, pages: 0, summary: emptyFineSummary() });
            }
            filter.user = { $in: ids };
        }

        const query = () => LibraryFine.find(filter)
            .populate('user',       'name email')
            .populate('issuance',   'issueDate dueDate book')
            .populate('collectedBy','name')
            .populate('waivedBy',   'name')
            .sort({ createdAt: -1 });

        if (wantsXlsx(req)) {
            const all = await query().limit(5000).lean();
            return sendXlsx(res, 'library_fines', all.map(f => ({
                Member: f.user?.name || '',
                Email: f.user?.email || '',
                Type: f.fineType,
                // Blank rather than a misleading "Cash" when nothing was paid.
                'Paid by': (f.paidAmount || 0) > 0
                    ? (f.paymentMode === 'online' ? 'Online' : 'Cash') : '',
                Receipt: f.receiptNumber || '',
                Reference: f.gatewayPaymentId || '',
                // Split the same way the fine ledger does — a single "amount"
                // stopped meaning anything once part of a fine could be waived.
                Charged: f.amount || 0,
                Waived: f.waivedAmount || 0,
                Collected: f.paidAmount || 0,
                Outstanding: outstandingOf(f),
                Status: f.status,
                'Days late': f.daysOverdue || 0,
                Raised: day(f.createdAt),
                Paid: day(f.paidAt),
                'Collected by': f.collectedBy?.name || '',
                'Waived by': f.waivedBy?.name || '',
                'Waiver reason': f.waiverReason || '',
            })));
        }

        // Totals for the whole filtered set, not just the page on screen —
        // "what is outstanding" is the question this page exists to answer.
        const [fines, total, summaryRows] = await Promise.all([
            query().skip(skip).limit(limit).lean(),
            LibraryFine.countDocuments(filter),
            LibraryFine.find(filter).select('status amount waivedAmount paidAmount').lean(),
        ]);

        // Totalled from the arithmetic rather than by status, so a part-waived
        // fine contributes its waiver to "written off" and its remainder to
        // "outstanding" — summing `amount` by status would double-count it.
        const summary = emptyFineSummary();
        for (const row of summaryRows) {
            const owed = outstandingOf(row);
            if (owed > 0)                    { summary.pending.amount += owed;                     summary.pending.count += 1; }
            if ((row.paidAmount   || 0) > 0) { summary.paid.amount    += Number(row.paidAmount);    summary.paid.count    += 1; }
            if ((row.waivedAmount || 0) > 0) { summary.waived.amount  += Number(row.waivedAmount);  summary.waived.count  += 1; }
        }
        for (const key of ['pending', 'paid', 'waived']) {
            summary.total.amount += summary[key].amount;
            summary.total.count  += summary[key].count;
        }

        res.json({ success: true, data: fines, total, page, pages: Math.ceil(total / limit), summary });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.collectFine = async (req, res) => {
    try {
        const fine = await LibraryFine.findOne({ _id: req.params.id, school: req.schoolId, status: 'pending' });
        if (!fine) return res.status(404).json({ success: false, message: 'Pending fine not found' });

        // Collects what is left after any waiver, not the amount originally
        // charged — otherwise a part-waived fine would be over-collected.
        const owed = outstandingOf(fine);
        if (owed <= 0) return res.status(400).json({ success: false, message: 'Nothing is outstanding on this fine' });

        // A counter payment gets a receipt too — a parent who pays cash should
        // walk away with the same document as one who paid on their phone.
        const receiptNumber = await nextFineReceiptNumber(req.schoolId);

        fine.paidAmount    = (fine.paidAmount || 0) + owed;
        fine.status        = fineStatusFor(fine);
        fine.paidAt        = new Date();
        fine.collectedBy   = req.userId;
        fine.paymentMode   = 'cash';
        fine.receiptNumber = receiptNumber;
        await fine.save();

        audit(req.schoolId, req.userId, req.userRole, 'FINE_PAID', 'Fine', fine._id, null,
            { status: fine.status, mode: 'cash', collected: owed, receiptNumber });
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '💳 Library fine paid',
            body: `A library fine payment of ₹${owed} has been recorded. Thank you.\nReceipt: ${receiptNumber}`,
            recipients: await audienceForUser(req.schoolId, fine.user),
            link: { type: 'library.myfines' },
        });
        const payer = await User.findById(fine.user).select('name').lean().catch(() => null);
        notifyLibraryStaff({
            schoolId: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '💵 Library fine collected at the counter',
            body: `₹${owed} was collected from ${payer?.name || 'a member'} against receipt ${receiptNumber}.`,
            link: { type: 'library.manage.fines' },
        });
        res.json({ success: true, data: { ...fine.toObject?.() ?? fine, collected: owed } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.waiveFine = async (req, res) => {
    try {
        const { reason } = req.body;
        // Waiving is writing off money owed; the audit trail is worth nothing
        // without a stated reason.
        if (!reason?.trim())
            return res.status(400).json({ success: false, message: 'A reason is required to waive a fine' });

        const fine = await LibraryFine.findOne({ _id: req.params.id, school: req.schoolId, status: 'pending' });
        if (!fine) return res.status(404).json({ success: false, message: 'Pending fine not found' });

        const owed = outstandingOf(fine);
        if (owed <= 0) return res.status(400).json({ success: false, message: 'Nothing is outstanding on this fine' });

        // Omitting the amount waives the lot, which is the common case. A
        // number waives part of it and leaves the rest payable — a librarian
        // forgiving ₹40 of ₹60 should not have to write the whole thing off.
        let waive = owed;
        if (req.body.amount !== undefined && req.body.amount !== '' && req.body.amount !== null) {
            waive = Number(req.body.amount);
            if (!Number.isFinite(waive) || waive <= 0)
                return res.status(400).json({ success: false, message: 'Enter a waiver amount greater than zero' });
            if (waive > owed)
                return res.status(400).json({ success: false, message: `Only ₹${owed} is outstanding — you cannot waive more than that` });
            waive = Math.round(waive * 100) / 100;
        }

        const before = { status: fine.status, waivedAmount: fine.waivedAmount || 0 };
        fine.waivedAmount = (fine.waivedAmount || 0) + waive;
        fine.waivedBy     = req.userId;
        // Reasons accumulate: a fine waived twice should show both.
        fine.waiverReason = [fine.waiverReason, reason.trim()].filter(Boolean).join(' · ');
        fine.status       = fineStatusFor(fine);
        await fine.save();

        const stillOwed = outstandingOf(fine);
        audit(req.schoolId, req.userId, req.userRole, 'FINE_WAIVED', 'Fine', fine._id, before,
            { status: fine.status, waived: waive, outstanding: stillOwed, reason: reason.trim() });
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: stillOwed > 0 ? '💳 Part of a library fine waived' : '💳 Library fine waived',
            body: stillOwed > 0
                ? `₹${waive} of a ₹${fine.amount} library fine has been waived. ₹${stillOwed} is still to pay.\nReason: ${reason.trim()}`
                : `A library fine of ₹${fine.amount} has been waived in full.\nReason: ${reason.trim()}`,
            recipients: await audienceForUser(req.schoolId, fine.user),
            link: { type: 'library.myfines' },
        });
        const waivedFor = await User.findById(fine.user).select('name').lean().catch(() => null);
        notifyLibraryStaff({
            schoolId: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: stillOwed > 0 ? '💳 Library fine part-waived' : '💳 Library fine waived',
            body: `₹${waive} of a ₹${fine.amount} fine for ${waivedFor?.name || 'a member'} was written off`
                + (stillOwed > 0 ? `, leaving ₹${stillOwed} to pay.` : ' in full.')
                + `\nReason: ${reason.trim()}`,
            link: { type: 'library.manage.fines' },
        });
        res.json({ success: true, data: { ...fine.toObject?.() ?? fine, outstanding: stillOwed } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Policy ────────────────────────────────────────────────────────────────────

const POLICY_NUMBERS = {
    maxBooksPerUser:        { min: 1, max: 100,  label: 'Max books per user' },
    issueDurationDays:      { min: 1, max: MAX_LOAN_DAYS, label: 'Issue duration' },
    finePerDay:             { min: 0, max: 10000, label: 'Fine per day' },
    gracePeriodDays:        { min: 0, max: 365,  label: 'Grace period' },
    maxRenewals:            { min: 0, max: 20,   label: 'Max renewals' },
    reservationExpiryDays:  { min: 1, max: 90,   label: 'Reservation expiry' },
    maxReservationsPerUser: { min: 1, max: 100,  label: 'Max reservations per user' },
    lostBookFineDays:       { min: 0, max: 3650, label: 'Lost book charge (days of fine)' },
    damagedBookFineDays:    { min: 0, max: 3650, label: 'Damaged book charge (days of fine)' },
};
const POLICY_FLAGS = ['teacherFinesEnabled', 'allowMultipleCopiesPerUser', 'blockIssueOnPendingFine', 'blockIssueOnOverdue'];

exports.getPolicy = async (req, res) => {
    try {
        const policy = await getOrCreatePolicy(req.schoolId);
        res.json({ success: true, data: policy });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updatePolicy = async (req, res) => {
    try {
        const update = { updatedBy: req.userId, updatedAt: new Date() };

        // Every one of these is read on a hot path — `+'abc'` used to store NaN
        // straight into the policy and take the whole module down with it.
        for (const [field, { min, max, label }] of Object.entries(POLICY_NUMBERS)) {
            const raw = req.body[field];
            if (raw === undefined || raw === '') continue;
            const n = Number(raw);
            if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max)
                return res.status(400).json({ success: false, message: `${label} must be a whole number between ${min} and ${max}` });
            update[field] = n;
        }
        for (const field of POLICY_FLAGS) {
            if (req.body[field] !== undefined) update[field] = !!req.body[field];
        }

        const policy = await LibraryPolicy.findOneAndUpdate(
            { school: req.schoolId },
            update,
            { upsert: true, new: true }
        ).lean();
        audit(req.schoolId, req.userId, req.userRole, 'POLICY_UPDATED', 'Policy', policy._id, null, update);
        res.json({ success: true, data: policy });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getAuditLog = async (req, res) => {
    try {
        const { actionType, entityType, before } = req.query;
        const { limit } = paging(req.query, 30);
        const filter = { school: req.schoolId };
        // Keyed on the timestamp rather than an offset: the log only grows, and
        // OFFSET makes the last page the most expensive one to reach.
        if (before) {
            const cursor = new Date(before);
            if (!Number.isNaN(cursor.getTime())) filter.timestamp = { $lt: cursor };
        }
        if (actionType) filter.actionType = actionType;
        if (entityType) filter.entityType = entityType;

        const [logs, total] = await Promise.all([
            LibraryAuditLog.find(filter)
                .populate('user', 'name')
                .sort({ timestamp: -1 })
                .limit(limit + 1)
                .lean(),
            LibraryAuditLog.countDocuments({ school: req.schoolId, ...(actionType ? { actionType } : {}), ...(entityType ? { entityType } : {}) }),
        ]);

        const hasMore = logs.length > limit;
        const rows    = hasMore ? logs.slice(0, limit) : logs;
        res.json({
            success: true, data: rows, total,
            nextCursor: hasMore ? rows[rows.length - 1].timestamp : null,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
