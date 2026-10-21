const db = require('../db/orm');

/**
 * A spreadsheet prepared in the background (Oct 2026) — large exports that
 * would otherwise hold a request open. Kept for a day, then its file is
 * deleted; downloading it is logged like any export of personal data.
 *
 *   kind    applications | payments
 *   status  queued | running | ready | failed | expired
 *   params  the filters it was asked for, as validated data
 */
const AdmissionExportSchema = new db.Schema({
    school:      { type: db.Types.UUID, ref: 'School', required: true },
    kind:        { type: String, enum: ['applications', 'payments'], required: true },
    format:      { type: String, enum: ['xlsx', 'csv'], default: 'xlsx' },
    params:      { type: db.Types.JSON, default: () => ({}) },
    status:      { type: String, enum: ['queued', 'running', 'ready', 'failed', 'expired'], default: 'queued' },
    file:        { type: String, default: '' },
    rows:        { type: Number, default: 0 },
    error:       { type: String, default: '' },
    requestedBy: { type: db.Types.UUID, ref: 'User', default: null },
    startedAt:   { type: Date, default: null },
    finishedAt:  { type: Date, default: null },
    expiresAt:   { type: Date, default: null },
}, { timestamps: true });

AdmissionExportSchema.index({ school: 1, createdAt: -1 });
AdmissionExportSchema.index({ status: 1, createdAt: 1 });

module.exports = db.model('AdmissionExport', AdmissionExportSchema);
