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

exports.getDashboard = async (req, res) => {
    try {
        const policy = await getOrCreatePolicy(req.schoolId);
        await Promise.all([
            sweepOverdue(req.schoolId),
            expireStaleHolds(req.schoolId, null, { actor: req.userId, actorRole: req.userRole }),
        ]);

        const [myIssuances, myFines, myReservations] = await Promise.all([
            LibraryIssuance.find({ school: req.schoolId, issuedTo: req.userId, status: { $in: ACTIVE_ISSUANCE } })
                .populate('book', 'title isbn')
                .lean(),
            LibraryFine.find({ school: req.schoolId, user: req.userId, status: 'pending' }).lean(),
            LibraryReservation.find({ school: req.schoolId, reservedBy: req.userId, status: { $in: ['pending','ready'] } })
                .populate('book', 'title')
                .lean(),
        ]);

        res.json({
            success: true,
            data: {
                issuedBooks:   myIssuances,
                pendingFines:  myFines,
                reservations:  myReservations,
                policy:        { maxBooksPerUser: policy.maxBooksPerUser, issueDurationDays: policy.issueDurationDays },
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.search = async (req, res) => {
    try {
        const { q, category } = req.query;
        const page  = Math.max(1, Math.floor(Number(req.query.page) || 1));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 20)));
        const filter = { school: req.schoolId };
        if (category) filter.category = category;
        if (q) filter.$or = [
            { title:     { $regex: q, $options: 'i' } },
            { authors:   { $elemMatch: { $regex: q, $options: 'i' } } },
            { isbn:      { $regex: q, $options: 'i' } },
            { publisher: { $regex: q, $options: 'i' } },
        ];

        const [books, total] = await Promise.all([
            LibraryBook.find(filter).sort({ title: 1 }).skip((page - 1) * limit).limit(limit).lean(),
            LibraryBook.countDocuments(filter),
        ]);

        // Attach user's own reservation status
        const bookIds      = books.map(b => b._id);
        const reservations = await LibraryReservation.find({
            book: { $in: bookIds }, reservedBy: req.userId, status: { $in: ['pending','ready'] },
        }).lean();
        const resMap = Object.fromEntries(reservations.map(r => [r.book.toString(), r]));

        const data = books.map(b => ({ ...b, myReservation: resMap[b._id.toString()] || null }));
        res.json({ success: true, data, total, page, pages: Math.ceil(total / limit) });
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
            link: { type: 'library.reservations' },
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
            link: { type: 'library.manage.reservations' },
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
                link: { type: 'library.manage.reservations' },
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

exports.getMyBooks = async (req, res) => {
    try {
        await sweepOverdue(req.schoolId);

        const { status } = req.query;
        const filter = { school: req.schoolId, issuedTo: req.userId };
        if (status) filter.status = status;

        const issuances = await LibraryIssuance.find(filter)
            .populate('book',    'title isbn authors category')
            .populate('bookCopy','uniqueCode')
            .sort({ issueDate: -1 })
            .lean();

        const now = new Date();
        // A lost book is still a row on this list, and until now it carried
        // nothing but the word "lost" — no charge, no receipt, no way to tell a
        // settled loss from an unpaid one.
        const withFines = await attachFineSummary(issuances);
        const data = withFines.map(i => ({
            ...i,
            isOverdue: ACTIVE_ISSUANCE.includes(i.status) && now > new Date(i.dueDate),
        }));
        res.json({ success: true, data });
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
