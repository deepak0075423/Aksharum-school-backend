const db = require('../db/orm');

/**
 * Running numbers for ID cards (Oct 2026), one row per school, kind and
 * series — the academic year for student cards ("2627"), the year of issue for
 * the others, and 'all' for the permanent parent IDs. Incremented in one
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` (services/idCardService), so two
 * offices issuing at the same instant never get the same number.
 */
const IdCardCounterSchema = new db.Schema({
    school:    { type: db.Types.UUID, ref: 'School', required: true },
    kind:      { type: String, required: true },
    series:    { type: String, required: true },
    value:     { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

IdCardCounterSchema.index({ school: 1, kind: 1, series: 1 }, { unique: true });

module.exports = db.model('IdCardCounter', IdCardCounterSchema);
