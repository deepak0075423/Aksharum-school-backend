const db = require('../db/orm');

// Options for multiple_choice / checkbox questions ("What do you like about
// this teacher?" → Explains concepts clearly, Helps with doubts, …).
const FeedbackQuestionOptionSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    question: {
        type: db.Types.UUID,
        ref: 'FeedbackQuestion',
        required: true,
    },
    optionText: {
        type: String,
        required: true,
        trim: true,
    },
    // Machine key used for tallies across campaigns even if the label is reworded.
    optionValue: {
        type: String,
        default: '',
        trim: true,
    },
    // "Other" options let the student type a free-text note alongside the tick.
    allowsFreeText: {
        type: Boolean,
        default: false,
    },
    displayOrder: {
        type: Number,
        default: 0,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
}, { timestamps: true });

FeedbackQuestionOptionSchema.index({ question: 1, displayOrder: 1 });

module.exports = db.model('FeedbackQuestionOption', FeedbackQuestionOptionSchema);
