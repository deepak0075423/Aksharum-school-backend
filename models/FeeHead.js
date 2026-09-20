const db = require('../db/orm');

const FeeHeadSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    name: { type: String, required: true, trim: true },
    category: { type: db.Types.UUID, ref: 'FeeCategory', default: null },
    // How often the head is charged. `recurring` is monthly; `yearly` is once a
    // year, which inside one academic year's schedule charges like `one_time`.
    type: { type: String, enum: ['recurring', 'one_time', 'quarterly', 'half_yearly', 'yearly'], required: true },
    // fixed: every structure charges `defaultAmount`. variable: the amount is
    // set per structure and `defaultAmount` is only the suggestion.
    amountType: { type: String, enum: ['fixed', 'variable'], default: 'fixed' },
    defaultAmount: { type: Number, default: 0, min: 0 },
    description: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    // Archived heads leave every picker but stay on the structures and the
    // ledger rows that already name them, so past years still read true.
    isArchived: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },
    // Switching a head off stops it charging. These remember when, and which
    // months it was off for, so switching it back on does not bill the gap.
    deactivatedAt: { type: Date, default: null },
    skippedMonths: { type: db.Types.JSON, default: null },
    createdBy: { type: db.Types.UUID, ref: 'User' },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

FeeHeadSchema.index({ school: 1, name: 1 }, { unique: true });
FeeHeadSchema.index({ school: 1, isActive: 1 });

module.exports = db.model('FeeHead', FeeHeadSchema);
