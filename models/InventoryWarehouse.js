const db = require('../db/orm');

// A warehouse / store. `campus` is a free-text label so multiple campuses can be
// supported without a separate master (matches the spec's Campus A / Campus B).
const InventoryWarehouseSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    name: { type: String, required: true, trim: true },     // Main Store, Sports Store…
    // The screens list stores by a short code (WH-001) the way they list items
    // by an item code; it is generated on create when nobody types one.
    code: { type: String, default: '', trim: true },
    // What the store is for. `main` is the school's central store, `department`
    // one owned by a department, `secondary` an overflow or retired space.
    type: { type: String, enum: ['main', 'department', 'secondary'], default: 'department' },
    description: { type: String, default: '' },
    image: { type: String, default: '' },
    campus: { type: String, default: 'Main Campus', trim: true },
    location: { type: String, default: '' },
    manager: { type: db.Types.UUID, ref: 'User', default: null },
    contactPerson: { type: String, default: '' },
    phone: { type: String, default: '' },
    capacity: { type: Number, default: 0 },                 // total units it holds
    // Percentage of capacity above which the store is reported "Low Capacity".
    lowCapacityAt: { type: Number, default: 80 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryWarehouseSchema.index({ school: 1, campus: 1, name: 1 }, { unique: true });

module.exports = db.model('InventoryWarehouse', InventoryWarehouseSchema);
