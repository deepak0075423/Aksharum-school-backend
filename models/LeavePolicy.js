const db = require('../db/orm');

// One policy per leave type per school — the rules that govern *applying for*
// that leave. It is the single source of truth for every leave type, Comp Off
// included; CompOffPolicy only covers how comp off days are *earned*.
//
// LeaveType keeps the entitlement figures (annual allocation, accrual, carry
// forward, encashment) because those describe the balance. Everything about who
// may apply, when, for how long, and who signs it off lives here.
//
// A type with no saved policy behaves exactly as it did before this model
// existed: leavePolicyService seeds the defaults from the LeaveType's own
// legacy fields, so nothing changes until an admin edits the policy.
const LeavePolicySchema = new db.Schema({
    school:    { type: db.Types.UUID, ref: 'School',    required: true },
    leaveType: { type: db.Types.UUID, ref: 'LeaveType', required: true },

    // ── Who may apply ───────────────────────────────────────────────────────
    // Empty designation list = everyone. Values come from School.designations.
    eligibleDesignations: { type: [String], default: [] },
    eligibleRoles:        { type: [String], default: ['teacher', 'school_admin'] },
    // Restricts a type to one gender — what maternity / paternity leave needs.
    gender: { type: String, enum: ['any', 'Male', 'Female'], default: 'any' },
    // Probation gate, measured from TeacherProfile.joiningDate. 0 = no wait.
    minServiceDays: { type: Number, default: 0 },

    // ── Shape of an application ─────────────────────────────────────────────
    minDaysPerApplication: { type: Number, default: 0 },  // 0 = no minimum
    maxConsecutiveDays:    { type: Number, default: 0 },  // 0 = no limit
    // Must be applied for at least N days ahead (0 = same-day is fine)
    advanceNoticeDays:     { type: Number, default: 0 },
    // Past-dated applications: off by default, matching the original behaviour
    allowBackdated:        { type: Boolean, default: false },
    backdatedWithinDays:   { type: Number,  default: 0 },  // 0 = no limit once allowed

    maxApplicationsPerMonth: { type: Number, default: 0 }, // 0 = no cap
    maxApplicationsPerYear:  { type: Number, default: 0 },
    maxDaysPerMonth:         { type: Number, default: 0 },

    // ── Day counting ────────────────────────────────────────────────────────
    halfDayAllowed: { type: Boolean, default: true },
    // Sandwich rule: holidays and weekly offs falling *inside* the range are
    // charged as leave too. Off by default — the existing behaviour skips them.
    sandwichRule:   { type: Boolean, default: false },

    // ── Supporting document (migrated off LeaveType) ────────────────────────
    requiresDocument:          { type: Boolean, default: false },
    documentRequiredAfterDays: { type: Number,  default: 0 },  // 0 = always required

    // ── Balance ─────────────────────────────────────────────────────────────
    allowNegativeBalance: { type: Boolean, default: false },
    maxNegativeDays:      { type: Number,  default: 0 },

    // ── Entitlement mechanics (migrated off LeaveType) ──────────────────────
    // How the allocation reaches the balance and what happens to what is left.
    // LeaveType still carries the headline annualAllocation figure; these rules
    // decide how it is credited, rolled over and cashed out.
    monthlyAccrual: {
        enabled:      { type: Boolean, default: false },
        daysPerMonth: { type: Number,  default: 0 },
    },
    carryForward: {
        enabled: { type: Boolean, default: false },
        maxDays: { type: Number,  default: 0 },   // 0 = carry everything remaining
    },
    encashable:        { type: Boolean, default: false },
    maxEncashableDays: { type: Number,  default: 0 },   // 0 = no limit

    // ── Clubbing with other leave ───────────────────────────────────────────
    allowCombineWithOtherLeaves: { type: Boolean, default: true },
    // Specific types this one may never sit next to, even when combining is on
    blockedLeaveTypes: { type: [db.Types.UUID], default: [] },

    // ── Approval workflow ───────────────────────────────────────────────────
    approval: {
        // 'admin'       → school admins only (the historical behaviour)
        // 'designation' → holders of approverDesignations only
        // 'both'        → either
        mode:                 { type: String, enum: ['admin', 'designation', 'both'], default: 'admin' },
        approverDesignations: { type: [String], default: [] },
        // Two sign-offs, by two different people, before the leave is approved
        twoLevel:             { type: Boolean, default: false },
    },

    // Suspends new applications for this type without deleting it or its history
    isActive:  { type: Boolean, default: true },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

LeavePolicySchema.index({ school: 1, leaveType: 1 }, { unique: true });

module.exports = db.model('LeavePolicy', LeavePolicySchema);
