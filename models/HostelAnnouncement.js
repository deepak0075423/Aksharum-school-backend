const db = require('../db/orm');

// A hostel announcement (spec §26). The notice itself is delivered through
// notifyService like everything else; this row is what the Announcements
// screen lists — drafts, the ones booked for later, what went out and to how
// many people, and what has been put away.
//
//   draft ──► scheduled ──► sending ──► published ──► archived
//     └───────────────────────┘
// 'sending' is the claim a publisher takes before it notifies anyone, so a
// scheduled notice is never sent twice (services/hostelAnnouncements.js).
const HostelAnnouncementSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    // The hostel it is for; null = every hostel the author could reach, which
    // `hostels` pins down at the moment it is written.
    hostel: { type: db.Types.UUID, ref: 'Hostel', default: null, index: true },
    hostels: { type: [db.Types.UUID], default: [] },          // [] = the whole school

    title: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    category: {
        type: String,
        enum: ['general', 'mess', 'maintenance', 'medical', 'discipline', 'leave', 'documents', 'safety', 'fees', 'events', 'other'],
        default: 'general',
    },
    audience: {
        type: String,
        enum: ['residents', 'new_residents', 'parents', 'residents_and_parents', 'staff'],
        default: 'residents',
    },
    attachments: { type: [String], default: [] },
    sendEmail: { type: Boolean, default: false },
    urgent: { type: Boolean, default: false },

    status: { type: String, enum: ['draft', 'scheduled', 'sending', 'published', 'archived'], default: 'draft', index: true },
    scheduledAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    recipients: { type: Number, default: 0 },
    // What it was before it was archived, so Restore puts it back.
    archivedFrom: { type: String, default: '' },
    archivedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    publishedBy: { type: db.Types.UUID, ref: 'User', default: null },
    publishedByName: { type: String, default: '' },
}, { timestamps: true });

HostelAnnouncementSchema.index({ school: 1, status: 1, scheduledAt: 1 });
HostelAnnouncementSchema.index({ school: 1, createdAt: -1 });

module.exports = db.model('HostelAnnouncement', HostelAnnouncementSchema);
