'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Module access guards — the server-side enforcement of
//
//      School module enablement  →  Designation permission  →  User access
//
//  requireModule(key)        the module must be enabled for the school AND the
//                            caller must have at least normal access to it.
//  requireModuleAdmin(key)   same, but administrative access is required.
//  allowModuleAdmin(key)     role guard: school_admin, or a teacher whose
//                            designation grants administrative access to `key`.
//                            Use in place of requireRole('school_admin') on a
//                            module's administrative routes.
//
//  Every guard leaves the resolved access on `req.access` so controllers can
//  branch on it without another lookup.
// ─────────────────────────────────────────────────────────────────────────────
const designations = require('../services/designationService');
const { isModuleKey } = require('../config/modules');

const deny = (res, code, message) => res.status(403).json({ success: false, code, message });

async function resolve(req) {
    const access = await designations.requestAccess(req);
    req.access = access;
    return access;
}

// Shared body of requireModule / requireModuleAdmin.
const gateLevel = (moduleName, required) => async (req, res, next) => {
    try {
        if (!isModuleKey(moduleName)) return next();      // unknown key: nothing to gate
        // Super admin has no school and sits above per-school enablement.
        if (!req.schoolId) return next();

        const access = await resolve(req);

        if (!access.moduleFlags[moduleName]) {
            return deny(res, 'MODULE_DISABLED',
                `Module '${moduleName}' is not enabled for your school`);
        }
        const level = access.permissions[moduleName] || designations.NONE;
        if (level === designations.NONE) {
            return deny(res, 'MODULE_ACCESS_DENIED',
                'Your designation does not have access to this module');
        }
        if (!designations.meets(level, required)) {
            return deny(res, 'MODULE_ADMIN_REQUIRED',
                'Administrative access to this module is required');
        }
        next();
    } catch (err) { next(err); }
};

const requireModule      = (moduleName) => gateLevel(moduleName, designations.USER);
const requireModuleAdmin = (moduleName) => gateLevel(moduleName, designations.ADMIN);

// Role guard for a module's administrative surface. school_admin always passes
// (an admin is administrative on everything their school has enabled); a teacher
// passes only when their designation grants 'admin' on this module. Students and
// parents never reach an administrative surface.
const allowModuleAdmin = (moduleName) => async (req, res, next) => {
    try {
        if (!req.schoolId) return next();                 // super admin
        const role = req.userRole;
        if (role !== 'school_admin' && role !== 'teacher') {
            return deny(res, 'INSUFFICIENT_PERMISSIONS', 'Insufficient permissions');
        }
        const access = await resolve(req);

        if (!access.moduleFlags[moduleName]) {
            return deny(res, 'MODULE_DISABLED',
                `Module '${moduleName}' is not enabled for your school`);
        }
        if (role === 'school_admin') return next();

        if (access.permissions[moduleName] !== designations.ADMIN) {
            return deny(res, 'MODULE_ADMIN_REQUIRED',
                'Administrative access to this module is required');
        }
        next();
    } catch (err) { next(err); }
};

// Resolve access without gating — for endpoints that report what a user can see.
const attachModuleAccess = async (req, res, next) => {
    try { if (req.schoolId || req.userRole === 'super_admin') await resolve(req); next(); }
    catch (err) { next(err); }
};

module.exports = { requireModule, requireModuleAdmin, allowModuleAdmin, attachModuleAccess };
