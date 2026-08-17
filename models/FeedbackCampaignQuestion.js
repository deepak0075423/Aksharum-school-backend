const db = require('../db/orm');

// The questionnaire a campaign actually ran, snapshotted at the moment the
// campaign was built. The question bank can be reworded, reordered or retired
// afterwards without changing what past respondents were asked — which is what
// keeps historical feedback readable forever (rules 14 & 15).
const FeedbackCampaignQuestionSchema = new db.Schema({
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
    question: {
        type: db.Types.UUID,
        ref: 'FeedbackQuestion',
        required: true,
    },
    category: {
        type: db.Types.UUID,
        ref: 'FeedbackCategory',
        default: null,
    },

    // ── Snapshot ────────────────────────────────────────────────────────────
    questionText:   { type: String, default: '', trim: true },
    questionType:   { type: String, default: 'rating_5' },
    categoryName:   { type: String, default: '', trim: true },
    helpText:       { type: String, default: '', trim: true },
    includeInScore: { type: Boolean, default: true },
    maxLength:      { type: Number, default: 1000 },
    // [{ _id, optionText, optionValue, allowsFreeText, displayOrder }]
    options:        { type: db.Types.JSON, default: [] },

    isRequired: {
        type: Boolean,
        default: true,
    },
    displayOrder: {
        type: Number,
        default: 0,
    },
}, { timestamps: true });

// A question appears at most once in a campaign.
FeedbackCampaignQuestionSchema.index({ campaign: 1, question: 1 }, { unique: true });
FeedbackCampaignQuestionSchema.index({ campaign: 1, displayOrder: 1 });

module.exports = db.model('FeedbackCampaignQuestion', FeedbackCampaignQuestionSchema);
