const db = require('../db/orm');

/**
 * A medical file — a prescription, a certificate, a lab report, a photo of
 * an injury. The file lives under uploads/medical-docs, which is NOT served
 * to the public (server.js): it is read through /api/medical/files/:id with
 * a login, or a short-lived signed link, after services/medicalAccess has
 * decided the reader may see it (controllers/medicalFiles).
 *
 *   visibility  family        the student, their parents and the medical staff
 *               staff         the medical staff only
 *               confidential  the medical staff only, and never listed to a
 *                             teacher even by name
 *   status      verified | pending (a parent's upload, waiting) | rejected
 *
 * Deleting archives (`archivedAt`); the file stays on disk for the record.
 */
const MedicalDocumentSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },

    type: {
        type: String,
        enum: ['prescription', 'medical_certificate', 'fitness_certificate', 'vaccination_certificate', 'lab_report',
               'doctor_report', 'hospital_document', 'history', 'incident_photo', 'other'],
        default: 'other',
    },
    title:        { type: String, required: true, trim: true },
    documentDate: { type: Date, default: null },
    expiresOn:    { type: Date, default: null },
    storedName:   { type: String, required: true },
    originalName: { type: String, default: '' },
    mime:         { type: String, default: '' },
    size:         { type: Number, default: 0 },
    visibility:   { type: String, enum: ['family', 'staff', 'confidential'], default: 'family' },
    status:       { type: String, enum: ['verified', 'pending', 'rejected'], default: 'verified' },
    remarks:      { type: String, default: '', trim: true },
    // What it belongs to, when it was attached to a record.
    linkKind: { type: String, default: '' },     // allergy | condition | vaccination | checkup | visit | incident | plan | request
    linkId:   { type: db.Types.UUID, default: null },

    uploadedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    uploadedByName: { type: String, default: '' },
    uploadedByRole: { type: String, default: '' },
    reviewedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    reviewedAt:     { type: Date, default: null },
    expiryNotifiedAt: { type: Date, default: null },
    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalDocumentSchema.index({ school: 1, student: 1, createdAt: -1 });
MedicalDocumentSchema.index({ school: 1, linkKind: 1, linkId: 1 });

module.exports = db.model('MedicalDocument', MedicalDocumentSchema);
