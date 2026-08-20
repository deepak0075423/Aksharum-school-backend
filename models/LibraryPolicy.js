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
    // ── Borrowing rules ──────────────────────────────────────────────────────
    // One person holding two copies of the same title is almost always a
    // counter mistake, so it is refused unless a school deliberately allows it
    // (a set text handed out in multiples, say).
    allowMultipleCopiesPerUser: {
        type: Boolean,
        default: false,
    },
    // Standard library practice: clear what you owe before you borrow again.
    blockIssueOnPendingFine: {
        type: Boolean,
        default: true,
    },
    blockIssueOnOverdue: {
        type: Boolean,
        default: true,
    },
    maxReservationsPerUser: {
        type: Number,
        default: 3,
        min: 1,
    },
    // Loss and damage are charged as a multiple of the daily fine, which is the
    // only money figure a school configures here. Compensation for the book,
    // not a penalty for lateness — so the teacher exemption does not apply.
    lostBookFineDays: {
        type: Number,
        default: 30,
        min: 0,
    },
    damagedBookFineDays: {
        type: Number,
        default: 10,
        min: 0,
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
