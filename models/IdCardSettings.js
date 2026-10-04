const db = require('../db/orm');

/**
 * What every ID card of a school says about the school (Oct 2026): the name
 * and tagline printed in the header, the logo, the return address and contact
 * lines on the back, the signatory — plus the module's few rules. One row per
 * school, created on first read (services/idCardDesign.settingsOf).
 *
 * An empty identity field means "the school's own" (School.name, School.logo,
 * School.address …), so a school that never opens Settings still prints
 * correct cards, and keeps doing so when its details change.
 */
const IdCardSettingsSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, unique: true },

    // ── Printed identity ──────────────────────────────────────────────────────
    displayName: { type: String, default: '', trim: true },
    tagline:     { type: String, default: '', trim: true },   // "Affiliated to CBSE · No. 1130256"
    logo:        { type: String, default: '' },                // '/uploads/images/…' — '' → School.logo
    address:     { type: String, default: '', trim: true },
    phone:       { type: String, default: '', trim: true },
    email:       { type: String, default: '', trim: true },
    website:     { type: String, default: '', trim: true },

    // ── Signatory ─────────────────────────────────────────────────────────────
    signatoryName:  { type: String, default: '', trim: true },
    signatoryTitle: { type: String, default: 'Principal', trim: true },
    signature:      { type: String, default: '' },             // '/uploads/images/…'

    // ── Rules ─────────────────────────────────────────────────────────────────
    // A card is not issued to someone with no photo on record.
    requirePhoto:    { type: Boolean, default: false },
    // Whether the public verification page shows the holder's photo.
    verifyShowPhoto: { type: Boolean, default: true },
    // Tell the holder (and a student's parents) when a card is issued for them.
    notifyOnIssue:   { type: Boolean, default: true },

    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
});

module.exports = db.model('IdCardSettings', IdCardSettingsSchema);
