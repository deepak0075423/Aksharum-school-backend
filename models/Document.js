const db = require('../db/orm');

const FileSchema = new db.Schema({
    originalName: { type: String, required: true },
    storedName:   { type: String, required: true },
    filePath:     { type: String, required: true },
    mimeType:     { type: String, required: true },
    fileSize:     { type: Number, required: true },
}, { _id: false });

const DocumentSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    title: {
        type: String,
        required: true,
        trim: true,
    },
    description: {
        type: String,
        default: '',
    },
    category: {
        type: String,
        required: true,
        trim: true,
    },
    subject: {
        type: String,
        default: '',
    },
    tags: {
        type: [String],
        default: [],
    },

    // Current-version files
    files: {
        type: [FileSchema],
        default: [],
    },
    currentVersion: {
        type: Number,
        default: 1,
    },

    uploadedBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    uploaderRole: {
        type: String,
        enum: ['school_admin', 'teacher'],
        required: true,
    },

    // Sharing target
    targetType: {
        type: String,
        enum: [
            'whole_school',       // admin → all users in school
            'all_teachers',       // admin → all teachers
            'specific_teachers',  // hand-picked teachers
            'class',              // all sections of one or more classes
            'class_sections',     // specific sections
        ],
        required: true,
    },
    targetClasses:   [{ type: db.Types.UUID, ref: 'Class' }],
    targetSections:  [{ type: db.Types.UUID, ref: 'ClassSection' }],
    targetUsers:     [{ type: db.Types.UUID, ref: 'User' }],

    // Assignment-specific fields
    isAssignment: {
        type: Boolean,
        default: false,
    },
    dueDate: {
        type: Date,
        default: null,
    },
    allowSubmission: {
        type: Boolean,
        default: true,
    },
    marksEnabled: {
        type: Boolean,
        default: false,
    },
    totalMarks: {
        type: Number,
        default: null,
    },

    isArchived: {
        type: Boolean,
        default: false,
    },
}, { timestamps: true });

DocumentSchema.index({ school: 1, createdAt: -1 });
DocumentSchema.index({ school: 1, category: 1 });
DocumentSchema.index({ school: 1, isArchived: 1 });
DocumentSchema.index({ uploadedBy: 1 });

module.exports = db.model('Document', DocumentSchema);
