const db = require('../db/orm');

// One row per (campaign, student, teacher, subject) — generated automatically
// from the section↔subject↔teacher links, never by hand (spec §5).
//
// The row is also the analytics unit: when the student submits, the per-category
// and overall averages for THAT evaluation are written here. Dashboards then
// aggregate over assignments (thousands) instead of raw responses (millions),
// which is what keeps §27 honest without a materialised summary table.
const ASSIGNMENT_STATUSES = ['pending', 'in_progress', 'submitted', 'expired'];

const FeedbackAssignmentSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    campaign: {
        type: db.Types.UUID,
        ref: 'FeedbackCampaign',
        required: true,
    },
    // The respondent. For student→teacher this is the student's User row; the
    // parent→teacher flow will point at the parent User with `student` kept as
    // the child being represented.
    student: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    respondent: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    teacher: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    subject: {
        type: db.Types.UUID,
        ref: 'Subject',
        default: null,
    },
    class: {
        type: db.Types.UUID,
        ref: 'Class',
        default: null,
    },
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        default: null,
    },
    status: {
        type: String,
        enum: ASSIGNMENT_STATUSES,
        default: 'pending',
    },
    // Snapshot of the campaign flag: a campaign can never be flipped to
    // non-anonymous after the fact and retro-expose past respondents.
    isAnonymous: {
        type: Boolean,
        default: true,
    },
    assignedAt: {
        type: Date,
        default: Date.now,
    },
    startedAt: {
        type: Date,
        default: null,
    },
    submittedAt: {
        type: Date,
        default: null,
    },

    // ── Denormalised scores (written once, at submit) ────────────────────────
    overallRating: {
        type: Number,
        default: null,
    },
    // { <categoryId>: { name, sum, count, avg } }
    categoryScores: {
        type: db.Types.JSON,
        default: {},
    },
    hasComment: {
        type: Boolean,
        default: false,
    },
    // Bumped by an admin reopen; lets reports tell a resubmission apart.
    submissionCount: {
        type: Number,
        default: 0,
    },
}, { timestamps: true });

// Business rule: no duplicate assignment for the same evaluation (spec §5).
// `subject` is nullable for class-teacher-only evaluations; Postgres treats
// NULLs as distinct in a unique index, so the controller always writes a
// concrete subject when one exists and de-dupes null-subject rows in code.
FeedbackAssignmentSchema.index(
    { campaign: 1, student: 1, teacher: 1, subject: 1 },
    { unique: true },
);
FeedbackAssignmentSchema.index({ campaign: 1, teacher: 1, status: 1 });
FeedbackAssignmentSchema.index({ student: 1, status: 1 });
FeedbackAssignmentSchema.index({ school: 1, campaign: 1, status: 1 });
FeedbackAssignmentSchema.index({ teacher: 1, submittedAt: -1 });
FeedbackAssignmentSchema.index({ campaign: 1, section: 1 });

module.exports = db.model('FeedbackAssignment', FeedbackAssignmentSchema);
module.exports.ASSIGNMENT_STATUSES = ASSIGNMENT_STATUSES;
