const db = require('../db/orm');

// Per-stop progress inside a trip (spec §9, §11).
const StopEventSchema = new db.Schema({
    stop: { type: db.Types.UUID, default: null },  // route stop _id
    name: { type: String, default: '' },
    sequence: { type: Number, default: 0 },
    plannedTime: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'reached', 'skipped'], default: 'pending' },
    reachedAt: { type: Date, default: null },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
}, { _id: true });

// A student's boarding/drop record for one trip (spec §10). Method captures how
// attendance was taken (RFID / QR / manual / face / biometric).
const TripAttendanceSchema = new db.Schema({
    student: { type: db.Types.UUID, ref: 'User', required: true },
    assignment: { type: db.Types.UUID, ref: 'TransportAssignment', default: null },
    stop: { type: db.Types.UUID, default: null },
    status: { type: String, enum: ['pending', 'boarded', 'dropped', 'absent', 'no_show'], default: 'pending' },
    method: { type: String, enum: ['rfid', 'qr', 'manual', 'face', 'biometric', ''], default: '' },
    boardTime: { type: Date, default: null },
    dropTime: { type: Date, default: null },
    byUser: { type: db.Types.UUID, ref: 'User', default: null },
}, { _id: true });

// A single scheduled/executed Daily Trip (spec §11). One route generates two
// trips a day (pickup + drop). Drives live tracking, attendance and delays.
const TransportTripSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },

    tripCode: { type: String, default: '' },                 // TRP-YYMMDD-####
    route: { type: db.Types.UUID, ref: 'TransportRoute', required: true },
    vehicle: { type: db.Types.UUID, ref: 'Vehicle', default: null },
    driver: { type: db.Types.UUID, ref: 'TransportStaff', default: null },
    attendant: { type: db.Types.UUID, ref: 'TransportStaff', default: null },

    date: { type: Date, required: true, index: true },       // trip day (local midnight)
    shift: { type: String, enum: ['morning', 'evening'], required: true },
    direction: { type: String, enum: ['pickup', 'drop'], required: true },

    status: {
        type: String,
        enum: ['scheduled', 'started', 'paused', 'completed', 'cancelled'],
        default: 'scheduled',
    },
    startTime: { type: Date, default: null },
    endTime: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    startOdometer: { type: Number, default: null },
    endOdometer: { type: Number, default: null },

    delayMinutes: { type: Number, default: 0 },
    cancellationReason: { type: String, default: '' },

    stopEvents: [StopEventSchema],
    studentAttendance: [TripAttendanceSchema],
    missedStops: { type: [String], default: [] },
    extraStops: { type: [String], default: [] },

    // Snapshot of last known position (live list without joining VehicleLocation).
    lastLocation: {
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
        speed: { type: Number, default: 0 },
        updatedAt: { type: Date, default: null },
    },
    notes: { type: String, default: '' },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

TransportTripSchema.index({ school: 1, date: 1, shift: 1 });
TransportTripSchema.index({ school: 1, route: 1, date: 1 });
TransportTripSchema.index({ school: 1, status: 1 });

module.exports = db.model('TransportTrip', TransportTripSchema);
