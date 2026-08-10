const db = require('../db/orm');

const NotificationReceiptSchema = new db.Schema({
    notification: { type: db.Types.UUID, ref: 'Notification', required: true },
    recipient:    { type: db.Types.UUID, ref: 'User',         required: true },
    school:       { type: db.Types.UUID, ref: 'School',       default: null },
    isRead:       { type: Boolean, default: false },
    readAt:       { type: Date,    default: null },
    isCleared:    { type: Boolean, default: false },
    clearedAt:    { type: Date,    default: null },
}, { timestamps: true });

// One receipt per (notification × recipient)
NotificationReceiptSchema.index({ notification: 1, recipient: 1 }, { unique: true });
// Bell icon query — uncleared receipts for a user, newest first
NotificationReceiptSchema.index({ recipient: 1, isCleared: 1, createdAt: -1 });
// Unread count query
NotificationReceiptSchema.index({ recipient: 1, isRead: 1, isCleared: 1 });

module.exports = db.model('NotificationReceipt', NotificationReceiptSchema);
