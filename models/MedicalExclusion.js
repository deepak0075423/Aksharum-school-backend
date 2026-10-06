const db = require('../db/orm');

/**
 * Off school until it is safe to come back (Oct 2026): a fever (24 hours
 * fever-free), vomiting or diarrhoea (48 hours), chickenpox, measles … The
 * rule (services/medicalExclusions, adjustable per school) gives the earliest
 * return from `from` — when the child was sent home or the illness started —
 * and says whether a doctor's fitness certificate is needed. The medical staff
 * clear the child to return; the family can upload the certificate.
 */
const MedicalExclusionSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    visit:   { type: db.Types.UUID, ref: 'MedicalVisit', default: null },

    rule:   { type: String, required: true },
    label:  { type: String, default: '' },          // the rule's name as it was
    text:   { type: String, default: '' },          // the rule's words for the family
    from:   { type: Date, required: true },
    earliestReturn: { type: Date, default: null },  // null = when a doctor says so
    needsCertificate: { type: Boolean, default: false },
    certificateDoc:   { type: db.Types.UUID, ref: 'MedicalDocument', default: null },
    note:   { type: String, default: '' },

    status: { type: String, enum: ['excluded', 'cleared', 'cancelled'], default: 'excluded' },
    clearedAt:   { type: Date, default: null },
    clearedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    clearedByName: { type: String, default: '' },
    clearNote:   { type: String, default: '' },
    cancelReason: { type: String, default: '' },

    createdBy:     { type: db.Types.UUID, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
}, { timestamps: true });

MedicalExclusionSchema.index({ school: 1, status: 1 });
MedicalExclusionSchema.index({ school: 1, student: 1, createdAt: -1 });

module.exports = db.model('MedicalExclusion', MedicalExclusionSchema);
