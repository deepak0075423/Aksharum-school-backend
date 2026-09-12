const db = require('../db/orm');

const FileSchema = new db.Schema({
    originalName: { type: String, required: true },
    storedName:   { type: String, required: true },
    filePath:     { type: String, required: true },
    mimeType:     { type: String, required: true },
    fileSize:     { type: Number, required: true },
}, { _id: false });

/**
 * The discussion hanging off one document.
 *
 * A flat table with a `parent` rather than nested arrays: a reply is a row like
 * any other, so it can be liked, pinned, edited and deleted by the same code as
 * a top-level comment, and the thread is assembled once at read time. Only one
 * level of nesting is offered — a reply to a reply attaches to the same parent,
 * because a school discussion that goes deeper than that is a chat, and the app
 * already has one.
 */
const DocumentCommentSchema = new db.Schema({
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
    author: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    // Stamped at write time. The author's account role can change — a teacher
    // becomes an admin — and a two-year-old comment should still read as having
    // been written by whoever wrote it at the time.
    authorRole: {
        type: String,
        enum: ['school_admin', 'teacher', 'student', 'parent'],
        required: true,
    },
    body: {
        type: String,
        default: '',
    },
    files: {
        type: [FileSchema],
        default: [],
    },
    // null for a top-level comment; the comment being replied to otherwise.
    parent: {
        type: db.Types.UUID,
        ref: 'DocumentComment',
        default: null,
    },
    isPinned: {
        type: Boolean,
        default: false,
    },
    /**
     * Who can read it. `all` is everyone the document itself reaches; `staff`
     * keeps it between the teachers and admins working on the assignment, so a
     * note about a struggling class is not published to that class.
     */
    visibility: {
        type: String,
        enum: ['all', 'staff'],
        default: 'all',
    },
    likes: {
        type: [db.Types.UUID],
        default: [],
    },
    isEdited: {
        type: Boolean,
        default: false,
    },
}, { timestamps: true });

DocumentCommentSchema.index({ document: 1, createdAt: -1 });
DocumentCommentSchema.index({ document: 1, parent: 1 });
DocumentCommentSchema.index({ school: 1 });

module.exports = db.model('DocumentComment', DocumentCommentSchema);
