const db = require('../db/orm');

/**
 * One dose — scheduled, given, missed, refused or cancelled. The complete
 * administration history of a student is these rows (Oct 2026).
 *
 * A dose with a `plan` and `scheduledFor` was generated from the plan's
 * schedule; one without (`source: 'visit' | 'manual'`) was given as needed —
 * in a Medical Room visit, or recorded on its own. A given dose from the
 * school's stock names the batches it came out of (`batches`); cancelling it
 * puts them back.
 */
const MedicationDoseSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    plan:    { type: db.Types.UUID, ref: 'MedicationPlan', default: null },
    item:    { type: db.Types.UUID, ref: 'MedicalItem', default: null },
    source:  { type: String, enum: ['plan', 'visit', 'manual'], default: 'plan' },

    medicineName: { type: String, required: true, trim: true },
    dosage:       { type: String, default: '', trim: true },
    quantity:     { type: Number, default: 0 },          // stock units taken (0 = not from stock)
    batches:      { type: Array, default: [] },          // [{ batch, batchNumber, quantity }]

    scheduledFor: { type: Date, default: null },
    status: { type: String, enum: ['scheduled', 'given', 'missed', 'refused', 'cancelled'], default: 'scheduled' },
    givenAt:     { type: Date, default: null },
    givenBy:     { type: db.Types.UUID, ref: 'User', default: null },
    givenByName: { type: String, default: '' },
    note:        { type: String, default: '' },
    visit:       { type: db.Types.UUID, ref: 'MedicalVisit', default: null },
    recordedBy:  { type: db.Types.UUID, ref: 'User', default: null },
    // A controlled medicine: the second member of staff who saw it given.
    witnessBy:   { type: db.Types.UUID, ref: 'User', default: null },
    witnessName: { type: String, default: '' },
    // A safety check that was overridden to give this dose, with the reason:
    // [{ code: allergy | interval | daily_max, message, reason, by, byName, at }]
    safetyOverrides: { type: Array, default: [] },
}, { timestamps: true });

MedicationDoseSchema.index({ school: 1, scheduledFor: 1 });
MedicationDoseSchema.index({ school: 1, student: 1, createdAt: -1 });
MedicationDoseSchema.index({ school: 1, status: 1 });

module.exports = db.model('MedicationDose', MedicationDoseSchema);
