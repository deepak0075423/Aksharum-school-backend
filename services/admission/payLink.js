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
    const payload = { a: String(app._id), s: String(app.school), k: kind, e: Date.now() + days * 86400000 };
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
    return { applicationId: p.a, kind: p.k, expiresAt: new Date(Number(p.e)) };
}

module.exports = { make, read };
