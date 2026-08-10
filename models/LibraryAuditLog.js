const db = require('../db/orm');

const LibraryAuditLogSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        index: true,
    },
    user: {
        type: db.Types.UUID,
        ref: 'User',
    },
    role: {
        type: String,
        default: '',
    },
    actionType: {
        type: String,
        required: true,
        // BOOK_CREATED, BOOK_UPDATED, BOOK_DELETED
        // COPY_ADDED, COPY_UPDATED, COPY_STATUS_CHANGED
        // BOOK_ISSUED, BOOK_RETURNED, BOOK_RENEWED
        // RESERVATION_CREATED, RESERVATION_READY, RESERVATION_COLLECTED, RESERVATION_EXPIRED, RESERVATION_CANCELLED
        // FINE_GENERATED, FINE_PAID, FINE_WAIVED
        // POLICY_UPDATED
    },
    entityType: {
        type: String,
        required: true,
        enum: ['Book', 'BookCopy', 'Issuance', 'Reservation', 'Fine', 'Policy'],
    },
    entityId: {
        type: db.Types.UUID,
    },
    oldValue: {
        type: db.Types.JSON,
        default: null,
    },
    newValue: {
        type: db.Types.JSON,
        default: null,
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true,
    },
});

// Immutable — never allow updates or deletes via application code
LibraryAuditLogSchema.index({ school: 1, timestamp: -1 });
LibraryAuditLogSchema.index({ school: 1, actionType: 1 });
LibraryAuditLogSchema.index({ school: 1, entityType: 1, entityId: 1 });

module.exports = db.model('LibraryAuditLog', LibraryAuditLogSchema);
