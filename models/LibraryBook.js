const db = require('../db/orm');

const LibraryBookSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
        index: true,
    },
    title: {
        type: String,
        required: true,
        trim: true,
        trgm: true,          // catalogue search matches on substrings
    },
    isbn: {
        type: String,
        default: '',
        trim: true,
        trgm: true,
    },
    authors: {
        type: [String],
        default: [],
    },
    publisher: {
        type: String,
        default: '',
        trim: true,
        trgm: true,
    },
    category: {
        type: String,
        default: '',
        trim: true,
    },
    edition: {
        type: String,
        default: '',
        trim: true,
    },
    language: {
        type: String,
        default: 'English',
        trim: true,
    },
    description: {
        type: String,
        default: '',
        trim: true,
    },
    // Duplicate detection compares normalised forms — 978-0-13-235088-4 and
    // 9780132350884 are the same book, as are "Physics" and "  PHYSICS  ".
    // Persisting them turns that check from a per-row regex scan into an index
    // lookup, and lets the database enforce the rule even if a caller forgets.
    isbnNormalized: {
        type: String,
        default: '',
        index: true,
    },
    titleNormalized: {
        type: String,
        default: '',
        index: true,
    },
    // Denormalized counts for fast availability queries
    totalCopies: {
        type: Number,
        default: 0,
    },
    availableCopies: {
        type: Number,
        default: 0,
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

LibraryBookSchema.index({ school: 1, title: 1 });
LibraryBookSchema.index({ school: 1, isbn: 1 });
LibraryBookSchema.index({ school: 1, category: 1 });
// The catalogue identity rules, enforced by the database rather than by
// convention. Partial, because a book without an ISBN is identified by its
// title + edition instead, and blanks must not collide with each other.
LibraryBookSchema.index(
    { school: 1, isbnNormalized: 1 },
    { unique: true, partialFilterExpression: { isbnNormalized: { $ne: '' } } },
);
LibraryBookSchema.index(
    { school: 1, titleNormalized: 1, edition: 1 },
    { unique: true, partialFilterExpression: { isbnNormalized: '' } },
);

// Derived on every write path — Model.create, updateOne and findOneAndUpdate
// all funnel through _saveDoc, so there is no way to write a book row that
// skips this and slips past the unique indexes above.
LibraryBookSchema.pre('save', function normalizeIdentity() {
    this.isbnNormalized  = String(this.isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    this.titleNormalized = String(this.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
});

module.exports = db.model('LibraryBook', LibraryBookSchema);
