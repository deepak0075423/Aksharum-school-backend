const db = require('../db/orm');

// A compliance / legal document attached to a vehicle (spec §2, §21).
// Kept as an array so any number/type of document can be uploaded, while the
// denormalised *Expiry fields below power the fast "upcoming renewals" widgets.
const VehicleDocSchema = new db.Schema({
    docType: {
        type: String,
        enum: ['insurance', 'rc', 'fitness', 'permit', 'road_tax', 'pollution', 'invoice', 'photo', 'other'],
        required: true,
    },
    number: { type: String, default: '' },
    issueDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },
    file: { type: String, default: '' },
    note: { type: String, default: '' },
}, { _id: true, timestamps: true });

// The Vehicle master (spec §2). Every bus/van in the fleet is created here once,
// then assigned to routes, driven on trips, fuelled, maintained and audited.
const VehicleSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    campus: { type: String, default: '' },                    // multi-campus (free text)

    // ── Identity ─────────────────────────────────────────────
    vehicleNumber: { type: String, required: true, trim: true },  // internal fleet no. auto VH-YYMM-####
    registrationNumber: { type: String, required: true, trim: true }, // RTO plate
    busName: { type: String, default: '' },
    vehicleType: { type: String, enum: ['bus', 'mini_bus', 'van', 'car', 'tempo', 'other'], default: 'bus' },
    photo: { type: String, default: '' },

    // ── Capacity ─────────────────────────────────────────────
    capacity: { type: Number, default: 0 },                   // seat count
    // currentOccupancy is derived from active assignments; stored for quick reads.
    currentOccupancy: { type: Number, default: 0 },

    // ── Devices / tracking ───────────────────────────────────
    gpsDeviceId: { type: String, default: '' },
    rfidDeviceId: { type: String, default: '' },
    hasCamera: { type: Boolean, default: false },

    // ── Mechanical ───────────────────────────────────────────
    fuelType: { type: String, enum: ['diesel', 'petrol', 'cng', 'electric', 'hybrid'], default: 'diesel' },
    mileage: { type: Number, default: 0 },                    // km per litre (avg)
    engineNumber: { type: String, default: '' },
    chassisNumber: { type: String, default: '' },
    manufacturer: { type: String, default: '' },
    modelYear: { type: Number, default: null },
    odometer: { type: Number, default: 0 },                   // current reading (km)

    // ── Financial ────────────────────────────────────────────
    purchaseDate: { type: Date, default: null },
    purchaseCost: { type: Number, default: 0 },

    // ── Compliance (denormalised for renewal dashboards) ─────
    insuranceExpiry: { type: Date, default: null },
    fitnessExpiry: { type: Date, default: null },
    permitExpiry: { type: Date, default: null },
    roadTaxExpiry: { type: Date, default: null },
    pollutionExpiry: { type: Date, default: null },
    documents: [VehicleDocSchema],
    photos: { type: [String], default: [] },

    status: { type: String, enum: ['active', 'inactive', 'maintenance', 'retired'], default: 'active' },
    isActive: { type: Boolean, default: true },               // soft delete
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

VehicleSchema.index({ school: 1, vehicleNumber: 1 }, { unique: true });
VehicleSchema.index({ school: 1, registrationNumber: 1 });
VehicleSchema.index({ school: 1, status: 1 });

module.exports = db.model('Vehicle', VehicleSchema);
