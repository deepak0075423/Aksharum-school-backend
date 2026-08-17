const db = require('../db/orm');

// A claim for compensatory time off against ONE worked date.
//
// This is the earning side only — spending comp off is an ordinary
// LeaveApplication against the COMPOFF leave type, so the whole existing
// apply/approve/cancel flow is reused unchanged.
//
// Lifecycle:
//   draft     → auto-built from approved attendance (scenario 3); the employee
//               reviews the pre-filled figures and clicks Apply. Never credits.
//   pending   → submitted, awaiting approval (level 1, then 2 when twoLevel)
//   approved  → the ONLY state in which balance is credited (LeaveLedger EARNED)
//   rejected / cancelled → nothing credited, or an existing credit reversed
//   expired   → credited days lapsed unused per policy.validityDays
const CompOffRequestSchema = new db.Schema({
    teacher: { type: db.Types.UUID, ref: 'User',      required: true },
    school:  { type: db.Types.UUID, ref: 'School',    required: true },
    // Always the school's active COMPOFF leave type — comp off shares the leave
    // balance/ledger tables rather than owning a parallel one.
    leaveType: { type: db.Types.UUID, ref: 'LeaveType', required: true },

    workDate: { type: Date, required: true },

    // 'manual'     → scenarios 1 & 2, the employee filled the form
    // 'attendance' → scenario 3, generated from an approved attendance record
    source: { type: String, enum: ['manual', 'attendance'], default: 'manual' },

    attendance: { type: db.Types.UUID, ref: 'TeacherAttendance', default: null },
    holiday:    { type: db.Types.UUID, ref: 'Holiday',           default: null },

    // What kind of day the work date turned out to be. 'unknown' is what a
    // school running without the holiday module gets — scenario 1, where the
    // day cannot be classified and the admin judges the claim manually.
    dayCategory: {
        type: String,
        enum: ['holiday', 'weekly_off', 'sunday', 'working_day', 'unknown'],
        default: 'unknown',
    },
    dayLabel: { type: String, default: '' },   // "Diwali", "Sunday", "Weekly Off", …

    checkIn:      { type: String, default: '' },   // 'HH:mm', mirrored from attendance
    checkOut:     { type: String, default: '' },
    workedHours:  { type: Number, default: 0 },
    compOffDays:  { type: Number, required: true, default: 0 },   // 0.5 | 1 (or more via policy)
    compOffMode:  { type: String, enum: ['full_day', 'half_day'], default: 'full_day' },

    reason:   { type: String, default: '', trim: true },
    document: { type: String, default: null },   // optional proof, same uploads/leave-docs bucket

    status: {
        type: String,
        enum: ['draft', 'pending', 'approved', 'rejected', 'cancelled', 'expired'],
        default: 'pending',
    },

    // ── Approval trail ──────────────────────────────────────────────────────
    approvalsRequired: { type: Number, default: 1 },   // snapshot of policy.approval.twoLevel
    approvalLevel:     { type: Number, default: 0 },   // sign-offs collected so far
    approvals: {
        type: [db.Types.JSON],
        default: [],   // [{ level, by, byName, at, comment }]
    },
    adminComment: { type: String, default: '' },
    approvedBy:   { type: db.Types.UUID, ref: 'User', default: null },

    appliedAt:   { type: Date, default: null },
    approvedAt:  { type: Date, default: null },
    rejectedAt:  { type: Date, default: null },
    cancelledAt: { type: Date, default: null },

    // ── Credit ──────────────────────────────────────────────────────────────
    academicYear:  { type: String, default: '' },
    creditedDays:  { type: Number, default: 0 },     // stays 0 until approval
    creditedAt:    { type: Date,   default: null },
    ledgerEntry:   { type: db.Types.UUID, ref: 'LeaveLedger', default: null },
    expiresAt:     { type: Date, default: null },
    expiredAt:     { type: Date, default: null },
    expiryNotifiedAt: { type: Date, default: null },

    // The rules actually applied, frozen at submission time. A later policy
    // edit must not rewrite the terms of a request already in flight — same
    // reasoning as the feedback campaign question snapshots.
    policySnapshot: { type: db.Types.JSON, default: null },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

CompOffRequestSchema.index({ teacher: 1, school: 1, workDate: 1 });

// Hard duplicate guard: one live claim per employee per work date. The partial
// predicate is what makes this safe — a rejected or cancelled claim leaves the
// date free to be claimed again, so the constraint never traps anyone.
// compOffService.findDuplicate() still checks first, to return a readable
// message instead of a constraint violation; this is the backstop for races.
CompOffRequestSchema.index(
    { teacher: 1, school: 1, workDate: 1 },
    {
        unique: true,
        partialFilterExpression: { status: { $in: ['draft', 'pending', 'approved'] } },
        name: 'unique_active_compoff_workdate',
    },
);
CompOffRequestSchema.index({ school: 1, status: 1, workDate: -1 });
CompOffRequestSchema.index({ teacher: 1, status: 1 });
// Expiry sweep: approved credits still holding unused days
CompOffRequestSchema.index({ school: 1, status: 1, expiresAt: 1 });
// Attendance-driven generation reuses this to stay idempotent
CompOffRequestSchema.index({ attendance: 1 });

module.exports = db.model('CompOffRequest', CompOffRequestSchema);
