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

    updatedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

module.exports = db.model('SubstituteSettings', SubstituteSettingsSchema);
