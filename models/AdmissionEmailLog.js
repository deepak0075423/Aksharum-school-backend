const db = require('../db/orm');

/**
 * Every admission email the school sent or tried to: to whom, which event and
 * template version, and what the mail server said. 'failed' rows can be sent
 * again from the delivery log.
 *
 * The rendered body is NOT kept — it can carry a one-time code — except with
 * the 'log' mail driver (ADMISSION_MAIL_DRIVER=log, development only), which
 * sends nothing and stores the body instead so it can be read back.
 */
const AdmissionEmailLogSchema = new db.Schema({
    school:      { type: db.Types.UUID, ref: 'School', required: true },
    event:       { type: String, required: true },
    application: { type: db.Types.UUID, ref: 'AdmissionApplication', default: null },
    recipient:   { type: db.Types.UUID, ref: 'User', default: null },
    to:          { type: String, required: true },
    subject:     { type: String, default: '' },
    status:      { type: String, enum: ['sent', 'failed', 'logged', 'skipped'], default: 'sent' },
    error:       { type: String, default: '' },
    messageId:   { type: String, default: '' },
    driver:      { type: String, default: 'smtp' },
    templateVersion: { type: Number, default: 0 },
    attempt:     { type: Number, default: 1 },
    isTest:      { type: Boolean, default: false },
    context:     { type: db.Types.JSON, default: null },   // the placeholder values, minus secrets — for a retry
    body:        { type: String, default: '' },
    createdAt:   { type: Date, default: Date.now },
});

AdmissionEmailLogSchema.index({ school: 1, createdAt: -1 });
AdmissionEmailLogSchema.index({ school: 1, status: 1 });

module.exports = db.model('AdmissionEmailLog', AdmissionEmailLogSchema);
