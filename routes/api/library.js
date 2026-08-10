'use strict';
const express  = require('express');
const router   = express.Router();
const libCtrl  = require('../../controllers/library.controller');
const stuCtrl  = require('../../controllers/libraryStudent.controller');
const parCtrl  = require('../../controllers/libraryParent.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule  = require('../../middleware/requireModule');
const TeacherProfile = require('../../models/TeacherProfile');
const { uploadExcel } = require('../../middleware/upload');

const baseGuard    = [verifyToken, requirePasswordReset, requireModule('library')];
const studentGuard = [...baseGuard, requireRole('student')];
const parentGuard  = [...baseGuard, requireRole('parent')];
const teacherBrowseGuard = [...baseGuard, requireRole('teacher')];
const adminOnlyGuard = [...baseGuard, requireRole('school_admin')];

const librarianGuard = [
    ...baseGuard,
    async (req, res, next) => {
        const role = req.userRole;
        if (role === 'school_admin') return next();
        if (role === 'teacher') {
            const profile = await TeacherProfile.findOne({ user: req.userId }).lean();
            if (profile?.designation === 'Librarian') return next();
        }
        return res.status(403).json({ success: false, message: 'Librarian access required' });
    },
];

// ── Librarian / Admin ─────────────────────────────────────────────────────────
router.get('/dashboard', librarianGuard, libCtrl.getDashboard);

// Books
router.get('/books',                       librarianGuard, libCtrl.getBooks);
router.post('/books',                      librarianGuard, libCtrl.createBook);
router.get('/books/bulk-upload',           librarianGuard, libCtrl.getBulkUpload);
router.get('/books/bulk-upload/template',  librarianGuard, libCtrl.getBulkUploadTemplate);
router.post('/books/bulk-upload',          librarianGuard, uploadExcel.single('file'), libCtrl.bulkUpload);
router.get('/books/:id',                   librarianGuard, libCtrl.getBookDetail);
router.put('/books/:id',                   librarianGuard, libCtrl.updateBook);
router.delete('/books/:id',                librarianGuard, libCtrl.deleteBook);

// Copies
router.post('/books/:id/copies',              librarianGuard, libCtrl.addCopy);
router.put('/books/:id/copies/:copyId',       librarianGuard, libCtrl.editCopy);
router.patch('/books/:id/copies/:copyId/status', librarianGuard, libCtrl.markCopyStatus);

// Circulation
router.get('/issue',              librarianGuard, libCtrl.getIssueForm);
router.post('/issue',             librarianGuard, libCtrl.issueBook);
router.get('/return',             librarianGuard, libCtrl.getReturnForm);
router.post('/return',            librarianGuard, libCtrl.returnBook);
router.get('/issuances',          librarianGuard, libCtrl.getIssuances);
router.post('/issuances/:id/renew', librarianGuard, libCtrl.renewBook);

// Reservations
router.get('/reservations',                      librarianGuard, libCtrl.getReservations);
router.post('/reservations/:id/mark-ready',      librarianGuard, libCtrl.markReservationReady);
router.delete('/reservations/:id',               librarianGuard, libCtrl.cancelReservation);

// Fines
router.get('/fines',                   librarianGuard, libCtrl.getFines);
router.post('/fines/:id/collect',      librarianGuard, libCtrl.collectFine);
router.post('/fines/:id/waive',        librarianGuard, libCtrl.waiveFine);

// Policy & Audit (admin only)
router.get('/policy',     adminOnlyGuard, libCtrl.getPolicy);
router.put('/policy',     adminOnlyGuard, libCtrl.updatePolicy);
router.get('/audit-log',  adminOnlyGuard, libCtrl.getAuditLog);

// ── Student ───────────────────────────────────────────────────────────────────
router.get('/student',                          studentGuard, stuCtrl.getDashboard);
router.get('/student/search',                   studentGuard, stuCtrl.search);
router.post('/student/books/:bookId/reserve',   studentGuard, stuCtrl.reserve);
router.delete('/student/reservations/:id',      studentGuard, stuCtrl.cancelReservation);
router.get('/student/my-books',                 studentGuard, stuCtrl.getMyBooks);
router.get('/student/my-fines',                 studentGuard, stuCtrl.getMyFines);

// ── Teacher (browse) ──────────────────────────────────────────────────────────
router.get('/teacher',          teacherBrowseGuard, stuCtrl.getDashboard);
router.get('/teacher/search',   teacherBrowseGuard, stuCtrl.search);
router.get('/teacher/my-books', teacherBrowseGuard, stuCtrl.getMyBooks);
router.get('/teacher/my-fines', teacherBrowseGuard, stuCtrl.getMyFines);
router.delete('/teacher/reservations/:id', teacherBrowseGuard, stuCtrl.cancelReservation);

// ── Parent ────────────────────────────────────────────────────────────────────
router.get('/parent', parentGuard, parCtrl.getOverview);

module.exports = router;
