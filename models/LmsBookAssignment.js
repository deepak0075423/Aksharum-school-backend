const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  A book a school follows: for a whole class (`section` null — every section
//  of it) or for one section. Section A may follow Book A while Section B
//  follows Book B.
//
//  A student sees the books assigned to the class and section they are in
//  NOW, so moving a student to another section moves their books with them.
//  An assignment is never deleted: it is ended (`status`, `endedAt`,
//  `endedBy`), which keeps the record of what a section followed and when.
//  One LIVE assignment per class, section and book (db/migrate.js).
// ─────────────────────────────────────────────────────────────────────────────
const LmsBookAssignmentSchema = new db.Schema({
    school:        { type: db.Types.UUID, ref: 'School', required: true, index: true },
    academicYear:  { type: db.Types.UUID, ref: 'AcademicYear', required: true, index: true },
    class:         { type: db.Types.UUID, ref: 'Class', required: true, index: true },
    section:       { type: db.Types.UUID, ref: 'ClassSection', default: null, index: true },
    lmsSubject:    { type: db.Types.UUID, ref: 'LmsSubject', required: true },
    schoolSubject: { type: db.Types.UUID, ref: 'Subject', required: true, index: true },
    book:          { type: db.Types.UUID, ref: 'LmsBook', required: true, index: true },
    status:        { type: String, enum: ['active', 'ended'], default: 'active', index: true },
    startedAt:     { type: Date, default: Date.now },
    endedAt:       { type: Date, default: null },
    assignedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    endedBy:       { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('LmsBookAssignment', LmsBookAssignmentSchema);
