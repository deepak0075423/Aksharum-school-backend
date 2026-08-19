const db = require('../db/orm');

// Hostel roll call (spec §11). One row per student per date per session.
//
// The academic Attendance/AttendanceRecord pair is section-scoped and allows a
// single session per section per day; hostel attendance is hostel-scoped with
// up to four named sessions, so it is its own table rather than a distortion of
// the academic one. The unique index is the "no duplicate attendance for the
// same student/date/session" rule (spec §11).
const HostelAttendanceSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    allocation: { type: db.Types.UUID, ref: 'HostelAllocation', default: null },
    // Denormalised placement so room-/floor-wise registers need no join.
    building: { type: db.Types.UUID, ref: 'HostelBuilding', default: null },
    floor: { type: db.Types.UUID, ref: 'HostelFloor', default: null },
    room: { type: db.Types.UUID, ref: 'HostelRoom', default: null },

    date: { type: Date, required: true },                     // local midnight
    session: { type: String, enum: ['morning', 'evening', 'night', 'roll_call'], required: true },
    status: { type: String, enum: ['present', 'absent', 'late', 'excused', 'on_leave'], required: true },
    remarks: { type: String, default: '' },

    markedBy: { type: db.Types.UUID, ref: 'User', default: null },
    markedAt: { type: Date, default: Date.now },

    // Correction trail (spec §11, §29): a change never overwrites silently.
    correctedBy: { type: db.Types.UUID, ref: 'User', default: null },
    correctedAt: { type: Date, default: null },
    previousStatus: { type: String, default: '' },
    correctionReason: { type: String, default: '' },
    approvalStatus: { type: String, enum: ['not_required', 'pending', 'approved', 'rejected'], default: 'not_required' },
    approvedBy: { type: db.Types.UUID, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
}, { timestamps: true });

HostelAttendanceSchema.index({ student: 1, date: 1, session: 1 }, { unique: true, name: 'unique_hostel_attendance_session' });
HostelAttendanceSchema.index({ school: 1, hostel: 1, date: -1 });
HostelAttendanceSchema.index({ school: 1, date: -1, status: 1 });
HostelAttendanceSchema.index({ school: 1, room: 1, date: -1 });

module.exports = db.model('HostelAttendance', HostelAttendanceSchema);
