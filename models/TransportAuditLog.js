const db = require('../db/orm');

// Immutable audit trail for the transport module (spec: Audit Logs, Security).
// Written by the controller helper on every create/update/delete/state change.
const TransportAuditLogSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    user: { type: db.Types.UUID, ref: 'User', default: null },
    role: { type: String, default: '' },

    actionType: { type: String, required: true },            // create / update / delete / start_trip / pay …
    entityType: { type: String, required: true },            // Vehicle / Route / Trip / Invoice …
    entityId: { type: db.Types.UUID, default: null },
    description: { type: String, default: '' },
    meta: { type: db.Types.JSON, default: {} },
}, { timestamps: true });

TransportAuditLogSchema.index({ school: 1, createdAt: -1 });
TransportAuditLogSchema.index({ school: 1, entityType: 1, entityId: 1 });

module.exports = db.model('TransportAuditLog', TransportAuditLogSchema);
