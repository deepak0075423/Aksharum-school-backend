const db = require('../db/orm');

const auditEntrySchema = new db.Schema({
    action:  { type: String, required: true },
    by:      { type: db.Types.UUID, ref: 'User', required: true },
    at:      { type: Date, default: Date.now },
    notes:   { type: String, default: '' },
}, { _id: false });

const subjectConfigSchema = new db.Schema({
    subject:        { type: db.Types.UUID, ref: 'Subject', required: true },
    maxMarks:       { type: Number, required: true, min: 1 },
    passingMarks:   { type: Number, required: true, min: 0 },
    assignedTeachers:[{ type: db.Types.UUID, ref: 'User' }],
    examDate:       { type: Date,   default: null },
    startTime:      { type: String, default: '' },
    endTime:        { type: String, default: '' },
    order:          { type: Number, default: 0 },
}, { _id: false });

const FormalExamSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School',       required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    section:      { type: db.Types.UUID, ref: 'ClassSection', required: true },

    title:    { type: String, required: true, trim: true },
    examType: { type: String, enum: ['MID_TERM', 'FINAL', 'UNIT_TEST'], required: true },

    subjects: { type: [subjectConfigSchema], default: [] },

    startDate:   { type: Date, required: true },
    endDate:     { type: Date, required: true },
    publishDate: { type: Date, default: null },

    // DRAFT → MARKS_PENDING → SUBMITTED → CLASS_APPROVED → FINAL_APPROVED | REJECTED | REOPENED
    status: {
        type: String,
        enum: ['DRAFT', 'MARKS_PENDING', 'SUBMITTED', 'CLASS_APPROVED', 'FINAL_APPROVED', 'REJECTED', 'REOPENED'],
        default: 'DRAFT',
    },

    rejectionReason: { type: String, default: '' },

    classApprovedBy: { type: db.Types.UUID, ref: 'User', default: null },
    classApprovedAt: { type: Date, default: null },
    finalApprovedBy: { type: db.Types.UUID, ref: 'User', default: null },
    finalApprovedAt: { type: Date, default: null },

    resultsGenerated: { type: Boolean, default: false },

    createdBy: { type: db.Types.UUID, ref: 'User', required: true },
    auditLog:  { type: [auditEntrySchema], default: [] },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

FormalExamSchema.pre('save', async function () {
    this.updatedAt = new Date();
});

module.exports = db.model('FormalExam', FormalExamSchema);
