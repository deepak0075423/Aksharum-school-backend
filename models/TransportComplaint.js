const db = require('../db/orm');

// A single action in a complaint's lifecycle (spec §18 workflow).
const TimelineSchema = new db.Schema({
    action: { type: String, required: true },                // created / assigned / commented / resolved / closed
    by: { type: db.Types.UUID, ref: 'User', default: null },
    byName: { type: String, default: '' },
    note: { type: String, default: '' },
    at: { type: Date, default: Date.now },
}, { _id: true });

// A transport complaint raised by a parent/student/staff (spec §18).
const TransportComplaintSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },

    complaintCode: { type: String, default: '' },            // CMP-YYMM-####
    raisedBy: { type: db.Types.UUID, ref: 'User', required: true },
    raisedByRole: { type: String, default: '' },
    student: { type: db.Types.UUID, ref: 'User', default: null },

    category: {
        type: String,
        enum: ['late_bus', 'driver_behavior', 'bus_condition', 'safety', 'delay', 'lost_item', 'overcrowding', 'other'],
        default: 'other',
    },
    subject: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    route: { type: db.Types.UUID, ref: 'TransportRoute', default: null },
    vehicle: { type: db.Types.UUID, ref: 'Vehicle', default: null },
    driver: { type: db.Types.UUID, ref: 'TransportStaff', default: null },

    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    status: { type: String, enum: ['open', 'assigned', 'in_progress', 'resolved', 'closed'], default: 'open' },
    assignedTo: { type: db.Types.UUID, ref: 'User', default: null },
    resolution: { type: String, default: '' },
    rating: { type: Number, default: null },                 // parent satisfaction after resolution

    attachments: { type: [String], default: [] },
    timeline: [TimelineSchema],
}, { timestamps: true });

TransportComplaintSchema.index({ school: 1, status: 1, createdAt: -1 });
TransportComplaintSchema.index({ school: 1, raisedBy: 1 });

module.exports = db.model('TransportComplaint', TransportComplaintSchema);
