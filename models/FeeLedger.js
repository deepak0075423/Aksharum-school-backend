const db = require('../db/orm');

// Immutable double-entry ledger — source of truth for all financial positions
const FeeLedgerSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    entryType: { type: String, enum: ['debit', 'credit'], required: true },
    category: {
        type: String,
        enum: ['fee_charged', 'payment', 'concession', 'fine', 'refund', 'adjustment'],
        required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, required: true },
    referenceType: {
        type: String,
        enum: ['FeeStructure', 'StudentFeeAssignment', 'FeePayment', 'StudentConcession', 'FineRule', 'HostelFeeInvoice', 'Manual'],
        default: 'Manual',
    },
    referenceId: { type: db.Types.UUID, default: null },
    feeItemId:   { type: db.Types.UUID, default: null }, // FeeStructure item subdoc _id
    feePeriod:   { type: Number, default: null },   // 0-based period index for idempotency
    periodLabel: { type: String, default: '' },     // human label: "January 2026", "Quarter 2 — July 2026"
    runningBalance: { type: Number, default: 0 }, // positive = owes money, negative = credit/overpaid
    feeHeadName: { type: String, default: '' },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdAt: { type: Date, default: Date.now, immutable: true },
});

// No updates or deletes — append-only
FeeLedgerSchema.index({ school: 1, student: 1, academicYear: 1, createdAt: -1 });
FeeLedgerSchema.index({ school: 1, createdAt: -1 });
FeeLedgerSchema.index({ referenceType: 1, referenceId: 1 });
FeeLedgerSchema.index({ school: 1, student: 1, feeItemId: 1, category: 1, createdAt: -1 });
FeeLedgerSchema.index({ school: 1, category: 1, createdAt: -1 });

module.exports = db.model('FeeLedger', FeeLedgerSchema);
