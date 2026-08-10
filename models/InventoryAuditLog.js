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
    description: { type: String, default: '' },
    meta: { type: db.Types.JSON },
    timestamp: { type: Date, default: Date.now, index: true },
});

InventoryAuditLogSchema.index({ school: 1, timestamp: -1 });
InventoryAuditLogSchema.index({ school: 1, entityType: 1, entityId: 1 });

module.exports = db.model('InventoryAuditLog', InventoryAuditLogSchema);
