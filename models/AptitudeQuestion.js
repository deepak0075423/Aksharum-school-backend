const db = require('../db/orm');

const OptionSchema = new db.Schema({
    optionId: { type: String, required: true }, // 'a', 'b', 'c', 'd', 'true', 'false'
    text:     { type: String, required: true, trim: true },
}, { _id: false });

const AptitudeQuestionSchema = new db.Schema({
    exam: {
        type: db.Types.UUID,
        ref: 'AptitudeExam',
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    questionText: {
        type: String,
        required: true,
        trim: true,
    },
    questionType: {
        type: String,
        enum: ['mcq_single', 'mcq_multiple', 'true_false'],
        required: true,
    },
    options: [OptionSchema],
    // optionIds of correct answers
    correctAnswers: [{
        type: String,
        required: true,
    }],
    marks: {
        type: Number,
        required: true,
        min: 0.5,
    },
    order: {
        type: Number,
        default: 0,
    },
}, { timestamps: true });

AptitudeQuestionSchema.index({ exam: 1, order: 1 });

module.exports = db.model('AptitudeQuestion', AptitudeQuestionSchema);
