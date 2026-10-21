'use strict';
/**
 * Who may reach which admission record — the tenant boundary, in one place.
 *
 * Every loader takes the school from the SESSION (req.schoolId), never from
 * the request body or the URL, and asks for the row by (id, school) — plus
 * (id, school, applicant) for an applicant — in the same query. A record of
 * another school is therefore indistinguishable from one that does not exist:
 * 404, nothing about it said.
 */
const pool = require('../../db/pool');
const AdmissionApplication = require('../../models/AdmissionApplication');
const designations = require('../designationService');
const settingsSvc = require('./settings');
const School = require('../../models/School');
const { refuse, isId } = require('./util');

/** Is the caller an admission administrator (school admin, or a teacher whose designation grants it)? */
async function isAdmin(req) {
    if (req.userRole === 'school_admin' || req.userRole === 'super_admin') return true;
    if (req.userRole !== 'teacher') return false;
    return designations.isModuleAdmin(req, 'admission');
}

/** The application, if it belongs to the caller's school. */
async function schoolApplication(req, id, { lock = false, q = null } = {}) {
    if (!isId(String(id || ''))) refuse('Application not found', 404);
    const run = q || ((s, p) => pool.query(s, p));
    const { rows } = await run(
        `SELECT * FROM "${AdmissionApplication.tableName}" WHERE "_id" = $1 AND "school" = $2${lock ? ' FOR UPDATE' : ''}`,
        [String(id), String(req.schoolId)],
    );
    if (!rows[0]) refuse('Application not found', 404);
    return rows[0];
}

/** The application, if it is the signed-in applicant's own. */
async function ownApplication(req, id, { lock = false, q = null } = {}) {
    if (!isId(String(id || ''))) refuse('Application not found', 404);
    const run = q || ((s, p) => pool.query(s, p));
    const { rows } = await run(
        `SELECT * FROM "${AdmissionApplication.tableName}" WHERE "_id" = $1 AND "school" = $2 AND "applicant" = $3${lock ? ' FOR UPDATE' : ''}`,
        [String(id), String(req.schoolId), String(req.userId)],
    );
    if (!rows[0]) refuse('Application not found', 404);
    return rows[0];
}

/** Any school-scoped row of `Model` by id — 404 when it is another school's. */
async function schoolRow(Model, req, id, label = 'Record') {
    if (!isId(String(id || ''))) refuse(`${label} not found`, 404);
    const { rows } = await pool.query(
        `SELECT * FROM "${Model.tableName}" WHERE "_id" = $1 AND "school" = $2`, [String(id), String(req.schoolId)]);
    if (!rows[0]) refuse(`${label} not found`, 404);
    return rows[0];
}

/**
 * Middleware for the signed-in applicant's API: the portal of THEIR school
 * (from the session), live and not under maintenance.
 */
async function guestPortal(req, res, next) {
    try {
        if (req.userRole !== 'guest') return res.status(403).json({ success: false, message: 'This is for applicant accounts' });
        const school = await School.findById(req.schoolId).select('name code logo email phone address city state website isActive modules paymentGateway').lean();
        if (!school || school.isActive === false || !school.modules?.admission) {
            return res.status(403).json({ success: false, code: 'PORTAL_OFF', message: 'Online admissions are not available for this school at the moment' });
        }
        const settings = await settingsSvc.getSettings(school._id);
        if (settings.portal.status === 'maintenance') {
            return res.status(503).json({ success: false, code: 'PORTAL_MAINTENANCE', message: settings.portal.maintenanceMessage });
        }
        req.portal = { school, settings, slug: settings.slug, live: true };
        // A changed privacy notice is agreed to before anything else is done:
        // reading, agreeing, asking about one's data and leaving stay open.
        if (req.method !== 'GET' && !CONSENT_FREE.some((re) => re.test(req.path))) {
            const { rows: [p] } = await pool.query(`SELECT "consentVersion" FROM "admissionapplicants" WHERE "user" = $1`, [String(req.userId)]);
            if (p && Number(p.consentVersion || 0) < Number(settings.portal.privacyVersion || 1)) {
                return res.status(409).json({ success: false, code: 'CONSENT_REQUIRED', message: 'The school has updated its privacy notice — please read it and agree to continue', version: settings.portal.privacyVersion });
            }
        }
        next();
    } catch (err) { next(err); }
}

// An exam in progress, and money already paid, are never held up by a changed notice.
const CONSENT_FREE = [/^\/portal\/consent$/, /^\/portal\/privacy\//, /\/withdraw$/, /\/exams\/[^/]+\/start$/, /\/attempts\/[^/]+\/(answers|submit|violation|next-section)$/,
    /\/pay\/verify$/, /\/payments\/[^/]+\/reconcile$/];

/** Middleware for public routes: the portal named in the address. */
async function publicPortal(req, res, next) {
    try {
        const portal = await settingsSvc.portalBySlug(req.params.slug);
        if (!portal || !portal.live) return res.status(404).json({ success: false, code: 'PORTAL_NOT_FOUND', message: 'There is no admission portal at this address' });
        req.portal = portal;
        next();
    } catch (err) { next(err); }
}

/** Middleware: the caller administers admissions (school admin or module-admin teacher). */
async function adminOnly(req, res, next) {
    try {
        if (await isAdmin(req)) return next();
        return res.status(403).json({ success: false, code: 'MODULE_ADMIN_REQUIRED', message: 'Administrative access to admissions is required' });
    } catch (err) { next(err); }
}

module.exports = { isAdmin, schoolApplication, ownApplication, schoolRow, guestPortal, publicPortal, adminOnly };
