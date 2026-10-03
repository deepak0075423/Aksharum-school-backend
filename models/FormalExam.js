const db = require('../db/orm');

const auditEntrySchema = new db.Schema({
    action:  { type: String, required: true },
    by:      { type: db.Types.UUID, ref: 'User', required: true },
    at:      { type: Date, default: Date.now },
    notes:   { type: String, default: '' },
}, { _id: false });

const subjectConfigSchema = new db.Schema({
    subject:        { type: db.Types.UUID, ref: 'Subject', required: true },
    maxMarks:       { type: Number, required: true, min: 1 },
    passingMarks:   { type: Number, required: true, min: 0 },
    assignedTeachers:[{ type: db.Types.UUID, ref: 'User' }],
    examDate:       { type: Date,   default: null },
    startTime:      { type: String, default: '' },
    endTime:        { type: String, default: '' },
    order:          { type: Number, default: 0 },
    // A paper in parts (Oct 2026) — theory, practical, internal assessment —
    // each with its own maximum and pass mark: [{ key, label, maxMarks,
    // passingMarks }]. The paper's maxMarks is their sum; a student passes the
    // paper by passing every part that has a pass mark AND the paper's own.
    components:     { type: Object, default: null },
    // Graded, not marked: the teacher gives a grade on the school's scale. The
    // paper is left out of the totals, the percentage and the pass/fail.
    gradeOnly:      { type: Boolean, default: false },
}, { _id: false });

const FormalExamSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School',       required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    section:      { type: db.Types.UUID, ref: 'ClassSection', required: true },

    // Searched by substring from the admin board, hence the trigram index.
    title:    { type: String, required: true, trim: true, trgm: true },
    // What the exam BEHAVES as — a unit test, a mid-term or a final (only a
    // final can promote). The school's own type it was created as, and that
    // type's name, are typeKey / typeLabel (services/resultSettings): "Half
    // Yearly" is a MID_TERM-kind type. Older rows have neither and read as
    // their kind.
    examType: { type: String, enum: ['MID_TERM', 'FINAL', 'UNIT_TEST'], required: true },
    typeKey:   { type: String, default: '' },
    typeLabel: { type: String, default: '' },

    // The office's own reference for the exam ("MT2026"). One cycle is one exam
    // per section, so every section's row carries the same code — it names the
    // cycle, and is deliberately not unique.
    code:        { type: String, default: '', trim: true, trgm: true },
    description: { type: String, default: '' },

    subjects: { type: [subjectConfigSchema], default: [] },

    startDate:   { type: Date, required: true },
    endDate:     { type: Date, required: true },
    publishDate: { type: Date, default: null },

    // Options set on the Create Exam form. A row older than these columns reads
    // NULL, and each is read so that NULL means what the exam did before the
    // option existed (see OPTION_DEFAULTS in services/resultExams.js) — nothing
    // has to be backfilled.
    showInPortal:     { type: Boolean, default: true },   // students and parents see the published result
    includeInOverall: { type: Boolean, default: false },  // counts towards the year's overall result
    allowGraceMarks:  { type: Boolean, default: false },  // marks short of a pass are made up when results are worked out
    grace: {
        perSubject:  { type: Number, default: 0 },        // most that may be added in one subject
        maxSubjects: { type: Number, default: 0 },        // in at most this many subjects per student
    },
    notifyOnPublish:  { type: Boolean, default: true },   // tell students and parents when it is published
    showRank:         { type: Boolean, default: true },   // the scorecard shows the rank

    // Final exams only: the students who pass move up a class on the day the
    // results reach families (services/resultPromotion). `promoteSection` says
    // where they land — 'same': the section of the same name (6-A → 7-A);
    // 'none': the class alone, a section to be given later.
    promoteOnPass:  { type: Boolean, default: false },
    promoteSection: { type: String, enum: ['same', 'none'], default: 'same' },
    // And the students who do not pass (Oct 2026): 'stay' — left where they
    // are, for the school to place; 'repeat' — placed in the same class in the
    // next year, into the section of the same name or none, as promotion does.
    // A re-exam pass later moves a repeating student up after all.
    failedPlacement: { type: String, default: 'stay' },
    // How far the promotion has got:
    //   null        not asked for, or cancelled
    //   scheduled   published — runs at promotionDueAt (the result date)
    //   running     claimed by one worker; nobody else touches it
    //   waiting     ran, but some who passed had no class to go to yet —
    //               retried until the next year's class exists
    //   done        everyone who passed has been moved
    //   reverted    the results were withdrawn and the moves taken back
    promotionState: { type: String, default: null },
    promotionDueAt: { type: Date, default: null },
    promotedAt:     { type: Date, default: null },
    promotionStats: { type: Object, default: null },   // counts, the target, and who was not moved and why

    // Re-exams (Oct 2026): a paper a student did not pass, sat again after the
    // results are published (services/resultExams saveReExam). The marks are
    // the exam's own input, like the sheets, so withdrawing and republishing
    // the results keeps them:
    //   { rule: 'scored' | 'pass', date, note, marks: [{ student, subject,
    //     marksObtained, isAbsent, at, by }], updatedAt }
    // `rule` — a re-exam pass counts as scored, or as exactly the pass mark.
    reExam: { type: Object, default: null },

    // When each reminder about marks still owed was last sent
    // (services/resultReminders): { 'sheet:<subjectId>': at, validate: at }.
    reminders: { type: Object, default: null },

    // ── Oct 2026, the second audit ────────────────────────────────────────────
    // The school's term this exam belongs to (ResultSettings.terms key); '' —
    // no term, the year as one. Term report cards and term weights read it.
    term:         { type: String, default: '' },
    // The timetable has been shared with students and parents: until then the
    // exam is the office's plan, on no family's schedule and in no notice.
    // NULL — an exam from before the switch existed — reads as shared.
    timetableShared: { type: Boolean, default: null },
    // The day subject teachers' marks are due; reminders count to it and the
    // office is told of sheets still out after it. NULL — no deadline.
    marksDueDate: { type: Date, default: null },
    // Students whose result is held back from them and their parents (unpaid
    // fees, discipline): [{ student, reason, by, at }]. Input, like reExam —
    // it survives withdrawing and republishing.
    withheld: { type: Object, default: null },
    // A final exam's promotion decided by hand for a student, over what the
    // result says: [{ student, decision: 'promote' | 'detain', reason, by, at }].
    promotionOverrides: { type: Object, default: null },
    // The grading scale the results were graded on when published (the class's
    // scale then): { preset, label, bands }. A report card grades its totals on
    // its newest exam's scale, so a scale changed mid-year never mixes two.
    gradeBands: { type: Object, default: null },
    // When families were told the results are out. Set at publishing when they
    // see them at once; otherwise by the release sweep on the result date.
    releaseNotifiedAt: { type: Date, default: null },

    // DRAFT → MARKS_PENDING → SUBMITTED → CLASS_APPROVED → FINAL_APPROVED | REJECTED | REOPENED
    status: {
        type: String,
        enum: ['DRAFT', 'MARKS_PENDING', 'SUBMITTED', 'CLASS_APPROVED', 'FINAL_APPROVED', 'REJECTED', 'REOPENED'],
        default: 'DRAFT',
    },

    rejectionReason: { type: String, default: '' },

    classApprovedBy: { type: db.Types.UUID, ref: 'User', default: null },
    classApprovedAt: { type: Date, default: null },
    finalApprovedBy: { type: db.Types.UUID, ref: 'User', default: null },
    finalApprovedAt: { type: Date, default: null },

    resultsGenerated: { type: Boolean, default: false },

    // Archiving is not a status. It puts an exam away — out of the admin's
    // working tabs and out of every teacher's queue — and leaves `status`
    // exactly where it was, so restoring one returns it to the step it had
    // reached. Results that were already published stay visible to families.
    archivedAt: { type: Date, default: null },
    archivedBy: { type: db.Types.UUID, ref: 'User', default: null },

    createdBy: { type: db.Types.UUID, ref: 'User', required: true },
    auditLog:  { type: [auditEntrySchema], default: [] },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

FormalExamSchema.pre('save', async function () {
    this.updatedAt = new Date();
});

module.exports = db.model('FormalExam', FormalExamSchema);
