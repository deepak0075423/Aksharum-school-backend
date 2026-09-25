'use strict';
const express = require('express');
const router  = express.Router();
const t       = require('../../controllers/transport.controller');
const p       = require('../../controllers/transportPortal.controller');
const a       = require('../../controllers/transportAdmin.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule = require('../../middleware/requireModule');
const { allowModuleAdmin } = require('../../middleware/moduleAccess');
const { requireTransportEnrolment } = require('../../services/transportEnrolment');

const adminGuard   = [verifyToken, requirePasswordReset, allowModuleAdmin('transport')];
// The portal guards carry one more layer than the module gate: the school has
// Transport on and the role may reach it, AND this person actually uses the
// service. A parent whose child does not ride the bus has no business on the
// live map. See services/transportEnrolment.
const parentGuard  = [verifyToken, requirePasswordReset, requireRole('parent'),  requireModule('transport'), requireTransportEnrolment];
const studentGuard = [verifyToken, requirePasswordReset, requireRole('student'), requireModule('transport'), requireTransportEnrolment];
// A driver/conductor/helper is an employee, so they sign in as staff. The
// handler finds their crew record from their own user id — nobody can push a
// position for somebody else. Their crew record is itself what admits them.
const crewGuard    = [verifyToken, requirePasswordReset, requireRole('teacher'), requireModule('transport'), requireTransportEnrolment];
// A teacher who rides the bus: same portal as a student, gated the same way.
const staffRiderGuard = [verifyToken, requirePasswordReset, requireRole('teacher'), requireModule('transport'), requireTransportEnrolment];

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
// MUST stay above '/admin/staff/:id' — Express matches in registration order, so
// a ':id' registered first swallows every literal path beside it. This one is
// the crew picker's list; it answered 404 "Staff not found" for months because
// it was declared 80 lines further down. The other /admin/staff/* read-model
// routes are safe only because they are two segments deep.
router.get('/admin/staff/employees', adminGuard, a.assignableEmployees);
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

// ══ ADMIN — per-screen read models (Sep 2026 redesign) ═══════════════════════
// One endpoint per screen, named after the screen. The CRUD routes above stay
// as they are: the mobile app and the portal still call them.
router.get('/admin/overview',            adminGuard, a.overview);
router.get('/admin/live-board',          adminGuard, a.liveBoard);

router.get('/admin/vehicle-board',       adminGuard, a.vehicleBoard);
router.get('/admin/vehicle-board/:id',   adminGuard, a.vehicleDetail);

router.get('/admin/staff-board',          adminGuard, a.staffBoard);
// GET /admin/staff/employees is declared with the CRUD block above, where it has
// to sit to beat '/admin/staff/:id'.
router.post('/admin/staff/assign',        adminGuard, a.assignCrewRole);
router.post('/admin/staff/:id/unlink',    adminGuard, a.unlinkCrewEmployee);
router.post('/admin/staff/:id/leave',     adminGuard, a.markStaffLeave);
router.post('/admin/staff/:id/leave/end', adminGuard, a.endStaffLeave);
router.post('/admin/staff/:id/location',  adminGuard, a.pushStaffLocation);
router.post('/admin/staff/:id/sharing',   adminGuard, a.setLocationSharing);
router.get('/admin/staff/:id/trail',      adminGuard, a.staffTrail);

router.get('/admin/route-board',         adminGuard, a.routeBoard);

router.get('/admin/assignment-board',    adminGuard, a.assignmentBoard);
// Students AND teachers who can be enrolled, with whether they already are.
router.get('/admin/enrollable',          adminGuard, a.enrollablePeople);
router.post('/admin/assignments/bulk',   adminGuard, a.bulkAssign);
router.post('/admin/assignments/import', adminGuard, a.importAssignments);
router.post('/admin/assignments/notify', adminGuard, a.notifyAssignees);

router.get('/admin/trip-board',          adminGuard, a.tripBoard);
router.get('/admin/trip-board/:id',      adminGuard, a.tripDetail);
router.post('/admin/trips/schedule',     adminGuard, a.scheduleTrip);

router.get('/admin/fuel-board',          adminGuard, a.fuelBoard);
router.post('/admin/fuel/bulk',          adminGuard, a.bulkFuel);

router.get('/admin/maintenance-board',   adminGuard, a.maintenanceBoard);
router.get('/admin/incident-board',      adminGuard, a.incidentBoard);
router.get('/admin/complaint-board',     adminGuard, a.complaintBoard);

router.get('/admin/fee-plan-board',      adminGuard, a.feePlanBoard);
router.post('/admin/fee-plans/:id/approve', adminGuard, a.approveFeePlan);

router.get('/admin/invoice-board',       adminGuard, a.invoiceBoard);
router.post('/admin/invoices/remind',    adminGuard, a.remindInvoices);
router.get('/admin/invoices/:id/receipt', adminGuard, a.invoiceReceipt);

router.get('/admin/request-board',       adminGuard, a.requestBoard);
router.post('/admin/requests',           adminGuard, a.createRequest);
router.post('/admin/requests/:id/flag',  adminGuard, a.flagRequest);

router.get('/admin/report-board',        adminGuard, a.reportBoard);
router.post('/admin/reports/generate',   adminGuard, a.generateReport);
router.post('/admin/reports/schedule',   adminGuard, a.saveScheduledReport);
router.get('/admin/reports/:id/download', adminGuard, a.downloadReport);
router.post('/admin/reports/:id/toggle', adminGuard, a.toggleReport);
router.delete('/admin/reports/:id',      adminGuard, a.deleteReport);

router.get('/admin/settings/full',       adminGuard, a.settingsFull);
router.put('/admin/settings/full',       adminGuard, a.updateSettingsFull);
router.post('/admin/settings/reset',     adminGuard, a.resetSettings);
router.get('/admin/settings/export',     adminGuard, a.exportData);
router.post('/admin/settings/backup',    adminGuard, a.markBackup);

router.get('/admin/activity',            adminGuard, a.activityBoard);

// ══ CREW (self) ══════════════════════════════════════════════════════════════
// A driver, conductor or crew member reading their OWN duty. Everything here is
// keyed on req.userId, so there is no id to pass and none to guess at.
router.get('/crew/duty',       crewGuard, p.crewDuty);
router.get('/crew/roster',     crewGuard, p.crewRoster);
router.post('/crew/sharing',   crewGuard, p.crewSetSharing);
router.post('/staff/location', crewGuard, a.selfPushLocation);

// The run itself, driven from the bus. `p.ownTrip` proves the trip is theirs
// and then the SAME handlers the office uses run, so "a stop was reached" has
// one implementation and the delay and the parent notifications come with it.
router.post('/crew/trips/:id/action',     crewGuard, p.ownTrip, t.tripAction);
router.post('/crew/trips/:id/stop',       crewGuard, p.ownTrip, t.reachStop);
router.post('/crew/trips/:id/attendance', crewGuard, p.ownTrip, t.markTripAttendance);

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

// ══ STAFF RIDER — a teacher enrolled in the service ══════════════════════════
router.get('/staff/transport',   staffRiderGuard, p.staffTransport);
router.get('/staff/track',       staffRiderGuard, p.staffTrack);
router.get('/staff/attendance',  staffRiderGuard, p.staffAttendance);
router.get('/staff/invoices',    staffRiderGuard, p.staffInvoices);
router.get('/staff/complaints',  staffRiderGuard, p.staffComplaints);
router.post('/staff/complaints', staffRiderGuard, p.staffCreateComplaint);

module.exports = router;
