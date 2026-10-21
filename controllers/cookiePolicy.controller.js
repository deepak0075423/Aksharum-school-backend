'use strict';
/**
 * Cookie policy endpoints (Oct 2026).
 *
 *   /api/admin/cookie-policy …              the school admin sets the policy up
 *   /api/admission/public/portals/:slug/…   the portal's banner, page and consent log
 *   /api/profile/cookie-policy              a signed-in person's school's policy
 *   /api/public/cookie-policy               the platform's own, before anyone signs in
 *
 * The school is always the session's (admin, profile) or the one behind the
 * portal's address (public) — never one a request names.
 */
const svc = require('../services/cookiePolicy');
const AdmissionSetting = require('../models/AdmissionSetting');
const { clientIp } = require('../middleware/rateLimit');

const FRONTEND = () => String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        if (err && (err.expose || (err.status && err.status < 500))) {
            return res.status(err.status || 400).json({ success: false, message: err.message, ...(err.field ? { field: err.field } : {}) });
        }
        console.error('[cookie policy]', err);
        return res.status(500).json({ success: false, message: 'Something went wrong — please try again' });
    }
};

async function adminView(schoolId) {
    const { policy, school } = await svc.getPolicy(schoolId);
    const setting = await AdmissionSetting.findOne({ school: schoolId }).select('slug').lean();
    const slug = setting?.slug || '';
    return {
        policy,
        banner: svc.bannerView(policy),
        page: svc.pageView(policy, school),
        portalUrl: slug ? `${FRONTEND()}/${slug}/cookies` : '',
        appUrl: `${FRONTEND()}/cookie-policy`,
    };
}

// ── The school admin ─────────────────────────────────────────────────────────

exports.get = wrap(async (req, res) => {
    res.json({ success: true, data: await adminView(req.schoolId) });
});

exports.save = wrap(async (req, res) => {
    await svc.savePolicy(req.schoolId, req.body || {}, req.userId);
    res.json({ success: true, data: await adminView(req.schoolId) });
});

exports.reset = wrap(async (req, res) => {
    await svc.resetPolicy(req.schoolId, req.userId);
    res.json({ success: true, data: await adminView(req.schoolId) });
});

exports.consents = wrap(async (req, res) => {
    const stats = await svc.consentStats(req.schoolId, { days: req.query.days, limit: req.query.format === 'csv' ? 500 : 50 });
    if (req.query.format === 'csv') {
        const esc = (v) => {
            const s = String(v ?? '');
            // Spreadsheet formulas never start a cell.
            const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
            return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        };
        const lines = [['When', 'Choice', 'Preferences', 'Analytics', 'Advertising', 'Policy version', 'Where'].join(',')];
        for (const r of stats.recent) {
            lines.push([new Date(r.createdAt).toISOString(), r.action, !!r.choices?.preferences, !!r.choices?.analytics, !!r.choices?.marketing, r.version, r.surface].map(esc).join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="cookie-consents.csv"');
        return res.send(lines.join('\n'));
    }
    res.json({ success: true, data: stats });
});

// ── The portal (public) ──────────────────────────────────────────────────────

exports.portalPolicy = wrap(async (req, res) => {
    const { policy, school } = await svc.getPolicy(req.portal.school._id);
    res.json({ success: true, data: { banner: svc.bannerView(policy), page: svc.pageView(policy, school) } });
});

exports.portalConsent = wrap(async (req, res) => {
    const saved = await svc.recordConsent(req.portal.school._id, req.body || {}, {
        ip: clientIp(req), userAgent: req.get('user-agent'), surface: 'portal',
    });
    res.status(201).json({ success: true, data: saved });
});

// ── The app ──────────────────────────────────────────────────────────────────

/** A signed-in person's school's policy; the platform's own for someone with no school. */
exports.mine = wrap(async (req, res) => {
    const { policy, school } = await svc.getPolicy(req.schoolId || null);
    res.json({ success: true, data: { banner: svc.bannerView(policy), page: svc.pageView(policy, school) } });
});

exports.platform = wrap(async (req, res) => {
    const { policy } = await svc.getPolicy(null);
    res.json({ success: true, data: { banner: svc.bannerView(policy), page: svc.pageView(policy, null) } });
});

exports.adminView = adminView;
