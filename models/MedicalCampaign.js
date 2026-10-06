const db = require('../db/orm');

/**
 * A health programme run across the school (Oct 2026) — a deworming day, a
 * vitamin A round, a vaccination drive, an eye-screening camp — with the
 * families asked first, a roster marked on the day, a mop-up day for those
 * who were away, and the coverage at the end.
 *
 *   consent   none     — families are told, nothing is asked
 *             opt_out  — given unless the family says no
 *             opt_in   — given only when the family says yes
 *   status    draft → announced (families told, the roster made) → closed;
 *             or cancelled. "Running" is worked out from the dates.
 *
 * Each student's part is a MedicalCampaignEntry.
 */
const MedicalCampaignSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    number: { type: String, default: '' },

    title: { type: String, required: true, trim: true },
    kind: {
        type: String,
        enum: ['deworming', 'vitamin_a', 'iron', 'vaccination', 'screening', 'dental', 'eye', 'awareness', 'other'],
        default: 'other',
    },
    medicine:  { type: String, default: '', trim: true },   // deworming, vitamin A, iron
    vaccine:   { type: String, default: '', trim: true },   // a vaccination drive: becomes the student's vaccination record
    dose:      { type: String, default: '', trim: true },
    lotNumber: { type: String, default: '', trim: true },
    about:     { type: String, default: '', trim: true },   // what the families are told
    audience:  { type: Object, default: {} },                // { all: bool, classes: [ids], sections: [ids] }

    startOn:   { type: Date, required: true },
    endOn:     { type: Date, default: null },
    mopUpOn:   { type: Date, default: null },
    consent:   { type: String, enum: ['none', 'opt_out', 'opt_in'], default: 'opt_out' },
    consentBy: { type: Date, default: null },

    status: { type: String, enum: ['draft', 'announced', 'closed', 'cancelled'], default: 'draft' },
    announcedAt:  { type: Date, default: null },
    announcedBy:  { type: db.Types.UUID, ref: 'User', default: null },
    closedAt:     { type: Date, default: null },
    closedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    cancelledAt:  { type: Date, default: null },
    cancelledBy:  { type: db.Types.UUID, ref: 'User', default: null },
    cancelReason: { type: String, default: '' },

    createdBy:     { type: db.Types.UUID, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
}, { timestamps: true });

MedicalCampaignSchema.index({ school: 1, status: 1, startOn: -1 });

module.exports = db.model('MedicalCampaign', MedicalCampaignSchema);
