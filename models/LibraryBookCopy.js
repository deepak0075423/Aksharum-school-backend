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
    // ── Accession record ─────────────────────────────────────────────────────
    // uniqueCode is the accession number; these are the rest of the register a
    // school is expected to keep — where the book came from, against which bill,
    // and what it cost. Without them the copy row cannot answer an audit.
    acquisitionDate: {
        type: Date,
        default: null,
    },
    vendor: {
        type: String,
        default: '',
        trim: true,
    },
    billNumber: {
        type: String,
        default: '',
        trim: true,
    },
    cost: {
        type: Number,
        default: 0,
        min: 0,
    },
    // Set when a copy leaves the collection (lost, or withdrawn as damaged
    // beyond use) — the register has to show what was written off and when.
    writtenOffAt: {
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
