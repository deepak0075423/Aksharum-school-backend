const db = require('../db/orm');

const marksEntrySchema = new db.Schema({
    student:       { type: db.Types.UUID, ref: 'User', required: true },
    marksObtained: { type: Number, default: null },
    isAbsent:      { type: Boolean, default: false },
    remarks:       { type: String, default: '' },
}, { _id: false });

const auditEntrySchema = new db.Schema({
    action:  { type: String, required: true },
    by:      { type: db.Types.UUID, ref: 'User', required: true },
    at:      { type: Date, default: Date.now },
    notes:   { type: String, default: '' },
    changes: { type: db.Types.JSON, default: null },
}, { _id: false });

const ExamMarksSheetSchema = new db.Schema({
    exam:    { type: db.Types.UUID, ref: 'FormalExam', required: true },
    subject: { type: db.Types.UUID, ref: 'Subject',    required: true },
    section: { type: db.Types.UUID, ref: 'ClassSection', required: true },

    // DRAFT → SUBMITTED (by subject teacher); admin can override marks anytime before FINAL_APPROVED
    status: {
        type: String,
        enum: ['DRAFT', 'SUBMITTED'],
        default: 'DRAFT',
    },

    submittedBy: { type: db.Types.UUID, ref: 'User', default: null },
    submittedAt: { type: Date, default: null },

    entries:  { type: [marksEntrySchema], default: [] },
    auditLog: { type: [auditEntrySchema], default: [] },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

ExamMarksSheetSchema.index({ exam: 1, subject: 1 }, { unique: true });

ExamMarksSheetSchema.pre('save', async function () {
    this.updatedAt = new Date();
});

module.exports = db.model('ExamMarksSheet', ExamMarksSheetSchema);
