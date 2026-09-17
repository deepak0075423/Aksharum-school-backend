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
    // The register's subject in a subject-wise school; null for a day register.
    subject: {
        type: db.Types.UUID,
        ref: 'Subject',
        default: null,
    },
    currentStatus: {
        type: String,
        enum: ['Present', 'Absent', 'Late', 'Half-Day', 'Not Marked'],
        required: true,
    },
    requestedStatus: {
        type: String,
        enum: ['Present', 'Absent', 'Late', 'Half-Day'],
        required: true,
    },
    // 'student' — asked for by the student; 'teacher' — a teacher corrected the
    // mark directly (New Correction) and this row is the record of it.
    source: {
        type: String,
        enum: ['student', 'teacher'],
        default: 'student',
    },
    // Files sent with the request or a later reply:
    // [{ name, url, size, type, at, by }]
    attachments: {
        type: [db.Types.JSON],
        default: [],
    },
    // What happened to the request, oldest first:
    // [{ event: 'submitted'|'info_requested'|'replied'|'approved'|'rejected'|'corrected',
    //    at, by, byName, role, message, attachments: [url] }]
    history: {
        type: [db.Types.JSON],
        default: [],
    },
    updatedAt: {
        type: Date,
        default: null,
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
