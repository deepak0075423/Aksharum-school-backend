const db = require('../db/orm');

// Immutable ledger of every stock movement (spec §13). Records are never edited
// or deleted — corrections are new adjustment entries.
const InventoryStockTransactionSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    item: { type: db.Types.UUID, ref: 'InventoryItem', required: true },
    warehouse: { type: db.Types.UUID, ref: 'InventoryWarehouse', required: true },

    type: {
        type: String,
        required: true,
        enum: ['purchase', 'issue', 'return', 'transfer_in', 'transfer_out', 'damage', 'repair', 'scrap', 'adjustment', 'audit'],
    },
    // Signed quantity delta applied to warehouse stock (+in / -out).
    quantity: { type: Number, required: true },
    balanceAfter: { type: Number, default: 0 },   // resulting on-hand qty (snapshot)
    unitCost: { type: Number, default: 0 },

    // Optional tracking info captured at movement time.
    batchNumber: { type: String, default: '' },
    serialNumbers: { type: [String], default: [] },
    expiryDate: { type: Date, default: null },

    // Loose back-reference to the source document (PO / Issue / GRN / audit…).
    refType: { type: String, default: '' },
    refId: { type: db.Types.UUID, default: null },

    note: { type: String, default: '' },
    performedBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryStockTransactionSchema.index({ school: 1, item: 1, createdAt: -1 });
InventoryStockTransactionSchema.index({ school: 1, warehouse: 1, createdAt: -1 });
InventoryStockTransactionSchema.index({ school: 1, type: 1 });

module.exports = db.model('InventoryStockTransaction', InventoryStockTransactionSchema);
