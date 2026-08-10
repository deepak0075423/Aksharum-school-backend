'use strict';
/**
 * Chat Broker Service  (Chat Service side)
 * ─────────────────────────────────────────
 * Owns ALL business logic that was previously inside chatSocketService._onXxx().
 * Transport is now Redis pub/sub instead of direct socket calls.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                        Redis Channel Contracts                          │
 * ├─────────────┬───────────────────────────────────────────────────────────┤
 * │ INBOUND     │ Direction: Gateway → Chat Service                         │
 * │ chat.send   │ { chatId, senderId, senderRole, schoolId,                 │
 * │             │   content, type, replyTo, attachments[], tempId }         │
 * │ chat.read   │ { chatId, userId, messageId }                             │
 * │ chat.edit   │ { messageId, senderId, content }                          │
 * │ chat.delete │ { messageId, senderId, senderRole }                       │
 * ├─────────────┬───────────────────────────────────────────────────────────┤
 * │ OUTBOUND    │ Direction: Chat Service → Gateway                         │
 * │ chat.deliver│ { target: 'room'|'user', targetId, event, data }          │
 * │ chat.member │ { action: 'join'|'leave', userId, chatId }                │
 * └─────────────┴───────────────────────────────────────────────────────────┘
 */

const { pubClient, subClient } = require('../config/redis');

const Chat           = require('../models/Chat');
const ChatMember     = require('../models/ChatMember');
const Message        = require('../models/Message');
const MessageReceipt = require('../models/MessageReceipt');

// Redis channel names — shared constants used by both this service and the gateway
const CH = {
    SEND:   'chat.send',
    READ:   'chat.read',
    EDIT:   'chat.edit',
    DELETE: 'chat.delete',
    DELIVER:'chat.deliver',
    MEMBER: 'chat.member',
};

let _ready = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
    if (!subClient || !pubClient) {
        console.log('ℹ️  chatBrokerService: Redis not configured — broker inactive');
        return;
    }

    subClient.subscribe(CH.SEND, CH.READ, CH.EDIT, CH.DELETE, (err) => {
        if (err) { console.error('[Broker] subscribe failed:', err.message); return; }
        _ready = true;
        console.log('✅ chatBrokerService subscribed to Redis channels');
    });

    subClient.on('message', async (channel, raw) => {
        try {
            const payload = JSON.parse(raw);
            switch (channel) {
                case CH.SEND:   await _onSend(payload);   break;
                case CH.READ:   await _onRead(payload);   break;
                case CH.EDIT:   await _onEdit(payload);   break;
                case CH.DELETE: await _onDelete(payload); break;
            }
        } catch (err) {
            console.error(`[Broker] handler error on ${channel}:`, err.message);
        }
    });
}

// ─── Inbound handlers ─────────────────────────────────────────────────────────

async function _onSend(payload) {
    const { chatId, senderId, senderRole, schoolId, content, type = 'text',
            replyTo, attachments = [], tempId } = payload;

    // 1. Verify membership
    const member = await ChatMember.findOne({
        chat: chatId, user: senderId, school: schoolId, isActive: true,
    }).lean();
    if (!member) return _errorToUser(senderId, 'Not a member of this chat');

    // 2. Load chat for read-only gate
    const chat = await Chat.findOne({ _id: chatId, school: schoolId }).lean();
    if (!chat) return _errorToUser(senderId, 'Chat not found');

    if (chat.isReadOnly && !['school_admin', 'super_admin', 'teacher'].includes(senderRole)) {
        return _errorToUser(senderId, 'This is a read-only channel');
    }

    // 3. Persist message
    const msg = await Message.create({
        chat:       chatId,
        school:     schoolId,
        sender:     senderId,
        senderRole,
        content:    (content || '').trim(),
        type,
        attachments,
        replyTo:    replyTo || null,
    });

    await Chat.findByIdAndUpdate(chatId, {
        lastMessage:  msg._id,
        lastActivity: new Date(),
    });

    // 4. Populate for delivery
    const populated = await Message.findById(msg._id)
        .populate('sender', 'name role profileImage')
        .populate({
            path:    'replyTo',
            select:  'content isDeleted',
            populate: { path: 'sender', select: 'name' },
        })
        .lean();

    // 5. Deliver to everyone in the room
    await _toRoom(chatId, 'chat:message', { ...populated, tempId });

    // 6. Write delivery receipts (background — do not block delivery)
    _writeReceipts(msg._id, chatId, senderId, schoolId).catch(() => {});
}

async function _onRead(payload) {
    const { chatId, userId, messageId } = payload;

    await ChatMember.findOneAndUpdate(
        { chat: chatId, user: userId },
        { lastReadMessage: messageId || null, lastReadAt: new Date() }
    );

    await MessageReceipt.updateMany(
        { chat: chatId, user: userId, readAt: null },
        { readAt: new Date() }
    );

    // Notify room so senders see double-tick
    await _toRoom(chatId, 'chat:message_read', {
        chatId, userId, messageId: messageId || null, readAt: new Date(),
    });
}

async function _onEdit(payload) {
    const { messageId, senderId, content } = payload;
    if (!content) return;

    const msg = await Message.findOne({
        _id: messageId, sender: senderId, isDeleted: false,
    }).lean();
    if (!msg) return _errorToUser(senderId, 'Message not found or not authorised');

    if (Date.now() - new Date(msg.createdAt).getTime() > 86_400_000) {
        return _errorToUser(senderId, 'Cannot edit messages older than 24 hours');
    }

    await Message.findByIdAndUpdate(messageId, {
        content:  content.trim(),
        isEdited: true,
        editedAt: new Date(),
    });

    await _toRoom(String(msg.chat), 'chat:message_edited', {
        messageId,
        chatId:   String(msg.chat),
        content:  content.trim(),
        editedAt: new Date(),
    });
}

async function _onDelete(payload) {
    const { messageId, senderId, senderRole } = payload;

    const msg = await Message.findOne({ _id: messageId, isDeleted: false }).lean();
    if (!msg) return;

    const isOwner = String(msg.sender) === String(senderId);
    const isAdmin = ['school_admin', 'super_admin'].includes(senderRole);
    if (!isOwner && !isAdmin) return _errorToUser(senderId, 'Not authorised to delete');

    await Message.findByIdAndUpdate(messageId, {
        isDeleted: true, deletedAt: new Date(), deletedBy: senderId,
    });

    await _toRoom(String(msg.chat), 'chat:message_deleted', {
        messageId, chatId: String(msg.chat),
    });
}

// ─── Background helpers ───────────────────────────────────────────────────────

async function _writeReceipts(messageId, chatId, senderUserId, schoolId) {
    const members = await ChatMember.find({
        chat: chatId, user: { $ne: senderUserId }, isActive: true,
    }).select('user').lean();
    if (!members.length) return;
    await MessageReceipt.insertMany(
        members.map(m => ({
            message: messageId, chat: chatId, user: m.user,
            school:  schoolId, deliveredAt: new Date(),
        })),
        { ordered: false }
    );
}

// ─── Publish helpers (used by this service AND by HTTP controllers) ────────────

async function _publish(channel, data) {
    if (!pubClient) return;
    await pubClient.publish(channel, JSON.stringify(data));
}

/**
 * Broadcast an event to every socket in a chat room.
 * Called by:
 *   - internal handlers (_onSend, _onEdit, etc.)
 *   - HTTP controllers (editMessage, deleteMessage, updateGroupSettings …)
 */
async function publishToRoom(chatId, event, data) {
    return _publish(CH.DELIVER, { target: 'room', targetId: `chat:${chatId}`, event, data });
}

/**
 * Send an event directly to all sockets of a specific user.
 * Used to deliver errors and targeted notifications.
 */
async function publishToUser(userId, event, data) {
    return _publish(CH.DELIVER, { target: 'user', targetId: String(userId), event, data });
}

/**
 * Tell the gateway to add/remove a user's socket from a room.
 * Called by chatController after creating a new chat or group.
 *   action: 'join' | 'leave'
 */
async function publishMembership(action, userId, chatId) {
    return _publish(CH.MEMBER, { action, userId: String(userId), chatId: String(chatId) });
}

function _toRoom(chatId, event, data) {
    return publishToRoom(chatId, event, data);
}

function _errorToUser(userId, message) {
    return publishToUser(userId, 'chat:error', { message });
}

function isReady() { return _ready; }

module.exports = {
    init,
    isReady,
    publishToRoom,
    publishToUser,
    publishMembership,
    CH, // export channel names for gateway to import
};
