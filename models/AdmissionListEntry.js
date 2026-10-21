const db = require('../db/orm');

/**
 * One applicant's line on a selection list: their rank, the score the
 * criteria gave them (and how — `breakdown`), and the decision. A decision
 * changed by hand is `manual`, and carries the office's reason.
 */
const AdmissionListEntrySchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    list:         { type: db.Types.UUID, ref: 'AdmissionList', required: true },
    application:  { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    rank:         { type: Number, default: null },
    score:        { type: Number, default: null },
    breakdown:    { type: db.Types.JSON, default: () => ({}) },
    decision:     { type: String, enum: ['selected', 'waitlisted', 'not_selected', 'excluded'], default: 'not_selected' },
    waitPosition: { type: Number, default: null },
    manual:       { type: Boolean, default: false },
    reason:       { type: String, default: '' },
    offer:        { type: db.Types.UUID, ref: 'AdmissionOffer', default: null },
    changedBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionListEntrySchema.index({ list: 1, application: 1 }, { unique: true });
AdmissionListEntrySchema.index({ school: 1, application: 1 });

module.exports = db.model('AdmissionListEntry', AdmissionListEntrySchema);
