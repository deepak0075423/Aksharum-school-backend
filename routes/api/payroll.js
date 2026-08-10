'use strict';
const express     = require('express');
const router      = express.Router();
const payrollCtrl = require('../../controllers/payroll.controller');
const payslipCtrl = require('../../controllers/payslip.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule = require('../../middleware/requireModule');

const adminGuard   = [verifyToken, requirePasswordReset, requireRole('school_admin'), requireModule('payroll')];
const teacherGuard = [verifyToken, requirePasswordReset, requireRole('teacher'),      requireModule('payroll')];

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/admin/dashboard', adminGuard, payrollCtrl.getDashboard);

// Salary Structures
router.get('/admin/structures',          adminGuard, payrollCtrl.getStructures);
router.post('/admin/structures',         adminGuard, payrollCtrl.createStructure);
router.put('/admin/structures/:id',      adminGuard, payrollCtrl.updateStructure);
router.patch('/admin/structures/:id/toggle', adminGuard, payrollCtrl.toggleStructure);
router.get('/admin/structures/:id/components', adminGuard, payrollCtrl.getStructureComponents);

// Assignments
router.get('/admin/assignments',           adminGuard, payrollCtrl.getAssignments);
router.post('/admin/assignments',          adminGuard, payrollCtrl.assignEmployee);
router.put('/admin/assignments/:id',       adminGuard, payrollCtrl.updateAssignment);
router.patch('/admin/assignments/:id/deactivate', adminGuard, payrollCtrl.deactivateAssignment);
router.get('/admin/assignments/:id/ctc',   adminGuard, payrollCtrl.getUpdateCtc);
router.put('/admin/assignments/:id/ctc',   adminGuard, payrollCtrl.updateCtc);
router.get('/admin/assignments/:id/ctc-history', adminGuard, payrollCtrl.getCtcHistory);

// Payroll Runs
router.get('/admin/runs',               adminGuard, payrollCtrl.getPayrollRuns);
router.post('/admin/runs',              adminGuard, payrollCtrl.createRun);
router.get('/admin/runs/:id',           adminGuard, payrollCtrl.getRunDetail);
router.patch('/admin/runs/:id/status',  adminGuard, payrollCtrl.updateRunStatus);
router.post('/admin/runs/:id/publish',  adminGuard, payrollCtrl.publishRun);
router.put('/admin/runs/:id/entries/:entryId', adminGuard, payrollCtrl.updateEntry);

// Payslips (admin download)
router.get('/admin/payslips/:id/download', adminGuard, payslipCtrl.adminDownloadPayslip);

// Reports & Audit
router.get('/admin/reports', adminGuard, payrollCtrl.getReports);
router.get('/admin/audit',   adminGuard, payrollCtrl.getAuditLog);

// ── Teacher ───────────────────────────────────────────────────────────────────
router.get('/teacher/ctc',               teacherGuard, payrollCtrl.getMyCtc);
router.get('/teacher/payslips',          teacherGuard, payslipCtrl.getMyPayslips);
router.get('/teacher/payslips/:id',      teacherGuard, payslipCtrl.getPayslipDetail);
router.get('/teacher/payslips/:id/download', teacherGuard, payslipCtrl.downloadPayslip);

module.exports = router;
