const db = require('../db/orm');

// A hostel resident's leave (spec §12).
//
// The existing Leave module (LeaveApplication / LeaveType / LeaveBalance) models
// *employee* leave with accrual and balances against a teacher's User row; a
// student going home for the weekend has none of that. This table reuses that
// module's shape — statuses, an approval trail, cancellation — for students,
// and pairs with HostelOutpass for same-day movement.
const HostelLeaveSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    allocation: { type: db.Types.UUID, ref: 'HostelAllocation', default: null },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },

    leaveNumber: { type: String, default: '' },                // HL-YYMM-####
    leaveType: {
        type: String,
        enum: ['short', 'weekend', 'holiday', 'medical', 'emergency', 'home', 'other'],
        default: 'home',
    },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    totalDays: { type: Number, default: 1 },
    reason: { type: String, required: true, trim: true },
    destination: { type: String, default: '' },

    guardianName: { type: String, default: '' },
    guardianPhone: { type: String, default: '' },
    emergencyContact: { type: String, default: '' },
    attachments: { type: [String], default: [] },

    status: {
        type: String,
        enum: ['pending', 'parent_approved', 'approved', 'rejected', 'cancelled', 'active', 'returned', 'overdue'],
        default: 'pending',
    },
    // Two-stage consent (spec §12). Whether the parent stage is required at all
    // is a setting, snapshotted here so a later settings edit cannot change the
    // terms of a request already in flight.
    parentApprovalRequired: { type: Boolean, default: true },
    parentApprovedBy: { type: db.Types.UUID, ref: 'User', default: null },
    parentApprovedAt: { type: Date, default: null },
    wardenApprovedBy: { type: db.Types.UUID, ref: 'User', default: null },
    wardenApprovedAt: { type: Date, default: null },
    rejectedBy: { type: db.Types.UUID, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '' },
    cancelledAt: { type: Date, default: null },

    departedAt: { type: Date, default: null },
    returnedAt: { type: Date, default: null },
    returnConfirmedBy: { type: db.Types.UUID, ref: 'User', default: null },
    isOverdue: { type: Boolean, default: false },
    overdueNotifiedAt: { type: Date, default: null },

    appliedBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelLeaveSchema.index({ school: 1, status: 1, fromDate: -1 });
HostelLeaveSchema.index({ school: 1, student: 1, fromDate: -1 });
HostelLeaveSchema.index({ school: 1, hostel: 1, status: 1 });

module.exports = db.model('HostelLeave', HostelLeaveSchema);
