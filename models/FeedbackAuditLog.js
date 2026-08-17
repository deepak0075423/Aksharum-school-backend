const db = require('../db/orm');

// Immutable audit trail (spec §28), same shape as TransportAuditLog /
// LibraryAuditLog so the existing activity-log UI patterns carry straight over.
//
// Note on privacy: a submit entry records the ACTING user for anonymous
// campaigns too. That is deliberate — the audit log is the internal record kept
// for duplicate prevention and investigation, and it is only ever readable by
// school admins through /feedback/admin/audit. No teacher-facing endpoint reads
// this table.
const FeedbackAuditLogSchema = new db.Schema({
    school:      { type: db.Types.UUID, ref: 'School', required: true, index: true },
    user:        { type: db.Types.UUID, ref: 'User', default: null },
    role:        { type: String, default: '' },

    actionType:  { type: String, required: true },   // create / update / activate / close / submit / export …
    entityType:  { type: String, required: true },   // Campaign / Question / Category / Assignment / Report
    entityId:    { type: db.Types.UUID, default: null },
    campaign:    { type: db.Types.UUID, ref: 'FeedbackCampaign', default: null },
    assignment:  { type: db.Types.UUID, ref: 'FeedbackAssignment', default: null },
    description: { type: String, default: '' },
    meta:        { type: db.Types.JSON, default: {} },
}, { timestamps: true });

FeedbackAuditLogSchema.index({ school: 1, createdAt: -1 });
FeedbackAuditLogSchema.index({ school: 1, entityType: 1, entityId: 1 });

module.exports = db.model('FeedbackAuditLog', FeedbackAuditLogSchema);
