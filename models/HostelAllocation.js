const db = require('../db/orm');

// A student's current or past stay in a bed (spec §10).
//
// One row per stay. A transfer closes the old row ('transferred') and opens a
// new one, so the full occupancy timeline is reconstructable from this table
// alone; HostelAllocationHistory records *who did what* on top of that.
const HostelAllocationSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true, index: true },
    admission: { type: db.Types.UUID, ref: 'HostelAdmission', default: null },

    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    building: { type: db.Types.UUID, ref: 'HostelBuilding', required: true, index: true },
    floor: { type: db.Types.UUID, ref: 'HostelFloor', required: true, index: true },
    room: { type: db.Types.UUID, ref: 'HostelRoom', required: true, index: true },
    bed: { type: db.Types.UUID, ref: 'HostelBed', required: true, index: true },

    allocationType: { type: String, enum: ['permanent', 'temporary'], default: 'permanent' },
    allocationMode: { type: String, enum: ['manual', 'auto', 'bulk'], default: 'manual' },

    fromDate: { type: Date, default: Date.now },
    toDate: { type: Date, default: null },                    // expected end (temporary stays)
    vacatedDate: { type: Date, default: null },

    status: {
        type: String,
        enum: ['pending', 'active', 'transferred', 'vacated', 'cancelled'],
        default: 'active',
    },
    // Where the student is right now — kept by the movement service so the
    // "students inside / outside" dashboard is one query, not a scan of movements.
    presence: { type: String, enum: ['in', 'out', 'on_leave'], default: 'in' },

    remarks: { type: String, default: '' },
    approvedBy: { type: db.Types.UUID, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    allocatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    vacatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelAllocationSchema.index({ school: 1, status: 1 });
HostelAllocationSchema.index({ school: 1, hostel: 1, status: 1 });
HostelAllocationSchema.index({ school: 1, room: 1, status: 1 });
HostelAllocationSchema.index({ school: 1, student: 1, status: 1 });
// "A student cannot have two active hostel allocations" — in the database.
HostelAllocationSchema.index(
    { student: 1 },
    {
        unique: true,
        partialFilterExpression: { status: { $in: ['pending', 'active'] } },
        name: 'unique_active_hostel_allocation',
    },
);

module.exports = db.model('HostelAllocation', HostelAllocationSchema);
