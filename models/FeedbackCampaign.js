const db = require('../db/orm');

// A feedback drive: who is evaluated, by whom, over which window (spec §4).
// Lifecycle: draft → scheduled → active → closed → archived. Closing NEVER
// deletes data (rule 16); archiving only hides it from the default lists.
const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'active', 'closed', 'archived'];
const FEEDBACK_TYPES    = ['student_teacher', 'parent_teacher'];

const FeedbackCampaignSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    name: {
        type: String,
        required: true,
        trim: true,
    },
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        default: null,
    },
    // Free-form term label ('Term 1', 'Semester 2') — the ERP has no Term entity,
    // so it is stored as text and used as a trend axis (spec §15).
    term: {
        type: String,
        default: '',
        trim: true,
    },
    feedbackType: {
        type: String,
        enum: FEEDBACK_TYPES,
        default: 'student_teacher',
    },
    description: {
        type: String,
        default: '',
        trim: true,
    },
    instructions: {
        type: String,
        default: '',
        trim: true,
    },
    startDate: {
        type: Date,
        required: true,
    },
    endDate: {
        type: Date,
        required: true,
    },
    isAnonymous: {
        type: Boolean,
        default: true,
    },
    // Privacy floor: analytics for a teacher stay hidden until this many
    // responses exist for them (spec §10).
    minimumResponses: {
        type: Number,
        default: 5,
        min: 1,
    },
    // Targeting. Empty array = "everyone" for that dimension.
    targetClasses: [{
        type: db.Types.UUID,
        ref: 'Class',
    }],
    targetSections: [{
        type: db.Types.UUID,
        ref: 'ClassSection',
    }],
    targetSubjects: [{
        type: db.Types.UUID,
        ref: 'Subject',
    }],
    targetTeachers: [{
        type: db.Types.UUID,
        ref: 'User',
    }],
    status: {
        type: String,
        enum: CAMPAIGN_STATUSES,
        default: 'draft',
    },
    // Reserved for the admin-controlled reopen flow (spec §11).
    allowResubmission: {
        type: Boolean,
        default: false,
    },
    // Reminder cadence for pending students; 0 disables reminders entirely.
    reminderEnabled: {
        type: Boolean,
        default: true,
    },
    reminderIntervalDays: {
        type: Number,
        default: 3,
    },
    lastReminderAt: {
        type: Date,
        default: null,
    },
    // Denormalised counters kept in step with the assignment table so the
    // campaign list never has to count rows per campaign (spec §27).
    stats: {
        assigned:   { type: Number, default: 0 },
        submitted:  { type: Number, default: 0 },
        ratingSum:  { type: Number, default: 0 },  // Σ of per-assignment overall ratings
        ratingCount:{ type: Number, default: 0 },
    },
    activatedAt: {
        type: Date,
        default: null,
    },
    closedAt: {
        type: Date,
        default: null,
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

FeedbackCampaignSchema.index({ school: 1, status: 1, startDate: -1 });
FeedbackCampaignSchema.index({ school: 1, academicYear: 1 });

module.exports = db.model('FeedbackCampaign', FeedbackCampaignSchema);
module.exports.CAMPAIGN_STATUSES = CAMPAIGN_STATUSES;
module.exports.FEEDBACK_TYPES    = FEEDBACK_TYPES;
