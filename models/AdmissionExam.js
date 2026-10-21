const db = require('../db/orm');

/**
 * An entrance examination or interview for one round.
 *
 *   mode        online     taken in the portal, timed by the server
 *               offline    sat on paper at a venue; marks entered by evaluators
 *               interview  a panel meeting; scored like an offline exam
 *   subjects    the parts marks are entered against: [{ key, name, maxMarks, passMarks }]
 *   eligibility which applications may be scheduled: statuses they must be in,
 *               and whether documents must be verified / the fee paid first
 *   settings    negative marking, randomisation, attempts, auto-submit
 *   admitCard   whether admit cards are issued, and from when
 *   evaluators  teachers (and staff) assigned to enter marks / evaluate
 *   booking     times a family picks for itself, each with room for so many
 *
 * Results are computed into AdmissionResult and only reach families once
 * `resultsPublishedAt` is set and has passed (scheduled publication).
 */
const AdmissionExamSchema = new db.Schema({
    school:        { type: db.Types.UUID, ref: 'School', required: true },
    round:         { type: db.Types.UUID, ref: 'AdmissionRound', required: true },
    name:          { type: String, required: true, trim: true },
    description:   { type: String, default: '' },
    instructions:  { type: String, default: '' },
    mode:          { type: String, enum: ['online', 'offline', 'interview'], default: 'offline' },
    classes:       { type: [db.Types.UUID], default: () => [] },
    eligibility:   { type: db.Types.JSON, default: () => ({ statuses: ['verified', 'eligible'], requireDocsVerified: false, requireApplicationFeePaid: false }) },
    subjects:      { type: db.Types.JSON, default: () => [] },
    maxMarks:      { type: Number, default: 0 },
    passMarks:     { type: Number, default: 0 },
    gradeBands:    { type: db.Types.JSON, default: () => [] },
    startsAt:      { type: Date, default: null },
    endsAt:        { type: Date, default: null },
    durationMinutes: { type: Number, default: 60 },
    reportingTime: { type: String, default: '' },
    venue:         { type: db.Types.JSON, default: () => ({}) },
    requiredItems: { type: String, default: '' },
    settings:      { type: db.Types.JSON, default: () => ({}) },
    admitCard:     { type: db.Types.JSON, default: () => ({ enabled: true, releaseAt: null, instructions: '' }) },
    evaluators:    { type: [db.Types.UUID], default: () => [] },
    // Times families choose themselves (Oct 2026; offline exams and interviews):
    // { enabled, slots: [{ id, startsAt, capacity, room }], changeUntilHours, maxChanges }.
    booking:       { type: db.Types.JSON, default: () => ({ enabled: false, slots: [], changeUntilHours: 24, maxChanges: 2 }) },
    approvalRequired: { type: Boolean, default: true },
    status:        { type: String, enum: ['draft', 'scheduled', 'completed', 'cancelled'], default: 'draft' },
    resultsStatus: { type: String, enum: ['none', 'in_progress', 'submitted', 'approved', 'published'], default: 'none' },
    resultPublishAt:    { type: Date, default: null },
    resultsPublishedAt: { type: Date, default: null },
    resultsApprovedAt:  { type: Date, default: null },
    resultsApprovedBy:  { type: db.Types.UUID, ref: 'User', default: null },
    createdBy:     { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:     { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionExamSchema.index({ school: 1, round: 1 });

module.exports = db.model('AdmissionExam', AdmissionExamSchema);
