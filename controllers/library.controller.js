'use strict';
const LibraryBook        = require('../models/LibraryBook');
const LibraryBookCopy    = require('../models/LibraryBookCopy');
const LibraryIssuance    = require('../models/LibraryIssuance');
const LibraryReservation = require('../models/LibraryReservation');
const LibraryFine        = require('../models/LibraryFine');
const LibraryPolicy      = require('../models/LibraryPolicy');
const LibraryAuditLog    = require('../models/LibraryAuditLog');
const XLSX               = require('xlsx');
const { notify }         = require('../services/notifyService');

const fmtLibDate = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

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

async function nextCopyCode(schoolId) {
    const policy = await LibraryPolicy.findOneAndUpdate(
        { school: schoolId },
        { $inc: { lastCopySequence: 1 } },
        { upsert: true, new: true }
    );
    return `LIB-COPY-${String(policy.lastCopySequence).padStart(6, '0')}`;
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

// ── Dashboard ─────────────────────────────────────────────────────────────────

exports.getDashboard = async (req, res) => {
    try {
        const [totalBooks, totalCopies, issuedCopies, overdue, reservations, pendingFines] = await Promise.all([
            LibraryBook.countDocuments({ school: req.schoolId }),
            LibraryBookCopy.countDocuments({ school: req.schoolId }),
            LibraryBookCopy.countDocuments({ school: req.schoolId, status: 'issued' }),
            LibraryIssuance.countDocuments({ school: req.schoolId, status: 'overdue' }),
            LibraryReservation.countDocuments({ school: req.schoolId, status: 'pending' }),
            LibraryFine.countDocuments({ school: req.schoolId, status: 'pending' }),
        ]);

        // Recent issuances
        const recent = await LibraryIssuance.find({ school: req.schoolId })
            .populate('book',    'title')
            .populate('issuedTo','name')
            .sort({ issueDate: -1 })
            .limit(10)
            .lean();

        res.json({ success: true, data: { totalBooks, totalCopies, issuedCopies, overdue, reservations, pendingFines, recent } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Books ─────────────────────────────────────────────────────────────────────

exports.getBooks = async (req, res) => {
    try {
        const { q, category, page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        if (category) filter.category = category;
        if (q) filter.$or = [{ title: { $regex: q, $options: 'i' } }, { isbn: { $regex: q, $options: 'i' } }];

        const [books, total] = await Promise.all([
            LibraryBook.find(filter).sort({ title: 1 }).skip((+page - 1) * +limit).limit(+limit).lean(),
            LibraryBook.countDocuments(filter),
        ]);
        res.json({ success: true, data: books, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createBook = async (req, res) => {
    try {
        const { title, isbn, authors, publisher, category, edition, language, description } = req.body;
        if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required' });

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
        const book  = await LibraryBook.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!book) return res.status(404).json({ success: false, message: 'Book not found' });
        const copies = await LibraryBookCopy.find({ book: book._id }).lean();
        res.json({ success: true, data: { ...book, copies } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updateBook = async (req, res) => {
    try {
        const old  = await LibraryBook.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!old)  return res.status(404).json({ success: false, message: 'Book not found' });
        const { title, isbn, authors, publisher, category, edition, language, description } = req.body;
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
        const hasIssuance = await LibraryIssuance.exists({ book: book._id, status: 'issued' });
        if (hasIssuance) return res.status(400).json({ success: false, message: 'Cannot delete — book has active issuances' });

        await Promise.all([
            LibraryBook.deleteOne({ _id: book._id }),
            LibraryBookCopy.deleteMany({ book: book._id }),
        ]);
        audit(req.schoolId, req.userId, req.userRole, 'BOOK_DELETED', 'Book', book._id, book.toObject(), null);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getBulkUpload = async (req, res) => {
    res.json({ success: true, message: 'POST to /books/bulk-upload with an Excel file' });
};

exports.getBulkUploadTemplate = async (req, res) => {
    try {
        const sample = [
            { title: 'Sample Book', isbn: '978-0-123456-78-9', authors: 'Author Name', publisher: 'Publisher', category: 'Science', edition: '1st', language: 'English', description: '' },
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

        const docs = rows.map(r => ({
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
        })).filter(d => d.title);

        await LibraryBook.insertMany(docs, { ordered: false });
        res.json({ success: true, imported: docs.length });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Copies ────────────────────────────────────────────────────────────────────

exports.addCopy = async (req, res) => {
    try {
        const book = await LibraryBook.findOne({ _id: req.params.id, school: req.schoolId });
        if (!book) return res.status(404).json({ success: false, message: 'Book not found' });

        const { condition, rackLocation, acquisitionDate } = req.body;
        const uniqueCode = await nextCopyCode(req.schoolId);

        const copy = await LibraryBookCopy.create({
            school: req.schoolId, book: book._id,
            uniqueCode, status: 'available',
            condition: condition || 'new',
            rackLocation: rackLocation || '',
            acquisitionDate: acquisitionDate ? new Date(acquisitionDate) : null,
            addedBy: req.userId,
        });

        await LibraryBook.updateOne({ _id: book._id }, { $inc: { totalCopies: 1, availableCopies: 1 } });
        audit(req.schoolId, req.userId, req.userRole, 'COPY_ADDED', 'BookCopy', copy._id, null, copy.toObject());
        res.status(201).json({ success: true, data: copy });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.editCopy = async (req, res) => {
    try {
        const old  = await LibraryBookCopy.findOne({ _id: req.params.copyId, book: req.params.id }).lean();
        if (!old)  return res.status(404).json({ success: false, message: 'Copy not found' });

        const { condition, rackLocation } = req.body;
        const update = {};
        if (condition    !== undefined) update.condition    = condition;
        if (rackLocation !== undefined) update.rackLocation = rackLocation;

        const copy = await LibraryBookCopy.findByIdAndUpdate(req.params.copyId, update, { new: true }).lean();
        audit(req.schoolId, req.userId, req.userRole, 'COPY_UPDATED', 'BookCopy', copy._id, old, copy);
        res.json({ success: true, data: copy });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.markCopyStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const copy = await LibraryBookCopy.findOne({ _id: req.params.copyId, book: req.params.id });
        if (!copy) return res.status(404).json({ success: false, message: 'Copy not found' });

        const oldStatus = copy.status;
        copy.status = status;
        await copy.save();

        // Sync available count
        if (oldStatus === 'available' && status !== 'available') {
            await LibraryBook.updateOne({ _id: copy.book }, { $inc: { availableCopies: -1 } });
        } else if (oldStatus !== 'available' && status === 'available') {
            await LibraryBook.updateOne({ _id: copy.book }, { $inc: { availableCopies: 1 } });
        }

        audit(req.schoolId, req.userId, req.userRole, 'COPY_STATUS_CHANGED', 'BookCopy', copy._id, { status: oldStatus }, { status });
        res.json({ success: true, data: copy });
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

        // Check active issuance count for user
        const activeCount = await LibraryIssuance.countDocuments({ school: req.schoolId, issuedTo: userId, status: 'issued' });
        if (activeCount >= (policy.maxBooksPerUser || 3))
            return res.status(400).json({ success: false, message: `User has reached max book limit (${policy.maxBooksPerUser})` });

        const copy = await LibraryBookCopy.findOne({ _id: copyId, book: bookId, school: req.schoolId, status: 'available' });
        if (!copy) return res.status(400).json({ success: false, message: 'Copy not available' });

        const computedDue = dueDate
            ? new Date(dueDate)
            : new Date(Date.now() + (policy.issueDurationDays || 14) * 86400000);

        const issuance = await LibraryIssuance.create({
            school: req.schoolId, book: bookId, bookCopy: copyId,
            issuedTo: userId, issuedToRole: userRole || '', issuedBy: req.userId,
            issueDate: new Date(), dueDate: computedDue, notes: notes || '',
        });

        copy.status = 'issued';
        await copy.save();
        await LibraryBook.updateOne({ _id: bookId }, { $inc: { availableCopies: -1 } });

        audit(req.schoolId, req.userId, req.userRole, 'BOOK_ISSUED', 'Issuance', issuance._id, null, { book: bookId, user: userId });
        LibraryBook.findById(bookId).select('title').lean().then(book => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📚 Book issued to you',
            body: `"${book?.title || 'A book'}" has been issued to you. Due date: ${fmtLibDate(computedDue)}.`,
            recipients: [userId],
        })).catch(() => {});
        res.status(201).json({ success: true, data: issuance });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getReturnForm = async (req, res) => {
    try {
        const { userId, copyCode } = req.query;
        const filter = { school: req.schoolId, status: 'issued' };
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
        const { issuanceId, notes } = req.body;
        if (!issuanceId) return res.status(400).json({ success: false, message: 'issuanceId is required' });

        const issuance = await LibraryIssuance.findOne({ _id: issuanceId, school: req.schoolId, status: 'issued' });
        if (!issuance) return res.status(404).json({ success: false, message: 'Issuance not found or already returned' });

        const policy   = await getOrCreatePolicy(req.schoolId);
        const fineAmt  = await calcFine(issuance, policy);

        issuance.status     = 'returned';
        issuance.returnDate = new Date();
        if (notes) issuance.notes = notes;
        await issuance.save();

        const copy = await LibraryBookCopy.findById(issuance.bookCopy);
        if (copy) {
            copy.status = 'available';
            await copy.save();
        }
        await LibraryBook.updateOne({ _id: issuance.book }, { $inc: { availableCopies: 1 } });

        let fine = null;
        if (fineAmt > 0) {
            const now = new Date();
            const due = new Date(issuance.dueDate);
            fine = await LibraryFine.create({
                school: req.schoolId, issuance: issuance._id, user: issuance.issuedTo,
                fineType: 'late_return', amount: fineAmt,
                daysOverdue: Math.ceil((now - due) / 86400000),
            });
            issuance.fine = fine._id;
            await issuance.save();
        }

        audit(req.schoolId, req.userId, req.userRole, 'BOOK_RETURNED', 'Issuance', issuance._id, { status: 'issued' }, { status: 'returned', fine: fine?._id });

        // Check reservations queue
        const nextReservation = await LibraryReservation.findOne({
            book: issuance.book, status: 'pending', school: req.schoolId,
        }).sort({ queuePosition: 1 });
        if (nextReservation) {
            nextReservation.status  = 'ready';
            nextReservation.readyAt = new Date();
            nextReservation.expiresAt = new Date(Date.now() + (policy.reservationExpiryDays || 2) * 86400000);
            await nextReservation.save();
        }

        const bookDoc = await LibraryBook.findById(issuance.book).select('title').lean().catch(() => null);
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📚 Book return recorded',
            body: `Return of "${bookDoc?.title || 'a book'}" has been recorded.${fine ? ` A late fine of ₹${fine.amount} (${fine.daysOverdue} day${fine.daysOverdue === 1 ? '' : 's'} overdue) was applied.` : ''}`,
            recipients: [issuance.issuedTo],
        });
        if (nextReservation) {
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '🔖 Reserved book available',
                body: `"${bookDoc?.title || 'A book'}" you reserved is now available. Collect it before ${fmtLibDate(nextReservation.expiresAt)}.`,
                recipients: [nextReservation.reservedBy],
            });
        }

        res.json({ success: true, data: { issuance, fine } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getIssuances = async (req, res) => {
    try {
        const { status, userId, page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        if (status) filter.status  = status;
        if (userId) filter.issuedTo = userId;

        const [issuances, total] = await Promise.all([
            LibraryIssuance.find(filter)
                .populate('book',    'title isbn')
                .populate('bookCopy','uniqueCode')
                .populate('issuedTo','name email')
                .populate('issuedBy','name')
                .sort({ issueDate: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            LibraryIssuance.countDocuments(filter),
        ]);
        res.json({ success: true, data: issuances, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.renewBook = async (req, res) => {
    try {
        const issuance = await LibraryIssuance.findOne({ _id: req.params.id, school: req.schoolId, status: 'issued' });
        if (!issuance) return res.status(404).json({ success: false, message: 'Active issuance not found' });

        const policy = await getOrCreatePolicy(req.schoolId);
        if (issuance.renewalCount >= (policy.maxRenewals || 1))
            return res.status(400).json({ success: false, message: `Max renewals (${policy.maxRenewals}) reached` });

        // No active reservation pending ahead of user
        const reservation = await LibraryReservation.findOne({ book: issuance.book, status: 'pending', school: req.schoolId });
        if (reservation) return res.status(400).json({ success: false, message: 'Book has pending reservations — cannot renew' });

        issuance.dueDate      = new Date(issuance.dueDate.getTime() + (policy.issueDurationDays || 14) * 86400000);
        issuance.renewalCount += 1;
        await issuance.save();

        audit(req.schoolId, req.userId, req.userRole, 'BOOK_RENEWED', 'Issuance', issuance._id, null, { newDueDate: issuance.dueDate, renewalCount: issuance.renewalCount });
        res.json({ success: true, data: issuance });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Reservations ──────────────────────────────────────────────────────────────

exports.getReservations = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        if (status) filter.status = status;

        const [reservations, total] = await Promise.all([
            LibraryReservation.find(filter)
                .populate('book',      'title isbn')
                .populate('reservedBy','name email')
                .sort({ queuePosition: 1, reservedAt: 1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            LibraryReservation.countDocuments(filter),
        ]);
        res.json({ success: true, data: reservations, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.markReservationReady = async (req, res) => {
    try {
        const policy = await getOrCreatePolicy(req.schoolId);
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
        })).catch(() => {});
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
        audit(req.schoolId, req.userId, req.userRole, 'RESERVATION_CANCELLED', 'Reservation', reservation._id, null, null);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Fines ─────────────────────────────────────────────────────────────────────

exports.getFines = async (req, res) => {
    try {
        const { status, userId, page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        if (status) filter.status = status;
        if (userId) filter.user   = userId;

        const [fines, total] = await Promise.all([
            LibraryFine.find(filter)
                .populate('user',     'name email')
                .populate('issuance', 'issueDate dueDate')
                .populate('collectedBy','name')
                .populate('waivedBy',   'name')
                .sort({ createdAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            LibraryFine.countDocuments(filter),
        ]);
        res.json({ success: true, data: fines, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.collectFine = async (req, res) => {
    try {
        const fine = await LibraryFine.findOne({ _id: req.params.id, school: req.schoolId, status: 'pending' });
        if (!fine) return res.status(404).json({ success: false, message: 'Pending fine not found' });

        fine.status      = 'paid';
        fine.paidAt      = new Date();
        fine.collectedBy = req.userId;
        await fine.save();
        audit(req.schoolId, req.userId, req.userRole, 'FINE_PAID', 'Fine', fine._id, null, { status: 'paid' });
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '💳 Library fine paid',
            body: `Your library fine of ₹${fine.amount} has been recorded as paid.`,
            recipients: [fine.user],
        });
        res.json({ success: true, data: fine });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.waiveFine = async (req, res) => {
    try {
        const { reason } = req.body;
        const fine = await LibraryFine.findOne({ _id: req.params.id, school: req.schoolId, status: 'pending' });
        if (!fine) return res.status(404).json({ success: false, message: 'Pending fine not found' });

        fine.status       = 'waived';
        fine.waivedBy     = req.userId;
        fine.waiverReason = reason || '';
        await fine.save();
        audit(req.schoolId, req.userId, req.userRole, 'FINE_WAIVED', 'Fine', fine._id, null, { status: 'waived', reason });
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '💳 Library fine waived',
            body: `Your library fine of ₹${fine.amount} has been waived.${reason ? `\nReason: ${reason}` : ''}`,
            recipients: [fine.user],
        });
        res.json({ success: true, data: fine });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Policy ────────────────────────────────────────────────────────────────────

exports.getPolicy = async (req, res) => {
    try {
        const policy = await getOrCreatePolicy(req.schoolId);
        res.json({ success: true, data: policy });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updatePolicy = async (req, res) => {
    try {
        const { maxBooksPerUser, issueDurationDays, finePerDay, gracePeriodDays, maxRenewals, reservationExpiryDays, teacherFinesEnabled } = req.body;
        const update = { updatedBy: req.userId, updatedAt: new Date() };
        if (maxBooksPerUser       !== undefined) update.maxBooksPerUser       = +maxBooksPerUser;
        if (issueDurationDays     !== undefined) update.issueDurationDays     = +issueDurationDays;
        if (finePerDay            !== undefined) update.finePerDay            = +finePerDay;
        if (gracePeriodDays       !== undefined) update.gracePeriodDays       = +gracePeriodDays;
        if (maxRenewals           !== undefined) update.maxRenewals           = +maxRenewals;
        if (reservationExpiryDays !== undefined) update.reservationExpiryDays = +reservationExpiryDays;
        if (teacherFinesEnabled   !== undefined) update.teacherFinesEnabled   = !!teacherFinesEnabled;

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
        const { actionType, entityType, page = 1, limit = 30 } = req.query;
        const filter = { school: req.schoolId };
        if (actionType) filter.actionType = actionType;
        if (entityType) filter.entityType = entityType;

        const [logs, total] = await Promise.all([
            LibraryAuditLog.find(filter)
                .populate('user', 'name')
                .sort({ timestamp: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            LibraryAuditLog.countDocuments(filter),
        ]);
        res.json({ success: true, data: logs, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
