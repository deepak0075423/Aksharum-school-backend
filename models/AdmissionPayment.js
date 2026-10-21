const db = require('../db/orm');

/**
 * Money paid towards an application: the application fee, or the admission
 * fee once a seat is offered. Online payments start as 'created' with the
 * gateway's order id and become 'paid' only after the gateway's signature is
 * verified (services/paymentGateway) — nothing here is ever marked paid on a
 * browser's word. Counter payments are recorded by the office with the mode
 * and reference. A waiver is a row of its own (mode 'waiver').
 *
 * receiptNumber is unique per school; paymentId (the gateway's) is unique, so
 * the same gateway payment can never be recorded twice.
 */
const AdmissionPaymentSchema = new db.Schema({
    school:        { type: db.Types.UUID, ref: 'School', required: true },
    application:   { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    applicant:     { type: db.Types.UUID, ref: 'User', default: null },
    kind:          { type: String, enum: ['application_fee', 'admission_fee'], required: true },
    amount:        { type: Number, required: true },
    currency:      { type: String, default: 'INR' },
    mode:          { type: String, enum: ['online', 'cash', 'cheque', 'dd', 'bank_transfer', 'upi', 'card', 'waiver'], default: 'online' },
    status:        { type: String, enum: ['created', 'paid', 'failed', 'cancelled', 'refunded', 'void'], default: 'created' },
    gateway:       { type: String, default: '' },
    orderId:       { type: String, default: '' },
    paymentId:     { type: String, default: '' },
    receiptNumber: { type: String, default: '' },
    reference:     { type: String, default: '' },
    paidAt:        { type: Date, default: null },
    waiver:        { type: db.Types.JSON, default: null },
    notes:         { type: String, default: '' },
    recordedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    voidedBy:      { type: db.Types.UUID, ref: 'User', default: null },
    voidReason:    { type: String, default: '' },
}, { timestamps: true });

AdmissionPaymentSchema.index({ school: 1, application: 1 });
AdmissionPaymentSchema.index({ school: 1, status: 1, paidAt: -1 });
AdmissionPaymentSchema.index({ school: 1, receiptNumber: 1 }, { unique: true, partialFilterExpression: { receiptNumber: { $gt: '' } } });
AdmissionPaymentSchema.index({ paymentId: 1 }, { unique: true, partialFilterExpression: { paymentId: { $gt: '' } } });

module.exports = db.model('AdmissionPayment', AdmissionPaymentSchema);
