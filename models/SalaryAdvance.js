const db = require('../db/orm');

/**
 * Money paid to an employee ahead of their salary, recovered from it.
 *
 * Covers both things schools actually do: a one-off advance taken against next
 * month's pay, and a loan repaid over a number of months. They differ only in
 * how many instalments there are, so they are one model with a `kind` rather
 * than two that would need the same recovery code twice.
 *
 * Recovery is driven by the payroll run: each run takes one instalment from
 * every active advance whose recovery has started, and stops of its own accord
 * once the balance is clear. `recovered` is the running total actually taken,
 * never a projection — a month where the employee earned too little to cover
 * the instalment takes what it can and leaves the rest outstanding.
 */
const RecoverySchema = new db.Schema({
    payrollRun: { type: db.Types.UUID, ref: 'PayrollRun' },
    month: Number,
    year: Number,
    amount: { type: Number, default: 0 },
    recoveredAt: { type: Date, default: Date.now },
}, { _id: false });

const SalaryAdvanceSchema = new db.Schema({
    employee: { type: db.Types.UUID, ref: 'User', required: true },
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    kind:     { type: String, enum: ['advance', 'loan'], default: 'advance' },
    amount:   { type: Number, required: true },
    // How many months to take it back over. 1 = the whole thing next month.
    instalments:      { type: Number, default: 1, min: 1 },
    instalmentAmount: { type: Number, default: 0 },
    recovered:        { type: Number, default: 0 },
    // Recovery begins with this pay month, so an advance paid today can be
    // taken back starting next month rather than out of the month in progress.
    startMonth: { type: Number, required: true, min: 1, max: 12 },
    startYear:  { type: Number, required: true },
    // 'active'    — still being recovered
    // 'closed'    — fully recovered, or written off
    // 'cancelled' — never disbursed after all
    status:   { type: String, enum: ['active', 'closed', 'cancelled'], default: 'active' },
    reason:   { type: String, default: '', trim: true },
    history:  [RecoverySchema],
    disbursedOn: { type: Date, default: Date.now },
    approvedBy: { type: db.Types.UUID, ref: 'User' },
    closedAt: { type: Date, default: null },
    closeNote: { type: String, default: '' },
}, { timestamps: true });

SalaryAdvanceSchema.index({ school: 1, employee: 1 });
SalaryAdvanceSchema.index({ school: 1, status: 1 });

module.exports = db.model('SalaryAdvance', SalaryAdvanceSchema);
