const db = require('../db/orm');

// An option is words, a picture, or both (Nov 2026) — `image` is an address
// under /uploads/exam-images, checked by services/aptitudeExam.checkQuestion.
const OptionSchema = new db.Schema({
    optionId: { type: String, required: true }, // 'a', 'b', 'c', 'd', 'true', 'false'
    text:     { type: String, default: '', trim: true },
    image:    { type: String, default: '' },
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
    // Any language (Nov 2026) — and x², 10⁻³, √, π. A question is words, a
    // picture (`questionImage`, a screenshot or diagram), or both.
    questionText: {
        type: String,
        default: '',
        trim: true,
    },
    questionImage: {
        type: String,
        default: '',
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
