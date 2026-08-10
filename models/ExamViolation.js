const db = require('../db/orm');

const ExamViolationSchema = new db.Schema({
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
    violationType: {
        type: String,
        enum: ['tab_switch', 'window_blur'],
        required: true,
    },
    occurredAt: {
        type: Date,
        default: Date.now,
    },
});

ExamViolationSchema.index({ attempt: 1, occurredAt: -1 });

module.exports = db.model('ExamViolation', ExamViolationSchema);
