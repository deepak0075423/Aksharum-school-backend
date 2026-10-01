const db = require('../db/orm');

// An online checkout that was opened for one or more hostel invoices.
//
// The order remembers WHICH invoices it was priced from and for how much, so
// that when the gateway reports the payment the money is put against exactly
// those invoices — not against whatever happens to be outstanding by then.
// It also makes a checkout that was opened and never confirmed visible to the
// fee desk, instead of a silent gap between the gateway and the books.
const HostelPaymentOrderSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },   // the resident billed
    openedBy: { type: db.Types.UUID, ref: 'User', required: true },              // the resident, or a parent
    openedByRole: { type: String, default: '' },

    orderId: { type: String, required: true, index: true },    // the gateway's order id
    amount: { type: Number, required: true },                  // rupees, as priced by the server
    lines: { type: db.Types.JSON, default: [] },               // [{ invoice, invoiceNumber, amount }]

    // 'expired': opened, never paid, and no longer worth asking the gateway about.
    status: { type: String, enum: ['created', 'paid', 'expired'], default: 'created' },
    lastCheckedAt: { type: Date, default: null },            // when the gateway was last asked about it
    confirmedBy: { type: String, default: '' },              // 'payer' | 'reconcile' — who brought the payment in
    paymentId: { type: String, default: '' },
    receiptNumber: { type: String, default: '' },
    paidAt: { type: Date, default: null },
    // Money the gateway took that could not be put against an invoice — it
    // was settled at the counter while the checkout was open. Never silently
    // dropped: the desk refunds or adjusts it.
    unapplied: { type: Number, default: 0 },
}, { timestamps: true });

HostelPaymentOrderSchema.index({ school: 1, orderId: 1 }, { unique: true });
HostelPaymentOrderSchema.index({ school: 1, student: 1, status: 1 });

module.exports = db.model('HostelPaymentOrder', HostelPaymentOrderSchema);
