const db = require('../db/orm');

const PayrollRunSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    status: {
        type: String,
        enum: ['draft', 'reviewed', 'approved', 'published'],
        default: 'draft',
    },
    totalEmployees: { type: Number, default: 0 },
    totalGross: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    totalNet: { type: Number, default: 0 },
    processedBy: { type: db.Types.UUID, ref: 'User' },
    processedAt: Date,
    reviewedBy: { type: db.Types.UUID, ref: 'User' },
    reviewedAt: Date,
    approvedBy: { type: db.Types.UUID, ref: 'User' },
    approvedAt: Date,
    publishedBy: { type: db.Types.UUID, ref: 'User' },
    publishedAt: Date,
    notes: { type: String, default: '' },
}, { timestamps: true });

PayrollRunSchema.index({ school: 1, year: -1, month: -1 });
PayrollRunSchema.index({ school: 1, status: 1 });
PayrollRunSchema.index({ school: 1, year: 1, month: 1 }, { unique: true });

module.exports = db.model('PayrollRun', PayrollRunSchema);
