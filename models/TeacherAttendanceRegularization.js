const db = require('../db/orm');

const TeacherAttendanceRegularizationSchema = new db.Schema({
    teacher: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    date: {
        type: Date,
        required: true,
    },
    requestType: {
        type: String,
        enum: ['Missed Punch', 'Correction', 'Leave Adjustment', 'Other'],
        required: true,
    },
    requestedStatus: {
        type: String,
        enum: ['Present', 'Absent', 'Half-Day', 'Leave'],
        required: true,
    },
    // Requested clock times ('HH:mm') — whichever punches were missed
    checkIn: {
        type: String,
        default: '',
    },
    checkOut: {
        type: String,
        default: '',
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
    adminRemarks: {
        type: String,
        default: '',
        trim: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

TeacherAttendanceRegularizationSchema.index({ teacher: 1, date: 1, status: 1 });
TeacherAttendanceRegularizationSchema.index({ school: 1, status: 1 });

module.exports = db.model('TeacherAttendanceRegularization', TeacherAttendanceRegularizationSchema);
