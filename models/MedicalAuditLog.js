const db = require('../db/orm');

/**
 * Who did what to which medical record, and who looked at one (Oct 2026).
 *
 * Every write in the module lands here (services/medicalAudit), and so does
 * every opening of a student's medical profile, history, emergency profile or
 * file — views at most once per reader, student and kind of view in ten
 * minutes, so the log says who looked without repeating itself.
 *
 * `changes` is [{ field, from, to }] for an edit; private notes are recorded
 * as changed, never with their text.
 */
const MedicalAuditLogSchema = new db.Schema({
    school:    { type: db.Types.UUID, ref: 'School', required: true },
    actor:     { type: db.Types.UUID, ref: 'User', default: null },
    actorName: { type: String, default: '' },
    actorRole: { type: String, default: '' },
    action:    { type: String, required: true },     // created | updated | viewed | archived | …
    entity:    { type: String, default: '' },        // visit | incident | allergy | profile | document | …
    entityId:  { type: db.Types.UUID, default: null },
    student:   { type: db.Types.UUID, ref: 'User', default: null },
    summary:   { type: String, default: '' },
    changes:   { type: Array, default: [] },
    ip:        { type: String, default: '' },
    userAgent: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
});

MedicalAuditLogSchema.index({ school: 1, createdAt: -1 });
MedicalAuditLogSchema.index({ school: 1, student: 1, createdAt: -1 });
MedicalAuditLogSchema.index({ school: 1, actor: 1, createdAt: -1 });

module.exports = db.model('MedicalAuditLog', MedicalAuditLogSchema);
