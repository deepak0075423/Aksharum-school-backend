'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  The payload behind GET /{role}/modules — one builder for all four roles.
//
//  The per-module booleans report EFFECTIVE access (school enablement AND the
//  caller's designation permission), because that is what every client already
//  gates its navigation and screens on. Adding designation permissions therefore
//  needed no change to any nav list: a module the designation cannot reach
//  simply reports false, exactly like a module the school has not enabled.
//
//  Callers that need to tell the two apart, or that need the administrative
//  level, read `schoolModules`, `permissions` and `moduleAdmin`.
// ─────────────────────────────────────────────────────────────────────────────
const School = require('../models/School');
const designations = require('../services/designationService');
const { MODULE_KEYS } = require('../config/modules');
const { hasMySection } = require('../services/teacherOwnSections');
const { transportRole } = require('../services/transportEnrolment');
const { staffHasHostel } = require('../services/hostelResident');
const { onHostelDuty } = require('../middleware/hostelDesk');

/**
 * One of the "not a module" answers below, on its own feet.
 *
 * They are separate questions about separate tables, and they used to share one
 * Promise.all — so a transport lookup that threw took the whole payload down
 * with it. The client then had no map at all: every module showed (it fails
 * open) and My Section, which fails closed, vanished for a teacher who runs a
 * class. A probe that cannot answer now says "no" for itself, loudly in the
 * log, and leaves the others alone.
 */
const probe = (name, promise, fallback) => Promise.resolve(promise).catch((e) => {
    console.error(`[modules] ${name} could not be worked out:`, e.message);
    return fallback;
});

async function buildModuleResponse(req) {
    const isTeacher = req.userRole === 'teacher';
    const [access, school, mySection, transport, staffHostel, hostelDuty] = await Promise.all([
        designations.requestAccess(req),
        req.schoolId
            ? School.findById(req.schoolId).select('leaveSettings').lean()
            : Promise.resolve(null),
        isTeacher ? probe('hasMySection', hasMySection(req.schoolId, req.userId), false) : Promise.resolve(false),
        probe('transportEnrolled', transportRole(req.schoolId, req.userId, req.userRole), { enrolled: false, crew: false }),
        isTeacher && req.schoolId ? probe('hostelResident', staffHasHostel(req.schoolId, req.userId), false) : Promise.resolve(false),
        isTeacher && req.schoolId ? probe('hostelDuty', onHostelDuty(req.schoolId, req.userId), false) : Promise.resolve(false),
    ]);

    const ls = school?.leaveSettings ?? {};
    const data = {};
    const permissions = {};
    const moduleAdmin = {};

    for (const key of MODULE_KEYS) {
        const level = access.permissions[key] || designations.NONE;
        permissions[key] = level;
        moduleAdmin[key] = level === designations.ADMIN;
        data[key] = access.moduleFlags[key] && level !== designations.NONE;
    }

    return {
        ...data,
        // School module enablement, before designation permissions are applied.
        schoolModules: access.moduleFlags,
        // 'admin' | 'user' | 'none' per module, after school gating.
        permissions,
        moduleAdmin,
        designation: access.designation || '',
        permissionSource: access.source,
        // Kept for the screens that predate the permission matrix; both are now
        // just administrative access to their module.
        isLibrarian: moduleAdmin.library,
        isPrincipal: moduleAdmin.feedback,
        // Not a module: whether this teacher has a section this year — as its
        // class teacher, its vice class teacher, or a subject teacher in it —
        // which is what opens My Section. Sent here because every client
        // already gates its menus on this payload. The page's endpoint
        // enforces the same rule (services/teacherOwnSections).
        hasMySection: mySection,
        // Not a module either: whether this person is enrolled in the transport
        // service (a student or teacher who rides, a parent whose child rides,
        // or a member of the crew). Hides the Transport entry for everyone else,
        // and services/transportEnrolment enforces the same rule on the routes.
        transportEnrolled: transport.enrolled,
        // ...and, for a teacher, WHICH of the two reasons. A driver wants the
        // duty screen, a teacher who rides wants the rider screen, and the nav
        // cannot tell them apart from `transportEnrolled` alone.
        transportCrew: transport.crew,
        // Whether this member of staff lives in the hostel (or has a hostel bill).
        // It opens "My Hostel" for them; running the hostel is `moduleAdmin.hostel`,
        // a different thing, and a warden may be one, both or neither.
        hostelResident: staffHostel,
        // ...and whether they are POSTED to a hostel — its warden, assistant or
        // staff. That opens the day-to-day management screens for that hostel
        // (middleware/hostelDesk enforces the same rule on the routes), without
        // the designation that administering the whole module takes.
        hostelDuty: !!(hostelDuty && access.moduleFlags.hostel),
        saturdayConfig: {
            working: ls.saturdayWorking !== false,
            mode:    ls.saturdayMode    || 'all',
            halfDay: !!ls.saturdayHalfDay,
        },
    };
}

// Express handler — every /{role}/modules route is now this one line.
const modulesHandler = async (req, res) => {
    try {
        res.json({ success: true, data: await buildModuleResponse(req) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
};

module.exports = { buildModuleResponse, modulesHandler };
