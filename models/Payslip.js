const db = require('../db/orm');

const LineItemSchema = new db.Schema({
    name: { type: String, required: true },
    amount: { type: Number, required: true, default: 0 },
}, { _id: false });

const PayslipSchema = new db.Schema({
    payrollEntry: { type: db.Types.UUID, ref: 'PayrollEntry', required: true },
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
    },
    schoolSnapshot: {
        name: String,
        address: String,
        email: String,
        phone: String,
    },
    earnings: [LineItemSchema],
    deductions: [LineItemSchema],
    grossSalary: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    netSalary: { type: Number, default: 0 },
    lopDays: { type: Number, default: 0 },
    lopAmount: { type: Number, default: 0 },
    arrears: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    generatedAt: { type: Date, default: Date.now },
    generatedBy: { type: db.Types.UUID, ref: 'User' },
    isLocked: { type: Boolean, default: true },
    notificationSent: { type: Boolean, default: false },
}, { timestamps: true });

PayslipSchema.index({ employee: 1, year: -1, month: -1 });
PayslipSchema.index({ school: 1, year: -1, month: -1 });

module.exports = db.model('Payslip', PayslipSchema);
