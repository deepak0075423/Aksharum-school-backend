const db = require('../db/orm');

const AptitudeExamSchema = new db.Schema({
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
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        required: true,
    },
    subject: {
        type: db.Types.UUID,
        ref: 'Subject',
        default: null,
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    title: {
        type: String,
        required: true,
        trim: true,
    },
    examDate: {
        type: Date,
        required: true,
    },
    startTime: {
        type: String,
        required: true, // HH:mm format
    },
    duration: {
        type: Number,
        required: true, // minutes
        min: 1,
    },
    totalQuestions: {
        type: Number,
        required: true,
        min: 1,
    },
    totalMarks: {
        type: Number,
        required: true,
        min: 1,
    },
    // Anti-cheating: auto-submit after this many violations
    maxViolations: {
        type: Number,
        default: 3,
        min: 1,
    },
    status: {
        type: String,
        enum: ['draft', 'published', 'completed', 'cancelled'],
        default: 'draft',
    },
    // Step 1: Subject teacher (exam creator) approval
    subjectTeacherApprovalStatus: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
    },
    subjectTeacherApprovedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    subjectTeacherApprovedAt: {
        type: Date,
        default: null,
    },
    subjectTeacherRejectionReason: {
        type: String,
        default: '',
    },
    // Step 2: Class teacher final approval + publish date
    resultApprovalStatus: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
    },
    resultApprovedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    resultApprovedAt: {
        type: Date,
        default: null,
    },
    resultRejectionReason: {
        type: String,
        default: '',
    },
    resultPublishDate: {
        type: Date,
        default: null,
    },
}, { timestamps: true });

AptitudeExamSchema.index({ section: 1, examDate: 1 });
AptitudeExamSchema.index({ school: 1, status: 1 });

module.exports = db.model('AptitudeExam', AptitudeExamSchema);
