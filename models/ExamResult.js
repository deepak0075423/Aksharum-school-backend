const db = require('../db/orm');

const QuestionResultSchema = new db.Schema({
    question:      { type: db.Types.UUID, ref: 'AptitudeQuestion' },
    questionText:  String,
    questionType:  String,
    studentAnswers:  [String], // optionIds selected
    correctAnswers:  [String], // optionIds expected
    optionTexts:     db.Types.JSON, // { optionId: text } map for display
    isCorrect:       Boolean,
    marksAwarded:    Number,
    marksTotal:      Number,
}, { _id: false });

const ExamResultSchema = new db.Schema({
    exam: {
        type: db.Types.UUID,
        ref: 'AptitudeExam',
        required: true,
    },
    attempt: {
        type: db.Types.UUID,
        ref: 'ExamAttempt',
        required: true,
    },
    student: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        required: true,
    },
    totalMarks:    { type: Number, required: true },
    obtainedMarks: { type: Number, required: true },
    percentage:    { type: Number, required: true },
    questionResults: [QuestionResultSchema],
}, { timestamps: true });

ExamResultSchema.index({ exam: 1, student: 1 }, { unique: true });
ExamResultSchema.index({ exam: 1, obtainedMarks: -1 });

module.exports = db.model('ExamResult', ExamResultSchema);
