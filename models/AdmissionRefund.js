const db = require('../db/orm');

/**
 * Money given back on an admission payment (Oct 2026): through the payment
 * gateway for an online payment, or recorded by the office for one taken at
 * the counter. A refund that is pending or processed is no longer counted as
 * paid (services/admission/payments.js balance()).
 */
const AdmissionRefundSchema = new db.Schema({
    school:      { type: db.Types.UUID, ref: 'School', required: true },
    application: { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    payment:     { type: db.Types.UUID, ref: 'AdmissionPayment', required: true },
    kind:        { type: String, required: true },                     // application_fee | admission_fee
    amount:      { type: Number, required: true },
    mode:        { type: String, required: true },                     // gateway | cash | cheque | bank_transfer | upi
    status:      { type: String, enum: ['pending', 'processed', 'failed'], default: 'processed' },
    gatewayRefundId: { type: String, default: '' },
    reference:   { type: String, default: '' },
    reason:      { type: String, default: '' },
    error:       { type: String, default: '' },
    requestedBy: { type: db.Types.UUID, ref: 'User', default: null },
    processedAt: { type: Date, default: null },
}, { timestamps: true });

AdmissionRefundSchema.index({ school: 1, application: 1 });
AdmissionRefundSchema.index({ payment: 1 });

module.exports = db.model('AdmissionRefund', AdmissionRefundSchema);
