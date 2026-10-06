const db = require('../db/orm');

/**
 * One student in a health campaign (Oct 2026): what the family said and what
 * happened on the day. `section`/`class` are where the student was when the
 * roster was made, so the coverage per section stays put when classes move.
 *
 *   consent   pending | yes | no
 *   outcome   '' (not yet) | given | absent | refused (by the child on the
 *             day) | excluded (unwell, an allergy, a medical reason)
 */
const MedicalCampaignEntrySchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    campaign: { type: db.Types.UUID, ref: 'MedicalCampaign', required: true },
    student:  { type: db.Types.UUID, ref: 'User', required: true },
    section:  { type: db.Types.UUID, ref: 'ClassSection', default: null },
    class:    { type: db.Types.UUID, ref: 'Class', default: null },

    consent:       { type: String, enum: ['pending', 'yes', 'no'], default: 'pending' },
    consentReason: { type: String, default: '' },
    consentBy:     { type: db.Types.UUID, ref: 'User', default: null },
    consentByName: { type: String, default: '' },
    consentAt:     { type: Date, default: null },

    outcome:       { type: String, enum: ['', 'given', 'absent', 'refused', 'excluded'], default: '' },
    outcomeReason: { type: String, default: '' },
    outcomeAt:     { type: Date, default: null },
    outcomeBy:     { type: db.Types.UUID, ref: 'User', default: null },
    outcomeByName: { type: String, default: '' },
    mopUp:         { type: Boolean, default: false },
    vaccination:   { type: db.Types.UUID, ref: 'MedicalVaccination', default: null },
}, { timestamps: true });

MedicalCampaignEntrySchema.index({ campaign: 1, student: 1 }, { unique: true });
MedicalCampaignEntrySchema.index({ school: 1, student: 1 });

module.exports = db.model('MedicalCampaignEntry', MedicalCampaignEntrySchema);
