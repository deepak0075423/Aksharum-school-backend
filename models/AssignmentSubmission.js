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

    /**
     * Marks per question, when the assignment defines questions —
     * `[{ label: 'Q1', score: 8 }, …]`.
     *
     * The labels are copied from the assignment rather than referenced, so
     * renaming a question later cannot silently re-attribute marks already
     * awarded. `marks` above stays the total and remains the field everything
     * else reads; this only ever explains it.
     */
    questionScores: {
        type: [new db.Schema({
            label: { type: String, required: true },
            score: { type: Number, default: null },
        }, { _id: false })],
        default: [],
    },
}, { timestamps: true });

AssignmentSubmissionSchema.index({ document: 1, student: 1 }, { unique: true });
AssignmentSubmissionSchema.index({ document: 1, status: 1 });
AssignmentSubmissionSchema.index({ student: 1 });

module.exports = db.model('AssignmentSubmission', AssignmentSubmissionSchema);
