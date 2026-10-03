const db = require('../db/orm');

/**
 * A school's own Results settings (Oct 2026). One row per school, created on
 * first read (services/resultSettings). Every field reads NULL as "as the
 * module always behaved", so a school that never opens the settings page keeps
 * the standard A+–F scale, the three built-in exam types and the defaults below.
 */
const ResultSettingsSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, unique: true },

    // ── Grading ───────────────────────────────────────────────────────────────
    // 'standard' (A+ to F), 'cbse9' (A1 to E2), 'five' (A to E) or 'custom'.
    gradePreset: { type: String, default: 'standard' },
    // The custom scale, highest first: [{ grade, min, point, pass }]. Only read
    // when gradePreset is 'custom'.
    gradeBands: { type: Object, default: null },

    // ── Exam types ────────────────────────────────────────────────────────────
    // [{ key, label, kind, active }] — the built-in three (kind = key) with
    // the labels the school gave them, and any it added. `kind` is what the
    // type behaves as: a FINAL-kind type can promote.
    examTypes: { type: Object, default: null },

    // ── Report cards ──────────────────────────────────────────────────────────
    // The areas graded outside the subjects: [{ key, label }].
    coScholastic: { type: Object, default: null },
    // The grades a co-scholastic area may be given, best first.
    coScholasticGrades: { type: Object, default: null },
    reportShowAttendance: { type: Boolean, default: true },
    reportShowRank: { type: Boolean, default: true },
    reportShowGradePoints: { type: Boolean, default: null },   // null → when the scale has points
    reportFooter: { type: String, default: '' },
    principalTitle: { type: String, default: 'Principal' },

    // ── Reminders ─────────────────────────────────────────────────────────────
    remindersEnabled: { type: Boolean, default: true },
    reminderAfterDays: { type: Number, default: 2 },    // after the exam's last day
    reminderRepeatDays: { type: Number, default: 2 },   // and again every so many days

    // ── Oct 2026, the second audit ────────────────────────────────────────────
    // Classes graded on a scale of their own: [{ from, to, preset, bands }] —
    // class numbers `from`..`to` use `preset` (or `bands` when 'custom').
    classScales: { type: Object, default: null },
    // The school's terms: [{ key, label, weight }]. Exams name their term;
    // a report card can be a term's, and the year can weigh its terms.
    terms: { type: Object, default: null },
    // How the year's overall result is worked out:
    //   { method: 'marks' | 'weighted',
    //     parts: [{ source: <exam type key> | 'CLASS_TEST', weight, best }],
    //     passRule: 'every' | 'aggregate', passPercent }
    // 'marks' adds the counted exams' marks up (the original rule); 'weighted'
    // gives each kind of assessment a share (best N of the unit tests…).
    overallRule: { type: Object, default: null },
    // Classes up to this number promote every student whatever the result
    // (a no-detention policy). NULL — none.
    noDetentionUpTo: { type: Number, default: null },
    // A re-exam is open to a student who failed at most this many papers
    // (compartment). NULL / 0 — any number.
    reExamMaxSubjects: { type: Number, default: null },
    // Families may ask for a paper to be checked again for this many days
    // after its results reach them. 0 — not offered.
    recheckDays: { type: Number, default: 0 },
    // "Distinction" on the analytics page: a result at or above this percentage.
    distinctionPercent: { type: Number, default: null },
    // Remarks the class teacher can pick instead of typing: [{ text }]
    // ({name}, {first} and {class} are filled in).
    remarkBank: { type: Object, default: null },
    // Printed on report cards: the head of school's signature and the seal.
    principalSignature: { type: String, default: '' },
    schoolSeal: { type: String, default: '' },
    reportShowClassFigures: { type: Boolean, default: false },
    reportShowSubjectRemarks: { type: Boolean, default: true },
    // Marks are due this many days after an exam ends unless the exam says
    // otherwise. NULL — no deadline.
    marksDueDays: { type: Number, default: null },
    // The office is reminded of results waiting to be published or reopened.
    officeReminders: { type: Boolean, default: true },

    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

ResultSettingsSchema.pre('save', async function () {
    this.updatedAt = new Date();
});

module.exports = db.model('ResultSettings', ResultSettingsSchema);
