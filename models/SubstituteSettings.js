const db = require('../db/orm');

// Per-school knobs for substitution. One row per school, created lazily on
// first read (see substituteService.getSettings) so a school that never opens
// the settings tab still gets sane behaviour.
const SubstituteSettingsSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
        unique: true,
    },

    // ── Automation ──────────────────────────────────────────────────────────
    // Master switch. Off = the board still detects absences and ranks
    // candidates, but nothing is committed until an admin clicks.
    autoAssign: {
        type: Boolean,
        default: true,
    },
    // Read absences from teacher attendance. Only consulted when the school's
    // attendance module is on — the flag AND-s with it.
    useAttendance: {
        type: Boolean,
        default: true,
    },
    // Read absences from approved leave applications. AND-s with the leave module.
    useLeave: {
        type: Boolean,
        default: true,
    },
    // A teacher who has simply not marked attendance is not yet absent — they
    // may be running late. After this clock time an unmarked teacher is treated
    // as absent so their periods get covered. 'HH:mm', school local time.
    unmarkedAbsentAfter: {
        type: String,
        default: '09:30',
    },
    // Don't auto-assign a period that has already started; a cover teacher
    // notified mid-period cannot act on it. Admins can still assign by hand.
    skipPeriodsAlreadyStarted: {
        type: Boolean,
        default: true,
    },
    // Where the morning ends, for an absence recorded as "half day" without
    // saying which half. Periods starting at or after this clock time are the
    // ones treated as the absent half. 'HH:mm', school local time.
    halfDayAbsentAfter: {
        type: String,
        default: '12:00',
    },
    // Leave applications that are not approved yet. Off by default: a pending
    // application is not yet an absence, and covering it commits the school to
    // a leave nobody has granted.
    useUnapprovedLeave: {
        type: Boolean,
        default: false,
    },
    // On duty / official work — the teacher is at the school's request but not
    // in the classroom, so the period still needs covering.
    useOnDuty: {
        type: Boolean,
        default: true,
    },

    // ── Eligibility ─────────────────────────────────────────────────────────
    // Honour TeacherAvailability.unavailable — the same blocked slots the
    // timetable generator respects.
    respectAvailabilityBlocks: {
        type: Boolean,
        default: true,
    },
    // Honour TeacherAvailability.maxPeriodsPerDay when counting the day's load.
    respectDailyPeriodCap: {
        type: Boolean,
        default: true,
    },
    // Hard ceiling on substitutions one teacher may be given in a single day,
    // on top of whatever their normal load is. 0 = no ceiling.
    maxSubstitutionsPerDay: {
        type: Number,
        default: 2,
        min: 0,
    },
    // Only offer teachers who actually teach the subject somewhere. Off by
    // default: covering a period is usually about supervision, and a strict
    // filter leaves periods uncovered in small schools. When off, a subject
    // match is still rewarded in the ranking (bonusSubjectMatch below).
    requireSubjectMatch: {
        type: Boolean,
        default: false,
    },
    // Offer teachers from outside the absent teacher's department. On by
    // default: most schools would rather a covered period than a departmental
    // match, and the ranking already prefers someone who teaches the subject.
    allowCrossDepartment: {
        type: Boolean,
        default: true,
    },
    // Never offer a teacher who is themselves away that day. Candidates who are
    // absent are already filtered out; this also drops anyone with an approved
    // leave covering the date whose absence the school does not detect from
    // attendance.
    excludeTeachersOnLeave: {
        type: Boolean,
        default: true,
    },

    // ── Fairness ranking ────────────────────────────────────────────────────
    // Weights fed into the candidate score. Higher weight = that count pushes a
    // teacher further down the list. See substituteService.scoreCandidate.
    weightSubsToday:   { type: Number, default: 100 },
    weightSubsWeek:    { type: Number, default: 20 },
    weightSubsMonth:   { type: Number, default: 5 },
    weightNormalToday: { type: Number, default: 8 },
    // Bonuses are subtracted from the score, lifting the candidate up the list.
    bonusSubjectMatch: { type: Number, default: 30 },
    bonusSameSection:  { type: Number, default: 10 },

    // ── Notifications ───────────────────────────────────────────────────────
    notifySubstitute: {
        type: Boolean,
        default: true,
    },
    // Also tell the teacher whose class is being covered.
    notifyOriginalTeacher: {
        type: Boolean,
        default: true,
    },
    // Tell a substitute when their assignment is changed away or cancelled.
    notifyOnChange: {
        type: Boolean,
        default: true,
    },
    // Route notifications through the school's SMTP as well as in-app.
    emailSubstitute: {
        type: Boolean,
        default: false,
    },

    // ── Reports & records ───────────────────────────────────────────────────
    // How far back the history and recent-activity lists reach, in academic
    // years. Older rows are never deleted here — they simply stop being read,
    // so a school that shortens this can lengthen it again and get them back.
    historyYears: {
        type: Number,
        default: 1,
        min: 1,
        max: 10,
    },
    // Count substituted periods towards a teacher's load in the workload
    // reports. Off = the reports show the timetable only.
    includeSubsInWorkload: {
        type: Boolean,
        default: true,
    },
    // Show the cover on the substitute's own timetable screen.
    showInTeacherTimetable: {
        type: Boolean,
        default: true,
    },
    // Offer the CSV/Excel export of the day board and the reports.
    allowExport: {
        type: Boolean,
        default: true,
    },

    updatedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

module.exports = db.model('SubstituteSettings', SubstituteSettingsSchema);
