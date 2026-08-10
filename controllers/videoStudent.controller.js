'use strict';
// ═════════════════════════════════════════════════════════════════════════════
//  Video Learning — Student controller
//  Route base: /api/video/student/*
//  Guard: requireRole('student') + requireModule('videoLibrary')
//
//  Students consume content: dashboard (continue watching / assigned / recent /
//  recommended), a secure per-user playback URL, resume + progress reporting,
//  telemetry events, and interactions (like / bookmark / favorite / note /
//  report). Every playback URL is authorized here — a student can only ever
//  play a video that is assigned to them or enabled+visible for their school.
// ═════════════════════════════════════════════════════════════════════════════
const path = require('path');
const fs   = require('fs');
const Video           = require('../models/Video');
const SchoolVideo     = require('../models/SchoolVideo');
const VideoAssignment = require('../models/VideoAssignment');
const VideoProgress   = require('../models/VideoProgress');
const VideoWatchEvent = require('../models/VideoWatchEvent');
const VideoInteraction= require('../models/VideoInteraction');
const VideoSetting    = require('../models/VideoSetting');
const StudentProfile  = require('../models/StudentProfile');

const storage = require('../services/videoStorage');
const { ok, bad, fail, audit, getTaxonomyForMany } = require('../services/videoHelpers');

// Resolve the assignments that currently target this student (visible + active).
async function myAssignments(studentId, schoolId) {
    const now = new Date();
    return VideoAssignment.find({
        school: schoolId, students: studentId, isDeleted: false,
        status: { $in: ['active', 'scheduled'] },
    }).sort('-isPinned -createdAt').lean().then((rows) => rows.filter((a) => {
        if (a.visibilityDate && new Date(a.visibilityDate) > now) return false;
        if (a.expiryDate && new Date(a.expiryDate) < now) return false;
        return true;
    }));
}

// Can this student access this video right now? Returns { video, assignment } or null.
async function authorizeVideo(studentId, schoolId, videoId) {
    const video = await Video.findById(videoId).lean();
    if (!video || video.isDeleted) return null;

    // 1) assigned to the student → always allowed
    const assignment = await VideoAssignment.findOne({
        school: schoolId, students: studentId, isDeleted: false,
        $or: [{ videos: videoId }],
    }).lean();
    if (assignment) return { video, assignment };

    // 2) school-enabled + published master video (self-serve library)
    if (video.scope === 'master' && video.status === 'published') {
        const sv = await SchoolVideo.findOne({ school: schoolId, video: videoId, enabled: true }).lean();
        if (sv && sv.visibility !== 'hidden') return { video, assignment: null };
    }
    // 3) approved school video
    if (video.scope === 'school' && String(video.school) === String(schoolId)
        && video.approvalStatus === 'approved' && video.status === 'published') {
        return { video, assignment: null };
    }
    return null;
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
exports.getDashboard = async (req, res) => {
    try {
        const sid = String(req.userId), schoolId = req.schoolId;
        const assignments = await myAssignments(sid, schoolId);

        // videos referenced by assignments
        const assignedVideoIds = [...new Set(assignments.flatMap((a) => (a.videos || []).map(String)))];
        const assignedVideos = assignedVideoIds.length
            ? await Video.find({ _id: { $in: assignedVideoIds }, isDeleted: false }, 'title thumbnailUrl durationSec source category').lean()
            : [];

        // continue watching (in-progress, not completed)
        const inProgress = await VideoProgress.find({ student: sid, completed: false, watchedSeconds: { $gt: 0 } })
            .sort('-lastWatchedAt').limit(12)
            .populate('video', 'title thumbnailUrl durationSec source category').lean();

        // recently added (school-enabled published master + approved school)
        const enabled = await SchoolVideo.find({ school: schoolId, enabled: true }, 'video').lean();
        const recent = await Video.find({
            isDeleted: false,
            $or: [
                { _id: { $in: enabled.map((e) => e.video) }, scope: 'master', status: 'published' },
                { scope: 'school', school: schoolId, approvalStatus: 'approved', status: 'published' },
            ],
        }, 'title thumbnailUrl durationSec source category publishedAt').sort('-publishedAt').limit(12).lean();

        // completed / pending counts
        const [completedCount, favorites] = await Promise.all([
            VideoProgress.countDocuments({ student: sid, completed: true }),
            VideoInteraction.countDocuments({ user: sid, type: 'favorite', active: true }),
        ]);

        ok(res, {
            assignments: assignments.map((a) => ({
                _id: a._id, title: a.title, contentType: a.contentType, mandatory: a.mandatory,
                endDate: a.endDate, minWatchPercent: a.minWatchPercent, isPinned: a.isPinned,
                videos: (a.videos || []).map(String),
            })),
            assignedVideos, continueWatching: inProgress, recentlyAdded: recent,
            stats: { assigned: assignedVideoIds.length, completed: completedCount, favorites },
        });
    } catch (e) { fail(res, e); }
};

// A student "shelf" list by kind: assigned | completed | pending | favorites | watch_later | bookmarks | history
exports.getShelf = async (req, res) => {
    try {
        const sid = String(req.userId), schoolId = req.schoolId;
        const kind = req.query.kind || 'assigned';

        if (kind === 'favorites' || kind === 'watch_later' || kind === 'bookmarks') {
            const typeMap = { favorites: 'favorite', watch_later: 'watch_later', bookmarks: 'bookmark' };
            const rows = await VideoInteraction.find({ user: sid, type: typeMap[kind], active: true })
                .sort('-updatedAt').populate('video', 'title thumbnailUrl durationSec source category').lean();
            return ok(res, rows.map((r) => ({ ...r.video, timestampSec: r.timestampSec, note: r.note })));
        }
        if (kind === 'completed' || kind === 'history') {
            const q = { student: sid };
            if (kind === 'completed') q.completed = true;
            const rows = await VideoProgress.find(q).sort('-lastWatchedAt').limit(60)
                .populate('video', 'title thumbnailUrl durationSec source category').lean();
            return ok(res, rows.map((r) => ({ ...r.video, progressPercent: r.progressPercent, completed: r.completed })));
        }
        // assigned / pending
        const assignments = await myAssignments(sid, schoolId);
        const ids = [...new Set(assignments.flatMap((a) => (a.videos || []).map(String)))];
        const videos = ids.length ? await Video.find({ _id: { $in: ids }, isDeleted: false }).lean() : [];
        const prog = await VideoProgress.find({ student: sid, video: { $in: ids } }, 'video completed progressPercent').lean();
        const pmap = new Map(prog.map((p) => [String(p.video), p]));
        let out = videos.map((v) => ({ ...v, progress: pmap.get(String(v._id)) || null }));
        if (kind === 'pending') out = out.filter((v) => !v.progress || !v.progress.completed);
        return ok(res, out);
    } catch (e) { fail(res, e); }
};

// ── PLAYER: authorized detail + secure playback URL ───────────────────────────
exports.getPlayer = async (req, res) => {
    try {
        const authz = await authorizeVideo(String(req.userId), req.schoolId, req.params.id);
        if (!authz) return bad(res, 'You do not have access to this video', 403);
        const { video, assignment } = authz;

        const playback = await storage.getPlaybackUrl(video, req.user);
        const [progress, taxMap, myInteractions, settings, profile] = await Promise.all([
            VideoProgress.findOne({ student: req.userId, video: video._id, assignment: assignment?._id || null }).lean(),
            getTaxonomyForMany('video', [video._id]),
            VideoInteraction.find({ user: req.userId, video: video._id }).lean(),
            VideoSetting.findOne({ school: req.schoolId }).lean(),
            StudentProfile.findOne({ user: req.userId }, 'admissionNumber').lean(),
        ]);

        // policy: download / speed / watermark come from assignment ∪ school settings ∪ video
        const policy = {
            allowDownload: (assignment?.allowDownload ?? false) && (settings?.allowStudentDownload ?? false) && video.downloadAllowed,
            allowPlaybackSpeed: (assignment?.allowPlaybackSpeed ?? true) && (settings?.allowPlaybackSpeed ?? true),
            watermark: (settings?.watermarkEnabled ?? true) && video.watermarkEnabled,
            watermarkText: settings?.watermarkText || `${req.user.name} • ${profile?.admissionNumber || req.userId}`,
            antiScreenRecordingHint: settings?.antiScreenRecordingHint ?? true,
            minWatchPercent: assignment?.minWatchPercent ?? 0,
            maxAttempts: assignment?.maxAttempts ?? 0,
        };

        const like = myInteractions.find((i) => i.type === 'like' && i.active);
        const fav  = myInteractions.find((i) => i.type === 'favorite' && i.active);
        const watchLater = myInteractions.find((i) => i.type === 'watch_later' && i.active);
        const bookmarks = myInteractions.filter((i) => i.type === 'bookmark').map((b) => ({ _id: b._id, timestampSec: b.timestampSec, note: b.note }));
        const notes = myInteractions.filter((i) => i.type === 'note').map((n) => ({ _id: n._id, timestampSec: n.timestampSec, note: n.note }));

        await audit(req, 'viewed', 'video', video._id, 'Opened player');

        ok(res, {
            video: {
                _id: video._id, title: video.title, shortDescription: video.shortDescription,
                longDescription: video.longDescription, durationSec: video.durationSec, source: video.source,
                category: video.category, difficulty: video.difficulty, transcript: video.transcript,
                learningOutcome: video.learningOutcome, likesCount: video.likesCount,
                taxonomy: taxMap.get(String(video._id)) || {},
            },
            playback, policy,
            assignment: assignment ? { _id: assignment._id, title: assignment.title, minWatchPercent: assignment.minWatchPercent, mandatory: assignment.mandatory } : null,
            resumeAt: progress?.lastPositionSec || 0,
            progressPercent: progress?.progressPercent || 0,
            interactions: { liked: !!like, favorited: !!fav, watchLater: !!watchLater, bookmarks, notes },
        });
    } catch (e) { fail(res, e); }
};

// ── Secure local stream (validates the signed URL from getPlaybackUrl) ────────
exports.streamVideo = async (req, res) => {
    try {
        const { exp, sig } = req.query;
        const okSig = storage.verifyLocal({ userId: String(req.userId), videoId: String(req.params.id), exp, sig });
        if (!okSig) return res.status(403).json({ success: false, message: 'Invalid or expired stream token' });
        const video = await Video.findById(req.params.id, 's3Key source').lean();
        if (!video || video.source !== 's3' || !video.s3Key) return res.status(404).json({ success: false, message: 'Media not found' });

        const filePath = path.join(__dirname, '..', 'uploads', video.s3Key.replace(/^videos\//, 'videos/'));
        if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'File missing' });

        // HTTP range streaming (seek support)
        const stat = fs.statSync(filePath);
        const range = req.headers.range;
        if (range) {
            const [s, e] = range.replace(/bytes=/, '').split('-');
            const start = parseInt(s, 10);
            const end = e ? parseInt(e, 10) : stat.size - 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                'Content-Type': 'video/mp4',
            });
            fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
            fs.createReadStream(filePath).pipe(res);
        }
    } catch (e) { fail(res, e); }
};

// ── PROGRESS: upsert the resume point + completion ─────────────────────────────
exports.reportProgress = async (req, res) => {
    try {
        const { videoId, assignmentId = null, positionSec = 0, watchedDeltaSec = 0, durationSec,
                progressPercent, device, browser, os, network, completed } = req.body;
        if (!videoId) return bad(res, 'videoId required');

        const authz = await authorizeVideo(String(req.userId), req.schoolId, videoId);
        if (!authz) return bad(res, 'Not authorized for this video', 403);

        const now = new Date();
        const existing = await VideoProgress.findOne({ student: req.userId, video: videoId, assignment: assignmentId });
        const dur = durationSec || authz.video.durationSec || 0;
        const pct = progressPercent != null ? Math.min(100, Math.max(0, progressPercent))
                  : (dur ? Math.min(100, Math.round((positionSec / dur) * 100)) : 0);
        const isComplete = completed === true || (authz.assignment ? pct >= (authz.assignment.minWatchPercent || 80) : pct >= 95);

        if (!existing) {
            await VideoProgress.create({
                school: req.schoolId, student: req.userId, video: videoId, assignment: assignmentId,
                watchedSeconds: Math.max(0, watchedDeltaSec), lastPositionSec: positionSec, progressPercent: pct,
                completed: isComplete, completedAt: isComplete ? now : null, attempts: 1,
                firstWatchedAt: now, lastWatchedAt: now, device, browser, os, network,
            });
            await Video.updateOne({ _id: videoId }, { $inc: { viewsCount: 1, uniqueViewsCount: 1 } });
        } else {
            const set = {
                lastPositionSec: positionSec, progressPercent: Math.max(existing.progressPercent, pct),
                lastWatchedAt: now, device, browser, os, network,
            };
            if (isComplete && !existing.completed) { set.completed = true; set.completedAt = now; }
            await VideoProgress.updateOne({ _id: existing._id }, {
                $set: set,
                $inc: { watchedSeconds: Math.max(0, watchedDeltaSec), viewsCount: 0 },
            });
            await Video.updateOne({ _id: videoId }, { $inc: { viewsCount: 1 } });
        }
        ok(res, { saved: true, completed: isComplete, progressPercent: pct });
    } catch (e) { fail(res, e); }
};

// ── TELEMETRY: append raw watch events (batched from the player) ───────────────
exports.reportEvents = async (req, res) => {
    try {
        const events = Array.isArray(req.body.events) ? req.body.events : [];
        if (!events.length) return ok(res, { stored: 0 });
        const rows = events.slice(0, 200).map((ev) => ({
            school: req.schoolId, student: req.userId, video: ev.videoId, assignment: ev.assignmentId || null,
            eventType: ev.eventType, sessionId: ev.sessionId || '', positionSec: ev.positionSec || 0,
            fromSec: ev.fromSec || 0, toSec: ev.toSec || 0, watchedDeltaSec: ev.watchedDeltaSec || 0,
            playbackRate: ev.playbackRate || 1, device: ev.device, browser: ev.browser, os: ev.os,
            network: ev.network, ip: req.headers['x-forwarded-for'] || req.ip || '',
        })).filter((r) => r.video && r.eventType);
        if (rows.length) await VideoWatchEvent.insertMany(rows, { ordered: false }).catch(() => {});
        ok(res, { stored: rows.length });
    } catch (e) { fail(res, e); }
};

// ── INTERACTIONS: like / dislike / favorite / watch_later / bookmark / note / report ──
const TOGGLE = ['like', 'dislike', 'favorite', 'watch_later'];
exports.interact = async (req, res) => {
    try {
        const { videoId, type, timestampSec = 0, note = '', reason = '' } = req.body;
        if (!videoId || !type) return bad(res, 'videoId and type required');
        const authz = await authorizeVideo(String(req.userId), req.schoolId, videoId);
        if (!authz) return bad(res, 'Not authorized for this video', 403);

        if (TOGGLE.includes(type)) {
            const existing = await VideoInteraction.findOne({ user: req.userId, video: videoId, type });
            const active = existing ? !existing.active : true;
            if (existing) await VideoInteraction.updateOne({ _id: existing._id }, { $set: { active } });
            else await VideoInteraction.create({ school: req.schoolId, user: req.userId, video: videoId, type, active: true });

            // keep like/dislike counters + mutual exclusivity
            if (type === 'like' || type === 'dislike') {
                const opposite = type === 'like' ? 'dislike' : 'like';
                await VideoInteraction.updateMany({ user: req.userId, video: videoId, type: opposite, active: true }, { $set: { active: false } });
                const [likes, dislikes] = await Promise.all([
                    VideoInteraction.countDocuments({ video: videoId, type: 'like', active: true }),
                    VideoInteraction.countDocuments({ video: videoId, type: 'dislike', active: true }),
                ]);
                await Video.updateOne({ _id: videoId }, { $set: { likesCount: likes, dislikesCount: dislikes } });
            }
            return ok(res, { type, active });
        }

        // multi types: bookmark / note / share / report
        const doc = await VideoInteraction.create({
            school: req.schoolId, user: req.userId, video: videoId, type,
            timestampSec, note, reportReason: type === 'report' ? reason : '',
            reportStatus: type === 'report' ? 'open' : '',
        });
        if (type === 'report') await audit(req, 'reported', 'video', videoId, reason);
        ok(res, doc);
    } catch (e) { fail(res, e); }
};

exports.deleteInteraction = async (req, res) => {
    try {
        await VideoInteraction.deleteOne({ _id: req.params.id, user: req.userId });
        ok(res, { deleted: true });
    } catch (e) { fail(res, e); }
};
