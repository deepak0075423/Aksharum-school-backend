const db = require('../db/orm');

// An individual bed (spec §7) — the unit a student is actually allocated to.
//
// `student` is the live occupant. The partial unique index below is the DB-level
// guarantee behind "a bed cannot have two active students": only one row per bed
// may carry status 'occupied', and a student may hold only one occupied bed at a
// time (see the second index). Application checks run first for a friendly
// message; these indexes are what make a race impossible.
const HostelBedSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    building: { type: db.Types.UUID, ref: 'HostelBuilding', required: true, index: true },
    floor: { type: db.Types.UUID, ref: 'HostelFloor', required: true, index: true },
    room: { type: db.Types.UUID, ref: 'HostelRoom', required: true, index: true },

    bedNumber: { type: String, required: true, trim: true },   // "1", "A", "Upper"
    code: { type: String, required: true, trim: true },        // auto BD-####
    bedType: { type: String, enum: ['single', 'bunk_upper', 'bunk_lower', 'other'], default: 'single' },

    status: {
        type: String,
        enum: ['available', 'occupied', 'reserved', 'maintenance', 'inactive'],
        default: 'available',
    },
    // Live occupant (User with role student) — null unless status is occupied/reserved.
    student: { type: db.Types.UUID, ref: 'User', default: null },
    allocation: { type: db.Types.UUID, ref: 'HostelAllocation', default: null },
    allocationDate: { type: Date, default: null },
    remarks: { type: String, default: '' },

    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelBedSchema.index({ school: 1, room: 1, bedNumber: 1 }, { unique: true });
HostelBedSchema.index({ school: 1, hostel: 1, code: 1 }, { unique: true });
HostelBedSchema.index({ school: 1, room: 1, status: 1 });
// One student, one occupied bed — enforced in the database, not just in code.
HostelBedSchema.index(
    { student: 1 },
    { unique: true, partialFilterExpression: { status: 'occupied' }, name: 'unique_occupied_bed_per_student' },
);

module.exports = db.model('HostelBed', HostelBedSchema);
