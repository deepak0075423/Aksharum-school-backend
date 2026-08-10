'use strict';
// Shared general-purpose Redis client for caching / rate-limiting (GET/SET/INCR).
// Kept separate from config/redis.js (whose subClient is locked in subscribe mode
// and cannot run ordinary commands). One lazy client per process, reused by the
// auth cache and the rate limiter so we don't open a fresh connection per feature.
//
// When REDIS_URL is absent the getter returns null and every caller degrades
// gracefully: the auth cache falls through to Postgres, the limiter passes traffic.
const Redis = require('ioredis');

let _client = null;
let _tried = false;

function getCacheRedis() {
    if (_tried) return _client;
    _tried = true;
    const url = process.env.REDIS_URL;
    if (!url) return null;
    _client = new Redis(url, {
        retryStrategy: (times) => Math.min(times * 200, 5000),
        maxRetriesPerRequest: 2,
        enableReadyCheck: false,
        lazyConnect: false,
    });
    _client.on('error', (e) => console.error('[redis-cache] error:', e.message));
    return _client;
}

module.exports = { getCacheRedis };
