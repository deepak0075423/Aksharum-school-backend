const db = require('../db/orm');

// Links a Student to a Route + pickup/drop stops + seat (spec §7 and §8).
// One active assignment per student; suspensions/cancellations keep history.
const TransportAssignmentSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },

    // The enrolled person. Historically students only, so the column keeps its
    // name and every existing row keeps working; `personType` says which kind
    // of person it is. Teachers ride the bus too and are enrolled the same way.
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    // NOTE: a column added to an existing table carries '' on the rows that were
    // already there — the schema default only applies to inserts. Anything that
    // branches on this must treat a falsy value as 'student', which is what
    // every row written before this field existed was.
    personType: { type: String, enum: ['student', 'teacher'], default: 'student', index: true },
    route: { type: db.Types.UUID, ref: 'TransportRoute', required: true },
    vehicle: { type: db.Types.UUID, ref: 'Vehicle', default: null }, // denormalised from route

    // Stops reference the embedded StopSchema _id inside the route.
    pickupStop: { type: db.Types.UUID, default: null },
    dropStop: { type: db.Types.UUID, default: null },
    shift: { type: String, enum: ['morning', 'evening', 'both'], default: 'both' },

    seatNumber: { type: String, default: '' },
    feePlan: { type: db.Types.UUID, ref: 'TransportFeePlan', default: null },

    // When the service starts for this person, and when it ended.
    effectiveDate: { type: Date, default: Date.now },
    endDate: { type: Date, default: null },

    // What they were quoted, when the plan's own figure is not the whole story
    // (a staff concession, a sibling discount already applied). Null means "use
    // the fee plan's amount", which is what every existing row means.
    feeAmount: { type: Number, default: null },
    feeStatus: { type: String, enum: ['pending', 'partial', 'paid', 'waived'], default: 'pending' },

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
// One active enrolment per person at a time.
TransportAssignmentSchema.index(
    { school: 1, student: 1 },
    { unique: true, partialFilterExpression: { status: 'active' } },
);

module.exports = db.model('TransportAssignment', TransportAssignmentSchema);
