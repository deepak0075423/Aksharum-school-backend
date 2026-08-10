'use strict';
// Redis-backed fixed-window rate limiter.
//
// Centralised in Redis so the limit is shared across all cluster workers (an
// in-process counter would let each worker allow the full quota). FAILS OPEN:
// if Redis is unavailable, requests pass — for a school ERP, availability beats
// enforcement. Limits are generous by default and env-tunable; they exist to
// absorb a single abusive client / accidental retry storm, not to police the
// normal traffic of a whole school sitting behind one NAT'd office IP.
const { getCacheRedis } = require('../config/cacheRedis');

function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || 'anon';
}

// windowSec: window length; max: allowed hits per window; prefix: bucket namespace;
// keyFn(req): subject to limit on (defaults to client IP).
function rateLimit({ windowSec, max, prefix, keyFn }) {
    return async function rateLimiter(req, res, next) {
        const r = getCacheRedis();
        if (!r) return next();

        let subject;
        try {
            subject = keyFn ? keyFn(req) : clientIp(req);
        } catch {
            return next();
        }
        if (!subject) return next();

        const key = `rl:${prefix}:${subject}`;
        try {
            const hits = await r.incr(key);
            if (hits === 1) await r.expire(key, windowSec);
            if (hits > max) {
                let ttl = await r.ttl(key);
                if (ttl < 0) ttl = windowSec;
                res.setHeader('Retry-After', ttl);
                return res.status(429).json({
                    success: false,
                    message: 'Too many requests — please slow down and try again shortly.',
                });
            }
        } catch {
            /* Redis hiccup — fail open */
        }
        return next();
    };
}

module.exports = { rateLimit, clientIp };
