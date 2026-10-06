const db = require('../db/orm');

/**
 * A count of a medicine on the shelf against the record (Oct 2026) — for a
 * controlled medicine every few days, witnessed; for any medicine when the
 * shelf looks wrong. A difference is never corrected here: it is reported,
 * and an adjustment with its reason is a separate step.
 */
const MedicalStockCountSchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    item:     { type: db.Types.UUID, ref: 'MedicalItem', required: true },
    at:       { type: Date, default: Date.now },
    expected: { type: Number, required: true },
    counted:  { type: Number, required: true },
    difference: { type: Number, default: 0 },
    note:     { type: String, default: '' },
    countedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    countedByName: { type: String, default: '' },
    witnessBy:     { type: db.Types.UUID, ref: 'User', default: null },
    witnessName:   { type: String, default: '' },
}, { timestamps: true });

MedicalStockCountSchema.index({ school: 1, item: 1, at: -1 });

module.exports = db.model('MedicalStockCount', MedicalStockCountSchema);
