'use strict';
const express        = require('express');
const router         = express.Router();
const teacherCtrl    = require('../../controllers/teacher.controller');
const sectionCtrl    = require('../../controllers/section.controller');
const attendanceCtrl = require('../../controllers/attendance.controller');
const timetableCtrl  = require('../../controllers/timetable.controller');
const substituteCtrl = require('../../controllers/substitute.controller');
const notifCtrl      = require('../../controllers/notification.controller');
const examCtrl       = require('../../controllers/aptitudeExam.controller');
const formalExamCtrl = require('../../controllers/formalExam.controller');
const classTestCtrl  = require('../../controllers/classTest.controller');
const leaveCtrl      = require('../../controllers/leave.controller');
const compOffCtrl    = require('../../controllers/compOff.controller');
const docCtrl        = require('../../controllers/document.controller');
const holidayCtrl    = require('../../controllers/holiday.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const { modulesHandler } = require('../../utils/moduleResponse');
const requireModule  = require('../../middleware/requireModule');
const { uploadExcel, uploadDocument, uploadLeaveDoc } = require('../../middleware/upload');

const guard            = [verifyToken, requirePasswordReset, requireRole('teacher')];
const attendanceGuard  = [...guard, requireModule('attendance')];
const timetableGuard   = [...guard, requireModule('timetable')];
const notifGuard       = [...guard, requireModule('notification')];
const examGuard        = [...guard, requireModule('aptitudeExam')];
const resultGuard      = [...guard, requireModule('result')];
const leaveGuard       = [...guard, requireModule('leave')];
const docGuard         = [...guard, requireModule('document')];
const holidayGuard     = [...guard, requireModule('holiday')];

// Dashboard
router.get('/dashboard', guard, teacherCtrl.getDashboard);

// Enabled modules for this school (used by frontend to show/hide nav items)
router.get('/modules', guard, modulesHandler);

// ── My Section ────────────────────────────────────────────────────────────────
router.get('/my-section',              guard, sectionCtrl.getMySection);
router.get('/sections',                guard, sectionCtrl.getMySections);
router.get('/sections/:sectionId',     guard, sectionCtrl.getTeacherSectionDetail);
router.post('/announcements',          guard, sectionCtrl.createAnnouncement);
router.delete('/announcements/:id',    guard, sectionCtrl.deleteAnnouncement);
router.post('/monitors/assign',        guard, sectionCtrl.assignMonitor);
router.delete('/monitors/:id',         guard, sectionCtrl.removeMonitor);

// ── Student Attendance ────────────────────────────────────────────────────────
router.get('/attendance',              attendanceGuard, sectionCtrl.getAttendance);
router.post('/attendance/mark',        attendanceGuard, sectionCtrl.markAttendance);

// ── Teacher Self Attendance ───────────────────────────────────────────────────
router.get('/my-attendance',           attendanceGuard, attendanceCtrl.getTeacherSelfAttendance);
router.get('/attendance-ranking',      attendanceGuard, attendanceCtrl.getSectionRanking);
router.post('/my-attendance/clock-in',  attendanceGuard, attendanceCtrl.clockIn);
router.post('/my-attendance/clock-out', attendanceGuard, attendanceCtrl.clockOut);

// ── Regularization ────────────────────────────────────────────────────────────
router.get('/regularization',          attendanceGuard, attendanceCtrl.getRegularizationForm);
router.post('/regularization',         attendanceGuard, attendanceCtrl.submitRegularization);

// ── Attendance Dashboard ──────────────────────────────────────────────────────
router.get('/attendance-dashboard',    attendanceGuard, attendanceCtrl.getAttendanceDashboard);
router.get('/students/:studentId/attendance', attendanceGuard, attendanceCtrl.getStudentProfile);

// ── Correction Requests ───────────────────────────────────────────────────────
router.get('/correction-requests',     attendanceGuard, attendanceCtrl.getCorrectionRequests);
router.post('/correction-requests/review', attendanceGuard, attendanceCtrl.reviewCorrection);

// ── Timetable ─────────────────────────────────────────────────────────────────
router.get('/timetable',              timetableGuard, timetableCtrl.teacherViewTimetable);
router.get('/timetable/download',     timetableGuard, timetableCtrl.teacherDownloadTimetable);
router.get('/timetable/my-class',     timetableGuard, timetableCtrl.teacherClassTimetable);

// Substitute duties I have been given, and my own periods someone else covers.
router.get('/substitutions',          timetableGuard, substituteCtrl.teacherMySubstitutions);

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications',        notifGuard, notifCtrl.getList);
router.post('/notifications/send',  notifGuard, notifCtrl.send);

// ── Aptitude Exams ────────────────────────────────────────────────────────────
router.get('/exams',                           examGuard, examCtrl.getTeacherExams);
router.get('/exams/meta',                      examGuard, examCtrl.getExamMeta);
router.post('/exams',                          examGuard, examCtrl.createExam);
router.get('/exams/:id',                       examGuard, examCtrl.getExamDetail);
router.put('/exams/:id',                       examGuard, examCtrl.updateExam);
router.delete('/exams/:id',                    examGuard, examCtrl.deleteExam);
router.post('/exams/:id/publish',              examGuard, examCtrl.publishExam);
router.get('/exams/:id/questions',             examGuard, examCtrl.getQuestions);
router.post('/exams/:id/questions',            examGuard, examCtrl.addQuestion);
router.put('/exams/:id/questions/:qid',        examGuard, examCtrl.updateQuestion);
router.delete('/exams/:id/questions/:qid',     examGuard, examCtrl.deleteQuestion);
router.get('/exams/:id/submissions',           examGuard, examCtrl.getSubmissions);
router.get('/exams/:id/submissions/:studentId',examGuard, examCtrl.getStudentResponse);
router.get('/exams/:id/analytics',             examGuard, examCtrl.getAnalytics);
router.get('/exams/:id/result-approval',            examGuard, examCtrl.getResultApproval);
router.post('/exams/:id/subject-approve',           examGuard, examCtrl.subjectApproveResults);
router.post('/exams/:id/result-approval',           examGuard, examCtrl.approveResults);

// ── Leave ─────────────────────────────────────────────────────────────────────
router.get('/leave',           leaveGuard, leaveCtrl.teacherGetMyLeaves);
router.get('/leave/balance',   leaveGuard, leaveCtrl.teacherGetLeaveBalance);
// The rules behind each leave type, and whether this employee qualifies
router.get('/leave/policies',  leaveGuard, leaveCtrl.teacherGetPolicies);
// Live balance + working-day count for my own application
router.get('/leave/apply-preview', leaveGuard, leaveCtrl.teacherApplyPreview);
// Designation-based approvers are teachers — this is their sign-off queue
router.get('/leave/approvals',              leaveGuard, leaveCtrl.teacherGetApprovals);
router.post('/leave/approvals/:id/approve', leaveGuard, leaveCtrl.adminApproveRequest);
router.post('/leave/approvals/:id/reject',  leaveGuard, leaveCtrl.adminRejectRequest);
router.post('/leave/apply',    leaveGuard, uploadLeaveDoc.single('document'), leaveCtrl.teacherApplyLeave);

// Comp Off — registered before '/leave/:id' so the delete route below cannot
// capture '/leave/compoff/...'.
router.get('/leave/compoff',              leaveGuard, compOffCtrl.myCompOff);
router.get('/leave/compoff/preview',      leaveGuard, compOffCtrl.previewWorkDate);
router.get('/leave/compoff/ledger',       leaveGuard, compOffCtrl.myLedger);
// Designation-based approvers (e.g. Principal) are teachers, so their queue and
// their approve/reject actions live on the teacher router. Both endpoints
// re-check canApprove() against the policy before doing anything.
router.get('/leave/compoff/approvals',    leaveGuard, compOffCtrl.listRequests);
router.post('/leave/compoff',             leaveGuard, uploadLeaveDoc.single('document'), compOffCtrl.applyCompOff);
router.post('/leave/compoff/:id/apply',   leaveGuard, compOffCtrl.submitDraft);
router.post('/leave/compoff/:id/approve', leaveGuard, compOffCtrl.approve);
router.post('/leave/compoff/:id/reject',  leaveGuard, compOffCtrl.reject);
router.delete('/leave/compoff/:id',       leaveGuard, compOffCtrl.cancelOwn);

router.delete('/leave/:id',    leaveGuard, leaveCtrl.teacherCancelLeave);

// ── Document Categories (read-only for teachers) ──────────────────────────────
const DocumentCategory = require('../../models/DocumentCategory');
router.get('/document-categories', docGuard, async (req, res) => {
    try {
        const cats = await DocumentCategory.find({ school: req.schoolId, isActive: true }).sort({ name: 1 }).lean();
        res.json({ success: true, data: cats });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Documents ─────────────────────────────────────────────────────────────────
router.get('/documents',                             docGuard, docCtrl.teacherGetDocuments);
router.post('/documents',                            docGuard, uploadDocument.array('files', 10), docCtrl.teacherUpload);
router.get('/documents/:id',                         docGuard, docCtrl.teacherGetDocument);
router.put('/documents/:id',                         docGuard, uploadDocument.array('files', 10), docCtrl.teacherEditDocument);
router.delete('/documents/:id',                      docGuard, docCtrl.teacherDeleteDocument);
router.get('/documents/:id/submissions',             docGuard, docCtrl.teacherGetSubmissions);
router.post('/documents/submissions/:submissionId/review', docGuard, docCtrl.teacherReviewSubmission);

// ── Holidays ──────────────────────────────────────────────────────────────────
router.get('/holidays',        holidayGuard, holidayCtrl.teacherGetHolidays);
router.get('/class-holidays',  holidayGuard, holidayCtrl.teacherGetClassHolidays);

// ── Results: Formal Exam (marks entry) ───────────────────────────────────────
router.get('/results/marks-entry',                           resultGuard, formalExamCtrl.teacherGetMarksEntry);
router.get('/results/marks-entry/:examId/:subjectId',        resultGuard, formalExamCtrl.teacherGetMarksForm);
router.post('/results/marks-entry/:examId/:subjectId/save',  resultGuard, formalExamCtrl.teacherSaveMarks);

// ── Results: Formal Exam (class teacher validation) ───────────────────────────
router.get('/results/validation',              resultGuard, formalExamCtrl.teacherGetValidation);
router.get('/results/validation/:examId',      resultGuard, formalExamCtrl.teacherGetValidationDetail);
router.post('/results/validation/:examId/approve', resultGuard, formalExamCtrl.teacherApproveExam);
router.post('/results/validation/:examId/reject',  resultGuard, formalExamCtrl.teacherRejectExam);

// ── Results: Class Tests ──────────────────────────────────────────────────────
router.get('/results/class-tests',                       resultGuard, classTestCtrl.teacherGetClassTests);
router.post('/results/class-tests',                      resultGuard, classTestCtrl.teacherCreateClassTest);
router.get('/results/class-tests/:id/marks',             resultGuard, classTestCtrl.teacherGetTestMarks);
router.post('/results/class-tests/:id/marks/save',       resultGuard, classTestCtrl.teacherSaveTestMarks);
router.post('/results/class-tests/:id/reopen',           resultGuard, classTestCtrl.teacherReopenTest);
router.get('/results/class-test-validation',             resultGuard, classTestCtrl.teacherGetClassTestValidation);
router.get('/results/class-test-validation/:id',         resultGuard, classTestCtrl.teacherGetClassTestValidationDetail);
router.post('/results/class-test-validation/:id/approve', resultGuard, classTestCtrl.teacherApproveClassTest);
router.post('/results/class-test-validation/:id/reject',  resultGuard, classTestCtrl.teacherRejectClassTest);

module.exports = router;
