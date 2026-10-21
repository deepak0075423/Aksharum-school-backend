const db = require('../db/orm');

/**
 * A family's request about its own information (Oct 2026) — the rights the
 * Digital Personal Data Protection Act, 2023 gives a data principal: to see
 * what is held, to have it corrected or erased, to withdraw consent, and to
 * be heard on a grievance. Made on the portal, answered by the admission
 * office within the school's own time limit (settings.privacy.requestDays,
 * at most the 90 days the DPDP Rules allow for a grievance).
 *
 *   kind      access | correction | erasure | withdraw_consent | grievance
 *   status    open | in_progress | done | declined
 *   response  what the family is told; internalNote stays in the office
 */
const AdmissionDataRequestSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    applicant:    { type: db.Types.UUID, ref: 'User', required: true },
    application:  { type: db.Types.UUID, ref: 'AdmissionApplication', default: null },
    number:       { type: String, default: '' },
    kind:         { type: String, enum: ['access', 'correction', 'erasure', 'withdraw_consent', 'grievance'], required: true },
    details:      { type: String, default: '' },
    status:       { type: String, enum: ['open', 'in_progress', 'done', 'declined'], default: 'open' },
    response:     { type: String, default: '' },
    internalNote: { type: String, default: '' },
    dueAt:        { type: Date, default: null },
    handledBy:    { type: db.Types.UUID, ref: 'User', default: null },
    handledAt:    { type: Date, default: null },
    applicantName:  { type: String, default: '' },
    applicantEmail: { type: String, default: '' },
}, { timestamps: true });

AdmissionDataRequestSchema.index({ school: 1, status: 1, dueAt: 1 });
AdmissionDataRequestSchema.index({ school: 1, applicant: 1 });

module.exports = db.model('AdmissionDataRequest', AdmissionDataRequestSchema);
