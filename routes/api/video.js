'use strict';
// ═════════════════════════════════════════════════════════════════════════════
//  Video Learning Module — routes (mounted at /api/video)
//  Four role sections: super-admin (master library), school-admin (governance),
//  teacher (upload-link + assign), student (consume). Super Admin is NOT module-
//  gated (master library is global, school-independent); the school-scoped roles
//  require requireModule('videoLibrary').
// ═════════════════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();

const lib     = require('../../controllers/videoLibrary.controller');   // super_admin
const school  = require('../../controllers/videoSchool.controller');    // school_admin
const teacher = require('../../controllers/videoTeacher.controller');   // teacher
const student = require('../../controllers/videoStudent.controller');   // student

const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule = require('../../middleware/requireModule');
const { uploadVideo, uploadDocument } = require('../../middleware/upload');

const superGuard   = [verifyToken, requirePasswordReset, requireRole('super_admin')];
const schoolGuard  = [verifyToken, requirePasswordReset, requireRole('school_admin'), requireModule('videoLibrary')];
const teacherGuard = [verifyToken, requirePasswordReset, requireRole('teacher'),      requireModule('videoLibrary')];
const studentGuard = [verifyToken, requirePasswordReset, requireRole('student'),      requireModule('videoLibrary')];

// ══ SUPER ADMIN — MASTER LIBRARY (/api/video/admin) ══════════════════════════
router.get('/admin/meta',            superGuard, lib.getMeta);
router.get('/admin/overview',        superGuard, lib.getOverview);
router.get('/admin/audit',           superGuard, lib.getAuditLog);

router.get('/admin/videos',          superGuard, lib.listVideos);
router.post('/admin/videos',         superGuard, lib.createVideo);
router.get('/admin/videos/:id',      superGuard, lib.getVideo);
router.put('/admin/videos/:id',      superGuard, lib.updateVideo);
router.delete('/admin/videos/:id',   superGuard, lib.deleteVideo);
router.post('/admin/videos/:id/archive',   superGuard, lib.archiveVideo);
router.post('/admin/videos/:id/duplicate', superGuard, lib.duplicateVideo);
router.post('/admin/videos/:id/publish',   superGuard, lib.publishVideo);
router.post('/admin/videos/:id/schedule',  superGuard, lib.scheduleVideo);
router.post('/admin/videos/:id/feature',   superGuard, lib.setFeatured);
router.put('/admin/videos/:id/taxonomy',   superGuard, lib.setTaxonomy);
router.get('/admin/videos/:id/analytics',  superGuard, lib.getVideoAnalytics);

// media + assets
router.get('/admin/upload-target',   superGuard, lib.getUploadTarget);
router.post('/admin/videos/:id/media',  superGuard, uploadVideo.single('file'),    lib.uploadVideoFile);
router.post('/admin/videos/:id/assets', superGuard, uploadDocument.single('file'), lib.addAsset);
router.delete('/admin/assets/:assetId', superGuard, lib.deleteAsset);

// playlists & courses (master)
router.get('/admin/playlists',        superGuard, lib.listPlaylists);
router.post('/admin/playlists',       superGuard, lib.createPlaylist);
router.get('/admin/playlists/:id',    superGuard, lib.getPlaylist);
router.put('/admin/playlists/:id',    superGuard, lib.updatePlaylist);
router.get('/admin/courses',          superGuard, lib.listCourses);
router.post('/admin/courses',         superGuard, lib.createCourse);
router.get('/admin/courses/:id',      superGuard, lib.getCourse);
router.put('/admin/courses/:id',      superGuard, lib.updateCourse);

// bulk
router.post('/admin/bulk/import',     superGuard, lib.bulkImport);
router.get('/admin/bulk/export',      superGuard, lib.bulkExport);

// ══ SCHOOL ADMIN — GOVERNANCE (/api/video/school) ════════════════════════════
router.get('/school/settings',        schoolGuard, school.getSettings);
router.put('/school/settings',        schoolGuard, school.updateSettings);
router.get('/school/overview',        schoolGuard, school.getOverview);
router.get('/school/browse',          schoolGuard, school.browseMaster);
router.post('/school/videos/:id/enable',     schoolGuard, school.enableVideo);
router.post('/school/videos/:id/visibility', schoolGuard, school.setVisibility);
router.get('/school/approvals',       schoolGuard, school.getApprovalQueue);
router.post('/school/approvals/:id/approve', schoolGuard, school.approveVideo);
router.post('/school/approvals/:id/reject',  schoolGuard, school.rejectVideo);
router.get('/school/playlists',       schoolGuard, school.listPlaylists);
router.post('/school/playlists',      schoolGuard, school.createPlaylist);
router.get('/school/assignments',     schoolGuard, school.listAssignments);
router.post('/school/assignments',    schoolGuard, school.createAssignment);
router.delete('/school/assignments/:id', schoolGuard, school.deleteAssignment);

// ══ TEACHER (/api/video/teacher) ═════════════════════════════════════════════
router.get('/teacher/scope',          teacherGuard, teacher.getScope);
router.get('/teacher/catalog',        teacherGuard, teacher.getCatalog);
router.post('/teacher/videos',        teacherGuard, teacher.addLinkVideo);
router.get('/teacher/videos',         teacherGuard, teacher.myVideos);
router.get('/teacher/playlists',      teacherGuard, teacher.myPlaylists);
router.get('/teacher/assignments',    teacherGuard, teacher.myAssignments);
router.post('/teacher/assignments',   teacherGuard, teacher.createAssignment);
router.delete('/teacher/assignments/:id', teacherGuard, teacher.deleteAssignment);
router.get('/teacher/assignments/:id/progress', teacherGuard, teacher.getAssignmentProgress);

// ══ STUDENT (/api/video/student) ═════════════════════════════════════════════
router.get('/student/dashboard',      studentGuard, student.getDashboard);
router.get('/student/shelf',          studentGuard, student.getShelf);
router.get('/student/videos/:id/player', studentGuard, student.getPlayer);
router.get('/student/stream/:id',     studentGuard, student.streamVideo);
router.post('/student/progress',      studentGuard, student.reportProgress);
router.post('/student/events',        studentGuard, student.reportEvents);
router.post('/student/interact',      studentGuard, student.interact);
router.delete('/student/interact/:id', studentGuard, student.deleteInteraction);

module.exports = router;
