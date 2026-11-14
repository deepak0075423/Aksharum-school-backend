const db = require('../db/orm');

/**
 * Where one student is in one academic year — the source of truth for
 * class, section and roll number, kept year by year.
 *
 * A student has at most one row per academic year (the unique index below).
 * Placing them in 2026-27 writes the 2026-27 row and nothing else, so their
 * 2025-26 class, section and roll number stay exactly as they were.
 *
 * Two other places mirror this table and are kept in step by
 * services/enrollment.js, the only writer:
 *   - ClassSection.enrolledStudents — the section's roster (a section belongs to
 *     one year, so its roster is that year's rows with that section);
 *   - StudentProfile.currentClass / currentSection / rollNumber — a pointer to
 *     the row of the school's ACTIVE year (or the student's latest earlier row
 *     when they have none in it). Switching the active year moves the pointer.
 *
 * `section` null with a class is a real state: admitted to the class for that
 * year, not placed in a section yet (what the section shuffle resolves).
 */
const StudentEnrollmentSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School',       required: true },
    student:      { type: db.Types.UUID, ref: 'User',         required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    class:        { type: db.Types.UUID, ref: 'Class',        default: null },
    section:      { type: db.Types.UUID, ref: 'ClassSection', default: null },
    rollNumber:   { type: String, default: '', trim: true },
    // How the row was last written: manual, import, admission, shuffle,
    // autoAssign, promotion, backfill — for the audit, not for logic.
    source:       { type: String, default: 'manual' },
    updatedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    createdAt:    { type: Date, default: Date.now },
    updatedAt:    { type: Date, default: Date.now },
});

StudentEnrollmentSchema.index({ student: 1, academicYear: 1 }, { unique: true });
StudentEnrollmentSchema.index({ school: 1, academicYear: 1 });
StudentEnrollmentSchema.index({ section: 1 });
StudentEnrollmentSchema.index({ class: 1 });

module.exports = db.model('StudentEnrollment', StudentEnrollmentSchema);
