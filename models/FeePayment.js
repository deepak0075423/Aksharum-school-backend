const db = require('../db/orm');

const PaymentLineSchema = new db.Schema({
    feeHead: { type: db.Types.UUID, ref: 'FeeHead', default: null },
    feeName: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
}, { _id: false });

const FeePaymentSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    receiptNumber: { type: String, default: null },
    amount: { type: Number, required: true, min: 0 },
    lines: [PaymentLineSchema],
    paymentMode: {
        type: String,
        enum: ['cash', 'cheque', 'bank_transfer', 'online', 'dd', 'upi'],
        required: true,
    },
    paymentStatus: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded'],
        default: 'completed',
    },
    transactionRef: { type: String, default: '' },
    gateway: { type: String, enum: ['razorpay', 'stripe', 'manual'], default: 'manual' },
    gatewayOrderId: { type: String, default: '' },
    gatewayPaymentId: { type: String, default: '' },
    paymentDate: { type: Date, default: Date.now },
    remarks: { type: String, default: '' },
    collectedBy: { type: db.Types.UUID, ref: 'User', default: null },
    idempotencyKey: { type: String, default: null },
    isRefunded: { type: Boolean, default: false },
    refundedAt: { type: Date, default: null },
    refundedBy: { type: db.Types.UUID, ref: 'User', default: null },
    ledgerEntry: { type: db.Types.UUID, ref: 'FeeLedger', default: null },
    schoolSnapshot: { type: db.Types.JSON, default: null },
    studentSnapshot: { type: db.Types.JSON, default: null },
}, { timestamps: true });

FeePaymentSchema.index({ school: 1, student: 1, academicYear: 1 });
FeePaymentSchema.index({ school: 1, paymentDate: -1 });
FeePaymentSchema.index({ school: 1, paymentStatus: 1 });
FeePaymentSchema.index({ receiptNumber: 1 }, { unique: true, sparse: true });
FeePaymentSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = db.model('FeePayment', FeePaymentSchema);
