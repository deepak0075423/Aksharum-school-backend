const db = require('../db/orm');

/**
 * A medicine a student takes during school hours, on a schedule (Oct 2026).
 *
 * The medicine is either from the school's stock (`item` set; each dose comes
 * out of a batch) or one the family sends in (`source: 'parent'`; nothing is
 * deducted). `times` are the clock times a dose is due on the plan's `days`
 * (0 = Sunday … 6 = Saturday) between `startDate` and `endDate`; an
 * `as_needed` plan has no times and its doses are recorded when given.
 *
 * Scheduled doses are MedicationDose rows generated for the day ahead by
 * services/medicalSweep (and on demand when the administration screen is
 * opened), one per (plan, time) — a unique index makes that idempotent. A
 * scheduled dose the schedule no longer wants is deleted, not cancelled, so
 * the slot can be generated again; a dose a person cancels stays cancelled.
 */
const MedicationPlanSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },

    source: { type: String, enum: ['school', 'parent'], default: 'school' },
    item:   { type: db.Types.UUID, ref: 'MedicalItem', default: null },
    medicineName: { type: String, required: true, trim: true },
    dosage:       { type: String, required: true, trim: true },   // "1 tablet (500 mg)"
    quantityPerDose: { type: Number, default: 1 },                   // stock units per dose
    route:  { type: String, default: 'Oral', trim: true },
    reason: { type: String, default: '', trim: true },
    frequency: { type: String, enum: ['once', 'twice', 'thrice', 'as_needed', 'custom'], default: 'once' },
    times: { type: [String], default: [] },                            // ['11:00', '13:30']
    days:  { type: [Number], default: [1, 2, 3, 4, 5, 6] },
    startDate: { type: Date, required: true },
    endDate:   { type: Date, default: null },
    instructions: { type: String, default: '', trim: true },
    // For an as-needed medicine above all: the least time between two doses and
    // the most in any 24 hours. null falls back to the stock item, then the class.
    minHoursBetween: { type: Number, default: null },
    maxPerDay:       { type: Number, default: null },

    parentAuthorization: {
        authorized: { type: Boolean, default: false },
        by:         { type: String, default: '' },
        byUser:     { type: db.Types.UUID, ref: 'User', default: null },
        at:         { type: Date, default: null },
    },
    prescription: { type: db.Types.UUID, ref: 'MedicalDocument', default: null },

    status: { type: String, enum: ['active', 'paused', 'completed', 'cancelled'], default: 'active' },
    // The family's own medicine: what was handed in and taken back —
    // [{ at, kind: received | returned, quantity, note, by, byName }] — and the
    // doses-left figure the family was last told about, so each warning goes once.
    supplied: { type: Array, default: [] },
    supplyPerDose: { type: Number, default: 1 },                 // of the family's supply, per dose (0 = not counted)
    supplyNotifiedLeft: { type: Number, default: null },
    statusNote: { type: String, default: '' },
    // When the schedule as it stands took effect: set each time the plan
    // becomes active (created authorised, authorised, resumed) or its times,
    // days or dates change. No dose slot earlier than this is generated — a
    // plan set up at 3 pm does not owe the school a 9 am dose it never had.
    activeFrom: { type: Date, default: null },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

MedicationPlanSchema.index({ school: 1, status: 1 });
MedicationPlanSchema.index({ school: 1, student: 1 });

module.exports = db.model('MedicationPlan', MedicationPlanSchema);
