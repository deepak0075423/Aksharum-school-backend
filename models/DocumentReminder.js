const db = require('../db/orm');

/**
 * When one student was last reminded about one assignment.
 *
 * A row per (assignment × student), written when a reminder goes to a named
 * student, so the "not again within ten minutes" rule is one fact every server
 * process reads. It used to be a list held in one process's memory: with
 * several workers each kept its own, and the same student could be reminded
 * once per worker.
 */
const DocumentReminderSchema = new db.Schema({
    document: { type: db.Types.UUID, ref: 'Document', required: true },
    student:  { type: db.Types.UUID, ref: 'User',     required: true },
    school:   { type: db.Types.UUID, ref: 'School',   required: true },
    sentAt:   { type: Date, default: Date.now },
}, { timestamps: true });

DocumentReminderSchema.index({ document: 1, student: 1 }, { unique: true });

module.exports = db.model('DocumentReminder', DocumentReminderSchema);
