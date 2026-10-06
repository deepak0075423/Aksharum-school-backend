const db = require('../db/orm');

/**
 * A family's request about the medical data the school holds on their child
 * (Oct 2026): a copy of it (access), a correction, or that it be erased. The
 * school answers within `dueOn` (30 days); an erasure the school must refuse
 * (a record the law or a safeguarding duty requires it to keep) says why.
 */
const MedicalDataRequestSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', default: null },     // null once the record has been purged
    studentName: { type: String, default: '' },
    kind:    { type: String, enum: ['access', 'correction', 'erasure'], required: true },
    details: { type: String, default: '' },
    requestedBy:     { type: db.Types.UUID, ref: 'User', required: true },
    requestedByName: { type: String, default: '' },
    dueOn:   { type: Date, required: true },
    status:  { type: String, enum: ['open', 'done', 'refused'], default: 'open' },
    response: { type: String, default: '' },
    respondedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    respondedByName: { type: String, default: '' },
    respondedAt:     { type: Date, default: null },
}, { timestamps: true });

MedicalDataRequestSchema.index({ school: 1, status: 1, dueOn: 1 });
MedicalDataRequestSchema.index({ school: 1, student: 1 });

module.exports = db.model('MedicalDataRequest', MedicalDataRequestSchema);
