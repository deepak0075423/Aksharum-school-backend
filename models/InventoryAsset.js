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
    name: { type: String, required: true, trim: true },
    assetCode: { type: String, required: true, trim: true },
    serialNumber: { type: String, default: '' },
    qrCode: { type: String, default: '' },
    rfidTag: { type: String, default: '' },

    purchaseDate: { type: Date, default: null },
    purchaseCost: { type: Number, default: 0 },
    warrantyExpiry: { type: Date, default: null },
    amcExpiry: { type: Date, default: null },
    insuranceExpiry: { type: Date, default: null },

    // Straight-line depreciation (informational).
    depreciationRate: { type: Number, default: 0 },  // % per year
    currentValue: { type: Number, default: 0 },

    warehouse: { type: db.Types.UUID, ref: 'InventoryWarehouse', default: null },
    location: { type: String, default: '' },
    assignedTo: { type: db.Types.UUID, ref: 'User', default: null },
    assignedName: { type: String, default: '' },

    status: {
        type: String,
        enum: ['in_store', 'assigned', 'under_repair', 'disposed', 'lost'],
        default: 'in_store',
    },
    repairs: [RepairSchema],
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryAssetSchema.index({ school: 1, assetCode: 1 }, { unique: true });
InventoryAssetSchema.index({ school: 1, status: 1 });
InventoryAssetSchema.index({ school: 1, assignedTo: 1 });

module.exports = db.model('InventoryAsset', InventoryAssetSchema);
