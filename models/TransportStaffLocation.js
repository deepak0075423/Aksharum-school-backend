const db = require('../db/orm');

// A GPS ping from a crew member's own device.
//
// Separate from VehicleLocation because they answer different questions: a
// vehicle ping says where the bus is, this says where the person is. They
// diverge exactly when it matters — a driver who has left the bus, a conductor
// walking a child to their door, someone who has not reached the depot yet.
//
// High-volume and safe to prune: TransportSettings.locationRetentionDays
// governs both this and VehicleLocation.
const TransportStaffLocationSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    staff: { type: db.Types.UUID, ref: 'TransportStaff', required: true },
    user: { type: db.Types.UUID, ref: 'User', default: null },   // who pushed it
    trip: { type: db.Types.UUID, ref: 'TransportTrip', default: null },

    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    accuracy: { type: Number, default: null },               // metres, from the device
    speed: { type: Number, default: 0 },                     // km/h
    heading: { type: Number, default: 0 },
    battery: { type: Number, default: null },                // % — a flat phone explains a silent tracker
    source: { type: String, enum: ['device', 'vehicle', 'manual'], default: 'device' },
    recordedAt: { type: Date, default: Date.now },
}, { timestamps: true });

TransportStaffLocationSchema.index({ school: 1, staff: 1, recordedAt: -1 });

module.exports = db.model('TransportStaffLocation', TransportStaffLocationSchema);
