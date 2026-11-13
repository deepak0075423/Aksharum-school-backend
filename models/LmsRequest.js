const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  A school asking the library for something it does not have: a whole book
//  (`type: 'book'`) or a chapter / its videos in a book that exists
//  (`type: 'chapter'`).
//
//  pending → under_review → approved | rejected → in_progress → completed
//
//  `dedupeKey` is what the request is FOR, normalised; one open request per
//  school and key (db/migrate.js), so the same ask is not filed twice.
//  `subjectKey` is the same without the school — how many schools want it.
// ─────────────────────────────────────────────────────────────────────────────
const LmsRequestSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true, index: true },
    type:    { type: String, enum: ['book', 'chapter'], required: true, index: true },
    status:  { type: String, enum: ['pending', 'under_review', 'approved', 'rejected', 'in_progress', 'completed'], default: 'pending', index: true },

    // A book that is not in the library
    board:           { type: db.Types.UUID, ref: 'LmsBoard', default: null },
    boardName:       { type: String, default: '' },
    classLevel:      { type: Number, default: null },
    subject:         { type: db.Types.UUID, ref: 'LmsSubject', default: null },
    subjectName:     { type: String, default: '' },
    title:           { type: String, default: '', trim: true },
    publisher:       { type: String, default: '', trim: true },
    author:          { type: String, default: '', trim: true },
    edition:         { type: String, default: '', trim: true },
    publicationYear: { type: Number, default: null },
    attachmentFile:  { type: String, default: '' },     // uploads/lms-requests — read through the API only
    attachmentName:  { type: String, default: '' },

    // A chapter or video missing from a book that is
    book:          { type: db.Types.UUID, ref: 'LmsBook', default: null, index: true },
    chapterNumber: { type: Number, default: null },
    chapterName:   { type: String, default: '', trim: true },
    topic:         { type: String, default: '' },

    comments:    { type: String, default: '' },
    dedupeKey:   { type: String, default: '', index: true },
    subjectKey:  { type: String, default: '', index: true },

    requestedBy: { type: db.Types.UUID, ref: 'User', required: true },
    reviewedBy:  { type: db.Types.UUID, ref: 'User', default: null },
    reviewNote:  { type: String, default: '' },
    resolvedBook:    { type: db.Types.UUID, ref: 'LmsBook', default: null },
    resolvedChapter: { type: db.Types.UUID, ref: 'LmsChapter', default: null },
    history:     { type: [db.Types.JSON], default: [] },   // [{ status, at, by, note }]
}, { timestamps: true });

LmsRequestSchema.index({ school: 1, status: 1 });

module.exports = db.model('LmsRequest', LmsRequestSchema);
