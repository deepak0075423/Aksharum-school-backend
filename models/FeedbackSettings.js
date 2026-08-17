const db = require('../db/orm');

// Per-school defaults for the feedback module (spec §3 "Settings", §19).
// One row per school, created lazily on first read.
const FeedbackSettingsSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
        unique: true,
    },
    // Defaults pre-filled into the new-campaign form.
    defaultAnonymous: {
        type: Boolean,
        default: true,
    },
    defaultMinimumResponses: {
        type: Number,
        default: 5,
        min: 1,
    },
    defaultCampaignDays: {
        type: Number,
        default: 14,
    },

    // ── Teacher visibility ──────────────────────────────────────────────────
    // Even above the minimum-response threshold a school may prefer teachers not
    // to read raw comments; the aggregate scores still show.
    teacherCanSeeComments: {
        type: Boolean,
        default: true,
    },
    teacherCanSeeTrends: {
        type: Boolean,
        default: true,
    },
    // Hold results back from teachers until the campaign is closed.
    publishToTeachersOnClose: {
        type: Boolean,
        default: false,
    },

    // ── Notifications (spec §19) ────────────────────────────────────────────
    notifyOnCampaignStart: {
        type: Boolean,
        default: true,
    },
    notifyReminders: {
        type: Boolean,
        default: true,
    },
    reminderIntervalDays: {
        type: Number,
        default: 3,
    },
    notifyBeforeClose: {
        type: Boolean,
        default: true,
    },
    closingSoonDays: {
        type: Number,
        default: 2,
    },
    notifyOnSubmission: {
        type: Boolean,
        default: true,
    },
    emailNotifications: {
        type: Boolean,
        default: false,
    },

    // ── Campaign lifecycle automation ───────────────────────────────────────
    autoActivateScheduled: {
        type: Boolean,
        default: true,
    },
    autoCloseExpired: {
        type: Boolean,
        default: true,
    },

    updatedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

module.exports = db.model('FeedbackSettings', FeedbackSettingsSchema);
