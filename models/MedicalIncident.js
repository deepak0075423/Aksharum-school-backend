const db = require('../db/orm');

/**
 * A medical incident or accident — something that happened to a student,
 * wherever it happened, reported by whoever saw it (a teacher on duty, the
 * medical room). Separate from a visit: a fall on the playground is an
 * incident whether or not the child is then treated in the room; when they
 * are, the visit points back here (`visit`).
 *
 * Supporting documents and photos are MedicalDocument rows (`documents`),
 * kept behind the module's own file guard like every other medical file.
 */
const step = new db.Schema({
    status: { type: String },
    at:     { type: Date },
    by:     { type: db.Types.UUID, ref: 'User', default: null },
    byName: { type: String, default: '' },
    note:   { type: String, default: '' },
}, { _id: false });

const MedicalIncidentSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    number:  { type: String, required: true },            // MI-2610-0003
    student: { type: db.Types.UUID, ref: 'User', required: true },

    occurredAt: { type: Date, required: true, default: Date.now },
    location:   { type: String, default: '', trim: true },
    type: {
        type: String,
        enum: ['playground', 'sports', 'fall', 'cut', 'fracture', 'fainting', 'fever', 'allergic', 'breathing', 'accident', 'other'],
        default: 'other',
    },
    description: { type: String, required: true, trim: true },
    injury:      { type: String, default: '', trim: true },
    bodyPart:    { type: String, default: '', trim: true },
    // Body map: [{ id, view front|back, region, kind, note }].
    injuries: { type: Array, default: [] },
    severity:    { type: String, enum: ['minor', 'moderate', 'serious', 'critical'], default: 'minor' },
    firstAid:     { type: String, default: '', trim: true },
    medicineUsed: { type: String, default: '', trim: true },
    witnesses:    { type: String, default: '', trim: true },
    witnessTeacher: { type: db.Types.UUID, ref: 'User', default: null },

    reportedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    reportedByName: { type: String, default: '' },
    reportedByRole: { type: String, default: '' },

    parentNotified:   { type: Boolean, default: false },
    parentNotifiedAt: { type: Date, default: null },
    parentNotifyNote: { type: String, default: '' },
    referral: {
        referred:      { type: Boolean, default: false },
        hospital:      { type: String, default: '' },
        reason:        { type: String, default: '' },
        transport:     { type: String, default: '' },
        accompaniedBy: { type: String, default: '' },
        at:            { type: Date, default: null },
    },
    followUp: {
        required: { type: Boolean, default: false },
        on:       { type: Date, default: null },
        note:     { type: String, default: '' },
        status:   { type: String, default: '' },
        doneAt:   { type: Date, default: null },
        doneBy:   { type: db.Types.UUID, ref: 'User', default: null },
        outcome:  { type: String, default: '' },
    },
    documents: { type: [db.Types.UUID], default: [] },
    remarks:   { type: String, default: '', trim: true },
    privateNotes: { type: String, default: '' },

    status:  { type: String, enum: ['reported', 'in_progress', 'resolved', 'closed'], default: 'reported' },
    history: { type: [step], default: [] },
    visit:   { type: db.Types.UUID, ref: 'MedicalVisit', default: null },
    request: { type: db.Types.UUID, ref: 'MedicalRequest', default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: db.Types.UUID, ref: 'User', default: null },

    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalIncidentSchema.index({ school: 1, number: 1 }, { unique: true });
MedicalIncidentSchema.index({ school: 1, occurredAt: -1 });
MedicalIncidentSchema.index({ school: 1, student: 1, occurredAt: -1 });
MedicalIncidentSchema.index({ school: 1, reportedBy: 1, occurredAt: -1 });

module.exports = db.model('MedicalIncident', MedicalIncidentSchema);
