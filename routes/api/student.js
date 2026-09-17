'use strict';
const express        = require('express');
const router         = express.Router();
const studentCtrl    = require('../../controllers/student.controller');
const attendanceCtrl = require('../../controllers/attendance.controller');
const timetableCtrl  = require('../../controllers/timetable.controller');
const examCtrl       = require('../../controllers/aptitudeExam.controller');
const docCtrl        = require('../../controllers/document.controller');
const docViewer      = require('../../controllers/documentViewer.controller');
const holidayCtrl    = require('../../controllers/holiday.controller');
const formalExamCtrl = require('../../controllers/formalExam.controller');
const classTestCtrl  = require('../../controllers/classTest.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const { modulesHandler } = require('../../utils/moduleResponse');
const requireModule  = require('../../middleware/requireModule');
const { uploadDocument, uploadAttendanceDoc } = require('../../middleware/upload');

// Up to three files on a correction request or reply. multer's own errors are
// answers to the student ("too big"), not server faults.
const correctionFiles = (req, res, next) => uploadAttendanceDoc.array('attachments', 3)(req, res, (e) => {
    if (!e) return next();
    const message = e.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 5 MB or smaller'
        : (e.code === 'LIMIT_FILE_COUNT' || e.code === 'LIMIT_UNEXPECTED_FILE') ? 'Attach at most 3 files'
        : e.message;
    res.status(400).json({ success: false, message });
});

const guard            = [verifyToken, requirePasswordReset, requireRole('student')];
const attendanceGuard  = [...guard, requireModule('attendance')];
const timetableGuard   = [...guard, requireModule('timetable')];
const examGuard        = [...guard, requireModule('aptitudeExam')];
const docGuard         = [...guard, requireModule('document')];
const holidayGuard     = [...guard, requireModule('holiday')];
const resultGuard      = [...guard, requireModule('result')];

router.get('/dashboard', guard, studentCtrl.getDashboard);
router.get('/my-class',  guard, studentCtrl.getMyClass);

// Enabled modules for this school
router.get('/modules', guard, modulesHandler);

// Timetable
router.get('/timetable',          timetableGuard, timetableCtrl.studentViewTimetable);
router.get('/timetable/download', timetableGuard, timetableCtrl.studentDownloadTimetable);

// Attendance
router.get('/my-attendance',       attendanceGuard, attendanceCtrl.getStudentAttendanceCalendar);
router.get('/attendance-ranking',  attendanceGuard, attendanceCtrl.getMyClassRanking);
router.get('/attendance/day',      attendanceGuard, attendanceCtrl.getStudentAttendanceDay);
router.get('/attendance/overview', attendanceGuard, attendanceCtrl.getStudentAttendanceOverview);
router.get('/correction',          attendanceGuard, attendanceCtrl.getStudentCorrectionForm);
router.post('/correction/submit',  attendanceGuard, correctionFiles, attendanceCtrl.submitStudentCorrection);
router.post('/correction/:id/reply', attendanceGuard, correctionFiles, attendanceCtrl.replyStudentCorrection);

// Aptitude Exams
router.get('/exams',                     examGuard, examCtrl.getStudentExams);
router.get('/exams/:id/attempt',         examGuard, examCtrl.getAttemptExam);
router.post('/exams/:id/save-answer',    examGuard, examCtrl.saveAnswer);
router.post('/exams/:id/violation',      examGuard, examCtrl.logViolation);
router.post('/exams/:id/submit',         examGuard, examCtrl.submitExam);
router.get('/exams/:id/result',          examGuard, examCtrl.getStudentResult);

// Documents
router.get('/documents',              docGuard, docViewer.studentGetDocuments);
router.get('/documents/:id',          docGuard, docCtrl.studentGetDocument);
router.post('/documents/:id/submit',  docGuard, uploadDocument.array('files', 5), docCtrl.studentSubmitAssignment);

// Holidays
router.get('/holidays', holidayGuard, holidayCtrl.studentGetHolidays);

// Results
router.get('/results',              resultGuard, formalExamCtrl.studentGetResults);
router.get('/results/class-tests',  resultGuard, classTestCtrl.studentGetClassTests);
router.get('/results/:resultId',    resultGuard, formalExamCtrl.studentGetResultDetail);

module.exports = router;
