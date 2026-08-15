'use strict';
/**
 * Section teacher group chat
 * ──────────────────────────
 * Every section gets one group chat holding exactly its teaching staff:
 *   • the class teacher            (group admin)
 *   • the vice class teacher       (ClassSection.substituteTeacher)
 *   • every subject teacher of that section (SectionSubjectTeacher)
 *
 * syncSectionChatGroup() is idempotent: it creates the group the first time a
 * teacher is attached to the section, then keeps the roster in step whenever
 * teachers are assigned or removed. School admins are not members — they can
 * already observe any chat in their school (chat.controller adminObserver).
 */
const Chat                  = require('../models/Chat');
const ChatMember            = require('../models/ChatMember');
const ClassSection          = require('../models/ClassSection');
const Class                 = require('../models/Class');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const broker                = require('./chatBrokerService');

/** Members the group should have, class teacher first. */
async function resolveTeachers(section) {
    const subjectLinks = await SectionSubjectTeacher.find({ section: section._id }, 'teacher').lean();
    const ids = [
        section.classTeacher,
        section.substituteTeacher,
        ...subjectLinks.map(l => l.teacher),
    ].filter(Boolean).map(String);
    return [...new Set(ids)];
}

async function groupName(section) {
    const cls = await Class.findById(section.class, 'className').lean();
    return `${cls?.className || 'Class'} – ${section.sectionName} Teachers`;
}

/**
 * Create or update the section's teacher group.
 * @returns {Promise<Object|null>} the chat document, or null when the section
 *          has no teachers yet (nothing to create).
 */
async function syncSectionChatGroup(sectionId, schoolId, actingUserId = null) {
    const section = await ClassSection.findOne({ _id: sectionId, school: schoolId }).lean();
    if (!section) return null;

    const teacherIds = await resolveTeachers(section);
    let chat = await Chat.findOne({ school: schoolId, classSection: section._id, type: 'group' }).lean();

    if (!chat) {
        if (!teacherIds.length) return null;           // nothing to chat about yet
        const created = await Chat.create({
            school:       schoolId,
            type:         'group',
            name:         await groupName(section),
            description:  'Class teacher, vice class teacher and subject teachers of this section.',
            createdBy:    actingUserId || section.classTeacher || teacherIds[0],
            classSection: section._id,
            lastActivity: new Date(),
        });
        chat = created.toObject ? created.toObject() : created;
    } else {
        const name = await groupName(section);
        if (name !== chat.name) {
            await Chat.findByIdAndUpdate(chat._id, { name });
            chat.name = name;
        }
    }

    const existing = await ChatMember.find({ chat: chat._id }).lean();
    const byUser   = new Map(existing.map(m => [String(m.user), m]));
    const wanted   = new Set(teacherIds);

    // Add / reactivate
    for (const uid of teacherIds) {
        const role = String(uid) === String(section.classTeacher) ? 'admin' : 'member';
        const row  = byUser.get(uid);
        if (!row) {
            await ChatMember.create({ chat: chat._id, user: uid, school: schoolId, role });
            await broker.publishMembership('join', uid, chat._id).catch(() => {});
        } else if (!row.isActive || row.role !== role) {
            await ChatMember.findByIdAndUpdate(row._id, { isActive: true, role });
            if (!row.isActive) await broker.publishMembership('join', uid, chat._id).catch(() => {});
        }
    }

    // Drop teachers who left the section (soft-delete keeps their history)
    for (const row of existing) {
        if (wanted.has(String(row.user)) || !row.isActive) continue;
        await ChatMember.findByIdAndUpdate(row._id, { isActive: false });
        await broker.publishMembership('leave', row.user, chat._id).catch(() => {});
    }

    return { ...chat, memberCount: teacherIds.length };
}

module.exports = { syncSectionChatGroup };
