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

async function buildModuleResponse(req) {
    const [access, school] = await Promise.all([
        designations.requestAccess(req),
        req.schoolId
            ? School.findById(req.schoolId).select('leaveSettings').lean()
            : Promise.resolve(null),
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
