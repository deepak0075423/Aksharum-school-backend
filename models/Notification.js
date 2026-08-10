const db = require('../db/orm');

const NotificationSchema = new db.Schema({
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    sender: { type: db.Types.UUID, ref: 'User', required: true },
    senderRole: { type: String, required: true },
    // null = global (super_admin sending to all schools)
    school: { type: db.Types.UUID, ref: 'School', default: null },
    channels: {
        inApp: { type: Boolean, default: true },
        email: { type: Boolean, default: false },
    },
    target: {
        type: {
            type: String,
            enum: [
                'all_schools',      // super_admin → every user across all schools
                'specific_school',  // super_admin → all users in one school
                'all',              // school_admin → teachers + students + parents in school
                'all_teachers',     // school_admin → all teachers in school
                'all_students',     // school_admin → all students in school
                'all_parents',      // school_admin → all parents in school
                'class_students',   // school_admin → students in a class
                'class_parents',    // school_admin → parents of students in a class
                'section_students', // school_admin / teacher → students in a section
                'section_parents',  // school_admin / teacher → parents of students in a section
                'section_all',      // teacher → students + parents in their section
                'individual',       // system / module → specific named recipients
            ],
            required: true,
        },
        schools:  [{ type: db.Types.UUID, ref: 'School' }],
        class:    { type: db.Types.UUID, ref: 'Class',        default: null },
        section:  { type: db.Types.UUID, ref: 'ClassSection', default: null },
    },
    recipientCount: { type: Number, default: 0 },
    emailSent:      { type: Boolean, default: false },
}, { timestamps: true });

NotificationSchema.index({ sender: 1, createdAt: -1 });
NotificationSchema.index({ school: 1, senderRole: 1, createdAt: -1 });

module.exports = db.model('Notification', NotificationSchema);
