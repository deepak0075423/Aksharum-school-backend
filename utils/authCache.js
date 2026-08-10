'use strict';
// Redis cache for the per-request auth lookup (user + its school).
//
// Auth runs on every authenticated request. Even after collapsing it to a single
// native JOIN, that is still one DB round-trip per request — the dominant source
// of Postgres load at 5-6k concurrent users. Caching the resolved user for a few
// seconds turns the overwhelming majority of those into a Redis GET (~0 DB load).
//
// Staleness is bounded two ways: a short TTL, and explicit invalidate() calls
// wired into every User mutation (deactivate / role change / delete) so those
// take effect immediately rather than waiting out the TTL. School-level edits
// (e.g. toggling a module) ride the TTL — at most AUTH_CACHE_TTL seconds stale.
//
// Values are JSON, so Date columns round-trip as ISO strings; revive() restores
// them to Date objects using the model schemas, keeping the cached object
// byte-for-byte identical to a fresh DB load.
const { getCacheRedis } = require('../config/cacheRedis');
const User = require('../models/User');
const School = require('../models/School');

const TTL = Number(process.env.AUTH_CACHE_TTL) || 30; // seconds
const keyFor = (id) => `auth:user:${id}`;

const dateFieldsOf = (Model) =>
    Object.entries(Model.schema.parsed().fields)
        .filter(([, meta]) => meta.kind === 'date')
        .map(([name]) => name);

const USER_DATE_FIELDS = dateFieldsOf(User);
const SCHOOL_DATE_FIELDS = dateFieldsOf(School);

function revive(user) {
    if (!user) return user;
    for (const f of USER_DATE_FIELDS) {
        if (typeof user[f] === 'string') user[f] = new Date(user[f]);
    }
    if (user.school && typeof user.school === 'object') {
        for (const f of SCHOOL_DATE_FIELDS) {
            if (typeof user.school[f] === 'string') user.school[f] = new Date(user.school[f]);
        }
    }
    return user;
}

async function get(userId) {
    const r = getCacheRedis();
    if (!r) return null;
    try {
        const raw = await r.get(keyFor(userId));
        return raw ? revive(JSON.parse(raw)) : null;
    } catch {
        return null; // fail open — caller falls back to the DB
    }
}

async function set(userId, user) {
    const r = getCacheRedis();
    if (!r || !user) return;
    try {
        await r.set(keyFor(userId), JSON.stringify(user), 'EX', TTL);
    } catch {
        /* best effort */
    }
}

async function invalidate(userId) {
    const r = getCacheRedis();
    if (!r || userId == null) return;
    try {
        await r.del(keyFor(userId));
    } catch {
        /* best effort */
    }
}

async function invalidateMany(userIds) {
    const r = getCacheRedis();
    if (!r || !Array.isArray(userIds) || !userIds.length) return;
    try {
        await r.del(...userIds.map((id) => keyFor(id)));
    } catch {
        /* best effort */
    }
}

module.exports = { get, set, invalidate, invalidateMany };
