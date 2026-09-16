const db = require('../db/orm');

const AttendanceRecordSchema = new db.Schema({
    attendance: {
        type: db.Types.UUID,
        ref: 'Attendance',
        required: true,
    },
    student: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    status: {
        type: String,
        enum: ['Present', 'Absent', 'Late'],
        required: true,
    },
    remarks: {
        type: String,
        default: '',
    },
    // When the CURRENT status was set, and by whom. They move only when the
    // status changes (see services/attendanceMarks.js), so a register saved
    // twice keeps the time each mark was really made. Rows written before these
    // existed read null — callers fall back to the session's createdAt.
    markedAt: {
        type: Date,
        default: null,
    },
    markedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
});

// One record per student per attendance session
AttendanceRecordSchema.index({ attendance: 1, student: 1 }, { unique: true });

module.exports = db.model('AttendanceRecord', AttendanceRecordSchema);
