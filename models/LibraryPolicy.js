const db = require('../db/orm');

const LibraryPolicySchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
        unique: true,
    },
    maxBooksPerUser: {
        type: Number,
        default: 3,
        min: 1,
    },
    issueDurationDays: {
        type: Number,
        default: 14,
        min: 1,
    },
    finePerDay: {
        type: Number,
        default: 2,
        min: 0,
    },
    gracePeriodDays: {
        type: Number,
        default: 0,
        min: 0,
    },
    maxRenewals: {
        type: Number,
        default: 1,
        min: 0,
    },
    reservationExpiryDays: {
        type: Number,
        default: 2,
        min: 1,
    },
    teacherFinesEnabled: {
        type: Boolean,
        default: false,
    },
    // Atomic counter for generating unique copy codes — never decrement
    lastCopySequence: {
        type: Number,
        default: 0,
    },
    updatedBy: {
        type: db.Types.UUID,
        ref: 'User',
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = db.model('LibraryPolicy', LibraryPolicySchema);
