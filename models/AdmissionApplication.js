const db = require('../db/orm');

/**
 * One application: one child, one class, one round, made by one applicant
 * (a `guest` User) — and the spine every other admission table hangs off.
 *
 * What the family wrote is `data`, keyed by the form's field keys and checked
 * against `formVersion` — the exact published version it was answered on, kept
 * for the life of the application. A few answers are copied into columns
 * (studentName, studentDob, guardian contact …) only so the office can search,
 * sort and spot duplicates in SQL; `data` stays the record.
 *
 * `status` moves only through services/admission/workflow.js, which knows the
 * allowed transitions and their guards; every move is an AdmissionEvent. The
 * other tables — documents, exams, results, list entries, offers, payments —
 * each hold their own part rather than this row growing without end. The few
 * summaries kept here (fee states, document state, offer state, the latest list
 * decision) exist so the application list can filter without five joins, and
 * are rewritten by the service that owns each part.
 */
const AdmissionApplicationSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    round:        { type: db.Types.UUID, ref: 'AdmissionRound', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    class:        { type: db.Types.UUID, ref: 'Class', required: true },
    applicant:    { type: db.Types.UUID, ref: 'User', required: true },
    form:         { type: db.Types.UUID, ref: 'AdmissionForm', default: null },
    formVersion:  { type: db.Types.UUID, ref: 'AdmissionFormVersion', default: null },
    formVersionNo: { type: Number, default: null },

    // Given on first submission (settings.numbering.applicationFormat); '' for a draft.
    applicationNumber: { type: String, trim: true, default: '', trgm: true },
    status:       { type: String, default: 'draft' },
    stage:        { type: String, default: 'draft' },
    statusChangedAt: { type: Date, default: null },
    // A group of branches (services/admission/groups.js): the family's order of preference
    // across branches, and the application this one was moved from.
    groupRank:       { type: Number, default: null },
    transferFrom:    { type: db.Types.UUID, ref: 'AdmissionApplication', default: null },

    data:         { type: db.Types.JSON, default: () => ({}) },
    // Answers to questions a later form version no longer asks — kept, never shown.
    retiredData:  { type: db.Types.JSON, default: () => ({}) },

    studentName:   { type: String, trim: true, default: '', trgm: true },
    studentDob:    { type: Date, default: null },
    studentGender: { type: String, default: '' },
    guardianName:  { type: String, trim: true, default: '' },
    guardianEmail: { type: String, trim: true, lowercase: true, default: '' },
    guardianPhone: { type: String, trim: true, default: '' },
    source:        { type: String, trim: true, default: '' },

    submittedAt:     { type: Date, default: null },
    lastSubmittedAt: { type: Date, default: null },
    decidedAt:       { type: Date, default: null },
    lastActivityAt:  { type: Date, default: null },

    assignedTo:   { type: db.Types.UUID, ref: 'User', default: null },
    // A move that needs an administrator's approval, waiting for one:
    // { to, by, byName, at, note }.
    pendingTransition: { type: db.Types.JSON, default: null },
    // { duplicateOf: [ids], reviewedDuplicate: bool, ... }
    flags:        { type: db.Types.JSON, default: () => ({}) },

    applicationFeeAmount: { type: Number, default: 0 },
    applicationFeeStatus: { type: String, default: 'not_required' },   // not_required | due | paid | waived
    admissionFeeAmount:   { type: Number, default: 0 },
    admissionFeeStatus:   { type: String, default: 'not_required' },
    feeWaivers:   { type: db.Types.JSON, default: () => [] },
    docStatus:    { type: String, default: 'none' },     // none | missing | uploaded | under_review | rejected | verified
    offerStatus:  { type: String, default: '' },
    // The latest published list decision: { list, listName, listNo, decision, rank, waitPosition }.
    selection:    { type: db.Types.JSON, default: null },

    // "Confirm admission / convert to student" — services/admission/conversion.js.
    conversion:   { type: db.Types.JSON, default: null },
    studentUser:  { type: db.Types.UUID, ref: 'User', default: null },
    parentUser:   { type: db.Types.UUID, ref: 'User', default: null },
    admissionNumber: { type: String, trim: true, default: '' },

    closedReason: { type: String, default: '' },          // why it was rejected / cancelled / withdrawn
    // A quota the application is considered under (services/admission/quotas.js):
    // claimed (from its answers) → verified or rejected by the office; allotted
    // = placed by the state (RTE 12(1)(c)), with the state's own reference.
    quota:        { type: String, default: '' },
    quotaStatus:  { type: String, default: '' },          // '' | claimed | verified | rejected | allotted
    quotaNote:    { type: String, default: '' },
    externalRef:  { type: String, default: '' },
    // Data protection (services/admission/privacy.js): a hold keeps the
    // application out of the retention purge ({ on, reason, by, byName, at });
    // erasedAt marks one whose personal data has been erased.
    legalHold:    { type: db.Types.JSON, default: null },
    erasedAt:     { type: Date, default: null },
    erasureReason: { type: String, default: '' },
    createdBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionApplicationSchema.index({ school: 1, round: 1, class: 1, status: 1 });
AdmissionApplicationSchema.index({ school: 1, status: 1 });
AdmissionApplicationSchema.index({ school: 1, applicant: 1 });
AdmissionApplicationSchema.index({ school: 1, guardianPhone: 1 });
AdmissionApplicationSchema.index({ school: 1, guardianEmail: 1 });
AdmissionApplicationSchema.index({ school: 1, submittedAt: -1 });
// One application number per school; drafts have none yet.
AdmissionApplicationSchema.index({ school: 1, applicationNumber: 1 }, { unique: true, partialFilterExpression: { applicationNumber: { $gt: '' } } });

module.exports = db.model('AdmissionApplication', AdmissionApplicationSchema);
