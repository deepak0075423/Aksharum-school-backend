const db = require('../db/orm');

// A repair / maintenance ticket embedded in an asset's history (spec §17).
const RepairSchema = new db.Schema({
    complaint: { type: String, required: true },
    reportedBy: { type: db.Types.UUID, ref: 'User', default: null },
    technician: { type: String, default: '' },
    status: { type: String, enum: ['reported', 'assigned', 'in_progress', 'completed', 'returned'], default: 'reported' },
    cost: { type: Number, default: 0 },
    reportedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    note: { type: String, default: '' },
}, { _id: true });

// An individually-tracked expensive item (laptop, projector, generator…), spec §16.
const InventoryAssetSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    item: { type: db.Types.UUID, ref: 'InventoryItem', default: null },
    // An asset may be registered without an item master row behind it (a bus, a
    // building fitting), so it carries its own category rather than borrowing
    // the item's — which is also what the Assets screen groups its donut by.
    category: { type: db.Types.UUID, ref: 'InventoryCategory', default: null },
    name: { type: String, required: true, trim: true },
    assetCode: { type: String, required: true, trim: true },
    image: { type: String, default: '' },
    serialNumber: { type: String, default: '' },
    qrCode: { type: String, default: '' },
    rfidTag: { type: String, default: '' },

    purchaseDate: { type: Date, default: null },
    purchaseCost: { type: Number, default: 0 },
    warrantyExpiry: { type: Date, default: null },
    amcExpiry: { type: Date, default: null },
    insuranceExpiry: { type: Date, default: null },
    // Next scheduled service. Its own field, not derived from the last repair:
    // an asset with no fault yet still has a service due date.
    nextMaintenance: { type: Date, default: null },
    maintenanceEveryMonths: { type: Number, default: 0 },

    // Straight-line depreciation (informational).
    depreciationRate: { type: Number, default: 0 },  // % per year
    currentValue: { type: Number, default: 0 },

    warehouse: { type: db.Types.UUID, ref: 'InventoryWarehouse', default: null },
    location: { type: String, default: '' },
    assignedTo: { type: db.Types.UUID, ref: 'User', default: null },
    assignedName: { type: String, default: '' },

    // Physical state, which is not the same question as whether it is in use:
    // a laptop can be In Use and Fair, or In Store and Poor.
    condition: { type: String, enum: ['good', 'fair', 'poor', 'damaged'], default: 'good' },

    // `in_store`/`assigned`/`under_repair`/`disposed`/`lost` are the original
    // five; `in_use`, `out_of_service` and `retired` were added for the Sep 2026
    // redesign, whose status filter is the school's vocabulary. Old rows keep
    // working — ASSET_STATUS in the controller maps both sets onto one word.
    status: {
        type: String,
        enum: ['in_store', 'in_use', 'assigned', 'under_repair', 'out_of_service', 'retired', 'disposed', 'lost'],
        default: 'in_store',
    },
    repairs: [RepairSchema],
    note: { type: String, default: '' },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryAssetSchema.index({ school: 1, assetCode: 1 }, { unique: true });
InventoryAssetSchema.index({ school: 1, status: 1 });
InventoryAssetSchema.index({ school: 1, assignedTo: 1 });

module.exports = db.model('InventoryAsset', InventoryAssetSchema);
