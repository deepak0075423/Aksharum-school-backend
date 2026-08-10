'use strict';
// ═════════════════════════════════════════════════════════════════════════════
//  Video Learning — Teacher controller (Class / Vice-Class / Subject Teacher)
//  Route base: /api/video/teacher/*
//  Guard: requireRole('teacher') + requireModule('videoLibrary')
//
//  Teachers CANNOT upload S3 media — only YouTube/Vimeo links, which enter the
//  approval workflow. Class teachers control their sections; subject teachers
//  are restricted to sections+subjects they teach (enforced via resolveTeacherScope).
// ═════════════════════════════════════════════════════════════════════════════
const Video           = require('../models/Video');
const SchoolVideo     = require('../models/SchoolVideo');
const VideoSetting    = require('../models/VideoSetting');
const VideoAssignment = require('../models/VideoAssignment');
const VideoProgress   = require('../models/VideoProgress');
const VideoPlaylist   = require('../models/VideoPlaylist');

const storage = require('../services/videoStorage');
const { slugify, resolveTeacherScope } = require('../services/videoAccess');
const { notify, schoolAdminIds } = require('../services/notifyService');
const { createAssignment } = require('../services/videoAssignmentService');
const { ok, bad, fail, audit, applyTaxonomy, getTaxonomyForMany } = require('../services/videoHelpers');

// Return the teacher's effective scope (used by the UI to constrain pickers).
exports.getScope = async (req, res) => {
    try { ok(res, await resolveTeacherScope(req.userId, req.schoolId)); } catch (e) { fail(res, e); }
};

// Catalogue available to a teacher: master videos enabled by the school +
// approved school videos. Filterable; taxonomy attached for display.
exports.getCatalog = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(60, parseInt(req.query.limit) || 24);

        // enabled master video ids for this school
        const enabled = await SchoolVideo.find({ school: req.schoolId, enabled: true }, 'video').lean();
        const enabledIds = enabled.map((e) => String(e.video));

        const or = [
            { _id: { $in: enabledIds }, scope: 'master', status: 'published' },
            { scope: 'school', school: req.schoolId, approvalStatus: 'approved', status: 'published' },
        ];
        const filter = { isDeleted: false, $or: or };
        if (req.query.category) filter.category = req.query.category;
        if (req.query.search)   filter.title = { $regex: req.query.search, $options: 'i' };

        const [items, total] = await Promise.all([
            Video.find(filter).sort('-publishedAt').skip((page - 1) * limit).limit(limit).lean(),
            Video.countDocuments(filter),
        ]);
        const taxMap = await getTaxonomyForMany('video', items.map((v) => v._id));
        for (const v of items) v.taxonomy = taxMap.get(String(v._id)) || {};
        ok(res, { items, total, page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};

// Teacher adds a YouTube/Vimeo link → enters approval workflow.
exports.addLinkVideo = async (req, res) => {
    try {
        const settings = await VideoSetting.findOne({ school: req.schoolId }).lean() || {};
        if (settings.teacherUploadEnabled === false) return bad(res, 'Teacher uploads are disabled for your school', 403);

        const parsed = storage.parseProvider(req.body.sourceUrl);
        if (!parsed) return bad(res, 'Provide a valid YouTube or Vimeo URL');
        const allowed = settings.allowedTeacherSources || ['youtube', 'vimeo'];
        if (!allowed.includes(parsed.source)) return bad(res, `${parsed.source} links are not allowed`);

        const requiresApproval = settings.teacherUploadRequiresApproval !== false;
        const v = await Video.create({
            scope: 'school', school: req.schoolId, source: parsed.source,
            providerId: parsed.providerId, sourceUrl: parsed.sourceUrl,
            title: req.body.title || 'Untitled', shortDescription: req.body.shortDescription || '',
            longDescription: req.body.longDescription || '', category: req.body.category || 'concept_explanation',
            difficulty: req.body.difficulty || 'beginner', language: req.body.language || 'English',
            slug: slugify(req.body.title || `t-${Date.now()}`),
            createdBy: req.userId,
            approvalStatus: requiresApproval ? 'pending' : 'approved',
            status: requiresApproval ? 'draft' : 'published',
            publishedAt: requiresApproval ? null : new Date(),
            visibility: 'restricted',
        });
        if (req.body.taxonomy) await applyTaxonomy('video', v._id, req.body.taxonomy);
        await audit(req, 'created', 'video', v._id, `Teacher added ${parsed.source} video`);

        if (requiresApproval) {
            const admins = await schoolAdminIds(req.schoolId);
            notify({
                school: req.schoolId, sender: req.userId, senderRole: 'teacher',
                title: 'Video pending approval', body: `A teacher submitted "${v.title}" for approval.`,
                recipients: admins,
            });
        }
        ok(res, { ...v.toObject?.() || v, requiresApproval });
    } catch (e) { fail(res, e); }
};

exports.myVideos = async (req, res) => {
    try {
        ok(res, await Video.find({ scope: 'school', school: req.schoolId, createdBy: req.userId, isDeleted: false })
            .sort('-createdAt').lean());
    } catch (e) { fail(res, e); }
};

// Create an assignment, scoped to the teacher's authority.
exports.createAssignment = async (req, res) => {
    try {
        const scope = await resolveTeacherScope(req.userId, req.schoolId);
        const body = req.body;

        // Determine the teacher's effective role for this target and authorize it.
        let role = null;
        if (['section', 'group', 'students'].includes(body.targetType) || body.section) {
            const sec = String(body.section || '');
            if (scope.classSectionIds.includes(sec)) role = 'class_teacher';
            else if (scope.subjectSectionIds.includes(sec)) {
                if (!body.subject || !scope.subjectIds.includes(String(body.subject))) {
                    return bad(res, 'Subject teachers must assign within their own subject', 403);
                }
                role = 'subject_teacher';
            }
        } else if (body.targetType === 'class') {
            return bad(res, 'Teachers assign by section or students, not whole class', 400);
        }
        if (!role && body.targetType === 'students' && body.students?.length) {
            // curated student list without a section → allow only if the teacher owns any section
            role = scope.isClassTeacher ? 'class_teacher' : (scope.subjectIds.length ? 'subject_teacher' : null);
        }
        if (!role) return bad(res, 'You are not authorized to assign to this target', 403);

        const doc = await createAssignment({
            schoolId: req.schoolId, actor: { id: req.userId, role },
            senderRef: req.userId, body,
        });
        await audit(req, 'assigned', 'assignment', doc._id, `Assigned "${doc.title}" (${role}) to ${doc.recipientCount} student(s)`);
        ok(res, doc);
    } catch (e) { fail(res, e); }
};

exports.myAssignments = async (req, res) => {
    try {
        const filter = { school: req.schoolId, assignedBy: req.userId, isDeleted: false };
        if (req.query.status) filter.status = req.query.status;
        ok(res, await VideoAssignment.find(filter).sort('-createdAt').populate('section', 'sectionName').lean());
    } catch (e) { fail(res, e); }
};

exports.deleteAssignment = async (req, res) => {
    try {
        const a = await VideoAssignment.findOne({ _id: req.params.id, school: req.schoolId, assignedBy: req.userId });
        if (!a) return bad(res, 'Assignment not found', 404);
        await VideoAssignment.updateOne({ _id: a._id }, { $set: { isDeleted: true, status: 'archived' } });
        await audit(req, 'deleted', 'assignment', a._id);
        ok(res, { deleted: true });
    } catch (e) { fail(res, e); }
};

// Student progress for one of the teacher's assignments.
exports.getAssignmentProgress = async (req, res) => {
    try {
        const a = await VideoAssignment.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!a) return bad(res, 'Assignment not found', 404);
        const videoIds = a.videos?.length ? a.videos.map(String) : [];
        const progress = await VideoProgress.find({
            assignment: a._id,
        }).populate('student', 'name').lean();
        const summary = {
            recipients: a.recipientCount,
            started: progress.length,
            completed: progress.filter((p) => p.completed).length,
            avgPercent: progress.length ? Math.round(progress.reduce((s, p) => s + p.progressPercent, 0) / progress.length) : 0,
        };
        ok(res, { assignment: a, summary, progress });
    } catch (e) { fail(res, e); }
};

// Playlists a teacher owns / created.
exports.myPlaylists = async (req, res) => {
    try {
        ok(res, await VideoPlaylist.find({
            scope: 'school', school: req.schoolId,
            $or: [{ createdBy: req.userId }, { teacherAssigned: req.userId }], isDeleted: false,
        }).sort('-createdAt').lean());
    } catch (e) { fail(res, e); }
};
