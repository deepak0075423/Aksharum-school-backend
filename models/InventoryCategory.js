const db = require('../db/orm');

// Categories & Sub-Categories share one model. A sub-category has `parent` set
// to its owning category; a top-level category has parent = null.
const InventoryCategorySchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    name: { type: String, required: true, trim: true },
    parent: { type: db.Types.UUID, ref: 'InventoryCategory', default: null },
    description: { type: String, default: '' },

    // The redesign draws a category everywhere its items appear — in the item
    // row, the donut legend, the budget row — so the mark is stored once here
    // rather than being re-picked per screen. `icon` is a key into the module's
    // own glyph set (invUI → GLYPHS); `color` seeds the tint behind it.
    icon: { type: String, default: 'box' },
    color: { type: String, default: '' },

    // Defaults a new item in this category inherits, so "Set default purchase
    // and accounting preferences" on the Categories screen means something.
    defaultUnit: { type: String, default: '' },
    defaultGst: { type: Number, default: 0 },
    defaultHsnCode: { type: String, default: '' },
    defaultWarehouse: { type: db.Types.UUID, ref: 'InventoryWarehouse', default: null },

    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryCategorySchema.index({ school: 1, parent: 1, name: 1 }, { unique: true });

module.exports = db.model('InventoryCategory', InventoryCategorySchema);
