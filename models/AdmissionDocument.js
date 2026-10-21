const db = require('../db/orm');

/**
 * One uploaded paper on an application. A re-upload is a NEW row (`version`
 * goes up, the old row's `current` goes false) so the office can always see
 * what was rejected and what replaced it.
 *
 * The file lives in uploads/admission-docs, which server.js never serves
 * directly — it is streamed by the admission API after an ownership check
 * (services/admission/documents.js). `sha256` is of the bytes as stored.
 */
const AdmissionDocumentSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    application:  { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    applicant:    { type: db.Types.UUID, ref: 'User', default: null },
    docType:      { type: db.Types.UUID, ref: 'AdmissionDocumentType', default: null },
    docKey:       { type: String, default: '' },
    fieldKey:     { type: String, default: '' },
    file:         { type: String, required: true },
    originalName: { type: String, default: '' },
    mime:         { type: String, default: '' },
    size:         { type: Number, default: 0 },
    sha256:       { type: String, default: '' },
    status:       { type: String, enum: ['uploaded', 'under_review', 'verified', 'rejected', 'resubmission_required', 'replaced'], default: 'uploaded' },
    version:      { type: Number, default: 1 },
    current:      { type: Boolean, default: true },
    reviewedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    reviewedAt:   { type: Date, default: null },
    rejectionReason: { type: String, default: '' },
    reviewNote:   { type: String, default: '' },
    history:      { type: db.Types.JSON, default: () => [] },
    uploadedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    // The virus scanner's answer when it was uploaded: clean | unavailable | off (services/admission/virusScan.js).
    scanStatus:   { type: String, default: '' },
    // Where it came from: an upload, or fetched from DigiLocker (issued by the issuer named in originMeta).
    origin:       { type: String, default: 'upload' },
    originMeta:   { type: db.Types.JSON, default: () => ({}) },
    scannedAt:    { type: Date, default: null },
}, { timestamps: true });

AdmissionDocumentSchema.index({ school: 1, application: 1 });
AdmissionDocumentSchema.index({ school: 1, status: 1 });

module.exports = db.model('AdmissionDocument', AdmissionDocumentSchema);
