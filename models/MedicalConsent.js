const db = require('../db/orm');

/**
 * What a parent allows the Medical Room to do, for one school year (Oct 2026):
 * arrange emergency treatment when the family cannot be reached, give the
 * everyday medicines of the categories ticked (paracetamol for a fever, an
 * antihistamine …), share medical alerts with teachers beyond what safety
 * needs, photograph an injury for the record, and let the child carry their
 * own rescue medicine. A parent gives it in the app (typing their name), or
 * the medical staff record a paper form.
 *
 * status: requested (the school asked; nothing given yet) | given | withdrawn
 */
const MedicalConsentSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },
    yearName: { type: String, default: '' },

    emergencyTreatment: { type: Boolean, default: false },
    otc:                { type: [String], default: [] },     // the medicine categories allowed
    shareWithTeachers:  { type: Boolean, default: true },
    injuryPhotos:       { type: Boolean, default: false },
    selfCarry:          { type: Boolean, default: false },
    note:               { type: String, default: '' },

    status: { type: String, enum: ['requested', 'given', 'withdrawn'], default: 'requested' },
    signedName:  { type: String, default: '' },
    givenBy:     { type: db.Types.UUID, ref: 'User', default: null },
    givenByName: { type: String, default: '' },
    givenAt:     { type: Date, default: null },
    onPaper:     { type: Boolean, default: false },            // recorded by the medical staff from a signed form
    requestedAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },
    withdrawReason: { type: String, default: '' },
    history: { type: Array, default: [] },                     // [{ at, byName, status, summary }]
}, { timestamps: true });

MedicalConsentSchema.index({ school: 1, student: 1, academicYear: 1 }, { unique: true });
MedicalConsentSchema.index({ school: 1, academicYear: 1, status: 1 });

module.exports = db.model('MedicalConsent', MedicalConsentSchema);
