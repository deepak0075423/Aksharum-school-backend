const db = require('../db/orm');

// A maintenance work order (spec §18), including scheduled / preventive jobs.
const UpdateSchema = new db.Schema({
    by: { type: db.Types.UUID, ref: 'User', default: null },
    byName: { type: String, default: '' },
    text: { type: String, required: true },
    at: { type: Date, default: Date.now },
}, { _id: true });

const HostelMaintenanceSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    building: { type: db.Types.UUID, ref: 'HostelBuilding', default: null },
    floor: { type: db.Types.UUID, ref: 'HostelFloor', default: null },
    room: { type: db.Types.UUID, ref: 'HostelRoom', default: null },
    asset: { type: db.Types.UUID, ref: 'HostelAsset', default: null },

    requestNumber: { type: String, default: '' },              // HM-YYMM-####
    category: {
        type: String,
        enum: ['electrical', 'plumbing', 'furniture', 'fan', 'ac', 'internet', 'cleaning',
               'room', 'bathroom', 'common_area', 'other'],
        default: 'other',
    },
    maintenanceType: { type: String, enum: ['corrective', 'preventive', 'scheduled'], default: 'corrective' },
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    title: { type: String, default: '' },
    description: { type: String, required: true },
    attachments: { type: [String], default: [] },

    technicianName: { type: String, default: '' },
    technician: { type: db.Types.UUID, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    vendorName: { type: String, default: '' },

    scheduledDate: { type: Date, default: null },
    // Preventive jobs recur; the controller rolls the next occurrence forward on
    // completion using this interval.
    recurEveryDays: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    estimatedCost: { type: Number, default: 0 },
    actualCost: { type: Number, default: 0 },
    resolution: { type: String, default: '' },

    status: {
        type: String,
        enum: ['open', 'assigned', 'in_progress', 'on_hold', 'completed', 'cancelled'],
        default: 'open',
    },
    updates: [UpdateSchema],
    complaint: { type: db.Types.UUID, ref: 'HostelComplaint', default: null },
    raisedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelMaintenanceSchema.index({ school: 1, status: 1, createdAt: -1 });
HostelMaintenanceSchema.index({ school: 1, hostel: 1, status: 1 });
HostelMaintenanceSchema.index({ school: 1, scheduledDate: 1, status: 1 });

module.exports = db.model('HostelMaintenance', HostelMaintenanceSchema);
