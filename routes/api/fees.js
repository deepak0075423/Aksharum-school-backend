'use strict';
const express      = require('express');
const router       = express.Router();
const adminCtrl    = require('../../controllers/fees.controller');
const studentCtrl  = require('../../controllers/feesStudent.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule = require('../../middleware/requireModule');

const adminGuard   = [verifyToken, requirePasswordReset, requireRole('school_admin'), requireModule('fees')];
const studentGuard = [verifyToken, requirePasswordReset, requireRole('student'),      requireModule('fees')];
const parentGuard  = [verifyToken, requirePasswordReset, requireRole('parent'),       requireModule('fees')];
const apiGuard     = [verifyToken, requirePasswordReset, requireRole('school_admin', 'teacher'), requireModule('fees')];

// ── Admin: Dashboard ──────────────────────────────────────────────────────────
router.get('/admin/dashboard', adminGuard, adminCtrl.getDashboard);

// ── Admin: Fee Categories ─────────────────────────────────────────────────────
router.get('/admin/fee-categories',          adminGuard, adminCtrl.getFeeCategories);
router.post('/admin/fee-categories',         adminGuard, adminCtrl.createFeeCategory);
router.put('/admin/fee-categories/:id',      adminGuard, adminCtrl.updateFeeCategory);
router.patch('/admin/fee-categories/:id/toggle', adminGuard, adminCtrl.toggleFeeCategory);

// ── Admin: Fee Heads ──────────────────────────────────────────────────────────
router.get('/admin/fee-heads',               adminGuard, adminCtrl.getFeeHeads);
router.post('/admin/fee-heads',              adminGuard, adminCtrl.createFeeHead);
router.put('/admin/fee-heads/:id',           adminGuard, adminCtrl.updateFeeHead);
router.patch('/admin/fee-heads/:id/toggle',  adminGuard, adminCtrl.toggleFeeHead);

// ── Admin: Fee Structures ─────────────────────────────────────────────────────
router.get('/admin/fee-structures',             adminGuard, adminCtrl.getFeeStructures);
router.post('/admin/fee-structures',            adminGuard, adminCtrl.createFeeStructure);
router.get('/admin/fee-structures/:id',         adminGuard, adminCtrl.getFeeStructureDetail);
router.put('/admin/fee-structures/:id',         adminGuard, adminCtrl.updateFeeStructure);
router.patch('/admin/fee-structures/:id/toggle',adminGuard, adminCtrl.toggleFeeStructure);
router.post('/admin/fee-structures/:id/generate-demand', adminGuard, adminCtrl.generateFeeDemand);
router.post('/admin/fee-structures/:id/add-fee-head',    adminGuard, adminCtrl.addFeeHeadToStructure);

// ── Admin: Fine Rules ─────────────────────────────────────────────────────────
router.get('/admin/fine-rules',              adminGuard, adminCtrl.getFineRules);
router.post('/admin/fine-rules',             adminGuard, adminCtrl.createFineRule);
router.put('/admin/fine-rules/:id',          adminGuard, adminCtrl.updateFineRule);
router.patch('/admin/fine-rules/:id/toggle', adminGuard, adminCtrl.toggleFineRule);

// ── Admin: Concession Templates ───────────────────────────────────────────────
router.get('/admin/concessions',             adminGuard, adminCtrl.getConcessions);
router.post('/admin/concessions',            adminGuard, adminCtrl.createConcession);
router.put('/admin/concessions/:id',         adminGuard, adminCtrl.updateConcession);
router.patch('/admin/concessions/:id/toggle',adminGuard, adminCtrl.toggleConcession);

// ── Admin: Student Fee Management ────────────────────────────────────────────
router.get('/admin/student-fees',                adminGuard, adminCtrl.getStudentFees);
router.get('/admin/student-fees/:studentId',     adminGuard, adminCtrl.getStudentFeeDetail);
router.get('/admin/student-fees/:studentId/ledger', adminGuard, adminCtrl.getStudentLedger);
router.post('/admin/student-fees/:studentId/assign-concession', adminGuard, adminCtrl.assignStudentConcession);
router.delete('/admin/student-fees/:studentId/concessions/:concessionId', adminGuard, adminCtrl.removeStudentConcession);

// ── Admin: Payments ───────────────────────────────────────────────────────────
router.get('/admin/payments',                  adminGuard, adminCtrl.getPayments);
router.post('/admin/payments/record',          adminGuard, adminCtrl.recordPayment);
router.post('/admin/payments/:id/approve',     adminGuard, adminCtrl.approvePayment);
router.post('/admin/payments/:id/reject',      adminGuard, adminCtrl.rejectPayment);
router.get('/admin/payments/:id/receipt',      adminGuard, adminCtrl.getPaymentReceipt);
router.get('/admin/payments/:id/download',     adminGuard, adminCtrl.downloadReceipt);

// ── Admin: Ledger ─────────────────────────────────────────────────────────────
router.get('/admin/ledger', adminGuard, adminCtrl.getSchoolLedger);

// ── Admin: Reports ────────────────────────────────────────────────────────────
router.get('/admin/reports/collection', adminGuard, adminCtrl.getCollectionReport);
router.get('/admin/reports/dues',       adminGuard, adminCtrl.getDuesReport);
router.get('/admin/reports/concession', adminGuard, adminCtrl.getConcessionReport);

// ── Admin: Settings ───────────────────────────────────────────────────────────
router.get('/admin/settings',  adminGuard, adminCtrl.getSettings);
router.put('/admin/settings',  adminGuard, adminCtrl.updateSettings);

// ── Shared JSON API ───────────────────────────────────────────────────────────
router.get('/students/:studentId/balance',  apiGuard, adminCtrl.getStudentBalance);
router.get('/classes/:classId/sections',    apiGuard, adminCtrl.getSectionsByClass);

// ── Student: My Fees ──────────────────────────────────────────────────────────
router.get('/student/my-fees',              studentGuard, studentCtrl.getMyFees);
router.get('/student/ledger',               studentGuard, studentCtrl.getMyLedger);
router.get('/student/payments',             studentGuard, studentCtrl.getMyPayments);
router.get('/student/pay',                  studentGuard, studentCtrl.getPayNow);
router.post('/student/pay',                 studentGuard, studentCtrl.payNow);
router.post('/student/pay/razorpay/create-order', studentGuard, studentCtrl.createRazorpayOrder);
router.post('/student/pay/razorpay/verify',       studentGuard, studentCtrl.verifyRazorpay);
router.post('/student/pay/stripe/create-intent',  studentGuard, studentCtrl.createStripeIntent);
router.post('/student/pay/stripe/verify',         studentGuard, studentCtrl.verifyStripe);
router.get('/student/payments/:id/receipt',       studentGuard, studentCtrl.getMyReceipt);
router.get('/student/payments/:id/download',      studentGuard, studentCtrl.downloadMyReceipt);

// ── Parent: Child Fees ────────────────────────────────────────────────────────
router.get('/parent/fees',                                        parentGuard, studentCtrl.getParentFeesRedirect);
router.get('/parent/child/:childId/fees',                         parentGuard, studentCtrl.getParentChildFees);
router.get('/parent/child/:childId/pay',                          parentGuard, studentCtrl.getParentPayNow);
router.post('/parent/child/:childId/pay',                         parentGuard, studentCtrl.postParentPayNow);
router.post('/parent/child/:childId/pay/razorpay/create-order',   parentGuard, studentCtrl.parentCreateRazorpayOrder);
router.post('/parent/child/:childId/pay/razorpay/verify',         parentGuard, studentCtrl.parentVerifyRazorpay);
router.post('/parent/child/:childId/pay/stripe/create-intent',    parentGuard, studentCtrl.parentCreateStripeIntent);
router.post('/parent/child/:childId/pay/stripe/verify',           parentGuard, studentCtrl.parentVerifyStripe);
router.get('/parent/child/:childId/payments/:paymentId/receipt',  parentGuard, studentCtrl.getParentPaymentReceipt);
router.get('/parent/child/:childId/payments/:paymentId/download', parentGuard, studentCtrl.downloadParentReceipt);

module.exports = router;
