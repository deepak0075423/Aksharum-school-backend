const db = require('../db/orm');

// What the sweep has already said, so it does not say it again every half hour.
//
// `key` identifies the thing being reported (an item at a store, a budget, a
// batch), `level` the severity it was reported at. A row exists once the school
// has been told; it is cleared when the condition clears, so the NEXT time the
// same item runs low it is reported again. Without the level in the key, an
// item that fell from low to out would stay silent at the worse news.
const InventoryAlertSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    kind: { type: String, required: true },       // low_stock | expiry | overdue_return | budget | capacity
    key: { type: String, required: true },        // stable identity of the subject
    level: { type: String, default: '' },         // warn | critical — same subject, worse news
    sentAt: { type: Date, default: Date.now },
    meta: { type: db.Types.JSON, default: {} },
}, { timestamps: true });

InventoryAlertSchema.index({ school: 1, kind: 1, key: 1, level: 1 }, { unique: true });
InventoryAlertSchema.index({ school: 1, kind: 1 });

module.exports = db.model('InventoryAlert', InventoryAlertSchema);
