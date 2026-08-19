const db = require('../db/orm');

// Where a hostel asset physically sits and who holds it (spec §19).
//
// This is a MAPPING table, not a second asset master. Expensive, individually
// tracked items stay in InventoryAsset (the Inventory module owns purchase cost,
// warranty, depreciation, repairs); this row says which room/student that asset
// is with. `inventoryAsset` is null only for bulk hostel furniture the school
// never entered into Inventory, in which case the descriptive fields below carry it.
const HostelAssetSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    building: { type: db.Types.UUID, ref: 'HostelBuilding', default: null },
    floor: { type: db.Types.UUID, ref: 'HostelFloor', default: null },
    room: { type: db.Types.UUID, ref: 'HostelRoom', default: null, index: true },
    bed: { type: db.Types.UUID, ref: 'HostelBed', default: null },

    // The Inventory record this maps to, when the school tracks it there.
    inventoryAsset: { type: db.Types.UUID, ref: 'InventoryAsset', default: null, index: true },
    inventoryItem: { type: db.Types.UUID, ref: 'InventoryItem', default: null },

    name: { type: String, required: true, trim: true },
    assetCode: { type: String, default: '' },
    category: {
        type: String,
        enum: ['bed', 'mattress', 'table', 'chair', 'cupboard', 'fan', 'ac', 'electronics',
               'fire_safety', 'kitchen', 'other'],
        default: 'other',
    },
    quantity: { type: Number, default: 1 },
    condition: { type: String, enum: ['new', 'good', 'fair', 'damaged', 'scrapped'], default: 'good' },

    // Student-wise mapping (spec §19) — issued to a resident, returned at checkout.
    issuedTo: { type: db.Types.UUID, ref: 'User', default: null, index: true },
    issuedAt: { type: Date, default: null },
    returnedAt: { type: Date, default: null },

    status: {
        type: String,
        enum: ['in_room', 'issued', 'under_repair', 'returned', 'damaged', 'replaced', 'disposed'],
        default: 'in_room',
    },
    damageNote: { type: String, default: '' },
    damageCharge: { type: Number, default: 0 },
    remarks: { type: String, default: '' },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelAssetSchema.index({ school: 1, hostel: 1, status: 1 });
HostelAssetSchema.index({ school: 1, room: 1, status: 1 });

module.exports = db.model('HostelAsset', HostelAssetSchema);
