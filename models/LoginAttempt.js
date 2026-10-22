const db = require('../db/orm');

/**
 * Wrong passwords typed against one email address — services/loginLockout.js.
 *
 * One row per address that has failed recently, whether or not any account
 * uses it (so the count can never tell a stranger which addresses are
 * registered). A right password removes the row; a stale one is pruned.
 */
const LoginAttemptSchema = new db.Schema({
    email:         { type: String, required: true, unique: true, lowercase: true, trim: true },
    failures:      { type: Number, default: 0 },
    lastFailedAt:  { type: Date, default: null },
    lockedUntil:   { type: Date, default: null },
    // A fingerprint of the password the failures were typed against. When the
    // address gets a new password — "Forgot password", the school office, a
    // brand-new account — it no longer matches, and the count and the lock
    // stop applying: the guesses were aimed at a password that is gone.
    passwordStamp: { type: String, default: '' },
});

module.exports = db.model('LoginAttempt', LoginAttemptSchema);
