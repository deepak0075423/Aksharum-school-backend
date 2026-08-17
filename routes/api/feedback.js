'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Teacher Feedback & Evaluation — API surface.
//
//  Guard ladder (every route is gated on the server; the frontend route guards
//  are convenience only):
//
//    adminGuard      school_admin                    → configuration + management
//    analyticsGuard  school_admin | principal        → school-wide read-only
//    teacherGuard    teacher                         → own aggregated results
//    studentGuard    student                         → own assignments only
//
//  "principal" is a teacher whose TeacherProfile.designation is Principal /
//  Vice Principal — the same designation-based RBAC the library module uses for
//  Librarian, because the ERP has no principal role on User.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

const admin   = require('../../controllers/feedback.controller');
const student = require('../../controllers/feedbackStudent.controller');
const teacher = require('../../controllers/feedbackTeacher.controller');

const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule = require('../../middleware/requireModule');
const { rateLimit } = require('../../middleware/rateLimit');
const fb = require('../../services/feedbackService');

const base = [verifyToken, requirePasswordReset, requireModule('feedback')];

const adminGuard   = [...base, requireRole('school_admin')];
const teacherGuard = [...base, requireRole('teacher')];
const studentGuard = [...base, requireRole('student')];

// School-wide analytics: admins always, plus principals (checked against the
// live profile on every request, so revoking the designation takes effect at once).
const analyticsGuard = [
    ...base,
    async (req, res, next) => {
        try {
            if (req.userRole === 'school_admin') return next();
            if (req.userRole === 'teacher' && await fb.isPrincipal(req.userId)) {
                req.isPrincipal = true;
                return next();
            }
            return res.status(403).json({ success: false, message: 'Insufficient permissions' });
        } catch (e) { next(e); }
    },
];

// Submissions are cheap but write-heavy and student-triggered; a per-user bucket
// blunts a scripted replay without touching the generous global API limiter.
const submitLimiter = rateLimit({
    prefix: 'feedback-submit',
    windowSec: Number(process.env.RL_FEEDBACK_WINDOW) || 60,
    max:       Number(process.env.RL_FEEDBACK_MAX)    || 30,
    keyFn:     (req) => String(req.userId || ''),
});

// ══ STUDENT ══════════════════════════════════════════════════════════════════
router.get ('/student/summary',                studentGuard, student.getSummary);
router.get ('/student/pending',                studentGuard, student.getPending);
router.get ('/student/completed',              studentGuard, student.getCompleted);
router.get ('/student/assignments/:id',        studentGuard, student.getForm);
router.get ('/student/assignments/:id/submission', studentGuard, student.getSubmission);
router.post('/student/assignments/:id/submit', studentGuard, submitLimiter, student.submit);

// ══ TEACHER (own results) ════════════════════════════════════════════════════
router.get('/teacher/dashboard', teacherGuard, teacher.getDashboard);
router.get('/teacher/trends',    teacherGuard, teacher.getTrends);
router.get('/teacher/breakdown', teacherGuard, teacher.getBreakdown);

// ══ ADMIN + PRINCIPAL (read-only analytics) ══════════════════════════════════
router.get('/dashboard',                analyticsGuard, admin.getDashboard);
router.get('/teachers/:id',             analyticsGuard, admin.getTeacherAnalytics);
router.get('/campaigns/:id/analytics',  analyticsGuard, admin.getCampaignAnalytics);
router.get('/reports',                  analyticsGuard, admin.getReport);
router.get('/meta',                     analyticsGuard, admin.getMeta);

// ══ ADMIN (configuration & management) ═══════════════════════════════════════
// Campaigns
router.get   ('/campaigns',                    adminGuard, admin.getCampaigns);
router.post  ('/campaigns',                    adminGuard, admin.createCampaign);
router.get   ('/campaigns/:id',                adminGuard, admin.getCampaign);
router.put   ('/campaigns/:id',                adminGuard, admin.updateCampaign);
router.delete('/campaigns/:id',                adminGuard, admin.deleteCampaign);
router.post  ('/campaigns/:id/activate',       adminGuard, admin.activateCampaign);
router.post  ('/campaigns/:id/close',          adminGuard, admin.closeCampaign);
router.post  ('/campaigns/:id/archive',        adminGuard, admin.archiveCampaign);
router.post  ('/campaigns/:id/duplicate',      adminGuard, admin.duplicateCampaign);
router.post  ('/campaigns/:id/sync',           adminGuard, admin.syncAssignments);
router.post  ('/campaigns/:id/reminders',      adminGuard, admin.sendReminders);
router.get   ('/campaigns/:id/assignments',    adminGuard, admin.getCampaignAssignments);
router.post  ('/assignments/:assignmentId/reopen', adminGuard, admin.reopenAssignment);

// Question bank
router.get   ('/questions',     adminGuard, admin.getQuestions);
router.post  ('/questions',     adminGuard, admin.createQuestion);
router.put   ('/questions/:id', adminGuard, admin.updateQuestion);
router.delete('/questions/:id', adminGuard, admin.deleteQuestion);

// Categories
router.get   ('/categories',     adminGuard, admin.getCategories);
router.post  ('/categories',     adminGuard, admin.createCategory);
router.put   ('/categories/:id', adminGuard, admin.updateCategory);
router.delete('/categories/:id', adminGuard, admin.deleteCategory);

// Templates
router.get   ('/templates',     adminGuard, admin.getTemplates);
router.post  ('/templates',     adminGuard, admin.createTemplate);
router.put   ('/templates/:id', adminGuard, admin.updateTemplate);
router.delete('/templates/:id', adminGuard, admin.deleteTemplate);

// Settings & bootstrap
router.get ('/settings',      adminGuard, admin.getSettings);
router.put ('/settings',      adminGuard, admin.updateSettings);
router.post('/settings/seed', adminGuard, admin.seedDefaults);

// Audit
router.get('/audit', adminGuard, admin.getAuditLog);

module.exports = router;
