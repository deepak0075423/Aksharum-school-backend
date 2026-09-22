const db = require('../db/orm');

/**
 * Something an employee spent on the school's behalf and is being paid back
 * for — travel, materials, a phone bill.
 *
 * A reimbursement is NOT salary: it is the return of money already spent, so it
 * is paid gross, is not taxable by default, and does not touch CTC. Paying it
 * through payroll is a convenience (one transfer instead of two), not a
 * statement that it is earnings — which is why it rides on the entry as its own
 * line rather than as a component of the salary structure.
 */
const SalaryClaimSchema = new db.Schema({
    employee: { type: db.Types.UUID, ref: 'User', required: true },
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    category: { type: String, default: 'Other', trim: true },
    amount:   { type: Number, required: true },
    description: { type: String, default: '', trim: true },
    claimedOn: { type: Date, default: Date.now },
    // Uploaded receipt, if the school asks for one.
    attachment: { type: String, default: '' },
    /**
     * pending → approved → paid, or pending → rejected.
     * Only an APPROVED claim is picked up by a payroll run; `paid` is set by
     * the run that paid it, together with the run it went out in, so the same
     * claim can never be reimbursed twice.
     */
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'paid'], default: 'pending' },
    // Most reimbursements are not income. A school that treats a particular
    // allowance as taxable can say so per claim.
    taxable: { type: Boolean, default: false },
    paidInRun: { type: db.Types.UUID, ref: 'PayrollRun', default: null },
    paidOn: { type: Date, default: null },
    decidedBy: { type: db.Types.UUID, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
}, { timestamps: true });

SalaryClaimSchema.index({ school: 1, employee: 1 });
SalaryClaimSchema.index({ school: 1, status: 1 });

module.exports = db.model('SalaryClaim', SalaryClaimSchema);
