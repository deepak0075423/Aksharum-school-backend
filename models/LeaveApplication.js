const db = require('../db/orm');

const LeaveApplicationSchema = new db.Schema({
    teacher: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    leaveType: {
        type: db.Types.UUID,
        ref: 'LeaveType',
        required: true,
    },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    totalDays: { type: Number, required: true },
    leaveMode: {
        type: String,
        enum: ['full_day', 'half_day'],
        default: 'full_day',
    },
    reason: { type: String, required: true, trim: true },
    document: { type: String, default: null }, // file path
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'modification_requested', 'cancelled'],
        default: 'pending',
    },
    adminComment: { type: String, default: '' },
    approvedBy: { type: db.Types.UUID, ref: 'User', default: null },

    // ── Approval trail ──────────────────────────────────────────────────────
    // Snapshot of LeavePolicy.approval.twoLevel taken when the application was
    // filed, so a later policy edit cannot change the terms of a request that
    // is already in flight. 1 keeps the historical single-approval behaviour.
    approvalsRequired: { type: Number, default: 1 },
    approvalLevel:     { type: Number, default: 0 },
    approvals: {
        type: [db.Types.JSON],
        default: [],   // [{ level, by, byName, at, comment }]
    },

    appliedAt: { type: Date, default: Date.now },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    modificationRequestedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
}, { timestamps: true });

LeaveApplicationSchema.index({ teacher: 1, school: 1, status: 1 });
LeaveApplicationSchema.index({ school: 1, status: 1, fromDate: -1 });
LeaveApplicationSchema.index({ teacher: 1, fromDate: 1, toDate: 1 });

// DB-level guard: prevents exact duplicate date-range applications while one is still active.
// partialFilterExpression limits the uniqueness constraint to active statuses only,
// so rejected/cancelled applications don't block re-application.
LeaveApplicationSchema.index(
    { teacher: 1, school: 1, fromDate: 1, toDate: 1 },
    {
        unique: true,
        partialFilterExpression: { status: { $in: ['pending', 'approved', 'modification_requested'] } },
        name: 'unique_active_leave_dates',
    }
);

module.exports = db.model('LeaveApplication', LeaveApplicationSchema);
