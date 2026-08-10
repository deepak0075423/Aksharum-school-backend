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
// Full-text search
MessageSchema.index({ content: 'text' });
// Sender-based queries (e.g. "delete all messages from user X")
MessageSchema.index({ sender: 1, chat: 1 });

module.exports = db.model('Message', MessageSchema);
