'use strict';
const express       = require('express');
const router        = express.Router();
const adminCtrl     = require('../../controllers/admin.controller');
const classCtrl     = require('../../controllers/class.controller');
const subjectCtrl   = require('../../controllers/subject.controller');
const reportCtrl    = require('../../controllers/report.controller');
const attendanceCtrl = require('../../controllers/attendance.controller');
const timetableCtrl  = require('../../controllers/timetable.controller');
const ttGenCtrl      = require('../../controllers/timetableGen.controller');
const notifCtrl      = require('../../controllers/notification.controller');
const examCtrl       = require('../../controllers/aptitudeExam.controller');
const formalExamCtrl = require('../../controllers/formalExam.controller');
const leaveCtrl      = require('../../controllers/leave.controller');
const compOffCtrl    = require('../../controllers/compOff.controller');
const docCtrl        = require('../../controllers/document.controller');
const holidayCtrl    = require('../../controllers/holiday.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule  = require('../../middleware/requireModule');
const { uploadExcel, uploadDocument, uploadCsv, uploadLeaveDoc, uploadImage, uploadStaffDoc, uploadStudentDoc } = require('../../middleware/upload');
const School         = require('../../models/School');

const guard            = [verifyToken, requirePasswordReset, requireRole('school_admin')];
const attendanceGuard  = [...guard, requireModule('attendance')];
const timetableGuard   = [...guard, requireModule('timetable')];
const notifGuard       = [...guard, requireModule('notification')];
const examGuard        = [...guard, requireModule('aptitudeExam')];
const resultGuard      = [...guard, requireModule('result')];
const leaveGuard       = [...guard, requireModule('leave')];
const docGuard         = [...guard, requireModule('document')];
const holidayGuard     = [...guard, requireModule('holiday')];

// Dashboard
router.get('/dashboard', guard, adminCtrl.getDashboard);

// School Settings
router.get('/designations', guard, adminCtrl.getDesignations);
router.put('/designations', guard, adminCtrl.updateDesignations);
router.get('/school-settings', guard, adminCtrl.getSchoolSettings);
router.put('/school-settings', guard, uploadImage.single('logo'), adminCtrl.updateSchoolSettings);
router.get('/smtp-settings',  guard, adminCtrl.getSmtpSettings);
router.put('/smtp-settings',  guard, adminCtrl.updateSmtpSettings);
router.post('/smtp-settings/test', guard, adminCtrl.testSmtp);

// Modules — returns enabled module flags for the current school
router.get('/modules', guard, async (req, res) => {
    try {
        const school = await School.findById(req.schoolId).select('modules leaveSettings').lean();
        const m  = school?.modules      ?? {};
        const ls = school?.leaveSettings ?? {};
        res.json({ success: true, data: {
            attendance:   !!m.attendance,
            notification: !!m.notification,
            aptitudeExam: !!m.aptitudeExam,
            result:       !!m.result,
            timetable:    !!m.timetable,
            holiday:      !!m.holiday,
            leave:        !!m.leave,
            document:     !!m.document,
            library:      !!m.library,
            payroll:      !!m.payroll,
            fees:         !!m.fees,
            chat:         !!m.chat,
            inventory:    !!m.inventory,
            transport:    !!m.transport,
            videoLibrary: !!m.videoLibrary,
            feedback:     !!m.feedback,
            saturdayConfig: {
                working: ls.saturdayWorking !== false,
                mode:    ls.saturdayMode    || 'all',
                halfDay: !!ls.saturdayHalfDay,
            },
        }});
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── Users ──────────────────────────────────────────────────────────────────────
router.get('/users/check-email',    guard, adminCtrl.checkEmail);
router.delete('/users/bulk-delete', guard, adminCtrl.bulkDeleteUsers);
router.get('/users/:id',            guard, adminCtrl.getUser);
router.put('/users/:id',            guard, adminCtrl.updateUser);
router.patch('/users/:id/toggle',   guard, adminCtrl.toggleUser);

// Teachers
router.get('/teachers',                     guard, adminCtrl.getTeachers);
router.post('/teachers',                    guard, uploadStaffDoc.fields([
    { name: 'aadhaarFront', maxCount: 1 }, { name: 'aadhaarBack', maxCount: 1 },
    { name: 'panCard', maxCount: 1 }, { name: 'experienceCertificate', maxCount: 1 },
    { name: 'resignationLetter', maxCount: 1 }, { name: 'joiningLetter', maxCount: 1 },
]), adminCtrl.createTeacher);
router.post('/teachers/bulk',               guard, uploadExcel.single('excelFile'), adminCtrl.bulkTeachers);
router.get('/teachers/template',            guard, adminCtrl.downloadTeacherTemplate);
router.delete('/teachers/:id',              guard, adminCtrl.deleteUser);
router.get('/teachers/:id',                 guard, adminCtrl.getTeacherDetail);

// Students
// Admission paperwork is posted as multipart; multer passes plain JSON bodies
// straight through, so the mobile app's older JSON payload still works.
const studentDocFields = uploadStudentDoc.fields(adminCtrl.STUDENT_DOC_FIELDS.map(name => ({ name, maxCount: 1 })));
router.get('/students',                     guard, adminCtrl.getStudents);
router.post('/students',                    guard, studentDocFields, adminCtrl.createStudent);
router.put('/students/:id',                 guard, studentDocFields, adminCtrl.updateStudentFull);
router.post('/students/bulk',               guard, uploadExcel.single('excelFile'), adminCtrl.bulkStudents);
router.get('/students/template',            guard, adminCtrl.downloadStudentTemplate);
router.get('/students/parent-lookup',       guard, adminCtrl.parentLookup);
// Address helpers for the student form
router.get('/states',            guard, adminCtrl.getStates);
router.get('/admission-number/preview', guard, adminCtrl.previewAdmissionNumber);
router.get('/employee-id/preview',      guard, adminCtrl.previewEmployeeId);
router.get('/pincode/:pincode',  guard, adminCtrl.pincodeLookup);
router.delete('/students/:id',              guard, adminCtrl.deleteUser);
router.get('/students/:id',                 guard, adminCtrl.getStudentDetail);

// Admins
router.get('/admins',                       guard, adminCtrl.getAdmins);
router.post('/admins',                      guard, adminCtrl.createAdmin);
router.delete('/admins/:id',                guard, adminCtrl.deleteUser);

// All classes with sections in one call (for student form dropdowns) — active academic year only
router.get('/classes-with-sections', guard, async (req, res) => {
    try {
        const AcademicYear = require('../../models/AcademicYear');
        const Class        = require('../../models/Class');
        const ClassSection = require('../../models/ClassSection');
        const activeYear   = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        const classFilter  = { school: req.schoolId };
        const secFilter    = { school: req.schoolId };
        if (activeYear) {
            classFilter.academicYear = activeYear._id;
            secFilter.academicYear   = activeYear._id;
            secFilter.status         = 'active';
        }
        // Alphabetical (digit-aware) so dropdowns match the Classes page order
        const byName = (key) => (a, b) =>
            String(a[key] || '').localeCompare(String(b[key] || ''), 'en', { numeric: true, sensitivity: 'base' });
        const classes  = (await Class.find(classFilter).lean()).sort(byName('className'));
        const sections = await ClassSection.find(secFilter).lean();
        const secMap   = {};
        sections.forEach(s => { const k = s.class.toString(); (secMap[k] = secMap[k] || []).push(s); });
        Object.values(secMap).forEach(list => list.sort(byName('sectionName')));
        res.json({ success: true, data: classes.map(c => ({ ...c, sections: secMap[c._id.toString()] || [] })) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Academic Years ──────────────────────────────────────────────────────────
router.get('/academic-years',                  guard, classCtrl.getAcademicYears);
router.post('/academic-years',                 guard, classCtrl.createAcademicYear);
router.put('/academic-years/:id',              guard, classCtrl.updateAcademicYear);
router.delete('/academic-years/:id',           guard, classCtrl.deleteAcademicYear);
router.patch('/academic-years/:id/set-active', guard, classCtrl.setActiveAcademicYear);

// ── Classes ─────────────────────────────────────────────────────────────────
router.get('/classes',                        guard, classCtrl.getClasses);
router.post('/classes',                       guard, classCtrl.createClass);
router.get('/classes/:classId',               guard, classCtrl.getClassDetail);
router.put('/classes/:classId',               guard, classCtrl.updateClass);
router.delete('/classes/:classId',            guard, classCtrl.deleteClass);
router.post('/classes/auto-assign',           guard, classCtrl.autoAssignStudents);
router.post('/classes/:classId/sections',     guard, classCtrl.createSection);
// Section shuffle — one random redistribution per class/year, then lockable
router.post('/classes/:classId/shuffle-sections', guard, classCtrl.shuffleSections);
router.post('/classes/:classId/lock-sections',    guard, classCtrl.lockSectionShuffle);
router.get('/classes/:classId/subjects',      guard, subjectCtrl.getClassSubjects);
router.post('/classes/:classId/subjects/assign', guard, subjectCtrl.assignSubjectToClass);
router.delete('/classes/:classId/subjects',   guard, subjectCtrl.removeSubjectFromClass);

// ── Sections ────────────────────────────────────────────────────────────────
router.get('/sections/:sectionId',                    guard, classCtrl.getSectionDetail);
router.post('/sections/:sectionId/assign-student',    guard, classCtrl.assignStudentToSection);
router.delete('/sections/:sectionId/remove-student',  guard, classCtrl.removeStudentFromSection);
router.put('/sections/:sectionId/teachers',           guard, classCtrl.updateSectionTeacher);
router.put('/sections/:sectionId/capacity',           guard, classCtrl.updateSectionCapacity);
// Roll numbers — one-time bulk assignment + manual corrections
router.post('/sections/:sectionId/assign-roll-numbers',            guard, classCtrl.assignRollNumbers);
router.put('/sections/:sectionId/students/:studentId/roll-number', guard, classCtrl.updateStudentRollNumber);
router.delete('/sections/:sectionId',                 guard, classCtrl.deleteSection);
router.get('/sections/:sectionId/subjects',           guard, subjectCtrl.getSectionSubjectTeachers);
router.post('/sections/:sectionId/subjects/assign',   guard, subjectCtrl.assignSubjectTeacher);
router.delete('/sections/:sectionId/subjects/:subjectId',                    guard, subjectCtrl.removeSectionSubject);
router.delete('/sections/:sectionId/subjects/:subjectId/teachers/:teacherId', guard, subjectCtrl.removeSectionSubjectTeacher);
router.get('/sections/:sectionId/teacher-options', guard, classCtrl.getSectionTeacherOptions);
// Section teacher group chat (class teacher + vice class teacher + subject teachers)
router.get('/sections/:sectionId/chat-group',  guard, classCtrl.getSectionChatGroup);
router.post('/sections/:sectionId/chat-group', guard, classCtrl.syncSectionChatGroup);

// Timetable (section-scoped)
router.get('/sections/:sectionId/timetable',           timetableGuard, timetableCtrl.adminManageTimetable);
router.put('/sections/:sectionId/timetable/structure', timetableGuard, timetableCtrl.adminSaveTimetableStructure);
router.get('/sections/:sectionId/timetable/entries',   timetableGuard, timetableCtrl.adminAssignPeriods);
router.put('/sections/:sectionId/timetable/entries',   timetableGuard, timetableCtrl.adminSaveEntries);
router.get('/sections/:sectionId/timetable/download',  timetableGuard, timetableCtrl.adminDownloadSectionTimetable);

// ── Subjects ────────────────────────────────────────────────────────────────
router.get('/subjects',          guard, subjectCtrl.getSubjects);
router.post('/subjects',         guard, subjectCtrl.createSubject);
router.put('/subjects/:id',      guard, subjectCtrl.updateSubject);
router.delete('/subjects/:id',   guard, subjectCtrl.deleteSubject);

// Timetable
router.get('/timetable/download-all', timetableGuard, timetableCtrl.adminDownloadAllTimetables);
router.get('/timetable/teachers',     timetableGuard, timetableCtrl.getTeachersBySubject);

// ── Timetable generation, versioning & publishing ────────────────────────────
// Static segments are declared before '/timetable/versions/:id' so a literal
// path like '/timetable/versions' is never captured as an id.
router.get('/timetable/meta',            timetableGuard, ttGenCtrl.getMeta);
router.get('/timetable/config',          timetableGuard, ttGenCtrl.getConfig);
router.put('/timetable/config',          timetableGuard, ttGenCtrl.saveConfig);

router.get('/timetable/rooms',           timetableGuard, ttGenCtrl.listRooms);
router.post('/timetable/rooms',          timetableGuard, ttGenCtrl.createRoom);
router.put('/timetable/rooms/:id',       timetableGuard, ttGenCtrl.updateRoom);
router.delete('/timetable/rooms/:id',    timetableGuard, ttGenCtrl.deleteRoom);

router.get('/timetable/availability',              timetableGuard, ttGenCtrl.listAvailability);
router.put('/timetable/availability/:teacherId',   timetableGuard, ttGenCtrl.saveAvailability);

router.get('/timetable/requirements',                    timetableGuard, ttGenCtrl.listRequirements);
router.put('/timetable/requirements/:sectionId',         timetableGuard, ttGenCtrl.saveRequirements);
router.post('/timetable/requirements/seed',              timetableGuard, ttGenCtrl.seedRequirements);
router.delete('/timetable/requirements/item/:id',        timetableGuard, ttGenCtrl.deleteRequirement);

router.post('/timetable/generate',       timetableGuard, ttGenCtrl.generate);
router.get('/timetable/versions',        timetableGuard, ttGenCtrl.listVersions);
router.get('/timetable/audit',           timetableGuard, ttGenCtrl.listAudit);

router.get('/timetable/versions/:id',                     timetableGuard, ttGenCtrl.getVersion);
router.put('/timetable/versions/:id',                     timetableGuard, ttGenCtrl.updateVersion);
router.delete('/timetable/versions/:id',                  timetableGuard, ttGenCtrl.deleteVersion);
router.get('/timetable/versions/:id/progress',            timetableGuard, ttGenCtrl.getProgress);
router.get('/timetable/versions/:id/conflicts',           timetableGuard, ttGenCtrl.getConflicts);
router.get('/timetable/versions/:id/export',              timetableGuard, ttGenCtrl.exportVersion);
router.get('/timetable/versions/:id/compare/:otherId',    timetableGuard, ttGenCtrl.compareVersions);
router.post('/timetable/versions/:id/validate',           timetableGuard, ttGenCtrl.validateVersion);
router.post('/timetable/versions/:id/publish',            timetableGuard, ttGenCtrl.publishVersion);
router.post('/timetable/versions/:id/regenerate',         timetableGuard, ttGenCtrl.regenerate);
router.post('/timetable/versions/:id/duplicate',          timetableGuard, ttGenCtrl.duplicateVersion);
router.post('/timetable/versions/:id/restore',            timetableGuard, ttGenCtrl.restoreVersion);
router.post('/timetable/versions/:id/archive',            timetableGuard, ttGenCtrl.archiveVersion);
router.post('/timetable/versions/:id/release-lock',       timetableGuard, ttGenCtrl.releaseLock);
router.post('/timetable/versions/:id/entries',            timetableGuard, ttGenCtrl.createEntry);
router.post('/timetable/versions/:id/entries/:entryId/move', timetableGuard, ttGenCtrl.moveEntry);
router.put('/timetable/versions/:id/entries/:entryId',    timetableGuard, ttGenCtrl.updateEntry);
router.delete('/timetable/versions/:id/entries/:entryId', timetableGuard, ttGenCtrl.deleteEntry);

// ── Reports ──────────────────────────────────────────────────────────────────
router.get('/reports', guard, reportCtrl.getReports);

// ── Attendance ───────────────────────────────────────────────────────────────
router.get('/regularization-requests',         attendanceGuard, attendanceCtrl.getAdminRegularizationRequests);
router.post('/regularization-requests/review', attendanceGuard, attendanceCtrl.adminReviewRegularization);

// Admin self-attendance (same store as teacher self-attendance)
router.get('/my-attendance',            attendanceGuard, attendanceCtrl.getTeacherSelfAttendance);
router.post('/my-attendance/clock-in',  attendanceGuard, attendanceCtrl.clockIn);
router.post('/my-attendance/clock-out', attendanceGuard, attendanceCtrl.clockOut);
router.get('/regularization',           attendanceGuard, attendanceCtrl.getRegularizationForm);
router.post('/regularization',          attendanceGuard, attendanceCtrl.submitRegularization);
router.post('/regularization/apply',    attendanceGuard, attendanceCtrl.adminRegularizeAttendance);
router.get('/regularization/people',    attendanceGuard, attendanceCtrl.adminSearchPeople);
router.post('/regularization/student',  attendanceGuard, attendanceCtrl.adminRegularizeStudent);

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications',        notifGuard, notifCtrl.getList);
router.post('/notifications/send',  notifGuard, notifCtrl.send);

// ── Aptitude Exams ────────────────────────────────────────────────────────────
router.get('/exams', examGuard, examCtrl.getAdminExams);

// ── Results / Formal Exams ────────────────────────────────────────────────────
router.get('/results/exams',                          resultGuard, formalExamCtrl.adminGetExams);
router.post('/results/exams',                         resultGuard, formalExamCtrl.adminCreateExam);
router.get('/results/exams/:id',                      resultGuard, formalExamCtrl.adminGetExamDetail);
router.put('/results/exams/:id',                      resultGuard, formalExamCtrl.adminUpdateExam);
router.delete('/results/exams/:id',                   resultGuard, formalExamCtrl.adminDeleteExam);
router.get('/results/exams/:id/marks-review',         resultGuard, formalExamCtrl.adminGetMarksReview);
router.post('/results/exams/:id/approve',             resultGuard, formalExamCtrl.adminApproveExam);
router.post('/results/exams/:id/reject',              resultGuard, formalExamCtrl.adminRejectExam);
router.post('/results/exams/:id/reopen',              resultGuard, formalExamCtrl.adminReopenExam);
router.put('/results/exams/:id/marks/:subjectId',     resultGuard, formalExamCtrl.adminEditMarks);
router.get('/results/exams/:id/result',               resultGuard, formalExamCtrl.adminGetResult);
router.get('/results/sections/:sectionId/subjects',   resultGuard, formalExamCtrl.adminGetSectionSubjects);

// ── Leave ─────────────────────────────────────────────────────────────────────
router.get('/leave/types',                         leaveGuard, leaveCtrl.adminGetLeaveTypes);
router.post('/leave/types',                        leaveGuard, leaveCtrl.adminCreateLeaveType);
router.put('/leave/types/:id',                     leaveGuard, leaveCtrl.adminUpdateLeaveType);
router.delete('/leave/types/:id',                  leaveGuard, leaveCtrl.adminDeleteLeaveType);
router.put('/leave/settings',                      leaveGuard, leaveCtrl.adminUpdateLeaveSettings);
// Per-leave-type policies — every type gets its own configurable rule set
router.get('/leave/policies',                      leaveGuard, leaveCtrl.adminGetPolicies);
router.get('/leave/policies/:leaveTypeId',         leaveGuard, leaveCtrl.adminGetPolicy);
router.put('/leave/policies/:leaveTypeId',         leaveGuard, leaveCtrl.adminUpdatePolicy);
router.get('/leave/requests',                      leaveGuard, leaveCtrl.adminGetRequests);
router.post('/leave/requests',                     leaveGuard, uploadLeaveDoc.single('document'), leaveCtrl.adminApplyLeave);
router.get('/leave/balance',                       leaveGuard, leaveCtrl.adminGetTeacherBalance);
router.post('/leave/requests/:id/approve',         leaveGuard, leaveCtrl.adminApproveRequest);
router.post('/leave/requests/:id/reject',          leaveGuard, leaveCtrl.adminRejectRequest);
router.post('/leave/requests/:id/modification',    leaveGuard, leaveCtrl.adminRequestModification);
router.get('/leave/allocations',                   leaveGuard, leaveCtrl.adminGetAllocations);
router.post('/leave/allocations',                  leaveGuard, leaveCtrl.adminAllocate);
router.get('/leave/allocations/template',          leaveGuard, leaveCtrl.adminGetAllocationTemplate);
router.post('/leave/allocations/excel',            leaveGuard, uploadExcel.single('excelFile'), leaveCtrl.adminBulkAllocateExcel);
router.post('/leave/allocations/carry-forward',    leaveGuard, leaveCtrl.adminRunCarryForward);
router.post('/leave/accrual/run',                  leaveGuard, leaveCtrl.adminRunMonthlyAccrual);
router.get('/leave/requests/export',               leaveGuard, leaveCtrl.adminExportRequests);
router.get('/leave/allocations/export',            leaveGuard, leaveCtrl.adminExportAllocations);
router.get('/leave/reports',                       leaveGuard, leaveCtrl.adminGetReports);
router.get('/leave/reports/export',                leaveGuard, leaveCtrl.adminExportReports);
router.post('/leave/requests/:id/reverse',         leaveGuard, leaveCtrl.adminReverseApproved);

// Comp Off — lives inside the leave module, so it rides the same guard.
// Static paths first: '/leave/compoff/policy' must not be swallowed by '/:id'.
router.get('/leave/compoff/policy',        leaveGuard, compOffCtrl.getPolicy);
router.put('/leave/compoff/policy',        leaveGuard, compOffCtrl.updatePolicy);
router.get('/leave/compoff/ledger',        leaveGuard, compOffCtrl.adminLedger);
router.get('/leave/compoff/balances',      leaveGuard, compOffCtrl.adminBalances);
router.get('/leave/compoff/reports',       leaveGuard, compOffCtrl.adminReports);
router.get('/leave/compoff/export',        leaveGuard, compOffCtrl.adminExport);
router.get('/leave/compoff/preview',       leaveGuard, compOffCtrl.previewWorkDate);
router.get('/leave/compoff/employees',     leaveGuard, compOffCtrl.adminEmployees);
router.post('/leave/compoff/adjust',       leaveGuard, compOffCtrl.adminAdjust);
router.post('/leave/compoff/expire/run',   leaveGuard, compOffCtrl.adminRunExpiry);
router.post('/leave/compoff/generate',     leaveGuard, compOffCtrl.adminGenerateFromAttendance);
router.get('/leave/compoff',               leaveGuard, compOffCtrl.listRequests);
router.post('/leave/compoff',              leaveGuard, uploadLeaveDoc.single('document'), compOffCtrl.adminApplyFor);
router.post('/leave/compoff/:id/approve',  leaveGuard, compOffCtrl.approve);
router.post('/leave/compoff/:id/reject',   leaveGuard, compOffCtrl.reject);
router.post('/leave/compoff/:id/cancel',   leaveGuard, compOffCtrl.adminCancelApproved);

// ── Document Categories ────────────────────────────────────────────────────────
const DocumentCategory = require('../../models/DocumentCategory');
router.get('/document-categories', docGuard, async (req, res) => {
    try {
        const cats = await DocumentCategory.find({ school: req.schoolId, isActive: true }).sort({ name: 1 }).lean();
        res.json({ success: true, data: cats });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
router.post('/document-categories', docGuard, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name?.trim()) return res.status(400).json({ success: false, message: 'Name is required' });
        const cat = await DocumentCategory.create({ school: req.schoolId, name: name.trim() });
        res.status(201).json({ success: true, data: cat });
    } catch (e) {
        if (e.code === 11000) return res.status(409).json({ success: false, message: 'Category already exists' });
        res.status(500).json({ success: false, message: e.message });
    }
});
router.delete('/document-categories/:id', docGuard, async (req, res) => {
    try {
        await DocumentCategory.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Documents ─────────────────────────────────────────────────────────────────
router.get('/documents',                              docGuard, docCtrl.adminGetDocuments);
router.post('/documents',                             docGuard, uploadDocument.array('files', 10), docCtrl.adminUpload);
router.get('/documents/audit',                        docGuard, docCtrl.adminGetAuditLog);
router.post('/documents/bulk-archive',                docGuard, docCtrl.adminBulkArchive);
router.delete('/documents/bulk-delete',               docGuard, docCtrl.adminBulkDelete);
router.get('/documents/:id',                          docGuard, docCtrl.adminGetDocument);
router.put('/documents/:id',                          docGuard, uploadDocument.array('files', 10), docCtrl.adminEditDocument);
router.delete('/documents/:id',                       docGuard, docCtrl.adminDeleteDocument);
router.post('/documents/:id/archive',                 docGuard, docCtrl.adminArchiveDocument);
router.post('/documents/:docId/versions/:versionId/restore', docGuard, docCtrl.adminRestoreVersion);

// ── Holidays ──────────────────────────────────────────────────────────────────
router.get('/holiday-types',       holidayGuard, holidayCtrl.getHolidayTypes);
router.put('/holiday-types',       holidayGuard, holidayCtrl.updateHolidayTypes);
router.get('/holidays',            holidayGuard, holidayCtrl.adminGetHolidays);
router.get('/holidays/mine',       holidayGuard, holidayCtrl.adminGetMyHolidays);
router.post('/holidays',           holidayGuard, holidayCtrl.adminCreateHoliday);
router.put('/holidays/:id',        holidayGuard, holidayCtrl.adminUpdateHoliday);
router.delete('/holidays/:id',     holidayGuard, holidayCtrl.adminDeleteHoliday);
router.post('/holidays/import',    holidayGuard, uploadCsv.single('csvFile'), holidayCtrl.adminImportHolidays);
router.get('/holidays/export',     holidayGuard, holidayCtrl.adminExportHolidays);
router.get('/holidays/template',   holidayGuard, holidayCtrl.adminGetImportTemplate);
router.get('/holidays/audit',      holidayGuard, holidayCtrl.adminGetAuditLog);

module.exports = router;
