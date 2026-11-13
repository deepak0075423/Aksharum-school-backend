const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  Video Learning — a book in the central library: Board → Class → Subject →
//  Book. One subject has as many books as there are publishers.
//
//  status
//    active    schools may select it; students of sections it is assigned to see it
//    inactive  hidden from schools and students until switched back on
//    archived  no new school may select it; sections already using it keep it
//
//  Editions: every edition of one title shares `editionGroup` (the first
//  edition's own id) and points at the one before it (`previousEdition`).
//  A book that a school uses or a student has watched is never deleted
//  (services/lms/catalog.removeBook) — it is archived.
// ─────────────────────────────────────────────────────────────────────────────
const LmsBookSchema = new db.Schema({
    title:           { type: String, required: true, trim: true, trgm: true },
    board:           { type: db.Types.UUID, ref: 'LmsBoard', required: true, index: true },
    classLevel:      { type: Number, required: true },
    subject:         { type: db.Types.UUID, ref: 'LmsSubject', required: true, index: true },
    publisher:       { type: String, default: '', trim: true },
    author:          { type: String, default: '', trim: true },
    isbn:            { type: String, default: '', trim: true },
    edition:         { type: String, default: '', trim: true },
    publicationYear: { type: Number, default: null },
    language:        { type: String, default: 'English', trim: true },
    description:     { type: String, default: '' },
    coverUrl:        { type: String, default: '' },
    displayOrder:    { type: Number, default: 0 },
    status:          { type: String, enum: ['active', 'inactive', 'archived'], default: 'active', index: true },
    editionGroup:    { type: db.Types.UUID, default: null, index: true },
    previousEdition: { type: db.Types.UUID, ref: 'LmsBook', default: null },
    // Set the first time the book is active — "a new book was added" is told once.
    announcedAt:     { type: Date, default: null },
    archivedAt:      { type: Date, default: null },
    createdBy:       { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:       { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

LmsBookSchema.index({ board: 1, classLevel: 1, subject: 1, status: 1 });

module.exports = db.model('LmsBook', LmsBookSchema);
