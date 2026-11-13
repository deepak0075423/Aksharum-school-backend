const db = require('../db/orm');

// Which board a school follows in one academic year. Everything the school
// then selects — subjects, books — comes from that board's part of the library.
const LmsSchoolConfigSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true, index: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    board:        { type: db.Types.UUID, ref: 'LmsBoard', required: true, index: true },
    configuredBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

LmsSchoolConfigSchema.index({ school: 1, academicYear: 1 }, { unique: true });

module.exports = db.model('LmsSchoolConfig', LmsSchoolConfigSchema);
