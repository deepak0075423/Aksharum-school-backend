const db = require('../db/orm');

/**
 * One run of an admission background job (Oct 2026) — the minute sweep, the
 * ten-minute reminders, the export worker — so the office's health card can
 * say when each last ran, whether it worked, and what it did. Platform-wide
 * (the jobs serve every school); kept seven days.
 *
 *   host   which server ran it (several may: each claims its own work)
 */
const AdmissionJobRunSchema = new db.Schema({
    job:        { type: String, required: true },
    host:       { type: String, default: '' },
    startedAt:  { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    ok:         { type: Boolean, default: false },
    result:     { type: db.Types.JSON, default: () => ({}) },
    error:      { type: String, default: '' },
}, { timestamps: false });

AdmissionJobRunSchema.index({ job: 1, startedAt: -1 });

module.exports = db.model('AdmissionJobRun', AdmissionJobRunSchema);
