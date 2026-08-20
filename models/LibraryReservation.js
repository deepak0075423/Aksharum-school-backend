const db = require('../db/orm');

const LibraryReservationSchema = new db.Schema({
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
    reservedBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
        index: true,
    },
    // FIFO position in the queue (1 = next to be served).
    // Never chosen by the caller: a new row goes in at 0 and reindexQueue
    // assigns the real number by reservedAt. Reading "max + 1" and inserting
    // raced — two people reserving in the same instant picked the same slot.
    queuePosition: {
        type: Number,
        default: 0,
    },
    status: {
        type: String,
        enum: ['pending', 'ready', 'collected', 'expired', 'cancelled'],
        default: 'pending',
        index: true,
    },
    reservedAt: {
        type: Date,
        default: Date.now,
    },
    // Set when librarian marks a copy is ready for pickup
    readyAt: {
        type: Date,
        default: null,
    },
    // Set when status becomes 'ready' — user has reservationExpiryDays to collect
    expiresAt: {
        type: Date,
        default: null,
    },
    notifiedAt: {
        type: Date,
        default: null,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Prevent duplicate active reservations for same user+book
LibraryReservationSchema.index(
    { book: 1, reservedBy: 1, status: 1 },
    { unique: false }
);
LibraryReservationSchema.index({ school: 1, book: 1, status: 1, queuePosition: 1 });

module.exports = db.model('LibraryReservation', LibraryReservationSchema);
