const db = require('../db/orm');

/**
 * The Results module's own trail, for what has no exam left to carry it — a
 * draft deleted, a class test handed over, settings changed, electives set,
 * report cards released or sent (Oct 2026). Each exam keeps its own history in
 * FormalExam.auditLog; this is the school-wide one (Results → Activity).
 */
const ResultAuditLogSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    user:   { type: db.Types.UUID, ref: 'User', default: null },
    role:   { type: String, default: '' },

    actionType:  { type: String, required: true },   // EXAM_DELETED / SETTINGS_CHANGED / …
    entityType:  { type: String, required: true },   // Exam / ClassTest / Settings / Electives / ReportCards …
    entityId:    { type: db.Types.UUID, default: null },
    description: { type: String, default: '' },
    meta:        { type: db.Types.JSON, default: {} },
}, { timestamps: true });

ResultAuditLogSchema.index({ school: 1, createdAt: -1 });

module.exports = db.model('ResultAuditLog', ResultAuditLogSchema);
