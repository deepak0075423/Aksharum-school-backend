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

// Module Permissions
router.get('/permissions',         guard, ctrl.getPermissions);
router.put('/permissions',         guard, ctrl.updatePermissions);
router.put('/permissions/bulk',    guard, ctrl.bulkUpdatePermissions);

// Notifications
router.get('/notifications',       guard, notifCtrl.getList);
router.post('/notifications/send', guard, notifCtrl.send);

// Holiday Audit
router.get('/holidays/audit',        guard, holidayCtrl.superAdminAuditLog);
router.get('/holidays/audit/export', guard, holidayCtrl.superAdminExportAuditCSV);

// Logs
router.get('/logs',        guard, logsCtrl.getLogs);
router.get('/logs/more',   guard, logsCtrl.getLogsMore);
router.get('/logs/export', guard, logsCtrl.exportCSV);

module.exports = router;
