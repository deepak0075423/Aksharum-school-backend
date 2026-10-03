const db = require('../db/orm');

const StudentPromotionHistorySchema = new db.Schema({
    student: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    oldClass: {
        type: db.Types.UUID,
        ref: 'Class',
        default: null,
    },
    newClass: {
        type: db.Types.UUID,
        ref: 'Class',
        required: true,
    },
    oldSection: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        default: null,
    },
    newSection: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        default: null,
    },
    promotionDate: {
        type: Date,
        default: Date.now,
    },
    promotedBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        required: true,
    },
    remarks: {
        type: String,
        default: '',
    },
    // A promotion that followed a final exam's results (services/resultPromotion)
    // names the exam, so the move can be shown beside the result and taken back
    // if the results are withdrawn. `source` is 'result' for those.
    school:     { type: db.Types.UUID, ref: 'School',     default: null },
    exam:       { type: db.Types.UUID, ref: 'FormalExam', default: null },
    source:     { type: String, default: 'manual' },
    // 'promoted' — up a class; 'repeated' — the same class in the next year,
    // for a student who did not pass a final set to place them so;
    // 'passedOut' — passed the school's highest class (nothing to move to:
    // newClass is the class they finished).
    kind:       { type: String, default: 'promoted' },
    // Why (Oct 2026): 'passed', 'reExam' (passed a re-exam since), 'condition'
    // (promoted by the office although the result was not a pass),
    // 'noDetention' (the class promotes everyone), 'detained' (kept back by
    // the office although the result was a pass).
    basis:      { type: String, default: '' },
    // The move this one took the place of — a repeat a re-exam pass overtook.
    // Taking this one back (the re-exam mark was wrong) restores that one.
    supersedes: { type: db.Types.UUID, ref: 'StudentPromotionHistory', default: null },
    revertedAt: { type: Date, default: null },
    revertedBy: { type: db.Types.UUID, ref: 'User', default: null },
});

module.exports = db.model('StudentPromotionHistory', StudentPromotionHistorySchema);
