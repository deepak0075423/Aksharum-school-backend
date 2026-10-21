const db = require('../db/orm');

/**
 * An enquiry — left on the admission portal by someone who has not registered,
 * or written down by the office (a walk-in, a phone call). The first stage of
 * the funnel: the office owns it (`assignedTo`), follows it up on a date
 * (`nextFollowUpAt`), keeps a log of every call, email and visit
 * (`interactions`), and marks how it went. When the person registers on the
 * portal with the same email or mobile, it is linked to their account.
 *
 *   priority     hot | warm | cold
 *   lostReason   why it was closed without an application
 */
const AdmissionEnquirySchema = new db.Schema({
    school:     { type: db.Types.UUID, ref: 'School', required: true },
    name:       { type: String, required: true, trim: true },
    email:      { type: String, trim: true, lowercase: true, default: '' },
    phone:      { type: String, trim: true, default: '' },
    class:      { type: db.Types.UUID, ref: 'Class', default: null },
    message:    { type: String, default: '' },
    source:     { type: String, trim: true, default: '' },
    status:     { type: String, enum: ['new', 'contacted', 'registered', 'closed'], default: 'new' },
    notes:      { type: db.Types.JSON, default: () => [] },
    handledBy:  { type: db.Types.UUID, ref: 'User', default: null },
    assignedTo: { type: db.Types.UUID, ref: 'User', default: null },
    priority:   { type: String, enum: ['hot', 'warm', 'cold'], default: 'warm' },
    nextFollowUpAt: { type: Date, default: null },
    followUpRemindedAt: { type: Date, default: null },
    interactions: { type: db.Types.JSON, default: () => [] },
    lostReason: { type: String, default: '' },
    applicant:  { type: db.Types.UUID, ref: 'User', default: null },   // the account they registered with
    createdBy:  { type: db.Types.UUID, ref: 'User', default: null },   // staff, for an enquiry written down by the office
}, { timestamps: true });

AdmissionEnquirySchema.index({ school: 1, status: 1, createdAt: -1 });
AdmissionEnquirySchema.index({ school: 1, assignedTo: 1, nextFollowUpAt: 1 });

module.exports = db.model('AdmissionEnquiry', AdmissionEnquirySchema);
