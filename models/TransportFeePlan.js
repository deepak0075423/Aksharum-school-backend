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

    // The plan's scope, as the Fee Plans table prints it: a route, or a named
    // zone, plus the class of vehicle it prices.
    route: { type: db.Types.UUID, ref: 'TransportRoute', default: null },
    zoneLabel: { type: String, default: '' },                // "South Kolkata"
    vehicleType: { type: String, enum: ['bus', 'mini_bus', 'van', 'car', 'tempo', 'any', ''], default: '' },

    amount: { type: Number, default: 0 },                    // used by flat / route / stop
    zones: [ZoneSchema],                                     // used by distance / zone

    lateFeePerDay: { type: Number, default: 0 },
    siblingDiscountPct: { type: Number, default: 0 },

    // A plan may be drafted by a coordinator and wait for a head's sign-off —
    // the Fee Plans screen counts these on its "Pending Approvals" tile.
    approvalStatus: { type: String, enum: ['approved', 'pending', 'rejected'], default: 'approved' },
    approvedBy: { type: db.Types.UUID, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    effectiveFrom: { type: Date, default: null },
    renewalDate: { type: Date, default: null },

    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

TransportFeePlanSchema.index({ school: 1, status: 1 });

module.exports = db.model('TransportFeePlan', TransportFeePlanSchema);
