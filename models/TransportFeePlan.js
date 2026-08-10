const db = require('../db/orm');

// A distance/zone band used by distance- and zone-based plans (spec §14).
const ZoneSchema = new db.Schema({
    name: { type: String, required: true },
    maxDistanceKm: { type: Number, default: 0 },             // upper bound of the band
    amount: { type: Number, required: true },
}, { _id: true });

// A Transport Fee Plan (spec §14). The `basis` decides how the payable amount is
// resolved for a student: flat, per-route, per-stop, or by distance/zone band.
const TransportFeePlanSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },

    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    basis: { type: String, enum: ['flat', 'route', 'stop', 'distance', 'zone'], default: 'flat' },
    frequency: { type: String, enum: ['monthly', 'quarterly', 'yearly', 'one_time'], default: 'monthly' },

    amount: { type: Number, default: 0 },                    // used by flat / route / stop
    zones: [ZoneSchema],                                     // used by distance / zone

    lateFeePerDay: { type: Number, default: 0 },
    siblingDiscountPct: { type: Number, default: 0 },

    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

TransportFeePlanSchema.index({ school: 1, status: 1 });

module.exports = db.model('TransportFeePlan', TransportFeePlanSchema);
