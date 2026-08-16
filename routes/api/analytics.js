'use strict';
//  Student Analytics — shared by school admins and teachers. There is no
//  requireModule() guard here: the dashboard is not a module of its own, it
//  reflects whichever modules the school has switched on (the controller reads
//  School.modules and only builds the blocks that are enabled).
//
//  Row-level access is enforced inside the controller: admins see the whole
//  school, a teacher only the sections they are class teacher / vice class
//  teacher of, or teach a subject in.
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/studentAnalytics.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');

const guard = [verifyToken, requirePasswordReset, requireRole('school_admin', 'teacher')];

router.get('/scope',               guard, ctrl.getScope);
router.get('/overview',            guard, ctrl.getOverview);
router.get('/students',            guard, ctrl.getStudents);
router.get('/students/:studentId', guard, ctrl.getStudentAnalytics);

module.exports = router;
