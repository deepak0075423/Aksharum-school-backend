const db = require('../db/orm');

/**
 * A salary structure: the rule set that turns one employee's annual CTC into a
 * month's earnings, deductions and employer contributions.
 *
 * The redesign (Sep 2026) made the structure CTC-aware. Before it, every
 * component was a flat rupee figure or a percentage of another flat figure, so
 * two employees on the same structure were paid exactly the same however
 * different their CTC — the CTC stored against the assignment was never read.
 * Three things fixed that:
 *
 *   percentageOf: 'CTC'      a percentage of the employee's MONTHLY CTC
 *   calculationType 'balance' the residual: whatever is left of monthly CTC
 *                             once every other earning and employer cost is
 *                             taken. One per structure — this is what makes
 *                             the earnings side add up to CTC exactly.
 *   type: 'employer'          an employer cost (PF, ESI, gratuity). Part of
 *                             CTC, never part of gross, never deducted.
 *
 * Statutory components also need ceilings: PF is 12% of basic but only up to a
 * ₹15,000 wage, ESI stops above a gross. `wageCeiling` caps the BASE a
 * percentage is taken of; `capAmount` caps the resulting amount.
 */
const ComponentSchema = new db.Schema({
    name:  { type: String, required: true, trim: true },
    // Short code for reports and the payslip ("BASIC", "HRA", "PF").
    code:  { type: String, default: '', trim: true },
    type:  { type: String, enum: ['earning', 'deduction', 'employer'], required: true },
    calculationType: { type: String, enum: ['fixed', 'percentage', 'balance'], required: true },
    value:      { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    // 'CTC' = monthly CTC; anything else names another component resolved before
    // this one (so `order` matters).
    percentageOf: { type: String, default: 'Basic Salary', trim: true },
    // Statutory limits. 0 = no limit.
    wageCeiling: { type: Number, default: 0 },   // cap the BASE before the % is taken
    capAmount:   { type: Number, default: 0 },   // cap the resulting amount
    minAmount:   { type: Number, default: 0 },   // floor the resulting amount
    // Does a loss-of-pay day reduce this line? Earnings normally yes; a fixed
    // reimbursement or a flat professional tax normally no.
    proRated: { type: Boolean, default: true },
    taxable:  { type: Boolean, default: true },
    order:    { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
}, { _id: true });

const SalaryStructureSchema = new db.Schema({
    name:   { type: String, required: true, trim: true },
    school: { type: db.Types.UUID, ref: 'School', required: true },
    description: { type: String, default: '' },
    // Groups the structures on the listing and colours the row badge.
    type: {
        type: String,
        enum: ['teaching', 'non_teaching', 'administration', 'contract', 'general'],
        default: 'general',
    },
    /**
     * 'monthly' — CTC-driven, the normal case.
     * 'rate'    — paid per unit of work (guest faculty at ₹800 a class). The
     *             units worked are entered on the payroll entry each month;
     *             gross is units × rate and CTC is not used.
     */
    payBasis: { type: String, enum: ['monthly', 'rate'], default: 'monthly' },
    rate:     { type: Number, default: 0 },
    rateUnit: { type: String, enum: ['class', 'hour', 'day'], default: 'class' },
    // What an hour of overtime is worth on this structure. Zero means the
    // school does not pay overtime on it.
    overtimeRate: { type: Number, default: 0 },
    components: [ComponentSchema],
    // Offered first when assigning an employee who has no structure yet.
    isDefault: { type: Boolean, default: false },
    isActive:  { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
    updatedBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

SalaryStructureSchema.index({ school: 1, isActive: 1 });
SalaryStructureSchema.index({ school: 1, name: 1 }, { unique: true });

module.exports = db.model('SalaryStructure', SalaryStructureSchema);
