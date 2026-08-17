const db = require('../db/orm');

// Physical teaching spaces used by the timetable generator for room allocation
// and clash detection. The ERP had no infrastructure entity before this module,
// so rooms live here; `building` doubles as the campus/branch label since a
// School row is itself the tenant (there is no separate Campus entity).
const RoomSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    roomName: {
        type: String,
        required: true,
        trim: true,
    },
    roomNumber: {
        type: String,
        default: '',
        trim: true,
    },
    roomType: {
        type: String,
        enum: [
            'Classroom', 'Science Lab', 'Computer Lab', 'Physics Lab',
            'Chemistry Lab', 'Biology Lab', 'Library', 'Auditorium',
            'Activity Room', 'Sports', 'Other',
        ],
        default: 'Classroom',
    },
    capacity: {
        type: Number,
        default: 40,
        min: 0,
    },
    building: {
        type: String,
        default: '',
        trim: true,
    },
    // When set, this room is the section's default classroom — theory periods
    // for that section land here unless the subject demands a special room.
    homeSection: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        default: null,
    },
    // Explicit subject whitelist. Empty ⇒ the room accepts any subject whose
    // required room type it satisfies.
    subjects: [{
        type: db.Types.UUID,
        ref: 'Subject',
    }],
    // Slots the room can never be booked in (maintenance, external bookings…).
    unavailable: [{
        dayOfWeek:    { type: String, default: '' },
        periodNumber: { type: Number, default: 0 },
        reason:       { type: String, default: '' },
    }],
    notes: {
        type: String,
        default: '',
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

// Room numbers are unique per school when supplied
RoomSchema.index({ school: 1, roomNumber: 1 }, { unique: true, sparse: true });
RoomSchema.index({ school: 1, roomType: 1 });
RoomSchema.index({ school: 1, isActive: 1 });

module.exports = db.model('Room', RoomSchema);
