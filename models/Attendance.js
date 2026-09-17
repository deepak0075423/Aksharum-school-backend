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
    // The subject this register is for, when the school takes attendance
    // subject-wise (School.attendanceSettings.registrationMode = 'subject').
    // Null for a day register — one per section per day.
    subject: {
        type: db.Types.UUID,
        ref: 'Subject',
        default: null,
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

// One register per section per day per subject (a day register has no
// subject). Uniqueness is the expression index "ux_attendances_register" on
// (section, date, COALESCE(subject::text, '')) created in db/migrate.js — the
// ORM cannot declare an expression — so this index is only for lookups.
AttendanceSchema.index({ section: 1, date: 1 });

module.exports = db.model('Attendance', AttendanceSchema);
