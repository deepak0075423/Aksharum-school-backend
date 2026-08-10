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
});

// One record per student per attendance session
AttendanceRecordSchema.index({ attendance: 1, student: 1 }, { unique: true });

module.exports = db.model('AttendanceRecord', AttendanceRecordSchema);
