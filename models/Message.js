'use strict';
const db = require('../db/orm');

const AttachmentSchema = new db.Schema(
    {
        originalName: { type: String, default: '' },
        fileName:     { type: String, default: '' },
        fileUrl:      { type: String, default: '' },
        fileType:     { type: String, default: '' },
        fileSize:     { type: Number, default: 0 },
    },
    { _id: false }
);

const MessageSchema = new db.Schema(
    {
        chat: {
            type: db.Types.UUID,
            ref: 'Chat',
            required: true,
        },
        school: {
            type: db.Types.UUID,
            ref: 'School',
            required: true,
        },
        sender: {
            type: db.Types.UUID,
            ref: 'User',
            required: true,
        },
        senderRole: {
            type: String,
            required: true,
        },
        content: {
            type: String,
            default: '',
            maxlength: 4000,
            trgm: true,     // message search is an ILIKE substring match
        },
        type: {
            type: String,
            enum: ['text', 'file', 'image'],
            default: 'text',
        },
        attachments: {
            type: [AttachmentSchema],
            default: [],
        },
        // FK to parent message for quote/reply
        replyTo: {
            type: db.Types.UUID,
            ref: 'Message',
            default: null,
        },
        isEdited: {
            type: Boolean,
            default: false,
        },
        editedAt: {
            type: Date,
            default: null,
        },
        // Previous versions kept for admin audit (surfaced to school_admin only)
        editHistory: {
            type: [{
                content:  { type: String, default: '' },
                editedAt: { type: Date,   default: Date.now },
            }],
            default: [],
            _id: false,
        },
        isDeleted: {
            type: Boolean,
            default: false,
        },
        deletedAt: {
            type: Date,
            default: null,
        },
        deletedBy: {
            type: db.Types.UUID,
            ref: 'User',
            default: null,
        },
        mentions: [
            {
                type: db.Types.UUID,
                ref: 'User',
            },
        ],
        isForwarded: {
            type:    Boolean,
            default: false,
        },
        // Client-generated id for one send attempt. A socket send that times out
        // is retried over REST with the same id, and the unique index below turns
        // the retry into a read of the first write instead of a second message.
        clientId: {
            type:    String,
            default: null,
        },
        reactions: {
            type: [{
                emoji:    { type: String, required: true },
                user:     { type: db.Types.UUID, ref: 'User', required: true },
                userName: { type: String, default: '' },
            }],
            default: [],
            _id: false,
        },
    },
    { timestamps: true }
);

// Primary access pattern: paginated history per chat
MessageSchema.index({ chat: 1, createdAt: -1 });
// Idempotent sends: one message per (sender, clientId)
MessageSchema.index({ sender: 1, clientId: 1 }, {
    unique: true,
    partialFilterExpression: { clientId: { $exists: true } },
});
// Sender-based queries (e.g. "delete all messages from user X")
MessageSchema.index({ sender: 1, chat: 1 });

module.exports = db.model('Message', MessageSchema);
