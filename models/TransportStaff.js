const db = require('../db/orm');

// Generic uploaded document for a staff member (licence, medical, police
// verification…), spec §3, §4, §21.
const StaffDocSchema = new db.Schema({
    docType: {
        type: String,
        enum: ['license', 'medical', 'police_verification', 'aadhaar', 'photo', 'other'],
        required: true,
    },
    number: { type: String, default: '' },
    expiryDate: { type: Date, default: null },
    file: { type: String, default: '' },
}, { _id: true });

// Unified Driver + Bus-Attendant record (spec §3 and §4). Drivers carry the
// licence / driving-performance fields; attendants use the common subset.
// Optionally linked to a User account for a future driver mobile login.
const TransportStaffSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    campus: { type: String, default: '' },

    staffType: { type: String, enum: ['driver', 'attendant'], required: true },
    employeeId: { type: String, required: true, trim: true },   // auto DRV/ATT-YYMM-####
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '' },
    photo: { type: String, default: '' },
    gender: { type: String, enum: ['male', 'female', 'other', ''], default: '' },
    dateOfBirth: { type: Date, default: null },
    dateOfJoining: { type: Date, default: null },
    address: { type: String, default: '' },

    // ── Driver-specific (unused for attendants) ──────────────
    licenseNumber: { type: String, default: '' },
    licenseType: { type: String, default: '' },              // LMV, HMV, HTV…
    licenseExpiry: { type: Date, default: null },
    experienceYears: { type: Number, default: 0 },

    // ── Safety / verification ────────────────────────────────
    medicalCertExpiry: { type: Date, default: null },
    policeVerification: {
        status: { type: String, enum: ['pending', 'verified', 'rejected', ''], default: '' },
        date: { type: Date, default: null },
        file: { type: String, default: '' },
    },
    emergencyContact: {
        name: { type: String, default: '' },
        phone: { type: String, default: '' },
        relation: { type: String, default: '' },
    },
    documents: [StaffDocSchema],

    // ── Performance (spec §3) ────────────────────────────────
    performance: {
        drivingScore: { type: Number, default: 100 },        // 0-100
        speedViolations: { type: Number, default: 0 },
        lateArrivals: { type: Number, default: 0 },
        totalTrips: { type: Number, default: 0 },
        ratingSum: { type: Number, default: 0 },
        ratingCount: { type: Number, default: 0 },
    },

    // Link to a login account (for the driver mobile app — optional).
    user: { type: db.Types.UUID, ref: 'User', default: null },

    status: { type: String, enum: ['active', 'inactive', 'on_leave'], default: 'active' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

// Average parent rating (spec §3) — computed from the running sum/count.
TransportStaffSchema.virtual('avgRating').get(function () {
    return this.performance?.ratingCount ? +(this.performance.ratingSum / this.performance.ratingCount).toFixed(2) : 0;
});
TransportStaffSchema.set('toJSON', { virtuals: true });
TransportStaffSchema.set('toObject', { virtuals: true });

TransportStaffSchema.index({ school: 1, employeeId: 1 }, { unique: true });
TransportStaffSchema.index({ school: 1, staffType: 1, status: 1 });

module.exports = db.model('TransportStaff', TransportStaffSchema);
