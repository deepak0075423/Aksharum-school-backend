'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Who may use the hostel's management routes.
//
//  Two kinds of people run a hostel:
//
//    the module's admins   the school admin, and a teacher whose designation
//                          grants administrative access to 'hostel'. They see
//                          every hostel and every route.
//
//    the people on duty    a teacher who is the warden or assistant warden of
//                          a hostel, or holds an active staff posting in one.
//                          They get the DAY-TO-DAY routes, and every one of
//                          those narrows itself to the hostels they are posted
//                          to (services/hostelService.visibleHostelIds).
//
//  Before this guard, a posting on its own opened nothing: the routes asked
//  for the designation, so a warden without it could not take a roll call in
//  the hostel they were warden of — while the scoping code written for them
//  sat unreachable behind the guard.
//
//  What a posting opens is an ALLOWLIST, not "everything except". A route is
//  on it only if its handler checks the record's hostel against the caller's
//  postings; setup (hostels, buildings, floors), staff postings, the mess,
//  fees, reports, settings and the activity log stay with the admins.
// ─────────────────────────────────────────────────────────────────────────────
const designations = require('../services/designationService');
const { visibleHostelIds } = require('../services/hostelService');

const deny = (res, code, message) => res.status(403).json({ success: false, code, message });

/** `METHOD path`, exactly as routes/api/hostel.js registers them. */
const DUTY_ROUTES = new Set([
    // What every screen reads
    'GET /admin/dashboard', 'GET /admin/overview', 'GET /admin/board/:screen', 'GET /admin/meta',
    'GET /admin/students', 'GET /admin/settings', 'GET /admin/students/:studentId/profile',
    // Rooms, beds and the occupancy map — in their own hostels
    'GET /admin/occupancy', 'GET /admin/rooms', 'GET /admin/rooms/:id', 'POST /admin/rooms', 'PUT /admin/rooms/:id',
    'DELETE /admin/rooms/:id', 'POST /admin/rooms/:id/beds', 'GET /admin/beds', 'POST /admin/beds', 'PUT /admin/beds/:id',
    'POST /admin/beds/:id/state', 'DELETE /admin/beds/:id',
    // Admissions and allocations
    'GET /admin/admissions', 'GET /admin/admissions/:id', 'POST /admin/admissions', 'PUT /admin/admissions/:id',
    'POST /admin/admissions/:id/decision',
    'GET /admin/allocations', 'POST /admin/allocations', 'POST /admin/allocations/auto', 'POST /admin/allocations/bulk',
    'POST /admin/allocations/:id/transfer', 'POST /admin/allocations/:id/release', 'POST /admin/allocations/:id/confirm',
    'GET /admin/allocations/:id/history', 'GET /admin/allocation-history',
    'GET /admin/allocations/:id/checkout', 'GET /admin/transfer-requests',
    // Roll call
    'GET /admin/attendance', 'GET /admin/attendance/history', 'POST /admin/attendance',
    'POST /admin/attendance/:id/correct', 'POST /admin/attendance/:id/approve',
    // Leave, outpass, the gate
    'GET /admin/leaves', 'POST /admin/leaves', 'POST /admin/leaves/:id/act',
    'GET /admin/outpasses', 'POST /admin/outpasses', 'POST /admin/outpasses/gate', 'GET /admin/outpasses/verify/:token',
    'GET /admin/outpasses/:id/qr.png', 'POST /admin/outpasses/:id/act',
    'GET /admin/visitors', 'POST /admin/visitors', 'POST /admin/visitors/:id/act', 'GET /admin/visitors/:id/pass',
    'DELETE /admin/visitors/:id',
    'GET /admin/movements', 'POST /admin/movements', 'GET /admin/movements/live',
    // Complaints, repairs, assets
    'GET /admin/complaints', 'POST /admin/complaints', 'GET /admin/complaints/:id', 'POST /admin/complaints/:id/act',
    'GET /admin/maintenance', 'POST /admin/maintenance', 'PUT /admin/maintenance/:id', 'POST /admin/maintenance/:id/act',
    'DELETE /admin/maintenance/:id',
    'GET /admin/assets', 'GET /admin/assets/inventory', 'POST /admin/assets', 'PUT /admin/assets/:id',
    'POST /admin/assets/:id/act', 'GET /admin/assets/:id/qr',
    // Incidents and discipline
    'GET /admin/incidents', 'GET /admin/incidents/:id', 'POST /admin/incidents', 'PUT /admin/incidents/:id',
    'GET /admin/discipline', 'POST /admin/discipline', 'PUT /admin/discipline/:id', 'GET /admin/discipline/student/:studentId',
    // Documents, attachments, notices
    'GET /admin/documents', 'POST /admin/documents', 'GET /admin/documents/:id/download', 'POST /admin/documents/:id/verify',
    'DELETE /admin/documents/:id', 'POST /admin/attachments',
    'GET /admin/announcements/audience', 'POST /admin/announcements', 'GET /admin/announcements/:id',
    'PUT /admin/announcements/:id', 'POST /admin/announcements/:id/send', 'POST /admin/announcements/:id/archive',
    'POST /admin/announcements/:id/restore', 'DELETE /admin/announcements/:id',
]);

/** The list screens (GET /admin/board/:screen) a posting opens. */
const DUTY_BOARDS = new Set([
    'rooms', 'occupancy', 'admissions', 'allocations', 'allocation-history', 'attendance', 'attendance-history',
    'leave', 'outpass', 'visitors', 'movements', 'complaints', 'maintenance', 'assets', 'incidents', 'discipline',
    'discipline-offenders', 'documents', 'announcements',
]);

/**
 * Route guard for /hostel/admin/*. Leaves `req.access` set (the handlers'
 * scoping reads it) and `req.hostelDuty` true when the caller is in on a
 * posting rather than as an admin.
 */
async function hostelDesk(req, res, next) {
    try {
        if (!req.schoolId) return next();                     // super admin
        const role = req.userRole;
        if (role !== 'school_admin' && role !== 'teacher') return deny(res, 'INSUFFICIENT_PERMISSIONS', 'Insufficient permissions');

        const access = await designations.requestAccess(req);
        req.access = access;
        if (!access.moduleFlags.hostel) return deny(res, 'MODULE_DISABLED', "Module 'hostel' is not enabled for your school");
        if (role === 'school_admin' || access.permissions.hostel === designations.ADMIN) return next();

        // A teacher without the designation: in only on a posting, and only
        // for the day-to-day routes.
        const posted = await visibleHostelIds(req);
        if (!posted || !posted.length) return deny(res, 'MODULE_ADMIN_REQUIRED', 'Administrative access to this module is required');

        const key = `${req.method} ${req.route?.path}`;
        const allowed = DUTY_ROUTES.has(key)
            && (key !== 'GET /admin/board/:screen' || DUTY_BOARDS.has(String(req.params.screen)));
        if (!allowed) return deny(res, 'HOSTEL_ADMIN_ONLY', 'This part of the hostel is managed by the hostel administrators');

        req.hostelDuty = true;
        next();
    } catch (err) { next(err); }
}

/** For the modules payload: is this teacher posted to a hostel? */
async function onHostelDuty(schoolId, userId) {
    const ids = await visibleHostelIds({ schoolId, userId, userRole: 'teacher', access: {} });
    return !!(ids && ids.length);
}

module.exports = { hostelDesk, onHostelDuty, DUTY_ROUTES, DUTY_BOARDS };
