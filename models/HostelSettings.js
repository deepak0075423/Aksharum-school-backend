const db = require('../db/orm');

// Per-school hostel configuration (spec §28). One row per school.
//
// Every rule the module enforces is read from here — nothing about capacity,
// curfew, gender, approvals or fines is hard-coded in a controller. Defaults
// reproduce sensible behaviour so a school that never opens this screen still
// gets a working module.
const HostelSettingsSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, unique: true, index: true },

    // ── Capacity & allocation ───────────────────────────────────────────────
    maxHostelCapacity: { type: Number, default: 0 },           // 0 = per-hostel capacity only
    maxRoomCapacity: { type: Number, default: 6 },
    enforceGenderRestriction: { type: Boolean, default: true },
    allowOvercapacityAllocation: { type: Boolean, default: false },
    autoAllocateOnApproval: { type: Boolean, default: false },
    allowTransferBetweenHostels: { type: Boolean, default: true },
    transferRequiresApproval: { type: Boolean, default: true },
    // Whether a student may hold an outpass while on leave (spec §31).
    allowConcurrentLeaveAndOutpass: { type: Boolean, default: false },

    // ── Timings ─────────────────────────────────────────────────────────────
    entryTime: { type: String, default: '06:00' },
    exitTime: { type: String, default: '21:00' },
    curfewTime: { type: String, default: '22:00' },
    visitorFrom: { type: String, default: '09:00' },
    visitorTo: { type: String, default: '18:00' },
    visitorDays: { type: [String], default: ['Sat', 'Sun'] },   // empty = any day
    outpassFrom: { type: String, default: '08:00' },
    outpassTo: { type: String, default: '20:00' },
    maxOutpassHours: { type: Number, default: 8 },

    // ── Late return & fines ─────────────────────────────────────────────────
    lateReturnGraceMinutes: { type: Number, default: 15 },
    lateReturnFine: { type: Number, default: 0 },
    overdueAlertAfterMinutes: { type: Number, default: 30 },
    curfewViolationFine: { type: Number, default: 0 },

    // ── Leave & outpass rules ───────────────────────────────────────────────
    leaveRequiresParentApproval: { type: Boolean, default: true },
    outpassRequiresParentApproval: { type: Boolean, default: false },
    maxLeaveDaysPerRequest: { type: Number, default: 30 },
    minLeaveNoticeDays: { type: Number, default: 0 },
    maxOpenLeavesPerStudent: { type: Number, default: 1 },

    // ── Attendance ──────────────────────────────────────────────────────────
    attendanceSessions: { type: [String], default: ['morning', 'night'] },
    attendanceCorrectionNeedsApproval: { type: Boolean, default: true },
    attendanceCorrectionWindowDays: { type: Number, default: 7 },

    // ── Fees ────────────────────────────────────────────────────────────────
    autoGenerateMonthlyFees: { type: Boolean, default: false },
    feeDueDayOfMonth: { type: Number, default: 10 },
    lateFeePerDay: { type: Number, default: 0 },
    lateFeeGraceDays: { type: Number, default: 5 },
    // Post hostel charges to the shared FeeLedger so they appear in the student's
    // overall fee position. Off keeps hostel billing self-contained.
    postToFeeLedger: { type: Boolean, default: true },
    securityDepositAmount: { type: Number, default: 0 },

    // ── Admission ───────────────────────────────────────────────────────────
    admissionRequiresApproval: { type: Boolean, default: true },
    allowStudentSelfApplication: { type: Boolean, default: true },
    allowParentApplication: { type: Boolean, default: true },
    requiredAdmissionDocuments: {
        type: [String],
        default: ['id_proof', 'medical', 'parent_authorization', 'undertaking'],
    },

    // ── Complaints & maintenance ────────────────────────────────────────────
    complaintSlaHours: { type: Number, default: 48 },
    complaintAutoEscalate: { type: Boolean, default: true },
    complaintEscalateTo: { type: db.Types.UUID, ref: 'User', default: null },

    // ── Mess ────────────────────────────────────────────────────────────────
    messAttendanceRequired: { type: Boolean, default: false },
    messLeaveNoticeHours: { type: Number, default: 12 },

    // ── Notifications (reuses notifyService — these are only toggles) ───────
    notifyParentOnLeave: { type: Boolean, default: true },
    notifyParentOnOutpass: { type: Boolean, default: true },
    notifyParentOnLateReturn: { type: Boolean, default: true },
    notifyParentOnIncident: { type: Boolean, default: true },
    notifyParentOnDiscipline: { type: Boolean, default: true },
    notifyOnFeeDue: { type: Boolean, default: true },
    notifyOnVisitor: { type: Boolean, default: true },
    emailNotifications: { type: Boolean, default: true },

    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('HostelSettings', HostelSettingsSchema);
