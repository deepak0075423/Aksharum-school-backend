const db = require('../db/orm');

/**
 * What a report card carries besides the marks (Oct 2026): the class teacher's
 * remarks on a student's year, and the student's grade in each co-scholastic
 * area the school grades (Results → Settings). One row per student per
 * academic year, written by the section's class or vice class teacher, or the
 * office (services/reportCard).
 */
const ReportCardNoteSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    // The term the note is for (ResultSettings.terms key); '' — the year.
    // Unique per (school, year, student, term) — an expression index made in
    // db/migrate.js, since a NULL term on older rows must count as ''.
    term: { type: String, default: '' },
    remarks: { type: String, default: '' },
    // { areaKey: grade } — keys are the school's co-scholastic areas.
    coScholastic: { type: Object, default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

ReportCardNoteSchema.index({ school: 1, academicYear: 1, student: 1 });
ReportCardNoteSchema.pre('save', async function () {
    this.updatedAt = new Date();
});

module.exports = db.model('ReportCardNote', ReportCardNoteSchema);
