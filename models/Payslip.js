const db = require('../db/orm');

const LineItemSchema = new db.Schema({
    name: { type: String, required: true },
    code: { type: String, default: '' },
    amount: { type: Number, required: true, default: 0 },
    fullAmount: { type: Number, default: 0 },
}, { _id: false });

const PayslipSchema = new db.Schema({
    payrollEntry: { type: db.Types.UUID, ref: 'PayrollEntry', required: true },
    payrollRun: { type: db.Types.UUID, ref: 'PayrollRun', default: null },
    // Human-readable slip number: PS/2026-27/0001. Printed on the PDF.
    slipNo: { type: String, default: '', trim: true },
    employee: { type: db.Types.UUID, ref: 'User', required: true },
    school: { type: db.Types.UUID, ref: 'School', required: true },
    month: { type: Number, required: true },
    year: { type: Number, required: true },
    // Immutable snapshots at time of generation
    employeeSnapshot: {
        name: String,
        email: String,
        employeeId: String,
        designation: String,
        department: String,
        joiningDate: Date,
        // Frozen with the slip: a bank change next month must not rewrite the
        // account a past salary was actually paid into.
        bankAccountNumber: String,
        bankIfsc: String,
        bankName: String,
        panNumber: String,
        uanNumber: String,
        paymentMode: String,
    },
    schoolSnapshot: {
        name: String,
        address: String,
        email: String,
        phone: String,
    },
    earnings: [LineItemSchema],
    deductions: [LineItemSchema],
    employerContributions: [LineItemSchema],
    grossSalary: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    employerCost: { type: Number, default: 0 },
    netSalary: { type: Number, default: 0 },
    workingDays: { type: Number, default: 0 },
    paidDays: { type: Number, default: 0 },
    notEmployedDays: { type: Number, default: 0 },
    lopDays: { type: Number, default: 0 },
    lopAmount: { type: Number, default: 0 },
    arrears: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    overtimeHours: { type: Number, default: 0 },
    overtimeAmount: { type: Number, default: 0 },
    reimbursement: { type: Number, default: 0 },
    advanceRecovery: { type: Number, default: 0 },
    otherDeductions: { type: Number, default: 0 },
    remarks: { type: String, default: '' },
    generatedAt: { type: Date, default: Date.now },
    generatedBy: { type: db.Types.UUID, ref: 'User' },
    isLocked: { type: Boolean, default: true },
    notificationSent: { type: Boolean, default: false },
}, { timestamps: true });

/**
 * One payslip per payroll entry, enforced by the database rather than by the
 * check-then-write in publishRun(). Two admins pressing Publish at the same
 * moment both read "nobody has a slip yet" and both wrote one; the loser now
 * fails its insert instead, and publishRun treats that as "already issued".
 */
PayslipSchema.index({ payrollEntry: 1 }, { unique: true });
PayslipSchema.index({ employee: 1, year: -1, month: -1 });
PayslipSchema.index({ school: 1, year: -1, month: -1 });

module.exports = db.model('Payslip', PayslipSchema);
