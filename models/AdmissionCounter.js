const db = require('../db/orm');

/**
 * Running numbers for the admission module — application numbers, receipts,
 * admit-card roll numbers, offer letters — one row per (school, key), where
 * the key already carries the resolved prefix ("APP2027"). Advanced in one
 * statement (INSERT … ON CONFLICT DO UPDATE … RETURNING), so two requests can
 * never take the same number (services/admission/counters.js).
 */
const AdmissionCounterSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    key:    { type: String, required: true },
    value:  { type: Number, default: 0 },
});

AdmissionCounterSchema.index({ school: 1, key: 1 }, { unique: true });

module.exports = db.model('AdmissionCounter', AdmissionCounterSchema);
