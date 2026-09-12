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

    /**
     * What kind of document this is, from a fixed list — the TYPE column and
     * the tabs on the admin landing page are both built on it.
     *
     * Deliberately separate from `category`, which is a free-form label each
     * school invents for itself (DocumentCategory). A tab called
     * "Notices/Circulars" cannot be built on a string one school spells
     * "Notice" and another "Circulars & Notices"; the taxonomy has to be the
     * same everywhere, and the school's own filing label sits beside it.
     */
    docType: {
        type: String,
        enum: ['notice', 'circular', 'study_material', 'assignment', 'other'],
        default: 'other',
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

    /**
     * What kind of assignment this is. Only read when `isAssignment` — the
     * assignment header states it, and it is the one thing about a piece of set
     * work that neither the type nor the category says.
     */
    assignmentType: {
        type: String,
        enum: ['homework', 'classwork', 'project', 'practice', 'lab', 'reading'],
        default: 'homework',
    },

    /**
     * The questions the assignment is marked out of, if it is broken down at
     * all — `[{ label: 'Q1', maxMarks: 10 }, …]`.
     *
     * Optional by design: most assignments are marked as one number, and those
     * simply leave this empty. When it IS filled in, the marking form asks for
     * a score per question and the analytics tab can say which question the
     * class actually struggled with — which is the whole reason to break a
     * total down.
     */
    questions: {
        type: [new db.Schema({
            label:    { type: String, required: true },
            maxMarks: { type: Number, default: null },
        }, { _id: false })],
        default: [],
    },

    /**
     * The year the document was filed under, stamped from the school's active
     * academic year at upload. Held as a reference rather than derived from
     * `createdAt` at read time: a year's window can be edited after the fact,
     * and a notice must not silently move between years when it is.
     */
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        default: null,
    },

    isArchived: {
        type: Boolean,
        default: false,
    },
}, { timestamps: true });

DocumentSchema.index({ school: 1, createdAt: -1 });
DocumentSchema.index({ school: 1, category: 1 });
DocumentSchema.index({ school: 1, docType: 1 });
DocumentSchema.index({ school: 1, academicYear: 1 });
DocumentSchema.index({ school: 1, isArchived: 1 });
DocumentSchema.index({ uploadedBy: 1 });

module.exports = db.model('Document', DocumentSchema);
