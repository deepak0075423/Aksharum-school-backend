const db = require('../db/orm');

// The module's history: who changed what in the library, a school's set-up or
// a release, and when. `school` is null for the central library. Append-only.
const LmsAuditSchema = new db.Schema({
    school:     { type: db.Types.UUID, ref: 'School', default: null, index: true },
    actor:      { type: db.Types.UUID, ref: 'User', default: null, index: true },
    actorRole:  { type: String, default: '' },
    action:     { type: String, required: true, index: true },
    entityType: { type: String, default: '' },
    entityId:   { type: db.Types.UUID, default: null },
    summary:    { type: String, default: '' },
    meta:       { type: db.Types.JSON, default: {} },
    ip:         { type: String, default: '' },
}, { timestamps: true });

LmsAuditSchema.index({ entityType: 1, entityId: 1 });
LmsAuditSchema.index({ school: 1, createdAt: 1 });

module.exports = db.model('LmsAudit', LmsAuditSchema);
