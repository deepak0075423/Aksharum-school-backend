'use strict';
/**
 * Chat Permission Engine
 * ─────────────────────
 * Single source of truth for all "can A talk to B?" decisions.
 * Controllers and socket handlers MUST call this; no role checks elsewhere.
 *
 * Academic relationship graph:
 *   ClassSection.classTeacher       → class teacher user FK
 *   ClassSection.substituteTeacher  → vice-class-teacher user FK
 *   SectionSubjectTeacher.teacher   → subject teacher user FK per section
 *   StudentProfile.currentSection   → section FK
 *   ParentProfile.children          → [student user FKs]
 */

const User                 = require('../models/User');
const StudentProfile       = require('../models/StudentProfile');
const TeacherProfile       = require('../models/TeacherProfile');
const ParentProfile        = require('../models/ParentProfile');
const ClassSection         = require('../models/ClassSection');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine whether senderId may open/send a direct message to receiverId.
 * Returns { allowed: Boolean, reason: String }
 */
async function canMessage(senderId, senderRole, receiverId, receiverRole, schoolId) {
    if (String(senderId) === String(receiverId)) {
        return { allowed: false, reason: 'Cannot message yourself' };
    }

    // Admins can reach anyone in the same school (or any school for super_admin)
    if (senderRole === 'super_admin' || senderRole === 'school_admin') {
        return { allowed: true };
    }

    // Verify receiver is in the same school (skip for admins who are school-global)
    if (!['school_admin', 'super_admin'].includes(receiverRole)) {
        const rx = await User.findOne({ _id: receiverId, school: schoolId, isActive: true })
            .select('_id').lean();
        if (!rx) return { allowed: false, reason: 'User not found in your school' };
    }

    switch (senderRole) {
        case 'teacher': return _teacherCanMessage(senderId, receiverId, receiverRole, schoolId);
        case 'student': return _studentCanMessage(senderId, receiverId, receiverRole, schoolId);
        case 'parent':  return _parentCanMessage(senderId, receiverId, receiverRole, schoolId);
        default:        return { allowed: false, reason: 'Unknown role' };
    }
}

/**
 * Return all User documents that userId is allowed to start a direct chat with.
 * Used to populate the "New Chat" contact picker.
 */
async function getAllowedContacts(userId, userRole, schoolId) {
    if (userRole === 'super_admin' || userRole === 'school_admin') {
        return User.find({ school: schoolId, _id: { $ne: userId }, isActive: true })
            .select('name role email profileImage').lean();
    }
    switch (userRole) {
        case 'teacher': return _teacherContacts(userId, schoolId);
        case 'student': return _studentContacts(userId, schoolId);
        case 'parent':  return _parentContacts(userId, schoolId);
        default:        return [];
    }
}

/**
 * Return candidate User documents for adding to a group.
 * Same permission rules as direct chat.
 */
async function getGroupCandidates(creatorId, creatorRole, schoolId) {
    return getAllowedContacts(creatorId, creatorRole, schoolId);
}

/** Only admin-level roles and teachers may create groups. */
function canCreateGroup(userRole) {
    return ['super_admin', 'school_admin', 'teacher'].includes(userRole);
}

// ─── Teacher rules ────────────────────────────────────────────────────────────

async function _teacherCanMessage(teacherId, receiverId, receiverRole, schoolId) {
    if (receiverRole === 'school_admin' || receiverRole === 'super_admin') return { allowed: true };
    if (receiverRole === 'teacher')      return { allowed: true };

    if (receiverRole === 'student') {
        return _teacherStudentAllowed(teacherId, receiverId, schoolId);
    }

    if (receiverRole === 'parent') {
        const pp = await ParentProfile.findOne({ user: receiverId, school: schoolId })
            .select('children').lean();
        if (!pp || !pp.children.length) {
            return { allowed: false, reason: 'Parent has no linked students' };
        }
        for (const childId of pp.children) {
            const r = await _teacherStudentAllowed(teacherId, childId, schoolId);
            if (r.allowed) return { allowed: true };
        }
        return { allowed: false, reason: "You don't teach this parent's children" };
    }

    return { allowed: false, reason: 'Not allowed' };
}

/**
 * Core predicate: can teacher send a message to student?
 * True when:
 *   1. Teacher is the classTeacher of the student's section, OR
 *   2. Teacher is the substituteTeacher (vice class teacher), OR
 *   3. Teacher has an entry in SectionSubjectTeacher for that section.
 */
async function _teacherStudentAllowed(teacherId, studentId, schoolId) {
    const sp = await StudentProfile.findOne({ user: studentId, school: schoolId })
        .select('currentSection').lean();
    if (!sp || !sp.currentSection) {
        return { allowed: false, reason: 'Student has no section assigned' };
    }

    const sectionId = sp.currentSection;

    const section = await ClassSection.findOne({ _id: sectionId, school: schoolId })
        .select('classTeacher substituteTeacher').lean();
    if (section) {
        if (String(section.classTeacher) === String(teacherId))   return { allowed: true };
        if (section.substituteTeacher &&
            String(section.substituteTeacher) === String(teacherId)) return { allowed: true };
    }

    const sst = await SectionSubjectTeacher.findOne({
        section: sectionId,
        teacher: teacherId,
    }).lean();
    if (sst) return { allowed: true };

    return { allowed: false, reason: "You don't teach this student's class" };
}

// ─── Student rules ────────────────────────────────────────────────────────────

async function _studentCanMessage(studentId, receiverId, receiverRole, schoolId) {
    if (receiverRole === 'school_admin' || receiverRole === 'super_admin') return { allowed: true };

    if (receiverRole !== 'teacher') {
        return { allowed: false, reason: 'Students can only message their teachers or admin' };
    }

    // Reuse the teacher→student check (symmetric: student can message a teacher
    // iff that teacher is allowed to message that student)
    const r = await _teacherStudentAllowed(receiverId, studentId, schoolId);
    return r.allowed
        ? { allowed: true }
        : { allowed: false, reason: 'This teacher does not teach your class' };
}

// ─── Parent rules ─────────────────────────────────────────────────────────────

async function _parentCanMessage(parentId, receiverId, receiverRole, schoolId) {
    if (receiverRole === 'school_admin' || receiverRole === 'super_admin') return { allowed: true };

    if (receiverRole !== 'teacher') {
        return { allowed: false, reason: "Parents can only message their children's teachers or admin" };
    }

    const pp = await ParentProfile.findOne({ user: parentId, school: schoolId })
        .select('children').lean();
    if (!pp || !pp.children.length) {
        return { allowed: false, reason: 'No children linked to your account' };
    }

    for (const childId of pp.children) {
        const r = await _teacherStudentAllowed(receiverId, childId, schoolId);
        if (r.allowed) return { allowed: true };
    }

    return { allowed: false, reason: "This teacher does not teach your children" };
}

// ─── Contact list builders ────────────────────────────────────────────────────

async function _teacherContacts(teacherId, schoolId) {
    const contacts = new Map();

    // All other teachers in this school
    const teachers = await User.find({
        school: schoolId, role: 'teacher',
        _id: { $ne: teacherId }, isActive: true,
    }).select('name role email profileImage').lean();
    teachers.forEach(t => contacts.set(String(t._id), t));

    // Admins
    const admins = await User.find({ school: schoolId, role: 'school_admin', isActive: true })
        .select('name role email profileImage').lean();
    admins.forEach(a => contacts.set(String(a._id), a));

    // Sections this teacher owns (classTeacher / substituteTeacher)
    const ownedSections = await ClassSection.find({
        school: schoolId,
        $or: [{ classTeacher: teacherId }, { substituteTeacher: teacherId }],
    }).select('enrolledStudents').lean();

    // Sections this teacher teaches as subject teacher
    const sstRows = await SectionSubjectTeacher.find({ teacher: teacherId })
        .populate({ path: 'section', select: 'enrolledStudents school', match: { school: schoolId } })
        .lean();

    const studentIds = new Set();
    ownedSections.forEach(s => s.enrolledStudents.forEach(id => studentIds.add(String(id))));
    sstRows.forEach(r => {
        if (r.section) r.section.enrolledStudents.forEach(id => studentIds.add(String(id)));
    });

    if (studentIds.size) {
        const students = await User.find({ _id: { $in: [...studentIds] }, isActive: true })
            .select('name role email profileImage').lean();
        students.forEach(s => contacts.set(String(s._id), s));

        // Parents of those students
        const sps = await StudentProfile.find({
            user: { $in: [...studentIds] }, school: schoolId,
        }).select('parent').lean();
        const parentIds = sps.filter(sp => sp.parent).map(sp => sp.parent);
        if (parentIds.length) {
            const parents = await User.find({ _id: { $in: parentIds }, isActive: true })
                .select('name role email profileImage').lean();
            parents.forEach(p => contacts.set(String(p._id), p));
        }
    }

    return [...contacts.values()];
}

async function _studentContacts(studentId, schoolId) {
    const sp = await StudentProfile.findOne({ user: studentId, school: schoolId })
        .select('currentSection').lean();
    if (!sp || !sp.currentSection) return [];

    const section = await ClassSection.findOne({ _id: sp.currentSection, school: schoolId })
        .select('classTeacher substituteTeacher').lean();

    const teacherIds = new Set();
    if (section) {
        if (section.classTeacher)      teacherIds.add(String(section.classTeacher));
        if (section.substituteTeacher) teacherIds.add(String(section.substituteTeacher));
    }

    const ssts = await SectionSubjectTeacher.find({ section: sp.currentSection }).select('teacher').lean();
    ssts.forEach(r => teacherIds.add(String(r.teacher)));

    const contacts = await User.find({ school: schoolId, role: 'school_admin', isActive: true })
        .select('name role email profileImage').lean();

    if (teacherIds.size) {
        const teachers = await User.find({ _id: { $in: [...teacherIds] }, isActive: true })
            .select('name role email profileImage').lean();
        contacts.push(...teachers);
    }

    return contacts;
}

async function _parentContacts(parentId, schoolId) {
    const pp = await ParentProfile.findOne({ user: parentId, school: schoolId })
        .select('children').lean();
    if (!pp || !pp.children.length) return [];

    // One batched round trip per collection instead of up to 3 per child.
    const profiles = await StudentProfile.find({ user: { $in: pp.children }, school: schoolId })
        .select('currentSection').lean();
    const sectionIds = profiles.map((sp) => sp.currentSection).filter(Boolean);

    const teacherIds = new Set();
    if (sectionIds.length) {
        const [sections, ssts] = await Promise.all([
            ClassSection.find({ _id: { $in: sectionIds }, school: schoolId })
                .select('classTeacher substituteTeacher').lean(),
            SectionSubjectTeacher.find({ section: { $in: sectionIds } }).select('teacher').lean(),
        ]);
        for (const section of sections) {
            if (section.classTeacher)      teacherIds.add(String(section.classTeacher));
            if (section.substituteTeacher) teacherIds.add(String(section.substituteTeacher));
        }
        ssts.forEach((r) => teacherIds.add(String(r.teacher)));
    }

    const contacts = await User.find({ school: schoolId, role: 'school_admin', isActive: true })
        .select('name role email profileImage').lean();

    if (teacherIds.size) {
        const teachers = await User.find({ _id: { $in: [...teacherIds] }, isActive: true })
            .select('name role email profileImage').lean();
        contacts.push(...teachers);
    }

    return contacts;
}

module.exports = {
    canMessage,
    getAllowedContacts,
    getGroupCandidates,
    canCreateGroup,
    _teacherStudentAllowed, // exported for testing
};
