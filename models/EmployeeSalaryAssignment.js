const db = require('../db/orm');

const OverrideSchema = new db.Schema({
    componentName: { type: String, required: true, trim: true },
    value: { type: Number, required: true },
}, { _id: false });

const RevisionSchema = new db.Schema({
    structure: { type: db.Types.UUID, ref: 'SalaryStructure' },
    effectiveDate: Date,
    changedBy: { type: db.Types.UUID, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
    notes: String,
}, { _id: false });

// One entry per CTC change — forms the salary timeline
const CtcRevisionSchema = new db.Schema({
    annualCtc:      { type: Number, required: true },
    previousCtc:    { type: Number, default: 0 },
    // 'initial' = first-time set, 'increment_pct' = % hike, 'increment_value' = flat ₹ hike, 'manual' = direct edit
    incrementType:  { type: String, enum: ['initial', 'increment_pct', 'increment_value', 'manual'], default: 'manual' },
    incrementValue: { type: Number, default: 0 },  // % or ₹ depending on incrementType
    effectiveMonth: { type: Number, required: true, min: 1, max: 12 },
    effectiveYear:  { type: Number, required: true },
    note:           { type: String, default: '' },
    updatedBy:      { type: db.Types.UUID, ref: 'User' },
    updatedAt:      { type: Date, default: Date.now },
}, { _id: true });

const EmployeeSalaryAssignmentSchema = new db.Schema({
    employee:         { type: db.Types.UUID, ref: 'User', required: true },
    school:           { type: db.Types.UUID, ref: 'School', required: true },
    structure:        { type: db.Types.UUID, ref: 'SalaryStructure', required: true },
    // The year the assignment belongs to. Stamped on create so a school can
    // carry assignments forward year by year and still see last year's.
    academicYear:     { type: db.Types.UUID, ref: 'AcademicYear', default: null },
    effectiveDate:    { type: Date, required: true },
    // Null = open-ended. A run only pays an assignment whose window covers the
    // pay month, which is what makes a mid-year leaver stop being paid.
    endDate:          { type: Date, default: null },
    ctc:              { type: Number, default: 0 },   // Annual CTC — always the CURRENT active value
    ctcRevisions:     [CtcRevisionSchema],
    componentOverrides: [OverrideSchema],
    // How this person is paid. The bank file only lists bank_transfer rows.
    paymentMode:      { type: String, enum: ['bank_transfer', 'cash', 'cheque'], default: 'bank_transfer' },
    isActive:         { type: Boolean, default: true },
    assignedBy:       { type: db.Types.UUID, ref: 'User' },
    notes:            { type: String, default: '' },
    revisionHistory:  [RevisionSchema],
}, { timestamps: true });

EmployeeSalaryAssignmentSchema.index({ school: 1, employee: 1 });
EmployeeSalaryAssignmentSchema.index({ school: 1, isActive: 1 });

/**
 * The active annual CTC for a pay month.
 *
 * Exported as a free function too (`activeCtc`), because every caller that
 * matters reads assignments with .lean() — and a lean row has no methods, so
 * for two years this method was silently never called and every back-dated run
 * used the CURRENT CTC. Use the function; the method stays for compatibility.
 */
function activeCtc(asgn, targetYear, targetMonth) {
    if (!asgn) return 0;
    const revs = asgn.ctcRevisions || [];
    if (!revs.length) return asgn.ctc || 0;
    const eligible = revs
        .filter(r =>
            r.effectiveYear < targetYear ||
            (r.effectiveYear === targetYear && r.effectiveMonth <= targetMonth)
        )
        // Newest effective date first, and for two revisions effective in the
        // SAME month, the one recorded last. Without that tiebreak the winner
        // was whichever order the sort happened to leave them in — so
        // correcting a revision by entering another for the same month might
        // or might not take effect.
        .sort((a, b) =>
            (b.effectiveYear - a.effectiveYear)
            || (b.effectiveMonth - a.effectiveMonth)
            || (new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
        );
    // No revision has taken effect yet: nothing is payable from this timeline,
    // so fall back to the stored current value rather than inventing one.
    return eligible.length > 0 ? eligible[0].annualCtc : (asgn.ctc || 0);
}

EmployeeSalaryAssignmentSchema.methods.getActiveCTC = function (targetYear, targetMonth) {
    return activeCtc(this, targetYear, targetMonth);
};

const Model = db.model('EmployeeSalaryAssignment', EmployeeSalaryAssignmentSchema);
Model.activeCtc = activeCtc;
module.exports = Model;
