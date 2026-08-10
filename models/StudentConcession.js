const db = require('../db/orm');

const StudentConcessionSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    concession: { type: db.Types.UUID, ref: 'FeeConcession', required: true },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    remarks: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    approvedBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

StudentConcessionSchema.index({ school: 1, student: 1, academicYear: 1 });
StudentConcessionSchema.index({ school: 1, academicYear: 1 });

module.exports = db.model('StudentConcession', StudentConcessionSchema);
