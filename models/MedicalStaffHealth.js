const db = require('../db/orm');

/**
 * A member of staff's own health record (Oct 2026) — what the Medical Room
 * needs to help them: allergies, conditions, the person to call. Kept apart
 * from the students' records; read by the medical staff and by the person
 * themselves, who may keep it up to date.
 */
const MedicalStaffHealthSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    staff:  { type: db.Types.UUID, ref: 'User', required: true },
    bloodGroup: { type: String, default: '' },
    allergies:  { type: Array, default: [] },     // [{ allergen, severity, reaction }]
    conditions: { type: Array, default: [] },     // [{ condition, notes }]
    medications: { type: String, default: '' },
    emergencyContact: { type: Object, default: {} },   // { name, relation, phone }
    doctor:     { type: Object, default: {} },         // { name, phone }
    notes:      { type: String, default: '' },
    updatedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
}, { timestamps: true });

MedicalStaffHealthSchema.index({ school: 1, staff: 1 }, { unique: true });

module.exports = db.model('MedicalStaffHealth', MedicalStaffHealthSchema);
