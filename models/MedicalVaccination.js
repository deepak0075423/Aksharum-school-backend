const db = require('../db/orm');

/**
 * One vaccine dose of one student — given (`givenOn` set) or still to come
 * (`dueOn`). Completed, pending, due soon and overdue are worked out at read
 * time from those dates (services/medicalRules.vaccinationStatus), so a dose
 * becomes overdue on its own the day after it was due.
 *
 * Recording a dose with a `nextDueOn` also creates the next dose as a pending
 * row, so the next one is never only a date on an old record.
 */
const MedicalVaccinationSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },

    vaccine:   { type: String, required: true, trim: true },
    dose:      { type: String, default: '', trim: true },    // Dose 1, Dose 2, Booster
    givenOn:   { type: Date, default: null },
    dueOn:     { type: Date, default: null },
    nextDueOn: { type: Date, default: null },
    provider:  { type: String, default: '', trim: true },    // hospital / clinic
    doctor:    { type: String, default: '', trim: true },
    lotNumber: { type: String, default: '', trim: true },
    certificate: { type: db.Types.UUID, ref: 'MedicalDocument', default: null },
    remarks:   { type: String, default: '', trim: true },

    source:     { type: String, enum: ['staff', 'parent'], default: 'staff' },
    verified:   { type: Boolean, default: true },
    verifiedBy: { type: db.Types.UUID, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },
    // Reminders already sent for this dose, so the sweep tells families once.
    remindedAt: { type: Date, default: null },
    overdueAt:  { type: Date, default: null },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalVaccinationSchema.index({ school: 1, student: 1 });
MedicalVaccinationSchema.index({ school: 1, dueOn: 1 });

module.exports = db.model('MedicalVaccination', MedicalVaccinationSchema);
