'use strict';
const db = require('../db/orm');

const ChatSchema = new db.Schema(
    {
        school: {
            type: db.Types.UUID,
            ref: 'School',
            required: true,
        },
        type: {
            type: String,
            enum: ['direct', 'group', 'broadcast'],
            required: true,
        },
        name: {
            type: String,
            trim: true,
            default: '',
        },
        description: {
            type: String,
            default: '',
        },
        createdBy: {
            type: db.Types.UUID,
            ref: 'User',
            required: true,
        },
        // For announcement / read-only groups — only admins/teachers can post
        isReadOnly: {
            type: Boolean,
            default: false,
        },
        avatar: {
            type: String,
            default: '',
        },
        lastMessage: {
            type: db.Types.UUID,
            ref: 'Message',
            default: null,
        },
        lastActivity: {
            type: Date,
            default: Date.now,
        },
        // Optional FK for class-based groups
        classSection: {
            type: db.Types.UUID,
            ref: 'ClassSection',
            default: null,
        },
        // What a class-based group is. Teachers create these by hand (see
        // services/classGroupService); nothing creates one automatically.
        //   'class'   — a section's whole class: its students, class teacher,
        //               vice class teacher and the subject teachers they add
        //   'subject' — one subject in one section: its students and the
        //               teachers of that same subject there
        //   ''        — any other group (and the old automatic staff groups)
        kind: {
            type: String,
            default: '',
        },
        // For kind 'subject'
        subject: {
            type: db.Types.UUID,
            ref: 'Subject',
            default: null,
        },
    },
    { timestamps: true }
);

ChatSchema.index({ school: 1, lastActivity: -1 });
ChatSchema.index({ school: 1, type: 1 });
ChatSchema.index({ school: 1, createdBy: 1 });
// One class group per section, one subject group per section + subject.
ChatSchema.index({ classSection: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: 'class' } });
ChatSchema.index({ classSection: 1, subject: 1 }, { unique: true, partialFilterExpression: { kind: 'subject' } });

module.exports = db.model('Chat', ChatSchema);
