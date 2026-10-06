const db = require('../db/orm');

/**
 * One allergy of one student. A severe or life-threatening allergy is a
 * critical medical alert (services/medicalRules.alertsFor).
 *
 * Records are never overwritten into oblivion: an allergy that has gone is
 * marked `resolved`, one entered by mistake is archived (with who and why),
 * and every change is in the medical audit log.
 *
 * `source: 'parent'` is a record that arrived through a parent's update and
 * was approved — `verified` says whether the medical room has confirmed it.
 */
const MedicalAllergySchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },

    allergen: { type: String, required: true, trim: true },
    category: { type: String, enum: ['food', 'medicine', 'environmental', 'insect', 'other'], default: 'other' },
    severity: { type: String, enum: ['mild', 'moderate', 'severe', 'life_threatening'], default: 'mild' },
    reaction:              { type: String, default: '', trim: true },   // the symptoms it causes
    emergencyInstructions: { type: String, default: '', trim: true },
    medication:            { type: String, default: '', trim: true },
    doctor:                { type: String, default: '', trim: true },
    parentNote:            { type: String, default: '', trim: true },   // what the family told us
    documents:             { type: [db.Types.UUID], default: [] },
    // Whether the student's own teachers see it beside their alerts. On for
    // anything a teacher must act on; the medical room can keep a sensitive
    // record to itself (services/medicalRules.defaultShare).
    shareWithTeachers: { type: Boolean, default: true },

    status:     { type: String, enum: ['active', 'resolved'], default: 'active' },
    source:     { type: String, enum: ['staff', 'parent'], default: 'staff' },
    verified:   { type: Boolean, default: true },
    verifiedBy: { type: db.Types.UUID, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalAllergySchema.index({ school: 1, student: 1 });
MedicalAllergySchema.index({ school: 1, severity: 1 });

module.exports = db.model('MedicalAllergy', MedicalAllergySchema);
