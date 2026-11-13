const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  Video Learning — an education board in the CENTRAL content library
//  (WBBSE, CBSE, ICSE …). The library belongs to no school: a school says
//  which board it follows (LmsSchoolConfig) and picks books from it.
//
//  `classLevels` is the board ↔ class mapping. A class here is the platform's
//  own class level (utils/classLevels: −3 Playgroup … 12 Class 12) — the same
//  number every school's Class row carries — so no second class master exists.
// ─────────────────────────────────────────────────────────────────────────────
const LmsBoardSchema = new db.Schema({
    name:        { type: String, required: true, trim: true },
    code:        { type: String, required: true, trim: true, uppercase: true, unique: true },
    description: { type: String, default: '' },
    classLevels: { type: [Number], default: [] },
    isActive:    { type: Boolean, default: true, index: true },
    createdBy:   { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:   { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('LmsBoard', LmsBoardSchema);
