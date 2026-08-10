const db = require('../db/orm');

const LineItemSchema = new db.Schema({
    name: { type: String, required: true },
    amount: { type: Number, required: true, default: 0 },
}, { _id: false });

const PayrollEntrySchema = new db.Schema({
    payrollRun: { type: db.Types.UUID, ref: 'PayrollRun', required: true },
    employee: { type: db.Types.UUID, ref: 'User', required: true },
    school: { type: db.Types.UUID, ref: 'School', required: true },
    month: { type: Number, required: true },
    year: { type: Number, required: true },
    salaryAssignment: { type: db.Types.UUID, ref: 'EmployeeSalaryAssignment' },
    earnings: [LineItemSchema],
    deductions: [LineItemSchema],
    grossSalary: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    netSalary: { type: Number, default: 0 },
    lopDays: { type: Number, default: 0 },
    lopAmount: { type: Number, default: 0 },
    arrears: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    payslip: { type: db.Types.UUID, ref: 'Payslip', default: null },
}, { timestamps: true });

PayrollEntrySchema.index({ payrollRun: 1, employee: 1 }, { unique: true });
PayrollEntrySchema.index({ school: 1, year: -1, month: -1 });
PayrollEntrySchema.index({ employee: 1, year: -1, month: -1 });

module.exports = db.model('PayrollEntry', PayrollEntrySchema);
