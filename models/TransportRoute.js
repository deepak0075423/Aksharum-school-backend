const db = require('../db/orm');

// A stop on a route (spec §6). Embedded so a route is a single fetch, but each
// stop keeps its own _id so student assignments and trip events can reference it.
const StopSchema = new db.Schema({
    name: { type: String, required: true, trim: true },
    sequence: { type: Number, default: 0 },                  // order along the route
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    landmark: { type: String, default: '' },
    arrivalTime: { type: String, default: '' },              // "07:15" (morning)
    departureTime: { type: String, default: '' },
    eveningTime: { type: String, default: '' },              // "15:20" (evening drop)
    maxStudents: { type: Number, default: 0 },               // 0 = no cap
    distanceFromStart: { type: Number, default: 0 },         // km (for distance-based fee)
    isActive: { type: Boolean, default: true },
}, { _id: true });

// A transport Route (spec §5). Holds the ordered stops, the assigned vehicle &
// crew, and the shift/type so the same physical road can have morning/evening,
// holiday, temporary and alternative variants.
const TransportRouteSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    campus: { type: String, default: '' },

    routeCode: { type: String, required: true, trim: true },  // auto RT-YYMM-####
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    shift: { type: String, enum: ['morning', 'evening', 'both'], default: 'both' },
    routeType: { type: String, enum: ['regular', 'holiday', 'temporary', 'alternative'], default: 'regular' },

    // Assigned resources (a route with no vehicle/driver is a "draft").
    vehicle: { type: db.Types.UUID, ref: 'Vehicle', default: null },
    driver: { type: db.Types.UUID, ref: 'TransportStaff', default: null },
    backupDriver: { type: db.Types.UUID, ref: 'TransportStaff', default: null },
    attendant: { type: db.Types.UUID, ref: 'TransportStaff', default: null },

    startPoint: { type: String, default: '' },
    endPoint: { type: String, default: 'School' },
    distanceKm: { type: Number, default: 0 },
    estimatedDurationMin: { type: Number, default: 0 },
    geofenceRadiusM: { type: Number, default: 150 },

    stops: [StopSchema],

    // For temporary/alternative routes.
    effectiveFrom: { type: Date, default: null },
    effectiveTo: { type: Date, default: null },

    status: { type: String, enum: ['active', 'inactive', 'draft'], default: 'active' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

TransportRouteSchema.index({ school: 1, routeCode: 1 }, { unique: true });
TransportRouteSchema.index({ school: 1, status: 1 });
TransportRouteSchema.index({ school: 1, vehicle: 1 });

module.exports = db.model('TransportRoute', TransportRouteSchema);
