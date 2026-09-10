'use strict';
const LibraryBook        = require('../models/LibraryBook');
const LibraryBookCopy    = require('../models/LibraryBookCopy');
const LibraryIssuance    = require('../models/LibraryIssuance');
const LibraryReservation = require('../models/LibraryReservation');
const LibraryFine        = require('../models/LibraryFine');
const LibraryPolicy      = require('../models/LibraryPolicy');
const LibraryAuditLog    = require('../models/LibraryAuditLog');
const XLSX               = require('xlsx');
const fs                 = require('fs');
const path               = require('path');
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
    attachFineSummary, placeReservation,
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

/** A populated ref or a bare id, reduced to the id. */
const sid = (v) => (v == null ? '' : String(v._id ?? v));

/** A search term is data, not a pattern — neutralise it before it becomes one. */
const escapeRx = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
        // v3: the tiles gained their period comparisons, and the payload gained
        // the category split and the weekly circulation series — a cached v2
        // body would keep serving a dashboard missing half its panels.
        const key   = `lib:dash:v3:${req.schoolId}`;
        let tiles = null;
        if (redis) {
            try {
                const raw = await redis.get(key);
                if (raw) tiles = JSON.parse(raw);
            } catch { /* fall through to the database */ }
        }

        if (!tiles) {
            // Every figure the tiles show, and what each one is being compared
            // against. A tile that says "3 issued out" and nothing else cannot
            // tell a librarian whether that is a busy week or a dead one, so
            // each count arrives beside the same count a period ago — measured,
            // not estimated.
            const [{ rows }, cats, series] = await Promise.all([
                pool.query(
                    `SELECT
                   (SELECT count(*) FROM "${LibraryBook.tableName}"        WHERE "school" = $1)                                  AS "totalBooks",
                   (SELECT count(*) FROM "${LibraryBookCopy.tableName}"    WHERE "school" = $1)                                  AS "totalCopies",
                   (SELECT count(*) FROM "${LibraryBookCopy.tableName}"    WHERE "school" = $1 AND "status" = 'issued')          AS "issuedCopies",
                   (SELECT count(*) FROM "${LibraryIssuance.tableName}"    WHERE "school" = $1 AND "status" = 'overdue')         AS "overdue",
                   (SELECT count(*) FROM "${LibraryReservation.tableName}" WHERE "school" = $1 AND "status" = ANY($2::text[]))    AS "reservations",
                   (SELECT count(*) FROM "${LibraryFine.tableName}"        WHERE "school" = $1 AND "status" = 'pending')         AS "pendingFines",
                   (SELECT COALESCE(sum("amount" - COALESCE("waivedAmount", 0) - COALESCE("paidAmount", 0)), 0)
                      FROM "${LibraryFine.tableName}" WHERE "school" = $1 AND "status" = 'pending')                              AS "pendingFineTotal",
                   (SELECT count(*) FROM "${LibraryBookCopy.tableName}"    WHERE "school" = $1 AND "status" = 'available')        AS "availableCopies",
                   -- What has changed, and over what.
                   (SELECT count(*) FROM "${LibraryBook.tableName}"        WHERE "school" = $1
                      AND "createdAt" >= date_trunc('month', now()))                                                             AS "booksThisMonth",
                   (SELECT count(*) FROM "${LibraryBookCopy.tableName}"    WHERE "school" = $1
                      AND "createdAt" >= date_trunc('month', now()))                                                             AS "copiesThisMonth",
                   (SELECT count(*) FROM "${LibraryIssuance.tableName}"    WHERE "school" = $1
                      AND "issueDate" >= date_trunc('month', now()))                                                             AS "issuedThisMonth",
                   (SELECT count(*) FROM "${LibraryIssuance.tableName}"    WHERE "school" = $1
                      AND "issueDate" >= date_trunc('month', now()) - interval '1 month'
                      AND "issueDate" <  date_trunc('month', now()))                                                             AS "issuedLastMonth",
                   -- Overdue is a live status, so a week ago has to be derived:
                   -- past its due date then, and not yet back at that point.
                   (SELECT count(*) FROM "${LibraryIssuance.tableName}"    WHERE "school" = $1
                      AND "dueDate" < now() - interval '7 days'
                      AND ("returnDate" IS NULL OR "returnDate" > now() - interval '7 days'))                                     AS "overdueLastWeek",
                   (SELECT count(*) FROM "${LibraryReservation.tableName}" WHERE "school" = $1
                      AND "status" = ANY($2::text[]) AND "createdAt" < now() - interval '7 days')                                 AS "reservationsLastWeek"`,
                    [String(req.schoolId), ACTIVE_RESERVATION],
                ),
                // What the collection is made of. Every book has exactly one
                // category, so these sum to the title count.
                pool.query(
                    `SELECT COALESCE(NULLIF(btrim("category"), ''), 'Uncategorised') AS "category",
                            count(*)::int AS "count"
                       FROM "${LibraryBook.tableName}" WHERE "school" = $1
                      GROUP BY 1 ORDER BY 2 DESC, 1 ASC`,
                    [String(req.schoolId)],
                ),
                // Twelve weeks of counter traffic. The client shows the last
                // four, eight or all twelve of these without asking again.
                pool.query(
                    `WITH w AS (
                        SELECT generate_series(
                            date_trunc('week', now()) - interval '11 weeks',
                            date_trunc('week', now()),
                            interval '1 week') AS "start")
                     SELECT to_char(w."start", 'YYYY-MM-DD') AS "week",
                       (SELECT count(*)::int FROM "${LibraryIssuance.tableName}" i
                         WHERE i."school" = $1 AND i."issueDate" >= w."start"
                           AND i."issueDate" < w."start" + interval '1 week')  AS "issued",
                       (SELECT count(*)::int FROM "${LibraryIssuance.tableName}" i
                         WHERE i."school" = $1 AND i."returnDate" >= w."start"
                           AND i."returnDate" < w."start" + interval '1 week') AS "returned"
                       FROM w ORDER BY w."start"`,
                    [String(req.schoolId)],
                ),
            ]);

            tiles = Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
            tiles.categories  = cats.rows;
            tiles.circulation = series.rows;
            if (redis) {
                try { await redis.set(key, JSON.stringify(tiles), 'EX', DASH_TTL); } catch { /* best effort */ }
            }
        }

        // The two live lists. A librarian chasing a book needs the borrower's
        // class, which lives two joins away on their student profile — the
        // populate chain that used to build this list could not reach it.
        const listSql = (where, order, limit) => `
            SELECT i."_id", i."issueDate", i."dueDate", i."status",
                   b."title", b."authors",
                   u."name" AS "borrowerName", u."role" AS "borrowerRole",
                   c."className", cs."sectionName"
              FROM "${LibraryIssuance.tableName}" i
              JOIN "${LibraryBook.tableName}" b  ON b."_id" = i."book"
              JOIN "${User.tableName}" u         ON u."_id" = i."issuedTo"
         LEFT JOIN "${StudentProfile.tableName}" sp ON sp."user" = u."_id"
         LEFT JOIN "${ClassSection.tableName}" cs   ON cs."_id" = sp."currentSection"
         LEFT JOIN "${Class.tableName}" c           ON c."_id"  = cs."class"
             WHERE i."school" = $1 ${where}
             ORDER BY ${order} LIMIT ${limit}`;

        const [recentRows, overdueRows] = await Promise.all([
            pool.query(listSql('', 'i."issueDate" DESC', 10), [String(req.schoolId)]),
            pool.query(listSql(`AND i."status" = 'overdue'`, 'i."dueDate" ASC', 8), [String(req.schoolId)]),
        ]);

        const shape = (r) => ({
            _id: r._id,
            issueDate: r.issueDate,
            dueDate: r.dueDate,
            status: r.status,
            book: { title: r.title, authors: Array.isArray(r.authors) ? r.authors : [] },
            issuedTo: {
                name: r.borrowerName,
                role: r.borrowerRole,
                // Staff have no class; saying so beats an empty cell.
                className: [r.className, r.sectionName].filter(Boolean).join(' '),
            },
            // Only a book still out can be late. Measuring a returned one
            // against today made every old issuance look weeks overdue.
            daysOverdue: r.dueDate && ACTIVE_ISSUANCE.includes(r.status)
                ? Math.max(0, Math.floor((Date.now() - new Date(r.dueDate).getTime()) / 86400000))
                : 0,
        });

        res.json({
            success: true,
            data: {
                ...tiles,
                recent:  recentRows.rows.map(shape),
                overdueList: overdueRows.rows.map(shape),
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Books ─────────────────────────────────────────────────────────────────────

/**
 * A book's own state, from its copies.
 *
 * `availableCopies` alone cannot answer it: a title with four copies out, one of
 * them weeks late, is a different problem from one that is merely popular. The
 * order matters — overdue outranks everything, because it is the only state
 * anybody has to act on.
 */
const BOOK_STATUS_SQL = `CASE
    WHEN COALESCE(b."totalCopies", 0) = 0 THEN 'no_copies'
    WHEN ov."n" > 0                       THEN 'overdue'
    -- Nothing on the shelf and nothing lent out either: the copies exist but
    -- are still being processed. Saying "all copies out" of a book nobody has
    -- borrowed sends a librarian looking for a borrower who does not exist.
    WHEN COALESCE(b."availableCopies", 0) = 0 AND pc."n" > 0 AND pc."n" >= COALESCE(b."totalCopies", 0)
                                          THEN 'processing'
    WHEN COALESCE(b."availableCopies", 0) = 0 THEN 'issued_out'
    ELSE 'available' END`;

// What may be sorted on, and the column behind it. A whitelist because the
// value lands in the ORDER BY — never interpolate a query parameter there.
const BOOK_SORTS = {
    title:     'b."title"',
    authors:   'b."authors"',
    isbn:      'b."isbn"',
    category:  'b."category"',
    available: 'b."availableCopies"',
    total:     'b."totalCopies"',
    status:    '"status"',
    added:     'b."createdAt"',
};

exports.getBooks = async (req, res) => {
    try {
        const { q, category, status } = req.query;
        const { page, limit, skip } = paging(req.query);

        const where  = ['b."school" = $1'];
        const values = [String(req.schoolId)];
        if (category) { values.push(category); where.push(`b."category" = $${values.length}`); }
        if (q) {
            // Title, ISBN, publisher and the author list — the search box says
            // "author" and until now searching one returned nothing.
            values.push(`%${q}%`);
            const i = values.length;
            where.push(`(b."title" ILIKE $${i} OR b."isbn" ILIKE $${i} OR b."publisher" ILIKE $${i}
                         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                              CASE WHEN jsonb_typeof(b."authors") = 'array' THEN b."authors" ELSE '[]'::jsonb END
                            ) a WHERE a ILIKE $${i}))`);
        }

        // The reservation list is a bound parameter, and the two queries below
        // bind it at different positions — so the FROM is built per query
        // rather than shared with a hard-coded placeholder.
        const fromSql = (resParam) => `
            FROM "${LibraryBook.tableName}" b
            LEFT JOIN LATERAL (
                SELECT count(*)::int AS "n" FROM "${LibraryIssuance.tableName}" i
                 WHERE i."book" = b."_id" AND i."status" = 'overdue') ov ON true
            LEFT JOIN LATERAL (
                SELECT count(*)::int AS "n" FROM "${LibraryReservation.tableName}" r
                 WHERE r."book" = b."_id" AND r."status" = ANY($${resParam}::text[])) rs ON true
            LEFT JOIN LATERAL (
                SELECT count(*)::int AS "n" FROM "${LibraryBookCopy.tableName}" c
                 WHERE c."book" = b."_id" AND c."status" = 'processing') pc ON true`;
        const from = fromSql(values.length + 1);
        values.push(ACTIVE_RESERVATION);

        // The status filter runs on the derived value, so it has to be applied
        // after the joins rather than in the WHERE above.
        const having = status ? `WHERE "status" = $${values.length + 1}` : '';
        if (status) values.push(status);

        const sortKey = BOOK_SORTS[req.query.sortBy] ? req.query.sortBy : 'title';
        const dir     = String(req.query.sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        const orderBy = `${sortKey === 'status' ? '"status"' : BOOK_SORTS[sortKey]} ${dir} NULLS LAST, b."title" ASC`;

        const base = `SELECT b.*, ov."n" AS "overdueCount", rs."n" AS "reservedCount", pc."n" AS "processingCount",
                             ${BOOK_STATUS_SQL} AS "status" ${from} WHERE ${where.join(' AND ')}`;

        const [rows, count, stats] = await Promise.all([
            pool.query(`SELECT * FROM (${base}) t ${having} ORDER BY ${orderBy.replace(/\bb\./g, 't.')} LIMIT ${limit} OFFSET ${skip}`, values),
            pool.query(`SELECT count(*)::int AS "n" FROM (${base}) t ${having}`, values),
            // The tiles count the whole catalogue, not the filtered page — they
            // are the denominator the percentages beside them are taken from.
            pool.query(
                `SELECT "status", count(*)::int AS "n" FROM (
                    SELECT ${BOOK_STATUS_SQL} AS "status" ${fromSql(2)} WHERE b."school" = $1
                 ) t GROUP BY 1`,
                [String(req.schoolId), ACTIVE_RESERVATION],
            ),
        ]);

        const by = Object.fromEntries(stats.rows.map((r) => [r.status, r.n]));
        // The categories this catalogue actually uses — a filter that offered
        // anything else would only ever empty the table.
        const cats = await pool.query(
            `SELECT COALESCE(NULLIF(btrim("category"), ''), '') AS "category", count(*)::int AS "count"
               FROM "${LibraryBook.tableName}" WHERE "school" = $1
              GROUP BY 1 ORDER BY 2 DESC, 1 ASC`,
            [String(req.schoolId)],
        );
        const totalBooks = Object.values(by).reduce((n, v) => n + v, 0);
        // Titles with somebody waiting, and titles catalogued this month.
        const extra = await pool.query(
            `SELECT
               (SELECT count(DISTINCT r."book")::int FROM "${LibraryReservation.tableName}" r
                 WHERE r."school" = $1 AND r."status" = ANY($2::text[]))              AS "reserved",
               (SELECT count(*)::int FROM "${LibraryBook.tableName}"
                 WHERE "school" = $1 AND "createdAt" >= date_trunc('month', now()))   AS "addedThisMonth"`,
            [String(req.schoolId), ACTIVE_RESERVATION],
        );

        const total = count.rows[0].n;
        res.json({
            success: true,
            data: rows.rows,
            total, page, pages: Math.ceil(total / limit) || 1,
            stats: {
                total: totalBooks,
                available:  by.available  || 0,
                issuedOut:  by.issued_out || 0,
                processing: by.processing || 0,
                overdue:    by.overdue    || 0,
                noCopies:   by.no_copies  || 0,
                reserved:       extra.rows[0].reserved,
                addedThisMonth: extra.rows[0].addedThisMonth,
            },
            categories: cats.rows.filter((c) => c.category),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * The catalogue fields that are neither text nor a list: a year somebody can
 * mistype as 20255, a page count that cannot be negative. Both are optional —
 * blank stays blank rather than becoming zero.
 */
function bibliographic(body) {
    const out = {};
    const year = body.publishedYear;
    if (year !== undefined) {
        if (year === '' || year === null) out.publishedYear = null;
        else {
            const n = Number(year);
            const max = new Date().getFullYear() + 1;   // next year's editions do exist
            if (!Number.isInteger(n) || n < 1450 || n > max)
                return { error: `Publication year must be a whole year between 1450 and ${max}` };
            out.publishedYear = n;
        }
    }
    const pages = body.pages;
    if (pages !== undefined) {
        if (pages === '' || pages === null) out.pages = null;
        else {
            const n = Number(pages);
            if (!Number.isInteger(n) || n < 1 || n > 20000)
                return { error: 'Number of pages must be a whole number between 1 and 20000' };
            out.pages = n;
        }
    }
    if (body.subjects !== undefined) {
        const list = Array.isArray(body.subjects)
            ? body.subjects
            : String(body.subjects).split(',');
        out.subjects = [...new Set(list.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
    }
    return { value: out };
}

/**
 * The copy codes for a new batch: the library's own sequence, or the ones a
 * school already has written inside its books.
 *
 * Typed codes never touch the counter — it only ever hands out codes nobody has
 * used, and consuming numbers for codes it did not generate would make it lie.
 */
async function codesFor(schoolId, count, typed) {
    if (!Array.isArray(typed) || !typed.length) return { codes: await reserveCopyCodes(schoolId, count) };

    const codes = typed.map((c) => String(c).trim()).filter(Boolean);
    if (codes.length !== count)
        return { error: `Enter ${count} copy code${count === 1 ? '' : 's'} — ${codes.length} given` };
    if (new Set(codes).size !== codes.length)
        return { error: 'Two copies cannot share a code' };
    const bad = codes.find((c) => c.length > 60);
    if (bad) return { error: `Copy code "${bad.slice(0, 20)}…" is too long (max 60 characters)` };

    const clash = await LibraryBookCopy.findOne({ school: schoolId, uniqueCode: { $in: codes } })
        .select('uniqueCode').lean();
    if (clash) return { error: `Copy code ${clash.uniqueCode} is already used by another copy` };
    return { codes };
}

exports.createBook = async (req, res) => {
    try {
        const { title, isbn, authors, publisher, category, edition, language, description } = req.body;
        if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required' });
        if (title.trim().length > 300) return res.status(400).json({ success: false, message: 'Title is too long (max 300 characters)' });
        if (isbn && !isValidIsbn(isbn))
            return res.status(400).json({ success: false, message: 'ISBN must be 10 or 13 digits (hyphens and spaces are fine)' });

        const extra = bibliographic(req.body);
        if (extra.error) return res.status(400).json({ success: false, message: extra.error });

        // Copies can be registered in the same breath as the title. A catalogue
        // entry with none of them cannot be issued or reserved, and asking for
        // them in a second dialog afterwards was a step everybody had to take
        // and half of them forgot.
        const count = Math.floor(Number(req.body.copies ?? 0));
        if (!Number.isFinite(count) || count < 0 || count > MAX_COPIES_PER_ADD)
            return res.status(400).json({ success: false, message: `Number of copies must be between 0 and ${MAX_COPIES_PER_ADD}` });

        const dup = await findDuplicateBook(req.schoolId, { title, isbn, edition });
        if (dup) return duplicateResponse(res, dup);

        // Copies can arrive shelf-ready or still being processed. Anything but
        // 'available' is owned but not lendable, and must not be counted in
        // availableCopies — the counter that every issue path reads.
        const shelved = req.body.availability !== 'processing';

        // Typed codes are checked before the book exists, so a clash leaves no
        // half-made catalogue entry behind.
        const picked = count > 0 ? await codesFor(req.schoolId, count, req.body.copyCodes) : { codes: [] };
        if (picked.error) return res.status(400).json({ success: false, message: picked.error });

        const book = await LibraryBook.create({
            school: req.schoolId, title: title.trim(), isbn: isbn || '',
            authors: authors || [], publisher: publisher || '', category: category || '',
            edition: edition || '', language: language || 'English', description: description || '',
            coverImage: '', ...extra.value,
            createdBy: req.userId,
        });
        audit(req.schoolId, req.userId, req.userRole, 'BOOK_CREATED', 'Book', book._id, null, book.toObject());

        if (count > 0) {
            const { condition, rackLocation, acquisitionDate, vendor, billNumber, cost } = req.body;
            const { codes } = picked;
            await LibraryBookCopy.insertMany(codes.map((code) => buildCopy(
                req.schoolId, book._id, code, req.userId,
                { condition, rackLocation, acquisitionDate, vendor, billNumber, cost,
                  status: shelved ? 'available' : 'processing' },
            )));
            await bumpBookCounts(book._id, { total: count, available: shelved ? count : 0 });
            // One row for the batch, not one per copy — the same shape addCopy
            // writes, so the audit log reads the same however copies arrived.
            audit(req.schoolId, req.userId, req.userRole, 'COPY_ADDED', 'Book', book._id, null, {
                count, codes: count > 1 ? `${codes[0]} … ${codes[count - 1]}` : codes[0],
                status: shelved ? 'available' : 'processing',
                condition: condition || 'new', rackLocation: rackLocation || '',
                vendor: vendor || '', billNumber: billNumber || '', cost: cost || 0,
            });
        }

        // Re-read rather than returning the document created before the copies:
        // its counters were bumped in the database, not on this object.
        const saved = await LibraryBook.findById(book._id).lean();
        res.status(201).json({ success: true, data: saved || book, copies: count });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getBookDetail = async (req, res) => {
    try {
        // `createdBy` is an id on the row; the page says who catalogued it.
        const book = await LibraryBook.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('createdBy', 'name').lean();
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

/**
 * Everything about one book that is *not* its copies: who has had it, who is
 * waiting for it, how hard it has worked, and what sits next to it on the shelf.
 *
 * Deliberately a second endpoint rather than more fields on `getBookDetail`.
 * That one is re-run every time the librarian pages the copy list or types a
 * copy code, and none of this changes when they do — a book's borrowing history
 * has nothing to say about which page of its copies is on screen.
 */
/**
 * The book's cover.
 *
 * A separate call rather than a field on create: the file needs a book to
 * belong to, and a multipart create would make every other client that posts
 * JSON to this endpoint deal with it. The old file is deleted once the new path
 * is stored — a cover replaced ten times should not leave ten files behind.
 */
exports.uploadBookCover = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Choose an image first' });

        const book = await LibraryBook.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!book) {
            // The file is already on disk; a book that is not ours must not keep it.
            fs.unlink(req.file.path, () => {});
            return res.status(404).json({ success: false, message: 'Book not found' });
        }

        const coverImage = `/uploads/images/${req.file.filename}`;
        await LibraryBook.updateOne({ _id: book._id }, { coverImage });

        if (book.coverImage && book.coverImage !== coverImage) {
            fs.unlink(path.join(__dirname, '..', book.coverImage), () => {});
        }
        audit(req.schoolId, req.userId, req.userRole, 'BOOK_UPDATED', 'Book', book._id,
            { coverImage: book.coverImage || '' }, { coverImage });
        res.json({ success: true, data: { coverImage } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getBookActivity = async (req, res) => {
    try {
        const book = await LibraryBook.findOne({ _id: req.params.id, school: req.schoolId })
            .select('_id title authors category').lean();
        if (!book) return res.status(404).json({ success: false, message: 'Book not found' });

        const id = String(book._id);
        const school = String(req.schoolId);
        const author = (Array.isArray(book.authors) ? book.authors : []).filter(Boolean)[0] || '';

        const [loans, loansTotal, reservations, statsRows, relatedRows] = await Promise.all([
            LibraryIssuance.find({ book: book._id, school: req.schoolId })
                .populate('issuedTo', 'name role')
                .populate('bookCopy', 'uniqueCode')
                .sort({ issueDate: -1 })
                .limit(10)
                .lean(),
            LibraryIssuance.countDocuments({ book: book._id, school: req.schoolId }),
            LibraryReservation.find({ book: book._id, school: req.schoolId, status: { $in: ACTIVE_RESERVATION } })
                .populate('reservedBy', 'name role')
                .sort({ queuePosition: 1 })
                .lean(),
            pool.query(
                `SELECT count(*)::int AS "loans",
                        count(*) FILTER (WHERE "status" = ANY($3::text[]))::int AS "out",
                        count(*) FILTER (WHERE "status" = 'overdue')::int AS "overdue",
                        count(DISTINCT "issuedTo")::int AS "readers",
                        max("issueDate") AS "lastIssued"
                   FROM "${LibraryIssuance.tableName}"
                  WHERE "book" = $1 AND "school" = $2`,
                [id, school, ACTIVE_ISSUANCE],
            ),
            // What a reader who liked this one might take next: another book by
            // the same author first, then the rest of the same category. Authors
            // is jsonb, so it is matched as text — see the reports controller for
            // why jsonb_array_elements_text is the wrong tool on a nullable column.
            pool.query(
                `SELECT b."_id", b."title", b."authors", b."category",
                        b."availableCopies", b."totalCopies",
                        (CASE WHEN $4 <> '' AND COALESCE(b."authors"::text, '') ILIKE $5 THEN 1 ELSE 0 END) AS "sameAuthor"
                   FROM "${LibraryBook.tableName}" b
                  WHERE b."school" = $2 AND b."_id" <> $1
                    AND ( ($3 <> '' AND b."category" = $3)
                       OR ($4 <> '' AND COALESCE(b."authors"::text, '') ILIKE $5) )
                  ORDER BY "sameAuthor" DESC, b."title" ASC
                  LIMIT 4`,
                [id, school, book.category || '', author, `%${author.replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
            ),
        ]);

        const s = statsRows.rows[0] || {};
        res.json({
            success: true,
            data: {
                // The class the borrower is in lives on their profile, not on the
                // loan; three bounded lookups over ten rows.
                loans: await withBorrowerClass(req.schoolId, loans),
                loansTotal,
                reservations,
                stats: {
                    loans: Number(s.loans || 0),
                    out: Number(s.out || 0),
                    overdue: Number(s.overdue || 0),
                    readers: Number(s.readers || 0),
                    lastIssued: s.lastIssued || null,
                    waiting: reservations.length,
                },
                related: relatedRows.rows.map((r) => ({
                    _id: r._id,
                    title: r.title,
                    authors: Array.isArray(r.authors) ? r.authors : [],
                    category: r.category || '',
                    availableCopies: Number(r.availableCopies || 0),
                    totalCopies: Number(r.totalCopies || 0),
                    sameAuthor: !!Number(r.sameAuthor),
                })),
            },
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

        const extra = bibliographic(req.body);
        if (extra.error) return res.status(400).json({ success: false, message: extra.error });

        const update = { ...extra.value };
        if (title       !== undefined) update.title       = title.trim();
        if (isbn        !== undefined) update.isbn        = isbn;
        if (authors     !== undefined) update.authors     = authors;
        if (publisher   !== undefined) update.publisher   = publisher;
        if (category    !== undefined) update.category    = category;
        if (edition     !== undefined) update.edition     = edition;
        if (language    !== undefined) update.language    = language;
        if (description !== undefined) update.description = description;
        // Clearing the cover is a deliberate empty string; the field is left
        // alone when the form does not mention it. The file itself is replaced
        // through /books/:id/cover, which is the only path that writes a path.
        if (req.body.coverImage === '') update.coverImage = '';

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

/**
 * Delete several books at once.
 *
 * Runs each one through the same three refusals the single delete uses — a book
 * on loan, queued for, or with a copy still marked issued stays put — and says
 * which ones it would not take rather than failing the whole batch or, worse,
 * quietly deleting the rest.
 */
exports.bulkDeleteBooks = async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
        if (!ids.length) return res.status(400).json({ success: false, message: 'Select at least one book' });

        const books = await LibraryBook.find({ _id: { $in: ids }, school: req.schoolId }).lean();
        const deleted = [];
        const skipped = [];

        for (const book of books) {
            const [onLoan, queued, outCopy] = await Promise.all([
                LibraryIssuance.exists({ book: book._id, status: { $in: ACTIVE_ISSUANCE } }),
                LibraryReservation.exists({ book: book._id, status: { $in: ACTIVE_RESERVATION } }),
                LibraryBookCopy.exists({ book: book._id, status: 'issued' }),
            ]);
            const reason = onLoan ? 'copies are still out on loan'
                : queued ? 'people are queued for it'
                : outCopy ? 'a copy is still marked issued' : null;
            if (reason) { skipped.push({ title: book.title, reason }); continue; }

            await Promise.all([
                LibraryBook.deleteOne({ _id: book._id }),
                LibraryBookCopy.deleteMany({ book: book._id }),
            ]);
            audit(req.schoolId, req.userId, req.userRole, 'BOOK_DELETED', 'Book', book._id, book, null);
            deleted.push(book.title);
        }

        res.json({ success: true, deleted: deleted.length, skipped });
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
        const book = await LibraryBook.findOne({ _id: bookId, school: req.schoolId }).lean();
        // A book id from another school used to come back with `book: null` and
        // that school's copy codes still listed underneath it — the copies query
        // was the one place here not scoped to the caller's school.
        if (!book) return res.status(404).json({ success: false, message: 'Book not found' });
        const copies = await LibraryBookCopy.find({ book: bookId, school: req.schoolId, status: 'available' }).lean();
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
            await LibraryReservation.updateOne({ _id: claim._id }, { status: 'collected', closedAt: new Date() });
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

/**
 * Which class each borrower is in.
 *
 * A loan points at a User; the class lives two hops away on their student
 * profile. Chasing an overdue book means knowing the class, and the page window
 * is at most a hundred rows, so it is three bounded lookups rather than a join
 * on every issuance in the school.
 */
async function withBorrowerClass(schoolId, rows, field = 'issuedTo') {
    const ids = [...new Set(rows.map((r) => sid(r[field])).filter(Boolean))];
    if (!ids.length) return rows;

    const profiles = await StudentProfile.find({ school: schoolId, user: { $in: ids } })
        .select('user currentSection').lean();
    const sectionIds = [...new Set(profiles.map((p) => sid(p.currentSection)).filter(Boolean))];
    const sections = sectionIds.length
        ? await ClassSection.find({ _id: { $in: sectionIds } }).select('sectionName class').lean()
        : [];
    const classIds = [...new Set(sections.map((x) => sid(x.class)).filter(Boolean))];
    const classes = classIds.length
        ? await Class.find({ _id: { $in: classIds } }).select('className').lean()
        : [];

    const className = Object.fromEntries(classes.map((c) => [String(c._id), c.className]));
    const bySection = Object.fromEntries(sections.map((x) => [
        String(x._id), `${className[sid(x.class)] || ''} ${x.sectionName || ''}`.trim(),
    ]));
    const byUser = Object.fromEntries(profiles.map((p) => [String(p.user), bySection[sid(p.currentSection)] || '']));

    return rows.map((r) => ({ ...r, borrowerClass: byUser[sid(r[field])] || '' }));
}

/**
 * The four figures above the register, each against the same week before it.
 *
 * "Overdue" is a live status with no history, so a week ago is derived: past
 * its due date then, and not yet back at that point. Fines collected is money
 * actually taken in the window, not money charged.
 */
async function circulationStats(schoolId) {
    const { rows } = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM "${LibraryIssuance.tableName}" WHERE "school" = $1
              AND "issueDate" >= date_trunc('week', now()))                                   AS "issued",
           (SELECT count(*)::int FROM "${LibraryIssuance.tableName}" WHERE "school" = $1
              AND "issueDate" >= date_trunc('week', now()) - interval '1 week'
              AND "issueDate" <  date_trunc('week', now()))                                   AS "issuedPrev",
           (SELECT count(*)::int FROM "${LibraryIssuance.tableName}" WHERE "school" = $1
              AND "returnDate" >= date_trunc('week', now()))                                  AS "returned",
           (SELECT count(*)::int FROM "${LibraryIssuance.tableName}" WHERE "school" = $1
              AND "returnDate" >= date_trunc('week', now()) - interval '1 week'
              AND "returnDate" <  date_trunc('week', now()))                                  AS "returnedPrev",
           (SELECT count(*)::int FROM "${LibraryIssuance.tableName}" WHERE "school" = $1
              AND "status" = 'overdue')                                                       AS "overdue",
           (SELECT count(*)::int FROM "${LibraryIssuance.tableName}" WHERE "school" = $1
              AND "dueDate" < now() - interval '7 days'
              AND ("returnDate" IS NULL OR "returnDate" > now() - interval '7 days'))          AS "overduePrev",
           (SELECT COALESCE(sum("paidAmount"), 0)::float FROM "${LibraryFine.tableName}" WHERE "school" = $1
              AND "paidAt" >= date_trunc('week', now()))                                      AS "collected",
           (SELECT COALESCE(sum("paidAmount"), 0)::float FROM "${LibraryFine.tableName}" WHERE "school" = $1
              AND "paidAt" >= date_trunc('week', now()) - interval '1 week'
              AND "paidAt" <  date_trunc('week', now()))                                      AS "collectedPrev",
           (SELECT COALESCE(sum("amount" - COALESCE("waivedAmount", 0) - COALESCE("paidAmount", 0)), 0)::float
              FROM "${LibraryFine.tableName}" WHERE "school" = $1 AND "status" = 'pending')    AS "outstanding"`,
        [String(schoolId)],
    );
    return rows[0];
}

exports.getIssuances = async (req, res) => {
    try {
        await sweepOverdue(req.schoolId);

        const { status, userId, role, classId, sectionId, q, from, to } = req.query;
        const { page, limit, skip } = paging(req.query);
        const filter = { school: req.schoolId };
        if (status) filter.status   = status;
        if (userId) filter.issuedTo = userId;
        if (BORROWER_ROLES.includes(role)) filter.issuedToRole = role;

        // A date window on when the loan was made. Both ends are optional, and
        // `to` covers the whole of its day rather than midnight at its start.
        if (from || to) {
            filter.issueDate = {};
            if (from) filter.issueDate.$gte = new Date(`${from}T00:00:00.000Z`);
            if (to)   filter.issueDate.$lte = new Date(`${to}T23:59:59.999Z`);
        }

        // One search box over three different records — the book, the copy on
        // the shelf, and the person holding it. Each is resolved to a bounded
        // set of ids first, because a loan carries only their references.
        if (q && q.trim()) {
            const rx = { $regex: escapeRx(q.trim()), $options: 'i' };
            const [books, copies, people] = await Promise.all([
                LibraryBook.find({ school: req.schoolId, $or: [{ title: rx }, { isbn: rx }] }).select('_id').limit(500).lean(),
                LibraryBookCopy.find({ school: req.schoolId, uniqueCode: rx }).select('_id').limit(500).lean(),
                User.find({ school: req.schoolId, name: rx }).select('_id').limit(500).lean(),
            ]);
            const or = [];
            if (books.length)  or.push({ book:     { $in: books.map((b) => String(b._id)) } });
            if (copies.length) or.push({ bookCopy: { $in: copies.map((c) => String(c._id)) } });
            if (people.length) or.push({ issuedTo: { $in: people.map((u) => String(u._id)) } });
            // Nothing matched the term anywhere, so nothing can match the loan.
            if (!or.length) {
                return wantsXlsx(req)
                    ? sendXlsx(res, 'library_circulation', [])
                    : res.json({ success: true, data: [], total: 0, page, pages: 0, stats: await circulationStats(req.schoolId) });
            }
            filter.$or = or;
        }

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
                    : res.json({ success: true, data: [], total: 0, page, pages: 0, stats: await circulationStats(req.schoolId) });
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

        const [issuances, total, stats] = await Promise.all([
            query().skip(skip).limit(limit).lean(),
            LibraryIssuance.countDocuments(filter),
            circulationStats(req.schoolId),
        ]);
        res.json({
            success: true, data: await withBorrowerClass(req.schoolId, await attachFineSummary(issuances)),
            total, page, pages: Math.ceil(total / limit) || 1, stats,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Renew several loans at once.
 *
 * Each id goes through `renewIssuance` exactly as a single renewal does, so the
 * renewal cap, the reservation queue and every other rule still apply — the
 * batch reports what each one did rather than stopping at the first refusal.
 */
exports.bulkRenew = async (req, res) => {
    try {
        await sweepOverdue(req.schoolId);
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
        if (!ids.length) return res.status(400).json({ success: false, message: 'Select at least one loan' });

        const renewed = [];
        const skipped = [];
        for (const id of ids) {
            // eslint-disable-next-line no-await-in-loop -- each renewal moves the
            // same copy's state; running them together would race on the queue.
            const result = await renewIssuance(req.schoolId, id, { actor: req.userId, actorRole: req.userRole });
            if (result.ok) {
                audit(req.schoolId, req.userId, req.userRole, 'BOOK_RENEWED', 'Issuance', result.issuance._id, null,
                    { newDueDate: result.issuance.dueDate, renewalCount: result.issuance.renewalCount });
                renewed.push(id);
            } else {
                skipped.push({ id, reason: result.message });
            }
        }
        res.json({ success: true, renewed: renewed.length, skipped });
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

/**
 * The four figures above the queue, and the counts behind the status chips.
 *
 * "Ready" and "waiting" are counts of a live state; "collected" and "closed"
 * are counts of a month's work, so each of those carries the same month before
 * it. A reservation that expired on the shelf is counted with the cancelled
 * ones — from the member's side nothing came of either.
 */
async function reservationStats(schoolId) {
    const { rows } = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1 AND "status" = 'ready')     AS "ready",
           (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1 AND "status" = 'pending')   AS "waiting",
           (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1 AND "status" = 'collected') AS "collected",
           (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1 AND "status" = 'cancelled') AS "cancelled",
           (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1 AND "status" = 'expired')   AS "expired",
           (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1)                            AS "all",
           (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1
              AND "status" = 'collected' AND "closedAt" >= date_trunc('month', now()))                                 AS "collectedThisMonth",
           (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1
              AND "status" = 'collected' AND "closedAt" >= date_trunc('month', now()) - interval '1 month'
              AND "closedAt" < date_trunc('month', now()))                                                             AS "collectedLastMonth",
           (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1
              AND "status" = ANY(ARRAY['cancelled','expired']) AND "closedAt" >= date_trunc('month', now()))           AS "closedThisMonth",
           (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1
              AND "status" = ANY(ARRAY['cancelled','expired'])
              AND "closedAt" >= date_trunc('month', now()) - interval '1 month'
              AND "closedAt" < date_trunc('month', now()))                                                             AS "closedLastMonth",
           -- What is about to fall off the hold shelf: the actionable number.
           (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1
              AND "status" = 'ready' AND "expiresAt" IS NOT NULL
              AND "expiresAt" < now() + interval '2 days')                                                              AS "expiringSoon",
           -- How long the person at the front of the queue has been waiting.
           (SELECT COALESCE(EXTRACT(day FROM now() - min("reservedAt")), 0)::int
              FROM "${LibraryReservation.tableName}" WHERE "school" = $1 AND "status" = 'pending')                       AS "longestWaitDays"`,
        [String(schoolId)],
    );
    return rows[0];
}

/**
 * Queue somebody at the desk.
 *
 * The member cannot place this themselves — they are standing at the counter —
 * so the librarian does it for them, through exactly the rules the member's own
 * screen enforces (`placeReservation`). Before this the button did not exist and
 * the only way to queue a person was to log in as them.
 */
exports.createReservation = async (req, res) => {
    try {
        const { bookId, userId } = req.body || {};
        if (!bookId || !userId)
            return res.status(400).json({ success: false, message: 'Choose a book and a member' });

        const member = await User.findOne({ _id: userId, school: req.schoolId }).select('name role').lean();
        if (!member) return res.status(404).json({ success: false, message: 'Member not found' });
        if (!BORROWER_ROLES.includes(member.role))
            return res.status(400).json({ success: false, message: 'Only students and staff can reserve books' });

        const result = await placeReservation({
            schoolId: req.schoolId, bookId, userId,
            actorId: req.userId, actorRole: req.userRole,
        });
        if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

        const { reservation, book, readyNow } = result;
        // The member did not place this, so they are the ones who need telling.
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: readyNow ? '🔖 Reserved book ready' : '🔖 Reservation placed for you',
            body: readyNow
                ? `"${book.title}" is being held for you. Collect it before ${fmtLibDate(reservation.expiresAt)}.`
                : `You are number ${reservation.queuePosition} in the queue for "${book.title}". We will let you know when it is ready.`,
            recipients: [userId],
            link: { type: 'library.reservations' },
        });

        res.status(201).json({ success: true, data: reservation });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getReservations = async (req, res) => {
    try {
        await expireStaleHolds(req.schoolId, null, { actor: req.userId, actorRole: req.userRole });

        const { status, classId, userId, q, from, to } = req.query;
        const { page, limit, skip } = paging(req.query);
        const filter = { school: req.schoolId };
        if (status) filter.status = status;
        if (userId) filter.reservedBy = userId;

        // A window on when the reservation was placed; `to` covers its whole day.
        if (from || to) {
            filter.reservedAt = {};
            if (from) filter.reservedAt.$gte = new Date(`${from}T00:00:00.000Z`);
            if (to)   filter.reservedAt.$lte = new Date(`${to}T23:59:59.999Z`);
        }

        // Class lives on the student profile, not on the reservation, so narrow
        // to those students first. Naming one member is more specific than
        // describing a group they might be in, so it wins.
        if (!userId && classId) {
            const students = await StudentProfile.find({ school: req.schoolId, currentClass: classId })
                .select('user').lean();
            const ids = students.map((p) => String(p.user));
            if (!ids.length) {
                return res.json({ success: true, data: [], total: 0, page, pages: 1, stats: await reservationStats(req.schoolId) });
            }
            filter.reservedBy = { $in: ids };
        }

        // One search box over the book and the person waiting for it. Each is
        // resolved to a bounded id set first, because a reservation carries
        // only their references.
        if (q && q.trim()) {
            const rx = { $regex: escapeRx(q.trim()), $options: 'i' };
            const [books, people] = await Promise.all([
                LibraryBook.find({ school: req.schoolId, $or: [{ title: rx }, { isbn: rx }] }).select('_id').limit(500).lean(),
                User.find({ school: req.schoolId, name: rx }).select('_id').limit(500).lean(),
            ]);
            const or = [];
            if (books.length)  or.push({ book:       { $in: books.map((b) => String(b._id)) } });
            if (people.length) or.push({ reservedBy: { $in: people.map((u) => String(u._id)) } });
            if (!or.length) {
                return res.json({ success: true, data: [], total: 0, page, pages: 1, stats: await reservationStats(req.schoolId) });
            }
            filter.$or = or;
        }

        const [reservations, total] = await Promise.all([
            LibraryReservation.find(filter)
                .populate('book',      'title isbn')
                .populate('reservedBy','name email')
                .sort({ queuePosition: 1, reservedAt: 1 })
                .skip(wantsXlsx(req) ? 0 : skip)
                .limit(wantsXlsx(req) ? 5000 : limit)
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

        const rows = await withBorrowerClass(req.schoolId, data, 'reservedBy');

        // The export is what the librarian filtered down to, not just the page
        // in front of them — the same rule the circulation register follows.
        if (wantsXlsx(req)) {
            return sendXlsx(res, 'library_reservations', rows.map((r) => ({
                Book:   r.book?.title || '',
                ISBN:   r.book?.isbn || '',
                Member: r.reservedBy?.name || '',
                Class:  r.borrowerClass || '',
                'Queue #':    r.queuePosition || '',
                Status:       r.status,
                'Reserved on': day(r.reservedAt || r.createdAt),
                'Ready on':    day(r.readyAt),
                'Expires on':  day(r.expiresAt),
                'Closed on':   day(r.closedAt),
                'Copy to give': r.availableCopy?.uniqueCode || '',
            })));
        }

        res.json({
            success: true, data: rows,
            total, page, pages: Math.ceil(total / limit) || 1,
            stats: await reservationStats(req.schoolId),
        });
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
            { status: 'cancelled', closedAt: new Date() },
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

/**
 * The book each fine is against, and the class of whoever owes it.
 *
 * A fine points at a loan, and the loan points at a book — the title never
 * reached the screen, so the register said somebody owed ₹60 without saying
 * what for. Both are bounded lookups over the page window.
 */
async function withFineContext(schoolId, rows) {
    const bookIds = [...new Set(rows.map((r) => sid(r.issuance?.book)).filter(Boolean))];
    const books = bookIds.length
        ? await LibraryBook.find({ _id: { $in: bookIds } }).select('title isbn').lean()
        : [];
    const byBook = Object.fromEntries(books.map((b) => [String(b._id), b]));

    const withBook = rows.map((r) => ({ ...r, book: byBook[sid(r.issuance?.book)] || null }));
    return withBorrowerClass(schoolId, withBook, 'user');
}

/**
 * The four figures above the register.
 *
 * Outstanding is arithmetic, not a status: a part-waived, part-paid fine still
 * has a remainder, and counting `status = 'pending'` rows would miss it. Money
 * collected and money written off are counted in the month they moved, which is
 * what `paidAt` and `waivedAt` are for.
 */
async function fineStats(schoolId) {
    const { rows } = await pool.query(
        `SELECT
           (SELECT COALESCE(sum("amount" - COALESCE("waivedAmount",0) - COALESCE("paidAmount",0)), 0)::float
              FROM "${LibraryFine.tableName}" WHERE "school" = $1
               AND "amount" - COALESCE("waivedAmount",0) - COALESCE("paidAmount",0) > 0)          AS "outstanding",
           (SELECT count(*)::int FROM "${LibraryFine.tableName}" WHERE "school" = $1
               AND "amount" - COALESCE("waivedAmount",0) - COALESCE("paidAmount",0) > 0)          AS "unpaidCount",
           (SELECT COALESCE(sum("paidAmount"), 0)::float FROM "${LibraryFine.tableName}"
              WHERE "school" = $1 AND "paidAt" >= date_trunc('month', now()))                     AS "collected",
           (SELECT COALESCE(sum("paidAmount"), 0)::float FROM "${LibraryFine.tableName}"
              WHERE "school" = $1 AND "paidAt" >= date_trunc('month', now()) - interval '1 month'
                AND "paidAt" < date_trunc('month', now()))                                        AS "collectedPrev",
           -- What was owed a week ago: raised by then, and not settled until after.
           (SELECT count(*)::int FROM "${LibraryFine.tableName}" WHERE "school" = $1
              AND "createdAt" < now() - interval '7 days'
              AND ("paidAt" IS NULL OR "paidAt" > now() - interval '7 days')
              AND ("waivedAt" IS NULL OR "waivedAt" > now() - interval '7 days'))                  AS "unpaidPrev",
           (SELECT COALESCE(sum("waivedAmount"), 0)::float FROM "${LibraryFine.tableName}"
              WHERE "school" = $1 AND "waivedAt" >= date_trunc('month', now()))                   AS "waived",
           (SELECT count(*)::int FROM "${LibraryFine.tableName}" WHERE "school" = $1
              AND "waivedAt" >= date_trunc('month', now()))                                       AS "waivedCount",
           (SELECT COALESCE(sum("waivedAmount"), 0)::float FROM "${LibraryFine.tableName}"
              WHERE "school" = $1 AND "waivedAt" >= date_trunc('month', now()) - interval '1 month'
                AND "waivedAt" < date_trunc('month', now()))                                      AS "waivedPrev"`,
        [String(schoolId)],
    );
    return rows[0];
}

exports.getFines = async (req, res) => {
    try {
        const { status, userId, fineType, role, classId, sectionId, from, to, q } = req.query;
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

        // One search box over the person who owes it and the book it is against.
        // A fine points at a user and, through its loan, at a book — so each is
        // resolved to a bounded id set first.
        if (q && q.trim()) {
            const rx = { $regex: escapeRx(q.trim()), $options: 'i' };
            const [people, books] = await Promise.all([
                User.find({ school: req.schoolId, name: rx }).select('_id').limit(500).lean(),
                LibraryBook.find({ school: req.schoolId, $or: [{ title: rx }, { isbn: rx }] }).select('_id').limit(500).lean(),
            ]);
            const loans = books.length
                ? await LibraryIssuance.find({ school: req.schoolId, book: { $in: books.map((b) => String(b._id)) } })
                    .select('_id').limit(2000).lean()
                : [];
            const or = [];
            if (people.length) or.push({ user:     { $in: people.map((u) => String(u._id)) } });
            if (loans.length)  or.push({ issuance: { $in: loans.map((i) => String(i._id)) } });
            if (!or.length) {
                return wantsXlsx(req)
                    ? sendXlsx(res, 'library_fines', [])
                    : res.json({ success: true, data: [], total: 0, page, pages: 1, summary: emptyFineSummary(), stats: await fineStats(req.schoolId) });
            }
            // A member filter already in force is the more specific answer, so
            // the search narrows within it rather than widening past it.
            if (filter.user && or.length === 1 && or[0].user) delete or[0].user;
            filter.$and = [{ $or: or.length ? or : [{ _id: null }] }];
        }

        const query = () => LibraryFine.find(filter)
            .populate('user',       'name email role')
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

        res.json({
            success: true,
            data: await withFineContext(req.schoolId, fines),
            total, page, pages: Math.ceil(total / limit) || 1,
            summary, stats: await fineStats(req.schoolId),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Raise a fine by hand.
 *
 * Fines are normally raised by the return counter — late, lost, damaged — but a
 * librarian sometimes has to charge for something nobody looked at until later:
 * a torn page found on the shelf, a copy returned with its cover off. There was
 * no way to do that at all.
 *
 * Every fine hangs off a loan (`issuance` is required on the model, and it is
 * what ties the charge to a book and a borrower), so this takes the loan rather
 * than inventing a free-floating debt.
 */
exports.createFine = async (req, res) => {
    try {
        const { issuanceId, fineType, amount, reason } = req.body || {};
        if (!issuanceId) return res.status(400).json({ success: false, message: 'Choose the loan this fine is against' });
        if (!FINE_TYPES.includes(fineType))
            return res.status(400).json({ success: false, message: `Reason must be one of: ${FINE_TYPES.join(', ')}` });

        const value = Number(amount);
        if (!Number.isFinite(value) || value <= 0)
            return res.status(400).json({ success: false, message: 'Enter an amount greater than zero' });

        const issuance = await LibraryIssuance.findOne({ _id: issuanceId, school: req.schoolId })
            .populate('book', 'title').lean();
        if (!issuance) return res.status(404).json({ success: false, message: 'Loan not found' });

        // One automatic fine per loan per type is the rule the return counter
        // follows; charging a second of the same kind by hand would double it.
        const already = await LibraryFine.findOne({
            school: req.schoolId, issuance: issuanceId, fineType, status: { $ne: 'waived' } }).lean();
        if (already)
            return res.status(400).json({
                success: false,
                message: `This loan already carries a ${fineType.replace(/_/g, ' ')} fine of ₹${already.amount}`,
            });

        const fine = await LibraryFine.create({
            school: req.schoolId,
            issuance: issuanceId,
            user: sid(issuance.issuedTo),
            fineType,
            amount: Math.round(value * 100) / 100,
            daysOverdue: 0,          // raised by hand, so not derived from a due date
            status: 'pending',
            waiverReason: reason?.trim() || '',
        });

        audit(req.schoolId, req.userId, req.userRole, 'FINE_RAISED', 'Fine', fine._id, null,
            { fineType, amount: fine.amount, issuance: issuanceId });

        // A charge nobody is told about is a charge that surprises somebody at
        // the counter weeks later.
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '💸 Library fine raised',
            body: `A ₹${fine.amount} fine has been raised against "${issuance.book?.title || 'a library book'}"`
                + `${reason?.trim() ? ` — ${reason.trim()}` : ''}.`,
            recipients: [sid(issuance.issuedTo)],
            link: { type: 'library.fines' },
        });

        res.status(201).json({ success: true, data: fine });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Take payment on one fine.
 *
 * Money leaves a trail whichever door it came through, so this is the one place
 * that writes it: the receipt number, the audit row, the member's notice and
 * the desk's own. Both the single-fine endpoint and the bulk one call it.
 *
 * Returns `{ ok: false, status, message }` or `{ ok: true, fine, collected, receiptNumber }`.
 */
async function takeFinePayment(schoolId, fineId, { actorId, actorRole }) {
    const fine = await LibraryFine.findOne({ _id: fineId, school: schoolId, status: 'pending' });
    if (!fine) return { ok: false, status: 404, message: 'Pending fine not found' };

    // Collects what is left after any waiver, not the amount originally
    // charged — otherwise a part-waived fine would be over-collected.
    const owed = outstandingOf(fine);
    if (owed <= 0) return { ok: false, status: 400, message: 'Nothing is outstanding on this fine' };

    // A counter payment gets a receipt too — a parent who pays cash should
    // walk away with the same document as one who paid on their phone.
    const receiptNumber = await nextFineReceiptNumber(schoolId);

    fine.paidAmount    = (fine.paidAmount || 0) + owed;
    fine.status        = fineStatusFor(fine);
    fine.paidAt        = new Date();
    fine.collectedBy   = actorId;
    fine.paymentMode   = 'cash';
    fine.receiptNumber = receiptNumber;
    await fine.save();

    audit(schoolId, actorId, actorRole, 'FINE_PAID', 'Fine', fine._id, null,
        { status: fine.status, mode: 'cash', collected: owed, receiptNumber });
    notify({
        school: schoolId, sender: actorId, senderRole: actorRole,
        title: '💳 Library fine paid',
        body: `A library fine payment of ₹${owed} has been recorded. Thank you.\nReceipt: ${receiptNumber}`,
        recipients: await audienceForUser(schoolId, fine.user),
        link: { type: 'library.myfines' },
    });
    const payer = await User.findById(fine.user).select('name').lean().catch(() => null);
    notifyLibraryStaff({
        schoolId, sender: actorId, senderRole: actorRole,
        title: '💵 Library fine collected at the counter',
        body: `₹${owed} was collected from ${payer?.name || 'a member'} against receipt ${receiptNumber}.`,
        link: { type: 'library.manage.fines' },
    });
    return { ok: true, fine, collected: owed, receiptNumber };
}

exports.collectFine = async (req, res) => {
    try {
        const result = await takeFinePayment(req.schoolId, req.params.id,
            { actorId: req.userId, actorRole: req.userRole });
        if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
        const { fine, collected } = result;
        res.json({ success: true, data: { ...fine.toObject?.() ?? fine, collected } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Settle several fines at once — one member clearing what they owe.
 *
 * Each is taken through the same path a single payment is, so each gets its own
 * receipt: a receipt covering three fines is not a document this module knows
 * how to produce, and inventing one would break the ledger. Refusals are
 * reported per fine rather than failing the batch, because money already taken
 * cannot be rolled back by a later error.
 */
exports.collectFines = async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
        if (!ids.length) return res.status(400).json({ success: false, message: 'Select at least one fine' });

        let collected = 0;
        const receipts = [];
        const skipped  = [];
        for (const id of ids) {
            // eslint-disable-next-line no-await-in-loop -- receipt numbers are a
            // sequence; issuing them concurrently would collide.
            const result = await takeFinePayment(req.schoolId, id, { actorId: req.userId, actorRole: req.userRole });
            if (result.ok) { collected += result.collected; receipts.push(result.receiptNumber); }
            else { skipped.push({ id, reason: result.message }); }
        }
        res.json({ success: true, paid: receipts.length, collected, receipts, skipped });
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
        fine.waivedAt     = new Date();
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

// The one piece of text on the policy: what a fine receipt number starts with.
// It has been on the model since receipts shipped and no endpoint ever accepted
// it, so a school could not move off "LIB" without an edit to the database.
const RECEIPT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9-]{0,7}$/;

const POLICY_FIELDS = [...Object.keys(POLICY_NUMBERS), ...POLICY_FLAGS, 'receiptPrefix'];

// Said once, here: the settings screen needs a name for a field when it reports
// what changed, and the validator needs one when it refuses a value.
const POLICY_LABELS = {
    ...Object.fromEntries(Object.entries(POLICY_NUMBERS).map(([k, v]) => [k, v.label])),
    teacherFinesEnabled:        'Charge late fines to teachers',
    allowMultipleCopiesPerUser: 'Allow two copies of one title per person',
    blockIssueOnPendingFine:    'Block borrowing while a fine is unpaid',
    blockIssueOnOverdue:        'Block borrowing while a book is overdue',
    receiptPrefix:              'Receipt prefix',
};

/**
 * The model's own defaults, read off the schema rather than restated here.
 * "Reset to default" has to mean the value a school starts with, and a second
 * copy of these numbers would be wrong the first time one of them changed.
 */
const policyDefaults = () => {
    const fields = LibraryPolicy.schema.parsed().fields;
    return Object.fromEntries(POLICY_FIELDS.map((f) => [f, fields[f]?.default]));
};

exports.getPolicy = async (req, res) => {
    try {
        const policy = await getOrCreatePolicy(req.schoolId);
        // The policy stores who last changed it as an id; the screen shows a
        // name, and used to show nothing at all.
        let updatedBy = null;
        if (policy.updatedBy) {
            const u = await User.findById(policy.updatedBy).select('name role').lean().catch(() => null);
            if (u) updatedBy = { _id: u._id, name: u.name, role: u.role };
        }
        res.json({
            success: true,
            data: policy,
            updatedBy,
            // The bounds travel with the policy so the form refuses what the
            // server would refuse, in the same words, without a round trip.
            limits: POLICY_NUMBERS,
            defaults: policyDefaults(),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updatePolicy = async (req, res) => {
    try {
        const before = await getOrCreatePolicy(req.schoolId);
        const update = {};

        // Every one of these is read on a hot path — `+'abc'` used to store NaN
        // straight into the policy and take the whole module down with it.
        for (const [field, { min, max, label }] of Object.entries(POLICY_NUMBERS)) {
            const raw = req.body[field];
            // null means "no value sent", not zero. Number(null) is 0, so a
            // client echoing an unset field back would quietly set the fine to
            // nothing rather than leave it alone.
            if (raw === undefined || raw === null || raw === '') continue;
            const n = Number(raw);
            if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max)
                return res.status(400).json({ success: false, message: `${label} must be a whole number between ${min} and ${max}` });
            update[field] = n;
        }
        for (const field of POLICY_FLAGS) {
            // Same reason as the numbers above: !!null is false, and turning a
            // rule off is a decision, not something a missing value should do.
            if (req.body[field] !== undefined && req.body[field] !== null) update[field] = !!req.body[field];
        }
        // `null` has to be skipped alongside undefined and '': a client that
        // echoes a policy back with an unset prefix sends null, and
        // String(null) is the four characters "NULL" — which passes the format
        // check and gets saved, so every later receipt is numbered NULL-000123.
        if (req.body.receiptPrefix !== undefined && req.body.receiptPrefix !== null && req.body.receiptPrefix !== '') {
            const prefix = String(req.body.receiptPrefix).trim().toUpperCase();
            if (!RECEIPT_PREFIX.test(prefix))
                return res.status(400).json({
                    success: false,
                    message: 'Receipt prefix must be 1–8 letters, digits or dashes, starting with a letter or digit',
                });
            update.receiptPrefix = prefix;
        }

        // What actually moved. A save that changed nothing writes nothing: the
        // history is a list of decisions, and a row saying a policy was updated
        // to the values it already had is noise in it.
        const changes = {};
        for (const field of POLICY_FIELDS) {
            if (!(field in update)) continue;
            if (String(before[field] ?? '') === String(update[field] ?? '')) continue;
            changes[field] = { from: before[field] ?? null, to: update[field] };
        }
        if (!Object.keys(changes).length) {
            return res.json({ success: true, data: before, changed: 0 });
        }

        const policy = await LibraryPolicy.findOneAndUpdate(
            { school: req.schoolId },
            { ...update, updatedBy: req.userId, updatedAt: new Date() },
            { upsert: true, new: true },
        ).lean();

        // Both halves of every change, so the history can say what a setting was
        // before somebody moved it — `newValue` alone could only say what it is
        // now, which the policy itself already says.
        audit(
            req.schoolId, req.userId, req.userRole, 'POLICY_UPDATED', 'Policy', policy._id,
            Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.from])),
            Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])),
        );
        res.json({ success: true, data: policy, changed: Object.keys(changes).length });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * What the policy used to say.
 *
 * Reachable by whoever may change the policy, which the audit log proper is
 * not — that stays school_admin-only because it records what the librarians
 * did. This records what was decided about the rules, and a module-admin
 * teacher who can change them can see how they got here.
 */
exports.getPolicyHistory = async (req, res) => {
    try {
        const rows = await LibraryAuditLog.find({ school: req.schoolId, actionType: 'POLICY_UPDATED' })
            .populate('user', 'name')
            .sort({ timestamp: -1 })
            .limit(Math.min(50, Math.max(1, Number(req.query.limit) || 20)))
            .lean();

        const data = rows.map((r) => {
            const from = r.oldValue || {};
            const to   = r.newValue || {};
            return {
                _id: r._id,
                at: r.timestamp,
                by: r.user?.name || '',
                role: r.role || '',
                // Entries written before the diff existed carry the whole update
                // object, `updatedBy` and `updatedAt` included; only settings are
                // shown, and a missing `from` is said as "not recorded" rather
                // than invented.
                changes: Object.keys(to)
                    .filter((f) => POLICY_FIELDS.includes(f))
                    .map((f) => ({ field: f, label: POLICY_LABELS[f] || f, from: from[f] ?? null, to: to[f] })),
            };
        });
        res.json({ success: true, data });
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
