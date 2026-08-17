const db = require('../db/orm');

// Immutable trail for the timetable module — who generated, edited, published,
// archived or restored what. Mirrors TransportAuditLog so the two modules read
// the same way in reports.
const TimetableAuditLogSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    user:   { type: db.Types.UUID, ref: 'User', default: null },
    role:   { type: String, default: '' },

    actionType:  { type: String, required: true },   // generate / move / publish / archive …
    entityType:  { type: String, required: true },   // Version / Entry / Room / Requirement …
    entityId:    { type: db.Types.UUID, default: null },
    version:     { type: db.Types.UUID, ref: 'TimetableVersion', default: null },
    description: { type: String, default: '' },
    meta:        { type: db.Types.JSON, default: {} },
}, { timestamps: true });

TimetableAuditLogSchema.index({ school: 1, createdAt: -1 });
TimetableAuditLogSchema.index({ version: 1, createdAt: -1 });

module.exports = db.model('TimetableAuditLog', TimetableAuditLogSchema);
