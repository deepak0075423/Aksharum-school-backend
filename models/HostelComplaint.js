const db = require('../db/orm');

// A resident complaint (spec §17) with an escalation ladder. Comments are
// embedded because they are always read with the ticket and never on their own.
const CommentSchema = new db.Schema({
    by: { type: db.Types.UUID, ref: 'User', default: null },
    byName: { type: String, default: '' },
    byRole: { type: String, default: '' },
    text: { type: String, required: true },
    at: { type: Date, default: Date.now },
    internal: { type: Boolean, default: false },               // staff-only note
}, { _id: true });

const HostelComplaintSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    room: { type: db.Types.UUID, ref: 'HostelRoom', default: null },
    student: { type: db.Types.UUID, ref: 'User', default: null, index: true },

    ticketNumber: { type: String, default: '' },               // HC-YYMM-####
    category: {
        type: String,
        enum: ['room', 'mess', 'cleaning', 'security', 'maintenance', 'staff', 'food', 'facilities', 'internet', 'other'],
        default: 'other',
    },
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    subject: { type: String, default: '' },
    description: { type: String, required: true },
    attachments: { type: [String], default: [] },

    assignedTo: { type: db.Types.UUID, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },

    status: {
        type: String,
        enum: ['open', 'assigned', 'in_progress', 'resolved', 'reopened', 'closed', 'rejected'],
        default: 'open',
    },
    resolution: { type: String, default: '' },
    resolutionDate: { type: Date, default: null },
    resolvedBy: { type: db.Types.UUID, ref: 'User', default: null },
    reopenCount: { type: Number, default: 0 },

    // Escalation (spec §17): level rises on breach of the settings SLA or by hand.
    escalationLevel: { type: Number, default: 0 },
    escalatedAt: { type: Date, default: null },
    escalatedTo: { type: db.Types.UUID, ref: 'User', default: null },
    dueAt: { type: Date, default: null },

    rating: { type: Number, default: 0 },                      // 1-5, set by the student on close
    comments: [CommentSchema],
    raisedBy: { type: db.Types.UUID, ref: 'User', default: null },
    raisedByRole: { type: String, default: '' },
}, { timestamps: true });

HostelComplaintSchema.index({ school: 1, status: 1, createdAt: -1 });
HostelComplaintSchema.index({ school: 1, hostel: 1, status: 1 });
HostelComplaintSchema.index({ school: 1, student: 1, createdAt: -1 });
HostelComplaintSchema.index({ school: 1, category: 1, status: 1 });

module.exports = db.model('HostelComplaint', HostelComplaintSchema);
