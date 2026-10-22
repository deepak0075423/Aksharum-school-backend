const db = require('../db/orm');

/**
 * Password-reset codes emailed to one address — services/resetCodeLimit.js.
 *
 * One row per address that has asked for a code: how many it has had in the
 * current run, and when the last one went. A completed reset removes it.
 */
const PasswordResetRequestSchema = new db.Schema({
    email:      { type: String, required: true, unique: true, lowercase: true, trim: true },
    sends:      { type: Number, default: 0 },
    lastSentAt: { type: Date, default: null },
    // The send before the last, and which request made the last one — so a
    // code whose email could not be sent is handed back exactly.
    prevSentAt: { type: Date, default: null },
    claimId:    { type: String, default: '' },
});

module.exports = db.model('PasswordResetRequest', PasswordResetRequestSchema);
