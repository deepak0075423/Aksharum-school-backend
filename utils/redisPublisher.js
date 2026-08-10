'use strict';
const Redis = require('ioredis');

let _client = null;

function _get() {
    if (_client) return _client;
    const url = process.env.REDIS_URL;
    if (!url) return null;
    _client = new Redis(url, {
        retryStrategy: times => Math.min(times * 200, 5000),
        maxRetriesPerRequest: 2,
        enableReadyCheck: false,
        lazyConnect: true,
    });
    _client.on('error', e => console.error('[redis-pub] error:', e.message));
    return _client;
}

// Publish notification unread count event so the WebSocket Gateway
// can forward it to the user's socket room.
async function publishNotificationCount(userId, count) {
    const client = _get();
    if (!client) return;
    try {
        await client.publish('notification.count', JSON.stringify({
            userId: userId.toString(),
            count,
        }));
    } catch (e) {
        console.error('[redis-pub] publish failed:', e.message);
    }
}

// Deliver an arbitrary event to all of a user's connected sockets.
// Rides the gateway's chat.deliver channel: { target, targetId, event, data }.
async function publishToUser(userId, event, data) {
    const client = _get();
    if (!client) return;
    try {
        await client.publish('chat.deliver', JSON.stringify({
            target:   'user',
            targetId: `user:${userId.toString()}`,
            event,
            data,
        }));
    } catch (e) {
        console.error('[redis-pub] publishToUser failed:', e.message);
    }
}

module.exports = { publishNotificationCount, publishToUser };
