const db = require('../db/orm');

// A parent/student transport request with an approval workflow (spec §20).
// Approving certain types mutates the linked assignment (handled in controller).
const TransportRequestSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },

    requestCode: { type: String, default: '' },              // TRQ-YYMM-####
    requestedBy: { type: db.Types.UUID, ref: 'User', required: true },
    // A User with role 'student' — NOT a StudentProfile. The portal has always
    // written the child's User id here (that is what approval matches
    // assignments on); the ref said StudentProfile, so every admin screen that
    // populated it got nothing back and showed a blank student name.
    student: { type: db.Types.UUID, ref: 'User', required: true },

    requestType: {
        type: String,
        enum: ['new_transport', 'route_change', 'stop_change', 'pickup_change', 'drop_change',
               'temporary_address', 'permanent_address', 'leave_request', 'special_trip',
               'cancellation', 'other'],
        required: true,
    },
    currentAssignment: { type: db.Types.UUID, ref: 'TransportAssignment', default: null },

    // Whatever the request proposes (nulls ignored on apply).
    details: {
        route: { type: db.Types.UUID, ref: 'TransportRoute', default: null },
        pickupStop: { type: db.Types.UUID, default: null },
        dropStop: { type: db.Types.UUID, default: null },
        address: { type: String, default: '' },
        fromDate: { type: Date, default: null },
        toDate: { type: Date, default: null },
        reason: { type: String, default: '' },
        note: { type: String, default: '' },
    },

    // Raised by an admin on someone's behalf, or flagged by the reviewer as
    // needing something from the school before it can be decided.
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    requiresAction: { type: Boolean, default: false },
    actionNote: { type: String, default: '' },

    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
    reviewedBy: { type: db.Types.UUID, ref: 'User', default: null },
    reviewNote: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
}, { timestamps: true });

TransportRequestSchema.index({ school: 1, status: 1, createdAt: -1 });
TransportRequestSchema.index({ school: 1, requestedBy: 1 });

module.exports = db.model('TransportRequest', TransportRequestSchema);
