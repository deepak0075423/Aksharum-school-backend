const db = require('../db/orm');

// A warehouse / store. `campus` is a free-text label so multiple campuses can be
// supported without a separate master (matches the spec's Campus A / Campus B).
const InventoryWarehouseSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    name: { type: String, required: true, trim: true },     // Main Store, Sports Store…
    campus: { type: String, default: 'Main Campus', trim: true },
    location: { type: String, default: '' },
    manager: { type: db.Types.UUID, ref: 'User', default: null },
    capacity: { type: Number, default: 0 },                 // optional, informational
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryWarehouseSchema.index({ school: 1, campus: 1, name: 1 }, { unique: true });

module.exports = db.model('InventoryWarehouse', InventoryWarehouseSchema);
