const db = require('../db/orm');

/**
 * A family's DigiLocker connection for one application (Oct 2026): started
 * from the application page, completed when DigiLocker sends the family back.
 * Lives thirty minutes. The access token is kept encrypted and deleted when
 * the session ends; the DigiLocker account id is kept only as a hash.
 *
 *   status   started | connected | failed | ended
 *   account  { name, dob (YYYY-MM-DD), gender, idHash } — as DigiLocker gave them
 *   files    the documents in the locker: [{ uri, name, doctype, issuer, date, mime, size }]
 */
const AdmissionDigilockerSessionSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    application:  { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    applicant:    { type: db.Types.UUID, ref: 'User', required: true },
    state:        { type: String, required: true, unique: true },
    codeVerifier: { type: String, default: '' },
    status:       { type: String, enum: ['started', 'connected', 'failed', 'ended'], default: 'started' },
    // Where the family started: 'app' sends them back into the phone app (APP_SCHEME), else the portal.
    client:       { type: String, enum: ['web', 'app'], default: 'web' },
    token:        { type: String, default: '' },
    account:      { type: db.Types.JSON, default: () => ({}) },
    files:        { type: db.Types.JSON, default: () => [] },
    error:        { type: String, default: '' },
    expiresAt:    { type: Date, required: true },
}, { timestamps: true });

AdmissionDigilockerSessionSchema.index({ application: 1, createdAt: -1 });

module.exports = db.model('AdmissionDigilockerSession', AdmissionDigilockerSessionSchema);
