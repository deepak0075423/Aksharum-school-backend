const db = require('../db/orm');

/**
 * What the admission portal knows about an applicant beyond their sign-in
 * (the `guest` User row): when the address was verified, which privacy notice
 * they agreed to, and how they found the school.
 */
const AdmissionApplicantSchema = new db.Schema({
    school:         { type: db.Types.UUID, ref: 'School', required: true },
    user:           { type: db.Types.UUID, ref: 'User', required: true, unique: true },
    phone:          { type: String, trim: true, default: '' },
    verifiedAt:     { type: Date, default: null },
    consentAt:      { type: Date, default: null },
    consentVersion: { type: Number, default: 0 },
    source:         { type: String, trim: true, default: '' },
    lastLoginAt:    { type: Date, default: null },
    linkedExisting: { type: Boolean, default: false },   // the address already signed in to Aksharum
}, { timestamps: true });

AdmissionApplicantSchema.index({ school: 1, createdAt: -1 });

module.exports = db.model('AdmissionApplicant', AdmissionApplicantSchema);
