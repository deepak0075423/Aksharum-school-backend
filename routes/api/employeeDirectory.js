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
router.get('/designations',   adminGuard, ctrl.getDesignations);
router.get('/org-structure',  adminGuard, ctrl.getOrgStructure);

// ── Responsibilities ─────────────────────────────────────────────────────────
router.get   ('/responsibilities',     guard,      ctrl.listResponsibilities);
router.post  ('/responsibilities',     adminGuard, ctrl.createResponsibility);
router.delete('/responsibilities/:id', adminGuard, ctrl.removeResponsibility);

// ── Verification ─────────────────────────────────────────────────────────────
router.get('/verification', adminGuard, ctrl.getVerificationQueue);

// ── Reports (administrative — exports carry no sensitive columns) ────────────
router.get('/reports',       adminGuard, ctrl.listReports);
router.get('/reports/:type', adminGuard, ctrl.getReport);

// ── One employee. Declared last so /meta, /reports … are never swallowed by
//    the :id parameter.
// ────────────────────────────────────────────────────────────────────────────
router.get('/employees/:id',            guard, ctrl.getEmployee);
router.get('/employees/:id/timetable',  guard, ctrl.getTimetable);
router.get('/employees/:id/attendance', guard, ctrl.getAttendance);
router.get('/employees/:id/leave',      guard, ctrl.getLeave);

// Unmasking one government-ID / bank value. Administrative, and audited in the
// controller with who read what, about whom, and from where.
router.post('/employees/:id/reveal',       adminGuard, ctrl.revealField);
router.put ('/employees/:id/employment',   adminGuard, ctrl.updateEmployment);
router.put ('/employees/:id/verification', adminGuard, ctrl.setVerification);

module.exports = router;
