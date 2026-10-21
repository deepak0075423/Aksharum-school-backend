const db = require('../db/orm');

/**
 * The state's reimbursement for one RTE child for one year (Oct 2026) — the
 * register a private unaided school keeps of what it has claimed for the
 * children admitted under section 12(1)(c), and what it has been paid.
 * services/admission/quotas.js makes a line for every such child enrolled.
 */
const AdmissionRteClaimSchema = new db.Schema({
    school:         { type: db.Types.UUID, ref: 'School', required: true },
    academicYear:   { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    application:    { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    student:        { type: db.Types.UUID, ref: 'User', default: null },
    studentName:    { type: String, default: '' },
    admissionNumber: { type: String, default: '' },
    className:      { type: String, default: '' },
    perChildAmount: { type: Number, default: null },
    claimedAmount:  { type: Number, default: null },
    claimedAt:      { type: Date, default: null },
    receivedAmount: { type: Number, default: null },
    receivedAt:     { type: Date, default: null },
    status:         { type: String, enum: ['pending', 'claimed', 'received', 'rejected'], default: 'pending' },
    reference:      { type: String, default: '' },
    notes:          { type: String, default: '' },
    updatedBy:      { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionRteClaimSchema.index({ academicYear: 1, application: 1 }, { unique: true });
AdmissionRteClaimSchema.index({ school: 1, academicYear: 1 });

module.exports = db.model('AdmissionRteClaim', AdmissionRteClaimSchema);
