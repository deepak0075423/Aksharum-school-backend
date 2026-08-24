'use strict';
/**
 * Library rules that more than one controller has to agree on: who may borrow
 * what, what counts as the same book, and the counters/queues that have to be
 * adjusted in SQL rather than in JS.
 *
 * These lived in library.controller.js while only the librarian endpoints used
 * them. The student endpoints enforce the same limits, and a second copy of
 * "can this person borrow?" is exactly the kind of thing that drifts.
 */
const LibraryBook        = require('../models/LibraryBook');
const LibraryBookCopy    = require('../models/LibraryBookCopy');
const LibraryIssuance    = require('../models/LibraryIssuance');
const LibraryReservation = require('../models/LibraryReservation');
const LibraryFine        = require('../models/LibraryFine');
const LibraryPolicy      = require('../models/LibraryPolicy');
const LibraryAuditLog    = require('../models/LibraryAuditLog');
const User               = require('../models/User');
const pool               = require('../db/pool');
const { notify, withParents } = require('./notifyService');
const { withTransaction, lock, buildInsert } = require('./dbTx');

const fmtLibDate = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

// Guard rail for the "add N copies" form and the bulk-import `copies` column.
const MAX_COPIES_PER_ADD = 100;
const COPY_STATUSES = ['available', 'reserved', 'lost', 'damaged', 'issued'];
const ACTIVE_ISSUANCE = ['issued', 'overdue'];
// A loan longer than a school year is a typo, not a policy.
const MAX_LOAN_DAYS = 365;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreatePolicy(schoolId) {
    let policy = await LibraryPolicy.findOne({ school: schoolId }).lean();
    if (!policy) policy = (await LibraryPolicy.create({ school: schoolId })).toObject();
    return policy;
}

async function audit(schoolId, userId, role, actionType, entityType, entityId, oldValue, newValue) {
    try {
        await LibraryAuditLog.create({ school: schoolId, user: userId, role, actionType, entityType, entityId, oldValue, newValue });
    } catch (e) { /* non-critical */ }
}

// Reserves `count` consecutive copy codes. The bump has to be a single SQL
// statement: the ORM's $inc reads the row into JS and writes it back, so two
// librarians adding copies at the same moment are handed the same sequence and
// the second insert dies on the unique (school, uniqueCode) index. UPDATE …
// RETURNING takes the row lock, so the ranges can only ever be disjoint.
async function reserveCopyCodes(schoolId, count) {
    const bump = () => pool.query(
        `UPDATE "${LibraryPolicy.tableName}"
            SET "lastCopySequence" = COALESCE("lastCopySequence", 0) + $2
          WHERE "school" = $1
      RETURNING "lastCopySequence"`,
        [String(schoolId), count],
    );

    let { rows } = await bump();
    if (!rows.length) {
        // First copy this school has ever registered — no policy row yet.
        await getOrCreatePolicy(schoolId);
        ({ rows } = await bump());
        if (!rows.length) throw new Error('Could not reserve copy codes');
    }

    const last  = Number(rows[0].lastCopySequence);
    const codes = [];
    for (let seq = last - count + 1; seq <= last; seq++) {
        codes.push(`LIB-COPY-${String(seq).padStart(6, '0')}`);
    }
    return codes;
}

// totalCopies / availableCopies are denormalised onto the book and read by the
// whole module to decide what can be issued. The ORM's $inc is a read-modify-
// write in JS, so two requests against the same title (two counters issuing at
// once, or a librarian adding copies while one is returned) silently lose one
// of the updates. Push the arithmetic into Postgres, where it is atomic, and
// clamp at zero so a stray decrement can never leave a negative count.
async function bumpBookCounts(bookId, { total = 0, available = 0 }) {
    if (!total && !available) return;
    await pool.query(
        `UPDATE "${LibraryBook.tableName}"
            SET "totalCopies"     = GREATEST(COALESCE("totalCopies", 0) + $2, 0),
                "availableCopies" = GREATEST(COALESCE("availableCopies", 0) + $3, 0)
          WHERE "_id" = $1`,
        [String(bookId), total, available],
    );
}

// ── Catalogue identity ───────────────────────────────────────────────────────

// ISBNs are written every which way — 978-0-13-235088-4, 9780132350884,
// "978 0 13 235088 4". Compare on the digits alone.
const normIsbn = (v) => String(v || '').replace(/[^0-9Xx]/g, '').toUpperCase();
const normText = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Shape only — a full ISBN-13 checksum would reject the older or home-grown
// accession numbers plenty of school libraries still use.
const isValidIsbn = (v) => /^[0-9]{10}$|^[0-9]{13}$|^[0-9]{9}X$/.test(normIsbn(v));

/**
 * The book already in this school's catalogue that `input` would duplicate, or
 * null. Identity is the ISBN when both sides have one, because that is what an
 * ISBN is for; otherwise title + edition, which is how a librarian tells two
 * printings apart on the shelf. Two entries carrying *different* ISBNs are left
 * alone — same title, genuinely different book.
 *
 * A second physical book of the same title is a *copy*, not a second catalogue
 * row, and that distinction is the whole reason this check exists.
 *
 * Reads the persisted normalised columns, so this is an index lookup rather
 * than a scan — it used to normalise inside the query, which meant one full
 * table scan per book and a quadratic bulk import. The same columns carry
 * unique indexes, so a caller that skips this check still cannot create the
 * duplicate; this exists to produce a helpful error instead of a constraint
 * violation.
 */
async function findDuplicateBook(schoolId, input, excludeId = null) {
    const isbn  = normIsbn(input.isbn);
    const title = normText(input.title);
    const edition = String(input.edition || '').trim();

    const base = { school: schoolId };
    if (excludeId) base._id = { $ne: String(excludeId) };

    if (isbn) {
        const byIsbn = await LibraryBook.findOne({ ...base, isbnNormalized: isbn })
            .select('title isbn edition').lean();
        if (byIsbn) return byIsbn;
    }

    // Title + edition decides it whenever at least one side is not identified by
    // an ISBN. If the incoming book has none, any existing printing of that
    // title is the duplicate; if it has one, only an existing row that lacks an
    // ISBN is comparable — two different ISBNs mean two different books.
    const byTitle = await LibraryBook.findOne({
        ...base,
        titleNormalized: title,
        edition,
        ...(isbn ? { isbnNormalized: '' } : {}),
    }).select('title isbn edition').lean();
    return byTitle || null;
}

/** 409 body that tells the UI which existing book to send the librarian to. */
const duplicateResponse = (res, dup) => res.status(409).json({
    success: false,
    code: 'DUPLICATE_BOOK',
    message: `"${dup.title}" is already in the catalogue${dup.isbn ? ` (ISBN ${dup.isbn})` : ''} — add copies to that entry instead of creating it again`,
    data: { existingBookId: dup._id, title: dup.title },
});

// ── Borrower eligibility ─────────────────────────────────────────────────────

// Books go to the people a school library serves. Admins and parents borrow
// through their own account only if the school gives them one of these roles.
const BORROWER_ROLES = ['student', 'teacher'];

/**
 * Every rule that decides whether this person may take this book right now, in
 * one place so the issue counter and any future self-checkout answer alike.
 * Resolves to `{ ok: true, user }` or `{ ok: false, status, message }`.
 */
async function checkBorrowerEligibility({ schoolId, userId, bookId, policy }) {
    const user = await User.findOne({ _id: userId, school: schoolId })
        .select('name role isActive').lean();
    if (!user) return { ok: false, status: 404, message: 'Borrower not found in this school' };
    if (user.isActive === false) return { ok: false, status: 400, message: `${user.name}'s account is inactive` };
    if (!BORROWER_ROLES.includes(user.role))
        return { ok: false, status: 400, message: `Books can only be issued to ${BORROWER_ROLES.join(' or ')} accounts` };

    // (a) One copy of a title per person, unless the school opts out.
    if (!policy.allowMultipleCopiesPerUser) {
        const sameTitle = await LibraryIssuance.findOne({
            school: schoolId, issuedTo: userId, book: bookId, status: { $in: ACTIVE_ISSUANCE } })
            .select('_id dueDate').lean();
        if (sameTitle) return {
            ok: false, status: 400,
            message: `${user.name} already has a copy of this book (due ${fmtLibDate(sameTitle.dueDate)}) — it must be returned first`,
        };
    }

    const activeCount = await LibraryIssuance.countDocuments({
        school: schoolId, issuedTo: userId, status: { $in: ACTIVE_ISSUANCE } });
    const maxBooks = policy.maxBooksPerUser || 3;
    if (activeCount >= maxBooks)
        return { ok: false, status: 400, message: `${user.name} already has ${activeCount} of a maximum ${maxBooks} books` };

    if (policy.blockIssueOnOverdue) {
        const overdue = await LibraryIssuance.findOne({
            school: schoolId, issuedTo: userId, status: { $in: ACTIVE_ISSUANCE },
            dueDate: { $lt: new Date() } }).select('_id').lean();
        if (overdue) return { ok: false, status: 400, message: `${user.name} has an overdue book — it must be returned first` };
    }

    if (policy.blockIssueOnPendingFine) {
        const fines = await LibraryFine.find({ school: schoolId, user: userId, status: 'pending' })
            .select('amount waivedAmount paidAmount').lean();
        const owed = fines.reduce((sum, f) => sum + outstandingOf(f), 0);
        if (owed > 0)
            return { ok: false, status: 400, message: `${user.name} has ₹${owed} in unpaid library fines` };
    }

    return { ok: true, user };
}

// Copies are only ever created through here, so the shape stays in one place.
function buildCopy(schoolId, bookId, uniqueCode, userId, { condition, rackLocation, acquisitionDate, vendor, billNumber, cost } = {}) {
    return {
        school: schoolId, book: bookId,
        uniqueCode, status: 'available',
        condition: condition || 'new',
        rackLocation: rackLocation || '',
        acquisitionDate: acquisitionDate ? new Date(acquisitionDate) : null,
        vendor: vendor || '',
        billNumber: billNumber || '',
        cost: Number.isFinite(Number(cost)) ? Math.max(0, Number(cost)) : 0,
        addedBy: userId,
    };
}

/**
 * Whether a late fine applies to this borrower at all. `teacherFinesEnabled`
 * has been on the policy — and on both policy screens as "Fines apply to
 * teachers" — since the module shipped, but nothing ever read it, so teachers
 * were fined regardless of what the school had set.
 */
async function fineApplies(schoolId, issuance, policy) {
    if (policy.teacherFinesEnabled) return true;
    let role = issuance.issuedToRole;
    // Older rows were written before the role was recorded reliably.
    if (!role) {
        const user = await User.findById(issuance.issuedTo).select('role').lean();
        role = user?.role || '';
    }
    return role !== 'teacher';
}

async function calcFine(issuance, policy) {
    if (!issuance.dueDate) return 0;
    const returnDate = new Date();
    const due        = new Date(issuance.dueDate);
    const graceDays  = policy?.gracePeriodDays || 0;
    const finePerDay = policy?.finePerDay || 0;
    const daysLate   = Math.ceil((returnDate - due) / 86400000) - graceDays;
    return daysLate > 0 ? daysLate * finePerDay : 0;
}


// ── Atomic circulation ───────────────────────────────────────────────────────
//
// Issuing and returning each move several tables, and the ORM issues every
// statement standalone. A failure between them used to leave a copy marked
// issued with no issuance behind it, or a returned book whose counters never
// caught up. Both now run as one transaction on one client, behind an advisory
// lock on the book so two counters working the same title serialise.
//
// Only the writes that must agree live inside. Audit rows and notifications
// stay outside: they are already best-effort, and holding a client open while
// an email goes out would be worse than losing an audit line.

const T_COPY  = () => `"${LibraryBookCopy.tableName}"`;
const T_BOOK  = () => `"${LibraryBook.tableName}"`;
const T_ISS   = () => `"${LibraryIssuance.tableName}"`;
const T_FINE  = () => `"${LibraryFine.tableName}"`;

/**
 * Claims the copy, writes the issuance and decrements availability as one unit.
 * Resolves to the new issuance id, or null when the copy was taken first.
 */
async function commitIssue({ schoolId, bookId, copyId, userId, userRole, issuedBy, dueDate, notes }) {
    return withTransaction(async (q) => {
        await lock(q, `library:book:${bookId}`);

        const claim = await q(
            `UPDATE ${T_COPY()} SET "status" = 'issued'
              WHERE "_id" = $1::uuid AND "book" = $2::uuid AND "school" = $3::uuid AND "status" = 'available'
          RETURNING "_id"`,
            [String(copyId), String(bookId), String(schoolId)],
        );
        if (!claim.rowCount) return null;

        const { sql, params, id } = buildInsert(LibraryIssuance, {
            school: schoolId, book: bookId, bookCopy: copyId,
            issuedTo: userId, issuedToRole: userRole || '', issuedBy,
            issueDate: new Date(), dueDate, notes: notes || '',
        });
        await q(sql, params);

        await q(
            `UPDATE ${T_BOOK()} SET "availableCopies" = GREATEST(COALESCE("availableCopies", 0) - 1, 0)
              WHERE "_id" = $1::uuid`,
            [String(bookId)],
        );
        return id;
    });
}

/**
 * Closes the loan, settles the copy and raises the fine as one unit.
 * `copyStatus` is 'available' only when the book is actually back on the shelf.
 */
async function commitReturn({ schoolId, issuance, condition, copyStatus, fineAmount, fineType, daysOverdue, notes }) {
    return withTransaction(async (q) => {
        await lock(q, `library:book:${issuance.book}`);

        const closed = await q(
            `UPDATE ${T_ISS()} SET "status" = $2, "returnDate" = now(), "notes" = COALESCE($3, "notes")
              WHERE "_id" = $1::uuid AND "status" = ANY($4::text[])
          RETURNING "_id"`,
            [String(issuance._id), condition === 'lost' ? 'lost' : 'returned', notes || null, ACTIVE_ISSUANCE],
        );
        if (!closed.rowCount) return null;   // someone else closed it first

        await q(
            `UPDATE ${T_COPY()} SET "status" = $2 WHERE "_id" = $1::uuid`,
            [String(issuance.bookCopy), copyStatus],
        );

        if (copyStatus === 'available') {
            await q(
                `UPDATE ${T_BOOK()} SET "availableCopies" = GREATEST(COALESCE("availableCopies", 0) + 1, 0)
                  WHERE "_id" = $1::uuid`,
                [String(issuance.book)],
            );
        }

        let fineId = null;
        if (fineAmount > 0) {
            const built = buildInsert(LibraryFine, {
                school: schoolId, issuance: issuance._id, user: issuance.issuedTo,
                fineType, amount: fineAmount, daysOverdue,
            });
            await q(built.sql, built.params);
            fineId = built.id;
            await q(`UPDATE ${T_ISS()} SET "fine" = $2::uuid WHERE "_id" = $1::uuid`,
                [String(issuance._id), fineId]);
        }
        return { fineId };
    });
}

/**
 * Next receipt number for a fine payment, e.g. LIB-REC-000042.
 *
 * One SQL statement for the same reason the copy counter is: the ORM's $inc is
 * a read-modify-write, so two payments landing together would be handed the
 * same receipt number.
 */
async function nextFineReceiptNumber(schoolId) {
    const bump = () => pool.query(
        `UPDATE "${LibraryPolicy.tableName}"
            SET "lastReceiptNumber" = COALESCE("lastReceiptNumber", 0) + 1
          WHERE "school" = $1
      RETURNING "lastReceiptNumber", "receiptPrefix"`,
        [String(schoolId)],
    );

    let { rows } = await bump();
    if (!rows.length) {
        await getOrCreatePolicy(schoolId);
        ({ rows } = await bump());
        if (!rows.length) throw new Error('Could not allocate a receipt number');
    }
    const prefix = (rows[0].receiptPrefix || 'LIB').trim() || 'LIB';
    return `${prefix}-REC-${String(rows[0].lastReceiptNumber).padStart(6, '0')}`;
}

// ── Fine arithmetic ──────────────────────────────────────────────────────────

/** What is still owed on a fine after any waiver and any part payment. */
const outstandingOf = (fine) => Math.max(
    0,
    Number(fine?.amount || 0) - Number(fine?.waivedAmount || 0) - Number(fine?.paidAmount || 0),
);

/**
 * The status a fine should carry given its arithmetic. Derived rather than set
 * by hand so a part-waived fine cannot end up marked settled while money is
 * still owed.
 */
function fineStatusFor(fine) {
    if (outstandingOf(fine) > 0) return 'pending';
    return Number(fine.paidAmount || 0) > 0 ? 'paid' : 'waived';
}

/**
 * Fills in waivedAmount / paidAmount on fines settled before those columns
 * existed. Without it every historical 'paid' row reads as fully outstanding,
 * because its paidAmount defaults to zero. Self-healing: once every row is
 * squared this matches nothing.
 */
async function backfillFineAmounts(schoolId) {
    const T = `"${LibraryFine.tableName}"`;
    const { rowCount } = await pool.query(
        `UPDATE ${T}
            SET "paidAmount"   = CASE WHEN "status" = 'paid'   THEN "amount" ELSE COALESCE("paidAmount", 0) END,
                "waivedAmount" = CASE WHEN "status" = 'waived' THEN "amount" ELSE COALESCE("waivedAmount", 0) END
          WHERE "school" = $1
            AND "status" IN ('paid', 'waived')
            AND COALESCE("paidAmount", 0) = 0
            AND COALESCE("waivedAmount", 0) = 0`,
        [String(schoolId)],
    );
    return rowCount;
}

// ── Lazy state sweeps ────────────────────────────────────────────────────────
//
// Two transitions in this module happen because time passed, not because anyone
// clicked: a loan becomes overdue, and an uncollected hold expires. The EJS app
// ran them on page load and the port dropped them, so `status: 'overdue'` was
// never written (the dashboard tile sat at 0 forever) and a `ready` reservation
// never lapsed — one no-show froze a copy permanently.
//
// Each is a single UPDATE, cheap enough to run on the read paths that care.

/**
 * A student's people: the student plus whoever the profile lists as parent.
 * A teacher is only ever themselves. Money and lateness are exactly the things
 * a parent expects to hear about, so those messages go to both.
 */
async function borrowerAudience(issuance) {
    const borrower = String(issuance.issuedTo);
    if (issuance.issuedToRole && issuance.issuedToRole !== 'student') return [borrower];
    try {
        return await withParents([borrower]);
    } catch {
        return [borrower];   // never let a lookup failure swallow the message
    }
}

/**
 * Flags loans whose due date has passed, and tells the borrower.
 *
 * The UPDATE only matches rows still marked 'issued', so it flips each loan
 * exactly once and RETURNING hands back precisely the ones that just tipped —
 * which is what makes it safe to notify from here without sending the same
 * message on every sweep.
 */
async function sweepOverdue(schoolId) {
    const T = `"${LibraryIssuance.tableName}"`;
    const { rows } = await pool.query(
        `UPDATE ${T} SET "status" = 'overdue'
          WHERE "school" = $1 AND "status" = 'issued' AND "dueDate" < now()
      RETURNING "_id", "book", "issuedTo", "issuedToRole", "issuedBy", "dueDate"`,
        [String(schoolId)],
    );
    if (!rows.length) return 0;

    const policy = await getOrCreatePolicy(schoolId);
    const books  = await LibraryBook.find({ _id: { $in: [...new Set(rows.map(r => String(r.book)))] } })
        .select('title').lean();
    const titleOf = Object.fromEntries(books.map(b => [String(b._id), b.title]));

    for (const row of rows) {
        const days = Math.max(1, Math.ceil((Date.now() - new Date(row.dueDate)) / 86400000));
        const rate = policy.finePerDay || 0;
        notify({
            school: schoolId, sender: row.issuedBy, senderRole: 'system',
            title: '⚠️ Library book overdue',
            body: `"${titleOf[String(row.book)] || 'A library book'}" was due on ${fmtLibDate(row.dueDate)}`
                + ` and is now ${days} day${days === 1 ? '' : 's'} overdue.`
                + (rate ? ` A fine of ₹${rate} a day applies until it is returned.` : ' Please return it.'),
            recipients: await borrowerAudience(row),
            link: { type: 'library.mybooks' },
        });
    }
    return rows.length;
}

/**
 * Lapses holds nobody collected, then offers the freed copy to the next person
 * in the queue. Scoped to one book when a caller only cares about that title.
 */
async function expireStaleHolds(schoolId, bookId = null, { actor, actorRole } = {}) {
    const T = `"${LibraryReservation.tableName}"`;
    const { rows: lapsed } = await pool.query(
        `UPDATE ${T} SET "status" = 'expired'
          WHERE "school" = $1 AND "status" = 'ready'
            AND "expiresAt" IS NOT NULL AND "expiresAt" < now()
            AND ($2::uuid IS NULL OR "book" = $2::uuid)
      RETURNING "_id", "book", "reservedBy"`,
        [String(schoolId), bookId ? String(bookId) : null],
    );
    if (!lapsed.length) return [];

    const policy = await getOrCreatePolicy(schoolId);
    const books  = await LibraryBook.find({ _id: { $in: [...new Set(lapsed.map(r => String(r.book)))] } })
        .select('title').lean();
    const titleOf = Object.fromEntries(books.map(b => [String(b._id), b.title]));

    for (const row of lapsed) {
        await LibraryAuditLog.create({
            school: schoolId, user: null, role: 'system',
            actionType: 'RESERVATION_EXPIRED', entityType: 'Reservation', entityId: row._id,
            oldValue: { status: 'ready' }, newValue: { status: 'expired' },
        }).catch(() => {});

        // Losing a hold silently is the worst version of this: the member turns
        // up for a book that was given to someone else days ago.
        if (actor) {
            notify({
                school: schoolId, sender: actor, senderRole: actorRole || 'system',
                title: '⌛ Reserved book no longer held',
                body: `"${titleOf[String(row.book)] || 'A book'}" was held for you but not collected in time,`
                    + ` so it has gone back on the shelf. You can reserve it again if you still want it.`,
                recipients: [row.reservedBy],
                link: { type: 'library.reservations' },
            });
        }

        await reindexQueue(schoolId, row.book);
        await promoteQueue(schoolId, row.book, policy, { actor, actorRole });
    }
    return lapsed;
}

/**
 * Hands free copies to the front of the queue, one per copy, skipping copies
 * already spoken for by an existing hold. Safe to call whenever a copy frees up.
 *
 * Returns the promoted reservations carrying their *new* readyAt/expiresAt —
 * callers put that deadline in the "collect it before…" message, and the rows
 * read before the update still held the old (null) values.
 *
 * `actor` is whoever's request triggered this; notifications need a sender, and
 * a promotion always has a person behind it even when it happens as a side
 * effect of a page load.
 */
async function promoteQueue(schoolId, bookId, policy, { actor, actorRole } = {}) {
    const [freeCopies, held] = await Promise.all([
        LibraryBookCopy.countDocuments({ school: schoolId, book: bookId, status: 'available' }),
        LibraryReservation.countDocuments({ school: schoolId, book: bookId, status: 'ready' }),
    ]);
    let slots = freeCopies - held;
    if (slots < 1) return [];

    const waiting = await LibraryReservation.find({ school: schoolId, book: bookId, status: 'pending' })
        .sort({ queuePosition: 1, reservedAt: 1 }).limit(slots).lean();

    const promoted = [];
    for (const r of waiting) {
        if (slots-- < 1) break;
        const readyAt   = new Date();
        const expiresAt = new Date(Date.now() + (policy.reservationExpiryDays || 2) * 86400000);
        await LibraryReservation.updateOne({ _id: r._id }, { status: 'ready', readyAt, expiresAt });
        promoted.push({ ...r, status: 'ready', readyAt, expiresAt });
    }
    if (!promoted.length) return [];

    await reindexQueue(schoolId, bookId);

    if (actor) {
        const book = await LibraryBook.findById(bookId).select('title').lean().catch(() => null);
        for (const r of promoted) {
            notify({
                school: schoolId, sender: actor, senderRole: actorRole || '',
                title: '🔖 Reserved book available',
                body: `"${book?.title || 'A book'}" you reserved is now available. Collect it before ${fmtLibDate(r.expiresAt)}.`,
                recipients: [r.reservedBy],
                link: { type: 'library.reservations' },
            });
        }
    }
    return promoted;
}

/**
 * "Your book is due in N days." The one message that actually reduces overdue
 * books, and impossible before there was a moment before the due date at which
 * library code ran at all.
 *
 * Idempotent by `dueSoonNotifiedFor`: the stamp records which due date was
 * warned about, so a restart mid-sweep sends nothing twice and a renewal
 * re-arms the reminder for the new date.
 */
async function sendDueSoonReminders(schoolId, { daysAhead = 2 } = {}) {
    const horizon = new Date(Date.now() + daysAhead * 86400000);
    const due = await LibraryIssuance.find({
        school: schoolId,
        status: 'issued',
        dueDate: { $gte: new Date(), $lte: horizon },
    }).populate('book', 'title').limit(500).lean();

    let sent = 0;
    for (const iss of due) {
        if (iss.dueSoonNotifiedFor && new Date(iss.dueSoonNotifiedFor).getTime() === new Date(iss.dueDate).getTime()) continue;
        notify({
            school: schoolId, sender: iss.issuedBy, senderRole: 'system',
            title: '⏰ Library book due soon',
            body: `"${iss.book?.title || 'A library book'}" is due back on ${fmtLibDate(iss.dueDate)}. Renew it or bring it in to avoid a fine.`,
            recipients: [iss.issuedTo],
            link: { type: 'library.mybooks' },
        });
        await LibraryIssuance.updateOne({ _id: iss._id }, { dueSoonNotifiedFor: iss.dueDate });
        sent += 1;
    }
    return sent;
}

/**
 * Everything the library needs the clock to do, for one school. Called by the
 * scheduled worker; the read paths call the individual sweeps as a safety net
 * so a stopped worker degrades rather than breaks.
 */
async function runLibrarySweep(schoolId) {
    await backfillIssuedToRole(schoolId);
    await backfillFineAmounts(schoolId);
    const overdue = await sweepOverdue(schoolId);
    const lapsed  = await expireStaleHolds(schoolId);
    const nudged  = await sendDueSoonReminders(schoolId);
    return { overdue, lapsed: lapsed.length, nudged };
}

/**
 * Fills in `issuedToRole` on loans written before it was recorded reliably.
 * Circulation can be filtered by role, and that filter reads this column — a
 * blank one would quietly drop those loans from the results. Self-healing: once
 * every row is stamped this matches nothing and costs nothing.
 */
async function backfillIssuedToRole(schoolId) {
    const { rowCount } = await pool.query(
        `UPDATE "${LibraryIssuance.tableName}" i
            SET "issuedToRole" = u."role"
           FROM "${User.tableName}" u
          WHERE u."_id" = i."issuedTo"
            AND i."school" = $1
            AND COALESCE(i."issuedToRole", '') = ''`,
        [String(schoolId)],
    );
    return rowCount;
}

/**
 * Trims the audit trail to the retention window. The log is immutable while it
 * matters and gone once it does not — without this it grows forever, and a
 * 5,000-copy import writes 5,000 rows in an afternoon.
 */
async function pruneAuditLog(schoolId, keepDays = 400) {
    const { rowCount } = await pool.query(
        `DELETE FROM "${LibraryAuditLog.tableName}"
          WHERE "school" = $1 AND "timestamp" < now() - ($2 || ' days')::interval`,
        [String(schoolId), String(keepDays)],
    );
    return rowCount;
}

// ── Reservation queue ────────────────────────────────────────────────────────

/**
 * Renumbers the pending queue for one book to 1..n by the order people joined
 * it. Called after anything leaves the queue (collected, cancelled, expired)
 * and after anything joins, which also makes the position a *new* reservation
 * picks for itself irrelevant — two students reserving in the same instant end
 * up correctly ordered by reservedAt instead of fighting over one number.
 *
 * One statement, so the renumbering cannot interleave with another.
 */
async function reindexQueue(schoolId, bookId) {
    const T = `"${LibraryReservation.tableName}"`;
    await pool.query(
        `WITH ordered AS (
             SELECT "_id", row_number() OVER (ORDER BY "reservedAt" ASC, "createdAt" ASC, "_id" ASC) AS rn
               FROM ${T}
              WHERE "school" = $1 AND "book" = $2 AND "status" = 'pending'
         )
         UPDATE ${T} r
            SET "queuePosition" = o.rn
           FROM ordered o
          WHERE r."_id" = o."_id" AND r."queuePosition" IS DISTINCT FROM o.rn`,
        [String(schoolId), String(bookId)],
    );
}

/**
 * Renewal, shared by the librarian endpoint and the member's own request so the
 * rules cannot drift apart. `onlyForUser` scopes it to the caller's own loan.
 */
async function renewIssuance(schoolId, issuanceId, { onlyForUser = null, actor = null, actorRole = '' } = {}) {
    const filter = { _id: issuanceId, school: schoolId, status: { $in: ACTIVE_ISSUANCE } };
    if (onlyForUser) filter.issuedTo = onlyForUser;

    const issuance = await LibraryIssuance.findOne(filter);
    if (!issuance) return { ok: false, status: 404, message: 'Active issuance not found' };

    const policy = await getOrCreatePolicy(schoolId);
    if (issuance.renewalCount >= (policy.maxRenewals || 1))
        return { ok: false, status: 400, message: `This book has already been renewed the maximum ${policy.maxRenewals} time(s)` };

    // Renewal is for a loan in good standing. An overdue book has to come back
    // so the fine is settled against a real return date.
    if (new Date(issuance.dueDate) < new Date())
        return { ok: false, status: 400, message: 'This book is overdue — it must be returned before it can be renewed' };

    const waiting = await LibraryReservation.findOne({
        book: issuance.book, school: schoolId, status: { $in: ['pending', 'ready'] } }).lean();
    if (waiting) return { ok: false, status: 400, message: 'Someone is waiting for this book — it cannot be renewed' };

    issuance.dueDate      = new Date(issuance.dueDate.getTime() + (policy.issueDurationDays || 14) * 86400000);
    issuance.renewalCount += 1;
    issuance.dueSoonNotifiedFor = null;   // the new due date deserves its own reminder
    await issuance.save();

    // The new due date is the whole point of the renewal, so it goes on the
    // record rather than living only in a toast the member may have missed.
    const book = await LibraryBook.findById(issuance.book).select('title').lean().catch(() => null);
    const left = (policy.maxRenewals || 1) - issuance.renewalCount;
    notify({
        school: schoolId, sender: actor || issuance.issuedBy, senderRole: actorRole || 'system',
        title: '🔄 Library book renewed',
        body: `"${book?.title || 'Your library book'}" is now due on ${fmtLibDate(issuance.dueDate)}.`
            + (left > 0 ? ` You can renew it ${left} more time${left === 1 ? '' : 's'}.` : ' This was the last renewal allowed.'),
        recipients: [issuance.issuedTo],
        includeSender: true,   // a member renewing their own loan is the recipient
        link: { type: 'library.mybooks' },
    });

    return { ok: true, issuance };
}

/** Reservations a person currently holds on a book — used to stop duplicates. */
async function activeReservation(schoolId, userId, bookId) {
    return LibraryReservation.findOne({
        school: schoolId, book: bookId, reservedBy: userId,
        status: { $in: ['pending', 'ready'] },
    }).lean();
}

module.exports = {
    MAX_COPIES_PER_ADD, COPY_STATUSES, ACTIVE_ISSUANCE, MAX_LOAN_DAYS, BORROWER_ROLES,
    fmtLibDate, getOrCreatePolicy, audit, reserveCopyCodes, bumpBookCounts,
    normIsbn, normText, isValidIsbn, findDuplicateBook, duplicateResponse,
    checkBorrowerEligibility, buildCopy, calcFine, reindexQueue, activeReservation,
    sweepOverdue, expireStaleHolds, promoteQueue, fineApplies, renewIssuance,
    commitIssue, commitReturn, sendDueSoonReminders, runLibrarySweep, pruneAuditLog,
    borrowerAudience, backfillIssuedToRole, nextFineReceiptNumber,
    outstandingOf, fineStatusFor, backfillFineAmounts,
};
