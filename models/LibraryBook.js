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
    },
    isbn: {
        type: String,
        default: '',
        trim: true,
    },
    authors: {
        type: [String],
        default: [],
    },
    publisher: {
        type: String,
        default: '',
        trim: true,
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

module.exports = db.model('LibraryBook', LibraryBookSchema);
