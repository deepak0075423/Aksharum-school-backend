const db = require('../db/orm');

// A block inside a hostel (spec §5). Floors hang off this; rooms name both so a
// room can be listed without walking the chain.
const HostelBuildingSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },

    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },       // auto BLD-####
    floorCount: { type: Number, default: 0 },
    capacity: { type: Number, default: 0 },
    description: { type: String, default: '' },

    status: { type: String, enum: ['active', 'inactive', 'maintenance'], default: 'active' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelBuildingSchema.index({ school: 1, hostel: 1, code: 1 }, { unique: true });
HostelBuildingSchema.index({ school: 1, hostel: 1, status: 1 });

module.exports = db.model('HostelBuilding', HostelBuildingSchema);
