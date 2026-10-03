const db = require('../db/orm');

/**
 * A section's report cards released to families (Oct 2026): from then on a
 * student and their parents see the whole card — the class teacher's remarks
 * and the co-scholastic grades too — for that year, or that term. Released
 * when the office (or the class teacher) says so, rather than only once a
 * Final-kind exam's results were out, which some schools never have.
 */
const ReportCardReleaseSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    section:      { type: db.Types.UUID, ref: 'ClassSection', required: true },
    term:         { type: String, default: '' },
    releasedAt:   { type: Date, default: null },
    releasedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    // The last time the cards were sent to parents (notice + email with the PDF).
    sentAt:       { type: Date, default: null },
    sentBy:       { type: db.Types.UUID, ref: 'User', default: null },
    sentCount:    { type: Number, default: 0 },
    createdAt:    { type: Date, default: Date.now },
    updatedAt:    { type: Date, default: Date.now },
});

ReportCardReleaseSchema.index({ school: 1, academicYear: 1, section: 1, term: 1 }, { unique: true });
ReportCardReleaseSchema.pre('save', async function () {
    this.updatedAt = new Date();
});

module.exports = db.model('ReportCardRelease', ReportCardReleaseSchema);
