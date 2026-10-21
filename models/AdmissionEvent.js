const db = require('../db/orm');

/**
 * The admission module's history: every status move, note, document decision,
 * payment, exam step, list publication, offer, conversion, email and settings
 * change, in one append-only table. It is both the application's timeline and
 * the audit log.
 *
 *   visibility  'applicant' events also appear on the family's tracking page
 *               (worded for them in `message`); 'internal' ones never leave
 *               the office — internal notes are type 'note', internal.
 *   application null for school-level events (settings, templates, lists).
 */
const AdmissionEventSchema = new db.Schema({
    school:      { type: db.Types.UUID, ref: 'School', required: true },
    application: { type: db.Types.UUID, ref: 'AdmissionApplication', default: null },
    actor:       { type: db.Types.UUID, ref: 'User', default: null },
    actorRole:   { type: String, default: 'system' },
    actorName:   { type: String, default: '' },
    type:        { type: String, required: true },
    action:      { type: String, default: '' },
    from:        { type: String, default: '' },
    to:          { type: String, default: '' },
    message:     { type: String, default: '' },
    visibility:  { type: String, enum: ['internal', 'applicant'], default: 'internal' },
    meta:        { type: db.Types.JSON, default: null },
    createdAt:   { type: Date, default: Date.now },
});

AdmissionEventSchema.index({ school: 1, application: 1, createdAt: -1 });
AdmissionEventSchema.index({ school: 1, type: 1, createdAt: -1 });

module.exports = db.model('AdmissionEvent', AdmissionEventSchema);
