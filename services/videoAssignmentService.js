'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  videoAssignmentService — the one place assignments are created, so School
//  Admins, Class Teachers and Subject Teachers all produce identical, correctly
//  targeted VideoAssignment rows. Resolves the audience (class / section /
//  selected students / group) into a stable snapshot of student user-ids and
//  fans out notifications.
// ─────────────────────────────────────────────────────────────────────────────
const VideoAssignment = require('../models/VideoAssignment');
const StudentProfile  = require('../models/StudentProfile');
const ClassSection    = require('../models/ClassSection');
const { nextCode } = require('./videoHelpers');
const { notify, withParents } = require('./notifyService');

// Resolve target student user-ids from the assignment target definition.
async function resolveRecipients({ schoolId, targetType, classId, sectionId, students }) {
    if (targetType === 'students' || targetType === 'group') {
        return [...new Set((students || []).map(String))];
    }
    if (targetType === 'section') {
        if (!sectionId) return [];
        const profs = await StudentProfile.find({ school: schoolId, classSection: sectionId }, 'user').lean();
        return profs.map((p) => String(p.user)).filter(Boolean);
    }
    if (targetType === 'class') {
        if (!classId) return [];
        const sections = await ClassSection.find({ school: schoolId, class: classId }, '_id').lean();
        const secIds = sections.map((s) => s._id);
        const profs = await StudentProfile.find({ school: schoolId, classSection: { $in: secIds } }, 'user').lean();
        return profs.map((p) => String(p.user)).filter(Boolean);
    }
    return [];
}

// Create an assignment. `actor` = { id, role } (role: school_admin|class_teacher|subject_teacher|teacher).
async function createAssignment({ schoolId, actor, senderRef, body }) {
    const contentType = body.contentType;
    if (!['video', 'multiple', 'playlist', 'course'].includes(contentType)) throw new Error('Invalid contentType');
    if (!body.title) throw new Error('Title is required');
    if (!['class', 'section', 'students', 'group'].includes(body.targetType)) throw new Error('Invalid targetType');

    const recipients = await resolveRecipients({
        schoolId, targetType: body.targetType,
        classId: body.class, sectionId: body.section, students: body.students,
    });

    const now = new Date();
    const startDate = body.startDate ? new Date(body.startDate) : now;
    const status = startDate > now ? 'scheduled' : 'active';

    const doc = await VideoAssignment.create({
        school: schoolId,
        assignmentCode: await nextCode(VideoAssignment, { school: schoolId }, 'VA'),
        title: body.title, instructions: body.instructions || '',
        assignedBy: actor.id, assignedByRole: actor.role,
        contentType,
        videos: contentType === 'video' || contentType === 'multiple'
            ? (Array.isArray(body.videos) ? body.videos : (body.video ? [body.video] : [])) : [],
        playlist: contentType === 'playlist' ? body.playlist : null,
        course:   contentType === 'course'   ? body.course   : null,
        targetType: body.targetType,
        class: body.class || null, section: body.section || null, subject: body.subject || null,
        groupTag: body.groupTag || '',
        students: recipients,
        startDate, endDate: body.endDate ? new Date(body.endDate) : null,
        visibilityDate: body.visibilityDate ? new Date(body.visibilityDate) : null,
        expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
        mandatory: !!body.mandatory,
        minWatchPercent: body.minWatchPercent != null ? Number(body.minWatchPercent) : 80,
        maxAttempts: Number(body.maxAttempts) || 0,
        watchLimitPerDay: Number(body.watchLimitPerDay) || 0,
        allowDownload: !!body.allowDownload,
        allowPlaybackSpeed: body.allowPlaybackSpeed !== false,
        isPinned: !!body.isPinned,
        notifyOnAssign: body.notifyOnAssign !== false,
        status,
        recipientCount: recipients.length,
    });

    // fan out notification to students (+ parents, future) when active & requested
    if (doc.notifyOnAssign && status === 'active' && recipients.length) {
        const audience = await withParents(recipients).catch(() => recipients);
        notify({
            school: schoolId, sender: senderRef, senderRole: actor.role,
            title: 'New learning video assigned',
            body: `${doc.title} — ${recipients.length} student(s)`,
            recipients: audience,
        });
    }
    return doc;
}

module.exports = { createAssignment, resolveRecipients };
