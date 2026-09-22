const db = require('../db/orm');

/**
 * One month's payroll for one school.
 *
 * Statuses are a straight line with two exits:
 *   draft → reviewed → approved → published
 *   any of the first three → cancelled   (abandoned, entries deleted)
 *   any of the first three → failed      (computation could not complete)
 *
 * `published` is terminal: payslips exist, employees have been told, and the
 * run is locked. Reversing it is `unpublish`, which deletes the payslips it
 * created and says so in the audit log — it is not a silent status change.
 */
const PayrollRunSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    // "September 2026 Payroll" — editable, so a school can label an off-cycle
    // or arrears run distinctly.
    runName: { type: String, default: '', trim: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },
    status: {
        type: String,
        // 'publishing' is a lock, not a stage: publishRun() claims the run with
        // it so two admins cannot both issue payslips, and replaces it with
        // 'published' (or puts the previous status back) before it returns.
        enum: ['draft', 'reviewed', 'approved', 'publishing', 'published', 'failed', 'cancelled'],
        default: 'draft',
    },
    // The divisor every per-day figure in this run used. Frozen on the run so a
    // later settings change cannot silently re-price a month already computed.
    workingDays: { type: Number, default: 26 },
    payDate: { type: Date, default: null },
    totalEmployees: { type: Number, default: 0 },
    totalGross: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    totalNet: { type: Number, default: 0 },
    totalLop: { type: Number, default: 0 },
    totalEmployerCost: { type: Number, default: 0 },
    // Employees who could not be computed (no structure, zero CTC, …). Kept so
    // the screen can say WHO was skipped rather than only how many.
    skipped: { type: db.Types.JSON, default: null },
    /**
     * Things the run computed but an admin has to decide about: a structure
     * paying more than the CTC it is based on, a recovery bigger than a
     * month's pay, a zero-pay month. Unlike `skipped` these people ARE in the
     * run — they are just worth a second look before it is approved.
     */
    warnings: { type: db.Types.JSON, default: null },
    /**
     * What this run WILL take off advances and mark as reimbursed, once it is
     * published. Held here rather than applied at computation time: a draft
     * that is recomputed or abandoned must not leave an advance half-recovered
     * or a claim marked paid for a month nobody was paid in.
     */
    pendingRecovery: { type: db.Types.JSON, default: null },
    pendingClaims:   { type: db.Types.JSON, default: null },
    failureReason: { type: String, default: '' },
    processedBy: { type: db.Types.UUID, ref: 'User' },
    processedAt: Date,
    computedAt: Date,
    reviewedBy: { type: db.Types.UUID, ref: 'User' },
    reviewedAt: Date,
    approvedBy: { type: db.Types.UUID, ref: 'User' },
    approvedAt: Date,
    publishedBy: { type: db.Types.UUID, ref: 'User' },
    publishedAt: Date,
    cancelledBy: { type: db.Types.UUID, ref: 'User' },
    cancelledAt: Date,
    notes: { type: String, default: '' },
}, { timestamps: true });

PayrollRunSchema.index({ school: 1, year: -1, month: -1 });
PayrollRunSchema.index({ school: 1, status: 1 });
PayrollRunSchema.index({ school: 1, year: 1, month: 1 }, { unique: true });

module.exports = db.model('PayrollRun', PayrollRunSchema);
