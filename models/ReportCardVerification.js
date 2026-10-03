const db = require('../db/orm');

/**
 * What a printed report card's QR code proves (Oct 2026). One row per student,
 * year and term: the code printed on the card, and the figures the school
 * issued — so anybody holding the paper can open the link and see that the
 * school issued exactly that, and whether it has been corrected since.
 */
const ReportCardVerificationSchema = new db.Schema({
    code:         { type: String, required: true, unique: true },
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    student:      { type: db.Types.UUID, ref: 'User', required: true },
    term:         { type: String, default: '' },
    // { name, className, sectionName, rollNumber, admissionNumber, yearName,
    //   termLabel, percentage, grade, result, exams: [{ title, percentage }] }
    snapshot:     { type: Object, default: null },
    issuedAt:     { type: Date, default: Date.now },
    updatedAt:    { type: Date, default: Date.now },
});

ReportCardVerificationSchema.index({ school: 1, academicYear: 1, student: 1 });

module.exports = db.model('ReportCardVerification', ReportCardVerificationSchema);
