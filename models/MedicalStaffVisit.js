const db = require('../db/orm');

/**
 * A member of staff seen in the Medical Room (Oct 2026): a headache, a cut in
 * the lab, a fall on the stairs. Medicines given come out of the same stock
 * as the students' (the stock ledger names the visit), but the record is kept
 * apart from any student's.
 */
const MedicalStaffVisitSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    number: { type: String, required: true },          // SV-2610-0007
    staff:  { type: db.Types.UUID, ref: 'User', required: true },
    arrivedAt: { type: Date, required: true, default: Date.now },
    reason:    { type: String, required: true, trim: true },
    symptoms:  { type: String, default: '' },
    vitals:    { type: Object, default: {} },
    treatment: { type: String, default: '' },
    medicines: { type: Array, default: [] },           // [{ item, name, dosage, quantity, batches, at }]
    outcome:   { type: String, enum: ['in_room', 'back_to_work', 'went_home', 'referred'], default: 'in_room' },
    outcomeNote: { type: String, default: '' },
    privateNotes: { type: String, default: '' },
    handledBy:     { type: db.Types.UUID, ref: 'User', default: null },
    handledByName: { type: String, default: '' },
    departedAt: { type: Date, default: null },
    createdBy:  { type: db.Types.UUID, ref: 'User', default: null },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalStaffVisitSchema.index({ school: 1, number: 1 }, { unique: true });
MedicalStaffVisitSchema.index({ school: 1, staff: 1, arrivedAt: -1 });
MedicalStaffVisitSchema.index({ school: 1, arrivedAt: -1 });

module.exports = db.model('MedicalStaffVisit', MedicalStaffVisitSchema);
