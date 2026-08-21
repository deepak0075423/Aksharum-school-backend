const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  One substituted period: "on 2026-08-21, period 3 of 8-A Maths, normally
//  taught by R. Sharma, is covered by K. Iyer".
//
//  A row is created per AFFECTED PERIOD, not per absent teacher, because the
//  cover decision is per period — a teacher free at P2 may be teaching at P4,
//  so one absence routinely fans out to several different substitutes.
//
//  The row records the assignment, never the absence: an absence with no
//  timetable periods that day produces no rows at all.
// ─────────────────────────────────────────────────────────────────────────────
const SubstituteAssignmentSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        required: true,
    },
    // The calendar day being covered, normalised to UTC midnight so a day is
    // one exact value and the (entry, date) uniqueness below actually bites.
    date: {
        type: Date,
        required: true,
    },
    // Denormalised from `date` so period lookups never re-derive it.
    dayOfWeek: {
        type: String,
        enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        required: true,
    },

    // ── What is being covered ───────────────────────────────────────────────
    // The published TimetableEntry this covers. Kept as a reference AND with
    // section/subject/period copied alongside, because a timetable republish
    // can delete the entry while the historical assignment must stay readable
    // for the workload counts.
    timetableEntry: {
        type: db.Types.UUID,
        ref: 'TimetableEntry',
        default: null,
    },
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        required: true,
    },
    subject: {
        type: db.Types.UUID,
        ref: 'Subject',
        default: null,
    },
    periodNumber: {
        type: Number,
        required: true,
        min: 1,
    },
    // 'HH:mm' copied from the timetable's periodsStructure at creation time, so
    // the notification can say "Period 3 (11:20–12:00)" without re-reading a
    // structure that may since have been edited.
    startTime: { type: String, default: '' },
    endTime:   { type: String, default: '' },

    // ── Who ─────────────────────────────────────────────────────────────────
    // The absent subject teacher whose period this is.
    originalTeacher: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    substituteTeacher: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,     // null only while status is 'uncovered'
    },

    // ── Why ─────────────────────────────────────────────────────────────────
    // 'absent'  — teacher attendance says Absent, or the day is well under way
    //             and they never marked attendance at all
    // 'leave'   — an approved LeaveApplication covers this date (or attendance
    //             recorded the day as Leave)
    // 'manual'  — an admin substituted a period with no recorded absence
    reason: {
        type: String,
        enum: ['absent', 'leave', 'manual'],
        default: 'manual',
    },
    // The LeaveApplication / TeacherAttendance row that triggered this, for the
    // audit trail. Untyped on purpose — `reason` says which table it points at.
    sourceRef: {
        type: db.Types.UUID,
        default: null,
    },
    // Set when the absence is only partial (half-day attendance or a half-day
    // leave) and the system cannot tell which half. The period is surfaced for
    // the admin to decide; auto-assign deliberately skips it.
    needsReview: {
        type: Boolean,
        default: false,
    },

    // ── State ───────────────────────────────────────────────────────────────
    // uncovered — the period needs a substitute, none is on the hook yet
    // assigned  — a substitute is on the hook (auto-assigned or admin-assigned)
    // cancelled — withdrawn; kept as a row so the notification trail survives
    status: {
        type: String,
        enum: ['uncovered', 'assigned', 'cancelled'],
        default: 'uncovered',
    },
    // How the CURRENT substitute got there. An auto row an admin later changed
    // becomes 'manual', which is what makes overrides countable.
    assignedVia: {
        type: String,
        enum: ['auto', 'manual', 'none'],
        default: 'none',
    },
    assignedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,     // null when the scheduler assigned it
    },
    assignedAt: { type: Date, default: null },

    // Free-text instructions the admin adds for the substitute; carried into
    // the notification body.
    remarks: {
        type: String,
        default: '',
        trim: true,
    },

    // ── Notification trail ──────────────────────────────────────────────────
    // Stamped once the current substitute has been told. Cleared on reassignment
    // so the new teacher is notified and the old one never is again.
    notifiedAt: { type: Date, default: null },
    // [{ at, event: 'assigned'|'changed'|'cancelled', to, toName, by, byName }]
    history: {
        type: [db.Types.JSON],
        default: [],
    },

    cancelledBy: { type: db.Types.UUID, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
}, { timestamps: true });

// The board, the workload counts and the sweep all read by school + day.
SubstituteAssignmentSchema.index({ school: 1, date: 1, status: 1 });
// Workload roll-ups: "how many substitutions has this teacher taken this month".
SubstituteAssignmentSchema.index({ substituteTeacher: 1, date: 1, status: 1 });
SubstituteAssignmentSchema.index({ originalTeacher: 1, date: 1 });

// One live row per timetable period per day PER ABSENT TEACHER. Without this a
// second sweep pass (or two admins acting at once) would double-cover the same
// period. originalTeacher is in the key because a merged-subject period has two
// teachers in one slot — if both are away, each needs their own cover.
// The predicate is over `status` only: a Date cannot appear in an index
// predicate (text→timestamptz is only STABLE, not IMMUTABLE), so `date` stays
// in the key. See db/model.js partialPredicate().
SubstituteAssignmentSchema.index(
    { timetableEntry: 1, date: 1, originalTeacher: 1 },
    {
        unique: true,
        partialFilterExpression: { status: { $in: ['uncovered', 'assigned'] } },
        name: 'unique_live_substitution_per_period',
    }
);

module.exports = db.model('SubstituteAssignment', SubstituteAssignmentSchema);
