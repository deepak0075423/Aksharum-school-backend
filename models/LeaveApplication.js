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

    // The year this application's days are drawn from, fixed when it is filed.
    // Without it every balance move resolved "whichever year is active right
    // now", so an application that outlived a year rollover released its held
    // days into a row that did not exist — stranding them on the old year
    // forever. Legacy rows have none; the handlers fall back to the active year
    // for those, which is the old behaviour.
    academicYear: { type: String, default: null },

    // Days within totalDays that carry no pay — either because the leave type
    // is unpaid, or because the application ran past the available balance
    // under a policy that permits it. Payroll reads this instead of an admin
    // retyping the figure into the payroll run every month.
    lopDays: { type: Number, default: 0 },
    leaveMode: {
        type: String,
        enum: ['full_day', 'half_day'],
        default: 'full_day',
    },
    // Which half. In a school running a period timetable this is the difference
    // between covering the morning periods and the afternoon ones, so the
    // substitute engine cannot arrange cover without it. Ignored for full days.
    halfDaySession: {
        type: String,
        enum: ['first', 'second'],
        default: 'first',
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
