const db = require('../db/orm');

const subjectResultSchema = new db.Schema({
    subject:      { type: db.Types.UUID, ref: 'Subject', required: true },
    marksObtained:{ type: Number, default: 0 },
    maxMarks:     { type: Number, required: true },
    passingMarks: { type: Number, required: true },
    grade:        { type: String, default: '' },
    isPassed:     { type: Boolean, default: false },
    isAbsent:     { type: Boolean, default: false },
    remarks:      { type: String, default: '' },
}, { _id: false });

const FormalResultSchema = new db.Schema({
    exam:         { type: db.Types.UUID, ref: 'FormalExam',    required: true },
    student:      { type: db.Types.UUID, ref: 'User',          required: true },
    school:       { type: db.Types.UUID, ref: 'School',        required: true },
    section:      { type: db.Types.UUID, ref: 'ClassSection',  required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear',  required: true },

    subjects: { type: [subjectResultSchema], default: [] },

    totalMarks:    { type: Number, default: 0 },
    totalMaxMarks: { type: Number, default: 0 },
    percentage:    { type: Number, default: 0 },
    grade:         { type: String, default: '' },
    rank:          { type: Number, default: 0 },
    isPassed:      { type: Boolean, default: false },

    attendancePercentage: { type: Number, default: null },

    generatedAt: { type: Date, default: Date.now },
});

FormalResultSchema.index({ exam: 1, student: 1 }, { unique: true });

module.exports = db.model('FormalResult', FormalResultSchema);
