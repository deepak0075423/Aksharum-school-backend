const db = require('../db/orm');

// Board × class level × subject: "WBBSE teaches Hindi in Class 9". One row per
// combination, so a common subject is reused instead of duplicated per board.
const LmsSubjectMapSchema = new db.Schema({
    board:      { type: db.Types.UUID, ref: 'LmsBoard', required: true, index: true },
    classLevel: { type: Number, required: true },
    subject:    { type: db.Types.UUID, ref: 'LmsSubject', required: true, index: true },
    createdBy:  { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

LmsSubjectMapSchema.index({ board: 1, classLevel: 1, subject: 1 }, { unique: true });

module.exports = db.model('LmsSubjectMap', LmsSubjectMapSchema);
