const db = require('../db/orm');

// A room (spec §6). `occupiedBeds` is a denormalised counter kept in step by the
// allocation service inside the same transaction that moves a bed, so the room
// grid renders without an aggregate per room. Beds remain the source of truth.
const HostelRoomSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    building: { type: db.Types.UUID, ref: 'HostelBuilding', required: true, index: true },
    floor: { type: db.Types.UUID, ref: 'HostelFloor', required: true, index: true },

    roomNumber: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },       // auto RM-####
    roomType: {
        type: String,
        enum: ['single', 'double', 'triple', 'four_bed', 'dormitory', 'custom'],
        default: 'double',
    },
    capacity: { type: Number, required: true, default: 2 },
    // Inherited from the hostel when blank; an explicit value narrows further.
    gender: { type: String, enum: ['male', 'female', 'any', ''], default: '' },
    facilities: { type: [String], default: [] },
    description: { type: String, default: '' },

    // Derived, kept transactionally: how many beds are currently occupied.
    occupiedBeds: { type: Number, default: 0 },
    bedCount: { type: Number, default: 0 },

    status: {
        type: String,
        enum: ['available', 'partially_occupied', 'full', 'reserved', 'maintenance', 'inactive'],
        default: 'available',
    },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelRoomSchema.index({ school: 1, hostel: 1, roomNumber: 1 }, { unique: true });
HostelRoomSchema.index({ school: 1, floor: 1, status: 1 });
HostelRoomSchema.index({ school: 1, hostel: 1, status: 1 });

module.exports = db.model('HostelRoom', HostelRoomSchema);
