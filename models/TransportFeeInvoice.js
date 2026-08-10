const db = require('../db/orm');

// A recorded payment against a transport invoice (spec §14).
const PaymentSchema = new db.Schema({
    amount: { type: Number, required: true },
    mode: { type: String, enum: ['cash', 'cheque', 'online', 'upi', 'card', 'bank_transfer'], default: 'cash' },
    reference: { type: String, default: '' },
    receiptNumber: { type: String, default: '' },
    paidAt: { type: Date, default: Date.now },
    receivedBy: { type: db.Types.UUID, ref: 'User', default: null },
    note: { type: String, default: '' },
}, { _id: true });

// A billed transport fee for a student for one period (spec §14). Ledger-style:
// paidAmount accumulates from the embedded payments; status is derived on save.
const TransportFeeInvoiceSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },

    invoiceNumber: { type: String, default: '' },            // TF-YYMM-####
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true }, // User w/ role student
    assignment: { type: db.Types.UUID, ref: 'TransportAssignment', default: null },
    feePlan: { type: db.Types.UUID, ref: 'TransportFeePlan', default: null },

    period: {
        month: { type: Number, default: null },              // 1-12 (null for yearly)
        year: { type: Number, required: true },
        label: { type: String, default: '' },                // "Jul 2026" / "Q1 2026-27"
    },

    amount: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    lateFee: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },                 // amount - discount + lateFee
    paidAmount: { type: Number, default: 0 },

    dueDate: { type: Date, default: null },
    status: { type: String, enum: ['pending', 'partial', 'paid', 'overdue', 'cancelled'], default: 'pending' },
    payments: [PaymentSchema],
    generatedBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

// Keep netAmount/paidAmount/status consistent on every save (sync pre-save hook).
TransportFeeInvoiceSchema.pre('save', function () {
    this.netAmount = Math.max(0, (this.amount || 0) - (this.discount || 0) + (this.lateFee || 0));
    this.paidAmount = (this.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    if (this.status !== 'cancelled') {
        if (this.paidAmount >= this.netAmount && this.netAmount > 0) this.status = 'paid';
        else if (this.paidAmount > 0) this.status = 'partial';
        else if (this.dueDate && this.dueDate < new Date()) this.status = 'overdue';
        else this.status = 'pending';
    }
});

TransportFeeInvoiceSchema.index({ school: 1, student: 1, 'period.year': 1, 'period.month': 1 });
TransportFeeInvoiceSchema.index({ school: 1, status: 1 });

module.exports = db.model('TransportFeeInvoice', TransportFeeInvoiceSchema);
