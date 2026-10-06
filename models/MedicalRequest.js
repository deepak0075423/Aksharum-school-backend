const db = require('../db/orm');

/**
 * A teacher sending a student to the Medical Room (Oct 2026).
 *
 *   requested → accepted → arrived → treatment → returned | sent_home | referred → closed
 *
 * From `arrived` on, the case is a MedicalVisit (`visit`), and this row's
 * status follows the visit's — services/medicalWorkflow is the one writer of
 * both, so the teacher's view and the medical room's can never disagree.
 * `cancelled` is the teacher withdrawing a request nobody has acted on.
 *
 * `outcomeNote` is the only clinical word the teacher gets: what happened,
 * in a sentence the medical room chose to send ("Rested 20 minutes, back in
 * class"). Nothing else of the visit is visible to them.
 */
const step = new db.Schema({
    status: { type: String },
    at:     { type: Date },
    by:     { type: db.Types.UUID, ref: 'User', default: null },
    byName: { type: String, default: '' },
    note:   { type: String, default: '' },
}, { _id: false });

const MedicalRequestSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    number:  { type: String, required: true },                   // MR-2610-0007
    student: { type: db.Types.UUID, ref: 'User', required: true },
    requestedBy:     { type: db.Types.UUID, ref: 'User', required: true },
    requestedByName: { type: String, default: '' },
    requestedByRole: { type: String, default: 'teacher' },

    reason:   { type: String, required: true, trim: true },
    symptoms: { type: String, default: '', trim: true },
    location: { type: String, default: '', trim: true },
    urgency:  { type: String, enum: ['low', 'normal', 'high', 'emergency'], default: 'normal' },
    remarks:  { type: String, default: '', trim: true },
    // The student is coming on their own, or someone is bringing them.
    escortedBy: { type: String, default: '', trim: true },
    // Where it came from: '' a teacher (or the room), 'hostel' a resident unwell in the hostel — the
    // warden's medical incident (services/medicalHostel), the nurse sees them in the morning.
    source:         { type: String, default: '' },
    hostelIncident: { type: db.Types.UUID, ref: 'HostelIncident', default: null },

    status: {
        type: String,
        enum: ['requested', 'accepted', 'arrived', 'treatment', 'returned', 'sent_home', 'referred', 'closed', 'cancelled'],
        default: 'requested',
    },
    history: { type: [step], default: [] },

    acceptedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    acceptedAt:   { type: Date, default: null },
    arrivedAt:    { type: Date, default: null },
    closedAt:     { type: Date, default: null },
    cancelledAt:  { type: Date, default: null },
    cancelReason: { type: String, default: '' },
    visit:        { type: db.Types.UUID, ref: 'MedicalVisit', default: null },
    outcomeNote:  { type: String, default: '' },
}, { timestamps: true });

MedicalRequestSchema.index({ school: 1, number: 1 }, { unique: true });
MedicalRequestSchema.index({ school: 1, status: 1, createdAt: -1 });
MedicalRequestSchema.index({ school: 1, requestedBy: 1, createdAt: -1 });
MedicalRequestSchema.index({ school: 1, student: 1, createdAt: -1 });

module.exports = db.model('MedicalRequest', MedicalRequestSchema);
