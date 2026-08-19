const db = require('../db/orm');

// Who ate which meal (spec §15) — feeds mess billing and wastage reports.
const HostelMessAttendanceSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    mess: { type: db.Types.UUID, ref: 'HostelMess', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', default: null },

    date: { type: Date, required: true },                      // local midnight
    meal: { type: String, enum: ['breakfast', 'lunch', 'snacks', 'dinner', 'special'], required: true },
    status: { type: String, enum: ['taken', 'skipped', 'on_leave', 'guest'], default: 'taken' },
    guestCount: { type: Number, default: 0 },
    remarks: { type: String, default: '' },
    markedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelMessAttendanceSchema.index({ student: 1, date: 1, meal: 1 }, { unique: true, name: 'unique_mess_attendance_meal' });
HostelMessAttendanceSchema.index({ school: 1, mess: 1, date: -1 });

module.exports = db.model('HostelMessAttendance', HostelMessAttendanceSchema);
