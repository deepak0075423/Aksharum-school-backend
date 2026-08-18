'use strict';
const express        = require('express');
const router         = express.Router();
const parentCtrl     = require('../../controllers/parent.controller');
const attendanceCtrl = require('../../controllers/attendance.controller');
const examCtrl       = require('../../controllers/aptitudeExam.controller');
const formalExamCtrl = require('../../controllers/formalExam.controller');
const classTestCtrl  = require('../../controllers/classTest.controller');
const docCtrl        = require('../../controllers/document.controller');
const holidayCtrl    = require('../../controllers/holiday.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const { modulesHandler } = require('../../utils/moduleResponse');
const requireModule  = require('../../middleware/requireModule');

const guard            = [verifyToken, requirePasswordReset, requireRole('parent')];
const attendanceGuard  = [...guard, requireModule('attendance')];
const examGuard        = [...guard, requireModule('aptitudeExam')];
const resultGuard      = [...guard, requireModule('result')];
const docGuard         = [...guard, requireModule('document')];
const holidayGuard     = [...guard, requireModule('holiday')];

router.get('/dashboard',   guard, parentCtrl.getDashboard);
router.get('/child-class', guard, parentCtrl.getChildClass);

// Enabled modules for this school
router.get('/modules', guard, modulesHandler);

// Attendance
router.get('/child-attendance', attendanceGuard, attendanceCtrl.getParentChildAttendance);

// Exams
router.get('/exams', examGuard, examCtrl.getParentExamResults);

// Results
router.get('/results',             resultGuard, formalExamCtrl.parentGetResults);
router.get('/results/class-tests', resultGuard, classTestCtrl.parentGetClassTests);
router.get('/results/:resultId',   resultGuard, formalExamCtrl.parentGetResultDetail);

// Documents
router.get('/documents',      docGuard, docCtrl.parentGetDocuments);
router.get('/documents/:id',  docGuard, docCtrl.parentGetDocument);

// Holidays
router.get('/holidays', holidayGuard, holidayCtrl.parentGetHolidays);

module.exports = router;
