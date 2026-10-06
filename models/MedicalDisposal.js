const db = require('../db/orm');

/**
 * The disposal register (Oct 2026): medicine taken out of use — expired,
 * damaged, recalled — and how it was finally got rid of. A write-off puts a
 * row here as `awaiting`; the person who destroys or returns it records the
 * method, a witness and any reference (the pharmacy's return note).
 */
const MedicalDisposalSchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    item:     { type: db.Types.UUID, ref: 'MedicalItem', required: true },
    batch:    { type: db.Types.UUID, ref: 'MedicalBatch', default: null },
    itemName: { type: String, default: '' },
    batchNumber: { type: String, default: '' },
    quantity: { type: Number, required: true },
    unit:     { type: String, default: '' },
    reason:   { type: String, enum: ['expired', 'damaged', 'recalled', 'other'], default: 'expired' },
    note:     { type: String, default: '' },
    status:   { type: String, enum: ['awaiting', 'disposed'], default: 'awaiting' },
    method:   { type: String, enum: ['', 'pharmacy_return', 'supplier_return', 'incineration', 'sharps_bin', 'drain_safe', 'other'], default: '' },
    reference:   { type: String, default: '' },
    disposedAt:  { type: Date, default: null },
    disposedBy:  { type: db.Types.UUID, ref: 'User', default: null },
    disposedByName: { type: String, default: '' },
    witnessBy:   { type: db.Types.UUID, ref: 'User', default: null },
    witnessName: { type: String, default: '' },
    createdBy:   { type: db.Types.UUID, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
}, { timestamps: true });

MedicalDisposalSchema.index({ school: 1, status: 1, createdAt: -1 });

module.exports = db.model('MedicalDisposal', MedicalDisposalSchema);
