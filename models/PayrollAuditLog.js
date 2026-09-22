const db = require('../db/orm');

/**
 * Who changed what, in a module where every change is money.
 *
 * `timestamps: true` is new and deliberate: the schema carried its own
 * `timestamp` field but the reader sorted on `createdAt`, which no column
 * backed — so the log came back in whatever order Postgres felt like. Both
 * columns now exist and `createdAt` is the one that is sorted on.
 */
const PayrollAuditLogSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    user: { type: db.Types.UUID, ref: 'User' },
    role: String,
    actionType: {
        type: String,
        required: true,
        // STRUCTURE_CREATED / UPDATED / DELETED / TOGGLED / DUPLICATED
        // ASSIGNMENT_CREATED / UPDATED / DEACTIVATED / REACTIVATED / CTC_UPDATED
        // RUN_CREATED / RECOMPUTED / REVIEWED / APPROVED / PUBLISHED / UNPUBLISHED
        //   / CANCELLED / DELETED / FAILED
        // ENTRY_UPDATED / ENTRY_HELD / ENTRY_RELEASED / PAYSLIP_GENERATED
        // REPORT_GENERATED / SETTINGS_UPDATED
    },
    entityType: {
        type: String,
        enum: ['SalaryStructure', 'EmployeeSalaryAssignment', 'PayrollRun', 'PayrollEntry', 'Payslip', 'PayrollSettings', 'PayrollReport'],
    },
    entityId: { type: db.Types.UUID },
    // A sentence a human can read without joining anything.
    note: { type: String, default: '' },
    oldValue: { type: db.Types.JSON },
    newValue: { type: db.Types.JSON },
    timestamp: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

PayrollAuditLogSchema.index({ school: 1, timestamp: -1 });
PayrollAuditLogSchema.index({ school: 1, actionType: 1 });
PayrollAuditLogSchema.index({ school: 1, entityType: 1, entityId: 1 });

module.exports = db.model('PayrollAuditLog', PayrollAuditLogSchema);
