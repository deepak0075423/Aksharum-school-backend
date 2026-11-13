const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  A subject a school follows for one of its classes: the central subject
//  (`lmsSubject`) and the school's OWN subject it stands for (`schoolSubject`).
//
//  The link is what joins the library to the ERP: teachers are attached to a
//  section through the school's subject (SectionSubjectTeacher), so a book of
//  this subject can be released only by the teachers who take that subject in
//  that section.
// ─────────────────────────────────────────────────────────────────────────────
const LmsSchoolSubjectSchema = new db.Schema({
    school:        { type: db.Types.UUID, ref: 'School', required: true, index: true },
    academicYear:  { type: db.Types.UUID, ref: 'AcademicYear', required: true, index: true },
    class:         { type: db.Types.UUID, ref: 'Class', required: true, index: true },
    classLevel:    { type: Number, required: true },
    lmsSubject:    { type: db.Types.UUID, ref: 'LmsSubject', required: true },
    schoolSubject: { type: db.Types.UUID, ref: 'Subject', required: true },
    createdBy:     { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

LmsSchoolSubjectSchema.index({ class: 1, lmsSubject: 1 }, { unique: true });

module.exports = db.model('LmsSchoolSubject', LmsSchoolSubjectSchema);
