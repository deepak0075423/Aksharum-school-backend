const db = require('../db/orm');

/**
 * One answer to a school's cookie banner (Oct 2026): what a visitor allowed,
 * for which version of the policy, and when — the school's record that consent
 * was asked for and given (or refused).
 *
 * `visitor` is a random id the browser keeps with its choice, so a later change
 * of mind can be told apart from a new visitor; nothing in it identifies the
 * person. The address is kept only as a salted hash.
 */
const CookieConsentSchema = new db.Schema({
    school:    { type: db.Types.UUID, ref: 'School', required: true },
    visitor:   { type: String, required: true },
    version:   { type: Number, default: 1 },
    action:    { type: String, enum: ['accept_all', 'reject_all', 'custom', 'withdraw'], required: true },
    choices:   { type: db.Types.JSON, default: () => ({}) },
    surface:   { type: String, default: 'portal' },        // portal | app
    user:      { type: db.Types.UUID, ref: 'User', default: null },
    ipHash:    { type: String, default: '' },
    userAgent: { type: String, default: '' },
}, { timestamps: true });

CookieConsentSchema.index({ school: 1, createdAt: -1 });
CookieConsentSchema.index({ school: 1, visitor: 1 });

module.exports = db.model('CookieConsent', CookieConsentSchema);
