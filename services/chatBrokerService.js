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

// ─── Inbound handlers (legacy) ────────────────────────────────────────────────
// The gateway now sends commands to /internal/chat/* over HTTP so it can ack the
// browser. These channels stay subscribed for a gateway that has not been
// redeployed yet; both paths run the same writer, so they cannot drift again.
// Required lazily — the writer publishes through this module.
const writer = () => require('./chatMessageService');

async function _asActor(userId, run) {
    const svc = writer();
    try {
        const actor = await svc.actorForUser(userId);
        await run(svc, actor);
    } catch (err) {
        if (err instanceof svc.ChatError) return _errorToUser(userId, err.message);
        throw err;
    }
}

async function _onSend(p) {
    await _asActor(p.senderId, (svc, actor) => svc.send(actor, p.chatId, {
        content: p.content, type: p.type, replyTo: p.replyTo, attachments: p.attachments, clientId: p.tempId,
    }));
}

async function _onRead(p) {
    await _asActor(p.userId, (svc, actor) => svc.markRead(actor, p.chatId, p.messageId || null));
}

async function _onEdit(p) {
    await _asActor(p.senderId, (svc, actor) => svc.edit(actor, p.messageId, p.content));
}

async function _onDelete(p) {
    await _asActor(p.senderId, (svc, actor) => svc.remove(actor, p.messageId));
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
    // The gateway joins each socket to `user:<id>` — the bare id is no room at
    // all, which is why chat:error never reached anybody before.
    return _publish(CH.DELIVER, { target: 'user', targetId: `user:${userId}`, event, data });
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
