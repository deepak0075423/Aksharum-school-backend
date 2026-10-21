'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/superAdmin.controller');
const notifCtrl = require('../../controllers/notification.controller');
const logsCtrl  = require('../../controllers/logs.controller');
const holidayCtrl = require('../../controllers/holiday.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const { uploadExcel, uploadImage } = require('../../middleware/upload');

const guard = [verifyToken, requirePasswordReset, requireRole('super_admin')];

// Dashboard
router.get('/dashboard', guard, ctrl.getDashboard);

// Schools
router.get('/schools',          guard, ctrl.getSchools);
router.post('/schools',         guard, uploadImage.single('logo'), ctrl.createSchool);
// Declared before /schools/:id so the parameter never swallows them.
router.get('/schools/:id/delete-check',  guard, ctrl.checkSchoolDeletable);
router.get('/schools/:id/users/export',  guard, ctrl.exportSchoolUsers);
router.get('/schools/:id',      guard, ctrl.getSchool);
router.put('/schools/:id',      guard, uploadImage.single('logo'), ctrl.updateSchool);
router.delete('/schools/:id',   guard, ctrl.deleteSchool);

// Users — specific routes MUST come before /:id wildcards
router.get('/users',                          guard, ctrl.getUsers);
router.post('/users',                         guard, ctrl.createUser);
router.delete('/users/bulk-delete',           guard, ctrl.bulkDeleteUsers);
router.post('/users/bulk-teachers',           guard, uploadExcel.single('excelFile'), ctrl.bulkTeachers);
router.post('/users/bulk-students',           guard, uploadExcel.single('excelFile'), ctrl.bulkStudents);
router.get('/users/template/teachers',        guard, ctrl.downloadTeacherTemplate);
router.get('/users/template/students',        guard, ctrl.downloadStudentTemplate);
router.get('/users/:id',                      guard, ctrl.getUser);
router.put('/users/:id',                      guard, ctrl.updateUser);
router.delete('/users/:id',                   guard, ctrl.deleteUser);
router.patch('/users/:id/toggle',             guard, ctrl.toggleUserStatus);
router.post('/users/:id/login-link',          guard, ctrl.generateLoginLink);

// Module Permissions — school-level enablement (the top of the hierarchy)
// The school form fills city and state from a PIN code, as the teacher form does.
router.get('/pincode/:pincode',    guard, require('../../controllers/admin.controller').pincodeLookup);
router.get('/permissions',         guard, ctrl.getPermissions);
router.put('/permissions',         guard, ctrl.updatePermissions);
router.put('/permissions/bulk',    guard, ctrl.bulkUpdatePermissions);

// Designation Permissions — the middle of the hierarchy, per school. Same
// controller the school admin uses; the school comes from the route instead of
// from the token.

// Notifications
router.get('/notifications',       guard, notifCtrl.getList);
router.post('/notifications/send', guard, notifCtrl.send);

// Holiday Audit
// How this server sees a request's address — to check TRUST_PROXY_HOPS in
// production. Rate limits key on req.ip: with too few hops every visitor shares
// the proxy's address; with too many, X-Forwarded-For can be forged again.
// Admission groups — schools that families see on one page, /g/<slug> (controllers/admissionGroup).
const admissionGroups = require('../../controllers/admissionGroup.controller');
router.get('/admission-groups', guard, admissionGroups.list);
router.post('/admission-groups', guard, admissionGroups.create);
router.put('/admission-groups/:id', guard, admissionGroups.update);
router.delete('/admission-groups/:id', guard, admissionGroups.remove);

router.get('/diagnostics/request', guard, (req, res) => {
    const hops = req.app.get('trust proxy');
    const xff = String(req.get('x-forwarded-for') || '');
    const chain = xff ? xff.split(',').map((x) => x.trim()).filter(Boolean) : [];
    res.set('Cache-Control', 'no-store').json({
        success: true,
        data: {
            ip: req.ip, ips: req.ips, socketAddress: req.socket?.remoteAddress || '', forwardedFor: chain, trustProxy: hops,
            advice: !chain.length
                ? 'No X-Forwarded-For header arrived: either nothing sits in front of this server, or the proxy does not set it.'
                : `The proxy chain has ${chain.length} address(es). TRUST_PROXY_HOPS should equal the number of proxies you run in front of the API (nginx alone = 1; a CDN or load balancer in front of nginx adds one each). "ip" above must be your own public address.`,
        },
    });
});

router.get('/holidays/audit',        guard, holidayCtrl.superAdminAuditLog);
router.get('/holidays/audit/export', guard, holidayCtrl.superAdminExportAuditCSV);

// Logs
router.get('/logs',        guard, logsCtrl.getLogs);
router.get('/logs/more',   guard, logsCtrl.getLogsMore);
router.get('/logs/export', guard, logsCtrl.exportCSV);

module.exports = router;
