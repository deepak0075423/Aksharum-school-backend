const db = require('../db/orm');

/**
 * What the school spent bringing families in through one source (Oct 2026) —
 * a newspaper advertisement, social media, a hoarding, an agency — for one
 * academic year, so the sources report can set it against the enquiries,
 * applications and admissions each source brought: cost per application,
 * cost per admission.
 *
 *   source   the code families arrive with (?src=… on the portal link), or
 *            what the office records on a walk-in or a call
 */
const AdmissionSourceSpendSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },
    source:       { type: String, required: true, trim: true, lowercase: true },
    label:        { type: String, default: '', trim: true },
    amount:       { type: Number, default: 0 },
    note:         { type: String, default: '' },
    updatedBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionSourceSpendSchema.index({ school: 1, academicYear: 1, source: 1 }, { unique: true });

module.exports = db.model('AdmissionSourceSpend', AdmissionSourceSpendSchema);
