'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Who may use the Transport module, and why.
//
//  The module's own gate (School flag → Designation permission) says whether
//  Transport EXISTS for this school and whether a role may reach it at all.
//  This service adds the fourth layer the school asked for: among the people
//  who could reach it, only those actually enrolled in the service — plus the
//  crew who run it — should see it.
//
//      student   an assignment of their own that has not been cancelled
//      teacher   an assignment of their own, OR a transport crew record
//                (a driver must reach the module to do the job)
//      parent    any of their children has one
//      admin     always — they are the people who enrol everyone else
//
//  One place, because three things depend on the same answer: the nav flag in
//  the modules payload, the route guard, and the screens themselves. Two of
//  those are advisory (a menu you cannot see is not a security control); the
//  guard is the one that enforces it.
// ─────────────────────────────────────────────────────────────────────────────
const TransportAssignment = require('../models/TransportAssignment');
const TransportStaff      = require('../models/TransportStaff');
const ParentProfile       = require('../models/ParentProfile');

// An enrolment that still entitles someone to the service. 'suspended' counts:
// the service is paused, not withdrawn, and they still need to see why.
const LIVE = ['active', 'suspended'];

/** The User ids of a parent's children (children[] with a legacy fallback). */
async function childIdsOf(userId) {
    const p = await ParentProfile.findOne({ user: userId }).lean();
    if (!p) return [];
    return p.children?.length ? p.children.map(String) : (p.student ? [String(p.student)] : []);
}

/**
 * @returns {Promise<{enrolled: boolean, reason: string, personIds: string[], isCrew: boolean}>}
 *   `reason` is for diagnostics and for the empty state the screens show; it is
 *   never the thing a client is trusted to act on.
 */
async function transportAccess(schoolId, userId, role) {
    if (!schoolId || !userId) return { enrolled: false, reason: 'no_school', personIds: [], isCrew: false };

    // Admins run the module; a teacher with administrative access reaches it
    // through the module permission, not through this.
    if (role === 'school_admin' || role === 'super_admin') {
        return { enrolled: true, reason: 'admin', personIds: [], isCrew: false };
    }

    if (role === 'parent') {
        const kids = await childIdsOf(userId);
        if (!kids.length) return { enrolled: false, reason: 'no_children', personIds: [], isCrew: false };
        const rows = await TransportAssignment.find({
            school: schoolId, student: { $in: kids }, status: { $in: LIVE },
        }).select('student').lean();
        const enrolledKids = [...new Set(rows.map((r) => String(r.student)))];
        return {
            enrolled: enrolledKids.length > 0,
            reason: enrolledKids.length ? 'child_enrolled' : 'child_not_enrolled',
            personIds: enrolledKids, isCrew: false,
        };
    }

    if (role === 'student' || role === 'teacher') {
        const [own, crew] = await Promise.all([
            TransportAssignment.findOne({ school: schoolId, student: userId, status: { $in: LIVE } })
                .select('_id').lean(),
            role === 'teacher'
                ? TransportStaff.findOne({ school: schoolId, user: userId, isActive: true }).select('_id').lean()
                : Promise.resolve(null),
        ]);
        if (crew) return { enrolled: true, reason: 'crew', personIds: [String(userId)], isCrew: true };
        if (own)  return { enrolled: true, reason: 'enrolled', personIds: [String(userId)], isCrew: false };
        return { enrolled: false, reason: 'not_enrolled', personIds: [], isCrew: false };
    }

    return { enrolled: false, reason: 'role_not_applicable', personIds: [], isCrew: false };
}

/** The boolean the modules payload carries, for the nav and the dashboard tiles. */
async function isTransportEnrolled(schoolId, userId, role) {
    const a = await transportAccess(schoolId, userId, role);
    return a.enrolled;
}

/**
 * Enrolled, and whether it is as CREW rather than as a rider.
 *
 * A teacher account reaches Transport for one of two quite different reasons —
 * they ride the bus, or they drive it — and the two want opposite screens. The
 * clients cannot work out which from `transportEnrolled` alone, so the modules
 * payload carries both and the nav sends them to the right one.
 */
async function transportRole(schoolId, userId, role) {
    const a = await transportAccess(schoolId, userId, role);
    return { enrolled: a.enrolled, crew: !!a.isCrew };
}

/**
 * Express guard. Sits AFTER requireModule('transport'), so by the time it runs
 * the school has the module on and the caller's role may reach it; all this
 * adds is "and they are actually enrolled".
 */
const requireTransportEnrolment = async (req, res, next) => {
    try {
        if (!req.schoolId) return next();                       // super admin
        const access = await transportAccess(req.schoolId, req.userId, req.userRole);
        if (!access.enrolled) {
            return res.status(403).json({
                success: false, code: 'TRANSPORT_NOT_ENROLLED',
                message: 'You are not enrolled in the school transport service.',
            });
        }
        req.transportAccess = access;
        next();
    } catch (err) { next(err); }
};

module.exports = { transportAccess, isTransportEnrolled, transportRole, requireTransportEnrolment, childIdsOf, LIVE };
