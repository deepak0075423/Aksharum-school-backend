const db = require('../db/orm');

const marksEntrySchema = new db.Schema({
    student:       { type: db.Types.UUID, ref: 'User', required: true },
    marksObtained: { type: Number, default: null },
    isAbsent:      { type: Boolean, default: false },
    remarks:       { type: String, default: '' },
    grade:         { type: String, default: '' },
}, { _id: false });

const auditEntrySchema = new db.Schema({
    action:  { type: String, required: true },
    by:      { type: db.Types.UUID, ref: 'User', required: true },
    at:      { type: Date, default: Date.now },
    notes:   { type: String, default: '' },
}, { _id: false });

const ClassTestSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School',        required: true },
    section:      { type: db.Types.UUID, ref: 'ClassSection',  required: true },
    subject:      { type: db.Types.UUID, ref: 'Subject',       required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear',  required: true },

    title:       { type: String, required: true, trim: true },
    testDate:    { type: Date,   required: true },
    maxMarks:    { type: Number, required: true, min: 1 },
    passingMarks:{ type: Number, required: true, min: 0 },
    topic:       { type: String, default: '' },
    description: { type: String, default: '' },

    // DRAFT → SUBMITTED → FINAL_APPROVED | REJECTED | REOPENED
    status: {
        type: String,
        enum: ['DRAFT', 'SUBMITTED', 'FINAL_APPROVED', 'REJECTED', 'REOPENED'],
        default: 'DRAFT',
    },

    rejectionReason: { type: String, default: '' },

    marks: { type: [marksEntrySchema], default: [] },

    classStats: {
        average:     { type: Number, default: null },
        highest:     { type: Number, default: null },
        lowest:      { type: Number, default: null },
        passPercent: { type: Number, default: null },
    },

    createdBy:   { type: db.Types.UUID, ref: 'User', required: true },
    approvedBy:  { type: db.Types.UUID, ref: 'User', default: null },
    approvedAt:  { type: Date, default: null },
    auditLog:    { type: [auditEntrySchema], default: [] },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

ClassTestSchema.pre('save', async function () {
    this.updatedAt = new Date();
});

module.exports = db.model('ClassTest', ClassTestSchema);
