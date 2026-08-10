const db = require('../db/orm');

const CustomItemSchema = new db.Schema({
    feeHead: { type: db.Types.UUID, ref: 'FeeHead', required: true },
    feeName: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    dueDate: { type: Date, default: null },
    installmentLabel: { type: String, default: '' },
}, { _id: true });

// Student-level fee override — highest priority in resolution chain
const StudentFeeAssignmentSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    feeStructure: { type: db.Types.UUID, ref: 'FeeStructure', default: null },
    useCustom: { type: Boolean, default: false },
    customItems: [CustomItemSchema],
    totalAmount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    remarks: { type: String, default: '' },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

StudentFeeAssignmentSchema.index({ school: 1, student: 1, academicYear: 1 }, { unique: true });

module.exports = db.model('StudentFeeAssignment', StudentFeeAssignmentSchema);
