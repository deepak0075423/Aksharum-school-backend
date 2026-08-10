'use strict';
const express = require('express');
const router  = express.Router();
const t       = require('../../controllers/transport.controller');
const p       = require('../../controllers/transportPortal.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule = require('../../middleware/requireModule');

const adminGuard   = [verifyToken, requirePasswordReset, requireRole('school_admin'), requireModule('transport')];
const parentGuard  = [verifyToken, requirePasswordReset, requireRole('parent'),       requireModule('transport')];
const studentGuard = [verifyToken, requirePasswordReset, requireRole('student'),      requireModule('transport')];

// ══ ADMIN / TRANSPORT MANAGER ════════════════════════════════════════════════
router.get('/admin/dashboard', adminGuard, t.getDashboard);
router.get('/admin/meta',      adminGuard, t.getMeta);
router.get('/admin/settings',  adminGuard, t.getSettings);
router.put('/admin/settings',  adminGuard, t.updateSettings);
router.get('/admin/reports',   adminGuard, t.getReports);
router.get('/admin/audit',     adminGuard, t.getAuditLog);

// Vehicles (§2)
router.get('/admin/vehicles',        adminGuard, t.getVehicles);
router.get('/admin/vehicles/:id',    adminGuard, t.getVehicle);
router.post('/admin/vehicles',       adminGuard, t.createVehicle);
router.put('/admin/vehicles/:id',    adminGuard, t.updateVehicle);
router.delete('/admin/vehicles/:id', adminGuard, t.deleteVehicle);

// Drivers & attendants (§3, §4)
router.get('/admin/staff',        adminGuard, t.getStaff);
router.get('/admin/staff/:id',    adminGuard, t.getStaffMember);
router.post('/admin/staff',       adminGuard, t.createStaff);
router.put('/admin/staff/:id',    adminGuard, t.updateStaff);
router.delete('/admin/staff/:id', adminGuard, t.deleteStaff);

// Routes & stops (§5, §6)
router.get('/admin/routes',            adminGuard, t.getRoutes);
router.get('/admin/routes/:id',        adminGuard, t.getRoute);
router.post('/admin/routes',           adminGuard, t.createRoute);
router.put('/admin/routes/:id',        adminGuard, t.updateRoute);
router.delete('/admin/routes/:id',     adminGuard, t.deleteRoute);
router.post('/admin/routes/:id/optimize', adminGuard, t.optimizeRoute);

// Assignments & seats (§7, §8)
router.get('/admin/assignments',            adminGuard, t.getAssignments);
router.post('/admin/assignments',           adminGuard, t.createAssignment);
router.put('/admin/assignments/:id',        adminGuard, t.updateAssignment);
router.post('/admin/assignments/:id/status', adminGuard, t.setAssignmentStatus);
router.get('/admin/seatmap/:vehicleId',     adminGuard, t.getSeatMap);

// Trips, tracking & attendance (§9, §10, §11)
router.get('/admin/trips',              adminGuard, t.getTrips);
router.get('/admin/trips/live',         adminGuard, t.getLiveTrips);
router.get('/admin/trips/:id',          adminGuard, t.getTrip);
router.post('/admin/trips/generate',    adminGuard, t.generateTrips);
router.post('/admin/trips/:id/action',  adminGuard, t.tripAction);
router.post('/admin/trips/:id/stop',    adminGuard, t.reachStop);
router.post('/admin/trips/:id/attendance', adminGuard, t.markTripAttendance);
router.post('/admin/location',          adminGuard, t.pushLocation);
router.get('/admin/trail',              adminGuard, t.getTrail);

// Fuel (§15)
router.get('/admin/fuel',        adminGuard, t.getFuelLogs);
router.post('/admin/fuel',       adminGuard, t.createFuelLog);
router.delete('/admin/fuel/:id', adminGuard, t.deleteFuelLog);

// Maintenance (§16)
router.get('/admin/maintenance',        adminGuard, t.getMaintenance);
router.post('/admin/maintenance',       adminGuard, t.createMaintenance);
router.put('/admin/maintenance/:id',    adminGuard, t.updateMaintenance);
router.delete('/admin/maintenance/:id', adminGuard, t.deleteMaintenance);

// Incidents (§17)
router.get('/admin/incidents',     adminGuard, t.getIncidents);
router.get('/admin/incidents/:id', adminGuard, t.getIncident);
router.post('/admin/incidents',    adminGuard, t.createIncident);
router.put('/admin/incidents/:id', adminGuard, t.updateIncident);

// Complaints (§18)
router.get('/admin/complaints',         adminGuard, t.getComplaints);
router.get('/admin/complaints/:id',     adminGuard, t.getComplaint);
router.post('/admin/complaints',        adminGuard, t.createComplaint);
router.post('/admin/complaints/:id/act', adminGuard, t.actOnComplaint);

// Fees (§14)
router.get('/admin/fee-plans',        adminGuard, t.getFeePlans);
router.post('/admin/fee-plans',       adminGuard, t.createFeePlan);
router.put('/admin/fee-plans/:id',    adminGuard, t.updateFeePlan);
router.delete('/admin/fee-plans/:id', adminGuard, t.deleteFeePlan);
router.get('/admin/invoices',           adminGuard, t.getInvoices);
router.post('/admin/invoices/generate', adminGuard, t.generateInvoices);
router.post('/admin/invoices/:id/pay',  adminGuard, t.recordFeePayment);
router.post('/admin/invoices/:id/cancel', adminGuard, t.cancelInvoice);

// Requests (§20)
router.get('/admin/requests',         adminGuard, t.getRequests);
router.post('/admin/requests/:id/act', adminGuard, t.actOnRequest);

// ══ PARENT PORTAL (§12) ══════════════════════════════════════════════════════
router.get('/parent/children',    parentGuard, p.parentChildren);
router.get('/parent/transport',   parentGuard, p.parentTransport);
router.get('/parent/track',       parentGuard, p.parentTrack);
router.get('/parent/attendance',  parentGuard, p.parentAttendance);
router.get('/parent/invoices',    parentGuard, p.parentInvoices);
router.get('/parent/requests',    parentGuard, p.parentRequests);
router.post('/parent/requests',   parentGuard, p.parentCreateRequest);
router.get('/parent/complaints',  parentGuard, p.parentComplaints);
router.post('/parent/complaints', parentGuard, p.parentCreateComplaint);

// ══ STUDENT (self) ═══════════════════════════════════════════════════════════
router.get('/student/transport',   studentGuard, p.studentTransport);
router.get('/student/track',       studentGuard, p.studentTrack);
router.get('/student/attendance',  studentGuard, p.studentAttendance);
router.get('/student/invoices',    studentGuard, p.studentInvoices);
router.get('/student/complaints',  studentGuard, p.studentComplaints);
router.post('/student/complaints', studentGuard, p.studentCreateComplaint);

module.exports = router;
