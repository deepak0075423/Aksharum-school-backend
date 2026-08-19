const db = require('../db/orm');

// A hostel document (spec §25).
//
// Storage is the existing uploads/ disk convention used by every other module
// (middleware/upload.js writes the file; this row is the metadata). The school
// Document model is a *sharing* surface with categories, versions and audience
// targeting — a different job from "the undertaking this resident signed", so
// this stays its own light table pointing at the same storage.
const HostelDocumentSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', default: null, index: true },
    student: { type: db.Types.UUID, ref: 'User', default: null, index: true },

    // What this document belongs to — an admission, an incident, a complaint…
    entityType: { type: String, default: '' },                 // HostelAdmission | HostelIncident | …
    entityId: { type: db.Types.UUID, default: null },

    docType: {
        type: String,
        enum: ['admission', 'id_proof', 'medical', 'parent_authorization', 'undertaking',
               'agreement', 'fee_receipt', 'outpass', 'incident', 'complaint', 'other'],
        default: 'other',
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    originalName: { type: String, default: '' },
    storedName: { type: String, required: true },              // uploads/hostel-docs/<file>
    mimeType: { type: String, default: '' },
    fileSize: { type: Number, default: 0 },

    // Verification & expiry (spec §25).
    verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
    verifiedBy: { type: db.Types.UUID, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },
    verificationRemark: { type: String, default: '' },
    expiryDate: { type: Date, default: null },

    version: { type: Number, default: 1 },
    replacesDocument: { type: db.Types.UUID, ref: 'HostelDocument', default: null },
    isActive: { type: Boolean, default: true },
    uploadedBy: { type: db.Types.UUID, ref: 'User', default: null },
    uploaderRole: { type: String, default: '' },
}, { timestamps: true });

HostelDocumentSchema.index({ school: 1, student: 1, docType: 1 });
HostelDocumentSchema.index({ school: 1, entityType: 1, entityId: 1 });
HostelDocumentSchema.index({ school: 1, expiryDate: 1 });

module.exports = db.model('HostelDocument', HostelDocumentSchema);
