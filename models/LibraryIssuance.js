const db = require('../db/orm');

const LibraryIssuanceSchema = new db.Schema({
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
    },
    bookCopy: {
        type: db.Types.UUID,
        ref: 'LibraryBookCopy',
        required: true,
    },
    issuedTo: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
        index: true,
    },
    issuedToRole: {
        type: String,
        default: '',
    },
    issuedBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    issueDate: {
        type: Date,
        default: Date.now,
    },
    dueDate: {
        type: Date,
        required: true,
    },
    returnDate: {
        type: Date,
        default: null,
    },
    renewalCount: {
        type: Number,
        default: 0,
    },
    status: {
        type: String,
        enum: ['issued', 'returned', 'overdue', 'lost'],
        default: 'issued',
        index: true,
    },
    fine: {
        type: db.Types.UUID,
        ref: 'LibraryFine',
        default: null,
    },
    notes: {
        type: String,
        default: '',
        trim: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

LibraryIssuanceSchema.index({ school: 1, status: 1 });
LibraryIssuanceSchema.index({ school: 1, issuedTo: 1, status: 1 });
LibraryIssuanceSchema.index({ bookCopy: 1, status: 1 });
LibraryIssuanceSchema.index({ dueDate: 1, status: 1 });

module.exports = db.model('LibraryIssuance', LibraryIssuanceSchema);
