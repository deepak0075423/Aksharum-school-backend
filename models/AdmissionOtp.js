const db = require('../db/orm');

/**
 * A one-time code sent to an address from an admission portal — to verify a
 * new applicant's email ('register') or to reset a password ('reset').
 *
 * Only a keyed hash of the code is stored. Each code is good for one use,
 * `maxAttempts` wrong guesses and until `expiresAt`; sending a new one
 * invalidates the last. A registration's details (name, phone, password hash,
 * consent) wait in `payload` until the code is verified — no account exists
 * before that (services/admission/guestAuth.js).
 */
const AdmissionOtpSchema = new db.Schema({
    school:        { type: db.Types.UUID, ref: 'School', required: true },
    email:         { type: String, required: true, lowercase: true, trim: true },
    purpose:       { type: String, enum: ['register', 'reset'], required: true },
    codeHash:      { type: String, required: true },
    expiresAt:     { type: Date, required: true },
    attempts:      { type: Number, default: 0 },
    maxAttempts:   { type: Number, default: 5 },
    consumedAt:    { type: Date, default: null },
    invalidatedAt: { type: Date, default: null },
    payload:       { type: db.Types.JSON, default: null },
    ip:            { type: String, default: '' },
    createdAt:     { type: Date, default: Date.now },
});

AdmissionOtpSchema.index({ school: 1, email: 1, purpose: 1, createdAt: -1 });

module.exports = db.model('AdmissionOtp', AdmissionOtpSchema);
