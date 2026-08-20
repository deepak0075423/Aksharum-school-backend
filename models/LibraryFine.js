const db = require('../db/orm');

const LibraryFineSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
        index: true,
    },
    issuance: {
        type: db.Types.UUID,
        ref: 'LibraryIssuance',
        required: true,
    },
    user: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
        index: true,
    },
    fineType: {
        type: String,
        enum: ['late_return', 'lost', 'damaged'],
        required: true,
    },
    // `amount` is the charge as raised and never changes — it is the record of
    // what was levied. What has since been forgiven or collected is tracked
    // separately, so a fine can be part-waived and the rest still paid.
    //   outstanding = amount − waivedAmount − paidAmount
    waivedAmount: {
        type: Number,
        default: 0,
        min: 0,
    },
    paidAmount: {
        type: Number,
        default: 0,
        min: 0,
    },
    amount: {
        type: Number,
        required: true,
        min: 0,
    },
    daysOverdue: {
        type: Number,
        default: 0,
    },
    status: {
        type: String,
        enum: ['pending', 'paid', 'waived'],
        default: 'pending',
        index: true,
    },
    paidAt: {
        type: Date,
        default: null,
    },
    // ── How it was paid ──────────────────────────────────────────────────────
    // A fine settled at the counter and one paid on a phone both end up 'paid';
    // these say which, and give the parent something to show for it.
    paymentMode: {
        type: String,
        enum: ['cash', 'online'],
        default: 'cash',
    },
    receiptNumber: {
        type: String,
        default: '',
        trim: true,
    },
    gatewayOrderId: {
        type: String,
        default: '',
        trim: true,
    },
    gatewayPaymentId: {
        type: String,
        default: '',
        trim: true,
    },
    // Who actually paid — a parent may settle a child's fine.
    paidBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    collectedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    waivedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    waiverReason: {
        type: String,
        default: '',
        trim: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

LibraryFineSchema.index({ school: 1, status: 1 });
LibraryFineSchema.index({ school: 1, user: 1, status: 1 });

module.exports = db.model('LibraryFine', LibraryFineSchema);
