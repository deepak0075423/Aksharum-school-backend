'use strict';
// ═════════════════════════════════════════════════════════════════════════════
//  Video Learning — School Admin controller
//  Route base: /api/video/school/*
//  Guard: requireRole('school_admin') + requireModule('videoLibrary')
//
//  School Admins govern their own catalogue: enable/disable master videos,
//  approve/reject teacher-added videos, manage school playlists, assign content,
//  and monitor analytics. They CANNOT upload S3 media (Super Admin only).
// ═════════════════════════════════════════════════════════════════════════════
const Video           = require('../models/Video');
const SchoolVideo     = require('../models/SchoolVideo');
const VideoSetting    = require('../models/VideoSetting');
const VideoPlaylist   = require('../models/VideoPlaylist');
const VideoPlaylistItem = require('../models/VideoPlaylistItem');
const VideoAssignment = require('../models/VideoAssignment');
const VideoProgress   = require('../models/VideoProgress');

const { slugify } = require('../services/videoAccess');
const { notify } = require('../services/notifyService');
const { createAssignment } = require('../services/videoAssignmentService');
const {
    ok, bad, fail, DIMENSIONS, audit,
    applyTaxonomy, getTaxonomyForMany, resolveVideoIdsByTaxonomy,
} = require('../services/videoHelpers');

async function getOrCreateSettings(schoolId) {
    let s = await VideoSetting.findOne({ school: schoolId });
    if (!s) s = await VideoSetting.create({ school: schoolId });
    return s;
}

exports.getSettings = async (req, res) => {
    try { ok(res, await getOrCreateSettings(req.schoolId)); } catch (e) { fail(res, e); }
};
exports.updateSettings = async (req, res) => {
    try {
        await getOrCreateSettings(req.schoolId);
        const allowed = ['enableMasterLibrary', 'defaultVisibility', 'teacherUploadEnabled',
            'teacherUploadRequiresApproval', 'allowedTeacherSources', 'allowStudentDownload',
            'allowStudentSharing', 'allowPlaybackSpeed', 'watermarkEnabled', 'watermarkText',
            'antiScreenRecordingHint', 'notifyOnAssign', 'notifyByEmail'];
        const set = {};
        for (const k of allowed) if (req.body[k] !== undefined) set[k] = req.body[k];
        await VideoSetting.updateOne({ school: req.schoolId }, { $set: set });
        await audit(req, 'updated', 'settings', null, 'Updated video settings', set);
        ok(res, await VideoSetting.findOne({ school: req.schoolId }).lean());
    } catch (e) { fail(res, e); }
};

// ── Master library browse (with per-school enabled flag) ──────────────────────
exports.browseMaster = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(60, parseInt(req.query.limit) || 24);
        const filter = { scope: 'master', isDeleted: false, status: 'published' };
        if (req.query.category) filter.category = req.query.category;
        if (req.query.search)   filter.title = { $regex: req.query.search, $options: 'i' };

        const taxFilters = {};
        for (const d of DIMENSIONS) if (req.query[d]) taxFilters[d] = String(req.query[d]).split(',');
        const taxIds = await resolveVideoIdsByTaxonomy(taxFilters);
        if (taxIds !== null) {
            if (!taxIds.length) return ok(res, { items: [], total: 0, page, pages: 0 });
            filter._id = { $in: taxIds };
        }

        const [items, total] = await Promise.all([
            Video.find(filter).sort('-publishedAt').skip((page - 1) * limit).limit(limit).lean(),
            Video.countDocuments(filter),
        ]);
        const enabled = await SchoolVideo.find(
            { school: req.schoolId, video: { $in: items.map((v) => v._id) } }, 'video enabled visibility',
        ).lean();
        const emap = new Map(enabled.map((e) => [String(e.video), e]));
        const taxMap = await getTaxonomyForMany('video', items.map((v) => v._id));
        for (const v of items) {
            const e = emap.get(String(v._id));
            v.enabled = e ? e.enabled : false;
            v.schoolVisibility = e ? e.visibility : null;
            v.taxonomy = taxMap.get(String(v._id)) || {};
        }
        ok(res, { items, total, page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};

exports.enableVideo = async (req, res) => {
    try {
        const enabled = req.body.enabled !== false;
        const v = await Video.findById(req.params.id, 'scope status title').lean();
        if (!v) return bad(res, 'Video not found', 404);
        if (v.scope === 'master' && v.status !== 'published') return bad(res, 'Only published master videos can be enabled');
        await SchoolVideo.updateOne(
            { school: req.schoolId, video: req.params.id },
            { $set: { enabled, visibility: req.body.visibility || 'school', enabledBy: req.userId } },
            { upsert: true },
        );
        await audit(req, enabled ? 'enabled' : 'disabled', 'video', req.params.id, `${enabled ? 'Enabled' : 'Disabled'} "${v.title}"`);
        ok(res, { enabled });
    } catch (e) { fail(res, e); }
};

exports.setVisibility = async (req, res) => {
    try {
        await SchoolVideo.updateOne(
            { school: req.schoolId, video: req.params.id },
            { $set: { visibility: req.body.visibility || 'school', enabledBy: req.userId } },
            { upsert: true },
        );
        await audit(req, 'updated', 'video', req.params.id, `Visibility → ${req.body.visibility}`);
        ok(res, { visibility: req.body.visibility });
    } catch (e) { fail(res, e); }
};

// ── Teacher-video approval queue ──────────────────────────────────────────────
exports.getApprovalQueue = async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const items = await Video.find({ scope: 'school', school: req.schoolId, approvalStatus: status, isDeleted: false })
            .sort('-createdAt').populate('createdBy', 'name role').lean();
        ok(res, items);
    } catch (e) { fail(res, e); }
};

exports.approveVideo = async (req, res) => {
    try {
        const v = await Video.findOne({ _id: req.params.id, school: req.schoolId, scope: 'school' });
        if (!v) return bad(res, 'Video not found', 404);
        await Video.updateOne({ _id: v._id }, { $set: {
            approvalStatus: 'approved', approvedBy: req.userId, approvedAt: new Date(),
            status: 'published', publishedAt: new Date(),
        } });
        await audit(req, 'approved', 'video', v._id, `Approved "${v.title}"`);
        notify({
            school: req.schoolId, sender: req.userId, senderRole: 'school_admin',
            title: 'Your video was approved', body: `"${v.title}" is now available to students.`,
            recipients: [v.createdBy],
            link: { type: 'video.mine', entityId: v._id },
        });
        ok(res, { approved: true });
    } catch (e) { fail(res, e); }
};

exports.rejectVideo = async (req, res) => {
    try {
        const v = await Video.findOne({ _id: req.params.id, school: req.schoolId, scope: 'school' });
        if (!v) return bad(res, 'Video not found', 404);
        await Video.updateOne({ _id: v._id }, { $set: {
            approvalStatus: 'rejected', rejectionReason: req.body.reason || '', status: 'archived',
        } });
        await audit(req, 'rejected', 'video', v._id, req.body.reason || 'Rejected');
        notify({
            school: req.schoolId, sender: req.userId, senderRole: 'school_admin',
            title: 'Your video was rejected',
            body: `"${v.title}" was not approved. ${req.body.reason || ''}`.trim(),
            recipients: [v.createdBy],
            link: { type: 'video.mine', entityId: v._id },
        });
        ok(res, { rejected: true });
    } catch (e) { fail(res, e); }
};

// ── School playlists ──────────────────────────────────────────────────────────
exports.listPlaylists = async (req, res) => {
    try {
        ok(res, await VideoPlaylist.find({ scope: 'school', school: req.schoolId, isDeleted: false }).sort('-createdAt').lean());
    } catch (e) { fail(res, e); }
};
exports.createPlaylist = async (req, res) => {
    try {
        if (!req.body.title) return bad(res, 'Title is required');
        const p = await VideoPlaylist.create({
            scope: 'school', school: req.schoolId, title: req.body.title, slug: slugify(req.body.title),
            description: req.body.description || '', status: req.body.status || 'published',
            teacherAssigned: req.body.teacherAssigned || null, createdBy: req.userId,
        });
        if (Array.isArray(req.body.videoIds)) {
            const rows = req.body.videoIds.map((vid, i) => ({ playlist: p._id, video: vid, sequence: i, addedBy: req.userId }));
            if (rows.length) await VideoPlaylistItem.insertMany(rows, { ordered: false }).catch(() => {});
            await VideoPlaylist.updateOne({ _id: p._id }, { $set: { videoCount: rows.length } });
        }
        if (req.body.taxonomy) await applyTaxonomy('playlist', p._id, req.body.taxonomy);
        await audit(req, 'created', 'playlist', p._id, `Created school playlist "${p.title}"`);
        ok(res, p);
    } catch (e) { fail(res, e); }
};

// ── Assignments ───────────────────────────────────────────────────────────────
exports.createAssignment = async (req, res) => {
    try {
        const doc = await createAssignment({
            schoolId: req.schoolId, actor: { id: req.userId, role: 'school_admin' },
            senderRef: req.userId, body: req.body,
        });
        await audit(req, 'assigned', 'assignment', doc._id, `Assigned "${doc.title}" to ${doc.recipientCount} student(s)`);
        ok(res, doc);
    } catch (e) { fail(res, e); }
};

exports.listAssignments = async (req, res) => {
    try {
        const filter = { school: req.schoolId, isDeleted: false };
        if (req.query.status) filter.status = req.query.status;
        const items = await VideoAssignment.find(filter).sort('-createdAt')
            .populate('assignedBy', 'name role').populate('class', 'name').lean();
        ok(res, items);
    } catch (e) { fail(res, e); }
};

exports.deleteAssignment = async (req, res) => {
    try {
        await VideoAssignment.updateOne({ _id: req.params.id, school: req.schoolId }, { $set: { isDeleted: true, status: 'archived' } });
        await audit(req, 'deleted', 'assignment', req.params.id);
        ok(res, { deleted: true });
    } catch (e) { fail(res, e); }
};

// ── Analytics / reports ───────────────────────────────────────────────────────
exports.getOverview = async (req, res) => {
    try {
        const schoolId = req.schoolId;
        const [enabledCount, assignmentCount, pendingApprovals] = await Promise.all([
            SchoolVideo.countDocuments({ school: schoolId, enabled: true }),
            VideoAssignment.countDocuments({ school: schoolId, isDeleted: false }),
            Video.countDocuments({ scope: 'school', school: schoolId, approvalStatus: 'pending', isDeleted: false }),
        ]);
        const completion = await VideoProgress.aggregate([
            { $match: { school: String(schoolId) } },
            { $group: { _id: null, learners: { $sum: 1 }, completed: { $sum: { $cond: ['$completed', 1, 0] } }, avg: { $avg: '$progressPercent' } } },
        ]);
        ok(res, {
            counts: { enabledCount, assignmentCount, pendingApprovals },
            completion: completion[0] || { learners: 0, completed: 0, avg: 0 },
        });
    } catch (e) { fail(res, e); }
};
