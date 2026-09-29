const db = require('../db/orm');

/**
 * The next number for a kind of document, per school.
 *
 * Numbers used to be `countDocuments() + 1`. Two people raising a request in
 * the same second both counted the same rows and both got the same number —
 * the unique index then rejected one of them with "Duplicate request number,
 * please retry". Deleting a row was worse: the count went down and the next
 * document reused a number a cancelled one already had.
 *
 * A counter row is incremented atomically instead, so a number is handed out
 * once and never reused. See services/inventoryNumber.js.
 */
const InventoryCounterSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    kind: { type: String, required: true },   // request | order | issue | return
    period: { type: String, default: '' },    // the year or year-month it resets on
    value: { type: Number, default: 0 },
}, { timestamps: true });

InventoryCounterSchema.index({ school: 1, kind: 1, period: 1 }, { unique: true });

module.exports = db.model('InventoryCounter', InventoryCounterSchema);
