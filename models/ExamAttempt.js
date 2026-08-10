const db = require('../db/orm');

// Stores per-student shuffled question/option order + saved answers
const ExamAttemptSchema = new db.Schema({
    exam: {
        type: db.Types.UUID,
        ref: 'AptitudeExam',
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
    // Shuffled question IDs (consistent for the full session)
    questionOrder: [{
        type: db.Types.UUID,
        ref: 'AptitudeQuestion',
    }],
    // Per-question shuffled option order
    optionOrders: [{
        question: { type: db.Types.UUID },
        options: [{
            optionId: String,
            text:     String,
        }],
    }],
    // Student's saved answers (upserted on each selection)
    answers: [{
        question:        { type: db.Types.UUID },
        selectedOptions: [String], // optionIds
        savedAt:         { type: Date, default: Date.now },
    }],
    startedAt:     { type: Date, default: null },
    submittedAt:   { type: Date, default: null },
    serverEndTime: { type: Date, default: null }, // startedAt + duration
    status: {
        type: String,
        enum: ['not_started', 'in_progress', 'submitted', 'auto_submitted'],
        default: 'not_started',
    },
    violationCount: { type: Number, default: 0 },
}, { timestamps: true });

ExamAttemptSchema.index({ exam: 1, student: 1 }, { unique: true });

module.exports = db.model('ExamAttempt', ExamAttemptSchema);
