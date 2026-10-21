const db = require('../db/orm');

/**
 * An applicant's result in one exam or interview.
 *
 * The working figures (marks, scores, total, grade, passed) are the office's:
 * entered, computed, corrected, approved. What a family sees is `published` —
 * a snapshot taken when the exam's results are published — so a correction
 * made afterwards changes nothing they can see until it is published again,
 * and every correction is kept in `corrections` with who, when and why.
 *
 *   marks     { subjectKey: number } — offline / interview marks
 *   autoScore what the online attempt's objective questions scored
 *   manualScore  descriptive answers, as evaluated
 */
const AdmissionResultSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    exam:         { type: db.Types.UUID, ref: 'AdmissionExam', required: true },
    application:  { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    candidate:    { type: db.Types.UUID, ref: 'AdmissionCandidate', default: null },
    marks:        { type: db.Types.JSON, default: () => ({}) },
    autoScore:    { type: Number, default: null },
    manualScore:  { type: Number, default: null },
    total:        { type: Number, default: null },
    percentage:   { type: Number, default: null },
    grade:        { type: String, default: '' },
    passed:       { type: Boolean, default: null },
    absent:       { type: Boolean, default: false },
    remarks:      { type: String, default: '' },
    status:       { type: String, enum: ['draft', 'submitted', 'approved', 'published'], default: 'draft' },
    enteredBy:    { type: db.Types.UUID, ref: 'User', default: null },
    enteredAt:    { type: Date, default: null },
    submittedBy:  { type: db.Types.UUID, ref: 'User', default: null },
    submittedAt:  { type: Date, default: null },
    approvedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    approvedAt:   { type: Date, default: null },
    published:    { type: db.Types.JSON, default: null },
    corrections:  { type: db.Types.JSON, default: () => [] },
}, { timestamps: true });

AdmissionResultSchema.index({ exam: 1, application: 1 }, { unique: true });
AdmissionResultSchema.index({ school: 1, exam: 1, status: 1 });

module.exports = db.model('AdmissionResult', AdmissionResultSchema);
