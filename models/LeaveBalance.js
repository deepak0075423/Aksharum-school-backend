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
    lastAccrualAt:  { type: Date,   default: null }, // last monthly accrual timestamp
}, { timestamps: true });

LeaveBalanceSchema.index(
    { teacher: 1, school: 1, leaveType: 1, academicYear: 1 },
    { unique: true }
);
LeaveBalanceSchema.index({ school: 1, academicYear: 1 });

// Virtual: remaining days available
LeaveBalanceSchema.virtual('remaining').get(function () {
    return Math.max(0, this.totalAllocated + this.carriedForward
        - this.used - this.pending - (this.expired || 0));
});

module.exports = db.model('LeaveBalance', LeaveBalanceSchema);
