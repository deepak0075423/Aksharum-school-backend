'use strict';
const express     = require('express');
const router      = express.Router();
const payrollCtrl = require('../../controllers/payroll.controller');
const adminCtrl   = require('../../controllers/payrollAdmin.controller');
const payslipCtrl = require('../../controllers/payslip.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule = require('../../middleware/requireModule');
const { allowModuleAdmin } = require('../../middleware/moduleAccess');

const adminGuard = [verifyToken, requirePasswordReset, allowModuleAdmin('payroll')];

/**
 * The "my own pay" surface.
 *
 * Deliberately NOT requireRole('teacher'). School admins are paid by this
 * module too — the dashboard counts them, runs pay them and payslips are
 * issued to them — and requiring the teacher role meant an administrator had
 * no way to see their own payslip at all. Every handler behind this guard
 * scopes to req.userId, so widening the role widens nobody's view but their own.
 *
 * `requireModule` still applies: the school must have payroll switched on and
 * the caller's designation must grant at least normal access.
 */
const selfGuard = [verifyToken, requirePasswordReset, requireRole('teacher', 'school_admin'), requireModule('payroll')];

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/admin/overview',  adminGuard, adminCtrl.getOverview);
router.get('/admin/dashboard', adminGuard, adminCtrl.getDashboard);   // the shape the mobile app reads
router.get('/admin/employees', adminGuard, adminCtrl.getEmployees);

// Settings
router.get('/admin/settings', adminGuard, adminCtrl.getSettings);
router.put('/admin/settings', adminGuard, adminCtrl.updateSettings);

// Salary structures.  The fixed paths come before /:id so "library",
// "templates" and "preview" are never read as a structure id.
router.get('/admin/structures',            adminGuard, adminCtrl.listStructures);
router.get('/admin/structures/library',    adminGuard, adminCtrl.getLibrary);
router.post('/admin/structures/preview',   adminGuard, adminCtrl.previewStructure);
router.post('/admin/structures/template',  adminGuard, adminCtrl.createFromTemplate);
router.post('/admin/structures',           adminGuard, adminCtrl.createStructure);
router.put('/admin/structures/:id',        adminGuard, adminCtrl.updateStructure);
router.delete('/admin/structures/:id',     adminGuard, adminCtrl.deleteStructure);
router.patch('/admin/structures/:id/toggle',  adminGuard, adminCtrl.toggleStructure);
router.patch('/admin/structures/:id/default', adminGuard, adminCtrl.setDefault);
router.post('/admin/structures/:id/duplicate', adminGuard, adminCtrl.duplicateStructure);
router.get('/admin/structures/:id/components', adminGuard, payrollCtrl.getStructureComponents);

// Assignments
router.get('/admin/assignments',         adminGuard, adminCtrl.listAssignments);
router.post('/admin/assignments',        adminGuard, adminCtrl.assignEmployee);
router.post('/admin/assignments/bulk',   adminGuard, adminCtrl.bulkAssign);
router.post('/admin/assignments/copy',   adminGuard, adminCtrl.copyAssignments);
router.get('/admin/assignments/:id',     adminGuard, adminCtrl.getAssignment);
router.put('/admin/assignments/:id',     adminGuard, adminCtrl.updateAssignment);
router.delete('/admin/assignments/:id',  adminGuard, adminCtrl.deleteAssignment);
router.patch('/admin/assignments/:id/deactivate', adminGuard, adminCtrl.setAssignmentActive);
router.patch('/admin/assignments/:id/activate',   adminGuard, adminCtrl.setAssignmentActive);
router.get('/admin/assignments/:id/ctc',          adminGuard, adminCtrl.getAssignment);
router.put('/admin/assignments/:id/ctc',          adminGuard, adminCtrl.updateCtc);
router.get('/admin/assignments/:id/ctc-history',  adminGuard, adminCtrl.getCtcHistory);

// Payroll runs
router.get('/admin/runs',               adminGuard, adminCtrl.listRuns);
router.post('/admin/runs',              adminGuard, adminCtrl.createRun);
router.get('/admin/runs/:id',           adminGuard, adminCtrl.getRun);
router.delete('/admin/runs/:id',        adminGuard, adminCtrl.deleteRun);
router.post('/admin/runs/:id/recompute', adminGuard, adminCtrl.recomputeRun);
router.patch('/admin/runs/:id/status',  adminGuard, adminCtrl.updateRunStatus);
router.post('/admin/runs/:id/publish',  adminGuard, adminCtrl.publishRun);
router.post('/admin/runs/:id/unpublish', adminGuard, adminCtrl.unpublishRun);
router.patch('/admin/runs/:id/cancel',  adminGuard, adminCtrl.cancelRun);
router.get('/admin/runs/:id/export',    adminGuard, adminCtrl.exportRun);
router.get('/admin/runs/:id/bank-file', adminGuard, adminCtrl.bankFile);
router.put('/admin/runs/:id/entries/:entryId',        adminGuard, adminCtrl.updateEntry);
router.patch('/admin/runs/:id/entries/:entryId/hold', adminGuard, adminCtrl.holdEntry);

// Payslips (admin download)
router.get('/admin/payslips/:id/download', adminGuard, payslipCtrl.adminDownloadPayslip);

// Reports
router.get('/admin/reports/overview',    adminGuard, adminCtrl.getReportsOverview);
router.get('/admin/reports',             adminGuard, adminCtrl.listReports);
router.post('/admin/reports',            adminGuard, adminCtrl.generateReport);
router.get('/admin/reports/:id/download', adminGuard, adminCtrl.downloadReport);
router.delete('/admin/reports/:id',      adminGuard, adminCtrl.deleteReport);

// Advances and loans
router.get('/admin/advances',             adminGuard, adminCtrl.listAdvances);
router.post('/admin/advances',            adminGuard, adminCtrl.createAdvance);
router.patch('/admin/advances/:id/close', adminGuard, adminCtrl.closeAdvance);

// Reimbursement claims
router.get('/admin/claims',           adminGuard, adminCtrl.listClaims);
router.post('/admin/claims',          adminGuard, adminCtrl.createClaim);
router.patch('/admin/claims/:id',     adminGuard, adminCtrl.decideClaim);
router.delete('/admin/claims/:id',    adminGuard, adminCtrl.deleteClaim);

// Full and final settlement — a preview the admin then applies to a run
router.get('/admin/assignments/:id/settlement',  adminGuard, adminCtrl.settlementPreview);
router.post('/admin/assignments/:id/settlement', adminGuard, adminCtrl.applySettlement);

// Audit
router.get('/admin/audit', adminGuard, adminCtrl.getAuditLog);

// ── My own pay (teachers and admins alike) ────────────────────────────────────
// The /teacher/* paths stay as they are because the mobile app calls them.
// /me/* is the name the web app uses: "teacher" stopped being true the moment
// admins became payable.
const mine = (path, handler) => {
    router.get(`/teacher/${path}`, selfGuard, handler);
    router.get(`/me/${path}`,      selfGuard, handler);
};

mine('ctc',      payrollCtrl.getMyCtc);
mine('payslips', payslipCtrl.getMyPayslips);
// A year's salary on one page — proof of income, which the module had no way
// to produce at any level before this. Declared ahead of the :id route so
// "statement" is never read as a payslip id.
mine('statement',             payslipCtrl.downloadMyStatement);
mine('payslips/:id',          payslipCtrl.getPayslipDetail);
mine('payslips/:id/download', payslipCtrl.downloadPayslip);

module.exports = router;
