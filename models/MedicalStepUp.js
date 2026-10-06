const db = require('../db/orm');

/**
 * A one-time code emailed to a member of the medical staff (Oct 2026), when
 * the school asks them to confirm who they are before opening medical records
 * (settings.requireStepUp). Only the code's hash is kept; it lasts ten
 * minutes and five tries. A correct code buys a twelve-hour step-up token.
 */
const MedicalStepUpSchema = new db.Schema({
    school:    { type: db.Types.UUID, ref: 'School', required: true },
    user:      { type: db.Types.UUID, ref: 'User', required: true },
    codeHash:  { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts:  { type: Number, default: 0 },
    usedAt:    { type: Date, default: null },
}, { timestamps: true });

MedicalStepUpSchema.index({ school: 1, user: 1, createdAt: -1 });

module.exports = db.model('MedicalStepUp', MedicalStepUpSchema);
