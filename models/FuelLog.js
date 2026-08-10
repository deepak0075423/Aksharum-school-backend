const db = require('../db/orm');

// A fuel fill-up entry (spec §15). Mileage is auto-computed from the odometer
// delta since the previous entry on the same vehicle.
const FuelLogSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    vehicle: { type: db.Types.UUID, ref: 'Vehicle', required: true, index: true },

    date: { type: Date, default: Date.now },
    fuelType: { type: String, enum: ['diesel', 'petrol', 'cng', 'electric', ''], default: '' },
    litres: { type: Number, required: true },
    pricePerLitre: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },

    odometer: { type: Number, default: 0 },                  // reading at fill-up
    previousOdometer: { type: Number, default: 0 },
    distance: { type: Number, default: 0 },                  // odometer - previous
    mileage: { type: Number, default: 0 },                   // distance / litres (km/l)

    vendor: { type: String, default: '' },
    receipt: { type: String, default: '' },
    filledBy: { type: db.Types.UUID, ref: 'User', default: null },
    note: { type: String, default: '' },
}, { timestamps: true });

FuelLogSchema.index({ school: 1, vehicle: 1, date: -1 });

module.exports = db.model('FuelLog', FuelLogSchema);
