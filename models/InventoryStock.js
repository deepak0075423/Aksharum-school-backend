const db = require('../db/orm');

// Current stock balance for an item at a specific warehouse (spec §13).
// available = quantity - reserved. Updated by every stock transaction.
const InventoryStockSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    item: { type: db.Types.UUID, ref: 'InventoryItem', required: true },
    warehouse: { type: db.Types.UUID, ref: 'InventoryWarehouse', required: true },
    quantity: { type: Number, default: 0 },      // total on hand
    reserved: { type: Number, default: 0 },      // committed (issued but not returned / awaiting pick)
    avgCost: { type: Number, default: 0 },        // weighted average purchase cost
}, { timestamps: true });

InventoryStockSchema.virtual('available').get(function () {
    return Math.max(0, (this.quantity || 0) - (this.reserved || 0));
});
InventoryStockSchema.set('toJSON', { virtuals: true });
InventoryStockSchema.set('toObject', { virtuals: true });

InventoryStockSchema.index({ school: 1, item: 1, warehouse: 1 }, { unique: true });

module.exports = db.model('InventoryStock', InventoryStockSchema);
