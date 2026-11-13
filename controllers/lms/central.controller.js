'use strict';
// Video Learning — Super Admin: the central content library, providers,
// school requests and platform-wide figures. Thin on purpose: the rules live
// in services/lms. Every route here sits behind requireRole('super_admin').
const { handle, ok, created, paged, audit, bad, CLASS_LEVELS } = require('../../services/lms/common');
const catalog = require('../../services/lms/catalog');
const uploads = require('../../services/lms/uploads');
const jobs = require('../../services/lms/jobs');
const providers = require('../../services/lms/providers');
const settings = require('../../services/lms/settings');
const school = require('../../services/lms/school');
const analytics = require('../../services/lms/analytics');
const tracking = require('../../services/lms/tracking');
const notices = require('../../services/lms/notices');

const central = (req, action, type, id, summary, meta) => audit(req, action, type, id, summary, meta, null);

// ── Reference data and overview ──────────────────────────────────────────────
exports.meta = handle(async (req, res) => ok(res, {
    classLevels: CLASS_LEVELS.map((l) => ({ number: l.number, label: l.label })),
    providers: (await providers.describe()).map((p) => ({ provider: p.provider, label: p.label, kind: p.kind, usable: p.usable, isDefault: p.isDefault, missing: p.missing })),
    settings: await settings.platform(),
    uploadExtensions: uploads.EXTENSIONS,
}));
exports.overview = handle(async (req, res) => ok(res, await analytics.centralOverview({ fresh: req.query.fresh === '1' })));
exports.audit = handle(async (req, res) => { const r = await analytics.auditLog(req.query, null); paged(res, r.rows, r.total, r.pg); });

// ── Boards ───────────────────────────────────────────────────────────────────
exports.listBoards = handle(async (req, res) => ok(res, await catalog.listBoards(req.query)));
exports.getBoard = handle(async (req, res) => ok(res, await catalog.boardDetail(req.params.id)));
exports.createBoard = handle(async (req, res) => {
    const b = await catalog.createBoard(req.body, req.userId);
    await central(req, 'board.created', 'board', b._id, `Board ${b.code} added`);
    created(res, b);
});
exports.updateBoard = handle(async (req, res) => {
    const b = await catalog.updateBoard(req.params.id, req.body, req.userId);
    await central(req, 'board.updated', 'board', b._id, `Board ${b.code} edited`);
    ok(res, b);
});
exports.setBoardActive = handle(async (req, res) => {
    const b = await catalog.setBoardActive(req.params.id, req.body.active, req.userId);
    await central(req, b.isActive ? 'board.activated' : 'board.deactivated', 'board', b._id, `Board ${b.code} ${b.isActive ? 'activated' : 'deactivated'}`);
    ok(res, b);
});
exports.removeBoard = handle(async (req, res) => {
    const b = await catalog.removeBoard(req.params.id);
    await central(req, 'board.deleted', 'board', b._id, `Board ${b.code} deleted`);
    ok(res, { deleted: true });
});

// ── Subjects ─────────────────────────────────────────────────────────────────
exports.listSubjects = handle(async (req, res) => ok(res, await catalog.listSubjects(req.query)));
exports.createSubject = handle(async (req, res) => {
    const s = await catalog.createSubject(req.body, req.userId);
    await central(req, 'subject.created', 'subject', s._id, `Subject ${s.code} added`);
    created(res, s);
});
exports.updateSubject = handle(async (req, res) => {
    const s = await catalog.updateSubject(req.params.id, req.body, req.userId);
    await central(req, 'subject.updated', 'subject', s._id, `Subject ${s.code} edited`);
    ok(res, s);
});
exports.setSubjectMappings = handle(async (req, res) => {
    const s = await catalog.setSubjectMappings(req.params.id, req.body.mappings, req.userId);
    await central(req, 'subject.mapped', 'subject', s._id, `Subject ${s.code} mapped to boards and classes`);
    ok(res, s);
});
exports.removeSubject = handle(async (req, res) => {
    const s = await catalog.removeSubject(req.params.id);
    await central(req, 'subject.deleted', 'subject', s._id, `Subject ${s.code} deleted`);
    ok(res, { deleted: true });
});

// ── Books ────────────────────────────────────────────────────────────────────
exports.listBooks = handle(async (req, res) => { const r = await catalog.listBooks(req.query); paged(res, r.rows, r.total, r.pg, { counts: r.counts }); });
exports.getBook = handle(async (req, res) => ok(res, await catalog.getBook(req.params.id)));
exports.createBook = handle(async (req, res) => {
    const b = await catalog.createBook(req.body, req.userId);
    await central(req, 'book.created', 'book', b._id, `Book "${b.title}" added`);
    notices.bookAdded(b, req.user).catch(() => {});
    created(res, b);
});
exports.updateBook = handle(async (req, res) => {
    const b = await catalog.updateBook(req.params.id, req.body, req.userId);
    await central(req, 'book.updated', 'book', b._id, `Book "${b.title}" edited`);
    ok(res, b);
});
exports.setBookStatus = handle(async (req, res) => {
    const b = await catalog.setBookStatus(req.params.id, req.body.status, req.userId);
    await central(req, `book.${b.status}`, 'book', b._id, `Book "${b.title}" is now ${b.status}`);
    notices.bookAdded(b, req.user).catch(() => {});       // told once, the first time it is live
    ok(res, b);
});
exports.newEdition = handle(async (req, res) => {
    const b = await catalog.newEdition(req.params.id, req.body, req.userId);
    await central(req, 'book.edition', 'book', b._id, `New edition of "${b.title}": ${b.edition}`, { from: req.params.id });
    created(res, b);
});
exports.removeBook = handle(async (req, res) => {
    const b = await catalog.removeBook(req.params.id);
    await central(req, 'book.deleted', 'book', b._id, `Book "${b.title}" deleted`);
    ok(res, { deleted: true });
});

// ── Chapters ─────────────────────────────────────────────────────────────────
exports.createChapter = handle(async (req, res) => {
    const c = await catalog.createChapter(req.params.id, req.body, req.userId);
    await central(req, 'chapter.created', 'chapter', c._id, `Chapter ${c.chapterNumber} "${c.title}" added`, { book: req.params.id });
    created(res, c);
});
exports.updateChapter = handle(async (req, res) => {
    const c = await catalog.updateChapter(req.params.id, req.body, req.userId);
    await central(req, 'chapter.updated', 'chapter', c._id, `Chapter ${c.chapterNumber} "${c.title}" edited`);
    ok(res, c);
});
exports.reorderChapters = handle(async (req, res) => {
    const r = await catalog.reorderChapters(req.params.id, req.body.order);
    await central(req, 'chapter.reordered', 'book', req.params.id, 'Chapters reordered');
    ok(res, r);
});
exports.removeChapter = handle(async (req, res) => {
    const c = await catalog.removeChapter(req.params.id);
    await central(req, 'chapter.deleted', 'chapter', c._id, `Chapter ${c.chapterNumber} "${c.title}" deleted`);
    ok(res, { deleted: true });
});

// ── Chapter ↔ video mappings ─────────────────────────────────────────────────
exports.mapVideos = handle(async (req, res) => {
    const r = await catalog.mapVideos(req.params.id, req.body.videos, req.userId);
    await central(req, 'mapping.added', 'chapter', req.params.id, `${r.added} video(s) mapped to Chapter ${r.chapter.chapterNumber}`, { videos: req.body.videos });
    ok(res, { added: r.added });
});
exports.unmapVideo = handle(async (req, res) => {
    const r = await catalog.unmapVideo(req.params.id);
    await central(req, r.removed ? 'mapping.removed' : 'mapping.deactivated', 'chapter', r.mapping.chapter, r.removed ? 'A video was taken out of a chapter' : 'A watched video was switched off in a chapter', { video: r.mapping.video });
    ok(res, { removed: r.removed, deactivated: r.deactivated });
});
exports.reorderChapterVideos = handle(async (req, res) => ok(res, await catalog.reorderChapterVideos(req.params.id, req.body.order)));

// ── Video assets ─────────────────────────────────────────────────────────────
exports.listVideos = handle(async (req, res) => { const r = await catalog.listVideos(req.query); paged(res, r.rows, r.total, r.pg, { counts: r.counts }); });
exports.getVideo = handle(async (req, res) => ok(res, await catalog.getVideo(req.params.id)));
exports.lookupEmbed = handle(async (req, res) => ok(res, await catalog.lookupEmbed(req.body.provider, req.body.url)));
exports.createVideo = handle(async (req, res) => {
    const v = await catalog.createVideo(req.body, req.userId);
    await central(req, 'video.created', 'video', v._id, `Video "${v.title}" added (${v.provider})`);
    created(res, v);
});
exports.updateVideo = handle(async (req, res) => {
    const v = await catalog.updateVideo(req.params.id, req.body, req.userId);
    await central(req, 'video.updated', 'video', v._id, `Video "${v.title}" edited`);
    ok(res, v);
});
exports.setVideoActive = handle(async (req, res) => {
    const v = await catalog.setVideoActive(req.params.id, req.body.active, req.userId);
    await central(req, v.isActive ? 'video.activated' : 'video.deactivated', 'video', v._id, `Video "${v.title}" ${v.isActive ? 'activated' : 'deactivated'}`);
    ok(res, v);
});
exports.removeVideo = handle(async (req, res) => {
    const v = await catalog.removeVideo(req.params.id);
    await central(req, 'video.deleted', 'video', v._id, `Video "${v.title}" deleted`);
    ok(res, { deleted: true });
});
exports.previewVideo = handle(async (req, res) => ok(res, await tracking.preview(req.user, req.params.id)));
exports.retryProcessing = handle(async (req, res) => {
    const r = await jobs.retry(req.params.id);
    await central(req, 'video.reprocess', 'video', req.params.id, 'Processing started again');
    ok(res, r);
});

// ── Uploads ──────────────────────────────────────────────────────────────────
exports.initUpload = handle(async (req, res) => {
    const r = await uploads.init(req.params.id, req.body, req.userId);
    await central(req, 'video.upload_started', 'video', req.params.id, `Upload started: ${req.body.filename}`, { sizeBytes: req.body.sizeBytes });
    created(res, r);
});
exports.uploadChunk = handle(async (req, res) => ok(res, await uploads.chunk(req.params.uploadId, req.params.index, req.body)));
exports.uploadStatus = handle(async (req, res) => ok(res, await uploads.status(req.params.uploadId)));
exports.completeUpload = handle(async (req, res) => {
    const r = await uploads.complete(req.params.uploadId, req.userId);
    await central(req, 'video.uploaded', 'video', r.videoId, 'File uploaded; queued for processing');
    ok(res, r);
});
exports.abortUpload = handle(async (req, res) => ok(res, await uploads.abort(req.params.uploadId)));

/** A cover or thumbnail picture. Stored under uploads/lms-images, which is public — these are not the videos. */
exports.uploadImage = handle(async (req, res) => {
    if (!req.file) throw bad('Choose a picture to upload (JPG, PNG or WebP)');
    created(res, { url: `/uploads/lms-images/${req.file.filename}` });
});

// ── Providers and settings ───────────────────────────────────────────────────
exports.listProviders = handle(async (req, res) => ok(res, { providers: await providers.describe(), settings: await settings.platform(), limits: settings.PLATFORM_LIMITS }));
exports.saveProvider = handle(async (req, res) => {
    const p = await providers.save(req.params.provider, req.body, req.userId);
    // What changed is recorded; what a secret was set to never is.
    await central(req, 'provider.saved', 'provider', null, `${p.label} settings saved`, { provider: p.provider, enabled: p.enabled, isDefault: p.isDefault, secretsChanged: Object.keys(req.body.secrets || {}).filter((k) => req.body.secrets[k]) });
    ok(res, p);
});
exports.checkProvider = handle(async (req, res) => ok(res, await providers.check(req.params.provider)));
exports.saveSettings = handle(async (req, res) => {
    const s = await settings.savePlatform(req.body, req.userId);
    await central(req, 'settings.saved', 'settings', null, 'Playback and upload settings changed', s);
    ok(res, s);
});

// ── School requests ──────────────────────────────────────────────────────────
exports.listRequests = handle(async (req, res) => { const r = await school.listRequests(req.query); paged(res, r.rows, r.total, r.pg, { counts: r.counts }); });
exports.getRequest = handle(async (req, res) => ok(res, await school.getRequest(req.params.id)));
exports.setRequestStatus = handle(async (req, res) => {
    const r = await school.setRequestStatus(req.params.id, req.body, req.user);
    await audit(req, `request.${r.status}`, 'request', r._id, `Request ${r.status.replace('_', ' ')}`, { note: req.body.note || '' }, r.school);
    ok(res, r);
});
exports.requestAttachment = handle(async (req, res) => {
    const { file, name } = await school.requestAttachment(req.params.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.download(file, name);
});
