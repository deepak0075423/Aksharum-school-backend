const db = require('../db/orm');

// Links a Student to a Route + pickup/drop stops + seat (spec §7 and §8).
// One active assignment per student; suspensions/cancellations keep history.
const TransportAssignmentSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },

    student: { type: db.Types.UUID, ref: 'User', required: true, index: true }, // User w/ role student
    route: { type: db.Types.UUID, ref: 'TransportRoute', required: true },
    vehicle: { type: db.Types.UUID, ref: 'Vehicle', default: null }, // denormalised from route

    // Stops reference the embedded StopSchema _id inside the route.
    pickupStop: { type: db.Types.UUID, default: null },
    dropStop: { type: db.Types.UUID, default: null },
    shift: { type: String, enum: ['morning', 'evening', 'both'], default: 'both' },

    seatNumber: { type: String, default: '' },
    feePlan: { type: db.Types.UUID, ref: 'TransportFeePlan', default: null },

    effectiveDate: { type: Date, default: Date.now },
    endDate: { type: Date, default: null },

    // Temporary assignment / address override (spec §7, §12).
    isTemporary: { type: Boolean, default: false },
    temporaryAddress: { type: String, default: '' },

    status: { type: String, enum: ['active', 'suspended', 'cancelled'], default: 'active' },
    suspensionReason: { type: String, default: '' },
    notes: { type: String, default: '' },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

TransportAssignmentSchema.index({ school: 1, student: 1, status: 1 });
TransportAssignmentSchema.index({ school: 1, route: 1, status: 1 });
// A student may only have one active assignment at a time.
TransportAssignmentSchema.index(
    { school: 1, student: 1 },
    { unique: true, partialFilterExpression: { status: 'active' } },
);

module.exports = db.model('TransportAssignment', TransportAssignmentSchema);
