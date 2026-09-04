const db = require('../db/orm');

const SubjectSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    // A subject belongs to ONE academic year. The school's offering changes —
    // a syllabus is revised, a subject is dropped — so each year owns its own
    // rows and editing or removing one leaves the other years alone. A new year
    // starts empty and is filled from the previous one (importYearStructure).
    //
    // Nullable only so rows written before this existed still load; the
    // migration in scripts/scopeSubjectsToYear.js gives every one a year, and
    // createSubject always sets it.
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        default: null,
        index: true,
    },
    subjectName: {
        type: String,
        required: true,
        trim: true,
    },
    subjectCode: {
        type: String,
        default: null,
        trim: true,
        uppercase: true,
    },
    type: {
        type: String,
        enum: ['theory', 'practical', 'elective'],
        default: 'theory',
    },
    description: {
        type: String,
        default: '',
    },
    teachers: [{
        type: db.Types.UUID,
        ref: 'User',
    }],
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Unique subject code per school PER YEAR, sparse so subjects with no code do
// not conflict. The year is part of the key because the same code is expected
// to repeat across years — "MATH" in 2026-27 and again in 2027-28 are two rows
// describing the same subject in two different years, not a duplicate.
SubjectSchema.index({ school: 1, academicYear: 1, subjectCode: 1 }, { unique: true, sparse: true });

module.exports = db.model('Subject', SubjectSchema);
