const db = require('../db/orm');

const AttendanceCorrectionSchema = new db.Schema({
    student: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        required: true,
    },
    attendance: {
        type: db.Types.UUID,
        ref: 'Attendance',
        required: true,
    },
    attendanceRecord: {
        type: db.Types.UUID,
        ref: 'AttendanceRecord',
        default: null, // null if the student was not marked at all
    },
    date: {
        type: Date,
        required: true,
    },
    currentStatus: {
        type: String,
        enum: ['Present', 'Absent', 'Late', 'Not Marked'],
        required: true,
    },
    requestedStatus: {
        type: String,
        enum: ['Present', 'Absent', 'Late'],
        required: true,
    },
    reason: {
        type: String,
        required: true,
        trim: true,
        maxlength: 500,
    },
    status: {
        type: String,
        enum: ['Pending', 'Approved', 'Rejected'],
        default: 'Pending',
    },
    reviewedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    reviewedAt: {
        type: Date,
        default: null,
    },
    teacherRemarks: {
        type: String,
        default: '',
        trim: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Prevent duplicate pending correction for the same day
AttendanceCorrectionSchema.index({ student: 1, date: 1, status: 1 });
AttendanceCorrectionSchema.index({ section: 1, status: 1 });
AttendanceCorrectionSchema.index({ school: 1, status: 1 });

module.exports = db.model('AttendanceCorrection', AttendanceCorrectionSchema);
