'use strict';
// ═════════════════════════════════════════════════════════════════════════════
//  Video Learning — Master Library controller (SUPER ADMIN)
//  Route base: /api/video/admin/*   Guard: requireRole('super_admin')
//
//  The master library is global (school = null). A video is stored ONCE and
//  reused across every school via VideoTaxonomy mappings + per-school SchoolVideo
//  enablement. "Duplicate" clones metadata into a new version; it never copies
//  the underlying media. See services/videoHelpers.js for the taxonomy engine.
// ═════════════════════════════════════════════════════════════════════════════
const Video            = require('../models/Video');
const VideoAsset       = require('../models/VideoAsset');
const VideoPlaylist    = require('../models/VideoPlaylist');
const VideoPlaylistItem= require('../models/VideoPlaylistItem');
const VideoCourse      = require('../models/VideoCourse');
const VideoCourseItem  = require('../models/VideoCourseItem');
const VideoTaxonomy    = require('../models/VideoTaxonomy');
const VideoProgress    = require('../models/VideoProgress');
const VideoWatchEvent  = require('../models/VideoWatchEvent');
const VideoInteraction = require('../models/VideoInteraction');
const SchoolVideo      = require('../models/SchoolVideo');
const VideoAuditLog    = require('../models/VideoAuditLog');

const { slugify } = require('../services/videoAccess');
const storage = require('../services/videoStorage');
const {
    ok, bad, fail, DIMENSIONS, audit,
    applyTaxonomy, getTaxonomy, getTaxonomyForMany, resolveVideoIdsByTaxonomy, nextCode,
} = require('../services/videoHelpers');

const CATEGORIES = Video.schema.parsed().fields.category.enum;

// Ensure a slug is unique within the master scope by suffixing -2, -3, …
async function uniqueSlug(base, excludeId = null) {
    let slug = slugify(base) || 'video';
    let i = 1, candidate = slug;
    /* eslint-disable no-await-in-loop */
    while (true) {
        const q = { scope: 'master', slug: candidate, isDeleted: false };
        if (excludeId) q._id = { $ne: excludeId };
        const clash = await Video.findOne(q, '_id').lean();
        if (!clash) return candidate;
        candidate = `${slug}-${++i}`;
    }
}

// Normalize a create/update body → the columns we allow to be set.
function pickVideoFields(b) {
    const f = {};
    const strs = ['title', 'shortDescription', 'longDescription', 'learningOutcome',
        'teacherNotes', 'transcript', 'sourceUrl', 'thumbnailUrl', 'language', 'medium'];
    for (const k of strs) if (b[k] !== undefined) f[k] = b[k];
    for (const k of ['durationSec', 'estimatedStudyTimeMin']) if (b[k] !== undefined) f[k] = Number(b[k]) || 0;
    for (const k of ['downloadAllowed', 'hasClosedCaption', 'watermarkEnabled']) if (b[k] !== undefined) f[k] = !!b[k];
    if (b.difficulty) f.difficulty = b.difficulty;
    if (b.category) f.category = b.category;
    if (b.streamingQuality) f.streamingQuality = b.streamingQuality;
    if (b.visibility) f.visibility = b.visibility;
    if (Array.isArray(b.keywords)) f.keywords = b.keywords;
    if (Array.isArray(b.tags)) f.tags = b.tags;
    if (b.expiryAt !== undefined) f.expiryAt = b.expiryAt ? new Date(b.expiryAt) : null;
    return f;
}

// ═════════════════════════════════════════════════════════════════════════════
//  META
// ═════════════════════════════════════════════════════════════════════════════
exports.getMeta = async (_req, res) => {
    try {
        ok(res, {
            categories: CATEGORIES,
            difficulties: ['beginner', 'intermediate', 'advanced'],
            sources: ['s3', 'youtube', 'vimeo'],
            statuses: ['draft', 'scheduled', 'published', 'archived'],
            dimensions: DIMENSIONS,
            boards: ['CBSE', 'ICSE', 'IB', 'IGCSE', 'State Board', 'NIOS', 'Cambridge'],
            grades: ['Nursery', 'LKG', 'UKG', ...Array.from({ length: 12 }, (_, i) => `Class ${i + 1}`)],
            languages: ['English', 'Hindi', 'Marathi', 'Tamil', 'Telugu', 'Bengali', 'Gujarati', 'Kannada'],
            mediums: ['English', 'Hindi', 'Bilingual', 'Regional'],
            storageDriver: storage.DRIVER,
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  LIST & DETAIL
// ═════════════════════════════════════════════════════════════════════════════
exports.listVideos = async (req, res) => {
    try {
        const q = req.query;
        const page  = Math.max(1, parseInt(q.page)  || 1);
        const limit = Math.min(100, parseInt(q.limit) || 20);

        const filter = { scope: q.scope || 'master', isDeleted: false };
        if (q.status)     filter.status = q.status;
        if (q.source)     filter.source = q.source;
        if (q.category)   filter.category = q.category;
        if (q.difficulty) filter.difficulty = q.difficulty;
        if (q.approval)   filter.approvalStatus = q.approval;
        if (q.featured === 'true') filter.featured = true;
        if (q.createdBy)  filter.createdBy = q.createdBy;
        if (q.search)     filter.title = { $regex: q.search, $options: 'i' };
        if (q.dateFrom || q.dateTo) {
            filter.createdAt = {};
            if (q.dateFrom) filter.createdAt.$gte = new Date(q.dateFrom);
            if (q.dateTo)   filter.createdAt.$lte = new Date(q.dateTo);
        }

        // taxonomy filters (board/grade/subject/chapter/topic/language/…) → id set
        const taxFilters = {};
        for (const d of DIMENSIONS) if (q[d]) taxFilters[d] = String(q[d]).split(',');
        const taxIds = await resolveVideoIdsByTaxonomy(taxFilters);
        if (taxIds !== null) {
            if (!taxIds.length) return ok(res, { items: [], total: 0, page, pages: 0 });
            filter._id = { $in: taxIds };
        }

        const sortField = q.sort || '-createdAt';
        const [items, total] = await Promise.all([
            Video.find(filter).sort(sortField).skip((page - 1) * limit).limit(limit)
                .populate('createdBy', 'name').lean(),
            Video.countDocuments(filter),
        ]);
        const taxMap = await getTaxonomyForMany('video', items.map((v) => v._id));
        for (const v of items) v.taxonomy = taxMap.get(String(v._id)) || {};

        ok(res, { items, total, page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};

exports.getVideo = async (req, res) => {
    try {
        const v = await Video.findById(req.params.id)
            .populate('createdBy', 'name').populate('updatedBy', 'name').lean();
        if (!v || v.isDeleted) return bad(res, 'Video not found', 404);
        const [taxonomy, assets] = await Promise.all([
            getTaxonomy('video', v._id),
            VideoAsset.find({ video: v._id, isActive: true }).lean(),
        ]);
        ok(res, { ...v, taxonomy, assets });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  CREATE / EDIT / DELETE / ARCHIVE / DUPLICATE
// ═════════════════════════════════════════════════════════════════════════════
exports.createVideo = async (req, res) => {
    try {
        const b = req.body;
        if (!b.title) return bad(res, 'Title is required');
        if (!['s3', 'youtube', 'vimeo'].includes(b.source)) return bad(res, 'Valid source (s3|youtube|vimeo) is required');

        const doc = { scope: 'master', school: null, source: b.source, createdBy: req.userId, ...pickVideoFields(b) };

        if (b.source === 'youtube' || b.source === 'vimeo') {
            const parsed = storage.parseProvider(b.sourceUrl);
            if (!parsed || parsed.source !== b.source) return bad(res, `Invalid ${b.source} URL`);
            doc.providerId = parsed.providerId;
            doc.sourceUrl  = parsed.sourceUrl;
            doc.approvalStatus = 'approved'; // super-admin content is trusted
        } else { // s3
            doc.s3Key   = b.s3Key || '';
            doc.s3Bucket= b.s3Bucket || storage.S3_BUCKET;
            doc.approvalStatus = 'not_required';
        }
        doc.slug = await uniqueSlug(b.slug || b.title);

        const v = await Video.create(doc);
        if (b.taxonomy) await applyTaxonomy('video', v._id, b.taxonomy);
        await audit(req, 'created', 'video', v._id, `Created "${v.title}"`);
        ok(res, v);
    } catch (e) { fail(res, e); }
};

exports.updateVideo = async (req, res) => {
    try {
        const v = await Video.findById(req.params.id);
        if (!v || v.isDeleted) return bad(res, 'Video not found', 404);
        const update = { ...pickVideoFields(req.body), updatedBy: req.userId };
        if (req.body.slug && req.body.slug !== v.slug) update.slug = await uniqueSlug(req.body.slug, v._id);
        if (req.body.source === 'youtube' || req.body.source === 'vimeo') {
            if (req.body.sourceUrl) {
                const parsed = storage.parseProvider(req.body.sourceUrl);
                if (!parsed) return bad(res, 'Invalid provider URL');
                update.source = parsed.source; update.providerId = parsed.providerId; update.sourceUrl = parsed.sourceUrl;
            }
        }
        await Video.updateOne({ _id: v._id }, { $set: update });
        if (req.body.taxonomy) await applyTaxonomy('video', v._id, req.body.taxonomy);
        await audit(req, 'updated', 'video', v._id, `Updated "${v.title}"`);
        ok(res, await Video.findById(v._id).lean());
    } catch (e) { fail(res, e); }
};

exports.deleteVideo = async (req, res) => {
    try {
        const v = await Video.findById(req.params.id);
        if (!v) return bad(res, 'Video not found', 404);
        // soft delete: keep analytics/assignments intact, hide everywhere.
        await Video.updateOne({ _id: v._id }, { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: req.userId, status: 'archived' } });
        await audit(req, 'deleted', 'video', v._id, `Soft-deleted "${v.title}"`);
        ok(res, { deleted: true });
    } catch (e) { fail(res, e); }
};

exports.archiveVideo = async (req, res) => {
    try {
        const restore = req.body.restore === true;
        const v = await Video.findById(req.params.id);
        if (!v) return bad(res, 'Video not found', 404);
        await Video.updateOne({ _id: v._id }, { $set: { status: restore ? 'draft' : 'archived' } });
        await audit(req, restore ? 'restored' : 'archived', 'video', v._id);
        ok(res, { status: restore ? 'draft' : 'archived' });
    } catch (e) { fail(res, e); }
};

exports.duplicateVideo = async (req, res) => {
    try {
        const src = await Video.findById(req.params.id).lean();
        if (!src || src.isDeleted) return bad(res, 'Video not found', 404);
        const { _id, createdAt, updatedAt, slug, viewsCount, uniqueViewsCount, likesCount, dislikesCount, ...rest } = src;
        const clone = {
            ...rest,
            title: `${src.title} (copy)`,
            slug: await uniqueSlug(`${src.title}-copy`),
            status: 'draft',
            version: (src.version || 1) + 1,
            originalVideoId: src.originalVideoId || src._id,
            viewsCount: 0, uniqueViewsCount: 0, likesCount: 0, dislikesCount: 0,
            createdBy: req.userId, updatedBy: req.userId,
            publishedAt: null, scheduledAt: null,
        };
        const v = await Video.create(clone);
        // copy taxonomy mappings
        const tax = await VideoTaxonomy.find({ entityType: 'video', entityId: src._id }).lean();
        if (tax.length) {
            await VideoTaxonomy.insertMany(tax.map((t) => ({
                entityType: 'video', entityId: v._id, dimension: t.dimension,
                value: t.value, valueSlug: t.valueSlug, refId: t.refId, sequence: t.sequence,
            })), { ordered: false }).catch(() => {});
        }
        await audit(req, 'duplicated', 'video', v._id, `Duplicated from ${src._id}`);
        ok(res, v);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  PUBLISH / SCHEDULE / FEATURE
// ═════════════════════════════════════════════════════════════════════════════
exports.publishVideo = async (req, res) => {
    try {
        const v = await Video.findById(req.params.id);
        if (!v || v.isDeleted) return bad(res, 'Video not found', 404);
        if (v.source === 's3' && !v.s3Key) return bad(res, 'Cannot publish: S3 media not uploaded yet');
        await Video.updateOne({ _id: v._id }, { $set: { status: 'published', publishedAt: new Date(), scheduledAt: null } });
        await audit(req, 'published', 'video', v._id, `Published "${v.title}"`);
        ok(res, { status: 'published' });
    } catch (e) { fail(res, e); }
};

exports.scheduleVideo = async (req, res) => {
    try {
        const when = new Date(req.body.scheduledAt);
        if (isNaN(when) || when <= new Date()) return bad(res, 'scheduledAt must be a future date');
        const v = await Video.findById(req.params.id);
        if (!v || v.isDeleted) return bad(res, 'Video not found', 404);
        await Video.updateOne({ _id: v._id }, { $set: { status: 'scheduled', scheduledAt: when } });
        await audit(req, 'scheduled', 'video', v._id, `Scheduled for ${when.toISOString()}`);
        ok(res, { status: 'scheduled', scheduledAt: when });
    } catch (e) { fail(res, e); }
};

exports.setFeatured = async (req, res) => {
    try {
        const { featured, trending } = req.body;
        const set = {};
        if (featured !== undefined) set.featured = !!featured;
        if (trending !== undefined) set.trending = !!trending;
        await Video.updateOne({ _id: req.params.id }, { $set: set });
        await audit(req, 'updated', 'video', req.params.id, 'Feature/trending flags changed', set);
        ok(res, set);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  UPLOAD (S3 media + companion assets)
// ═════════════════════════════════════════════════════════════════════════════
// Presigned target for a direct-to-S3 upload (or local fallback key).
exports.getUploadTarget = async (req, res) => {
    try {
        const target = await storage.getUploadTarget({ filename: req.query.filename, contentType: req.query.contentType });
        ok(res, target);
    } catch (e) { fail(res, e); }
};

// Local-driver multipart upload: store the file and stamp s3Key on the video.
exports.uploadVideoFile = async (req, res) => {
    try {
        if (!req.file) return bad(res, 'No file uploaded');
        const v = await Video.findById(req.params.id);
        if (!v) return bad(res, 'Video not found', 404);
        const key = `videos/${req.file.filename}`;
        await Video.updateOne({ _id: v._id }, { $set: {
            s3Key: key, source: 's3',
            thumbnailUrl: v.thumbnailUrl,
        } });
        await audit(req, 'updated', 'video', v._id, 'Uploaded S3 media', { key });
        ok(res, { s3Key: key, url: `/uploads/${key}` });
    } catch (e) { fail(res, e); }
};

exports.addAsset = async (req, res) => {
    try {
        const v = await Video.findById(req.params.id);
        if (!v) return bad(res, 'Video not found', 404);
        const body = req.body;
        const asset = {
            video: v._id, kind: body.kind, title: body.title || '', language: body.language || '',
            uploadedBy: req.userId,
        };
        if (req.file) {
            asset.source = 'local';
            asset.fileUrl = `/uploads/documents/${req.file.filename}`;
            asset.fileKey = req.file.filename;
            asset.mimeType = req.file.mimetype;
            asset.sizeBytes = req.file.size;
        } else if (body.fileUrl) {
            asset.source = 'external'; asset.fileUrl = body.fileUrl;
        } else return bad(res, 'Provide a file or fileUrl');
        if (asset.kind === 'thumbnail') await Video.updateOne({ _id: v._id }, { $set: { thumbnailUrl: asset.fileUrl } });
        const a = await VideoAsset.create(asset);
        await audit(req, 'updated', 'asset', a._id, `Added ${asset.kind}`, { video: v._id });
        ok(res, a);
    } catch (e) { fail(res, e); }
};

exports.deleteAsset = async (req, res) => {
    try {
        await VideoAsset.updateOne({ _id: req.params.assetId }, { $set: { isActive: false } });
        ok(res, { deleted: true });
    } catch (e) { fail(res, e); }
};

// Replace a video's taxonomy mappings (full or per-dimension).
exports.setTaxonomy = async (req, res) => {
    try {
        const v = await Video.findById(req.params.id, '_id').lean();
        if (!v) return bad(res, 'Video not found', 404);
        await applyTaxonomy('video', req.params.id, req.body.taxonomy || req.body || {});
        await audit(req, 'updated', 'video', req.params.id, 'Updated taxonomy mappings');
        ok(res, await getTaxonomy('video', req.params.id));
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  PLAYLISTS (master)
// ═════════════════════════════════════════════════════════════════════════════
exports.listPlaylists = async (req, res) => {
    try {
        const filter = { scope: 'master', isDeleted: false };
        if (req.query.status) filter.status = req.query.status;
        if (req.query.search) filter.title = { $regex: req.query.search, $options: 'i' };
        const items = await VideoPlaylist.find(filter).sort('-createdAt').lean();
        ok(res, items);
    } catch (e) { fail(res, e); }
};

exports.createPlaylist = async (req, res) => {
    try {
        if (!req.body.title) return bad(res, 'Title is required');
        const p = await VideoPlaylist.create({
            scope: 'master', school: null, title: req.body.title,
            slug: slugify(req.body.title), description: req.body.description || '',
            thumbnailUrl: req.body.thumbnailUrl || '', status: req.body.status || 'draft',
            createdBy: req.userId,
        });
        if (req.body.taxonomy) await applyTaxonomy('playlist', p._id, req.body.taxonomy);
        if (Array.isArray(req.body.videoIds)) await syncPlaylistItems(p._id, req.body.videoIds, req.userId);
        await audit(req, 'created', 'playlist', p._id, `Created playlist "${p.title}"`);
        ok(res, p);
    } catch (e) { fail(res, e); }
};

exports.getPlaylist = async (req, res) => {
    try {
        const p = await VideoPlaylist.findById(req.params.id).lean();
        if (!p || p.isDeleted) return bad(res, 'Playlist not found', 404);
        const items = await VideoPlaylistItem.find({ playlist: p._id }).sort('sequence')
            .populate('video', 'title durationSec thumbnailUrl source status').lean();
        ok(res, { ...p, items, taxonomy: await getTaxonomy('playlist', p._id) });
    } catch (e) { fail(res, e); }
};

exports.updatePlaylist = async (req, res) => {
    try {
        const set = {};
        for (const k of ['title', 'description', 'thumbnailUrl', 'status', 'isPinned']) if (req.body[k] !== undefined) set[k] = req.body[k];
        set.updatedBy = req.userId;
        await VideoPlaylist.updateOne({ _id: req.params.id }, { $set: set });
        if (req.body.taxonomy) await applyTaxonomy('playlist', req.params.id, req.body.taxonomy);
        if (Array.isArray(req.body.videoIds)) await syncPlaylistItems(req.params.id, req.body.videoIds, req.userId);
        await audit(req, 'updated', 'playlist', req.params.id);
        ok(res, await VideoPlaylist.findById(req.params.id).lean());
    } catch (e) { fail(res, e); }
};

// Replace a playlist's ordered items and refresh denormalized counts.
async function syncPlaylistItems(playlistId, videoIds, userId) {
    await VideoPlaylistItem.deleteMany({ playlist: playlistId });
    const rows = videoIds.map((vid, i) => ({ playlist: playlistId, video: vid, sequence: i, addedBy: userId }));
    if (rows.length) await VideoPlaylistItem.insertMany(rows, { ordered: false }).catch(() => {});
    const vids = await Video.find({ _id: { $in: videoIds } }, 'durationSec').lean();
    const durMin = Math.round(vids.reduce((s, v) => s + (v.durationSec || 0), 0) / 60);
    await VideoPlaylist.updateOne({ _id: playlistId }, { $set: { videoCount: rows.length, estimatedDurationMin: durMin } });
}

// ═════════════════════════════════════════════════════════════════════════════
//  COURSES (master)
// ═════════════════════════════════════════════════════════════════════════════
exports.listCourses = async (req, res) => {
    try {
        const filter = { scope: 'master', isDeleted: false };
        if (req.query.status) filter.status = req.query.status;
        ok(res, await VideoCourse.find(filter).sort('-createdAt').lean());
    } catch (e) { fail(res, e); }
};

exports.createCourse = async (req, res) => {
    try {
        if (!req.body.title) return bad(res, 'Title is required');
        const c = await VideoCourse.create({
            scope: 'master', school: null, title: req.body.title, slug: slugify(req.body.title),
            description: req.body.description || '', thumbnailUrl: req.body.thumbnailUrl || '',
            difficulty: req.body.difficulty || 'beginner',
            certificateEnabled: !!req.body.certificateEnabled, passPercent: req.body.passPercent || 80,
            status: req.body.status || 'draft', createdBy: req.userId,
        });
        if (req.body.taxonomy) await applyTaxonomy('course', c._id, req.body.taxonomy);
        await audit(req, 'created', 'course', c._id, `Created course "${c.title}"`);
        ok(res, c);
    } catch (e) { fail(res, e); }
};

exports.getCourse = async (req, res) => {
    try {
        const c = await VideoCourse.findById(req.params.id).lean();
        if (!c || c.isDeleted) return bad(res, 'Course not found', 404);
        const items = await VideoCourseItem.find({ course: c._id }).sort('sectionSequence sequence')
            .populate('playlist', 'title videoCount').populate('video', 'title durationSec').lean();
        ok(res, { ...c, items, taxonomy: await getTaxonomy('course', c._id) });
    } catch (e) { fail(res, e); }
};

exports.updateCourse = async (req, res) => {
    try {
        const set = {};
        for (const k of ['title', 'description', 'thumbnailUrl', 'difficulty', 'status', 'certificateEnabled', 'passPercent']) if (req.body[k] !== undefined) set[k] = req.body[k];
        await VideoCourse.updateOne({ _id: req.params.id }, { $set: set });
        if (Array.isArray(req.body.items)) {
            await VideoCourseItem.deleteMany({ course: req.params.id });
            const rows = req.body.items.map((it, i) => ({
                course: req.params.id, sectionTitle: it.sectionTitle || 'Section 1',
                sectionSequence: it.sectionSequence || 0, itemType: it.itemType,
                playlist: it.itemType === 'playlist' ? it.playlist : null,
                video: it.itemType === 'video' ? it.video : null,
                sequence: it.sequence != null ? it.sequence : i, isMandatory: it.isMandatory !== false,
            }));
            if (rows.length) await VideoCourseItem.insertMany(rows, { ordered: false }).catch(() => {});
            await VideoCourse.updateOne({ _id: req.params.id }, { $set: { itemCount: rows.length } });
        }
        if (req.body.taxonomy) await applyTaxonomy('course', req.params.id, req.body.taxonomy);
        await audit(req, 'updated', 'course', req.params.id);
        ok(res, await VideoCourse.findById(req.params.id).lean());
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ANALYTICS & AUDIT
// ═════════════════════════════════════════════════════════════════════════════
// Library-wide overview for the Super Admin dashboard.
exports.getOverview = async (_req, res) => {
    try {
        const [total, published, draft, scheduled] = await Promise.all([
            Video.countDocuments({ scope: 'master', isDeleted: false }),
            Video.countDocuments({ scope: 'master', isDeleted: false, status: 'published' }),
            Video.countDocuments({ scope: 'master', isDeleted: false, status: 'draft' }),
            Video.countDocuments({ scope: 'master', isDeleted: false, status: 'scheduled' }),
        ]);
        const bySource = await Video.aggregate([
            { $match: { scope: 'master', isDeleted: false } },
            { $group: { _id: '$source', n: { $sum: 1 } } },
        ]);
        const topViewed = await Video.find({ scope: 'master', isDeleted: false }, 'title viewsCount likesCount')
            .sort('-viewsCount').limit(10).lean();
        ok(res, {
            counts: { total, published, draft, scheduled },
            bySource: bySource.map((r) => ({ source: r._id, count: r.n })),
            topViewed,
        });
    } catch (e) { fail(res, e); }
};

// Per-video analytics: aggregate watch events into a drop-off/engagement view.
exports.getVideoAnalytics = async (req, res) => {
    try {
        const videoId = req.params.id;
        const v = await Video.findById(videoId, 'title durationSec viewsCount likesCount dislikesCount').lean();
        if (!v) return bad(res, 'Video not found', 404);

        const [progressAgg] = await VideoProgress.aggregate([
            { $match: { video: String(videoId) } },
            { $group: {
                _id: null,
                learners: { $sum: 1 },
                completed: { $sum: { $cond: ['$completed', 1, 0] } },
                avgPercent: { $avg: '$progressPercent' },
                avgWatch: { $avg: '$watchedSeconds' },
                pauses: { $sum: '$pauseCount' },
                replays: { $sum: '$replayCount' },
            } },
        ]);
        const deviceMix = await VideoProgress.aggregate([
            { $match: { video: String(videoId) } },
            { $group: { _id: '$device', n: { $sum: 1 } } },
        ]);
        ok(res, {
            video: v,
            engagement: progressAgg || { learners: 0, completed: 0, avgPercent: 0, avgWatch: 0, pauses: 0, replays: 0 },
            deviceMix: deviceMix.map((d) => ({ device: d._id || 'unknown', count: d.n })),
        });
    } catch (e) { fail(res, e); }
};

exports.getAuditLog = async (req, res) => {
    try {
        const filter = {};
        if (req.query.entityType) filter.entityType = req.query.entityType;
        if (req.query.entityId)   filter.entityId = req.query.entityId;
        if (req.query.actionType) filter.actionType = req.query.actionType;
        const items = await VideoAuditLog.find(filter).sort('-createdAt').limit(200)
            .populate('user', 'name role').lean();
        ok(res, items);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  BULK
// ═════════════════════════════════════════════════════════════════════════════
// Import an array of { title, source, sourceUrl|s3Key, category, taxonomy, … }.
exports.bulkImport = async (req, res) => {
    try {
        const rows = Array.isArray(req.body.videos) ? req.body.videos : [];
        if (!rows.length) return bad(res, 'Provide a non-empty "videos" array');
        const created = [];
        const errors = [];
        for (const [i, r] of rows.entries()) {
            try {
                if (!r.title || !['s3', 'youtube', 'vimeo'].includes(r.source)) throw new Error('title + valid source required');
                const doc = { scope: 'master', school: null, source: r.source, createdBy: req.userId, ...pickVideoFields(r), status: 'draft' };
                if (r.source !== 's3') {
                    const parsed = storage.parseProvider(r.sourceUrl);
                    if (!parsed) throw new Error('invalid provider url');
                    doc.providerId = parsed.providerId; doc.sourceUrl = parsed.sourceUrl; doc.approvalStatus = 'approved';
                } else { doc.s3Key = r.s3Key || ''; }
                doc.slug = await uniqueSlug(r.slug || r.title);
                const v = await Video.create(doc);
                if (r.taxonomy) await applyTaxonomy('video', v._id, r.taxonomy);
                created.push(v._id);
            } catch (err) { errors.push({ row: i, message: err.message }); }
        }
        await audit(req, 'created', 'video', null, `Bulk import: ${created.length} created, ${errors.length} failed`);
        ok(res, { created: created.length, failed: errors.length, errors });
    } catch (e) { fail(res, e); }
};

exports.bulkExport = async (req, res) => {
    try {
        const filter = { scope: 'master', isDeleted: false };
        if (req.query.status) filter.status = req.query.status;
        const videos = await Video.find(filter).sort('-createdAt').limit(5000).lean();
        const taxMap = await getTaxonomyForMany('video', videos.map((v) => v._id));
        const out = videos.map((v) => ({
            id: v._id, title: v.title, source: v.source, sourceUrl: v.sourceUrl, s3Key: v.s3Key,
            category: v.category, difficulty: v.difficulty, status: v.status, durationSec: v.durationSec,
            taxonomy: taxMap.get(String(v._id)) || {},
        }));
        ok(res, { count: out.length, videos: out });
    } catch (e) { fail(res, e); }
};
