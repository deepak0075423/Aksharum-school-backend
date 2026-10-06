const db = require('../db/orm');

/**
 * The medical stock ledger — one row per movement, written only by
 * services/medicalStock in the same transaction as the balance it changes.
 *
 *   stock_in      received (a new batch)
 *   stock_out     issued for some other purpose
 *   administered  a dose given to a student
 *   first_aid     used giving first aid
 *   adjustment    a stock-take correction (either sign)
 *   expired       written off past its expiry date
 *   damaged       written off as damaged
 *   returned      put back — a dose recorded in error, an unopened supply
 *   disposed      removed for any other reason
 *
 * `quantity` is signed; `itemBalance` / `batchBalance` are the balances
 * straight after this movement. `refKind`/`refId` name what caused it.
 */
const MedicalStockMoveSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    item:   { type: db.Types.UUID, ref: 'MedicalItem', required: true },
    batch:  { type: db.Types.UUID, ref: 'MedicalBatch', default: null },
    kind:   { type: String, default: 'medicine' },                 // the item's kind, for filtering
    type: {
        type: String,
        enum: ['stock_in', 'stock_out', 'administered', 'first_aid', 'adjustment', 'expired', 'damaged', 'returned', 'disposed', 'transfer_out', 'transfer_in'],
        required: true,
    },
    quantity:     { type: Number, required: true },
    itemBalance:  { type: Number, default: 0 },
    batchBalance: { type: Number, default: 0 },
    reason:  { type: String, default: '' },
    refKind: { type: String, default: '' },     // visit | dose | firstaid | incident | batch
    refId:   { type: db.Types.UUID, default: null },
    student: { type: db.Types.UUID, ref: 'User', default: null },
    by:      { type: db.Types.UUID, ref: 'User', default: null },
    byName:  { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
});

MedicalStockMoveSchema.index({ school: 1, createdAt: -1 });
MedicalStockMoveSchema.index({ school: 1, item: 1, createdAt: -1 });

module.exports = db.model('MedicalStockMove', MedicalStockMoveSchema);
