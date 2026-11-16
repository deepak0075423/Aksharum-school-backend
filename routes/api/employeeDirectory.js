'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Employee Directory routes.
//
//  Authorisation is layered, and every layer is enforced here or below — the
//  clients only decide what to render.
//
//    1. verifyToken            authenticated, and the token's user is loaded
//                              together with their school (req.schoolId).
//    2. requirePasswordReset   a first-login account cannot browse staff.
//    3. requireRole            school_admin or teacher. No other role reaches
//                              any endpoint in this file — a student or parent
//                              gets 403 whether or not they know the URL.
//    4. requireModule          the school has the module enabled AND the
//                              caller's designation grants at least normal
//                              access to it.
//    5. requireModuleAdmin     administrative endpoints additionally need
//                              ADMIN level on the module. school_admin has it
//                              on every enabled module by definition; a teacher
//                              only where the designation matrix grants it.
//    6. controller             field-level visibility, tenant re-check on every
//                              :id, and the audited reveal.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/employeeDirectory.controller');
const docsCtrl = require('../../controllers/employeeDocuments.controller');
const { uploadStaffDoc } = require('../../middleware/upload');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const { requireModule, requireModuleAdmin } = require('../../middleware/moduleAccess');

const MODULE = 'employeeDirectory';

// Read surface — school admins and teachers.
const guard = [
    verifyToken,
    requirePasswordReset,
    requireRole('school_admin', 'teacher'),
    requireModule(MODULE),
];

// Administrative surface — plus ADMIN level on the module.
const adminGuard = [
    verifyToken,
    requirePasswordReset,
    requireRole('school_admin', 'teacher'),
    requireModuleAdmin(MODULE),
];

// ── Directory ────────────────────────────────────────────────────────────────
router.get('/meta',        guard, ctrl.getMeta);
router.get('/dashboard',   adminGuard, ctrl.getDashboard);
router.get('/employees',   guard, ctrl.getEmployees);

// ── Structure ────────────────────────────────────────────────────────────────
// Administrative views of the workforce — headcount by department and
// designation, and the reporting tree. A teacher looking a colleague up has no
// use for them, so they are not part of the normal tier.
router.get('/departments',    adminGuard, ctrl.getDepartments);
// The school's own list of departments: add one before anybody is in it,
// rename it (its members follow), merge two spellings, remove an empty one.
// `/move` is declared before `/:id` so it is never read as an id.
router.post  ('/departments',      adminGuard, ctrl.createDepartment);
router.post  ('/departments/move', adminGuard, ctrl.moveDepartment);
router.put   ('/departments/:id',  adminGuard, ctrl.updateDepartment);
router.delete('/departments/:id',  adminGuard, ctrl.removeDepartment);
router.get('/designations',   adminGuard, ctrl.getDesignations);
router.get('/org-structure',  adminGuard, ctrl.getOrgStructure);

// ── Responsibilities ─────────────────────────────────────────────────────────
router.get   ('/responsibilities',     guard,      ctrl.listResponsibilities);
router.post  ('/responsibilities',     adminGuard, ctrl.createResponsibility);
router.put   ('/responsibilities/:id', adminGuard, ctrl.updateResponsibility);
router.delete('/responsibilities/:id', adminGuard, ctrl.removeResponsibility);

// ── Verification ─────────────────────────────────────────────────────────────
router.get('/verification', adminGuard, ctrl.getVerificationQueue);

// ── Employee documents: the office's review and reminders ────────────────────
router.get ('/document-desk',      adminGuard, docsCtrl.getDocumentDesk);
router.post('/document-reminders', adminGuard, docsCtrl.sendReminders);

// ── My documents: any member of staff, whatever their designation, as long as
//    the school uses the module. Their own paperwork, never anyone else's.
const selfGuard = [verifyToken, requirePasswordReset, requireRole('teacher'), docsCtrl.schoolUsesModule];
router.get ('/me/documents',      selfGuard, docsCtrl.myDocuments);
router.post('/me/documents/:key', selfGuard, uploadStaffDoc.single('file'), docsCtrl.uploadMyDocument);
// "Please correct my details" — the employee's side, then the office's.
router.get ('/me/requests',       selfGuard, docsCtrl.myRequests);
router.post('/me/requests',       selfGuard, docsCtrl.createMyRequest);
router.get ('/change-requests',     adminGuard, docsCtrl.listRequests);
router.put ('/change-requests/:id', adminGuard, docsCtrl.closeRequest);

// ── Reports (administrative — exports carry no sensitive columns) ────────────
router.get('/reports',       adminGuard, ctrl.listReports);
router.get('/reports/:type', adminGuard, ctrl.getReport);

// ── One employee. Declared last so /meta, /reports … are never swallowed by
//    the :id parameter.
// ────────────────────────────────────────────────────────────────────────────
// Many people at once. Declared before `/employees/:id` for the same reason.
router.put('/employees/bulk-employment', adminGuard, ctrl.bulkEmployment);

router.get('/employees/:id',            guard, ctrl.getEmployee);
router.get('/employees/:id/timetable',  guard, ctrl.getTimetable);
router.get('/employees/:id/attendance', guard, ctrl.getAttendance);
router.get('/employees/:id/leave',      guard, ctrl.getLeave);

// Unmasking one government-ID / bank value: an administrator, or the employee
// reading their own record — the controller decides which, and audits it with
// who read what, about whom, and from where.
router.post('/employees/:id/reveal',       guard, ctrl.revealField);
router.get ('/employees/:id/assignments',  adminGuard, ctrl.getAssignments);
router.get ('/employees/:id/history',      adminGuard, ctrl.getHistory);
router.get ('/employees/:id/profile.pdf',  adminGuard, ctrl.getProfilePdf);
router.put ('/employees/:id/employment',   adminGuard, ctrl.updateEmployment);
router.put ('/employees/:id/qualifications', adminGuard, ctrl.updateQualifications);
router.put ('/employees/:id/verification', adminGuard, ctrl.setVerification);
router.put ('/employees/:id/documents/:key/review', adminGuard, docsCtrl.reviewDocument);
// A paper handed in at the desk: the office puts it on the record (it is still
// reviewed like any other).
router.post('/employees/:id/documents/:key', adminGuard, uploadStaffDoc.single('file'), docsCtrl.uploadForEmployee);

module.exports = router;
