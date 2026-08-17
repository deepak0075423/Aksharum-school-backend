const db = require('../db/orm');

// Reusable question bank (spec §12). Questions are shared across campaigns;
// a campaign stores an immutable SNAPSHOT of the question it used
// (FeedbackCampaignQuestion), so editing or retiring a question here can never
// rewrite history (rule 14/15).
const QUESTION_TYPES = ['rating_5', 'yes_no', 'multiple_choice', 'checkbox', 'text', 'emoji_5'];

const FeedbackQuestionSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    category: {
        type: db.Types.UUID,
        ref: 'FeedbackCategory',
        default: null,
    },
    questionText: {
        type: String,
        required: true,
        trim: true,
    },
    questionType: {
        type: String,
        enum: QUESTION_TYPES,
        default: 'rating_5',
    },
    // Which feedback flow the question belongs to. 'student_teacher' today,
    // 'parent_teacher' is already accepted so the parent flow can be switched
    // on without a schema change (spec §4).
    feedbackType: {
        type: String,
        enum: ['student_teacher', 'parent_teacher', 'any'],
        default: 'any',
    },
    isRequired: {
        type: Boolean,
        default: true,
    },
    // Only scored question types feed the category / overall averages. Text and
    // option questions carry qualitative signal and are counted separately.
    includeInScore: {
        type: Boolean,
        default: true,
    },
    helpText: {
        type: String,
        default: '',
        trim: true,
    },
    maxLength: {
        type: Number,
        default: 1000,
    },
    displayOrder: {
        type: Number,
        default: 0,
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'archived'],
        default: 'active',
    },
    // Marks the questions created by the default seed so re-seeding is a no-op.
    seedKey: {
        type: String,
        default: '',
        trim: true,
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

FeedbackQuestionSchema.index({ school: 1, status: 1, displayOrder: 1 });
FeedbackQuestionSchema.index({ school: 1, category: 1 });
FeedbackQuestionSchema.index({ school: 1, seedKey: 1 });

module.exports = db.model('FeedbackQuestion', FeedbackQuestionSchema);
module.exports.QUESTION_TYPES = QUESTION_TYPES;
