const db = require('../db/orm');

const TeacherAttendanceSchema = new db.Schema({
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
    status: {
        type: String,
        enum: ['Present', 'Absent', 'Half-Day', 'Leave'],
        required: true,
    },
    // Clock in/out times as 'HH:mm' — presence is derived from checkIn
    checkIn: {
        type: String,
        default: '',
    },
    checkOut: {
        type: String,
        default: '',
    },
    remarks: {
        type: String,
        default: '',
        trim: true,
    },
    markedBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true, // self or admin override
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
});

// One attendance record per teacher per day
TeacherAttendanceSchema.index({ teacher: 1, date: 1 }, { unique: true });
TeacherAttendanceSchema.index({ school: 1, date: 1 });

// pre-save hooks are promise-based — no `next` callback
TeacherAttendanceSchema.pre('save', function () {
    this.updatedAt = new Date();
});

module.exports = db.model('TeacherAttendance', TeacherAttendanceSchema);
