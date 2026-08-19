const db = require('../db/orm');

// Append-only allocation trail (spec §10, §29). Written for every allocate /
// release / transfer / reserve so deleting master data can never destroy the
// record of who stayed where: the names are snapshotted alongside the ids.
const HostelAllocationHistorySchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    allocation: { type: db.Types.UUID, ref: 'HostelAllocation', default: null },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },

    action: {
        type: String,
        enum: ['allocated', 'released', 'transferred', 'reserved', 'cancelled', 'maintenance', 'vacated'],
        required: true,
    },

    fromHostel: { type: db.Types.UUID, ref: 'Hostel', default: null },
    fromRoom: { type: db.Types.UUID, ref: 'HostelRoom', default: null },
    fromBed: { type: db.Types.UUID, ref: 'HostelBed', default: null },
    toHostel: { type: db.Types.UUID, ref: 'Hostel', default: null },
    toRoom: { type: db.Types.UUID, ref: 'HostelRoom', default: null },
    toBed: { type: db.Types.UUID, ref: 'HostelBed', default: null },

    // Human-readable snapshot — survives deletion of the master rows above.
    fromLabel: { type: String, default: '' },
    toLabel: { type: String, default: '' },
    studentName: { type: String, default: '' },

    reason: { type: String, default: '' },
    effectiveDate: { type: Date, default: Date.now },
    performedBy: { type: db.Types.UUID, ref: 'User', default: null },
    performedByName: { type: String, default: '' },
}, { timestamps: true });

HostelAllocationHistorySchema.index({ school: 1, student: 1, createdAt: -1 });
HostelAllocationHistorySchema.index({ school: 1, createdAt: -1 });

module.exports = db.model('HostelAllocationHistory', HostelAllocationHistorySchema);
