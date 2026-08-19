const db = require('../db/orm');

// One floor of a building (spec §5). `supervisor` is an existing employee.
const HostelFloorSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    building: { type: db.Types.UUID, ref: 'HostelBuilding', required: true, index: true },

    name: { type: String, required: true, trim: true },       // "Ground", "First"
    floorNumber: { type: Number, default: 0 },
    capacity: { type: Number, default: 0 },
    supervisor: { type: db.Types.UUID, ref: 'User', default: null },
    facilities: { type: [String], default: [] },

    status: { type: String, enum: ['active', 'inactive', 'maintenance'], default: 'active' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelFloorSchema.index({ school: 1, building: 1, floorNumber: 1 }, { unique: true });
HostelFloorSchema.index({ school: 1, hostel: 1, status: 1 });

module.exports = db.model('HostelFloor', HostelFloorSchema);
