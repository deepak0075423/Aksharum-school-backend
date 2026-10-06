const db = require('../db/orm');

/**
 * A rescue medicine a student must have within reach (Oct 2026): an
 * adrenaline auto-injector, a reliever inhaler, glucagon, a seizure rescue
 * medicine. One row per medicine, wherever its doses are kept — the school
 * bag, the Medical Room, the classroom, the bus — so whoever is with the
 * child knows where to reach, and the expiry date is watched (the sweep tells
 * the family before it runs out, and the room again if it has).
 *
 * The older `MedicalProfile.emergencyMedication` (one name, one place) is
 * still read for students who have nothing here yet.
 */
const MedicalRescueMedSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },

    kind: {
        type: String,
        enum: ['auto_injector', 'inhaler', 'glucagon', 'seizure', 'antihistamine', 'glucose', 'other'],
        default: 'other',
    },
    name:      { type: String, required: true, trim: true },   // "EpiPen Jr 0.15 mg"
    dose:      { type: String, default: '', trim: true },      // "1 injection into the outer thigh"
    quantity:  { type: Number, default: 1 },
    expiresOn: { type: Date, default: null },
    // Where the doses are: [{ place: bag|medical_room|classroom|bus|staff_room|hostel|sports|other, note }]
    locations: { type: Array, default: [] },
    selfCarry: { type: Boolean, default: false },              // the student carries it (see consent)
    instructions: { type: String, default: '', trim: true },
    notes:        { type: String, default: '', trim: true },

    status: { type: String, enum: ['active', 'used', 'returned', 'archived'], default: 'active' },
    source: { type: String, enum: ['staff', 'parent'], default: 'staff' },
    lastCheckedAt:   { type: Date, default: null },
    lastCheckedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    lastCheckedName: { type: String, default: '' },
    // The expiry date the family / the room were last told about, so each is told once.
    expiryNotifiedFor: { type: String, default: '' },
    expiredNotifiedFor: { type: String, default: '' },

    createdBy:     { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalRescueMedSchema.index({ school: 1, student: 1 });
MedicalRescueMedSchema.index({ school: 1, status: 1, expiresOn: 1 });

module.exports = db.model('MedicalRescueMed', MedicalRescueMedSchema);
