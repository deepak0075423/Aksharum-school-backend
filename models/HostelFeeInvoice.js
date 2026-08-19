const db = require('../db/orm');

// A billed hostel charge (spec §16).
//
// Payment capture follows the TransportFeeInvoice shape (embedded payments,
// derived status) so the fee desk works the same way everywhere, and every
// charge / payment / refund is ALSO posted to the shared FeeLedger — the
// immutable double-entry ledger the Fees module already treats as the source of
// truth for a student's position. No second gateway, receipt or ledger is built.
const PaymentSchema = new db.Schema({
    amount: { type: Number, required: true },
    mode: { type: String, enum: ['cash', 'cheque', 'online', 'upi', 'card', 'bank_transfer'], default: 'cash' },
    reference: { type: String, default: '' },
    receiptNumber: { type: String, default: '' },
    paidAt: { type: Date, default: Date.now },
    receivedBy: { type: db.Types.UUID, ref: 'User', default: null },
    note: { type: String, default: '' },
}, { _id: true });

const HostelFeeInvoiceSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    invoiceNumber: { type: String, default: '' },              // HF-YYMM-####

    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', default: null, index: true },
    allocation: { type: db.Types.UUID, ref: 'HostelAllocation', default: null },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null, index: true },
    feePlan: { type: db.Types.UUID, ref: 'HostelFeePlan', default: null },

    feeType: {
        type: String,
        enum: ['admission', 'monthly', 'quarterly', 'annual', 'mess', 'laundry', 'electricity',
               'maintenance', 'security_deposit', 'fine', 'late_fee', 'other'],
        default: 'monthly',
    },
    period: {
        month: { type: Number, default: null },                // 1-12 (null for annual)
        year: { type: Number, default: null },
        label: { type: String, default: '' },                  // "Aug 2026"
    },

    amount: { type: Number, required: true, default: 0 },
    discount: { type: Number, default: 0 },                    // concession / scholarship / waiver
    discountReason: { type: String, default: '' },
    lateFee: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    refundedAmount: { type: Number, default: 0 },

    dueDate: { type: Date, default: null },
    status: {
        type: String,
        enum: ['pending', 'partial', 'paid', 'overdue', 'cancelled', 'refunded'],
        default: 'pending',
    },
    // Security deposits are held, not earned — tracked so a refund at checkout
    // can be reconciled without reading the whole payment history.
    isRefundable: { type: Boolean, default: false },
    refundedAt: { type: Date, default: null },
    refundReference: { type: String, default: '' },

    payments: [PaymentSchema],
    remarks: { type: String, default: '' },
    generatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

// Keep the derived money fields honest on every save (sync hook — the ORM's
// pre('save') is not awaited per-field, so this must stay synchronous).
HostelFeeInvoiceSchema.pre('save', function () {
    this.netAmount  = Math.max(0, (this.amount || 0) - (this.discount || 0) + (this.lateFee || 0));
    this.paidAmount = (this.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    if (this.status !== 'cancelled' && this.status !== 'refunded') {
        if (this.paidAmount >= this.netAmount && this.netAmount > 0) this.status = 'paid';
        else if (this.paidAmount > 0) this.status = 'partial';
        else if (this.dueDate && this.dueDate < new Date()) this.status = 'overdue';
        else this.status = 'pending';
    }
});

HostelFeeInvoiceSchema.index({ school: 1, student: 1, 'period.year': 1, 'period.month': 1 });
HostelFeeInvoiceSchema.index({ school: 1, status: 1 });
HostelFeeInvoiceSchema.index({ school: 1, hostel: 1, status: 1 });

module.exports = db.model('HostelFeeInvoice', HostelFeeInvoiceSchema);
