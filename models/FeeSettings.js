const db = require('../db/orm');

// Every counter-payment mode the office can be allowed to take. `online` is
// not here: that is the gateway, switched on in Settings → Payment Gateway.
const COUNTER_MODES = ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'dd'];

const FeeSettingsSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, unique: true },
    // Gateway credentials moved to School.paymentGateway — library fines are
    // payable too, and a school has one merchant account, not one per module.
    // Whether fees may charge through it is School.paymentGateway.modules.fees.
    currency: { type: String, default: 'INR' },
    currencySymbol: { type: String, default: '₹' },
    roundingRule: { type: String, enum: ['none', 'round', 'ceil', 'floor'], default: 'none' },
    decimalPlaces: { type: Number, enum: [0, 2], default: 0 },
    receipt: {
        logo: { type: String, default: '' },
        header: { type: String, default: '' },
        footer: { type: String, default: '' },
        customNotes: { type: String, default: '' },
    },
    receiptPrefix: { type: String, default: 'REC', trim: true },
    lastReceiptNumber: { type: Number, default: 0 },

    // ── General ────────────────────────────────────────────────────────────
    // The window fees are collected in. Payments screens open on it.
    collectionStart: { type: Date, default: null },
    collectionEnd:   { type: Date, default: null },
    // Days after a demand is raised that it falls due, for a structure that
    // has no due day of its own.
    defaultDueDays:  { type: Number, default: 15, min: 0 },
    // Grace days a new fine rule starts with.
    defaultGraceDays: { type: Number, default: 5, min: 0 },
    // The year every fees screen opens on. Null = the school's active year.
    defaultAcademicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },
    allowPartialPayments: { type: Boolean, default: true },
    autoGenerateReceipt:  { type: Boolean, default: true },
    showPreviousDues:     { type: Boolean, default: true },

    // ── Rounding & calculation ─────────────────────────────────────────────
    lateFeeCalculation: { type: String, enum: ['per_day', 'flat'], default: 'per_day' },
    fineAppliesOn: { type: String, enum: ['total_due', 'per_head'], default: 'total_due' },
    includeConcessionInFine: { type: Boolean, default: false },
    autoAdjustAdvance: { type: Boolean, default: true },

    // ── Display (what students and parents see) ────────────────────────────
    display: {
        feeHeadDetails:   { type: Boolean, default: true },
        concessionDetails:{ type: Boolean, default: true },
        fineDetails:      { type: Boolean, default: true },
        previousYearDues: { type: Boolean, default: true },
    },

    // ── Payment settings ───────────────────────────────────────────────────
    acceptedModes: { type: [String], default: () => COUNTER_MODES.slice() },
    minPaymentAmount: { type: Number, default: 0, min: 0 },

    // ── Notifications ──────────────────────────────────────────────────────
    notifications: {
        paymentReceived: { type: Boolean, default: true },
        paymentDecision: { type: Boolean, default: true },
        emailParents:    { type: Boolean, default: true },
    },

    /**
     * Reminders sent without anyone pressing anything. Off until a school
     * turns it on — this writes to real parents, so it never starts by
     * itself. Each family is chased at most once per month per trigger
     * (FeeReminderLog holds the record).
     */
    autoReminders: {
        enabled:      { type: Boolean, default: false },
        // Days BEFORE a month falls due to give notice, e.g. [3] = three days ahead.
        beforeDays:   { type: db.Types.JSON, default: () => [3] },
        onDueDay:     { type: Boolean, default: true },
        // Days AFTER it fell due and is still unpaid.
        afterDays:    { type: db.Types.JSON, default: () => [3, 7] },
        // Anything smaller than this is not worth chasing.
        minAmount:    { type: Number, default: 0, min: 0 },
        emailParents: { type: Boolean, default: true },
        // Local hour to send at, so nobody is woken at 3am.
        sendHour:     { type: Number, default: 9, min: 0, max: 23 },
    },

    // Reports mailed on a timetable. [{ _id, type, frequency: weekly|monthly,
    // day, recipients: [email], lastSentAt, createdBy }]
    scheduledReports: { type: db.Types.JSON, default: () => [] },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

FeeSettingsSchema.statics.COUNTER_MODES = COUNTER_MODES;

module.exports = db.model('FeeSettings', FeeSettingsSchema);
module.exports.COUNTER_MODES = COUNTER_MODES;
