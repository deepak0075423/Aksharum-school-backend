const db = require('../db/orm');

/**
 * A parent's proposed change to their child's medical record — a new allergy,
 * a condition, an emergency contact, the family doctor, a document — waiting
 * for the medical room to approve it (Oct 2026).
 *
 * Nothing a parent submits reaches the record until it is approved, unless
 * the school's settings say parents' updates need no approval; the request is
 * kept either way, so the record says where every fact came from.
 *
 *   kind    allergy | condition | contact | doctor | hospital | profile | vaccination | document
 *   action  add | update | remove
 *   target  the record an update or removal is about
 *   payload the proposed values, in the shape the matching staff form takes
 */
const MedicalChangeRequestSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    submittedBy:     { type: db.Types.UUID, ref: 'User', required: true },
    submittedByName: { type: String, default: '' },

    kind:   { type: String, enum: ['allergy', 'condition', 'contact', 'doctor', 'hospital', 'profile', 'vaccination', 'document'], required: true },
    action: { type: String, enum: ['add', 'update', 'remove'], default: 'add' },
    target:  { type: db.Types.UUID, default: null },
    payload: { type: Object, default: {} },
    note:    { type: String, default: '', trim: true },
    document: { type: db.Types.UUID, ref: 'MedicalDocument', default: null },

    status: { type: String, enum: ['pending', 'approved', 'rejected', 'withdrawn'], default: 'pending' },
    reviewedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    reviewedByName: { type: String, default: '' },
    reviewedAt:     { type: Date, default: null },
    reviewNote:     { type: String, default: '' },
    result:         { type: db.Types.UUID, default: null },
}, { timestamps: true });

MedicalChangeRequestSchema.index({ school: 1, status: 1, createdAt: -1 });
MedicalChangeRequestSchema.index({ school: 1, student: 1, createdAt: -1 });

module.exports = db.model('MedicalChangeRequest', MedicalChangeRequestSchema);
