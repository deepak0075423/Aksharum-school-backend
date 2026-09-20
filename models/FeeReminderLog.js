const db = require('../db/orm');

/**
 * One row per reminder actually sent to one family.
 *
 * It does two jobs. It stops a reminder going out twice — the automatic sweep
 * runs hourly, and a restart or a second worker must not chase the same
 * parent again — and it lets the office see who has already been chased
 * before chasing them again by hand.
 *
 * `kind` says what set it off:
 *   manual      an admin pressed Send Reminder
 *   before-<n>  n days before that month fell due
 *   due         the day it fell due
 *   after-<n>   n days after it fell due, still unpaid
 *
 * `monthKey` is the month being chased ('YYYY-MM'), or null for a manual
 * reminder about the balance as a whole.
 */
const FeeReminderLogSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    kind: { type: String, required: true },
    monthKey: { type: String, default: null },
    amount: { type: Number, default: 0 },
    // The local day it went out ('YYYY-MM-DD'), so "already sent today" is a
    // plain string comparison rather than timezone arithmetic.
    sentOn: { type: String, required: true },
    channel: { type: String, default: 'app' },        // 'app' | 'app+email'
    auto: { type: Boolean, default: false },
    sentBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

FeeReminderLogSchema.index({ school: 1, createdAt: -1 });
FeeReminderLogSchema.index({ school: 1, student: 1, createdAt: -1 });
// The guard the automatic sweep leans on: one reminder of a given kind, per
// student, per month, ever. Manual reminders are deliberately left out — the
// office may chase the same family again whenever it likes.
FeeReminderLogSchema.index(
    { school: 1, student: 1, academicYear: 1, monthKey: 1, kind: 1 },
    { unique: true, partialFilterExpression: { auto: true } },
);

module.exports = db.model('FeeReminderLog', FeeReminderLogSchema);
