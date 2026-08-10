const db = require('../db/orm');

// The Item Master (spec §3). Every physical resource is created here once, then
// purchased, issued, transferred, repaired, audited and disposed of.
const InventoryItemSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },

    // ── General ──────────────────────────────────────────────
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    image: { type: String, default: '' },
    category: { type: db.Types.UUID, ref: 'InventoryCategory', default: null },
    brand: { type: String, default: '' },
    model: { type: String, default: '' },

    // ── Inventory identity ───────────────────────────────────
    itemCode: { type: String, required: true, trim: true },   // human/school code
    barcode: { type: String, default: '' },
    qrCode: { type: String, default: '' },
    rfidTag: { type: String, default: '' },
    unit: { type: String, default: 'Nos' },                   // Nos, Kg, Ltr…

    // ── Financial ────────────────────────────────────────────
    purchasePrice: { type: Number, default: 0 },
    gst: { type: Number, default: 0 },                        // percentage
    hsnCode: { type: String, default: '' },
    reorderLevel: { type: Number, default: 0 },               // minimum stock (auto-reorder)

    // ── Default storage location ─────────────────────────────
    warehouse: { type: db.Types.UUID, ref: 'InventoryWarehouse', default: null },
    rack: { type: String, default: '' },
    shelf: { type: String, default: '' },
    bin: { type: String, default: '' },

    // ── Tracking flags ───────────────────────────────────────
    trackSerial: { type: Boolean, default: false },
    trackBatch: { type: Boolean, default: false },
    hasExpiry: { type: Boolean, default: false },
    warrantyMonths: { type: Number, default: 0 },

    // Expensive items are also tracked individually as Assets (spec §16).
    isAsset: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryItemSchema.index({ school: 1, itemCode: 1 }, { unique: true });
InventoryItemSchema.index({ school: 1, name: 1 });
InventoryItemSchema.index({ school: 1, category: 1 });

module.exports = db.model('InventoryItem', InventoryItemSchema);
