const db = require('../db/orm');

// A parent/student transport request with an approval workflow (spec §20).
// Approving certain types mutates the linked assignment (handled in controller).
const TransportRequestSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },

    requestCode: { type: String, default: '' },              // TRQ-YYMM-####
    requestedBy: { type: db.Types.UUID, ref: 'User', required: true },
    student: { type: db.Types.UUID, ref: 'StudentProfile', required: true },

    requestType: {
        type: String,
        enum: ['new_transport', 'route_change', 'stop_change', 'temporary_address', 'permanent_address', 'cancellation'],
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
    },

    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
    reviewedBy: { type: db.Types.UUID, ref: 'User', default: null },
    reviewNote: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
}, { timestamps: true });

TransportRequestSchema.index({ school: 1, status: 1, createdAt: -1 });
TransportRequestSchema.index({ school: 1, requestedBy: 1 });

module.exports = db.model('TransportRequest', TransportRequestSchema);
