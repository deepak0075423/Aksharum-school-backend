const db = require('../db/orm');

/**
 * A family asking for one paper of a published result to be checked again
 * (Oct 2026). Open while the office looks; resolved with the marks as they
 * were ('unchanged') or corrected ('changed' — the result is worked out again
 * in place, services/resultExams.correctPublishedMark), or declined.
 */
const ResultRecheckSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    exam:    { type: db.Types.UUID, ref: 'FormalExam', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    subject: { type: db.Types.UUID, ref: 'Subject', required: true },
    requestedBy:     { type: db.Types.UUID, ref: 'User', required: true },
    requestedByRole: { type: String, default: '' },
    reason:  { type: String, default: '' },

    // open → resolved | declined
    status:   { type: String, default: 'open' },
    outcome:  { type: String, default: '' },          // unchanged | changed
    response: { type: String, default: '' },
    before:   { type: Object, default: null },        // { marksObtained, isAbsent }
    after:    { type: Object, default: null },
    resolvedBy: { type: db.Types.UUID, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    createdAt:  { type: Date, default: Date.now },
    updatedAt:  { type: Date, default: Date.now },
});

ResultRecheckSchema.index({ exam: 1, student: 1, subject: 1 });
ResultRecheckSchema.pre('save', async function () {
    this.updatedAt = new Date();
});

module.exports = db.model('ResultRecheck', ResultRecheckSchema);
