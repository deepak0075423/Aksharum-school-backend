'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  /api/hostel — Hostel Management routes (spec §33).
//
//  Three guards, matching the existing module convention:
//    adminGuard    school_admin, or a teacher whose designation grants
//                  administrative access to 'hostel'. Wardens fall in here;
//                  the controller narrows what they see to their own hostels.
//    studentGuard  role student + the module enabled for the school
//    parentGuard   role parent  + the module enabled for the school
//
//  Every guard starts with verifyToken + requirePasswordReset, so no hostel
//  endpoint is reachable without the existing authentication.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const h = require('../../controllers/hostel.controller');
const p = require('../../controllers/hostelPortal.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule = require('../../middleware/requireModule');
const { allowModuleAdmin } = require('../../middleware/moduleAccess');
const { uploadHostelDoc } = require('../../middleware/upload');

const adminGuard   = [verifyToken, requirePasswordReset, allowModuleAdmin('hostel')];
const studentGuard = [verifyToken, requirePasswordReset, requireRole('student'), requireModule('hostel')];
const parentGuard  = [verifyToken, requirePasswordReset, requireRole('parent'),  requireModule('hostel')];

// ══ ADMIN / WARDEN ═══════════════════════════════════════════════════════════

// Dashboard, meta, settings, audit (§3, §28, §29)
router.get('/admin/dashboard', adminGuard, h.getDashboard);
router.get('/admin/meta',      adminGuard, h.getMeta);
router.get('/admin/students',  adminGuard, h.searchStudents);
router.get('/admin/settings',  adminGuard, h.getSettings);
router.put('/admin/settings',  adminGuard, h.updateSettings);
router.get('/admin/audit',     adminGuard, h.getAuditLog);

// Hostel setup (§4)
router.get('/admin/hostels',        adminGuard, h.getHostels);
router.get('/admin/hostels/:id',    adminGuard, h.getHostel);
router.post('/admin/hostels',       adminGuard, h.createHostel);
router.put('/admin/hostels/:id',    adminGuard, h.updateHostel);
router.delete('/admin/hostels/:id', adminGuard, h.deleteHostel);

// Buildings & floors (§5)
router.get('/admin/buildings',        adminGuard, h.getBuildings);
router.post('/admin/buildings',       adminGuard, h.createBuilding);
router.put('/admin/buildings/:id',    adminGuard, h.updateBuilding);
router.delete('/admin/buildings/:id', adminGuard, h.deleteBuilding);
router.get('/admin/floors',        adminGuard, h.getFloors);
router.post('/admin/floors',       adminGuard, h.createFloor);
router.put('/admin/floors/:id',    adminGuard, h.updateFloor);
router.delete('/admin/floors/:id', adminGuard, h.deleteFloor);

// Rooms & beds (§6, §7) + the drill-down occupancy tree (§32)
router.get('/admin/occupancy',        adminGuard, h.getOccupancyTree);
router.get('/admin/rooms',            adminGuard, h.getRooms);
router.get('/admin/rooms/:id',        adminGuard, h.getRoom);
router.post('/admin/rooms',           adminGuard, h.createRoom);
router.put('/admin/rooms/:id',        adminGuard, h.updateRoom);
router.delete('/admin/rooms/:id',     adminGuard, h.deleteRoom);
router.post('/admin/rooms/:id/beds',  adminGuard, h.generateBeds);
router.get('/admin/beds',             adminGuard, h.getBeds);
router.post('/admin/beds',            adminGuard, h.createBed);
router.put('/admin/beds/:id',         adminGuard, h.updateBed);
router.post('/admin/beds/:id/state',  adminGuard, h.setBedState);
router.delete('/admin/beds/:id',      adminGuard, h.deleteBed);

// Admissions (§8)
router.get('/admin/admissions',              adminGuard, h.getAdmissions);
router.get('/admin/admissions/:id',          adminGuard, h.getAdmission);
router.post('/admin/admissions',             adminGuard, h.createAdmission);
router.put('/admin/admissions/:id',          adminGuard, h.updateAdmission);
router.post('/admin/admissions/:id/decision', adminGuard, h.decideAdmission);

// Allocation & transfer (§10) and the student hostel profile (§9)
router.get('/admin/allocations',               adminGuard, h.getAllocations);
router.post('/admin/allocations',              adminGuard, h.createAllocation);
router.post('/admin/allocations/auto',         adminGuard, h.autoAllocate);
router.post('/admin/allocations/bulk',         adminGuard, h.bulkAllocate);
router.post('/admin/allocations/:id/transfer', adminGuard, h.transferAllocation);
router.post('/admin/allocations/:id/release',  adminGuard, h.releaseAllocation);
router.get('/admin/allocations/:id/history',   adminGuard, h.getAllocationHistory);
router.get('/admin/allocation-history',        adminGuard, h.getAllocationHistory);
router.get('/admin/students/:studentId/profile', adminGuard, h.getStudentHostelProfile);

// Attendance (§11)
router.get('/admin/attendance',                 adminGuard, h.getAttendanceRegister);
router.get('/admin/attendance/history',         adminGuard, h.getAttendanceHistory);
router.post('/admin/attendance',                adminGuard, h.markAttendance);
router.post('/admin/attendance/:id/correct',    adminGuard, h.correctAttendance);
router.post('/admin/attendance/:id/approve',    adminGuard, h.approveAttendanceCorrection);

// Leave (§12)
router.get('/admin/leaves',         adminGuard, h.getLeaves);
router.post('/admin/leaves',        adminGuard, h.createLeave);
router.post('/admin/leaves/:id/act', adminGuard, h.actOnLeave);

// Outpass (§12) — including the QR gate
router.get('/admin/outpasses',          adminGuard, h.getOutpasses);
router.post('/admin/outpasses',         adminGuard, h.createOutpass);
router.post('/admin/outpasses/gate',    adminGuard, h.gateScan);
router.post('/admin/outpasses/sweep',   adminGuard, h.runOverdueSweep);
router.get('/admin/outpasses/verify/:token', adminGuard, h.verifyOutpass);
router.get('/admin/outpasses/:id/qr.png', adminGuard, h.outpassQr);
router.post('/admin/outpasses/:id/act', adminGuard, h.actOnOutpass);

// Visitors (§13)
router.get('/admin/visitors',          adminGuard, h.getVisitors);
router.post('/admin/visitors',         adminGuard, h.createVisitor);
router.post('/admin/visitors/:id/act', adminGuard, h.actOnVisitor);
router.delete('/admin/visitors/:id',   adminGuard, h.deleteVisitor);

// Warden & hostel staff (§14)
router.get('/admin/staff',        adminGuard, h.getStaffAssignments);
router.post('/admin/staff',       adminGuard, h.createStaffAssignment);
router.put('/admin/staff/:id',    adminGuard, h.updateStaffAssignment);
router.delete('/admin/staff/:id', adminGuard, h.endStaffAssignment);

// Mess (§15)
router.get('/admin/mess',            adminGuard, h.getMesses);
router.post('/admin/mess',           adminGuard, h.createMess);
router.put('/admin/mess/:id',        adminGuard, h.updateMess);
router.delete('/admin/mess/:id',     adminGuard, h.deleteMess);
router.get('/admin/mess-members',    adminGuard, h.getMessMembers);
router.post('/admin/mess-members',   adminGuard, h.enrolMessMember);
router.put('/admin/mess-members/:id', adminGuard, h.updateMessMember);
router.get('/admin/menus',           adminGuard, h.getMenus);
router.post('/admin/menus',          adminGuard, h.saveMenu);
router.post('/admin/menus/generate', adminGuard, h.generateMenus);
router.delete('/admin/menus/:id',    adminGuard, h.deleteMenu);
router.get('/admin/mess-attendance', adminGuard, h.getMessAttendance);
router.post('/admin/mess-attendance', adminGuard, h.markMessAttendance);
router.get('/admin/mess-expenses',   adminGuard, h.getMessExpenses);
router.post('/admin/mess-expenses',  adminGuard, h.createMessExpense);
router.delete('/admin/mess-expenses/:id', adminGuard, h.deleteMessExpense);

// Fees (§16)
router.get('/admin/fee-plans',        adminGuard, h.getFeePlans);
router.post('/admin/fee-plans',       adminGuard, h.createFeePlan);
router.put('/admin/fee-plans/:id',    adminGuard, h.updateFeePlan);
router.delete('/admin/fee-plans/:id', adminGuard, h.deleteFeePlan);
router.get('/admin/invoices',              adminGuard, h.getInvoices);
router.post('/admin/invoices',             adminGuard, h.createInvoice);
router.post('/admin/invoices/generate',    adminGuard, h.generateInvoices);
router.post('/admin/invoices/late-fees',   adminGuard, h.applyLateFees);
router.post('/admin/invoices/fine',        adminGuard, h.raiseFine);
router.post('/admin/invoices/:id/pay',      adminGuard, h.payInvoice);
router.post('/admin/invoices/:id/discount', adminGuard, h.discountInvoice);
router.post('/admin/invoices/:id/refund',   adminGuard, h.refundInvoice);
router.post('/admin/invoices/:id/cancel',   adminGuard, h.cancelInvoice);

// Complaints (§17)
router.get('/admin/complaints',          adminGuard, h.getComplaints);
router.post('/admin/complaints',         adminGuard, h.createComplaint);
router.post('/admin/complaints/escalate', adminGuard, h.escalateOverdueComplaints);
router.get('/admin/complaints/:id',      adminGuard, h.getComplaint);
router.post('/admin/complaints/:id/act', adminGuard, h.actOnComplaint);

// Maintenance (§18)
router.get('/admin/maintenance',          adminGuard, h.getMaintenance);
router.post('/admin/maintenance',         adminGuard, h.createMaintenance);
router.put('/admin/maintenance/:id',      adminGuard, h.updateMaintenance);
router.post('/admin/maintenance/:id/act', adminGuard, h.actOnMaintenance);
router.delete('/admin/maintenance/:id',   adminGuard, h.deleteMaintenance);

// Assets (§19) — mapped onto the Inventory module
router.get('/admin/assets',              adminGuard, h.getAssets);
router.get('/admin/assets/inventory',    adminGuard, h.getAvailableInventoryAssets);
router.post('/admin/assets',             adminGuard, h.createAsset);
router.put('/admin/assets/:id',          adminGuard, h.updateAsset);
router.post('/admin/assets/:id/act',     adminGuard, h.actOnAsset);

// Security & movement (§20)
router.get('/admin/movements',      adminGuard, h.getMovements);
router.post('/admin/movements',     adminGuard, h.recordMovement);
router.get('/admin/movements/live', adminGuard, h.getLiveMovement);

// Incidents & medical (§21, §22)
router.get('/admin/incidents',     adminGuard, h.getIncidents);
router.get('/admin/incidents/:id', adminGuard, h.getIncident);
router.post('/admin/incidents',    adminGuard, h.createIncident);
router.put('/admin/incidents/:id', adminGuard, h.updateIncident);

// Discipline (§23)
router.get('/admin/discipline',       adminGuard, h.getDisciplineActions);
router.post('/admin/discipline',      adminGuard, h.createDisciplineAction);
router.put('/admin/discipline/:id',   adminGuard, h.updateDisciplineAction);
router.get('/admin/discipline/student/:studentId', adminGuard, h.getStudentDiscipline);

// Communication (§24)
router.post('/admin/announcements', adminGuard, h.sendAnnouncement);

// Attachments — one upload route serving complaints, incidents, maintenance,
// leaves and outpasses, all of which store `attachments: [String]`.
router.post('/admin/attachments', adminGuard, uploadHostelDoc.single('file'), h.uploadAttachment);

// Documents (§25)
router.get('/admin/documents',             adminGuard, h.getDocuments);
router.post('/admin/documents', adminGuard, uploadHostelDoc.single('file'), h.uploadDocument);
router.get('/admin/documents/:id/download', adminGuard, h.downloadDocument);
router.post('/admin/documents/:id/verify',  adminGuard, h.verifyDocument);
router.delete('/admin/documents/:id',       adminGuard, h.deleteDocument);

// Reports (§26)
router.get('/admin/reports/types',  adminGuard, h.getReportTypes);
router.get('/admin/reports/export', adminGuard, h.exportReport);
router.get('/admin/reports',        adminGuard, h.getReport);

// ══ STUDENT PORTAL ═══════════════════════════════════════════════════════════
router.get('/student/my-hostel',   studentGuard, p.myHostel);
router.get('/student/hostels',     studentGuard, p.availableHostels);
router.post('/student/apply',      studentGuard, p.applyForHostel);
router.get('/student/attendance',  studentGuard, p.myAttendance);
router.get('/student/leaves',      studentGuard, p.myLeaves);
router.post('/student/leaves',     studentGuard, p.applyLeave);
router.post('/student/leaves/:id/act', studentGuard, p.actOnMyLeave);
router.get('/student/outpasses',   studentGuard, p.myOutpasses);
router.post('/student/outpasses',  studentGuard, p.applyOutpass);
router.get('/student/outpasses/:id/pass', studentGuard, p.myOutpassPass);
router.get('/student/outpasses/:id/qr.png', studentGuard, p.myOutpassQr);
router.post('/student/outpasses/:id/cancel', studentGuard, p.cancelMyOutpass);
router.get('/student/visitors',    studentGuard, p.myVisitors);
router.post('/student/visitors',   studentGuard, p.requestVisitor);
router.get('/student/fees',        studentGuard, p.myFees);
router.get('/student/complaints',  studentGuard, p.myComplaints);
router.post('/student/complaints', studentGuard, p.raiseComplaint);
router.post('/student/complaints/:id/act', studentGuard, p.actOnMyComplaint);
router.get('/student/mess',        studentGuard, p.myMess);
router.get('/student/record',      studentGuard, p.myRecord);
router.post('/student/attachments', studentGuard, uploadHostelDoc.single('file'), p.uploadAttachment);

// ══ PARENT PORTAL ════════════════════════════════════════════════════════════
// Same handlers — subjectStudent() resolves the child from the ParentProfile,
// so a parent can never read a student who is not theirs.
router.get('/parent/children',    parentGuard, p.myChildren);
router.get('/parent/my-hostel',   parentGuard, p.myHostel);
router.get('/parent/hostels',     parentGuard, p.availableHostels);
router.post('/parent/apply',      parentGuard, p.applyForHostel);
router.get('/parent/attendance',  parentGuard, p.myAttendance);
router.get('/parent/leaves',      parentGuard, p.myLeaves);
router.post('/parent/leaves',     parentGuard, p.applyLeave);
router.post('/parent/leaves/:id/act', parentGuard, p.actOnMyLeave);
router.get('/parent/outpasses',   parentGuard, p.myOutpasses);
router.post('/parent/outpasses',  parentGuard, p.applyOutpass);
router.post('/parent/outpasses/:id/cancel', parentGuard, p.cancelMyOutpass);
router.get('/parent/visitors',    parentGuard, p.myVisitors);
router.post('/parent/visitors',   parentGuard, p.requestVisitor);
router.get('/parent/fees',        parentGuard, p.myFees);
router.get('/parent/complaints',  parentGuard, p.myComplaints);
router.post('/parent/complaints', parentGuard, p.raiseComplaint);
router.post('/parent/complaints/:id/act', parentGuard, p.actOnMyComplaint);
router.get('/parent/mess',        parentGuard, p.myMess);
router.get('/parent/record',      parentGuard, p.myRecord);
router.post('/parent/attachments', parentGuard, uploadHostelDoc.single('file'), p.uploadAttachment);

module.exports = router;
