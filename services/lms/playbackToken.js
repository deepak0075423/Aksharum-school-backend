'use strict';
/**
 * Video Learning — the token inside a playback address.
 *
 * A <video> element cannot send an Authorization header, so the address it is
 * given carries its own proof: who it is for, which video, which watch
 * session, and when it stops working — signed (HMAC-SHA256) so none of it can
 * be changed. The token alone is not enough to play: every request made with
 * it is also checked against the session it names, which must still be open
 * (controllers/lms/media). Close the session — the student leaves, goes
 * quiet, or loses access — and the address is dead, whatever its expiry says.
 *
 *   VIDEO_SIGN_SECRET   optional; a key of its own for these tokens.
 *                       Falls back to one derived from JWT_SECRET.
 */
const crypto = require('crypto');

const secret = () => process.env.VIDEO_SIGN_SECRET
    || crypto.createHash('sha256').update(`aksharum-video-playback|${process.env.JWT_SECRET || ''}`).digest('hex');

const mac = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

/** @param {{ kind: 'watch'|'preview', vid: string, uid: string, sid?: string }} claims */
function sign(claims, ttlSec) {
    const body = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + Math.max(30, Math.floor(ttlSec)) })).toString('base64url');
    return `${body}.${mac(body)}`;
}

/** The claims, or null when the token is not ours, was altered or has run out. */
function verify(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const want = Buffer.from(mac(body));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try {
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
        return claims;
    } catch { return null; }
}

module.exports = { sign, verify };
