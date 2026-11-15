'use strict';
/**
 * A link to pay a fee without signing in (Oct 2026) — for the family that
 * cannot find its password, or whose relative pays. The office makes one (and
 * may email it); it works for one fee of one application, at the school whose
 * portal it opens, for seven days. It shows the application number, the
 * child's first name and the amount — nothing else of the application — and
 * it can only pay.
 *
 * The link is signed (HMAC-SHA256 with a key derived from the server's secret),
 * so it cannot be altered to point at another application, fee or school.
 */
const crypto = require('crypto');
const { refuse } = require('./util');

const key = () => crypto.createHash('sha256').update(`aksharum-admission-pay-link|${process.env.JWT_SECRET || ''}`).digest();
const sign = (body) => crypto.createHmac('sha256', key()).update(body).digest('base64url');

function make(app, kind, days = 7) {
    // `v`: the application's pay-link epoch — the office cancels every link it
    // has sent for an application by raising it (the link could not be taken back before).
    const payload = { a: String(app._id), s: String(app.school), k: kind, e: Date.now() + days * 86400000, v: Number(app.payLinkEpoch) || 0 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { token: `${body}.${sign(body)}`, expiresAt: new Date(payload.e) };
}

/** The link's contents, if it is genuine, unexpired and this school's. */
function read(token, schoolId) {
    const [body, sig] = String(token || '').split('.');
    const bad = () => refuse('This payment link is not valid', 404);
    if (!body || !sig || sig.length !== 43) bad();
    const expect = Buffer.from(sign(body));
    if (!crypto.timingSafeEqual(expect, Buffer.from(sig))) bad();
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { bad(); }
    if (String(p.s) !== String(schoolId)) bad();
    if (!['application_fee', 'admission_fee'].includes(p.k)) bad();
    if (Date.now() > Number(p.e)) refuse('This payment link has expired — ask the school for a new one', 410, { code: 'LINK_EXPIRED' });
    return { applicationId: p.a, kind: p.k, expiresAt: new Date(Number(p.e)), epoch: Number(p.v) || 0 };
}

/** The link is still the application's: not cancelled since it was made. */
function assertCurrent(link, app) {
    if ((Number(app.payLinkEpoch) || 0) !== link.epoch) refuse('This payment link has been cancelled — ask the school for a new one', 410, { code: 'LINK_CANCELLED' });
}

module.exports = { make, read, assertCurrent };
