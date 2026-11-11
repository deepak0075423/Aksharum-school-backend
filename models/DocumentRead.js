const db = require('../db/orm');

/**
 * Who has opened which document.
 *
 * A row per (document × reader) rather than an array on the document: a notice
 * shared with the whole school would carry a thousand ids on one row, rewritten
 * every time somebody opens it. A row existing is the whole fact — there is no
 * "unread" row, so a document nobody has opened costs nothing.
 */
const DocumentReadSchema = new db.Schema({
    document: { type: db.Types.UUID, ref: 'Document', required: true },
    user:     { type: db.Types.UUID, ref: 'User',     required: true },
    school:   { type: db.Types.UUID, ref: 'School',   required: true },
    readAt:   { type: Date, default: Date.now },
}, { timestamps: true });

DocumentReadSchema.index({ document: 1, user: 1 }, { unique: true });

module.exports = db.model('DocumentRead', DocumentReadSchema);
