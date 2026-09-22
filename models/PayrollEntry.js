const db = require('../db/orm');

const LineItemSchema = new db.Schema({
    name: { type: String, required: true },
    code: { type: String, default: '' },
    amount: { type: Number, required: true, default: 0 },
    // What the line would have been for a full month, before loss of pay. The
    // payslip prints both so a short month explains itself.
    fullAmount: { type: Number, default: 0 },
}, { _id: false });

const PayrollEntrySchema = new db.Schema({
    payrollRun: { type: db.Types.UUID, ref: 'PayrollRun', required: true },
    employee: { type: db.Types.UUID, ref: 'User', required: true },
    school: { type: db.Types.UUID, ref: 'School', required: true },
    month: { type: Number, required: true },
    year: { type: Number, required: true },
    salaryAssignment: { type: db.Types.UUID, ref: 'EmployeeSalaryAssignment' },
    structure: { type: db.Types.UUID, ref: 'SalaryStructure', default: null },
    annualCtc: { type: Number, default: 0 },
    earnings: [LineItemSchema],
    deductions: [LineItemSchema],
    // Employer cost (PF, ESI, gratuity): inside CTC, outside gross, never
    // deducted from the employee. Reported separately so the school can see
    // what a month really costs it.
    employerContributions: [LineItemSchema],
    grossSalary: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    employerCost: { type: Number, default: 0 },
    netSalary: { type: Number, default: 0 },
    workingDays: { type: Number, default: 26 },
    paidDays: { type: Number, default: 26 },
    // Working days outside the employment window — they joined on the 20th, or
    // left on the 3rd. Distinct from lopDays: nothing survives non-employment,
    // while a flat allowance survives unpaid leave. See services/payrollCalc.js.
    notEmployedDays: { type: Number, default: 0 },
    lopDays: { type: Number, default: 0 },
    lopAmount: { type: Number, default: 0 },
    // Where the LOP figure came from: 'leave' (approved unpaid leave),
    // 'manual' (typed by the admin, and therefore never overwritten by a
    // recompute) or 'none'.
    lopSource: { type: String, enum: ['none', 'leave', 'attendance', 'manual'], default: 'none' },
    // Rate-paid staff (guest faculty): units worked this month.
    units: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },
    arrears: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    // Overtime, priced per hour. Zero unless the school records hours — a
    // structure can carry a default rate so it does not have to be typed
    // for every person every month.
    overtimeHours: { type: Number, default: 0 },
    overtimeRate: { type: Number, default: 0 },
    overtimeAmount: { type: Number, default: 0 },
    // Expenses being paid back through this month's salary. Paid gross and
    // not taxable by default — see models/SalaryClaim.js.
    reimbursement: { type: Number, default: 0 },
    // Instalments of advances and loans taken out of this month's pay.
    advanceRecovery: { type: Number, default: 0 },
    otherDeductions: { type: Number, default: 0 },
    // A recovery bigger than the month's pay. Net floors at zero and the
    // remainder is carried rather than handing someone a negative payslip.
    unrecovered: { type: Number, default: 0 },
    remarks: { type: String, default: '' },
    // Set on a PAST entry once a back-dated CTC revision has been settled as
    // arrears in a later run, so the same difference is never paid twice.
    arrearsSettledBy: { type: db.Types.UUID, ref: 'PayrollRun', default: null },
    // An entry on hold is excluded from the run totals and gets no payslip —
    // the way a school withholds one person's pay without blocking the month.
    isOnHold: { type: Boolean, default: false },
    // True once an admin has hand-edited it, so a recompute can leave it alone.
    isEdited: { type: Boolean, default: false },
    payslip: { type: db.Types.UUID, ref: 'Payslip', default: null },
}, { timestamps: true });

PayrollEntrySchema.index({ payrollRun: 1, employee: 1 }, { unique: true });
PayrollEntrySchema.index({ school: 1, year: -1, month: -1 });
PayrollEntrySchema.index({ employee: 1, year: -1, month: -1 });

module.exports = db.model('PayrollEntry', PayrollEntrySchema);
