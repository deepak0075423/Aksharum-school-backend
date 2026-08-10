const db = require('../db/orm');

// Categories & Sub-Categories share one model. A sub-category has `parent` set
// to its owning category; a top-level category has parent = null.
const InventoryCategorySchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    name: { type: String, required: true, trim: true },
    parent: { type: db.Types.UUID, ref: 'InventoryCategory', default: null },
    description: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryCategorySchema.index({ school: 1, parent: 1, name: 1 }, { unique: true });

module.exports = db.model('InventoryCategory', InventoryCategorySchema);
