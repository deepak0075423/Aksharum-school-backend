'use strict';
const express  = require('express');
const router   = express.Router();
const libCtrl  = require('../../controllers/library.controller');
const stuCtrl  = require('../../controllers/libraryStudent.controller');
const parCtrl  = require('../../controllers/libraryParent.controller');
const repCtrl  = require('../../controllers/libraryReports.controller');
const payCtrl  = require('../../controllers/libraryPayment.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule  = require('../../middleware/requireModule');
const { allowModuleAdmin } = require('../../middleware/moduleAccess');
const { uploadExcel } = require('../../middleware/upload');

const baseGuard    = [verifyToken, requirePasswordReset, requireModule('library')];
const studentGuard = [...baseGuard, requireRole('student')];
const parentGuard  = [...baseGuard, requireRole('parent')];
const teacherBrowseGuard = [...baseGuard, requireRole('teacher')];
const adminOnlyGuard = [...baseGuard, requireRole('school_admin')];

// Library management. Was a hard-coded designation === 'Librarian' test; it is
// now "administrative access to the library module", which the designation
// permission matrix decides (a designation named Librarian with no configured
// row still resolves to admin, so nothing changed for existing schools).
const librarianGuard = [...baseGuard, allowModuleAdmin('library')];

// ── Librarian / Admin ─────────────────────────────────────────────────────────
router.get('/dashboard', librarianGuard, libCtrl.getDashboard);

// Books
router.get('/books',                       librarianGuard, libCtrl.getBooks);
router.post('/books',                      librarianGuard, libCtrl.createBook);
router.get('/books/export',                 librarianGuard, libCtrl.exportBooks);
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
router.delete('/books/:id/copies/:copyId',    librarianGuard, libCtrl.deleteCopy);
router.get('/books/:id/labels',               librarianGuard, libCtrl.copyLabels);
router.get('/books/:id/copies/:copyId/barcode', librarianGuard, libCtrl.copyBarcode);

// Counter scanner — one copy code in, the desk's next move out
router.get('/scan',               librarianGuard, libCtrl.scanCopy);

// Member lookup — the issue counter's typeahead
router.get('/members',            librarianGuard, libCtrl.searchMembers);
// Classes and sections for the circulation filters
router.get('/classes',            librarianGuard, libCtrl.getClassList);

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

// Reports — every one also serves ?format=xlsx
router.get('/reports',            librarianGuard, repCtrl.index);
router.get('/reports/overdue',    librarianGuard, repCtrl.overdueRegister);
router.get('/reports/popular',    librarianGuard, repCtrl.mostBorrowed);
router.get('/reports/dead-stock', librarianGuard, repCtrl.deadStock);
router.get('/reports/member',     librarianGuard, repCtrl.memberHistory);
router.get('/reports/accession',  librarianGuard, repCtrl.accessionRegister);
router.get('/reports/stock-take', librarianGuard, repCtrl.stockTake);
router.get('/reports/fines',      librarianGuard, repCtrl.fineLedger);

// Policy — administrative access to the LIBRARY module, not the school.
// This was requireRole('school_admin'), which refuses a teacher whose
// designation makes them a library administrator: the Policy tab is on their
// nav, the page loaded, and every field rendered as a dash because the fetch
// behind it 403'd. Administering the module is precisely what the designation
// grants, so the policy is part of it.
router.get('/policy',     librarianGuard, libCtrl.getPolicy);
router.put('/policy',     librarianGuard, libCtrl.updatePolicy);

// The audit log stays school_admin-only: it records what the librarians did.
router.get('/audit-log',  adminOnlyGuard, libCtrl.getAuditLog);

// ── Student ───────────────────────────────────────────────────────────────────
router.get('/student',                          studentGuard, stuCtrl.getDashboard);
router.get('/student/search',                   studentGuard, stuCtrl.search);
router.post('/student/books/:bookId/reserve',   studentGuard, stuCtrl.reserve);
router.delete('/student/reservations/:id',      studentGuard, stuCtrl.cancelReservation);
router.post('/student/issuances/:id/renew',      studentGuard, stuCtrl.requestRenewal);
router.get('/student/my-books',                 studentGuard, stuCtrl.getMyBooks);
router.get('/student/my-fines',                 studentGuard, stuCtrl.getMyFines);

// ── Teacher (browse) ──────────────────────────────────────────────────────────
router.get('/teacher',          teacherBrowseGuard, stuCtrl.getDashboard);
router.get('/teacher/search',   teacherBrowseGuard, stuCtrl.search);
router.post('/teacher/books/:bookId/reserve', teacherBrowseGuard, stuCtrl.reserve);
router.post('/teacher/issuances/:id/renew',  teacherBrowseGuard, stuCtrl.requestRenewal);
router.get('/teacher/my-books', teacherBrowseGuard, stuCtrl.getMyBooks);
router.get('/teacher/my-fines', teacherBrowseGuard, stuCtrl.getMyFines);
router.delete('/teacher/reservations/:id', teacherBrowseGuard, stuCtrl.cancelReservation);

// ── Fine payment & receipts ───────────────────────────────────────────────────
// Reachable by whoever owes the fine and by a parent paying for a child; the
// controller decides whose fines the caller may act on.
const payerGuard = [...baseGuard, requireRole('student', 'teacher', 'parent')];
router.get('/my-fines/summary',            payerGuard, payCtrl.getMyFineSummary);
router.post('/my-fines/order',             payerGuard, payCtrl.createFineOrder);
router.post('/my-fines/confirm',           payerGuard, payCtrl.confirmFinePayment);
router.get('/my-fines/receipts',           payerGuard, payCtrl.listMyReceipts);
// Staff can reprint a counter receipt, so this one is open to librarians too.
router.get('/receipts/:receiptNumber', [...baseGuard], payCtrl.getFineReceipt);

// ── Parent ────────────────────────────────────────────────────────────────────
router.get('/parent', parentGuard, parCtrl.getOverview);

module.exports = router;
