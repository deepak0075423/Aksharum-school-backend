const db = require('../db/orm');

// A single GPS ping (spec §9). Written by the GPS device / driver app; read for
// live tracking (latest per vehicle) and trip playback (ordered by time).
// High-volume — indexed for both access patterns and safe to prune periodically.
const VehicleLocationSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    vehicle: { type: db.Types.UUID, ref: 'Vehicle', required: true },
    trip: { type: db.Types.UUID, ref: 'TransportTrip', default: null },

    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    speed: { type: Number, default: 0 },                     // km/h
    heading: { type: Number, default: 0 },                   // degrees 0-360
    accuracy: { type: Number, default: 0 },                  // metres
    engineOn: { type: Boolean, default: true },
    recordedAt: { type: Date, default: Date.now },
}, { timestamps: true });

VehicleLocationSchema.index({ school: 1, vehicle: 1, recordedAt: -1 });
VehicleLocationSchema.index({ trip: 1, recordedAt: 1 });

module.exports = db.model('VehicleLocation', VehicleLocationSchema);
