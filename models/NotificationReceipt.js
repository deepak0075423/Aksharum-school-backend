const db = require('../db/orm');

const NotificationReceiptSchema = new db.Schema({
    notification: { type: db.Types.UUID, ref: 'Notification', required: true },
    recipient:    { type: db.Types.UUID, ref: 'User',         required: true },
    school:       { type: db.Types.UUID, ref: 'School',       default: null },
    isRead:       { type: Boolean, default: false },
    readAt:       { type: Date,    default: null },
    isCleared:    { type: Boolean, default: false },
    clearedAt:    { type: Date,    default: null },
    // On a parent's receipt: which of their children it is about (Nov 2026).
    // A parent of two reads their mailbox one child at a time, and a notice
    // sent to parents alone — a class's parents, a sick-room note — names no
    // child anywhere else. Empty/NULL = not recorded; the reader then decides
    // from the notification itself (notification.controller childCond).
    about:        [{ type: db.Types.UUID, ref: 'User' }],
}, { timestamps: true });

// One receipt per (notification × recipient)
NotificationReceiptSchema.index({ notification: 1, recipient: 1 }, { unique: true });
// Bell icon query — uncleared receipts for a user, newest first
NotificationReceiptSchema.index({ recipient: 1, isCleared: 1, createdAt: -1 });
// Unread count query
NotificationReceiptSchema.index({ recipient: 1, isRead: 1, isCleared: 1 });

module.exports = db.model('NotificationReceipt', NotificationReceiptSchema);
