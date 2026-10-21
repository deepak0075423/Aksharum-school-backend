const db = require('../db/orm');

/**
 * One sitting of an online entrance exam.
 *
 * The clock is the server's: `deadlineAt` is fixed when the attempt starts
 * (the earlier of start + duration and the exam's end), every save after it is
 * refused, and an attempt still open past it is submitted by the sweep or by
 * the next read — whichever comes first (services/admission/exams.js).
 *
 * `saveSeq` is the client's save counter. A save carrying a lower number than
 * the stored one arrived late (a retry after a dropped connection) and is not
 * allowed to overwrite newer answers.
 *
 * One attempt in progress per exam per application — partial unique index in
 * db/migrate.js — so two tabs cannot open two sittings.
 */
const AdmissionAttemptSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    exam:         { type: db.Types.UUID, ref: 'AdmissionExam', required: true },
    application:  { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    applicant:    { type: db.Types.UUID, ref: 'User', default: null },
    candidate:    { type: db.Types.UUID, ref: 'AdmissionCandidate', default: null },
    attemptNo:    { type: Number, default: 1 },
    status:       { type: String, enum: ['in_progress', 'submitted', 'auto_submitted', 'void'], default: 'in_progress' },
    startedAt:    { type: Date, default: null },
    deadlineAt:   { type: Date, default: null },
    submittedAt:  { type: Date, default: null },
    lastSavedAt:  { type: Date, default: null },
    saveSeq:      { type: Number, default: 0 },
    questionOrder: { type: db.Types.JSON, default: () => [] },
    optionOrder:  { type: db.Types.JSON, default: () => ({}) },
    answers:      { type: db.Types.JSON, default: () => ({}) },
    autoScore:    { type: Number, default: null },
    manualMarks:  { type: db.Types.JSON, default: () => ({}) },
    manualPending: { type: Number, default: 0 },
    violations:   { type: db.Types.JSON, default: () => [] },
    // Timed sections (services/admission/examPlan.js): [{ key, name, minutes, questions, startedAt, deadlineAt, closedAt }].
    sections:     { type: db.Types.JSON, default: () => [] },
    currentSection: { type: Number, default: 0 },
    extraMinutes: { type: Number, default: 0 },
    clientInfo:   { type: db.Types.JSON, default: null },
}, { timestamps: true });

AdmissionAttemptSchema.index({ exam: 1, application: 1, attemptNo: 1 }, { unique: true });
AdmissionAttemptSchema.index({ school: 1, exam: 1, status: 1 });

module.exports = db.model('AdmissionAttempt', AdmissionAttemptSchema);
