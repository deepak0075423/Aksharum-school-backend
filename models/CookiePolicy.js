const db = require('../db/orm');

/**
 * A school's cookie policy (Oct 2026) — one row per school, set up by its
 * school admin under School Settings → Privacy & cookies.
 *
 * It drives three things: the consent banner on the school's admission portal,
 * the cookie policy page (portal and app), and which optional tags may load on
 * the portal's public pages once a visitor agrees. Everything here is validated
 * data (services/cookiePolicy.js owns the shape) — a school names a measurement
 * ID, never a script.
 *
 *   sections      the policy's own words: [{ title, body }]
 *   categories    { preferences, analytics, marketing } — each { enabled, description };
 *                 essential storage is always on and needs no consent
 *   items         what is stored: [{ name, provider, category, purpose, duration, type }]
 *   integrations  { ga4MeasurementId, metaPixelId } — loaded only after consent,
 *                 only on public portal pages
 *   version       raised whenever what a visitor agrees to changes; a banner
 *                 answered for an older version is asked again
 */
const CookiePolicySchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true, unique: true },
    enabled:      { type: Boolean, default: true },
    bannerTitle:  { type: String, default: '' },
    bannerText:   { type: String, default: '' },
    sections:     { type: db.Types.JSON, default: () => [] },
    categories:   { type: db.Types.JSON, default: () => ({}) },
    items:        { type: db.Types.JSON, default: () => [] },
    integrations: { type: db.Types.JSON, default: () => ({}) },
    contactEmail: { type: String, default: '' },
    consentDays:  { type: Number, default: 180 },
    version:      { type: Number, default: 1 },
    publishedAt:  { type: Date, default: null },
    updatedBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('CookiePolicy', CookiePolicySchema);
