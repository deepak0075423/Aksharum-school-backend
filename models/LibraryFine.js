const db = require('../db/orm');

const LibraryFineSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
        index: true,
    },
    issuance: {
        type: db.Types.UUID,
        ref: 'LibraryIssuance',
        required: true,
    },
    user: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
        index: true,
    },
    fineType: {
        type: String,
        enum: ['late_return', 'lost', 'damaged'],
        required: true,
    },
    amount: {
        type: Number,
        required: true,
        min: 0,
    },
    daysOverdue: {
        type: Number,
        default: 0,
    },
    status: {
        type: String,
        enum: ['pending', 'paid', 'waived'],
        default: 'pending',
        index: true,
    },
    paidAt: {
        type: Date,
        default: null,
    },
    collectedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    waivedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    waiverReason: {
        type: String,
        default: '',
        trim: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

LibraryFineSchema.index({ school: 1, status: 1 });
LibraryFineSchema.index({ school: 1, user: 1, status: 1 });

module.exports = db.model('LibraryFine', LibraryFineSchema);
