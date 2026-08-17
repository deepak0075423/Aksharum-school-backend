const db = require('../db/orm');

// One answer to one question. Deliberately carries NO student reference — the
// respondent is reachable only through `assignment`, which is what makes an
// anonymous read path (teacher/principal analytics) structurally safe: those
// queries never touch the assignment's student column.
//
// `teacher`, `campaign` and `category` are denormalised so every analytics
// query is a single indexed scan with no joins.
const FeedbackResponseSchema = new db.Schema({
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
    subject: {
        type: db.Types.UUID,
        ref: 'Subject',
        default: null,
    },
    campaignQuestion: {
        type: db.Types.UUID,
        ref: 'FeedbackCampaignQuestion',
        required: true,
    },
    question: {
        type: db.Types.UUID,
        ref: 'FeedbackQuestion',
        default: null,
    },
    category: {
        type: db.Types.UUID,
        ref: 'FeedbackCategory',
        default: null,
    },
    questionType: {
        type: String,
        default: 'rating_5',
    },
    // 1–5 for rating / emoji questions; 5 or 1 for yes/no. null for text.
    ratingValue: {
        type: Number,
        default: null,
    },
    textResponse: {
        type: String,
        default: '',
    },
    includeInScore: {
        type: Boolean,
        default: true,
    },
}, { timestamps: true });

FeedbackResponseSchema.index({ campaign: 1, teacher: 1 });
FeedbackResponseSchema.index({ assignment: 1 });
FeedbackResponseSchema.index({ teacher: 1, category: 1 });
FeedbackResponseSchema.index({ campaign: 1, campaignQuestion: 1 });

module.exports = db.model('FeedbackResponse', FeedbackResponseSchema);
