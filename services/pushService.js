'use strict';
/**
 * OS push notifications (Oct 2026) — the second way every notification travels.
 *
 * The first is the websocket: `notification:new` over the gateway reaches a
 * screen that is open, live. This one reaches a phone or a browser that is
 * NOT looking: the operating system shows it in the tray, on the lock screen,
 * as a desktop notification — the app can be closed. Every notification goes
 * both ways, from one place (notifyService.deliver — every module, the admin
 * broadcast — and chatMessageService for a new chat message):
 *
 *   phones    Expo's push service (EXPO_PUSH_URL, default
 *             https://exp.host/--/api/v2/push/send), which hands the message to
 *             Firebase on Android and to Apple on iPhones. The token comes from
 *             the app (expo-notifications). EXPO_ACCESS_TOKEN is sent when set —
 *             only needed if the Expo account requires it.
 *   browsers  Web Push, signed with the server's VAPID keys: VAPID_PUBLIC_KEY /
 *             VAPID_PRIVATE_KEY from the environment, or a pair made once and
 *             kept in PushConfig. school-frontend/public/push-sw.js shows it.
 *
 * Tapping one opens the receipt — /n/<receipt> on the web,
 * aksharum://notification/<receipt> on the phone — which marks it read and
 * forwards to wherever it belongs for that reader; a chat message opens its
 * conversation. A device the push service says is gone is forgotten. Never
 * throws, and never holds up whoever sent the notification.
 */
const pool = require('../db/pool');
const { patch } = require('../db/patch');
const PushDevice = require('../models/PushDevice');
const PushConfig = require('../models/PushConfig');

const EXPO_URL = process.env.EXPO_PUSH_URL || 'https://exp.host/--/api/v2/push/send';
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]{4,200}\]$/;
const S = (v) => String(v);
const clip = (t, n) => { const s = String(t ?? '').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

class PushError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

/* ── The server's Web Push keys ───────────────────────────────────────────── */

let vapidPromise = null;
/** { publicKey, privateKey } — the environment's pair, or the one made once and kept. */
function vapid() {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        return Promise.resolve({ publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY });
    }
    if (!vapidPromise) {
        vapidPromise = (async () => {
            let row = await PushConfig.findOne({ name: 'vapid' }).lean();
            if (!row?.publicKey) {
                const keys = require('web-push').generateVAPIDKeys();
                try { await PushConfig.create({ name: 'vapid', publicKey: keys.publicKey, privateKey: keys.privateKey }); }
                catch { /* another server made the pair a moment ago — read theirs */ }
                row = await PushConfig.findOne({ name: 'vapid' }).lean();
            }
            if (!row?.publicKey) throw new Error('No Web Push keys');
            return { publicKey: row.publicKey, privateKey: row.privateKey };
        })().catch((e) => { vapidPromise = null; throw e; });
    }
    return vapidPromise;
}
const vapidSubject = () => process.env.VAPID_SUBJECT || `mailto:${process.env.PUSH_CONTACT_EMAIL || 'support@aksharum.com'}`;

/** What a client needs to subscribe: the Web Push public key. */
async function config() {
    let webPublicKey = null;
    try { webPublicKey = (await vapid()).publicKey; } catch (e) { console.error('[push] no Web Push keys:', e.message); }
    return { webPublicKey };
}

/* ── Devices ──────────────────────────────────────────────────────────────── */

/**
 * This device shows the signed-in person's notifications from now on:
 *   { kind: 'expo', token, platform, deviceName, appVersion }
 *   { kind: 'web', subscription: { endpoint, keys: { p256dh, auth } }, deviceName }
 * A device belongs to whoever signed in on it last.
 */
async function register(req, body = {}) {
    const kind = body.kind === 'web' ? 'web' : body.kind === 'expo' ? 'expo' : null;
    if (!kind) throw new PushError(400, 'Say which kind of device this is');
    let key; let subscription = null;
    if (kind === 'expo') {
        key = S(body.token || '').trim();
        if (!EXPO_TOKEN_RE.test(key)) throw new PushError(400, 'That is not an Expo push token');
    } else {
        const sub = body.subscription || {};
        key = S(sub.endpoint || '').trim();
        if (!/^https:\/\/[^\s]{8,2000}$/.test(key) || !sub.keys?.p256dh || !sub.keys?.auth) throw new PushError(400, 'That is not a Web Push subscription');
        subscription = { endpoint: key, keys: { p256dh: clip(sub.keys.p256dh, 200), auth: clip(sub.keys.auth, 100) } };
    }
    const set = {
        user: req.userId, school: req.schoolId || null, kind, subscription,
        platform: clip(body.platform || (kind === 'web' ? 'web' : ''), 20),
        deviceName: clip(body.deviceName, 120), appVersion: clip(body.appVersion, 40),
        lastSeenAt: new Date(), lastError: '',
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const cur = await PushDevice.findOne({ key }).lean();
        if (cur) return patch(PushDevice, cur._id, set);
        try { return (await PushDevice.create({ key, ...set })).toObject?.() || null; }
        catch (e) { if (!/duplicate|23505/.test(`${e.code} ${e.message}`)) throw e; /* registered twice at once — update the one that won */ }
    }
    return null;
}

/** Signing out: this device stops showing that person's notifications. Only its own holder can remove it. */
async function unregister(req, body = {}) {
    const key = S(body.token || body.endpoint || body.key || '').trim();
    if (!key) throw new PushError(400, 'Which device?');
    const { rowCount } = await pool.query(`DELETE FROM "pushdevices" WHERE "key" = $1 AND "user" = $2`, [key, S(req.userId)]);
    return { removed: rowCount };
}

const forget = (id) => pool.query(`DELETE FROM "pushdevices" WHERE "_id" = $1`, [id]).catch(() => {});
const noteError = (id, message) => pool.query(`UPDATE "pushdevices" SET "lastError" = $2, "updatedAt" = now() WHERE "_id" = $1`, [id, clip(message, 300)]).catch(() => {});

/* ── Sending ──────────────────────────────────────────────────────────────── */

/**
 * items: [{ user, title, body, receiptId?, link?: { web, mobile }, urgent?, badge?,
 *           kind?: 'notification' | 'chat', chatId?, tag? }]
 * One push per device of each reader.
 */
async function send(items) {
    try {
        const list = (items || []).filter((x) => x && x.user && x.title);
        if (!list.length) return { expo: 0, web: 0 };
        const users = [...new Set(list.map((x) => S(x.user)))];
        const { rows: devices } = await pool.query(
            `SELECT "_id"::text AS id, "user"::text AS "user", "kind", "key", "subscription" FROM "pushdevices" WHERE "user"::text = ANY($1::text[])`,
            [users],
        );
        if (!devices.length) return { expo: 0, web: 0 };
        const byUser = new Map();
        for (const d of devices) {
            if (!byUser.has(d.user)) byUser.set(d.user, []);
            byUser.get(d.user).push(d);
        }
        const expo = []; const web = [];
        for (const x of list) for (const d of byUser.get(S(x.user)) || []) (d.kind === 'expo' ? expo : web).push({ d, x });
        await Promise.all([expo.length ? sendExpo(expo) : null, web.length ? sendWeb(web) : null]);
        return { expo: expo.length, web: web.length };
    } catch (e) {
        console.error('[push] send failed:', e.message);
        return { expo: 0, web: 0, error: e.message };
    }
}

/** The phone: where a tap goes (handled by the app — utils/pushNotifications). */
function expoMessage(d, x) {
    const chat = x.kind === 'chat' && x.chatId;
    return {
        to: d.key,
        title: clip(x.title, 120),
        body: clip(x.body, 400),
        data: {
            kind: x.kind || 'notification',
            receiptId: x.receiptId || null,
            chatId: chat ? S(x.chatId) : null,
            path: x.link?.mobile || null,
            url: chat ? null : (x.receiptId ? `aksharum://notification/${x.receiptId}` : null),
            urgent: !!x.urgent,
        },
        sound: 'default',
        // Android delivers 'high' at once even in Doze; urgent news and messages are worth it.
        priority: x.urgent || chat ? 'high' : 'default',
        channelId: x.urgent ? 'urgent' : chat ? 'chat' : 'default',
        ...(Number.isFinite(x.badge) ? { badge: Math.max(0, Math.round(x.badge)) } : {}),
    };
}

async function sendExpo(pairs) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    for (let i = 0; i < pairs.length; i += 100) {
        const batch = pairs.slice(i, i + 100);
        try {
            const res = await fetch(EXPO_URL, { method: 'POST', headers, body: JSON.stringify(batch.map(({ d, x }) => expoMessage(d, x))), signal: AbortSignal.timeout(15000) });
            const out = await res.json().catch(() => ({}));
            if (!res.ok) { console.error('[push] Expo answered', res.status, JSON.stringify(out).slice(0, 300)); continue; }
            (out.data || []).forEach((ticket, j) => {
                const d = batch[j]?.d;
                if (!d || ticket?.status !== 'error') return;
                // The app was uninstalled, or the token replaced: never send to it again.
                if (ticket.details?.error === 'DeviceNotRegistered') forget(d.id);
                else noteError(d.id, `${ticket.details?.error || 'error'}: ${ticket.message || ''}`);
            });
        } catch (e) { console.error('[push] Expo send failed:', e.message); }
    }
}

/** The browser: what push-sw.js shows, and where a click goes. */
function webPayload(x) {
    const chat = x.kind === 'chat' && x.chatId;
    return JSON.stringify({
        title: clip(x.title, 120),
        body: clip(x.body, 400),
        url: chat ? `/chat?c=${encodeURIComponent(S(x.chatId))}` : x.receiptId ? `/n/${x.receiptId}` : (x.link?.web || '/'),
        tag: x.tag || (chat ? `chat:${x.chatId}` : x.receiptId ? `n:${x.receiptId}` : undefined),
        urgent: !!x.urgent,
        kind: x.kind || 'notification',
    });
}

async function sendWeb(pairs) {
    let keys;
    try { keys = await vapid(); } catch (e) { console.error('[push] Web Push keys unavailable:', e.message); return; }
    const webpush = require('web-push');
    const vapidDetails = { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey };
    for (let i = 0; i < pairs.length; i += 10) {
        await Promise.all(pairs.slice(i, i + 10).map(async ({ d, x }) => {
            if (!d.subscription?.endpoint) { forget(d.id); return; }
            try {
                await webpush.sendNotification(d.subscription, webPayload(x), {
                    vapidDetails, TTL: x.urgent ? 86400 : 3 * 86400, urgency: x.urgent ? 'high' : 'normal', timeout: 15000,
                });
            } catch (err) {
                // 404/410: the browser dropped the subscription (signed out of the site, cleared data).
                if (err.statusCode === 404 || err.statusCode === 410) forget(d.id);
                else noteError(d.id, `${err.statusCode || ''} ${err.body || err.message || ''}`);
            }
        }));
    }
}

module.exports = { PushError, config, register, unregister, send, vapid, expoMessage, webPayload };
