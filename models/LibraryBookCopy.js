const db = require('../db/orm');

const LibraryBookCopySchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
        index: true,
    },
    book: {
        type: db.Types.UUID,
        ref: 'LibraryBook',
        required: true,
        index: true,
    },
    // Globally unique per school — format: LIB-COPY-000001
    uniqueCode: {
        type: String,
        required: true,
        trim: true,
    },
    status: {
        type: String,
        enum: ['available', 'issued', 'reserved', 'lost', 'damaged'],
        default: 'available',
    },
    condition: {
        type: String,
        enum: ['new', 'good', 'fair', 'damaged'],
        default: 'new',
    },
    rackLocation: {
        type: String,
        default: '',
        trim: true,
    },
    acquisitionDate: {
        type: Date,
        default: null,
    },
    addedBy: {
        type: db.Types.UUID,
        ref: 'User',
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Unique copy code per school
LibraryBookCopySchema.index({ school: 1, uniqueCode: 1 }, { unique: true });
LibraryBookCopySchema.index({ school: 1, status: 1 });
LibraryBookCopySchema.index({ book: 1, status: 1 });

module.exports = db.model('LibraryBookCopy', LibraryBookCopySchema);
