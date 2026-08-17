const db = require('../db/orm');

// Ticked options for checkbox / multiple-choice answers. The label is copied in
// so a "top strengths" tally is one indexed read with no joins, and so a
// reworded option never rewrites what past cohorts actually chose.
const FeedbackSelectedOptionSchema = new db.Schema({
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
    response: {
        type: db.Types.UUID,
        ref: 'FeedbackResponse',
        required: true,
    },
    assignment: {
        type: db.Types.UUID,
        ref: 'FeedbackAssignment',
        required: true,
    },
    teacher: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    campaignQuestion: {
        type: db.Types.UUID,
        ref: 'FeedbackCampaignQuestion',
        required: true,
    },
    // Snapshot id from FeedbackCampaignQuestion.options — not a live FK.
    option: {
        type: db.Types.UUID,
        default: null,
    },
    optionText: {
        type: String,
        default: '',
        trim: true,
    },
    optionValue: {
        type: String,
        default: '',
        trim: true,
    },
}, { timestamps: true });

FeedbackSelectedOptionSchema.index({ campaign: 1, teacher: 1 });
FeedbackSelectedOptionSchema.index({ teacher: 1, campaignQuestion: 1 });
FeedbackSelectedOptionSchema.index({ response: 1 });

module.exports = db.model('FeedbackSelectedOption', FeedbackSelectedOptionSchema);
