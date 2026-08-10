const db = require('../db/orm');

// Immutable audit trail for the Video module. school is null for master-library
// (Super Admin) actions. Every mutating or sensitive action writes one row.
const VideoAuditLogSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', default: null, index: true },
    user:   { type: db.Types.UUID, ref: 'User', default: null, index: true },
    role:   { type: String, default: '' },

    actionType: {
        type: String,
        enum: [
            'created', 'updated', 'deleted', 'archived', 'restored', 'duplicated',
            'published', 'scheduled', 'viewed', 'assigned', 'approved', 'rejected',
            'downloaded', 'enabled', 'disabled', 'reported', 'certificate_issued',
        ],
        required: true,
        index: true,
    },
    entityType:  { type: String, default: 'video' }, // video | playlist | course | assignment | asset
    entityId:    { type: db.Types.UUID, default: null },
    description: { type: String, default: '' },
    meta:        { type: db.Types.JSON, default: {} },
    ip:          { type: String, default: '' },
}, { timestamps: true });

VideoAuditLogSchema.index({ entityType: 1, entityId: 1 });
VideoAuditLogSchema.index({ school: 1, createdAt: 1 });

module.exports = db.model('VideoAuditLog', VideoAuditLogSchema);
