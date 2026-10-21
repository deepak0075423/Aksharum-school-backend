const db = require('../db/orm');

/**
 * A family asking the school to look again (Oct 2026): at an exam result (a
 * re-check of the marks) or at a decision that closed the application (not
 * eligible, not selected). Filed from the family's page within the school's
 * window; answered by an admission administrator within the school's time.
 *
 *   kind          recheck | decision
 *   status        open | in_review | upheld | not_upheld | withdrawn
 *   reason        the family's words
 *   decision      the answer the family reads
 *   internalNote  staff only — never shown to the family
 *   outcome       what changed: { before, after } marks for a re-check,
 *                 { reopenedTo } for a decision
 */
const AdmissionAppealSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    application:  { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    applicant:    { type: db.Types.UUID, ref: 'User', default: null },
    number:       { type: String, default: '' },
    kind:         { type: String, enum: ['recheck', 'decision'], required: true },
    exam:         { type: db.Types.UUID, ref: 'AdmissionExam', default: null },
    aboutStatus:  { type: String, default: '' },
    reason:       { type: String, default: '' },
    status:       { type: String, enum: ['open', 'in_review', 'upheld', 'not_upheld', 'withdrawn'], default: 'open' },
    dueAt:        { type: Date, default: null },
    assignedTo:   { type: db.Types.UUID, ref: 'User', default: null },
    decision:     { type: String, default: '' },
    internalNote: { type: String, default: '' },
    outcome:      { type: db.Types.JSON, default: () => ({}) },
    decidedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    decidedAt:    { type: Date, default: null },
}, { timestamps: true });

AdmissionAppealSchema.index({ school: 1, status: 1, createdAt: -1 });
AdmissionAppealSchema.index({ application: 1 });

module.exports = db.model('AdmissionAppeal', AdmissionAppealSchema);
