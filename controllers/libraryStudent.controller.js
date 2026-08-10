'use strict';
const LibraryBook        = require('../models/LibraryBook');
const LibraryIssuance    = require('../models/LibraryIssuance');
const LibraryReservation = require('../models/LibraryReservation');
const LibraryFine        = require('../models/LibraryFine');
const LibraryPolicy      = require('../models/LibraryPolicy');
const LibraryAuditLog    = require('../models/LibraryAuditLog');

async function getOrCreatePolicy(schoolId) {
    let p = await LibraryPolicy.findOne({ school: schoolId }).lean();
    if (!p) p = (await LibraryPolicy.create({ school: schoolId })).toObject();
    return p;
}

// ── Student / Teacher shared endpoints ────────────────────────────────────────

exports.getDashboard = async (req, res) => {
    try {
        const policy = await getOrCreatePolicy(req.schoolId);

        const [myIssuances, myFines, myReservations] = await Promise.all([
            LibraryIssuance.find({ school: req.schoolId, issuedTo: req.userId, status: 'issued' })
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
        const { q, category, page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        if (category) filter.category = category;
        if (q) filter.$or = [
            { title:     { $regex: q, $options: 'i' } },
            { authors:   { $elemMatch: { $regex: q, $options: 'i' } } },
            { isbn:      { $regex: q, $options: 'i' } },
            { publisher: { $regex: q, $options: 'i' } },
        ];

        const [books, total] = await Promise.all([
            LibraryBook.find(filter).sort({ title: 1 }).skip((+page - 1) * +limit).limit(+limit).lean(),
            LibraryBook.countDocuments(filter),
        ]);

        // Attach user's own reservation status
        const bookIds      = books.map(b => b._id);
        const reservations = await LibraryReservation.find({
            book: { $in: bookIds }, reservedBy: req.userId, status: { $in: ['pending','ready'] },
        }).lean();
        const resMap = Object.fromEntries(reservations.map(r => [r.book.toString(), r]));

        const data = books.map(b => ({ ...b, myReservation: resMap[b._id.toString()] || null }));
        res.json({ success: true, data, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.reserve = async (req, res) => {
    try {
        const { bookId } = req.params;
        const book = await LibraryBook.findOne({ _id: bookId, school: req.schoolId }).lean();
        if (!book) return res.status(404).json({ success: false, message: 'Book not found' });

        // Duplicate active reservation guard
        const existing = await LibraryReservation.findOne({ book: bookId, reservedBy: req.userId, status: { $in: ['pending','ready'] } });
        if (existing) return res.status(400).json({ success: false, message: 'Already reserved' });

        // Queue position
        const last = await LibraryReservation.findOne({ book: bookId, status: 'pending', school: req.schoolId }).sort({ queuePosition: -1 }).lean();
        const queuePosition = (last?.queuePosition || 0) + 1;

        const reservation = await LibraryReservation.create({
            school: req.schoolId, book: bookId, reservedBy: req.userId,
            queuePosition, status: book.availableCopies > 0 ? 'ready' : 'pending',
        });

        await LibraryAuditLog.create({
            school: req.schoolId, user: req.userId, role: req.userRole,
            actionType: 'RESERVATION_CREATED', entityType: 'Reservation', entityId: reservation._id,
        });

        res.status(201).json({ success: true, data: reservation });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.cancelReservation = async (req, res) => {
    try {
        const reservation = await LibraryReservation.findOneAndUpdate(
            { _id: req.params.id, reservedBy: req.userId, school: req.schoolId, status: { $in: ['pending','ready'] } },
            { status: 'cancelled' },
            { new: true }
        ).lean();
        if (!reservation) return res.status(404).json({ success: false, message: 'Active reservation not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getMyBooks = async (req, res) => {
    try {
        const { status } = req.query;
        const filter = { school: req.schoolId, issuedTo: req.userId };
        if (status) filter.status = status;

        const issuances = await LibraryIssuance.find(filter)
            .populate('book',    'title isbn authors category')
            .populate('bookCopy','uniqueCode')
            .sort({ issueDate: -1 })
            .lean();

        const now = new Date();
        const data = issuances.map(i => ({
            ...i,
            isOverdue: i.status === 'issued' && now > new Date(i.dueDate),
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
