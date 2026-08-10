const db = require('../db/orm');

const ClassMonitorSchema = new db.Schema({
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        required: true,
    },
    student: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    assignedBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    assignedDate: {
        type: Date,
        default: Date.now,
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active',
    },
});

// A student can only be an active monitor once per section
ClassMonitorSchema.index({ section: 1, student: 1 }, { unique: true });

module.exports = db.model('ClassMonitor', ClassMonitorSchema);
