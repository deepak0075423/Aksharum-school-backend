'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  videoAccess — the RBAC permission matrix for the Video Learning module and a
//  handful of shared helpers.
//
//  The ERP has 5 physical roles (super_admin, school_admin, teacher, student,
//  parent). The spec's finer roles (principal, vice-principal, class-teacher,
//  vice-class-teacher, subject-teacher) are *teacher* users distinguished by
//  assignment context (whether they are a ClassSection.classTeacher /
//  viceClassTeacher, or teach a ClassSubject). `resolveTeacherScope()` computes
//  that context so controllers can enforce "subject teacher only manages his
//  subject" and "class teacher controls his whole class".
// ─────────────────────────────────────────────────────────────────────────────

// permission → set of roles that hold it (school-scoped roles; super_admin holds all).
const MATRIX = {
    // Master library (Super Admin only)
    'video.create':        ['super_admin'],
    'video.edit':          ['super_admin'],
    'video.delete':        ['super_admin'],
    'video.archive':       ['super_admin'],
    'video.duplicate':     ['super_admin'],
    'video.publish':       ['super_admin'],
    'video.schedule':      ['super_admin'],
    'video.upload_s3':     ['super_admin'],
    'video.version':       ['super_admin'],
    'video.bulk':          ['super_admin'],
    'video.feature':       ['super_admin'],
    'playlist.master':     ['super_admin'],
    'course.master':       ['super_admin'],

    // School catalogue governance (School Admin)
    'video.enable':        ['super_admin', 'school_admin'],
    'video.disable':       ['super_admin', 'school_admin'],
    'video.approve':       ['super_admin', 'school_admin'],
    'video.reject':        ['super_admin', 'school_admin'],
    'video.set_visibility':['super_admin', 'school_admin'],
    'playlist.school':     ['super_admin', 'school_admin', 'teacher'],

    // Teacher-added external videos (YouTube/Vimeo only, need approval)
    'video.upload_link':   ['school_admin', 'teacher'],

    // Assignment (class teacher / vice / subject teacher / school admin)
    'video.assign':        ['super_admin', 'school_admin', 'teacher'],
    'assignment.edit':     ['super_admin', 'school_admin', 'teacher'],
    'assignment.delete':   ['super_admin', 'school_admin', 'teacher'],

    // Analytics & reports
    'video.analytics':     ['super_admin', 'school_admin', 'teacher'],
    'video.reports':       ['super_admin', 'school_admin', 'teacher'],
    'video.audit':         ['super_admin', 'school_admin'],

    // Student consumption
    'video.view':          ['student'],
    'video.interact':      ['student'],
    'video.download':      ['student'],       // further gated by assignment/policy
};

function can(role, permission) {
    const roles = MATRIX[permission];
    if (!roles) return false;
    if (role === 'super_admin') return true; // super admin is unrestricted
    return roles.includes(role);
}

// slugify a title for SEO slugs / taxonomy value keys.
function slugify(s) {
    return String(s || '')
        .toLowerCase().trim()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
}

// Resolve a teacher's effective scope within their school so we can enforce the
// spec's class-teacher vs subject-teacher rules. Returns:
//   { isClassTeacher, classSectionIds:[…], subjectIds:[…], subjectSectionIds:[…] }
//
// A "class teacher" (or vice/substitute) owns a whole ClassSection; a "subject
// teacher" owns specific (section, subject) pairs via SectionSubjectTeacher.
async function resolveTeacherScope(userId, schoolId) {
    const ClassSection          = require('../models/ClassSection');
    const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');

    const [ownedSections, sst] = await Promise.all([
        ClassSection.find({
            school: schoolId,
            $or: [{ classTeacher: userId }, { substituteTeacher: userId }],
        }, '_id class').lean().catch(() => []),
        SectionSubjectTeacher.find({ teacher: userId }, 'section subject').lean().catch(() => []),
    ]);

    return {
        isClassTeacher:    ownedSections.length > 0,
        classSectionIds:   ownedSections.map((s) => String(s._id)),
        subjectIds:        [...new Set(sst.map((r) => String(r.subject)).filter(Boolean))],
        subjectSectionIds: [...new Set(sst.map((r) => String(r.section)).filter(Boolean))],
    };
}

module.exports = { MATRIX, can, slugify, resolveTeacherScope };
