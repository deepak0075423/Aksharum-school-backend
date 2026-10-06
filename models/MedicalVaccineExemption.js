const db = require('../db/orm');

/**
 * Why a student is not to have a vaccine on the school's schedule (Oct 2026):
 * a medical reason (often for a while — `until`), proof of immunity, the
 * family's beliefs or their choice. Counted apart in the coverage, so the
 * school's figures stay honest, and never shown to teachers.
 *
 * `entryKey` names one dose of the schedule; empty means every dose of the
 * vaccine. Ended by archiving, never deleted.
 */
const MedicalVaccineExemptionSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },

    vaccine:  { type: String, required: true, trim: true },
    entryKey: { type: String, default: '' },
    reason:   { type: String, enum: ['medical', 'immune', 'religious', 'declined', 'other'], required: true },
    note:     { type: String, default: '', trim: true },
    document: { type: db.Types.UUID, ref: 'MedicalDocument', default: null },
    until:    { type: Date, default: null },

    recordedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    recordedByName: { type: String, default: '' },
    archivedAt:     { type: Date, default: null },
    archivedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason:  { type: String, default: '' },
}, { timestamps: true });

MedicalVaccineExemptionSchema.index({ school: 1, student: 1 });

module.exports = db.model('MedicalVaccineExemption', MedicalVaccineExemptionSchema);
