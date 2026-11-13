'use strict';
// ═════════════════════════════════════════════════════════════════════════════
//  Video Learning — routes (mounted at /api/video)
//
//      Board → Class → Subject → Book → Chapter → Videos
//
//  /central   Super Admin      the content library, providers, school requests
//  /school    School Admin     which board, subjects and books the school follows
//  /teacher   Teacher          releasing books, chapters and videos; progress
//  /student   Student          their books, watching, their own history
//  /stream, /hls, /media       the bytes — authorised by a signed playback
//                              token in the address (controllers/lms/media)
//
//  Every other route needs a session and the right role, and — for the three
//  school roles — the module switched on for the school and allowed by the
//  user's designation. Services then check the records themselves: a class,
//  section, student or book id in a request is never trusted on sight.
//
//  The module was rebuilt in Nov 2026. The routes of the old flat library
//  answer 410 with a plain message, so an app that has not been updated says
//  why instead of showing an empty screen.
// ═════════════════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();

const central = require('../../controllers/lms/central.controller');
const school  = require('../../controllers/lms/school.controller');
const teacher = require('../../controllers/lms/teacher.controller');
const student = require('../../controllers/lms/student.controller');
const media   = require('../../controllers/lms/media.controller');

const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule = require('../../middleware/requireModule');
const { allowModuleAdmin } = require('../../middleware/moduleAccess');
const { uploadLmsImage, uploadLmsRequestDoc } = require('../../middleware/upload');
const { rateLimit } = require('../../middleware/rateLimit');

// A school route is for someone who belongs to a school; the Super Admin has none.
const requireSchool = (req, res, next) => (req.schoolId ? next()
    : res.status(403).json({ success: false, message: 'This page is for a school\'s own staff and students' }));

const superGuard   = [verifyToken, requirePasswordReset, requireRole('super_admin')];
const schoolGuard  = [verifyToken, requirePasswordReset, requireSchool, allowModuleAdmin('videoLibrary')];
const teacherGuard = [verifyToken, requirePasswordReset, requireSchool, requireRole('teacher'), requireModule('videoLibrary')];
const studentGuard = [verifyToken, requirePasswordReset, requireSchool, requireRole('student'), requireModule('videoLibrary')];

// Per person, not per address: a whole school shares one address.
const perUser = (prefix, max) => rateLimit({ prefix, windowSec: 60, max: Number(process.env[`RL_${prefix.toUpperCase().replace(/-/g, '_')}_MAX`]) || max, keyFn: (req) => String(req.userId || '') });
const beatLimit  = perUser('vl-beat', 60);      // heartbeats: one every few seconds is all a real player sends
const playLimit  = perUser('vl-play', 30);      // opening videos
const writeLimit = perUser('vl-write', 120);    // teachers' and admins' changes
const chunkBody  = express.raw({ type: 'application/octet-stream', limit: '6mb' });

// ══ THE BYTES (signed playback token in the address) ═════════════════════════
router.get('/stream/:token',        media.stream);
router.head('/stream/:token',       media.stream);
router.get('/hls/:token/*path',     media.hls);
router.get('/media/thumb/:id',      media.thumb);

// ══ SUPER ADMIN — CENTRAL LIBRARY (/api/video/central) ═══════════════════════
router.get('/central/meta',                    superGuard, central.meta);
router.get('/central/overview',                superGuard, central.overview);
router.get('/central/audit',                   superGuard, central.audit);
router.post('/central/images',                 superGuard, uploadLmsImage.single('file'), central.uploadImage);

router.get('/central/boards',                  superGuard, central.listBoards);
router.post('/central/boards',                 superGuard, central.createBoard);
router.get('/central/boards/:id',              superGuard, central.getBoard);
router.put('/central/boards/:id',              superGuard, central.updateBoard);
router.post('/central/boards/:id/active',      superGuard, central.setBoardActive);
router.delete('/central/boards/:id',           superGuard, central.removeBoard);

router.get('/central/subjects',                superGuard, central.listSubjects);
router.post('/central/subjects',               superGuard, central.createSubject);
router.put('/central/subjects/:id',            superGuard, central.updateSubject);
router.put('/central/subjects/:id/mappings',   superGuard, central.setSubjectMappings);
router.delete('/central/subjects/:id',         superGuard, central.removeSubject);

router.get('/central/books',                   superGuard, central.listBooks);
router.post('/central/books',                  superGuard, central.createBook);
router.get('/central/books/:id',               superGuard, central.getBook);
router.put('/central/books/:id',               superGuard, central.updateBook);
router.post('/central/books/:id/status',       superGuard, central.setBookStatus);
router.post('/central/books/:id/editions',     superGuard, central.newEdition);
router.delete('/central/books/:id',            superGuard, central.removeBook);
router.post('/central/books/:id/chapters',     superGuard, central.createChapter);
router.put('/central/books/:id/chapters/order', superGuard, central.reorderChapters);

router.put('/central/chapters/:id',            superGuard, central.updateChapter);
router.delete('/central/chapters/:id',         superGuard, central.removeChapter);
router.post('/central/chapters/:id/videos',    superGuard, central.mapVideos);
router.put('/central/chapters/:id/videos/order', superGuard, central.reorderChapterVideos);
router.delete('/central/mappings/:id',         superGuard, central.unmapVideo);

router.get('/central/videos',                  superGuard, central.listVideos);
router.post('/central/videos',                 superGuard, central.createVideo);
router.post('/central/videos/lookup',          superGuard, central.lookupEmbed);
router.get('/central/videos/:id',              superGuard, central.getVideo);
router.put('/central/videos/:id',              superGuard, central.updateVideo);
router.post('/central/videos/:id/active',      superGuard, central.setVideoActive);
router.post('/central/videos/:id/preview',     superGuard, central.previewVideo);
router.post('/central/videos/:id/process',     superGuard, central.retryProcessing);
router.delete('/central/videos/:id',           superGuard, central.removeVideo);

router.post('/central/videos/:id/uploads',             superGuard, central.initUpload);
router.get('/central/uploads/:uploadId',               superGuard, central.uploadStatus);
router.put('/central/uploads/:uploadId/chunks/:index', superGuard, chunkBody, central.uploadChunk);
router.post('/central/uploads/:uploadId/complete',     superGuard, central.completeUpload);
router.delete('/central/uploads/:uploadId',            superGuard, central.abortUpload);

router.get('/central/providers',               superGuard, central.listProviders);
router.put('/central/providers/:provider',     superGuard, central.saveProvider);
router.post('/central/providers/:provider/check', superGuard, central.checkProvider);
router.put('/central/settings',                superGuard, central.saveSettings);

router.get('/central/requests',                superGuard, central.listRequests);
router.get('/central/requests/:id',            superGuard, central.getRequest);
router.post('/central/requests/:id/status',    superGuard, central.setRequestStatus);
router.get('/central/requests/:id/attachment', superGuard, central.requestAttachment);

// ══ SCHOOL ADMIN — WHAT THE SCHOOL FOLLOWS (/api/video/school) ═══════════════
router.get('/school/setup',                    schoolGuard, school.setup);
router.put('/school/board',                    schoolGuard, writeLimit, school.setBoard);
router.put('/school/classes/:classId/subjects', schoolGuard, writeLimit, school.setClassSubjects);
router.get('/school/classes/:classId/books',   schoolGuard, school.availableBooks);
router.put('/school/books/assignment',         schoolGuard, writeLimit, school.assignBook);
router.get('/school/assignments/history',      schoolGuard, school.assignmentHistory);

router.get('/school/requests',                 schoolGuard, school.listRequests);
router.post('/school/requests',                schoolGuard, writeLimit, uploadLmsRequestDoc.single('file'), school.createRequest);
router.get('/school/requests/:id',             schoolGuard, school.getRequest);
router.delete('/school/requests/:id',          schoolGuard, school.withdrawRequest);
router.get('/school/requests/:id/attachment',  schoolGuard, school.requestAttachment);

router.get('/school/settings',                 schoolGuard, school.getSettings);
router.put('/school/settings',                 schoolGuard, school.saveSettings);
router.get('/school/analytics',                schoolGuard, school.overview);
router.get('/school/analytics/students',       schoolGuard, school.students);
router.get('/school/audit',                    schoolGuard, school.audit);

// ══ TEACHER — RELEASES AND PROGRESS (/api/video/teacher) ═════════════════════
router.get('/teacher/workspace',               teacherGuard, teacher.workspace);
router.get('/teacher/books/:id',               teacherGuard, teacher.book);
router.get('/teacher/sections/:id/students',   teacherGuard, teacher.sectionStudents);

router.get('/teacher/releases',                teacherGuard, teacher.listReleases);
router.post('/teacher/releases',               teacherGuard, writeLimit, teacher.createRelease);
router.get('/teacher/releases/:id',            teacherGuard, teacher.getRelease);
router.put('/teacher/releases/:id',            teacherGuard, writeLimit, teacher.updateRelease);
router.post('/teacher/releases/:id/unpublish', teacherGuard, writeLimit, teacher.unpublish);
router.post('/teacher/releases/:id/publish',   teacherGuard, writeLimit, teacher.publish);
router.post('/teacher/releases/:id/revoke',    teacherGuard, writeLimit, teacher.revoke);
router.post('/teacher/releases/:id/rerelease', teacherGuard, writeLimit, teacher.rerelease);

router.get('/teacher/analytics',               teacherGuard, teacher.dashboard);
router.get('/teacher/analytics/students',      teacherGuard, teacher.students);
router.get('/teacher/analytics/export',        teacherGuard, teacher.exportClass);
router.get('/teacher/analytics/students/:id',  teacherGuard, teacher.studentReport);
router.get('/teacher/analytics/students/:id/export', teacherGuard, teacher.exportStudent);

// ══ STUDENT — WATCHING (/api/video/student) ══════════════════════════════════
router.get('/student/home',                    studentGuard, student.dashboard);
router.get('/student/books/:id',               studentGuard, student.book);
router.get('/student/chapters/:id',            studentGuard, student.chapter);
router.get('/student/history',                 studentGuard, student.history);
router.get('/student/videos/:id',              studentGuard, student.video);
router.post('/student/watch/:id/authorize',    studentGuard, playLimit, student.authorize);
router.post('/student/sessions/:id/renew',     studentGuard, playLimit, student.renew);
router.post('/student/sessions/:id/heartbeat', studentGuard, beatLimit, student.heartbeat);
router.post('/student/sessions/:id/end',       studentGuard, student.end);

// ══ RETIRED (the flat library of before Nov 2026) ════════════════════════════
const gone = (req, res) => res.status(410).json({
    success: false, code: 'VIDEO_MODULE_UPDATED',
    message: 'Video Learning has been rebuilt around books and chapters. Please update the app, or open Video Learning from the menu.',
});
router.use('/admin', gone);
for (const p of ['/student/dashboard', '/student/shelf', '/student/videos/:id/player', '/student/stream/:id', '/student/progress', '/student/events',
    '/student/interact', '/student/interact/:id', '/teacher/scope', '/teacher/catalog', '/teacher/videos', '/teacher/playlists', '/teacher/assignments',
    '/teacher/assignments/:id', '/teacher/assignments/:id/progress', '/school/overview', '/school/browse', '/school/videos/:id/enable',
    '/school/videos/:id/visibility', '/school/approvals', '/school/approvals/:id/approve', '/school/approvals/:id/reject', '/school/playlists',
    '/school/assignments', '/school/assignments/:id']) router.all(p, gone);

module.exports = router;
