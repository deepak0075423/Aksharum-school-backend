const db = require('../db/orm');

const LeaveBalanceSchema = new db.Schema({
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
    academicYear: { type: String, required: true }, // e.g. "2025-26"
    totalAllocated: { type: Number, default: 0 },
    carriedForward: { type: Number, default: 0 },
    used: { type: Number, default: 0 },
    pending:        { type: Number, default: 0 },  // awaiting approval
    // Days credited but never spent before their validity window closed.
    // Only comp off sets this today (see CompOffPolicy.validityDays); it stays
    // 0 for every other leave type, so the `remaining` formula is unchanged
    // for them.
    expired:        { type: Number, default: 0 },
    // Days carry-forward moved OUT of this year into the next. Without it the
    // carried days still read as this year's remainder: a second carry run
    // moved them again, and closing the year then lapsed them as well — the
    // employee was told they had lost days they had in fact kept.
    carriedOut:     { type: Number, default: 0 },
    lastAccrualAt:  { type: Date,   default: null }, // last monthly accrual timestamp
}, { timestamps: true });

LeaveBalanceSchema.index(
    { teacher: 1, school: 1, leaveType: 1, academicYear: 1 },
    { unique: true }
);
LeaveBalanceSchema.index({ school: 1, academicYear: 1 });

// Virtual: remaining days available (same formula as utils/leaveDays.remainingOf)
LeaveBalanceSchema.virtual('remaining').get(function () {
    return Math.max(0, (this.totalAllocated || 0) + (this.carriedForward || 0)
        - (this.used || 0) - (this.pending || 0) - (this.expired || 0) - (this.carriedOut || 0));
});

module.exports = db.model('LeaveBalance', LeaveBalanceSchema);
