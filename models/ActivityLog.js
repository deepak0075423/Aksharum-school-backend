const db = require('../db/orm');

const ActivityLogSchema = new db.Schema({
    user: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        default: null,
    },
    actionType: {
        type: String,
        required: true,
        // e.g. 'CREATE_CLASS', 'UPDATE_SECTION', 'ASSIGN_STUDENT', 'MARK_ATTENDANCE'
    },
    entityType: {
        type: String,
        required: true,
        // e.g. 'Class', 'ClassSection', 'Student'
    },
    entityId: {
        type: db.Types.UUID,
        default: null,
    },
    oldValue: {
        type: db.Types.JSON,
        default: null,
    },
    newValue: {
        type: db.Types.JSON,
        default: null,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Index for fast lookup by school/user/time
ActivityLogSchema.index({ school: 1, createdAt: -1 });
ActivityLogSchema.index({ user: 1, createdAt: -1 });

module.exports = db.model('ActivityLog', ActivityLogSchema);
