const db = require('../db/orm');

/**
 * An address admission email is no longer sent to (Oct 2026): it bounced for
 * good, its owner marked a message as spam, or the office asked. Sending to
 * such an address again only harms the school's sender reputation — and with
 * it every other family's chance of getting the next code.
 *
 *   school   the school whose mail it covers; null for every school (a
 *            platform-wide bounce report)
 *   source   smtp_reject | bounce | complaint | manual
 */
const AdmissionEmailSuppressionSchema = new db.Schema({
    school:    { type: db.Types.UUID, ref: 'School', default: null },
    email:     { type: String, required: true, lowercase: true, trim: true },
    source:    { type: String, enum: ['smtp_reject', 'bounce', 'complaint', 'manual'], default: 'manual' },
    reason:    { type: String, default: '' },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionEmailSuppressionSchema.index({ email: 1 });
AdmissionEmailSuppressionSchema.index({ school: 1, createdAt: -1 });

module.exports = db.model('AdmissionEmailSuppression', AdmissionEmailSuppressionSchema);
