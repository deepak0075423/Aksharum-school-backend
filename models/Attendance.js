const db = require('../db/orm');

const AttendanceSchema = new db.Schema({
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        required: true,
    },
    date: {
        type: Date,
        required: true,
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Only one attendance session per section per day
AttendanceSchema.index({ section: 1, date: 1 }, { unique: true });

module.exports = db.model('Attendance', AttendanceSchema);
