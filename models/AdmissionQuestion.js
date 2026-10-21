const db = require('../db/orm');

/**
 * A question for an online entrance exam — or, with `exam` null, a question in
 * the school's admission question bank, copied into exams from there.
 *
 *   single / multiple / true_false   options [{ id, text }], correct [ids]
 *   numeric      correct { value, tolerance }
 *   short        correct { answers: [accepted strings] } — compared trimmed,
 *                case-insensitive
 *   descriptive  no key: an evaluator marks it (services/admission/exams.js)
 *
 * `correct` never leaves the server while an attempt is open.
 */
const AdmissionQuestionSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    exam:         { type: db.Types.UUID, ref: 'AdmissionExam', default: null },
    subjectKey:   { type: String, default: '' },
    type:         { type: String, enum: ['single', 'multiple', 'true_false', 'numeric', 'short', 'descriptive'], required: true },
    text:         { type: String, required: true },
    options:      { type: db.Types.JSON, default: () => [] },
    correct:      { type: db.Types.JSON, default: null },
    marks:        { type: Number, default: 1 },
    negativeMarks: { type: Number, default: null },     // null: the exam's rule
    explanation:  { type: String, default: '' },
    tags:         { type: [String], default: () => [] },
    difficulty:   { type: String, enum: ['easy', 'medium', 'hard', ''], default: '' },
    order:        { type: Number, default: 0 },
    isActive:     { type: Boolean, default: true },
    createdBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionQuestionSchema.index({ school: 1, exam: 1, order: 1 });

module.exports = db.model('AdmissionQuestion', AdmissionQuestionSchema);
