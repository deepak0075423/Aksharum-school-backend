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
    effectiveDate:    { type: Date, required: true },
    ctc:              { type: Number, default: 0 },   // Annual CTC — always the CURRENT active value
    ctcRevisions:     [CtcRevisionSchema],
    componentOverrides: [OverrideSchema],
    isActive:         { type: Boolean, default: true },
    assignedBy:       { type: db.Types.UUID, ref: 'User' },
    notes:            { type: String, default: '' },
    revisionHistory:  [RevisionSchema],
}, { timestamps: true });

EmployeeSalaryAssignmentSchema.index({ school: 1, employee: 1 });
EmployeeSalaryAssignmentSchema.index({ school: 1, isActive: 1 });

// Returns the active annual CTC for a given payroll month/year
EmployeeSalaryAssignmentSchema.methods.getActiveCTC = function (targetYear, targetMonth) {
    if (!this.ctcRevisions || !this.ctcRevisions.length) return this.ctc || 0;
    const eligible = this.ctcRevisions
        .filter(r =>
            r.effectiveYear < targetYear ||
            (r.effectiveYear === targetYear && r.effectiveMonth <= targetMonth)
        )
        .sort((a, b) =>
            b.effectiveYear !== a.effectiveYear
                ? b.effectiveYear - a.effectiveYear
                : b.effectiveMonth - a.effectiveMonth
        );
    return eligible.length > 0 ? eligible[0].annualCtc : (this.ctc || 0);
};

module.exports = db.model('EmployeeSalaryAssignment', EmployeeSalaryAssignmentSchema);
