const db = require('../db/orm');

// One policy row per school — the rules for *earning* comp off. Nothing in the
// engine is hard-coded: compOffService reads this document and falls back to
// these schema defaults for a school that never saved one, exactly like
// LibraryPolicy backs the library rules.
//
// Spending comp off as leave is not covered here. That is the COMPOFF leave
// type's LeavePolicy, the same model every other leave type uses, so
// consecutive-day caps, clubbing rules and approval routing are configured in
// one place for all types.
const CompOffPolicySchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
        unique: true,
    },

    // ── Who may earn comp off ───────────────────────────────────────────────
    // Empty list = everyone. Values come from School.designations — the same
    // dropdown source the teacher form uses, so no parallel list to maintain.
    eligibleDesignations: { type: [String], default: [] },
    eligibleRoles:        { type: [String], default: ['teacher', 'school_admin'] },

    // ── Working-hours thresholds ────────────────────────────────────────────
    minWorkingHours: { type: Number, default: 4 },   // below this → nothing is earned
    halfDayHours:    { type: Number, default: 4 },   // ≥ this, < fullDayHours → 0.5 day
    fullDayHours:    { type: Number, default: 8 },   // ≥ this → 1 day

    // ── Which kinds of day earn comp off ────────────────────────────────────
    eligibleDays: {
        holiday:   { type: Boolean, default: true },  // a Holiday row covering the date
        weeklyOff: { type: Boolean, default: true },  // non-working Saturday per School.leaveSettings
        sunday:    { type: Boolean, default: true },
    },
    // Ordinary working days normally earn nothing (that is just attendance)
    allowWorkingDays: { type: Boolean, default: false },

    // ── Application window & caps ───────────────────────────────────────────
    applyWithinDays:    { type: Number, default: 30 }, // days after the work date; 0 = no deadline
    maxPerMonth:        { type: Number, default: 0 },  // days earned per calendar month; 0 = no limit
    maxPerYear:         { type: Number, default: 0 },  // days earned per academic year; 0 = no limit

    // ── Validity / expiry ───────────────────────────────────────────────────
    validityDays: { type: Number, default: 90 },       // credited days lapse after N days; 0 = never

    // ── Claiming ────────────────────────────────────────────────────────────
    // Whether a part-day of work can earn half a comp off day. Spending comp
    // off as leave is governed by the COMPOFF type's LeavePolicy, like every
    // other leave type — this flag is only about earning.
    halfDayAllowed:              { type: Boolean, default: true },
    // Lets an employee raise the request before the work date has passed
    advanceCompOffAllowed:       { type: Boolean, default: false },

    // ── Approval workflow ───────────────────────────────────────────────────
    approval: {
        // 'admin'       → school admins only (matches the rest of the leave module)
        // 'designation' → holders of approverDesignations only
        // 'both'        → either of the two
        mode:                 { type: String, enum: ['admin', 'designation', 'both'], default: 'admin' },
        approverDesignations: { type: [String], default: [] },
        // Two sign-offs before anything is credited; the second approver must
        // be a different person from the first.
        twoLevel:             { type: Boolean, default: false },
    },

    // ── Automation (scenario 3) ─────────────────────────────────────────────
    // Build a ready-to-apply draft as soon as attendance lands on an eligible
    // day. Only takes effect when the attendance module is enabled.
    autoGenerateFromAttendance: { type: Boolean, default: true },

    expiryNotification: {
        enabled:    { type: Boolean, default: true },
        daysBefore: { type: Number,  default: 7 },
    },

    isActive:  { type: Boolean, default: true },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('CompOffPolicy', CompOffPolicySchema);
