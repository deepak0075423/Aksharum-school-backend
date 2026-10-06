const db = require('../db/orm');

/**
 * One delivery of a medical item: its batch number, expiry and what is left.
 *
 *   active     in use; whether it is expiring or past its date is worked out
 *              at read time from `expiryDate` (services/medicalRules)
 *   expired    written off as expired — the quantity left was removed
 *   damaged    written off as damaged
 *   depleted   used up
 *   disposed   removed for another reason
 *
 * `quantity` changes only through services/medicalStock, which refuses to
 * take it below zero and writes the ledger row in the same transaction.
 */
const MedicalBatchSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    item:   { type: db.Types.UUID, ref: 'MedicalItem', required: true },

    batchNumber:  { type: String, default: '', trim: true },
    quantity:     { type: Number, default: 0 },
    received:     { type: Number, default: 0 },
    unitCost:     { type: Number, default: 0 },
    supplier:     { type: String, default: '', trim: true },
    purchaseDate: { type: Date, default: null },
    expiryDate:   { type: Date, default: null },
    location:     { type: db.Types.UUID, ref: 'MedicalLocation', default: null },   // null = the main Medical Room
    status: { type: String, enum: ['active', 'expired', 'damaged', 'depleted', 'disposed'], default: 'active' },
    note:   { type: String, default: '' },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

MedicalBatchSchema.index({ school: 1, item: 1, status: 1 });
MedicalBatchSchema.index({ school: 1, expiryDate: 1 });

module.exports = db.model('MedicalBatch', MedicalBatchSchema);
