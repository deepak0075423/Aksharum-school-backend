const db = require('../db/orm');

/**
 * Who looked at what (Oct 2026): every time someone at the school reveals an
 * applicant's Aadhaar number (it is masked everywhere else), and every export
 * of applications. Kept for the school's own accountability; never shown to
 * families.
 */
const AdmissionAccessLogSchema = new db.Schema({
    school:      { type: db.Types.UUID, ref: 'School', required: true },
    application: { type: db.Types.UUID, ref: 'AdmissionApplication', default: null },
    user:        { type: db.Types.UUID, ref: 'User', default: null },
    userName:    { type: String, default: '' },
    role:        { type: String, default: '' },
    action:      { type: String, enum: ['reveal', 'export'], required: true },
    field:       { type: String, default: '' },
    detail:      { type: String, default: '' },
}, { timestamps: true });

AdmissionAccessLogSchema.index({ school: 1, createdAt: -1 });
AdmissionAccessLogSchema.index({ school: 1, application: 1 });

module.exports = db.model('AdmissionAccessLog', AdmissionAccessLogSchema);
