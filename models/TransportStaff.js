const db = require('../db/orm');

// Generic uploaded document for a staff member (licence, medical, police
// verification…), spec §3, §4, §21.
const StaffDocSchema = new db.Schema({
    docType: {
        type: String,
        enum: ['license', 'medical', 'police_verification', 'aadhaar', 'address_proof', 'photo', 'other'],
        required: true,
    },
    number: { type: String, default: '' },
    expiryDate: { type: Date, default: null },
    file: { type: String, default: '' },
}, { _id: true });

// A transport ROLE held by a member of staff (spec §3 and §4).
//
// Sep 2026: this stopped being a second place to type a person's name. Drivers,
// conductors and helpers are created as employees first (a User with role
// 'teacher' plus a TeacherProfile, exactly like any non-teaching staff member),
// and this record only says "that employee drives for us", plus the things that
// are true of the transport role and nowhere else: the licence, the medical, the
// police check, driving performance, transport leave and their last known
// position.
//
// `user` is therefore the identity. When it is set, name / phone / photo /
// employeeId / address / emergency contact are READ FROM the employee record —
// the columns below are kept only as a fallback for the standalone rows created
// before this change, which still work.
const TransportStaffSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    campus: { type: String, default: '' },

    // 'attendant' is the original word for a bus helper and is kept so older
    // records keep working; the screens speak the mockups' vocabulary
    // (driver / conductor / helper) and treat 'attendant' as a helper.
    staffType: { type: String, enum: ['driver', 'attendant', 'conductor', 'helper'], required: true },
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

    // ── Leave (spec §3; the Drivers & Crew screen's "On Leave" tile) ──
    // Each row is one absence. `status` on the staff record is kept in step by
    // the controller so the list can filter on one column.
    leaves: [new db.Schema({
        fromDate: { type: Date, required: true },
        toDate: { type: Date, required: true },
        leaveType: { type: String, enum: ['casual', 'sick', 'earned', 'unpaid', 'other'], default: 'casual' },
        reason: { type: String, default: '' },
        status: { type: String, enum: ['approved', 'pending', 'rejected', 'cancelled'], default: 'approved' },
        approvedBy: { type: db.Types.UUID, ref: 'User', default: null },
        createdAt: { type: Date, default: Date.now },
    }, { _id: true })],

    // ── Identity ────────────────────────────────────────────────────────────
    // The employee holding this transport role. Set for every record created
    // since Sep 2026; null on legacy standalone rows.
    user: { type: db.Types.UUID, ref: 'User', default: null },

    // The bus this person crews, when the school names one against the PERSON
    // rather than through a route. It lives here and not on Vehicle: a vehicle
    // has no crew column, and its crew normally comes from the route it runs —
    // this is the exception, not the rule.
    assignedVehicle: { type: db.Types.UUID, ref: 'Vehicle', default: null },

    // ── Last known position (spec §9, extended to people) ───────────────────
    // A snapshot of the newest TransportStaffLocation, so a roster or the live
    // map can show where someone is without joining the ping table.
    lastLocation: {
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
        accuracy: { type: Number, default: null },     // metres
        speed: { type: Number, default: 0 },           // km/h
        source: { type: String, enum: ['device', 'vehicle', 'manual', ''], default: '' },
        at: { type: Date, default: null },
    },
    // Location is only collected while this is on. A person can be on a route
    // and still not be shared — the school turns it on per crew member.
    locationSharing: { type: Boolean, default: false },

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
