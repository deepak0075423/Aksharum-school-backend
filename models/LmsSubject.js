const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  Video Learning — the central subject master. One "Hindi" for the whole
//  platform, mapped to as many boards and classes as teach it (LmsSubjectMap).
//  A school's own Subject rows are per school and per year; LmsSchoolSubject
//  links one of them to the central subject it stands for.
// ─────────────────────────────────────────────────────────────────────────────
const LmsSubjectSchema = new db.Schema({
    name:        { type: String, required: true, trim: true },
    code:        { type: String, required: true, trim: true, uppercase: true, unique: true },
    description: { type: String, default: '' },
    language:    { type: String, default: 'English', trim: true },
    status:      { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    createdBy:   { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:   { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('LmsSubject', LmsSubjectSchema);
