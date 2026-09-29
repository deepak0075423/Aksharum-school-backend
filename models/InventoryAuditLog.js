const db = require('../db/orm');

// Immutable activity log (spec §24). Every meaningful action is recorded; entries
// are only ever read, never edited or deleted.
const InventoryAuditLogSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    user: { type: db.Types.UUID, ref: 'User' },
    role: String,
    actionType: { type: String, required: true },  // ITEM_CREATED, PR_APPROVED, PO_CREATED, STOCK_IN…
    entityType: { type: String, default: '' },     // InventoryItem, PurchaseRequest, PurchaseOrder…
    entityId: { type: db.Types.UUID, default: null },
    // The human code of the thing acted on (PO-2026-084, ITM-045). The log is
    // read by people, and a UUID tells them nothing; the Reference column on
    // the Activity Log screen is this field.
    referenceCode: { type: String, default: '' },
    description: { type: String, default: '' },
    // Where the action came from. Recorded because an audit trail that cannot
    // say which machine made a change is not an audit trail.
    ip: { type: String, default: '' },
    // Deletions, cancellations, write-offs and budget changes — the rows the
    // screen counts as "Critical Changes" and offers as a filter.
    critical: { type: Boolean, default: false },
    meta: { type: db.Types.JSON },
    timestamp: { type: Date, default: Date.now, index: true },
});

InventoryAuditLogSchema.index({ school: 1, timestamp: -1 });
InventoryAuditLogSchema.index({ school: 1, entityType: 1, entityId: 1 });

module.exports = db.model('InventoryAuditLog', InventoryAuditLogSchema);
