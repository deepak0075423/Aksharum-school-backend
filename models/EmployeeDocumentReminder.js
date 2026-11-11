const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  A reminder the office sent an employee about their documents.
//
//  One row per send. Whether it is still "open" is NOT stored: it is open while
//  any document it asked for is still missing or rejected, and that is worked
//  out from the employee's record when the list is read — so an upload closes
//  every reminder it answers without anything having to remember to update it.
// ─────────────────────────────────────────────────────────────────────────────

const EmployeeDocumentReminderSchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    employee: { type: db.Types.UUID, ref: 'User', required: true },
    // What was asked for: DOCUMENT_DEFS keys, with the reason each was owed
    // at the time ({ key, reason: 'missing' | 'rejected' }).
    documents: { type: Array, default: [] },
    message:  { type: String, default: '', trim: true },
    // 1 for the first reminder about an outstanding set, 2+ for follow-ups.
    sequence: { type: Number, default: 1 },
    email:    { type: Boolean, default: false },
    sentBy:   { type: db.Types.UUID, ref: 'User', default: null },
    sentAt:   { type: Date, default: Date.now },
}, { timestamps: true });

EmployeeDocumentReminderSchema.index({ school: 1, employee: 1, sentAt: -1 });

module.exports = db.model('EmployeeDocumentReminder', EmployeeDocumentReminderSchema);
