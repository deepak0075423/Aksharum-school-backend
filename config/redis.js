'use strict';
/**
 * Redis client factory — Chat Service
 * ─────────────────────────────────────
 * ioredis enforces one subscription per client connection.
 * We therefore keep two clients: one for publishing (pubClient)
 * and one exclusively for subscriptions (subClient).
 *
 * When REDIS_URL is absent the factory returns null clients and
 * the broker/gateway run in no-op mode (local dev without Redis).
 */
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL;

function _make(name) {
    if (!REDIS_URL) return null;

    const client = new Redis(REDIS_URL, {
        retryStrategy:        times => Math.min(times * 100, 3000),
        maxRetriesPerRequest: 3,
        enableReadyCheck:     true,
        lazyConnect:          false,
    });

    client.on('error',   e  => console.error(`[Redis:${name}] error:`, e.message));
    client.on('connect', () => console.log(`✅ Redis:${name} connected`));
    client.on('reconnecting', () => console.log(`⟳  Redis:${name} reconnecting…`));

    return client;
}

const pubClient = _make('pub');
const subClient = _make('sub');

if (!REDIS_URL) {
    console.warn('⚠️  REDIS_URL not set — chat runs in single-server mode (no broker/gateway)');
}

module.exports = { pubClient, subClient };
