const db = require('../db/orm');

/**
 * A report someone generated, kept so the Reports screen can list what has
 * already been produced and hand the same file back.
 *
 * Only the RECIPE is stored, never the file: a payroll report is a projection
 * of runs and entries that are themselves immutable once published, so
 * re-running the recipe reproduces the file byte for byte and the database
 * does not grow a blob per download. `summary` holds the handful of totals the
 * listing shows without re-running anything.
 */
const PayrollReportSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    name:   { type: String, required: true, trim: true },
    type: {
        type: String,
        enum: ['summary', 'salary_register', 'deductions', 'department', 'annual', 'bank_transfer', 'employee'],
        required: true,
    },
    // Either one month, or a whole year when `month` is null.
    month: { type: Number, default: null },
    year:  { type: Number, required: true },
    periodLabel: { type: String, default: '' },
    format: { type: String, enum: ['pdf', 'excel', 'csv'], default: 'pdf' },
    // The filters the report was generated with, replayed on download.
    filters: { type: db.Types.JSON, default: null },
    summary: { type: db.Types.JSON, default: null },
    rowCount: { type: Number, default: 0 },
    generatedBy: { type: db.Types.UUID, ref: 'User' },
    generatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

PayrollReportSchema.index({ school: 1, generatedAt: -1 });

module.exports = db.model('PayrollReport', PayrollReportSchema);
