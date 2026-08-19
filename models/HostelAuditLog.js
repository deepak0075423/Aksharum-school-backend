const db = require('../db/orm');

// Immutable audit trail for the hostel module (spec §29). Written by the
// controller helper on every state change. `before`/`after` capture the changed
// fields only, so a diff is readable without storing whole documents.
const HostelAuditLogSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', default: null, index: true },
    user: { type: db.Types.UUID, ref: 'User', default: null },
    userName: { type: String, default: '' },
    role: { type: String, default: '' },

    actionType: { type: String, required: true },              // create / update / approve / allocate …
    entityType: { type: String, required: true },              // Hostel / Room / Allocation / Invoice …
    entityId: { type: db.Types.UUID, default: null },
    description: { type: String, default: '' },

    before: { type: db.Types.JSON, default: null },
    after: { type: db.Types.JSON, default: null },
    meta: { type: db.Types.JSON, default: {} },

    // Present when the app is behind a proxy that forwards them (trust proxy is
    // already configured in server.js).
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
}, { timestamps: true });

HostelAuditLogSchema.index({ school: 1, createdAt: -1 });
HostelAuditLogSchema.index({ school: 1, entityType: 1, entityId: 1 });
HostelAuditLogSchema.index({ school: 1, actionType: 1, createdAt: -1 });

module.exports = db.model('HostelAuditLog', HostelAuditLogSchema);
