const db = require('../db/orm');

const ClassAnnouncementSchema = new db.Schema({
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        required: true,
    },
    title: {
        type: String,
        required: true,
        trim: true,
    },
    message: {
        type: String,
        required: true,
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active',
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = db.model('ClassAnnouncement', ClassAnnouncementSchema);
