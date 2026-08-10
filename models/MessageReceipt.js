'use strict';
const db = require('../db/orm');

const MessageReceiptSchema = new db.Schema(
    {
        message: {
            type: db.Types.UUID,
            ref: 'Message',
            required: true,
        },
        chat: {
            type: db.Types.UUID,
            ref: 'Chat',
            required: true,
        },
        user: {
            type: db.Types.UUID,
            ref: 'User',
            required: true,
        },
        school: {
            type: db.Types.UUID,
            ref: 'School',
            required: true,
        },
        deliveredAt: {
            type: Date,
            default: Date.now,
        },
        readAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
);

// One receipt per (message, user) pair
MessageReceiptSchema.index({ message: 1, user: 1 }, { unique: true });
// Unread count query: chat + user + readAt null
MessageReceiptSchema.index({ chat: 1, user: 1, readAt: 1 });

module.exports = db.model('MessageReceipt', MessageReceiptSchema);
