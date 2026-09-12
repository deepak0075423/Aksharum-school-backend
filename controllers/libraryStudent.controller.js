'use strict';
const LibraryBook        = require('../models/LibraryBook');
const LibraryIssuance    = require('../models/LibraryIssuance');
const LibraryReservation = require('../models/LibraryReservation');
const LibraryFine        = require('../models/LibraryFine');
const LibraryAuditLog    = require('../models/LibraryAuditLog');
const User               = require('../models/User');
const {
    ACTIVE_ISSUANCE, getOrCreatePolicy, reindexQueue, activeReservation, placeReservation,
    sweepOverdue, expireStaleHolds, renewIssuance, fmtLibDate,
    notifyLibraryStaff, attachFineSummary,
} = require('../services/libraryRules');
const { notify } = require('../services/notifyService');

// ── Student / Teacher shared endpoints ────────────────────────────────────────

/**
 * A member's own library page — their loans, fines and holds, plus the two
 * pieces of catalogue context that are not personal at all: how big the
 * collection is and what it is made of. Anyone allowed to browse the catalogue
 * can already see both from Search, so they carry no privilege.
 *
 * Everything school-wide — other people's loans, fines across all readers —
 * stays on GET /library/dashboard behind the module-admin guard.
 */
exports.getDashboard = async (req, res) => {
    try {
        const LibraryBookCopy = require('../models/LibraryBookCopy');
        const { query } = require('../db/pool');

        const policy = await getOrCreatePolicy(req.schoolId);
        await Promise.all([
            sweepOverdue(req.schoolId),
            expireStaleHolds(req.schoolId, null, { actor: req.userId, actorRole: req.userRole }),
        ]);

        const [myIssuances, myFines, myReservations, counts, cats, history] = await Promise.all([
            LibraryIssuance.find({ school: req.schoolId, issuedTo: req.userId, status: { $in: ACTIVE_ISSUANCE } })
                .populate('book', 'title isbn authors category coverImage')
                .lean(),
            LibraryFine.find({ school: req.schoolId, user: req.userId, status: 'pending' }).lean(),
            LibraryReservation.find({ school: req.schoolId, reservedBy: req.userId, status: { $in: ['pending','ready'] } })
                .populate('book', 'title')
                .lean(),
            query(
                `SELECT (SELECT count(*)::int FROM "${LibraryBook.tableName}"     WHERE "school" = $1) AS "totalBooks",
                        (SELECT count(*)::int FROM "${LibraryBookCopy.tableName}" WHERE "school" = $1) AS "totalCopies",
                        (SELECT count(*)::int FROM "${LibraryBookCopy.tableName}" WHERE "school" = $1
                           AND "status" = 'available')                                                 AS "availableCopies"`,
                [String(req.schoolId)],
            ),
            // Every book has exactly one category, so these sum to the title count.
            query(
                `SELECT COALESCE(NULLIF(btrim("category"), ''), 'Uncategorised') AS "category",
                        count(*)::int AS "count"
                   FROM "${LibraryBook.tableName}" WHERE "school" = $1
                  GROUP BY 1 ORDER BY 2 DESC, 1 ASC`,
                [String(req.schoolId)],
            ),
            // The member's own last few movements, returns included — the live
            // list above only ever holds what they still have.
            LibraryIssuance.find({ school: req.schoolId, issuedTo: req.userId })
                .populate('book', 'title')
                .sort({ issueDate: -1 }).limit(8).lean(),
        ]);

        res.json({
            success: true,
            data: {
                issuedBooks:   myIssuances,
                pendingFines:  myFines,
                reservations:  myReservations,
                catalogue:     counts.rows[0] || { totalBooks: 0, totalCopies: 0, availableCopies: 0 },
                categories:    cats.rows,
                history:       history.map((i) => ({
                    _id: i._id, title: i.book?.title || 'Book', status: i.status,
                    issueDate: i.issueDate, dueDate: i.dueDate, returnDate: i.returnDate,
                })),
                policy:        { maxBooksPerUser: policy.maxBooksPerUser, issueDurationDays: policy.issueDurationDays },
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// What the catalogue may be ordered by, and the column behind it. A whitelist,
// because the value arrives from the query string.
const SEARCH_SORTS = {
    title_asc:  { title: 1 },
    title_desc: { title: -1 },
    newest:     { createdAt: -1 },
    available:  { availableCopies: -1 },
};

/**
 * The catalogue, as a member browses it.
 *
 * The response carries its own filter options (`facets`) and the four counts
 * above the results (`summary`), so the page never has to guess which
 * categories exist or hard-code a list that drifts from the collection. A
 * facet with nothing behind it is simply absent, which is how the page knows
 * not to offer the filter at all.
 */
exports.search = async (req, res) => {
    try {
        const LibraryBookCopy = require('../models/LibraryBookCopy');
        const { query } = require('../db/pool');
        const { ACTIVE_RESERVATION: HELD } = require('../services/libraryRules');

        const { q, category, language, subject, availability } = req.query;
        const page  = Math.max(1, Math.floor(Number(req.query.page) || 1));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 20)));

        const filter = { school: req.schoolId };
        if (category) filter.category = category;
        if (language) filter.language = language;
        if (subject)  filter.subjects = subject;
        // "Available" is about copies on the shelf, not about the title existing.
        if (availability === 'available') filter.availableCopies = { $gt: 0 };
        if (availability === 'out')       filter.availableCopies = { $lte: 0 };
        if (q) filter.$or = [
            { title:     { $regex: q, $options: 'i' } },
            { authors:   { $elemMatch: { $regex: q, $options: 'i' } } },
            { isbn:      { $regex: q, $options: 'i' } },
            { publisher: { $regex: q, $options: 'i' } },
        ];

        const sort  = SEARCH_SORTS[req.query.sort] || SEARCH_SORTS.title_asc;
        const books = LibraryBook.tableName;
        const sid   = String(req.schoolId);

        const [rows, total, counts, facetRows] = await Promise.all([
            LibraryBook.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
            LibraryBook.countDocuments(filter),
            query(
                `SELECT (SELECT count(*)::int FROM "${books}"                      WHERE "school" = $1) AS "totalBooks",
                        (SELECT count(*)::int FROM "${LibraryBookCopy.tableName}"  WHERE "school" = $1
                           AND "status" = 'available')                                                 AS "availableCopies",
                        (SELECT count(*)::int FROM "${LibraryBookCopy.tableName}"  WHERE "school" = $1
                           AND "status" = 'issued')                                                    AS "issuedCopies",
                        (SELECT count(*)::int FROM "${LibraryReservation.tableName}" WHERE "school" = $1
                           AND "status" = ANY($2::text[]))                                             AS "reserved"`,
                [sid, HELD],
            ),
            // Every filterable value the collection actually contains. Subjects
            // are a jsonb array, so they are unnested rather than grouped whole.
            query(
                `SELECT 'category' AS "kind", btrim("category") AS "value", count(*)::int AS "count"
                   FROM "${books}" WHERE "school" = $1 AND COALESCE(btrim("category"), '') <> '' GROUP BY 2
                  UNION ALL
                 SELECT 'language', btrim("language"), count(*)::int
                   FROM "${books}" WHERE "school" = $1 AND COALESCE(btrim("language"), '') <> '' GROUP BY 2
                  UNION ALL
                 SELECT 'subject', btrim(s."v"), count(*)::int
                   FROM "${books}" b,
                        LATERAL jsonb_array_elements_text(
                            CASE WHEN jsonb_typeof(b."subjects") = 'array' THEN b."subjects" ELSE '[]'::jsonb END
                        ) AS s("v")
                  WHERE b."school" = $1 AND btrim(s."v") <> '' GROUP BY 2
                  ORDER BY 1, 3 DESC, 2 ASC`,
                [sid],
            ),
        ]);

        // The member's own place in the queue for anything on this page.
        const bookIds      = rows.map((b) => b._id);
        const reservations = bookIds.length
            ? await LibraryReservation.find({
                book: { $in: bookIds }, reservedBy: req.userId, status: { $in: HELD },
            }).lean()
            : [];
        const resMap = Object.fromEntries(reservations.map((r) => [String(r.book), r]));

        const facets = { category: [], language: [], subject: [] };
        facetRows.rows.forEach((f) => { if (facets[f.kind]) facets[f.kind].push({ value: f.value, count: f.count }); });

        res.json({
            success: true,
            data:    rows.map((b) => ({ ...b, myReservation: resMap[String(b._id)] || null })),
            total, page, pages: Math.ceil(total / limit),
            summary: counts.rows[0] || { totalBooks: 0, availableCopies: 0, issuedCopies: 0, reserved: 0 },
            facets,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.reserve = async (req, res) => {
    try {
        const { bookId } = req.params;
        // Every rule lives in placeReservation, so the desk and the member's own
        // screen cannot drift apart on what a reservation is allowed to be.
        const result = await placeReservation({
            schoolId: req.schoolId, bookId, userId: req.userId,
            actorId: req.userId, actorRole: req.userRole, self: true,
        });
        if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
        const { reservation, book, readyNow } = result;

        // A silent success reads as a failure — say what happened and where
        // they stand.
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: readyNow ? '🔖 Reserved book ready' : '🔖 Reservation placed',
            body: readyNow
                ? `"${book.title}" is being held for you. Collect it before ${fmtLibDate(reservation.expiresAt)}.`
                : `You are number ${reservation.queuePosition} in the queue for "${book.title}". We will let you know when it is ready.`,
            recipients: [req.userId],
            includeSender: true,
            link: { type: 'library.reservations', entityId: reservation._id },
        });

        // A reservation is placed by the member, so nobody at the desk has seen
        // it happen. This is the notification the module was most obviously
        // missing: a hold shelf nobody is told to fill.
        const member = await User.findById(req.userId).select('name').lean().catch(() => null);
        notifyLibraryStaff({
            schoolId: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: readyNow ? '🔖 Reserved copy to hold' : '🔖 New reservation',
            body: readyNow
                ? `${member?.name || 'A member'} reserved "${book.title}" — a copy is free, set it aside before ${fmtLibDate(reservation.expiresAt)}.`
                : `${member?.name || 'A member'} joined the queue for "${book.title}" at position ${reservation.queuePosition}.`,
            link: { type: 'library.manage.reservations', entityId: reservation._id },
        });

        res.status(201).json({ success: true, data: reservation });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.cancelReservation = async (req, res) => {
    try {
        const reservation = await LibraryReservation.findOneAndUpdate(
            { _id: req.params.id, reservedBy: req.userId, school: req.schoolId, status: { $in: ['pending','ready'] } },
            { status: 'cancelled', closedAt: new Date() },
            { new: true }
        ).lean();
        if (!reservation) return res.status(404).json({ success: false, message: 'Active reservation not found' });
        await reindexQueue(req.schoolId, reservation.book);
        await LibraryAuditLog.create({
            school: req.schoolId, user: req.userId, role: req.userRole,
            actionType: 'RESERVATION_CANCELLED', entityType: 'Reservation', entityId: reservation._id,
        });
        // Only worth the desk's attention when a copy was actually being held
        // for them — a queue place given up changes nothing on the shelf.
        if (reservation.status === 'cancelled' && reservation.readyAt) {
            const book = await LibraryBook.findById(reservation.book).select('title').lean().catch(() => null);
            const who  = await User.findById(req.userId).select('name').lean().catch(() => null);
            notifyLibraryStaff({
                schoolId: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '🔖 Held copy released',
                body: `${who?.name || 'A member'} cancelled their hold on "${book?.title || 'a book'}" — the copy can go back on the shelf.`,
                link: { type: 'library.manage.reservations', entityId: reservation._id },
            });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// A member asking to extend their own loan. Same rules as the counter — the
// librarian only had to be involved because there was no route for this.
exports.requestRenewal = async (req, res) => {
    try {
        await sweepOverdue(req.schoolId);
        const result = await renewIssuance(req.schoolId, req.params.id, {
            onlyForUser: req.userId, actor: req.userId, actorRole: req.userRole,
        });
        if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

        await LibraryAuditLog.create({
            school: req.schoolId, user: req.userId, role: req.userRole,
            actionType: 'BOOK_RENEWED', entityType: 'Issuance', entityId: result.issuance._id,
            newValue: { newDueDate: result.issuance.dueDate, renewalCount: result.issuance.renewalCount, self: true },
        });
        res.json({ success: true, data: result.issuance, message: `Renewed — now due ${fmtLibDate(result.issuance.dueDate)}` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Every loan this member has ever had, newest first.
 *
 * The academic year rides along so the page can say "returned this year"
 * truthfully rather than counting all of history and labelling it as the year,
 * and the outstanding total is read from the fines themselves — a charge that
 * was never tied to a loan would otherwise go uncounted.
 */
exports.getMyBooks = async (req, res) => {
    try {
        const AcademicYear = require('../models/AcademicYear');
        await sweepOverdue(req.schoolId);

        const { status } = req.query;
        const filter = { school: req.schoolId, issuedTo: req.userId };
        if (status) filter.status = status;

        const [issuances, year, fines] = await Promise.all([
            LibraryIssuance.find(filter)
                .populate('book',    'title isbn authors category coverImage')
                .populate('bookCopy','uniqueCode')
                .sort({ issueDate: -1 })
                .lean(),
            AcademicYear.findOne({ school: req.schoolId, status: 'active' })
                .select('yearName startDate endDate').lean(),
            LibraryFine.find({ school: req.schoolId, user: req.userId, status: 'pending' })
                .select('amount waivedAmount paidAmount').lean(),
        ]);

        const now = new Date();
        // A lost book is still a row on this list, and until now it carried
        // nothing but the word "lost" — no charge, no receipt, no way to tell a
        // settled loss from an unpaid one.
        const withFines = await attachFineSummary(issuances);
        const data = withFines.map(i => ({
            ...i,
            isOverdue: ACTIVE_ISSUANCE.includes(i.status) && now > new Date(i.dueDate),
        }));

        const finesOutstanding = fines.reduce((sum, f) => sum + Math.max(
            0, Number(f.amount || 0) - Number(f.waivedAmount || 0) - Number(f.paidAmount || 0),
        ), 0);

        res.json({ success: true, data, academicYear: year || null, finesOutstanding });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getMyFines = async (req, res) => {
    try {
        const { status } = req.query;
        const filter = { school: req.schoolId, user: req.userId };
        if (status) filter.status = status;

        const fines = await LibraryFine.find(filter)
            .populate('issuance', 'issueDate dueDate returnDate')
            .sort({ createdAt: -1 })
            .lean();
        res.json({ success: true, data: fines });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
