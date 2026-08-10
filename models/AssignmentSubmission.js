const db = require('../db/orm');

const FileSchema = new db.Schema({
    originalName: { type: String, required: true },
    storedName:   { type: String, required: true },
    filePath:     { type: String, required: true },
    mimeType:     { type: String, required: true },
    fileSize:     { type: Number, required: true },
}, { _id: false });

const AssignmentSubmissionSchema = new db.Schema({
    document: {
        type: db.Types.UUID,
        ref: 'Document',
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    student: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        default: null,
    },
    files: {
        type: [FileSchema],
        default: [],
    },
    status: {
        type: String,
        enum: ['pending', 'submitted', 'late'],
        default: 'pending',
    },
    submittedAt: {
        type: Date,
        default: null,
    },
    reviewedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    reviewedAt: {
        type: Date,
        default: null,
    },
    marks: {
        type: Number,
        default: null,
    },
    feedback: {
        type: String,
        default: '',
    },
}, { timestamps: true });

AssignmentSubmissionSchema.index({ document: 1, student: 1 }, { unique: true });
AssignmentSubmissionSchema.index({ document: 1, status: 1 });
AssignmentSubmissionSchema.index({ student: 1 });

module.exports = db.model('AssignmentSubmission', AssignmentSubmissionSchema);
