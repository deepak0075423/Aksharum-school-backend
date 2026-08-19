const db = require('../db/orm');

// Which existing employee covers which hostel/floor, in what role and shift
// (spec §14). This is an assignment table only — the employee master stays
// User + TeacherProfile, so nothing about a person is duplicated here.
const HostelStaffAssignmentSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    building: { type: db.Types.UUID, ref: 'HostelBuilding', default: null },
    floor: { type: db.Types.UUID, ref: 'HostelFloor', default: null },

    staff: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    role: {
        type: String,
        enum: ['warden', 'assistant_warden', 'caretaker', 'security', 'housekeeping', 'mess_staff', 'maintenance', 'floor_supervisor'],
        required: true,
    },
    shift: { type: String, enum: ['morning', 'evening', 'night', 'general', 'rotational'], default: 'general' },
    shiftStart: { type: String, default: '' },                 // "08:00"
    shiftEnd: { type: String, default: '' },
    responsibilities: { type: [String], default: [] },

    fromDate: { type: Date, default: Date.now },
    toDate: { type: Date, default: null },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    isActive: { type: Boolean, default: true },
    remarks: { type: String, default: '' },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelStaffAssignmentSchema.index({ school: 1, hostel: 1, role: 1, status: 1 });
HostelStaffAssignmentSchema.index({ school: 1, staff: 1, status: 1 });

module.exports = db.model('HostelStaffAssignment', HostelStaffAssignmentSchema);
